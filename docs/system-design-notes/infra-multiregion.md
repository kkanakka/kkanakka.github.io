---
title: "Multi‑region, multi‑cloud LLM inference serving with failover"
slug: /system-design-notes/infra-multiregion
sidebar_position: 13
sidebar_label: "Multi‑region, multi‑cloud LLM inference …"
description: "hard · Anthropic · cells · N+1 · degraded modes · GPUs don’t autoscale"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/infra-multiregion/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">hard · Anthropic · cells · N+1 · degraded modes · GPUs don’t autoscale</span>
</header>

## Requirements {#infra-multiregion-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Serve inference for each model from multiple regions across two clouds</li>
      <li>Route each request to a healthy region/cell honoring data residency</li>
      <li>Fail over automatically when a cell or region is unhealthy</li>
      <li>Operators can enter and exit pre‑defined degraded modes</li>
      <li class="out">Model training, billing, the chat product</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Availability 99.95% per model globally; a region loss must not be a total outage</li>
      <li>TTFT/ITL SLOs hold in normal mode; explicit relaxed SLOs per degraded mode</li>
      <li>Capacity is fixed on a minutes‑to‑days horizon: no burst autoscaling</li>
      <li>Blast radius of any deploy or bad node limited to one cell</li>
    </ol>
  </div>
</div>

## Entities and API {#infra-multiregion-api}

<p>Region · Cell (id, region, cloud, model, capacity RPS, health, weight) · ModelVersion · RoutingPolicy (residency, tier rules) · DegradedMode (level, actions, owner, maxDuration)</p>
<pre><code>POST /v1/messages                        -&gt; stream            (public; unchanged)
GET  /internal/cells?model=              -&gt; [cell health, capacity, weight]
PUT  /internal/routing/:model            -&gt; {region weights, residency rules}
POST /internal/modes {model, region, level, reason}   -&gt; enters degraded mode (audited)
GET  /internal/modes                     -&gt; current levels per region</code></pre>

## Design {#infra-multiregion-design}

<figure>
<svg viewBox="0 0 980 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Global router over regions on two clouds; each region contains cells that are independent failure units with router, replicas, KV cache; N+1 regional capacity; degraded modes ladder">
  <defs><marker id="m1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker></defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:11px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#m1)}.pl{fill:none;stroke:#D6DDE5;stroke-dasharray:6 4;rx:8}.pt{font-size:11px;font-weight:700;fill:#5B6673}</style>
  <rect class="box" x="20" y="120" width="140" height="60"></rect><text class="tb" x="90" y="142" text-anchor="middle">Global router</text><text class="ts" x="90" y="158" text-anchor="middle">anycast/DNS + health</text><text class="ts" x="90" y="172" text-anchor="middle">capacity‑aware weights</text>
  <rect class="pl" x="200" y="20" width="360" height="120"></rect><text class="pt" x="210" y="38">REGION us‑east (cloud A)</text>
  <rect class="box" x="210" y="50" width="100" height="70"></rect><text class="tb" x="260" y="70" text-anchor="middle">cell 1</text><text class="ts" x="260" y="86" text-anchor="middle">router · 64 GPUs</text><text class="ts" x="260" y="100" text-anchor="middle">KV cache · limiter</text>
  <rect class="box" x="320" y="50" width="100" height="70"></rect><text class="tb" x="370" y="70" text-anchor="middle">cell 2</text><text class="ts" x="370" y="86" text-anchor="middle">independent</text><text class="ts" x="370" y="100" text-anchor="middle">deploy + fail</text>
  <rect class="box" x="430" y="50" width="100" height="70" stroke="#B45309"></rect><text class="tb" x="480" y="70" text-anchor="middle">cell 3</text><text class="ts" x="480" y="86" text-anchor="middle">+1 headroom</text><text class="ts" x="480" y="100" text-anchor="middle">(canary here)</text>
  <rect class="pl" x="200" y="160" width="360" height="120"></rect><text class="pt" x="210" y="178">REGION eu‑west (cloud B)</text>
  <rect class="box" x="210" y="190" width="100" height="70"></rect><text class="tb" x="260" y="210" text-anchor="middle">cell 1</text><text class="ts" x="260" y="226" text-anchor="middle">different GPU SKU</text><text class="ts" x="260" y="240" text-anchor="middle">same model version</text>
  <rect class="box" x="320" y="190" width="100" height="70"></rect><text class="tb" x="370" y="210" text-anchor="middle">cell 2</text>
  <rect class="box" x="430" y="190" width="100" height="70" stroke="#B45309"></rect><text class="tb" x="480" y="210" text-anchor="middle">cell 3</text><text class="ts" x="480" y="226" text-anchor="middle">+1</text>
  <rect class="box" x="600" y="40" width="360" height="220"></rect><text class="tb" x="610" y="60">Degraded modes (pre‑approved, in order)</text>
  <text class="ts" x="610" y="82">0 normal: all tiers, full max_tokens</text>
  <text class="ts" x="610" y="100">1 shed: reject free tier (429 + Retry‑After)</text>
  <text class="ts" x="610" y="118">2 cap: lower max_tokens and context limits</text>
  <text class="ts" x="610" y="136">3 downgrade: route to smaller model, tell client via header</text>
  <text class="ts" x="610" y="154">4 queue: waiting room for interactive, pause batch entirely</text>
  <text class="ts" x="610" y="172">5 brownout: enterprise only</text>
  <text class="ts" x="610" y="196">Each mode has an owner, an SLO, a dashboard, and a</text><text class="ts" x="610" y="210">runbook. Entering a mode is a decision, exiting is a</text><text class="ts" x="610" y="224">measured recovery. Never invent a mode during an incident.</text>
  <text class="ts" x="610" y="248">Weights replicated to every region ahead of time.</text>
  <path class="f" d="M160 140 L208 90"></path><path class="f" d="M160 160 L208 220"></path>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 746" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Multi-region failover flow">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="5" y="14" width="130" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Client</text>
<line class="ln" x1="70" y1="48" x2="70" y2="726"></line>
<rect class="sb" x="173" y="14" width="130" height="34"></rect><text class="st" x="238" y="36" text-anchor="middle">Global router</text>
<line class="ln" x1="238" y1="48" x2="238" y2="726"></line>
<rect class="sb" x="341" y="14" width="130" height="34"></rect><text class="st" x="406" y="36" text-anchor="middle">Region A cell</text>
<line class="ln" x1="406" y1="48" x2="406" y2="726"></line>
<rect class="sb" x="509" y="14" width="130" height="34"></rect><text class="st" x="574" y="36" text-anchor="middle">Region B cell</text>
<line class="ln" x1="574" y1="48" x2="574" y2="726"></line>
<rect class="sb" x="677" y="14" width="130" height="34"></rect><text class="st" x="742" y="36" text-anchor="middle">Probes</text>
<line class="ln" x1="742" y1="48" x2="742" y2="726"></line>
<rect class="sb" x="845" y="14" width="130" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Mode controller</text>
<line class="ln" x1="910" y1="48" x2="910" y2="726"></line>
<line class="a3" x1="734" y1="80" x2="414" y2="80"></line>
<text class="sl" x="574" y="74" text-anchor="middle">synthetic inference probe (every few s)</text>
<line class="a2" x1="414" y1="114" x2="734" y2="114"></line>
<text class="sl" x="574" y="108" text-anchor="middle">TTFT ok</text>
<line class="a3" x1="734" y1="148" x2="246" y2="148"></line>
<text class="sl" x="490" y="142" text-anchor="middle">cell weights update</text>
<line class="a1" x1="78" y1="182" x2="230" y2="182"></line>
<text class="sl" x="154" y="176" text-anchor="middle">request</text>
<rect class="nt" x="159" y="203" width="159" height="22"></rect><text class="sl" x="238" y="218" text-anchor="middle">residency + tier policy</text>
<line class="a1" x1="246" y1="250" x2="398" y2="250"></line>
<text class="sl" x="322" y="244" text-anchor="middle">weighted pick</text>
<line class="a2" x1="398" y1="284" x2="78" y2="284"></line>
<text class="sl" x="238" y="278" text-anchor="middle">stream</text>
<line class="a1" x1="734" y1="318" x2="414" y2="318"></line>
<text class="sl" x="574" y="312" text-anchor="middle">probe fails</text>
<line class="a3" x1="734" y1="352" x2="246" y2="352"></line>
<text class="sl" x="490" y="346" text-anchor="middle">weight A → 0</text>
<line class="a1" x1="246" y1="386" x2="398" y2="386"></line>
<text class="sl" x="322" y="380" text-anchor="middle">drain: no new requests</text>
<rect class="nt" x="324" y="407" width="165" height="22"></rect><text class="sl" x="406" y="422" text-anchor="middle">in-flight streams finish</text>
<line class="a1" x1="78" y1="454" x2="230" y2="454"></line>
<text class="sl" x="154" y="448" text-anchor="middle">next request</text>
<line class="a1" x1="246" y1="488" x2="566" y2="488"></line>
<text class="sl" x="406" y="482" text-anchor="middle">route to B</text>
<rect class="nt" x="507" y="509" width="134" height="22"></rect><text class="sl" x="574" y="524" text-anchor="middle">headroom exhausted?</text>
<line class="a3" x1="582" y1="556" x2="902" y2="556"></line>
<text class="sl" x="742" y="550" text-anchor="middle">queue depth, SLIs</text>
<rect class="nt" x="815" y="577" width="190" height="22"></rect><text class="sl" x="910" y="592" text-anchor="middle">enter mode 1: shed free tier</text>
<line class="a3" x1="902" y1="624" x2="246" y2="624"></line>
<text class="sl" x="574" y="618" text-anchor="middle">policy update</text>
<line class="a2" x1="230" y1="658" x2="78" y2="658"></line>
<text class="sl" x="154" y="652" text-anchor="middle">429 for free tier, stream for paid</text>
<rect class="nt" x="800" y="679" width="220" height="22"></rect><text class="sl" x="910" y="694" text-anchor="middle">measured recovery → exit mode, audited</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Probes → Region A cell:</b> synthetic inference probe (every few s) (async)</li>
  <li><b>Region A cell → Probes:</b> TTFT ok (response)</li>
  <li><b>Probes → Global router:</b> cell weights update (async)</li>
  <li><b>Client → Global router:</b> request</li>
  <li><b>Global router:</b> residency + tier policy</li>
  <li><b>Global router → Region A cell:</b> weighted pick</li>
  <li><b>Region A cell → Client:</b> stream (response)</li>
  <li><b>Probes → Region A cell:</b> probe fails</li>
  <li><b>Probes → Global router:</b> weight A → 0 (async)</li>
  <li><b>Global router → Region A cell:</b> drain: no new requests</li>
  <li><b>Region A cell:</b> in-flight streams finish</li>
  <li><b>Client → Global router:</b> next request</li>
  <li><b>Global router → Region B cell:</b> route to B</li>
  <li><b>Region B cell:</b> headroom exhausted?</li>
  <li><b>Region B cell → Mode controller:</b> queue depth, SLIs (async)</li>
  <li><b>Mode controller:</b> enter mode 1: shed free tier</li>
  <li><b>Mode controller → Global router:</b> policy update (async)</li>
  <li><b>Global router → Client:</b> 429 for free tier, stream for paid (response)</li>
  <li><b>Mode controller:</b> measured recovery → exit mode, audited</li>
</ol>

## How it works, step by step {#infra-multiregion-flow}

<ol class="order">
  <li>Client resolves an anycast/DNS name to the nearest healthy edge; the global router reads routing policy (residency, tier) and cell weights.</li>
  <li>Router picks a cell by weighted choice within the allowed regions; weight = measured spare capacity, not cell count.</li>
  <li>Inside the cell, the local router pins the request to a replica (prefix‑cache affinity) and streams.</li>
  <li>Synthetic probes per cell run real inference every few seconds; failing probes drop the cell weight to 0 and drain it.</li>
  <li>Region‑level failure: weights shift to surviving regions gradually; if their headroom is insufficient the mode controller steps to level 1, 2, 3… per runbook.</li>
  <li>In‑flight streams finish where they are; only new requests move.</li>
  <li>Exit a mode by measured recovery (queue depth, SLIs) and an explicit operator action; every transition is logged.</li>
</ol>

## Deep dives {#infra-multiregion-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/infra-multiregion/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
  <div><h4>Cells as failure units</h4><ul>
    <li>A cell = router + N GPU replicas + local KV/prefix cache + local rate limiter + config. No shared state with other cells. Blast radius of a bad deploy or a bad node = one cell.</li>
    <li>Deploy cell by cell; canary is a cell; drain a cell to take it out.</li>
    <li>Route by (model, region, cell weight); sticky by prefix hash within a cell for cache hits, never sticky across cells.</li></ul></div>
  <div><h4>N+1 capacity, said with numbers</h4><ul>
    <li>If peak needs N cells per region, provision N+1 per region so one cell can die or be upgraded at peak.</li>
    <li>Region loss: you cannot absorb a whole region into another without pre‑paid headroom. Decide: 2× everywhere (expensive) or explicit degraded modes (cheaper, honest). Most choose modes + partial headroom.</li>
    <li>Multi‑cloud: same model version everywhere but different GPU SKUs → different throughput per cell; router weights by measured capacity, not cell count.</li></ul></div>
  <div><h4>Failover mechanics</h4><ul>
    <li>Health = synthetic inference probes per cell (TTFT, correctness), not just TCP.</li>
    <li>Global router shifts weight gradually (avoid stampeding the survivor); in‑flight streams finish where they are, new requests move.</li>
    <li>Data residency: EU requests may not fail over to US; encode residency in routing policy.</li>
    <li>Quota/limits are per cell with global lease (see #6) so failover doesn't double‑count.</li></ul></div>
</div>

## Don't leave the room without saying {#infra-multiregion-check}

<ul class="checklist">
  <li>A cell is a self‑contained failure unit: router + replicas + cache + limiter + config</li>
  <li>N+1 per region with numbers; region loss needs either 2× or degraded modes</li>
  <li>Degraded modes are pre‑approved, ordered, owned, time‑boxed</li>
  <li>Health = synthetic inference, not TCP</li>
  <li>Gradual weight shift to avoid stampeding survivors</li>
  <li>Residency encoded in routing policy</li>
  <li>Weights replicated everywhere ahead of time; different GPU SKUs → capacity‑weighted routing</li>
</ul>

## What each level is expected to drive {#infra-multiregion-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Multiple regions behind a global LB with health checks; failover to the other region</td><td>Cells, capacity limits</td></tr>
  <tr><td>Senior</td><td>Cells, N+1 math, capacity‑aware routing, synthetic probes, drain semantics, at least two degraded modes</td><td>Residency, multi‑cloud SKU differences</td></tr>
  <tr><td>Staff+</td><td>Full mode ladder with ownership and exit criteria, cost vs headroom trade‑off argued with numbers, quota/limit behaviour during failover, game‑day testing</td><td>—</td></tr>
</tbody></table>
