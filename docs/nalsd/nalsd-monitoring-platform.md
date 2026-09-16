---
title: "Monitoring & Alerting Platform"
slug: /nalsd/nalsd-monitoring-platform
sidebar_position: 2
sidebar_label: "Monitoring & Alerting Platform"
description: "Monitoring & Alerting Platform"
---
in

in/observability

v2026.05 · nalsd

[in/observability](#)/ [design-docs](#)/ [2026](#)/ monitoring-alerting-platform.md

A NALSD walkthrough — Feed events, InMail delivery, Profile views, Connection notifications. 100M signals/sec, p99 alert latency < 30s, 99.95% pipeline availability, < 2% false-positive rate.

NALSD SLO: p99 < 30s 100M sig/s 5 regions draft · review last edit · 2026-05-12 · sjc

## 1 · Problem statement & SLO contract [#](#problem) {#problem}

LinkedIn runs hundreds of microservices across five regions. Every *Feed impression*, *InMail delivery*, *Profile view*, *Connection notification*, and *job-recommendation render* emits structured telemetry. Engineers expect to be paged within tens of seconds when something is wrong — without being paged for everything.

Peak ingest

100M/s

signals · global

Hot retention

30d

queryable TSDB

Cold retention

3y

object store

Regions

5

active-active

### SLO contract

Every architectural decision below is justified against one of these three numbers. If a proposal does not move an SLI, it does not ship.

| SLI | Target | Measurement | Error budget / 28d |
| --- | --- | --- | --- |
| **A · Alert latency** | p99 ≤ 30s | signal ingress → notifier ACK | ~24h of >30s tail |
| **B · Pipeline availability** | ≥ 99.95% | successful ingest / offered | ~21 min/month |
| **C · Alert precision** | ≥ 98% | 1 − (FP critical / total critical) | ~2% of pages |

Why SLOs first An SLO contract turns architecture into a budget exercise. "Should we batch?" becomes "does batching consume more of SLI-A's budget than it saves on SLI-B's?" — a question with a numeric answer.

## 2 · Capacity model (the NALSD math) [#](#capacity) {#capacity}

Below is the back-of-envelope sizing that decides hardware and cost. Numbers are conservative — overhead factors are stated explicitly.

### 2.1 — Ingestion throughput

#### Bytes per second at the edge

```
signals/sec        = 100,000,000   (peak global)
avg signal size    = 280 B         (proto: event_type + tenant + 8 tags + 4 metrics)
                                    measured on LinkedIn FeedImpressionEvent v3
─────────────────────────────────────────────────────────
raw ingress        = 100e6 × 280 B = 28 GB/s        ≈ 224 Gbps

with framing + auth headers (gRPC HPACK ~12% overhead):
wire-level         = 28 × 1.12     = 31.4 GB/s      ≈ 251 Gbps

per region (5 regions, traffic weighted 35/25/20/12/8):
us-west-2 peak     = 31.4 × 0.35   = 11.0 GB/s      ≈ 88 Gbps
eu-west-1 peak     = 31.4 × 0.25   =  7.9 GB/s      ≈ 63 Gbps
```

VERDICT · 88 Gbps top region → 2× 100GbE LAG per ingress rack handles it with headroom.

#### QPS at the enqueue gateway

```
client batching        = 50 signals / RPC   (Kafka-like producer batch)
RPC/sec global         = 100e6 / 50         = 2,000,000 RPC/s
RPC/sec top region     = 2e6 × 0.35         = 700,000 RPC/s

per-gateway capacity   = 25,000 RPC/s       (Envoy + gRPC, m6i.4xlarge)
gateways needed        = 700k / 25k         = 28 instances
with N+2 redundancy    = 28 + 2             = 30 instances per top region
fleet total (5 regions, weighted) ≈        102 gateway instances
```

VERDICT · 102 gateways handle 2M RPC/s with N+2 per region. p99 budget at gateway: 5 ms.

### 2.2 — Storage footprint (hot + cold)

#### Hot TSDB (30 days)

```
raw bytes/day      = 28 GB/s × 86,400 s        = 2.42 PB/day
TSDB compression   = 12× (Gorilla XOR + delta) → 200 TB/day stored
30-day hot footprint                            = 6.0 PB

replication factor = 3 (durability + read fan-out)
gross hot storage  = 6.0 PB × 3                 = 18 PB

per shard          = 6 TB usable (NVMe i4i.4xlarge → 7.5 TB raw)
shards needed      = 18 PB / 6 TB               = 3,000 shards
nodes (8 shards/node)                           = 375 storage nodes
```

VERDICT · 375 NVMe nodes for hot tier. Sized for 30d × 100M/s with 3× replication.

#### Cold archive (3 years)

```
downsample at 24h boundary      → 1-min rollups, ratio 60:1
post-rollup bytes/day            = 200 TB / 60        = 3.3 TB/day
3-year cold footprint            = 3.3 TB × 1,095     = 3.6 PB

object storage (S3-class)        = $0.021/GB/mo
monthly cost                     = 3.6e6 GB × $0.021  = $75,600 /mo
                                                       ≈ $907 K /yr cold tier
```

VERDICT · Cold is dominated by storage cost, not bytes. Negotiate enterprise rate → target $0.012/GB/mo (~$520K/yr).

### 2.3 — Stream processing compute

#### CPU for parse + aggregate + rule eval

```
parse (proto decode)            = 800 MB/s per core   (measured, Go)
aggregate (1-min window)        = 400 MB/s per core
rule evaluation (avg 1.2k rules)= 250 MB/s per core
combined throughput per core    = 1 / (1/800 + 1/400 + 1/250)  ≈ 138 MB/s

ingress bytes                   = 28 GB/s × 1024     = 28,672 MB/s
cores needed                    = 28,672 / 138       = 208 cores
with 2× headroom (bursts, GC)   = 416 cores
with 30% over-provision (rebal) = 540 cores

per node (c6i.8xlarge, 32 vCPU) → 540 / 32           = 17 nodes
plus N+2 per region (5 × 2)                          = 27 stream-proc nodes
```

VERDICT · 27 stream-processor nodes globally. State checkpointed to Spanner every 5s.

#### Memory for windowed state

```
active series in window (10-min) = 12 M series        (post-aggregation)
bytes per series in RAM          = 320 B              (labels + ring buffer)
state RAM                        = 12e6 × 320 B       = 3.84 GB / proc
×27 nodes                                              = 104 GB fleet
per-node budget (64 GB box)      → 6% RAM for state    ✓ comfortable
```

VERDICT · State RAM is a non-issue. CPU and network are the binding constraints.

### 2.4 — Network sizing

#### East-west traffic & cross-region replication

```
intra-region fan-out  = ingress × (1 + RF × write_amp)
                      = 11 GB/s × (1 + 3 × 1.2)  = 50.6 GB/s top region
                                                  ≈ 405 Gbps

cross-region (MirrorMaker2, p0 + p1 topics only, 70% of volume):
                      = 31.4 GB/s × 0.70         = 22 GB/s ≈ 176 Gbps global
asymmetric replication: us-west → eu-west = 60 Gbps sustained
```

VERDICT · Cross-region link costs dominate egress bill. Drop p2 (batch) from MM2 — already covered by cold rebuild.

### 2.5 — Fleet summary & cost

| Tier | Instance | Count | vCPU·RAM | $/mo (on-demand) | $/mo (3y RI) |
| --- | --- | --- | --- | --- | --- |
| Enqueue gateway | m6i.4xlarge | 102 | 16 · 64 GB | $59 K | $22 K |
| Kafka brokers | i4i.4xlarge | 90 | 16 · 128 GB | $108 K | $41 K |
| Stream processors | c6i.8xlarge | 27 | 32 · 64 GB | $30 K | $11 K |
| Hot TSDB nodes | i4i.4xlarge | 375 | 16 · 128 GB | $450 K | $170 K |
| Alert engine | m6i.2xlarge | 36 | 8 · 32 GB | $10 K | $3.8 K |
| Cold archive (S3) | — | 3.6 PB | — | $76 K | $76 K |
| Cross-region egress | — | 22 GB/s | — | $118 K | $118 K |
| Total | — | 630 nodes | — | $851 K/mo | $442 K/mo |

Cost lever 3-year RIs cut compute by ~62%. Egress is the irreducible cost — addressed by edge aggregation (§3.2), which can shave another 30%.

## 3 · Architecture [#](#arch) {#arch}

### 3.1 — End-to-end data flow

<img src="/diagrams/nalsd-monitoring-platform/1.svg" alt="nalsd-monitoring-platform diagram 1" class="doc-diagram" />

Fig 1 · End-to-end signal flow. Producers (LinkedIn services) emit telemetry; edge agents pre-aggregate; gateway authenticates and shards; Kafka durably buffers; processors evaluate; alerts page on-call.

### 3.2 — Step-by-step flow (the numbered walkthrough)

Following the numbered blue badges in Fig 1. Concrete example throughout: **the Feed ranker's p99 latency starts climbing — a single metric event triggers a page to on-call within 30 seconds.**

Producer emits a metric signal

The Feed ranker service measures its own request latency and emits a metric every second: `feed_ranker.latency_ms{p99=850, host=feed-pod-7f3a}`. Producer is **fire-and-forget** — the metric is written to a local in-memory ring buffer and the service moves on. Blocking on telemetry would couple production latency to the monitoring pipeline's health, which is a classic outage amplifier.

metric.emit("feed\_ranker.latency\_ms", 850, tags={host, region, version}) → local ringbuffer

budget · **1 µs** (local memory) size · **~280 B** per signal rate · **100 M signals/s** global peak

Edge agent — pre-aggregate, batch, compress

The `liagent` sidecar reads from the local ringbuffer every 60 s. It does the most important work in the entire pipeline: **pre-aggregation**. Instead of forwarding 60 individual samples for a metric, it computes the 60-second rollup (min/max/avg/p50/p99/count) and forwards one summary. This cuts ingest volume from **100M/s → 30M/s**, a 3.3× reduction. It also batches, gzips at ~4×, and authenticates over mTLS.

window: 60 s · output: min/max/avg/p50/p99/count · compression: gzip · auth: mTLS

budget · **60 s** (window length) ingest reduction · **3.3×** deployment · **sidecar per pod (~2M)**

Enqueue gateway — auth, schema, dedupe, route

The gateway is where untrusted producer bytes become trusted pipeline bytes. Five jobs: (a) mTLS verify, (b) gunzip, (c) **schema validate** against registered proto — malformed → DLQ-0 (this prevents poison-pill metrics from crashing downstream), (d) per-tenant token bucket (Feed has 35M signals/s quota), (e) idempotency CAS in Spanner using the signal's unique key — dedupes producer retries.  
  
The gateway also routes by priority: critical paging metrics (Feed availability, InMail delivery) go to `signals.p0`; standard observability metrics to `signals.p1`; analytics-grade to `signals.p2`.

verify\_mtls() → gunzip() → schema\_validate() → token\_bucket(tenant) → spanner.cas(idem\_key) → kafka.produce(priority\_topic, partition=hash(tenant))

budget · **5 ms p99** fleet · **102 nodes** globally rejected → **DLQ-0**

Kafka — durable buffer with priority lanes

Three priority topics: `signals.p0` (critical, paging), `signals.p1` (standard), `signals.p2` (batch analytics). Partitioned by `hash(tenant_id) % 1800` — keeps tenant metrics ordered while spreading load. Replicated 3× in-region; MirrorMaker2 replicates p0+p1 cross-region (p2 stays regional — cost trade).  
  
**Why Kafka:** decouples producer side (must never block) from consumer side (can be slow without back-pressuring producers). If processors fall behind, signals queue in Kafka, not in producer pods. 7-day retention is the replay window for incident recovery.

topics: signals.p0 / p1 / p2 · partitions: 1,800 · ACK: all · MM2: p0+p1 cross-region only

budget · **2 s** (steady-state lag) brokers · **90 · 3× repl** retention · **7 days**

Stream processor — parse, window, SLI compute, rule eval

Stream processors continuously consume from Kafka, partition by partition. For each signal: (a) **parse** the proto (800 MB/s/core), (b) **maintain sliding windows** for SLI computation (10-min tumbling, 1-min hop), (c) **compute SLIs** like error rate or p99 latency per service, (d) **evaluate alert rules** in O(1) lookup time. Per-partition state in local memory; checkpointed to Spanner every 5 s for crash recovery.  
  
Effective throughput: **138 MB/s per core** (harmonic mean of the three stages). This is the core capacity calculation in §2.3 — drives the 27-node fleet sizing.

stages: parse(800MB/s) → window(400MB/s) → rule\_eval(250MB/s) · harmonic\_mean: 138 MB/s/core

budget · **4 s** (window + compute) fleet · **27 nodes · 540 cores** checkpoint · **every 5 s to Spanner**

Alert engine — rule match, verify, dedupe, group

For our example, the Feed ranker p99 latency exceeds its alert threshold (800 ms). The alert engine: (a) **matches the rule**, (b) **verifies in a window** (require 3 consecutive 1-min breaches OR error-budget burning at >2×) — this single step cuts false-positive rate from ~8% to <2%, (c) **deduplicates** using a fingerprint in Spanner CAS (so two stream processors that both fire the same alert produce only one page), (d) **groups** related alerts (if 200 Feed pods all alert simultaneously, group into 1 parent incident).  
  
The engine is stateless; rules are versioned in Git and canary-deployed.

threshold\_check() → window\_verify(3\_consecutive) → spanner.cas(fingerprint) → group\_by(parent\_incident)

budget · **5 s** fleet · **36 nodes · stateless** FP rate cut · **8% → < 2%**

Storage fanout — Hot TSDB + Cold archive (in parallel)

Independent of the alerting path, every signal also lands in storage for dashboards and historical analysis:  
  
**→ Hot TSDB (30-day):** Gorilla XOR compression at 12× ratio. Sharded across 375 NVMe nodes, 3× replicated. Query p99 < 800 ms. Used by Grafana dashboards and ad-hoc SRE queries.  
  
**→ Cold archive (3-year):** 1-min rollups (60:1 reduction) in Parquet on object storage. 3.6 PB total, $76 K/mo. Used for capacity planning and audit trails.  
  
The lifecycle controller demotes shards from hot to cold at the 30-day boundary.

Hot TSDB: 12× Gorilla · 375 NVMe nodes · 3× repl || Cold: 1-min rollups · Parquet · 3.6 PB

budget · **3 s** (write + replicate) hot footprint · **6 PB · 18 PB gross** cold cost · **$76 K/mo**

Notifier — page on-call with priority queue

The grouped alert from step 6 hits the notifier, which delivers to the on-call engineer via PagerDuty, Slack ChatOps, SMS, or email — based on tenant configuration and severity.  
  
**Priority queue:** p0 alerts (Feed unavailable, InMail broken) bypass any throttling and get dedicated capacity. p1/p2 may be batched or suppressed if error budget is already burning hot — preserving SRE attention for what matters.  
  
**Multi-region failover:** notifier runs hot in 2 regions; if primary fails, secondary picks up within 30 s. Vendor fallback chain (PagerDuty → SMS → Slack) handles the rare case of a notification provider outage.  
  
**Total wall-clock time from metric emit to SRE pager buzzing:** ~20 s typical, 30 s p99. Comfortably inside the SLO with room to spare.

PagerDuty (p0) · Slack (p1) · Email digest (p2) · vendor fallback chain · multi-region hot

e2e typical · **~20 s** e2e p99 · **~30 s** SLO target · **p99 ≤ 30 s · ✓ at the edge**

The key design insight Most of the 20-second wall time is *intentional* waiting — 60 s edge aggregation window (for non-critical signals), 5 s alert engine verification (3 consecutive breaches). These look like latency costs but are actually **precision investments**: without them, FP rate would be ~8% and on-call would suffer alert fatigue. Critical p0 paths (Feed availability, InMail delivery) skip the verification step and accept the 1-min window — sacrificing some precision for tighter freshness on the most important alerts only.

### 3.3 — Multi-region topology (active-active)

<img src="/diagrams/nalsd-monitoring-platform/2.svg" alt="nalsd-monitoring-platform diagram 2" class="doc-diagram" />

Fig 2 · Five-region active-active layout. Traffic is weighted by user population; brokers cross-replicate via MM2 with 10 s RPO.

### 3.4 — Alert evaluation pipeline (close-up)

<img src="/diagrams/nalsd-monitoring-platform/3.svg" alt="nalsd-monitoring-platform diagram 3" class="doc-diagram" />

Fig 3 · The 7 stages of alert evaluation, each with an explicit latency budget. Sum is 20 s; remaining 10 s is reserved as queue/scheduler headroom.

## 4 · Failure gauntlet [#](#gauntlet) {#gauntlet}

For each scenario, the response is grounded in a number, not a buzzword.

A · Scale spike to 100M/s SLI: latency

Feed launches a new ranking experiment; signal volume 4× for 20 min.

trigger28 GB/s → 112 GB/s

absorbedge agg 60s → 3.3× cut

elasticHPA gateway 30→90 / 5 min

verdictp99 25 s · within budget

B · Region outage (pdx) SLI: availability

us-west-2 power event takes the region offline for 45 min.

trigger−35% capacity

absorbGSLB → iad + dub in 5 s

notifierdub takes over < 30 s

verdict0 dropped pages

C · Poison-pill metric SLI: precision

A buggy InMail service emits a malformed event 50k/s.

triggerschema reject > 1% / 1 min

absorbgateway → DLQ-0

capper-tenant token bucket

verdict0 spurious pages

D · Alert storm SLI: precision

Database failover causes 12k alerts in 90 s across services.

triggernotify rate > 50/s

absorbdedupe by fingerprint

groupparent incident · 1 page

verdict12k → 4 actionable

E · Spanner CAS contention SLI: latency

Hot dedupe key from a single noisy service blocks step 5.

triggerCAS p99 > 200 ms

absorbshard key by hash(service)

elasticread replicas + bounded staleness

verdictCAS p99 → 35 ms

F · Notifier vendor down SLI: availability

PagerDuty has a 20-min partial outage.

triggerACK rate drops > 30%

absorbfall back: SMS + Slack DM

auditreplay on PD recovery

verdict0 missed pages · audit clean

What we do not defend against (explicit) Simultaneous outage of ≥ 3 of 5 regions. With 5 active-actives weighted 35/25/20/12/8, losing the top 3 means 80% of traffic with no warm replica — beyond the design budget. Mitigation: cold-spin BCP plan; out of scope for this doc.

## 5 · Operational playbook [#](#playbook) {#playbook}

### 5.1 — Deployment

| Stage | % traffic | Soak | Auto-promote criteria |
| --- | --- | --- | --- |
| Shadow | 0% (mirror) | 24 h | diff vs prod < 0.1% on SLI-A,B,C |
| Canary | 1% (single AZ) | 24 h | no SLO regression · p99 < baseline + 5% |
| Regional | 10% (single region) | 12 h | error budget burn rate < 1× |
| Half | 50% | 6 h | auto if no SEV-2+ open |
| Global | 100% | — | manual sign-off (oncall + tech lead) |

### 5.2 — Chaos drills (quarterly)

-   **Region kill** — terminate every node in one region; verify GSLB failover < 5 s and notifier handoff < 30 s.
-   **Broker partition** — block traffic between two Kafka clusters for 15 min; verify replay catches up within 7-day retention.
-   **DLQ flood** — inject 100k malformed events; verify depth-growth alert fires within 60 s and replay tooling drains.
-   **Spanner latency injection** — add 200 ms to all CAS ops; verify step 5 stays within 1 s budget via shard fan-out.
-   **Notifier vendor blackhole** — drop 100% PagerDuty traffic; verify fallback to SMS within 60 s, replay on recovery.

### 5.3 — On-call runbook excerpt

```
# Symptom: SLI-A burning > 5× / 1h
# Likely causes (sorted by base rate over last 12 months)

1. Stream processor lag → check Kafka consumer offset / partition
2. Spanner CAS contention → look at dedupe hot keys
3. Notifier vendor throttling → check PagerDuty 5xx rate
4. Cross-region replication backlog → MM2 lag metric
5. Schema-reject rate spike → check DLQ-0 depth

# First response (in order):
- Confirm: dashboard 'slo-a-burn' showing > 1× over 1 h window
- Page: only if multi-burn (5× over 1h AND 2× over 6h)
- Mitigate: scale processors (`kubectl scale ... --replicas=2x`)
- Communicate: post in #incident-monitoring with hypothesis
```

## 6 · Component reference [#](#components) {#components}

| Component | Tech | Scale strategy | Failure mitigation | SLO |
| --- | --- | --- | --- | --- |
| **Edge agent** | liagent (Go) | process-local · pod sidecar | local disk buffer 5 min | A |
| **Enqueue gateway** | Envoy + gRPC | HPA 30→200 | circuit breaker · token bucket | A,B |
| **Kafka cluster** | Kafka 3.7 · MM2 | partition rebalance | 3× repl · cross-region async | B |
| **Stream processor** | Apache Beam · Dataflow | autoscaling · per-shard | checkpoint /5s · replay | A,C |
| **Alert engine** | Go service | stateless · LB fanout | rule versioning · canary | C |
| **Hot TSDB** | Pinot + Gorilla | shard split at 6 TB | 3-way repl · self-heal | B |
| **Cold archive** | Iceberg / S3 | partition by day | cross-bucket repl | — |
| **State store** | Spanner | region-replicated | bounded staleness reads | A,C |
| **Notifier** | Go · multi-vendor | priority queue | vendor fallback chain | A,B |
| **DLQ** | Kafka topic | per-tenant partition | depth-growth alert · auto-replay | C |

## 7 · Trade-offs & open questions [#](#tradeoffs) {#tradeoffs}

#### Chose

-   **Active-active 5 regions** over active-passive · +35% cost, but RPO < 10 s and zero blackout on single-region loss.
-   **Edge pre-aggregation** over raw forwarding · 3.3× ingress reduction; trade: aggregation window adds 60 s to historical drill-down depth.
-   **Async cross-region MM2** over synchronous · keeps producer-side p99 at 5 ms; trade: RPO > 0, dedupe needed at consumer.
-   **Spanner** for state · global serializable for dedupe correctness; trade: $$, contention risk on hot keys (mitigation in §4-E).
-   **3 consecutive breaches** before paging · adds ~3 s but cuts FP rate from 8% → < 2%.

#### Rejected

-   **Single global Kafka** · simple but ties availability to one region — fails SLO-B.
-   **Push directly to TSDB** · skips queue, but loses durability and replay; one TSDB hiccup = lost signals.
-   **ML-driven anomaly detection at edge** · GPU pool was scoped; ROI unclear vs threshold + EB-burn. Revisit when FP rate stalls above 2%.
-   **HDD for hot tier** · cheap, but 1.16 GB/s sustained per node exceeds HDD IOPS; NVMe non-negotiable.

### Open questions

1.  Is 60 s edge aggregation window too long for InMail delivery alerts? — proposal: priority-0 producers skip edge agg, accept 1.3× cost.
2.  Should DLQ-0 trigger auto-replay or always require human review? — current default: human, but consider tenant-scoped auto-replay for trusted services.
3.  Cross-region egress is $118K/mo. Can we drop one read-replica region (bom or sin)? Would reduce coverage for APAC engineers on-call.
