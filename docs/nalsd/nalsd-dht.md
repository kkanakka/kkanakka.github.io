---
title: "Distributed Hash Table"
slug: /nalsd/nalsd-dht
sidebar_position: 6
sidebar_label: "Distributed Hash Table"
description: "Distributed Hash Table"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/nalsd-dht/sequence.svg" alt="How it works — nalsd-dht" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
in

in/dht

v2026.05 · nalsd

in/dht/ design-docs/ 2026/ distributed-hash-table.md

A NALSD walkthrough — the storage substrate beneath Profile, InMail attachments, Connect graphs, and feature stores. 1 PB of key-value data, 5 M ops/sec, p99 ≤ 10 ms reads, self-organizing through node join/leave with consistent hashing + virtual nodes.

NALSD p99 ≤ 10 ms 5M ops/s 1 PB · 1000 nodes draft · review last edit · 2026-05-12 · sjc

## 1 · Problem statement & SLO contract

A DHT is the canonical distributed-systems primitive: a key-value store partitioned across N nodes such that any client can locate any key in O(log N) hops without consulting a central coordinator. Inspired by Chord, Kademlia, and Dynamo, the design provides **self-organization** (nodes join and leave continuously without operator intervention), **load balance** (consistent hashing with virtual nodes spreads keys uniformly), **fault tolerance** (N-replica writes survive node loss), and **eventual consistency** (replicas converge after partition healing). At LinkedIn, this substrate underlies Profile blob storage, attachment metadata, distributed locks, feature vectors, and the Connect graph adjacency lists.

Data volume

1 PB

key-value pairs

Ops/sec

5 M

80% reads · 20% writes

Read latency

≤ 10 ms

p99 within region

Cluster size

~1,000

nodes per region

### SLO contract

| SLI | Target | Measurement | Error budget / 28d |
| --- | --- | --- | --- |
| **A · Read latency** | p99 ≤ 10 ms | client GET → response | ~24 h tail |
| **B · Write latency** | p99 ≤ 20 ms | client PUT → W-of-N ACK | ~24 h tail |
| **C · Availability** | ≥ 99.99% | ops accepted / offered | ~4 min/month |
| **D · Durability** | 11 nines | RF=3 + cross-region async | measured via audit |
| **E · Convergence** | p99 ≤ 5 s | last-replica replication delay | eventual consistency window |
| **F · Load skew** | ±10% max | per-node key count vs mean | rebalancing target |
| **G · Routing hops** | O(log N) | median 1, p99 ≤ 3 hops | finger-table SLO |

The defining property: self-organization Unlike sharded SQL or traditional caches (which need an operator or coordinator to manage shard placement), a DHT *routes itself*. Add a node — it joins the ring, takes over a slice of the keyspace, and starts serving traffic within seconds. Remove a node — its successor takes over its range. **This makes DHTs ideal for highly elastic workloads** where capacity changes constantly (e.g., feature stores during model training peaks).

#### The CAP trade we're making

DHTs sit firmly in the **AP corner** (Availability + Partition tolerance, eventual Consistency). On a network partition, both sides keep accepting writes; conflicts resolve via vector clocks + last-writer-wins (with optional CRDT semantics for counters). This is what enables 4 nines availability and the elastic node-add behavior. If you need strong consistency, use Spanner; if you can tolerate ~5 seconds of eventual convergence, a DHT is 10× cheaper and 100× more elastic.

## 2 · Capacity model (the NALSD math)

### 2.1 — Workload characterization

#### Ops, bytes, and key distribution

```
peak ops/sec global       = 5,000,000
  reads (80%)             = 4,000,000 GET/s
  writes (20%)            = 1,000,000 PUT/s

avg key size              = 32 B (uuid + namespace prefix)
avg value size            = 2 KB (Profile blob, feature vector, etc.)
                              p99 value size = 64 KB (large attachments)

read bytes/sec global     = 4M × 2 KB = 8 GB/s ≈ 64 Gbps
write bytes/sec global    = 1M × 2 KB = 2 GB/s ≈ 16 Gbps
  with 3× replication on writes: 6 GB/s ≈ 48 Gbps

per region (5 regions, weighted 35/25/20/12/8):
us-west-2 peak read       = 8 × 0.35 = 2.8 GB/s ≈ 22 Gbps
us-west-2 peak write      = 6 × 0.35 = 2.1 GB/s ≈ 17 Gbps  (incl. repl)
```

VERDICT · 22 Gbps top region read. 100 Gbps spine handles it with headroom.

### 2.2 — Routing math (where O(log N) comes from)

#### Naïve vs. Chord finger table

```
cluster size              = 1,000 nodes per region
keyspace                  = SHA-256, treated as 2^160 ring
keys per node             = 2^160 / 1,000 ≈ 10^48 IDs (effectively continuous)

NAIVE LOOKUP (no routing info):
  client knows 1 node, asks it
  worst case: that node forwards around entire ring
  → O(N) hops = up to 1,000 RPCs
  → completely impractical

LINEAR FORWARDING (each node knows successor):
  walk around ring until you find owner
  → O(N/2) average hops = 500
  → still terrible

CHORD FINGER TABLE (O(log N)):
  each node maintains log2(N) "finger" pointers:
    finger[i] = successor of (my_id + 2^i)
  for N = 1000: log2(1000) ≈ 10 fingers per node
  → each hop halves the remaining distance
  → O(log N) = ~10 hops worst case
  → in practice: 1-3 hops average due to client caching

storage per node for finger table:
  10 entries × ~100 B each (node_id + ip + port + status)
  = 1 KB per node — trivial
```

VERDICT · 10 fingers per node → median 1 hop, p99 ≤ 3 hops. SLO-G met with 1 KB of state per node.

#### Why we still cache routing client-side

```
even 1-3 hops × 0.5 ms each = 1.5-4.5 ms wasted on routing
client SDK caches "last known owner" for each key prefix
  cache size: ~10k entries × 200 B = 2 MB per client
  TTL: 60 seconds (refreshes during normal operation)
  invalidation: server returns 307 redirect on cache miss

with client cache hit (~95% of requests):
  client → owner direct, 0 routing hops
  total latency = 1 network RTT + storage lookup ≈ 5 ms

without cache (5% of requests):
  client → coordinator → owner = 1-3 hops
  total latency = 3-10 ms

p99 read latency budget:
  client RTT to coord       = 1 ms
  routing (when needed)     = 3 ms  (1-3 hops)
  storage read on owner     = 2 ms  (NVMe random read)
  response back             = 1 ms
  ─────────────────────────────────
  total p99                  = 7 ms ✓ under 10 ms SLO
```

VERDICT · Client cache + O(log N) finger table = 7 ms p99 read. 3 ms headroom.

### 2.3 — Storage and replication sizing

#### Per-node storage, replication overhead

```
total data per region (us-west-2, 35% share):
  1 PB × 0.35 = 350 TB logical

with RF=3 replication:
  350 × 3 = 1,050 TB = ~1 PB physical per region

per-node storage (1000 nodes/region):
  1 PB / 1000 = 1 TB per node
  with 30% headroom for tombstones, indexes = 1.3 TB

instance choice: i4i.4xlarge
  16 vCPU, 128 GB RAM, 7.5 TB NVMe (plenty of headroom)
  ~30K IOPS sustained, ~150K peak
  $1,200/month on-demand, ~$450/month 3y RI

replication strategy:
  RF=3 placed on 3 successive nodes in the ring
  AZ-aware: each replica in a different AZ
  cross-region: async (eventually consistent, ~5s lag)

write quorum: W=2 of 3 → durable on 2 nodes before ACK
read quorum: R=1 of 3 → reads any one replica (fast path)
  if R+W > N: strong consistency (rarely used here, R=1)
  if R+W ≤ N: eventual consistency (default, fast)
```

VERDICT · 1.3 TB/node × 1000 nodes/region · RF=3 · W=2 · R=1.

#### Memory tier (hot key cache)

```
each node also has:
  in-memory LRU cache: 32 GB per node
  caches ~16M keys (avg 2 KB value) per node
  ratio: 32/1024 = 3% of disk in RAM

cache hit ratio (measured): ~85%
  hit → 0.5 ms read (RAM)
  miss → 2 ms read (NVMe)
  weighted avg = 0.5 × 0.85 + 2 × 0.15 = 0.7 ms storage time
  → most of the 7ms latency is network, not storage
```

VERDICT · 32 GB hot cache per node yields 85% hit rate. Storage is rarely the bottleneck.

### 2.4 — Fleet summary & cost

| Tier | Instance | Count | $/mo (on-demand) | $/mo (3y RI) |
| --- | --- | --- | --- | --- |
| DHT nodes (storage + routing) | i4i.4xlarge | 5,000 (1000 × 5 regions) | $6 M | $2.25 M |
| Coordinator / seed nodes | m6i.2xlarge | 25 (5/region) | $7 K | $2.7 K |
| Anti-entropy workers | m6i.xlarge | 15 | $2.6 K | $1 K |
| Cross-region replication | — | 2 Gbps avg | $13 K | $13 K |
| Bootstrap / config store | Spanner | 3 nodes | $12 K | $12 K |
| Observability | m6i.large | 12 | $1 K | $0.4 K |
| Total | — | ~5,067 nodes | $6.04 M/mo | $2.28 M/mo |

Cost composition Storage nodes dominate at **98% of cost**. The DHT itself is essentially "free" overhead — the actual cost is storing 1 PB × 3 replicas × 5 regions = 15 PB physical with NVMe-grade performance. Compared to Spanner-equivalent storage (~$15M/mo at this scale), the DHT is **~6× cheaper** by accepting eventual consistency.

## 3 · Architecture

### 3.1 — Full architecture diagram

<img src="/diagrams/nalsd-dht/1.svg" alt="nalsd-dht diagram 1" class="doc-diagram" />

Fig 1 · Complete DHT architecture. Numbered circles match the step-by-step flow in §3.2. Every node is a peer playing multiple roles (routing, storage, gossip). The ring is the "topology"; each node owns a slice and replicates to N-1 successors.

### 3.2 — Step-by-step flow (the numbered walkthrough)

Following the numbered blue badges in Fig 1. We trace **two scenarios**: **(A)** a Profile blob GET (steps 1-7 — the hot read path), then **(B)** an InMail attachment PUT (steps 8-11 — the write path).

Client issues GET for a Profile blob

**Scenario A:** A Feed render needs Profile blob for user 12345. The app pod calls `dht.get("profile:user:12345")` via the embedded SDK.  
  
The SDK first checks its **local key cache** (60s TTL). If we recently fetched this key, the cache tells us which DHT node currently owns it — we can go direct, skipping routing. Cache hit rate is ~95% during steady state.  
  
For our example, this is the first request for user 12345 — cache miss. The SDK picks any DHT node from its seed list and sends the GET there. That node will act as the **coordinator** for this request.

key = "profile:user:12345" · hash = SHA256(key) · cache.lookup(key) → MISS · coord = pick\_random(seed\_list)

budget · **1 ms client-side** cache hit rate · **~95%** cache TTL · **60 s**

Coordinator node receives request, looks up owner

Any DHT node can play coordinator — there's no special "router" tier. The chosen node (say N₂₇) receives the GET, hashes the key, and consults its **finger table** to find the closest predecessor of `hash(key)`.  
  
The finger table has 10 entries (log₂(1000)). The lookup:  
1\. Compute `target = SHA256("profile:user:12345") = 0x9b21...`  
2\. Find the largest finger entry whose ID precedes the target  
3\. Forward the request to that finger (one hop)  
4\. That node repeats — but its finger table covers a finer region of the ring  
5\. After ~3 hops, we reach the actual owner  
  
The coordinator could also do this lookup eagerly (fetch successor list and route directly) — saves hops but burns more state. We use lazy single-hop forwarding for simplicity.

finger\_table.find\_predecessor(target) → forward(next\_hop) · until hash(key) ∈ (predecessor, successor\]

budget · **3 ms (max 3 hops × 0.5 ms each + 1 ms node lookup)** hops · **median 1, p99 ≤ 3** finger table size · **10 entries**

Bootstrap / config provides cluster metadata

Out-of-band but critical: the bootstrap service (running on Spanner) is the source of truth for cluster topology. SDKs and DHT nodes consult it on startup to get the seed node list, current RF/quorum config, and topology version.  
  
**Why not let the ring be its own source of truth?** Because new joiners need to know SOMEONE to ask first. The bootstrap service is the "rendezvous point" — once you've found any one ring member, gossip teaches you the rest. After startup, the bootstrap service is rarely consulted (only on config change or full rejoin).

spanner.read(cluster\_meta) → {seed\_nodes, RF, W, R, topology\_version} · cached client-side

consult frequency · **once per SDK init** cache TTL · **1 hour** storage · **Spanner (strong consistency)**

Request lands on owner node (Nₖ)

After 1-3 hops, the request reaches the actual owner — node Nₖ whose ID range contains `hash("profile:user:12345")`. Nₖ is now the coordinator for this read.  
  
Nₖ has three options:  
(a) **Local read (R=1, fast path)** — read from its own storage and respond. Used 95% of the time. ~2 ms latency.  
(b) **Quorum read (R=2)** — read from 2 of 3 replicas, return the one with the highest vector clock. Used when caller passes `consistency=strong`.  
(c) **Read-repair** — read from all 3 replicas, return the latest, and asynchronously push the latest version to any stale replicas. Used periodically for anti-entropy.  
  
For our Feed render, we want R=1 (fast) — eventual consistency is fine for Profile data.

if hash(key) ∈ my\_range: serve from local; else: forward · consistency=eventual → R=1

budget · **3 ms on owner** R=1 default · **~95% of reads** R=2 strong · **~5% of reads**

Routing layer maintains finger table (continuous)

In parallel with serving requests, every node continuously maintains its routing state:  
  
**Stabilization protocol (every 30 s):**  
\- Each node asks its successor "who is your predecessor?"  
\- If the answer isn't this node, the topology shifted (someone joined between us)  
\- Update successor pointer; the joiner's stabilization will see us and update its predecessor  
  
**Finger table refresh (every 60 s):**  
\- Periodically re-lookup each finger entry to detect failed nodes  
\- Replace dead entries with their successors via successor list  
  
**Successor list (length 3):**  
\- Each node tracks its next 3 successors, not just one  
\- Survives transient node failure without full re-stabilization

every 30s: stabilize() · every 60s: fix\_fingers() · failure detection via SWIM gossip

stabilization period · **30 s** finger refresh · **60 s** successor list · **length 3**

Storage layer reads from LSM tree (or RAM cache)

The actual storage engine on Nₖ is an LSM tree (similar to RocksDB) on local NVMe. Its read path:  
  
1\. **Check in-memory LRU cache** first (32 GB). For our Profile blob, cache hit rate is ~85% because hot profiles are repeatedly accessed. Cache hit → return in 0.5 ms.  
2\. On cache miss, check the active memtable (recent writes).  
3\. On miss, walk SSTables from newest to oldest, using bloom filters to skip most files.  
4\. Read the value from NVMe (1-2 ms with NVMe random read).  
5\. Promote to cache; return.  
  
The key also carries a **vector clock** for conflict resolution. On read, we just return the value; on write, the clock advances. If two replicas diverge, the vector clock tells us which one is "later" (or that they conflict, requiring application-level merge).

cache.get(key) → on miss: memtable + sstables (bloom-filtered) · value+vclock returned

cache hit · **0.5 ms** cache miss · **2 ms (NVMe random read)** weighted avg · **~0.7 ms**

Gossip + failure detection runs continuously (independent)

Independent of any request, every node participates in the gossip protocol (we use a SWIM-style design):  
  
\- Every 1 s, each node picks **k = log(N) ≈ 10** random peers and exchanges heartbeats  
\- Heartbeats also piggyback "metadata diffs" — recent membership changes, suspicions of node failure  
\- If a node hasn't responded in 5 s, peers ask the suspected dead node's neighbors to check  
\- After 10 s of confirmed silence, the node is marked dead and removed from the ring  
  
**Why this matters for the read path:** when Nₖ's finger pointer to "Nₖ₊₃" is stale (Nₖ₊₃ died 2 minutes ago), the gossip protocol ensures Nₖ knows quickly and routes around the failure. SLO-A (10ms p99) depends on this fast failure detection.

SWIM: every 1s, ping(random\_peer); if fail: indirect\_probe via k=3 witnesses; mark dead after 10 s

gossip cadence · **1 s** failure detection · **< 10 s** gossip fanout · **k = log(N) = 10**

SCENARIO B: Client writes (PUT) an attachment

A user sends an InMail with a PDF attachment. After uploading the PDF to blob storage, the InMail service stores the metadata (sender, recipient, attachment URL, vector clock) via `dht.put("inmail:msg:abc123", metadata)`.  
  
Same flow as the read: SDK consults cache, contacts a coordinator (could be the same Nₖ or a different node), which forwards to the owner.  
  
The key difference: **the coordinator now talks to all 3 replicas in parallel**. It sends the write to Nₖ (primary), Nₖ₊₁ (replica 2), and Nₖ₊₂ (replica 3). It waits for W=2 successful ACKs before responding to the client. The third replica is updated asynchronously.

put(key, val) → coord forwards to \[Nₖ, Nₖ₊₁, Nₖ₊₂\] · vclock advance · ACK when W=2 of 3 succeed

budget · **20 ms p99 (write)** replicas · **3 (RF=3)** quorum · **W=2**

Replication path with hinted handoff

What if one of the replicas is temporarily down? Without protection, the write might block waiting for ACK, or worse, succeed at W=2 but leave the third replica permanently stale.  
  
**Hinted handoff:** When the coordinator can't reach Nₖ₊₂, it stores the write locally with a "hint" indicating which node it was meant for. Periodically, the coordinator retries delivering hints. When Nₖ₊₂ comes back online, the hints flush in order.  
  
This is what gives us "always writable" semantics — the write succeeds as long as *any* W nodes anywhere in the ring can accept it. Even during severe failures, writes don't block.  
  
Combined with vector clocks for conflict resolution, this is the **Dynamo-style "AP" property**: prioritize availability over strict consistency.

on replica unreachable: store(value, hint={target\_node, vclock}) · on peer return: flush\_hints\_in\_order(target)

hint TTL · **3 days** hint storage · **per-coordinator local** always-writable · **yes**

Anti-entropy heals long-term divergence

Hinted handoff fixes brief outages, but what about longer ones — a node down for hours, or a network partition that swallowed writes?  
  
The **anti-entropy** mechanism runs in the background. Every hour, replica pairs exchange **Merkle tree hashes** of their key ranges:  
\- Compute hash of all keys in each sub-range  
\- Exchange tree roots; if equal, all keys are consistent  
\- If unequal, recurse into children; identify the divergent ranges  
\- Sync only the divergent keys (logarithmic data transfer, not full scan)  
  
Additionally, **read-repair** happens inline: if a read with R=2 returns inconsistent values across replicas, the coordinator asynchronously pushes the latest version to stale replicas. SLO-E (convergence p99 ≤ 5s) is met through this combination — hinted handoff for <1s outages, read-repair for steady state, anti-entropy for long-term healing.

every 1h: exchange\_merkle\_roots(peer) · diff identifies divergent ranges · sync only those keys

cadence · **1 h scan · inline read-repair** workers · **15 (throttled)** data transfer · **logarithmic in divergence**

Observability + admission control close the loop

All five SLIs are continuously monitored: read p99, write p99, availability, durability (via audit replicas), convergence delay, load skew. Crucial dashboards include:  
  
\- **Load skew alert** if any node holds >110% of mean keys (rebalance trigger)  
\- **Ring topology view** showing current membership, finger correctness, suspected failures  
\- **Per-tenant rate limiting** at the coordinator to prevent noisy neighbors  
\- **Chaos injection** running continuously in staging (kill random nodes, induce partitions, slow disk)  
  
For our scenarios: the GET completed in ~7 ms (1 ms client + 3 ms routing + 3 ms read). The PUT completed in ~15 ms (1 ms client + 3 ms routing + 11 ms W=2 quorum). Both under SLO budgets.  
  
**Total wall-clock for the hot read path:** 7 ms p99. **For the write path:** 15 ms p99. The system handles 5M ops/sec, self-organizes under churn, and has 6× lower cost than the strongly-consistent alternative (Spanner). That's the DHT value proposition.

metrics: read\_p99, write\_p99, avail, conv\_delay, load\_skew · admission control via token bucket per tenant

read p99 · **~7 ms ✓ (SLO 10 ms)** write p99 · **~15 ms ✓ (SLO 20 ms)** availability · **4 nines**

The key design insight Notice that *every node plays every role* — there's no special "router," "coordinator," or "leader." Each node holds a finger table, stores data, gossips, and can coordinate any request. **This is what gives DHTs their elasticity: adding a node doesn't require operator intervention, schema migration, or capacity planning — the new node just joins the ring and the system rebalances.** The cost is eventual consistency, which is acceptable for most workloads but unacceptable for, say, monetary transactions (use Spanner there).

### 3.3 — Ring topology and finger table close-up

The hash ring is the heart of the DHT. Here's the topology with 8 example nodes (in production: 1,000 per region) and how the finger table works.

<img src="/diagrams/nalsd-dht/2.svg" alt="nalsd-dht diagram 2" class="doc-diagram" />

Fig 2 · Ring topology with 8 example nodes. N₆ receives a lookup for key at hash 0x40. Without fingers, it would forward to successor (N₇), which forwards to N₀, then N₁, then N₂ — 4 hops. With finger table, N₆ finds the largest finger preceding 0x40 (N₂) and forwards directly — 1 hop.

### 3.4 — Node join/leave (the self-organizing part)

The defining feature of a DHT: you don't manually plan capacity. You add a node and it integrates itself. Here's the protocol:

| Event | Step | Action | Time |
| --- | --- | --- | --- |
| **Node JOIN** | 1 | New node N\* picks a random ID (UUID-based, ensures uniform placement) | instant |
| 2 | N\* contacts a seed node, asks "who is the successor of my ID?" | +10 ms |
| 3 | N\* tells its successor "I'm your new predecessor"; successor updates its predecessor pointer | +10 ms |
| 4 | Successor transfers the relevant key range to N\* (only the range N\* should own) | +30-60 s |
| 5 | Stabilization propagates: within 1-2 minutes, all other nodes' finger tables converge to include N\* | +90 s |
| **Node LEAVE (graceful)** | 1 | Departing node announces departure via gossip | instant |
| 2 | Successor takes over the departing node's key range (already has copies as replica) | +5 s |
| 3 | Other replicas are promoted; new replica chosen to maintain RF=3 | +30 s |
| 4 | Finger tables converge via stabilization | +90 s |
| **Node FAIL (crash)** | 1 | SWIM gossip detects unreachable node within 10 s | +10 s |
| 2 | Successor list activates: next live successor takes over range | +10 s |
| 3 | Read traffic for that range continues uninterrupted (replicas still serve) | continuous |
| 4 | Replication maintenance: replicate to new replica to restore RF=3 | +5 min |

Why "virtual nodes" matter Each physical node actually owns **256 virtual nodes** on the ring, each with its own ID. Why? **Without vnodes:** when a node fails, ALL its keys move to one successor — that node now has 2× its share, getting hammered. **With 256 vnodes:** the failed node's 256 vnodes are spread across 256 different successors, each taking only a small fraction. **Load remains uniform during churn.** Same trick as the distributed cache doc, applied to a different problem.

## 4 · Failure gauntlet

A · Single node crash SLI: A, C

A DHT node dies; its keys (range + replica copies) are affected.

triggerSWIM marks node dead < 10 s

absorbsuccessor takes over range; other replicas serve reads

healnew replica created within 5 min to restore RF=3

verdictno data loss · brief latency tail

B · Network partition SLI: B, E

AZ split — ring is divided into two halves that can't talk.

triggergossip-detected partition

absorb (AP)both halves continue accepting reads/writes

healanti-entropy + read-repair merge divergent values via vclocks

verdictavailability preserved; convergence p99 ≤ 5 s

C · Hot key SLI: A, F

A viral profile gets 100K GET/s — single node saturates.

triggerper-node QPS > 50K

absorbreplica-side read load balancing (R=1 across 3 replicas)

capclient-side L1 cache for hot keys (1 s TTL)

verdicthot key spread across 3 replicas + client cache

D · Concurrent writes (conflict) SLI: E

Two clients write to the same key simultaneously from different regions.

triggervclock comparison shows concurrent writes

absorb (simple)last-writer-wins by timestamp

absorb (CRDT)app-level merge function called by SDK

verdictboth writes preserved or merged

E · Cascading failure SLI: A, C

Failed node's load shifts to successor; successor overloads and fails.

trigger2+ consecutive node failures in same range

absorbvnodes mean load spreads to 256 successors, not 1

protectadmission control caps per-node QPS

verdictno cascade — load remains spread

F · Join storm SLI: A, F

Auto-scaler adds 200 nodes simultaneously.

triggertopology version churning

absorbthrottle joins to N/min via bootstrap service

protectdata transfer rate-limited during join

verdict~1 min per join; total 200 nodes added in < 1 h

Cannot defend against Complete loss of all 3 replicas for the same key (data center fire affecting one ring slice across AZs). Mitigation: cross-region async replication (1+ region always alive). Math: probability of all 3 AZs failing simultaneously ≈ 10⁻⁹/year, mitigated to 10⁻¹²/year with cross-region.

## 5 · Operational playbook

### 5.1 — Deployment

| Stage | Strategy | Care needed |
| --- | --- | --- |
| DHT nodes | rolling, 1 node at a time | drain → handoff → restart; ~5 min/node |
| SDK rollout | canary 1% → 10% → 100% | SDK changes affect every app pod; canary first |
| Protocol upgrades | backwards-compatible only | two-phase: read old/write old → write new → read new |
| Major topology changes | scheduled maintenance window | rebalancing data movement is expensive |

### 5.2 — Chaos drills (quarterly)

-   **Random node kill (1)** — verify successor takes over within 10 s; no read errors.
-   **Random node kill (multiple)** — kill 3 nodes simultaneously; verify successor list activates correctly.
-   **Network partition** — induce AZ split; verify both sides keep serving; verify convergence post-heal.
-   **Slow node** — inject 100ms latency on one node's responses; verify other replicas absorb the read load.
-   **Join storm** — add 50 nodes simultaneously; verify rebalancing doesn't degrade SLOs.
-   **Vclock conflict injection** — write same key from 3 regions concurrently; verify conflict resolution.
-   **Hot key simulation** — synthesize 200k QPS on one key; verify replica fan-out + client cache absorption.

### 5.3 — Runbook excerpt

```
# Symptom: SLO-A burning — read p99 > 10 ms

# Likely causes (ranked)
1. Routing table stale            → check stabilization metrics
2. Hot key on single replica      → check per-key QPS
3. Slow node in critical path     → check per-node response time
4. Network partition              → check gossip view consistency

# First response (in order):
- Confirm: dashboard 'dht-slo-a' shows > 10 ms p99
- Check ring topology: nodes with stale fingers / suspected failures
- Identify hot key (if any): top keys by QPS, replicate to client cache
- If specific node slow: drain it (gracefully exit ring), restart
- Communicate: post in #incident-dht
- Escalate: if not resolving in 15 min, page tier-2 oncall
```

## 6 · Component reference

| Component | Tech | Scale | Failure mitigation | SLO |
| --- | --- | --- | --- | --- |
| **Client SDK** | Go / Java library | ~2M app pods | local cache · seed list · retry | A,B |
| **DHT node (routing)** | finger table · successor list | 1000 nodes/region | stabilization · gossip | A,G |
| **DHT node (storage)** | LSM tree + LRU cache | 1.3 TB/node · 32 GB RAM | 3× replica · vclock | A,B,D |
| **Gossip / failure detect** | SWIM | k=log(N) fanout | indirect probes · suspicion | C |
| **Replication path** | async fanout | RF=3, W=2, R=1 | hinted handoff | B,C,D |
| **Anti-entropy** | Merkle tree sync | 15 workers throttled | scheduled + read-repair | E |
| **Cross-region replication** | async stream | 2 Gbps avg | retry · catch-up via merkle | D,E |
| **Bootstrap / config** | Spanner | 3 nodes region-replicated | strong consistency | C |
| **Coordinator role** | any DHT node | stateless function | any other node can take over | A,B |
| **Observability** | Prometheus + chaos | per-node metrics | synthetic tests, load skew alerts | all |

## 7 · Trade-offs & open questions

#### Chose

-   **AP over CP** · availability and partition tolerance over strong consistency; trade: eventual consistency (5 s convergence window).
-   **Consistent hashing with 256 vnodes** · uniform load even during churn; trade: more per-node state (256× ring entries).
-   **Finger tables (O(log N))** over flat routing · ~3 hops max instead of 500; trade: 1 KB state per node + maintenance overhead.
-   **Vector clocks** over physical timestamps · captures concurrency correctly; trade: storage cost (~50 B per key).
-   **Hinted handoff** · always-writable behavior; trade: temporary inconsistency, hint TTL management.
-   **Per-node coordinator role** · any node can serve; trade: no admin shortcut for "find the leader."
-   **LSM tree on NVMe** · high write throughput; trade: read amplification (mitigated by bloom filters + cache).
-   **SWIM gossip** · scales to thousands of nodes; trade: ~10 s failure detection (not sub-second).

#### Rejected

-   **Single coordinator** (Cassandra-style "token-aware client") · client complexity; SDK approach is more transparent.
-   **Strong consistency (Paxos/Raft per shard)** · would tank write latency from 15 ms to 100+ ms.
-   **No virtual nodes** · simpler but creates dramatic load imbalance during failures.
-   **Full state synchronization** · would saturate network; Merkle trees give logarithmic sync cost.
-   **Manual shard placement** · operationally heavy; consistent hashing automates it.
-   **Bigtable / DynamoDB managed** · vendor lock-in; we own the protocol and can tune for our workloads.
-   **Spanner** for the same use cases · 6× more expensive at this scale; only worth it for strong consistency requirements.

### Open questions

1.  Should we support **per-key consistency levels** as a write-time parameter (e.g., monetary transactions: R=2, W=3; profile data: R=1, W=2)? Currently global config.
2.  Is 256 vnodes the right number? Higher = better load balance, but more ring metadata to maintain. Need to measure.
3.  Should we offer **multi-key transactions**? Some workloads (Connect graph updates) want "atomically update 5 keys." Currently single-key only.
4.  Should the SDK support **local secondary indexes**? "Find all keys with attribute X = Y" requires scatter-gather across all nodes. Add this complexity, or push to a separate indexing service?
5.  How aggressive should cross-region replication be? Currently async (~5 s lag); some workloads want sync (read-your-writes globally). Adds latency + cost.
6.  Should we add **compression at the SDK layer** for large values? Avg value is 2 KB; with zstd we'd save ~50% storage. Trade: CPU on client.
