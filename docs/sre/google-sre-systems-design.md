---
title: "Google SRE Systems Design Guide"
slug: /sre/google-sre-systems-design
sidebar_position: 2
sidebar_label: "Google SRE Systems Design Guide"
description: "Google SRE Systems Design Guide"
---
Complete preparation guide with 9 authentic problems from Google's Site Reliability Engineering interviews

"Don't just fix the bug. Design the system where the bug can't exist."

## 🕒 Round 3: System Design Interview Overview

### Why This Round is Different

This is often the most decisive round in the Google SRE loop, separating strong engineers from true SRE architects. Unlike a standard software engineering design interview that focuses on features and scale, the SRE version is a deep probe into **reliability, observability, and operational maturity**.

The interviewer isn't just asking "How would you build it?" They are asking, **"How would you build it to survive its worst day, and how would you prove it's meeting its promises?"**

#### This round tests your ability to:

-   ✅ Reason about systems under stress and define SLOs first
-   ✅ Make difficult trade-offs between availability, latency, and cost
-   ✅ Design for failure, not just for the "happy path"
-   ✅ Demonstrate operational ownership over a complex, distributed service

**Expect a dialogue, not a monologue.** The goal isn't to draw a perfect diagram, but to narrate your architectural choices and justify them with production-grade reliability principles.

### The 6-Step SRE Design Methodology

#### 1\. Requirements → SLO Contract

**"How reliable, fast, and scalable must this system be?"**

-   Define availability targets (99.9%, 99.99%, 99.999%)
-   Set latency requirements (p50, p95, p99)
-   Establish throughput expectations (QPS, concurrent users)
-   Determine data consistency needs (strong, eventual, session)
-   Identify critical user journeys and their SLOs

#### 2\. SLO Contract → Baseline Design

**"What minimal set of components meets those guarantees?"**

-   Design the simplest architecture that meets SLOs
-   Choose appropriate databases and caching layers
-   Define API contracts and data models
-   Estimate capacity and resource requirements
-   Map components to specific SLO contributions

#### 3\. Baseline Design → Stressors

**"What happens when scale ×10 or a dependency fails?"**

-   Traffic spikes (10x normal load)
-   Database failures (primary, replica, partition)
-   Network issues (latency, packet loss, partitions)
-   Dependency outages (external APIs, services)
-   Resource exhaustion (CPU, memory, disk, network)

#### 4\. Stressors → Resilient Architecture

**"Which reliability patterns mitigate failure modes?"**

-   Replication (master-slave, master-master, sharding)
-   Circuit breakers and bulkheads
-   Queue-based decoupling and backpressure
-   Graceful degradation and fallbacks
-   Rate limiting and load shedding

#### 5\. Resilient Architecture → Observability & Ops

**"How will we know it's healthy—and repair it safely?"**

-   SLI metrics and monitoring dashboards
-   Error budgets and burn rate alerts
-   Distributed tracing and logging
-   Health checks and synthetic monitoring
-   Runbooks and incident response procedures

#### 6\. Observability & Ops → Trade-offs

**"Where do we accept cost or complexity to meet SLOs?"**

-   Performance vs consistency trade-offs
-   Cost of over-provisioning for reliability
-   Operational complexity vs automation
-   Development velocity vs safety
-   Regional deployment vs latency requirements

## Design Prompt #1 — Monitoring & Alerting Platform

### 🎯 Scenario / Problem Statement

You're asked to design a global monitoring & alerting platform for an organization that runs hundreds of services across multiple regions.

#### Requirements (high level):

-   Ingest metrics & events from producers at peak **100M metrics/sec** global ingestion
-   Produce alerts to on-call within **p99 latency < 30 seconds** from metric event to notification
-   Platform must provide **SLIs, SLO tracking**, and support error-budget based alerting and throttling
-   Support **multi-region availability** (no single region outage should cause alerting blackout)

**Goal:** "Build something like Google's Stackdriver Logging or Cloud Logging service — reliable, fast, and cost-efficient."

### Step 1 — Clarification Dialogue + SLO Contract

#### You (Candidate): Quick clarifying questions:

-   **"Are producers pushing metrics in a structured format (proto/JSON) and are they authenticated?"**  
    Interviewer: "Yes—structured, authenticated telemetry via gRPC/HTTP."
-   **"Do we require long-term retention for analytics?"**  
    Interviewer: "Yes. Hot retention for 30 days; cold storage for 3 years."
-   **"Is alert delivery via SMS/Email/ChatOps required?"**  
    Interviewer: "Yes, integrate with on-call systems (PagerDuty/Google Ops)."
-   **"What's the SRE org tolerance for false positives vs. missed alerts?"**  
    Interviewer: "Avoid alert storms — prioritize precision."

#### You (Candidate) — SLO Contract (the money move):

"Before architecture, let's define the SLOs that will guide design tradeoffs. For this monitoring pipeline I propose:"

| SLI | Target | Measurement |
| --- | --- | --- |
| **SLI A (Alert latency)** | p99 ≤ 30 seconds | End-to-end from metric ingestion → alert notification |
| **SLI B (Pipeline availability)** | ≥ 99.95% monthly | Ingestion & processing pipeline available |
| **SLI C (Alert precision)** | < 2% false positive rate | For critical alerts |

**"Do these targets reflect expectations?"**  
Interviewer: "Yes — those are reasonable targets."

##### 💡 Interviewer Lens:

Declaring SLOs first reframes every decision: buffering, batching, retry, sampling, redundancy — all are justified by meeting these measurable targets.

### Step 2 — Baseline Functional Design (Happy Path)

#### Minimal components and dataflow:

1.  **Producers** → push metrics/events (gRPC/HTTP) →
2.  **Ingress Load Balancer / API Gateway** →
3.  **Sharded Ingest Brokers** (Kafka-like) →
4.  **Stream Processors** (stateless workers) → compute SLIs/aggregate metrics →
5.  **Time-series Storage** (hot TSDB) for 30-day fast queries →
6.  **Alerting Engine** (rules, thresholds, error budget checks) →
7.  **Notifier** → on-call systems (Pager/ChatOps)
8.  **Cold Storage** (object store) for long-term analytics

**Data flow:** producers → ingest → durable queue → processing → TSDB + alert evaluation → notifications.

This baseline meets functionality in an ideal world; no resilience or scale pressure yet.

### Step 3 — The Interviewer's Gauntlet (Add failure & scale constraints)

##### 🔥 Gauntlet A — Scale: "Your baseline works for 1M metrics/sec. How to handle 100M?"

**Candidate:**

-   Shard ingestion: partition by tenant/service into many topics
-   Autoscale processors; use local aggregation (pre-aggregation at edge) to reduce cardinality
-   Use adaptive sampling for high-cardinality metrics; push raw for critical signals only

##### 🔥 Gauntlet B — Regional outage: "A whole region goes down — can on-call still be notified?"

**Candidate:**

-   Make ingest & processing geo-redundant: producers can fall back to nearest region; brokers are multi-region replication (active-active)
-   Notifier must be multi-region — route notifications from healthy control plane region

##### 🔥 Gauntlet C — Alert storms / Poison pill: "One malformed high-frequency metric generates thousands of alerts."

**Candidate:**

-   Add schema validation/ingress filters and a **Dead-Letter Queue (DLQ)** for malformed events
-   Add alert deduplication & grouping logic and a rate limiter for downstream notification channels
-   Introduce a verification window: require t consecutive breaches or error-budget burn before paging

##### 🔥 Gauntlet D — SLO enforcement: "How do we ensure critical alerts are not throttled during huge traffic bursts?"

**Candidate:**

-   **Priority queueing:** critical alerts bypass throttling and get dedicated capacity
-   Implement error-budget aware alerting: non-critical alerts suppressed if error budget burn is high, preserving attention for critical signals

Each defense tied back to SLOs: latency (ingest+batches), availability (multi-region), precision (dedupe, DLQ).

### Step 4 — Production-Grade Architecture

#### Final architecture (key components & resilience patterns — each tied to SLO):

1.  **Edge Agent / Ingress**
    -   gRPC endpoints + auth, TLS, client-side buffering & batching (minimize network overhead)
    -   *SLO mapping:* reduces p99 latency by amortizing RPC overhead
2.  **Global Load Balancer + Regional Gateways**
    -   Routes to healthy region; producers configured with fallback endpoints
    -   *SLO mapping:* avoids single-region outage, supports 99.95% availability
3.  **Durable, Sharded Ingest Queue (multi-region)**
    -   Kafka-like topics with geo-replication or log replication (active-active)
    -   Retains raw events for reprocessing (hot window + cold archive)
    -   *SLO mapping:* durability ensures availability; replay supports correctness after failures
4.  **Edge Aggregators**
    -   Run near producers to pre-aggregate and downsample high-cardinality metrics
    -   *SLO mapping:* reduces ingestion load, helps meet latency SLO
5.  **Stream Processing Layer**
    -   Stateless processors in autoscaling groups; process per-shard; apply dedupe, grouping, alert rules, and error-budget checks
    -   Maintain local state (sliding windows) and checkpoint to durable storage
    -   *SLO mapping:* low-latency evaluation; state checkpoints support failover

### Step 5 — The Operational Playbook

#### Deployment Strategy (progressive & safe):

-   Canary rollout: 1% traffic in single region → monitor SLOs for 24h → 10% → 50% → global
-   Use traffic shaping to route a subset of producers to canary ingress; ensure canary runs with same config as prod
-   Keep dynamic flags to disable new features instantly

#### Resilience Testing (Runbook):

-   Chaos experiments: kill processors, pause replication, inject high-latency to DB, and verify alerting pipeline still meets p99 latency target
-   DLQ drills: inject malformed messages and verify DLQ handling, replay mechanics, and alerting on DLQ growth

##### 💡 Pro Tip:

Always quantify: when you propose sampling or aggregation, state the expected reduction in ingest QPS (e.g., "apply 10x downsampling on low-cardinality metrics; reduces ingestion from 100M → 10M QPS"). Interviewers love concrete numbers.

### Step 6 — Complete Architecture Solution

#### 🏗️ Production-Grade Monitoring & Alerting Platform

![Global Monitoring & Alerting Platform Detailed Architecture](/images/monitoring-platform-detailed.png)

**Production-Grade Monitoring Platform:** Multi-region, 100M metrics/sec, with durable message queues, auto-scaling stream processors, and comprehensive observability layer.

**Key Reliability Patterns:** Multi-region active-active • Durable queues with DLQ • Autoscaling processors • Deduplication engine • Error budget aware alerting • End-to-end synthetic monitoring

#### 🔧 Technical Implementation Details:

| Component | Technology Choice | Scaling Strategy | Failure Mode Mitigation |
| --- | --- | --- | --- |
| **API Gateway** | Envoy/NGINX with rate limiting | Autoscaling groups per region | Circuit breakers, health checks |
| **Message Queue** | Kafka with MirrorMaker 2.0 | Dynamic partition scaling | Cross-region replication, DLQ |
| **Stream Processors** | Apache Beam/Dataflow | Horizontal autoscaling | Checkpointing, replay capability |
| **Hot Storage** | Bigtable/DynamoDB | Automatic sharding | Multi-region replication |
| **Alert Engine** | Custom Go/Java service | Stateless, load balanced | Rule versioning, canary deployment |

#### 💰 SLO Achievement Strategy:

-   **p99 Alert Latency < 30s:** Achieved through regional processing + priority queuing for critical alerts
-   **99.95% Pipeline Availability:** Multi-region active-active + automatic failover
-   **< 2% False Positive Rate:** Deduplication engine + error budget aware throttling

## Design Prompt #2 — Distributed Logging Pipeline

### 🎯 Scenario / Problem Statement

Design a global distributed logging system for thousands of services generating logs at massive scale.

#### Requirements (interviewer brief):

-   Must ingest up to **20 TB/day** of logs across regions
-   Logs must be **queryable within 60 seconds** of ingestion
-   Store raw logs for **30 days hot, 1 year cold**, with 99.9% durability
-   Support **multi-tenant isolation** and cost-efficient storage
-   Include error handling for malformed or oversized log entries

**Goal:** "Build something like Google's Stackdriver Logging or Cloud Logging service — reliable, fast, and cost-efficient."

### Step 1 — Clarification Dialogue + SLO Contract

#### Proposed SLOs:

| SLI | Target | Measurement |
| --- | --- | --- |
| **SLI A – Ingestion Latency** | p99 ≤ 10 seconds | Time from log emission → durable write |
| **SLI B – Query Freshness** | ≤ 60 seconds | Logs visible for querying post-ingest |
| **SLI C – Pipeline Availability** | ≥ 99.95% monthly | Multi-region uptime |
| **SLI D – Storage Durability** | ≥ 99.999999999% | (11 9s) object durability (hot+cold tiers) |

##### 💡 Interviewer Lens:

This "SLO-first" framing is the senior signal. The candidate isn't designing a system; they're defining what success means for reliability before designing anything.

### Step 2 — Baseline Functional Design (Happy Path)

#### Minimal architecture (functional view):

1.  **Log Producers** → send structured JSON over gRPC/HTTPS
2.  **Regional Ingestion Service** — authenticates, batches, and writes to a Durable Log Queue (Kafka/PubSub) for async decoupling
3.  **Indexing Workers** — consume logs, extract metadata (service, timestamp, severity)
4.  **Storage Layers:**
    -   Hot Store: fast SSD-backed TSDB or log store (30-day retention)
    -   Cold Store: object storage (compressed, partitioned by day/service)
5.  **Query API:** indexes logs in search backend (e.g., Elastic/Loki-like) for real-time queries
6.  **Management Plane:** retention policies, schema, multi-tenant quotas

**Happy Path:** Logs flow in, persist durably, index, and become queryable within seconds. No failures yet — only correctness and latency considered.

### Step 3 — The Interviewer's Gauntlet

##### 🔥 Challenge A – Scale Explosion

**Interviewer:** "That works at 2M logs/sec. What if it's 20M?"

**Candidate:**

-   Partition logs by service ID and region, shard ingestion
-   Apply pre-aggregation and compression at edge agents
-   Use tiered queues: edge → regional buffer → global merge
-   Implement load shedding for non-critical debug-level logs

"I'd define sampling rules: critical severity always stored, info/debug rate-limited."

##### 🔥 Challenge B – Cost & Retention Trade-offs

**Interviewer:** "Storing raw logs for a year is expensive — how do you balance cost vs durability?"

**Candidate:**

-   Hot tier (30 days): SSD-backed distributed store for query freshness
-   Cold tier (1 year): compressed object storage (GCS/S3) with infrequent access
-   Lifecycle policies auto-transition logs from hot to cold after 30 days
-   Apply columnar compression (Snappy/Zstd) for 80–90% reduction

"That's the sweet spot: cost down, SLOs preserved for query freshness and durability."

##### 💡 Pro Tip:

Whenever you mention "durable queues," emphasize backpressure. Google interviewers love hearing: "We protect downstream systems by applying backpressure instead of uncontrolled retries."

### Step 6 — Complete Architecture Solution

#### 🏗️ Production-Grade Distributed Logging Pipeline

![Distributed Logging Pipeline Architecture](/images/monitoring-alerting-detailed.png)

**Distributed Logging Pipeline:** 20TB/day structured logs, 60s query freshness, multi-tier storage with hot (30d) and cold (1y) tiers, parallel processing pipeline.

**Key Reliability Patterns:** Regional hot-standby • Durable streams with replay • Multi-tier storage • Intelligent sampling • Schema evolution • Circuit breakers

#### 🔧 Technical Implementation Details:

| Component | Technology Choice | Scaling Strategy | Cost Optimization |
| --- | --- | --- | --- |
| **Log Agents** | Fluent Bit/Vector | Per-node deployment | Local buffering + compression |
| **Stream Store** | Kafka/Pulsar | Auto-partition scaling | Tiered storage (hot/warm/cold) |
| **Hot Storage** | Elasticsearch/OpenSearch | Shard rebalancing | Index lifecycle management |
| **Cold Storage** | S3/GCS with Parquet | Unlimited capacity | 80-90% compression + lifecycle |
| **Query Engine** | GraphQL + caching | Read replicas | Query result caching |

#### 💰 SLO Achievement Strategy:

-   **p99 Ingestion < 10s:** Regional processing + durable buffering prevents data loss
-   **60s Query Freshness:** Real-time indexing pipeline with <30s end-to-end latency
-   **99.95% Pipeline Availability:** Multi-region active-passive with automatic failover
-   **99.999999999% Durability:** Cross-region replication + object storage redundancy

## Design Prompt #3 — Distributed Cache (Global Scale)

### 🎯 Scenario / Problem Statement

You're designing a global distributed cache that serves user profile and session data to latency-sensitive applications across multiple regions.

#### Requirements (interviewer brief):

-   Global user base (~**500M active users**)
-   **p99 read latency target < 5ms** from regional cache
-   Writes must propagate globally within **1s** for critical data (e.g., session invalidation)
-   **Cache hit ratio ≥ 95%**
-   Support multi-region resilience (no single-region dependency)
-   Handle **10M RPS read and 1M RPS write** workload

**Goal:** "Design something like Google's Memcache/Spanner hybrid caching tier — low latency, reliable, globally aware."

### Step 1 — SLO Contract

| Metric | Target |
| --- | --- |
| **SLI A – Read Latency** | p99 < 5ms from regional cache |
| **SLI B – Global Write Propagation** | ≤ 1s to all regions |
| **SLI C – Availability** | ≥ 99.99% read path uptime |
| **SLI D – Hit Ratio** | ≥ 95% sustained |
| **SLI E – Data Integrity** | < 0.001% stale-read beyond SLO window |
| **SLI F – Cost Efficiency** | ≤ $0.05 per million reads (example target) |

##### 💡 Interviewer Lens:

Defining these numbers first is the "Google move." The conversation now has measurable targets: latency, staleness, availability and even cost.

### Step 4 — Production-Grade Architecture

| Layer | Key Responsibilities | Reliability Pattern |
| --- | --- | --- |
| **Ingestion Tier** | Multi-region API front-ends | Active-active load balancing |
| **Queue Layer** | Buffering & prioritization | Replicated Kafka clusters with MirrorMaker |
| **Deduplication & Aggregation** | Collapses repeated alerts | Sliding-window hashing + in-memory cache |
| **Notification Service** | Multi-channel dispatch | Circuit breakers & multi-path delivery |
| **Ack Tracker DB** | State management | Multi-primary Spanner/Cloud SQL HA |
| **Monitoring & SLIs** | End-to-end delivery metrics | Synthetic alert tests every minute |

### Step 6 — Trade-offs & Final Justification

| Decision | Reliability | Latency | Complexity | Cost | Reason |
| --- | --- | --- | --- | --- | --- |
| **Active-active ingestion** | 99.999% | < 30s | High | High | Ensures no regional SPOF |
| **Dedup in memory** | High | 10ms avg | Medium | Low | Prevents paging storms |
| **Multi-channel notify** | 99.999% | Slightly slower | Medium | Medium | Eliminates alert loss |
| **Global ACK sync** | High | 10s | Medium | Medium | Maintains auditability |

**Final Verdict:** Final design achieves p99 alert latency < 25s, five-nines reliability, and audit-grade traceability with moderate complexity. Trade-offs favor redundancy over cost — appropriate for critical incident systems.

### Step 6 — Complete Architecture Solution

#### 🏗️ Production-Grade Global Distributed Cache

![Global Distributed Cache System Architecture](/images/cache-architecture-detailed.png)

**Global Distributed Cache:** 500M users, 10M ops/sec, p99 < 5ms latency, with consistent hash routing, multi-region clusters, and intelligent cache warming.

**Key Reliability Patterns:** Multi-master with conflict resolution • Regional read replicas • Circuit breakers • Consistent hashing • Background warming ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ REGIONAL CACHE PROXY LAYER │ ├─────────────────────────────────────────────────────────────────────────────────────────┤ │ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐ │ │ │ US-WEST-1 │ │ US-EAST-1 │ │ EU-WEST-1 │ │ │ │ ┌─────────────┐ │ │ ┌─────────────┐ │ │ ┌─────────────┐ │ │ │ │ │Load Balancer│ │ │ │Load Balancer│ │ │ │Load Balancer│ │ │ │ │ │Consistent │ │ │ │Consistent │ │ │ │Consistent │ │ │ │ │ │Hashing │ │ │ │Hashing │ │ │ │Hashing │ │ │ │ │ │Rate Limiting│ │ │ │Rate Limiting│ │ │ │Rate Limiting│ │ │ │ │ │Health Checks│ │ │ │Health Checks│ │ │ │Health Checks│ │ │ │ │ └─────────────┘ │ │ └─────────────┘ │ │ └─────────────┘ │ │ │ │ Latency SLO: │ │ Latency SLO: │ │ Latency SLO: │ │ │ │ p99 < 2ms │ │ p99 < 2ms │ │ p99 < 2ms │ │ │ └─────────────────┘ └─────────────────┘ └─────────────────┘ │ └─────────────────────────────────────────────────────────────────────────────────────────┘ │ ▼ ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ CACHE CLUSTER MESH (Per-Region) │ ├─────────────────────────────────────────────────────────────────────────────────────────┤ │ │ │ US-WEST-1 Cache Cluster: │ │ ┌─────────────────────────────────────────────────────────────────────────────────┐ │ │ │ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ │ │ │ │ │Shard-01 │ │Shard-02 │ │Shard-03 │ │Shard-04 │ │Shard-05 │ │Shard-N │ │ │ │ │ │Redis │ │Redis │ │Redis │ │Redis │ │Redis │ │Redis │ │ │ │ │ │Master │ │Master │ │Master │ │Master │ │Master │ │Master │ │ │ │ │ │+ 2 Rep │ │+ 2 Rep │ │+ 2 Rep │ │+ 2 Rep │ │+ 2 Rep │ │+ 2 Rep │ │ │ │ │ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘ │ │ │ │ Hash Ring: CRC32(key) mod N | Auto-failover | Memory: 64GB per shard │ │ │ └─────────────────────────────────────────────────────────────────────────────────┘ │ │ │ │ US-EAST-1 & EU-WEST-1: Similar cluster topology │ │ │ └─────────────────────────────────────────────────────────────────────────────────────────┘ │ ▼ ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ CROSS-REGION COORDINATION LAYER │ ├─────────────────────────────────────────────────────────────────────────────────────────┤ │ ┌─────────────────────────┐ ┌─────────────────────────┐ │ │ │ WRITE COORDINATION │ │ INVALIDATION BUS │ │ │ │ ┌─────────────────────┐ │ │ ┌─────────────────────┐ │ │ │ │ │ Global Write Router │ │ │ │ Kafka/Pulsar Stream │ │ │ │ │ │ ┌─────────────────┐ │ │ │ │ ┌─────────────────┐ │ │ │ │ │ │ │ Write-through │ │ │ │ │ │ Topic: cache- │ │ │ │ │ │ │ │ Coordinator │ │ │◄────────────►│ │ │ invalidations │ │ │ │ │ │ │ │ • Primary Region│ │ │ │ │ │ Partitions: key │ │ │ │ │ │ │ │ • Async Fanout │ │ │ │ │ │ Retention: 24h │ │ │ │ │ │ │ │ • Conflict Res. │ │ │ │ │ └─────────────────┘ │ │ │ │ │ │ └─────────────────┘ │ │ │ └─────────────────────┘ │ │ │ │ └─────────────────────┘ │ └─────────────────────────┘ │ │ └─────────────────────────┘ │ │ Write Latency Target: p95 < 10ms global propagation within 1s │ └─────────────────────────────────────────────────────────────────────────────────────────┘ │ ▼ ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ FALLBACK & WARMING LAYER │ ├─────────────────────────────────────────────────────────────────────────────────────────┤ │ ┌─────────────────────────┐ ┌─────────────────────────┐ │ │ │ CACHE MISS HANDLER │ │ WARMING SYSTEM │ │ │ │ ┌─────────────────────┐ │ │ ┌─────────────────────┐ │ │ │ │ │ Database Fallback │ │ │ │ Predictive Warmer │ │ │ │ │ │ ┌─────────────────┐ │ │ │ │ ┌─────────────────┐ │ │ │ │ │ │ │ Read Replicas │ │ │ │ │ │ ML-based Cache │ │ │ │ │ │ │ │ (Postgres/ │ │ │ │ │ │ Key Prediction │ │ │ │ │ │ │ │ Spanner) │ │ │ │ │ │ • Usage patterns│ │ │ │ │ │ │ │ Connection Pool │ │ │◄────────────►│ │ │ • Time-based │ │ │ │ │ │ │ │ Circuit Breaker │ │ │ │ │ │ • User-based │ │ │ │ │ │ │ │ Bulkhead Pattern│ │ │ │ │ │ Preload Cache │ │ │ │ │ │ │ └─────────────────┘ │ │ │ │ └─────────────────┘ │ │ │ │ │ └─────────────────────┘ │ │ └─────────────────────┘ │ │ │ └─────────────────────────┘ └─────────────────────────┘ │ │ Hit Ratio Target: ≥ 95% │ Miss Latency: p99 < 50ms │ Warming Success: 80% │ └─────────────────────────────────────────────────────────────────────────────────────────┘ │ ▼ ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ OBSERVABILITY & OPERATIONS LAYER │ ├─────────────────────────────────────────────────────────────────────────────────────────┤ │ ┌─────────────────────────┐ ┌─────────────────────────┐ ┌─────────────────────────┐ │ │ │ METRICS & ALERTING │ │ CHAOS ENGINEERING │ │ CAPACITY PLANNING │ │ │ │ ┌─────────────────────┐ │ │ ┌─────────────────────┐ │ │ ┌─────────────────────┐ │ │ │ │ │ Cache Hit Rate │ │ │ │ Shard Failure Tests │ │ │ │ Memory Utilization │ │ │ │ │ │ • Per-region │ │ │ │ Network Partition │ │ │ │ • Growth prediction │ │ │ │ │ │ • Per-service │ │ │ │ Master-Replica Lag │ │ │ │ • Auto-scaling │ │ │ │ │ │ • Per-key-pattern │ │ │ │ Write Conflict Res │ │ │ │ Key Distribution │ │ │ │ │ │ Latency P50/P95/P99 │ │ │ │ Cache Invalidation │ │ │ │ • Hotspot detection │ │ │ │ │ │ Error Rates │ │ │ │ Fallback DB Load │ │ │ │ • Shard rebalance │ │ │ │ │ │ Memory Pressure │ │ │ │ Regional Failover │ │ │ │ Cost Analysis │ │ │ │ │ └─────────────────────┘ │ │ └─────────────────────┘ │ │ └─────────────────────┘ │ │ │ └─────────────────────────┘ └─────────────────────────┘ └─────────────────────────┘ │ │ SLI Dashboard │ Synthetic tests every 30s │ Auto-remediation playbooks │ └─────────────────────────────────────────────────────────────────────────────────────────┘ Data Flow Patterns: • READ: Client → Regional Proxy → Consistent Hash → Cache Shard → \[Cache Miss → DB\] • WRITE: Client → Write Coordinator → Primary Region → Async Fanout → Global Invalidation • INVALIDATE: Write Event → Kafka Stream → Regional Subscribers → Local Cache Eviction • WARM: ML Predictor → Identified Keys → Background Fetch → Cache Population Key Reliability Patterns Applied: • Multi-master with conflict resolution (CRDTs/Last-Writer-Wins) • Regional read replicas with async global writes • Circuit breakers prevent DB overload on cache failure • Consistent hashing enables graceful shard addition/removal • Background warming maintains high hit ratios

#### 🔧 Technical Implementation Details:

| Component | Technology Choice | Scaling Strategy | Consistency Model |
| --- | --- | --- | --- |
| **Cache Engine** | Redis Cluster/Memcached | Horizontal sharding | Eventually consistent |
| **Proxy Layer** | Envoy/HAProxy | Autoscaling groups | Session affinity |
| **Coordination** | Kafka + Custom Service | Multi-region brokers | Async replication |
| **DB Fallback** | PostgreSQL/Spanner | Read replicas | Strong consistency |
| **Warming System** | ML Pipeline + Workers | Batch processing | Best-effort |

#### 💰 SLO Achievement Strategy:

-   **p99 < 5ms Regional Reads:** In-memory Redis with connection pooling and regional proximity
-   **1s Global Write Propagation:** Async fanout architecture with Kafka-based invalidation bus
-   **≥95% Hit Ratio:** ML-powered predictive warming + intelligent eviction policies (LRU + TTL)
-   **99.99% Availability:** Multi-shard resilience + circuit breakers + graceful degradation to DB

## Design Prompt #4 — Global Incident Response System

### 🎯 Key Requirements

-   Collect alerts from multiple monitoring systems (Prometheus, Stackdriver, Datadog)
-   **Deduplicate similar alerts** (avoid paging storms)
-   Deliver critical alerts to on-call engineers reliably **within 30s (p99)**
-   Support **regional failover** and redundancy
-   Provide **audit trails** and acknowledgment tracking
-   Scale to **5M alerts/day** globally

**Goal:** "Think of something like Google's internal Alertmanager + PagerDuty hybrid — ultra-reliable and globally consistent."

#### SLO Contract:

| SLI / Metric | Target |
| --- | --- |
| **Alert Delivery Latency** | p99 < 30s |
| **Alert Delivery Reliability** | ≥ 99.999% ("five nines") |
| **Deduplication Accuracy** | ≥ 99.5% identical-alert collapse |
| **Acknowledgment Propagation Delay** | ≤ 10s global sync |
| **System Availability** | ≥ 99.99% |

##### 🔥 Challenge E – Alert Intelligence & Semantic Grouping

**Interviewer:** "Your deduplication handles identical alerts perfectly. But in a real outage, we don't get 10,000 identical alerts; we get 10,000 related but different alerts. For example, 'Database CPU high,' 'Query latency p99 high,' and 'API error rate high' for the same service. How would you handle this 'pattern collapse'?"

**Candidate (Staff-Level Response):**

"This requires moving beyond simple fingerprinting to semantic grouping. I'd introduce a **causality engine or alert correlation service** as a new layer in our pipeline. It would work in three steps:

1.  **Service Dependency Graph:** This system would maintain a real-time graph of our service dependencies (e.g., API Frontend → Billing Service → Customer DB), ingested from our service mesh or configuration files.
2.  **Temporal & Topological Correlation:** When an alert for a foundational service like the Customer DB fires, the engine opens a short time window (e.g., 60 seconds). Any subsequent alerts from upstream services that depend on the database (like the Billing Service) are topologically correlated to the root cause alert.
3.  **Composite Alerting:** Instead of paging for all three issues, the system would generate a single, enriched composite alert that provides immediate context to the on-call engineer:
    
    Title: \[P0\] Multiple correlated alerts for Billing Service. Root Cause (Inferred): Customer DB CPU high. Impacted Services: API Frontend (High error rate), Billing Service (High latency).
    

##### 💡 Interviewer Lens:

This is next-level thinking. The candidate is no longer just processing alerts; they are interpreting them. By designing a system that reduces the cognitive load on the on-call engineer, they are demonstrating a deep empathy for operations and a proactive approach to incident management. This is a core trait of SRE leadership at Google.

### Step 6 — Complete Architecture Solution

#### 🏗️ Production-Grade Global Incident Response System

┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ GLOBAL INCIDENT RESPONSE SYSTEM │ │ 5M Alerts/Day │ p99 < 30s Delivery │ 99.999% Reliability │ └─────────────────────────────────────────────────────────────────────────────────────────┘ ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ ALERT SOURCES (Monitoring Systems) │ ├─────────────────────────────────────────────────────────────────────────────────────────┤ │ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ │ │ │ Prometheus │ │ Stackdriver │ │ Datadog │ │ NewRelic │ │ Custom Apps │ │ │ │ ┌─────────┐ │ │ ┌─────────┐ │ │ ┌─────────┐ │ │ ┌─────────┐ │ │ ┌─────────┐ │ │ │ │ │Webhook │ │ │ │Webhook │ │ │ │Webhook │ │ │ │Webhook │ │ │ │gRPC/API │ │ │ │ │ │Auth │ │ │ │Auth │ │ │ │Auth │ │ │ │Auth │ │ │ │TLS Cert │ │ │ │ │ │Payload │ │ │ │Payload │ │ │ │Payload │ │ │ │Payload │ │ │ │Schema │ │ │ │ │ └─────────┘ │ │ └─────────┘ │ │ └─────────┘ │ │ └─────────┘ │ │ └─────────┘ │ │ │ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ │ │ Common Alert Schema: service, severity, timestamp, fingerprint, metadata │ └─────────────────────────────────────────────────────────────────────────────────────────┘ │ HTTPS Webhooks ▼ ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ MULTI-REGION INGESTION TIER │ ├─────────────────────────────────────────────────────────────────────────────────────────┤ │ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐ │ │ │ US-WEST-1 │ │ US-EAST-1 │ │ EU-WEST-1 │ │ │ │ ┌─────────────┐ │ │ ┌─────────────┐ │ │ ┌─────────────┐ │ │ │ │ │Alert Gateway│ │ │ │Alert Gateway│ │ │ │Alert Gateway│ │ │ │ │ │• Rate Limit │ │ │ │• Rate Limit │ │ │ │• Rate Limit │ │ │ │ │ │• Validation │ │ │ │• Validation │ │ │ │• Validation │ │ │ │ │ │• Auth Check │ │ │ │• Auth Check │ │ │ │• Auth Check │ │ │ │ │ │• Schema Norm│ │ │ │• Schema Norm│ │ │ │• Schema Norm│ │ │ │ │ │• Enrichment │ │ │ │• Enrichment │ │ │ │• Enrichment │ │ │ │ │ └─────────────┘ │ │ └─────────────┘ │ │ └─────────────┘ │ │ │ │ Load Balancer │ │ Load Balancer │ │ Load Balancer │ │ │ │ Health Checks │ │ Health Checks │ │ Health Checks │ │ │ └─────────────────┘ └─────────────────┘ └─────────────────┘ │ │ Active-Active: Regional failover in <10s │ Cross-region alert replication │ └─────────────────────────────────────────────────────────────────────────────────────────┘ │ ▼ ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ DURABLE ALERT QUEUE (Multi-Region Kafka) │ ├─────────────────────────────────────────────────────────────────────────────────────────┤ │ ┌────────────────────────────────────────────────────────────────────────────────┐ │ │ │ Topic: raw-alerts │ Partitions: 500 │ Retention: 7d │ Replication: 3x │ │ │ ├────────────────────────┼──────────────────┼───────────────┼────────────────────┤ │ │ │ Partition Key: service\_name + fingerprint │ Ordering: per alert type │ │ │ │ DLQ: malformed-alerts │ Throughput: 100k alerts/sec sustained │ │ │ └────────────────────────────────────────────────────────────────────────────────┘ │ │ MirrorMaker 2.0 for cross-region replication │ Backpressure controls │ └─────────────────────────────────────────────────────────────────────────────────────────┘ │ ▼ ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ INTELLIGENT PROCESSING PIPELINE │ ├─────────────────────────────────────────────────────────────────────────────────────────┤ │ ┌──────────────────────────┐ ┌──────────────────────────┐ ┌──────────────────────────┐ │ │ │ DEDUPLICATION ENGINE │ │ CORRELATION & GROUPING │ │ PRIORITY & ROUTING │ │ │ │ ┌──────────────────────┐ │ │ ┌──────────────────────┐ │ │ ┌──────────────────────┐ │ │ │ │ │ Fingerprint Cache │ │ │ │ Service Dependency │ │ │ │ Alert Severity Map │ │ │ │ │ │ • Rolling window │ │ │ │ Graph (Real-time) │ │ │ │ • P0: Page immediat. │ │ │ │ │ │ • Similar alerts │ │ │ │ ┌──────────────────┐ │ │ │ │ • P1: Page in 5min │ │ │ │ │ │ • Configurable TTL │ │ │ │ │Service A → DB │ │ │ │ │ • P2: Ticket only │ │ │ │ │ │ Storm prevention │ │ │ │ │Service B → Cache │ │ │ │ │ • P3: Metrics only │ │ │ │ │ │ • Max 10/min/service │ │ │ │ │Service C → Queue │ │ │ │ │ Escalation Policies │ │ │ │ │ └──────────────────────┘ │ │ │ └──────────────────┘ │ │ │ └──────────────────────┘ │ │ │ │ ┌──────────────────────┐ │ │ │ Temporal Correlation │ │ │ ┌──────────────────────┐ │ │ │ │ │ Semantic Similarity │ │ │ │ • 60s time window │ │ │ │ On-Call Scheduler │ │ │ │ │ │ • NLP fingerprints │ │ │ │ • Root cause detect │ │ │ │ • Teams/Rotations │ │ │ │ │ │ • ML-based grouping │ │ │ │ • Composite alerts │ │ │ │ • Escalation ladder │ │ │ │ │ │ • Alert families │ │ │ │ • Impact propagation │ │ │ │ • Time zone aware │ │ │ │ │ └──────────────────────┘ │ │ └──────────────────────┘ │ │ └──────────────────────┘ │ │ │ └──────────────────────────┘ └──────────────────────────┘ └──────────────────────────┘ │ │ Stateless workers │ Auto-scaling │ Circuit breakers │ Checkpoints for recovery │ └─────────────────────────────────────────────────────────────────────────────────────────┘ │ ▼ ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ MULTI-CHANNEL NOTIFICATION SYSTEM │ ├─────────────────────────────────────────────────────────────────────────────────────────┤ │ ┌─────────────────────────┐ ┌─────────────────────────┐ ┌─────────────────────────┐ │ │ │ PRIMARY CHANNELS │ │ SECONDARY CHANNELS │ │ FALLBACK CHANNELS │ │ │ │ ┌─────────────────────┐ │ │ ┌─────────────────────┐ │ │ ┌─────────────────────┐ │ │ │ │ │ PagerDuty API │ │ │ │ Slack Webhooks │ │ │ │ SMS Gateway │ │ │ │ │ │ • Circuit breaker │ │ │ │ • Rich formatting │ │ │ │ • Twilio/AWS SNS │ │ │ │ │ │ • Retry w/backoff │ │ │ │ • Thread management │ │ │ │ • Global coverage │ │ │ │ │ │ • Incident tracking │ │ │ │ • Bot interactions │ │ │ │ • Last resort only │ │ │ │ │ └─────────────────────┘ │ │ └─────────────────────┘ │ │ └─────────────────────┘ │ │ │ │ ┌─────────────────────┐ │ │ ┌─────────────────────┐ │ │ ┌─────────────────────┐ │ │ │ │ │ Email SMTP │ │ │ │ Microsoft Teams │ │ │ │ Push Notifications │ │ │ │ │ │ • Multi-provider │ │ │ │ • Adaptive cards │ │ │ │ • Mobile apps │ │ │ │ │ │ • HTML + plaintext │ │ │ │ • Action buttons │ │ │ │ • Wake-up capable │ │ │ │ │ │ • Template engine │ │ │ │ • Deep links │ │ │ │ • Location aware │ │ │ │ │ └─────────────────────┘ │ │ └─────────────────────┘ │ │ └─────────────────────┘ │ │ │ └─────────────────────────┘ └─────────────────────────┘ └─────────────────────────┘ │ │ Delivery Strategy: Primary first → Secondary if fail → Fallback if P0/P1 │ └─────────────────────────────────────────────────────────────────────────────────────────┘ │ ▼ ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ ACKNOWLEDGMENT & STATE TRACKING │ ├─────────────────────────────────────────────────────────────────────────────────────────┤ │ ┌─────────────────────────┐ ┌─────────────────────────┐ │ │ │ STATE DATABASE │ │ AUDIT & ANALYTICS │ │ │ │ ┌─────────────────────┐ │ │ ┌─────────────────────┐ │ │ │ │ │ Multi-Region │ │ │ │ Alert Lifecycle │ │ │ │ │ │ Spanner/Postgres │ │ │ │ • Time to ack │ │ │ │ │ │ ┌─────────────────┐ │ │ │ │ • Resolution time │ │ │ │ │ │ │ │Alert States: │ │ │ │ │ • False pos. rate │ │ │ │ │ │ │ │- FIRING │ │ │◄────────────►│ │ │ • Channel success │ │ │ │ │ │ │ │- ACKNOWLEDGED │ │ │ │ │ │ Trend Analysis │ │ │ │ │ │ │ │- RESOLVED │ │ │ │ │ │ • Service patterns │ │ │ │ │ │ │ │- ESCALATED │ │ │ │ │ │ • Team performance │ │ │ │ │ │ │ │- SUPPRESSED │ │ │ │ │ │ • System health │ │ │ │ │ │ │ └─────────────────┘ │ │ │ │ └─────────────────────┘ │ │ │ │ │ └─────────────────────┘ │ │ └─────────────────────────┘ │ │ │ └─────────────────────────┘ └─────────────────────────────┘ │ │ Global consistency │ Conflict resolution │ SLI computation │ Alerting feedback loops │ └─────────────────────────────────────────────────────────────────────────────────────────┘ Alert Lifecycle Flow: 1. INGEST: Multi-source → Gateway → Schema normalization → Queue 2. PROCESS: Deduplication → Correlation → Priority assignment → Routing rules 3. NOTIFY: Multi-channel dispatch → Delivery confirmation → Retry logic 4. TRACK: State updates → Global sync → Audit trail → Analytics pipeline 5. RESOLVE: Manual/Auto resolution → Notification → Post-incident analysis Key Reliability Patterns Applied: • Multi-region active-active ingestion (no single point of failure) • Semantic alert correlation (reduces noise, increases signal) • Priority-based delivery (critical alerts bypass throttling) • Multi-path notification (redundancy across channels) • Global state synchronization (audit and consistency)

#### 🔧 Technical Implementation Details:

| Component | Technology Choice | Scaling Strategy | Failure Mitigation |
| --- | --- | --- | --- |
| **Alert Gateway** | Go/Java microservices | Autoscaling groups | Circuit breakers, health checks |
| **Message Queue** | Kafka with Schema Registry | Dynamic partitioning | Multi-region replication |
| **Processing Engine** | Apache Flink/Beam | Stream processing | Checkpointing, exactly-once |
| **Correlation Service** | Graph DB + ML Pipeline | Horizontal scaling | Cached dependency graphs |
| **State Store** | Spanner/CockroachDB | Global distribution | Multi-primary consistency |

#### 💰 SLO Achievement Strategy:

-   **p99 < 30s Alert Delivery:** Regional processing + priority queuing + multi-channel redundancy
-   **99.999% Delivery Reliability:** Multi-region active-active + persistent retry queues + fallback channels
-   **≥99.5% Deduplication Accuracy:** ML-powered semantic fingerprinting + configurable time windows
-   **≤10s Global ACK Sync:** Distributed state machine with conflict-free replicated data types (CRDTs)

## Design Prompt #5 — SLO Error Budget Tracker

### 🎯 Most Authentically "Google" Prompt

Google teams track SLOs (Service Level Objectives) to measure reliability and manage error budgets. You're asked to design a system that:

-   Ingests raw **SLIs** (Service Level Indicators) such as success rate, latency, and availability from multiple services
-   Computes **SLO compliance** (e.g., 99.9% success) continuously
-   Tracks **error budget burn rate** over multiple time windows (1h, 6h, 30d)
-   Triggers alerts when burn rate **exceeds thresholds** (e.g., 2× expected)
-   Exposes **dashboards and APIs** for SREs and product owners

**Essentially:** "Build the backend brain of Google's reliability measurement stack — the system that decides when a service is burning through its reliability budget."

#### SLO Contract for the Tracker itself:

| SLI / Metric | Target |
| --- | --- |
| **SLO computation latency** | < 60s p95 |
| **Computation accuracy** | ≥ 99.99% data consistency |
| **System availability** | 99.99% |
| **Error budget alert delay** | < 5 min |

##### 💡 Interviewer Lens:

They've not only defined SLOs for the services being tracked but also for the tracker itself — a subtle, senior-level move.

#### Production-Grade Architecture:

| Component | Tech / Pattern | SLO Benefit |
| --- | --- | --- |
| **Data Ingestion** | Kafka + Pub/Sub + Checkpointing | Reliable stream processing |
| **Compute Engine** | Apache Beam / Dataflow | Low-latency, fault-tolerant aggregation |
| **Alert Engine** | Bigtable for rolling windows + Spanner for SLO configs | Burn-rate rule evaluation + deduplication |
| **API / UI** | Serves aggregated SLO state with filters | Transparency / observability |

##### 🍀 Pro Tip Box

**For the System:** "An SLO system is only useful if its own SLOs are measurable and reliable. Instrument the tracker as ruthlessly as you would a user-facing service."

**For the Business:** "An SLO system's ultimate purpose is to serve as a data-driven contract between product and reliability. When the error budget is green, product teams have the explicit freedom to launch features and take risks. When the budget turns red, the contract dictates that engineering effort must pivot to reliability work. This tracker isn't just for alerts; it's for automating strategic decision-making."

### Step 6 — Complete Architecture Solution

#### 🏗️ Production-Grade SLO Error Budget Tracker

┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ SLO ERROR BUDGET TRACKER SYSTEM │ │ p95 < 60s Compute │ 99.99% Accuracy │ < 5min Alert Delay │ └─────────────────────────────────────────────────────────────────────────────────────────┘ ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ SLI DATA SOURCES (Raw Telemetry Streams) │ ├─────────────────────────────────────────────────────────────────────────────────────────┤ │ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ │ │ │Load Balancer│ │API Gateway │ │ Application │ │ Database │ │Infrastructure│ │ │ │ ┌─────────┐ │ │ ┌─────────┐ │ │ ┌─────────┐ │ │ ┌─────────┐ │ │ ┌─────────┐ │ │ │ │ │Req Count│ │ │ │Success │ │ │ │Response │ │ │ │Query │ │ │ │CPU/Mem │ │ │ │ │ │2xx/4xx/ │ │ │ │Rate │ │ │ │Latency │ │ │ │Latency │ │ │ │Disk I/O │ │ │ │ │ │5xx codes│ │ │ │Error % │ │ │ │P50/P95/ │ │ │ │Timeouts │ │ │ │Network │ │ │ │ │ │Latency │ │ │ │Throughp.│ │ │ │P99 dist │ │ │ │Connect │ │ │ │Health │ │ │ │ │ └─────────┘ │ │ └─────────┘ │ │ └─────────┘ │ │ └─────────┘ │ │ └─────────┘ │ │ │ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ │ │ Structured metrics │ Prometheus format │ OpenTelemetry │ Custom exporters │ └─────────────────────────────────────────────────────────────────────────────────────────┘ │ Pull/Push APIs ▼ ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ SLI INGESTION & NORMALIZATION LAYER │ ├─────────────────────────────────────────────────────────────────────────────────────────┤ │ ┌─────────────────────────┐ ┌─────────────────────────┐ │ │ │ COLLECTION AGENTS │ │ NORMALIZATION ENGINE │ │ │ │ ┌─────────────────────┐ │ │ ┌─────────────────────┐ │ │ │ │ │ Prometheus Scraper │ │ │ │ Schema Validator │ │ │ │ │ │ • Service discovery │ │ │ │ • Standard SLI fmt │ │ │ │ │ │ • Auto-scaling │ │ │ │ • Unit conversion │ │ │ │ │ │ • Failure handling │ │ │ │ • Timestamp norm. │ │ │ │ │ └─────────────────────┘ │◄────────────►│ │ • Metadata enrich │ │ │ │ │ ┌─────────────────────┐ │ │ └─────────────────────┘ │ │ │ │ │ Push Gateway │ │ │ ┌─────────────────────┐ │ │ │ │ │ • Batch processing │ │ │ │ SLI Type Classifier │ │ │ │ │ │ • Rate limiting │ │ │ │ • Availability │ │ │ │ │ │ • Authentication │ │ │ │ • Latency (P95/P99) │ │ │ │ │ │ • Circuit breakers │ │ │ │ • Throughput │ │ │ │ │ └─────────────────────┘ │ │ │ • Error rate │ │ │ │ └─────────────────────────┘ │ └─────────────────────┘ │ │ └─────────────────────────────────────────────────────────────────────────────────────────┘ │ ▼ ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ REAL-TIME SLO COMPUTATION ENGINE (Apache Beam/Dataflow) │ ├─────────────────────────────────────────────────────────────────────────────────────────┤ │ ┌──────────────────────────┐ ┌──────────────────────────┐ ┌──────────────────────────┐ │ │ │ SLIDING WINDOWS │ │ SLO RULE ENGINE │ │ BURN RATE CALCULATOR │ │ │ │ ┌──────────────────────┐ │ │ ┌──────────────────────┐ │ │ ┌──────────────────────┐ │ │ │ │ │ 1-minute windows │ │ │ │ SLO Configuration │ │ │ │ Multi-Window Burn │ │ │ │ │ │ 5-minute windows │ │ │ │ ┌──────────────────┐ │ │ │ │ ┌──────────────────┐ │ │ │ │ │ │ 1-hour windows │ │ │ │ │Service: auth-svc │ │ │ │ │ │ 1h window: 14.4x │ │ │ │ │ │ │ 6-hour windows │ │ │ │ │SLO: 99.9% avail │ │ │ │ │ │ 6h window: 6x │ │ │ │ │ │ │ 24-hour windows │ │ │ │ │Error Budget: 8.7h│ │ │ │ │ │ 24h window: 3x │ │ │ │ │ │ │ 30-day windows │ │ │ │ │Budget Period: 30d│ │ │ │ │ │ 30d window: 1x │ │ │ │ │ │ └──────────────────────┘ │ │ │ └──────────────────┘ │ │ │ └──────────────────┘ │ │ │ │ │ Watermarks & Late Data │ │ │ SLI → SLO Mapping │ │ │ Alert Thresholds │ │ │ │ │ Exactly-once processing │ │ │ Dynamic config reload │ │ │ Multi-burn detection │ │ │ │ └──────────────────────────┘ └──────────────────────────┘ └──────────────────────────┘ │ │ State: Bigtable checkpoints │ Config: Spanner/etcd │ Alerts: Kafka topics │ └─────────────────────────────────────────────────────────────────────────────────────────┘ │ ▼ ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ SLO STATE STORE & ALERT ENGINE │ ├─────────────────────────────────────────────────────────────────────────────────────────┤ │ ┌─────────────────────────┐ ┌─────────────────────────┐ │ │ │ TIME-SERIES STORAGE │ │ ALERT GENERATOR │ │ │ │ ┌─────────────────────┐ │ │ ┌─────────────────────┐ │ │ │ │ │ Bigtable/DynamoDB │ │ │ │ Burn Rate Rules │ │ │ │ │ │ ┌─────────────────┐ │ │ │ │ ┌─────────────────┐ │ │ │ │ │ │ │ Row Key: │ │ │ │ │ │ FAST: >14.4x │ │ │ │ │ │ │ │service#slo#time │ │ │ │ │ │ burn in 1h │ │ │ │ │ │ │ │ │ │ │ │ │ │ → Page immed. │ │ │ │ │ │ │ │ Columns: │ │ │◄────────────►│ │ │ SLOW: >3x burn │ │ │ │ │ │ │ │ - good\_events │ │ │ │ │ │ in 24h │ │ │ │ │ │ │ │ - total\_events │ │ │ │ │ │ → Warning alert │ │ │ │ │ │ │ │ - slo\_target │ │ │ │ │ └─────────────────┘ │ │ │ │ │ │ │ - budget\_remain │ │ │ │ │ Budget Exhaustion │ │ │ │ │ │ │ │ - burn\_rate │ │ │ │ │ • 50% budget → warn │ │ │ │ │ │ │ └─────────────────┘ │ │ │ │ • 90% budget → crit │ │ │ │ │ │ └─────────────────────┘ │ │ └─────────────────────┘ │ │ │ └─────────────────────────┘ └─────────────────────────┘ │ │ Sharded by service │ Auto-scaling │ Read replicas │ Alert deduplication │ └─────────────────────────────────────────────────────────────────────────────────────────┘ │ ▼ ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │ API LAYER & DASHBOARD SERVICES │ ├─────────────────────────────────────────────────────────────────────────────────────────┤ │ ┌─────────────────────────┐ ┌─────────────────────────┐ ┌─────────────────────────┐ │ │ │ QUERY API │ │ DASHBOARD SERVICE │ │ CONFIGURATION API │ │ │ │ ┌─────────────────────┐ │ │ ┌─────────────────────┐ │ │ ┌─────────────────────┐ │ │ │ │ │ GraphQL Endpoint │ │ │ │ Real-time SLO Views │ │ │ │ SLO CRUD Operations │ │ │ │ │ │ • Service queries │ │ │ │ • Error budget viz │ │ │ │ • Version control │ │ │ │ │ │ • Time range filter │ │ │ │ • Burn rate trends │ │ │ │ • Approval workflow │ │ │ │ │ │ • Aggregation funcs │ │ │ │ • Alert timeline │ │ │ │ • Rollback support │ │ │ │ │ │ • Caching layer │ │ │ │ • Multi-service view│ │ │ │ • Schema validation │ │ │ │ │ └─────────────────────┘ │ │ └─────────────────────┘ │ │ └─────────────────────┘ │ │ │ │ ┌─────────────────────┐ │ │ ┌─────────────────────┐ │ │ ┌─────────────────────┐ │ │ │ │ │ REST API Gateway │ │ │ │ Team Ownership Map │ │ │ │ Audit & Change Log │ │ │ │ │ │ • Rate limiting │ │ │ │ • On-call rotations │ │ │ │ • Who changed what │ │ │ │ │ │ • Authentication │ │ │ │ • Escalation paths │ │ │ │ • When and why │ │ │ │ │ │ • Request batching │ │ │ │ • Contact methods │ │ │ │ • Impact analysis │ │ │ │ │ └─────────────────────┘ │ │ └─────────────────────┘ │ │ └─────────────────────┘ │ │ │ └─────────────────────────┘ └─────────────────────────┘ └─────────────────────────┘ │ │ Multi-tenant isolation │ Redis caching │ Load balancing │ Circuit breakers │ └─────────────────────────────────────────────────────────────────────────────────────────┘ SLO Computation Logic: 1. INGEST: Raw SLI metrics → Normalization → Structured events 2. COMPUTE: Sliding window aggregation → SLO compliance % → Error budget calculation 3. ALERT: Multi-window burn rate detection → Threshold breach → Alert generation 4. SERVE: Query API → Cached results → Dashboard visualization → Team notifications 5. CONFIG: Dynamic SLO management → Version control → Approval workflow → Rollback Key Reliability Patterns Applied: • Exactly-once stream processing (duplicate SLI handling) • Multi-window burn rate alerting (fast + slow burn detection) • Immutable SLO configuration (versioned, auditable changes) • Circuit breakers on data sources (prevent SLI cascade failures) • Global state replication (cross-region SLO consistency)

#### 🔧 Technical Implementation Details:

| Component | Technology Choice | Scaling Strategy | Consistency Model |
| --- | --- | --- | --- |
| **Stream Processing** | Apache Beam/Dataflow | Auto-scaling workers | Exactly-once processing |
| **Time-Series Storage** | Bigtable/DynamoDB | Automatic sharding | Strong consistency |
| **Configuration Store** | Spanner/etcd | Global replication | Strong consistency |
| **API Layer** | GraphQL + REST | Horizontal scaling | Read replicas |
| **Dashboard** | React + WebSocket | CDN distribution | Eventually consistent |

#### 💰 SLO Achievement Strategy:

-   **p95 < 60s Compute Latency:** Stream processing with micro-batching + pre-computed aggregations
-   **99.99% Data Accuracy:** Exactly-once processing guarantees + data validation checkpoints
-   **< 5min Alert Delay:** Real-time burn rate calculation + prioritized alert queues
-   **99.99% System Availability:** Multi-region deployment + circuit breakers + graceful degradation

## Design Prompt #6 — Canary Deployment Controller

### 🎯 Progressive Delivery at Scale

Google wants a system that safely deploys new service versions globally with minimal risk. Your task: design a Canary Deployment Controller that can:

-   **Gradually roll out** new versions across clusters or regions
-   **Route a small %** of production traffic to canary instances
-   **Measure key SLIs** (latency, error rate, CPU, memory) for both canary and baseline
-   **Automatically promote or rollback** based on statistical comparison
-   Integrate with existing CI/CD pipelines (e.g., Spinnaker, Borg, or Kubernetes)

**Goal:** "Build the control brain that decides whether a release is healthy enough to go 100%."

#### SLO Contract for the Controller:

| SLI / Metric | Target |
| --- | --- |
| **Deployment failure detection latency** | < 60s p95 |
| **Rollback success rate** | 99.99% |
| **Promotion decision accuracy (false positive rate)** | < 0.1% |
| **Controller availability** | 99.99% |
| **Canary vs. Baseline metric parity** | ± 5% tolerance |

##### 💡 Interviewer Lens:

Starting with SLOs for the deployment system itself shows real Google DNA — reliability as a product, not an afterthought.

#### Enhanced Decision Module

"The Decision Module would be more sophisticated than simple thresholds. It would be **error-budget-aware**. A deployment would only be allowed to proceed if the service's current error budget for the quarter is healthy. If a canary deployment starts burning the error budget at an accelerated rate (e.g., 5% of the monthly budget in one hour), the controller would trigger an automatic rollback, even if no single metric has crossed a hard red line. This aligns our release velocity directly with user-facing reliability."

##### 💡 Pro Tip:

"A canary controller is not a deployment tool — it's a risk management system with code as the interface."

#### 🏗️ Production-Grade Canary Deployment Controller

![Canary Deployment Controller Architecture](/images/canary-deployment-detailed.png)

**Canary Deployment Controller:** Progressive release automation with ML-based decision engine, error budget awareness, and statistical significance testing for safe deployments.

**Key Features:** Traffic splitting • Real-time SLI tracking • Automated rollback • Statistical tests • Audit trails

#### 🔧 Technical Implementation Details:

| Component | Technology Choice | Scaling Strategy | Reliability Pattern |
| --- | --- | --- | --- |
| **Traffic Splitter** | Istio/Envoy service mesh | Per-cluster configuration | Progressive percentage rollout (1% → 5% → 25% → 100%) |
| **Metrics Collection** | Prometheus + Grafana | Federated monitoring | Real-time SLI comparison with statistical significance |
| **Decision Engine** | ML model (Random Forest) | Ensemble voting | Error budget aware + Mann-Whitney U test |
| **Rollback System** | Kubernetes native APIs | Instant pod replacement | Circuit breaker pattern with manual override |
| **Audit Trail** | Event sourcing to Kafka | Immutable log storage | Complete deployment decision history |

#### 📊 SLO Achievement Strategy:

-   **Detection Latency < 60s:** Real-time streaming metrics with 10s collection intervals and 30s analysis windows
-   **Rollback Success 99.99%:** Pre-validated rollback plans with automated health checks and pod readiness gates
-   **False Positive < 0.1%:** Statistical significance testing (p-value < 0.01) combined with business context validation
-   **Controller Availability 99.99%:** Multi-region controller deployment with leader election and state replication

#### 🎯 Advanced Decision Logic:

**Multi-Signal Analysis:** The decision engine doesn't rely on single metrics. It performs correlation analysis across latency (p50, p95, p99), error rates (4xx, 5xx), throughput (QPS), and resource utilization (CPU, memory). The system uses a weighted ensemble approach where each signal contributes to a confidence score.

**Error Budget Integration:** Before any deployment proceeds beyond 5% traffic, the controller checks the service's current error budget consumption. If the monthly budget is >80% consumed, the controller automatically applies stricter thresholds and shorter observation windows. This prevents deployments from exhausting error budgets during already-stressed periods.

## Design Prompt #7 — Distributed Task Queue

### 🎯 Background Processing at Scale

Design a global distributed task queue used by multiple teams for background processing (jobs like image processing, email sending, data enrichment).

#### Requirements:

-   Support **10M tasks/sec ingest** across regions at peak
-   Guarantee **at-least-once delivery** and optionally support idempotent exactly-once semantics
-   Provide visibility: **per-task status, retries, failures, and DLQ**
-   Provide latency SLIs: **p95 enqueue→start ≤ 2s** for regional tasks (local), p99 ≤ 10s global
-   Support controlled **retry/backoff policies**, exponential backoff, and maximum retries before DLQ

#### SLO Contract (for the queue):

| Metric | Target |
| --- | --- |
| **Enqueue → Start Latency (regional)** | p95 ≤ 2s |
| **Enqueue → Start Latency (global)** | p99 ≤ 10s |
| **Delivery Reliability** | ≥ 99.999% (at-least-once delivered or moved to DLQ) |
| **Task visibility latency** | p95 ≤ 5s (status updates) |
| **Queue availability** | 99.99% |

#### Key Challenges & Solutions:

##### Challenge B — Exactly-once vs At-least-once semantics

**Interviewer:** "Some tasks need exactly-once delivery. How do you support that?"

**Candidate:**

-   **Default model:** at-least-once (simple, scalable)
-   **Exactly-once:** require idempotency key + idempotent worker logic + dedupe table (transactional store keyed by idempotency key)
-   Use compare-and-set or conditional writes in transactional DB (Spanner/Bigtable) during task completion to avoid double-apply

#### 🏗️ Production-Grade Distributed Task Queue

![LinkedIn Distributed Task Queue Complete Architecture](/images/distributed-task-queue-detailed.png)

**LinkedIn-Style Distributed Task Queue:** Complete flow from producer enqueue → gateway admission → Kafka partitioning → scheduler routing → specialized worker pools → success/failure paths with exactly-once semantics.

**Key Reliability Patterns:** Idempotency keys • Lease-based claiming • CAS operations • Multi-pool routing • Exponential backoff • Dead letter queues • Predictive auto-scaling • Circuit breakers • Control loops

#### 🔧 Technical Implementation Details:

| Component | Technology Choice | Scaling Strategy | Reliability Pattern |
| --- | --- | --- | --- |
| **Queue Management** | Apache Kafka (partitioned topics) | Horizontal partition scaling | Multi-level priority with SLA-based routing |
| **Worker Pools** | Kubernetes Jobs + HPA | Auto-scaling (1K-20K instances) | Specialized pools: CPU/IO/GPU/Memory workers |
| **Task Scheduling** | Custom scheduler + Redis | Distributed consensus | Delayed execution with cron-like patterns |
| **State Management** | PostgreSQL + S3/GCS | Read replicas + sharding | Task state tracking with retry policies |
| **Rate Limiting** | Token bucket (Redis) | Per-tenant quotas | Fair queuing with sliding windows |

#### 📊 SLO Achievement Strategy:

-   **Processing Latency p95 < 30s:** Intelligent worker assignment based on task type with resource-optimized pools
-   **Failure Rate < 0.1%:** Comprehensive retry policies with exponential backoff and dead letter queue handling
-   **Throughput 10M tasks/sec:** Kafka partitioning strategy with consistent hashing and auto-scaling worker pools
-   **Multi-tenant Isolation:** Per-tenant resource quotas with fair scheduling and priority-based queue management

#### 🎯 LinkedIn-Style Flow Implementation:

**Step 1-3: Producer → Gateway → Kafka:** The LinkedIn image-upload service enqueues a thumbnail generation task with payload, tenant ID, priority class, and idempotency key (hash of input). The gateway performs authentication, schema validation, per-tenant token bucket checking, and crucially, a Spanner CAS operation: "insert this key if it doesn't exist." If the key exists, return the original task ID (preventing duplicate tasks from retries). Task lands in the appropriate Kafka topic (tasks.p0/p1/p2) partitioned by hash(tenant\_id) for ordering within tenant while spreading tenants across partitions for parallelism.

**Step 4-6: Scheduler → Worker Claims → Completion:** Stateless scheduler workers consume from Kafka and route tasks based on type: image\_resize → CPU pool, send\_email → I/O pool, run\_inference → GPU pool. Workers claim tasks with leases (30s validity, 10s heartbeat renewal) rather than locks. No distributed lock manager prevents split-brain scenarios. Worker completion requires a conditional write to Spanner: "mark task=DONE only if status=RUNNING and my lease is valid." This CAS operation ensures exactly-once semantics - if the lease expired and another worker completed the task, the second worker's write fails harmlessly.

**Step 7: Failure Paths & Control Loops:** Worker crashes result in lease expiration and automatic task re-claiming by other workers. Task failures trigger exponential backoff requeuing (1s, 2s, 4s, 8s, 16s, 32s) with terminal failure after N retries moving tasks to DLQ. Background control loops include Kafka consumer lag feeding autoscalers, ML forecasting for 15-minute ahead capacity pre-warming, DLQ depth monitoring for systemic issues, and lease sweepers for edge case cleanup. Circuit breakers to downstream dependencies prevent cascading failures by failing fast and requeuing with backoff.

## Design Prompt #8 — AI-Infused Anomaly Detection System

### 🎯 The Showstopper Prompt

Your mission: design an AI-driven anomaly detection platform that continuously monitors SLO metrics across thousands of services and automatically detects, classifies, and prioritizes anomalies before they cause SLO breaches.

#### Requirements:

-   Ingest **millions of time series** from services across Google-scale systems
-   Identify anomalies (spikes, drifts, trends) with **minimal false positives**
-   Integrate with SLO Error Budget Tracker to predict **burn-rate acceleration**
-   Trigger human notifications only for **meaningful anomalies** (SLO-impacting)
-   Target latency for anomaly detection: **≤ 2 minutes** for high-priority SLO metrics

**Goal:** "Build the system that catches an outage before your pager does."

#### SLO Contract (for the Anomaly Detection System itself):

| Metric | Target |
| --- | --- |
| **Detection latency** | p95 ≤ 2 min |
| **False positive rate** | ≤ 1% |
| **False negative rate** | ≤ 2% |
| **System uptime** | ≥ 99.99% |
| **Detection coverage (monitored SLIs)** | ≥ 95% of SLO metrics |

##### 💡 Interviewer Lens:

The best candidates define SLOs for the AI system itself. That's the meta-signal of an SRE mindset — ML is a component of reliability, not an exception to it.

##### 💡 Pro Tip:

"In SRE, an ML detector is just another production system. Monitor it, canary it, and page it when it drifts. Its most important SLI is the trust of the on-call engineer."

#### 🏗️ Production-Grade AI Anomaly Detection Platform

![AI-Powered Anomaly Detection Architecture](/images/anomaly-detection-detailed.png)

**AI Anomaly Detection Platform:** Real-time ML-powered detection across metrics, logs, traces, and events with ensemble models, automated response, and continuous learning feedback loops.

**Key Features:** Multi-modal detection • Ensemble models • Feature engineering • Automated remediation • False positive learning

#### 🔧 Technical Implementation Details:

| Component | Technology Choice | Scaling Strategy | Reliability Pattern |
| --- | --- | --- | --- |
| **Feature Engineering** | Apache Beam + Feature Store | Stream processing pipelines | Time series, statistical, graph, and text features |
| **ML Models** | Ensemble: Isolation Forest, LSTM-AE, VAE, One-Class SVM, Transformer | Model parallelization | Consensus voting with confidence scoring |
| **Decision Engine** | Custom inference service | Auto-scaling containers | Context-aware alerting with business impact assessment |
| **Response System** | Playbook automation + Human-in-loop | Graduated automation | Safe automated actions with manual override capability |
| **Feedback Loop** | Online learning + Model retraining | Continuous deployment | False positive learning with human feedback integration |

#### 📊 SLO Achievement Strategy:

-   **Detection Latency < 60s:** Real-time feature computation with sub-minute model inference using ensemble parallel processing
-   **False Positive Rate < 2%:** Multi-model consensus voting combined with business context validation and historical pattern analysis
-   **Coverage 99.5%:** Multi-modal data ingestion (metrics, logs, traces, events) with comprehensive feature engineering pipeline
-   **Model Drift Detection:** Continuous model performance monitoring with automated retraining triggers and A/B testing for model updates

#### 🎯 Advanced ML Architecture:

**Ensemble Approach:** No single model can detect all anomaly types. The system uses Isolation Forest for high-dimensional outliers, LSTM Autoencoders for temporal sequences, VAEs for generative modeling, One-Class SVMs for boundary learning, and Transformers for multi-modal contexts. Each model votes on anomaly probability with confidence weighting.

**Continuous Learning:** The system maintains a feedback loop where human operators can mark false positives/negatives. This feedback is used for online learning to adjust model weights and retrain models. A/B testing ensures new model versions improve performance before full deployment, treating the ML system like any other production service.

## Design Prompt #9 — Unified Global Monitoring Platform

### 🎯 Planet-Scale Observability Challenge

Design the ultimate unified monitoring platform that Google would use internally — a system that combines metrics, logs, traces, and events from across the entire Google ecosystem into a single pane of glass.

#### Requirements:

-   Ingest **1 billion events per minute** from 100+ million devices and services globally
-   Support **multi-modal data**: time-series metrics, structured logs, distributed traces, business events
-   **Real-time query performance**: p95 < 200ms for dashboards, ad-hoc queries within seconds
-   **Planet-scale edge collection**: 150+ global PoPs with intelligent data routing
-   **Cost optimization**: Automated tiering, compression, lifecycle management
-   **Universal query interface**: Single API for all data types with intelligent correlation

**Goal:** "Build the monitoring system that monitors all of Google's other monitoring systems."

#### SLO Contract for the Platform:

| SLI / Metric | Target |
| --- | --- |
| **Platform availability** | 99.99% (< 4.4 min downtime/month) |
| **Query latency (dashboards)** | p95 < 200ms, p99 < 1s |
| **Data ingestion rate** | 1B events/min sustained, 5B burst |
| **Data freshness** | p95 < 30s from edge to queryable |
| **Storage cost efficiency** | 80% compression ratio, 95% automated tiering |

#### 🏗️ Production-Grade Unified Global Monitoring Platform

![Unified Global Monitoring Platform Architecture](/images/unified-global-monitoring-detailed.png)

**Unified Global Monitoring Platform:** Planet-scale observability with 150+ edge PoPs, multi-tier storage, intelligent routing, and unified query interface for 1B+ events/minute.

**Key Features:** Global edge collection • Multi-modal data • Intelligent routing • Cost optimization • Unified query API

#### 🔧 Technical Implementation Details:

| Component | Technology Choice | Scaling Strategy | Reliability Pattern |
| --- | --- | --- | --- |
| **Global Edge Network** | Custom edge collectors + Envoy | 150+ PoPs worldwide | Protocol adaptation with intelligent routing |
| **Unified Ingestion** | Apache Beam + Schema Registry | Auto-scaling pipelines | Multi-format support with tenant isolation |
| **Multi-Tier Storage** | Hot(SSD)/Warm(Hybrid)/Cold(Object) | Automated lifecycle management | Query performance vs cost optimization |
| **Query Engine** | Custom OLAP + ClickHouse + Elasticsearch | Federated query routing | Unified API with intelligent data correlation |
| **Intelligence Layer** | ML anomaly detection + Cost analytics | Real-time processing | Automated insights and cost optimization |

#### 📊 SLO Achievement Strategy:

-   **Platform Availability 99.99%:** Multi-region deployment with intelligent failover and no single points of failure
-   **Query Latency p95 < 200ms:** Intelligent query routing with hot/warm/cold tier optimization and pre-computed aggregations
-   **Ingestion 1B events/min:** Global edge network with protocol adaptation and auto-scaling stream processing pipelines
-   **Data Freshness p95 < 30s:** Real-time streaming with optimized network paths and edge-to-core routing

#### 🎯 Advanced Platform Features:

**Intelligent Data Correlation:** The platform doesn't just store different data types separately. It uses ML models to automatically correlate metrics spikes with log error patterns, trace bottlenecks with resource utilization, and business events with technical incidents. This creates a unified view where engineers can start with any signal and discover related context across all data types.

**Adaptive Cost Optimization:** The system continuously analyzes query patterns, data access frequencies, and business value to optimize storage tiers and retention policies. High-value, frequently-accessed data stays in hot storage, while automated ML models predict when data can be safely moved to cheaper cold storage without impacting user experience.

## 🏆 Master Summary Sheet — All 9 Design Prompts

| Prompt # | Design Challenge | Core SLOs / Targets | Key Components & Reliability Patterns | Unique Learning Hook |
| --- | --- | --- | --- | --- |
| **1** | Monitoring & Alerting Platform | p99 alert latency < 30s, 99.999% reliability | Multi-region ingestion, deduplication, multi-channel notification | "Reliability is a spec" — alert systems themselves have SLOs |
| **2** | Distributed Logging Pipeline | p99 ingest < 5s, 99.99% delivery | Sharded queues, backpressure, DLQ, cold-storage indexing | Cost–reliability trade-off, streaming backpressure logic |
| **3** | Distributed Cache (Global Scale) | p95 read < 10ms, p99 availability 99.99% | Sharding, consistent hashing, replication, TTL eviction | Balancing latency vs. consistency under failure |
| **4** | Global Incident Response System | p99 alert ≤ 30s, 5-nines reliability | Dedup, geo-failover, multi-channel escalation, ACK tracking | Human-in-the-loop reliability — the pager has an SLO |
| **5** | SLO Error Budget Tracker | < 1 min compute latency, 99.99% accuracy | Stream aggregation, burn-rate calculation, SLO config registry | Operationalizes SRE Book Chapter 4 — reliability math as service |
| **6** | Canary Deployment Controller | Rollback < 2 min, promotion accuracy > 99.9% | Progressive rollout, metrics-based decisioning, rollback journal | "Deployment = reliability event" — ML + SLO-based release safety |
| **7** | Distributed Task Queue | p95 enqueue→start < 2s, 99.999% delivery | Sharded brokers, retry + DLQ, idempotency keys | Classic "reliability vs throughput" design under concurrency |
| **8** | Anomaly Detection System (AI-Infused) | p95 detect latency < 2 min, FP ≤ 1% | Streaming ML inference, ensemble detection, feedback loop | Modern trend: ML reliability measured like any other service |
| **9** | Unified Global Monitoring Platform | 1B events/min ingestion, query p95 < 200ms, 99.99% availability | Global edge network, multi-tier storage, unified API, intelligent correlation | "Monitor the monitor" — planet-scale observability with adaptive cost optimization |

### 🎯 What This Section Accomplishes

Each prompt follows the 7-Step "Undefeatable Blueprint," blending:

-   **Architecture clarity** (SWE)
-   **Reliability reasoning** (SRE)
-   **Operational empathy** (Google production culture)

By the end of this section, you don't just know how to design systems — you know how to **think like a Google SRE**.

### 🚀 Key Interview Success Patterns

-   **Start with SLOs:** Every architectural decision must be justified by measurable reliability targets
-   **Design for failure:** Always consider what happens when components fail or scale 10x
-   **Operational ownership:** Include runbooks, chaos testing, and observability for the system itself
-   **Quantify trade-offs:** State specific numbers (latency, throughput, error rates) not just concepts
-   **Think in production:** Consider human factors, cost efficiency, and operational complexity
