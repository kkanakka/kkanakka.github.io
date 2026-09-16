---
title: "SRE Mini Patterns"
slug: /sre/sre-mini-patterns
sidebar_position: 7
sidebar_label: "SRE Mini Patterns"
description: "SRE Mini Patterns"
---
Reliability Design Building Blocks — Google SRE Interview Essentials

Short-form, laser-focused reliability design exercises covering the breadth of building blocks Google expects candidates to know cold. Master these 14 patterns to demonstrate senior-level systems thinking in production incident scenarios.

Production Incidents

SLO-Driven Design

Senior SRE Signals

[Home](/) [Design Framework](/docs/foundations/sre-design-framework) [SRE Systems](/docs/sre/sre-sysdesign) [Cost Alerting](/docs/linkedin/linkedin-cost-aware-alerting)

## 📚 14 Essential Reliability Patterns

[

Pattern #1

Rate Limiting & Load Shedding

Protect critical paths by dropping low-priority traffic first during overload

](#pattern-1)[

Pattern #2

Dead-Letter Queue Recovery

Isolate poison pills to prevent head-of-line blocking in message processing

](#pattern-2)[

Pattern #3

Circuit Breakers & Timeouts

Fail fast to prevent cascading failures when dependencies misbehave

](#pattern-3)[

Pattern #4

Bulkhead Isolation

Partition resources so failure in one domain doesn't sink the ship

](#pattern-4)[

Pattern #5

Multi-Region Replication

Balance availability vs consistency using CAP theorem in practice

](#pattern-5)[

Pattern #6

Idempotent Job Scheduling

At-least-once delivery with replay-safe logic prevents data corruption

](#pattern-6)[

Pattern #7

Backpressure Signaling

Producer-consumer coordination to prevent queue overflow and crashes

](#pattern-7)[

Pattern #8

Distributed Lease Locks

Leader election with fencing tokens to prevent split-brain scenarios

](#pattern-8)[

Pattern #9

Cache Warming & Eviction

Balance staleness vs latency with smart eviction and stampede prevention

](#pattern-9)[

Pattern #10

Graceful Degradation

Progressive feature disablement to keep core functionality alive

](#pattern-10)[

Pattern #11

Control/Data Plane Separation

Stale-but-available beats fresh-but-down for serving continuity

](#pattern-11)[

Pattern #12

Error-Budget-Aware Automation

SLO-driven rollouts that respect burn rates, not just binary failures

](#pattern-12)[

Pattern #13

Chaos Engineering

Validate resilience through controlled failure injection and testing

](#pattern-13)[

Pattern #14

Observability-Driven Design

Three pillars (logs, metrics, traces) for diagnosing SLO violations

](#pattern-14)

<a id="pattern-1"></a>

Mini-Pattern #1

## Rate Limiting & Load Shedding

#### 🔥 The Production Incident

At 2 AM, a misconfigured partner service starts sending **10× normal request volume** to your payments API. Within minutes, latency for all users spikes, queues back up, and critical checkout requests start timing out. Analytics and logging traffic, sharing the same pathway, consume half the available capacity. What should have been an isolated partner misfire now threatens global availability.

#### 🎯 Key Parameters & Metrics

maxRequestsPerSecond: Global capacity cap

perClientQuota: Fair share enforcement per tenant

dropPolicy: Priority order (analytics → recommendations → checkout = never)

##### Critical SLIs to Track:

-   **p95/p99 request latency** — Primary user experience metric
-   **Error rate from throttled requests** — Measure dropped vs served
-   **% critical vs non-critical traffic preserved** — Load shedding effectiveness

#### 🧠 The Decision Framework

A senior SRE frames rate limiting with these questions:

-   **What is the reliability goal?** Protect user-facing critical paths (checkout) at all costs
-   **Who should be protected?** Should all clients be throttled equally, or do trusted/paid tenants get higher quota?
-   **How should limits adapt?** Static caps often fail; should you tie quotas to observed system load?
-   **What happens to dropped requests?** Are they logged, retried, or silently dropped?

#### 🔄 Failure Simulation (Before vs After)

##### ❌ BEFORE (No Rate Limiting)

-   Single client's flood consumes 80% of capacity
-   Critical API calls (checkout, login) see 30% errors
-   Error budget for entire quarter burned in one hour
-   SEV-1 global outage declared

##### ✅ AFTER (Smart Rate Limiting)

-   Rate limiter enforces per-client quotas
-   Excess requests from bad actor dropped first
-   Load shedding protects critical traffic (checkout)
-   Incident downgraded from SEV-1 to SEV-3

#### 🎯 The Senior SRE Signal: How to Talk About It

**"I'd introduce rate limiting not just to cap load, but as a load-shedding mechanism. That means protecting critical user journeys (checkout, login) while gracefully dropping lower-priority traffic like analytics. I'd track this with per-client quotas and dashboards showing the % of traffic preserved by priority class. The goal isn't just survival — it's preserving reliability where it matters most."**

##### 💡 Interview Power Phrases

-   "Load shedding is about surgical precision, not blunt rejection"
-   "Rate limits must be SLO-aware, not just throughput-aware"
-   "Drop analytics before you drop revenue-generating traffic"

<a id="pattern-2"></a>

Mini-Pattern #2

## Dead-Letter Queue (DLQ) Recovery

#### 🔥 The Production Incident

A tiny schema change slips into the payments producer: the `amount_cents` field moves from `int` to `string`. One malformed message lands on a hot partition. Your consumer tries to unmarshal, panics, restarts, immediately re-reads the same **poison pill**, panics again... repeat. The partition starves; valid payments queue behind the bad one, backpressure propagates upstream, and your "payments processed per minute" SLI craters.

#### 🎯 Key Parameters & Metrics

maxRetries: 3-5 tries before quarantining

retryBackoff: Exponential with jitter (base=200ms, factor=2.0, ±20%)

classificationRules: Deterministic predicates for retryable vs non-retryable

dlqTopic: Separate, isolated destination with 7-14 day retention + encryption

##### Critical SLIs to Track:

-   **dlq\_ingress\_rate** — Messages/min routed to DLQ
-   **dlq\_oldest\_message\_age** — Age of oldest unprocessed DLQ item
-   **main\_pipeline\_latency** — Prove DLQ protects primary flow
-   **reprocess\_success\_rate** — % of DLQ items successfully repaired

#### 🧠 The Decision Framework (Senior Engineer's Checklist)

1.  **Correctness vs. Latency:** Block until fixed, or quarantine and keep flowing?
2.  **Deterministic vs. Transient Failures:** Schema violations → DLQ fast; network blips → retry
3.  **Idempotency on Reprocess:** Can we safely re-insert without double-charging?
4.  **Isolation of Remediation:** Separate worker pool prevents noisy-neighbor effects
5.  **Order Guarantees:** Will DLQ detours affect business logic (updates before creates)?

#### 🔄 Failure Simulation (Before vs After)

##### ❌ BEFORE (No DLQ)

-   Poison message wedges hot partition
-   Consumer crash-loop → throughput collapses
-   Backpressure propagates; producers timeout
-   Several minutes of SLO burn; incident escalates

##### ✅ AFTER (With DLQ)

-   Consumer classifies error as non-retryable quickly
-   Message quarantined with full context
-   Main pipeline continues at full throughput
-   Separate DLQ-reprocessor handles remediation safely

#### 🎯 The Senior SRE Signal: How to Talk About It

**"I use a DLQ to protect availability of the primary pipeline. We classify errors deterministically; non-retryables are routed to a DLQ quickly to prevent head-of-line blocking. The DLQ is isolated (own topic, workers, and quotas) and observable — we track ingress and oldest-age as SLIs with a runbook SLA. Reprocessing is idempotent by design, using keys so we don't double-charge. This turns a single bad message from a SEV-1 into routine hygiene without user impact."**

##### 💡 Interview Power Phrases

-   "DLQ isolates poison pills so healthy traffic never stalls"
-   "We measure oldest-message age as the SLA for operational follow-up"
-   "Reprocessing runs in a separate worker pool with idempotency guarantees"
-   "Classification rules prevent infinite retry loops and alert on schema regressions"

#### ⚠️ Common Pitfalls to Avoid

-   **Same consumers read DLQ** — They'll crash again on the same poison pill
-   **No alerting on DLQ growth** — Silent failure mode, oldest age unbounded
-   **Re-injecting without idempotency** — Duplicates create financial/compliance risk
-   **Treating DLQ as trashcan** — Should be work queue with operational SLA

<a id="pattern-3"></a>

Mini-Pattern #3

## Circuit Breakers & Adaptive Timeouts

#### 🔥 The Production Incident

Your checkout service calls the payment processor API. One afternoon, the processor begins responding intermittently with **5s latency** instead of the usual 200ms. Your threads block, queues fill, and very quickly every call from checkout → payments is stuck waiting. The domino effect spreads: shopping cart updates, order confirmation, even inventory reservations all start timing out. Without a circuit breaker, you exhaust threads on cascading timeouts.

#### 🎯 Key Parameters & Metrics

timeout: Max wait per call (1-2× p99 latency of dependency)

failureThreshold: Fraction of recent calls to fail before trip (>50% in last 20)

cooldownPeriod: Time before allowing test retries (30s)

halfOpenRequests: Number of test calls during recovery validation

##### Critical SLIs to Track:

-   **dependency\_call\_latency** — p95/p99 to downstream service
-   **circuit\_open\_ratio** — % of time breaker is open (SLO metric)
-   **fallback\_success\_rate** — How often degraded logic succeeds
-   **timeout\_miss** — % requests exceeding breaker vs client timeout

#### 🧠 The Decision Framework

Senior SRE questions before adding a circuit breaker:

1.  **Static vs. Adaptive Timeout:** Use adaptive timeout based on rolling p99 of last 5 min
2.  **Fail Fast vs. Retry:** What's worse — dropping requests early, or retry storms?
3.  **Fallback Strategy:** Graceful degradation path?
    -   Checkout: queue order for manual retry
    -   Recommendations: return cached suggestions
    -   Analytics: drop low-priority events
4.  **Blast Radius:** Place breaker at edge of dependency, or upstream to prevent cascades?

#### 🔄 Failure Simulation (Before vs After)

##### ❌ BEFORE (No Breaker)

-   Dependency slows from 200ms → 5s
-   Threads exhaust waiting; upstream queues
-   Retries amplify load → both systems collapse
-   Full system outage in <10 minutes

##### ✅ AFTER (With Breaker)

-   Latency spike detected → breaker trips
-   New requests fail fast (<50ms) with graceful fallback
-   Dependency has time to recover
-   Half-open probes auto-heal when stable

#### 🎯 The Senior SRE Signal: How to Talk About It

**"I'd implement a client-side circuit breaker with adaptive timeouts to prevent cascading failures. The timeout must be shorter than the client's to fail fast and avoid wasted waiting. Once failure rate crosses a threshold, the breaker opens, routing calls to a fallback handler that provides degraded but acceptable service. We'd monitor circuit\_open\_ratio as an SLI and alert if it exceeds our error budget."**

##### 💡 Interview Power Phrases

-   "Breaker isolates failure, preventing retry storms and thread exhaustion"
-   "Timeouts should adapt to observed p99 latency, not be hardcoded"
-   "A half-open state is critical to verify recovery safely"
-   "Fallback logic must be safe and explicit, not silently skip critical business logic"

#### ⚠️ Common Pitfalls to Avoid

-   **Breaker timeout > client timeout** — Pointless, client will timeout first
-   **No fallback** — Breaker turns outage into instant failure without mitigation
-   **Silent bypasses** — Approving payment without processor check
-   **Forgetting jitter on cooldown** — Thundering herd when all instances probe together

<a id="pattern-4"></a>

Mini-Pattern #4

## Bulkhead Isolation (Preventing Cascading Failures)

#### 🔥 The Production Incident

Your multi-tenant service hosts both critical **checkout traffic** and background **analytics jobs** on the same thread pool. One day, analytics receives a sudden spike—millions of batch events from a partner's misconfigured ETL job. The threads saturate, queues balloon, and soon checkout requests are waiting behind analytics jobs. Your latency SLOs for checkout (p95 < 200ms) are obliterated, and customers can't purchase.

#### 🎯 Key Parameters & Metrics

Thread pool segmentation: Separate pools per service tier

Queue depth limits: Independent max sizes per partition

Resource quotas: CPU, memory, node pools by function

##### Critical SLIs to Track:

-   **checkout\_latency\_p95** — Must remain within 200ms under stress
-   **analytics\_queue\_depth** — Alert if backlog exceeds N messages
-   **bulkhead\_violation\_rate** — % requests denied due to partition exhaustion

#### 🧠 The Decision Framework

Before implementing bulkheads, senior SREs ask:

1.  **Which workloads can be co-located safely?** Latency-critical vs batch must be split
2.  **At what level to apply bulkheads?**
    -   Thread pools (per service process)
    -   Containers (per workload type)
    -   Entire clusters (prod-critical vs prod-noncritical)
3.  **What happens when partition exhausted?** Reject immediately, defer to DLQ, or graceful degradation?

#### 🔄 Failure Simulation (Before vs After)

##### ❌ BEFORE (Shared Resources)

-   Analytics job spikes consume all threads
-   Checkout requests pile up → timeout
-   Revenue-impacting outage declared
-   SLO violation cascades globally

##### ✅ AFTER (With Bulkheads)

-   Analytics threads saturate only their pool
-   Checkout pool remains isolated at normal SLO
-   Analytics queue depth alert fires
-   Revenue flow protected during partner issue

#### 🎯 The Senior SRE Signal: How to Talk About It

**"I'd enforce bulkhead isolation between latency-critical and best-effort workloads. For example, checkout would have a dedicated thread pool with strict queue depth limits. Even if analytics floods, checkout SLOs remain intact. We'd monitor per-partition queue depths and add alerting. Bulkheads act as blast radius limiters—they ensure that failure in one partition doesn't sink the entire service."**

##### 💡 Interview Power Phrases

-   "Bulkheads are about failure domain isolation"
-   "Protect revenue-critical workloads from best-effort ones"
-   "Apply at multiple layers: threads, containers, clusters"
-   "Queue limits must be explicit, or bulkheads silently fail"

#### ⚠️ Common Pitfalls to Avoid

-   **No fallback for rejected requests** — Bulkhead becomes a black hole
-   **Over-partitioning** — Wasted capacity due to unused pool quotas
-   **Silent bleed-over** — One service sneaks into another's pool via config drift
-   **No per-partition monitoring** — Leaves you blind to queue depth problems

<a id="pattern-5"></a>

Mini-Pattern #5

## Multi-Region Replication (CAP Theorem in Practice)

#### 🔥 The Production Incident

Google Photos experiences a regional datacenter outage in Europe. Users try to upload pictures, but replication is **synchronous across three regions**. The outage blocks consensus, causing writes to stall worldwide—uploads fail, and reliability SLOs are instantly violated. Alternatively, if replication were asynchronous, users could upload during the outage, but later some metadata updates might be missing. A user deletes a photo in Europe, but when they travel to the U.S., it still appears.

#### 🎯 Key Parameters & Metrics

Synchronous: Strong consistency - writes wait for all replicas

Asynchronous: Eventual consistency - local ack, replicas catch up

Quorum: Middle ground - majority acknowledgment (2 of 3)

##### Critical SLIs to Track:

-   **p95\_write\_latency** — < 100ms global target
-   **replication\_lag\_seconds** — < 5s for async mode
-   **data\_consistency\_error\_rate** — < 0.1% stale reads across regions

#### 🧠 The Decision Framework

A senior SRE frames the trade-offs by asking:

1.  **What's the user impact of stale data?** Bank balances must be consistent; profile photos can be eventual
2.  **How much availability is acceptable?** During outage: serve stale data (availability) or fail writes (consistency)?
3.  **How do we measure and enforce this?** Replication lag SLIs and error budgets must align with strategy

#### 🔄 Failure Simulation (Before vs After)

##### ❌ BEFORE (Synchronous-only)

-   Europe datacenter outage occurs
-   Global write traffic stalls waiting for consensus
-   write\_latency\_p95 spikes 80ms → 5s → timeouts
-   Global outage declared

##### ✅ AFTER (Quorum + Async Hybrid)

-   Europe datacenter outage occurs
-   Quorum of U.S. + Asia replicas accepts writes
-   Users continue uploading (availability preserved)
-   3s replication lag flagged; Europe catches up on recovery

#### 🎯 The Senior SRE Signal: How to Talk About It

**"I'd apply multi-region replication with quorum writes. This ensures global availability even during a regional outage while keeping replication lag bounded. For user-facing features where consistency is non-critical, we'd allow async reads. For critical features like billing, we'd enforce strong consistency. The system's error budget policy would explicitly define when async consistency is acceptable."**

##### 💡 Interview Power Phrases

-   "We choose replication strategy based on user promise defined in SLOs, not technology"
-   "Async replication buys availability at the cost of staleness"
-   "Quorum-based consensus is the middle ground"
-   "Every replication strategy must map to explicit SLOs and error budgets"

#### ⚠️ Common Pitfalls to Avoid

-   **Treating all data equally** — Not everything needs strong consistency
-   **No replication lag monitoring** — Async is useless without visibility
-   **Mixing critical/non-critical** — Don't use same replication mode for billing and photos
-   **Undefined "eventual"** — Must define what "eventual" means in measurable SLO terms

<a id="pattern-6"></a>

Mini-Pattern #6

## Idempotent Job Scheduling (At-Least-Once vs. Exactly-Once)

#### 🔥 The Production Incident

A global ad-serving system schedules jobs to bill advertisers for impressions. A transient network failure causes the scheduler to retry a billing event twice, and the advertiser gets **double-billed**. Outrage ensues. Conversely, imagine the job crashes mid-process and never retries—the advertiser isn't billed at all, costing millions in lost revenue. This is the classic distributed systems problem: you cannot guarantee "exactly-once" delivery in unreliable networks.

#### 🎯 Key Parameters & Metrics

At-least-once: Jobs may be retried; duplicates possible

At-most-once: Jobs may be lost; no duplicates

Exactly-once: The "holy grail" — theoretically impossible

Idempotency Keys: Unique identifier for each job request

Deduplication Store: Tracks processed keys

##### Critical SLIs to Track:

-   **duplicate\_job\_rate** — < 0.01% of total jobs
-   **missed\_job\_rate** — < 0.001% lost jobs
-   **processing\_latency\_p95** — < 100ms including dedup lookup

#### 🧠 The Decision Framework

When deciding how to schedule jobs, senior SREs ask:

1.  **What's the failure mode cost?** Double-billing unacceptable → must design for idempotency
2.  **How are jobs uniquely identified?** Without strong identifiers, retries = duplicates
3.  **Do retries introduce state corruption?** Jobs updating shared state require idempotency design

#### 🔄 Failure Simulation (Before vs After)

##### ❌ BEFORE (Non-Idempotent)

-   Job: "increment ad balance by $10"
-   Scheduler retries twice due to timeout
-   Advertiser charged $30 instead of $10
-   Outage-level customer impact

##### ✅ AFTER (Idempotent with Keys)

-   Job includes idempotency\_key=ABC123
-   Scheduler retries twice due to timeout
-   Deduplication layer sees ABC123 already processed
-   Advertiser charged correctly: $10

#### 🎯 The Senior SRE Signal: How to Talk About It

**"The correct strategy is to design every scheduled job as idempotent. That means instead of saying 'increment balance by $10,' the job says 'set balance to $current + $10, identified by idempotency\_key=ABC123.' The backend records processed keys in a deduplication store, ensuring retries don't corrupt state. This aligns with distributed system truth: at-least-once delivery with idempotent logic is the practical path to reliability."**

##### 💡 Interview Power Phrases

-   "True exactly-once is a myth; idempotency simulates it safely"
-   "Retries are inevitable; design your jobs so retries are harmless"
-   "Every job needs a unique key and replay-safe design"
-   "Error budgets often tolerate retries but not missed state updates"

#### ⚠️ Common Pitfalls to Avoid

-   **Claiming exactly-once delivery** — Immediate red flag for senior SREs
-   **No unique identifiers** — Without idempotency keys, retries corrupt data
-   **Ignoring latency trade-offs** — Deduplication adds cost; must measure impact
-   **Blanket idempotency** — Not every job requires it, only critical state updates

<a id="pattern-7"></a>

Mini-Pattern #7

## Backpressure Signaling (Producer–Consumer Coordination)

#### 🔥 The Production Incident

At Google Cloud Pub/Sub, a producer floods a topic with **1M messages per second**, but consumers can only process 200K/sec. Queues grow uncontrollably, memory spikes, and eventually consumers crash under OOM errors. In another variant: a backend gRPC service under traffic surge keeps accepting requests until its thread pool is exhausted. Latency explodes, SLOs breach, and the entire dependency chain collapses.

#### 🎯 Key Parameters & Metrics

Implicit Backpressure: Queue length, TCP window, resource saturation

Explicit Backpressure: HTTP 429, gRPC RESOURCE\_EXHAUSTED

##### Critical SLIs to Track:

-   **queue\_length\_p95** — Should remain < 80% capacity threshold
-   **request\_drop\_rate** — < 0.01% under traffic surge
-   **consumer\_latency\_p95** — < 200ms processing time

#### 🧠 The Decision Framework

When designing for backpressure, senior SREs ask:

1.  **What should the system do when overwhelmed?** Queue messages, shed low-priority load, or fail fast?
2.  **Is explicit feedback better than implicit?** Can producers adapt to consumer signals (429)?
3.  **How do we prevent cascading failures?** Can surge in one region kill global availability?

#### 🔄 Failure Simulation (Before vs After)

##### ❌ BEFORE (No Backpressure)

-   Producers overwhelm consumers with unbounded requests
-   Queue grows unbounded → memory spikes → crashes
-   Latency SLO breach → global outage

##### ✅ AFTER (Explicit + Implicit)

-   Consumers return 429 once queue > 80% capacity
-   Producers throttle or shed low-priority traffic
-   Consumer stays healthy, processes 200K/sec steady

#### 🎯 The Senior SRE Signal: How to Talk About It

**"I'd design for explicit backpressure — when a consumer queue exceeds a safe threshold, it returns HTTP 429 or gRPC RESOURCE\_EXHAUSTED. Producers must respect this signal and throttle. We'd complement with implicit signals (queue length, CPU utilization) to shed load gracefully. The goal isn't just keeping the consumer alive — it's protecting the system's overall reliability under surge."**

##### 💡 Interview Power Phrases

-   "Backpressure is about safe failure under overload"
-   "429 isn't an error; it's a reliability tool"
-   "You must prevent cascading failures across the dependency graph"
-   "Load shedding low-value traffic first is a senior-level move"

#### ⚠️ Common Pitfalls to Avoid

-   **Implicit backpressure only** — TCP queues alone are too opaque
-   **Not shedding load selectively** — Dropping critical before analytics = red flag
-   **No upstream propagation** — Backpressure must flow to the source
-   **Treating 429 as failure** — Actually a controlled reliability mechanism

<a id="pattern-8"></a>

Mini-Pattern #8

## Distributed Lease Locks (Leader Election & Split-Brain Prevention)

#### 🔥 The Production Incident

Consider Google Spanner or Borg cluster managers. Two nodes simultaneously believe they are the **primary leader** for scheduling jobs. Both issue commands to the same worker pool: one schedules batch jobs, the other schedules user-facing requests. The result? Conflicting writes, duplicate work, and potential data corruption. This is the split-brain problem: multiple nodes act as leaders due to network partitions, clock drift, or failed heartbeats.

#### 🎯 Key Parameters & Metrics

Lease Duration (TTL): How long leadership is valid (10s)

Renewal Interval: How often leader refreshes lease

Fencing Tokens: Monotonic version numbers prevent stale leaders

##### Critical SLIs to Track:

-   **leader\_election\_time\_p95** — < 2s during failover
-   **split\_brain\_incidents** — 0 tolerated
-   **availability\_during\_failover** — > 99.9%

#### 🎯 The Senior SRE Signal: How to Talk About It

**"Leader election isn't just about choosing a leader — it's about preventing split-brain scenarios. I'd implement lease-based locks with short TTLs and enforce fencing tokens so that even if an old leader comes back after a partition, its commands are rejected by workers that only honor the latest fencing token. This pattern ensures consistency, availability, and safety under failure."**

<a id="pattern-9"></a>

Mini-Pattern #9

## Cache Warming & Eviction (Staleness vs. Latency Trade-off)

#### 🔥 The Production Incident

A Google Search autocomplete service relies heavily on caching hot queries. Suddenly, the cache evicts too aggressively (using LRU), and every keystroke query hits the backend database. Latency spikes from **20ms → 500ms**, and global CPU usage on the DB tier jumps to 90%. SLOs breach in under a minute. In the opposite case, cache entries linger too long—a user changes their email, but the cache serves the old address for hours.

#### 🎯 The Senior SRE Signal: How to Talk About It

**"Caching isn't just about performance — it's a reliability strategy. I'd implement hybrid eviction (LFU+TTL) and enforce stale-while-revalidate so users see consistent performance while data refreshes. To prevent outages, we'd use pre-warming of hot keys and cache stampede protection. Every cache design must explicitly tie back to SLIs like hit ratio, latency, and staleness error rate."**

<a id="pattern-10"></a>

Mini-Pattern #10

## Graceful Degradation (Progressive Feature Disablement)

#### 🔥 The Production Incident

Picture YouTube during a sudden global surge (breaking news livestream). Traffic spikes **5× in under 10 minutes**. Without graceful degradation, the backend fails uniformly: watch pages don't load, thumbnails vanish, and the entire site goes down. Instead, with graceful degradation, YouTube can sacrifice non-critical features (recommendations, comments, HD streams) while keeping core video playback alive.

#### 🎯 The Senior SRE Signal: How to Talk About It

**"Graceful degradation is about failing safely. I'd design tiered services where Tier 1 features (core path) are isolated and protected. Using feature flags, we can progressively disable Tier 2 and Tier 3 features under surge, ensuring the site still delivers essential functionality. The goal is: better a degraded service than a dead service."**

<a id="pattern-11"></a>

Mini-Pattern #11

## Control Plane / Data Plane Separation

#### 🔥 The Production Incident

In 2019, a global cloud provider experienced a severe outage. The cause? A misconfiguration in the **control plane API** (where engineers pushed configs) propagated incorrectly and made the **data plane** (system serving live traffic) unavailable. A bug in the "admin portal" took down production serving for millions of users. This highlighted why control-plane failures must never compromise data-plane availability.

#### 🎯 The Senior SRE Signal: How to Talk About It

**"I would architect the system so that control-plane unavailability never impacts the data-plane. Config pushes would be versioned and cached locally by data-plane workers. If the control-plane goes down, the worst-case impact is config staleness, not service outage. This mirrors how systems like Envoy separate 'write configs' from 'serve requests.'"**

##### 💡 Killer Phrase

**"Stale-but-available is always better than fresh-but-down."**

<a id="pattern-12"></a>

Mini-Pattern #12

## Error-Budget-Aware Automation

#### 🔥 The Production Incident

A team launched automated canary deployment. It looked solid—rollouts were automated, failures triggered rollbacks. But the system was tuned only for hard failures (HTTP 500s). One night, a "non-fatal" latency regression (requests jumped from **100ms → 1s at p95**) shipped to prod. The service didn't fail, so automation didn't roll back. Within hours, the entire **weekly error budget** was burned, violating SLOs and triggering VP-level escalation.

#### 🎯 The Senior SRE Signal: How to Talk About It

**"At Google scale, the only definition of 'success' that matters is compliance with SLOs. Our automation must enforce error-budget policies. For example, I'd configure the canary controller to monitor not just failures, but also latency and burn rates. If we're projected to burn the weekly budget in less than 12 hours, the rollout pauses automatically. This ties release velocity directly to reliability."**

##### 💡 Killer Phrase

**"Velocity must be gated by SLO health, not by binary error counts."**

<a id="pattern-13"></a>

Mini-Pattern #13

## Chaos Engineering & Resilience Testing

#### 🔥 The Production Incident

Google had a service that was supposedly "highly available" with redundancy, failover, and retries. But during a regional outage, operators discovered the system failed cascadingly—timeouts stacked, retries amplified load, and the **failover logic was never actually tested at scale**. What looked perfect on paper turned into a 15-minute customer outage. The postmortem conclusion? The architecture was fine—the problem was untested assumptions.

#### 🎯 The Senior SRE Signal: How to Talk About It

**"Designing for resilience is only half the battle. A system that isn't tested for failure is unreliable by definition. I'd embed chaos engineering into the CI/CD cycle and operational calendar. Every Friday we run pod-kill experiments, and every quarter we simulate regional failover. The key is ensuring our SLIs are measured during chaos—availability, latency, error budget burn."**

##### 💡 Killer Phrase

**"Resilience is not a design property; it's a tested property."**

<a id="pattern-14"></a>

Mini-Pattern #14

## Observability-Driven Design (The Three Pillars)

#### 🔥 The Production Incident

A Google Ads service had intermittent 500 errors. The system had metrics showing CPU/memory were fine, logs with generic "request failed," and traces... well, **there were none**. Engineers couldn't pinpoint where requests died. Hours later, they discovered a downstream dependency was intermittently stalling, but client retries masked the issue. The service looked "healthy" in dashboards but was bleeding user trust.

#### 🎯 The Senior SRE Signal: How to Talk About It

**"Monitoring tells you when something breaks. Observability tells you why. At Google scale, I'd design every new service with observability-first principles: structured logs with correlation IDs, metrics exposed with cardinality control, and traces propagated through all RPCs. This ensures any SLO violation has a diagnosable root cause. Without this, you're blind in production."**

##### 💡 Killer Phrases

-   **"If you can't measure it, you can't SLO it."**
-   **"Observability is not an add-on — it's a design requirement."**

## 📊 How Google Scores System Design

At Google, system design interviews are graded on **how you think, prioritize, and communicate** — not "getting it right." Here's the internal rubric:

1\. Clarity of Problem Definition

**Weak (2/5):** Jumps into architecture without clarifying questions

**Strong (3/5):** Asks about scale and users, defines inputs/outputs

**Exceptional (5/5):** Frames around SLOs first (p99, 99.99%) like an SRE

2\. Handling Stressors & Failures

**Weak:** Doesn't consider failures until prompted

**Strong:** Mentions redundancy, retries, or replication

**Exceptional:** Proactively stress-tests design with real failure scenarios

3\. Production-Grade Architecture

**Weak:** Basic design with hand-wavy "make it scalable"

**Strong:** Adds multi-region, monitoring, rollback safety

**Exceptional:** Explains patterns (circuit breakers, DLQ, quorum)

4\. Communication & Trade-Offs

**Weak:** Talks only in features or buzzwords

**Strong:** Uses trade-off table (cost, complexity, reliability)

**Exceptional:** Explains business impact of trade-offs

5\. Operational Ownership

**Weak:** Designs system but doesn't consider rollout

**Strong:** Mentions canaries, config flags, monitoring

**Exceptional:** Speaks like owner: "1% canary, chaos tests, error budgets"

6\. Systems Thinking & Composability

**Weak:** Random components with no reasoning

**Strong:** Simple, functional baseline that works

**Exceptional:** Explains why each building block exists and composability

### 🎯 Key Success Signal

**If you consistently anchor answers in SLOs + trade-offs + operational thinking, you land in the Strong Hire category.**

Candidates at Google are scored across Clarity, Depth, Systems Thinking, Composure, and Prevention Mindset.
