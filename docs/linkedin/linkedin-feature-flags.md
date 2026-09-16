---
title: "Feature Flag Service"
slug: /linkedin/linkedin-feature-flags
sidebar_position: 1
sidebar_label: "Feature Flag Service"
description: "Feature Flag Service"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/linkedin-feature-flags/sequence.svg" alt="How it works — linkedin-feature-flags" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
Launch Control System — Production-Grade Design

A reliability-first feature flag service designed for LinkedIn's scale: sub-2ms evaluation, 30-second global propagation, and zero single points of failure. Built with Kafka, Espresso, Memcache, and LinkedIn infrastructure patterns.

LinkedIn Scale

5-Page Deep Dive

Production Architecture

[Home](/) [Design Framework](/docs/foundations/sre-design-framework) [SRE Systems](/docs/sre/sre-sysdesign) [System Design Hub](/docs/foundations)

## Table of Contents — 5-Page Architecture

1.  [System Overview & Design Philosophy](#overview)
2.  [Core Architecture & LinkedIn Components](#architecture)
3.  [Implementation Details & Data Models](#implementation)
4.  [Reliability, Failure Scenarios & Cross-Colo](#reliability)
5.  [Operations, Monitoring & SLOs](#operations)

<a id="overview"></a>

## Page 1 — System Overview & Design Philosophy

### What This System Is

A **"Launch Control System"** that lets LinkedIn engineers toggle code paths in production without redeploying. Think of it as a reliability tool, not just a developer switch — it must stay alive even when everything else is failing, evaluate flags in under 2ms, and propagate changes fleet-wide in under 30 seconds.

#### Service Level Objectives (SLOs)

| Objective | Target | Measurement |
| --- | --- | --- |
| Flag evaluation latency | p99 ≤ 2ms | In-process timing, zero network calls |
| Availability | 99.999% | Flag evaluation success rate |
| Propagation delay | p95 ≤ 30s | Control plane change → edge application |
| Consistency | 99.99% | All users in cohort see same behavior |
| Kill-switch latency | ≤ 10s | Global flag disable across all DCs |
| Audit integrity | 100% | Every write produces hash-chained record |

### Design Philosophy: Reliability First

#### System Architecture — Flag Evaluation & Propagation Flow

#### 🏗️ Complete Feature Flag Architecture

🎛️ Control Plane

Admin UI + API Gateway

**Web UI**  
Flag Management

**API Gateway**  
REST + GraphQL

**Auth Service**  
LinkedIn SSO

⬇️

1\. Engineer updates flag via UI

💾 Data Persistence Layer

Espresso + Audit Log

**Espresso DB**  
Flag definitions  
`HTTP + Avro`

**Audit Store**  
Immutable log  
`SHA-256 chain`

**Version Control**  
Git integration  
`JSON configs`

⬇️

2\. Write to Espresso + audit log

📡 Message Bus (Kafka)

Real-time propagation

**Producer**  
Control Plane

**Topic**  
flag-updates

**Partitions**  
By flag ID

**Retention**  
7 days

⬇️

3\. Publish change event to Kafka

🏪 Edge Cache Layer

Multi-tier caching

**Memcache**  
L1 Cache  
`TCP 11211`

**Local Cache**  
In-process  
`HashMap`

**CDN Edge**  
Geographic  
`REST API`

⬇️

4\. Update all cache layers

🚀 Application Runtime

Flag evaluation (< 2ms)

**App A**  
Profile Service

**App B**  
Feed Service

**App C**  
Search Service

**App N**  
All Services

**Protocols & Ports:**  
• Control Plane: HTTPS 443  
• Espresso: HTTP + Avro  
• Kafka: TCP 9092  
• Memcache: TCP 11211

**Key Flows:**  
• Flag update: UI → API → Espresso → Kafka  
• Propagation: Kafka → Cache → Apps  
• Evaluation: Local cache lookup (0 network)  
• Kill switch: Broadcast via Kafka

#### Core Design Principles

-   **Edge-First Evaluation** — Flag checks never touch the network. Services evaluate against local cache.
-   **Zero Single Points of Failure** — Even if control plane dies, services keep running with last known state.
-   **Delta Streaming** — Only changes propagate, not full snapshots. Bandwidth scales with change rate, not flag count.
-   **Consistent User Hashing** — A user never flips cohorts between requests within a session.
-   **Global Kill Switch** — Disable any flag across entire LinkedIn fleet in under 10 seconds.
-   **Immutable Audit Trail** — Hash-chained audit log for compliance and debugging.

### Five Core Components

1.  **Control Plane** — Where engineers define flags and targeting rules (UI + REST API)
2.  **Metadata Store** — Durably holds all flag versions and targeting rules (Espresso)
3.  **Distribution Plane** — Fans changes out to the edge using delta streaming (Kafka)
4.  **Edge Evaluators** — In-memory caches co-located with every service (embedded SDK)
5.  **Audit & Metrics Service** — Maintains immutable hash-chained log (Kafka + Espresso)

### Full Feature Set Breakdown

#### Rollout Control

-   **Gradual Percentage Rollouts** — 1% → 5% → 25% → 50% → 100% with automated metric gates
-   **Consistent User Hashing** — SHA256(flag\_key + user\_id) ensures stable cohort assignment
-   **Global Kill Switch** — Disable any flag across the fleet in under 10 seconds
-   **Safe Rollback** — Read any prior flag version via `flag@version` syntax

#### Reliability by Design

-   **Edge-First Evaluation** — Flag checks never touch the network at runtime
-   **Graceful Degradation** — Services keep evaluating flags even if control plane is down
-   **Self-Healing** — Automatic replay queue for nodes that miss deltas

#### Propagation & Consistency

-   **Delta Streaming** — Only diffs propagate, keeping bandwidth low at LinkedIn scale
-   **Replay Queue** — Ensures nodes that missed a delta can catch up
-   **Drift Detection** — Continuous monitoring of per-region propagation delay
-   **Resync-All Command** — Forces full cache flush if drift detected

#### Observability & Audit

-   **Hash-Chained Audit Records** — Every write produces immutable compliance log
-   **Flag Drift Metrics** — Track how many edge nodes are out of sync
-   **Evaluation Rate Tracking** — Identify top flags by usage
-   **SLO Burn-Rate Timeline** — Real-time SLO health dashboard

<a id="architecture"></a>

## Page 2 — Core Architecture & LinkedIn Components

### System Architecture Overview

<img src="/diagrams/linkedin-feature-flags/1.svg" alt="linkedin-feature-flags diagram 1" class="doc-diagram" />

### LinkedIn Component Integration

#### Control Plane Implementation

**Technology Stack:** React frontend + Spring Boot REST API + LinkedIn SSO

-   **UI Framework** — React with LinkedIn's Pemberly design system
-   **Backend API** — Spring Boot with LinkedIn's Play framework integration
-   **Authentication** — LinkedIn SSO with RBAC (engineers can only modify their team's flags)
-   **Load Balancing** — LinkedIn's GFE (Global Front End) with sticky sessions
-   **Rate Limiting** — 100 flag updates per engineer per hour via Redis counters

#### Espresso Metadata Store

**Schema Design:** Optimized for read-heavy workload with version history

-   **Multi-DC Replication** — Espresso's built-in async replication across LTX1, LVA1, EI4
-   **Read Preference** — Local DC reads, write to master with async propagation
-   **Consistency** — Eventual consistency acceptable (30s propagation SLO)

#### Kafka Distribution Plane

**Topic Design:** Per-datacenter topics for regional isolation

-   **Delta Events** — Only flag changes produce Kafka messages, not periodic snapshots
-   **Message Format** — Avro schema with backward compatibility
-   **Partitioning** — Hash(flag\_key) for ordering guarantees per flag
-   **Retention** — 7 days for replay capability

#### Edge SDK Implementation

**Embedded Library:** Zero-network evaluation with local caching

### Cross-Datacenter Architecture

| Datacenter | Primary Role | Kafka Topic | Espresso Shard |
| --- | --- | --- | --- |
| LTX1 | Write Master | feature-flags-ltx1 | Primary Writer |
| LVA1 | Hot Standby | feature-flags-lva1 | Async Replica |
| EI4 | Staging | feature-flags-ei4 | Test Environment |
| Grid2 | Disaster Recovery | feature-flags-grid2 | Cold Standby |

##### ✅ Architecture Benefits

-   Zero network dependency during flag evaluation
-   Linear scalability with service count
-   Built-in disaster recovery across 4 DCs
-   Bandwidth scales with change rate, not flag count

##### ⚠️ Architecture Trade-offs

-   30s eventual consistency (vs real-time)
-   Memory overhead in every service (≈2MB per 1K flags)
-   Complex bootstrap sequence for new services
-   Kafka dependency for updates (but not evaluation)

<a id="implementation"></a>

## Page 3 — Implementation Details & Data Models

### Flag Configuration Data Model

### Delta Event Schema

### User Cohort Assignment Algorithm

#### Consistent Hashing Implementation

### Memcache Integration

#### Why Both Local Cache AND Memcache Are Needed

##### The Bootstrap Problem

Without Memcache, new services would have a "cold start" problem:

**❌ Without Memcache:**  
`New Service Starts → Empty local cache → Wait for Kafka → Gradually receive flags`  
↑ Could take minutes to get all flags

**✅ With Memcache:**  
`New Service Starts → Load from Memcache → Full flag set in 100ms → Start Kafka for updates`

##### Different Data Flow Patterns:

| Cache Type | Update Frequency | Update Method | Access Pattern |
| --- | --- | --- | --- |
| **Local Cache** | Real-time | Kafka deltas | Every request (millions/sec) |
| **Memcache** | Every 30s | Control Plane batch | Only at startup |

#### Bootstrap & Warm Cache Strategy

New services bootstrap from Memcache before establishing Kafka connection

-   **Cache Key Strategy** — `feature_flags:snapshot` contains full flag state
-   **TTL** — 5 minutes (shorter than Kafka retention for safety)
-   **Size** — ~2MB for 10,000 flags (compressed with Snappy)
-   **Refresh Pattern** — Control Plane updates every 30 seconds

### Gradual Rollout Implementation

#### Automated Metric Gates

Integration with LinkedIn's metrics infrastructure for automated rollout control

### Kill Switch Implementation

#### Global Emergency Disable

10-second global flag disable across all LinkedIn datacenters

### Audit Trail Implementation

#### Hash-Chained Compliance Log

<a id="reliability"></a>

## Page 4 — Reliability, Failure Scenarios & Cross-Colo Design

### Failure Scenarios & Mitigation Strategies

#### Scenario 1: Control Plane Outage

**Failure:** React UI and REST API become unavailable

**Impact:** Engineers cannot create/modify flags, but all existing flags continue evaluating

**Mitigation:**

-   Edge SDKs continue evaluating from local cache (no dependency on Control Plane)
-   Multi-AZ deployment with health checks and automatic failover
-   Read-only mode available from any DC if master is down
-   Emergency kill-switch available via direct Kafka publish

**Recovery Time:** 0 seconds (transparent to flag evaluation)

#### Scenario 2: Espresso Database Failure

**Failure:** Primary Espresso shard becomes unavailable

**Impact:** Cannot persist new flags, but reads continue from replica

**Mitigation:**

-   Automatic failover to read replica in same DC (30s RTO)
-   Cross-DC failover to LVA1 if LTX1 Espresso fully down (2 min RTO)
-   Memcache bootstrap ensures new services can still start
-   Kafka replay queue allows catch-up after recovery

**Recovery Time:** 30 seconds (automatic), 2 minutes (cross-DC)

#### Scenario 3: Kafka Partition Failure

**Failure:** Kafka topic becomes unavailable or messages are lost

**Impact:** Flag changes don't propagate to Edge SDKs

**Mitigation:**

-   Kafka replication factor of 3 prevents single-broker failure
-   Cross-DC Kafka mirroring for disaster recovery
-   SDKs poll Memcache every 5 minutes as backup propagation path
-   Manual "resync-all" command forces full cache refresh
-   Flag drift monitoring alerts within 2 minutes of propagation failure

**Recovery Time:** 0 seconds (replication), 5 minutes (Memcache fallback)

#### Scenario 4: Flag Drift (20% of Europe out of sync)

**Failure:** Network issues cause subset of Edge SDKs to miss updates

**Impact:** Inconsistent flag behavior across user sessions

**Detection:**

-   Checkly monitoring probes flag evaluation from multiple regions
-   SDKs report cache checksum every 60 seconds
-   Drift alert fires when >5% of nodes disagree on flag state

**Mitigation:**

-   Automatic "resync-all" triggered when drift >10%
-   Individual SDK reset via management endpoint
-   Emergency broadcast channel bypasses Kafka

**Recovery Time:** 30 seconds (resync-all), 10 seconds (emergency broadcast)

#### Scenario 5: Memcache Cluster Down

**Failure:** Memcache cluster becomes unavailable

**Impact:** New services cannot bootstrap flag cache

**Mitigation:**

-   Services fall back to direct Espresso query for bootstrap
-   Degraded performance during startup but no outage
-   Multi-AZ Memcache deployment with automatic failover
-   Local disk cache backup on each service host

**Recovery Time:** 0 seconds (automatic fallback), 60 seconds (Espresso bootstrap)

### Cross-Datacenter Design

#### Multi-DC Topology

| Datacenter | Role | Kafka Setup | Espresso Role | Failover Time |
| --- | --- | --- | --- | --- |
| **LTX1** | Primary Write | Master topic | Primary Writer | N/A |
| **LVA1** | Hot Standby | Mirror + local | Async Replica | 2 minutes |
| **EI4** | Staging | Test topic | Test DB | Manual |
| **Grid2** | DR Cold | Archive mirror | Cold Standby | 15 minutes |

##### Cross-DC Propagation Flow:

1.  **Write Path:** Control Plane (LTX1) → Espresso (LTX1) → Kafka (LTX1)
2.  **Local Distribution:** Kafka (LTX1) → Edge SDKs (LTX1)
3.  **Cross-DC Replication:** Kafka (LTX1) → Kafka (LVA1, EI4, Grid2)
4.  **Remote Distribution:** Kafka (LVA1) → Edge SDKs (LVA1)

#### Cross-DC Failover Implementation

### Network Partition Resilience

#### Split-Brain Prevention

Prevent multiple Control Planes from accepting writes during network partition

### Performance & Scalability

#### Scalability Targets

| Metric | Current Scale | Target Scale | Scaling Strategy |
| --- | --- | --- | --- |
| Total Flags | 10,000 | 100,000 | Linear with memory |
| Services | 2,000 | 20,000 | Kafka partition scaling |
| Flag Evaluations | 100M/min | 1B/min | Edge-only (no central load) |
| Flag Updates | 1,000/day | 10,000/day | Kafka throughput scaling |
| Cross-DC Latency | 30s p95 | 15s p95 | Dedicated network links |

### Security & Compliance

#### Security Controls

-   **Authentication:** LinkedIn SSO with 2FA requirement for flag modifications
-   **Authorization:** Team-based RBAC - engineers can only modify their team's flags
-   **Audit Trail:** Every change logged with operator, timestamp, and reason
-   **Encryption:** TLS 1.3 for all service-to-service communication
-   **Network Security:** Internal-only APIs, no public internet exposure
-   **Data Privacy:** No PII in flag configurations or audit logs

<a id="operations"></a>

## Page 5 — Operations, Monitoring & SLOs

### Checkly Monitoring Integration

#### Flag Health Monitoring

**Checkly Setup:** Continuous flag evaluation testing from multiple regions

### SLO Monitoring & Alerting

#### Service Level Indicators (SLIs)

| SLI | Measurement | Good Events | Total Events |
| --- | --- | --- | --- |
| Flag Evaluation Success | `flag_evaluations_success / flag_evaluations_total` | Non-error responses | All evaluation attempts |
| Propagation Latency | `flag_propagation_latency_p95` | Updates <30s | All flag updates |
| Consistency Rate | `consistent_evaluations / total_evaluations` | Same result across DCs | Cross-DC samples |
| Kill Switch Speed | `kill_switch_propagation_p99` | Disables <10s | All kill switch events |

#### Error Budget & Burn Rate Alerts

### Operational Dashboards

#### Primary SRE Dashboard Metrics

##### 🎯 Core SLO Health

-   **Flag Evaluation P99 Latency:** Target ≤2ms, Alert >5ms
-   **Evaluation Success Rate:** Target ≥99.999%, Alert <99.99%
-   **Propagation P95 Latency:** Target ≤30s, Alert >60s
-   **Cross-DC Consistency:** Target ≥99.99%, Alert <99.9%

##### 📊 System Health Indicators

-   **Kafka Consumer Lag:** Per-DC topic lag in messages
-   **Espresso Response Time:** P95 latency for flag reads/writes
-   **Memcache Hit Rate:** Bootstrap cache effectiveness
-   **SDK Memory Usage:** Flag cache size per service instance

##### 🚨 Business Impact Metrics

-   **Active Flags Count:** Total enabled flags across all services
-   **Flag Evaluation QPS:** Total evaluations per second
-   **Rollout Velocity:** Flags per day progressing through rollout stages
-   **Kill Switch Usage:** Emergency disables per week

### Incident Response Playbooks

#### Runbook: High Flag Evaluation Latency

**Alert:** "Flag evaluation P99 >5ms for 5 minutes"

**Investigation Steps:**

1.  Check if specific service or global issue: `grep "slow_flag_eval" service_logs`
2.  Verify SDK cache health: Check cache hit ratio and memory usage
3.  Look for memory pressure: JVM GC logs, heap utilization
4.  Check for hash collision: Review user ID distribution in cohort assignment
5.  Escalate to on-call engineer if not resolved in 10 minutes

**Mitigation:**

-   Restart affected service instances to clear cache corruption
-   Temporarily disable new flag evaluations via circuit breaker
-   Force cache refresh from Memcache

#### Runbook: Flag Drift Detected

**Alert:** "Flag evaluation inconsistency >5% across DCs"

**Investigation Steps:**

1.  Identify affected datacenters and flag keys
2.  Check Kafka consumer lag: `kafka-consumer-groups.sh --describe`
3.  Verify network connectivity between DCs
4.  Review recent deployments or config changes
5.  Check Edge SDK version consistency across services

**Mitigation:**

-   Execute resync-all command: `curl -X POST /admin/resync-all`
-   Reset individual SDK caches via management endpoint
-   Use emergency broadcast channel to bypass Kafka
-   Temporary rollback to previous flag version if user impact

#### Runbook: Kill Switch Not Working

**Alert:** "Kill switch propagation >10s or failed"

**Investigation Steps:**

1.  Verify kill switch command reached all DC Kafka topics
2.  Check if Edge SDKs are processing kill switch events
3.  Look for SDK deployment issues or version mismatches
4.  Review network partitions or DC-level failures

**Emergency Mitigation:**

-   Direct Espresso update to force flag disable
-   Manual service restarts to force cache refresh
-   DNS-level traffic routing to bypass affected services
-   Engage incident commander for coordination

### Capacity Planning

#### Resource Scaling Guidelines

| Component | Scaling Factor | Current Capacity | Scale Trigger |
| --- | --- | --- | --- |
| Kafka Partitions | 1 per 100 services | 16 partitions | Consumer lag >1000 msgs |
| Espresso Shards | 10K flags per shard | 2 shards | Query latency >50ms |
| Memcache Nodes | 1GB per 10K flags | 4 nodes × 4GB | Hit rate <95% |
| Control Plane | 1000 RPS per instance | 4 instances | CPU >70% |

##### Memory Planning per Service:

-   **Base SDK:** ~5MB (libraries and infrastructure)
-   **Flag Cache:** ~200 bytes per flag × flag count
-   **User Context:** ~100 bytes per active session
-   **Example:** Service with 10K flags = 5MB + 2MB + variable = ~7MB

### Performance Optimization

#### Sub-2ms Evaluation Optimization

### Future Enhancements

#### Roadmap Items

##### Q2 2024:

-   **Multi-Variate Testing:** A/B/C experiments with variant assignment
-   **Scheduled Rollouts:** Time-based automatic flag progression
-   **Dependency Management:** Flag dependencies and prerequisite chains

##### Q3 2024:

-   **Edge Caching:** CDN-level flag evaluation for mobile apps
-   **Real-time Analytics:** Live flag usage and conversion tracking
-   **ML-Powered Rollouts:** Automatic rollout decisions based on metrics

##### Q4 2024:

-   **Global Load Balancing:** Flag-based traffic routing
-   **Compliance Framework:** GDPR/CCPA data handling in targeting
-   **Mobile SDK:** Native iOS/Android libraries with offline support

##### ✅ System Benefits

-   Sub-2ms evaluation with zero network dependency
-   Linear scalability (no central bottlenecks)
-   Multi-DC disaster recovery built-in
-   Strong audit trail for compliance
-   Gradual rollout with automated safety gates
-   10-second global kill switch capability

##### ⚠️ System Limitations

-   30-second eventual consistency (not real-time)
-   Memory overhead in every service instance
-   Complex bootstrap sequence for new services
-   Kafka dependency for updates (not evaluation)
-   Limited targeting rule complexity
-   Cross-DC network partitions affect propagation
