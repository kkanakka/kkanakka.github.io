---
title: "SLO Error Budget Tracker"
slug: /nalsd/nalsd-slo-tracker
sidebar_position: 8
sidebar_label: "SLO Error Budget Tracker"
description: "SLO Error Budget Tracker"
---
in

in/slo-tracker

v2026.05 · nalsd

in/slo-tracker/ design-docs/ 2026/ slo-error-budget-tracker.md

A NALSD walkthrough — the backend brain that watches every service's reliability budget and decides when product teams must pivot from features to fixes. Multi-window burn-rate alerting, 99.99% computation accuracy, alert delivery in < 5 minutes.

NALSD compute < 60s 99.99% accuracy 5,000 SLOs tracked draft · review last edit · 2026-05-12 · sjc

## 1 · Problem statement & SLO contract

Every service at LinkedIn has SLOs: Feed homepage at 99.95% availability, InMail delivery at 99.9%, Search results in < 500ms p95. An **error budget** is the inverse: 0.05% / 0.1% / 5% of allowed badness per 30 days. The tracker is the system that **continuously computes how much of each budget has been consumed** and decides when to alert. When the budget is green, product teams ship features freely. When it goes red, engineering pivots to reliability work. The tracker is therefore a **data-driven contract between product and reliability**, not just a dashboard.

SLOs tracked

~5,000

across 500 services

Compute latency

< 60s

p95 SLI → SLO state

Accuracy

99.99%

data consistency

Alert delay

< 5 min

burn threshold → page

### SLO contract (for the tracker itself)

The senior move: define SLOs for the SLO tracker. Eating your own dogfood — the tracker is instrumented as ruthlessly as a user-facing service.

| SLI | Target | Measurement | Error budget / 28d |
| --- | --- | --- | --- |
| **A · Compute latency** | p95 ≤ 60 s | SLI emit → SLO state updated | ~24h of >60s |
| **B · Computation accuracy** | ≥ 99.99% | data consistency on replay | ~1 in 10⁴ errors |
| **C · System availability** | ≥ 99.99% | API uptime, queryable state | ~4 min/month |
| **D · Alert delay** | < 5 min p95 | burn threshold → page delivered | ~24h with >5min |
| **E · Alert precision** | ≥ 95% | actionable / total pages | ~5% noise allowed |

Why this design exists Without an error-budget contract, every team negotiates "how reliable should we be?" continuously and politically. With it, the discussion becomes data-driven: *"We've burned 80% of the budget this month — features pause, reliability work starts."* The tracker is what makes that contract auditable.

## 2 · Capacity model (the NALSD math)

### 2.1 — SLI ingestion rate

#### SLI events per second across all tracked services

```
tracked services           ≈ 500
SLOs per service           ≈ 10 (avail, latency p50/p95/p99, errors, etc.)
total SLOs                 = 5,000

per-SLO event rate at ingestion:
  request-based SLIs (avail) = stream every request bucketed
                              ≈ 100,000 events/s per active service
  time-based SLIs (uptime)   = sampled per minute
                              ≈ 1 sample/min per SLO

aggregate ingest at peak:
  500 services × 100k events/s = 50,000,000 events/s = 50 M/s

→ this is the SAME monitoring stream from §monitoring doc
→ tracker is a CONSUMER, not a producer of telemetry
→ we read pre-aggregated SLI streams from Kafka, NOT raw signals

post-aggregation rate (1-min windows from upstream):
  5,000 SLOs × (1 / 60s) = 83 SLI samples/s entering the tracker
  with 6 window sizes (1m, 5m, 1h, 6h, 24h, 30d) computed
                       = 83 × 6 = 500 window updates/s
```

VERDICT · Tracker is a thin layer on top of monitoring. Ingest is ~500 updates/s — trivial volume.

### 2.2 — Window state size

#### How much state must we keep in memory?

```
per-SLO state for each window:
  good_events count        =  8 B
  total_events count       =  8 B
  slo_target (config)      =  8 B
  budget_remaining ratio   =  8 B
  burn_rate (current)      =  8 B
  last_updated_ts          =  8 B
  ─────────────────────────────
  per (SLO, window) state  = 48 B

6 windows per SLO × 5,000 SLOs = 30,000 (SLO, window) cells
total state in memory          = 30,000 × 48 B = 1.4 MB

with all historical points retained 30 days at 1-min granularity:
  5,000 SLOs × 6 windows × 60 × 24 × 30 = 1.3 B rows
  × 48 B/row                            = 62 GB total state

stored in Bigtable, queried with row-key prefix scan:
  row key: {service}#{slo_name}#{window}#{ts}
  hot data (last 24h):  ~2 GB in memory cache
  warm data (last 30d): ~62 GB in Bigtable
  cold data (>30d):     archived to GCS
```

VERDICT · 62 GB hot state. Bigtable handles this with one tablet; we don't even need horizontal sharding.

### 2.3 — Burn-rate math (the heart of the system)

This is the entire SLO methodology in one box. Understand this and you understand the system.

#### What is burn rate?

```
SLO        = 99.9% over 30 days
error budget = 100% - 99.9% = 0.1%
            = 0.001 × (30d × 24h × 60min × 60s)
            = 2,592 seconds of badness allowed per 30 days
            = 43.2 minutes per 30 days
            = 1.44 minutes per day (steady state)

current error rate (over some window):
  if errors are 0.1% (matches SLO) → burn rate = 1.0× (sustainable)
  if errors are 0.5%               → burn rate = 5.0× (burning 5× faster)
  if errors are 1.5%               → burn rate = 15.0× (CRITICAL)

formula:
  burn_rate = (current_error_rate) / (1 - SLO_target)
            = (current_error_rate) / (error_budget_per_unit_time)
```

VERDICT · Burn rate is just "how fast are we eating the budget compared to sustainable pace?"

#### The multi-window strategy (Google SRE classic)

```
Why multiple windows? Each catches different failure modes:

  1h window  · 14.4× threshold → fast, intense burns
                                  → "service is on fire RIGHT NOW"
                                  → would consume 2% of monthly budget in 1h

  6h window  · 6× threshold    → sustained problems
                                  → "ongoing degradation across multiple subsystems"
                                  → would consume 5% of budget in 6h

  24h window · 3× threshold    → slow leaks
                                  → "we're drifting, something is wrong"
                                  → would consume 10% of budget in 24h

  30d window · 1× threshold    → budget exhaustion alarm
                                  → "we have spent the whole month's reliability"

ALERTING RULE: fire only when BOTH a short AND long window cross threshold
  → "1h × 14.4× AND 5min × 14.4×" → page (fast)
  → "6h × 6× AND 30min × 6×"      → page (medium)
  → "24h × 3× AND 2h × 3×"        → ticket (slow)

WHY THE PAIR: short window catches the spike, long window confirms it's not a blip
  → avoids paging on 30-second outages that auto-recover
  → catches both fast burns AND drift
```

VERDICT · The dual-window AND-condition is what makes this precise. Single-window alerting is either too jumpy or too slow.

### 2.4 — Fleet summary & cost

| Tier | Instance | Count | $/mo (on-demand) | $/mo (3y RI) |
| --- | --- | --- | --- | --- |
| Normalization service | m6i.large | 12 | $1 K | $0.4 K |
| Dataflow (compute engine) | n2-standard-4 | 20 | $3.5 K | $1.3 K |
| Alert engine | m6i.2xlarge | 9 | $2.6 K | $1.0 K |
| Bigtable (window state) | — | 3 nodes · 62 GB | $1.2 K | $1.2 K |
| Spanner (config store) | — | 2 nodes | $2 K | $2 K |
| Redis (API cache) | cache.r6g.large | 9 | $2 K | $0.8 K |
| API + Dashboard service | m6i.large | 15 | $1.3 K | $0.5 K |
| Audit Kafka | i4i.large | 6 | $3.4 K | $1.3 K |
| Total | — | ~76 nodes | $17 K/mo | $8.5 K/mo |

Cost compared Even cheaper than the canary controller ($17K vs $30K) — because this is pure derived state. SLI streams already exist (monitoring pipeline pays). The tracker is 76 boxes doing arithmetic on aggregated streams.

## 3 · Architecture

### 3.1 — Full architecture diagram

<img src="/diagrams/nalsd-slo-tracker/1.svg" alt="nalsd-slo-tracker diagram 1" class="doc-diagram" />

Fig 1 · Complete SLO Error Budget Tracker. Numbered circles map to the step-by-step flow in §3.2. SLI sources → ingestion → Kafka → Dataflow (windows + rules + burn rate) → state store → alert engine → API/dashboard/notifier. SLO configs flow from Spanner into the rule evaluator.

### 3.2 — Step-by-step flow (the numbered walkthrough)

Following the numbered blue badges in Fig 1. Concrete example: **the InMail delivery service is having a bad afternoon — 0.5% failure rate sustained for 10 minutes triggers a page within 4 minutes of the regression starting.**

SLI sources emit raw telemetry

The InMail send service runs across 200 pods. Each pod increments two counters per request: `inmail.requests_total` and `inmail.requests_failed_total`. The local Prometheus client maintains these in memory; an exporter exposes them at `/metrics`.  
  
Other SLI sources contribute too: the API gateway tracks 4xx/5xx, the database tracks query timeouts, infrastructure tracks pod health. **All measure the same SLO contributors** for InMail availability.

prometheus\_counter("inmail.requests\_total", labels={tenant, region}) · \_failed\_total · exposed at /metrics

SLI sources · **5 layers** services tracked · **500** SLO count · **~5,000 total**

Ingestion + normalization layer

A federation of Prometheus scrapers pulls SLI data from every service every 15s. A push gateway accepts batch ingestion from services that can't be scraped (one-off jobs, edge networks). The normalization engine then: (a) **validates schema** against the SLI registry, (b) **converts units** (some teams emit milliseconds, others microseconds), (c) **normalizes timestamps** to UTC nanoseconds, (d) **enriches metadata** (service ownership team, on-call rotation), (e) **classifies SLI type** (availability / latency / throughput / error rate).  
  
Output: a uniform schema regardless of source. **This is the contract that makes everything downstream possible.**

normalized SLI event: { service, slo\_name, sli\_type, timestamp\_ns, good\_count, total\_count, labels{...}}

scrape interval · **15 s** ingest rate · **500 updates/s** fleet · **12 normalizer nodes**

SLO config store (Spanner)

Parallel to the data path, SLO configurations live in Spanner. An SLO config is: `{service: "inmail-send", sli: "availability", target: 0.999, window: "30d", alert_rules: [...]}`. Configs are version-controlled in Git, edited via PR, approved by service owner + SRE, then applied via GitOps. Each change is audited.  
  
The config store also holds **burn-rate alert rules**: multi-window thresholds, which teams to page, what time-of-day suppression to apply, etc. These can be reloaded without restarting the compute engine.

slo\_config: {target: 0.999, window: "30d", alerts: \[{fast: "14.4× over 1h+5m"}, {slow: "3× over 24h+2h"}\]}

Spanner nodes · **2 (region-replicated)** change workflow · **GitOps + approval** hot-reload · **5 s propagation**

Kafka — normalized SLI stream

Normalized events land in Kafka topics. Two topics: `sli.events` (request-bucketed: good\_count + total\_count over a small window) and `sli.samples` (time-sampled SLIs like uptime). Partitioned by `hash(service)` so each service's stream is ordered. 7-day retention means we can **replay the last week** if the compute engine fails or a config change requires recomputation.  
  
**Exactly-once producer** semantics on the way in. Combined with Dataflow's exactly-once consumer, this gives us the 99.99% accuracy SLO.

topic: sli.events · partition: hash(service) · ACK: all · idempotent producer · 7-day retention

brokers · **9** retention · **7 days** processing semantic · **exactly-once**

Sliding windows in Dataflow

Apache Beam / Dataflow maintains **six concurrent windows** for every SLO: 1m, 5m, 1h, 6h, 24h, 30d. As each SLI event arrives, it's added to all six windows simultaneously. Beam handles late data via **watermarks** — if an event arrives 30 seconds late, the affected windows are reprocessed.  
  
For our InMail example at minute T (when the regression starts): the 1m window shows error rate jumping from 0.05% to 0.5%. The 5m window starts to follow as more samples arrive. The 1h window is still mostly clean because most of the hour was healthy. **That's exactly the multi-window strategy at work — different windows see the same event with different sensitivities.**

Beam pipeline: KafkaIO → ParDo(normalize) → Window.into(\[1m, 5m, 1h, 6h, 24h, 30d\]) → CombinePerKey(sum) → Bigtable.write

windows per SLO · **6** Dataflow workers · **20 autoscaling** state store · **Bigtable checkpoints**

SLO rule evaluator + burn-rate calculator

For each window update, the rule evaluator computes: `compliance = good_events / total_events` and compares to the SLO target. The burn-rate calculator then computes: `burn_rate = (1 - compliance) / (1 - SLO_target)`.  
  
For our InMail case, after 10 minutes of 0.5% failure rate:  
• **1m window:** compliance = 99.5%, burn rate = 5× (above 14.4× threshold? No — but close)  
• **5m window:** compliance = 99.5%, burn rate = 5× (sustained)  
• **1h window:** compliance = 99.85%, burn rate = 1.5× (still mostly clean)  
  
At T+15 minutes, the 1h window hits burn rate 4× and the 5m window is at 5×. The fast-burn pair (14.4× threshold) isn't met yet, but the medium-burn pair (6× threshold over 6h+30m) is close.

burn\_rate = (1 - compliance) / (1 - target) · evaluated every 30s · output: {window, burn\_rate, compliance, budget\_remaining}

eval frequency · **30 s** SLOs evaluated · **5,000** CPU per eval · **~3 ms**

SLO state stored in Bigtable

Every (service, SLO, window, timestamp) tuple is written to Bigtable. Row key is `service#slo#window#ts` — sorted lexicographically so range scans for "InMail availability over last hour" are sequential disk reads.  
  
Columns include: `good_events`, `total_events`, `slo_target`, `budget_remaining`, `burn_rate`. This is the canonical source of truth — every dashboard query and alert evaluation reads from here.  
  
30 days × 6 windows × 5,000 SLOs at 1-min granularity = ~62 GB. Bigtable handles this with one tablet; we shard by service to enable parallel queries.

row key: inmail-send#availability#1h#1715520600 · column family: cf:{good, total, target, remain, burn}

Bigtable nodes · **3** hot state · **62 GB** row scan latency · **~10 ms p99**

API + dashboard serve queries

SREs and product managers query the system in two ways:  
  
**Query API (GraphQL):** "what's InMail's availability over the last 24h, grouped by region?" Returns from Bigtable, cached in Redis with 60s TTL (70% cache hit rate because dashboards refresh on the same queries repeatedly).  
  
**Dashboard:** React UI with WebSocket subscriptions for real-time burn-rate updates. Shows current SLO compliance, time-series of burn rate across all windows, error budget remaining as a thermometer, alert timeline of past incidents.  
  
Product managers use this to see "we have 35% of the month's budget left and 12 days remaining — we can ship that risky feature." SREs use it to see which services are red.

GraphQL: query { service(name: "inmail-send") { slo(name: "availability") { compliance(window: "24h") burnRate } } }

API fleet · **15 nodes** cache hit · **70%** dashboard latency · **p99 200 ms**

Alert engine evaluates burn-rate rules

Independent of the API path, the alert engine continuously evaluates burn-rate rules. For our InMail example at T+18 minutes:  
  
• **5m window burn rate:** 5.2×  
• **1h window burn rate:** 4.8× (approaching threshold)  
• **Medium-burn pair check:** "30m AND 6h both > 6×?" → Not yet  
  
At T+22 minutes:  
• **5m window:** 5.5×  
• **30m window:** 6.1×  
• **6h window:** 6.2× — **BOTH thresholds met**  
  
The alert engine fires: `{service: "inmail-send", slo: "availability", severity: "page", reason: "medium-burn 6× over 6h+30m"}`. Dedupes against any existing open alert for this SLO. Then routes to the notifier.

alert\_rule: burn\_rate(5m) > 6 AND burn\_rate(6h) > 6 → page · suppress if EB > 90% already alerted

eval frequency · **15 s** alert fleet · **9 nodes** dedupe window · **per (service, SLO) tuple**

Notifier delivers the page

The alert hits the notifier, which looks up InMail's on-call rotation in the team-ownership service, formats the page with context (which SLO, current burn rate, budget remaining, link to dashboard, recent deploys for context), and delivers via PagerDuty for the current on-call engineer.  
  
**Total wall-clock time from the SLI regression starting to the on-call's phone ringing: ~4 minutes.** Well within the 5-minute SLI-D target. The notification includes a deep link to the dashboard pre-filtered to InMail availability over the last 30 minutes — the engineer can see the regression on-screen before they finish reading the page.  
  
Throughout this entire flow, every state transition has been written to the audit Kafka. Six months later, someone can reconstruct exactly when this incident started, what the burn rate was at each step, who was paged, and when it was resolved.

page: {service: "inmail-send", slo: "availability", burn\_rate: 6.2, budget\_remaining: 0.42, oncall: "bob@", dashboard\_url: ...}

e2e regression → page · **~4 min** SLI-D target · **< 5 min ✓** audit trail · **every step logged**

The key design insight Notice the *tracker itself* never decides what to do — it just measures and informs. The product team decides whether to ship features when budget is green. The engineering team decides what reliability work to do when budget is red. The tracker is a referee, not a coach. That's what makes it trusted: it has no agenda except accurate measurement.

### 3.3 — Multi-window burn-rate detail (the SRE classic)

The multi-window strategy is the heart of this system. Single-window alerting is either too jumpy (1-min triggers on noise) or too slow (1-day misses fast burns). The dual-window AND-condition is the senior trick.

| Alert tier | Long window | Short window | Burn threshold | Budget consumed | Response |
| --- | --- | --- | --- | --- | --- |
| **Fast burn** | 1 h | 5 min | 14.4× | 2% in 1h | page immediately |
| **Medium burn** | 6 h | 30 min | 6× | 5% in 6h | page during business |
| **Slow burn** | 24 h | 2 h | 3× | 10% in 24h | file ticket |
| **Budget warn** | 30 d | — | 1× cumulative | 75% total | email service owner |
| **Budget critical** | 30 d | — | 1× cumulative | 95% total | auto-pause deploys |

Why 14.4× for the fast burn? Math: at 14.4× sustained for 1 hour, you'd consume `14.4 × (1/720)` = 2% of the monthly budget. The 14.4 isn't magic; it's `30 days × 24 h / 1 h × 2%`. The Google SRE book picks 14.4 because 2% in an hour is "definitely an emergency" — a real outage burns the monthly budget catastrophically fast.

### 3.4 — Error budget visualizer

Three example services in different states. The visual **is** the contract: green means ship features, red means pivot.

#### InMail availability (currently burning)

78% consumed

22% remaining · 8 days left in month

Budget burning at 4× expected pace · slow-burn alert active · feature freeze recommended

#### Feed availability (healthy)

18% consumed

82% remaining · 8 days left in month

Budget burning at 0.7× expected pace · safe to ship

#### Search latency (warning)

52% consumed

48% remaining · 8 days left in month

Burning at 1.8× expected pace · ship cautiously · canary thresholds tightened

## 4 · Failure gauntlet

A · Late-arriving SLI data SLI: A, B

A region's metrics pipeline lags 90s; events arrive out of order.

triggerwatermark lag > 30 s

absorbBeam reprocesses windows on late data

guardrefuse to fire alerts on stale windows

verdictdata eventually correct · alerts delayed not wrong

B · Bad SLO config SLI: E

Someone configures SLO target = 100% (impossible).

triggertarget ≥ 0.99999 or window mismatch

absorbvalidation in config PR blocks merge

overrideSRE approval required for > 99.99% targets

verdictimpossible configs never reach prod

C · Bigtable hot spot SLI: A, C

One service produces 100× the SLI volume; its row range becomes hot.

triggerrow p99 latency > 50 ms

absorbrow key hash prefix spreads writes

scaleBigtable adds nodes automatically

verdictself-resolves in < 5 min

D · Dataflow worker crash SLI: A

A whole worker pool restarts during a deploy.

triggercheckpoint lag > 60 s

absorbBeam restarts from last checkpoint

replayKafka has 7-day buffer

verdictno data loss · brief alert delay

E · Alert storm SLI: E

Major incident burns 50 services' budgets simultaneously.

triggerconcurrent alerts > 20/min

absorbgroup by parent incident (1 page)

capper-tenant alert rate limit

verdict50 alerts → 1 actionable page

F · Audit Kafka loss SLI: B

Audit topic loses a partition; some history gone.

triggerpartition health check fail

absorbrebuild from Bigtable backwards

gapcold archive in GCS as 3rd copy

verdictaudit reconstructed within 24h

What we cannot defend against Gaming the SLOs — a team that picks low SLO targets to avoid red status. The tracker measures honestly but cannot verify the targets are reasonable. Mitigation: **SLO review process** where targets must be approved by VP Eng + SRE leadership, with quarterly retrospectives on actual user-perceived reliability vs SLO target.

## 5 · Operational playbook

### 5.1 — Eating our own dogfood

The tracker tracks the tracker. We define and publish SLOs for our own compute latency, accuracy, availability, and alert delay. These flow through the same pipeline — recursive but well-defined since the data path is independent of self-monitoring. If the tracker's own compute SLO burns red, we get paged by an external monitoring system (the §monitoring doc) which doesn't depend on us.

### 5.2 — Chaos drills (quarterly)

-   **Late data injection** — inject 5-min late SLI events; verify window reprocessing.
-   **Bigtable failover** — drain a region's Bigtable; verify read failover within 10 s.
-   **Bad config push** — submit an impossible SLO target; verify validation blocks.
-   **Dataflow pool kill** — kill all workers; verify replay from Kafka.
-   **Alert storm injection** — synthesize 100 simultaneous breaches; verify dedupe + rate limiting.
-   **Accuracy verification** — replay 24h of audit log; verify reconstructed state matches Bigtable within 0.01%.

### 5.3 — Runbook excerpt

```
# Symptom: "SLI-D burning — alerts taking > 5 min"

# Likely causes, ranked
1. Dataflow worker lag        → check checkpoint lag dashboard
2. Bigtable write latency     → check row p99 latency
3. Kafka consumer group stall → check lag per partition
4. Alert engine evaluation lag → check eval-per-cycle metric

# First response (in order):
- Confirm: dashboard 'tracker-slo-d' shows > 5 min p95
- If Dataflow: scale workers 2× (gcloud dataflow jobs ... --workers=40)
- If Bigtable: check for hot row prefix, kick autoscaling
- Communicate: post in #incident-slo-tracker with hypothesis
- Escalate: if not resolving in 10 min, page tier-2 oncall
```

## 6 · Component reference

| Component | Tech | Scale strategy | Failure mitigation | SLO |
| --- | --- | --- | --- | --- |
| **Normalization service** | Go service | HPA 12→30 | circuit breaker · DLQ | A,B |
| **Kafka SLI stream** | Kafka 3.7 | partition by service | 3× repl · 7d retention | B,C |
| **Compute engine** | Apache Beam / Dataflow | autoscaling workers | checkpoint · exactly-once | A,B |
| **State store** | Bigtable | auto-sharding | multi-region replication | B,C |
| **Config store** | Spanner | region-replicated | strong consistency | C |
| **Alert engine** | Go service | stateless · LB fanout | dedupe · rate limit | D,E |
| **Query API** | GraphQL + REST | read replicas | Redis cache | C |
| **Dashboard** | React + WebSocket | CDN distribution | cached SLO state | — |
| **Audit Kafka** | Kafka topic | per-tenant partition | 3× repl · GCS archive | B |
| **Notifier** | shared service | multi-vendor | vendor fallback | D |

## 7 · Trade-offs & open questions

#### Chose

-   **Multi-window dual-condition alerting** over single window · catches both fast burns and drift; trade: more compute per evaluation.
-   **Apache Beam / Dataflow** over custom stream · exactly-once + late data handling is hard to write yourself.
-   **Bigtable** for state · row-key range scans match query patterns; trade: less flexible than SQL.
-   **Spanner for config** · strong consistency + global replication; trade: $$.
-   **SLO config as code** (GitOps) · auditable changes, approval workflow; trade: slower iteration than UI editing.
-   **14.4× / 6× / 3× thresholds** from Google SRE book · battle-tested defaults; trade: not tuned to LinkedIn specifically (yet).

#### Rejected

-   **Single rolling window** · simpler but either jumpy or slow.
-   **Prometheus recording rules** alone · works for small fleets, doesn't scale to 5,000 SLOs across regions.
-   **Custom stream processor** · would re-implement Beam poorly.
-   **InfluxDB / TimescaleDB** · capable but doesn't match Bigtable's row-scan economics at scale.
-   **Web UI for SLO editing** · would lose audit trail and review workflow.
-   **Manual burn-rate thresholds per service** · 5,000 SLOs × bespoke tuning = nobody maintains.

### Open questions

1.  Should the system support **SLO objectives that span multiple services** (e.g., "end-to-end Feed homepage availability" = product of feed-ranker × feed-storage × feed-api)? Currently each SLO is a single service.
2.  How to handle **time-of-day patterns**? Maintenance windows that intentionally burn budget shouldn't trigger pages. Currently we just suppress alerts during declared windows.
3.  Should burn rates account for **traffic volume changes**? A 1% error rate at 10 QPS is 6 errors/min; at 10k QPS is 6,000 errors/min — same percentage, very different user impact.
4.  Should we move toward **per-user-journey SLOs** instead of per-service? "Did this user successfully complete the InMail send flow?" matters more than "did the inmail-send microservice return 200?".
