---
title: "Global Distributed Cache"
slug: /nalsd/nalsd-distributed-cache
sidebar_position: 7
sidebar_label: "Global Distributed Cache"
description: "Global Distributed Cache"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/nalsd-distributed-cache/sequence.svg" alt="How it works — nalsd-distributed-cache" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
in

in/cache

v2026.05 · nalsd

in/cache/ design-docs/ 2026/ global-distributed-cache.md

A NALSD walkthrough — the tier between user-facing services (Feed, Profile, Search, InMail) and persistent stores. 500M users, 10M reads/sec, 1M writes/sec, p99 ≤ 5 ms regional reads, global invalidation in < 1 s.

NALSD read p99 < 5ms 10M RPS read ≥ 95% hit rate draft · review last edit · 2026-05-12 · sjc

## 1 · Problem statement & SLO contract

Every Feed render reads ~30 Profile records. Every Search results in 100 user-card lookups. Every InMail sent invalidates the recipient's notification count. None of these can hit Postgres directly — at 10 M reads/sec, the database fleet alone would cost more than the entire monitoring platform. The distributed cache sits between the application tier and persistent storage, absorbing the hot path. Most reads (≥ 95%) terminate in the cache and never touch a database.

Active users

500 M

global

Read RPS

10 M

peak global

Write RPS

1 M

peak global

Read latency

< 5 ms

p99 regional

### SLO contract

| SLI | Target | Measurement | Error budget / 28d |
| --- | --- | --- | --- |
| **A · Read latency** | p99 ≤ 5 ms | client → cache hit → response | ~24h with >5ms tail |
| **B · Write propagation** | p99 ≤ 1 s | write at origin → visible all regions | configurable per key class |
| **C · Availability** | ≥ 99.99% | read path uptime per region | ~4 min/month |
| **D · Hit ratio** | ≥ 95% | cache hits / total reads | ~5% misses budget |
| **E · Data integrity** | < 0.001% | stale reads beyond SLO window | strict |
| **F · Cost efficiency** | ≤ $0.05 | per million reads | budget pressure |

The latency vs cost trade Every order of magnitude tighter on latency costs ~10× more (RAM > SSD > HDD). Every order of magnitude better hit rate above 95% requires exponentially more memory. The art is finding the sweet spot where reads are fast enough *and* cheap enough *and* hit rate is high enough — all three at once. SLO-F (≤ $0.05/M reads) is what keeps the design honest.

#### The latency ladder this design lives in

RAM ~100 ns

L1 cache, JVM heap, Redis in-process

DC round-trip ~500 µs

App pod ↔ cache pod inside region — this is OUR budget

SSD random read ~100 µs

DB fallback path on cache miss

Cross-region ~100 ms

Cross-region read — must NEVER be in the read path

## 2 · Capacity model (the NALSD math)

### 2.1 — Workload mix

#### Bytes per second across reads + writes

```
peak read RPS          = 10,000,000
peak write RPS         =  1,000,000  (10% of reads, typical R/W ratio)

avg value size (profile + session data):
  user_id (key)            =  16 B
  profile JSON blob        = 2 KB  (name, headline, photo URL, etc.)
  session token blob       = 512 B
  notification counts      = 128 B
  ─────────────────────────────────
  avg value per key        = 2 KB (round up, simple)

read traffic bytes/sec    = 10e6 × 2 KB = 20 GB/s ≈ 160 Gbps global
write traffic bytes/sec   =  1e6 × 2 KB =  2 GB/s ≈  16 Gbps global

per region (5 regions, weighted 35/25/20/12/8):
us-west-2 peak read       = 20 × 0.35 = 7 GB/s ≈ 56 Gbps
us-west-2 peak write      =  2 × 0.35 = 700 MB/s ≈ 5.6 Gbps
```

VERDICT · 56 Gbps top region. 4× 25Gbps NICs per rack handles it.

### 2.2 — Memory sizing (the hot working set)

#### How much RAM do we need?

```
active users globally     = 500,000,000
per-user cache footprint:
  profile blob             = 2 KB
  3 recent sessions        = 1.5 KB
  notification counts      = 0.5 KB
  ─────────────────────────────────
  per-user data            = 4 KB

theoretical 100% hit working set:
  500M × 4 KB              = 2 TB

practical observation: 90/10 rule
  90% of reads hit 10% of users (top 50M users)
  hot working set          = 50M × 4 KB = 200 GB
  warm working set         = 150M × 4 KB = 600 GB
                              (cumulative 95% of reads → keep in cache)

cache size target          = 800 GB hot working set per region (largest)
  → covers 95% hit rate for top region (us-west-2)
  → smaller regions need proportionally less

with 2× replication for durability + 30% growth headroom:
  per region: 800 × 2 × 1.3 = 2.1 TB
```

VERDICT · 2.1 TB per top region. Cache miss budget (5%) absorbs the long tail of cold users.

### 2.3 — Shard count and node sizing

#### How many Redis nodes per region?

```
per-Redis-node specs (cache.r6g.4xlarge):
  memory                    = 128 GB
  network                   = 12 Gbps (1.5 GB/s)
  ops/sec capacity          = ~150,000 ops/sec sustained
                            ← BOUNDED by ops/sec, not memory

shards needed by MEMORY (top region):
  2.1 TB / 128 GB           = 17 shards

shards needed by OPS (top region):
  read RPS top region       = 10M × 0.35 = 3,500,000 RPS
  per-shard cap (150k)      = 24 shards

  → ops bounds, not memory → need 24 shards

with 2 replicas per shard (master + 2 replicas):
  nodes per top region      = 24 × 3 = 72 nodes

total fleet (5 regions, scaled by traffic share):
  pdx (35%) = 72 nodes
  dub (25%) = 51 nodes
  iad (20%) = 41 nodes
  sin (12%) = 25 nodes
  bom  (8%) = 17 nodes
  ──────────────────────────
  total                    = 206 cache nodes
```

VERDICT · 206 cache nodes globally. Ops/sec, not memory, is the binding constraint at this scale.

### 2.4 — Network sizing

#### Intra-region + cross-region traffic

```
intra-region read fan-out (top region):
  app pods → cache pods    = 7 GB/s (one request, one response)
  with response = 2 KB     = same 7 GB/s back
  total bidirectional       = 14 GB/s ≈ 112 Gbps
  per-rack with 100 GbE TOR  → 2 racks accommodate

cross-region invalidation traffic (writes):
  global write RPS          = 1M writes/s
  invalidation message size = 64 B (key + timestamp + region origin)
  bytes/sec global          = 1M × 64 B = 64 MB/s ≈ 512 Mbps

  per region to peer regions (4 peers via MM2):
  64 MB/s × 4 dest peers    = 256 MB/s ≈ 2 Gbps cross-region
  AWS egress cost @ $0.02/GB = $4,400/mo per region
  total cross-region cost    = ~$22K/mo

note: this is INVALIDATION traffic, NOT full value replication
  → just key + tombstone, not 2 KB blob
  → key insight: regions re-fetch from local DB on miss
```

VERDICT · Cross-region traffic is small (2 Gbps per region) because we send invalidations, not values.

### 2.5 — Fleet summary & cost

| Tier | Instance | Count | $/mo (on-demand) | $/mo (3y RI) |
| --- | --- | --- | --- | --- |
| Regional proxy | m6i.2xlarge | 40 | $12 K | $4.5 K |
| Cache nodes (Redis) | cache.r6g.4xlarge | 206 | $340 K | $129 K |
| Write coordinator | m6i.xlarge | 15 | $2.6 K | $1 K |
| Kafka (invalidation bus) | i4i.large | 9 | $5 K | $1.9 K |
| Warming service | m6i.large | 12 | $1 K | $0.4 K |
| DB fallback (read replicas) | db.r6g.4xlarge | 25 | $78 K | $30 K |
| Cross-region egress | — | 2 Gbps avg | $22 K | $22 K |
| Total | — | ~307 nodes | $461 K/mo | $189 K/mo |

#### Cost per million reads (the SLI-F check)

```
monthly reads             = 10M RPS × 86,400 × 30 = 26 trillion reads/month

cost per million reads (on-demand):
  $461,000 / 26,000,000   = $0.0177 per million reads
  ✓ well under $0.05 SLO target

cost per million reads (RI):
  $189,000 / 26,000,000   = $0.0073 per million reads
  ✓ ~7× cheaper than budget
```

VERDICT · $0.007/M reads with RIs. Far under SLO-F target of $0.05.

## 3 · Architecture

### 3.1 — Full architecture diagram

<img src="/diagrams/nalsd-distributed-cache/1.svg" alt="nalsd-distributed-cache diagram 1" class="doc-diagram" />

Fig 1 · Complete global distributed cache. Numbered circles match the step-by-step flow in §3.2. Green arrows = hot read path; dashed red = rare miss path; orange band = the cross-region write coordinator. The architecture lives or dies on keeping the green path short.

### 3.2 — Step-by-step flow (the numbered walkthrough)

Following the numbered blue badges in Fig 1. We trace **two scenarios**: (A) a Feed render reading a Profile (95% of traffic — the hot read path), then (B) an InMail send invalidating a notification counter (the cross-region write path).

Client service issues a read

**Scenario A:** A member opens their LinkedIn home page. Feed ranker needs ~30 Profile blobs (one per post author shown in the feed). It issues 30 gRPC `GET` calls to the regional cache proxy with keys like `profile:user_12345`.  
  
The client SDK **pipelines** these — single TCP connection, 30 requests in flight simultaneously. This is critical: 30 serial RTTs at 500 µs each = 15 ms, well over budget; pipelined = ~1.5 ms total.

cache.MultiGet(\["profile:user\_12345", "profile:user\_67890", ...\]) → pipelined gRPC

budget · **1 ms client → proxy** rate · **10 M reads/s peak** avg keys per call · **~30 (Feed) · 1 (others)**

Regional proxy applies consistent hashing

The proxy is the **traffic director**. For each key, it:  
  
(a) Computes `CRC32(key) mod 2^32` to get a position on the hash ring.  
(b) Looks up the ring (cached in proxy RAM) to find the shard responsible for that ring position.  
(c) Routes the request to one of the shard's nodes (master for writes; least-loaded replica for reads).  
(d) Maintains a long-lived connection pool to each cache node — connection setup is too expensive at 10 M RPS.  
  
**Consistent hashing** is the key trick. When we add or remove a shard, only ~1/N of keys remap — not all of them. Without consistent hashing, a single shard failure would invalidate the entire cache.

shard = ring.lookup(CRC32(key) mod 2^32) · node = shard.pick\_replica(load\_balance) · conn = pool.get(node)

budget · **0.5 ms (in-memory lookup)** fleet · **40 proxy nodes** vnodes per shard · **256 (smooth distribution)**

Hash ring config is the source of truth

The hash ring isn't hardcoded — it's a versioned config in Spanner. When SRE adds a new shard or one fails, the ring is updated: new vnodes added (or removed), and the change is **gossiped** to all proxy nodes within ~3 seconds.  
  
Proxies hold a hot copy of the ring in memory (it's small — a few KB), so lookups are sub-microsecond. Stale ring versions during gossip propagation are handled by a retry: if a proxy routes to shard 7 but shard 7's node says "I'm shard 8 now," the proxy refetches the ring and retries.  
  
**Why Spanner:** the ring change is metadata, not hot data. Strong consistency for the config; ring change once per week vs reads at 10M/s — totally fine.

spanner.read(hash\_ring) · gossip to 40 proxies · proxies cache ring · version-aware retry on mismatch

ring updates · **~1/week (operational)** gossip propagation · **~3 s** ring size · **~30 KB (small)**

Cache shard returns the value (95% of the time)

The selected Redis node receives the GET. Best case (and 95% of the time), the key is in memory. Redis returns the 2 KB value blob in < 500 µs.  
  
Total wall time so far: client → proxy (1 ms) + proxy lookup (0.5 ms) + Redis fetch (0.5 ms) + response back (1 ms) = **~3 ms p99**. Under the 5 ms SLO with 2 ms headroom.  
  
**What makes this fast:**  
• Single network hop (proxy is in same DC)  
• Redis in pure in-memory mode (no AOF fsync on hot path)  
• Long-lived connection pool (no TCP handshake)  
• Connection pipelining (no head-of-line blocking)  
• Local replicas for reads (master-only for writes)

redis.GET("profile:user\_12345") → in-mem hash table lookup → return 2 KB

budget · **1 ms shard fetch** hit rate · **≥ 95% (SLO-D)** value size · **~2 KB avg**

Cache miss → fallback handler + thundering herd protection

**5% of the time**, Redis returns NULL (key not in cache). The proxy can't just return null — the client needs the data. The miss handler:  
  
(a) **Single-flight coalescing** — if 100 requests for `profile:user_99999` all miss simultaneously, only ONE DB read is issued. The other 99 wait for the same future. This is critical: without it, a popular user "going viral" with a cold cache would hammer the DB with 100,000 identical queries.  
  
(b) **Circuit breaker on DB** — if DB latency exceeds threshold, requests fail-fast rather than queuing up. Protects the entire system from a slow DB.  
  
(c) **Bulkhead pattern** — fixed pool of DB connections per service. One bad service can't starve others.

if cache.miss(): future = singleflight.do(key, () => db.read(key)) · circuit\_breaker.guard()

miss rate budget · **≤ 5%** miss latency · **p99 50 ms** coalescing factor · **10-100× on hot keys**

Warming service prevents cold-start misses

Independent of the read path, a background warming service uses ML to predict which keys will be hot soon. Time-of-day patterns (US morning rush at 09:00 PT = pre-warm North American profiles), user-behavior patterns (someone just logged in → likely needs their session, connections, notifications next), seasonal patterns (Sunday evenings get higher Feed reads).  
  
It runs batch jobs **before** traffic spikes, populating caches with predicted hot keys. Target: 80% of "expected hot keys" are already in cache when they're requested.  
  
**Why this matters:** without warming, every cache deploy or shard restart causes a 10-30 minute miss-storm. With warming, recovery is < 2 min.

ml\_model.predict\_hot\_keys(time, user\_patterns) → batch\_get\_from\_db → cache.MSET

warming hit rate · **~80%** runs per day · **continuous, batched** cost · **$1K/mo (small fleet)**

Write coordinator handles cross-region writes

**Scenario B starts here.** A member reads an InMail. The InMail service needs to: (1) decrement the unread counter for that member, (2) make this visible globally within 1 s so the badge disappears on their phone too.  
  
The write coordinator: (a) writes-through to the **primary region cache** for that key (consistent hash determines primary), (b) writes-through to the underlying database, (c) emits an invalidation event to Kafka. Synchronous for local region; async fanout for peers.  
  
**Conflict resolution:** for simple values, last-writer-wins by timestamp. For counters (notification count), use **CRDTs** — each region tracks its own delta; the global value is the sum. No coordination needed; eventually consistent.

primary.SET(key, val) · db.UPDATE() · kafka.produce(invalidation\_topic, {key, ts, origin\_region})

budget · **50 ms primary write** fleet · **15 coordinator nodes** write RPS · **1 M peak**

Invalidation bus (Kafka) propagates across regions

The invalidation event lands in Kafka. **Critically: we send only the key + tombstone, not the value.** A 2 KB value × 1M writes/s × 4 destination regions = 8 GB/s cross-region traffic. A 64 B invalidation × 1M writes/s × 4 regions = 256 MB/s. **30× cheaper, simpler conflict semantics, and we trust regions to re-fetch from their local DB.**  
  
Kafka MirrorMaker2 replicates the invalidation topic to peer regions within ~200 ms. Each region has a subscriber consuming the global invalidation stream.

kafka.invalidations · partitioned by hash(key) · MM2 cross-region · 24h retention · 64B per message

propagation · **~200 ms cross-region** topic size · **64 B per invalidation** brokers · **9 · 3× repl**

Regional subscribers apply DEL to local caches

In each peer region (dub, iad, sin, bom), an invalidation subscriber consumes from Kafka and issues `DEL key` to the local cache shard that owns the key (via consistent hash lookup — same ring as reads).  
  
The next read for that key in that region will MISS, hit the local DB replica, fetch the fresh value, and re-populate the cache. **This is what makes "1 second global write propagation" achievable** — we invalidate (fast, small) and let local reads naturally refresh from local DB (still fast, since DB is also regional).  
  
Total propagation: write at origin → Kafka → MM2 to peer region → subscriber → DEL → next read sees fresh value. Typical p99: **~500-800 ms**, well under 1 s.

subscriber.consume() → ring.lookup(key) → shard.DEL(key) · next GET in this region → MISS → DB

budget · **500 ms invalidation apply** subscribers per region · **3 (HA)** SLO-B · **p99 < 1 s ✓**

Observability watches everything

All five SLIs are monitored continuously: read p99 latency, write propagation p99, availability, hit ratio, data integrity (synthetic test compares cache values to DB ground truth every 30 s).  
  
Crucial dashboards: **hit ratio per key pattern** (catches a service that just added a new uncached query type), **memory utilization per shard** (catches a single user with abnormally large data), **cross-region invalidation lag** (catches Kafka issues that would break SLO-B).  
  
Chaos drills inject failures continuously: kill random shards, partition networks, induce master-replica lag, simulate cold-start storms. The cache is "tested in production every Tuesday."  
  
**Total wall-clock time for the hot read path:** ~3 ms p99. **For the cross-region write path:** ~700 ms p99 from write to global visibility. Both inside SLO.

prometheus scrape every 15s · synthetic GETs every 30s · chaos schedule weekly

read p99 · **~3 ms (SLO 5 ms)** global write p99 · **~700 ms (SLO 1 s)** hit ratio · **96% sustained (SLO 95%)**

The key design insight Notice how the architecture exploits **asymmetric requirements**: reads are 10× more frequent than writes, and the latency budget for reads is 200× tighter than for writes. So we optimize ruthlessly for reads (in-region, in-memory, pipelined) and accept higher complexity on writes (cross-region fanout, conflict resolution, eventual consistency). **The asymmetry IS the design.**

### 3.3 — Consistent hashing close-up

Consistent hashing is what lets us add/remove shards without rehashing the whole world. Here's the ring with 4 shards (in production, 24 per region, 256 vnodes each).

<img src="/diagrams/nalsd-distributed-cache/2.svg" alt="nalsd-distributed-cache diagram 2" class="doc-diagram" />

Fig 2 · Consistent hash ring with 4 shards (simplified). Keys hash to a ring position; walk clockwise to find the owning shard. Adding/removing a shard only remaps 1/N of keys, not all.

### 3.4 — Cross-region write propagation close-up

The trick that makes "global writes in < 1 s" feasible is sending invalidations, not values. Trace a write through the system:

| Step | What happens | Time at this point | Where |
| --- | --- | --- | --- |
| T+0 ms | InMail send completes; client calls cache.SET(notif\_count, 5) | 0 ms | app pod, pdx |
| T+15 ms | Write coordinator writes primary region cache + DB | 15 ms | pdx cache + DB |
| T+20 ms | Coordinator emits invalidation to Kafka (pdx) | 20 ms | pdx Kafka |
| T+220 ms | MirrorMaker2 replicates message to dub, iad, sin, bom | 220 ms | peer regions Kafka |
| T+250 ms | Regional subscribers consume the invalidation | 250 ms | each peer region |
| T+260 ms | Regional subscribers DEL the key in local cache shards | 260 ms | each peer region cache |
| T+~500 ms | Next read in dub for this key MISSES → reads local DB replica → gets new value 5 → repopulates dub cache | ~500 ms | dub (whenever next read happens) |
| T+< 1 s | All regions consistent · SLO-B met | < 1 s ✓ | global |

Why DB replicas don't break this When the dub subscriber DELs the key and the next dub read MISSES, it reads from dub's local DB read replica — NOT cross-region. The DB has its own replication (Spanner global, or per-region Postgres replicas with logical replication). DB replication has its own SLO; we assume it's strong enough to keep up. If a DB region is lagging, that's a DB-tier alarm, not a cache problem.

## 4 · Failure gauntlet

A · Shard master crash SLI: A, C

A Redis master node hard-crashes; 1/24th of keys in that region affected.

triggermaster health check fail > 5 s

absorbRedis Sentinel promotes a replica in 10 s

capproxy circuit-breaks failing shard, fallback to DB

verdict10 s degradation, no data loss

B · Cache-DB stampede SLI: A, F

A code deploy in app tier shifts read pattern; 50% miss rate suddenly.

triggermiss rate > 20% over 1 min

absorbsingle-flight coalescing limits DB load

protectDB circuit breaker fails fast

verdictelevated latency · DB survives

C · Hot key SLI: A

A viral profile gets 100k reads/s — single shard saturates.

triggerper-shard QPS > 200k

absorbproxy detects, replicates to L1 in-proxy cache (1s TTL)

caprequest coalescing at proxy layer

verdicthot key served from proxy RAM

D · Region outage SLI: B, C

us-west-2 power event takes the region offline 45 min.

triggerregion health probe fail

absorbGSLB redirects clients to next-nearest region

degraded+50 ms cross-region latency · acceptable temporary

verdictusers see slight latency bump, no data loss

E · Invalidation lag SLI: B, E

MirrorMaker2 stuck; invalidations not reaching peer regions.

triggerMM2 lag > 30 s

absorbshorter TTL on critical keys (5min instead of 1h)

degradedSLO-B (1s prop) breached but data converges in 5 min

verdictpage SRE; manual MM2 restart

F · Concurrent writes (conflict) SLI: E

User decrements notification count in pdx; concurrently iad processes another read mark.

triggertwo writes within network propagation delay

absorb (simple)last-writer-wins by ts (acceptable for counters)

absorb (counters)CRDT: per-region delta · global sum

verdicteventual consistency · no permanent skew

Cannot defend against Loss of underlying DB (the fallback source). If cache miss happens AND DB is also down, requests fail. Mitigation: DB has its own multi-region replication + 4-nines SLO. If both cache and DB are down for the same key, that's a tier-0 incident requiring manual intervention. Out of scope here.

## 5 · Operational playbook

### 5.1 — Deployment

| Stage | % traffic | Soak | Auto-promote |
| --- | --- | --- | --- |
| Shadow | mirror, 0% serve | 24 h | diff vs prod < 0.01% |
| Canary | 1%, 1 region | 24 h | p99 latency Δ < 5% |
| Regional | 10% (1 region) | 12 h | SLO burn < 1× |
| Half | 50% | 6 h | auto if no SEV-2+ |
| Global | 100% | — | manual sign-off |

### 5.2 — Chaos drills (quarterly)

-   **Random shard kill** — terminate 1 random shard per region; verify failover < 15 s.
-   **Network partition** — partition a region from peers; verify reads continue, writes queue.
-   **Master-replica lag injection** — add 1s replication lag; verify replica reads stay correct.
-   **Cold-start storm** — flush an entire region's cache; verify warming + miss handler hold up.
-   **Hot-key injection** — synthesize 500k QPS to one key; verify in-proxy L1 caching kicks in.
-   **DB outage** — kill DB read replicas in a region; verify circuit breaker + degraded mode.

### 5.3 — Runbook excerpt

```
# Symptom: read p99 > 5 ms (SLI-A burning)

# Likely causes (ranked)
1. Shard saturation              → check per-shard QPS dashboard
2. Hot key                       → check hot-key detector output
3. Network latency               → check intra-region p99 ping
4. GC pause in Redis             → check shard memory utilization
5. Proxy connection pool         → check pool exhaustion metric

# First response (in order):
- Confirm: dashboard 'cache-slo-a' shows > 5 ms p99 over 1 min
- Identify hot shard: per-shard QPS sorted desc
- If shard QPS > 200k: enable proxy L1 cache for affected key pattern
- If memory > 90%: trigger eviction policy review
- Communicate: post in #incident-cache
- Escalate: if not resolving in 15 min, page tier-2 oncall
```

## 6 · Component reference

| Component | Tech | Scale | Failure mitigation | SLO |
| --- | --- | --- | --- | --- |
| **Regional proxy** | Envoy + Go | HPA 40→120 | circuit breaker · connection pool | A,C |
| **Cache nodes** | Redis Cluster | 24 shards × 3 nodes | Sentinel failover · 2 replicas/shard | A,C,D |
| **Hash ring config** | Spanner | 2 nodes region-replicated | gossip propagation | C |
| **Cache miss handler** | Go service | colocated with proxy | single-flight + circuit breaker | A,D |
| **DB fallback** | Postgres read replicas | 25 replicas | connection pool · bulkhead | — |
| **Warming service** | Go + ML pipeline | 12 nodes | best-effort · alerts on low hit rate | D |
| **Write coordinator** | Go service | 15 nodes stateless | retry · conflict resolution | B,E |
| **Invalidation bus** | Kafka + MM2 | 9 brokers | 3× repl · cross-region async | B |
| **Regional subscriber** | Go service | 3 per region | consumer group failover | B |
| **Observability** | Prometheus + synthetic | region-local | synthetic tests every 30 s | all |

## 7 · Trade-offs & open questions

#### Chose

-   **Invalidation propagation** (not value replication) · 30× cheaper cross-region traffic; trade: brief miss after invalidation in peer regions.
-   **Eventually consistent across regions** · enables 1 s SLO globally; trade: brief stale reads on conflicting writes.
-   **Consistent hashing with 256 vnodes** · smooth distribution; trade: 256× more ring metadata to gossip.
-   **Single-flight on cache miss** · prevents stampedes; trade: 99 of 100 simultaneous misses wait for one DB read (acceptable).
-   **2× replicas per shard** · tolerates one node loss with no service interruption; trade: 3× memory cost.
-   **Multi-master with last-writer-wins** · simpler than consensus; trade: not safe for monetary values (use Spanner for those).
-   **In-proxy L1 cache for hot keys** · saves the underlying shard; trade: 1s TTL means slightly stale data on hot keys (acceptable for profiles).

#### Rejected

-   **Synchronous cross-region writes** · would add 100+ ms to every write — kills write path SLO.
-   **Full value replication** · 30× cross-region traffic cost · breaks SLO-F.
-   **Strongly consistent (Spanner-style)** for everything · slow and expensive; only use for monetary/auth data.
-   **Memcached over Redis** · simpler but no replication, no cluster mode; doesn't meet C SLO alone.
-   **Client-side hashing** · would couple clients to ring changes — operational nightmare.
-   **One big region (us-east) for all writes** · simpler but SLO-B (1 s global) impossible for users in Asia.

### Open questions

1.  Should we support **per-key consistency levels**? Profile cache can be eventually consistent; session tokens must be strongly consistent (or invalidated atomically with the DB).
2.  Is 256 vnodes the right number? Too few → uneven distribution; too many → ring becomes large. Need to measure.
3.  Should we offer **tiered TTLs** per key class? Hot profiles: 1 h. Cold profiles: 24 h. Sessions: 15 min. Currently uniform.
4.  Is the warming service actually paying for itself? Measure: if we turned it off, would miss rate stay under 5%? If yes, simplify by removing it.
5.  Should we move to **Memcached-compatible protocol** for some workloads? Cheaper, simpler, but less feature-rich.
