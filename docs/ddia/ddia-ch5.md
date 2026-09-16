---
title: "Ch 5: How Companies Handle Data"
slug: /ddia/ddia-ch5
sidebar_position: 5
sidebar_label: "Ch 5: How Companies Handle Data"
description: "Ch 5: How Companies Handle Data"
---
Replication, multi-DC writes, conflict resolution, Raft vs Paxos, and why "the best way to solve a hard consensus problem is to redesign your data model so you don't have one."

Data Intensive Systems • Chapter 5 • Interview Guide

[Home](/) [Ch 4: TiDB & Raft](/docs/ddia/ddia-ch4) [Ch 3: Storage](/docs/ddia/ddia-ch3)

<a id="toc"></a>

## Table of Contents

1.  [The Normalization Problem — Why IDs, Not Strings](#sec-1)
2.  [Single-Leader Replication — LinkedIn, Facebook, Gmail](#sec-2)
3.  [Multi-Leader — When You Actually Need It](#sec-3)
4.  [Conflict Resolution Strategies](#sec-4)
5.  [Raft vs Paxos — The Consensus Showdown](#sec-5)
6.  [Every Company Mapped](#sec-6)
7.  [The Golden Rule: Avoid the Problem](#sec-7)
8.  [Paxos In Depth — Phases, Ballots, fsync](#sec-8)
9.  [ZooKeeper ZAB Protocol](#sec-9)
10.  [Read Strategies in Consensus Systems](#sec-10)
11.  [The Consensus Protocol Family Tree](#sec-11)
12.  [Tradeoff Comparison Matrix](#sec-12)

<a id="sec-1"></a>

Section 1

## The Normalization Problem — Why IDs, Not Strings

<img src="/diagrams/ddia-ch5/1.svg" alt="ddia-ch5 diagram 1" class="doc-diagram" />

Denormalized = fast reads but update nightmare. Normalized = clean writes but need JOINs. Espresso sidesteps this: normalize in source of truth, denormalize in derived stores (Galene, Venice) via Kafka CDC.

[↑ Back to Contents](#toc)

<a id="sec-2"></a>

Section 2

## Single-Leader Replication — The Default at Scale MetaLinkedInGoogle

**Most companies at scale use single-leader replication.** Each piece of data has ONE primary datacenter. Writes go to the leader; followers replicate async.

<img src="/diagrams/ddia-ch5/2.svg" alt="ddia-ch5 diagram 2" class="doc-diagram" />

Single-leader: one DC owns writes, other DCs get async read replicas. Simple, no conflicts, but cross-DC writes have latency. This is what 90% of companies use.

#### Facebook's Cache Trick: Read-Your-Writes Consistency

```
Problem: User in Europe writes a comment. Write goes to US primary (~150ms).
         User refreshes page. Read hits local European cache. Comment not there yet!

Facebook's solution (from "Scaling Memcache at Facebook" paper):
  1. User writes comment → routed to US primary → committed
  2. Immediately: set a REMOTE MARKER in European cache:
     "key X is stale, go to primary for reads"
  3. User reads → cache sees marker → fetches from US primary → shows comment
  4. After async replication catches up (~200ms) → marker cleared → reads local again

Result: User always sees their own writes, even cross-DC.
        Other European users see it ~200ms later (acceptable).
```

[↑ Back to Contents](#toc)

<a id="sec-3"></a>

Section 3

## Multi-Leader — When You Actually Need It

Multi-leader means **any DC can accept writes**. Sounds great, but now you have the **conflict problem**: what if two DCs write the same data at the same time?

#### The Rule: Multi-leader is a tool of LAST RESORT

```
Multi-leader is ONLY needed when:
  ✓ Multiple users CONCURRENTLY modify the SAME mutable object
  ✓ AND users expect BOTH writes to succeed WITHOUT waiting
  ✓ AND the data type has well-defined merge semantics

Examples where multi-leader IS needed:
  ✓ Google Docs (two people typing in same paragraph)
  ✓ Figma (two designers moving shapes on same canvas)
  ✓ CRDTs (counters, sets that merge mathematically)

Examples where multi-leader is NOT needed (even though data is shared):
  ✗ Gmail (messages are immutable, flags are per-user)
  ✗ WhatsApp group chat (messages are append-only, each person writes their own)
  ✗ Google Drive file metadata (renames are rare, last-writer-wins is fine)
  ✗ Shared calendar (editing same event is rare → "reload" UX is acceptable)

The best way to solve a hard consensus problem is to
REDESIGN YOUR DATA MODEL so you don't have one.
```

<img src="/diagrams/ddia-ch5/3.svg" alt="ddia-ch5 diagram 3" class="doc-diagram" />

Decision flowchart: most shared data doesn't need multi-leader. Only concurrent edits to the same mutable object require OT/CRDTs.

[↑ Back to Contents](#toc)

<a id="sec-4"></a>

Section 4

## Conflict Resolution Strategies MetaGoogle

When conflicts DO happen (multi-leader or leaderless), how do you resolve them?

| Strategy | How It Works | Data Loss? | Used By |
| --- | --- | --- | --- |
| **Last-Write-Wins (LWW)** | Compare timestamps, newer wins, older silently discarded | YES — one write lost | Cassandra, DynamoDB (default), Spotify |
| **Keep Both (Siblings)** | Store both versions, client merges on next read | No, but client complexity | Riak, early DynamoDB, Amazon cart |
| **CRDTs** | Data structures that merge automatically (counters, sets) | No, mathematically safe | Redis Enterprise, Riak, Azure Cosmos DB |
| **OT (Operational Transform)** | Transform concurrent operations to preserve intent | No, intent preserved | Google Docs |
| **Avoid conflicts by design** | Pin writes to one leader, make data immutable/append-only | N/A — no conflicts | LinkedIn, Facebook, Gmail, Twitter |

#### CRDTs — The Elegant Solution (When Your Data Fits)

```
CRDT = Conflict-free Replicated Data Type

Counter CRDT (for "likes"):
  DC-1 increments: +5 likes
  DC-2 increments: +3 likes
  Merge: SUM(5, 3) = 8 likes. No conflict! Both increments survive.

Set CRDT (for "playlist items"):
  DC-1 adds: {Song A, Song B}
  DC-2 adds: {Song B, Song C}
  Merge: UNION = {Song A, Song B, Song C}. Both adds survive.

OR-Set CRDT (add + remove):
  DC-1 adds Song A (with unique tag α)
  DC-2 removes Song A (removes tag α)
  If DC-1's add has a DIFFERENT tag than DC-2's remove → add wins
  If same tag → remove wins. Deterministic!

Limitation: Not everything can be a CRDT.
  ✗ Text documents (OT or specialized text CRDTs like Yjs)
  ✗ Complex business logic (inventory, payments)
  ✓ Counters, sets, flags, registers, maps
```

[↑ Back to Contents](#toc)

<a id="sec-5"></a>

Section 5

## Raft vs Paxos — The Consensus Showdown Google

<img src="/diagrams/ddia-ch5/4.svg" alt="ddia-ch5 diagram 4" class="doc-diagram" />

Paxos (1989): mathematically elegant but hard to implement. Raft (2013): same guarantees but decomposed into 3 clear sub-problems. Raft won post-2014 by being boring and clear.

| Aspect | Paxos | Raft |
| --- | --- | --- |
| **Leader** | Any node can propose (flexible, complex) | Strong leader (all writes flow one way) |
| **Phases** | Prepare + Accept (2 round-trips) | AppendEntries (1 round-trip after election) |
| **Log ordering** | Out-of-order commits possible | Prefix-consistent (simpler log repair) |
| **Membership changes** | Not specified (roll your own) | Joint consensus (specified in paper) |
| **Understanding** | "Notoriously hard" — every implementer | Designed for understandability |
| **Convergence** | In practice, Multi-Paxos with stable leader ≈ Raft. They're converging. |

**Interview One-Liner:** "Raft is essentially Multi-Paxos with all the pragmatic choices already made. Same safety guarantees (majority quorum, leader election, log consistency), but Raft specifies everything Paxos leaves undefined (leader election, membership changes, log compaction). Raft won the 2010s consensus wars by being boring and clear."

[↑ Back to Contents](#toc)

<a id="sec-6"></a>

Section 6

## Every Company Mapped MetaGoogleLinkedInNetflix

| Company / Feature | Replication Model | Conflict Strategy | Why |
| --- | --- | --- | --- |
| **LinkedIn** (profiles, messages) | Single-leader per user partition (Espresso) | No conflicts by design | User pinned to DC. Writes to one leader, async Kafka CDC to other DCs. |
| **Facebook** (posts, likes, comments) | Single-leader per shard (TAO) | No conflicts. Remote marker for read-your-writes. | Each object has one primary DC. Cache hides cross-DC latency. |
| **Facebook** (News Feed) | Read-time aggregation | N/A — feed is computed, not stored | ML ranking changes constantly → precomputing wastes work. |
| **Twitter** (tweets) | Single-leader per user (Manhattan) | No conflicts | Tweets are append-only. Fan-out on write to Redis timelines. |
| **YouTube** (metadata, comments) | Spanner (synchronous Paxos) | No conflicts — strong global consistency | Correctness > latency. ~50-150ms cross-region writes. |
| **YouTube** (view counts) | Eventual (counter system) | CRDT-like (sum of partitioned counters) | Can't pay Spanner latency on every play event. Approximate is OK. |
| **Gmail** | Single-leader per user (Spanner/Bigtable) | No conflicts | Mailbox = single user. Messages immutable. Flags per-user. |
| **Google Drive** (metadata) | Spanner (synchronous) | Strong consistency (last-writer-wins) | Permissions need instant global consistency. |
| **Google Docs** (editing) | Multi-leader (OT) | Operational Transformation | Concurrent typing is the whole point. Central OT server merges ops. |
| **Figma / Notion** | Multi-leader (CRDTs) | Conflict-free merge | Offline-friendly. No central server needed for merge. |
| **Spotify** (playlists) | Cassandra (leaderless, multi-DC) | LWW + app-level merge for playlists | Play counts are idempotent. Losing one play event is OK. |
| **Netflix** (profiles, history) | Cassandra (leaderless, AP) | LWW | High availability > consistency. Profile reads must never fail. |
| **Amazon** (shopping cart) | Dynamo (leaderless) | Keep siblings, union on merge | Never lose an "add to cart." Union of both carts = no lost items. |
| **WhatsApp** | Single-leader per user/chat | No conflicts | Messages append-only. Per-user region pinning. |
| **TiDB** | Raft per Region (majority ACK) | Strong consistency (linearizable) | ACID transactions. Commits after majority. No data loss. |

[↑ Back to Contents](#toc)

<a id="sec-7"></a>

Section 7

## The Golden Rule: Avoid the Problem

<img src="/diagrams/ddia-ch5/5.svg" alt="ddia-ch5 diagram 5" class="doc-diagram" />

The five rules that govern how every company at scale handles data. From DDIA: "modern systems are pipelines of specialized stores, each optimized for a particular read or write pattern, kept in sync by event streams."

#### The Ultimate Interview Statement

```
You're always picking two of three:
  1. Low-latency local writes
  2. Strong consistency
  3. High availability during partitions

LinkedIn/Facebook: pick 1 + 3 (pin writes to one DC, eventual cross-DC)
Google/Spanner:    pick 2 + 3 (pay latency for strong consistency)
Cassandra/Spotify: pick 1 + 3 (accept LWW data loss)
CRDTs:            get all 3... but only for data that CAN be a CRDT

Strong consistency across datacenters COSTS LATENCY. Always.
You're paying for the speed of light between continents (~150ms).
There is no way around this. Choose your trade-off.
```

[↑ Back to Contents](#toc)

<a id="sec-8"></a>

Section 8

## Paxos In Depth — Phases, Ballots, fsync Google

**Roles are logical, not physical.** Proposer, Acceptor, Learner are threads in the same process, not separate machines.

<img src="/diagrams/ddia-ch5/6.svg" alt="ddia-ch5 diagram 6" class="doc-diagram" />

Basic Paxos: Prepare (establish right to propose) → Accept (commit value after majority). Acceptors MUST fsync to disk before responding — crash amnesia would violate safety.

#### The Clever Part of Paxos

```
If during Phase 1, any acceptor says "I already accepted value Y at ballot 30,"
the proposer MUST propose Y in Phase 2, not its own value.

This is how Paxos ensures only ONE value is ever chosen,
even with multiple concurrent proposers.

Multi-Paxos optimization: elect a stable leader, skip Phase 1
for subsequent writes (reuse the ballot). This is what Spanner does.
In practice, Multi-Paxos with a stable leader ≈ Raft.
```

[↑ Back to Contents](#toc)

<a id="sec-9"></a>

Section 9

## ZooKeeper ZAB Protocol

ZAB (ZooKeeper Atomic Broadcast) predates Raft and has unique recovery mechanics. Used **only** by ZooKeeper (Helix, Kafka pre-KRaft, Espresso coordination).

<img src="/diagrams/ddia-ch5/7.svg" alt="ddia-ch5 diagram 7" class="doc-diagram" />

ZAB has 4 explicit phases: election → discovery → sync → broadcast. The zxid compound identifier (epoch + counter) makes comparing state trivial.

[↑ Back to Contents](#toc)

<a id="sec-10"></a>

Section 10

## Read Strategies in Consensus Systems

Reads are trickier than they look. A leader might *think* it's still the leader when a partition has already caused a new election.

<img src="/diagrams/ddia-ch5/8.svg" alt="ddia-ch5 diagram 8" class="doc-diagram" />

Four read strategies: Consensus (safest, slowest), Lease (fast + strong, needs clocks), Quorum (strong, spreads load), Follower (fastest, but stale). Most production systems use Lease reads.

[↑ Back to Contents](#toc)

<a id="sec-11"></a>

Section 11

## The Consensus Protocol Family Tree

<img src="/diagrams/ddia-ch5/9.svg" alt="ddia-ch5 diagram 9" class="doc-diagram" />

The consensus protocol family: Paxos (1989) is the root. Multi-Paxos → Spanner. ZAB → ZooKeeper. Raft (2014) won post-2014 and powers TiDB, etcd, CockroachDB, Kafka KRaft, Kubernetes.

[↑ Back to Contents](#toc)

<a id="sec-12"></a>

Section 12

## Tradeoff Comparison Matrix

### Consensus Protocols

| Protocol | Leader | Phases | Quorum | Log Order | Membership | Used By |
| --- | --- | --- | --- | --- | --- | --- |
| **Paxos** | Any proposer | Prepare + Accept (2 RTT) | Majority | Out-of-order possible | Unspecified | Spanner, Chubby |
| **Multi-Paxos** | Stable leader | Accept only (1 RTT) | Majority | Sequential | Varies | Spanner |
| **Raft** | Strong leader | AppendEntries (1 RTT) | Majority | Strictly sequential | Joint consensus | TiDB, etcd, CockroachDB |
| **ZAB** | Strong leader | 4 phases (recovery) | Majority | Primary Order | Built-in | ZooKeeper |
| **EPaxos** | Leaderless | 1 RTT (commutative) | Fast quorum | Dependency graph | Complex | Research |

### Write-Path Architectures

| Company | Write Model | Conflict Strategy | Write Latency | Consistency |
| --- | --- | --- | --- | --- |
| **LinkedIn** | Single-leader (Espresso) | None by design | ~3ms | Strong (leader), eventual (cross-DC) |
| **Facebook** | Single-leader (TAO) | Remote marker trick | ~5ms | Read-your-writes via cache |
| **Google/YouTube** | Sync Paxos (Spanner) | None (global order) | ~50-150ms | External consistency |
| **Spotify/Netflix** | Leaderless (Cassandra) | LWW | ~5ms | Eventual (tunable) |
| **TiDB** | Raft per Region | None (majority ACK) | ~10ms | Strong (linearizable) |

### Sharding Strategies

| Strategy | Range Scans | Hot Spots | Auto-Split | Adding Nodes | Used By |
| --- | --- | --- | --- | --- | --- |
| **Hash (modulo)** | Scatter-gather | Low | No | Helix reassigns | Espresso, Redis |
| **Range** | Efficient | High (sequential) | Yes | PD moves Regions | TiKV, Spanner, HBase |
| **Consistent hash** | Scatter-gather | Low | No | 1/N keys move | DynamoDB, Cassandra |

#### Closing Thoughts from the Document

```
FOUR THEMES:

1. Schema design beats fancy protocols.
   Make objects immutable, give each one writer, append don't update.
   If you can, single-leader is enough and life is easy.

2. Modern systems are composites.
   Authoritative write store + derived read stores + change streams.
   CQRS is the underlying pattern everywhere.

3. Strong consistency costs latency.
   You cannot beat the speed of light. Spanner: 50-150ms cross-region.
   Accept eventual, pin writes, or use CRDTs.

4. fsync is the real bottleneck.
   Consensus latency isn't the network — it's the disk.
   Acceptor must fsync before ACK: ~0.5ms SSD, ~10ms HDD.
   Batching fsyncs and NVMe are the real optimizations.
```

[↑ Back to Contents](#toc)
