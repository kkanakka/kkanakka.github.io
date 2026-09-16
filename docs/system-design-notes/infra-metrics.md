---
title: "Metrics monitoring at 10M points/sec"
slug: /system-design-notes/infra-metrics
sidebar_position: 18
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
  <li><b>Agent → Ingest:</b> write batch</li>
  <li><b>Ingest:</b> label allowlist, series budget</li>
  <li><b>Ingest:</b> over budget → reject new series</li>
  <li><b>Ingest:</b> hash series → shard</li>
  <li><b>Ingest → Kafka:</b> append</li>
  <li><b>TSDB shard → Kafka:</b> consume shard partition</li>
  <li><b>TSDB shard:</b> head block, Gorilla compress</li>
  <li><b>TSDB shard:</b> flush 2 h blocks to SSD</li>
  <li><b>Compactor → TSDB shard:</b> read raw</li>
  <li><b>Compactor:</b> 5 m / 1 h rollups + histograms</li>
  <li><b>Compactor → TSDB shard:</b> write rollups; expire raw after 2 d</li>
  <li><b>Alert evaluator → Kafka:</b> consume independently</li>
  <li><b>Alert evaluator:</b> own 2 h store; eval rules</li>
  <li><b>Alert evaluator:</b> absence check per series</li>
  <li><b>Alert evaluator → Pager:</b> fire</li>
  <li><b>Alert evaluator → Pager:</b> heartbeat (dead-man) (async)</li>
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
