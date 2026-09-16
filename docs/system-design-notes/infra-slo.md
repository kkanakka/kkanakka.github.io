---
title: "SLOs and monitoring across the token path"
slug: /system-design-notes/infra-slo
sidebar_position: 14
sidebar_label: "SLOs and monitoring across the token path"
description: "medium · Anthropic · TTFT / ITL · trace propagation · latency ledger · burn rate"
---
<header>
  
  <span class="tag">medium · Anthropic · TTFT / ITL · trace propagation · latency ledger · burn rate</span>
</header>

## Requirements {#infra-slo-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Define SLIs for streamed inference that reflect user experience</li>
      <li>Attribute latency to each hop: SDK → gateway → router → serving → GPU</li>
      <li>Alert on SLO violations reliably, without paging on noise</li>
      <li>Give support and customers per‑request diagnostics</li>
      <li class="out">Building the metrics store itself (see #7)</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>SLIs measurable at the edge and reproducible from a request id</li>
      <li>Overhead of instrumentation &lt; 1% latency</li>
      <li>Alerts page within minutes of a real regression; near‑zero false pages</li>
      <li>Dashboards sliced by model, tier, region, cell, context bucket</li>
    </ol>
  </div>
</div>

## Entities and API {#infra-slo-api}

<p>Trace (traceId, spans[]) · LatencyLedger (per‑hop ms, returned with response) · SLI series (ttft, itl, completion, availability × labels) · SLO (target, window) · ErrorBudget · Alert (burn rate, windows)</p>
<pre><code>Request headers:  traceparent: 00-&lt;trace&gt;-&lt;span&gt;-01
Response trailer / final SSE event:
  x-latency-ledger: gw=3;queue=22;prefill=180;first_token=205;itl_p50=28;tokens=412
Metrics emitted per request (labels: model, tier, region, cell, ctx_bucket):
  ttft_ms histogram · itl_ms histogram · stream_complete counter · request_error counter</code></pre>

## Design {#infra-slo-design}

<figure>
<svg viewBox="0 0 980 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Token path hops with one trace id and a per-hop latency ledger; SLIs defined at the edge: TTFT, inter-token latency, completion success; bucketed by context length; burn rate alerting">
  <defs><marker id="s1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker></defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.tm{font-size:10.5px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#s1)}</style>
  <g>
    <rect class="box" x="20" y="40" width="90" height="50"></rect><text class="tb" x="65" y="60" text-anchor="middle">SDK</text><text class="ts" x="65" y="78" text-anchor="middle">t0 send</text>
    <rect class="box" x="150" y="40" width="100" height="50"></rect><text class="tb" x="200" y="60" text-anchor="middle">API GW</text><text class="ts" x="200" y="78" text-anchor="middle">auth 3 ms</text>
    <rect class="box" x="290" y="40" width="100" height="50"></rect><text class="tb" x="340" y="60" text-anchor="middle">Router</text><text class="ts" x="340" y="78" text-anchor="middle">queue 22 ms</text>
    <rect class="box" x="430" y="40" width="110" height="50"></rect><text class="tb" x="485" y="60" text-anchor="middle">Serving</text><text class="ts" x="485" y="78" text-anchor="middle">prefill 180 ms</text>
    <rect class="box" x="580" y="40" width="100" height="50" stroke="#0F766E"></rect><text class="tb" x="630" y="60" text-anchor="middle">GPU decode</text><text class="ts" x="630" y="78" text-anchor="middle">28 ms / token</text>
    <path class="f" d="M110 65 L148 65"></path><path class="f" d="M250 65 L288 65"></path><path class="f" d="M390 65 L428 65"></path><path class="f" d="M540 65 L578 65"></path>
  </g>
  <text class="tm" x="20" y="120">traceparent: 00-4bf9…-a1b2…-01   propagated on every hop, into the stream metadata too</text>
  <text class="tm" x="20" y="138">x-latency-ledger: gw=3;queue=22;prefill=180;first_token=205;itl_p50=28   (returned in trailer / final SSE event)</text>
  <rect class="box" x="720" y="30" width="240" height="210"></rect><text class="tb" x="730" y="50">SLIs (measured at the edge)</text>
  <text class="ts" x="730" y="70">TTFT: t(first token) − t0</text>
  <text class="ts" x="730" y="86">ITL / TPOT: median gap between tokens</text>
  <text class="ts" x="730" y="102">Completion: stream ended with done, no error</text>
  <text class="ts" x="730" y="118">Availability: non‑5xx, non‑timeout</text>
  <text class="ts" x="730" y="140">Bucket every SLI by context length:</text>
  <text class="tm" x="730" y="156">&lt;4k · 4–32k · 32–128k · &gt;128k</text>
  <text class="ts" x="730" y="176">and by model, tier, region, cell.</text>
  <text class="ts" x="730" y="198">Example SLO: TTFT p95 &lt; 1 s for &lt;32k,</text><text class="ts" x="730" y="212">ITL p95 &lt; 60 ms, completion 99.9%,</text><text class="ts" x="730" y="226">over 30 days.</text>
  <rect class="box" x="20" y="160" width="660" height="80"></rect><text class="tb" x="30" y="180">Burn‑rate alerting (multi‑window)</text>
  <text class="ts" x="30" y="198">Error budget = 1 − SLO. Burn rate = (observed error rate) / (budget rate).</text>
  <text class="ts" x="30" y="214">Page: burn 14.4× over 1 h AND 5 m  (budget gone in 2 days)   ·   Ticket: 6× over 6 h AND 30 m   ·   Slow: 1× over 3 d</text>
  <text class="ts" x="30" y="230">Short window confirms it's still happening; long window confirms it's significant. No paging on raw latency thresholds.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 712" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Token-path SLO measurement flow">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="7" y="14" width="126" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">SDK</text>
<line class="ln" x1="70" y1="48" x2="70" y2="692"></line>
<rect class="sb" x="147" y="14" width="126" height="34"></rect><text class="st" x="210" y="36" text-anchor="middle">Gateway</text>
<line class="ln" x1="210" y1="48" x2="210" y2="692"></line>
<rect class="sb" x="287" y="14" width="126" height="34"></rect><text class="st" x="350" y="36" text-anchor="middle">Router</text>
<line class="ln" x1="350" y1="48" x2="350" y2="692"></line>
<rect class="sb" x="427" y="14" width="126" height="34"></rect><text class="st" x="490" y="36" text-anchor="middle">Serving</text>
<line class="ln" x1="490" y1="48" x2="490" y2="692"></line>
<rect class="sb" x="567" y="14" width="126" height="34"></rect><text class="st" x="630" y="36" text-anchor="middle">GPU</text>
<line class="ln" x1="630" y1="48" x2="630" y2="692"></line>
<rect class="sb" x="707" y="14" width="126" height="34"></rect><text class="st" x="770" y="36" text-anchor="middle">Metrics</text>
<line class="ln" x1="770" y1="48" x2="770" y2="692"></line>
<rect class="sb" x="847" y="14" width="126" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Alert evaluator</text>
<line class="ln" x1="910" y1="48" x2="910" y2="692"></line>
<line class="a1" x1="78" y1="80" x2="202" y2="80"></line>
<text class="sl" x="140" y="74" text-anchor="middle">request + traceparent, t0</text>
<rect class="nt" x="134" y="101" width="152" height="22"></rect><text class="sl" x="210" y="116" text-anchor="middle">root span, ledger gw=3</text>
<line class="a1" x1="218" y1="148" x2="342" y2="148"></line>
<text class="sl" x="280" y="142" text-anchor="middle">forward</text>
<rect class="nt" x="292" y="169" width="115" height="22"></rect><text class="sl" x="350" y="184" text-anchor="middle">queue wait 22 ms</text>
<line class="a1" x1="358" y1="216" x2="482" y2="216"></line>
<text class="sl" x="420" y="210" text-anchor="middle">dispatch</text>
<line class="a1" x1="498" y1="250" x2="622" y2="250"></line>
<text class="sl" x="560" y="244" text-anchor="middle">prefill 180 ms</text>
<line class="a2" x1="622" y1="284" x2="498" y2="284"></line>
<text class="sl" x="560" y="278" text-anchor="middle">first token</text>
<line class="a2" x1="482" y1="318" x2="218" y2="318"></line>
<text class="sl" x="350" y="312" text-anchor="middle">first token</text>
<rect class="nt" x="156" y="339" width="109" height="22"></rect><text class="sl" x="210" y="354" text-anchor="middle">TTFT = now − t0</text>
<line class="a2" x1="202" y1="386" x2="78" y2="386"></line>
<text class="sl" x="140" y="380" text-anchor="middle">stream</text>
<line class="a2" x1="622" y1="420" x2="498" y2="420"></line>
<text class="sl" x="560" y="414" text-anchor="middle">decode tokens</text>
<rect class="nt" x="152" y="441" width="115" height="22"></rect><text class="sl" x="210" y="456" text-anchor="middle">ITL = median gap</text>
<line class="a2" x1="202" y1="488" x2="78" y2="488"></line>
<text class="sl" x="140" y="482" text-anchor="middle">final event + x-latency-ledger</text>
<line class="a3" x1="218" y1="522" x2="762" y2="522"></line>
<text class="sl" x="490" y="516" text-anchor="middle">ttft/itl histograms, ctx bucket labels</text>
<line class="a3" x1="778" y1="556" x2="902" y2="556"></line>
<text class="sl" x="840" y="550" text-anchor="middle">own 2 h store via Kafka</text>
<rect class="nt" x="831" y="577" width="159" height="22"></rect><text class="sl" x="910" y="592" text-anchor="middle">burn rate 1h/5m, 6h/30m</text>
<rect class="nt" x="837" y="611" width="146" height="22"></rect><text class="sl" x="910" y="626" text-anchor="middle">absence rule per cell</text>
<line class="a3" x1="902" y1="658" x2="78" y2="658"></line>
<text class="sl" x="490" y="652" text-anchor="middle">page / ticket</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>SDK → Gateway:</b> request + traceparent, t0</li>
  <li><b>Gateway:</b> root span, ledger gw=3</li>
  <li><b>Gateway → Router:</b> forward</li>
  <li><b>Router:</b> queue wait 22 ms</li>
  <li><b>Router → Serving:</b> dispatch</li>
  <li><b>Serving → GPU:</b> prefill 180 ms</li>
  <li><b>GPU → Serving:</b> first token (response)</li>
  <li><b>Serving → Gateway:</b> first token (response)</li>
  <li><b>Gateway:</b> TTFT = now − t0</li>
  <li><b>Gateway → SDK:</b> stream (response)</li>
  <li><b>GPU → Serving:</b> decode tokens (response)</li>
  <li><b>Gateway:</b> ITL = median gap</li>
  <li><b>Gateway → SDK:</b> final event + x-latency-ledger (response)</li>
  <li><b>Gateway → Metrics:</b> ttft/itl histograms, ctx bucket labels (async)</li>
  <li><b>Metrics → Alert evaluator:</b> own 2 h store via Kafka (async)</li>
  <li><b>Alert evaluator:</b> burn rate 1h/5m, 6h/30m</li>
  <li><b>Alert evaluator:</b> absence rule per cell</li>
  <li><b>Alert evaluator → SDK:</b> page / ticket (async)</li>
</ol>

## How it works, step by step {#infra-slo-flow}

<ol class="order">
  <li>SDK stamps t0 and a traceparent; gateway creates the root span and starts the ledger.</li>
  <li>Each hop appends its own duration to the ledger and creates a child span; the serving replica records prefill and per‑token timestamps.</li>
  <li>Gateway computes TTFT at first token and ITL as the median token gap while streaming; on completion it emits histograms with the context‑length bucket label.</li>
  <li>Ledger is returned in the stream’s final event and logged with the request id; traces are sampled 1–10% with exemplars linking slow buckets to traces.</li>
  <li>Alert evaluator computes burn rate per SLO over paired windows (1h/5m, 6h/30m, 3d/6h) and pages/tickets accordingly.</li>
  <li>Absence rules fire if any cell stops emitting; synthetic probes emit the same SLIs continuously.</li>
</ol>

## Deep dives {#infra-slo-deep}

<div class="cards">
  <div><h4>Why these SLIs</h4><ul>
    <li>TTFT is what users perceive as "responsiveness"; ITL is what they perceive as "speed"; completion is "did it work." Total latency is a bad SLI for streams because it scales with output length.</li>
    <li>Prefill cost grows with context; without bucketing, a customer sending 200k contexts blows the p95 for everyone. Bucket, then set per‑bucket targets.</li>
    <li>Measure at the edge (SDK or gateway), attribute with the ledger. Server‑side‑only numbers miss network and client stalls.</li></ul></div>
  <div><h4>Trace and ledger mechanics</h4><ul>
    <li>W3C traceparent on every hop; spans for gw, queue wait, prefill, each decode chunk; sampled 1–10% for traces, 100% for the ledger (cheap, structured).</li>
    <li>Ledger returned to the client so support tickets carry it; also emitted as metrics per hop → you can answer "which hop regressed" in one query.</li>
    <li>Exemplars link a slow histogram bucket to a trace id.</li></ul></div>
  <div><h4>Monitoring the monitor</h4><ul>
    <li>Absence alert: if TTFT series stops reporting for a cell, page (silent failure is the worst failure).</li>
    <li>Synthetic probes per cell/model emit the same SLIs so you see regressions before customers.</li>
    <li>Alert evaluation in a separate failure domain from the serving stack (see #7).</li></ul></div>
</div>

## Don't leave the room without saying {#infra-slo-check}

<ul class="checklist">
  <li>TTFT, ITL/TPOT, completion, availability: why total latency is the wrong SLI for streams</li>
  <li>Bucket by context length or long‑context users poison every percentile</li>
  <li>Measure at the edge, attribute with the ledger</li>
  <li>Trace propagation into stream metadata; sampling + exemplars</li>
  <li>Burn‑rate alerts with short and long windows, not static thresholds</li>
  <li>Absence alerts and synthetic probes</li>
  <li>Evaluate alerts in a separate failure domain</li>
</ul>

## What each level is expected to drive {#infra-slo-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>p95 latency and error rate per service, dashboards, threshold alerts</td><td>Streaming‑specific SLIs</td></tr>
  <tr><td>Senior</td><td>TTFT/ITL/completion SLIs, trace propagation, per‑hop ledger, context bucketing, burn‑rate alerting</td><td>Multi‑window tuning, exemplars</td></tr>
  <tr><td>Staff+</td><td>SLO ownership per hop, error‑budget policy tied to rollouts, cost of instrumentation, customer‑facing diagnostics, absence/dead‑man design</td><td>—</td></tr>
</tbody></table>
