---
title: "Google SRE L7: NALSD & Senior Design"
slug: /sre/sd-google-sre
sidebar_position: 3
sidebar_label: "Google SRE L7: NALSD & Senior Design"
description: "Google SRE L7: NALSD & Senior Design"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/sd-google-sre/sequence.svg" alt="How it works — sd-google-sre" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
Non-Abstract Large System Design (NALSD), the three design archetypes, Senior Staff curveballs, and the exact rubric Google SRE interviewers use to evaluate you.

Senior Staff SRE • L7 Interview Guide • NALSD Framework

[Home](/) [How Companies Handle Data](/docs/ddia/ddia-ch5) [Caching Strategies](/docs/ddia/ddia-ch6)

<a id="toc"></a>

## Table of Contents

1.  [What Makes L7 SRE Different](#sec-1)
2.  [The Three Design Archetypes](#sec-2)
    -   [A. Infrastructure & Management Systems](#sec-2a)
    -   [B. Scalable Consumer-Grade Services](#sec-2b)
    -   [C. NALSD (Non-Abstract Large System Design)](#sec-2c)
3.  [NALSD Deep Dive — From Diagram to Hardware](#sec-3)
4.  [Senior Staff Curveballs (L7 Questions)](#sec-4)
5.  [The Evaluation Rubric — How They Score You](#sec-5)
6.  [Deep Dive: Global Metrics Pipeline](#sec-6)
7.  [Deep Dive: Feature Flag / Config Push Service](#sec-7)
8.  [Deep Dive: Retry Storm Prevention](#sec-8)

<a id="sec-1"></a>

Section 1

## What Makes L7 SRE Different L7SRE

A Senior Staff SRE (L7) interview is fundamentally different from a standard SWE system design. They don't want a "working architecture" — they want **NALSD thinking**: translate a design into real hardware, calculate costs, and discuss failure modes at global scale.

<img src="/diagrams/sd-google-sre/1.svg" alt="sd-google-sre diagram 1" class="doc-diagram" />

SWE interviews are abstract ("use a load balancer"). SRE L7 interviews are concrete ("how many machines, what's the cost, what breaks at 3am").

[↑ Back to Contents](#toc)

<a id="sec-2"></a>

Section 2

## The Three Design Archetypes GoogleSRE

#### A. Infrastructure Systems

Managing thousands of machines. The "plumbing."

**Examples:**  
• Global Metrics Pipeline  
• Feature Flag / Config Push  
• Job Scheduler (Borg-lite)

**Focus:** Cardinality, backpressure, blast radius, consistency

#### B. Consumer Services

Traditional SD questions through an SRE lens.

**Examples:**  
• Google Photos / Drive  
• Real-time Ad Bidding  
• Thumbnail Service

**Focus:** Erasure coding, latency SLIs, cache stampedes, CDN

#### C. NALSD

Non-Abstract. Calculate actual hardware.

**Examples:**  
• Log Processing (100TB/day)  
• "How many machines?"  
• "How much bandwidth?"

**Focus:** CPU, RAM, Disk I/O, Network — real numbers

### A. Infrastructure & Management Systems {#sec-2a}

| Problem | Key Challenges | What They're Testing |
| --- | --- | --- |
| **Global Metrics Pipeline** | Cardinality explosion (10M unique label combos), backpressure when downstream is slow, HA ingestion across 40+ DCs | Can you design for 10B data points/min without losing metrics during spikes? |
| **Feature Flag / Config Service** | Blast-radius control (bad config kills 1% not 100%), atomic rollback, eventual vs strong consistency | Can you push a config to 10M nodes in <60s AND roll back instantly? |
| **Job Scheduler (Borg-lite)** | Bin-packing (fit N tasks on M machines), priority preemption (kill batch jobs for serving), state machine replication | Can you reason about resource fragmentation and priority inversion? |

### B. Scalable Consumer-Grade Services {#sec-2b}

| Problem | Key Challenges | What They're Testing |
| --- | --- | --- |
| **Google Photos / Drive** | 11 nines of durability (99.999999999%), erasure coding, checksumming at rest, cross-region replication lag | Can you calculate storage costs and explain why erasure coding beats replication 3x? |
| **Real-time Ad Bidding** | Tight latency SLIs (<100ms p99), "soft" failure: serve default ad if auction slow, load shedding under spike | Can you design graceful degradation (never show blank, always show something)? |
| **Thumbnail Service** | Cache stampede (1M requests for same thumbnail on miss), hot-spotting (viral content), CDN invalidation | Can you prevent thundering herd and design multi-tier caching with CDN? |

### C. NALSD (Non-Abstract Large System Design) {#sec-2c}

#### This is what makes Google SRE unique. They give you concrete numbers and expect concrete answers.

```sql
EXAMPLE NALSD QUESTION:
"Design a system to parse 100TB of logs daily to detect fraud."

NOT ACCEPTABLE ANSWER:
"I'd use Kafka and Spark."

EXPECTED ANSWER:
"100TB/day = 100,000 GB / 86,400 sec = 1.16 GB/s sustained throughput.

CPU: Parsing + regex matching at ~200 MB/s per core.
     1,160 MB/s ÷ 200 MB/s = 6 cores minimum for parsing alone.
     With fraud model inference at ~50 MB/s per core: 24 cores.
     With 2x overhead for spikes: 48 cores → 3 machines (16-core each).

RAM: Each worker needs ~4GB for state + buffers.
     48 workers × 4GB = 192GB.
     3 machines × 64GB each = 192GB ✓

Disk: 100TB raw logs, compressed 5:1 = 20TB stored.
      Retention: 30 days = 600TB of compressed logs.
      SSD: too expensive. HDD at $0.03/GB = $18,000 for storage.
      24 HDDs × 25TB each across 4 storage nodes.

Network: 1.16 GB/s = ~10 Gbps sustained ingestion.
         Single rack: 2 × 25 Gbps uplinks = sufficient.
         Cross-rack for replication: 2 × 10 Gbps.

TOTAL: ~7 machines (3 compute + 4 storage), ~$5K/month.
       Scale to 3x for redundancy + spike handling = 21 machines."
```

[↑ Back to Contents](#toc)

<a id="sec-3"></a>

Section 3

## NALSD Deep Dive — From Diagram to Hardware SREL7

The NALSD framework: **start simple (1x), then scale to 10x, then 100x**. At each step, identify which component breaks first and fix it.

<img src="/diagrams/sd-google-sre/2.svg" alt="sd-google-sre diagram 2" class="doc-diagram" />

NALSD iterative design: start with 1x (what's the simplest thing that works?), identify what breaks at 10x, then solve for 100x. At each step, CALCULATE the machines needed.

#### The NALSD Calculation Cheat Sheet

```
QUICK REFERENCE FOR BACK-OF-ENVELOPE CALCULATIONS:

CPU:
  Modern server: 64-128 cores
  Simple request processing: ~10K-50K req/s per core
  Complex processing (ML inference): ~100-1K req/s per core

RAM:
  Modern server: 256-512 GB
  Per-connection state: ~10-50 KB
  Cache: 70-80% of RAM for hot data

Disk:
  SSD: 100K-500K IOPS, ~1 GB/s sequential, ~$0.10/GB
  HDD: 100-200 IOPS, ~200 MB/s sequential, ~$0.03/GB
  NVMe: 500K-1M IOPS, ~3 GB/s sequential, ~$0.15/GB

Network:
  Within rack: 25-100 Gbps
  Cross-rack: 10-40 Gbps
  Cross-DC: 1-10 Gbps (and ~50-150ms RTT)

Cost (cloud):
  Compute: ~$0.05/core-hour
  Storage: ~$0.02/GB-month (HDD), ~$0.10/GB-month (SSD)
  Network egress: ~$0.08/GB (cross-region)

NINES TO DOWNTIME:
  99%     → 3.65 days/year   (unacceptable for most services)
  99.9%   → 8.77 hours/year  (many internal services)
  99.95%  → 4.38 hours/year  (standard production)
  99.99%  → 52.6 min/year    (critical services)
  99.999% → 5.26 min/year    (payments, auth)
```

[↑ Back to Contents](#toc)

<a id="sec-4"></a>

Section 4

## Senior Staff Curveballs (L7 Questions) L7

At L7, they move past the diagram quickly and ask **strategic questions** that test operational maturity.

#### "If this system costs $10M/month at 99.99%, but we only need 99.9%, how would you re-architect to save 40%?"

```
ANSWER FRAMEWORK:

99.99% → 99.9% means we can tolerate 10x more downtime (52 min → 8.77 hrs/year).
This unlocks:

1. REDUCE REPLICAS: 5 replicas → 3 replicas per shard
   Saves: ~40% storage and compute for data tier
   Risk: tolerate 1 failure instead of 2. Acceptable at 99.9%.

2. SINGLE-REGION FOR WRITES: stop synchronous cross-DC replication
   Switch from Spanner (50-150ms cross-region writes) to
   single-leader + async replication (Espresso model, ~3ms writes)
   Saves: ~60% on cross-region network costs
   Risk: data loss window during DC failure. Acceptable at 99.9%.

3. RELAX SLO BUDGETS: allow longer failover time
   Instead of instant failover (expensive health checking, warm standby),
   allow 5-minute cold failover (cheaper standby capacity)
   Saves: ~30% on standby compute

4. USE SPOT/PREEMPTIBLE FOR BATCH: batch processing on spot instances
   Saves: ~70% on batch compute (which might be 30% of total cost)

TOTAL SAVINGS ESTIMATE:
  Data tier: -40% (fewer replicas) = save $1.5M
  Network: -60% (no sync cross-DC) = save $1M
  Standby: -30% (cold standby) = save $0.5M
  Batch: -70% (spot) = save $1M
  TOTAL: ~$4M/month saved = 40% of $10M ✓
```

#### "A massive BGP leak has isolated our Asia-Pacific regions. Walk me through automated traffic redirection and data consistency."

```
ANSWER FRAMEWORK:

DETECTION (0-30 seconds):
  1. Anycast health probes from each region → global health dashboard
  2. APAC probes failing → GSLB (Global Server Load Balancer) detects
  3. BGP monitoring system (RPKI, BGPStream) confirms route hijack

AUTOMATED RESPONSE (30-120 seconds):
  4. GSLB removes APAC endpoints from DNS/Anycast
  5. Users in APAC region are re-routed to nearest healthy region:
     - Japan/Korea → US-West
     - Australia → US-West
     - India → EU-West
  6. Traffic shift is gradual (canary 5% → 25% → 100%) to avoid
     overwhelming the receiving region

DATA CONSISTENCY CONCERNS:
  7. If APAC was a Raft follower → reads fail, redirected to leader (OK)
  8. If APAC had a Raft leader for some regions → election timeout (~300ms)
     → new leader elected in surviving DCs → writes resume
  9. If APAC had uncommitted writes → those writes are LOST
     (never reached majority). Client retries to new leader.
  10. If using Espresso (async replication) → APAC writes acknowledged
      but not yet replicated may be lost. CDC replay after recovery.

RECOVERY:
  11. BGP leak resolved → APAC routes restored
  12. APAC servers re-join Raft groups as followers
  13. Raft log replay catches them up to current state
  14. Gradual traffic shift back to APAC (canary again)
  15. Post-incident: check for data divergence, run reconciliation
```

#### "How do you handle a schema migration for a database with 100 billion rows without a single millisecond of downtime?"

```
ANSWER FRAMEWORK (the "expand-contract" pattern):

PHASE 1: EXPAND (add new column, keep old)
  ALTER TABLE users ADD COLUMN email_v2 VARCHAR(255);
  - Online DDL: most databases (PostgreSQL, Spanner, TiDB) do this
    without locking the table
  - MySQL: use gh-ost (GitHub) or pt-online-schema-change (Percona)
    which create a shadow table, copy in background, atomic swap

PHASE 2: DUAL-WRITE (write to both columns)
  Application code updated to write BOTH old and new column.
  Deploy with feature flag, canary 1% → 10% → 100%.
  Duration: hours to days, depending on confidence.

PHASE 3: BACKFILL (migrate existing data)
  Background job: scan 100B rows, copy old → new column.
  Rate-limited to avoid impacting production (e.g., 10K rows/sec).
  At 10K/sec: 100B rows = ~116 days. Too slow!
  Parallelize across shards: 256 shards × 10K/sec = 2.56M/sec → ~11 hours.
  Checkpoint progress for restartability.

PHASE 4: VERIFY
  Run checksums on old vs new column. Ensure 100% match.
  Shadow-read: serve from old column but validate against new.

PHASE 5: CONTRACT (switch reads to new, remove old)
  Update application to read from new column only.
  After validation period, DROP old column.
  Again, online DDL — no downtime.

KEY: Never do a "big bang" migration. Always expand-contract.
```

[↑ Back to Contents](#toc)

<a id="sec-5"></a>

Section 5

## The Evaluation Rubric — How They Score You Google

Google SRE interviewers use this mental checklist. You "pass" by hitting each of these during your explanation:

<img src="/diagrams/sd-google-sre/3.svg" alt="sd-google-sre diagram 3" class="doc-diagram" />

The 6-point rubric Google SRE interviewers use. Hit all 6 and you pass. Miss SLOs or failure planning and you likely fail regardless of how pretty your diagram is.

[↑ Back to Contents](#toc)

<a id="sec-6"></a>

Section 6

## Deep Dive: Global Metrics Pipeline GoogleSRE

#### "Design a system to collect and query metrics from every Google frontend worldwide."

```
SLOs:
  ✓ Ingest: 10B data points/min, <10s end-to-end latency
  ✓ Query: <2s for any dashboard query over last 24h
  ✓ Availability: 99.95% (metrics are critical for SRE)
  ✓ Retention: raw 30 days, downsampled 1 year, aggregated 5 years

ARCHITECTURE:

Frontends (40+ DCs)
  → Local agent (statsd/OpenTelemetry) batches metrics every 10s
  → Regional aggregator (pre-aggregates by label, reduces cardinality)
  → Kafka (regional) → Cross-region replication → Central Kafka
  → Stream processor (Flink/Samza): real-time alerting
  → Time-series DB (Gorilla/Monarch): recent data in memory
  → Cold storage (Bigtable/S3): downsampled, compressed

KEY CHALLENGES:

1. CARDINALITY EXPLOSION:
   If every metric has labels {host, endpoint, status, method, region}
   and there are 100K hosts × 1000 endpoints × 5 statuses × 4 methods × 40 regions
   = 80 BILLION unique time series. Can't store all of them.
   FIX: Pre-aggregate at the regional level. Drop high-cardinality labels.
        Adaptive sampling: keep 100% of errors, sample 1% of successes.

2. BACKPRESSURE:
   If the central ingestion pipeline is slow, regional buffers fill up.
   FIX: Kafka as buffer (retained for 24h). Regional agents drop
        oldest data first (newest is most valuable). Circuit breaker:
        if Kafka lag > 5min, alert on "metrics pipeline degraded."

3. QUERY FANOUT:
   "Show me p99 latency for all endpoints in the last hour"
   = query across 40 DCs, millions of time series.
   FIX: Pre-computed materialized views for common queries (top dashboards).
        Gorilla (Facebook's in-memory TSDB): recent 26 hours in RAM.
        Older data: downsampled to 1-minute resolution (from 10s).

NALSD: ~200 regional aggregators (5/DC × 40 DCs)
       ~50 Kafka brokers (central)
       ~100 Flink workers (stream processing)
       ~30 Gorilla/Monarch nodes (in-memory TSDB)
       ~20 Bigtable nodes (cold storage)
       TOTAL: ~400 machines. Cost: ~$500K/month.
```

[↑ Back to Contents](#toc)

<a id="sec-7"></a>

Section 7

## Deep Dive: Feature Flag / Config Push Google

#### "Design a system to push configuration changes to 10 million nodes in <60 seconds."

```
SLOs:
  ✓ Propagation: 95% of nodes updated within 60s, 99.9% within 5min
  ✓ Blast radius: bad config affects <1% of nodes before auto-rollback
  ✓ Rollback: <30s to revert any change globally
  ✓ Availability: 99.99% (config service down = can't deploy anything)

ARCHITECTURE:

Config Store (Spanner / etcd cluster)
  → Central config service (API: set, get, watch, rollback)
  → Regional relay servers (cache + fan-out, 1 per DC)
  → Node agents (long-poll or gRPC stream from regional relay)

PUSH MECHANISM:
  Option A: Long-poll (node polls every 30s, gets update on next poll)
    ✓ Simple, HTTP-compatible, works through proxies
    ✗ 30s average propagation delay

  Option B: gRPC streaming (server pushes to connected clients)
    ✓ Sub-second propagation
    ✗ 10M persistent connections = significant memory on relay servers
    10M connections × 10KB/conn = 100GB RAM just for connections
    → Need ~100 relay servers (1GB RAM each for connections)

  Option C: Hierarchical gossip (tree-shaped fan-out)
    Root → 100 L1 relays → 10K L2 relays → 10M nodes
    Each level fans out 100x. 3 levels = 100^3 = 1M nodes per tree.
    ✓ Minimal server load
    ✗ Complex, harder to guarantee ordering

BLAST RADIUS CONTROL:
  1. Canary: push to 0.1% of nodes (10K), wait 5 min, check error rates
  2. Gradual: 0.1% → 1% → 10% → 50% → 100%
  3. Auto-rollback: if error rate > threshold at any stage → revert
  4. Kill switch: any engineer can instant-revert to previous config
  5. Config versioning: every change is a new version, immutable

NALSD: 3 Spanner nodes (config store)
       5 central API servers
       100 regional relay servers (gRPC streaming)
       10M node agents (lightweight, runs on every server)
       Cost: ~$50K/month for the infrastructure (not counting node agents)
```

[↑ Back to Contents](#toc)

<a id="sec-8"></a>

Section 8

## Deep Dive: Retry Storm Prevention SREL7

This is the most common "systemic failure" question at Google SRE interviews.

<img src="/diagrams/sd-google-sre/4.svg" alt="sd-google-sre diagram 4" class="doc-diagram" />

A retry storm turns a small failure (1 server dies) into a global outage (30K req/s overwhelms everything). Five defenses: backoff+jitter, circuit breaker, load shedding, retry budgets, admission control.

[↑ Back to Contents](#toc)
