---
title: "Ch 4: TiDB, TiKV & Raft Consensus"
slug: /ddia/ddia-ch4
sidebar_position: 4
sidebar_label: "Ch 4: TiDB, TiKV & Raft Consensus"
description: "Ch 4: TiDB, TiKV & Raft Consensus"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/ddia-ch4/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

How a distributed NewSQL database works: Raft consensus for replication, Regions for partitioning, PD for scheduling — no Helix, no master. Open-source alternative to Spanner.

Data Intensive Systems • Chapter 4 • Interview Guide

[Home](/) [Ch 3: Storage & Retrieval](/docs/ddia/ddia-ch3) [Ch 2: Data Models](/docs/ddia/ddia-ch2)

<a id="toc"></a>

## Table of Contents

1.  [TiDB Architecture Overview](#sec-1)
2.  [Regions — Partitioning Without a Hash Ring](#sec-2)
3.  [Raft Consensus — How Replication Works](#sec-3)
    -   [Leader Election](#sec-3-leader)
    -   [Write Path (Raft Log Replication)](#sec-3-write)
    -   [Read Path (Leader Reads vs Follower Reads)](#sec-3-read)
    -   [Majority Quorum — NOT All Followers](#sec-3-quorum)
4.  [What Happens When a Replica Goes Down?](#sec-4)
5.  [Placement Driver (PD) — The Brain](#sec-5)
6.  [Storage: RocksDB + MVCC + Percolator Transactions](#sec-6)
7.  [Backup & Recovery](#sec-7)
8.  [TiDB vs Espresso vs Spanner](#sec-8)
9.  [Interview Questions](#sec-9)

<a id="sec-1"></a>

Section 1

## TiDB Architecture Overview

TiDB is an open-source **distributed NewSQL database**. It's MySQL-compatible, supports ACID transactions, and scales horizontally. Think of it as an open-source Google Spanner.

<img src="/diagrams/ddia-ch4/1.svg" alt="ddia-ch4 diagram 1" class="doc-diagram" />

TiDB architecture: Stateless SQL layer (TiDB Server) → Distributed KV storage (TiKV with Raft per Region) → PD (metadata, scheduling, transaction IDs). Compare: TiDB Server ≈ Espresso Router, TiKV ≈ Espresso Storage Node, PD ≈ Helix + ZooKeeper.

[↑ Back to Contents](#toc)

<a id="sec-2"></a>

Section 2

## Regions — Partitioning Without a Hash Ring

TiKV uses **range-based partitioning** (not hash-based like Espresso). The key space is split into **Regions**, each ~256MB. Each Region is a contiguous key range `[StartKey, EndKey)`.

```
HOW REGIONS WORK:

Key space:  [aaa ... bbb ... ccc ... ddd ... eee ... fff ... zzz]
             |←── Region 1 ──→|←── Region 2 ──→|←── Region 3 ──→|
             [aaa, ccc)         [ccc, eee)        [eee, zzz]

Each Region:
  ✓ Default max size: 256 MB
  ✓ When Region grows > 256MB → PD auto-splits it into two
  ✓ When Region shrinks → PD can merge adjacent Regions
  ✓ 3 replicas by default (configurable)
  ✓ Each replica set forms a RAFT GROUP
  ✓ One replica is Leader, others are Followers

WHY RANGE-BASED (not hash like Espresso)?
  ✓ Efficient range scans: SELECT * WHERE key BETWEEN 'aaa' AND 'bbb'
    → all data in Region 1, single node scan (no scatter-gather!)
  ✓ Table data is naturally ordered by primary key
  ✗ Risk: sequential writes create hot spots on one Region
    → PD detects and splits hot Regions automatically

VS ESPRESSO:
  Espresso: FNV hash → fixed partition count (256), Helix assigns to nodes
  TiKV:     Range-based → dynamic Region count (auto-split/merge), PD assigns
```

[↑ Back to Contents](#toc)

<a id="sec-3"></a>

Section 3

## Raft Consensus — How Replication Works MetaGoogle

Every Region has 3 replicas (on different TiKV nodes). These 3 replicas form a **Raft Group**. Raft ensures they stay consistent.

### Leader Election {#sec-3-leader}

```
RAFT LEADER ELECTION:

1. Every replica starts as a FOLLOWER
2. Followers expect heartbeats from the Leader every ~150ms
3. If a Follower gets no heartbeat for election timeout (~300ms):
   → It becomes a CANDIDATE and asks others for votes
4. If a Candidate gets votes from MAJORITY (2 of 3) → becomes LEADER
5. Leader sends heartbeats to all Followers to maintain authority

Three states: FOLLOWER → CANDIDATE → LEADER

      ┌──────────────────────────────────────────────┐
      │  Node A: LEADER  ←── wins election            │
      │  Node B: FOLLOWER (voted for A)               │
      │  Node C: FOLLOWER (voted for A)               │
      └──────────────────────────────────────────────┘

SPLIT BRAIN PREVENTION:
  A Candidate needs MAJORITY votes (2 of 3, 3 of 5, etc.)
  → Only ONE leader can be elected per term
  → Even with network partition, at most one partition has majority
```

### Write Path — Raft Log Replication {#sec-3-write}

<img src="/diagrams/ddia-ch4/2.svg" alt="ddia-ch4 diagram 2" class="doc-diagram" />

Raft write path: Leader logs → replicates to followers → commits after MAJORITY (not all) acknowledge. This gives strong consistency even if one replica is down.

### Read Path {#sec-3-read}

```
READ OPTIONS IN RAFT:

1. LEADER READ (default, strong consistency):
   Client → TiDB Server → Region Leader → read from RocksDB → return
   ✓ Always sees the latest committed data
   ✗ All reads go to Leader (potential bottleneck)

2. FOLLOWER READ (stale read, higher throughput):
   Client → TiDB Server → any Follower → read from its RocksDB → return
   ✓ Spreads read load across all replicas
   ✗ Might read slightly stale data (follower may lag behind leader)
   TiDB: SET tidb_replica_read = 'follower' or 'closest-replicas'

3. STALE READ (bounded staleness):
   Client → TiDB Server → any replica → read data as of a specific timestamp
   ✓ Can read from follower if timestamp ≤ follower's applied version
   TiDB: SELECT * FROM users AS OF TIMESTAMP '2024-01-01 00:00:00'

IS RAFT EVENTUAL CONSISTENCY?
  NO! Raft provides STRONG (linearizable) consistency for writes.
  - Writes are committed only after majority ACK
  - Leader reads always return the latest committed value
  - Follower reads CAN be eventually consistent (if you opt in)
```

### Majority Quorum — NOT All Followers {#sec-3-quorum}

#### Common Misconception: "Raft waits for ALL replicas"

```sql
WRONG: Raft waits for ACK from ALL followers before committing
RIGHT: Raft waits for ACK from MAJORITY (quorum) before committing

With 3 replicas: majority = 2 (leader + 1 follower)
With 5 replicas: majority = 3 (leader + 2 followers)

WHY MAJORITY, NOT ALL?
  If Raft waited for ALL replicas:
    → 1 slow/dead replica blocks ALL writes = no fault tolerance
    → This would be SYNCHRONOUS replication (like 2PC)
  
  With majority:
    → 1 replica can be down and writes still succeed
    → This is the CORE TRADE-OFF of Raft:
       ✓ Tolerate f failures with 2f+1 replicas
       ✓ 3 replicas → tolerate 1 failure
       ✓ 5 replicas → tolerate 2 failures

VS ESPRESSO:
  Espresso: Leader commits ALONE, replicates ASYNC via Kafka
    → Faster writes, but risk of data loss if leader dies before replication
  TiKV/Raft: Leader commits after MAJORITY ACK
    → Slightly slower writes, but NO data loss as long as majority survives
```

[↑ Back to Contents](#toc)

<a id="sec-4"></a>

Section 4

## What Happens When a Replica Goes Down?

<img src="/diagrams/ddia-ch4/3.svg" alt="ddia-ch4 diagram 3" class="doc-diagram" />

Three failure scenarios: one follower down (no impact), leader down (300ms election, no data loss), majority down (Region unavailable until one returns).

[↑ Back to Contents](#toc)

<a id="sec-5"></a>

Section 5

## Placement Driver (PD) — The Brain Google

PD is TiDB's equivalent of Espresso's Helix + ZooKeeper, but it does **much more**. PD is itself a 3-node Raft cluster for its own high availability.

| PD Responsibility | What It Does | Espresso Equivalent |
| --- | --- | --- |
| **Metadata store** | Which Region on which TiKV node. Region key ranges. | Helix external view (partition → host) |
| **TSO (Timestamp Oracle)** | Allocates globally unique, monotonically increasing transaction IDs | No equivalent (Espresso uses per-partition CAS) |
| **Region scheduling** | Balance Regions across nodes, repair under-replicated Regions | Helix state machine (OFFLINE→SLAVE→MASTER) |
| **Auto-split / merge** | Split Regions > 256MB, merge tiny Regions | Not supported (fixed partition count) |
| **Hot spot detection** | Move hot Region leaders away from overloaded nodes | Manual (no auto hot-spot balancing) |
| **Store failure detection** | 30min no heartbeat → mark Down → re-replicate all Regions | Helix detects, reassigns partitions |
| **Label-aware placement** | Ensure replicas span racks/zones/DCs via labels | Helix placement constraints |

[↑ Back to Contents](#toc)

<a id="sec-6"></a>

Section 6

## Storage: RocksDB + MVCC + Percolator Transactions

```
STORAGE STACK (bottom to top):

┌─────────────────────────────────────────────┐
│  SQL Layer (TiDB Server)                     │
│  Parse → Optimize → KV operations            │
├─────────────────────────────────────────────┤
│  Transaction Layer (Percolator 2PC)           │
│  Distributed ACID with MVCC                  │
│  Snapshot Isolation by default               │
├─────────────────────────────────────────────┤
│  Consensus Layer (Raft)                      │
│  Log replication, leader election            │
│  One Raft group per Region                   │
├─────────────────────────────────────────────┤
│  Storage Engine (RocksDB — LSM-tree)         │
│  Local persistent KV store per TiKV node     │
│  Keys: {table_id}_{row_id}_{version}         │
│  MVCC: multiple versions per key             │
└─────────────────────────────────────────────┘

MVCC IN TIKV:
  Without MVCC:  Key1 → Value
  With MVCC:     Key1_Version3 → Value   ← latest
                 Key1_Version2 → Value
                 Key1_Version1 → Value   ← oldest

  Versions sorted descending (newest first).
  Read at timestamp T: SeekPrefix(Key1_T) → first entry ≤ T

PERCOLATOR TRANSACTIONS (Google's 2PC variant):
  Phase 1 (Prewrite): Lock all keys, write to each Region's Leader
  Phase 2 (Commit):   Write commit record, unlock
  Provides: Snapshot Isolation (serializable with FOR UPDATE)
```

[↑ Back to Contents](#toc)

<a id="sec-7"></a>

Section 7

## Backup & Recovery

```
TIDB BACKUP & RESTORE (BR):

1. SNAPSHOT BACKUP (full backup at a point in time):
   br backup full --pd "pd-host:2379" --storage "s3://my-bucket/backup"
   → Backs up all Regions' data to S3/GCS/Azure
   → Speed: 50-100 MB/s per TiKV node
   → Impact: < 20% CPU on cluster (configurable)

2. LOG BACKUP (continuous incremental — like Espresso's Kafka CDC):
   br log start --pd "pd-host:2379" --storage "s3://my-bucket/logs"
   → Continuously streams KV changes to storage
   → RPO: ~5 minutes (how much data you can lose)
   → Enables POINT-IN-TIME RECOVERY (PITR)

3. POINT-IN-TIME RECOVERY:
   br restore point --pd "pd-host:2379" \
     --full-backup-storage "s3://my-bucket/backup" \
     --log-backup-storage "s3://my-bucket/logs" \
     --restored-ts "2024-04-15 14:30:00"
   → Restores to ANY timestamp: last full backup + replay logs
   → Speed: ~1 GB/s per TiKV node (restore)

VS ESPRESSO BACKUP:
  Espresso: MySQL mysqldump or Ambry snapshots + Kafka CDC replay
  TiDB BR: integrated tool, S3-native, PITR built-in, cluster-consistent
```

[↑ Back to Contents](#toc)

<a id="sec-8"></a>

Section 8

## TiDB vs Espresso vs Spanner

| Aspect | TiDB/TiKV | Espresso | Google Spanner |
| --- | --- | --- | --- |
| **Data Model** | Relational (MySQL SQL) | Document (Avro in MySQL) | Relational (SQL) |
| **Storage Engine** | RocksDB (LSM-tree) | MySQL/InnoDB (B-tree) | Custom (Colossus + B-tree) |
| **Partitioning** | Range-based Regions (auto-split) | FNV hash (fixed count) | Range-based splits |
| **Replication** | Raft (per Region, majority ACK) | Async (binlog → Kafka) | Paxos (per split) |
| **Consistency** | Strong (linearizable writes) | Strong within partition (leader) | External consistency (TrueTime) |
| **Transactions** | Distributed ACID (Percolator 2PC) | Single-partition ACID | Distributed ACID (2PC + Paxos) |
| **Failure Tolerance** | Tolerate f failures with 2f+1 | Leader-only commit (risk window) | Tolerate f with 2f+1 (Paxos) |
| **Cross-DC** | Raft across DCs (PD labels) | Async replication via Kafka | Paxos across DCs (TrueTime GPS) |
| **Schema** | SQL DDL (online schema change) | Avro in ZooKeeper (versioned) | SQL DDL |
| **JOINs** | Full SQL JOINs | Not supported | Full SQL JOINs (interleaved) |
| **Analytics** | TiFlash (columnar OLAP engine) | Pinot (separate system) | Built-in OLAP |
| **Open Source** | Yes (Apache 2.0) | No (LinkedIn internal) | No (Google Cloud only) |

**Interview One-Liner:** "TiDB is an open-source Spanner. It uses Raft (not Paxos) for consensus, RocksDB (not custom) for storage, and Percolator (not Spanner 2PC) for distributed transactions. Unlike Espresso, which commits on leader-only and replicates async via Kafka, TiKV commits after majority Raft ACK — stronger consistency but slightly higher write latency."

[↑ Back to Contents](#toc)

<a id="sec-9"></a>

Section 9

## Interview Questions

#### Q1: "How does Raft handle writes? Does it wait for all replicas?" MetaGoogle

**Answer:** No! Raft commits after **majority** (quorum) ACK, not all replicas. With 3 replicas, 2 ACKs (leader + 1 follower) is sufficient. This is what makes Raft fault-tolerant — 1 replica can be down and writes still succeed. The formula is 2f+1 replicas to tolerate f failures. This is NOT eventual consistency — committed writes are guaranteed durable on the majority.

#### Q2: "What happens when the Raft leader dies?" Google

**Answer:** Followers detect missing heartbeats after ~300ms (election timeout). One becomes a Candidate, requests votes from others, and wins with majority votes. New leader resumes serving reads and writes. No data loss because the new leader has all committed entries (they were ACK'd by majority, and the new leader was part of that majority). Total unavailability for that Region: ~300ms.

#### Q3: "Raft vs Espresso replication — what's the trade-off?" LinkedIn

**Answer:** Espresso commits on leader alone and replicates asynchronously via Kafka binlog. Faster writes (~3ms) but there's a window where committed data exists only on one node — if the leader dies before binlog replication, data is lost. TiKV/Raft commits after majority ACK (~10ms). Slower but no data loss as long as majority survives. Espresso trades durability for latency; TiKV trades latency for durability.

#### Q4: "How does TiDB partition data without a hash ring?" Google

**Answer:** Range-based Regions. The key space is split into contiguous ranges, each ~256MB. When a Region grows too large, PD auto-splits it. This enables efficient range scans (all data in order on one node) but risks hot spots on sequential inserts. PD detects hot Regions and splits or moves their leaders. Compare to Espresso's fixed-count hash partitioning (no auto-split, no range scan advantage).

#### Q5: "Explain TiDB backup and PITR" Google

**Answer:** TiDB BR does full snapshot backups (all Regions to S3, 50-100 MB/s per node, <20% CPU impact) plus continuous log backup (streams KV changes to S3, RPO ~5 min). For PITR: restore the last snapshot, then replay log backup to the exact timestamp. This gives you "restore to any second" capability. Compare to Espresso: MySQL dumps + Kafka CDC replay (similar concept but less integrated).

[↑ Back to Contents](#toc)
