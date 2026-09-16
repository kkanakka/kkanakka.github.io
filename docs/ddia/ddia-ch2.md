---
title: "Ch 2: Data Models & Query Languages"
slug: /ddia/ddia-ch2
sidebar_position: 2
sidebar_label: "Ch 2: Data Models & Query Languages"
description: "Ch 2: Data Models & Query Languages"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/ddia-ch2/sequence.svg" alt="How it works — ddia-ch2" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
How to model your data matters more than anything else. Relational, document, and graph models — mapped to LinkedIn's Espresso, Venice, Pinot, and Galene.

Data Intensive Systems • Chapter 2 • Interview Guide

[Home](/) [Ch 1: Reliability & Scalability](/docs/ddia/ddia-ch1)

<a id="toc"></a>

## Table of Contents

1.  [Data Model Layers](#sec-1)
2.  [Relational vs Document vs Graph](#sec-2)
    -   [Relational Model (SQL)](#sec-2-rel)
    -   [Document Model (NoSQL)](#sec-2-doc)
    -   [Graph Model](#sec-2-graph)
3.  [LinkedIn Data Store Mapping](#sec-3)
    -   [Espresso (Document/Relational)](#sec-3-espresso)
    -   [Venice (Derived / Key-Value)](#sec-3-venice)
    -   [Pinot (OLAP / Analytics)](#sec-3-pinot)
    -   [Galene / SEAS (Search)](#sec-3-galene)
    -   [Liquid (Graph)](#sec-3-liquid)
4.  [LinkedIn Profile Browsing — End-to-End Flow](#sec-3b)
    -   [When Do You Need a Secondary Index?](#sec-3b)
    -   [Materialized Views (Venice)](#sec-3b)
    -   [Couchbase Cache Update Flow](#sec-3b)
5.  [Modeling Relationships](#sec-4)
    -   [One-to-Many](#sec-4-one)
    -   [Many-to-One](#sec-4-many-one)
    -   [Many-to-Many](#sec-4-many-many)
6.  [Schema-on-Read vs Schema-on-Write](#sec-5)
7.  [Query Languages: Declarative vs Imperative](#sec-6)
8.  [When to Use What — Complete Decision Guide](#sec-7)
9.  [Real-World Data Models — Facebook, Netflix, YouTube](#sec-8)
10.  [Interview Questions & Talking Points](#sec-9)

<a id="sec-1"></a>

Section 1

## Data Model Layers

Applications are built by **layering one data model on top of another**. Each layer hides the complexity below it.

<img src="/diagrams/ddia-ch2/1.svg" alt="ddia-ch2 diagram 1" class="doc-diagram" />

Each layer provides a clean abstraction, hiding the complexity below. This chapter focuses on Layer 3: the data model.

[↑ Back to Contents](#toc)

<a id="sec-2"></a>

Section 2

## Relational vs Document vs Graph MetaGoogle

<img src="/diagrams/ddia-ch2/2.svg" alt="ddia-ch2 diagram 2" class="doc-diagram" />

The three dominant data models. Each excels at different relationship patterns.

### Relational Model (SQL) {#sec-2-rel}

Data organized into **relations (tables)** of **tuples (rows)**. The queen of data models for 40+ years. Normalization eliminates duplication; JOINs reconnect data at query time.

### Document Model (NoSQL) {#sec-2-doc}

Self-contained documents (JSON/BSON). Great for **one-to-many** tree structures. All data for an entity loaded in one read (locality). Weak at JOINs and many-to-many.

### Graph Model {#sec-2-graph}

Vertices + edges. Anything can connect to anything. Best for **highly interconnected data** where many-to-many relationships dominate (social graphs, knowledge graphs).

**Interview Decision Framework:** "What model should I use?" → *What are the relationships?*  
  
• **Mostly 1-to-many (tree)?** → Document (Espresso, MongoDB)  
• **Many-to-many with JOINs?** → Relational (MySQL, Espresso)  
• **Highly interconnected?** → Graph (Liquid, Neo4j, TAO)

[↑ Back to Contents](#toc)

<a id="sec-3"></a>

Section 3

## LinkedIn Data Store Mapping LinkedIn

LinkedIn uses **polyglot persistence** — different data stores for different access patterns. Here's how each maps to the data model concepts.

<img src="/diagrams/ddia-ch2/3.svg" alt="ddia-ch2 diagram 3" class="doc-diagram" />

LinkedIn's polyglot persistence: Espresso (source of truth) feeds Kafka, which populates Venice, Pinot, and Galene for specialized access patterns.

### Espresso — Deep Dive LinkedIn {#sec-3-espresso}

Espresso is LinkedIn's distributed document store. Unlike MongoDB (schema-optional, BSON, WiredTiger), Espresso is **schema-first**: every table requires an Avro schema. Documents are serialized as **Avro binary blobs** stored in **MySQL/InnoDB** tables.

#### How Documents Are Actually Stored in MySQL

```sql
-- This is the ACTUAL MySQL table schema inside Espresso storage nodes:

CREATE TABLE Members (
    _key        VARCHAR(255) NOT NULL,    -- partition key (e.g. memberId)
    _subKey1    VARCHAR(255) DEFAULT '',  -- 1st sub-key (for 1-to-many)
    _subKey2    VARCHAR(255) DEFAULT '',  -- 2nd sub-key (nested 1-to-many)
    _value      MEDIUMBLOB,              -- Avro-serialized document (NOT raw JSON!)
    _schemaVersion INT,                  -- which Avro schema version was used
    _etag       VARCHAR(32),             -- optimistic concurrency (compare-and-swap)
    _timestamp  BIGINT,                  -- last modification timestamp
    PRIMARY KEY (_key, _subKey1, _subKey2)
);

-- Max doc size: 2MB default (configurable up to 10MB)
-- Larger blobs go to Ambry (LinkedIn's blob store)
```

**Key insight:** Espresso does NOT store raw JSON on disk. It stores **Avro binary** in a MEDIUMBLOB column. The schema version tracks which Avro schema to use for deserialization. This gives you type safety + compact serialization + backward/forward compatible evolution.

#### Espresso Architecture

<img src="/diagrams/ddia-ch2/4.svg" alt="ddia-ch2 diagram 4" class="doc-diagram" />

Espresso architecture: stateless Routers hash keys to partitions, Helix maps partitions to Storage Nodes running MySQL/InnoDB. Binlog feeds Kafka for CDC to Venice, Pinot, Galene, and cross-DC replicas.

#### Write Path — What Happens When You Write to Espresso

```sql
WRITE PATH (step by step):

T=0ms   Client sends PUT /MemberDB/Profiles/12345 with Avro document
T=1ms   Router receives request:
          1. Parse path → db=MemberDB, table=Profiles, key=12345
          2. FNV hash(12345) → partition 42
          3. Helix lookup: partition 42 → StorageNode2 (LEADER)
          4. Router ALWAYS routes writes to LEADER (never follower)
T=2ms   StorageNode2 executes MySQL INSERT/UPDATE:
          INSERT INTO Profiles (_key, _value, _schemaVersion, _etag, _timestamp)
          VALUES ('12345', <avro_blob>, 3, 'abc123', 1713200000)
          ON DUPLICATE KEY UPDATE ...
          → InnoDB writes to redo log, fsync to disk
          → InnoDB writes to binlog
T=3ms   Leader returns 200 OK to Router → Client
          ⚡ Write is acknowledged on LEADER COMMIT ONLY (not replicated yet!)
T=5ms   BinlogTranslator reads the binlog entry → creates EspressoEvent
T=8ms   KafkaProducer publishes event to topic MemberDB_p42
T=15ms  Follower replicas (same DC) consume and apply event
T=50ms  Cross-DC replicas receive and apply event
T=∞     Router invalidates cache entry for key 12345
```

#### Read Path — What Happens When You Read from Espresso

```
READ PATH (step by step):

T=0ms   Client sends GET /MemberDB/Profiles/12345
T=1ms   Router Netty pipeline:
          1. HTTP Decoder → SSL Handler → Request Parser
          2. EspressoPathParser: extract db, table, key
          3. Authentication → Authorization → ACL Check
          4. PartitionFinder: FNV hash(12345) → partition 42
          5. HostFinder: Helix external view → partition 42 on StorageNode2
          6. Apply RoutingPolicy:
             • LEADER_ONLY: always go to leader (strong consistency)
             • LEADER_THEN_FOLLOWER: try leader, fallback to follower (HA)
          7. Check HostHealthMonitor: is StorageNode2 healthy?
          8. Check L1 cache (OHC off-heap) → MISS
          9. Check L2 cache (Couchbase) → MISS
T=2ms   Router obtains connection from pool → forwards to StorageNode2
T=3ms   StorageNode2 executes MySQL SELECT:
          SELECT _value, _schemaVersion, _etag FROM Profiles WHERE _key='12345'
          → InnoDB B-tree lookup → return Avro blob
T=4ms   Router deserializes Avro blob using schema version 3
T=5ms   Response returned to Client

Cache key format: hash(database + table + primary_key + schema_version)
→ schema_version in cache key = automatic invalidation on schema changes!
```

#### Schema Enforcement — How Espresso Validates Documents

Unlike MongoDB (schema-optional), Espresso **requires an Avro schema for every table**. This is a hard requirement.

#### Schema Enforcement Mechanism

```
// Schema file: database/MemberDB/schemata/document/MemberDB/Profiles/1.avsc
{
  "type": "record",
  "name": "Profile",
  "namespace": "com.linkedin.memberdb",
  "fields": [
    {"name": "firstName", "type": "string"},
    {"name": "lastName",  "type": "string"},
    {"name": "headline",  "type": ["null", "string"], "default": null},
    {"name": "regionId",  "type": "int"},
    {"name": "industryId","type": "int"},
    {"name": "positions", "type": {"type": "array", "items": {
      "type": "record", "name": "Position", "fields": [
        {"name": "title", "type": "string"},
        {"name": "companyId", "type": "long"},
        {"name": "startDate", "type": "string"}
      ]
    }}}
  ]
}

How schema evolution works:
  v1: {firstName, lastName, regionId}
  v2: {firstName, lastName, regionId, headline}  ← added with default null
  v3: {firstName, lastName, regionId, headline, positions[]}

Rules:
  ✓ Add fields with defaults (backward compatible)
  ✓ Remove fields with defaults (forward compatible)
  ✓ Promote types (int → long)
  ✗ Remove required fields → REJECTED
  ✗ Change field type incompatibly → REJECTED
  ✗ Write doc that violates schema → HTTP 422

Where schemas live: ZooKeeper, versioned per table
Each stored row has _schemaVersion → deserializer picks the right schema
```

#### Avro vs JSON — Why Espresso Doesn't Store Raw JSON

This is a critical distinction. When the book says "JSON document," most people picture raw text like `{"name":"Bill"}`. But Espresso stores **Avro binary**, not JSON text. Here's why:

<img src="/diagrams/ddia-ch2/5.svg" alt="ddia-ch2 diagram 5" class="doc-diagram" />

JSON stores field names in every document (bloated, no validation). Avro stores only values; the schema lives separately. Same data: 95 bytes (JSON) vs 15 bytes (Avro) — 6x compression.

#### How Avro Schema Evolution Works in Practice

```
// Scenario: You wrote 1 billion profiles with schema v1.
// Now you want to add a "headline" field.

// Schema v1 (1 billion docs already stored with _schemaVersion=1):
{"fields": [
  {"name": "firstName", "type": "string"},
  {"name": "lastName",  "type": "string"},
  {"name": "regionId",  "type": "int"}
]}

// Schema v2 (new docs get _schemaVersion=2):
{"fields": [
  {"name": "firstName", "type": "string"},
  {"name": "lastName",  "type": "string"},
  {"name": "regionId",  "type": "int"},
  {"name": "headline",  "type": ["null","string"], "default": null}  ← NEW
]}

// READING OLD DOCS (v1) WITH NEW CODE (expects v2):
// Avro reader sees: _schemaVersion=1, looks up schema v1
// "headline" field missing in v1 → Avro fills in DEFAULT (null)
// App gets: {firstName:"Bill", lastName:"Gates", regionId:91, headline:null}
// ✓ Old data reads perfectly with new code!

// READING NEW DOCS (v2) WITH OLD CODE (expects v1):
// Avro reader sees: _schemaVersion=2, looks up schema v2
// Old code doesn't know about "headline" → Avro SKIPS it
// App gets: {firstName:"Bill", lastName:"Gates", regionId:91}
// ✓ New data reads perfectly with old code!

// THIS IS BACKWARD + FORWARD COMPATIBILITY.
// No downtime. No migration of 1 billion rows.
// Compare with MySQL: ALTER TABLE users ADD COLUMN headline TEXT;
// → MySQL copies the ENTIRE table (minutes to hours of downtime)
```

| Feature | JSON | Avro | Protocol Buffers |
| --- | --- | --- | --- |
| **Format** | Text | Binary | Binary |
| **Field names in data** | Yes (bloated) | No (schema has them) | Tag numbers only |
| **Schema required** | No | Yes (Avro .avsc) | Yes (.proto) |
| **Schema evolution** | None (breaks silently) | Add/remove with defaults | Add/remove with tags |
| **Type safety** | Weak (is "91" a string?) | Strong (int, string, array) | Strong |
| **Size (example)** | 95 bytes | 15 bytes | ~18 bytes |
| **Human readable** | Yes | No | No |
| **Used at LinkedIn** | REST APIs, configs | Espresso, Kafka, Spark | gRPC services |

**Interview Insight:** When an interviewer asks "how would you store this data?" and you say "JSON documents" — follow up with: "For storage, I'd use a binary format like Avro or Protobuf. JSON for APIs, Avro for persistence. This gives us type safety, schema evolution without downtime, and 5-6x smaller storage." This shows you understand the difference between a *data model* (document/JSON-like) and a *serialization format* (how it's actually encoded on disk).

#### Secondary Indexes — How You Query by Non-Key Fields

If a profile doc has `regionId: 91`, how do you find all members in Bay Area? You can't scan every partition. Espresso provides **three types of secondary indexes**:

```
// TYPE 1: Lucene-Based Secondary Index (within a partition)
// Physical: Lucene index alongside MySQL on each storage node
GetRequest request = GetRequest.builder()
    .setDatabase("MemberDB").setTable("Profiles")
    .setQuery("regionId=91 AND industryId=96")  // Lucene syntax
    .build();
// Latency: 10-100ms (vs <5ms for point lookups)

// TYPE 2: SQL Query
GetRequest request = GetRequest.builder()
    .setDatabase("MemberDB").setTable("Profiles")
    .setSqlQuery("SELECT * FROM Profiles WHERE regionId = 91")
    .build();

// TYPE 3: Global Secondary Index (GSI) — spans ALL partitions
// When regionId=91 could be on ANY partition:
GetRequest request = GetRequest.builder()
    .setDatabase("MemberDB").setTable("Profiles")
    .setGlobalIndexName("region_index")      // pre-declared GSI
    .setQuery("regionId=91")
    .build();
// Router does scatter-gather: queries ALL partitions, aggregates results

// HOW SECONDARY INDEXES ACTUALLY WORK:
// Each storage node maintains a Lucene index alongside MySQL.
// When a doc is written, the indexed fields are also written to Lucene.
// Declarative: you declare indexes in config, Espresso maintains them.
// No Kafka consumer needed (unlike manually maintaining a separate table).
```

#### The "Storing IDs" Question — Object-Relational Mismatch

The book asks: if you store `regionId: 91` instead of `"Greater Seattle Area"`, how does anyone know what 91 means? This is the **impedance mismatch** between app objects and stored data:

#### Why Store IDs Instead of Strings?

```
// BAD: Storing the string directly
{"region": "Greater Seattle Area", "industry": "Philanthropy"}
  → If Seattle renames a district, update EVERY profile that has it
  → Inconsistent spelling: "Greater Seattle Area" vs "Seattle Area"
  → Can't localize: French users see English region names
  → Search is dumb: "Washington state" doesn't match "Seattle"

// GOOD: Storing an ID (normalization)
{"regionId": 91, "industryId": 131}
  → Region name stored ONCE in a regions table/doc
  → Update the name in ONE place, all profiles reflect it
  → Localization: regionId 91 → "Greater Seattle Area" (EN) / "Région de Seattle" (FR)
  → Search: regionId 91 encodes that Seattle is in Washington state

// THE TRADE-OFF:
// Storing IDs = you need a JOIN (or a follow-up query) to show the human name
// In Espresso: no JOINs! So the client does TWO queries:
//   1. GET /MemberDB/Profiles/12345 → {regionId: 91, ...}
//   2. GET /MemberDB/Regions/91 → {name: "Greater Seattle Area"}
// Or: denormalize into Venice (pre-joined, read-optimized)
```

#### 1-to-Many in Espresso: Sub-Keys

Espresso models one-to-many using its **hierarchical key structure** with sub-keys. The primary key is `(_key, _subKey1, _subKey2)`:

```
// EXAMPLE: Messaging (1 member has many conversations, 1 conversation has many messages)

Database: MessagingDB (256 partitions)

Table: Conversations
  _key = memberId          ← the "one" (also partition key)
  _subKey1 = conversationId ← the "many"
  _value = {participants: [...], title: "...", lastMessageTs: ...}

// Get ALL conversations for member 12345:
GET /MessagingDB/Conversations/12345?start=0&count=50
→ Returns all rows where _key='12345' (co-located on same MySQL instance!)

// Get ONE specific conversation:
GET /MessagingDB/Conversations/12345/conv789
→ MySQL: SELECT * WHERE _key='12345' AND _subKey1='conv789'

Table: Messages
  _key = conversationId    ← the "one"
  _subKey1 = messageId     ← the "many"
  _value = {senderId: ..., text: "...", timestamp: ...}

// Get all messages in a conversation:
GET /MessagingDB/Messages/conv789?start=0&count=100

// WHY THIS IS EFFICIENT:
// All docs sharing the same _key are on the SAME MySQL instance
// (same partition = same node) → no cross-node queries for 1-to-many!
// This is DATA LOCALITY — the same advantage as embedding in MongoDB,
// but with the ability to paginate and query sub-keys independently.
```

#### Many-to-Many in Espresso: Junction Tables + GSI

```
// EXAMPLE: Members ↔ Skills (with endorsements)
// One member has many skills, one skill belongs to many members

// APPROACH: Junction/association table
Table: MemberSkills
  _key = memberId          ← partition key
  _subKey1 = skillId       ← which skill
  _value = {endorserIds: [67890, 11111], endorsedAt: "2024-01"}

// "What skills does member 12345 have?"
GET /SkillsDB/MemberSkills/12345
→ Fast! All on same partition.

// "Who has the skill 'Cloud Computing' (skillId=500)?"
// PROBLEM: skillId is _subKey1, not _key. Data is partitioned by memberId.
// Skill 500 could be on ANY partition!

// SOLUTION 1: Global Secondary Index
GET /SkillsDB/MemberSkills?gsi=skill_index&query=skillId=500
→ Router scatter-gathers across ALL partitions (expensive but works)

// SOLUTION 2: Denormalized reverse table
Table: SkillMembers  ← separate table, partitioned by skillId
  _key = skillId           ← partition key
  _subKey1 = memberId      ← which member
  _value = {endorserCount: 2}

GET /SkillsDB/SkillMembers/500
→ Fast! But now you maintain TWO tables. Kafka CDC keeps them in sync.

// SOLUTION 3: Use Liquid (graph DB) for the relationship
// (Satya)--[HAS_SKILL{endorsers:[...]}]-->(Cloud)
// Graph traversal naturally handles many-to-many.

// ESPRESSO'S LIMITATION:
// No JOINs across tables. No cross-partition queries (without GSI/scatter).
// Many-to-many requires either:
//   a) GSI (expensive scatter-gather)
//   b) Denormalized reverse table (extra write amplification)
//   c) Move to a graph DB (Liquid) for relationship-heavy access
```

#### FNV Hashing — How Key "12345" Maps to Partition 42

The partition assignment formula is simple: `partition = FNV_hash(key) % numPartitions`. FNV (Fowler-Noll-Vo) is a fast, non-cryptographic hash. You can verify with `esretool calc fnvhash -n 256 -k "12345"`.

<img src="/diagrams/ddia-ch2/6.svg" alt="ddia-ch2 diagram 6" class="doc-diagram" />

FNV hash maps a key to one of 256 fixed partitions. Helix assigns partitions to storage nodes. This is NOT a consistent hash ring — Helix manages assignment via a state machine.

#### Does the Router Load the Schema? Who Deserializes Avro?

#### The Router Does NOT Deserialize Avro

```sql
READ RESPONSE FLOW — Who handles what:

Storage Node (MySQL):
  SELECT _value, _schemaVersion, _etag FROM Profiles WHERE _key='12345'
  → Returns raw bytes: _value = [08 42 69 6C 6C 0A 47 61 74 65 73 ...]
  → The storage node does NOT interpret the blob. It's just bytes.

Router (Netty):
  → Receives raw bytes from storage node
  → Passes them through to client AS-IS (opaque blob)
  → Router does NOT load Avro schemas
  → Router does NOT deserialize the document
  → Router is a STATELESS PROXY — it only knows about keys and partitions

Client SDK (espresso-pub):
  → Receives the raw Avro bytes + _schemaVersion number
  → Looks up schema v3 from ZooKeeper (cached locally after first fetch)
  → Uses SpecificDatumReader to deserialize:
     SpecificDatumReader<Profile> reader = new SpecificDatumReader<>(schemaV3);
     Profile profile = reader.read(null, decoderFactory.binaryDecoder(bytes));
  → Now you have a typed Java object: profile.getFirstName() → "Bill"

WHO NEEDS THE SCHEMA:
  ┌─────────────┬───────────────────────────────────────────────┐
  │ Component   │ Needs Schema?                                 │
  ├─────────────┼───────────────────────────────────────────────┤
  │ Client SDK  │ YES — to deserialize Avro bytes into objects  │
  │ Router      │ NO  — treats _value as opaque bytes           │
  │ Storage Node│ NO  — MySQL stores MEDIUMBLOB, doesn't parse  │
  │ ZooKeeper   │ YES — stores all versioned schemas            │
  │ Lucene Index│ YES — needs to extract indexed fields          │
  └─────────────┴───────────────────────────────────────────────┘

EXCEPTION: The Lucene index on the storage node DOES need to understand
the schema — when a document is written, the storage node deserializes
the indexed fields to update the Lucene index. But this only happens
on the WRITE path, not on reads.
```

#### MySQL Table vs Avro Schema — No Column Per Field!

```
COMMON MISCONCEPTION: "Avro schema fields become MySQL columns"
REALITY: The ENTIRE document is ONE blob column (_value)

Avro Schema:                    MySQL Table:
┌─────────────────────┐         ┌──────────────────────────────┐
│ firstName: string   │         │ _key      VARCHAR(255)  PK   │
│ lastName:  string   │    →    │ _subKey1  VARCHAR(255)  PK   │
│ regionId:  int      │  NOT    │ _subKey2  VARCHAR(255)  PK   │
│ positions: array[]  │ columns │ _value    MEDIUMBLOB ← EVERYTHING│
│ headline:  string   │         │ _schemaVersion INT           │
└─────────────────────┘         │ _etag     VARCHAR(32)        │
                                │ _timestamp BIGINT            │
                                └──────────────────────────────┘

WHY? Because Espresso is a DOCUMENT store using MySQL for:
  ✓ ACID transactions (InnoDB)
  ✓ Proven durability (redo log, fsync)
  ✓ Efficient B-tree primary key lookup
  ✗ NOT for relational queries on individual fields
  ✗ NOT for SQL JOINs between tables

To query individual fields → use Lucene secondary index or GSI
MySQL only does: lookup by _key (+ optional _subKey1, _subKey2)
```

#### How Espresso Finds Your Row Among Millions — The Full Index Chain

When you do `GET /MemberDB/Profiles/12345`, how does Espresso find that one row out of **800 million+ member profiles**? It's a 3-stage funnel: partitioning narrows 800M rows to ~3M, then InnoDB's B-tree narrows 3M to 1 in ~3 disk reads.

<img src="/diagrams/ddia-ch2/7.svg" alt="ddia-ch2 diagram 7" class="doc-diagram" />

The 3-stage funnel: Partitioning narrows 800M to ~3M rows, InnoDB B+ tree finds the exact row in 2-3 page reads, client deserializes Avro. Total: 2-5ms for a point lookup.

#### InnoDB Buffer Pool — Why It's Usually Faster Than 2 Disk Reads

```
InnoDB keeps frequently accessed pages in a RAM cache called the BUFFER POOL.

Buffer Pool size: typically 70-80% of storage node RAM (e.g., 200GB on a 256GB node)

What's cached:
  ✓ Root page of every B+ tree index → ALWAYS in RAM
  ✓ Internal pages (levels 1-2) → almost always in RAM (only a few thousand pages)
  ✓ Hot leaf pages (frequently accessed members) → often in RAM

For a HOT key (e.g., celebrity profile accessed 1000x/sec):
  Root page: RAM hit         → 0 disk reads
  Internal page: RAM hit     → 0 disk reads
  Leaf page: RAM hit         → 0 disk reads
  Total: 0 disk reads, ~0.1ms ← ALL from buffer pool!

For a COLD key (e.g., inactive member, first access in weeks):
  Root page: RAM hit         → 0 disk reads
  Internal page: RAM hit     → 0 disk reads
  Leaf page: DISK READ       → 1 disk read (~0.1ms SSD, ~5ms HDD)
  Total: 1 disk read, ~0.5ms on SSD

For a VERY COLD key (partition just moved to this node):
  Root page: DISK READ       → 1 disk read
  Internal page: DISK READ   → 1 disk read
  Leaf page: DISK READ       → 1 disk read
  Total: 3 disk reads, ~1.5ms on SSD ← worst case

PLUS: Espresso's L1 (OHC) and L2 (Couchbase) caches sit BEFORE MySQL.
Hot profiles (Satya Nadella, Bill Gates) might never even reach InnoDB.
Cache hit → return in ~0.05ms (50 microseconds).
```

#### What About the Lucene Secondary Index? How Is It Different?

```
PRIMARY KEY LOOKUP (B+ tree — what we just described):
  "Give me the profile for userId 12345"
  → Hash to partition → B+ tree → exact row → done
  → O(log N) where N = rows in partition
  → 2-5ms

SECONDARY INDEX LOOKUP (Lucene — for non-key fields):
  "Give me all profiles where regionId = 91"
  → regionId is NOT part of the B+ tree primary key
  → MySQL can't use the B+ tree for this query!
  → Without an index: FULL TABLE SCAN of 3.1M rows = seconds/minutes
  → With Lucene secondary index:
      1. Lucene inverted index: regionId=91 → [docId_1, docId_7, docId_42, ...]
      2. For each docId, fetch the full row from InnoDB B+ tree
      3. Return matching docs
  → O(K) where K = number of matching docs
  → 10-100ms

WHY LUCENE, NOT A MYSQL SECONDARY INDEX?
  MySQL secondary indexes ARE B+ trees too, but:
  ✓ Lucene supports full-text search, range queries, boolean logic
  ✓ Lucene supports compound queries: "regionId=91 AND industryId=96"
  ✓ Espresso's Lucene is updated synchronously with writes
  ✗ MySQL secondary index would need separate B+ tree per indexed column
  ✗ MySQL secondary index can't do full-text or complex boolean queries

GLOBAL SECONDARY INDEX (GSI — for cross-partition queries):
  "Give me all profiles where regionId = 91 ACROSS ALL PARTITIONS"
  → regionId=91 members are scattered across all 256 partitions
  → Local Lucene only searches ONE partition
  → GSI: separate service that indexes ALL partitions globally
  → Router routes to GSI provider instead of a specific partition
  → 50-200ms (slower: must aggregate results from global index)
```

**Interview One-Liner:** "Partitioning narrows 800M rows to 3M (hash). The B+ tree narrows 3M to 1 in 3 page reads (O(log N)). The buffer pool caches hot pages in RAM so most lookups are 0 disk reads. For non-key fields, Lucene inverted index avoids full table scans. For cross-partition queries, GSI aggregates globally."

#### Local Lucene Index vs GSI — Where They Live, How Queries Route

<img src="/diagrams/ddia-ch2/8.svg" alt="ddia-ch2 diagram 8" class="doc-diagram" />

Local Lucene index lives on each storage node (fast, single partition). GSI lives on a separate service (slower, spans all partitions). There is NO automatic fallback between them — the client must choose the right query path.

#### Anti-Pattern: Missing GSI Can Cause Outages

```
// SCENARIO: You need "all members at company X" but forgot to create a GSI

// BAD: Full table scan (scatter-gather all 256 partitions)
GetRequest request = GetRequest.builder()
    .setDatabase("MemberDB").setTable("Positions")
    .setQuery("companyId=1035")
    .setCount(Integer.MAX_VALUE)    // ← NEVER DO THIS
    .build();
// → Router fans out to ALL 256 partitions (32 storage nodes)
// → Each node scans its local data
// → 429 TOO_MANY_REQUESTS (quota exhausted)
// → 504 GATEWAY_TIMEOUT (query too slow)
// → Other queries to the same nodes slow down
// → CASCADING FAILURE = OUTAGE

// GOOD: Use a pre-declared GSI
GetRequest request = GetRequest.builder()
    .setDatabase("MemberDB").setTable("Positions")
    .setGlobalIndexName("company_index")  // ← pre-provisioned GSI
    .setQuery("companyId=1035")
    .setStart(0).setCount(100)             // ← always paginate!
    .build();

// ALTERNATIVE: If cross-partition queries are common,
// Espresso recommends using HDFS/Spark for batch analysis,
// NOT Espresso as a query engine for analytics workloads.
```

#### Espresso vs MongoDB

| Aspect | Espresso | MongoDB |
| --- | --- | --- |
| **Schema** | Required (Avro) — schema-on-write | Optional — schema-on-read |
| **Storage** | Avro binary in MySQL/InnoDB BLOB | BSON in WiredTiger |
| **Transactions** | Single-partition ACID (InnoDB) | Multi-document ACID (since 4.0) |
| **Consistency** | Strong on leader, eventual on follower | Configurable |
| **Secondary Index** | Lucene-based + GSI | B-tree based, built-in |
| **Partitioning** | FNV hash, fixed count, Helix-managed | Range or hash, dynamic |
| **JOINs** | Not supported | $lookup (limited) |
| **Replication** | Binlog → Kafka → followers | Oplog → replica sets |
| **Caching** | Built-in (OHC + Couchbase) | External (Redis) |
| **Max Doc** | 2MB (10MB max) | 16MB |
| **Read p99** | 5-15ms | Variable |

### Venice — Derived Key-Value Store LinkedIn {#sec-3-venice}

#### Pre-computed ML Features in Venice

```
// Venice stores pre-computed, read-optimized data
// Key: memberId, Value: feature vector (derived from Espresso + Kafka)

Key: "member:12345"
Value: {
  "profileCompleteness": 0.92,
  "connectionCount": 2847,
  "avgEndorsements": 15.3,
  "industryVector": [0.23, 0.87, ...],  // ML embedding
  "lastActiveTs": 1713200000
}

// Batch push: Spark job computes features → pushes to Venice
// Stream write: Samza/Flink updates in near-real-time via Kafka
```

**When to use:** When you need pre-computed, read-heavy lookups (ML features, recommendation scores, "People You May Know" precomputed lists).

### Pinot — Real-Time OLAP Analytics LinkedIn {#sec-3-pinot}

#### "Who Viewed Your Profile" Analytics in Pinot

```sql
// Pinot uses columnar storage optimized for aggregation queries
// Schema: star-schema with dimensions and metrics

Table: profile_views
Columns: viewer_id, viewed_id, timestamp, viewer_industry,
         viewer_region, viewer_seniority, device_type

// PQL Query: "How many people from tech viewed my profile this week?"
SELECT COUNT(*), viewer_seniority
FROM profile_views
WHERE viewed_id = 12345
  AND timestamp > ago('7d')
  AND viewer_industry = 'Technology'
GROUP BY viewer_seniority
ORDER BY COUNT(*) DESC
LIMIT 10
```

**When to use:** Real-time analytics dashboards, ad impression counting, A/B test metrics. Not for transactional reads/writes.

### Galene / SEAS — Search Index LinkedIn {#sec-3-galene}

#### People Search via Galene

```
// Galene builds inverted indexes from Espresso data (via Kafka)
// Search doc indexed for member:

{
  "memberId": 12345,
  "name": "Satya Nadella",
  "headline": "CEO at Microsoft",
  "skills": ["Cloud Computing", "AI", "Enterprise Software"],
  "company": "Microsoft",
  "location": "Redmond, WA",
  "connections": 2847,
  "profileStrength": 0.92
}

// Query: "AI engineers in Bay Area" →
// BM25 text match + geo filter + connection-distance boost
// Results ranked by: relevance × network proximity × profile strength
```

**When to use:** Full-text search, typeahead, faceted filtering. Galene is LinkedIn's custom search engine (Lucene-based). Not a source of truth — rebuilt from Espresso via Kafka.

### Liquid — Graph Database Deep Dive LinkedIn {#sec-3-liquid}

Liquid is LinkedIn's **in-memory distributed graph database**. It stores the **Economic Graph** — the graph of all professional entities (members, companies, jobs, skills, schools). Unlike Espresso (document store) or Neo4j (disk-based property graph), Liquid keeps the entire graph **in RAM** for sub-millisecond traversals.

#### Liquid Architecture

<img src="/diagrams/ddia-ch2/9.svg" alt="ddia-ch2 diagram 9" class="doc-diagram" />

Liquid architecture: Espresso CDC → Kafka → Ingestion Server → Log Consumer → In-memory Shards (C++). Broker distributes Prologin queries across shards via gRPC. Everything lives in RAM.

#### The Data Model: Triples, Not Property Graphs

Liquid uses a **triple-store model** (like the book's RDF/SPARQL section), not a property graph (Neo4j). Everything is an `Edge(subject, predicate, object)`. Related edges are grouped into **Compounds**.

```
// LIQUID DATA MODEL: Edge(subject, predicate, object) — three strings

// Simple facts (like RDF triples):
Edge("urn:li:member:12345", "name", "Satya Nadella").
Edge("urn:li:member:12345", "works-at", "urn:li:company:1035").
Edge("urn:li:company:1035", "name", "Microsoft").

// COMPOUND TYPE: groups related edges under a hub node
// A Connection between two members:
DefCompound("Connection",
  "Connection/left_member", "Connection/right_member").

Connection@(
  Connection/left_member = "urn:li:member:12345",    // Satya
  Connection/right_member = "urn:li:member:67890"    // Bill
).
// This creates a hub node with edges to both members

// Properties on the connection (additional edges on the hub):
Edge(hub, "Connection/left_score", "95").
Edge(hub, "Connection/creation_date", "2015-03-14").

// VS NEO4J (property graph):
// (Satya)-[:CONNECTED_TO {score: 95, since: "2015-03-14"}]->(Bill)
// In Liquid, properties are MORE edges, not key-value pairs on the edge.
```

#### Prologin: Liquid's Declarative Query Language

Liquid uses **Prologin** — a Datalog-based language (the same family the book discusses!). It's **declarative**: you write rules describing what you want, the engine figures out how.

#### Graph Traversals in Prologin

```
// 1ST DEGREE: All direct connections of member 12345
Connected(src, dest) :-
    Connection@(Connection/left_member=src, Connection/right_member=dest).
Connected(src, dest) :-
    Connection@(Connection/left_member=dest, Connection/right_member=src).

// Query: Who is member:12345 connected to?
Connected("urn:li:member:12345", who)?
// → "urn:li:member:67890", "urn:li:member:11111", ...
// Latency: sub-millisecond (in-memory index lookup)

// 2ND DEGREE: Friends-of-friends
SecondDegree(src, fof) :-
    Connected(src, mid),       // my connection
    Connected(mid, fof),       // their connection
    src != fof.                // not myself

SecondDegree("urn:li:member:12345", who)?
// Latency: low single-digit milliseconds (two-hop join)

// PEOPLE YOU MAY KNOW (PYMK):
PYMK(me, candidate, sharedCount) :-
    SecondDegree(me, candidate),
    NOT Connected(me, candidate),       // not already connected
    count(mid: Connected(me, mid), Connected(mid, candidate)) = sharedCount.
// → rank by sharedCount descending

// MUTUAL CONNECTIONS (shown on profile page):
Mutual(viewer, target, mutual) :-
    Connected(viewer, mutual),
    Connected(mutual, target).

Mutual("urn:li:member:99999", "urn:li:member:12345", who)?
// → all people connected to both the viewer and Satya

// CONNECTION DEGREE (1st, 2nd, 3rd):
// This is what powers the "1st", "2nd", "3rd" badges on LinkedIn!
Degree1(me, other) :- Connected(me, other).
Degree2(me, other) :- Connected(me, mid), Connected(mid, other),
                      NOT Connected(me, other), me != other.
Degree3(me, other) :- Connected(me, a), Connected(a, b), Connected(b, other),
                      NOT Connected(me, other), NOT Degree2(me, other),
                      me != other.
```

#### When to Use a Graph DB (vs Document/Relational)

#### The Book's Rule: "As data becomes more interconnected, move from Document → Relational → Graph"

```
USE DOCUMENT (Espresso/MongoDB) WHEN:
  ✓ Data is mostly self-contained trees (profiles, products, events)
  ✓ 1-to-many is the dominant pattern
  ✓ You rarely need JOINs across documents
  Example: A member profile with embedded positions and education

USE RELATIONAL (MySQL/PostgreSQL) WHEN:
  ✓ Many-to-many relationships exist but are manageable
  ✓ JOINs are needed but the number of joins is known in advance
  ✓ ACID transactions across related tables
  Example: Orders → Products → Inventory (e-commerce)

USE GRAPH (Liquid/Neo4j) WHEN:
  ✓ EVERYTHING is related to EVERYTHING (social networks)
  ✓ Traversal depth is variable (1st, 2nd, 3rd degree)
  ✓ The query "who is connected to whom?" IS the core product
  ✓ You need 10-100+ joins in real-time
  Example: Connections, PYMK, endorsements, "people at company X who
           know people at company Y who have skill Z"
```

| Aspect | Liquid | Neo4j | Meta TAO |
| --- | --- | --- | --- |
| **Storage** | In-memory (distributed) | Disk-based (with cache) | Cache over MySQL |
| **Query Language** | Prologin (Datalog) | Cypher | Simple get/assoc API |
| **Data Model** | Triples + Compounds | Property graph | Objects + Associations |
| **Traversal Latency** | <1ms (1st deg), <100ms (multi-hop) | ms-seconds | ms (cache hit) |
| **Durability** | Kill-9 only (NOT source of truth) | Full ACID | MySQL is SoT |
| **Designed for** | Complex multi-hop joins (10-100+) | General graph | Simple social lookups |
| **Ingestion** | Kafka CDC from Espresso | Direct writes | Direct writes to MySQL |

**Interview Connection to the Book:** The book's chapter covers Cypher (Neo4j), SPARQL (triple-stores), and Datalog. Liquid's Prologin is *literally Datalog* — the same query language the book calls "the foundation that later query languages build upon." When an interviewer asks about graph databases, you can say: "LinkedIn uses Liquid, which uses a Datalog-based query language called Prologin. It's a triple-store (like SPARQL), not a property graph (like Neo4j). The advantage of Datalog is composable rules — you define `Connected`, then `SecondDegree` uses `Connected`, then `PYMK` uses `SecondDegree`. Each rule builds on the last."

[↑ Back to Contents](#toc)

<a id="sec-3b"></a>

Section 3B

## LinkedIn Profile Browsing — End-to-End Data Flow LinkedIn

When you open a LinkedIn profile, click a company, browse jobs — each click triggers queries across **multiple data stores**. This is the book's composite data system in action. Let's trace every click.

<img src="/diagrams/ddia-ch2/10.svg" alt="ddia-ch2 diagram 10" class="doc-diagram" />

Every click on LinkedIn crosses multiple data stores. Secondary indexes are needed when querying by a field that isn't the partition key. Each downstream store is populated differently.

### Materialized Views — Pre-Computed Query Results

The book talks about derived data throughout. At LinkedIn, **Venice** is the materialized view layer. A materialized view is a **pre-computed result** stored separately from the source data, so reads are instant instead of computing on the fly.

#### Materialized View Example: "People You May Know"

```
// SOURCE DATA (in Espresso + Liquid):
//   Member profiles, connections graph, activity events

// COMPUTATION (Spark batch job, runs nightly):
//   For each member:
//     1. Get their connections from Liquid
//     2. Get friends-of-friends (2nd degree)
//     3. Filter out existing connections
//     4. Score by shared connections, industry, school
//     5. Rank top 100 candidates

// MATERIALIZED VIEW (pushed to Venice):
Key: "pymk:12345"
Value: {
  candidates: [
    {memberId: 67890, score: 0.95, sharedConns: 23, reason: "Microsoft"},
    {memberId: 11111, score: 0.87, sharedConns: 15, reason: "Harvard"},
    ...
  ],
  computedAt: "2026-04-16T03:00:00Z"
}

// READING THE VIEW (at profile page load time):
GET venice/pymk:12345 → instant! No graph traversal at read time.

// WHY MATERIALIZE?
// Computing PYMK from scratch = traverse graph (seconds)
// Reading pre-computed Venice result = key-value lookup (<5ms)
// Trade-off: data is stale (nightly batch), but reads are 1000x faster
```

### Couchbase Cache — How It Gets Updated

Espresso has a **two-tier cache**: L1 (OHC off-heap, per router) and L2 (Couchbase, shared across routers). Here's exactly how the cache stays consistent:

```
CACHE UPDATE FLOW:

1. READ PATH (cache HIT):
   Client → Router → check L1 OHC → HIT → return cached doc
   (never touches Espresso storage node or MySQL)

2. READ PATH (cache MISS):
   Client → Router → check L1 → MISS → check L2 Couchbase → MISS
   → query Espresso Storage Node → MySQL SELECT
   → return doc to client
   → POPULATE L1 cache (local OHC, TTL-based eviction)
   → POPULATE L2 cache (Couchbase, shared, larger)
   Cache key = hash(database + table + primary_key + schema_version)
                                                    ^^^^^^^^^^^^
   schema_version in cache key → schema change = automatic invalidation!

3. WRITE PATH (cache INVALIDATION):
   Client writes to Espresso → Leader commits to MySQL
   → Router INVALIDATES cache entry in L1 AND L2
   → Next read will be a cache miss → fresh data fetched
   → Cache repopulated with new version

4. SCHEMA CHANGE (automatic invalidation):
   Schema v2 deployed → cache key includes schema_version
   → All existing cache entries (schema v1 keys) become stale
   → New reads generate new cache keys with v2 → cache miss → fresh data

WHY TWO TIERS?
  L1 (OHC): ~100MB per router, nanosecond access, local only
  L2 (Couchbase): ~100GB shared pool, microsecond access, survives router restart
  Combined: 95%+ cache hit rate for hot profiles
```

**Interview Connection to the Book:** The book says "if you have an application-managed caching layer (Memcached or similar) separate from your main database, it is normally the application code's responsibility to keep those caches and indexes in sync." At LinkedIn, Espresso *builds this into the infrastructure*: the Router handles cache population and invalidation automatically. Galene/Venice are populated via Kafka CDC. This is the **composite data system** from Figure 1-1 of the book — but with the sync mechanism built into the platform, not left to application developers.

[↑ Back to Contents](#toc)

<a id="sec-4"></a>

Section 4

## Modeling Relationships MetaGoogleLinkedIn

The book uses a **LinkedIn profile** as the canonical example. A profile has exactly one name but multiple positions, education entries, and skills. This is the **Object-Relational Mismatch** (impedance mismatch): your app objects are trees, but SQL tables are flat rows.

### One-to-Many (User → Positions, Skills) {#sec-4-one}

Three ways to represent 1-to-many. Each has real tradeoffs:

#### Option A: Relational (Normalized, Separate Tables + FK)

```sql
-- The "textbook SQL" approach from the book (Figure 2-1)
CREATE TABLE users (
  user_id INT PRIMARY KEY, first_name TEXT, last_name TEXT,
  region_id INT REFERENCES regions(id),    -- many-to-one FK
  industry_id INT REFERENCES industries(id)
);
CREATE TABLE positions (
  id INT PRIMARY KEY, user_id INT REFERENCES users(user_id),
  job_title TEXT, organization TEXT
);
CREATE TABLE education (
  id INT PRIMARY KEY, user_id INT REFERENCES users(user_id),
  school_name TEXT, start_year INT, end_year INT
);

-- To fetch a full profile: multi-table JOIN (or N+1 queries)
SELECT u.*, p.job_title, p.organization
FROM users u JOIN positions p ON u.user_id = p.user_id
WHERE u.user_id = 251;
-- PROBLEM: messy multi-way join for one profile page load
```

#### Option B: Document (Embedded, Single Fetch)

```
// The JSON/document approach — what Espresso and MongoDB use
// This is the SAME profile, but as a self-contained document:
{
  "user_id": 251,
  "first_name": "Bill", "last_name": "Gates",
  "region_id": "us:91",
  "industry_id": 131,
  "positions": [  // 1-to-many: embedded RIGHT IN the document
    {"job_title": "Co-chair", "organization": "Bill & Melinda Gates Foundation"},
    {"job_title": "Co-founder", "organization": "Microsoft"}
  ],
  "education": [  // 1-to-many: embedded
    {"school_name": "Harvard University", "start": 1973, "end": 1975},
    {"school_name": "Lakeside School", "start": null, "end": null}
  ]
}
// ONE query fetches everything. No JOINs.
// The 1-to-many relationship forms a TREE — and JSON makes this tree explicit.
```

#### Option C: Espresso Sub-Keys (Best of Both)

```
// Espresso's unique approach: sub-keys give you document locality
// WITH the ability to query/paginate children independently

Table: Profiles   _key=memberId                → profile doc
Table: Positions  _key=memberId, _subKey1=posId → each position is a separate doc
Table: Education  _key=memberId, _subKey1=eduId → each education is a separate doc

// Get full profile:
GET /MemberDB/Profiles/251        → the profile doc
GET /MemberDB/Positions/251       → ALL positions (same partition = same node!)
GET /MemberDB/Education/251       → ALL education entries

// Get just one position:
GET /MemberDB/Positions/251/pos2  → only the 2nd position

// WHY this works: _key=memberId is the partition key.
// All data for member 251 lives on the SAME MySQL instance.
// You get document locality WITHOUT embedding everything in one blob.
```

<img src="/diagrams/ddia-ch2/11.svg" alt="ddia-ch2 diagram 11" class="doc-diagram" />

A LinkedIn profile is a tree: 1-to-many branches (positions, education) are embedded or use sub-keys. Many-to-one references (region, industry) store IDs pointing to shared entities.

### Many-to-One (Members → Region, Industry) {#sec-4-many-one}

<img src="/diagrams/ddia-ch2/12.svg" alt="ddia-ch2 diagram 12" class="doc-diagram" />

Many-to-one: many members share one region. Store the ID, not the string. This is normalization — and it requires JOINs (easy in SQL, hard in documents).

### Many-to-Many (Members ↔ Skills, Endorsements) {#sec-4-many-many}

<img src="/diagrams/ddia-ch2/13.svg" alt="ddia-ch2 diagram 13" class="doc-diagram" />

Many-to-many: members have many skills, each skill belongs to many members. Junction tables (relational) or edges (graph) are the clean solutions. Documents struggle here.

[↑ Back to Contents](#toc)

<a id="sec-5"></a>

Section 5

## Schema-on-Read vs Schema-on-Write MetaGoogle

#### Schema-on-Write (Relational)

Like static typing (compile-time checks)

-   Schema is **explicit**, enforced on every write
-   DB rejects invalid data
-   Schema changes via `ALTER TABLE`
-   MySQL: ALTER copies entire table (slow!)
-   Good when all records have same structure

```sql
ALTER TABLE users ADD COLUMN first_name text;
UPDATE users SET first_name =
  substring_index(name, ' ', 1);
```

#### Schema-on-Read (Document)

Like dynamic typing (runtime checks)

-   Schema is **implicit**, interpreted on read
-   Any JSON shape is accepted
-   Code handles old + new formats
-   No downtime for schema changes
-   Good when data is heterogeneous

```
// Handle old docs at read time:
if (user && user.name && !user.first_name) {
  user.first_name = user.name.split(" ")[0];
}
```

**Interview Tip:** Neither is universally better. Schema-on-write gives **guarantees** (great for financial data). Schema-on-read gives **flexibility** (great for rapidly evolving features). Espresso gives you both: JSON docs with optional secondary index enforcement.

[↑ Back to Contents](#toc)

<a id="sec-6"></a>

Section 6

## Query Languages: Declarative vs Imperative Google

<img src="/diagrams/ddia-ch2/14.svg" alt="ddia-ch2 diagram 14" class="doc-diagram" />

Declarative tells the database WHAT you want; imperative tells it HOW. SQL won because the query optimizer handles the HOW automatically.

**Key Insight for Interviews:** MapReduce is *between* declarative and imperative — you write `map()` and `reduce()` functions, but the framework handles distribution. MongoDB eventually added a declarative aggregation pipeline (reinventing SQL!). The moral: declarative wins in the long run because it enables the engine to optimize.

[↑ Back to Contents](#toc)

<a id="sec-7"></a>

Section 7

## When to Use What — The Complete Decision Guide MetaGoogleLinkedIn

This is the most common interview question: "Which database would you use?" The answer is always: **it depends on the access pattern.** Here's every scenario mapped to the right store.

<img src="/diagrams/ddia-ch2/15.svg" alt="ddia-ch2 diagram 15" class="doc-diagram" />

The complete decision guide: pick your store by access pattern. In production, you'll use 3-5 of these together (polyglot persistence), connected by Kafka CDC.

### Quick Decision Table

| Scenario | Store | Why |
| --- | --- | --- |
| "Get profile by memberId" | **Espresso** | Point lookup by key, <5ms, source of truth |
| "Update member's headline" | **Espresso** | CRUD writes go to source of truth first |
| "Get pre-computed PYMK list" | **Venice** | Read-only materialized view, pre-computed by Spark |
| "Get ML feature vector for ranking" | **Venice** | Derived data, batch/stream pushed, fast key lookup |
| "Search AI engineers in Bay Area" | **Galene** | Full-text + faceted search, relevance ranking |
| "Autocomplete as user types" | **Galene** | Prefix search on inverted index, typeahead |
| "How many views this week?" | **Pinot** | COUNT/GROUP BY aggregation over events |
| "Ad click-through rate by region" | **Pinot** | Real-time analytics, columnar, star-tree index |
| "Who are mutual connections?" | **Liquid** | 2-hop graph traversal, in-memory, <5ms |
| "1st/2nd/3rd degree badge" | **Liquid** | Variable-depth graph traversal, Prologin rules |
| "Speed up hot profile reads" | **Couchbase** | L2 cache for Espresso, shared across routers |
| "Complex SQL JOINs across tables" | **MySQL direct** | Espresso doesn't support JOINs; MySQL does natively |
| "Financial transactions (ACID)" | **MySQL direct** | Multi-table ACID, foreign key constraints |
| "Batch analytics on all profiles" | **HDFS / Spark** | Full table scans, ETL — never do this on Espresso! |

#### The Golden Rule for Interviews

```
Source of Truth:     Espresso (writes go here FIRST)
                         │
                    Kafka CDC (binlog → events)
                    ┌────┼────┬────────┐
                    ▼    ▼    ▼        ▼
Read-optimized:  Venice  Galene  Pinot  Liquid
                 (K-V)  (Search) (OLAP) (Graph)

Cache layer:     Couchbase (fronts Espresso reads)

Batch/ETL:       HDFS + Spark (never query Espresso directly for analytics)

RULE: Write to Espresso → Kafka propagates → downstream stores update.
      Each downstream store is optimized for ONE access pattern.
      This is POLYGLOT PERSISTENCE — the core idea of this chapter.
```

[↑ Back to Contents](#toc)

<a id="sec-8"></a>

Section 8

## Real-World Data Models — Facebook, Netflix, YouTube MetaNetflixGoogle

Every interview asks "how would you store X?" Here's exactly what data model and store the big companies use for each feature, with the trade-offs that drove those decisions.

<img src="/diagrams/ddia-ch2/16.svg" alt="ddia-ch2 diagram 16" class="doc-diagram" />

Every Facebook/Meta feature mapped to its data model and storage system. The pattern: entities in documents/KV, relationships in graph (TAO), counts in counters, feeds in materialized views, search in inverted indexes.

### Netflix & YouTube Examples

| Feature | Data Model | Store (Actual) | Key Trade-Off |
| --- | --- | --- | --- |
| **Netflix: User profile + preferences** | Document (JSON-like) | Cassandra (wide-column) | High availability over consistency. Profile reads must never fail → AP system, eventual consistency OK |
| **Netflix: Viewing history** | Time-series (append-only) | Cassandra (partitioned by userId, clustered by timestamp) | Write-heavy (every play event). LSM-tree = fast writes. Range scan for "recent watches" |
| **Netflix: Recommendations** | Materialized view (pre-computed) | EVCache (Memcached) + Cassandra | ML model scores pre-computed offline (Spark) → cached for instant reads. Stale by hours = acceptable |
| **Netflix: Video catalog metadata** | Document (title, genres\[\], cast\[\], thumbnails\[\]) | Cassandra + Elasticsearch | Catalog rarely changes → eventually consistent replicas OK. Search needs inverted index (ES) |
| **YouTube: Video metadata** | Document | Vitess (sharded MySQL) + Bigtable | Strict consistency for upload pipeline. View counts in Bigtable (counter cells, eventually consistent) |
| **YouTube: Comments** | Document (1-to-many tree) | Spanner (globally consistent) | Interleaved tables: video → comments co-located. Global consistency for moderation |
| **YouTube: Search** | Inverted index | Custom search (descended from Google Search) | BM25 + ML ranking + video understanding (auto-captions indexed). Galene equivalent |
| **YouTube: Subscriptions** | Graph edge (directed) | Spanner / Bigtable | Asymmetric: subscribe is directed. Fan-out for "Subscriptions" feed = Twitter problem at YouTube scale |

### Summary: Data Model Decision Matrix

| If your data looks like... | Data Model | Meta Uses | LinkedIn Uses | Google Uses |
| --- | --- | --- | --- | --- |
| Self-contained entity (profile, product, video) | **Document** | TAO objects | Espresso | Spanner / Bigtable |
| 1-to-many tree (posts→comments, user→orders) | **Document + sub-keys** | TAO objects | Espresso sub-keys | Spanner interleaved |
| Many-to-many (friends, likes, followers) | **Graph / Junction table** | TAO associations | Liquid / Espresso GSI | Bigtable / Spanner |
| Full-text search (find people, jobs, products) | **Inverted index** | Unicorn (custom) | Galene / SEAS | Google Search / Caffeine |
| Aggregation (counts, dashboards, analytics) | **Columnar / OLAP** | Scuba / Presto | Pinot | BigQuery / Mesa |
| Pre-computed results (recommendations, ML scores) | **Materialized view (K-V)** | TAO + Memcache | Venice | Bigtable / Spanner |
| Time-series events (view history, click stream) | **Append-only log / wide-column** | Scribe → Hive | Kafka → Pinot | Bigtable / Colossus |
| Cache (hot reads, session data) | **In-memory K-V** | Memcache / TAO cache | Couchbase / OHC | Memcache |

**The Pattern Across All Companies:** Nobody uses one database. Every company at scale uses 5-8 specialized stores connected by an event bus (Kafka at LinkedIn, Wormhole at Meta, Pub/Sub at Google). The source of truth is a transactional store (Espresso, MySQL, Spanner). Everything else is a **derived view** optimized for one access pattern. This is **polyglot persistence** — the central theme of this entire chapter.

[↑ Back to Contents](#toc)

<a id="sec-9"></a>

Section 9

## Interview Questions & Talking Points

#### Q1: "When would you use a document DB vs relational?" MetaGoogle

**Answer:** Document when data is self-contained with 1-to-many nesting (profiles, product catalogs, event logs). Relational when you need JOINs, many-to-many relationships, and strict schema enforcement (financial transactions, inventory). At LinkedIn, Espresso bridges both: JSON documents with secondary indexes and change capture.

#### Q2: "How would you model a social graph?" MetaLinkedIn

**Answer:** Graph model. Vertices = members, companies, schools. Edges = connections, follows, endorsements. At LinkedIn, Liquid stores the social graph for traversal queries (PYMK, mutual connections, connection degree). Meta uses TAO (graph cache over MySQL shards). Graph enables "friends of friends" queries that would require recursive CTEs in SQL.

#### Q3: "How do you handle schema evolution?" GoogleNetflix

**Answer:** Schema-on-read (document DBs): write new format, handle old format in code. Schema-on-write (relational): `ALTER TABLE` + backfill. Google Spanner uses schema-on-write with online schema changes. At LinkedIn, Espresso supports both — you can evolve JSON doc structure without downtime while keeping secondary indexes.

#### Q4: "SQL vs NoSQL — which is better?" MetaGoogle

**Answer:** Wrong question! It's polyglot persistence — use the right store for each access pattern. Source of truth (Espresso/MySQL), search (Galene/Elasticsearch), analytics (Pinot/BigQuery), derived data (Venice/Redis), graph (Liquid/Neo4j). They're converging: relational DBs add JSON support, document DBs add JOINs.

#### Q5: "Explain normalization vs denormalization" MetaGoogle

**Answer:** Normalization: store each fact once, use IDs/FKs, JOIN to assemble. Removes duplication, ensures consistency. Denormalization: duplicate data for read performance (embed region name in every profile instead of region\_id). Tradeoff: faster reads vs harder writes and risk of inconsistency. At LinkedIn, Espresso is normalized (source of truth), Venice is denormalized (pre-computed for reads).

<img src="/diagrams/ddia-ch2/17.svg" alt="ddia-ch2 diagram 17" class="doc-diagram" />

Quick reference: data models, LinkedIn stores, and query language insights for interviews.

[↑ Back to Contents](#toc)
