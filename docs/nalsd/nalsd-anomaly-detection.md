---
title: "AI Anomaly Detection Platform"
slug: /nalsd/nalsd-anomaly-detection
sidebar_position: 11
sidebar_label: "AI Anomaly Detection Platform"
description: "AI Anomaly Detection Platform"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/nalsd-anomaly-detection/sequence.svg" alt="How it works — nalsd-anomaly-detection" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
in

in/anomaly

v2026.05 · nalsd

in/anomaly/ design-docs/ 2026/ ai-anomaly-detection.md

A NALSD walkthrough — the system that catches the outage before your pager does. Continuously monitor 5,000 SLOs across 500 services with an ensemble of ML models, detect drift in < 2 min, FP rate ≤ 1%, and feed predictions into the error-budget tracker.

NALSD detect < 2 min FP ≤ 1% 5k SLOs · 5 models draft · review last edit · 2026-05-12 · sjc

## 1 · Problem statement & SLO contract

Threshold-based alerting catches only what we already know to look for. Real outages start with subtle drifts: p99 latency creeping from 50 ms to 60 ms over an hour, error rates ticking up 0.05% before the 5×-burn threshold trips, GC pause distributions widening. Humans don't see these. An ML system trained on what "normal" looks like for each service can — and forward the prediction to the SLO tracker so it raises tighter thresholds before the budget burns. The anomaly platform is **the eyes that watch for change**, not the alarm that fires on a known signature.

Series monitored

~2 M

across all services

Detection latency

< 2 min

p95 anomaly → notification

FP rate

≤ 1%

precision target

Models in ensemble

5

specialized per anomaly type

### SLO contract (for the ML system itself)

An ML detector is just another production system. Monitor it, canary it, page it when it drifts. Its most important SLI is *the trust of the on-call engineer* — and trust is built on the FP rate.

| SLI | Target | Measurement | Error budget / 28d |
| --- | --- | --- | --- |
| **A · Detection latency** | p95 ≤ 2 min | regression onset → anomaly emitted | ~24h with >2min |
| **B · False positive rate** | ≤ 1% | flagged / not actionable | strict — drives trust |
| **C · False negative rate** | ≤ 2% | real anomalies missed | measured via post-incident audit |
| **D · System uptime** | ≥ 99.99% | detection pipeline availability | ~4 min/month |
| **E · Coverage** | ≥ 95% | SLO metrics with active models | 5% cold-start gap allowed |

#### Why the FP/FN trade matters

A detector with 50% FP rate but 0% FN rate is useless — the on-call will ignore it. A detector with 0% FP rate but 50% FN rate is dangerous — the on-call thinks it's covered when it isn't. The sweet spot is the bottom-right corner:

Predicted: anomaly

Predicted: normal

Actual: anomaly

**TP** · ~3,000/mo  
real anomalies caught

**FN** · ≤ 60/mo  
missed anomalies (FN ≤ 2%)

Actual: normal

**FP** · ≤ 30/mo  
spurious alarms (FP ≤ 1%)

**TN** · everything else  
quietly correct

The senior insight Anomaly detection is *not* alert generation. It feeds the SLO tracker — which already has dedupe, correlation, and routing. The anomaly platform's job is to produce **high-precision early signals** that integrate with the existing pipeline. It's a sensor, not a siren.

## 2 · Capacity model (the NALSD math)

### 2.1 — Time series ingestion

#### Series volume — bigger than you'd think

```
SLO-tracked services         ≈ 500
metrics per service (SLIs)   ≈ 50  (latency p50/95/99, errors, throughput, CPU, mem, etc.)
dimensions per metric (host, region, version)
                              = avg 8 active dimensions
total tracked series         = 500 × 50 × 8 = 200,000 unique series

with multi-modal expansion (logs, traces, events as features):
  text-derived features      = +5× series count
  trace-derived features     = +3× series count
  total monitored series     = 200,000 × (1 + 5 + 3) = ~2 M series

per-series sample rate       = 1 sample / 15 sec (matches Prom)
ingest rate                  = 2M / 15 = 133,000 samples/s

per-sample size (compact):
  series_id (8 B) + ts (8 B) + value (8 B) + meta (40 B) = 64 B
bytes/sec at peak            = 133,000 × 64 B = 8.5 MB/s ≈ 68 Mbps
```

VERDICT · 2 M series, 133k samples/s, 68 Mbps. Tiny vs the monitoring firehose — we consume aggregated SLIs, not raw.

### 2.2 — Feature engineering volume

#### Features per series per window

```
features per series per cycle (computed every 15 s):
  statistical: mean, std, min, max, p50/95/99, skew, kurtosis = 10
  temporal: lag-1/5/30/60min, EMA, rate-of-change                = 12
  seasonal: hour-of-day, day-of-week residuals                    = 6
  graph: parent/child SLI correlations                            = 8
  text: log-derived (severity ratio, novel terms)                 = 6
  trace: span tree shape · error spans                            = 4
  ──────────────────────────────────────────────────────────────────
  total features per series                                       = 46

feature ops/sec global:
  2M series × 46 features ÷ 15 s = 6.1 M feature computations/s
  per Beam worker capacity        = 30,000 ops/sec
  workers needed                  = 6.1M / 30K = 203 workers
  with N+2 + cross-region buffer  = 240 Beam workers

feature store sizing:
  features × series              = 46 × 2M = 92 M features
  hot store (last 24h)           = 92M × (96 samples/24h) × 8 B
                                   = 70 GB → fits in Redis cluster
  warm store (last 30d)          = 70 GB × 30 = 2.1 TB → Bigtable
```

VERDICT · 6M feature ops/s. The biggest fleet in this design (240 nodes) — feature engineering is the bottleneck, not inference.

### 2.3 — Model inference latency budget

#### Where the 2-minute SLO budget goes

```
metric emission lag (Prom scrape)         = 15 s
feature computation (Beam window)         = 15 s
ensemble inference (5 models in parallel) =  2 s
consensus voting                          =  1 s
confidence scoring + business context     =  1 s
output to SLO tracker / alert engine      =  1 s
notification delivery                     =  5 s
──────────────────────────────────────────────
typical p50                                = 40 s
×2 for p99 tail                            = 80 s ≈ 1.3 min
SLO target                                 = 120 s ✓ 40s headroom
```

VERDICT · 80 s p99. Inside the 2-min SLO. The two 15s waits (scrape + window) eat half the budget — can't escape them.

#### Inference compute

```
anomaly score requests per second (per series):
  series × eval interval = 2M / 15 = 133,000 inferences/s

ensemble fan-out (5 models in parallel):
  effective inferences = 133K × 5 = 665,000 model-inferences/s

per-model latencies (small models on CPU):
  Isolation Forest             = 0.5 ms
  LSTM Autoencoder             = 2.0 ms
  Variational Autoencoder      = 1.5 ms
  One-Class SVM                = 0.5 ms
  Transformer (small)          = 3.0 ms
  ────────────────────────────────────
  parallel max                  = 3.0 ms (longest model)

inferences per inference node (c6i.4xlarge, 16 cores):
  133K / 16 cores = 8.3K series/sec/node theoretical
  with realistic batching       = 25K series/sec/node
  nodes needed                  = 133K / 25K = 5.3
  with 3× redundancy + N+2      = 18 nodes per region
  global (5 regions, weighted)  = 60 inference nodes
```

VERDICT · 60 inference nodes globally. Small fleet because we batch and run lightweight models on CPU.

### 2.4 — Fleet summary & cost

| Tier | Instance | Count | $/mo (on-demand) | $/mo (3y RI) |
| --- | --- | --- | --- | --- |
| Ingestion / normalizer | m6i.large | 12 | $1 K | $0.4 K |
| Feature engineering (Beam) | n2-standard-4 | 240 | $42 K | $16 K |
| Feature store (Redis hot) | cache.r6g.large | 30 | $7 K | $2.7 K |
| Feature store (Bigtable warm) | — | 3 nodes · 2.1 TB | $1.5 K | $1.5 K |
| Inference (ensemble) | c6i.4xlarge | 60 | $35 K | $13 K |
| Model registry / store | — | S3 + Postgres | $1 K | $1 K |
| Training cluster (offline) | g5.4xlarge | 8 (avg) | $11 K | $4 K |
| Decision engine | m6i.xlarge | 15 | $3 K | $1 K |
| Feedback loop / labeling | m6i.large | 9 | $0.8 K | $0.3 K |
| Kafka audit + Spanner state | — | — | $5 K | $3 K |
| Total | — | ~377 nodes | $107 K/mo | $42 K/mo |

Cost composition Feature engineering (Beam fleet) is **40% of total cost** — way more than inference. This is the consistent ML lesson: feature pipelines dominate. Training is cheap because we retrain weekly, not constantly.

## 3 · Architecture

### 3.1 — Full architecture diagram

<img src="/diagrams/nalsd-anomaly-detection/1.svg" alt="nalsd-anomaly-detection diagram 1" class="doc-diagram" />

Fig 1 · AI Anomaly Detection Platform. Numbered circles match the step-by-step flow in §3.2. Data sources → ingest → Kafka → feature engineering (5 feature types) → feature store → 5-model ensemble → consensus decision → SLO tracker signal feed → feedback loop retrains models.

### 3.2 — Step-by-step flow (the numbered walkthrough)

Following the numbered blue badges in Fig 1. Concrete example: **the Feed ranker's p99 latency starts drifting upward at 14:30 UTC — not enough to trip a static threshold, but the anomaly platform spots it at 14:31 and flags it to the SLO tracker, which tightens its burn-rate alert window. The incident is contained 8 minutes earlier than it would have been otherwise.**

Multi-modal data sources emit telemetry

The anomaly platform consumes from **four sources** simultaneously: metrics (Prometheus SLI scrapes), logs (parsed JSON from the logging pipeline with severity/error-keyword features extracted), traces (span trees from the APM system), and events (deploys, config changes, scaling events from the audit logs of other systems).  
  
Crucially, this isn't its own data plane — it **subscribes to existing pipelines**. The monitoring platform's metric stream, the logging pipeline's parsed output, etc. are the inputs. No double-ingest.

subscribes to: monitoring.metrics · logging.parsed · apm.spans · audit.events

series monitored · **~2 M** sample rate · **1/15s per series** ingest · **133k samples/s · 68 Mbps**

Ingestion + normalization unifies the schema

Each input source has its own schema. The normalizer flattens them all into a unified time-series record: `{series_id, ts, value, meta{source, service, region, slo_id}}`. This includes a critical step: **linking each series to its SLO** by lookup against the SLO config store. A metric without an SLO link gets lower priority (we still monitor it, but its anomalies don't reach the SLO tracker).  
  
The normalizer also dedupes (same metric from multiple sources), validates against the schema registry, and enriches with team owner + dependency-graph info.

normalize() → dedupe() → schema\_validate() → enrich(slo\_id, team, deps) → kafka.produce(unified-stream)

budget · **500 ms** fleet · **12 nodes** SLO-linked coverage · **≥ 95%**

Model registry holds versioned model artifacts

Parallel to the data path, the model registry holds **5 trained models per service** (Isolation Forest, LSTM-AE, VAE, OC-SVM, Transformer). Models are version-controlled like code — every model has a git commit, training data hash, evaluation scores, and a deployment status (canary / production / shadow).  
  
Per-service models are essential. A "high CPU" anomaly for the Feed ranker has different baseline behavior than for the Profile DB. Each service's ensemble is trained on its own historical data.  
  
Models are deployed via the canary controller (§canary doc) — new models start in shadow mode, then canary, then promoted only if FP/FN rates improve.

model\_id: "feed-ranker-v17/lstm-ae:2026-05-01" · stored in S3 · metadata in Postgres

models per service · **5** total models · **500 × 5 = 2,500** retrain cadence · **weekly**

Kafka durably buffers the unified stream

Normalized records land in Kafka topics. Partitioned by `hash(series_id)` so all updates for a given series stay in order on one partition — important for temporal features (LSTM needs ordered sequences).  
  
**Why Kafka here:** if feature engineering or inference falls behind, data queues durably. 7-day retention is the replay window — if we deploy a buggy model, we can rerun the past week against the corrected version and audit what we missed.

topics: metrics.normalized · logs.normalized · traces.normalized · events.normalized · partitioned by hash(series\_id)

brokers · **shared with monitoring (9)** retention · **7 days** budget · **2 s consumer lag**

Feature engineering computes 46 features per series

This is the heart of the system. For each new data point, Apache Beam workers compute 46 features across 5 categories:  
  
• **Statistical (10):** rolling mean, std, percentiles, skew, kurtosis  
• **Temporal (12):** lag-1 / lag-5min / lag-30min, EMA, rate-of-change, autocorrelation  
• **Seasonal (6):** hour-of-day, day-of-week residuals against expected seasonal pattern  
• **Graph (8):** correlations with parent/child SLIs in the dependency graph  
• **Text + trace (10):** log-derived (severity-shift ratios, novel terms), trace-shape statistics  
  
For Feed ranker at 14:30, the rate-of-change feature for p99 latency starts showing a positive trend (0.5 ms/min upward). Statistical features show p99 = 850 ms (vs 30-day baseline of 780 ms). Seasonal residual = +60 ms above expected for this time of day. These are subtle — no single feature trips a threshold — but together they form a pattern.

Beam pipeline: KafkaIO → CoGroupByKey(series) → ComputeFeatures(46) → BigQueryIO + Redis sink

features per series · **46** ops/sec global · **6.1 M** workers · **240 (biggest fleet)**

Feature store serves features online and offline

Computed features land in two stores:  
  
**Redis (24h hot · 70 GB):** for online inference. Inference fetches the last N feature values for each series in < 1 ms. This is the performance-critical path.  
  
**Bigtable (30d warm · 2.1 TB):** for training. Periodic retraining jobs read 30 days of features as model training data. Also serves the analytics dashboards that compare current state to historical patterns.  
  
**Point-in-time correctness** is the trickiest part: when training a model, we must serve features as they existed at training time, not as they are now (otherwise the model learns from future data — "data leakage"). The feature store is versioned for this reason.

redis.MGET("features:feed-ranker:lstm-ae:t-100..t-0") · bigtable.scan(prefix="features:feed-ranker:", start\_ts, end\_ts)

hot read p99 · **< 1 ms** warm read p99 · **~50 ms** point-in-time · **versioned per feature**

Ensemble inference — 5 models run in parallel

For each series + new feature vector, all 5 models run **in parallel**, each computing an anomaly score in \[0,1\]:  
  
• **Isolation Forest** (0.5ms) — high-dim outlier detection. Score from path length in random forests.  
• **LSTM Autoencoder** (2.0ms) — encodes the time-series and reconstructs it. Reconstruction error = anomaly score.  
• **VAE (Variational Autoencoder)** (1.5ms) — generative model; how unlikely is this point under the learned distribution?  
• **One-Class SVM** (0.5ms) — distance from learned boundary in feature space.  
• **Transformer (small)** (3.0ms) — attention over (metric, log, trace, event) multi-modal context. Catches anomalies visible only in combinations.  
  
For Feed ranker: LSTM-AE returns **0.78** (high — sequence diverging from learned pattern). VAE returns **0.71** (unusual distribution). Others return moderate scores. The "wall-time" is 3 ms (longest model) because they're parallelized.

parallel: \[if.predict(), lstm.encode\_decode(), vae.likelihood(), svm.distance(), tfm.attend()\]  
output: \[score\_if=0.42, score\_lstm=0.78, score\_vae=0.71, score\_svm=0.45, score\_tfm=0.66\]

budget · **3 ms (parallel max)** inferences/sec global · **665k (5 × 133k)** fleet · **60 inference nodes**

Consensus engine + business context check

The 5 model scores are combined into a single confidence score by a meta-learner that weights each model based on historical accuracy *for this specific anomaly type and service*. For Feed ranker temporal sequences, LSTM-AE has historically been most accurate (weight 0.35); Transformer 0.25; VAE 0.20; others 0.10 each.  
  
Weighted score for Feed ranker: `0.35×0.78 + 0.25×0.66 + 0.20×0.71 + 0.10×0.42 + 0.10×0.45 = 0.66`  
  
Then business context applies: time of day (weekday business hours → high impact), service criticality (Feed = tier-0), recent deploys (yes — feed-ranker:v2.3.1 deployed 20 min ago, suspicious). The decision engine outputs: **confidence 0.74 → flag as anomaly · severity P1 · likely cause: recent deploy**.

final\_score = Σ(weight\_i × score\_i) · context\_features = \[time, criticality, recent\_deploys\] · meta\_classifier.predict → severity

budget · **1 s** fleet · **15 decision engine nodes** decision threshold · **0.7 (tuned for FP ≤ 1%)**

Signal feeds the SLO tracker (does NOT page directly)

This is the senior design choice: **the anomaly platform does not page humans directly**. It emits a signal to the SLO tracker, which then decides whether to tighten its burn-rate alert window for this service.  
  
For Feed ranker at confidence 0.74: the SLO tracker receives the anomaly signal, looks up Feed's current burn rate (1.2× — slightly elevated), and **tightens the medium-burn threshold from 6× to 4×** for the next 30 min. The alert engine is now more sensitive — a smaller deviation will fire a page. If the regression continues, the page fires several minutes earlier than it would have otherwise.  
  
This achieves the system's goal — *catching the outage before your pager does* — without bypassing the existing alert pipeline. No new on-call interface. No new ack workflow. Just earlier and tighter thresholds when an anomaly is detected.

slo\_tracker.signal({service: "feed-ranker", anomaly\_score: 0.74, suggested\_threshold: "tighten 4×", duration: "30min"})

budget · **1 s** integration · **signals only, no paging** FP-impact-on-SLO · **tighter thresholds, not pages**

Feedback loop closes — retraining + A/B testing

Every anomaly decision is recorded. After the incident is resolved (whether the platform was right or wrong), human SREs can label the decision: **TP** (anomaly was real), **FP** (alarm but nothing wrong), **FN** (we missed a real anomaly), **TN** (silent and correct).  
  
These labels feed two systems: (a) **online learning** updates model weights in the consensus engine in near-real-time (don't retrain models, just adjust how much we trust each one), (b) **weekly retraining** uses the labeled data as fresh training examples. New model versions are deployed via the canary controller — shadow mode first, then 1%, 5%, 25% canary, with statistical FP/FN comparison vs current production. Only promoted if metrics improve.  
  
**Total wall-clock time for the detection path:** ~80 s p99. Under the 2-min SLO. The earliest the platform can catch an anomaly is bounded by the 15s scrape + 15s window — that's physics, not a design choice.

audit.append({decision, label, ts}) · weights.update(ema) · weekly: retrain(labeled\_data) · canary deploy via §canary doc

e2e typical · **~40 s** e2e p99 · **~80 s** SLO target · **p95 ≤ 2 min ✓ 40s headroom**

The key design insight Notice this is fundamentally a **sensor system, not an alert system**. The output is a probabilistic signal, not a binary page. By feeding signals into the existing SLO tracker rather than minting a parallel paging pipeline, we get all the benefits (dedupe, correlation, on-call routing, audit) for free. ML is plugged into the reliability stack, not bolted on the side. The on-call engineer still sees pages from one system — they trust — not from a new ML system they don't.

### 3.3 — Why an ensemble of 5 models (not 1 big model)

Each anomaly type has different "shape" and different best-detector. No single model dominates. Here's the matrix of what each model catches well:

| Model | Best at | Worst at | Latency | Ensemble weight (Feed) |
| --- | --- | --- | --- | --- |
| **Isolation Forest** | high-dim outliers · single bad point | gradual drift | 0.5 ms | 0.10 |
| **LSTM Autoencoder** | temporal sequences · pattern breaks | cold start / new services | 2.0 ms | 0.35 |
| **VAE** | distribution shifts · multi-modal data | very short sequences | 1.5 ms | 0.20 |
| **One-Class SVM** | novelty · clear boundaries | high-dim spaces | 0.5 ms | 0.10 |
| **Transformer (small)** | multi-modal context (metric+log+trace) | compute cost · interpretability | 3.0 ms | 0.25 |

Why not just one big model? A single deep model would have higher peak accuracy but worse *tail* behavior — it'd fail catastrophically on anomaly types it hadn't seen during training. The ensemble degrades gracefully: if 1 model is wrong, 4 others still vote. We trade some peak accuracy for robustness. **This is the same logic as the multi-window burn-rate alert in the SLO tracker — never trust a single signal.**

### 3.4 — Feedback loop & continuous learning

The feedback loop is what keeps the system honest over time. Without it, models drift as services change and FP/FN rates silently degrade. Here's the cycle:

Online labeling post-incident

After every incident (resolved or stood-down), SREs label past anomaly decisions in a labeling UI: TP, FP, FN, or TN. Takes ~30 sec per label. Builds a continuously fresh training set.

labels per week~1,500

toolingSnorkel + custom UI

Online weight tuning near-real-time

A FP label causes the consensus engine to slightly reduce the weight of whichever model voted strongly for "anomaly." A FN label slightly increases the weight of models that voted softly. Exponential moving average keeps the adjustment smooth.

update intervalevery 1 min

smoothingEMA alpha=0.05

Weekly retraining offline batch

Every Sunday night, the training cluster (8 GPU nodes) retrains all 5 models for each service on the past 30 days of labeled data. New models tagged as candidates.

training time~6 h per cohort

candidates per week~50 retrained models

A/B canary via §canary production gates

New model versions deploy via the canary controller — shadow → 1% → 5% → 25% → 100%, with statistical FP/FN comparison at each stage. Only promoted if metrics improve vs production. Same gates as any other production service.

promotion rate~60% (40% rolled back)

model SLOFP/FN must improve or hold

The feedback loop IS the SLO Without retraining, an ML system is just a fixed function that decays over time. Without canary deployment, retraining is a liability. Without labels, canary deployment is blind. The loop is what makes ML systems behave like other production code: deployable, testable, rollback-able.

## 4 · Failure gauntlet

A · Model drift undetected SLI: B, C

A service changes its behavior; old model now over-fires (FP spike).

triggerFP rate > 2% over 7 days

absorbonline weight tuning reduces model's influence

capauto-rollback to previous model version

verdictFP returns to ≤1% within 1 week

B · New service with no model SLI: E

A new microservice gets deployed; no trained model yet.

triggerservice has no model in registry

absorbfall back to generic "global" model

repairauto-trigger training after 7d of data

verdictcoverage gap closed within 1 week

C · Feature pipeline lag SLI: A

Beam workers fall behind; features stale by 5+ min.

triggerfeature watermark lag > 60 s

absorbBeam autoscale adds workers

guarddecision engine refuses stale features → emit NO\_DECISION

verdictSLI-A delay logged, not silent

D · Bad retrained model SLI: B, C

Weekly retraining produces a worse model (data quality issue).

triggercanary FP/FN worse than baseline

absorbcanary controller refuses to promote

repairstays on previous model · investigates next cycle

verdictbad model never reaches production

E · Adversarial drift SLI: C

A deploy introduces gradual change → models adapt to "new normal" → real outage looks normal.

defense 130-day training window (slow to adapt)

defense 2anomaly platform doesn't override SLO thresholds, only suggests

defense 3static fallback alerts always remain

verdictworst case: ML adds nothing, doesn't subtract

F · Label scarcity SLI: B, C

SREs busy; labels aren't getting added; retraining starves.

triggerlabel rate < 100/week

absorbweekly retraining skipped (keep current models)

repairauto-label TNs (most decisions); ask humans only on uncertain cases

verdictsystem stays current with reduced human cost

Cannot defend against Completely novel failure modes the system has never seen. An ML detector is fundamentally a "pattern recognizer" trained on history — a truly unprecedented event (first-time-ever hardware bug, novel attack vector) will look "normal" enough to slip past. Mitigation: keep traditional threshold alerts as the safety net. ML *adds* to detection; it doesn't replace.

## 5 · Operational playbook

### 5.1 — Treating the ML system as a production system

This is the cultural shift the system requires: ML pipelines must be treated like any other tier-0 production service. SLOs, canary deploys, post-incident reviews, on-call rotations, error budgets — all of it. The most common failure mode for ML systems is being treated as "research" and slipping into untracked, unreliable territory.

### 5.2 — Chaos drills (quarterly)

-   **Drift injection** — synthetically shift one service's distribution; verify detection within 2 min.
-   **Model rollback** — push a known-bad model; verify canary FP/FN gate blocks promotion.
-   **Feature pipeline kill** — terminate Beam workers; verify autoscaling and NO\_DECISION fallback.
-   **Label drought simulation** — block label submission for 2 weeks; verify graceful degradation.
-   **FP storm** — synthetically flood with FP labels; verify online weight tuning responds correctly.
-   **Cold-start drill** — deploy a synthetic new service; verify fallback to global model within 5 min.

### 5.3 — Runbook excerpt

```
# Symptom: SLI-B burning — FP rate > 1%

# Likely causes (ranked)
1. Recent model drift on hot service     → check FP-by-service dashboard
2. Recent SLO config change              → check SLO tracker change log
3. Bad retrained model promoted          → check canary promotion log
4. Feature pipeline producing nulls      → check feature freshness

# First response (in order):
- Confirm: dashboard 'anomaly-slo-b' shows > 1% FP rate
- Identify worst service: FP-by-service sorted desc
- If single service: rollback that service's model to previous version
- If multi-service: investigate recent labeling distribution shift
- Communicate: post in #incident-anomaly
- Escalate: if not resolving in 30 min, page tier-2 (ML platform team)
```

## 6 · Component reference

| Component | Tech | Scale | Failure mitigation | SLO |
| --- | --- | --- | --- | --- |
| **Ingestion / normalizer** | Go service | HPA 12→30 | circuit breaker · DLQ | A,E |
| **Kafka unified stream** | shared with monitoring | per series\_id | 3× repl · 7d retention | A,D |
| **Feature engineering** | Apache Beam / Dataflow | 240 autoscaling workers | checkpoint · exactly-once | A,D |
| **Feature store (hot)** | Redis cluster | 30 nodes | multi-region replicas | A |
| **Feature store (warm)** | Bigtable | 3 nodes auto-shard | strong consistency | — |
| **Model registry** | S3 + Postgres | versioned · auditable | cross-region S3 repl | — |
| **Inference fleet** | CPU + small models | 60 nodes · 5 models parallel | fallback to single model | A,B,C |
| **Decision engine** | Go service | 15 nodes stateless | NO\_DECISION on stale features | A,B |
| **Training cluster** | GPU (g5.4xlarge) | 8 nodes batch | retry · checkpoint | — |
| **Feedback / labeling** | Snorkel + custom UI | 9 nodes | auto-label TNs · skip retrain on drought | B,C |

## 7 · Trade-offs & open questions

#### Chose

-   **Ensemble of 5 models** over single big model · graceful degradation, interpretable per-model; trade: 5× inference work.
-   **Signal feed to SLO tracker** (not paging directly) · reuses existing alert pipeline; trade: cap on max anomaly latency improvement.
-   **Per-service models** over global · much higher accuracy; trade: 2,500 models to retrain weekly.
-   **CPU inference** over GPU · models are small, batching is enough; trade: would need GPU if models grow.
-   **Apache Beam** for features · exactly-once + late-data; trade: harder to author than Spark.
-   **Online weight tuning + weekly retrain** · responsive AND stable; trade: 2 mechanisms to maintain.
-   **Treating ML as a prod system** · canary, SLO, on-call · trade: more process; pays off in trust.

#### Rejected

-   **Single deep model** · higher peak accuracy but catastrophic tail; ensemble is safer.
-   **ML-direct paging** · would duplicate alert infrastructure; tradeoff doesn't pencil.
-   **Global model only** · doesn't capture service-specific patterns; FP rate would be 5×+.
-   **Continuous online retraining** · interesting but hard to test, hard to rollback; weekly batch is enough.
-   **Heavyweight LLM-based detector** · 100× inference cost · marginal accuracy gain · not worth it.
-   **"ML-only" detection** (no threshold fallback) · risky; static alerts remain as safety net.

### Open questions

1.  Should we expose **"why" explanations** with each anomaly? SHAP values from the meta-learner could tell on-call "the model flagged this because of seasonal residual and LSTM reconstruction error." Adds value but adds compute.
2.  How aggressive should **online learning** be? Too slow = stale; too fast = chasing noise. Currently EMA alpha=0.05 — probably needs A/B tuning.
3.  Should we support **cross-service anomaly correlation** at the ML layer (vs leaving it to the incident response system's dependency graph)? Could catch "this is a coordinated failure" earlier.
4.  Is the 30-day training window right? Shorter = adapts faster but more noise; longer = more stable but slower to learn new patterns.
5.  Should we offer **predictive burn-rate forecasting** (not just current-state anomalies)? "Burn rate will exceed 6× within 30 minutes if current trajectory continues" is more actionable than current-state anomaly scoring alone.
