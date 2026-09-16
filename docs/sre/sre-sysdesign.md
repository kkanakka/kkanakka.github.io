---
title: "SRE Systems Design Playbook"
slug: /sre/sre-sysdesign
sidebar_position: 4
sidebar_label: "SRE Systems Design Playbook"
description: "SRE Systems Design Playbook"
---
10 classic Google SRE design problems with SLO sheets, baseline → production architectures, reliability stressors, trade-off tables, failure drills, and evaluation lens.

Google SRE • Systems Design • 10 Problems • 64 Pages

[Home](/) [NALSD System Design](/docs/sre/sd-google-sre) [Debugging](/docs/sre/sre-debugging)

## The SRE Design Flow — Before You Draw a Single Box

```javascript
STEP 0: Frame the Problem Like an SRE
  → "What is the service trying to guarantee, and to whom?"

THE FLOW:
  Requirements → SLO Contract → Baseline Design → Stressors →
  Resilient Architecture → Observability & Ops → Trade-offs

THE CHECKLIST (for ANY design prompt):
  1. Define User Impact → derive SLOs
  2. Draw the Happy Path
  3. Identify 5 ways it can fail
  4. Apply reliability patterns to each
  5. Decide metrics & dashboards
  6. Prepare rollout & recovery plan
  7. Articulate trade-offs & reasoning

RED FLAG: designing before clarifying requirements
GREEN FLAG: starting with "let me define the SLO contract first"
```

## SLA Uptime Reference — The "Nines" Cheat Sheet

### Allowed Downtime (99.99% SLA)

| Period | Total Time | Allowed Downtime |
| --- | --- | --- |
| Year | 525,600 min | **52.56 min** |
| Month | 43,800 min | **4.38 min** |
| Week | 10,080 min | **1.008 min (~60 sec)** |
| Day | 1,440 min | **8.64 sec** |
| Hour | 60 min | **0.36 sec** |

### The "Nines" Cheat Sheet

| SLA | Annual Downtime |
| --- | --- |
| 99% (2 nines) | ~3.65 days |
| 99.9% (3 nines) | ~8.77 hours |
| **99.99% (4 nines)** | **~52.6 minutes ✅** |
| 99.999% (5 nines) | ~5.26 minutes |
| 99.9999% (6 nines) | ~31.5 seconds |

### How to Calculate (Step by Step)

```
1. Pick your time window in minutes
   e.g. 1 year = 365 × 24 × 60 = 525,600 min

2. Multiply by the downtime fraction  
   downtime fraction = 1 − 0.9999 = 0.0001

3. Result
   525,600 × 0.0001 = 52.56 minutes/year
```

### SRE Interview Pro Tips

**🎯 99.99% is the Google SRE sweet spot** — reliable enough for most services, achievable without heroics

**📊 Error Budget Math:** 99.99% uptime = 0.01% error budget = 1 error per 10,000 requests

**⚡ Failure Impact:** 1 minute outage in 99.99% system consumes ~20% of monthly error budget

**🚨 Five 9s Reality Check:** 5.26 min/year means every deploy, restart, or incident must be ≤1 minute

**💰 Cost vs Reliability:** Each additional 9 typically costs 10x more (99.9% → 99.99% → 99.999%)

#### Error Budget Calculator

```javascript
// JavaScript for SRE interviews
function calculateErrorBudget(sla, requests_per_month) {
    const uptime = sla / 100;
    const error_budget = 1 - uptime;
    const allowed_errors = requests_per_month * error_budget;
    
    return {
        error_budget_percent: error_budget * 100,
        allowed_errors: Math.floor(allowed_errors),
        errors_per_day: Math.floor(allowed_errors / 30),
        mtbf_minutes: (30 * 24 * 60) / Math.floor(allowed_errors / 30)
    };
}

// Example: 1M requests/month at 99.99% SLA
calculateErrorBudget(99.99, 1000000);
→ {error_budget: 0.01%, allowed_errors: 100, errors_per_day: 3, mtbf: 480min}
```

#### Real-World SLO Examples (Google/Netflix Pattern)

```
📊 API Service SLOs:
  • Availability: 99.99% (measured by HTTP 200-299 responses)
  • Latency: p95 ≤ 200ms, p99 ≤ 500ms (measured at load balancer)
  • Throughput: ≥ 10K RPS sustained (measured per region)

🛒 E-commerce Checkout SLOs:
  • Success Rate: 99.95% (measured by payment completion)
  • Latency: p95 ≤ 1s, p99.9 ≤ 3s (end-to-end user experience)
  • Data Durability: 99.999999999% (11 nines for order data)

📱 Mobile API SLOs:
  • Availability: 99.9% (mobile apps handle degradation better)
  • Latency: p90 ≤ 500ms (mobile networks are slower)
  • Error Rate: ≤ 0.5% (includes 4xx client errors)

🔍 Search Service SLOs:
  • Recall: ≥ 95% (find relevant results)
  • Latency: p99 ≤ 100ms (user expectation for search)
  • Freshness: 90% of updates reflected within 10 minutes
```

## 10 Classic Design Problems

1.  [Feature-Flag Service](#d1) — Progressive rollouts, blast radius, kill switch [\[LinkedIn Deep Dive →\]](/docs/linkedin/linkedin-feature-flags)
2.  [Secrets Rotation System](#d2) — Zero-downtime key rotation, dual-key pattern [\[LinkedIn Deep Dive →\]](/docs/linkedin/linkedin-secrets-rotation)
3.  [Disaster-Recovery Orchestrator](#d3) — RTO/RPO, split-brain, failback [\[LinkedIn Deep Dive →\]](/docs/linkedin/linkedin-disaster-recovery)
4.  [Build-Artifact Cache](#d4) — Content-addressable storage, lease eviction, CI/CD [\[LinkedIn Deep Dive →\]](/docs/linkedin/linkedin-build-cache)
5.  [Config Management System](#d5) — Drift detection, canary configs, freeze mode [\[LinkedIn Deep Dive →\]](/docs/linkedin/linkedin-config-management)
6.  [Realtime Metrics Aggregator](#d6) — 10M metrics/s, cardinality, TSDB [\[LinkedIn Deep Dive →\]](/docs/linkedin/linkedin-metrics-aggregator)
7.  [Kubernetes Autoscaler](#d7) — SLO-aware control, feedback stability, cost optimization [\[LinkedIn Deep Dive →\]](/docs/linkedin/linkedin-kubernetes-autoscaler)
8.  [Capacity Planner Service](#d8) — ML forecasting, error budgets, procurement automation [\[LinkedIn Deep Dive →\]](/docs/linkedin/linkedin-capacity-planner)
9.  [Incident Replay Simulator](#d9) — Chaos training, reliability learning, SRE education [\[LinkedIn Deep Dive →\]](/docs/linkedin/linkedin-incident-simulator)
10.  [Cost-Aware Alerting System](#d10) — Budget burn, sustainable ops, cost as SLO [\[LinkedIn Deep Dive →\]](/docs/linkedin/linkedin-cost-aware-alerting)
11.  [Auto-Scaling Engine](#d7) — HPA/VPA/CA, latency-based scaling, PDB
12.  [Capacity Planning System](#d8) — Forecasting, BDP math, error budgets
13.  [Incident Replay Simulator](#d9) — Chaos engineering, sandbox isolation, scoring
14.  [Cost-Aware Alerting System](#d10) — Budget burn, cost SLOs, waste detection

<a id="d1"></a>

### #1 — Design a Feature-Flag Service

Progressive Rollouts | Reliability vs Velocity | Safe Experimentation

#### SLO Sheet

| Objective | Target |
| --- | --- |
| Flag evaluation latency | ≤ 2ms (p95) — critical path |
| Availability | ≥ 99.999% — must not block traffic if backend down |
| Rollout consistency | ≥ 99.9% — all users in cohort see same behavior |
| Propagation delay | ≤ 30s — flag update → edge apply |
| Audit integrity | 100% — immutable audit trail |

#### Architecture: 5 Components

<img src="/diagrams/sre-sysdesign/1.svg" alt="sre-sysdesign diagram 1" class="doc-diagram" />

 **Data Flow:**

```
1. Admin updates flag via Control Plane API
2. Change persisted to Metadata Store (Spanner)
3. Distribution Plane streams delta to all regions
4. Edge Evaluators update in-memory cache (≤30s)
5. Services evaluate flags locally (≤2ms)
6. All operations logged to Audit Service
```

**Key APIs:**

```
POST /flags/{id}/rollout
{
  "rollout_percentage": 25,
  "targeting_rules": {
    "user_segment": "beta_users",
    "geo_regions": ["us-west", "us-east"]
  },
  "gradual_rollout": {
    "stages": [5, 25, 50, 100],
    "stage_duration": "10m"
  }
}

// Edge Evaluation (local)
GET /eval?flag=new_checkout&user=u123&context={...}
→ {"enabled": true, "version": "v47", "cohort": "treatment_a"}
```

#### Reliability Stressors

Partial rollout stalls (one region misses update). Clock skew (cohort hashing diverges). Hot flag evaluation (millions/sec). Misconfigured targeting (bad regex). Network partition (control plane unreachable).

#### Production Patterns

**Edge-First Evaluation** (zero dependency on central store). **Delta Streaming** (only diffs, not full snapshots). **Versioned Flags + Fallback** (keep last known good). **Gradual Rollout**: 5% → 25% → 50% → 100% with metric checks + consistent user hashing. **Global Kill Switch**: disable any flag in <10s.

#### Metrics

Propagation delay (≤30s, page if >60s). Evaluation latency (≤2ms). Flag drift rate (<0.1%). Rollback success rate (100%).

#### Trade-offs

Edge eval: ultra-low latency but cache invalidation risk. Central eval: simpler audit but adds RTT. Delta streaming: bandwidth efficient but state complex. Full snapshot: simpler resync but high network.

**Failure Drill:** Flag rolled back but 20% of Europe still shows new behavior → detect via drift metrics → force "resync-all" → validate Pub/Sub delivery logs → add checksum verification on edge payloads.

**Scoring:** Reliability vs velocity? Rollback + kill switch discussed? SLOs and flag-drift metrics? Hash-based targeting + data freshness?

<a id="d2"></a>

### #2 — Design a Secrets Rotation System

Security SLOs | Zero-Downtime Rotation | Dual-Key Pattern

#### SLO Sheet

| Objective | Target |
| --- | --- |
| Secret propagation latency | ≤ 60s (p99) |
| Control plane availability | ≥ 99.999% |
| Rotation success rate | ≥ 99.9% automated |
| Audit log completeness | 100% |

#### Architecture

<img src="/diagrams/sre-sysdesign/2.svg" alt="sre-sysdesign diagram 2" class="doc-diagram" />

 **Dual-Key Protocol:**

```
Phase 1: Generate new_key, distribute to all consumers
Phase 2: Both old_key + new_key accepted (15min overlap)
Phase 3: Switch primary to new_key, old_key as fallback
Phase 4: Health validation across all services
Phase 5: Deactivate old_key, promote new_key to sole
```

#### Key Pattern: Dual-Key Rotation

Maintain **old\_key + new\_key** overlap window (15 min). Both accepted during transition. Clients gracefully migrate. Pull+Push hybrid for eventual consistency. Versioned secrets (`secret_id@version`). Fail-safe rollback to previous valid version.

**Implementation:**

```python
class SecretConsumer:
    def __init__(self):
        self.primary_key = None
        self.fallback_key = None
        
    def validate_signature(self, token, signature):
        # Try primary first, fallback if invalid
        if self.primary_key and verify(token, signature, self.primary_key):
            return True
        if self.fallback_key and verify(token, signature, self.fallback_key):
            return True
        return False
            
    def rotate_keys(self, new_key):
        self.fallback_key = self.primary_key
        self.primary_key = new_key
        # Start 15min timer to drop fallback
```

**Failure Drill:** Secret drift >1% in APAC → auto-trigger pull-based self-healing → Rotation Controller pauses new rotations → if auto-remediation fails: one-click rollback to previous\_valid\_version → blameless postmortem.

<a id="d3"></a>

### #3 — Design a Disaster-Recovery Orchestrator

Business Continuity | RTO/RPO | Split-Brain Prevention

#### SLO Sheet

| Objective | Target |
| --- | --- |
| RTO (Recovery Time) | ≤ 5 minutes |
| RPO (Recovery Point) | ≤ 30 seconds |
| Switchover success rate | ≥ 99.99% |
| False failover rate | ≤ 0.1% |
| Failback completion | ≤ 10 minutes |

#### Architecture

<img src="/diagrams/sre-sysdesign/3.svg" alt="sre-sysdesign diagram 3" class="doc-diagram" />

 **Failover Sequence (RTO ≤ 5min):**

```
T+0s:  Health probe detects primary failure (3/5 checks fail)
T+30s: DR Controller consensus via Raft (prevents split-brain)  
T+60s: Stop accepting writes to primary (if reachable)
T+90s: Promote DR replica to master, catchup from WAL
T+120s: Update DNS records (primary.app → dr.app)
T+180s: Warm up DR app cluster, validate synthetic transactions
T+240s: Route production traffic to DR region
T+300s: Failover complete, monitor for 15min
```

**Split-Brain Prevention:**

```go
// Raft-based DR Controller ensures single decision maker
type DRController struct {
    raftNode     *raft.Raft
    isLeader     bool
    lastDecision time.Time
}

func (d *DRController) InitiateFailover() error {
    if !d.raftNode.State() == raft.Leader {
        return errors.New("not leader, cannot initiate failover")
    }
    
    // Propose failover decision to Raft cluster
    proposal := FailoverProposal{Timestamp: time.Now(), Reason: "primary_unhealthy"}
    if err := d.raftNode.Apply(proposal.Encode(), 10*time.Second); err != nil {
        return err
    }
    // Only proceed if consensus reached
}
```

#### Stressors

Split-brain (both regions think they're primary). Replication lag > RPO. Flaky health probes (false failover). Dependent service ordering. Operator delay.

#### Production Patterns

**Multi-tier health assessment** (active ping + synthetic txns + dependency checks). **Leader election via Paxos/Raft** (guarantees single DR controller). **Staged failover**: DNS → drain → data rebind → warm-up. **Snapshot + stream merge** for minimal RPO. **Monthly chaos testing** to validate readiness.

#### Trade-offs

Async replication: lower latency but non-zero RPO. Sync: zero data loss but higher write latency. Automated failover: fast but risk of false triggers. Manual: safer but slower.

<a id="d4"></a>

### #4 — Design a Build-Artifact Cache

CI/CD Reliability | Content-Addressable Storage | Dedup

#### SLO Sheet

| Objective | Target |
| --- | --- |
| Artifact retrieval latency | p95 ≤ 100ms |
| Cache hit rate | ≥ 90% |
| Availability | ≥ 99.99% |
| Stale artifact probability | ≤ 0.1% |

#### Architecture

<img src="/diagrams/sre-sysdesign/4.svg" alt="sre-sysdesign diagram 4" class="doc-diagram" />

 **Content-Addressable Storage (CAS):**

```
// Every artifact identified by SHA-256 of its contents
artifact_hash = sha256(file_contents)
storage_path = "/cache/" + artifact_hash[:2] + "/" + artifact_hash[2:4] + "/" + artifact_hash

// Deduplication is automatic - identical content = same hash = single storage
PUT /artifacts/a1b2c3d4e5f6... HTTP/1.1
Content-Length: 1048576
Content-Type: application/octet-stream

GET /artifacts/a1b2c3d4e5f6... HTTP/1.1
→ 200 OK (from L1 hot cache, ≤100ms)
→ 301 Redirect to L2 cold store if not in L1
```

**Lease-Based Eviction:**

```python
// Prevent eviction of artifacts during active builds
class LeaseManager:
    def acquire_lease(self, artifact_hash, build_id, ttl=3600):
        # Lock artifact from eviction during build
        redis.setex(f"lease:{artifact_hash}", ttl, build_id)
        
    def can_evict(self, artifact_hash):
        return not redis.exists(f"lease:{artifact_hash}")
        
    def evict_lru(self, target_size):
        candidates = [a for a in lru_list if self.can_evict(a.hash)]
        evict_until_size(candidates, target_size)
```

#### Production Patterns

**CAS** (Content-Addressable Storage): SHA-256 hash = address. **Two-tier cache**: SSD L1 hot + object store L2 cold. **Lease-based eviction**: prevent removal during active build. **Bloom filter index**: avoid rebuilds during global sync lag. **Checksum validation pipeline**: CRC + periodic audit for bit-rot.

<a id="d5"></a>

### #5 — Design a Config Management System

Consistency | Drift Detection | Canary Configs | Freeze Mode

#### SLO Sheet

| Objective | Target |
| --- | --- |
| Config propagation latency | ≤ 60s |
| Rollback latency | ≤ 30s |
| Config drift rate | < 0.01% |
| Corruption probability | 0 |
| Availability | ≥ 99.999% |

#### Production Patterns

**Immutable config versions**: rollback = pointer swap. **Canary rollouts**: deploy to <1% fleet first + SLO metric comparison. **Drift detection loop**: agents hash current config → report to registry. **Validation stages**: pre-submit (schema) → pre-rollout (runtime dry-run) → post-deploy (metric regression). **Emergency freeze mode**: prevents changes during active incident.

**Failure Drill:** Config update introduces wrong load-balancing ratio → canary detects → auto-rollback (version pointer flip) → clients revert within 20s → Schema Validator updated with new constraint.

<a id="d6"></a>

### #6 — Design a Realtime Metrics Aggregator

10M Metrics/s | High Cardinality | Borgmon/Monarch/Stackdriver

#### SLO Sheet

| Objective | Target |
| --- | --- |
| Ingestion throughput | ≥ 10M metrics/s globally |
| Ingest latency | p99 ≤ 1s |
| Query latency | p99 ≤ 2s |
| Availability | ≥ 99.999% — monitoring must never go dark |
| Metric loss rate | < 0.001% |

#### Architecture

<img src="/diagrams/sre-sysdesign/5.svg" alt="sre-sysdesign diagram 5" class="doc-diagram" />

 **Tiered Storage Strategy:**

```
Hot Tier (≤2hr):   In-memory TSDB, ≤100ms query, recent dashboards
Warm Tier (≤7d):   SSD-based storage, ≤2s query, historical analysis
Cold Tier (≤6mo):  Object store, ≤30s query, compliance/forensics

// Automatic aging policy
retention_policy = {
  "hot": {"duration": "2h", "storage": "memory"},
  "warm": {"duration": "7d", "storage": "ssd", "downsample": "1m"},
  "cold": {"duration": "180d", "storage": "gcs", "downsample": "5m"}
}
```

**Cardinality Control (Critical for 10M/s):**

```python
// Prevent cardinality explosions that kill TSDB
class CardinalityGuard:
    def validate_metric(self, metric_name, labels):
        series_id = f"{metric_name}[{sorted(labels.items())}]"
        
        # Check label value cardinality (prevent user_id in labels!)
        for k, v in labels.items():
            if self.get_cardinality(k) > MAX_CARDINALITY[k]:
                return {"error": f"label {k} exceeds cardinality limit"}
                
        # Check overall series growth rate
        if self.series_growth_rate() > 10000:  # 10K new series/min
            return {"error": "series growth rate exceeded"}
            
        return {"ok": True}
```

#### Stressors

Cardinality explosion (per-host × per-endpoint × per-status = billions of series). Ingestion backpressure. Query fanout across regions. Hot metrics (one dashboard = millions of reads). Cold queries (12-month range).

<a id="d7"></a>

### #7 — Design an Auto-Scaling Engine

HPA / VPA / Cluster Autoscaler | Latency-Based Scaling | PDB

#### SLO Sheet

| Objective | Target |
| --- | --- |
| Scale-out latency | ≤ 60s (pod ready) |
| Scale-in safety | No SLO violations during scale-down |
| Node provisioning | ≤ 5min (new nodes) |
| False scaling rate | ≤ 1% (due to metric noise) |

#### Architecture

<img src="/diagrams/sre-sysdesign/6.svg" alt="sre-sysdesign diagram 6" class="doc-diagram" />

 **Latency-Based HPA Algorithm:**

```python
def calculate_replicas(current_replicas, target_latency_ms, current_latency_p95):
    # Better SLO proxy than CPU utilization
    if current_latency_p95 <= target_latency_ms * 0.8:
        # Well under target - scale down (slow)
        target = max(min_replicas, current_replicas - 1)
        cooldown = 300  # 5min scale-in protection
    elif current_latency_p95 >= target_latency_ms:
        # Above SLO - scale out (fast)  
        scale_factor = min(2.0, current_latency_p95 / target_latency_ms)
        target = min(max_replicas, int(current_replicas * scale_factor))
        cooldown = 60   # 1min scale-out
    else:
        target = current_replicas  # steady state
        
    return target, cooldown
```

**Pod Disruption Budget (PDB) Integration:**

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
spec:
  minAvailable: 75%  # Never drop below 75% during scale-in
  selector:
    matchLabels:
      app: payment-service
      
# Autoscaler respects PDB - won't scale down if it would violate minAvailable
```

#### Key Patterns

**HPA**: horizontal pod autoscaler (scale replicas on latency/CPU). **VPA**: vertical pod autoscaler (adjust resource requests). **Cluster Autoscaler**: provision/deprovision nodes. **PDB** (Pod Disruption Budget): ensures minimum replicas during scaling/upgrades. **Latency-based HPA**: scale on p95 latency, not CPU (better SLO proxy). **Cool-down periods**: prevent flapping (scale out fast, scale in slow).

#### Trade-offs

Latency-based HPA: direct SLO control but needs robust metric path. CPU-based HPA: simple but weak proxy. Fast scale-out / slow scale-in: protects SLO but higher cost. Overprovision buffer nodes: handles bursts but idle cost.

<a id="d8"></a>

### #8 — Design a Capacity Planning System

Forecasting | Saturation Probability | Capacity Error Budget

#### Architecture

Ingest Pipeline (RPS, CPU, memory, storage, egress + event calendars) → Feature Builder (seasonality, trend, anomalies, promo flags) → Forecaster (Prophet/ETS + Gradient Boosting) → Risk Engine (saturation probability → capacity error budget) → Action Planner (reservations, change requests) → Feedback Loop (actuals vs forecast → retrain)

**Scoring:** SLO-first capacity thinking (Capacity Error Budget). Probabilistic reasoning (quantiles, confidence bands). Constraint awareness (quotas, bin-packing, hardware lead times). Cross-service coupling (upstream → downstream effects).

<a id="d9"></a>

### #9 — Design an Incident Replay Simulator

Chaos Engineering | Postmortem Training | Sandbox Isolation

#### Architecture

Incident Archive → Replay Engine (telemetry at original cadence) → Synthetic Injectors → Scenario Orchestrator → Sandbox Environment (isolated clusters) → Trainer Dashboard → Scoring Engine (MTTD, MTTR)

#### Key Patterns

**Time-warped playback** (1x, 2x, paused with commentary). **Data sanitization** (remove PII). **Sandbox isolation** (ephemeral clusters, no prod access). **Incident templates** (generalized classes: DB spike, config rollback, CrashLoop). **Chaos extensions** (inject variant stressors beyond original). **Self-service portal**.

<a id="d10"></a>

### #10 — Design a Cost-Aware Alerting System

Budget Burn vs Reliability | Cost as Operational Signal | Waste Detection

#### SLO Sheet

| Objective | Target |
| --- | --- |
| Alert latency (cost anomaly) | ≤ 2 min |
| Cost coverage | ≥ 95% of billable services |
| False positive rate | ≤ 5% (cost alerts) |
| Waste detection | ≥ 90% of idle resources |

#### Architecture

<img src="/diagrams/sre-sysdesign/7.svg" alt="sre-sysdesign diagram 7" class="doc-diagram" />

 **Cost-Per-Request Anomaly Detection:**

```python
class CostAnomalyDetector:
    def detect_anomaly(self, service_name, time_window="1h"):
        # Fetch cost and request metrics
        cost = get_cost_for_service(service_name, time_window)
        requests = get_request_count(service_name, time_window) 
        
        cost_per_request = cost / max(requests, 1)
        baseline_cpr = get_baseline_cpr(service_name, "7d")
        
        # Alert if cost/request > 2x baseline
        if cost_per_request > baseline_cpr * 2.0:
            severity = "HIGH" if cost_per_request > baseline_cpr * 3.0 else "MEDIUM"
            
            alert = {
                "service": service_name,
                "cost_per_request": cost_per_request,
                "baseline": baseline_cpr,
                "multiplier": cost_per_request / baseline_cpr,
                "severity": severity
            }
            
            return alert
```

**Budget Burn Rate Monitoring:**

```python
def check_budget_burn_rate(team, monthly_budget):
    days_in_month = 30
    days_elapsed = get_current_day_of_month()
    
    actual_spend = get_month_to_date_spend(team)
    expected_spend = monthly_budget * (days_elapsed / days_in_month)
    burn_rate = actual_spend / expected_spend
    
    # Alert thresholds
    if burn_rate > 1.5:  # 50% over budget pace
        return {"alert": "CRITICAL", "projected_overage": monthly_budget * (burn_rate - 1)}
    elif burn_rate > 1.2:  # 20% over budget pace  
        return {"alert": "WARNING", "projected_overage": monthly_budget * (burn_rate - 1)}
        
    return {"status": "OK"}
```

#### Key Insight

Make **cost an operational signal** — as important as latency or availability. Alert on: cost spikes (sudden 3x), sustained overprovisioning (>30% idle for 7 days), cost-per-request anomalies, budget burn rate exceeding forecast. Integrate with SLO dashboards: show cost-to-achieve-SLO alongside availability.

**Senior Signal:** "If this system costs $10M/month at 99.99% but we only need 99.9%, this alerting system quantifies exactly where the $4M savings are."
