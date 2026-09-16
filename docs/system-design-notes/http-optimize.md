---
title: "Optimize HTTP requests for speed and limits"
slug: /system-design-notes/http-optimize
sidebar_position: 28
sidebar_label: "Optimize HTTP requests for speed and lim…"
description: "medium · client‑side concurrency · rate limits · batching · caching · retries"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/http-optimize/sequence.svg" alt="How it works — http-optimize" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
<header>
  
  <span class="tag">medium · client‑side concurrency · rate limits · batching · caching · retries</span>
</header>
<p>A client (SDK, backfill job, scraper) must make many HTTP calls to an API that has rate limits, and finish as fast as possible without getting throttled or banned. The answer is a small pipeline: bounded concurrency, a local token bucket that tracks the server's limits, batching/coalescing, caching, and disciplined retries.</p>

## Requirements {#http-optimize-req}

<div class="board">
  <div><h4>Functional</h4><ol>
      <li>Issue N requests (10K–10M) against an API with per‑key limits (e.g. 600 req/min, 10 concurrent)</li>
      <li>Honor 429/Retry‑After and rate‑limit headers</li>
      <li>Deduplicate identical requests; cache GETs; batch where the API allows</li>
      <li>Report progress; resume after crash</li>
      <li class="out">Changing the server</li>
  </ol></div>
  <div><h4>Non‑functional</h4><ol>
      <li>Throughput ≈ the allowed limit, not above (no bans) and not far below</li>
      <li>Latency per request minimized (keep‑alive, HTTP/2, compression)</li>
      <li>Bounded memory regardless of N</li>
      <li>Correct under retries: idempotent or keyed writes</li>
  </ol></div>
</div>
<div class="note"><b>Little's law:</b> concurrency = throughput × latency. At 10 req/s allowed and 200 ms latency you only need 2 in flight; 50 workers just queue on the limiter. Size the pool from the limit, not from CPU.</div>

## Entities and API {#http-optimize-api}

<p>Request (id, method, url, body, idempotencyKey, attempts, state) · RateBudget (per key: tokens, refill, concurrent cap, learned from headers) · Cache (ETag/Last‑Modified) · Checkpoint (done ids).</p>
<pre><code>client.submit(reqs) → results (streaming)
Limiter:  acquire(key) blocks until token available and inflight &lt; cap; release() on completion
Headers read: X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After; write: If-None-Match, Accept-Encoding, Idempotency-Key</code></pre>

## Design {#http-optimize-design}

<figure>
<svg viewBox="0 0 980 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="HTTP request optimizer: bounded work queue, coalescer/batcher, cache, token-bucket + concurrency limiter, worker pool with keep-alive HTTP/2 client, retry with backoff and jitter, checkpoint store">
<defs><marker id="dg1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="dg3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#dg1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#dg3);stroke-dasharray:2 4}.lbl{font-size:10.5px;fill:#1F4E9E}</style>
<rect class="box" x="20" y="60" width="120" height="80"></rect><text class="tb" x="80" y="78" text-anchor="middle">Input</text>
<text class="ts" x="80" y="94" text-anchor="middle">N requests</text>
<text class="ts" x="80" y="107" text-anchor="middle">from file/DB</text>
<text class="ts" x="80" y="120" text-anchor="middle">streamed</text>
<rect class="box" x="170" y="60" width="150" height="80"></rect><text class="tb" x="245" y="78" text-anchor="middle">Dedupe + batch</text>
<text class="ts" x="245" y="94" text-anchor="middle">coalesce identical</text>
<text class="ts" x="245" y="107" text-anchor="middle">pack up to API batch size</text>
<text class="ts" x="245" y="120" text-anchor="middle">priority queue</text>
<rect class="box" x="350" y="60" width="130" height="80" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="415" y="78" text-anchor="middle">Cache</text>
<text class="ts" x="415" y="94" text-anchor="middle">ETag / max-age</text>
<text class="ts" x="415" y="107" text-anchor="middle">conditional GETs</text>
<text class="ts" x="415" y="120" text-anchor="middle">304 = free</text>
<rect class="box" x="510" y="40" width="160" height="120" stroke="#B45309"></rect><text class="tb" x="590" y="58" text-anchor="middle">Limiter</text>
<text class="ts" x="590" y="74" text-anchor="middle">token bucket per key</text>
<text class="ts" x="590" y="87" text-anchor="middle">refill from headers</text>
<text class="ts" x="590" y="100" text-anchor="middle">inflight ≤ cap</text>
<text class="ts" x="590" y="113" text-anchor="middle">pause on 429 until Reset</text>
<rect class="box" x="700" y="60" width="130" height="80"></rect><text class="tb" x="765" y="78" text-anchor="middle">Worker pool</text>
<text class="ts" x="765" y="94" text-anchor="middle">size = limit × latency</text>
<text class="ts" x="765" y="107" text-anchor="middle">HTTP/2 keep-alive</text>
<text class="ts" x="765" y="120" text-anchor="middle">timeouts, gzip</text>
<rect class="box" x="860" y="60" width="100" height="80" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="tb" x="910" y="78" text-anchor="middle">API</text>
<text class="ts" x="910" y="94" text-anchor="middle">429, Retry-After</text>
<text class="ts" x="910" y="107" text-anchor="middle">rate headers</text>
<rect class="box" x="510" y="200" width="160" height="60"></rect><text class="tb" x="590" y="218" text-anchor="middle">Retry policy</text>
<text class="ts" x="590" y="234" text-anchor="middle">exp backoff + jitter</text>
<text class="ts" x="590" y="247" text-anchor="middle">idempotent only; DLQ</text>
<rect class="box" x="700" y="200" width="130" height="60" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="765" y="218" text-anchor="middle">Checkpoint</text>
<text class="ts" x="765" y="234" text-anchor="middle">done ids; resume</text>
<text class="ts" x="765" y="247" text-anchor="middle">progress metrics</text>
<line class="f" x1="140" y1="100" x2="168" y2="100"></line>
<line class="f" x1="320" y1="100" x2="348" y2="100"></line>
<line class="f" x1="480" y1="100" x2="508" y2="100"></line>
<line class="f" x1="670" y1="100" x2="698" y2="100"></line>
<line class="f" x1="830" y1="100" x2="858" y2="100"></line>
<line class="f" x1="765" y1="140" x2="765" y2="198"></line>
<line class="f" x1="765" y1="230" x2="672" y2="230"></line>
<text class="lbl" x="718" y="224" text-anchor="middle">failed → retry</text>
<text class="ts" x="20" y="250">Only the limiter knows the budget; everything upstream just queues; everything downstream just executes.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 644" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="One request through the optimizer">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="7" y="14" width="126" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Caller</text>
<line class="ln" x1="70" y1="48" x2="70" y2="624"></line>
<rect class="sb" x="147" y="14" width="126" height="34"></rect><text class="st" x="210" y="36" text-anchor="middle">Queue</text>
<line class="ln" x1="210" y1="48" x2="210" y2="624"></line>
<rect class="sb" x="287" y="14" width="126" height="34"></rect><text class="st" x="350" y="36" text-anchor="middle">Cache</text>
<line class="ln" x1="350" y1="48" x2="350" y2="624"></line>
<rect class="sb" x="427" y="14" width="126" height="34"></rect><text class="st" x="490" y="36" text-anchor="middle">Limiter</text>
<line class="ln" x1="490" y1="48" x2="490" y2="624"></line>
<rect class="sb" x="567" y="14" width="126" height="34"></rect><text class="st" x="630" y="36" text-anchor="middle">Worker</text>
<line class="ln" x1="630" y1="48" x2="630" y2="624"></line>
<rect class="sb" x="707" y="14" width="126" height="34"></rect><text class="st" x="770" y="36" text-anchor="middle">API</text>
<line class="ln" x1="770" y1="48" x2="770" y2="624"></line>
<rect class="sb" x="847" y="14" width="126" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Checkpoint</text>
<line class="ln" x1="910" y1="48" x2="910" y2="624"></line>
<line class="a1" x1="78" y1="80" x2="202" y2="80"></line>
<text class="sl" x="140" y="74" text-anchor="middle">submit 1M requests (streamed)</text>
<rect class="nt" x="100" y="101" width="220" height="22"></rect><text class="sl" x="210" y="116" text-anchor="middle">dedupe key = method+url+body hash</text>
<line class="a1" x1="218" y1="148" x2="342" y2="148"></line>
<text class="sl" x="280" y="142" text-anchor="middle">GET? cached fresh?</text>
<line class="a2" x1="342" y1="182" x2="218" y2="182"></line>
<text class="sl" x="280" y="176" text-anchor="middle">hit → return</text>
<line class="a1" x1="218" y1="216" x2="482" y2="216"></line>
<text class="sl" x="350" y="210" text-anchor="middle">acquire(key)</text>
<rect class="nt" x="389" y="237" width="202" height="22"></rect><text class="sl" x="490" y="252" text-anchor="middle">wait for token + inflight slot</text>
<line class="a1" x1="498" y1="284" x2="622" y2="284"></line>
<text class="sl" x="560" y="278" text-anchor="middle">go</text>
<line class="a1" x1="638" y1="318" x2="762" y2="318"></line>
<text class="sl" x="700" y="312" text-anchor="middle">request (keep-alive, gzip, If-None-Match)</text>
<line class="a2" x1="762" y1="352" x2="638" y2="352"></line>
<text class="sl" x="700" y="346" text-anchor="middle">200 / 304 / 429 / 5xx</text>
<line class="a1" x1="622" y1="386" x2="498" y2="386"></line>
<text class="sl" x="560" y="380" text-anchor="middle">release; update budget from headers</text>
<line class="a1" x1="622" y1="420" x2="358" y2="420"></line>
<text class="sl" x="490" y="414" text-anchor="middle">store ETag/body</text>
<rect class="nt" x="520" y="441" width="220" height="22"></rect><text class="sl" x="630" y="456" text-anchor="middle">429 → limiter pauses key until Retry-After; requeue</text>
<rect class="nt" x="520" y="475" width="220" height="22"></rect><text class="sl" x="630" y="490" text-anchor="middle">5xx/timeout → backoff+jitter, attempts++</text>
<line class="a1" x1="638" y1="522" x2="902" y2="522"></line>
<text class="sl" x="770" y="516" text-anchor="middle">done id</text>
<line class="a2" x1="622" y1="556" x2="78" y2="556"></line>
<text class="sl" x="350" y="550" text-anchor="middle">result</text>
<line class="a3" x1="902" y1="590" x2="78" y2="590"></line>
<text class="sl" x="490" y="584" text-anchor="middle">resume after crash from done set</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Caller → Queue:</b> submit 1M requests (streamed)</li>
  <li><b>Queue:</b> dedupe key = method+url+body hash</li>
  <li><b>Queue → Cache:</b> GET? cached fresh?</li>
  <li><b>Cache → Queue:</b> hit → return (response)</li>
  <li><b>Queue → Limiter:</b> acquire(key)</li>
  <li><b>Limiter:</b> wait for token + inflight slot</li>
  <li><b>Limiter → Worker:</b> go</li>
  <li><b>Worker → API:</b> request (keep-alive, gzip, If-None-Match)</li>
  <li><b>API → Worker:</b> 200 / 304 / 429 / 5xx (response)</li>
  <li><b>Worker → Limiter:</b> release; update budget from headers</li>
  <li><b>Worker → Cache:</b> store ETag/body</li>
  <li><b>Worker:</b> 429 → limiter pauses key until Retry-After; requeue</li>
  <li><b>Worker:</b> 5xx/timeout → backoff+jitter, attempts++</li>
  <li><b>Worker → Checkpoint:</b> done id</li>
  <li><b>Worker → Caller:</b> result (response)</li>
  <li><b>Checkpoint → Caller:</b> resume after crash from done set (async)</li>
</ol>

## Deep dives {#http-optimize-deep}

<div class="cards">
<div><h4>Fewer bytes, fewer round trips</h4><ul><li>Keep‑alive and HTTP/2 multiplexing: one TLS handshake, many streams; avoids the 1–2 RTT per request that dominates small calls.</li><li>Batch endpoints when available; otherwise coalesce identical in‑flight requests (single‑flight).</li><li>Compression, minimal fields (<code>?fields=</code>), conditional GETs with ETags so unchanged data costs a 304.</li><li>Pipelining order: cheap cached checks first, expensive calls last.</li></ul></div>
<div><h4>Staying inside the limit</h4><ul><li>Local token bucket seeded from documented limits and corrected from response headers; treat the server as truth.</li><li>Concurrency cap separate from rate: many APIs limit both.</li><li>On 429: stop the whole key, not just the request; honor Retry‑After; add jitter so many clients don't resume in lockstep.</li><li>Priority queue so important work isn't starved by bulk; per‑tenant fairness if multiple keys.</li></ul></div>
<div><h4>Correctness</h4><ul><li>Retry only idempotent requests, or send an Idempotency‑Key for POSTs; cap attempts; DLQ the rest.</li><li>Timeouts on connect and read; cancel on shutdown; bounded queue so 10M inputs don't sit in RAM.</li><li>Checkpoint done ids (or offsets) so a crash resumes instead of restarting and re‑spending budget.</li><li>Metrics: achieved rps vs allowed, 429 rate, p95 latency, cache hit rate, retries; stop if 429 rate climbs.</li></ul></div></div>

## Don't leave the room without saying {#http-optimize-check}

<ul class="checklist">
  <li>Concurrency = limit × latency (Little), not CPU count</li>
  <li>Token bucket + concurrency cap driven by response headers; pause on 429 with jitter</li>
  <li>Keep‑alive/HTTP2, batching, single‑flight, ETags/304</li>
  <li>Retries only when idempotent; backoff + jitter; DLQ</li>
  <li>Bounded queue, streaming input, checkpoint for resume</li>
  <li>Measure achieved vs allowed and adapt</li>
</ul>

## What each level is expected to drive {#http-optimize-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Thread pool + retries + respect Retry‑After</td><td>Sizing from Little's law, caching</td></tr>
  <tr><td>Senior</td><td>Full pipeline: dedupe, cache, limiter from headers, sized pool, idempotent retries, checkpoints</td><td>Priority/fairness, adaptive limits</td></tr>
  <tr><td>Staff+</td><td>Adaptive rate control (AIMD on 429s), cost model per request type, multi‑key scheduling, observability that proves you never exceed limits</td><td>—</td></tr>
</tbody></table>
