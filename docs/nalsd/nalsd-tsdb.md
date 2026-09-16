---
title: "Time Series Database"
slug: /nalsd/nalsd-tsdb
sidebar_position: 5
sidebar_label: "Time Series Database"
description: "Time Series Database"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/nalsd-tsdb/sequence.svg" alt="How it works — nalsd-tsdb" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
in

in/tsdb

v2026.05 · nalsd

in/tsdb/ design-docs/ 2026/ time-series-database.md

A NALSD walkthrough — the storage and query engine under the monitoring platform. 10M samples/sec/region, ~1.3 bytes/sample after Gorilla compression, PromQL-flavored queries, p99 recent reads < 500 ms, multi-year retention via deterministic downsampling.

NALSD recent p99 < 500ms 100M samples/s global ≥ 10× compression draft · review last edit · 2026-05-12 · sjc

## 1 · Problem statement & SLO contract

A time series database is **not** a generic key-value store with timestamps. Its workload has structural regularity that unlocks 10× engineering leverage: timestamps are monotonic per series (delta-of-delta encoding), values are autocorrelated (XOR encoding with leading/trailing zero suppression), access is overwhelmingly time-range scans (time-partitioned shards with min/max pruning), and the log is append-only with bounded out-of-order corrections (LSM-style compaction). Get encoding wrong → 10× cost overrun. Get cardinality wrong → existential failure (index explosion, planner can't prune, hot shards). This doc designs the TSDB beneath LinkedIn's monitoring platform — the system that turns 138 TB/day of raw samples into ~11 TB/day of compressed, queryable, multi-tenant time-series data.

Samples/sec global

100 M

10 M/region peak

Active series

10 M

per region · 100M cumulative

Recent query p99

< 500 ms

last 6h windows

Compression

≥ 10×

vs naïve 16B/sample

### SLO contract — nine SLIs

| SLI | Target | What it protects |
| --- | --- | --- |
| **A · Ingest latency** | p99 ≤ 5 s | write → durable ACK (WAL fsync + M-of-N quorum) |
| **B · Recent query** | p99 ≤ 500 ms | queries over last 6h on RAM/SSD tiers |
| **C · Mid-range query** | p99 ≤ 5 s | days–weeks · warm SSD/object |
| **D · Cold query** | p99 ≤ 30 s | months+ · downsampled tiers |
| **E · Durability** | 11 nines | WAL + quorum + object replication |
| **F · Availability** | ≥ 99.95% | ingest + query API uptime |
| **G · Compression efficiency** | ≥ 10× | finance lever — recurring storage + egress $ |
| **H · Cardinality governance** | per-tenant quotas | EXISTENTIAL — without it the index dominates RAM |
| **I · Query fairness** | no persistent noisy neighbor | alert > dashboard > batch priority |

The two life-or-death SLOs **G (compression)** is the CFO question — each byte is recurring cost at PB scale. **H (cardinality)** is existential — it determines whether your architecture stays a TSDB or collapses into a distributed grep. **B vs D** exposes whether you understand tiering: mixing cold expectations into a hot SLO is how candidates doom the design.

#### The defining property — structural regularity

| Property | Engineering leverage | What goes wrong without it |
| --- | --- | --- |
| Monotonic time (per series) | delta-of-delta, ~1 bit/ts after warmup | generic varint, 4-8 B/ts |
| Autocorrelated values | XOR vs previous, 5-10× compression | raw 8 B doubles forever |
| Range-heavy reads | time partitioning, min/max pruning | full scans every query |
| Append-only + tiered | LSM-style compaction · cheap cold | random rewrites · uniform tier cost |

## 2 · Capacity model (the NALSD math)

### 2.1 — Ingest rate

#### Samples and bytes at peak

```
peak samples/sec/region    = 10,000,000
global peak (5 regions)    = 100,000,000 samples/sec
with 3× burst headroom     = 30,000,000/region (capacity plan)

naïve sample size (raw):
  timestamp (8 B) + value (8 B) = 16 B
  → 100M × 16 B/s = 1.6 GB/s = 12.8 Gbps global
  → 100M × 16 B × 86,400 s = 138 TB/day RAW

per-region bytes (us-west-2, 35% share):
  10M × 16 B = 160 MB/s raw
  ≈ 1.3 Gbps in
```

VERDICT · 138 TB/day naïve. Unsustainable. Compression is the entire margin story.

### 2.2 — Compression (Gorilla-style)

#### What encoding actually buys us

```
timestamp encoding — delta-of-delta:
  ts1 stored raw  (8 B)
  ts2 = ts1 + Δt   (varint Δt, ~2 B)
  ts3+ = Δ(Δt)     (often 0 → 1 bit "same Δ as before")
  → typical ~1 bit/sample after chunk warmup
  → ~10× reduction on time

value encoding — XOR vs previous:
  v_n XOR v_{n-1} → many leading/trailing zeros on smooth metrics
  store leading-zero count + meaningful bits + trailing-zero count
  counters → ~5× compression
  smooth gauges → ~8-10× compression
  noisy values (e.g., random load) → ~3× worst case
  → typical 5-10× reduction on value

chunk amortization:
  120 samples per chunk (~20 min @ 10s scrape)
  one shared header → headers amortized to near zero
  vectorized decode (SIMD-friendly) on read path

net effective:
  ~1.3 bytes/sample post-compression on real prod data
  100M samples/s × 1.3 B = 130 MB/s = ~1 Gbps
  100M × 1.3 B × 86,400 s = 11 TB/day compressed
  138 TB / 11 TB = 12.6× compression

monthly hot footprint: 11 TB × 30 = 330 TB compressed hot
yearly compressed (with downsampling): ~67 TB long-tail
total multi-tier footprint: ~600 TB vs ~6 PB if naïve
```

VERDICT · 138 TB/day → 11 TB/day. The difference between funded and fantasy.

### 2.3 — Cardinality math (the existential one)

#### What "cardinality" means and why it kills systems

```
a "series" = unique combination of (metric_name + label_values)
  e.g., http_requests_total{service="feed",region="iad",status="200"}
       http_requests_total{service="feed",region="iad",status="500"}
       http_requests_total{service="feed",region="pdx",status="200"}
       → 3 different series, even though same metric

active series per region:
  10M unique series steady-state
  100M cumulative across retention window (churn from deploys, ephemeral pods)

inverted index sizing:
  posting list = label_kv → bitmap of series IDs containing it
  avg posting size at our cardinality = ~3 KB
  postings per region = ~5 billion entries (every label_value:value pair)
  → ~15 TB hot inverted index per region

what kills you: adding user_id as a label
  500M users × 50 metrics × 8 dims = 200 BILLION series
  → index alone would be 600 TB just for posting lists
  → matchers degrade from "intersect bitmaps" to "scan everything"
  → query latency goes from 200 ms to never-completes

defenses (the cardinality governance stack):
  1. per-tenant HLL counter at ingest (rolling 1h estimate)
  2. hard quota: max active series per tenant
  3. label allowlist for known-safe labels (region, service, status, version)
  4. label denylist for known-poison (user_id, session_id, request_id)
  5. circuit breaker: STOP THE WORLD on tenant explode → reject 100%
  6. recording rules: aggregate-away high-cardinality dims at ingest
```

VERDICT · Cardinality governance is a tier-0 SLO. Without it, the architecture collapses in days.

### 2.4 — Tier sizing (the 95/5 story)

#### Storage media match access pattern

```
query distribution (measured):
  95% of queries hit data < 6h old      → RAM / hot SSD
   4% queries hit days-to-weeks         → warm object
   1% queries hit months-to-years       → cold downsampled

per-region tier sizing (us-west-2 share):
  HOT TIER (RAM in ingester heads, 2h):
    10M series × 720 samples (2h@10s) × 1.3 B = 9 GB heap per ingester
    × replication factor 3 × 8 ingesters/ring = 216 GB hot RAM total
  
  WARM TIER (NVMe SSD, 1-7 days raw):
    160 MB/s × 86,400 × 7 = 96 TB raw
    × 1.3 / 16 compression = 7.8 TB on disk
    + 3× replication = 23 TB SSD across cluster
  
  COLD #1 (Object · S3, full-res 7-30d):
    160 MB/s × 86,400 × 23 = 318 TB raw
    × compression = 26 TB
    + replication done by object store (11 nines built-in)
  
  COLD #2 (1-min rollups, 30d-6mo):
    raw → 1min downsample = 6× reduction in time resolution
    26 TB / 6 × 5 (months) = 22 TB
  
  COLD #3 (5-min, 6mo-1yr):
    22 TB / 5 × 6 = 26 TB additional
  
  COLD #4 (1-hour, 1yr-3yr+):
    cumulative ~70 TB long tail
    legal/compliance hold
```

VERDICT · Tier 0 (RAM) is tiny. Tier 1 (SSD) is the working set. Tiers 2-4 are where multi-year retention becomes affordable.

### 2.5 — Fleet summary & cost

| Tier | Instance | Count | $/mo (on-demand) | $/mo (3y RI) |
| --- | --- | --- | --- | --- |
| Distributor (stateless) | m6i.2xlarge | 30 | $8.8 K | $3.3 K |
| Ingester (stateful, ring) | r6i.4xlarge (128 GB RAM, NVMe) | 40 (8/region) | $96 K | $36 K |
| Inverted index nodes | r6i.2xlarge | 30 | $24 K | $9 K |
| Hot SSD storage | i4i.4xlarge (NVMe) | 25 | $30 K | $11 K |
| Compactor (batch) | c6i.4xlarge | 20 | $12 K | $4.5 K |
| Downsampler | c6i.2xlarge | 15 | $4.5 K | $1.7 K |
| Query gateway | m6i.2xlarge | 20 | $5.8 K | $2.2 K |
| Querier pool (stateless) | m6i.4xlarge | 60 | $35 K | $13 K |
| Warm + cold object storage | S3 Standard + IA + Glacier | ~120 TB total | $3.5 K | $3.5 K |
| Result cache (Redis) | cache.r6g.xlarge | 9 | $3 K | $1.1 K |
| Total | — | ~250 nodes | $222 K/mo | $85 K/mo |

Cost composition Ingesters (RAM-heavy, with NVMe) are **42% of cost**. SSD storage tier is **13%**. Object storage is shockingly cheap — only **4%** despite holding most of the data. *Compression is what makes this pencil out*: 12.6× reduction at the source flows through to every downstream tier.

## 3 · Architecture

### 3.1 — Full architecture diagram

<img src="/diagrams/nalsd-tsdb/1.svg" alt="nalsd-tsdb diagram 1" class="doc-diagram" />

Fig 1 · TSDB architecture. Numbered circles map to the step-by-step flow in §3.2. Stateful ingest plane (top) writes through distributor → ingester ring → tiered storage. Stateless query plane (bottom) reads via gateway → planner → querier pool spanning all tiers.

### 3.2 — Step-by-step flow (the numbered walkthrough)

Following the numbered blue badges in Fig 1. We trace **two scenarios**: **(A)** a write — Feed ranker's `http_requests_total{service="feed",status="200"}` gets scraped and stored (steps 1-8), then **(B)** a read — a Grafana dashboard panel showing 1h of Feed error rate (steps 9-11).

Producer ships a batch of samples

The Feed service's Prometheus client scrapes its metrics endpoint every 10 seconds. A batch of ~500 samples (one per active series on this pod for this scrape) is gzipped and sent to the regional TSDB via `POST /api/v1/write` with mTLS auth. Producer is fire-and-forget after retries — it doesn't block on durability ACK.  
  
Batch size matters: 500 samples per RPC = 60k RPCs/sec instead of 30M individual RPCs/sec. **Batching is what makes the network tractable.**

POST /api/v1/write · Content-Encoding: snappy · body: TimeSeries\[\] proto · ~500 samples/batch

scrape interval · **10 s default** batch size · **500 samples avg** batches/sec · **~60 k/region**

Distributor: auth, cardinality check, hash, fan-out

The stateless distributor is the front door. Five jobs in order:  
  
(a) **mTLS auth** → identify tenant  
(b) **HLL cardinality check** — the tenant has a rolling HyperLogLog estimate of unique series in the last hour. If they're at 95% of their quota, slow down. If 100%, reject with HTTP 429. **This is the circuit breaker that prevents existential failure.**  
(c) **Schema validation** — well-formed proto, allowed label names  
(d) **Consistent hash** on `(tenant, series_id)` → identifies the 3 ingester replicas responsible (replication factor N=3)  
(e) **Parallel fan-out** to all 3 replicas; wait for M=2 quorum before returning ACK  
  
For our Feed sample at series\_id = hash("feed.requests.200"), distributor hashes to ingesters {A, D, F} → fans out → waits for 2 of 3 to confirm WAL write.

consistent\_hash(tenant + series\_id) % ring\_size → \[A, D, F\] · ParallelInvoke · ACK on M-of-N (2/3)

budget · **5 ms p99** replication · **N=3, ACK on M=2** fleet · **30 distributors (stateless)**

Ingester ring — WAL write + head chunk update

Each of the 3 chosen ingesters does the same thing in parallel:  
  
(a) **Append to WAL** on local NVMe → fsync. This is the durability commit point — once fsync returns, the sample survives a crash.  
(b) **Update the in-memory "head" chunk** for that series. The head holds the last ~2 hours of samples. Each new sample is delta-encoded against the previous one.  
(c) When a head chunk reaches 120 samples (~20 min @ 10s scrape) it's **sealed** into a Gorilla-compressed immutable chunk and a new head starts.  
(d) Acknowledge back to distributor.  
  
Critical detail: the ingester is **stateful**. It has a 2-hour working set in RAM (~9 GB heap for 10M series) plus a WAL on local NVMe. Restarts replay the WAL to reconstruct head state. This is what makes ingest fast AND durable — RAM speed for current chunk, NVMe speed for durability commit.

wal.append(sample) · fsync · head\[series\_id\].push(sample) · if len(head)==120: chunk = gorilla.compress(head)

budget · **2 s p99 (includes fsync)** head retention · **2 hours in RAM** chunk size · **120 samples**

Inverted index update (label → series posting)

In parallel with the data write, the ingester updates the inverted index. The index maps `label_name:value` → posting (a Roaring bitmap of series\_ids containing that label).  
  
For our Feed sample, the index already has:  
• `service:feed` → bitmap with series\_id set  
• `status:200` → bitmap with series\_id set  
• `region:iad` → bitmap with series\_id set  
  
If this is a new series (first time seen), the series\_id bit gets added to each posting. Roaring bitmaps compress well (typically 1-10 KB per posting, even for popular labels with millions of series).  
  
The inverted index runs as a separate fleet (30 nodes, 15 TB hot per region) so its memory pressure doesn't compete with ingester RAM. Updates are batched and asynchronously flushed.

for label, value in sample.labels: index\[label:value\].bitmap\_set(series\_id) · roaring bitmap encoding

budget · **50 ms async** index size · **15 TB/region hot** posting compression · **Roaring bitmaps**

Compactor merges sealed chunks → warm tier

Every ~2 hours, the compactor runs in the background. For each ingester, it:  
  
(a) Reads sealed chunks from local NVMe  
(b) **Merges** chunks from the 3 replicas of each series — they should be identical, but compactor handles any out-of-order corrections  
(c) **Deduplicates** — replicas can have minor timestamp/value differences from network jitter; uses M-of-N agreement to pick canonical values  
(d) **Re-encodes** with optimal chunk sizing (block-level instead of per-replica)  
(e) **Publishes** immutable blocks to warm object storage (S3)  
(f) After publish + verify, deletes the source from ingester NVMe  
  
This is the most CPU-heavy job in the system — it re-encodes large amounts of data. But it's an *offline batch* path: pausing it for 30 minutes just causes hot SSD to fill up; it doesn't break the live path.

compactor.merge(replicas) · dedup\_by\_quorum(ts, val) · gorilla.reencode(block) · s3.put(block\_id) · checkpoint(manifest)

cadence · **~every 2 h** fleet · **20 nodes batch** output · **immutable blocks in object store**

Downsampler creates cold-tier rollups

As data ages past 30 days, the downsampler runs deterministic rollups. For each series, it reads the full-resolution warm data and computes pre-aggregated rollups for coarser time resolutions:  
  
• **1-min rollups** (30d-6mo): rate, avg, min, max, count, sum, p50, p99  
• **5-min rollups** (6mo-1yr): same set  
• **1-hour rollups** (1yr+): same set, with reduced precision  
  
Each hop reduces storage by ~6× (60s/10s = 6× compression in time resolution). Crucially, these rollups are **deterministic** — re-running the downsampler on the same input produces bit-identical output. This makes the pipeline replayable: if we find a downsample bug 6 months later, we can re-run and trust the output.  
  
For histogram metrics, the downsampler preserves bucket counts (not raw observations) so `histogram_quantile()` still works at coarser resolutions.

downsample(block, 60s) → {rate, avg, min, max, count, sum, p50, p99} per minute · idempotent · checkpoint-replayable

fleet · **15 nodes** size reduction · **~6× per hop** runs · **continuously, throttled**

Storage tiers in place — write path complete

After steps 1-6, our Feed sample exists in multiple places simultaneously:  
  
• **3 ingester WALs** (durable, will be replayed on crash)  
• **3 ingester head chunks** in RAM (hot read source for the next 2 hours)  
• **Inverted index** (so queries can find the series by label)  
• Eventually: **warm object store block** after compaction (~2 h later)  
• Eventually: **cold downsampled rollup** after 30+ days  
  
The data is now queryable through any tier. The **planner** chooses which tier based on the query's time range and resolution requirements. **This is where SLO B/C/D divergence comes from** — recent queries hit RAM (500 ms), mid-range hit SSD/warm object (5 s), cold queries hit downsampled tiers (30 s).

data location matrix:  
0-2h: ingester RAM (head chunks)  
2h-7d: hot SSD (sealed chunks)  
7d-30d: warm S3 (immutable blocks, full resolution)  
30d+: cold S3 (1min/5min/1hr downsamples)

tiers · **5 (RAM · SSD · warm · 3 cold)** durability · **11 nines (object) + WAL quorum** replication · **3× ingester · object internal**

SCENARIO B: query arrives at gateway

A user opens Grafana to view Feed error rate. The dashboard panel issues a PromQL query:  
  
`rate(http_requests_total{service="feed",status=~"5.."}[5m])`  
  
The query gateway is the front door for reads. It does:  
  
(a) **Auth + tenant resolution**  
(b) **Rate limit check** — this tenant's QPS budget  
(c) **Query class assignment** — dashboard = priority 2 (alert eval = 1, batch = 3)  
(d) **Result cache lookup** (Redis, 30s TTL) — most dashboards refresh on the same query, 30-50% hit rate  
(e) On cache miss, forward to planner  
  
For our Feed query: it's an interactive dashboard query over the last 5 minutes — class 2 priority, definitely uncached on first load.

cache.get(query\_hash) → miss → planner.plan(ast, tenant\_class, deadline) · 60s server timeout

budget · **10 ms gateway** fleet · **20 gateway nodes** cache hit rate · **~40%**

Planner: AST analysis, tier selection, pushdown

The planner is where the query gets *smart*. Five jobs:  
  
(a) **Parse PromQL → AST** — break down the query into label matchers, range vectors, functions  
(b) **Time range analysis** — the query asks for "now − 5min". Tier = RAM head chunks. **Recent query → cheap path.**  
(c) **Label matcher pushdown** — `service="feed"` is an equality match, `status=~"5.."` is a regex. Both go to the inverted index FIRST to find candidate series IDs, BEFORE touching any sample data.  
(d) **Cardinality estimation** — estimate "how many series match these labels?" If the estimate is huge (e.g., a regex matches a million series), reject with a helpful error message: "your query would touch 1.2M series; please add more label filters."  
(e) **Plan generation** — output a parallel execution plan that fans out to the right ingesters/storage nodes  
  
For our Feed query: planner uses index to find ~50 matching series (Feed pods × status codes), tier = ingester RAM, plan = parallel fetch from 8 ingesters.

ast = promql.parse(query) · series\_ids = index.match(labels) · tier = select\_tier(time\_range) · plan = generate(series\_ids, tier, parallelism)

budget · **50 ms p99** cardinality limit · **50k series/query** parallelism · **per-tenant quota**

Querier pool: streaming evaluation across tiers

The querier pool is stateless — pick any node, give it a plan, it executes. For our Feed query, queriers do:  
  
(a) **Fetch chunks** from the right tier (here: ingester RAM for recent data, possibly warm S3 if range crosses boundary)  
(b) **Decompress** Gorilla chunks (SIMD-vectorized)  
(c) **Streaming evaluation** — apply rate() function, aggregate over 5-min window. Result is one number per series.  
(d) **Bounded RAM** — queriers limit memory per query; oversize queries get killed with a clear error  
(e) **Partial results** — if 1 of 8 ingesters times out, return `partial: true` with the data from the other 7. Dashboards can fail-open; alert eval fails-closed.  
  
Result returns through gateway → cached → Grafana renders.  
  
**Total wall-clock time:** ~200 ms p99 for our 5-minute Feed query. Well under the 500 ms SLO-B. For a 6-hour query, ~400 ms. For 30-day query (warm tier), ~3 s — under SLO-C.

parallel\_for ingester in plan: chunks = fetch(ingester, series\_ids) · for chunk: decompress() · rate(window) · aggregate

recent (RAM) p99 · **~200 ms ✓ SLO-B 500ms** mid (SSD/warm) p99 · **~3 s ✓ SLO-C 5s** cold p99 · **~15 s ✓ SLO-D 30s**

Results delivered to consumers

The result is delivered to one of three consumer classes:  
  
**Dashboards (Grafana):** visualizes time series as line/area/heatmap charts. May refresh every 30 s. Cache hits here are very common — same query, same time window, different users.  
  
**Alert ruler:** evaluates PromQL expressions on a fixed schedule (typically 15 s or 1 min). Outputs go to the alert engine (separate system). High QPS but predictable shape — ~100k queries/sec steady-state. Cached aggressively because the same recording rules run repeatedly.  
  
**Capacity planning / BI:** batch jobs running cold-tier queries over months or years. Priority 3 — gets deprioritized during alert storms or dashboard hot moments.  
  
Per-tenant cost attribution (cardinality + scanned bytes + CPU seconds) is computed and surfaced to tenants on a billing dashboard — closes the feedback loop and creates incentives for clean label hygiene.

consumer classes: alert\_eval (P1) · dashboard (P2) · batch (P3) · per-query attribution: tenant + scanned\_bytes + cpu\_sec

consumers · **3 priority classes** alert eval QPS · **~100k steady-state** cost attribution · **per-tenant billing**

The key design insight Notice the system's bones: **stateful ingest + stateless query**. Ingest owns ordering, WAL durability, head chunks — restarts are slow and careful. Query is pure compute on immutable storage — can scale up and down at will. This split is the bedrock pattern for high-throughput durable systems. Get this right and everything else (compression, tiering, cardinality) follows naturally. Get it wrong and you're fighting your architecture forever.

### 3.3 — Gorilla-style chunk encoding

The 10× compression isn't magic — it's *exploiting structural regularity*. Two encodings working in parallel:

Timestamp: delta-of-delta ~1 bit/sample

Store first timestamp raw (8 B). Store second as Δt (varint, ~2 B). Store third+ as Δ(Δt) — the change in delta. Since scrape intervals are regular (10 s, 10 s, 10 s...), the second derivative is usually 0, encoded as 1 bit "same as before."  
  
Even with occasional jitter (10.1 s, 9.9 s, 10.0 s), the ΔΔ values are tiny and pack into a few bits.

exploitsmonotonic time, regular scrapes

compression~10× vs 8 B raw

Value: XOR vs previous 5-10× compression

For a 64-bit float, XOR the current value with the previous one. For autocorrelated data (which most metrics are), the XOR result has many leading and trailing zero bits.  
  
Store: leading zero count + meaningful middle bits + trailing zero count. A slowly-rising counter (request count) XORs to mostly-zeros with just a few changed bits — packed into ~1 byte instead of 8.

exploitsautocorrelated values, smooth metrics

compression5-10× vs 8 B raw

Chunk boundaries reset the bases Each chunk (120 samples ≈ 20 min @ 10 s scrape) starts fresh — timestamps reset, XOR base resets. This is critical: it means corrupted chunks don't cascade, and we can decompress any chunk independently (parallel reads, point-in-time queries). The overhead per chunk header is tiny relative to 120 samples of data, so amortizes to near zero.

### 3.4 — Storage tier strategy (the 95/5 story)

The biggest cost optimization is matching storage medium to access frequency. 95% of queries hit data < 6h old; we put that data in RAM and SSD. The other 5% hit older data; we put that in object storage.

RAM  
2h

Hot SSD  
1-7d

Warm S3 full-res  
7-30d

Cold 1min  
30d-6mo

Cold 5min  
6mo-1yr

Cold 1hr  
1yr+

| Tier | Medium | Window | Resolution | $/GB-mo | Access p99 |
| --- | --- | --- | --- | --- | --- |
| 0 · Head | RAM | 0-2h | 10 s raw | $50 | < 5 ms |
| 1 · Hot | NVMe SSD | 1-7d | 10 s raw | $0.13 | < 20 ms |
| 2 · Warm | Object (S3) | 7-30d | 10 s raw | $0.023 | ~300 ms |
| 3 · Cold 1min | Object | 30d-6mo | 1 min | $0.023 | ~1 s |
| 4 · Cold 5min | Object (IA) | 6mo-1yr | 5 min | $0.013 | ~3 s |
| 5 · Cold 1hr | Object (Glacier) | 1yr+ | 1 hour | $0.004 | ~30 s |

Tier ratio: 12,500× from RAM to Glacier RAM at $50/GB-mo · Glacier at $0.004/GB-mo · ratio 12,500×. **Every byte placed in the right tier saves ~10⁴ on storage cost.** The planner's job is to know which tier can answer each query, and the downsampler's job is to make sure coarser tiers exist by the time queries ask for them.

## 4 · Failure gauntlet

A · Single ingester crash SLI: A, E

An ingester pod dies; 1/Nth of writes affected for that ring slot.

triggerhealth probe fail > 5 s

absorbdistributor still gets M=2 from other 2 replicas

recovernew ingester replays WAL from peer · ~10 min

verdictno data loss · brief elevated p99

B · Cardinality bomb SLI: H

A tenant deploys a new service that adds `request_id` as a label.

triggerHLL estimate > 95% of tenant quota

absorbdistributor returns 429 to offending tenant

capcircuit breaker stops ingest entirely if > 110% quota

verdicttenant pages own oncall · cluster stable

C · Monstrous ad-hoc query SLI: B, I

Someone runs `{__name__=~".+"}[30d]` — touch every series for 30 days.

triggerplanner cardinality estimate > 1M series

absorbplanner rejects with "query touches 1.2M series, please filter"

protectper-tenant CPU/RAM quotas prevent collateral damage

verdictother tenants unaffected (SLO-I)

D · Compactor falls behind SLI: A, B

A bug in compactor causes it to process 5× slower than data arrival rate.

triggercompaction lag > 6 h

absorbhot SSD fills · alert at 70%

backpressuredistributor slows accept rate · alerting on backpressure

verdictelevated latency · no data loss · catch-up over hours

E · Object storage outage SLI: C, D, F

S3 in the region has degraded availability for 2 hours.

triggerS3 error rate > 1%

absorbrecent queries (RAM/SSD) unaffected — most traffic

degradedcold queries return partial: true with block errors

verdictrecent dashboards unaffected; cold scans warned

F · WAL corruption SLI: E

Bad NVMe; a chunk of WAL becomes unreadable.

triggerchunk checksum mismatch on replay

absorbrecover from peer ingester (we have 2 other replicas)

repairreplace NVMe · re-sync from peer

verdict0 data loss because of M-of-N

Not defended against Simultaneous loss of all 3 replicas for the same ring slot (data center fire affecting one ring partition). Mitigation: cross-AZ replica placement, regular WAL backups to cross-region object storage. The math: with 3 replicas in 3 AZs, simultaneous failure probability is roughly (annual AZ failure rate)³ ≈ 10⁻⁹.

## 5 · Operational playbook

### 5.1 — Deployment

| Tier | Strategy | Soak | Care needed |
| --- | --- | --- | --- |
| Distributors | rolling, surge=2 | 30 min | stateless · easy |
| Ingesters | drain + handoff, 1 at a time | 30 min/node | stateful · slow · WAL replay budget |
| Compactor / Downsampler | pause → upgrade → resume | 15 min | checkpointed · safe to pause |
| Queriers / Gateway | rolling, surge=4 | 15 min | stateless · trivial |
| Storage format migration | shadow write, dual read, cutover | multi-month | backwards-compatible · slow |

### 5.2 — Chaos drills (quarterly)

-   **Kill 1 ingester** — verify M-of-N quorum survives; WAL replay completes within budget.
-   **Kill 2 ingesters simultaneously** — verify M-of-N degrades correctly (ACK fails closed); alerts fire on replication lag.
-   **Cardinality bomb injection** — synthesize a tenant exceeding quota; verify HLL breaker trips; tenant throttled cleanly.
-   **Monstrous query injection** — run absurd PromQL; verify planner rejects with helpful error; other tenants unaffected.
-   **Compactor pause for 4 h** — verify hot SSD fills gracefully; alerts at 70/80/90%; catch-up doesn't dupe data.
-   **Object storage throttle** — inject 1s latency on S3; verify recent queries unaffected; cold queries degrade gracefully.
-   **WAL corruption** — corrupt a WAL file on one ingester; verify peer recovery in < 30 min.
-   **Producer time skew** — push samples with timestamps 2h in past; verify OOO window handles or rejects cleanly.

### 5.3 — Runbook excerpt

```
# Symptom: SLO-B burning — recent query p99 > 500 ms

# Likely causes (ranked)
1. Ingester head chunk pressure   → check head_chunk_age + RAM utilization
2. Cardinality explosion          → check per-tenant HLL count
3. Querier pool saturation        → check querier CPU + queue depth
4. Inverted index slow            → check index node p99 lookup latency

# First response (in order):
- Confirm: dashboard 'tsdb-slo-b' shows > 500 ms p99
- Identify hot tenant: scanned_bytes_by_tenant sorted desc
- If single tenant: enforce rate limit + notify their oncall
- If across-the-board: scale querier pool 2x
- If ingester pressure: check for failed compactor → restart if needed
- Communicate: post in #incident-tsdb with hypothesis
- Escalate: if not resolving in 15 min, page tier-2 oncall
```

## 6 · Component reference

| Component | Tech | Scale strategy | Failure mitigation | SLO |
| --- | --- | --- | --- | --- |
| **Distributor** | Go service | HPA 30→90 stateless | circuit breaker · HLL | A,F,H |
| **Ingester ring** | Go + WAL + RAM heads | consistent hash · N=3 repl | quorum M=2 · WAL replay | A,E |
| **Inverted index** | Roaring bitmaps | 30 nodes sharded by tenant | 2× replica per shard | B,C,H |
| **Hot SSD** | NVMe local | 25 nodes per region | 3× replica · checksums | B,C |
| **Warm + cold object** | S3 / S3-IA / Glacier | auto-scale | 11 nines durability built-in | D,E |
| **Compactor** | Go batch service | 20 nodes | idempotent · checkpoint replay | E |
| **Downsampler** | Go batch service | 15 nodes | deterministic · re-runnable | D |
| **Query gateway** | Envoy + Go | 20 nodes stateless | cache · rate limit · timeout | F,I |
| **Query planner** | Go service | colocated w/ gateway | cardinality estimation · fail-fast | B,C,D,H,I |
| **Querier pool** | Go service · stateless | 60 nodes · HPA | partial results · streaming | B,C,D,I |

## 7 · Trade-offs & open questions

#### Chose

-   **Stateful ingester + WAL** over fully async write · low-latency hot writes + durability; trade: ops-heavy restarts (drain protocol).
-   **Hard cardinality quotas** over best-effort · predictable index size; trade: developer friction, self-serve estimators needed.
-   **Gorilla-style compression** over generic gzip · 12× compression specific to time-series shape; trade: CPU on hot paths, mitigated by SIMD.
-   **Object store cold tier** over local-SSD-only · cheap multi-year retention; trade: latency variance, parallel fetch + cache mitigations.
-   **Deterministic downsampling** over streaming · idempotent pipelines, re-runnable; trade: lossy analytics caveats, UI must disclose.
-   **PromQL AST compatibility** over custom DSL · ecosystem reuse (Grafana, recording rules); trade: complex planner.
-   **Partial query responses** over fail-closed · graceful degradation during partial outages; trade: client must handle.
-   **N=3 replication** across AZs · 11 nines durability; trade: 3× write amplification.
-   **Stateless query, stateful ingest** · the bedrock pattern; ops simplicity on query side, ordering guarantees on ingest side.

#### Rejected

-   **Single homogeneous tier** · simpler but cannot satisfy 500 ms recent AND 30 s cold simultaneously.
-   **Raw 16 B/sample** · 138 TB/day vs 11 TB/day — not financially viable.
-   **Best-effort cardinality limits** · would mean periodic existential outages — not acceptable.
-   **Custom query DSL** · would lose the entire Prometheus + Grafana ecosystem.
-   **Strong consistency cross-region** · would tank write latency to 100ms+; eventual is fine for dashboards.
-   **InfluxDB / TimescaleDB direct** · capable but SQL ergonomics fight PromQL ecosystem; columnar Arrow path interesting but operationally heavier.
-   **Bigtable-as-storage** · would re-invent compaction worse than dedicated time-series codec; doesn't exploit ΔΔ/XOR.
-   **Single global cluster** · would tie all reliability to one region's availability; per-region rings are mandatory for SLO-F.

### Open questions

1.  Should we support **native sparse histograms** (Prom 2.40+) to cut bucket series count 5-10×? Migration cost is real but the cardinality savings compound forever.
2.  How to handle **GDPR delete-by-label** efficiently? Tombstone + compaction works but is expensive; we currently process these in batches monthly.
3.  Is the 2-hour head window right? Longer → more lossless OOO; shorter → faster ingester restarts, smaller WAL.
4.  Should query result cache TTL be dynamic (longer for cold queries, shorter for alert eval)? Currently 30 s for everything.
5.  Should we offer **federated cross-region queries** for global SLO dashboards? Currently each region is independent; federation adds latency and complexity but enables "global Feed availability."
6.  Cardinality quota should be expressed in $ not in series-count — give tenants a budget they can allocate however they want. Currently raw series count is easier to enforce.
