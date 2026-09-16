---
title: "Ch 3: Storage & Retrieval"
slug: /ddia/ddia-ch3
sidebar_position: 3
sidebar_label: "Ch 3: Storage & Retrieval"
description: "Ch 3: Storage & Retrieval"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/ddia-ch3/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

How databases store data and find it again. B-Trees vs LSM-Trees, hash indexes, SSTables, column storage, OLTP vs OLAP — mapped to Espresso (InnoDB), Venice (RocksDB), and Pinot.

Data Intensive Systems • Chapter 3 • Interview Guide

[Home](/) [Ch 1: Reliability](/docs/ddia/ddia-ch1) [Ch 2: Data Models](/docs/ddia/ddia-ch2)

<a id="toc"></a>

## Table of Contents

1.  [The Index Trade-Off](#sec-1)
2.  [Hash Indexes](#sec-2)
3.  [SSTables & LSM-Trees](#sec-3)
4.  [B-Trees](#sec-4)
5.  [B-Trees vs LSM-Trees](#sec-5)
6.  [Secondary Indexes, Clustered & Covering](#sec-6)
7.  [OLTP vs OLAP & Column Storage](#sec-7)
8.  [Partitioning: Hash vs Range vs Consistent Hashing](#sec-7b)
9.  [LinkedIn Mapping: Which Engine Where?](#sec-8)
10.  [Interview Questions](#sec-9)

<a id="sec-1"></a>

Section 1

## The Index Trade-Off MetaGoogle

#### The Fundamental Trade-Off of Every Storage System

```
Every INDEX speeds up READS but slows down WRITES.

WHY? On every write, the database must update:
  1. The actual data (row/document/blob)
  2. EVERY index that covers any field in that write

Example: Espresso table with 3 indexes (primary key B-tree + 2 Lucene secondary indexes)
  → 1 write = 1 MySQL INSERT + 1 B-tree update + 2 Lucene index updates = 4x write amplification

This is why databases DON'T index everything by default.
YOU choose indexes based on your query patterns.
More indexes = faster reads, slower writes, more storage.

THE RULE:
┌──────────────────────────────────────────────────────────┐
│  Read-heavy workload? → Add more indexes. Worth it.      │
│  Write-heavy workload? → Fewer indexes. Avoid overhead.  │
│  Mixed? → Index only the fields you actually query on.   │
└──────────────────────────────────────────────────────────┘
```

<img src="/diagrams/ddia-ch3/1.svg" alt="ddia-ch3 diagram 1" class="doc-diagram" />

The index trade-off: no indexes = fast writes but O(n) reads. Selective indexes = balanced. Over-indexed = fast reads but write amplification kills throughput.

[↑ Back to Contents](#toc)

<a id="sec-2"></a>

Section 2

## Hash Indexes Google

The simplest index: an **in-memory hash map** mapping every key to a byte offset on disk.

<img src="/diagrams/ddia-ch3/2.svg" alt="ddia-ch3 diagram 2" class="doc-diagram" />

Hash index: in-memory hash map points to byte offsets in an append-only file. O(1) reads, O(1) writes. Used by Bitcask (Riak). Limitation: all keys must fit in RAM, no range queries.

**LinkedIn parallel:** Espresso's Router keeps the Helix partition map in memory — it's essentially a hash map: `FNV(key) % 256 → partition → host`. Same O(1) concept. But the actual data lookup within a partition uses B-trees, not hash indexes.

[↑ Back to Contents](#toc)

<a id="sec-3"></a>

Section 3

## SSTables & LSM-Trees GoogleNetflix

What if we **sort** the log segments by key? That's an SSTable (Sorted String Table). Stack multiple SSTables with an in-memory write buffer (memtable) and you get an **LSM-Tree**.

<img src="/diagrams/ddia-ch3/3.svg" alt="ddia-ch3 diagram 3" class="doc-diagram" />

LSM-Tree: writes go to an in-memory memtable (sorted), flush to disk as immutable SSTables, background compaction merges and deduplicates. Used by RocksDB (Venice), Cassandra, HBase, LevelDB.

**LinkedIn mapping:** **Venice** uses RocksDB (an LSM-tree engine). Write path: Spark batch job or Flink stream → push data → RocksDB writes to memtable → flush to SST files. Optimized for write-heavy ingestion of pre-computed ML features.

[↑ Back to Contents](#toc)

<a id="sec-4"></a>

Section 4

## B-Trees MetaGoogle

The most widely used index structure. Unlike LSM-trees (append-only segments), B-trees use **fixed-size pages** (typically 4-16KB) organized as a tree. **Updates in place.**

```
B-TREE KEY PROPERTIES:
  ✓ Fixed-size pages (InnoDB: 16KB)
  ✓ Sorted by key (enables range queries)
  ✓ Update in place (overwrite the page)
  ✓ Balanced: depth = O(log n)
  ✓ Branching factor ~500 (keys per page)
  ✓ 500^4 = 62.5 BILLION rows in just 4 levels

  Write-Ahead Log (WAL / redo log):
    Every modification written to WAL BEFORE updating the B-tree page.
    If crash happens mid-write → WAL replays to restore consistency.
    This is exactly what InnoDB does inside Espresso storage nodes.
```

See the detailed B+ tree traversal diagram in [Chapter 2: How Espresso Finds 1 Row in 800M](/docs/ddia/ddia-ch2#sec-3-espresso) — it shows the 3-stage funnel (partitioning → B-tree → return) with actual page-level walkthrough.

[↑ Back to Contents](#toc)

<a id="sec-5"></a>

Section 5

## B-Trees vs LSM-Trees MetaGoogleNetflix

<img src="/diagrams/ddia-ch3/4.svg" alt="ddia-ch3 diagram 4" class="doc-diagram" />

B-Trees: update in place, fast reads, predictable latency, strong transactions. LSM-Trees: append-only, fast writes, better compression, but compaction can spike latency.

#### The One-Liner for Interviews

**B-Trees are faster for reads, LSM-Trees are faster for writes.** Use B-Trees for OLTP (Espresso/MySQL — user-facing, needs predictable latency). Use LSM-Trees for write-heavy workloads (Venice/RocksDB — ML feature ingestion, log storage). Lucene (inside Galene) uses LSM-like sorted files for its term dictionary.

[↑ Back to Contents](#toc)

<a id="sec-6"></a>

Section 6

## Secondary Indexes, Clustered & Covering MetaGoogle

| Index Type | What It Does | Example | Trade-Off |
| --- | --- | --- | --- |
| **Primary index** | Uniquely identifies each row. Clustered in InnoDB (data lives IN the leaf pages) | Espresso: `_key` is the primary B-tree | Must have. Can only have one. |
| **Secondary index** | Non-unique lookup by another field. Points back to primary key. | Espresso Lucene: `regionId=91` | Speeds up reads on that field. Slows all writes. |
| **Clustered index** | Row data stored directly IN the index leaf. InnoDB primary key does this. | InnoDB: primary key lookup returns data directly (no heap file hop) | Fastest reads, but only one per table. Writes update data + index together. |
| **Covering index** | Index includes extra columns so some queries never touch the main table | `CREATE INDEX ON orders(customer_id) INCLUDE (total)` | Avoids heap lookup for covered queries. More storage. |
| **Concatenated / Composite** | Multi-column index: (lastname, firstname) | Phone book: find by (last, first) — useless for first-name-only search | Column order matters! Leftmost prefix rule. |
| **Spatial (R-tree)** | Multi-dimensional range queries (latitude + longitude) | PostGIS, Google Maps: "restaurants within this rectangle" | Standard B-tree can't do 2D ranges efficiently |
| **Full-text (inverted)** | Maps terms → list of document IDs (postings list). Fuzzy, synonyms. | Galene/Elasticsearch: "AI engineers" → \[doc1, doc7, doc42\] | Built on LSM-like sorted files (Lucene). Heavy write amplification. |

[↑ Back to Contents](#toc)

<a id="sec-7"></a>

Section 7

## OLTP vs OLAP & Column Storage GoogleNetflix

#### OLTP (Transaction Processing)

-   User-facing, low-latency
-   Small number of records per query
-   Random read/write by key
-   Disk seek time is bottleneck
-   Row-oriented storage

```sql
SELECT * FROM profiles WHERE id = 12345
-- 1 row, fast B-tree lookup
```

**Engines:** InnoDB (B-tree), RocksDB (LSM)

**LinkedIn:** Espresso, MySQL

#### OLAP (Analytical Processing)

-   Analyst-facing, high-throughput
-   Scan millions of rows per query
-   Sequential scan, aggregate
-   Disk bandwidth is bottleneck
-   Column-oriented storage

```sql
SELECT region, COUNT(*) FROM profile_views
WHERE timestamp > ago('7d')
GROUP BY region -- scan millions of rows
```

**Engines:** Column stores, star-tree

**LinkedIn:** Pinot, HDFS+Spark

#### Column-Oriented Storage — Why Pinot Is Fast for Analytics

```sql
ROW-ORIENTED (MySQL/Espresso):
  Row 1: [date, product, store, customer, price, quantity]
  Row 2: [date, product, store, customer, price, quantity]
  → To compute SUM(price), must load ALL columns of every row. Wasteful!

COLUMN-ORIENTED (Pinot/BigQuery/Parquet):
  date column:     [2024-01-01, 2024-01-01, 2024-01-02, ...]
  product column:  [iPhone, Galaxy, Pixel, ...]
  price column:    [999, 899, 699, ...]      ← only load this column!
  quantity column: [1, 2, 1, ...]

  SUM(price) → read ONLY the price column. Skip all other columns.
  With 100 columns and you need 3 → read 3% of the data. 33x faster!

COMPRESSION BONUS:
  Column of dates: [2024-01-01, 2024-01-01, 2024-01-01, 2024-01-02, ...]
  → Many repeated values → run-length encoding → tiny on disk
  → Bitmap index: date=2024-01-01 → [1,1,1,0,0,...] — bitwise AND/OR!
```

[↑ Back to Contents](#toc)

<a id="sec-7b"></a>

Section 7B

## Partitioning: Hash vs Range vs Consistent Hashing MetaGoogleLinkedIn

When data doesn't fit on one machine, you **partition** (shard) it across multiple nodes. The partitioning strategy determines how keys are mapped to nodes — and every choice has trade-offs.

<img src="/diagrams/ddia-ch3/5.svg" alt="ddia-ch3 diagram 5" class="doc-diagram" />

Three partitioning strategies: Hash (Espresso) gives uniform distribution but no range scans. Range (TiKV/Spanner) enables range scans but risks hot spots. Consistent Hashing (DynamoDB) minimizes data movement when adding nodes.

### Comparison Table

| Property | Hash (Espresso) | Range (TiKV / Spanner) | Consistent Hash (DynamoDB) |
| --- | --- | --- | --- |
| **Key → Partition** | `FNV(key) % N` | Find Region containing key in sorted range | Hash key → walk ring clockwise to node |
| **Partition count** | Fixed at creation (e.g. 256) | Dynamic (auto-split at 256MB, auto-merge) | Fixed ring, virtual nodes per real node |
| **Range scans** | Scatter-gather all partitions | Efficient (contiguous keys on one Region) | Scatter-gather (keys randomized by hash) |
| **Hot spot risk** | Low (hash distributes evenly) | High (sequential inserts → one Region) | Low (hash distributes evenly) |
| **Auto-split** | No (manual migration to re-partition) | Yes (PD splits when Region > 256MB) | No (add vnodes manually) |
| **Adding a node** | Helix reassigns partitions. All data stays in same partition numbers. | PD moves some Regions to new node. Transparent. | Only 1/N of keys move. Minimal disruption. |
| **Coordination** | Helix + ZooKeeper | PD (itself a Raft cluster) | Gossip protocol (no central coordinator) |
| **Replication** | Async (binlog → Kafka) | Raft per Region (majority ACK) | Sloppy quorum + hinted handoff |
| **Consistency** | Strong on leader, eventual on followers | Strong (Raft linearizable) | Tunable (ONE / QUORUM / ALL) |
| **Used by** | Espresso, Redis Cluster | TiKV, Spanner, HBase, CockroachDB | DynamoDB, Cassandra, Riak |

#### Interview Answer: "How would you partition this data?"

```
DECISION FRAMEWORK:

"Do I need range scans (ORDER BY, BETWEEN, time-series)?"
  YES → Range partitioning (TiKV / Spanner / HBase)
        But watch for hot spots on sequential inserts.
  NO  → Hash partitioning (Espresso / DynamoDB)
        Uniform distribution, but range queries = scatter-gather.

"Will the data grow unpredictably?"
  YES → Range with auto-split (TiKV — Regions split automatically)
  NO  → Hash with fixed count (Espresso — choose 2-4x node count)

"Do I need minimal disruption when adding nodes?"
  YES → Consistent hashing (DynamoDB — only 1/N keys move)
  NO  → Hash or Range (more data movement, but simpler reasoning)

"What consistency do I need?"
  Strong    → Raft-based range (TiKV) or leader-only hash (Espresso)
  Tunable   → Consistent hash with quorum (Cassandra R+W>N)
  Eventual  → Any, with async replication
```

[↑ Back to Contents](#toc)

<a id="sec-8"></a>

Section 8

## LinkedIn Mapping: Which Engine Where? LinkedIn

| System | Storage Engine | Index Type | Optimized For |
| --- | --- | --- | --- |
| **Espresso** | MySQL/InnoDB (B-tree) | Primary: B+ tree. Secondary: Lucene. GSI: separate service. | OLTP: user-facing CRUD, point lookups, source of truth |
| **Venice** | RocksDB (LSM-tree) | Key-value (primary key only) | Write-heavy derived data: ML features, batch push from Spark |
| **Pinot** | Custom columnar (segments) | Inverted + star-tree + sorted | OLAP: real-time analytics, GROUP BY, COUNT aggregations |
| **Galene** | Lucene (LSM-like sorted files) | Inverted index (term → postings list) | Full-text search, typeahead, faceted filtering |
| **Liquid** | In-memory (B-tree + hash) | B-tree + hash on vertices/edges | Graph traversals, multi-hop joins, PYMK |
| **Couchbase** | In-memory + async disk | Hash (key → value) | L2 cache for Espresso hot reads |
| **Kafka** | Append-only log (segments) | Offset-based (no key index) | Event streaming, CDC, exactly-once delivery |

**Interview Power Statement:** "The choice of storage engine is the most important decision in database design. B-trees (InnoDB) for OLTP with predictable latency. LSM-trees (RocksDB) for write-heavy ingestion. Columnar (Pinot) for analytics. Inverted indexes (Lucene) for search. In-memory (Liquid) for graph traversals. Each is a different trade-off on the index spectrum: reads vs writes vs space."

[↑ Back to Contents](#toc)

<a id="sec-9"></a>

Section 9

## Interview Questions

#### Q1: "Explain the index trade-off" MetaGoogle

**Answer:** Every index speeds up reads but slows down writes (write amplification: data + every index must be updated). Databases don't index everything by default — you choose indexes based on query patterns. Read-heavy → more indexes. Write-heavy → fewer. Espresso uses selective indexing: primary B-tree + declared Lucene secondary indexes only.

#### Q2: "B-Tree vs LSM-Tree — when to use which?" GoogleNetflix

**Answer:** B-trees for read-heavy OLTP with strong transactions (Espresso/MySQL — each key in one place, predictable latency, range queries). LSM-trees for write-heavy workloads (Venice/RocksDB, Cassandra — sequential writes, better compression, higher write throughput). Trade-off: LSM compaction can spike p99 latency; B-trees have write amplification from WAL + page updates.

#### Q3: "Why column storage for analytics?" Google

**Answer:** Analytical queries read few columns across millions of rows. Column storage reads only needed columns (100 columns, need 3 = read 3% of data). Compression is much better (repeated values in a column → run-length/bitmap encoding). Vectorized processing: tight loops on compressed column chunks fit in CPU L1 cache. LinkedIn's Pinot uses columnar segments with star-tree pre-aggregation for sub-second dashboards.

#### Q4: "What is write amplification?" Meta

**Answer:** One logical write triggers multiple physical writes. B-tree: WAL write + page overwrite = 2x minimum. With page splits = 3x. LSM-tree: memtable flush + compaction rewrites = 10-30x over lifetime. Critical on SSDs (limited write cycles). Espresso's WCU calculation uses 1.6x amplification factor accounting for MySQL write + binlog + replication + index updates.

[↑ Back to Contents](#toc)
