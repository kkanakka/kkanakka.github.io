---
title: "Distributed Logging Pipeline"
slug: /nalsd/nalsd-logging-pipeline
sidebar_position: 3
sidebar_label: "Distributed Logging Pipeline"
description: "Distributed Logging Pipeline"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/nalsd-logging-pipeline/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

in

in/logging

v2026.05 · nalsd

in/logging/ design-docs/ 2026/ distributed-logging-pipeline.md

A NALSD walkthrough — service logs from Feed, InMail, Search, Jobs, and Notifications. 20 TB/day ingest, queryable within 60 s, 30-day hot + 1-year cold, 11 nines durability.

NALSD SLO: query < 60s 20 TB/day 5 regions draft · review last edit · 2026-05-12 · sjc

## 1 · Problem statement & SLO contract [#](#problem) {#problem}

LinkedIn's microservices each emit structured logs — request traces, error stacks, business events from Feed ranking, InMail delivery, Search relevance, Jobs matching, and Notifications. SREs need to grep across 20 TB of logs/day and have the result appear within seconds. The challenge: at naïve $0.20/GB/mo hot tier pricing, storing 30 days × 20 TB = 600 TB would cost **$120K/month before compression**. The whole design hinges on access-pattern-aware tiering.

Daily ingest

20 TB/d

~230 MB/s avg · 700 MB/s peak

Hot retention

30d

queryable index + raw

Cold retention

1y

compressed object store

Durability

11 9s

cross-region replication

### SLO contract

Every architectural decision below is justified against one of these four numbers. If a proposal doesn't move an SLI, it doesn't ship.

| SLI | Target | Measurement | Error budget / 28d |
| --- | --- | --- | --- |
| **A · Ingest latency** | p99 ≤ 10s | log emitted → durable write ACK | ~24h with >10s tail |
| **B · Query freshness** | ≤ 60s | durable write → queryable | ~24h of 60s+ lag |
| **C · Pipeline availability** | ≥ 99.95% | ingest accepted / offered | ~21 min/month |
| **D · Durability** | ≥ 11 nines | annual data loss probability | ~0.001% loss tolerated |

The hard constraint Durability at 11 nines drives the entire storage architecture — single-region storage caps at ~6 nines (RAID + 3× replication), so multi-region replication is non-negotiable. That dictates network sizing, which dictates cost. Every other SLO is comparatively easy.

## 2 · Capacity model (the NALSD math) [#](#capacity) {#capacity}

Conservative numbers throughout. Each multiplier is stated explicitly so the assumption can be audited.

### 2.1 — Ingestion throughput

#### Bytes per second at the edge

```
daily ingest          = 20 TB/day = 20 × 10¹² B / 86,400 s
sustained avg         = 231 MB/s
peak (3× factor)      = 693 MB/s ≈ 700 MB/s

per-log payload (structured JSON):
  timestamp (ISO-8601)        =  24 B
  service + host + pod        =  64 B
  trace_id + span_id          =  48 B
  severity + status code      =  16 B
  message body (median)       = 280 B
  contextual fields           = 168 B
  ─────────────────────────────────
  avg log size                = 600 B

logs/sec sustained    = 231 MB/s / 600 B    = 385,000 logs/s
peak logs/sec         = 700 MB/s / 600 B    = 1.15 M logs/s

with gzip at edge (4× ratio for JSON logs):
wire bytes/sec        = 700 / 4 = 175 MB/s ≈ 1.4 Gbps peak

per region (5 regions, weighted 35/25/20/12/8):
us-west-2 peak        = 700 × 0.35 = 245 MB/s ≈ 2 Gbps
eu-west-1 peak        = 700 × 0.25 = 175 MB/s ≈ 1.4 Gbps
```

VERDICT · 1.4 Gbps global wire traffic (after gzip). Trivial for any WAN — 700 MB/s decompressed lands in the pipeline.

#### RPC rate at the ingestion gateway

```
edge agent batch size = 1000 logs/batch (Fluent Bit tuned)
RPC/sec global        = 1.15 M / 1000 = 1,150 RPC/s
RPC/sec top region    = 1,150 × 0.35 = 400 RPC/s

per-ingestion node cap = 5,000 RPC/s (Go + gunzip + validate)
nodes per top region   = 400 / 5,000 = 1 (rounded to 3 for N+2)
fleet total            = 5 regions × 3 = 15 ingestion nodes
```

VERDICT · 15 nodes globally. RPC count is low because of batching; p99 budget at gateway: 200 ms.

### 2.2 — Storage footprint (hot + warm + cold)

#### Hot tier (0–30 days)

```
raw bytes/day                = 20 TB
zstd compression on logs     = 6× → 3.3 TB/day stored
search index overhead        = 1.3× → 4.3 TB/day net
30-day hot footprint         = 4.3 TB × 30 = 130 TB

replication factor (in-region) = 3 (durability + query fanout)
gross hot storage              = 130 × 3 = 390 TB

per shard (i4i.4xlarge NVMe)   = 6 TB usable (7.5 TB raw × 80%)
shards needed                  = 390 / 6 = 65 shards
nodes (4 shards/node)          = 17 storage nodes
```

VERDICT · 17 NVMe nodes for hot tier. 6× compression is the make-or-break input.

#### Warm + cold archive (30 days – 1 year)

```
30–90 days warm (Parquet on S3 Standard):
  same daily logs            = 20 TB/day raw
  zstd + Parquet columnar    = 10× → 2 TB/day stored
  60 days of warm            = 120 TB

90–365 days cold (Glacier Instant Retrieval):
  same compression           = 2 TB/day stored
  275 days of cold           = 550 TB

cross-region replication     = 2× (for 11-nines target)
gross cold + warm storage    = (120 + 550) × 2 = 1.34 PB

monthly storage cost:
  warm 120 TB × 2 × $0.023  = $5.5K
  cold 550 TB × 2 × $0.004  = $4.4K
  ───────────────────────────────────
  total                      = ~$10K /mo
```

VERDICT · Cold is dominated by access-pattern-aware tiering. Without this: $730K/mo all-hot. With: $40K/mo total.

### 2.3 — Indexing pipeline (the 60s SLO)

#### CPU for parse + tokenize + index build

```
JSON parse (simdjson-go)      = 600 MB/s per core
tokenize + field normalize    = 300 MB/s per core
inverted index build          = 150 MB/s per core
combined throughput (harmonic mean):
  1/T = 1/600 + 1/300 + 1/150
      = 0.00167 + 0.00333 + 0.00667
      = 0.01167
  T   = 86 MB/s per core

ingest rate (decompressed)    = 700 MB/s peak
cores needed                  = 700 / 86 = 8.1 → 10 cores
with 2× burst headroom        = 20 cores
with 30% over-provision       = 26 cores

per node (c6i.8xlarge = 32 vCPU) → fits in 1 node
plus N+2 per region (5 × 2)   = 12 indexing nodes total
```

VERDICT · 12 indexer nodes. Inverted index build is the bottleneck stage.

#### End-to-end latency budget (the 60s SLO)

```
edge agent buffer window       =  5.0 s
network to ingestion           =  0.05 s
ingestion → Kafka write        =  0.5 s
Kafka consumer lag (steady)    =  2.0 s
indexer parse + write          =  3.0 s
search index refresh interval  =  5.0 s
shard replication (3-way)      =  2.0 s
─────────────────────────────────────
typical sum                     = 17.5 s
×2 safety margin (p99 tail)     = 35 s
                               ≤ 60 s ✓ (42% headroom)
```

VERDICT · Observed p99 in load tests: 38 s. Headroom 22 s under SLO. Largest lever: edge buffer window.

### 2.4 — Query fleet sizing

#### Query QPS and concurrency

```
active engineers (SRE + backend) ≈ 800
queries/engineer/day             ≈ 40 (dashboards + ad-hoc grep + incidents)
total queries/day                = 32,000
avg QPS                          = 32,000 / 86,400 = 0.37 QPS

peak factor (incident-driven)    = 100×
peak QPS                         ≈ 40 QPS

avg query touches                = 4 shards (1-day time bound)
worst-case multi-day query       = 20 shards
per-shard query cost             = 100 ms p50, 800 ms p99

concurrent capacity per node     = 30 queries (CPU bound)
in-flight at 40 QPS × 800ms      = 32 concurrent
nodes needed (theoretical)       = 32 / 30 ≈ 1.1 nodes

+ N+2 + cross-region (5 × 2)     = 9 query coordinator nodes
```

VERDICT · Query traffic is a rounding error vs ingest. Fleet of 9 is dominated by redundancy.

### 2.5 — Network sizing

#### East-west traffic & cross-region replication

```
intra-region fan-out (indexer → 3× shard replicas):
  = ingest × (1 + RF × write_amp)
  = 245 MB/s × (1 + 3 × 1.2) = 1.13 GB/s top region
                              ≈ 9 Gbps

cross-region replication (warm + cold tiers, async S3 repl):
  = 2 TB/day × 2 replicas / 86,400 = 47 MB/s avg
                                   ≈ 0.4 Gbps global

Kafka MM2 cross-region (error + warn topics only):
  = 700 MB/s × 0.4 (only critical levels) = 280 MB/s
                                          ≈ 2.2 Gbps

total cross-region egress      ≈ 2.6 Gbps avg, 4 Gbps peak
monthly egress cost (AWS $0.02/GB) ≈ $8K/mo
```

VERDICT · Cross-region egress is minor compared to monitoring ($118K/mo). Logs are batched; signals are real-time.

### 2.6 — Fleet summary & cost

| Tier | Instance | Count | vCPU·RAM | $/mo (on-demand) | $/mo (3y RI) |
| --- | --- | --- | --- | --- | --- |
| Edge agents | Fluent Bit (sidecar) | ~2 M pods | 200 MB RAM each | $0 (in pod budget) | $0 |
| Ingestion service | m6i.2xlarge | 15 | 8 · 32 GB | $4.4 K | $1.7 K |
| Kafka brokers | i4i.2xlarge | 21 | 8 · 64 GB | $12 K | $4.6 K |
| Indexer pool | c6i.8xlarge | 12 | 32 · 64 GB | $13 K | $4.9 K |
| Hot search nodes | i4i.4xlarge | 17 | 16 · 128 GB | $20 K | $7.6 K |
| Query coordinators | m6i.2xlarge | 9 | 8 · 32 GB | $2.6 K | $1.0 K |
| Warm S3 (Parquet) | — | 240 TB | — | $5.5 K | $5.5 K |
| Cold Glacier IR | — | 1.1 PB | — | $4.4 K | $4.4 K |
| Cross-region egress | — | 2.6 Gbps avg | — | $8 K | $8 K |
| Total | — | 74 nodes + storage | — | $70 K/mo | $38 K/mo |

Compared to monitoring platform Logging is ~12× cheaper than monitoring ($442K/mo). Why? Lower QPS, 120× less data volume, and Glacier-class cold tier doing the heavy lifting. The cost lever is the lifecycle controller — without it, all-hot would cost $730K/mo.

## 3 · Architecture [#](#arch) {#arch}

### 3.1 — End-to-end data flow

<img src="/diagrams/nalsd-logging-pipeline/1.svg" alt="nalsd-logging-pipeline diagram 1" class="doc-diagram" />

Fig 1 · End-to-end log flow. Producers → ATS edge (TLS + rate-limit) → Ingest gateway (schema + DLQ) → Kafka (durable, replayable) → Flink (aggregate, dedupe, rule eval) → MDM (2h hot) / TSDS (30d) / Cold (3y) → Query API or Alert engine → Grafana or Notifier.

### 3.2 — Step-by-step flow (the numbered walkthrough)

Following the numbered blue badges in Fig 1. Concrete example throughout: **the Feed ranking service throws an exception while ranking a member's home page, emitting an ERROR log.**

Producer emits a log

The Feed service catches an exception during ranking. Its logger formats a structured JSON line and writes it to stdout (or directly to the local sidecar via a Unix socket). Producer is **fire-and-forget** — it does NOT wait for confirmation that the log was stored. Logging that blocks application requests would be catastrophic.

{"ts":"2026-05-12T14:32:18Z","service":"feed-ranker","severity":"ERROR","msg":"NullPointerException...","trace\_id":"abc123","stack":"..."}

budget · **1 ms** (local write) size · **~600 B median · 4 KB p99** rate · **385k/s sustained · 1.15M/s peak**

ATS edge — TLS, rate limit, batch + gzip

ATS (Application Tracing Stack) runs as a sidecar in every pod. It collects logs from stdout, batches them (1000 logs OR 5s OR 1 MB, whichever first), gzips at 4×, ships over mTLS. **Three jobs:** (a) TLS termination — producers don't need their own certs, (b) per-tenant rate limit — if Feed suddenly logs 100× normal volume, the sidecar sheds debug logs and keeps errors, (c) batch + compress — gzip ratio of 4× cuts cross-region egress cost by 4×. The 5-minute local disk buffer protects against pipeline downtime.

batch\_window: 5s · batch\_size: 1000 OR 1MB · compression: gzip · local\_disk\_buffer: 5min

budget · **5 s** (the batch window) deployment · **sidecar per pod (~2M)** gzip ratio · **4×**

Ingest gateway — the firewall

The gateway is where untrusted producer bytes become trusted pipeline bytes. Five jobs in order: (a) mTLS verify the sidecar's identity, (b) gunzip the batch, (c) **schema validate** every log against a registered proto — malformed → DLQ, not Kafka (this prevents poison-pill logs from crashing Flink), (d) per-tenant token bucket — exceed quota → 429, (e) optional idempotency dedupe via Spanner CAS for logs that carry an idempotency key.

verify\_mtls() → gunzip() → schema\_validate() → token\_bucket.check(tenant) → kafka.produce(topic, partition=hash(tenant))

budget · **200 ms p99** fleet · **15 nodes globally** rejected → **DLQ-0**

Kafka — durable buffer

Gateway writes to the appropriate Kafka topic. Four topics by severity: `logs.error` · `logs.warn` · `logs.info` · `logs.debug` (sampled 10%). Our ERROR lands in `logs.error`, partition = `hash(tenant_id) % 256`. **Why Kafka:** it decouples producer (which must never block) from consumer (which can be slow without back-pressuring producers). If Flink falls behind, logs queue in Kafka, not in producer pods. 7-day retention is the replay window — if Flink breaks, you have 7 days to fix it and replay without losing logs.

topic: logs.error · partition: hash(tenant\_id) % 256 · ACK: all · MM2 cross-region: error+warn only (40% volume)

budget · **2 s** (steady-state lag) brokers · **21 · 3× repl** retention · **7 days**

Flink — the stream processor

Flink jobs continuously consume from Kafka. For each log: (a) **parse** with simdjson (600 MB/s/core), (b) **aggregate** for derived metrics like error\_rate per service per minute, (c) **dedupe** rare duplicates, (d) **SLI compute** like error\_rate per service, (e) **rule eval** — does this log match any alert rule?, (f) **field extract** — pull indexable fields for downstream stores.  
  
**Why Flink, not consumer loops:** stateful windows (RocksDB on local NVMe, checkpoints to S3 every 30s), exactly-once semantics (atomic offset+state commit), and automatic backpressure (slows Kafka consumption if downstream is slow, never drops).

stages: parse(600MB/s) → aggregate(300MB/s) → index\_build(150MB/s) · harmonic\_mean: 86 MB/s/core

budget · **3 s** fleet · **12 nodes · 384 cores** checkpoint · **every 30 s to S3**

Three-way fanout to storage

Flink writes each log to **three places in parallel**, each optimized for a different access pattern:  
  
**→ MDM (2-hour hot):** recent logs in RAM for sub-second drill-down during active incidents. "What errors did feed-ranker emit in the last 10 min?" answered in <100 ms.  
  
**→ TSDS (30-day compressed):** OpenSearch on NVMe with inverted index. Full-text search across 30 days in <800 ms p99. 6× zstd compression, 3× replication.  
  
**→ Cold (3-year archive):** Parquet on Glacier IR. Compliance + rare historical queries. Restore in 1–5 min. 1/50th the per-GB cost of hot.  
  
**Why three stores:** 90% of queries hit logs < 30 days, 9% hit MDM during drill-downs, 1% hit cold. Matching access frequency to per-GB cost is the design's central trick.

MDM: 1 TB RAM · 4 nodes || TSDS: 130 TB NVMe · 17 nodes · 65 shards || Cold: 670 TB · Glacier IR

budget · **5 s** (refresh interval is the floor) cost · **$10 K + $5.5 K + $4.4 K /mo** durability · **10 / 11 / 11 nines**

Query API + Alert engine — two consumers

**Query API:** SREs run queries from Grafana, Kibana, or CLI. The API receives a query, decides which store to hit based on time range (last 2h → MDM, last 30d → TSDS, older → Cold with restore prompt), and caches results in Redis with TTL — 70% cache hit ratio because dashboards refresh on the same query repeatedly.  
  
**Alert engine:** for each log that Flink flagged as matching a rule: (a) threshold + error-budget burn check, (b) dedupe + group similar alerts ("100 ranking errors" → 1 page, not 100), (c) priority lanes — p0 bypasses throttling, p1/p2 may be batched.

Query: Trino federates MDM + TSDS + Cold · cache TTL 60s · 70% hit ratio  
Alert: dedupe by fingerprint · group by parent incident · suppress on error-budget burn

budget · **2 s** Query QPS · **40 peak** Alert lag · **p95 5 s**

Grafana / Notifier — humans

The final consumers. **Grafana dashboards** show SLI views ("feed-ranker error rate over time") and error-budget burn rates. **Notifier** sends alerts to PagerDuty, ChatOps (Slack), or email.  
  
The SRE gets paged about the feed-ranker error spike. They open Grafana, drill into the time range, query TSDS for the specific error logs, find the NullPointer trace, fix the bug.  
  
**Total wall-clock time from log emission to SRE seeing it:** ~35 s typical (sum of step budgets: 1ms + 5s + 0.2s + 2s + 3s + 5s + 2s ≈ 17 s · ×2 for p99 tail ≈ 35 s). Comfortably inside the 60 s SLO with 25 s of headroom.

PagerDuty (p0) · Slack #incident-\* (p1) · Email digest (p2)

e2e typical · **17 s** e2e p99 · **35 s** SLO budget · **60 s · headroom 25 s**

The key design insight Most of the 35 seconds is *intentional waiting* — for batches to fill (step 2), for OpenSearch refresh intervals to fire (step 6). We're trading freshness for cost efficiency. If you wanted 1-second freshness, you could drop the edge batch (5× more RPCs) and the refresh interval (5× more index writes) — but the system would cost ~5× more. The 60 s SLO is carefully chosen as the sweet spot.

### 3.3 — Multi-region topology (active-active)

<img src="/diagrams/nalsd-logging-pipeline/2.svg" alt="nalsd-logging-pipeline diagram 2" class="doc-diagram" />

Fig 2 · Five-region active-active. Each region indexes its own logs locally; only error/warn logs replicate cross-region (cost vs availability trade-off). Queries can be served from any region.

### 3.4 — Indexing pipeline close-up (the 60s SLO)

<img src="/diagrams/nalsd-logging-pipeline/3.svg" alt="nalsd-logging-pipeline diagram 3" class="doc-diagram" />

Fig 3 · The 7 stages of indexing, each with explicit latency budget. Sum is 17.5 s typical; ×2 for tail = 35 s p99; 25 s of headroom under the 60 s SLO.

### 3.5 — Storage tier comparison

<img src="/diagrams/nalsd-logging-pipeline/4.svg" alt="nalsd-logging-pipeline diagram 4" class="doc-diagram" />

Fig 4 · Three storage tiers. The capacity bars visualize how 130 TB hot is dwarfed by 550 TB cold — yet hot costs 4× more in absolute terms, 50× more per GB. Matching access frequency to per-GB cost is the design's central trick.

### 3.6 — Lifecycle pipeline (the cost lever)

<img src="/diagrams/nalsd-logging-pipeline/5.svg" alt="nalsd-logging-pipeline diagram 5" class="doc-diagram" />

Fig 5 · The lifecycle is the cost lever. By day 90, logs are on Glacier at 1/50th the per-GB cost of hot tier. Without aggressive tiering, the system costs 18× more.

Why this structure works Access pattern: 90% of queries hit logs < 30 days old. 9% hit 30–90 days. 1% hit older. Matching access frequency to storage cost is the entire game; everything else is plumbing.

## 4 · Failure gauntlet [#](#gauntlet) {#gauntlet}

For each scenario, the response is grounded in a number, not a buzzword.

A · 10× log explosion SLI: A, B

Feed ranking experiment goes wrong, logs at 10× normal volume for 30 min.

trigger230 → 2,300 MB/s

absorbKafka 7-day retention

sheddrop debug @ edge (90%)

verdictindexers lag 15 min · 0 loss

B · Region outage SLI: C, D

us-west-2 takes 45-min power hit.

trigger−35% capacity

absorbedge agent 5-min buffer

failoverGSLB → iad in 5 s

verdict0 loss · 1-min query gap

C · Oversize log SLI: A, D

Service logs 5 MB stack traces at 100/s (500 MB/s of garbage).

triggerlog size > 64 KB

absorbtruncate at ingress

flagDLQ + alert tenant

verdictpipeline unaffected

D · Hot tier disk full SLI: B, D

Lifecycle controller stalls; hot tier hits 95% disk.

triggerdisk usage > 85%

absorbemergency demote 7-day idx

pagelifecycle owner

verdictwindow narrows · queries live

E · Cardinality bomb SLI: B

Service adds user\_id as a logged field — index explodes.

triggerunique fields > 10k/tenant

absorbstop indexing offender

repairpage tenant · schema fix

verdictindexer CPU → baseline

F · Glacier restore storm SLI: cost

Incident review needs 1 month of cold data restored.

triggerrestore request > 10 TB

absorbbulk-restore queue

capper-tenant restore budget

verdictcost predictable · hours not min

What we do not defend against (explicit) Simultaneous loss of ≥ 3 of 5 regions, or a coordinated indexer zero-day. With 5 active-actives weighted 35/25/20/12/8, losing the top 3 means 80% of traffic with no warm replica. Mitigation: cross-cloud cold backups + manual rebuild; separate disaster-recovery doc.

## 5 · Operational playbook [#](#playbook) {#playbook}

### 5.1 — Deployment

| Stage | % traffic | Soak | Auto-promote criteria |
| --- | --- | --- | --- |
| Shadow indexer | 100% mirror, 0% query | 48 h | output diff vs prod < 0.01% |
| Canary | 1% query traffic, 1 region | 24 h | p99 query latency Δ < 5% |
| Regional | 10% (1 region) | 12 h | no SLO regression · EB burn < 1× |
| Half | 50% | 6 h | auto if no SEV-2+ open |
| Global | 100% | — | manual sign-off (oncall + lead) |

### 5.2 — Chaos drills (quarterly)

-   **Region kill** — drain one region; verify GSLB and indexer rebalancing within 2 min.
-   **Kafka broker loss** — kill 3 brokers; verify partitions rebalance and producer ACKs continue.
-   **Cardinality bomb injection** — emit logs with synthetic high-cardinality field; verify auto-suppression within 5 min.
-   **Lifecycle stall** — block demote jobs; verify disk-full alert fires before tier saturates.
-   **Glacier restore at scale** — restore 100 TB; verify rate-limit and per-tenant budgets work.
-   **Indexer poison message** — emit log that crashes the parser; verify DLQ + circuit breaker, no cascade.

### 5.3 — On-call runbook excerpt

```
# Symptom: SLI-B (query freshness) burning > 5× / 1h
# Likely causes (sorted by base rate over last 12 months)

1. Indexer Kafka lag        → check consumer offset, scale indexer pool
2. Hot tier shard imbalance → check rebalance, watch GC pauses
3. OpenSearch refresh slow  → check refresh_interval, segment merge backlog
4. Schema change deployed   → check index template mismatches
5. DLQ-0 growth (silent FP) → check DLQ depth for legitimate logs being rejected
6. Cross-region MM2 lag     → check MM2 metrics, possibly a network issue

# First response (in order):
- Confirm: dashboard 'slo-b-freshness' shows > 60s over 5 min window
- Page: only if multi-burn (5× over 1h AND 2× over 6h)
- Mitigate: scale indexer pool 2× (`kubectl scale deployment indexer --replicas=24`)
- Communicate: post in #incident-logging with hypothesis
- Escalate: if not resolving in 15 min, page tier-2 oncall
```

## 6 · Component reference [#](#components) {#components}

| Component | Tech | Scale strategy | Failure mitigation | SLO |
| --- | --- | --- | --- | --- |
| **Edge agent** | Fluent Bit (sidecar) | per-pod deployment | local disk 5-min buffer | A |
| **Ingestion service** | Envoy + Go | HPA 3→30 per region | circuit breaker · DLQ | A,C |
| **Kafka cluster** | Kafka 3.7 · MM2 | partition split by tenant | 3× repl · cross-region async | C,D |
| **Indexer pool** | Go · simdjson | autoscale on Kafka lag | offset checkpoint · replay | B |
| **Hot search** | OpenSearch 2.x | shard split at 50 GB | 3-way repl · self-heal | B,C |
| **Warm Parquet** | Iceberg + S3 Std | partition by day/tenant | cross-bucket repl | D |
| **Cold archive** | S3 Glacier IR | — | 11 nines built-in | D |
| **Query API** | Trino + Go gw | read replicas | result cache · tier fallback | B |
| **Lifecycle ctrl** | Go cron (leader-elected) | singleton w/ lease | disk-full alert · manual override | D |
| **DLQ** | Kafka topic | per-tenant partition | depth alert · auto-replay | A |

## 7 · Trade-offs & open questions [#](#tradeoffs) {#tradeoffs}

#### Chose

-   **3-tier storage** over single-tier · 18× total cost reduction; trade: lifecycle complexity, possible demote bugs.
-   **OpenSearch over Loki/ClickHouse** · proven, large ops community, full-text queries; trade: less efficient per GB than Loki.
-   **Gzip at edge** over server-side compression · 4× bandwidth reduction at cost of ~5% producer CPU.
-   **Sample debug logs** · drop 90% under load; trade: lossy debug, but full error/warn preserved.
-   **Glacier IR (Instant Retrieval)** not deep Glacier · 1–5 min restore vs hours; cost premium worth it for ad-hoc audits.
-   **Region-local indexing** · indexers don't cross regions; trade: per-region query, but simpler ops.

#### Rejected

-   **Direct write to S3** · skips Kafka, simpler — but loses replay window and back-pressure handling.
-   **Loki-style label-only index** · cheaper but breaks full-text queries SREs depend on.
-   **Single hot region** · costs less but breaks SLO-C (region outage = total query blackout).
-   **HDD hot tier** · 10× cheaper per GB but IOPS can't handle index writes at 700 MB/s.
-   **30-day Kafka retention** as replay source · would cost more than hot tier; 7 days sufficient.
-   **Per-tenant dedicated clusters** · operational nightmare at LinkedIn's tenant count; multi-tenant with quotas instead.

### Open questions

1.  Should debug logs go to a separate ultra-cheap tier (Loki-style) and skip OpenSearch entirely? Could save ~30% of hot fleet.
2.  Is 7-day Kafka retention enough? Past incidents have needed 14-day replay. Trade: 2× broker count.
3.  Should we offer "logs export to customer's S3" for compliance/enterprise tenants? Adds plumbing but reduces our retention pressure.
4.  Per-tenant zstd dictionary training could push compression from 6× to 9× — ~30% storage savings. Worth the ops complexity?
