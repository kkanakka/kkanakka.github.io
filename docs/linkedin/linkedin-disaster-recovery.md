---
title: "Disaster Recovery Orchestrator"
slug: /linkedin/linkedin-disaster-recovery
sidebar_position: 3
sidebar_label: "Disaster Recovery Orchestrator"
description: "Disaster Recovery Orchestrator"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/linkedin-disaster-recovery/sequence.svg" alt="How it works — linkedin-disaster-recovery" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
Business Continuity Design — Automated Regional Failover

A resilience-first DR orchestrator for LinkedIn scale: 5-minute RTO, 30-second RPO, automated failover with Raft consensus, and chaos engineering validation. Built for zero-manual-intervention business continuity.

Business Critical

5-Page Deep Dive

Zero Manual Intervention

[Home](/) [Design Framework](/docs/foundations/sre-design-framework) [SRE Systems](/docs/sre/sre-sysdesign) [Secrets Rotation](/docs/linkedin/linkedin-secrets-rotation)

## Table of Contents — 5-Page DR Architecture

1.  [System Overview & Business Continuity Philosophy](#overview)
2.  [Core Architecture & LinkedIn Components](#architecture)
3.  [Implementation Details & Raft Consensus](#implementation)
4.  [Disaster Scenarios & Regional Failover](#reliability)
5.  [Operations, Chaos Testing & Validation](#operations)

<a id="overview"></a>

## Page 1 — System Overview & Business Continuity Philosophy

### What This System Is

A **"Business Continuity Orchestrator"** that automatically detects regional failures, promotes standby regions, and coordinates data recovery for LinkedIn's critical services. The system must handle full-region loss, maintain data consistency, and orchestrate dependency recovery — all without manual intervention while meeting strict RTO/RPO targets.

#### Recovery Level Objectives (RLOs)

| Objective | Target | Measurement |
| --- | --- | --- |
| Recovery Time Objective (RTO) | ≤ 5 minutes | Time to restore full service after region failure |
| Recovery Point Objective (RPO) | ≤ 30 seconds | Max acceptable data loss from last checkpoint |
| Switchover Success Rate | ≥ 99.99% | Includes automated failover tests |
| False Failover Rate | ≤ 0.1% | Avoid unnecessary cutovers |
| Failback Completion | ≤ 10 minutes | After primary returns healthy |
| Split-Brain Prevention | 100% | Never have dual-primary regions |

### Business Continuity Philosophy: Automated Resilience

#### System Architecture — Multi-DC Disaster Recovery & Automated Failover

### 🌍 LinkedIn Disaster Recovery Orchestrator

Multi-Region Automated Failover Architecture

✅ NORMAL OPERATIONS — All Regions Healthy

🌟 PRIMARY (LTX1)

**Member API:** ✅ ACTIVE  
**Feed Service:** ✅ ACTIVE  
**Espresso DB:** ✅ PRIMARY  
**Traffic:** 100% serving

**Health Score:** 100%  
**Latency P99:** 45ms  
**Error Rate:** 0.01%

1\. Async Replication  
⬇️  
`Brooklin → Kafka`  
`TCP 9092`

2\. Health Probes  
⬇️  
`HTTPS 443`  
`Every 10s`

🔥 HOT STANDBY (LVA1)

**Member API:** ⏸️ STANDBY  
**Feed Service:** ⏸️ STANDBY  
**Espresso DB:** 📄 REPLICA  
**Traffic:** 0% (ready)

**Repl Lag:** 12s  
**Last Sync:** 2s ago  
**Status:** HEALTHY

**❄️ COLD DR (EI4)**  
Snapshot: 4h old

**🌡️ WARM DR (CORP)**  
Repl Lag: 5min

**🏗️ STAGING (DEV)**  
Test traffic only

🚨 FAILURE DETECTED — Primary Region Down

⏱️ Detection Timeline (90 seconds)

**T+0s**  
Health probe timeout  
`HTTP 503`

→

**T+30s**  
3 consecutive failures  
`Threshold breached`

→

**T+60s**  
Synthetic tests fail  
`End-to-end broken`

→

**T+90s**  
FAILURE DECLARED  
`Initiate failover`

🧠 Raft Consensus Decision (30 seconds)

**NODE 1**  
DR-Controller-LTX1  
LEADER  
Vote: FAILOVER ✅

**NODE 2**  
DR-Controller-LVA1  
FOLLOWER  
Vote: FAILOVER ✅

**NODE 3**  
DR-Controller-EI4  
FOLLOWER  
Vote: FAILOVER ✅

**NODE 4**  
DR-Controller-CORP  
FOLLOWER  
Vote: FAILOVER ✅

**NODE 5**  
DR-Controller-GRID  
FOLLOWER  
Vote: FAILOVER ✅

🎯 QUORUM ACHIEVED: 5/5 nodes agree → FAILOVER TO LVA1 AUTHORIZED

🔄 AUTOMATED FAILOVER EXECUTION — 5 Minute RTO

STAGE 1: DNS SWITCH

**Timeline:** T+0 to T+60s  
**Action:** Route 53 update  
**Old:** api.linkedin.com → LTX1  
**New:** api.linkedin.com → LVA1  
**TTL:** 60 seconds  
**Protocol:** DNS over HTTPS

Status: ✅ COMPLETED

STAGE 2: TRAFFIC DRAIN

**Timeline:** T+60 to T+120s  
**Action:** ALB connection drain  
**Method:** Graceful shutdown  
**Wait:** Active connections finish  
**Timeout:** 60s max  
**Protocol:** HTTP keep-alive

Status: ✅ COMPLETED

STAGE 3: DB PROMOTE

**Timeline:** T+120 to T+180s  
**Action:** Espresso replica promote  
**Method:** Primary election  
**Check:** Replication lag < 30s  
**Validate:** Write test successful  
**Protocol:** HTTP + Avro

Status: ✅ COMPLETED

STAGE 4: WARMUP

**Timeline:** T+180 to T+300s  
**Action:** Cache population  
**Method:** Preload hot data  
**Target:** 80% cache hit rate  
**Validate:** Synthetic test pass  
**Protocol:** Memcached TCP 11211

Status: ✅ COMPLETED

🎉 FAILOVER COMPLETE — LVA1 NOW PRIMARY — RTO: 4m 32s — RPO: 18s — SUCCESS ✅

✅ POST-FAILOVER OPERATIONS — New Normal State

🌟 NEW PRIMARY (LVA1)

**Member API:** ✅ ACTIVE  
**Feed Service:** ✅ ACTIVE  
**Espresso DB:** ✅ PRIMARY  
**Traffic:** 100% serving

**Health Score:** 98%  
**Latency P99:** 52ms  
**Error Rate:** 0.02%

💀 FAILED REGION (LTX1)

**Member API:** ❌ DOWN  
**Feed Service:** ❌ DOWN  
**Espresso DB:** ❌ UNREACHABLE  
**Traffic:** 0% (drained)

**Status:** INVESTIGATING  
**ETA:** Recovery TBD  
**Action:** Ops team paged

📊 MONITORING ACTIVE

**Alerts Fired:** 47 total  
**Incidents Created:** SEV-1  
**War Room:** ACTIVE  
**Comms:** Status page updated

**Next Check:** 10s  
**Failback Ready:** When LTX1 healthy  
**Manual Override:** Available

**🔧 Technical Protocols:**  
• Health probes: HTTPS/443 + TCP/80  
• Raft consensus: TCP/8300  
• DB replication: Brooklin + Kafka/9092  
• DNS updates: Route 53 API  
• Load balancer: ALB connection draining  
• Cache: Memcached/11211 + Redis/6379

**📊 Key Metrics:**  
• RTO Target: ≤ 5 minutes  
• RPO Target: ≤ 30 seconds  
• Availability: 99.999% (5.26min/year)  
• MTTR: 4.5 minutes average  
• False positive rate: < 0.1%  
• Split-brain incidents: 0 (prevented)

**🎯 Success Criteria:**  
• Zero data loss (within RPO)  
• No manual intervention required  
• All synthetic tests passing  
• Cache hit rate > 80%  
• Error rate < 0.05%  
• Customer impact < 5 minutes

#### Core DR Principles

-   **Zero Manual Intervention** — Fully automated detection, failover, and recovery
-   **Split-Brain Prevention** — Raft consensus ensures single active primary globally
-   **Multi-Tier Health Assessment** — Active ping, synthetic transactions, dependency checks
-   **Staged Failover** — DNS → Traffic Drain → Data Rebind → Warm-up Validation
-   **Snapshot + Stream Merge** — Minimal RPO with periodic snapshots + streaming replication
-   **Chaos Engineering Integration** — Monthly regional failure injection for validation

### Six Core Components

1.  **Health Probe Engine** — Multi-dimensional health monitoring (latency, availability, dependencies)
2.  **Decision Controller** — Raft-based consensus for failover decisions
3.  **Replication Manager** — Async replication with snapshot+stream architecture
4.  **Orchestration Pipeline** — Staged DNS, load balancer, and dependency coordination
5.  **Failback Module** — Automated primary restoration with data catch-up
6.  **Simulation Framework** — Chaos engineering and game-day validation

### LinkedIn Service Tiers & DR Strategies

#### Service Classification by Business Impact

| Tier | Services | RTO | RPO | DR Strategy |
| --- | --- | --- | --- | --- |
| **Tier 0** | Member Auth, Core API | 1 minute | 0 seconds | Sync replication + Hot standby |
| **Tier 1** | News Feed, Messaging | 5 minutes | 30 seconds | Async replication + Warm standby |
| **Tier 2** | Jobs, Learning | 15 minutes | 5 minutes | Snapshot + Cold standby |
| **Tier 3** | Analytics, Reporting | 1 hour | 1 hour | Batch backup + Manual recovery |

#### Disaster Scenarios by Scope

#### Critical Failure Categories

-   **Availability Zone Failure:** Single AZ down → Load balancer redirect (30s RTO)
-   **Regional Failure:** Entire AWS region down → Cross-region failover (5min RTO)
-   **Service-Specific Outage:** Application failure → Service-level DR (2min RTO)
-   **Data Corruption:** Bad deployment or data → Point-in-time recovery (15min RTO)
-   **Network Partition:** Cross-region connectivity loss → Split-brain prevention
-   **Cascading Failure:** Dependency chain failure → Dependency-aware recovery

### Reliability Stressors (What Can Break)

#### Advanced Failure Modes

-   **Split-Brain Failover:** Both regions believe they are primary → Data divergence
-   **Replication Lag:** Data loss > RPO → Inconsistent user experience
-   **Flaky Health Probes:** False positives triggering unnecessary failover
-   **Dependent Service Delay:** DB restored before cache → Cascading errors
-   **DNS Propagation Delay:** TTL causes traffic to failed region
-   **Cross-Region Network Partition:** Replication broken but regions still accessible
-   **Partial Region Degradation:** Some services healthy, others failed

<a id="architecture"></a>

## Page 2 — Core Architecture & LinkedIn Components

### Detailed LinkedIn DR Architecture — Production Implementation

### LinkedIn Component Integration

#### Health Probe Engine Implementation

**Multi-Tier Health Assessment:** Comprehensive health validation before failover

-   **Layer 1 - Infrastructure Health:** AWS CloudWatch, network connectivity, DNS resolution
-   **Layer 2 - Service Health:** HTTP health checks, application metrics, resource utilization
-   **Layer 3 - Business Logic Health:** Synthetic transactions, end-to-end workflows
-   **Layer 4 - Dependency Health:** Database connectivity, cache hit rates, external API latency
-   **Consensus Requirement:** 3 of 4 layers must fail for 2+ minutes to trigger failover

#### Raft-Based Decision Controller

**Split-Brain Prevention:** Distributed consensus for failover decisions

#### Replication Manager Architecture

**Snapshot + Stream Pattern:** Minimal RPO with efficient bandwidth usage

### Cross-Datacenter Topology

| Datacenter | DR Role | Service Deployment | Data Replication | Failover Time |
| --- | --- | --- | --- | --- |
| **LTX1** | Primary Active | Full deployment | Source for all | N/A |
| **LVA1** | Hot Standby | Warm services | Async replica | 5 minutes |
| **EI4** | DR Testing | Test environment | Test data | Manual |
| **Grid2** | Cold DR | Minimal footprint | Backup storage | 30 minutes |

##### ✅ Architecture Benefits

-   Automated failover with zero manual intervention
-   Raft consensus prevents split-brain scenarios
-   Multi-tier health assessment reduces false triggers
-   Staged failover minimizes blast radius
-   Built-in chaos testing validates readiness

##### ⚠️ Architecture Trade-offs

-   5-minute RTO may be too slow for Tier 0 services
-   30-second RPO allows some data loss
-   Complex consensus protocol adds latency
-   Cross-region replication costs
-   Requires significant standby capacity

<a id="implementation"></a>

## Page 3 — Implementation Details & Raft Consensus

### Staged Failover Implementation

#### Four-Stage Failover Pipeline

Coordinated sequence minimizes blast radius and ensures dependency ordering

### Split-Brain Prevention with Raft

#### Distributed Leadership Election

5-node Raft cluster ensures single primary region globally

### Dependency-Aware Recovery

#### Service Recovery Ordering

<a id="reliability"></a>

## Page 4 — Disaster Scenarios & Regional Failover

### Critical Disaster Scenarios

#### Scenario 1: Complete Regional Failure

**Disaster:** Entire LTX1 region unavailable (AWS outage)

**Detection Timeline:**

-   **30s:** Infrastructure health checks fail
-   **60s:** Service health checks timeout
-   **90s:** Synthetic transactions fail
-   **120s:** Raft consensus for failover

**Automated Response (5 minutes):**

-   **DNS Cutover:** Route53 → LVA1 (30s)
-   **Data Promotion:** Espresso replica → primary (120s)
-   **Service Scaling:** Warm standby → full capacity (90s)
-   **Validation:** Health + synthetic tests (90s)

#### Scenario 2: Split-Brain Prevention

**Risk:** Network partition between regions

**Raft Protection:**

-   Isolated LTX1: Only 2 of 5 nodes → Cannot make decisions
-   Connected LVA1+EI4: 3 of 5 nodes → Can elect new primary
-   Automatic demotion when quorum lost

### Cross-Region Failover Matrix

| Failure Type | Target | RTO | RPO | Data Loss |
| --- | --- | --- | --- | --- |
| Single AZ failure | Other AZs | 30s | 0 | None |
| Regional failure | LVA1 | 5min | 30s | Low |
| Multi-region failure | Grid2 | 30min | 1hr | Medium |

### Chaos Engineering

#### Monthly DR Validation

<a id="operations"></a>

## Page 5 — Operations, Chaos Testing & Validation

### Incident Response Playbooks

#### Runbook: Regional Failover Active

**Alert:** "DR failover LTX1 → LVA1 initiated"

**Actions (First 5 minutes):**

1.  Monitor DR dashboard for stage progress
2.  Validate LVA1 service health
3.  Check user-reported issues
4.  Prepare rollback if needed

#### Runbook: Split-Brain Detected

**Alert:** "Multiple primary regions"

**Emergency Response:**

1.  **Page:** On-call + incident commander
2.  **Assess:** Which regions claim primary
3.  **Raft:** Check cluster quorum status
4.  **Force:** Manual Raft restart if needed

### DR Monitoring & SLO Tracking

#### Real-time DR Metrics

### Game Day Exercises

#### Quarterly DR Tests

**Test Scenarios:**

-   **Q1:** Peak traffic regional failure
-   **Q2:** Gradual degradation simulation
-   **Q3:** Network partition + split-brain
-   **Q4:** Coordinated attack simulation

### Future Enhancements

#### DR Roadmap

##### Q2 2024:

-   **Predictive Failover:** ML-based failure prediction
-   **Service-Level DR:** Granular failover per service
-   **Zero-RPO Mode:** Sync replication for Tier 0

##### Q3 2024:

-   **Multi-Cloud DR:** AWS → Azure failover
-   **Edge DR:** CDN failover capabilities
-   **Auto-Scaling:** Dynamic standby sizing

##### ✅ System Benefits

-   5-minute automated RTO
-   30-second RPO with async replication
-   Raft consensus prevents split-brain
-   Dependency-aware recovery
-   Monthly chaos validation
-   Automated failback capability

##### ⚠️ System Limitations

-   5-min RTO may be slow for critical services
-   30s RPO allows some data loss
-   High standby infrastructure cost
-   Complex Raft coordination
-   Cross-region network dependency
-   Manual edge case handling needed
