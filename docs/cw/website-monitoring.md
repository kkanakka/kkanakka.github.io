---
title: "Website monitoring service: checks, outage detection and alerting"
slug: /cw/website-monitoring
sidebar_position: 3
sidebar_label: "Website monitoring service: checks, outa…"
description: "hard · multi-region quorum · false positives · check scheduling · alert storms · who watches the watcher"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/website-monitoring/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

## How it works

<header>
  
  <span class="tag">hard · multi-region quorum · false positives · check scheduling · alert storms · who watches the watcher</span>
</header>
<p>Customers register URLs; you check them from several regions, record uptime and latency, and page someone when a site goes down. The mechanics are simple — a scheduler, some workers, a time-series store. <b>The entire product is false-positive control.</b> A monitor that cries wolf gets muted, and a muted monitor is worth less than none, because it also carries the belief that someone is watching.</p>

<div class="trap"><b>The reframe that scores:</b> the hard question is never "did the check fail?" It is <b>"did the site fail, or did we?"</b> Your checker's network, DNS resolver, region, and TLS stack are all between you and the truth. Every serious mechanism here — multi-region quorum, consecutive failures, self-monitoring — exists to separate those two cases.</p></div>

## Requirements {#wm-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Register URLs with interval, expected status, timeout and alert destinations</li>
      <li>Check periodically from multiple regions; HTTP, TCP and DNS</li>
      <li>Detect outages and latency degradation; alert with low false positives</li>
      <li>Track uptime and latency history; public status pages</li>
      <li>Maintenance windows, and SSL certificate expiry warnings</li>
      <li class="out">Fixing the customer's site; synthetic browser journeys</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Checks fire on schedule regardless of how many customers are added</li>
      <li>A checker region failing must not page every customer</li>
      <li>Detection within ~2 check intervals; no alert storms</li>
      <li>Uptime figures must be defensible — customers bill against them</li>
      <li>The monitoring system must be monitored by something else</li>
    </ol>
  </div>
</div>

<div class="note"><b>Clarifying questions worth asking:</b> what check intervals — 10 s or 5 min? HTTP only, or TCP and DNS too? How many URLs and how many regions? Which alert channels, and do they need escalation? And the one that shapes the whole design: <b>how many consecutive failures, from how many regions, should trigger an alert?</b></div>

## Scale, performance and safety targets {#wm-targets}

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> 1M monitored URLs at a 60 s interval × 5 regions = <b>~83,000 checks/s</b>. That is the real number, and it is why the scheduler cannot be a cron loop over a table.</li>
    <li><b>Data volume:</b> one result per check ≈ 100 bytes → ~7 GB/day raw, and ~5M active time series (url × region × metric). <b>Cardinality is the scaling variable</b>, exactly as in a metrics platform.</li>
    <li><b>Growth:</b> URLs grow with customers, but cost grows with <em>URLs × regions × frequency</em>. A customer moving from 5 min to 10 s multiplies their load 30×, which is why interval is a billing dimension rather than a free setting.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> a check must fire within ±5 s of schedule (drift is indistinguishable from a gap in the data). Check timeout 10 s. <b>Failure to alert delivered within 60 s</b> of the quorum decision.</li>
    <li><b>Throughput:</b> ~83K checks/s across regions, but each checker is network-bound and mostly idle — a few hundred concurrent connections per worker, so this is an async-I/O problem, not a CPU one.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> you are a distributed HTTP client pointed at arbitrary URLs — that is an <b>SSRF and DDoS engine</b> if unguarded. Customers can register internal addresses to probe your network, point thousands of checks at a victim, or register a URL returning a 10 GB body.</li>
    <li><b>Rate limiting:</b> per-customer URL and frequency caps, per-target-host rate limits <em>across all customers</em>, response size caps, redirect depth limits, and blocking private/loopback address ranges after DNS resolution.</li>
    <li><b>Data sensitivity:</b> checks may carry auth headers or hit authenticated endpoints. Store credentials encrypted, never log response bodies, and <b>verify domain ownership before monitoring</b> — otherwise you are a free reconnaissance tool.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.95%. The stronger requirement is that a <b>partial failure must not look like a customer outage</b> — one region losing connectivity is the most common incident and must never page anyone.</li>
    <li><b>Degraded mode:</b> region down → excluded from quorum, alerting continues on the rest, and the gap is recorded rather than counted against uptime. Alerting pipeline down → a dead-man switch fires externally. Result store behind → keep checking and buffer; losing history is better than losing detection.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> eventual for results and dashboards. The exception is <b>alert state</b> — firing, acknowledged, resolved must be strongly consistent, or a failover re-pages everyone at 3am.</li>
    <li><b>Durability:</b> uptime history is billing-grade — customers hold SLAs against these numbers, so results are durable and the calculation must be reproducible and explainable months later.</li>
    <li><b>The recursive problem:</b> who monitors the monitor? An external dead-man switch and synthetic targets with known behaviour, because a monitoring platform that fails silently is the worst possible failure.</li></ul></div>
</div>

## Entities and API {#wm-api}

<p>Monitor (id, customerId, url, type, intervalSec, timeoutMs, expectedStatus, regions[], enabled) · Check (monitorId, region, ts, status, latencyMs, error, certExpiry) · MonitorState (monitorId, status UP|DOWN|DEGRADED, consecutiveFailures, since) · Incident (monitorId, startedAt, endedAt, regionsAffected) · AlertPolicy (channels[], threshold, escalation) · MaintenanceWindow (monitorId, from, to).</p>
<pre><code>POST /monitors  {url, type, intervalSec, expectedStatus, regions[], alertPolicy}  -&gt; monitorId
POST /monitors/:id/maintenance {from, to, reason}
GET  /monitors/:id/uptime?from=&amp;to=          -&gt; {uptimePct, incidents[], excludedWindows[]}
GET  /status/:slug                            -&gt; public status page (cached, separate failure domain)

Internal:
  scheduler -&gt; due(now)             # time-wheel / sorted set, not a table scan
  checker   -&gt; POST /results {monitorId, region, ts, status, latencyMs, certExpiry}
  evaluator -&gt; quorum(region results) + consecutive threshold -&gt; state transition -&gt; alert</code></pre>

## Design {#wm-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/website-monitoring/architecture.svg" alt="The hard question is never &quot;did the check fail&quot; but &quot;did the site fail, or did we&quot;. Quorum, consecutive thresholds and self-monitoring all exist to answer it." class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

### Flow between components

<ol class="order">
  <li><b>Customer → Config API:</b> register a URL, interval and alert destinations.
    Domain ownership is <b>verified before any checking starts</b> — a DNS TXT record or a file at a known path. Without this you are a free reconnaissance and DDoS tool that anyone can point at a victim.
    Interval is validated against the customer's plan, because interval is the cost dimension: 10 s versus 5 min is a 30× difference in everything downstream.</li>
  <li><b>Config API → Scheduler:</b> publish the monitor's schedule.
    The scheduler keeps due-times in a <b>sorted structure keyed by next-run</b> — a Redis sorted set or a time wheel — so "what is due now" is a range read, not a scan over a million rows.
    Each monitor's first run is <b>jittered within its interval</b>, so a million monitors created in a batch do not all fire on the same second forever after.</li>
  <li><b>Scheduler → Region queues:</b> dispatch one job per (monitor, region).
    Fan-out happens here: one monitor at 5 regions is 5 independent checks, and each region's workers pull only their own queue.
    Dispatch is at-least-once with a dedupe key of (monitor, region, scheduled_ts) — a duplicate check is harmless, a missed one is a gap in the data.</li>
  <li><b>Checker worker → Target:</b> perform the check with hard limits.
    Resolve DNS, then <b>validate the resolved IP</b> against private and loopback ranges — this is the SSRF gate, and it must happen after resolution because a public hostname can resolve to 127.0.0.1.
    Hard caps on timeout, response size and redirect depth, so one hostile target cannot consume a worker.
    Record latency broken down by phase — DNS, connect, TLS, first byte, total — because "slow" means different things and the phases point at different causes.</li>
  <li><b>Checker worker:</b> classify the outcome precisely.
    Not just up/down: <b>timeout, connection refused, DNS failure, TLS error, wrong status, body mismatch, slow-but-served</b> are different events with different meanings.
    Collapsing them to a boolean throws away exactly the information that separates "their site is down" from "our DNS resolver is broken" — which is the distinction the whole system exists to make.</li>
  <li><b>Checker worker → Result store:</b> write the result.
    Results go to a time-series store partitioned by monitor, with latency as a histogram rather than an average, so percentiles remain meaningful and re-aggregatable.
    Certificate expiry is captured on every TLS check, which gets cert monitoring for free rather than as a separate subsystem.</li>
  <li><b>Evaluator:</b> apply quorum across regions.
    <b>This is the false-positive gate.</b> One region failing is far more likely to be that region than the customer's site — so a monitor is DOWN only when a majority (or a configured k-of-n) of regions agree.
    Regions with known local problems are excluded from the vote rather than counted as failures, using the platform's own health signals.
    Single-region checking is the design that produces alerts nobody trusts.</li>
  <li><b>Evaluator:</b> apply the consecutive-failure threshold.
    Even with quorum, require N consecutive failed intervals before declaring DOWN. Two is a reasonable default: a single blip is noise, two in a row is a pattern.
    This trades <b>detection latency for precision</b> — at a 60 s interval, N=2 means up to ~2 minutes to alert — and that trade should be the customer's to make per monitor.</li>
  <li><b>Evaluator → Monitor state:</b> transition UP → DOWN, strongly consistent.
    The state transition is the thing that must not be duplicated or lost: two evaluators both deciding DOWN must produce <b>one</b> incident, not two pages.
    Recovery requires consecutive <em>successes</em> too, otherwise a flapping site produces an alert storm all by itself.</li>
  <li><b>Evaluator → Maintenance check:</b> suppress if in a window.
    Planned work is suppressed before alerting, and — importantly — <b>excluded from the uptime calculation</b> rather than counted as downtime, because customers bill against these numbers.
    Windows need a hard maximum duration, or someone opens one during an incident and forgets it for a month.</li>
  <li><b>Evaluator → Alerting:</b> deduplicate, group, then deliver.
    Deduplication means one incident yields one notification, not one per failed check.
    Grouping means a customer whose 400 monitors all fail gets <b>one</b> "400 monitors down, likely your origin" rather than 400 pages. That single behaviour is the difference between a product people keep and one they mute.
    Delivery is retried across channels with escalation, and every notification carries the evidence: which regions, which error, since when.</li>
  <li><b>Alerting → Customer:</b> notify with evidence, and later a resolution.
    A useful alert states what failed, from where, for how long, and the specific error — enough to start diagnosing without logging in.
    The resolution notification matters as much: an alert that never closes trains people to ignore the channel.</li>
  <li><b>Result store → Status page:</b> serve from a separate failure domain.
    A status page hosted on the same infrastructure as the thing it reports on is useless exactly when it is needed — it must be statically generated and served from a different provider, region and DNS zone.
    Uptime is computed from stored results with maintenance excluded, and the calculation is published so the number is defensible.</li>
  <li><b>Self-monitoring:</b> synthetic targets and a dead-man switch.
    Known-good and known-bad targets are checked continuously from every region: the known-bad <em>must</em> alert, and if it stops doing so, detection is broken even though every dashboard looks healthy.
    A dead-man heartbeat to an external, third-party service closes the last hole — <b>the one failure nothing internal can detect is the monitoring platform dying quietly.</b></li>
</ol>

## How it works, step by step {#wm-flow}

<ol class="order">
  <li>Customers register a URL after domain verification; interval is validated against their plan.</li>
  <li>A scheduler keyed by next-run time dispatches one job per (monitor, region), jittered so creation batches do not synchronise.</li>
  <li>Checkers resolve DNS, block private addresses, check with hard timeout and size caps, and classify the outcome precisely rather than as a boolean.</li>
  <li>Results land in a time-series store with per-phase latency histograms and certificate expiry.</li>
  <li>An evaluator applies multi-region quorum, then a consecutive-failure threshold, then maintenance suppression, then transitions state strongly consistently.</li>
  <li>Alerting deduplicates and groups — one incident, one notification; 400 monitors down is one page, not 400 — and delivers with evidence and escalation.</li>
  <li>Status pages are served from a separate failure domain; synthetic targets and an external dead-man switch monitor the monitor.</li>
</ol>

## Deep dives {#wm-deep}

<div class="cards">
  <div><h4>False positives are the product</h4><ul>
    <li><b>Multi-region quorum</b> — one region failing is usually that region, not the customer.</li>
    <li><b>N consecutive failures</b> — trades detection latency for precision, and should be per-monitor.</li>
    <li><b>Immediate retry from a different region</b> before declaring down; it costs one check and kills a whole class of blips.</li>
    <li><b>Classify failures precisely.</b> DNS failure from every region says something very different from a 503 from every region.</li>
    <li>A monitor that pages wrongly twice gets muted, and a muted monitor is worse than none — it also carries the false belief that someone is watching.</li></ul></div>
  <div><h4>Scheduling a million checks</h4><ul>
    <li>Due-times in a sorted set or time wheel; "what is due" is a range read, never a table scan.</li>
    <li><b>Jitter at creation</b>, or a bulk import makes every monitor fire on the same second forever.</li>
    <li>Fan-out to per-region queues; workers are network-bound, so hundreds of concurrent connections each and async I/O throughout.</li>
    <li>Dedupe on (monitor, region, scheduled_ts): a duplicate check is harmless, a missed one is a gap that looks like an outage.</li></ul></div>
  <div><h4>Who watches the watcher</h4><ul>
    <li><b>Synthetic known-bad targets</b> that must always alert — if they stop, detection is broken while everything looks green.</li>
    <li><b>Dead-man switch</b> to an external provider, because nothing internal can detect the platform dying quietly.</li>
    <li><b>Status page in a different failure domain</b> — different provider, region and DNS zone, statically generated.</li>
    <li><b>Absence alerts on check volume</b> per region: a region that stops reporting looks identical to a healthy quiet one.</li></ul></div>
</div>

## Trade-offs {#wm-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Outage decision</td><td>Multi-region quorum</td><td>Slower detection, and a region's worth of infrastructure</td><td>Single-region is cheap and produces alerts nobody believes — which makes the whole product worthless</td></tr>
  <tr><td>Sensitivity</td><td>N consecutive failures before alerting</td><td>Up to N intervals of detection latency</td><td>Alert on the first failure only where seconds genuinely matter and the customer accepts the noise</td></tr>
  <tr><td>Scheduling</td><td>Sorted next-run structure with jitter</td><td>A stateful scheduler to operate and shard</td><td>A cron loop over a table is simpler and collapses somewhere around tens of thousands of monitors</td></tr>
  <tr><td>Result storage</td><td>Time series with latency histograms</td><td>Storage, and rollups to manage</td><td>Storing averages is smaller and destroys percentiles, which are the only latency numbers that mean anything</td></tr>
  <tr><td>Alert grouping</td><td>Deduplicate and group by customer and correlation</td><td>An individual monitor's alert can be buried in a group</td><td>Per-monitor alerts are simpler and produce the 400-page storm that gets your product muted</td></tr>
  <tr><td>Maintenance windows</td><td>Suppress <em>and</em> exclude from uptime</td><td>Customers can game their own uptime figures</td><td>Counting maintenance as downtime is more honest and makes the feature useless, so cap window duration instead</td></tr>
  <tr><td>Status page</td><td>Separate provider and failure domain</td><td>A second deployment path to maintain</td><td>Hosting it with the main service is simpler and guarantees it is down exactly when it is needed</td></tr>
</tbody></table>

## Safety-first design {#wm-safety}

<div class="cards">
  <div><h4>You are a distributed HTTP client — treat yourself as a weapon</h4><ul>
    <li><b>Verify domain ownership</b> before checking, or you are free reconnaissance anyone can aim at a victim.</li>
    <li><b>Validate the resolved IP, not the hostname.</b> A public name can resolve to 127.0.0.1 — that is the SSRF path into your own network.</li>
    <li><b>Rate limit per target host across all customers</b>, so a popular site is not checked by you a thousand times a second.</li>
    <li><b>Hard caps everywhere</b> — timeout, response size, redirect depth — so one hostile target cannot tie up a worker.</li></ul></div>
  <div><h4>An alert nobody believes is worse than none</h4><ul>
    <li><b>Quorum before declaring down.</b> One region's bad day must never page a customer.</li>
    <li><b>Group aggressively.</b> 400 monitors failing is one incident with a likely common cause, not 400 notifications.</li>
    <li><b>Always send the resolution.</b> An alert that never closes trains people to ignore the channel.</li>
    <li><b>Carry the evidence</b> — which regions, which error, since when — so the alert starts the diagnosis instead of prompting a login.</li></ul></div>
  <div><h4>Numbers customers bill against</h4><ul>
    <li><b>Uptime must be reproducible.</b> Publish how it is calculated; it will be disputed, and "the dashboard said so" is not an answer.</li>
    <li><b>Exclude maintenance explicitly</b>, with a recorded reason and a hard cap on window length.</li>
    <li><b>Record your own gaps.</b> A region you failed to check is not customer downtime, and pretending otherwise is a false claim in your favour.</li>
    <li><b>Alert state strongly consistent</b>, so a failover does not re-page a whole customer base at 3am.</li></ul></div>
</div>

## Don't leave the room without saying {#wm-check}

<ul class="checklist">
  <li>The hard question is "did the site fail, or did we?" — everything else follows from it</li>
  <li>1M URLs × 5 regions ÷ 60 s ≈ 83K checks/s — do this arithmetic early</li>
  <li>Multi-region quorum plus N consecutive failures; retry from a different region first</li>
  <li>Classify failures precisely — DNS, TLS, timeout, wrong status are different events</li>
  <li>Sorted next-run scheduling with jitter at creation; never a table scan</li>
  <li>Validate the <em>resolved IP</em> — SSRF is the real security hole here</li>
  <li>Verify domain ownership, and rate limit per target host across all customers</li>
  <li>Deduplicate and group alerts; always send the resolution</li>
  <li>Uptime excludes maintenance and your own gaps, and the calculation is published</li>
  <li>Synthetic known-bad targets, an external dead-man switch, and a status page in a different failure domain</li>
</ul>

## What each level is expected to drive {#wm-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Cron-style scheduler, workers that curl the URL, store results, email on failure</td><td>False positives, multi-region, scheduling at scale</td></tr>
  <tr><td>Senior</td><td>Multi-region quorum, consecutive thresholds, sorted scheduling with jitter, precise failure classification, alert dedup and grouping, maintenance windows, time-series storage</td><td>SSRF, per-host rate limits, self-monitoring</td></tr>
  <tr><td>Staff+</td><td>False-positive control framed as the product, the "did we fail or did they" distinction driving every mechanism, uptime as a billing-grade defensible number, and the recursive problem of monitoring the monitor</td><td>—</td></tr>
</tbody></table>
