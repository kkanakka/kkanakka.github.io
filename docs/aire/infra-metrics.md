---
title: "Metrics monitoring at 10M points/sec"
slug: /aire/infra-metrics
sidebar_position: 35
sidebar_label: "Metrics monitoring at 10M points/sec"
description: "hard · cardinality · Gorilla · retention tiers · alerting failure domain"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/infra-metrics/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">hard · cardinality · Gorilla · retention tiers · alerting failure domain</span>
</header>

## Requirements {#infra-metrics-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Ingest metrics from every host and service fleet‑wide</li>
      <li>Query by label with percentiles over arbitrary windows</li>
      <li>Evaluate alert rules and page</li>
      <li>Retain history for months at lower resolution</li>
      <li class="out">Logs and traces pipelines</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>10M points/s sustained, 3× burst</li>
      <li>Query p95 &lt; 2 s over 24 h of a single series set</li>
      <li>Alerts must keep working when the query path or storage is degraded</li>
      <li>Series cardinality bounded per tenant</li>
    </ol>
  </div>
</div>


## Scale, performance and safety targets {#infra-metrics-targets}

<p>State these first, because the headline number is a decoy: 10M points/sec is easy, and cardinality is what actually decides whether this system stands up.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> 10M samples/s sustained with 3× burst headroom, arriving as batched writes from ~100K agents scraping every 15 s — so only a few hundred thousand HTTP requests/s, not 10M.</li>
    <li><b>Data volume:</b> ~50M active series is the number that matters; at ~1.4 bytes/point compressed that is ~14 MB/s, ~1.2 TB/day raw, ~2.4 TB for a 2‑day raw window. Query load is modest: thousands of dashboard and rule queries per second.</li>
    <li><b>Growth:</b> 2× annually in fleet size but cardinality grows superlinearly as teams add labels — assume 3× series growth per year and make per‑tenant budgets the thing that holds the line.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> ingest‑to‑queryable p99 &lt; 30 s; dashboard query p95 &lt; 2 s over 24 h of a single series set, p99 &lt; 10 s; alert evaluation every 15–60 s with p99 evaluation time well under the interval.</li>
    <li><b>Throughput:</b> sustain 10M points/s while compacting and serving queries concurrently — ingest must never be paused by compaction, and a heavy query must never stall ingest.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the attacker here is usually a colleague. A label containing a user id, a request path with parameters, or a retry loop emitting a fresh series per attempt is a cardinality explosion that can take down monitoring for everyone — precisely when it is most needed.</li>
    <li><b>Rate limiting:</b> per‑tenant active‑series budgets (e.g. 1M series per team) enforced at ingest, label allowlists per metric, a cap on samples/s per agent, and query limits on series touched and bytes scanned so one dashboard cannot exhaust the read path.</li>
    <li><b>Data sensitivity:</b> metrics should carry no PII — that is a design rule, not a hope, because label values are indexed, replicated and retained for months. Enforce it with allowlists; push high‑cardinality identifiers into exemplars and traces instead. Retention: 2 days raw, 30 days at 5 min, 13 months at 1 h.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.9% for ingest and query, but <b>alerting is held to a higher bar than the system it monitors</b> — it must keep working during exactly the incidents that degrade everything else.</li>
    <li><b>Degraded mode:</b> TSDB down → alert evaluators keep firing from their own independent store; compactor down → raw data accumulates and queries stay correct but slower; Kafka backed up → agents buffer locally and drop oldest, and an absence alert catches the gap. Dropping samples is acceptable; failing silently is not.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> eventual and best‑effort. Monitoring data is allowed to be slightly lossy and slightly late; a missing sample is a gap on a graph, not a corrupted record.</li>
    <li><b>Durability:</b> deliberately weak — a few seconds of samples may be lost on a node failure, and that is the right trade for ingest throughput. Alert <em>state</em> is the exception and must survive an evaluator restart so a firing alert does not silently reset.</li>
    <li><b>Compliance:</b> tenant isolation on both read and write paths, and a retention policy that actually deletes — months of label data is a real surface if PII ever leaks into it.</li></ul></div>
</div>

## Entities and API {#infra-metrics-api}

<p>Series (metric name + label set → seriesId) · Sample (ts, value) · Block (2 h chunk, compressed) · Rollup (5 m / 1 h aggregates incl. histogram buckets) · AlertRule · Tenant (series budget)</p>
<pre><code>Agent → ingest:  POST /write (protobuf batches, series id + samples)
Query:           GET /query?expr=histogram_quantile(0.95, rate(ttft_ms_bucket[5m]))&amp;start&amp;end&amp;step
Admin:           PUT /tenants/:id/limits {maxSeries, allowedLabels[metric]}
Alerting:        rules evaluated every 15–60 s against the evaluator’s own recent store; notify → pager</code></pre>

## Design {#infra-metrics-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/infra-metrics/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Metrics pipeline: agents scrape and pre-aggregate; ingestion enforces cardinality limits; Kafka; TSDB shards by series hash with Gorilla compression; retention tiers via downsampling; alert evaluators in a separate failure domain with their own recent-data store; absence alerts">
  <defs><marker id="t1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker></defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.tm{font-size:10.5px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#t1)}.pl{fill:none;stroke:#B45309;stroke-dasharray:6 4;rx:8}.pt{font-size:11px;font-weight:700;fill:#B45309}</style>
  <rect class="box" x="20" y="60" width="110" height="60"></rect><text class="tb" x="75" y="80" text-anchor="middle">Agents</text><text class="ts" x="75" y="96" text-anchor="middle">scrape 10–15 s</text><text class="ts" x="75" y="110" text-anchor="middle">pre‑aggregate locally</text>
  <rect class="box" x="160" y="50" width="150" height="80"></rect><text class="tb" x="235" y="70" text-anchor="middle">Ingest / cardinality</text><text class="ts" x="235" y="86" text-anchor="middle">label allowlist per metric</text><text class="ts" x="235" y="100" text-anchor="middle">series cap per tenant</text><text class="ts" x="235" y="114" text-anchor="middle">drop request_id/user_id labels</text><text class="ts" x="235" y="126" text-anchor="middle">hash → shard</text>
  <rect class="box" x="340" y="60" width="90" height="60" stroke="#B45309"></rect><text class="tb" x="385" y="85" text-anchor="middle">Kafka</text><text class="ts" x="385" y="102" text-anchor="middle">buffer, replay</text>
  <rect class="box" x="460" y="30" width="200" height="120"></rect><text class="tb" x="560" y="50" text-anchor="middle">TSDB shards (by series hash)</text>
  <text class="ts" x="470" y="68">in‑memory head block, 2 h</text><text class="ts" x="470" y="82">Gorilla: delta‑of‑delta timestamps,</text><text class="ts" x="470" y="96">XOR floats → ~1.4 B/point</text><text class="ts" x="470" y="110">10M pts/s ≈ 14 MB/s ≈ 1.2 TB/day raw</text><text class="ts" x="470" y="124">inverted index label → series ids</text><text class="ts" x="470" y="140">replicas ×2, query fan‑out + merge</text>
  <rect class="box" x="690" y="30" width="270" height="120"></rect><text class="tb" x="700" y="50">Retention tiers</text>
  <text class="tm" x="700" y="68">raw 15 s      → 2 days   (SSD)</text><text class="tm" x="700" y="84">5 m rollups   → 30 days  (SSD)</text><text class="tm" x="700" y="100">1 h rollups   → 13 months (object store)</text>
  <text class="ts" x="700" y="120">rollups keep min/max/sum/count + histogram</text><text class="ts" x="700" y="134">buckets so p95 survives downsampling</text>
  <rect class="pl" x="460" y="170" width="500" height="100"></rect><text class="pt" x="470" y="188">SEPARATE FAILURE DOMAIN</text>
  <rect class="box" x="470" y="200" width="220" height="60"></rect><text class="tb" x="580" y="220" text-anchor="middle">Alert evaluators</text><text class="ts" x="580" y="236" text-anchor="middle">own 2 h store fed from Kafka</text><text class="ts" x="580" y="250" text-anchor="middle">evaluate rules every 15–60 s</text>
  <rect class="box" x="720" y="200" width="220" height="60"></rect><text class="tb" x="830" y="220" text-anchor="middle">Absence + heartbeat</text><text class="ts" x="830" y="236" text-anchor="middle">"no data for X in 5 min" fires</text><text class="ts" x="830" y="250" text-anchor="middle">dead‑man alert on the alerter itself</text>
  <path class="f" d="M130 90 L158 90"></path><path class="f" d="M310 90 L338 90"></path><path class="f" d="M430 90 L458 90"></path><path class="f" d="M660 90 L688 90"></path>
  <path class="f" d="M385 120 C 385 200, 430 230, 468 230"></path>
  <text class="ts" x="20" y="200">Cardinality is the whole game:</text><text class="ts" x="20" y="214">10M/s is fine; 100M series is not.</text><text class="ts" x="20" y="228">Series count drives memory and</text><text class="ts" x="20" y="242">index size, not points/sec.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 678" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Metrics pipeline flow">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="7" y="14" width="126" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Agent</text>
<line class="ln" x1="70" y1="48" x2="70" y2="658"></line>
<rect class="sb" x="147" y="14" width="126" height="34"></rect><text class="st" x="210" y="36" text-anchor="middle">Ingest</text>
<line class="ln" x1="210" y1="48" x2="210" y2="658"></line>
<rect class="sb" x="287" y="14" width="126" height="34"></rect><text class="st" x="350" y="36" text-anchor="middle">Kafka</text>
<line class="ln" x1="350" y1="48" x2="350" y2="658"></line>
<rect class="sb" x="427" y="14" width="126" height="34"></rect><text class="st" x="490" y="36" text-anchor="middle">TSDB shard</text>
<line class="ln" x1="490" y1="48" x2="490" y2="658"></line>
<rect class="sb" x="567" y="14" width="126" height="34"></rect><text class="st" x="630" y="36" text-anchor="middle">Compactor</text>
<line class="ln" x1="630" y1="48" x2="630" y2="658"></line>
<rect class="sb" x="707" y="14" width="126" height="34"></rect><text class="st" x="770" y="36" text-anchor="middle">Alert evaluator</text>
<line class="ln" x1="770" y1="48" x2="770" y2="658"></line>
<rect class="sb" x="847" y="14" width="126" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Pager</text>
<line class="ln" x1="910" y1="48" x2="910" y2="658"></line>
<rect class="nt" x="-19" y="67" width="177" height="22"></rect><text class="sl" x="70" y="82" text-anchor="middle">scrape 15 s, pre-aggregate</text>
<line class="a1" x1="78" y1="114" x2="202" y2="114"></line>
<text class="sl" x="140" y="108" text-anchor="middle">write batch</text>
<rect class="nt" x="109" y="135" width="202" height="22"></rect><text class="sl" x="210" y="150" text-anchor="middle">label allowlist, series budget</text>
<rect class="nt" x="106" y="169" width="208" height="22"></rect><text class="sl" x="210" y="184" text-anchor="middle">over budget → reject new series</text>
<rect class="nt" x="143" y="203" width="134" height="22"></rect><text class="sl" x="210" y="218" text-anchor="middle">hash series → shard</text>
<line class="a1" x1="218" y1="250" x2="342" y2="250"></line>
<text class="sl" x="280" y="244" text-anchor="middle">append</text>
<line class="a1" x1="482" y1="284" x2="358" y2="284"></line>
<text class="sl" x="420" y="278" text-anchor="middle">consume shard partition</text>
<rect class="nt" x="395" y="305" width="190" height="22"></rect><text class="sl" x="490" y="320" text-anchor="middle">head block, Gorilla compress</text>
<rect class="nt" x="411" y="339" width="159" height="22"></rect><text class="sl" x="490" y="354" text-anchor="middle">flush 2 h blocks to SSD</text>
<line class="a1" x1="622" y1="386" x2="498" y2="386"></line>
<text class="sl" x="560" y="380" text-anchor="middle">read raw</text>
<rect class="nt" x="529" y="407" width="202" height="22"></rect><text class="sl" x="630" y="422" text-anchor="middle">5 m / 1 h rollups + histograms</text>
<line class="a1" x1="622" y1="454" x2="498" y2="454"></line>
<text class="sl" x="560" y="448" text-anchor="middle">write rollups; expire raw after 2 d</text>
<line class="a1" x1="762" y1="488" x2="358" y2="488"></line>
<text class="sl" x="560" y="482" text-anchor="middle">consume independently</text>
<rect class="nt" x="684" y="509" width="171" height="22"></rect><text class="sl" x="770" y="524" text-anchor="middle">own 2 h store; eval rules</text>
<rect class="nt" x="688" y="543" width="165" height="22"></rect><text class="sl" x="770" y="558" text-anchor="middle">absence check per series</text>
<line class="a1" x1="778" y1="590" x2="902" y2="590"></line>
<text class="sl" x="840" y="584" text-anchor="middle">fire</text>
<line class="a3" x1="778" y1="624" x2="902" y2="624"></line>
<text class="sl" x="840" y="618" text-anchor="middle">heartbeat (dead-man)</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Agent → Ingest:</b> write batch.
    Agents scrape locally every 15 s and ship compressed protobuf batches, so 10M points/s becomes a manageable few hundred thousand requests/s.
    Batching is also what makes back‑pressure survivable: an agent that cannot deliver buffers locally and drops oldest rather than blocking the process it is monitoring.
    Where per‑instance detail is not needed, the agent pre‑aggregates before sending — the cheapest cardinality reduction is the one that never leaves the host.</li>
  <li><b>Ingest:</b> label allowlist, series budget.
    Every incoming series is checked against an allowlist of permitted label names for that metric, which is how a stray <code>user_id</code> or a parameterised URL path is caught at the door.
    This is the single most important control in the system: cardinality, not sample rate, is what kills a metrics platform.
    Enforcing at ingest rather than at query time means the damage is prevented, not merely observed later.</li>
  <li><b>Ingest:</b> over budget → reject new series.
    When a tenant exceeds its active‑series budget, new series are rejected while existing ones keep flowing — so a team that explodes its cardinality loses its new labels, not its existing dashboards.
    The rejection is reported back to the emitting team explicitly; a silent drop just produces a mysterious gap and an incident later.
    Rejecting rather than throttling is deliberate: the resource being protected is the index, and one tenant must never be able to degrade another's monitoring.</li>
  <li><b>Ingest:</b> hash series → shard.
    Series are hashed by their full label set so every sample of one series always lands on the same shard, which keeps a time range for a series contiguous and cheap to read.
    Sharding by series rather than by time means ingest scales horizontally and no shard becomes a hot "now" partition.</li>
  <li><b>Ingest → Kafka:</b> append.
    A durable log between ingest and storage decouples the two: TSDB shards can restart, compact or fall behind without agents noticing or samples being lost.
    It is also what makes multiple independent consumers possible — the property the alerting design depends on entirely.
    Partitions align with shards so ordering per series is preserved without any coordination.</li>
  <li><b>TSDB shard → Kafka:</b> consume shard partition.
    Each shard owns its partitions and tracks its own offset, so a restart resumes exactly where it left off rather than losing or duplicating a window.
    Consumption lag is a first‑class metric: it is the earliest signal that storage is falling behind ingest.</li>
  <li><b>TSDB shard:</b> head block, Gorilla compress.
    Recent samples live in an in‑memory head block, which is where almost all queries and every alert rule actually read from.
    Gorilla compression exploits the shape of the data: timestamps arrive at regular intervals so deltas‑of‑deltas are usually zero, and consecutive float values XOR to mostly shared bits.
    The result is ~1.37 bytes per point instead of 16 — a 10× reduction that is why 10M points/s fits on ordinary SSDs.</li>
  <li><b>TSDB shard:</b> flush 2 h blocks to SSD.
    Blocks are immutable once written, which makes them trivially cacheable, replicable and safe to compact in the background.
    Each block carries its own inverted index from label pairs to series ids, so a query narrows to matching series before touching any samples.
    Two hours is a balance: small enough to bound memory and recovery time, large enough that compression works and the index is amortised.</li>
  <li><b>Compactor → TSDB shard:</b> read raw.
    Compaction runs out of band so it never competes with the ingest path for the write lock.
    It reads immutable blocks only, which means it needs no coordination with the shard still accepting writes.</li>
  <li><b>Compactor:</b> 5 m / 1 h rollups + histograms.
    Rollups keep sum, count, min and max — not just an average — because an average of averages is wrong and a lost count makes rates uncomputable.
    Histogram buckets are preserved rather than pre‑computed percentiles, which is what lets <code>histogram_quantile(0.95, …)</code> still work on a 13‑month‑old window.
    This is the detail people miss: downsampling that discards buckets quietly destroys every percentile query over old data.</li>
  <li><b>Compactor → TSDB shard:</b> write rollups; expire raw after 2 d.
    Retention tiers make the cost curve flat: raw for 2 days for incident debugging, 5‑minute for a month, 1‑hour for a year.
    Expiry is dropping whole immutable blocks, so reclaiming space is a metadata operation rather than a compaction of live data.</li>
  <li><b>Alert evaluator → Kafka:</b> consume independently.
    This is the most important arrow in the diagram: evaluators read the log directly, as their own consumer group, and never go through the TSDB query path.
    Monitoring that depends on the system it monitors fails exactly when it is needed, and a shared query path means one bad dashboard query can delay every alert.
    Independent consumption costs a second copy of recent data and buys alerting that survives a storage outage.</li>
  <li><b>Alert evaluator:</b> own 2 h store; eval rules.
    A small local window is all rules need, so the evaluator's storage is simple, fast and entirely self‑contained.
    Rules are evaluated on rollups where the window allows it, so an hour‑long rule does not rescan raw samples every minute.
    Alert state — pending, firing, resolved — is persisted so a restart does not silently reset a firing alert or re‑page for one already acknowledged.</li>
  <li><b>Alert evaluator:</b> absence check per series.
    Threshold alerts only fire on data that arrives; the dangerous failures are the ones where data stops — an agent died, the pipeline stalled, a whole rack went dark.
    Absence rules invert the logic and alert on the gap, which is what catches a silent failure instead of a quiet dashboard.</li>
  <li><b>Alert evaluator → Pager:</b> fire.
    Notification is deliberately last and deliberately simple, with deduplication and grouping so one bad deploy produces one page and not four hundred.
    The pager is an external dependency on purpose: the last hop out of the failure domain should not be something this platform operates.</li>
  <li><b>Alert evaluator → Pager:</b> heartbeat (dead-man) (async).
    The evaluator continuously proves it is alive to an external service; if the heartbeat stops, that service pages.
    This closes the last hole — everything above detects problems in other systems, and only the dead‑man switch detects a total failure of the monitoring system itself.
    Without it, the worst outage in the system is also the quietest.</li>
</ol>

## How it works, step by step {#infra-metrics-flow}

<ol class="order">
  <li>Agents scrape every 15 s, pre‑aggregate per‑instance series where configured, batch and send.</li>
  <li>Ingest validates labels against allowlists, enforces per‑tenant series budgets (reject new series over budget), hashes the series to a shard, and writes to Kafka.</li>
  <li>TSDB shards consume, append to the in‑memory head block with Gorilla compression, flush 2‑hour blocks to SSD, maintain an inverted index label → series ids.</li>
  <li>Compactor builds 5 m and 1 h rollups keeping sum/count/min/max and histogram buckets; raw expires after 2 days, rollups per tier.</li>
  <li>Queries fan out to the shards owning the matching series, merge, and pick resolution by range.</li>
  <li>Alert evaluators consume Kafka independently into their own 2‑hour store and evaluate rules; absence rules and a dead‑man heartbeat cover silent failure.</li>
</ol>

## Deep dives {#infra-metrics-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/infra-metrics/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
  <div><h4>Cardinality control</h4><ul>
    <li>Reject or hash‑bucket unbounded labels (ids, paths with params). Enforce at ingest with per‑tenant series budgets; return 429‑style feedback to the emitting team.</li>
    <li>Pre‑aggregate on the agent (per‑pod → per‑service) for anything you don't need per instance.</li>
    <li>Exemplars carry the high‑cardinality detail (a trace id) without creating series.</li></ul></div>
  <div><h4>Storage math</h4><ul>
    <li>Gorilla: 96% of timestamps compress to 1 bit; XOR of consecutive floats mostly shares leading/trailing zeros → ~1.37 bytes/point.</li>
    <li>10M pts/s × 1.4 B ≈ 14 MB/s ≈ 1.2 TB/day; 2 days raw ≈ 2.4 TB across shards, trivially SSD.</li>
    <li>Downsample to rollups on a schedule; keep histogram buckets so percentile queries still work at coarse resolution.</li></ul></div>
  <div><h4>Alerting that survives outages</h4><ul>
    <li>Alert evaluators must not depend on the TSDB query path or the same Kafka consumers; they keep their own short window fed directly. If the TSDB is down, alerts still fire.</li>
    <li>Absence alerts catch the silent failure (agent died, pipeline stalled).</li>
    <li>Dead‑man switch: the alerter emits a heartbeat to an external pager; missing heartbeat pages.</li>
    <li>Evaluate on rollups where possible; rules over 1 h windows shouldn't scan raw.</li></ul></div>
</div>


## Trade-offs {#infra-metrics-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Cardinality policy</td><td>Reject new series over a tenant budget</td><td>Teams lose new labels mid‑incident, which is a painful moment to discover a budget</td><td>Never silently drop instead — a missing series looks identical to a healthy one, and that ambiguity causes worse incidents than a loud rejection</td></tr>
  <tr><td>Sharding key</td><td>Hash of the full series label set</td><td>A single enormous series cannot be split, and rebalancing means moving series</td><td>Shard by time only for append‑heavy archival use cases; here it would make "now" a hot partition for every query</td></tr>
  <tr><td>Alerting data path</td><td>Independent consumers with their own store</td><td>A second copy of recent data and a second system to operate</td><td>Never share the query path — alerting that depends on the TSDB goes blind during exactly the outages it exists to catch</td></tr>
  <tr><td>Retention</td><td>Tiered rollups that preserve histogram buckets</td><td>Storage and compaction cost, plus resolution loss on old data</td><td>Keep raw longer only if you routinely debug month‑old incidents at second resolution; drop buckets never — percentiles over old data die with them</td></tr>
  <tr><td>Durability</td><td>Best‑effort; a few seconds of samples may be lost</td><td>Exactness — you cannot bill or audit from these numbers</td><td>Use a durable, exactly‑once pipeline when metrics feed billing; for observability it is the wrong trade at 10M points/s</td></tr>
  <tr><td>High‑cardinality detail</td><td>Exemplars pointing at traces</td><td>An extra system to query when you need the specific request</td><td>Putting the identifier in a label is always tempting and always ends in a cardinality incident</td></tr>
  <tr><td>Pre‑aggregation</td><td>On the agent, before the network</td><td>Per‑instance detail is gone and cannot be recovered later</td><td>Keep per‑instance series for a small set of metrics where a single bad host matters; aggregate the long tail</td></tr>
</tbody></table>

## Safety-first design {#infra-metrics-safety}

<div class="cards">
  <div><h4>Monitoring must outlive what it monitors</h4><ul>
    <li><b>Separate failure domain for alerting.</b> Evaluators consume the log directly with their own storage, so a TSDB, compactor or query‑path outage does not blind the pager.</li>
    <li><b>Dead‑man switch.</b> A heartbeat to an external service means a total failure of this platform still pages someone — the one failure mode nothing internal can detect.</li>
    <li><b>Absence alerts as standard.</b> Rules on missing data catch dead agents and stalled pipelines; threshold rules alone are silent precisely when things stop.</li>
    <li><b>Alert state survives restarts.</b> Firing and acknowledged states are persisted, so a redeploy neither re‑pages nor silently forgets an active incident.</li></ul></div>
  <div><h4>One tenant must never blind another</h4><ul>
    <li><b>Series budgets at ingest.</b> Enforced per tenant before anything is indexed, so a cardinality explosion is contained to the team that caused it.</li>
    <li><b>Label allowlists.</b> Permitted label names are declared per metric, which stops user ids and parameterised paths from becoming millions of series.</li>
    <li><b>Query limits too.</b> Caps on series touched and bytes scanned mean one runaway dashboard cannot exhaust the read path for everyone else.</li>
    <li><b>Feedback, not silence.</b> Rejections are reported back to the emitting team with the offending metric named, so the fix happens upstream.</li></ul></div>
  <div><h4>Keep sensitive data out by construction</h4><ul>
    <li><b>Labels are indexed and kept for a year.</b> That makes them the worst place in the stack for anything identifying, so the allowlist enforces the rule rather than documenting it.</li>
    <li><b>Exemplars carry the detail.</b> A trace id attached to a sample gives the specific request without creating a series, keeping the sensitive identifier in the traces system where retention is short.</li>
    <li><b>Tenant isolation on read and write.</b> Queries are scoped to the caller's tenant, so cross‑tenant label values are never visible even when series names collide.</li>
    <li><b>Retention that deletes.</b> Tiers expire by dropping immutable blocks, so "we deleted it" is a fact about storage rather than a policy statement.</li></ul></div>
</div>

## Don't leave the room without saying {#infra-metrics-check}

<ul class="checklist">
  <li>Cardinality, not points/sec, is the scaling variable</li>
  <li>Gorilla ≈ 1.4 B/point → 10M/s ≈ 1.2 TB/day raw</li>
  <li>Retention tiers with histogram‑preserving rollups</li>
  <li>Shard by series hash; inverted index for labels</li>
  <li>Alert evaluators in a separate failure domain with their own data path</li>
  <li>Absence alerts and dead‑man switch</li>
  <li>Exemplars for high‑cardinality detail</li>
</ul>

## What each level is expected to drive {#infra-metrics-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Prometheus‑style scrape, TSDB, Grafana, threshold alerts</td><td>Sharding, cardinality limits</td></tr>
  <tr><td>Senior</td><td>Cardinality control, sharding, compression math, retention tiers, separated alerting</td><td>Exemplars, tenant budgets</td></tr>
  <tr><td>Staff+</td><td>Failure‑domain argument for alerting, capacity and cost model, query planning across tiers, organisational cardinality governance</td><td>—</td></tr>
</tbody></table>
