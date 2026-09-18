---
title: "Telemetry with metric‑name reconciliation"
slug: /aire/telemetry
sidebar_position: 16
sidebar_label: "Telemetry with metric‑name reconciliation"
description: "hard · Anthropic · ingest + store + query · metric identity · aliases with evidence · provenance and correction"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/telemetry/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">hard · Anthropic · ingest + store + query · metric identity · aliases with evidence · provenance and correction</span>
</header>
<p>Deployed clients emit metric observations; the platform stores them and serves analysis. The twist: older client versions emit the same intended metric under different names, not all clients can be upgraded, and a similar name is not proof of the same meaning. The design has to keep raw truth, resolve names through a governed registry, and be able to undo a wrong mapping without double counting.</p>

## What this problem actually is {#tl-what}

<p>Before any architecture, it is worth being concrete about the words in the question, because the whole design follows from what they mean.</p>

<div class="cards">
  <div><h4>"Deployed clients"</h4><ul>
    <li><b>Software you shipped that runs somewhere you do not control:</b> a mobile app on a million phones, an SDK embedded in customers' servers, an agent on VMs, a desktop app, an IoT device.</li>
    <li><b>The defining property is that you cannot upgrade them on demand.</b> Someone is still running the version you shipped eighteen months ago, and may never update. The prompt states this explicitly, and it is what rules out any solution involving a flag day.</li>
    <li><b>So every client version in the wild is a permanent part of the input.</b> Old names are not a migration to finish; they are traffic you will receive forever.</li></ul></div>
  <div><h4>"Metric observations"</h4><ul>
    <li><b>Numbers the client reports about itself</b> — not user data. Request latency, error counts, cache hit rate, upload duration, queue depth, tokens used, battery level.</li>
    <li><b>One observation looks like</b> <code>{name: "request_latency_ms", value: 143, ts: …, labels: {region: "us-east", endpoint: "/v1/chat"}}</code>.</li>
    <li><b>You collect them to answer "is the fleet healthy?"</b> — dashboards, alerts, capacity planning, and sometimes billing, which is why correctness matters more than it first appears.</li></ul></div>
  <div><h4>"Different naming variants"</h4><ul>
    <li><b>The same measurement, renamed across releases.</b> Instrumentation gets refactored, teams adopt a naming convention, someone fixes a typo — and each shipped version is stuck with whatever name it had.</li>
    <li><b>So one real quantity arrives under several strings at once,</b> from several client populations, all live simultaneously.</li>
    <li><b>And sometimes two similar names are <em>not</em> the same thing</b> — different units, different type, or measuring a different span. That ambiguity is the heart of the question.</li></ul></div>
</div>

### A concrete example {#tl-example}

<p>Your SDK measures how long a request takes. Over three years it shipped under three names, and all three client populations are live right now:</p>

<table>
  <tbody><tr><th>Client version</th><th>Metric name emitted</th><th>Type</th><th>Unit</th><th>Share of fleet</th></tr>
  <tr><td>v1.x (2023)</td><td><code>request_latency_ms</code></td><td>histogram</td><td>milliseconds</td><td>30%</td></tr>
  <tr><td>v2.x (2024)</td><td><code>http_request_duration_ms</code></td><td>histogram</td><td>milliseconds</td><td>45%</td></tr>
  <tr><td>v3.x (2025)</td><td><code>http.request.duration</code></td><td>histogram</td><td><b>seconds</b></td><td>25%</td></tr>
</tbody></table>

<p>Two failures are available, and they point in opposite directions:</p>

<ul>
  <li><b>Do not merge them</b> → the "request latency" dashboard shows only v3 clients. You are looking at a quarter of the fleet and nothing tells you so. An incident affecting v1 devices is invisible.</li>
  <li><b>Merge all three naively</b> → v3's <em>seconds</em> are averaged with v1 and v2's <em>milliseconds</em>. A p99 of 800 ms and a p99 of 0.8 s land in the same bucket 1000× apart, the percentile becomes meaningless, and the chart looks better than ever. Nothing errors.</li>
  <li><b>Correct</b> → v1 and v2 are a genuine alias pair and merge cleanly. v3 measures the same thing but in a different unit, so it merges <em>only</em> with a declared conversion. If it had also been a different type, or measured a different span, it would not merge at all.</li>
</ul>

<div class="trap"><b>The question in one sentence:</b> merge what is genuinely the same, refuse to merge what merely looks the same — for data arriving now <em>and</em> for the years of history already stored — and be able to undo a merge you later discover was wrong, without double counting and without losing the original.</div>

<p>Everything below follows from that: raw observations are kept untouched as the source of truth (so a wrong merge is reversible), names resolve to a stable identity through a registry that requires evidence and an owner's approval (so merges are deliberate), and every stored aggregate records the mapping version it was computed under (so a number that changes can be explained).</p>

## Requirements and clarifying questions {#tl-requirements}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Receive observations from many client versions, batched, with delay</li>
      <li>Store durably; expose raw observations and aggregates</li>
      <li>Query by metric, labels, time range; dashboards and ad‑hoc analysis</li>
      <li>Resolve naming variants to stable metric identities, for new and historical data</li>
      <li>Correct a mapping later found wrong, with audit trail</li>
      <li class="out">Alerting UI, tracing, logs</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional (ask, since none are given)</h4>
    <ol>
      <li>Volume: observations/s, cardinality, batch size, fan‑in from N clients</li>
      <li>Arrival delay: seconds vs hours (offline devices) → late‑data windows</li>
      <li>Query patterns: recent dashboards vs long historical scans</li>
      <li>Retention per tier; acceptable loss and duplication (at‑least‑once + dedupe assumed)</li>
      <li>Freshness of aggregates; correctness over speed for billing‑grade metrics</li>
    </ol>
  </div>
</div>
<div class="note"><b>Identity questions to ask first:</b> is a metric identified by name alone, or by (tenant/namespace, producer, name, type, unit, label schema)? Are units declared or implied? Can the same name mean different things in different namespaces? Who owns a metric and can approve an alias? The answers decide whether resolution keys on <code>(namespace, raw_name, client_version)</code>, which is the assumption below.</div>

### The questions to ask, and what to assume if nobody answers {#tl-questions}

<p>No scale is given in the prompt, so the first move is to ask — and the second is to state an assumption for each, because a design cannot be evaluated against adjectives. Every assumption below is written so the interviewer can correct it cheaply.</p>

<table>
  <tbody><tr><th>Question</th><th>Why it changes the design</th><th>Assume if unanswered</th></tr>
  <tr><td><b>Observation volume?</b> Observations/s, batch size, fan‑in from how many clients, and — far more important — how many <em>distinct series</em>.</td><td>Cardinality, not observation rate, decides whether this is one database or a sharded fleet. 5M observations/s over 20M series is a different system from 5M over 20K series.</td><td>5M observations/s from ~500K clients, ~20M active series, ~50K batched requests/s.</td></tr>
  <tr><td><b>Arrival delay?</b> Seconds, or hours from devices that were offline?</td><td>Sets the late‑arrival window, and therefore whether aggregates can ever be considered final or must always be re‑computable.</td><td>Minutes normally, up to 7 days from offline clients — so every aggregate is re‑computable and nothing is sealed.</td></tr>
  <tr><td><b>Query patterns?</b> Recent dashboards, long historical scans, or ad‑hoc exploration?</td><td>Decides rollup tiers and whether raw must be directly queryable or only a re‑derivation source.</td><td>90% of queries touch the last 24 h; a long tail scans months at coarse resolution; raw is queryable but rarely.</td></tr>
  <tr><td><b>Retention per tier?</b> How long raw, 5‑minute and hourly data must survive.</td><td>Raw retention is the hard constraint here: re‑deriving history after a bad mapping is only possible while raw still exists.</td><td>Raw 90 days (longer than usual, deliberately), 5‑minute 30 days, hourly 13 months.</td></tr>
  <tr><td><b>Acceptable loss and duplication?</b> Is this observability, or does anything bill from it?</td><td>Billing‑grade metrics force exactly‑once semantics and reconciliation; observability tolerates at‑least‑once with dedupe.</td><td>At‑least‑once with edge dedupe; ≤0.1% loss acceptable for observability, and any billing‑grade metric flagged and reconciled separately.</td></tr>
  <tr><td><b>Metric identity?</b> Name alone, or (namespace, producer, name, type, unit, label schema)?</td><td>This is the question the whole second half of the design rests on. Name‑only identity silently merges different metrics that happen to share a string.</td><td>Identity is an opaque <code>metric_id</code> with a declared type, unit, label schema and owning team; names are aliases pointing at it.</td></tr>
  <tr><td><b>Units declared or implied?</b> Does the client state milliseconds, or is it in the name?</td><td>A unit encoded only in a name is a unit nobody checks, and <code>ms</code> vs <code>s</code> is a 1000× error in an SLO.</td><td>Units are declared in the payload; when absent, the observation is quarantined rather than assumed.</td></tr>
  <tr><td><b>Who owns a metric?</b> Who may approve an alias, and can they approve their own?</td><td>Aliasing is a semantic judgement, not a string operation, so it needs an accountable human and a reviewer who is not the proposer.</td><td>Every <code>metric_id</code> has an owning team; aliases need owner approval, and proposers cannot approve their own.</td></tr>
  <tr><td><b>Can clients be upgraded?</b></td><td>Stated in the prompt: they cannot. So old names must keep working indefinitely, which rules out any design that requires a flag day.</td><td>Old client versions persist for years; aliases are permanent infrastructure, not a temporary migration step.</td></tr>
</tbody></table>


## Scale, performance and safety targets {#tl-targets}

<p>The page above says to <em>ask</em> for these. Here is a concrete set to propose if the interviewer leaves them open — stating numbers turns "it depends" into a design.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> 5M observations/s arriving as ~50K batched requests/s from ~500K clients. Query load is small by comparison — a few thousand dashboard and ad‑hoc queries per second.</li>
    <li><b>Data volume:</b> ~20M active series (the real scaling variable), ~1 KB per batched observation on the wire, ~600 GB/day raw compressed. Raw observations are retained far longer than usual here, because re‑derivation depends on them.</li>
    <li><b>Growth:</b> ~2× annually in clients, but naming variants grow with every shipped client version — so the alias registry grows monotonically and must be designed for thousands of mappings, not dozens.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> ingest ack p99 &lt; 200 ms (the client must not block on it); observation queryable p99 &lt; 60 s; dashboard query p95 &lt; 2 s; a re‑derivation backfill over 30 days of one metric completing within hours, not days.</li>
    <li><b>Throughput:</b> sustain 5M observations/s through resolution and both writes, while a backfill runs concurrently — the backfill must never be able to starve live ingest.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the distinctive risk is not an attacker but a wrong mapping: silently double‑counting a metric that feeds capacity planning or billing. Alongside that, a client version emitting unbounded label values is a cardinality explosion, and a compromised client key could forge observations for another tenant.</li>
    <li><b>Rate limiting:</b> per‑tenant observation and series budgets enforced at the edge, label allowlists per metric, per‑client batch size and rate caps, and a cap on how much of the historical range one backfill may rewrite at a time.</li>
    <li><b>Data sensitivity:</b> labels must carry no PII, enforced by allowlist rather than convention, because label values are indexed and retained for months. Tenant isolation applies on ingest, storage and query. Retention: raw ~90 days (longer than usual, to allow re‑derivation), rollups 13 months.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.9% for ingest — but clients buffer, so a short outage costs delay rather than data. Query availability matters more to users; the registry is on the resolution path and needs to be highly available or aggressively cached.</li>
    <li><b>Degraded mode:</b> registry unreachable → resolve from a cached mapping snapshot, and quarantine rather than guess. TSDB write failing → keep writing raw, because raw is what everything can be rebuilt from. Backfill falling behind → live ingest always wins; historical correction is allowed to take longer.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> at‑least‑once delivery with dedupe on (client_id, batch_id, seq); aggregates are eventually consistent and explicitly re‑computable, which is the property that makes late data and corrections tractable at all.</li>
    <li><b>Durability:</b> raw observations are the system of record and need eleven nines — every canonical series is a derived view that can be rebuilt, and that is the whole basis for reversible mappings.</li>
    <li><b>Compliance:</b> every mapping change is an audited event with evidence, approver and a validity range, and every query result carries provenance — which is what lets someone answer "why did this number change last Tuesday?".</li></ul></div>
</div>

## Entities and API {#tl-entities}

<p>Observation (raw: namespace, raw_name, client_version, labels, type, unit?, value, ts, ingest_ts, batch_id, seq) · MetricIdentity (metric_id, canonical_name, type, unit, label_schema, owner) · Alias mapping (namespace, raw_name, version_range, → metric_id, unit_conversion?, status, evidence, approved_by, valid_from/to, mapping_version) · Series (metric_id + labels) · Rollup · MappingChangeLog.</p>
<pre><code>POST /v1/metrics   {client_version, namespace, batch_id, observations:[{name, type, unit?, labels, value, ts, seq}]}  -&gt; 202 {accepted, rejected[]}
GET  /v1/query     ?metric=metric_id|canonical_name&amp;labels&amp;start&amp;end&amp;step&amp;resolve=aliases|raw   -&gt; series[] with provenance
GET  /v1/registry/metrics/:id            -&gt; identity, unit, type, aliases[], owner
POST /v1/registry/aliases  {namespace, raw_name, version_range, metric_id, evidence, unit_conversion?}   -&gt; PENDING (needs owner approval)
POST /v1/registry/aliases/:id/approve | /revoke {reason}
GET  /v1/registry/unresolved             -&gt; raw names seen with counts, sample labels, versions</code></pre>

## Design {#tl-diagram}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/telemetry/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 420" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Telemetry architecture: client SDK buffers and batches; ingest edge validates and appends to Kafka; resolver consults the metric registry to map scoped raw names to metric ids and writes both a raw observation store with provenance and a canonical time-series store; unresolved names are quarantined; query API expands aliases by time range; a backfill job re-derives canonical data from raw when a mapping changes; registry changes require owner approval and evidence">
  <defs><marker id="tm1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="tm2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.tm{font-size:10.5px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#tm1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#tm2);stroke-dasharray:2 4}.lbl{font-size:10.5px;fill:#1F4E9E}.lbla{font-size:10.5px;fill:#B45309}</style>
  <rect class="box" x="20" y="150" width="120" height="80"></rect><text class="tb" x="80" y="170" text-anchor="middle">Client SDK</text><text class="ts" x="80" y="188" text-anchor="middle">v1.2 … v4.0</text><text class="ts" x="80" y="202" text-anchor="middle">buffer, batch, backoff</text><text class="ts" x="80" y="216" text-anchor="middle">seq per batch</text>
  <rect class="box" x="170" y="150" width="130" height="80"></rect><text class="tb" x="235" y="170" text-anchor="middle">Ingest edge</text><text class="ts" x="235" y="188" text-anchor="middle">auth · schema · limits</text><text class="ts" x="235" y="202" text-anchor="middle">dedupe (client, batch, seq)</text><text class="ts" x="235" y="216" text-anchor="middle">202 fast, no resolution</text>
  <rect class="box" x="330" y="160" width="90" height="60" stroke="#B45309"></rect><text class="tb" x="375" y="185" text-anchor="middle">Kafka</text><text class="ts" x="375" y="203" text-anchor="middle">raw, replayable</text>
  <rect class="box" x="450" y="130" width="160" height="120"></rect><text class="tb" x="530" y="150" text-anchor="middle">Resolver / Processor</text><text class="ts" x="460" y="168">(namespace, raw_name,</text><text class="ts" x="460" y="182"> version) → metric_id</text><text class="ts" x="460" y="198">unit convert if declared</text><text class="ts" x="460" y="212">label normalize + cardinality cap</text><text class="ts" x="460" y="226">unresolved → quarantine</text><text class="ts" x="460" y="240">stamp mapping_version</text>
  <rect class="box" x="450" y="20" width="160" height="80" stroke="#0F766E"></rect><text class="tb" x="530" y="40" text-anchor="middle">Metric Registry</text><text class="ts" x="460" y="58">identities: type, unit, owner</text><text class="ts" x="460" y="72">aliases: scoped, versioned,</text><text class="ts" x="460" y="86">evidence, approval, valid range</text>
  <rect class="box" x="650" y="60" width="150" height="70" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="tb" x="725" y="80" text-anchor="middle">Raw store</text><text class="ts" x="725" y="98" text-anchor="middle">every observation as sent</text><text class="ts" x="725" y="112" text-anchor="middle">+ provenance; immutable</text>
  <rect class="box" x="650" y="160" width="150" height="70" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="725" y="180" text-anchor="middle">Canonical TSDB</text><text class="ts" x="725" y="198" text-anchor="middle">series by metric_id</text><text class="ts" x="725" y="212" text-anchor="middle">rollups; derived, rebuildable</text>
  <rect class="box" x="650" y="260" width="150" height="60"></rect><text class="tb" x="725" y="280" text-anchor="middle">Quarantine</text><text class="ts" x="725" y="298" text-anchor="middle">raw:&lt;name&gt; series, never</text><text class="ts" x="725" y="312" text-anchor="middle">merged; review queue</text>
  <rect class="box" x="840" y="130" width="120" height="100"></rect><text class="tb" x="900" y="150" text-anchor="middle">Query API</text><text class="ts" x="850" y="168">expand aliases by</text><text class="ts" x="850" y="182">time range</text><text class="ts" x="850" y="196">provenance flags</text><text class="ts" x="850" y="210">resolve=raw option</text>
  <rect class="box" x="450" y="300" width="160" height="60" stroke="#B45309"></rect><text class="tb" x="530" y="320" text-anchor="middle">Backfill / rewrite job</text><text class="ts" x="530" y="338" text-anchor="middle">raw → canonical for a range</text><text class="ts" x="530" y="352" text-anchor="middle">on mapping change</text>
  <rect class="box" x="170" y="300" width="130" height="60"></rect><text class="tb" x="235" y="320" text-anchor="middle">Owners / review</text><text class="ts" x="235" y="338" text-anchor="middle">propose, evidence,</text><text class="ts" x="235" y="352" text-anchor="middle">approve, revoke</text>
  <path class="f" d="M140 190 L168 190"></path><path class="f" d="M300 190 L328 190"></path><path class="f" d="M420 190 L448 190"></path>
  <path class="f" d="M530 130 L530 102"></path><text class="lbl" x="536" y="120">lookup</text>
  <path class="f" d="M610 165 L648 100"></path><text class="lbl" x="612" y="120">raw + prov</text>
  <path class="f" d="M610 195 L648 195"></path><text class="lbl" x="614" y="188">canonical</text>
  <path class="f" d="M610 230 L648 285"></path><text class="lbl" x="600" y="270">unresolved</text>
  <path class="f" d="M800 195 L838 185"></path><path class="f" d="M840 150 C 780 20, 640 10, 610 40" stroke-dasharray="4 3"></path><text class="lbl" x="700" y="24">alias expansion</text>
  <path class="fa" d="M300 330 L448 330"></path><text class="lbla" x="320" y="322">approve / revoke → registry</text>
  <path class="fa" d="M330 300 C 380 200, 420 60, 448 60"></path>
  <path class="fa" d="M650 95 C 630 250, 620 320, 610 330"></path><text class="lbla" x="640" y="240">read raw</text>
  <path class="fa" d="M610 310 C 640 260, 640 230, 650 226"></path><text class="lbla" x="620" y="255">rewrite</text>
  <text class="ts" x="20" y="400">Raw store is the system of record and is never rewritten. Canonical series are a derived view under a specific mapping_version, so a wrong alias is fixed by re‑deriving, not by guessing.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 712" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Telemetry ingestion, resolution and query flow">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="17" y="14" width="106" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Client SDK</text>
<line class="ln" x1="70" y1="48" x2="70" y2="692"></line>
<rect class="sb" x="137" y="14" width="106" height="34"></rect><text class="st" x="190" y="36" text-anchor="middle">Ingest edge</text>
<line class="ln" x1="190" y1="48" x2="190" y2="692"></line>
<rect class="sb" x="257" y="14" width="106" height="34"></rect><text class="st" x="310" y="36" text-anchor="middle">Kafka</text>
<line class="ln" x1="310" y1="48" x2="310" y2="692"></line>
<rect class="sb" x="377" y="14" width="106" height="34"></rect><text class="st" x="430" y="36" text-anchor="middle">Resolver/Processor</text>
<line class="ln" x1="430" y1="48" x2="430" y2="692"></line>
<rect class="sb" x="497" y="14" width="106" height="34"></rect><text class="st" x="550" y="36" text-anchor="middle">Registry</text>
<line class="ln" x1="550" y1="48" x2="550" y2="692"></line>
<rect class="sb" x="617" y="14" width="106" height="34"></rect><text class="st" x="670" y="36" text-anchor="middle">Raw store</text>
<line class="ln" x1="670" y1="48" x2="670" y2="692"></line>
<rect class="sb" x="737" y="14" width="106" height="34"></rect><text class="st" x="790" y="36" text-anchor="middle">TSDB</text>
<line class="ln" x1="790" y1="48" x2="790" y2="692"></line>
<rect class="sb" x="857" y="14" width="106" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Query API</text>
<line class="ln" x1="910" y1="48" x2="910" y2="692"></line>
<rect class="nt" x="-40" y="67" width="220" height="22"></rect><text class="sl" x="70" y="82" text-anchor="middle">buffer, batch, retry with backoff, drop policy</text>
<line class="a1" x1="78" y1="114" x2="182" y2="114"></line>
<text class="sl" x="130" y="108" text-anchor="middle">POST /v1/metrics (batch, client_version, namespace)</text>
<rect class="nt" x="80" y="135" width="220" height="22"></rect><text class="sl" x="190" y="150" text-anchor="middle">auth, schema validate, label limits, dedupe key</text>
<line class="a1" x1="198" y1="182" x2="302" y2="182"></line>
<text class="sl" x="250" y="176" text-anchor="middle">append raw batch</text>
<line class="a2" x1="182" y1="216" x2="78" y2="216"></line>
<text class="sl" x="130" y="210" text-anchor="middle">202 accepted</text>
<line class="a1" x1="422" y1="250" x2="318" y2="250"></line>
<text class="sl" x="370" y="244" text-anchor="middle">consume</text>
<line class="a1" x1="438" y1="284" x2="542" y2="284"></line>
<text class="sl" x="490" y="278" text-anchor="middle">lookup (namespace, raw_name, version) → metric_id</text>
<line class="a2" x1="542" y1="318" x2="438" y2="318"></line>
<text class="sl" x="490" y="312" text-anchor="middle">metric_id + unit + type | UNRESOLVED</text>
<line class="a1" x1="438" y1="352" x2="662" y2="352"></line>
<text class="sl" x="550" y="346" text-anchor="middle">write raw observation with provenance (raw_name, version, metric_id, mapping_version)</text>
<line class="a1" x1="438" y1="386" x2="782" y2="386"></line>
<text class="sl" x="610" y="380" text-anchor="middle">write to canonical metric_id series (labels normalized)</text>
<rect class="nt" x="320" y="407" width="220" height="22"></rect><text class="sl" x="430" y="422" text-anchor="middle">UNRESOLVED → quarantine series metric_id=raw:&lt;name&gt;</text>
<line class="a1" x1="902" y1="454" x2="558" y2="454"></line>
<text class="sl" x="730" y="448" text-anchor="middle">expand query: metric_id → include historical aliases by time range</text>
<line class="a1" x1="902" y1="488" x2="798" y2="488"></line>
<text class="sl" x="850" y="482" text-anchor="middle">query canonical + alias series</text>
<line class="a2" x1="798" y1="522" x2="902" y2="522"></line>
<text class="sl" x="850" y="516" text-anchor="middle">samples</text>
<rect class="nt" x="800" y="543" width="220" height="22"></rect><text class="sl" x="910" y="558" text-anchor="middle">merge with provenance; never sum an alias twice</text>
<line class="a3" x1="542" y1="590" x2="438" y2="590"></line>
<text class="sl" x="490" y="584" text-anchor="middle">mapping v2 approved</text>
<line class="a3" x1="438" y1="624" x2="662" y2="624"></line>
<text class="sl" x="550" y="618" text-anchor="middle">re-derive canonical from raw (backfill job)</text>
<line class="a3" x1="438" y1="658" x2="782" y2="658"></line>
<text class="sl" x="610" y="652" text-anchor="middle">rewrite affected range with new mapping_version</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Client SDK:</b> buffer, batch, retry with backoff, drop policy.
    The SDK buffers in bounded memory, batches by size or time, and retries with exponential backoff and jitter — so a platform outage costs delay, not data.
    The drop policy is explicit and measurable: on overflow, drop oldest and emit a <code>dropped_observations</code> counter, because silent loss is indistinguishable from a healthy quiet period.
    Both client event time and server ingest time are recorded, since offline devices make late arrival normal rather than exceptional.</li>
  <li><b>Client SDK → Ingest edge:</b> POST /v1/metrics (batch, client_version, namespace).
    <code>client_version</code> is the single most important field on the request: it is what later lets the same raw name mean different things in different releases.
    Namespace scopes identity, so two teams using the same metric name are not accidentally merged.</li>
  <li><b>Ingest edge:</b> auth, schema validate, label limits, dedupe key.
    Validation is strict and itemized — type, value shape, timestamp sanity — and rejections name the offending observation so the emitting team can fix it.
    Label allowlists and per‑tenant cardinality budgets are enforced here, because cardinality is the scaling variable and the only cheap place to stop an explosion is at the door.
    Dedupe on (client_id, batch_id, seq) through a short Redis window makes at‑least‑once delivery safe without demanding exactly‑once from the client.</li>
  <li><b>Ingest edge → Kafka:</b> append raw batch.
    The raw batch is durable before anything is interpreted, which is the foundation of the entire design: resolution is a derived step, not a gate.
    A log here also decouples ingest from resolution, so a registry problem slows derivation without dropping data.</li>
  <li><b>Ingest edge → Client SDK:</b> 202 accepted (response).
    Acknowledging after the durable append but before resolution keeps the client's round trip short and independent of downstream health.
    202 rather than 200 is honest: the data is accepted, not yet processed, and rejected items are itemized in the response.</li>
  <li><b>Resolver/Processor → Kafka:</b> consume.
    Resolution runs as an independent consumer, so it can be restarted, re‑run from an offset, or scaled up during a backfill without touching ingest.</li>
  <li><b>Resolver/Processor → Registry:</b> lookup (namespace, raw_name, version) → metric_id.
    Identity keys on the triple, not on the name — a similar name is not evidence of the same meaning, and version ranges are what make historical variants resolvable.
    The registry is cached aggressively in the resolver, since this lookup happens millions of times a second.</li>
  <li><b>Registry → Resolver/Processor:</b> metric_id + unit + type | UNRESOLVED (response).
    Unit comes back with the identity so a mapping can carry a conversion — merging milliseconds into a seconds series without converting is the classic silent corruption.
    UNRESOLVED is a first‑class answer, not an error: the system is explicitly designed to receive names it has never seen.</li>
  <li><b>Resolver/Processor → Raw store:</b> write raw observation with provenance (raw_name, version, metric_id, mapping_version).
    Raw is written <em>always</em>, exactly as received, and is the system of record.
    Provenance — which raw name, which client version, which mapping version produced this — is what makes a wrong mapping reversible instead of permanent.
    Without the raw store plus mapping_version, correcting a mapping would mean either double counting or losing history.</li>
  <li><b>Resolver/Processor → TSDB:</b> write to canonical metric_id series (labels normalized).
    The canonical series is a <em>derived view</em>, which is the key insight: it can be rewritten because it can be rebuilt.
    Label normalization happens here so dashboards query one consistent schema regardless of which client version produced the data.</li>
  <li><b>Resolver/Processor:</b> UNRESOLVED → quarantine series metric_id=raw:&lt;name&gt;.
    Unknown names are stored under a quarantine identity rather than dropped or guessed at — data is preserved, and nothing is silently merged into the wrong metric.
    Quarantined names surface in the registry's unresolved list with counts, sample labels and versions, which is exactly the evidence an owner needs to approve a mapping.
    Guessing here would be the worst possible behaviour: it corrupts a metric that people trust, invisibly.</li>
  <li><b>Query API → Registry:</b> expand query: metric_id → include historical aliases by time range.
    A query for a metric must cover every name it has ever been emitted under, but only within each alias's validity window.
    Time‑bounded expansion is what stops an alias approved last month from retroactively changing what a year‑old dashboard shows.</li>
  <li><b>Query API → TSDB:</b> query canonical + alias series.
    Series are fetched in parallel across the expanded identity set, which keeps a multi‑alias metric roughly as fast as a single one.</li>
  <li><b>TSDB → Query API:</b> samples (response).
    Samples arrive tagged with the series and mapping version that produced them, carrying provenance all the way to the merge step.</li>
  <li><b>Query API:</b> merge with provenance; never sum an alias twice.
    Deduplication on identity is essential: if a range was already re‑derived under the new mapping <em>and</em> the alias is also expanded, naive summation double counts it.
    Results carry provenance so a user can see which raw names and mapping versions contributed — the difference between a number and a number you can defend.
    This is where "correctness over speed" is actually paid for; it is the right trade for anything billing‑grade.</li>
  <li><b>Registry → Resolver/Processor:</b> mapping v2 approved (async).
    Mappings are proposed with evidence, approved by the metric's owner, and carry a validity range — governance is part of the data model, not a process around it.
    Approval bumps a mapping version, which is what makes the change identifiable in every downstream artifact.</li>
  <li><b>Resolver/Processor → Raw store:</b> re-derive canonical from raw (backfill job) (async).
    Correction re‑reads raw and recomputes the canonical series, rather than patching the existing aggregates in place.
    Re‑derivation from an immutable source is idempotent, so a backfill that fails halfway can simply be run again.
    Backfills are throttled and bounded so historical correction can never starve live ingest.</li>
  <li><b>Resolver/Processor → TSDB:</b> rewrite affected range with new mapping_version (async).
    Only the affected time range and identities are rewritten, stamped with the new mapping version so queries can tell old derivation from new.
    Every change is recorded in the mapping change log with reason and approver — so when a dashboard shifts, the answer to "why" is a query rather than an investigation.
    And because raw is untouched, a revoked mapping is simply another re‑derivation, not a recovery project.</li>
</ol>

## Part 1: ingest, store, query {#tl-part1}

<p>The path from a deployed client to a queryable number, with the reason for each hop. The shape is conventional — buffer, validate, durable log, derive, serve — but two choices are specific to this problem: <b>resolution happens after the durable log, never before it</b>, and <b>raw observations are the system of record while every aggregate is a derived view</b>. Those two together are what make the second half of the design possible at all.</p>

### 1. Client SDK — buffer, batch, and make loss measurable

<ul>
  <li><b>Bounded in‑memory buffer, then disk if allowed.</b> The SDK must never grow without limit and must never block the application it is measuring; a telemetry library that causes an outage has inverted its purpose.</li>
  <li><b>Batch by size or time, compress, and retry with exponential backoff and jitter.</b> Batching turns 5M observations/s into ~50K requests/s; jitter stops a fleet that was partitioned from reconnecting in lockstep and re‑creating the outage.</li>
  <li><b>On overflow, drop oldest and count the drop.</b> The <code>dropped_observations</code> counter is what converts silent loss into a measurable number. Silent loss is indistinguishable from "the system was quiet", which is the worst possible ambiguity in monitoring data.</li>
  <li><b>Send <code>client_version</code>, <code>namespace</code>, <code>batch_id</code> and a per‑batch <code>seq</code>.</b> <code>client_version</code> is the single most important field on the request: it is what later allows the same raw name to mean different things in different releases, which is exactly the problem to be solved.</li>
  <li><b>Carry both client event time and server ingest time.</b> Client clocks are wrong and sometimes move backwards; keeping both lets you bucket by event time while still detecting and bounding skew.</li>
</ul>

### 2. Ingest edge — validate, dedupe, and refuse what you cannot store

<ul>
  <li><b>Stateless and horizontally scaled.</b> Nothing here holds state beyond a short dedupe window, so the tier scales with request rate and can be restarted freely.</li>
  <li><b>Authenticate and validate strictly:</b> type ∈ counter/gauge/histogram, value shape matches the type, timestamp within a sane window, declared unit present. Rejections are itemized so the emitting team can fix the client — a silent drop just produces a mystery gap weeks later.</li>
  <li><b>Enforce label allowlists and per‑tenant series budgets here.</b> Cardinality is the scaling variable, and the door is the only cheap place to stop an explosion. Rejecting a new series while existing ones keep flowing means a team that explodes its cardinality loses its new labels, not its dashboards.</li>
  <li><b>Dedupe on <code>(client_id, batch_id, seq)</code></b> through a short Redis window, which makes at‑least‑once delivery from unreliable clients safe without demanding exactly‑once from them.</li>
  <li><b>Do <em>not</em> resolve names here.</b> Resolution needs the registry and must be replayable under a later mapping; doing it before the durable log would bake today's mapping into tomorrow's history irreversibly. This is the most important ordering decision in Part 1.</li>
  <li><b>Return 202, not 200.</b> The data is accepted and durable, not yet processed, and saying so honestly is what allows the acknowledgement to be fast.</li>
</ul>

### 3. Durable log — the commit point

<ul>
  <li><b>Append the raw batch to Kafka, partitioned by (namespace, raw name hash),</b> so all observations of one series are ordered without any global coordination.</li>
  <li><b>This is the commit point:</b> everything upstream is about getting data here safely, everything downstream is derived and rebuildable. Consumers can be restarted, scaled, or replayed from an offset without the clients ever noticing.</li>
  <li><b>It is also what makes multiple independent consumers possible</b> — resolution, raw archiving and backfill all read the same log without coordinating with each other.</li>
  <li><b>Backpressure is expressed here:</b> consumer lag and edge queue depth drive 429/503 with <code>Retry‑After</code>, and the SDK's backoff absorbs it. Never accept what you cannot durably write — accepting and then dropping is worse than refusing.</li>
</ul>

### 4. Resolver — name to identity, replayably

<ul>
  <li><b>Look up <code>(namespace, raw_name, client_version)</code> in the registry</b> and get back a <code>metric_id</code> with its declared unit and type, or <code>UNRESOLVED</code>. Keying on the triple rather than the name is what lets one string mean two things in two releases.</li>
  <li><b>Write the raw observation with full provenance</b> — <code>raw_name, client_version, metric_id, mapping_version, ingest_ts</code> — <em>always</em>, whether or not resolution succeeded.</li>
  <li><b>Write the canonical series into the TSDB</b> under <code>metric_id</code> with normalized labels and any declared unit conversion applied.</li>
  <li><b>Unresolved goes to quarantine,</b> under <code>raw:&lt;namespace&gt;/&lt;name&gt;</code>: queryable on its own, excluded from every canonical metric, and surfaced in a review queue with counts, versions, sample labels and a distribution sketch. Never dropped, never guessed at — the two failure modes that matter here.</li>
  <li><b>The registry is cached aggressively</b> in the resolver, since this lookup runs millions of times a second, and is refreshed on mapping‑version change.</li>
</ul>

### 5. Storage — two stores with different jobs

<ul>
  <li><b>Raw observation store</b> (columnar files partitioned by namespace and day, or a wide‑column store): every observation exactly as sent, immutable, append‑only, long retention. <b>This is the system of record</b>, and its existence is the entire reason a wrong mapping is survivable.</li>
  <li><b>Canonical TSDB</b> keyed by <code>metric_id</code> plus normalized labels, with rollups at 1m/5m/1h keeping sum, count, min, max <em>and</em> histogram buckets. Derived, rebuildable, tiered down by age.</li>
  <li><b>Keep the buckets, not just percentiles.</b> Downsampling that discards histogram buckets silently destroys every percentile query over old data — a mistake that is invisible until someone asks for last quarter's p99.</li>
  <li><b>Aggregates record the <code>mapping_version</code> they were computed under,</b> which is what makes "this number changed because the mapping changed" an answerable question rather than a mystery.</li>
  <li><b>Cardinality control:</b> reject unbounded labels at the edge, hash‑bucket a label that must exist but is high‑cardinality, budget per tenant, and monitor series growth per <code>metric_id</code>. Unknown labels are preserved in raw but not indexed in the TSDB.</li>
</ul>

### 6. Query — resolve through the registry, return provenance

<ul>
  <li><b>Queries name a <code>metric_id</code>, not a raw name.</b> The API expands it through the registry into the set of <code>(raw_name, version_range, valid_from/to)</code> aliases, fetches the matching series and merges them.</li>
  <li><b>Expansion is time‑bounded</b> by each alias's validity window, so an alias approved last month cannot retroactively change what a year‑old dashboard shows.</li>
  <li><b>Every result carries provenance:</b> which aliases contributed, over which ranges, under which mapping version. A number you cannot explain is a number nobody should act on.</li>
  <li><b><code>resolve=raw</code> bypasses aliasing entirely</b> for investigation — indispensable when you are trying to work out whether a mapping is wrong.</li>
  <li><b>Dashboards reference <code>metric_id</code>,</b> so a rename never breaks them and a mapping correction propagates without anyone editing a chart.</li>
</ul>

### 7. Recovery, backpressure and service measurements

<ul>
  <li><b>Replay rebuilds anything downstream.</b> Processors are idempotent (upsert on series and timestamp), offsets are checkpointed, and poison batches go to a DLQ rather than stalling a partition.</li>
  <li><b>Backfills are throttled and bounded</b> so correcting the past can never starve live ingest; when the two compete, live ingest wins.</li>
  <li><b>SLIs worth naming:</b> ingest availability; end‑to‑end freshness (event time → queryable); dedupe rate; SDK‑reported drop rate; <b>unresolved‑name rate</b>; series count per tenant against budget; query p95; consumer lag.</li>
  <li><b>Absence alerts per producer fleet.</b> A client population that stops reporting looks identical to a healthy quiet one, and only an absence rule tells them apart.</li>
  <li><b>Unresolved‑name rate is the SLI unique to this system.</b> A rising value means a new client version is shipping names nobody has mapped, and catching that in hours rather than months is the difference between a small review queue and a year of quarantined data.</li>
</ul>

<div class="note"><b>How the choices move with the requirements:</b> higher <em>throughput</em> pushes partitioning and pre‑aggregation on the client, and eventually a sampling policy. Tighter <em>freshness</em> shrinks the late‑arrival window and pushes rollups closer to ingest, at the cost of re‑computation when late data lands. Stricter <em>reliability</em> (billing‑grade) forces exactly‑once through the log with per‑batch idempotency keys and a reconciliation job. Heavier <em>historical query</em> load pushes more rollup tiers and longer raw retention, which in turn is what keeps mapping corrections possible further back in time.</div>

## Worked example: one observation, end to end {#tl-example-flow}

<p>Follow a single number from a phone in Berlin to a chart, then follow what happens when it turns out to be the wrong kind of number. Concrete values throughout.</p>

<ol class="order">
  <li><b>T+0 · The client measures something.</b>
    A phone running SDK <code>v2.4.1</code> finishes an API call in 143 ms and records
    <code>{name: "http_request_duration_ms", value: 143, ts: 09:14:02.331, labels: {region: "eu-central", endpoint: "/v1/chat", status: "200"}}</code>.
    It goes into a bounded in‑memory buffer. Nothing is sent yet — sending one observation per measurement would be 5M requests/s across the fleet.</li>
  <li><b>T+12s · The SDK batches and sends.</b>
    The buffer reaches 2,000 observations, so it compresses and POSTs them with <code>client_version=2.4.1</code>, <code>namespace=mobile-app</code>, <code>batch_id=b‑8841</code>, and a per‑observation <code>seq</code>.
    <em>The phone had been on the underground for 6 minutes, so this batch also carries observations timestamped 09:08.</em> Both client event time and server ingest time are recorded — the gap is how late data is detected rather than silently mis‑bucketed.</li>
  <li><b>T+12s · Ingest edge validates.</b>
    Auth passes. Type is <code>histogram</code>, the value shape matches, the timestamp is within the 7‑day late window, the unit <code>ms</code> is declared explicitly.
    Labels are checked against the allowlist for this metric: <code>region</code>, <code>endpoint</code>, <code>status</code> are permitted. <em>Had the client added <code>user_id</code>, that observation would be rejected with an itemized error — one label like that is millions of new series.</em>
    Dedupe on <code>(client_id, b‑8841, seq)</code> against a short Redis window: this batch is a retry of one sent 4 s ago that timed out, so 1,847 of the 2,000 are dropped as duplicates and 153 are new.</li>
  <li><b>T+12s · Append to the log, return 202.</b>
    The raw batch is appended to Kafka, partitioned by <code>(namespace, name hash)</code>. <b>Nothing has been resolved yet</b> — this is the ordering decision the whole design rests on. The edge returns <code>202 Accepted</code>: durable, not yet processed.</li>
  <li><b>T+13s · The resolver looks up identity.</b>
    It asks the registry for <code>(mobile-app, "http_request_duration_ms", 2.4.1)</code> and gets back <code>metric_id = m_9f22</code>, declared unit <code>ms</code>, type <code>histogram</code>, mapping_version 6.
    <em>Note the key is the triple, not the name.</em> The same string from <code>namespace=backend</code>, or from client version 3.0, could resolve somewhere entirely different.</li>
  <li><b>T+13s · Write raw, with provenance.</b>
    The observation is written to the raw store exactly as sent, plus <code>raw_name="http_request_duration_ms"</code>, <code>client_version=2.4.1</code>, <code>metric_id=m_9f22</code>, <code>mapping_version=6</code>, <code>ingest_ts</code>.
    <b>This row is never modified again.</b> It is what makes everything later reversible.</li>
  <li><b>T+13s · Write the canonical series.</b>
    The TSDB gets a sample on series <code>m_9f22{region="eu-central", endpoint="/v1/chat", status="200"}</code>. No unit conversion — the declared unit already matches the metric's. Rollups at 1m/5m/1h will pick it up, keeping sum, count, min, max and histogram buckets.</li>
  <li><b>T+45s · A dashboard queries it.</b>
    The chart asks for <code>m_9f22</code>, p99, last 24 h. The query API expands <code>m_9f22</code> through the registry into its aliases with their validity ranges, fetches the matching series, merges, and returns the result with a provenance note: <em>"contributed by http_request_duration_ms (v2.0–v2.9) and request_latency_ms (v1.x, until 2024‑11‑03)"</em>.
    The dashboard references <code>m_9f22</code>, never a raw name — which is why the rename in v2.0 never broke it.</li>
</ol>

<h4>Now the interesting half — a new client version shows up</h4>

<ol class="order">
  <li><b>Day 1 · An unknown name arrives.</b>
    SDK <code>v3.0.0</code> ships and emits <code>http.request.duration</code>, value <code>0.143</code>, unit <code>s</code>.
    The registry has no entry for <code>(mobile-app, "http.request.duration", 3.0.0)</code>, so the resolver writes it to raw with <code>metric_id = UNRESOLVED</code> and puts it in a quarantine series <code>raw:mobile-app/http.request.duration</code>.
    <b>It is not dropped and it is not guessed at.</b> The dashboard for <code>m_9f22</code> does not move, because quarantined data contributes to no canonical metric.</li>
  <li><b>Day 1 · The review queue surfaces it.</b>
    The entry shows: 2.1M observations/day, client versions [3.0.0], labels <code>region/endpoint/status</code>, declared unit <code>s</code>, type <code>histogram</code>, and a distribution sketch with median 0.143.
    <em>A human immediately sees the trap: the name looks like a rename of <code>http_request_duration_ms</code>, but the unit is seconds and the values are 1000× smaller.</em></li>
  <li><b>Day 2 · Proposal with evidence.</b>
    Someone proposes: <code>(mobile-app, "http.request.duration", [3.0.0, ∞)) → m_9f22</code> <b>with <code>unit_conversion: s → ms (×1000)</code></b>.
    Evidence attached: the v3.0.0 client diff showing the same instrumentation point renamed and its unit changed; same type; same label schema; and a distribution comparison showing v2.9 and v3.0 medians match to within 2% <em>after</em> conversion.
    Status <code>PENDING</code>. Nothing has changed for any consumer.</li>
  <li><b>Day 3 · Owner approves.</b>
    The team owning <code>m_9f22</code> approves; the proposer could not approve their own. <code>mapping_version</code> → 7, <code>valid_from</code> = the date v3.0.0 first appeared.</li>
  <li><b>Day 3–10 · Shadow, then query‑time, then soak.</b>
    First a shadow series nobody queries. Then the alias goes live as a <em>query‑time expansion</em> — canonical storage is untouched, so revoking is one registry write.
    Soak checks run: no step change at the boundary (✓ after conversion), no ×1000 ratio between the series (✓ the conversion handles it), no per‑device duplicates (✓ a device runs one version).
    <em>Had the conversion been omitted, check two would have caught a 1000× discrepancy before any consumer saw it.</em></li>
  <li><b>Day 10 · Backfill.</b>
    Canonical history is re‑derived from raw for the alias's range under mapping_version 7, with the conversion applied. Raw is untouched. The affected range is flagged <em>"recomputed under v7"</em> so a chart that shifts has an explanation.</li>
  <li><b>Day 40 · It turns out to be wrong.</b>
    Someone notices v3.0's metric excludes TLS handshake time — it measures a different span, so it was never the same metric.
    Revoke: status <code>REVOKED</code>, <code>valid_to = now</code>, reason recorded. The resolver stops applying it immediately; new v3.0 data returns to quarantine.
    <code>mapping_version</code> → 8, and the backfill re‑derives the affected range from raw — <b>which still holds the original names</b>, because raw was never modified. Then <code>http.request.duration</code> gets its own <code>metric_id</code>, and the quarantined plus historical rows are mapped to it, so the data is recovered rather than discarded.
    The audit trail says who approved it, on what evidence, and which dashboards were affected.</li>
</ol>

<div class="trap"><b>What the raw store bought you.</b> Every correction above was possible because raw observations were written exactly as sent, before any resolution, and never modified. Had the edge resolved names before the durable log, the original <code>http.request.duration</code> observations would have been stored as <code>m_9f22</code> samples with the conversion already applied — and on day 40 there would be no way to separate them back out. <b>Resolve after the log, never before it.</b></div>

## Part 2: reconcile naming variants {#tl-part2}

<!-- DIAGRAM:lifecycle:START -->

<img src="/diagrams/telemetry/lifecycle.svg" alt="The alias lifecycle — detection to revocation, reversible at every step" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:lifecycle:END -->

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/telemetry/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

### The mapping model

<table>
  <tbody><tr><th>Field</th><th>Meaning</th></tr>
  <tr><td>scope</td><td>namespace/tenant/producer the raw name came from; the same string in another namespace is a different key</td></tr>
  <tr><td>raw_name, version_range</td><td>exact name and client versions it applies to; a name can map differently across versions</td></tr>
  <tr><td>metric_id</td><td>the stable identity it resolves to</td></tr>
  <tr><td>unit_conversion, type</td><td>declared transformation (ms → s) and confirmation the type matches; mismatched type is never an alias</td></tr>
  <tr><td>evidence</td><td>links: client source diff, release notes, owner statement, distribution comparison</td></tr>
  <tr><td>status, approved_by, valid_from, valid_to</td><td>PENDING → APPROVED → (REVOKED); who and when; time range the alias is believed true</td></tr>
  <tr><td>mapping_version</td><td>monotonic; every derived row records the version it was computed with</td></tr>
</tbody></table>

### What counts as evidence for a true alias

<ul>
  <li><b>Code:</b> the client source shows the rename of the same instrumentation point, or the same field emitted under two names.</li>
  <li><b>Semantics declared equal:</b> same type (counter vs gauge vs histogram), same unit or a declared conversion, same label schema and meaning of each label.</li>
  <li><b>Empirical:</b> during the overlap window, per‑device distributions match (after conversion) and the two names are not both emitted by one client version with different values.</li>
  <li><b>Ownership:</b> the metric owner approves; reviewers can't approve their own proposal. Similar spelling (<code>req_latency_ms</code> vs <code>request_latency</code>) is a hypothesis, not evidence: the second might be seconds, or a histogram, or a different span.</li>
</ul>

### Incoming data

<ul>
  <li>Resolver applies APPROVED aliases only. Unknown or PENDING names go to a quarantine series (<code>raw:&lt;namespace&gt;/&lt;name&gt;</code>) that is queryable on its own but excluded from canonical metric_ids. Unresolved names appear in a review queue with counts, versions, sample labels, and a distribution sketch.</li>
  <li>A client version emitting a familiar name with a different declared unit or type is <b>not</b> resolved to the existing metric_id: it's a new candidate identity until a human decides.</li>
</ul>

### Stored history: the choice

<table>
  <tbody><tr><th>Strategy</th><th>How</th><th>Use when</th><th>Risk</th></tr>
  <tr><td>Query‑time alias resolution</td><td>Canonical store keeps series under their raw names; query expands metric_id → aliases and merges</td><td>Mapping uncertain or young; many consumers; cheap reversibility</td><td>Every query pays the merge; double count if two aliases overlap in time on one device</td></tr>
  <tr><td>Rewrite derived history</td><td>Backfill job re‑derives canonical series from raw under the new mapping_version for the affected range</td><td>Mapping approved and stable; heavy dashboards; aggregates that feed billing/SLOs</td><td>Costly; must be idempotent and versioned; needs raw store to exist</td></tr>
  <tr><td><b>Hybrid (pick)</b></td><td>New alias: query‑time for a soak period; once approved and validated, backfill canonical and keep raw untouched</td><td>Default</td><td>Two code paths; mitigated by provenance flags in results</td></tr>
</tbody></table>
<ul>
  <li><b>Double counting guard:</b> during the overlap window a single device may emit both names. Dedupe by (device, metric_id, ts bucket) and prefer the newest version's name; count the other as provenance, not as a second sample. This is the "a rename can change an aggregate" trap: merging two names that both fire per event doubles the counter.</li>
  <li>Raw store is never modified. Provenance answers "where did this number come from" after any number of remaps.</li>
</ul>

<div class="trap"><b>Worked example — a rename changes an aggregate.</b> Client v4.2 emits <code>http_requests</code>; v4.3 renames it to <code>http_request_total</code>. Both versions are in the field, so during the overlap the fleet emits 10,000/min under the old name and 6,000/min under the new one.
<br/>· <b>Merge naively</b> and the canonical counter reads 16,000/min — a 60% step change on a chart, caused entirely by a rename. Any SLO, alert threshold or capacity model built on it is now wrong, and nothing errored.
<br/>· <b>Worse:</b> if a single client version briefly emitted <em>both</em> names for the same event (common during a rename), those observations are genuinely double counted, and no amount of downstream maths recovers the truth.
<br/>· <b>Correct:</b> the alias carries a validity range per client version, so v4.2 devices contribute through the old name and v4.3 devices through the new one, and a device is counted under exactly one name at any instant. Dedupe by (device, metric_id, ts bucket), preferring the newest version's name, and record the other as provenance rather than as a second sample.
<br/>· <b>The check that catches it:</b> compare the merged series against the sum of per‑version series during the soak window. If merged &gt; sum, you have double counting; if merged shows a step at the alias boundary, the alias is wrong or its validity range is.</div>

### Dashboards and queries

<ul>
  <li>Consumers query metric_id; alias expansion is server‑side. Add a <code>provenance</code> overlay so a chart can show where an alias starts contributing.</li>
  <li>Deprecation: raw‑name queries still work with a warning header and a sunset date; a linter flags dashboards using raw names.</li>
</ul>

### The alias lifecycle, step by step {#tl-lifecycle}

<p>This is the second flow in the system, and the one people skip. Ingest moves observations; this moves <em>meaning</em>. Every step exists to keep a human judgement in the loop and to keep the whole thing reversible.</p>

<ol class="order">
  <li><b>Detection — an unresolved name appears in the review queue.</b>
    The resolver quarantined it, so no canonical metric was touched and no dashboard silently changed.
    The queue entry carries counts, the client versions emitting it, sample labels, the declared unit and type, and a distribution sketch — everything a human needs to form a hypothesis without querying anything.
    A rising unresolved‑name rate is itself an alert: it usually means a new client version shipped names nobody mapped.</li>
  <li><b>Proposal — someone claims raw_name X in namespace N for versions [a,b) is metric_id M.</b>
    The proposal is a row with status <code>PENDING</code>, not a config change, so proposing costs nothing and changes nothing.
    It must state the version range, because the same name in a later release may legitimately mean something else.
    It is a hypothesis at this point; the next step is what makes it evidence.</li>
  <li><b>Evidence — attach code, declared semantics, and empirical comparison.</b>
    <em>Code:</em> the client diff showing the same instrumentation point renamed, which is the strongest evidence available and usually settles it.
    <em>Declared semantics:</em> same type, same unit or an explicit conversion, same label schema with the same meaning per label — a type mismatch is never an alias, whatever the names look like.
    <em>Empirical:</em> during the overlap window, per‑device distributions match after conversion, and no single client version emits both names with different values.
    A similar spelling is not on this list. <code>req_latency_ms</code> and <code>request_latency</code> may differ by a factor of 1000, by type, or by which span they measure.</li>
  <li><b>Approval — the owning team approves; the proposer cannot approve their own.</b>
    Aliasing is a semantic judgement about what a number means, which makes it an ownership decision rather than an infrastructure one.
    Separating proposer from approver is what stops a well‑meaning platform engineer from merging two metrics they do not actually understand.
    Approval stamps <code>approved_by</code>, <code>valid_from</code>, <code>valid_to</code> and bumps <code>mapping_version</code>.</li>
  <li><b>Shadow — resolve into a parallel series, act on nothing.</b>
    The alias is applied to produce a shadow metric that nobody queries, while the canonical series continues unchanged.
    This is where a wrong mapping is caught for free: the merged shadow can be compared against the per‑version raw series with no consumer affected.
    Any automatic name‑matching tool lives permanently at this stage and never past it.</li>
  <li><b>Query‑time resolution — the alias goes live, but only as an expansion.</b>
    Canonical storage is untouched; the query layer expands <code>metric_id</code> into its aliases and merges at read time.
    Reversibility is the point: if the alias is wrong, revoking it is a registry write and the next query is correct, with nothing to rebuild.
    The cost is paid per query, which is acceptable for a young mapping and not for a permanent one.</li>
  <li><b>Soak — run the automated checks for a defined window.</b>
    Three checks, each targeting a specific way this goes wrong: a step change at the alias boundary (wrong alias or wrong validity range); a ratio near a power of ten between the two series (a unit mismatch, the ms/s trap); and per‑device duplicates (double counting during overlap).
    The merged series is also compared against the sum of per‑version series — merged greater than sum means double counting.
    The window must be long enough to cover a full traffic cycle, because a daily pattern can hide a step change for hours.</li>
  <li><b>Backfill — re‑derive canonical history from raw under the new mapping_version.</b>
    Only now, with the mapping approved and soaked, is history rewritten — and "rewritten" only ever means re‑deriving the canonical view. Raw is never modified.
    The job is idempotent and restartable because it reads immutable input and writes a versioned output, so a failure halfway is simply re‑run.
    It is throttled and bounded so correcting the past cannot starve live ingest.</li>
  <li><b>Publish — change log entry, provenance flag, and consumer notice.</b>
    The affected time range is flagged "recomputed under mapping v<em>N</em>" so a chart that shifts has a visible, queryable explanation.
    Query logs identify which dashboards and which teams touched that <code>metric_id</code>, so notification is targeted rather than a broadcast nobody reads.</li>
  <li><b>Client migration — ship the canonical name, keep the alias forever.</b>
    New SDKs emit the canonical name, so the alias stops accumulating new data as the fleet turns over.
    Because clients cannot all be upgraded, the alias is permanent infrastructure rather than a temporary bridge — and that is the design accommodating reality rather than fighting it.
    Raw‑name queries keep working with a deprecation warning and a sunset date, and a linter flags dashboards still using them.</li>
  <li><b>Revocation — if the mapping turns out to be wrong.</b>
    Set status <code>REVOKED</code> with <code>valid_to = now</code> and a reason; the resolver stops applying it immediately and new data for that raw name returns to quarantine.
    Bump <code>mapping_version</code> and re‑derive the affected range from raw, which still holds the original names — this is precisely what the raw store exists for.
    If the name turned out to be a genuinely different metric, give it its own <code>metric_id</code> and map the quarantined and historical rows to that instead, so the data is recovered rather than discarded.
    The audit trail — who approved, on what evidence, when revoked, which consumers were affected — is what makes the correction reviewable rather than another unexplained shift.</li>
</ol>

### Correction runbook: the concrete steps {#tl-correction}

<ol class="order">
  <li>Revoke the alias (status REVOKED, valid_to = now, reason). Resolver stops applying it immediately; new data for that raw name goes to quarantine.</li>
  <li>Bump mapping_version; the backfill job re‑derives the affected metric_id's canonical series for the alias's time range from raw, which still has the original names.</li>
  <li>Rollups and any downstream aggregates keyed by mapping_version are recomputed; consumers see a provenance flag "recomputed under v7" for the range.</li>
  <li>If the raw name was actually a different metric, create its own identity and map the quarantined + historical raw rows to it.</li>
  <li>Audit trail: who approved, evidence, when revoked, which queries/dashboards were affected (query logs by metric_id).</li>
</ol>

## Follow‑ups {#tl-followups}

<details><summary>An unknown client version submits a familiar name with a different unit?</summary><p>Don't resolve. Identity includes unit; a mismatch means a different metric until proven otherwise. Quarantine it under the raw name + version, alert the owner, and if evidence shows it's the same measurement in different units, approve an alias with an explicit unit_conversion and backfill with the conversion applied. Never auto‑convert on a guess: ms vs s is a ×1000 error in an SLO.</p></details>
<details><summary>Query‑time alias resolution vs rewriting history?</summary><p>Query‑time when the mapping is new or contested, when reversibility matters more than query cost, when consumers are few, or when raw isn't yet complete for the range. Rewrite when the mapping is approved and stable, the metric feeds heavy dashboards, SLOs, or billing, and you need one physical series for performance and downsampling. In both cases raw is untouched; "rewrite" only ever means re‑deriving the canonical view.</p></details>
<details><summary>Evaluating an automatic name‑matching tool without silent merges?</summary><p>Run it in shadow mode producing PENDING proposals only, never APPROVED. Score against a labeled set of known aliases and known non‑aliases (same‑name‑different‑unit traps included); measure precision first, since a false merge corrupts data while a miss just delays. Require every proposal to carry evidence the tool found (code diff, distribution match). Gate promotion on owner approval plus the soak checks. Track its precision over time and pull it if precision drops.</p></details>


## Trade-offs {#tl-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>What is the system of record</td><td>Raw observations, with canonical series as a derived view</td><td>Substantially more storage, and a re‑derivation pipeline to operate</td><td>Store only resolved data when mappings are certain and permanent — here they are neither, and reversibility is the whole point</td></tr>
  <tr><td>Metric identity</td><td>(namespace, raw_name, client_version) → metric_id</td><td>A registry to govern, and mappings that need owners and approvals</td><td>Name‑only identity is simpler and silently merges metrics that merely share a name, which is the failure this design exists to prevent</td></tr>
  <tr><td>Unknown names</td><td>Quarantine under a raw identity</td><td>A pool of unresolved series that someone must triage</td><td>Dropping loses data irrecoverably; auto‑guessing corrupts a trusted metric invisibly — quarantine is the only reversible option</td></tr>
  <tr><td>Alias approval</td><td>Owner approval with attached evidence</td><td>Mappings take days rather than minutes to land</td><td>Auto‑approving on name similarity is fast and occasionally catastrophic; a similar name is not proof of the same meaning</td></tr>
  <tr><td>Correction mechanism</td><td>Re‑derive from raw into the affected range</td><td>Backfill cost, and a window where old and new derivations coexist</td><td>Patching aggregates in place is cheaper but not idempotent and not auditable, so a failed correction leaves unknown state</td></tr>
  <tr><td>Query semantics</td><td>Time‑bounded alias expansion, dedupe on identity</td><td>More complex queries and a slower path than a single‑series read</td><td>Never simplify by summing everything matching — that double counts re‑derived ranges, which is exactly the bug this system must not have</td></tr>
  <tr><td>Delivery</td><td>At‑least‑once with dedupe on (client_id, batch_id, seq)</td><td>A dedupe window to size and operate</td><td>Exactly‑once from thousands of unreliable clients is not achievable; dedupe at the edge gets the same observable result</td></tr>
</tbody></table>

## Safety-first design {#tl-safety}

<div class="cards">
  <div><h4>Never silently change a number people trust</h4><ul>
    <li><b>Raw is immutable and always written.</b> Every canonical series is derived, so a mistaken mapping is a re‑derivation rather than permanent corruption.</li>
    <li><b>Provenance travels with the data.</b> Raw name, client version and mapping version are attached to every observation and surfaced in query results.</li>
    <li><b>Never sum an alias twice.</b> Merge deduplicates on identity, because the combination of alias expansion and a completed backfill is exactly where double counting hides.</li>
    <li><b>Units are part of identity.</b> A mapping carries a conversion; merging milliseconds into a seconds series without one is silent corruption that no alert would catch.</li></ul></div>
  <div><h4>Governance as a design element</h4><ul>
    <li><b>Mappings need evidence and an owner's approval.</b> Similar names are a hypothesis, not a fact, and the person who owns the metric is the one who can confirm it.</li>
    <li><b>Every change is versioned and logged.</b> Reason, approver and validity range are recorded, so "why did this dashboard shift?" is answerable by query.</li>
    <li><b>Revocation is a first‑class operation.</b> A wrong mapping is revoked and the range re‑derived, using the same machinery as approval.</li>
    <li><b>Validity ranges bound the damage.</b> An alias applies only within its window, so a new mapping cannot retroactively rewrite history it was never meant to cover.</li></ul></div>
  <div><h4>Protecting the platform from its clients</h4><ul>
    <li><b>Cardinality budgets at the edge.</b> Per‑tenant series limits and label allowlists stop one client version from taking down analytics for everyone.</li>
    <li><b>Rejections are itemized.</b> The 202 lists what was refused and why, so a misbehaving client version is diagnosable rather than mysterious.</li>
    <li><b>Loss is measurable.</b> The SDK emits a dropped‑observations counter, so buffer overflow shows up as a number instead of an unexplained gap.</li>
    <li><b>Live ingest always wins.</b> Backfills are throttled and bounded, so correcting the past can never degrade the present.</li></ul></div>
</div>

## Don't leave the room without saying {#tl-checklist}

<ul class="checklist">
  <li>Ask for volume, delay, query shape, retention and tolerable loss — then state an assumption for each, because a design cannot be judged against adjectives</li>
  <li>Identity is (namespace, name, client_version) → metric_id with a declared type, unit, label schema and owner — never the name alone</li>
  <li>Resolve <em>after</em> the durable log, never before it, so today's mapping is not baked into tomorrow's history</li>
  <li>Raw is the system of record; every aggregate is a derived view carrying the mapping_version it was computed under</li>
  <li>Unknown names are quarantined, never dropped and never guessed — and the unresolved‑name rate is an SLI</li>
  <li>Evidence for an alias: code diff, matching type/unit/labels, matching distributions in the overlap window, owner approval — spelling is a hypothesis, not evidence</li>
  <li>A rename can change an aggregate: two names live at once double the counter unless validity ranges and per‑device dedupe are applied</li>
  <li>Query‑time resolution first (reversible), backfill after soak (performant); raw is never modified either way</li>
  <li>Revocation is a registry write plus a re‑derivation, and the audit trail says who approved it on what evidence</li>
  <li>Ask about volume, delay, query shape, retention, loss/dup tolerance, and how identity is scoped, before drawing</li>
  <li>Raw immutable store with provenance is the system of record; canonical TSDB is a derived, versioned view</li>
  <li>Resolution happens after the durable log, never at the edge; edge validates, dedupes, rate‑limits, applies cardinality budgets</li>
  <li>metric_id as stable identity; names are scoped, versioned aliases with evidence, owner approval, validity range</li>
  <li>Similar name ≠ same metric; type/unit/label schema must match; unit conversions declared</li>
  <li>Unresolved and pending names go to quarantine, queryable but never merged</li>
  <li>Overlap dedupe by device so a rename never double counts</li>
  <li>Hybrid: query‑time first, backfill after soak; wrong mapping → revoke, bump version, re‑derive from raw</li>
  <li>Dashboards bind to metric_id; provenance flags in query results</li>
  <li>SLIs: freshness, drop/dup rates, unresolved rate, cardinality, lag</li>
</ul>

## What each level is expected to drive {#tl-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Client batching, ingest API, queue, TSDB, basic query; a rename table applied at ingest</td><td>Raw vs derived separation, evidence for aliases</td></tr>
  <tr><td>Senior</td><td>Durable log before resolution, raw store with provenance, registry with scoped versioned aliases and approval, query‑time vs rewrite trade‑off, overlap dedupe, revoke + re‑derive path</td><td>Cardinality governance, automatic matcher evaluation</td></tr>
  <tr><td>Staff+</td><td>Frames identity and governance as the core problem, connects every storage choice to the stated requirements, designs the correction path as a first‑class workflow with audit, and evaluates tooling by precision with shadow mode</td><td>—</td></tr>
</tbody></table>
