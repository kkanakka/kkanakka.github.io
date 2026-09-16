---
title: "Canary Deployment Controller"
slug: /nalsd/nalsd-canary-controller
sidebar_position: 9
sidebar_label: "Canary Deployment Controller"
description: "Canary Deployment Controller"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/nalsd-canary-controller/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

in

in/canary

v2026.05 · nalsd

in/canary/ design-docs/ 2026/ canary-deployment-controller.md

A NALSD walkthrough — the control brain that decides whether a Feed/InMail/Jobs/Search release is healthy enough to go to 100%. Progressive rollout with statistical significance testing, error-budget awareness, and automatic rollback in under 60 seconds.

NALSD detect < 60s rollback 99.99% FP < 0.1% draft · review last edit · 2026-05-12 · sjc

## 1 · Problem statement & SLO contract

LinkedIn ships thousands of deployments per day across Feed, InMail, Jobs, Search, Profile, Notifications, and hundreds of supporting services. A bad deploy at 100% traffic can take down a region in minutes — and historically has. The canary controller is the **risk-management system with code as its interface**: it routes a small slice of production traffic to the new version, watches metrics, and decides whether to keep going or roll back.

Daily deploys

~3,000

across all services

Detection

< 60s

p95 anomaly → decision

Rollback

99.99%

success rate

False positive

< 0.1%

unjustified rollbacks

### SLO contract

Five SLIs. Every design choice below maps to at least one.

| SLI | Target | Measurement | Error budget / 28d |
| --- | --- | --- | --- |
| **A · Detection latency** | p95 ≤ 60 s | regression onset → decision emitted | ~24h slow tail |
| **B · Rollback success** | ≥ 99.99% | rollback initiated → baseline restored | ~3 failed/month |
| **C · False positive rate** | < 0.1% | unjustified rollbacks / promotions | ~3 per 3,000 deploys |
| **D · Controller availability** | ≥ 99.99% | controller able to accept deploys | ~4 min/month |
| **E · Metric parity** | ± 5% | canary vs baseline SLI delta tolerance | configurable per-service |

The hard one False-positive rate < 0.1% is the binding constraint. If the controller rolls back 5% of deploys spuriously, developers stop trusting it and force-promote everything — defeating the purpose. Precision is what earns the right to be in the critical path.

## 2 · Capacity model (the NALSD math)

### 2.1 — Deploy rate & concurrency

#### Daily deploys and concurrent canaries

```
services at LinkedIn          ≈ 500
avg deploys/service/day       ≈ 6  (active services; many sub-1/day)
total deploys/day             ≈ 3,000
                              ≈ 125/hour avg
                              ≈ 500/hour peak (post-standup waves)

per-canary observation window = 20 minutes (5 stages × ~4 min each)
concurrent canaries at peak  = 500/h × (20/60)
                              = 167 active canaries

per region (5 regions, weighted 35/25/20/12/8):
us-west-2 peak                = 167 × 0.35 = 58 concurrent canaries
eu-west-1 peak                = 167 × 0.25 = 42 concurrent canaries
```

VERDICT · ~170 concurrent canaries at peak globally. Controller must hold 170 live decision contexts simultaneously.

### 2.2 — Metrics volume from canaries

#### SLI samples per canary per second

```
per-service SLIs we track:
  latency: p50, p95, p99               = 3 series
  error rates: 4xx, 5xx, timeout       = 3 series
  throughput: QPS                      = 1 series
  resource: CPU, memory, network       = 3 series
  business metrics (varies):           = 2 series
  ─────────────────────────────────────
  per canary                            = 12 series

we track BOTH canary AND baseline:    = 24 series per deployment
samples/series/sec (1-sec interval)   = 1

global metrics samples/sec at peak:
  167 canaries × 24 series × 1 sample = 4,008 samples/s

with metadata per sample (~200 B):
  bytes/sec                            = 4,000 × 200 = 800 KB/s
                                       ≈ 6 Mbps total
```

VERDICT · Metrics volume is TINY (6 Mbps). Why? Because we're sampling SLIs, not raw events. Decisions are made on aggregated signals.

### 2.3 — Decision engine compute

#### Statistical analysis per canary per evaluation cycle

```
evaluation cycle              = every 10 seconds per canary
samples per cycle             = 10 sec × 12 series = 120 samples (canary)
                                + 120 samples (baseline) = 240 samples

statistical tests per cycle:
  Mann-Whitney U (per series) = 12 tests × ~5 ms each = 60 ms
  Welch's t-test (per series) = 12 tests × ~2 ms each = 24 ms
  effect size (Cohen's d)     = 12 calcs × ~1 ms each = 12 ms
  error-budget burn check     = 1 query to budget service = 20 ms
  composite confidence score  = ML inference (random forest) = 30 ms
  ─────────────────────────────────────────────────────
  total per evaluation cycle  = 146 ms

evaluations/sec at peak       = 167 canaries × (1 / 10s) = 17 eval/s
CPU cores needed              = 17 × 0.146 s = 2.5 cores
                              + 10× over-provision (latency, P99) = 25 cores
                              + N+2 per region (5 × 2) = 35 cores

per-node (c6i.4xlarge, 16 vCPU) → 35 / 16 = 3 nodes
plus redundancy + warm standby = 12 decision engine nodes total
```

VERDICT · Tiny fleet (12 nodes). Decision engine is CPU-light because most work is small-batch statistics, not big-data ML.

#### Latency budget for SLI-A (detect in 60s)

```
metric ingestion lag (Prometheus)   = 15 s   (15s scrape interval)
metric scrape → storage             =  2 s
evaluation cycle frequency          = 10 s   (worst case wait)
statistical test computation        =  0.15 s
decision emit to traffic splitter   =  0.5 s
Istio rollout flush                 =  2 s
─────────────────────────────────────────
total typical                        = 30 s
×2 for p99 tail                      = 60 s   ← at the SLO edge!
```

VERDICT · 60s SLO is TIGHT. The 15s Prometheus scrape interval eats half the budget. Reducing to 5s gets us to 20s typical, 40s p99.

### 2.4 — Fleet summary & cost

| Tier | Instance | Count | $/mo (on-demand) | $/mo (3y RI) |
| --- | --- | --- | --- | --- |
| Controller (orchestrator) | m6i.2xlarge | 15 | $4.4 K | $1.7 K |
| Decision engine | c6i.4xlarge | 12 | $7 K | $2.7 K |
| Metrics collector | m6i.large | 25 | $1.8 K | $0.7 K |
| Audit Kafka | i4i.large | 9 | $5 K | $1.9 K |
| State store (Spanner) | — | low QPS | $8 K | $8 K |
| Redis (active state) | cache.r6g.large | 15 | $3.5 K | $1.3 K |
| Total | — | ~76 nodes | $29.7 K/mo | $16.3 K/mo |

Compared to others Cheapest doc in the series — $29K/mo vs $851K (monitoring), $74K (logging), $4.1M (task queue). Why? The controller is a thin *decision* layer, not a data pipeline. It reads metrics from existing observability (free) and writes commands to existing K8s/Istio (free). Its only cost is the brain.

## 3 · Architecture

### 3.1 — Full architecture diagram

<img src="/diagrams/nalsd-canary-controller/1.svg" alt="nalsd-canary-controller diagram 1" class="doc-diagram" />

Fig 1 · The complete canary controller. Numbered circles correspond to the step-by-step flow in §3.2. CI/CD triggers deploy → controller plans stages → traffic splitter routes percentage → metrics collected → decision engine evaluates → promote / hold / rollback → feedback loop adjusts traffic split.

### 3.2 — Step-by-step flow (the numbered walkthrough)

Following the numbered blue badges in Fig 1. Concrete example throughout: **a developer pushes v2.3.1 of the Feed ranker. The canary catches a 4% p99 latency regression and rolls back in 45 seconds.**

CI/CD triggers a deploy

A developer merges a PR; Jenkins builds and pushes `feed-ranker:v2.3.1` to the artifact registry. Spinnaker creates a deploy request and calls the canary controller API. The request includes: service name, new version, previous (baseline) version, deployment policy reference (defines stages, SLO thresholds, max duration), and a deploy owner contact.

POST /deploy {service: "feed-ranker", new: "v2.3.1", baseline: "v2.3.0", policy: "default-5stage", owner: "alice@..."}

budget · **200 ms** (API accept) rate · **~3,000/day · 500/h peak** CI/CD tools · **Spinnaker · Jenkins · Argo**

Canary controller plans the rollout

The orchestrator validates the request (service exists, policy is current, no other deploy in flight for this service), then computes the rollout plan: 5 stages at 1% → 5% → 25% → 50% → 100%, with 4 minutes of observation per stage. It writes the deploy record to Spanner with state=PENDING and emits an event to the Kafka audit log. The controller is leader-elected per region with multi-region hot-standby.

stages = \[(1, 4min), (5, 4min), (25, 4min), (50, 4min), (100, 4min)\] · total\_max = 20 min · state = PENDING

budget · **500 ms** fleet · **15 orchestrator nodes** concurrent deploys · **~170 peak**

Every decision is audit-logged

Before any side effect, the controller appends an event to the Kafka audit log: `{deploy_id, timestamp, state_transition, reason}`. Same pattern for every promote/hold/rollback decision later. **Immutable audit trail** is non-negotiable for post-incident review and regulatory compliance — "why was v2.3.1 rolled back?" must always have a definitive answer 6 months later.

audit.append({deploy\_id, ts, state\_from, state\_to, decision\_inputs, reason, owner\_action})

retention · **1 year hot · 7 years cold** writes · **~10/deploy** queryable via Visibility API

Traffic splitter (Istio) routes 1% to canary

The controller writes an Istio `VirtualService` CRD update: weight=99 to baseline pods, weight=1 to canary pods. Istio's sidecars in every Feed ranker caller pick up the config within ~2 seconds and start routing 1% of real production traffic to v2.3.1. **This is the moment risk begins** — bad code is now serving live users.  
  
Routing is consistent-hash by user\_id so the same user always hits the same version during the deploy (avoids weird A/B-mid-session glitches).

kubectl apply -f virtualservice.yaml · weight: {baseline: 99, canary: 1} · hash\_by: user\_id

budget · **2 s** (Istio propagation) stages · **1% → 5% → 25% → 50% → 100%** routing · **consistent hash on user\_id**

Metrics collected from both versions in parallel

Prometheus scrapes Feed ranker pods every 15 seconds. Crucially, pods are labeled with `version=v2.3.0` or `version=v2.3.1`, so the same metric series is captured separately for baseline and canary. For our example, here's what's measured in stage 1:  
  
• Baseline (v2.3.0): p99 latency 780 ms, error rate 0.4%  
• Canary (v2.3.1): p99 latency 810 ms, error rate 0.45%  
  
Looks similar at first glance — but is the +30 ms difference real or noise? That's the decision engine's job.

prometheus scrape interval: 15 s · labels: {version, region, cluster} · stored 30 days

SLIs per version · **12** scrape interval · **15 s** stored in TSDB · **30 days**

SLI comparator runs statistical tests

Every 10 seconds, the SLI comparator pulls the last 4 minutes of metrics for both versions and runs three tests per SLI:  
  
**Mann-Whitney U test** — is the canary's distribution different from baseline's? (non-parametric, handles non-Gaussian)  
**Welch's t-test** — is the mean different? (parametric, faster)  
**Cohen's d** — what's the effect size? (statistical significance ≠ practical significance)  
  
For our Feed example: Mann-Whitney returns p=0.003 (significant difference), Cohen's d = 0.18 (small but non-trivial effect). The latency regression is real.

scipy.stats.mannwhitneyu(canary\_p99, baseline\_p99) → p=0.003 · cohens\_d → 0.18 · threshold: p<0.01 AND d>0.2 = rollback

budget · **146 ms/cycle** tests per SLI · **3** p-value threshold · **0.01**

ML engine composes a confidence score

Raw statistical tests give one signal per SLI, but real deploys need **multi-signal correlation**. The ML engine (a Random Forest trained on 2 years of historical deploys, each labeled with its eventual outcome) takes all 12 SLI deltas + statistical results + service-level context (which service, time of day, error budget state) and outputs a single confidence score in \[0, 1\].  
  
For Feed v2.3.1: confidence = 0.31 → **below the 0.5 threshold → rollback recommendation**. The model "saw" similar latency regressions cause incidents in past Feed deploys.

random\_forest.predict(\[sli\_deltas, p\_values, effect\_sizes, service\_meta, time\_features\]) → 0.31

inference latency · **30 ms** model · **Random Forest · 500 trees** training set · **2 years · ~2M deploys**

Error-budget service applies the safety override

Before any final decision, the controller queries the error-budget service: "What's Feed's current monthly error-budget burn?" Feed has burned 65% of its monthly budget already (it's the 20th of the month). That's elevated but not yet critical, so the controller applies **stricter thresholds** — confidence must be ≥ 0.65 to promote (vs 0.5 default), observation windows extend from 4 min to 6 min per stage.  
  
If budget burn were > 80%, the controller would auto-rollback on any negative signal. If budget were healthy (< 40% burned), the canary might've been allowed to proceed with a borderline confidence score.  
  
**This is the "release velocity directly tied to user-facing reliability" link.** A team can't ship recklessly when they've already paid for it in user-facing errors.

budget\_burn = 0.65 → adjusted\_threshold = 0.65 (from 0.5) · canary confidence 0.31 << 0.65 → ROLLBACK

budget < 40% · **standard thresholds** budget 40-80% · **tightened** budget > 80% · **defensive (any negative → rollback)**

Decision: rollback — and the loop closes

Final verdict: **ROLLBACK**. The controller:  
  
(a) Writes new Istio VirtualService with weight 100/0 → all traffic back to v2.3.0. Propagation ~2s.  
(b) Triggers K8s to scale canary pods down (releasing resources).  
(c) Pages the deploy owner (alice@) via the notifier with the decision rationale and links to the SLI graphs.  
(d) Writes the final state transition to the audit log.  
(e) **Circuit-breaks further deploys** of feed-ranker until alice reviews — prevents auto-retry of a known-bad commit.  
  
**Total wall-clock time from first bad metric to baseline fully restored:** ~45 seconds. Inside the 60 s SLO with 15 s margin. The deploy outcome — including the rollback — is in the audit log; alice gets a clean root-cause link.

istio.set\_weights(100, 0) · k8s.scale("canary", replicas=0) · notifier.page(owner) · audit.append("ROLLBACK", reason) · circuit\_breaker.open(service)

e2e typical · **~30 s** e2e p99 · **~45 s** SLO target · **< 60 s ✓ 15s headroom**

The key design insight Notice this is fundamentally a **control system** — perception (collect metrics) → inference (statistical + ML) → action (Istio reconfig) → feedback (next cycle). The same loop runs on every evaluation cycle until the deploy either reaches 100% or rolls back. Treating deploys as control problems (not as scripts) is what makes the system *predictable*: you can reason about failure modes the same way you reason about a thermostat or autopilot.

### 3.3 — Stage progression visualizer

Each stage either promotes (advance), holds (wait one cycle), or rolls back. A normal happy-path deploy takes ~20 minutes. A bad deploy is caught in 45–90 seconds and rolled back.

#### Happy path — clean promotion

baseline 99%

1%

baseline 95%

canary 5%

baseline 75%

canary 25%

baseline 50%

canary 50%

canary 100% (now baseline)

#### Rollback path — bad canary caught at stage 1

baseline 99%

!

baseline 100% (rolled back · 45s after stage 1 start)

| Stage | Canary % | Observation | Decision threshold | What's tested |
| --- | --- | --- | --- | --- |
| 1 | 1% | 4 min | conf ≥ 0.5 (or 0.65 if EB>40%) | does it work at all? |
| 2 | 5% | 4 min | conf ≥ 0.6 | are SLIs comparable at scale? |
| 3 | 25% | 4 min | conf ≥ 0.7 | tail behavior, resource use |
| 4 | 50% | 4 min | conf ≥ 0.75 | load-balancer convergence |
| 5 | 100% | 4 min stabilize | monitor only | final settle, declare promoted |

### 3.4 — Statistical decision close-up (why p < 0.01)

Mann-Whitney U non-parametric

Asks: "Are these two distributions different?" Doesn't assume Gaussian. Robust to outliers. Used as the primary test because real latency distributions are heavy-tailed and skewed.

strengthrobust, distribution-free

weaknessslower to detect small shifts

Welch's t-test parametric

Asks: "Are the means different?" Assumes Gaussian-ish data (CLT helps with large samples). Faster to compute and very sensitive to mean shifts. Used as a tiebreaker.

strengthsensitive to small mean shifts

weaknessfooled by non-normal data

Cohen's d effect size

Asks: "How big is the difference?" Distinct from statistical significance. A 0.001 ms difference can be statistically significant at huge sample sizes but practically meaningless. We require BOTH p<0.01 AND d>0.2 to flag a regression.

guards against"statistically significant noise"

thresholdd > 0.2 (small effect)

Why p < 0.01 (not 0.05) FP control

SLO-C requires FP rate < 0.1%. At p<0.05 with 12 SLIs tested per cycle, family-wise FP rate would be ~46% — disastrous. p<0.01 with Bonferroni correction (effectively p<0.001 per test) keeps family-wise FP under 1%, combined with ML scoring brings actual rollback FP under 0.1%.

family-wise FP @ p<0.05, 12 tests~46% (bad)

family-wise FP @ p<0.001~1.2% (acceptable)

The senior insight Naïve canary controllers fail by checking "is canary error rate > threshold?". This misses everything subtle: a 4% p99 latency creep that doesn't trip the alert threshold but eventually compounds into an outage. Statistical comparison against the *concurrent baseline* catches drift that absolute thresholds miss. The baseline is the real control group — comparing v2.3.1 vs v2.3.0 running at the same instant cancels out time-of-day effects, traffic mix, dependency latencies, everything.

## 4 · Failure gauntlet

A · Metrics pipeline lag SLI: A

Prometheus federation is 90 s behind reality — decisions are made on stale data.

triggerscrape lag > 30 s

absorbHOLD decision until lag < 20 s

fallbackextend observation window

verdictno bad rollback · slightly slower detect

B · Decision engine crash SLI: D

All decision engine pods OOM during a model update.

triggerengine unreachable > 30 s

absorbfail-safe: HOLD all canaries

recoversecondary region engine takes over

verdictdeploys pause · nothing wrongly rolled back

C · Bad model deploy SLI: C

A new ML model regresses; FP rate jumps to 5%.

triggerFP rate > 1% over 24h

absorbauto-fallback to previous model

capshadow-test every new model

verdictFP returns to baseline

D · Istio config push fails SLI: B

Istio CRD apply fails (etcd partition or webhook issue) during rollback.

triggerweight not applied after 10 s

absorbretry with exp backoff

escalatepage SRE; manual kubectl override

verdictrollback succeeds < 60 s

E · Baseline itself is broken SLI: C

Baseline v2.3.0 has its own ongoing incident. Every canary "looks good" relative to a broken baseline.

triggerbaseline SLI absolute threshold breached

absorbpause all canaries for that service

repairrequire baseline recovery before resuming

verdictprevents shipping on top of broken

F · Cosmic-ray promotion SLI: C

By chance, all 12 SLIs of a bad canary look similar to baseline for the observation window.

defense 15 stages of progressive exposure

defense 2error-budget alert post-promote

defense 31h "watch window" after 100%

verdictdetected at stage 3 or post-promote

Not defended against Long-tail regressions that emerge only after 24+ hours (memory leaks, GC drift, queue buildup). The canary observation window is 20 min total — way too short. Mitigation: post-promote monitoring with an alert if any SLI drifts in the 24h after full rollout, with the deploy linked as a likely suspect.

## 5 · Operational playbook

### 5.1 — Self-deployment (recursion)

The canary controller deploys **itself** using the canary controller. This sounds risky but is actually safer: any regression in the controller is caught by the same statistical rigor it applies to other services. The bootstrap problem (controller v1 deploying controller v2) is solved by keeping v1 alive in a separate region during v2 rollout — if v2 breaks, v1 rolls it back from outside.

### 5.2 — Chaos drills (quarterly)

-   **Inject latency in canary pods** — verify detection within SLO.
-   **Inject high error rate in baseline** — verify all canaries paused.
-   **Crash decision engine** — verify fail-safe HOLD behavior.
-   **Corrupt audit log** — verify replay from Kafka.
-   **Istio control-plane outage** — verify retry and SRE escalation.
-   **Saturation test** — push 500 concurrent canaries; verify no backpressure.

### 5.3 — Runbook excerpt

```
# Symptom: "my deploy is stuck in HOLD for 15 minutes"
# Likely causes (ranked)

1. SLI signal is noisy (low traffic service)
   → check signal-to-noise ratio; consider longer observation window
2. Error budget high → tighter thresholds → harder to meet
   → check service's budget burn; may need to wait
3. Metrics pipeline lag
   → check Prometheus federation lag dashboard
4. Decision engine model uncertainty
   → check confidence score history; flat 0.4-0.5 = inconclusive

# First response:
- Check deploy state via Visibility API
- Pull last 5 evaluation cycles
- If clearly fine: SRE can manual-promote with audit reason
- If unclear: extend observation window 2× and let next cycle decide
```

## 6 · Component reference

| Component | Tech | Scale | Failure mitigation | SLO |
| --- | --- | --- | --- | --- |
| **Orchestrator** | Go service | leader-elected · multi-region | hot standby in 2 regions | D |
| **Traffic splitter** | Istio + Envoy | per-cluster CRD | fallback to kubectl manual | B |
| **Metrics collector** | Prometheus federation | per-region scrape | cache last-good for 60s | A,E |
| **SLI comparator** | Python + scipy | per-canary cycle | fail-safe HOLD | A,C |
| **ML engine** | Random Forest (sklearn) | 12 nodes | fallback to threshold rules | C |
| **Error-budget service** | Go + Spanner | region-replicated | cached values 5 min | C |
| **Audit log** | Kafka + S3 archive | per-tenant partition | 3× repl · 1y retention | — |
| **Visibility API** | Go + Spanner | read replicas | cached responses | D |
| **Notifier** | Go (shared with monitoring) | multi-vendor | vendor fallback chain | — |
| **Manual override** | UI + API | SRE-only | requires reason + audit | — |

## 7 · Trade-offs & open questions

#### Chose

-   **Statistical comparison vs absolute thresholds** · catches subtle regressions; trade: needs sufficient traffic per stage.
-   **5 stages over 3** · finer-grained risk gradient; trade: longer rollout (20 min vs 12 min).
-   **Random Forest over deep learning** · explainable ("which SLI drove the decision?"); trade: 1% worse accuracy.
-   **Mann-Whitney + Welch + Cohen** ensemble · no single test fooled by edge cases; trade: 3× CPU per evaluation.
-   **Error-budget integration** · velocity tied to reliability; trade: harder to ship at end of month.
-   **Per-user consistent-hash routing** · no mid-session version swaps; trade: harder to test demographic-specific issues.

#### Rejected

-   **Time-based progression** (just "wait 5 min between stages") · trades safety for simplicity; rejected as it ignores signal.
-   **Big-bang deploy with monitoring** · what most companies do; we already had outages from this in 2024.
-   **Single SLI gate (error rate only)** · misses latency creep, resource issues, business-metric regressions.
-   **Blue/green without traffic split** · less risk per deploy but no real production signal until 100% cut over.
-   **Self-service force-promote without audit** · would erode trust in the system; manual override always logs reason.
-   **Per-region independent decisions** · would split traffic semantics; we decide globally per service.

### Open questions

1.  Should we support **shadow deploys** (mirror prod traffic, write nothing) for write-heavy services that can't tolerate any canary risk?
2.  The ML model is currently service-agnostic. Would **per-service models** improve precision? Trade: 500 models to train and maintain.
3.  Should the controller support **multi-version canaries** (test 3 candidate versions at once)? Useful for A/B/n experiments but explodes the statistical surface.
4.  How to handle **low-traffic services** where statistical significance is impossible in 4 minutes? Currently we just extend windows up to 1h, but that's not always acceptable.
