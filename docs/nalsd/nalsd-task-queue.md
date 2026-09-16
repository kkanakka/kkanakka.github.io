---
title: "Distributed Task Queue"
slug: /nalsd/nalsd-task-queue
sidebar_position: 4
sidebar_label: "Distributed Task Queue"
description: "Distributed Task Queue"
---
in

in/taskqueue

v2026.05 · nalsd

in/taskqueue/ design-docs/ 2026/ distributed-task-queue.md

A NALSD walkthrough — background processing for Feed image resize, InMail send, Profile picture transcode, Jobs-digest generation, and ML inference. 10 M tasks/sec ingest, p99 ≤ 10 s, exactly-once with idempotency keys, 5 nines delivery.

NALSD SLO: p99 ≤ 10s 10 M tasks/s 5 regions draft · review last edit · 2026-05-12 · sjc

## 1 · Problem statement & SLO contract [#](#problem) {#problem}

LinkedIn's product teams generate background work all day: a member uploads a profile photo (transcode + thumbnail), a recruiter sends an InMail (delivery via vendor APIs), Jobs ships a daily digest email to 50M members, a Feed ranking experiment kicks off offline ML inference. None of this can run inline on the user request — it must be queued, executed reliably, and observed.

Peak enqueue

10 M/s

tasks · global

Avg latency

≤ 10 s

p99 enqueue → start

Delivery

99.999%

at-least-once OR DLQ

Worker pools

4 types

CPU · I/O · GPU · Memory

### SLO contract

Every component below is justified against these five SLIs. If a proposal doesn't move one, it doesn't ship.

| SLI | Target | Measurement | Error budget / 28d |
| --- | --- | --- | --- |
| **A · Regional latency** | p95 ≤ 2 s | enqueue → worker claim, same region | ~24 h with >2s |
| **B · Global latency** | p99 ≤ 10 s | enqueue → worker claim, any region | ~24 h with >10s |
| **C · Delivery reliability** | ≥ 99.999% | tasks delivered OR moved to DLQ | ~5 in 10⁶ lost |
| **D · Visibility freshness** | p95 ≤ 5 s | task event → status API reflects it | ~24 h stale |
| **E · Queue availability** | ≥ 99.99% | enqueue accepted / offered | ~4 min/month |

The hardest SLO Five nines delivery (SLI-C) is the binding constraint. It's what forces durable Kafka, lease-based claiming, conditional Spanner writes, and the DLQ. Without that target, you could get away with Redis lists and a watchdog.

## 2 · Capacity model (the NALSD math) [#](#capacity) {#capacity}

### 2.1 — Enqueue rate at the gateway

#### Bytes per second at the edge

```
peak tasks/sec        = 10,000,000

avg task payload (proto):
  task_id (uuid)             = 16 B
  tenant_id + service_id     = 32 B
  idempotency_key            = 32 B
  task_type (enum)           =  4 B
  priority (p0/p1/p2)        =  2 B
  schedule (timestamp)       =  8 B
  retry policy + retries     = 16 B
  payload (image url / blob ref) = 290 B
  ──────────────────────────────────
  avg task size              = 400 B

bytes/sec at peak     = 10e6 × 400 B  = 4 GB/s
                                       ≈ 32 Gbps

per-region peak (35% top region):
  us-west-2           = 4 × 0.35 = 1.4 GB/s ≈ 11 Gbps
```

VERDICT · 32 Gbps global enqueue. 4 GB/s decompressed lands in Kafka after gateway.

#### Gateway RPC capacity

```
RPC batching by producer = 20 tasks/RPC
RPC/sec global           = 10e6 / 20 = 500,000 RPC/s
RPC/sec top region (35%) = 175,000 RPC/s

per-gateway capacity (Envoy + gRPC + Spanner CAS dedupe):
                         = 8,000 RPC/s
                          (limited by Spanner CAS p99, NOT CPU)

gateways needed per top region  = 175k / 8k = 22 instances
+ N+2 redundancy                = 24
fleet total (5 regions, weighted) ≈ 80 gateway instances
```

VERDICT · 80 gateways. Spanner CAS dedupe is the bottleneck, not CPU.

### 2.2 — Kafka cluster sizing

#### Brokers, partitions, retention

```
peak throughput        = 4 GB/s in × 3 (replication factor) = 12 GB/s gross write
                       + 4 GB/s out (consumers)            = 16 GB/s aggregate
per-broker capacity    = 250 MB/s sustained (i4i.4xlarge, NVMe)
brokers needed         = 16,000 / 250 = 64 brokers
+ headroom + per-region distribution → 80 brokers

partitions (need enough for parallelism):
  tasks.p0 (critical) = 256 partitions
  tasks.p1 (standard) = 512 partitions
  tasks.p2 (batch)    = 256 partitions
  total               = 1,024 partitions

retention:
  7 days at 4 GB/s    = 4 × 86,400 × 7 = 2.4 PB raw
  with 3× repl        = 7.3 PB
  per-broker (12 TB)  = 7,300 / 12 ÷ 80 = 7.6 TB/broker ✓ fits
```

VERDICT · 80 brokers · 1024 partitions · 7-day retention enables replay window for incident recovery.

### 2.3 — Worker pool sizing (the big number)

The worker fleet is the biggest cost component. Sizing depends on the *mix of task types*, not just count. Different tasks land in different pools.

#### Task mix and per-pool throughput

```
task type mix (measured from production):
  CPU pool (image resize, transcode)    = 50%  = 5 M tasks/s
  I/O pool (email, webhooks, vendor API) = 35%  = 3.5 M tasks/s
  GPU pool (ML inference, ranking)      =  8%  = 0.8 M tasks/s
  Memory pool (data enrich, joins)      =  7%  = 0.7 M tasks/s
                                          ───
                                          10 M tasks/s

per-task wall time (measured p50):
  CPU task       = 200 ms  (image 200 KB → thumbnail)
  I/O task       = 800 ms  (email vendor API call)
  GPU task       = 50 ms   (small inference, batched 32×)
  Memory task    = 500 ms  (data join + write)

concurrent workers needed = tasks/s × wall time:
  CPU pool       = 5,000,000 × 0.2 s  = 1,000,000 concurrent
  I/O pool       = 3,500,000 × 0.8 s  = 2,800,000 concurrent
  GPU pool       =   800,000 × 0.05 s =    40,000 concurrent
  Memory pool    =   700,000 × 0.5 s  =   350,000 concurrent
                                       ──────────
                                       4,190,000 concurrent
```

VERDICT · 4.2M concurrent worker instances peak. That's a big number — packing density is critical.

#### Worker packing on Kubernetes nodes

```
concurrent workers per pod (varies by pool):
  CPU pod (4 vCPU, 8 GB)     = 4 concurrent CPU tasks
  I/O pod (2 vCPU, 4 GB)     = 200 concurrent I/O tasks  (mostly waiting on network)
  GPU pod (1 GPU shared)     = 32 concurrent (batched)
  Memory pod (2 vCPU, 32 GB) = 8 concurrent

pods needed:
  CPU pool       = 1,000,000 / 4   = 250,000 pods
  I/O pool       = 2,800,000 / 200 =  14,000 pods
  GPU pool       =    40,000 / 32  =   1,250 pods
  Memory pool    =   350,000 / 8   =  44,000 pods
                                    ──────────
                                    309,250 pods peak

nodes (pack ~20 pods per node):
  CPU       = 250,000 / 20 = 12,500 nodes
  I/O       = 14,000 / 100 = 140 nodes  (smaller, denser pods)
  GPU       = 1,250 / 4    = 313 nodes  (GPU nodes hold fewer pods)
  Memory    = 44,000 / 8   = 5,500 nodes
  ──────────────────────────────────────
  total                    = 18,453 nodes peak (matches HPA "1k-20k")
```

VERDICT · 18k nodes peak. Autoscale 1k baseline → 20k peak via HPA. CPU pool dominates everything.

### 2.4 — State store (Spanner)

#### QPS and storage

```
per-task lifecycle writes to Spanner:
  enqueue:    CAS dedupe insert    = 1 write
  claim:      lease acquire        = 1 write
  heartbeat:  lease renew × 3      = 3 writes (during 30s task at 10s heartbeat)
  complete:   CAS final status     = 1 write
  ──────────────────────────────────────
  total                            = 6 writes per task

write QPS at peak = 10e6 × 6 = 60 M writes/s

per-Spanner-node capacity = 10,000 writes/s sustained
nodes needed              = 6,000 (theoretical, not actually how Spanner scales)
                          → use Spanner's automatic splitting
                          → 200 splits × 30K writes/s each = serves the load

storage per task row     = 500 B (metadata + lease + retry counters)
rows retained 7 days     = 7 × 86,400 × 10M = 6 × 10¹² rows
storage                  = 6e12 × 500 B = 3 PB
with TTL cleanup at 7d  → roughly steady state
```

VERDICT · Spanner handles 60M writes/s via automatic splits. The CAS p99 is the binding latency constraint.

### 2.5 — Fleet summary & cost

| Tier | Instance | Count | $/mo (on-demand) | $/mo (3y RI) |
| --- | --- | --- | --- | --- |
| Enqueue gateway | m6i.4xlarge | 80 | $47 K | $18 K |
| Kafka brokers | i4i.4xlarge | 80 | $96 K | $36 K |
| Scheduler/dispatcher | m6i.2xlarge | 40 | $12 K | $4.5 K |
| CPU worker pool | c6i.2xlarge (avg) | 12,500 | $2.7 M | $1.0 M |
| I/O worker pool | m6i.large | 140 | $11 K | $4.2 K |
| GPU worker pool | g5.2xlarge | 313 | $280 K | $106 K |
| Memory worker pool | r6i.large | 5,500 | $540 K | $205 K |
| Spanner state store | — | 3 PB · 60M wps | $420 K | $420 K |
| DLQ + redis cache | cache.r6g.large | 30 | $7 K | $2.7 K |
| Cross-region egress | — | 4 Gbps | $15 K | $15 K |
| Total | — | ~19,000 nodes | $4.13 M/mo | $1.82 M/mo |

Cost composition Worker pools eat 87% of the budget — CPU pool alone is $2.7M/mo. Every saved millisecond of task wall time directly cuts hundreds of nodes. **Optimizing task code matters more than infrastructure choices at this scale.**

## 3 · Architecture [#](#arch) {#arch}

### 3.1 — Full architecture diagram

<img src="/diagrams/nalsd-task-queue/1.svg" alt="nalsd-task-queue diagram 1" class="doc-diagram" />

Fig 1 · Complete distributed task queue. Numbered circles match the step-by-step flow in §3.2. Producers enqueue through gateway → Kafka → scheduler routes to one of four specialized worker pools → success commits to Spanner, failure retries with backoff then DLQ.

### 3.2 — Step-by-step flow (the numbered walkthrough)

Following the numbered circles in Fig 1. Concrete example: **a Profile photo upload triggering a thumbnail-generation task.**

Producer enqueues the task

The Profile service finishes accepting the user's photo upload and needs to generate 5 thumbnail sizes. Instead of doing this inline (slow user response), it pushes a task to the queue.

POST /enqueue { task\_type: "image\_resize", payload: {blob\_id, sizes:\[…\]}, idempotency\_key: sha256(blob\_id+sizes), priority: "p1" }

budget · **50 ms** RPC size · **~400 B** tasks/sec · **10 M peak**

Gateway authenticates and dedupes

The enqueue gateway does four things in sequence, fast: (a) verify mTLS, (b) validate proto schema, (c) check per-tenant token bucket — if Profile service exceeds its quota, return 429, (d) **idempotency dedupe** via Spanner CAS — "insert (tenant\_id, idempotency\_key) if not exists." If the key exists, return the existing task\_id immediately — this kills duplicates from retried client requests.

Spanner CAS: INSERT INTO dedupe (tenant, key, task\_id, ts) ON CONFLICT RETURN existing.task\_id

budget · **50 ms p99** CAS latency · **~20 ms** rejected → **DLQ-0**

Task written to Kafka

Once deduped, the gateway writes to the appropriate Kafka topic. Partition is chosen as `hash(tenant_id) % partitions` — this keeps tasks from the same tenant ordered (useful when sequence matters) while spreading load across all partitions for parallelism. The task lands in `tasks.p1` because Profile thumbnails are standard priority.

topic = tasks.p1 · partition = hash(tenant\_id) mod 512 · ACK = all (durability)

budget · **30 ms** replication · **3×** retention · **7 days**

Scheduler routes to the right worker pool

Scheduler instances continuously consume from Kafka. For each task, the scheduler looks at `task_type` and routes:  
• `image_resize`, `transcode` → **CPU pool**  
• `send_email`, `http_webhook` → **I/O pool** (mostly waiting on network — pack densely)  
• `run_inference`, `rank_feed` → **GPU pool**  
• `join_dataset`, `enrich_profile` → **Memory pool**  
The scheduler doesn't execute the task — it places it onto a per-pool work queue with a lease token.

routing table: task\_type → pool · delayed tasks held in scheduler memory until ready · cron expressions evaluated per-tick

budget · **200 ms** worker pools · **4 specialized** scheduler instances · **40 stateless**

Worker claims the task with a lease

A CPU pool worker pod picks up the image\_resize task. **It doesn't acquire a distributed lock** — it acquires a *lease* via a Spanner CAS: "set task.status = RUNNING, lease\_owner = me, lease\_expiry = now + 30s, only if status = PENDING." This is the key trick: no central lock manager, no split-brain. Two workers can race; only one wins the CAS.  
  
While running, the worker sends heartbeats every 10s renewing the lease ("extend lease by 30s if I still own it"). If the worker crashes, the lease expires after 30s and another worker can claim the task safely.

CAS: UPDATE tasks SET status='RUNNING', owner=$me, lease\_expiry=now()+30s WHERE id=$id AND status='PENDING'

budget · **1.5 s** (from enqueue) lease validity · **30 s** heartbeat · **every 10 s**

Worker executes — branches into success or failure

The worker runs the actual task logic — fetches the photo from blob store, runs ImageMagick to generate 5 thumbnails, uploads them back.  
  
**Success** (~99.9% of attempts): writes results, then conditional Spanner CAS marks the task DONE — *only if* status is still RUNNING and the lease is still valid. This prevents double-completion: if a sibling worker also claimed the task after lease expiry, only one of the two CAS writes will succeed; the other fails harmlessly.  
  
**Failure** (~0.1%): task throws an exception OR exceeds wall-time budget OR a downstream dependency circuit-breaks. The worker writes status = FAILED with retry\_count++. The scheduler picks it up and requeues with exponential backoff (1s, 2s, 4s, 8s, 16s, 32s). After N attempts (default 6), task is moved to DLQ.

success CAS: UPDATE tasks SET status='DONE', result=$r WHERE id=$id AND status='RUNNING' AND owner=$me  
failure: UPDATE tasks SET status='FAILED', retry\_count=retry\_count+1, next\_retry=now()+backoff

success rate · **99.9%** max retries · **6 (configurable)** backoff · **2^n seconds**

Visibility — state store and DLQ feed dashboards

All state transitions flow into Spanner: `PENDING → RUNNING → DONE/FAILED`. The Visibility API queries this for "what's the status of task X?" and tenant dashboards aggregate per-tenant counts. The DLQ has its own depth-growth alert — if DLQ depth grows faster than X/min, something is systemically broken (a vendor outage, a code regression) and oncall gets paged.  
  
Background control loops run continuously:  
• **Kafka consumer lag** feeds the HPA — if lag grows, scale up workers  
• **ML forecasting** pre-warms capacity 15 min ahead based on historical patterns (so 9am Profile traffic doesn't catch us cold-started)  
• **Lease sweeper** cleans up tasks whose owners died without releasing leases (edge case)  
• **Circuit breakers** to downstream dependencies (image-store, email vendor) fail fast and requeue with backoff rather than letting workers hang

background loops: lag→autoscale (1 min) · forecast (5 min) · lease sweep (1 min) · DLQ depth alert (any spike)

visibility freshness · **p95 5 s** DLQ retention · **14 days** forecast window · **15 min ahead**

### 3.3 — Lease mechanics close-up

Leases instead of locks is the key design choice. Here's how the timeline plays out:

<img src="/diagrams/nalsd-task-queue/2.svg" alt="nalsd-task-queue diagram 2" class="doc-diagram" />

Fig 2 · Lease lifecycle. Happy path (top): worker heartbeats every 10s; lease never expires; CAS marks DONE. Crash path (bottom): worker dies; lease expires; sweeper resets status to PENDING; another worker claims and completes. Side effects of partial execution are absorbed by idempotency at the application level.

### 3.4 — Exactly-once semantics (the subtle part)

Strictly, exactly-once delivery is impossible in distributed systems. What we offer is **at-least-once delivery + idempotent execution = exactly-once observable effect.** Three mechanisms cooperate:

1\. Producer idempotency at enqueue

Producer computes `idempotency_key = hash(inputs)` and sends it. Gateway CAS-inserts into dedupe table. Duplicate enqueue requests return the original task\_id without creating a second task.

defends againstretry storms on client

storage cost1 row per task in dedupe table

2\. Worker-side conditional commit at completion

Worker's final write is a CAS: "set DONE only if status=RUNNING and lease still mine." Two workers can't both succeed; one's write will be a no-op.

defends againstsplit-brain double commit

costone extra Spanner round-trip

3\. Application-level idempotency in task body

Task code uses the idempotency\_key as a natural key on side effects — e.g. thumbnail filename is `thumb_{key}.jpg`. Even if the task runs twice (B partial + C full), the result is the same file in blob store.

defends againstretry-after-crash

costapp developers must write idempotent code

What we can't guarantee honest limits

If a task sends an external email and crashes after the SMTP send but before the CAS commit, the email is sent — and on retry, it sends again. **Workers must use idempotent external APIs** (e.g. SendGrid's X-Message-Id) for true exactly-once with side effects.

mitigationdocument the constraint clearly

costintegration complexity per task type

The senior insight Exactly-once is a property of *the system including the task code*, not the queue alone. Selling "exactly-once delivery" without explaining this is misleading. We sell "at-least-once + idempotency primitives" and let task authors compose them.

## 4 · Failure gauntlet [#](#gauntlet) {#gauntlet}

A · Worker pool saturation SLI: A, B

A Feed launch dumps 50M tasks in 5 minutes — CPU pool can't scale fast enough.

triggerKafka consumer lag > 60 s

absorbHPA scales 10k → 20k in 5 min

overflowKafka 7d retention buffers

verdictlag drains in 20 min · 0 loss

B · Worker mass crash SLI: A, C

A bad task crashes 30% of CPU pods in a few minutes.

triggerpod restart rate > baseline 10×

absorblease expiry → reclaim by healthy workers

capcircuit-break the bad task type

verdicthealthy tasks unaffected · bad → DLQ

C · Spanner hot-key contention SLI: A

One tenant uses constant idempotency\_key prefix; CAS row becomes hot.

triggerSpanner CAS p99 > 200 ms

absorbhash-prefix the dedupe key

capper-tenant rate limit on enqueue

verdictCAS p99 → 35 ms

D · Region outage SLI: B, E

us-west-2 power event takes the region offline 45 min.

trigger−35% capacity

absorbGSLB → iad in 5 s

recoverMM2 replay backlog when up

verdictqueued tasks delayed not lost

E · DLQ flood SLI: C

SendGrid outage → 100% of I/O tasks fail → DLQ grows 1k/sec.

triggerDLQ depth growth alert

absorbcircuit-break I/O pool to SendGrid

repairauto-replay when vendor recovers

verdict0 tasks lost · all replayable

F · Slow consumer poisons partition SLI: A, B

One worker hangs on a single partition, blocking head-of-line for that tenant.

triggerpartition lag > 5 min

absorblease expiry forces reclaim

capper-partition consumer health check

verdictresolved in < 1 min

Not defended against (explicit) Loss of Spanner for > 5 min globally — that would block all CAS operations and halt the queue. Mitigation is "Spanner has its own 4-nines SLO; rely on it." For longer outages, manual escalation + read-only degraded mode.

## 5 · Operational playbook [#](#playbook) {#playbook}

### 5.1 — Deployment

| Stage | % traffic | Soak | Auto-promote |
| --- | --- | --- | --- |
| Shadow worker | mirror, 0% commit | 24 h | diff vs prod < 0.01% |
| Canary | 1%, 1 region | 24 h | p99 latency Δ < 5% |
| Regional | 10%, 1 region | 12 h | SLO burn < 1× |
| Half | 50% | 6 h | no SEV-2+ open |
| Global | 100% | — | manual sign-off |

### 5.2 — Chaos drills (quarterly)

-   **Worker mass kill** — terminate 50% of CPU pool; verify lease expiry → reclaim within 60s.
-   **Region kill** — drain pdx region; verify GSLB failover and worker re-balance.
-   **Spanner latency injection** — add 200 ms to all CAS; verify gateway falls back to "best-effort" and SLO-E holds.
-   **Bad task injection** — emit task that always panics; verify backoff escalation and DLQ landing.
-   **DLQ depth spike** — push 100k DLQ entries; verify alerting and replay tooling.
-   **Kafka broker loss** — kill 3 brokers; verify partition rebalance and continued enqueue.

### 5.3 — Runbook excerpt

```
# Symptom: SLI-B (p99 latency) burning > 5× / 1h

# Likely causes, ranked
1. Worker pool saturation     → check Kafka consumer lag per topic
2. Spanner CAS p99 spike      → check Spanner monitoring console
3. Bad task type circuit open → check circuit breaker dashboard
4. Cross-region replication   → check MM2 lag

# First response (in order):
- Confirm: dashboard 'slo-b-latency' shows > 10s p99 over 5 min
- Identify hot pool: check lag-per-pool dashboard
- Scale: kubectl scale deployment worker-${pool} --replicas=$((current*2))
- Communicate: post in #incident-taskqueue with hypothesis
- Escalate: if not resolving in 15 min, page tier-2 oncall
```

## 6 · Component reference [#](#components) {#components}

| Component | Tech | Scale | Failure mitigation | SLO |
| --- | --- | --- | --- | --- |
| **Enqueue gateway** | Envoy + Go | HPA 30→200 | circuit breaker · token bucket | A,E |
| **Kafka cluster** | Kafka 3.7 · MM2 | partition rebalance | 3× repl · cross-region async | C,E |
| **Scheduler** | Go service | stateless · LB fanout | checkpoint Kafka offsets | A,B |
| **CPU worker pool** | K8s + HPA | 1k → 20k pods | lease + restart | A,B |
| **I/O worker pool** | K8s + HPA | dense pod packing | circuit breaker per vendor | A,B,C |
| **GPU worker pool** | K8s + GPU nodes | batched inference | fallback to CPU pool | B |
| **Memory worker pool** | K8s + RAM nodes | large heap workers | OOM kill → requeue | B |
| **State store** | Spanner | region-replicated | bounded staleness reads | A,B,D |
| **DLQ** | Kafka topic | per-tenant partition | depth-growth alert · auto-replay | C |
| **Visibility API** | Go + Spanner | read replicas | cached responses | D |

## 7 · Trade-offs & open questions [#](#tradeoffs) {#tradeoffs}

#### Chose

-   **Leases over locks** · no distributed lock manager, no split-brain. Trade: duplicate execution possible (mitigated by idempotency).
-   **4 specialized pools** over 1 generic pool · packing efficiency (I/O pods at 200 concurrent vs CPU at 4). Trade: more complex routing.
-   **Spanner** for state · serializable CAS is non-negotiable for exactly-once. Trade: $$, hot-key contention risk.
-   **Kafka + scheduler** over direct producer → worker · durable replay window is the safety net. Trade: enqueue latency.
-   **Exponential backoff** 1s/2s/4s/8s/16s/32s · gives downstream time to recover. Trade: long tail on transient failures.
-   **3 priority tiers (p0/p1/p2)** over flat queue · critical paths bypass batch backlog. Trade: starvation risk on p2.

#### Rejected

-   **Redis lists** as queue · simple but no durability. One Redis failure = lost work.
-   **SQS / Cloud Tasks** · works but vendor-locked + can't tune CAS semantics ourselves.
-   **Single global cluster** · simpler but ties availability to one region.
-   **Single worker pool** · pads everything to worst-case resource shape; ~40% waste.
-   **Synchronous Spanner write on every step** · would cost 2× CAS per task. We batch where possible.
-   **Push instead of pull** · scheduler-push is simpler but loses backpressure semantics — workers must pull.

### Open questions

1.  Should we expose **workflow / DAG semantics** on top of single tasks? Many use cases (image upload → resize → notify) chain 3 tasks. Workflow primitive could simplify task authoring.
2.  Is 30s lease validity right? Some tasks legitimately take 5+ min (large ML inference) — currently they must extend lease constantly. Consider per-task-type lease length.
3.  Per-tenant fair queuing — currently all tenants share partitions weighted by hash. Should we add explicit fair-share scheduling for noisy-neighbor cases?
4.  Should DLQ replay be self-service per tenant or always require oncall review? Self-service is faster but riskier.
