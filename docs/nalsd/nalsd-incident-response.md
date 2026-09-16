---
title: "Global Incident Response"
slug: /nalsd/nalsd-incident-response
sidebar_position: 10
sidebar_label: "Global Incident Response"
description: "Global Incident Response"
---
in

in/incident

v2026.05 · nalsd

in/incident/ design-docs/ 2026/ global-incident-response.md

A NALSD walkthrough — the layer between "something fired an alert" and "the right human gets paged with context." 5 M alerts/day, p99 delivery in 30 s, 5 nines reliability, semantic correlation to collapse 10,000 related alerts into 1 actionable page.

NALSD deliver < 30s 99.999% reliability 5M alerts/day draft · review last edit · 2026-05-12 · sjc

## 1 · Problem statement & SLO contract

At LinkedIn scale, monitoring systems (Prometheus, Stackdriver, Datadog) fire alerts non-stop. During a real incident, **one root cause produces thousands of correlated symptoms** — DB CPU spike fires, then query latency, then API errors, then user-facing 5xxs, then customer-support pages. If we forward all of them to PagerDuty, we get an **alert storm** that drowns the on-call. The Global Incident Response system is the brain between the raw alert torrent and the human on-call: it dedupes, correlates root causes, prioritizes, and delivers with redundancy across channels.

Daily alerts (in)

5 M

~60/sec avg · 1k/sec storm

Daily pages (out)

~3 K

post dedupe + correlate

Delivery

< 30 s

p99 alert → on-call

Reliability

99.999%

5 nines delivery

### SLO contract

| SLI | Target | Measurement | Error budget / 28d |
| --- | --- | --- | --- |
| **A · Delivery latency** | p99 ≤ 30 s | ingress → notification ACK | ~24h with >30s |
| **B · Delivery reliability** | ≥ 99.999% | delivered / offered (P0/P1 alerts) | ~5 in 10⁶ lost |
| **C · Dedupe accuracy** | ≥ 99.5% | identical-alert collapse rate | 0.5% leak through |
| **D · ACK propagation** | ≤ 10 s global | ack click → all regions consistent | configurable |
| **E · System availability** | ≥ 99.99% | controller API uptime | ~4 min/month |

The hardest one — 5 nines 99.999% delivery reliability means *~5 lost pages per million*. This is harder than the monitoring pipeline's 99.95% because a missed page = humans don't know about an outage. It demands multi-region active-active + multi-channel fallback (PagerDuty → SMS → Slack → mobile push). No single vendor or region failure can prevent delivery.

## 2 · Capacity model (the NALSD math)

### 2.1 — Alert ingestion rate

#### Throughput at the alert gateway

```
daily alerts ingested        = 5,000,000
sustained avg                = 5M / 86,400 s = 58 alerts/s
peak (storm factor 20×)      = 1,160 alerts/s ≈ 1 K/s
absolute worst (region-wide) = 10,000 alerts/s (cascading outage)

avg alert payload (JSON):
  fingerprint (sha256)          = 64 B
  service · severity · tenant   = 40 B
  source (prom/sd/dd)           = 16 B
  labels (map of 10 KV pairs)   = 200 B
  annotation (human description)= 280 B
  metadata + timestamp + trace  = 100 B
  ─────────────────────────────────
  avg alert size                = 700 B

ingest bytes/sec at peak = 1,160 × 700 = 812 KB/s ≈ 6.5 Mbps
absolute worst case      = 10,000 × 700 = 7 MB/s ≈ 56 Mbps

per region (5 regions, weighted 35/25/20/12/8):
us-west-2 peak               = 1,160 × 0.35 = 406 alerts/s
```

VERDICT · Volume is TINY by data-pipeline standards. 6.5 Mbps peak. Reliability matters far more than throughput here.

#### Gateway capacity

```
per-gateway capacity        = 2,000 alerts/s (Go service, validation + dedupe lookup)
gateways needed at peak     = 1,160 / 2,000 = 1 (rounded to 3 per region for N+2)
fleet across 5 regions      = 15 gateway instances

absolute worst case (10k/s):
  needs 5 gateways/region   → HPA scales 3 → 8 in 30 s
```

VERDICT · 15 gateways base, scales to ~40 during major incidents.

### 2.2 — Deduplication math

#### How much does dedupe save?

```
raw alert volume / day            = 5,000,000
empirical dedupe ratio (measured) = ~95%
  → 5,000,000 × 0.95 = 4,750,000 dedup'd
  → 5,000,000 × 0.05 = 250,000 unique alerts/day

after correlation grouping (composite alerts):
  ~10× reduction on top of dedupe (clustering by root cause)
  → 250,000 / 10 = 25,000 alert groups/day

after priority routing (P2/P3 → ticket, not page):
  P0/P1 (pageable) ≈ 12% of groups
  → 25,000 × 0.12 = 3,000 pages/day

so the funnel is:
  5,000,000  raw alerts (incoming firehose)
    250,000  unique after dedupe              (20× reduction)
     25,000  alert groups after correlation   (10× reduction)
      3,000  actual human pages               (8× reduction)

aggregate noise reduction: 5,000,000 / 3,000 = 1,667× compression
```

VERDICT · The funnel turns a firehose of 5M alerts into 3K actionable pages. This is the entire point of the system.

#### Dedupe cache sizing

```
active fingerprints in cache:
  rolling window           = 15 min (alert flap protection)
  unique alerts in 15 min  = 250k/day × (15/1440) = 2,600
  with cache overhead 3×   = ~8,000 active entries
  per-entry size           = 256 B (fingerprint + meta + count)
  total cache size         = 2 MB  ← fits easily in any Redis

Redis ops/sec:
  reads (every alert checks dedupe) = 1,160 reads/s peak
  writes (new alert, count update)  = ~60 writes/s
  Redis single instance handles 100k ops/s → 1000× headroom
```

VERDICT · Redis dedupe layer is trivial. 2 MB cache, < 1k ops/s peak.

### 2.3 — Correlation engine (causality)

#### Service dependency graph size

```
services at LinkedIn         = ~500
avg dependencies per service = 8
graph edges                  = 500 × 8 = 4,000 directed edges
graph storage                = 4,000 × 200 B = 800 KB total
  → fits in memory of every correlation worker

correlation query per alert:
  1. lookup alert's service in graph        =  1 ms
  2. fetch downstream services (BFS depth 2)= 10 ms
  3. check active alerts in those services  = 20 ms (Redis MGET)
  4. score correlation strength             =  5 ms
  ──────────────────────────────────────────────
  total per alert                            = 36 ms

correlator capacity per node = 1000/36 = 28 alerts/s
fleet at peak (1,160 alerts/s) = 1,160 / 28 = ~42 workers
with N+2 + cross-region buffer = 50 correlator nodes
```

VERDICT · 50 correlator workers handle peak with headroom. Graph fits in RAM — no DB lookup per alert.

### 2.4 — Fleet summary & cost

| Tier | Instance | Count | $/mo (on-demand) | $/mo (3y RI) |
| --- | --- | --- | --- | --- |
| Alert gateway | m6i.large | 15 | $1.3 K | $0.5 K |
| Kafka brokers | i4i.large | 9 | $5 K | $1.9 K |
| Dedupe engine | m6i.large | 12 | $1 K | $0.4 K |
| Correlator | m6i.xlarge | 50 | $8.7 K | $3.3 K |
| Routing service | m6i.large | 15 | $1.3 K | $0.5 K |
| Notifier (multi-channel) | m6i.large | 18 | $1.6 K | $0.6 K |
| Redis (dedupe cache) | cache.r6g.large | 9 | $2 K | $0.8 K |
| Spanner (state store) | — | 3 nodes | $12 K | $12 K |
| Audit Kafka + archive | i4i.large + S3 | 6 + 1 TB | $3.5 K | $1.4 K |
| Notification vendor cost | PagerDuty + Twilio | — | $25 K | $25 K |
| Total | — | ~134 nodes | $61 K/mo | $46 K/mo |

Cost note Notice **40% of cost is vendor APIs** (PagerDuty, Twilio SMS, etc.) not infrastructure. Compute is cheap; reliable notification delivery to humans is expensive. Worth it — a missed page can mean a multi-hour outage.

## 3 · Architecture

### 3.1 — Full architecture diagram

<img src="/diagrams/nalsd-incident-response/1.svg" alt="nalsd-incident-response diagram 1" class="doc-diagram" />

Fig 1 · Complete global incident response system. Numbered circles map to the step-by-step flow in §3.2. The funnel is the entire story: 5M alerts → 250K dedup'd → 25K composite groups → 3K actionable pages → 1 paged engineer per incident.

### 3.2 — Step-by-step flow (the numbered walkthrough)

Following the numbered blue badges in Fig 1. Concrete example: **the Profile DB has a CPU spike. Within 90 seconds, 12,000 related alerts fire across 8 dependent services. The on-call engineer receives exactly ONE page that says "Profile DB CPU high (root cause), 8 downstream services affected."**

Alert sources fire webhooks

Profile DB's Prometheus instance evaluates a rule: `node_cpu_usage{service="profile-db"} > 90% for 1m`. The rule fires and Prometheus posts an alert webhook to our gateway. Simultaneously, Datadog (which monitors the same DB from outside) fires its own alert for the same condition. Stackdriver fires another for downstream API error rate climbing.  
  
Each source posts an HTTPS webhook with its own payload schema — Prometheus uses its native format, Datadog uses its own JSON, Stackdriver uses GCP's structure. The system accepts all of them.

POST /v1/alert · TLS · auth header · body: {fingerprint, service, severity, labels, annotations}

sources · **Prom · Stackdriver · Datadog · custom** avg payload · **700 B** peak rate · **~1k alerts/s**

Alert gateway authenticates, normalizes, enriches

The gateway does five things in sequence: (a) **verify mTLS** or webhook auth header, (b) **rate-limit** per source (one buggy Prometheus rule can't drown the system), (c) **schema normalize** — translate each source's format to our common alert schema, (d) **schema validate** — bad payload → DLQ-0, (e) **enrich** with team owner (from service registry), runbook URL, related dashboards, recent deploys.  
  
Output: a uniform alert event regardless of source. This is the contract that makes everything downstream simple.

verify\_auth() → rate\_limit(source) → normalize\_to\_common\_schema() → enrich(team\_owner, runbook) → kafka.produce(raw-alerts)

budget · **50 ms p99** fleet · **15 nodes · HPA to 40** rejected → **DLQ-0**

DLQ catches malformed alerts

Auth failures, schema mismatches, oversize payloads, and over-quota tenants land in DLQ-0. The DLQ has its own **depth-growth alarm** — if it grows faster than 10/sec, something is systematically broken (a new monitoring system mis-configured, or an attacker probing endpoints) and SRE gets paged.  
  
Valid-but-flagged alerts can be replayed after a manual schema fix; truly bad ones (auth fail) are purged after 7 days.

retained 7 days · auto-replay on schema fix · depth-growth alert at 10/s

retention · **7 days** replay · **self-service via API** audit · **every rejection logged**

Kafka durably buffers raw alerts

Normalized alerts land in the `raw-alerts` Kafka topic. Partitioned by `hash(service + fingerprint)` so alerts about the same condition land on the same partition — gives deterministic ordering for dedupe downstream.  
  
**Why Kafka here:** alerts must NEVER be lost. If the dedupe/correlation/notifier pipeline crashes, alerts queue in Kafka with 7-day retention. We can replay everything once the downstream is healthy. This is what unlocks 5-nines reliability.

topic: raw-alerts · partition: hash(service + fingerprint) · ACK: all · 3× replication

brokers · **9 · 3× repl** retention · **7 days (replay window)** budget · **500 ms**

Deduplication engine collapses identical alerts

For our Profile DB example: Prometheus + Datadog + Stackdriver all fire alerts with effectively the same fingerprint (`profile-db-cpu-high`). The dedupe engine looks up the fingerprint in Redis (15-min rolling window). First arrival → cache miss → forward, mark "active." Second arrival within 15 min → cache hit → increment count, drop the alert (but track that it fired).  
  
For the storm scenario (12,000 alerts in 90 s), most are dedup'd to a few hundred unique fingerprints. Storm prevention also caps each service at 10 unique alerts/min — if a service emits 50 unique fingerprints in 1 minute, the system suppresses the excess and emits one meta-alert "service X is in storm state."

redis.SET fingerprint NX EX 900 → if exists: INCR count, drop; else: forward to correlator

window · **15 min rolling** reduction · **~20× (5M → 250K)** storm cap · **10/min per service**

Correlation engine groups by causality

This is the **staff-level magic**. Each unique alert enters the causality engine, which does three things:  
  
(a) **Service dependency lookup:** "What depends on profile-db?" → returns \[profile-api, search, feed-ranker, ...\] via BFS on the dependency graph.  
  
(b) **Temporal correlation:** When the Profile DB alert fires at T, the engine opens a 60-second window. Any alerts arriving in \[T, T+60s\] from *downstream* services are topologically tagged as "likely caused by profile-db incident."  
  
(c) **Composite alert generation:** Instead of forwarding 8 separate alerts, the engine emits ONE enriched composite:  
  
*\[P0\] Profile DB CPU high — root cause*  
*Downstream impact: API frontend (high error rate), Search (high latency), Feed-ranker (5xx spike)*  
  
The on-call engineer now sees ONE actionable page with the causal chain laid out, not a flood of symptoms.

depends\_on(profile-db) → \[api, search, feed-ranker\] · within 60s window: group as composite · emit single P0 with full impact list

graph edges · **~4000 in memory** temporal window · **60 s** reduction · **~10× (250K → 25K)**

Priority + routing assigns severity and on-call

The composite alert needs a severity and a destination. The routing service:  
  
(a) Looks up severity in the SLO config — Profile DB has SLO of 99.95% availability; CPU saturation that affects availability = P0 = page immediately.  
(b) Resolves the on-call rotation for the Profile platform team via the on-call scheduler (Profile platform's on-call right now is "bob@" in eu-west region; primary contact = phone + PagerDuty).  
(c) Applies any business-hour or timezone rules (e.g. P2 alerts during business hours only; outside business hours they wait until morning).  
(d) Outputs the routing decision: `{composite_id, severity: P0, recipients: [bob@, escalation: alice@], channels: [pagerduty, sms, slack]}`.

slo\_lookup(service) → severity · oncall\_scheduler.who(team, now) → recipient · tz\_check → channels

P0 (page immediately) · **~12%** P1 (page in 5min) · **~8%** P2/P3 (ticket only) · **80%**

Multi-channel notifier delivers with fallback chain

The notifier dispatches the page across multiple channels in parallel for P0/P1:  
  
**Primary:** PagerDuty API call → bob's phone rings within 5 s. If PagerDuty returns 5xx or no ACK in 15 s → try secondary.  
**Secondary:** Slack DM with action buttons (ACK / Escalate / Resolve). If no response in 15 s → try fallback.  
**Fallback:** SMS via Twilio + push notification + (for P0 only) phone call via Twilio Voice.  
  
The delivery strategy is configurable per severity. For P0, all three layers fire in parallel — redundancy beats sequential retries when seconds matter. For P2/P3 ticket-only, just Slack DM.  
  
**5-nines reliability** comes from this redundancy: no single vendor failure (PagerDuty outage, Twilio API issues) prevents delivery.

P0 fanout: parallel\[pagerduty, slack, sms\] · ACK from any wins · retry chain if all fail

budget · **20 s (most of the 30s SLO)** vendor cost · **$25K/mo** delivery confirmation · **per channel**

State store tracks alert lifecycle globally

Every state transition is written to Spanner: `FIRING → ACKNOWLEDGED → RESOLVED` (or `ESCALATED → SUPPRESSED`). Why Spanner? Because **global ACK propagation** within 10 s is required (SLI-D) — when bob clicks "ACK" in PagerDuty, the same alert in Slack must show "Acked by bob" within 10 s, regardless of which region bob is in.  
  
For ACK conflict resolution (two engineers click ACK simultaneously from different channels), the state store uses **CRDTs** (conflict-free replicated data types) — both ACKs are recorded; whoever fires first wins the "primary acker" status; the other is logged as co-responder. No human-visible race condition.

spanner.cas(alert\_id, state="ACKED", acker=bob, ts=now) WHERE state="FIRING" · CRDT merge for concurrent updates

Spanner nodes · **3 region-replicated** ACK propagation · **p95 5 s · p99 10 s** states tracked · **5 lifecycle**

Audit + analytics close the loop

Every event (alert received, dedup'd, correlated, routed, delivered, acked, resolved) flows into the audit Kafka topic with 1-year retention. The analytics pipeline computes:  
  
• **Time-to-acknowledge** per team — slow ACK = on-call training issue  
• **MTTR** — mean time to resolve, per service  
• **False-positive rate** — alerts that were ACKed but never investigated → tune dedupe/correlation thresholds  
• **Channel success rate** — if Twilio fails 0.5%, we know to budget for it  
• **Team scoreboard** — surfaces ops health to engineering leadership  
  
Crucially, this feedback loop tunes the correlation engine: if "Profile DB CPU high" + "API error rate" co-occur 95% of the time, the engine raises its confidence in linking them.  
  
**Total wall-clock time from first alert fire to bob seeing the composite on his phone: ~12 seconds.** Inside the 30 s SLO with 18 s margin.

analytics pipeline: time\_to\_ack · MTTR · FP rate · channel success · feedback loop tunes correlation thresholds

e2e typical · **~12 s** e2e p99 · **~25 s** SLO target · **p99 ≤ 30 s ✓ 18s headroom**

The key design insight Every box in this system exists to **reduce cognitive load on the on-call human**. Dedupe kills duplicates; correlation kills symptoms-of-the-same-cause; priority kills noise; redundant channels ensure the one alert that matters reaches them. The system processes 5M alerts/day so that *one engineer at 3 AM sees one page*. Empathy for the operator is the design principle.

### 3.3 — Causality engine close-up (the staff-level differentiator)

Below is the dependency graph snippet for the Profile DB scenario. The causality engine traverses this in 60-second windows to group correlated alerts.

<img src="/diagrams/nalsd-incident-response/2.svg" alt="nalsd-incident-response diagram 2" class="doc-diagram" />

Fig 2 · Causality graph for the Profile DB incident. One root cause → 4 depth-1 services → 5 depth-2 services, 10 services total. Without correlation, on-call would receive 10+ separate pages. With correlation, ONE composite page with the full impact tree.

| Without correlation | With correlation |
| --- | --- |
| 10 pages, 10 different services, on-call must mentally re-construct the dependency chain. | 1 page with title "\[P0\] Profile DB CPU high — root cause" and impact tree visible. |
| Time to root cause identification: 10–30 minutes. | Time to root cause identification: instant (it's in the page title). |
| 10 separate ack actions, possibly to different on-calls. | 1 ack closes the composite; downstream pages auto-suppress. |
| Alert fatigue → next outage's pages get ignored. | Each page is high signal → on-call trusts them. |

### 3.4 — Delivery fanout strategy

For P0/P1, parallel fanout across channels. For lower severity, sequential. This is what unlocks 5-nines.

| Severity | Primary | Secondary (15s later if no ACK) | Fallback (30s later) | Escalation (5min if still no ACK) |
| --- | --- | --- | --- | --- |
| P0 page now | PagerDuty + SMS + Slack (parallel) | Phone call | Backup on-call | Manager + tier-2 |
| P1 page 5min | PagerDuty | Slack | SMS | Backup on-call |
| P2 ticket | Slack channel | Email digest (next morning) | — | — |
| P3 metric | Dashboard only | — | — | — |

Why parallel for P0 Sequential delivery (PD → wait 15 s → SMS → wait 15 s → call) would consume 30+ seconds before fallback fires — eating the entire SLO. Parallel fire means whichever channel succeeds first gets the ACK; the others are cancelled. This is the difference between "the on-call gets paged within 30 s" and "we deliver the page eventually" — only the first matters during a real outage.

## 4 · Failure gauntlet

A · Alert source flood SLI: A, E

A buggy Prometheus rule fires 10k alerts/sec from one cluster.

triggerper-source rate > 100/s

absorbgateway rate limit kicks in

collapsededupe → ~1 alert/min

verdictpipeline unaffected · source notified

B · PagerDuty outage SLI: B

PagerDuty API returns 5xx for 20 min.

triggerPD success rate < 95% over 1 min

absorbcircuit-break PD, route to SMS+Slack

recoverreplay queued PD alerts on recovery

verdict0 missed P0 pages

C · Region outage SLI: B, E

us-west-2 power event takes the region offline 45 min.

triggerregion health probe fail

absorbGSLB redirects to iad/dub in < 10 s

replayMM2 backfills on recovery

verdictalerts delayed not lost

D · Correlation engine wrong SLI: C

Engine groups unrelated alerts (false correlation).

triggerFP rate > 5% over 7 days

absorbfall back to dedup-only (no correlation)

repairretrain correlation model offline

verdictextra pages but no missed ones

E · Spanner ACK divergence SLI: D

Two engineers ACK the same alert from different regions simultaneously.

triggerconcurrent ACK timestamps within 1 s

absorbCRDT merge: both recorded, first wins primary

auditboth visible in incident log

verdictno race · clean audit

F · On-call asleep SLI: B

P0 fires, primary on-call doesn't ACK within 5 min.

triggerno ACK after 5 min on P0

escalatebackup on-call + manager paged

escalate 2tier-2 + executive at 15 min

verdictincident always reaches someone

Cannot defend against Simultaneous outage of **all notification vendors** (PagerDuty + Twilio + Slack at the same time). This is an external dependency we can't control. Mitigation: monitor vendor health independently; if > 2 are down, on-call dashboards show "DEGRADED — call manually" mode.

## 5 · Operational playbook

### 5.1 — Deployment (canary)

| Stage | % traffic | Soak | Auto-promote |
| --- | --- | --- | --- |
| Shadow | mirror, 0% delivery | 48 h | diff vs prod < 0.1% |
| Canary | 1% alert traffic | 24 h | delivery latency Δ < 5% |
| Regional | 10% (1 region) | 12 h | SLO burn < 1× |
| Half | 50% | 6 h | auto if no SEV-2+ |
| Global | 100% | — | manual sign-off |

### 5.2 — Chaos drills (quarterly)

-   **PagerDuty kill** — simulate PD 100% 5xx; verify SMS+Slack fallback within 30 s.
-   **Region kill** — drain primary region; verify GSLB failover.
-   **Alert storm injection** — emit 50k synthetic alerts/min; verify dedupe + storm cap.
-   **Bad correlation model** — push a model that miscorrelates; verify auto-rollback.
-   **Sleeping on-call drill** — simulate primary not ACKing P0; verify escalation chain.
-   **Audit replay** — replay 24 h of audit log; verify state reconstruction matches Spanner.

### 5.3 — Runbook excerpt

```
# Symptom: SLI-A burning — alerts delivered > 30 s

# Likely causes (ranked)
1. PagerDuty API latency       → check vendor status dashboard
2. Correlation engine lag      → check correlator Kafka lag
3. Spanner CAS contention      → check Spanner monitoring
4. Notifier rate limited       → check per-channel success rates
5. Gateway HPA not scaling     → check pod count vs alert rate

# First response (in order):
- Confirm: dashboard 'slo-a-delivery' shows > 30 s p99
- Scale correlator: kubectl scale ... --replicas=2x
- Check vendor health: status.pagerduty.com, status.twilio.com
- If vendor down: circuit-break and rely on fallback
- Communicate: #incident-response with hypothesis
- Escalate: tier-2 oncall if not resolving in 15 min
```

## 6 · Component reference

| Component | Tech | Scale | Failure mitigation | SLO |
| --- | --- | --- | --- | --- |
| **Alert gateway** | Go service | HPA 15→40 | circuit breaker · DLQ | A,E |
| **Kafka raw-alerts** | Kafka 3.7 | 500 partitions | 3× repl · MM2 | B,E |
| **Dedupe engine** | Go + Redis | 12 nodes stateless | cache rebuild on miss | C |
| **Correlator** | Go + in-mem graph | 50 nodes | fallback to dedup-only | C |
| **Routing service** | Go service | stateless · LB | cached on-call schedules | A |
| **Notifier** | Go · multi-vendor | priority queue | vendor fallback chain | A,B |
| **State store** | Spanner | 3 nodes region-replicated | CRDT for ACK conflicts | D,E |
| **Audit Kafka** | Kafka topic | per-tenant partition | 3× repl · GCS archive | — |
| **On-call scheduler** | Go + Spanner | read replicas | cached for 1 hour | A |
| **Dashboard** | React + WebSocket | CDN | cached state | — |

## 7 · Trade-offs & open questions

#### Chose

-   **Semantic correlation** over dedup-only · cuts on-call cognitive load 10×; trade: false-correlation risk.
-   **Parallel multi-channel delivery** for P0 · 5-nines reliability; trade: vendor cost ($25K/mo).
-   **Spanner + CRDTs** for ACK state · global consistency in < 10 s; trade: $$.
-   **Service dependency graph in RAM** · sub-ms BFS lookups; trade: 50 nodes carry duplicated graph.
-   **60-second correlation window** · catches downstream propagation; trade: 60 s extra alert latency for correlated alerts.
-   **P0 escalation chain** · always reaches a human; trade: ladder takes 15+ min in worst case.

#### Rejected

-   **Single notification channel** · simpler but can't hit 5 nines.
-   **Dedup-only (no correlation)** · works but on-call drowns during real outages.
-   **Custom on-call/escalation** · "build vs buy" — PagerDuty does this well, partner with them.
-   **ML model for severity classification** · risky; rule-based + SLO config is auditable.
-   **Synchronous cross-region Kafka** · would tank latency; async MM2 with replay is enough.
-   **"Smart suppress" of P3 alerts during outages** · could hide useful signal; we let them flow.

### Open questions

1.  Should the correlation engine support **cross-team dependencies**? Currently dependencies are per-service; should we model "the Profile team depends on the Platform team's auth service" at the team level for org-level views?
2.  How do we handle **maintenance windows**? Some teams want to suppress paging during planned work, but P0 should always fire. Currently we have a binary "suppress all" switch — too coarse.
3.  Should we offer **"self-resolved" auto-detection**? If an alert stops firing for 5 min, mark it resolved automatically. Risk: hides flapping issues.
4.  Should the system support **tenant-specific delivery preferences**? E.g. some teams want everything to Slack first, others want PagerDuty first. Currently severity-driven only.
