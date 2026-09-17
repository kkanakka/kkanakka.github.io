---
title: "SLOs and monitoring across the token path"
slug: /system-design-notes/infra-slo
sidebar_position: 14
sidebar_label: "SLOs and monitoring across the token path"
description: "medium · Anthropic · TTFT / ITL · trace propagation · latency ledger · burn rate"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/infra-slo/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

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


## Scale, performance and safety targets {#infra-slo-targets}

<p>An SLO design is only as good as the numbers it commits to. These are the ones to state before defining a single SLI.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> 100K QPS at peak on the token path, each request producing one ledger record and a handful of histogram observations — so ~1M metric observations/s, plus 1–10% of requests sampled into full traces.</li>
    <li><b>Data volume:</b> ledger records at ~500 bytes × 100K/s ≈ 50 MB/s of structured logs; traces at 5% sampling with ~10 spans each ≈ 50K spans/s. Labels are the constraint: model × tier × region × cell × context bucket must stay a bounded product.</li>
    <li><b>Growth:</b> request volume ~2× annually, but average context length is growing faster — assume tokens per request 3× a year, which makes context bucketing more important over time, not less.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> the SLO targets themselves — e.g. TTFT p50 &lt; 400 ms, p95 &lt; 1.5 s, p99 &lt; 3 s for short contexts; ITL p50 &lt; 30 ms, p95 &lt; 60 ms; alert detection within 5 minutes of a real regression.</li>
    <li><b>Throughput:</b> instrumentation overhead must stay under 1% of request latency, so the ledger is appended in memory and emitted asynchronously — measurement that costs latency corrupts the thing it measures.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the risks here are self‑inflicted. A trace id or customer id promoted to a metric label is a cardinality explosion; an unbounded context bucket does the same; and a noisy alert rule that pages hundreds of times trains people to ignore the pager, which is its own outage.</li>
    <li><b>Rate limiting:</b> trace sampling capped at 1–10% with a per‑cell ceiling, bounded label sets enforced at ingest, alert deduplication and grouping so one bad rollout is one page, and rate limits on the diagnostics API support tools call.</li>
    <li><b>Data sensitivity:</b> the ledger travels back to the customer, so it must contain timings and nothing else — no prompt content, no internal hostnames, no model internals. Traces may reference a request id but never the payload; retain traces ~7 days, ledgers ~30 days, aggregated SLIs ~13 months.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> the SLO for the token path is four nines (~52 min/year); the alerting path that watches it must be more available than that, because it matters most during the incidents that break everything else.</li>
    <li><b>Degraded mode:</b> metrics pipeline down → serving continues unaffected, because instrumentation is fire‑and‑forget and never blocks a response. Traces unavailable → ledgers still answer "which hop regressed". Alert evaluator degraded → the dead‑man switch and synthetic probes still page.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> eventual. SLI data can be seconds late and slightly lossy; what it cannot be is biased — dropping slow requests preferentially would make every percentile a lie.</li>
    <li><b>Durability:</b> weak for metrics, stronger for the error budget ledger — budget consumption drives release decisions, so it needs to be reconstructible and auditable rather than merely graphable.</li>
    <li><b>Compliance:</b> per‑request diagnostics shared with customers must be scoped to their own requests, and the error‑budget policy needs to be written down: what happens to rollouts when the budget is spent is an organisational commitment, not a dashboard.</li></ul></div>
</div>

## Entities and API {#infra-slo-api}

<p>Trace (traceId, spans[]) · LatencyLedger (per‑hop ms, returned with response) · SLI series (ttft, itl, completion, availability × labels) · SLO (target, window) · ErrorBudget · Alert (burn rate, windows)</p>
<pre><code>Request headers:  traceparent: 00-&lt;trace&gt;-&lt;span&gt;-01
Response trailer / final SSE event:
  x-latency-ledger: gw=3;queue=22;prefill=180;first_token=205;itl_p50=28;tokens=412
Metrics emitted per request (labels: model, tier, region, cell, ctx_bucket):
  ttft_ms histogram · itl_ms histogram · stream_complete counter · request_error counter</code></pre>

## Design {#infra-slo-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/infra-slo/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

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
  <li><b>SDK → Gateway:</b> request + traceparent, t0.
    The clock starts in the client, because that is where the user actually waits — a server‑side timer silently excludes network time and client‑side stalls.
    A W3C <code>traceparent</code> generated here means every downstream hop can attach itself to one trace without inventing its own correlation scheme.</li>
  <li><b>Gateway:</b> root span, ledger gw=3.
    The gateway opens the root span and starts a latency ledger — a small, structured per‑hop timing record that will travel with the request and come back to the caller.
    Ledger and trace are deliberately separate: traces are sampled at a few percent, the ledger is recorded for 100% of requests because it is cheap and structured.
    That combination gives complete per‑hop attribution without the cost of tracing everything.</li>
  <li><b>Gateway → Router:</b> forward.
    Context propagates by header, so each hop adds a child span rather than starting a new trace; a broken propagation here is the usual reason traces mysteriously stop halfway.</li>
  <li><b>Router:</b> queue wait 22 ms.
    Queue time is recorded as its own hop rather than folded into service time, because the two have completely different remedies — more capacity versus faster code.
    In practice queue wait is the first thing to blow up under load, so isolating it makes saturation obvious in a single query.</li>
  <li><b>Router → Serving:</b> dispatch.
    The span records which cell and replica were chosen, so a regression isolated to one cell or one model version is visible without a separate investigation.</li>
  <li><b>Serving → GPU:</b> prefill 180 ms.
    Prefill is where context length turns into latency, and it scales with input tokens — which is exactly why SLIs must be bucketed by context length.
    Recording it separately from decode is what lets you say "long‑context users got slower" rather than "p95 went up".</li>
  <li><b>GPU → Serving:</b> first token (response).
    The first token is the moment the user stops waiting and starts reading, which is why it gets its own metric rather than being part of a total.</li>
  <li><b>Serving → Gateway:</b> first token (response).
    Each hop stamps its own arrival time, so the ledger reconstructs where the time actually went without needing clock synchronisation across machines — only durations within a hop are compared.</li>
  <li><b>Gateway:</b> TTFT = now − t0.
    Time to first token is the responsiveness SLI, measured at the edge so it includes queueing, routing and prefill as the user experiences them.
    Total request latency is deliberately <em>not</em> the SLI: it grows with output length, so a long answer would look like an outage.</li>
  <li><b>Gateway → SDK:</b> stream (response).
    Streaming starts immediately; from here the user's experience is governed by the gaps between tokens rather than by any single number.</li>
  <li><b>GPU → Serving:</b> decode tokens (response).
    Per‑token timestamps are recorded as the stream proceeds, which makes the distribution of gaps available rather than just an average.
    A stall halfway through a response is invisible in a mean and obvious in a p95 of inter‑token latency.</li>
  <li><b>Gateway:</b> ITL = median gap.
    Inter‑token latency is the "speed" SLI — how fast the text appears once it starts — and together with TTFT it fully describes a streaming experience.
    Using the median gap per request, then taking percentiles across requests, avoids one pathological pause dominating a request's own number.</li>
  <li><b>Gateway → SDK:</b> final event + x-latency-ledger (response).
    Returning the ledger to the client is what turns a support ticket from "it felt slow" into a per‑hop breakdown the customer can paste in.
    It contains timings only — no prompt content, no internal topology — because it crosses a trust boundary.</li>
  <li><b>Gateway → Metrics:</b> ttft/itl histograms, ctx bucket labels (async).
    Emission is asynchronous and fire‑and‑forget, so instrumentation can never add latency to or fail a customer request.
    Histograms rather than pre‑computed percentiles are emitted, because percentiles cannot be averaged across cells or re‑aggregated over time.
    The context bucket label is the crucial one: without it, a handful of 200K‑token requests poisons the p95 that everyone else is judged by.</li>
  <li><b>Metrics → Alert evaluator:</b> own 2 h store via Kafka (async).
    The evaluator consumes the stream independently and keeps its own short window, so it does not depend on the query path or the long‑term store.
    Alerting that runs through the same infrastructure it is watching goes blind during exactly the incidents that matter.</li>
  <li><b>Alert evaluator:</b> burn rate 1h/5m, 6h/30m.
    Alerts fire on how fast the error budget is being consumed, not on a static threshold — a 2% error rate for five minutes and for five hours are completely different events.
    Paired windows are what make this both fast and quiet: the long window establishes that the burn is real, the short one confirms it is still happening right now.
    Fast burn pages immediately; slow burn opens a ticket, because not every budget problem is worth waking someone.</li>
  <li><b>Alert evaluator:</b> absence rule per cell.
    A cell that stops reporting looks exactly like a healthy cell to every threshold rule, so absence is checked explicitly per cell and per model.
    Synthetic probes emit the same SLIs continuously, which means the series never legitimately goes empty and an absence alert is unambiguous.</li>
  <li><b>Alert evaluator → SDK:</b> page / ticket (async).
    Routing depends on burn rate: fast burn pages a human, slow burn files a ticket, and both carry the ledger breakdown and exemplar traces so the first question — which hop? — is already answered.
    Deduplication and grouping keep one bad rollout to one page; an alerting system that cries wolf is worse than none, because people stop reading it.</li>
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

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/infra-slo/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

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


## Trade-offs {#infra-slo-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>What to measure</td><td>TTFT, ITL and completion</td><td>The simplicity of one "latency" number that everyone already understands</td><td>Total latency is fine for non‑streaming APIs; for streams it scales with output length and makes long answers look like outages</td></tr>
  <tr><td>Where to measure</td><td>At the edge (SDK/gateway), attributed by ledger</td><td>Edge numbers include client network conditions you cannot fix</td><td>Server‑side only when you are tuning a specific hop; never for the customer‑facing SLO, which must reflect what the user waited for</td></tr>
  <tr><td>Slicing</td><td>Bucket by context length</td><td>More series, and per‑bucket targets to agree and maintain</td><td>Skip bucketing only if context lengths are uniform — otherwise a few long‑context users set the p95 for everyone</td></tr>
  <tr><td>Trace coverage</td><td>1–10% sampled traces, 100% ledgers</td><td>The specific slow request may not have a trace</td><td>Raise sampling during an incident or for a specific customer; 100% tracing at 100K QPS costs more than it returns</td></tr>
  <tr><td>Alerting rule</td><td>Multi‑window burn rate</td><td>Harder to explain than "page if p95 &gt; 2 s"</td><td>Static thresholds are acceptable for a small service; at scale they either page constantly or miss slow burns entirely</td></tr>
  <tr><td>Alert domain</td><td>Evaluators independent of the serving and query stack</td><td>Duplicate infrastructure to run and keep in sync</td><td>Never share it — the correlated failure is the whole point, and a shared dependency means silence during the worst incidents</td></tr>
  <tr><td>Customer diagnostics</td><td>Return the per‑hop ledger to the client</td><td>Exposes some internal structure and a support surface to maintain</td><td>Withhold it only where the hop names themselves are sensitive; the support cost saved is usually far larger</td></tr>
</tbody></table>

## Safety-first design {#infra-slo-safety}

<div class="cards">
  <div><h4>Measurement that cannot hurt the thing measured</h4><ul>
    <li><b>Fire‑and‑forget emission.</b> Metrics and ledgers are written asynchronously with bounded buffers, so a metrics outage can never fail or slow a customer request.</li>
    <li><b>Under 1% overhead, enforced.</b> Instrumentation cost is itself measured, because a tracing system that adds 50 ms has changed the latency it reports.</li>
    <li><b>Never bias the sample.</b> Sampling is decided at the start of a request, not at the end — dropping slow requests because they timed out would quietly make every percentile a lie.</li>
    <li><b>Bounded labels.</b> The label set is a fixed product of model, tier, region, cell and context bucket; ids never become labels, and exemplars carry the per‑request detail instead.</li></ul></div>
  <div><h4>Alerts people still trust at 3am</h4><ul>
    <li><b>Burn rate, not thresholds.</b> Paging is tied to how fast the error budget is being spent, so severity matches consequence rather than a line on a graph.</li>
    <li><b>Fast burn pages, slow burn tickets.</b> Two different problems get two different responses, which is what keeps the pager meaningful.</li>
    <li><b>One incident, one page.</b> Deduplication and grouping mean a bad rollout does not produce four hundred notifications and a reflex to silence them.</li>
    <li><b>Every page carries its evidence.</b> The ledger breakdown and exemplar traces ship with the alert, so the responder starts at "which hop" rather than at "is this real".</li></ul></div>
  <div><h4>Silence is the failure you must design for</h4><ul>
    <li><b>Absence rules per cell and model.</b> A cell that stops emitting is indistinguishable from a healthy one to a threshold rule — so the gap itself is alerted on.</li>
    <li><b>Synthetic probes always running.</b> Continuous probes per cell mean the SLI series is never legitimately empty, which makes absence unambiguous.</li>
    <li><b>Dead‑man switch outside the stack.</b> The evaluator proves liveness to an external service, so a total failure of monitoring still reaches a human.</li>
    <li><b>Ledgers carry timings only.</b> What crosses back to the customer is durations and request ids — never prompt content, never internal hostnames.</li></ul></div>
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
