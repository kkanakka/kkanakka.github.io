---
title: "High‑concurrency Inference API (batch service in front of GPUs)"
slug: /system-design-notes/inference-api
sidebar_position: 8
sidebar_label: "High‑concurrency Inference API (batch se…"
description: "hard · Anthropic‑style · batching · pull dispatch · response routing · capacity feedback"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/inference-api/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">hard · Anthropic‑style · batching · pull dispatch · response routing · capacity feedback</span>
</header>
<p>Clients call a fixed synchronous <code>POST /v1/inference</code> and wait. Behind it, you own everything: how requests are queued, batched, sent to a limited GPU pool, and routed back to the exact open socket that's waiting. The model API can't change; the infrastructure is the interview. This is the flash‑sale problem with GPUs as the scarce inventory and latency instead of fairness as the second axis.</p>

## Requirements and the numbers that drive everything {#ia-requirements}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Submit a prompt, get the model output on the same HTTP connection</li>
      <li>Batch individual requests for the GPU</li>
      <li>Tiers: free / paid / enterprise with priority</li>
      <li>Tiered rate limiting</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>1K RPS now, 10K RPS later, peaks 3×</li>
      <li>P95 &lt; 500 ms end to end (queue wait + inference)</li>
      <li>99.9% available, degrade gracefully</li>
      <li>GPU utilization 70–80%: cost vs. spike headroom</li>
    </ol>
  </div>
</div>
<pre><code>Per batch:   50 ms inference + ~20 ms batching wait + ~5 ms transfer = 75 ms
Per GPU:     1000 / 75 ≈ 13.3 batches/s × 32 = ~426 RPS
1K RPS:      1000 / 426 = 2.35 GPUs → ÷ 0.7 utilization ≈ 4 GPUs
10K RPS:     23.5 → ≈ 34 GPUs;  3× peak → ~100 GPUs
Latency:     2 (LB) + 1 + 5 (gateway) + ~20 (queue) + 1 + 4 (claim) + 50 (GPU) + 8 (return) ≈ 90–130 ms</code></pre>
<div class="note"><b>Why 70%, said properly:</b> this is a queueing system. Wait time grows like 1/(1−ρ); at ρ=0.7 a small spike adds milliseconds, at ρ=0.95 the same spike adds seconds. The 30% you "waste" is the time it takes autoscaling to provision a GPU (minutes, because the model has to load). You buy that time with idle capacity or you buy it with 429s.</div>

## Architecture {#ia-diagram}

<figure>
<svg viewBox="0 0 980 470" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Inference API architecture: clients to load balancer to API gateway with rate limiter; gateway enqueues to per-tier Redis lists and holds the connection; batcher pulls in priority order into inflight lists, forms batches, pushes to a batch queue; GPU workers BLPOP batches, run inference, publish per-request responses to the owning gateway's pub/sub channel; gateway resolves pending socket; heartbeats feed healthy GPU count to the rate limiter; Postgres for audit">
  <defs>
    <marker id="e1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker>
    <marker id="e2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker>
    <marker id="e3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker>
  </defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:13px;fill:#1B2430;font-weight:600}.ts{font-size:11px;fill:#5B6673}.tm{font-size:11px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#e1)}.fp{stroke:#6B2D6B;stroke-width:1.6;fill:none;marker-end:url(#e2);stroke-dasharray:5 4}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#e3);stroke-dasharray:2 4}.lbl{font-size:11px;fill:#1F4E9E}.lblp{font-size:11px;fill:#6B2D6B}.lbla{font-size:11px;fill:#B45309}</style>

  <rect class="box" x="20" y="180" width="90" height="50"></rect><text class="tb" x="65" y="201" text-anchor="middle">Clients</text><text class="ts" x="65" y="218" text-anchor="middle">sync HTTP</text>
  <rect class="box" x="140" y="180" width="70" height="50"></rect><text class="tb" x="175" y="209" text-anchor="middle">LB</text>
  <rect class="box" x="240" y="150" width="150" height="110"></rect><text class="tb" x="315" y="170" text-anchor="middle">API Gateway (×G)</text>
  <text class="ts" x="250" y="188">auth · tier lookup</text><text class="ts" x="250" y="202">dynamic rate limit</text><text class="ts" x="250" y="216">stamp gateway_id</text><text class="ts" x="250" y="230">enqueue by tier</text><text class="ts" x="250" y="244">pending{request_id→socket}</text>

  <rect class="box" x="440" y="40" width="150" height="36" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tm" x="515" y="62" text-anchor="middle">queue:enterprise</text>
  <rect class="box" x="440" y="84" width="150" height="36" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tm" x="515" y="106" text-anchor="middle">queue:paid</text>
  <rect class="box" x="440" y="128" width="150" height="36" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tm" x="515" y="150" text-anchor="middle">queue:free</text>
  <text class="ts" x="440" y="182">Redis lists · RPOPLPUSH → inflight:{tier}:{batcher}</text>

  <rect class="box" x="440" y="220" width="150" height="80"></rect><text class="tb" x="515" y="240" text-anchor="middle">Batcher (×B)</text><text class="ts" x="450" y="258">drain in priority order</text><text class="ts" x="450" y="272">32 reqs OR 40 ms</text><text class="ts" x="450" y="286">LPUSH batch_queue</text>

  <rect class="box" x="640" y="220" width="130" height="36" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tm" x="705" y="242" text-anchor="middle">batch_queue</text>

  <rect class="box" x="810" y="180" width="150" height="120" stroke="#0F766E"></rect><text class="tb" x="885" y="200" text-anchor="middle">GPU workers (×N)</text>
  <text class="ts" x="820" y="218">BLPOP batch_queue</text><text class="ts" x="820" y="232">run_inference ~50 ms</text><text class="ts" x="820" y="246">PUBLISH per request</text><text class="ts" x="820" y="260">→ responses:{gateway_id}</text><text class="ts" x="820" y="280">heartbeat → gpu:{id}</text>

  <rect class="box" x="440" y="340" width="150" height="50" stroke="#B45309"></rect><text class="tb" x="515" y="360" text-anchor="middle">Reaper</text><text class="ts" x="515" y="377" text-anchor="middle">stale inflight → back to queue</text>
  <rect class="box" x="640" y="340" width="130" height="50" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="705" y="360" text-anchor="middle">Redis pub/sub</text><text class="ts" x="705" y="377" text-anchor="middle">responses:{gateway_id}</text>
  <rect class="box" x="810" y="340" width="150" height="50"></rect><text class="tb" x="885" y="360" text-anchor="middle">healthy_gpu_count</text><text class="ts" x="885" y="377" text-anchor="middle">from heartbeats · feeds limiter</text>
  <rect class="box" x="240" y="400" width="150" height="50"></rect><text class="tb" x="315" y="420" text-anchor="middle">Postgres</text><text class="ts" x="315" y="437" text-anchor="middle">request audit, async write</text>

  <path class="f" d="M110 205 L138 205"></path><path class="f" d="M210 205 L238 205"></path>
  <path class="f" d="M390 180 L438 60"></path><path class="f" d="M390 195 L438 102"></path><path class="f" d="M390 210 L438 146"></path><text class="lbl" x="392" y="128">enqueue</text>
  <path class="f" d="M515 164 L515 218"></path><text class="lbl" x="522" y="196">pull</text>
  <path class="f" d="M590 240 L638 240"></path><path class="f" d="M770 240 L808 240"></path><text class="lbl" x="774" y="232">claim</text>
  <path class="fp" d="M840 300 C 820 330, 790 360, 772 365"></path><text class="lblp" x="780" y="322">publish</text>
  <path class="fp" d="M640 365 C 520 420, 420 320, 392 262"></path><text class="lblp" x="470" y="318">deliver to owning gateway</text>
  <path class="fp" d="M240 240 C 200 260, 130 260, 110 222"></path><text class="lblp" x="120" y="262">respond on held socket</text>
  <path class="fa" d="M885 300 L885 338"></path><path class="fa" d="M810 372 C 700 430, 400 440, 330 262"></path><text class="lbla" x="560" y="432">capacity feedback → limiter</text>
  <path class="fa" d="M315 260 L315 398"></path>
  <text class="ts" x="20" y="465">Solid = request, dashed plum = response, dotted amber = control/feedback. No component pushes to a GPU; GPUs pull.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 678" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Inference API request flow between components">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="7" y="14" width="126" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Client</text>
<line class="ln" x1="70" y1="48" x2="70" y2="658"></line>
<rect class="sb" x="147" y="14" width="126" height="34"></rect><text class="st" x="210" y="36" text-anchor="middle">Gateway</text>
<line class="ln" x1="210" y1="48" x2="210" y2="658"></line>
<rect class="sb" x="287" y="14" width="126" height="34"></rect><text class="st" x="350" y="36" text-anchor="middle">Redis queues</text>
<line class="ln" x1="350" y1="48" x2="350" y2="658"></line>
<rect class="sb" x="427" y="14" width="126" height="34"></rect><text class="st" x="490" y="36" text-anchor="middle">Batcher</text>
<line class="ln" x1="490" y1="48" x2="490" y2="658"></line>
<rect class="sb" x="567" y="14" width="126" height="34"></rect><text class="st" x="630" y="36" text-anchor="middle">batch_queue</text>
<line class="ln" x1="630" y1="48" x2="630" y2="658"></line>
<rect class="sb" x="707" y="14" width="126" height="34"></rect><text class="st" x="770" y="36" text-anchor="middle">GPU worker</text>
<line class="ln" x1="770" y1="48" x2="770" y2="658"></line>
<rect class="sb" x="847" y="14" width="126" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Redis pub/sub</text>
<line class="ln" x1="910" y1="48" x2="910" y2="658"></line>
<line class="a1" x1="78" y1="80" x2="202" y2="80"></line>
<text class="sl" x="140" y="74" text-anchor="middle">POST /v1/inference</text>
<rect class="nt" x="109" y="101" width="202" height="22"></rect><text class="sl" x="210" y="116" text-anchor="middle">auth, tier, dynamic rate limit</text>
<line class="a1" x1="218" y1="148" x2="342" y2="148"></line>
<text class="sl" x="280" y="142" text-anchor="middle">LPUSH queue:{tier} (gateway_id stamped)</text>
<rect class="nt" x="103" y="169" width="214" height="22"></rect><text class="sl" x="210" y="184" text-anchor="middle">hold socket; pending[request_id]</text>
<line class="a1" x1="482" y1="216" x2="358" y2="216"></line>
<text class="sl" x="420" y="210" text-anchor="middle">RPOPLPUSH → inflight (priority order)</text>
<line class="a2" x1="358" y1="250" x2="482" y2="250"></line>
<text class="sl" x="420" y="244" text-anchor="middle">requests</text>
<rect class="nt" x="417" y="271" width="146" height="22"></rect><text class="sl" x="490" y="286" text-anchor="middle">32 collected or 40 ms</text>
<line class="a1" x1="498" y1="318" x2="622" y2="318"></line>
<text class="sl" x="560" y="312" text-anchor="middle">LPUSH batch</text>
<line class="a1" x1="762" y1="352" x2="638" y2="352"></line>
<text class="sl" x="700" y="346" text-anchor="middle">BLPOP batch</text>
<line class="a2" x1="638" y1="386" x2="762" y2="386"></line>
<text class="sl" x="700" y="380" text-anchor="middle">batch</text>
<rect class="nt" x="700" y="407" width="140" height="22"></rect><text class="sl" x="770" y="422" text-anchor="middle">run inference ~50 ms</text>
<line class="a1" x1="778" y1="454" x2="902" y2="454"></line>
<text class="sl" x="840" y="448" text-anchor="middle">PUBLISH responses:{gateway_id} per request</text>
<line class="a2" x1="902" y1="488" x2="218" y2="488"></line>
<text class="sl" x="560" y="482" text-anchor="middle">response event</text>
<rect class="nt" x="112" y="509" width="196" height="22"></rect><text class="sl" x="210" y="524" text-anchor="middle">resolve pending by request_id</text>
<line class="a2" x1="202" y1="556" x2="78" y2="556"></line>
<text class="sl" x="140" y="550" text-anchor="middle">HTTP response</text>
<line class="a3" x1="482" y1="590" x2="358" y2="590"></line>
<text class="sl" x="420" y="584" text-anchor="middle">trim inflight on ack</text>
<rect class="nt" x="672" y="611" width="196" height="22"></rect><text class="sl" x="770" y="626" text-anchor="middle">heartbeat → healthy_gpu_count</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Client → Gateway:</b> POST /v1/inference</li>
  <li><b>Gateway:</b> auth, tier, dynamic rate limit</li>
  <li><b>Gateway → Redis queues:</b> LPUSH queue:{tier} (gateway_id stamped)</li>
  <li><b>Gateway:</b> hold socket; pending[request_id]</li>
  <li><b>Batcher → Redis queues:</b> RPOPLPUSH → inflight (priority order)</li>
  <li><b>Redis queues → Batcher:</b> requests (response)</li>
  <li><b>Batcher:</b> 32 collected or 40 ms</li>
  <li><b>Batcher → batch_queue:</b> LPUSH batch</li>
  <li><b>GPU worker → batch_queue:</b> BLPOP batch</li>
  <li><b>batch_queue → GPU worker:</b> batch (response)</li>
  <li><b>GPU worker:</b> run inference ~50 ms</li>
  <li><b>GPU worker → Redis pub/sub:</b> PUBLISH responses:{gateway_id} per request</li>
  <li><b>Redis pub/sub → Gateway:</b> response event (response)</li>
  <li><b>Gateway:</b> resolve pending by request_id</li>
  <li><b>Gateway → Client:</b> HTTP response (response)</li>
  <li><b>Batcher → Redis queues:</b> trim inflight on ack (async)</li>
  <li><b>GPU worker:</b> heartbeat → healthy_gpu_count</li>
</ol>

## One request, step by step {#ia-flow}

<ol class="order">
  <li>Client → LB → a gateway instance. Gateway authenticates the API key, resolves tier, checks the rate limiter (Redis counter, tier‑aware, capacity‑aware).</li>
  <li>Gateway stamps <code>gateway_id</code> onto the request, <code>LPUSH queue:{tier}</code>, keeps the HTTP connection open in an async pending map keyed by <code>request_id</code>, and sets a timeout.</li>
  <li>A batcher drains queues enterprise → paid → free with <code>RPOPLPUSH queue:{tier} inflight:{tier}:{batcher}</code> (atomic move, so a crash can't lose a request) until it has 32 or 40 ms elapsed, then <code>LPUSH batch_queue</code>.</li>
  <li>Any idle GPU worker <code>BLPOP batch_queue</code>. Atomic claim, no scheduler, no race.</li>
  <li>Worker runs the batch (~50 ms), then publishes each result to <code>responses:{gateway_id}</code> since one batch spans many gateways.</li>
  <li>The owning gateway's subscriber receives, looks up the socket by <code>request_id</code>, writes the response, deletes the pending entry; batcher trims the inflight list on ack.</li>
  <li>Async: write the request row (status, latency) to Postgres for audit and billing; worker heartbeat updates the registry.</li>
</ol>

## Deep analysis: the decisions and why {#ia-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/inference-api/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

### 1. Sync outside, async inside: where does the connection live?

<ul>
  <li>The socket can only be answered by the process holding it. So the gateway must be the one that receives the result: <b>route responses by gateway_id, not by "any gateway."</b> Stamping gateway_id at enqueue time is the whole trick.</li>
  <li>Pending map in gateway memory (request_id → socket future), plus a Redis record <code>request_id → gateway_id</code> with TTL = request timeout for observability and reaping.</li>
  <li>If a gateway dies, its sockets die with it; the client gets a connection error and retries. Results for those requests are published to a channel nobody listens to. That's acceptable at 99.9%; if you want better, make the GPU output durable (Redis stream keyed by request_id with TTL) so a retry with the same request_id can be served from the buffer instead of re‑running inference.</li>
  <li>Redis pub/sub is fire‑and‑forget: a subscriber that's momentarily disconnected misses the message. Streams (<code>XADD</code>/<code>XREAD</code>) give at‑least‑once at slightly higher cost. Name the trade‑off; pick pub/sub for latency and add a short reaper timeout that turns a lost message into a 504 rather than a hang.</li>
</ul>

### 2. Batching: the throughput/latency dial

<ul>
  <li>Send when <b>full (32) or timed out (40 ms)</b>. Under load batches are full and latency is bounded by the GPU; under light load the timeout bounds latency and utilization drops, which is fine because there's nothing to utilize.</li>
  <li>Both knobs come from the SLA: 500 ms P95 − 50 ms inference − overheads leaves a budget; the timeout must be a fraction of it, and batch size is whatever the GPU can do in ~50 ms.</li>
  <li>Adaptive batching: shrink the timeout as queue depth grows (no point waiting when the queue already has 32), grow it when idle. Interviewers like hearing "the timeout is a function of queue depth."</li>
  <li><b>Priority within a batch:</b> drain enterprise first, but reserve a slice for free tier so it doesn't starve forever under sustained paid load (weighted draining, e.g. 60/30/10 when all queues are non‑empty). Strict priority + starvation is the follow‑up question.</li>
  <li><b>If the model is an LLM:</b> outputs have variable length, so static batches suffer head‑of‑line blocking (batch waits for the longest generation). Real serving uses <b>continuous batching</b>: admit new sequences every decode step as others finish. Say this even if the given API hides it; it shows you know why "50 ms per batch" is a simplification.</li>
</ul>

### 3. Pull, not push, to GPUs

<ul>
  <li>Push needs a scheduler with a fresh view of every GPU's load. That view is always stale; with multiple batchers they all pick the same "least loaded" GPU on the same tick and stampede it.</li>
  <li>Pull (<code>BLPOP</code>) makes the queue the scheduler: whoever is idle takes the next batch. Atomic, self‑balancing, no coordination, and retry‑on‑another‑GPU is free (re‑push the batch).</li>
  <li>Push earns its complexity only for heterogeneous pools, model affinity/routing, or canaries. Say when you'd switch.</li>
  <li>The GPU registry (heartbeats) still exists, but for <b>capacity feedback and dashboards</b>, not dispatch.</li>
</ul>

### 4. Rate limiting that knows the fleet size

<ul>
  <li>Static limits are wrong the moment half the GPUs die. Capacity = healthy_gpus × 426 × 0.7, recomputed from heartbeats every few seconds.</li>
  <li>Tiered shedding by queue depth: &gt;100 → reject free, &gt;500 → reject everything but enterprise, at capacity → throttle free. Return 429 with Retry‑After so clients back off instead of hammering.</li>
  <li>Feedback must flow in seconds (pub/sub or a metrics tick), not minutes, or the queue balloons and P95 breaks before the limiter notices.</li>
  <li>This is admission control: the same idea as the flash‑sale waiting room, expressed as reject‑early instead of hold‑in‑line because the SLA is sub‑second.</li>
</ul>

### 5. Failure handling

<ul>
  <li><b>Batcher crash:</b> requests are in <code>inflight:{tier}:{batcher}</code>, not lost. A reaper moves stale inflight entries (older than a threshold) back to the queue. Run ≥2 batchers so throughput doesn't drop to zero.</li>
  <li><b>GPU crash mid‑batch:</b> batch re‑pushed to <code>batch_queue</code> with retry_count; after 2 retries → DLQ, clients get 5xx. Cap retries or an outage amplifies load 2–3×.</li>
  <li><b>Timeouts:</b> queue age 2 s (drop and 503 rather than serve a stale answer nobody's waiting for), GPU 3 s, total 4 s. Hard caps sit above the P95 target on purpose.</li>
  <li><b>Redis down:</b> queues, pending routing, and rate limits all vanish. Sentinel/Cluster for failover; accept that in‑flight requests during failover fail fast. If that's unacceptable, Kafka for the queue (durable, ~5–10 ms more latency) and keep Redis only for routing/limits.</li>
  <li><b>Idempotency:</b> clients retry on timeout; if the fixed API lets clients send a request id, dedupe on it and serve the buffered result; if not, accept duplicate inference as the cost of the fixed contract and say so.</li>
</ul>

### 6. Spikes and autoscaling

<table>
  <tbody><tr><th>Window</th><th>What happens</th><th>What saves you</th></tr>
  <tr><td>0–10 s</td><td>Queue grows, latency rises</td><td>The 30% utilization buffer absorbs it</td></tr>
  <tr><td>10–60 s</td><td>Autoscale triggers; some 429s to free tier</td><td>Dynamic limiter sheds the lowest tier first</td></tr>
  <tr><td>1–5 min</td><td>New GPUs booting, model weights loading</td><td>Warm pool / pre‑baked images shorten this</td></tr>
  <tr><td>5–10 min</td><td>Queue drains, latency normal</td><td>Scale down slowly, ≤10–20% at a time, 5–10 min cooldown</td></tr>
</tbody></table>
<p>Triggers: utilization &gt;80% for 2 min, queue depth &gt;100 for 1 min, or P95 &gt;1.5× SLA for 1 min → scale up. Scale down only after 10 quiet minutes. Aggressive up, conservative down.</p>

## Where the sample solution is thin (bring these up yourself) {#ia-critique}

<ul>
  <li><b>Streaming.</b> Real LLM APIs stream tokens; a sync JSON response is the toy version. If the fixed API streams, the gateway holds an SSE response and the worker publishes deltas to the same channel; batching becomes continuous batching. Ask the interviewer which contract you're on.</li>
  <li><b>Batching across heterogeneous requests.</b> Different <code>model</code> or <code>max_tokens</code> can't share a batch. Queue key becomes <code>queue:{model}:{tier}</code> and <code>batch_queue:{model}</code>; workers subscribe to the models they host. Multi‑model routing is where push scheduling starts to justify itself.</li>
  <li><b>Fairness per user, not just per tier.</b> One enterprise customer sending 5K RPS starves the others in its tier. Add per‑API‑key concurrency limits and fair queueing (round‑robin across keys inside a tier).</li>
  <li><b>Prompt size.</b> Cost scales with tokens, not requests. Rate limit in tokens/min; long prompts also dominate batch time, so consider sorting/bucketing by length to keep batches uniform.</li>
  <li><b>The batcher is an extra hop.</b> Workers could pull directly from tier queues and batch themselves (each worker is its own batcher). Fewer moving parts, one fewer Redis hop; you lose the central place to implement fairness. Worth naming as the simpler alternative.</li>
  <li><b>Postgres on the hot path.</b> Write the audit row asynchronously (Kafka → consumer) or the DB becomes a second throughput ceiling at 10K RPS.</li>
  <li><b>Redis as a single hot spot.</b> Every request touches Redis 4–5 times (limit, enqueue, inflight, batch queue, pub/sub). At 10K RPS that's ~50K ops/s on one node, within limits but close; shard queues by model or run separate Redis instances for queues vs. routing vs. limits.</li>
  <li><b>Observability.</b> Queue depth per tier, batch fill ratio, GPU utilization, P50/P95/P99 split into queue wait vs. inference, 429 rate by tier, DLQ size. Alert on SLA, not CPU.</li>
</ul>

## Trade‑offs table (say these in pairs) {#ia-tradeoffs}

<table>
  <tbody><tr><th>Choice</th><th>Gains</th><th>Costs</th></tr>
  <tr><td>Separate queue per tier</td><td>Isolation, priority, simple shedding</td><td>More keys to drain; starvation risk without weighting</td></tr>
  <tr><td>70% utilization target</td><td>Spike headroom, stable latency</td><td>~40% more GPUs than raw math</td></tr>
  <tr><td>Timeout‑based batching</td><td>Bounded latency at low load, full batches at high</td><td>Variable batch sizes, tuning</td></tr>
  <tr><td>Redis queues</td><td>~1 ms hops</td><td>Not durable; failover loses in‑flight (Kafka if that matters)</td></tr>
  <tr><td>Pull dispatch</td><td>Race‑free, self‑balancing, free retries</td><td>No global scheduling smarts</td></tr>
  <tr><td>Pub/sub for responses</td><td>Lowest latency</td><td>At‑most‑once; need timeouts to turn loss into errors</td></tr>
  <tr><td>Sync HTTP contract</td><td>Simple clients</td><td>Held connections per in‑flight request; gateway needs async I/O and high fd limits</td></tr>
</tbody></table>

## Concurrency control: where optimistic locking fits and which stores do it {#ia-locking}

<p>Optimistic locking = read a version, do your work, write back only if the version hasn't changed (compare‑and‑set). No lock is held, so it suits short, low‑contention updates where a retry is cheap. Pessimistic = take a lock first (<code>SELECT … FOR UPDATE</code>, Redis <code>SET NX</code>); suits high contention or long critical sections.</p>

### Where it applies here

<table>
  <tbody><tr><th>Spot</th><th>Race</th><th>Mechanism</th></tr>
  <tr><td>Request status row</td><td>Reaper requeues a "stuck" request that a slow worker is still finishing → two results for one request</td><td>CAS on status: <code>UPDATE requests SET status='completed', output=? WHERE id=? AND status='processing' AND version=?</code>. First writer wins, second gets 0 rows and drops its result.</td></tr>
  <tr><td>Claiming a request/batch</td><td>Two batchers or two GPUs take the same item</td><td>Not optimistic: <code>RPOPLPUSH</code> / <code>BLPOP</code> are atomic pops. The queue is the lock.</td></tr>
  <tr><td>Routing key <code>request_id → gateway_id</code></td><td>Duplicate submit from client retry</td><td><code>SET key val NX PX ttl</code>; second write fails → return the in‑flight result instead of re‑running inference.</td></tr>
  <tr><td>Rate‑limit counters, healthy_gpu_count</td><td>Concurrent increments</td><td>No locking needed: <code>INCRBY</code> is atomic. Optimistic locking is for read‑modify‑write of a value, counters skip the read.</td></tr>
  <tr><td>Model registry "current version" pointer</td><td>Two rollouts flip it at once</td><td>CAS on the pointer's revision (etcd/ZooKeeper) or a versioned row in Postgres.</td></tr>
</tbody></table>

### Stores that support it and the syntax to name

<table>
  <tbody><tr><th>Store</th><th>How</th><th>Notes</th></tr>
  <tr><td>Postgres / MySQL</td><td><code>UPDATE t SET …, version = version+1 WHERE id=? AND version=?</code>; check rows affected = 1</td><td>Default choice. Works on any column, not just a version number (e.g. <code>AND status='processing'</code>).</td></tr>
  <tr><td>DynamoDB</td><td><code>ConditionExpression: "version = :expected"</code> on PutItem/UpdateItem; <code>ConditionalCheckFailedException</code> on conflict</td><td>Native, cheap, single item. Transactions across items via TransactWriteItems.</td></tr>
  <tr><td>Cassandra</td><td>Lightweight transaction: <code>UPDATE … IF version = ?</code></td><td>Paxos under the hood; ~4× slower than a plain write. Fine for state rows, not for hot counters.</td></tr>
  <tr><td>MongoDB</td><td><code>findOneAndUpdate({_id, version}, {$set…, $inc:{version:1}})</code></td><td>Single‑document atomicity; returns null on conflict.</td></tr>
  <tr><td>Redis</td><td><code>WATCH key; MULTI; …; EXEC</code> (aborts if key changed) or a Lua script that checks then sets</td><td>Lua is simpler and truly atomic; WATCH is the classic optimistic form.</td></tr>
  <tr><td>etcd / ZooKeeper</td><td>Txn <code>if mod_revision == X then put</code> / <code>setData(path, data, expectedVersion)</code></td><td>Consensus‑backed; use for config/leader/registry pointers, not per‑request state.</td></tr>
  <tr><td>S3</td><td>Conditional write with <code>If-Match: etag</code> / <code>If-None-Match: *</code></td><td>Useful for checkpoint or manifest files in the training plane.</td></tr>
</tbody></table>
<div class="note"><b>Interview line:</b> "Pops from the queue are atomic so claiming needs no lock; the only read‑modify‑write is the request's status transition, and I guard that with a conditional update on status/version so a reaper‑requeued duplicate can't overwrite a finished result. Any store with a conditional write does this; I'd use Postgres's <code>WHERE version=?</code> or DynamoDB's condition expression."</div>

## Don't leave the room without saying {#ia-checklist}

<ul class="checklist">
  <li>Capacity math with utilization headroom, and why headroom is the autoscaling lag in disguise</li>
  <li>Batch = 32 or 40 ms, both derived from the SLA; adaptive timeout by queue depth</li>
  <li>GPUs pull from a shared batch queue; explain the push stampede you're avoiding</li>
  <li>Response routing: gateway_id stamped at enqueue, per‑gateway pub/sub channel, pending map by request_id</li>
  <li>RPOPLPUSH to inflight + reaper for crash safety; retries capped, DLQ</li>
  <li>Rate limiter reads healthy GPU count; tiered shedding by queue depth; 429 + Retry‑After</li>
  <li>Timeouts at every stage; queue‑age drop so you don't compute answers nobody waits for</li>
  <li>Spike timeline and autoscale triggers; scale up fast, down slow</li>
  <li>Continuous batching / streaming if the model is an LLM; per‑model queues; token‑based limits</li>
  <li>Redis durability caveat and the Kafka alternative</li>
</ul>

## What each level is expected to drive {#ia-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Gateway → queue → batcher → GPU → response; basic batching; why hold the connection</td><td>Response routing back to the right gateway, retries</td></tr>
  <tr><td>Senior</td><td>Capacity math, tiered queues, pull dispatch and why, crash‑safe queue ops, dynamic rate limiting, timeouts/DLQ</td><td>Continuous batching, per‑model routing</td></tr>
  <tr><td>Staff+</td><td>Everything above plus the critique list: streaming contract, fairness per key, token‑based limits, Redis hot‑spot math, batcher‑less alternative, durability vs latency choice with numbers</td><td>—</td></tr>
</tbody></table>
