---
title: "Debug a p95 latency spike from 100 ms to 2 s"
slug: /aire/p95-debug
sidebar_position: 41
sidebar_label: "Debug a p95 latency spike from 100 ms to…"
description: "hard · Anthropic · bisect the stack · USE/RED · queueing · prioritize by measured cost"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/p95-debug/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

## How it works

<header>
  
  <span class="tag">hard · Anthropic · bisect the stack · USE/RED · queueing · prioritize by measured cost</span>
</header>
<p>p95 went from 100 ms to 2,000 ms. You are asked to find out why, build the monitoring that would have caught it sooner, and then decide what to fix first. It is a debugging question wearing a system‑design costume: the interviewer wants a method that converges, not a list of things that could be slow.</p>

## Requirements {#pd-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Localize the regression to a component, a dependency and a change</li>
      <li>Distinguish "everything got slower" from "a subset got much slower"</li>
      <li>Build detection that would have caught this within minutes</li>
      <li>Rank fixes by measured impact, not by intuition</li>
      <li class="out">Rewriting the service, capacity procurement</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Diagnosis without a maintenance window — the system stays live</li>
      <li>Instrumentation overhead &lt; 1% of request latency</li>
      <li>Every conclusion supported by a measurement, not a hypothesis</li>
      <li>Mitigation available before root cause is understood</li>
    </ol>
  </div>
</div>
<div class="trap"><b>The most common wrong move:</b> reaching for a profiler first. A 20× p95 regression with a normal p50 is almost never CPU inside the service — it is queueing, a dependency, a lock, or a subset of traffic that changed shape. Look at the <em>distribution</em> before looking at the code.</div>

## Scale, performance and safety targets {#pd-targets}

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> assume ~50K QPS across a few hundred instances, so p95 is 2,500 slow requests per second — large enough to be statistically solid and small enough that a subset, not the whole, may be affected.</li>
    <li><b>Data volume:</b> at 100% ledger records and 5% traces, one hour of incident data is ~180M request records and ~9M traces — enough to slice by every dimension without sampling bias.</li>
    <li><b>Growth:</b> a regression that scales with traffic behaves completely differently from one that scales with data size; comparing the spike's shape against the traffic curve is one of the first useful signals.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> the target restored — p50 &lt; 50 ms, p95 &lt; 100 ms, p99 &lt; 200 ms. Interim: get p95 under 500 ms by mitigation while root cause work continues.</li>
    <li><b>Throughput:</b> watch utilization against latency together. Queueing theory says wait time grows as 1/(1−ρ); going from 70% to 95% utilization multiplies queue delay roughly sixfold with no code change at all, which is exactly how a 100 ms p95 becomes 2 s.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> consider that the spike may be caused, not suffered. A scraper hitting expensive endpoints, one tenant's data growing until a query goes linear, or a retry storm amplifying its own trigger all present as a latency regression.</li>
    <li><b>Rate limiting:</b> per‑tenant limits are the fastest mitigation available while the cause is still unknown, and identifying the heaviest callers is usually the fastest route to the cause.</li>
    <li><b>Data sensitivity:</b> debugging tempts people to log request bodies. Add dimensions (tenant, endpoint, size bucket, version) rather than payloads, or the investigation quietly creates a new copy of customer data.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> the service is up — this is a latency incident, which is why it is harder. Nothing is failing loudly, so error‑rate alerts stay silent while users experience the product as broken.</li>
    <li><b>Degraded mode:</b> mitigate before diagnosing — shed the heaviest traffic, disable the newest feature flag, roll back the most recent deploy, or add capacity. Restoring the user experience first and understanding second is the right order, and it is worth saying so explicitly.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Method:</b> bisect the stack with per‑hop timings, then bisect the traffic by dimension. Each measurement should halve the search space; a step that cannot rule something out is a step worth skipping.</li>
    <li><b>Evidence:</b> every claim is a graph. "The database is slow" is a hypothesis; "database span p95 went 8 ms → 1,400 ms at 14:05 for tenant X only" is a finding.</li>
    <li><b>Detection:</b> the deliverable is not only a fix but the alert that would have fired — burn‑rate alerting on a latency SLO, sliced by the dimensions that mattered.</li></ul></div>
</div>

## Entities and API {#pd-api}

<p>RED metrics (Rate, Errors, Duration per endpoint) · USE metrics (Utilization, Saturation, Errors per resource) · LatencyLedger (per‑hop ms, 100% of requests) · Trace (sampled spans) · Dimension (tenant, endpoint, version, region, payload bucket) · ChangeLog (deploys, flags, config, schema).</p>
<pre><code>Per request:   x-latency-ledger: lb=2;auth=3;app=12;db=41;cache=1;ext=0;queue=? total=59
Histograms:    duration_ms{endpoint,tenant_tier,version,region,size_bucket}   (bounded label set)
Saturation:    queue_depth, thread_pool_active, db_pool_waiters, gc_pause_ms, disk_await_ms
Correlate:     GET /changes?from=13:30&amp;to=14:30  -&gt; deploys, flag flips, config pushes, schema migrations
Slice:         histogram_quantile(0.95, sum by (dimension) (rate(duration_ms_bucket[5m])))</code></pre>

## Design {#pd-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/p95-debug/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

### Flow between components

<ol class="order">
  <li><b>Alert → Responder:</b> p95 burn-rate alert fires.
    The alert is on error‑budget burn rather than a static threshold, so it fires on a real regression and stays quiet through ordinary noise.
    It arrives carrying the ledger breakdown and exemplar traces, so the first question — which hop — is already half answered before anyone opens a dashboard.</li>
  <li><b>Responder → Dashboards:</b> compare p50, p95, p99 — is the whole distribution moving?
    This single comparison splits the problem in two and is the correct first move.
    p50 flat with p95 and p99 exploding means a <em>subset</em> is affected — a tenant, an endpoint, a shard, a cold cache — and the shape points at queueing or a specific slow path.
    All percentiles moving together means something systemic: a dependency, a resource ceiling, or a deploy that slowed every request equally.</li>
  <li><b>Responder → Change log:</b> what changed at the inflection point?
    Most regressions are caused by a change, so correlating the exact inflection minute against deploys, flag flips, config pushes and schema migrations is the highest‑yield lookup available.
    A change that lines up exactly is not proof, but it makes the cheapest possible test available: revert it and watch.
    Absence of a change is informative too — it points toward growth, traffic shape, or a dependency outside your control.</li>
  <li><b>Responder → Latency ledger:</b> which hop grew? load balancer, app, database, cache, external.
    The per‑hop ledger turns "the service is slow" into "the database span went from 8 ms to 1,400 ms", which is a different and far more tractable problem.
    Bisecting the stack this way halves the search space in one query, which is why the ledger is recorded for 100% of requests rather than sampled.
    If the hops sum to far less than the total, the missing time is queueing before the work started — and that is a finding in itself, not a measurement gap.</li>
  <li><b>Responder → Metrics:</b> slice p95 by tenant, endpoint, version, region, payload size.
    Bisecting the <em>traffic</em> is the complement of bisecting the stack, and one of the two almost always localizes the problem immediately.
    A regression confined to one tenant points at their data or usage; one endpoint points at a code path; one version points at a partial rollout; one region points at infrastructure.
    This is why the label set is designed in advance — you cannot slice by a dimension you did not record, and an incident is a bad time to discover that.</li>
  <li><b>Responder → Saturation metrics:</b> utilization, queue depth, pool waiters, GC, disk await.
    Utilization plus latency together is what identifies queueing: at 70% utilization a spike adds milliseconds, at 95% the same spike adds seconds.
    Queue depth and connection‑pool waiters are leading indicators that rise before latency does, which makes them the best early‑warning signals in the whole system.
    A saturated resource explains a 20× p95 with no code change whatsoever, and this step is what rules it in or out.</li>
  <li><b>Responder → Traces:</b> pull exemplars from the slow bucket, not random samples.
    Exemplars link a slow histogram bucket directly to the traces that produced it, so you inspect actual slow requests rather than average ones.
    Sampling randomly at 5% and hoping to find the tail is how debugging sessions lose an hour.
    Ten slow traces side by side usually show the pattern immediately — the same span, the same dependency, the same tenant.</li>
  <li><b>Responder → Dependency:</b> confirm at the source — is it slow for everyone, or slow for us?
    A database that is slow only for your queries means your queries or your data changed; slow for every client means the database changed.
    This distinction decides whether the fix is yours or someone else's, and getting it wrong wastes the most time of any mistake in the process.</li>
  <li><b>Responder → Mitigation:</b> shed, flag off, roll back, or add capacity — before root cause.
    Restoring the user experience is the priority, and it does not require understanding. Roll back the correlated change, disable the new flag, rate‑limit the heaviest tenant, or add instances to drop utilization out of the queueing knee.
    Mitigation also acts as a test: if rolling back fixes it, the search space has collapsed to one change.
    Insisting on full root cause before mitigating is a common and expensive instinct to name and resist.</li>
  <li><b>Responder → Hypothesis:</b> state it so it can be falsified.
    "N+1 query introduced in v2.4.1, triggered only for tenants with more than 10K items, amplified by connection‑pool exhaustion" is testable.
    "The database is slow" is not, and an untestable hypothesis is how an investigation stalls.</li>
  <li><b>Responder → Verification:</b> test the hypothesis on one instance or one tenant.
    Change one thing, on a small blast radius, and watch the specific metric the hypothesis predicts will move.
    Changing several things at once restores service and destroys the information about which one mattered.</li>
  <li><b>Responder → Fix list:</b> rank by measured cost, not by how interesting the fix is.
    Attribute milliseconds of p95 to each contributing cause from the ledger, then rank fixes by milliseconds recovered per unit of effort.
    The 1,400 ms database span dominates a 40 ms serialization inefficiency by a factor of 35, and optimising the serialization first is a week that changes nothing users can perceive.
    Include "add capacity" as a candidate: if the system is in the queueing knee, more instances may buy more p95 than any code change.</li>
  <li><b>Responder → Monitoring:</b> add the alert that would have caught this.
    The deliverable is the detection gap closed: a burn‑rate alert on the latency SLO, sliced by the dimension that mattered, plus saturation alerts on the leading indicator.
    A per‑tenant or per‑endpoint alert is what turns "p95 is fine overall" into "tenant X is broken", which is usually the truth being averaged away.
    Absence alerts matter here too — a subset of traffic that stops reporting looks healthy to every percentile.</li>
  <li><b>Responder → Postmortem:</b> record the timeline, the detection gap and the fix ranking.
    The two questions worth answering are why it took as long as it did to detect, and why it took as long as it did to localize.
    Each answer becomes a dashboard, a label, or an alert — which is how the next incident of this shape takes minutes instead of hours.</li>
</ol>

## How it works, step by step {#pd-flow}

<ol class="order">
  <li>Compare p50 against p95 and p99 to decide whether the whole distribution moved or only a subset.</li>
  <li>Correlate the inflection point with the change log — deploys, flags, config, migrations — because most regressions are caused rather than spontaneous.</li>
  <li>Bisect the stack with the per‑hop latency ledger to find which hop grew, and check whether the hops sum to the total (missing time is queueing).</li>
  <li>Bisect the traffic by tenant, endpoint, version, region and payload size, using a label set designed in advance.</li>
  <li>Check saturation — utilization, queue depth, pool waiters, GC — because a 20× p95 with no code change is usually queueing.</li>
  <li>Pull exemplar traces from the slow bucket, confirm at the dependency, and mitigate before root cause is fully understood.</li>
  <li>Rank fixes by measured milliseconds recovered, then close the detection gap with the alert that would have fired.</li>
</ol>

## Deep dives {#pd-deep}

<div class="cards">
  <div><h4>Read the distribution first</h4><ul>
    <li><b>p50 flat, p95 exploding:</b> a subset is affected — one tenant, one endpoint, one shard, a cold cache, or a lock contended only sometimes.</li>
    <li><b>Everything shifted:</b> systemic — a dependency, a resource ceiling, or a deploy that slowed every request.</li>
    <li><b>Bimodal:</b> two populations, usually cache hit versus miss, or a fast path and a fallback that is being taken more often.</li>
    <li><b>Averages hide all of this.</b> A mean that looks "a bit worse" can be a quarter of users seeing two seconds.</li></ul></div>
  <div><h4>Queueing explains most 20× spikes</h4><ul>
    <li>Wait time grows like 1/(1−ρ). At ρ=0.7 a spike costs milliseconds; at ρ=0.95 the same spike costs seconds.</li>
    <li>So a 10% traffic increase, or a 10% slowdown per request, can produce a 20× latency change with no code change at all.</li>
    <li>Queue depth and pool waiters rise <em>before</em> latency does, which makes them the best early warning available.</li>
    <li>The fix is often capacity or concurrency limits rather than code — and that should be on the ranked fix list like anything else.</li></ul></div>
  <div><h4>Build the detection you wish you had</h4><ul>
    <li>Burn‑rate alerts on a latency SLO, with paired short and long windows, rather than a static p95 threshold.</li>
    <li>Sliced alerts per tenant and per endpoint, because an aggregate p95 averages away exactly the subset that is broken.</li>
    <li>Saturation alerts on the leading indicators, which fire before users feel anything.</li>
    <li>A 100% latency ledger plus sampled traces with exemplars — cheap, structured, and the difference between hours and minutes to localize.</li></ul></div>
</div>

## Trade-offs {#pd-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>First move</td><td>Read the distribution and the change log</td><td>The satisfaction of profiling immediately</td><td>Profile first only when p50 moved with everything else and no change correlates — a 20× p95 is rarely CPU in your own code</td></tr>
  <tr><td>Order of operations</td><td>Mitigate before root cause</td><td>Some diagnostic information is lost when the trigger is removed</td><td>Preserve the broken state only if you can do it on a small subset of traffic while users are served from healthy instances</td></tr>
  <tr><td>Instrumentation</td><td>100% ledger, 5% traces</td><td>Storage, and a label set that must be designed in advance</td><td>100% tracing costs far more and adds little once exemplars link buckets to traces</td></tr>
  <tr><td>Alerting</td><td>Burn rate on a latency SLO</td><td>Harder to explain than "page if p95 &gt; 500 ms"</td><td>Static thresholds are fine for a small service and either page constantly or miss slow burns at scale</td></tr>
  <tr><td>Slicing</td><td>A fixed, bounded label set</td><td>You cannot slice by a dimension nobody anticipated</td><td>Unbounded labels give total flexibility and cause the cardinality incident that takes monitoring down during the outage</td></tr>
  <tr><td>Fix ranking</td><td>By measured milliseconds recovered</td><td>Interesting refactors lose to boring index additions</td><td>Never rank by intuition: the 1,400 ms span dominates the 40 ms one by 35×, whatever your instincts say</td></tr>
  <tr><td>Capacity as a fix</td><td>Treated as a legitimate candidate</td><td>Cost, and it can mask a real inefficiency</td><td>When the system sits in the queueing knee, capacity buys more p95 per day of effort than any code change</td></tr>
</tbody></table>

## Safety-first design {#pd-safety}

<div class="cards">
  <div><h4>Restore first, understand second</h4><ul>
    <li><b>Mitigation does not require a cause.</b> Roll back the correlated change, flip the flag off, shed the heaviest tenant, or add capacity — users come before curiosity.</li>
    <li><b>Mitigation is also evidence.</b> If a rollback fixes it, the search space has collapsed to a single change.</li>
    <li><b>Change one thing at a time.</b> Fixing three things at once restores service and destroys the information about which one mattered.</li>
    <li><b>Small blast radius for tests.</b> Verify hypotheses on one instance or one tenant, not fleet‑wide.</li></ul></div>
  <div><h4>Consider that you may be the target</h4><ul>
    <li><b>Check who is calling.</b> A scraper on an expensive endpoint or a retry storm presents exactly like a performance regression.</li>
    <li><b>Retry storms amplify their own cause.</b> Clients retrying a slow endpoint multiply the load that made it slow; look for request rate rising with latency.</li>
    <li><b>One tenant's growth is everyone's problem.</b> A query that went linear as a single customer's data grew is a common and easily missed cause.</li>
    <li><b>Rate limits are the fastest mitigation.</b> They work before the cause is known and are trivially reversible.</li></ul></div>
  <div><h4>Debug without creating new problems</h4><ul>
    <li><b>Add dimensions, not payloads.</b> Tenant, endpoint and size bucket are enough; logging request bodies quietly creates a second copy of customer data.</li>
    <li><b>Keep labels bounded.</b> Adding a high‑cardinality label mid‑incident can take monitoring down exactly when it is needed most.</li>
    <li><b>Instrumentation under 1%.</b> Measurement that changes the latency it measures has stopped being measurement.</li>
    <li><b>Close the detection gap.</b> The postmortem deliverable is the alert that would have fired, not just the fix that was applied.</li></ul></div>
</div>

## Don't leave the room without saying {#pd-check}

<ul class="checklist">
  <li>Compare p50 vs p95 vs p99 first — subset or systemic decides everything after it</li>
  <li>Correlate the inflection point against deploys, flags, config and migrations</li>
  <li>Bisect the stack with a per‑hop ledger; missing time is queueing, and that is a finding</li>
  <li>Bisect traffic by tenant, endpoint, version, region, payload size</li>
  <li>1/(1−ρ): a 20× p95 with no code change is usually saturation</li>
  <li>Exemplars from the slow bucket, not random traces</li>
  <li>Mitigate before root cause; rank fixes by measured milliseconds, including capacity</li>
  <li>Deliver the alert that would have caught it, sliced by the dimension that mattered</li>
</ul>

## What each level is expected to drive {#pd-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Check dashboards and logs, look at recent deploys, profile the slow endpoint</td><td>Percentile shape, queueing, slicing by dimension</td></tr>
  <tr><td>Senior</td><td>Distribution analysis, change correlation, per‑hop bisection, saturation and the 1/(1−ρ) argument, exemplar traces, mitigate‑then‑diagnose</td><td>Burn‑rate alerting, label cardinality, fix ranking by measured cost</td></tr>
  <tr><td>Staff+</td><td>A method that halves the search space at every step, detection‑gap analysis in the postmortem, capacity as a ranked fix, organisational follow‑through on the monitoring built</td><td>—</td></tr>
</tbody></table>
