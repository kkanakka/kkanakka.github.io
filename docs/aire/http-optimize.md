---
title: "Optimize HTTP requests for speed and limits"
slug: /aire/http-optimize
sidebar_position: 6
sidebar_label: "Optimize HTTP requests for speed and lim…"
description: "medium · client‑side concurrency · rate limits · batching · caching · retries"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/http-optimize/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

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


## Scale, performance and safety targets {#http-optimize-targets}

<p>This is the rate‑limiting problem from the client's side. The numbers are what stop you from over‑engineering a worker pool that will only ever queue on the limiter.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> whatever the server allows and not one request more — e.g. 600 req/min (10/s) with 10 concurrent. The job itself may be 10K to 10M requests, so the work is large but the permitted rate is small and fixed.</li>
    <li><b>Data volume:</b> at 10M requests × ~10 KB responses that is ~100 GB to process, which must stream rather than accumulate — memory has to be bounded regardless of N.</li>
    <li><b>Growth:</b> the request count grows with the dataset while the rate limit does not, so total runtime scales linearly and the only real levers are caching and batching, not concurrency.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> per‑request p95 of a few hundred milliseconds with keep‑alive and HTTP/2; the job's completion time is N ÷ allowed rate, so individual latency barely matters once concurrency is sized correctly.</li>
    <li><b>Throughput:</b> Little's law sets the pool size — concurrency = throughput × latency. At 10 req/s and 200 ms that is <b>2</b> in flight. Fifty workers would simply queue on the limiter while burning memory and connections.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> here <em>you</em> are the potential abuser. Exceeding limits gets the key throttled and then banned; retrying aggressively into a struggling server turns their incident into an outage; ignoring <code>Retry‑After</code> is what escalates a 429 into a block.</li>
    <li><b>Rate limiting:</b> a local token bucket per key, learned and corrected from the server's own <code>x-ratelimit-*</code> headers, plus a concurrency cap. Treat the server's limit as a ceiling to stay under, never a target to hit exactly.</li>
    <li><b>Data sensitivity:</b> responses may contain customer data; the cache is a durable copy of it, so it needs the same protection and retention as any other store. Never log full URLs with tokens in query strings, and never write response bodies to debug logs.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> not a service — the requirement is that a job of 10M requests survives crashes, restarts and rate‑limit changes, and resumes without redoing completed work.</li>
    <li><b>Degraded mode:</b> 429 → pause that key for exactly <code>Retry‑After</code> and requeue, never retry immediately. 5xx or timeout → exponential backoff with jitter and a bounded attempt count. Server down entirely → the job pauses and resumes from its checkpoint rather than failing.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> retries must be safe. GETs are naturally idempotent; writes need an idempotency key, or a retried timeout creates a duplicate resource the caller never intended.</li>
    <li><b>Durability:</b> a checkpoint of completed request ids, so a crash at 9M of 10M costs minutes rather than the whole run.</li>
    <li><b>Efficiency:</b> the cheapest request is the one never sent. Deduplicating identical requests and using conditional requests to turn repeats into 304s often cuts the job more than any concurrency tuning can.</li></ul></div>
</div>

## Entities and API {#http-optimize-api}

<p>Request (id, method, url, body, idempotencyKey, attempts, state) · RateBudget (per key: tokens, refill, concurrent cap, learned from headers) · Cache (ETag/Last‑Modified) · Checkpoint (done ids).</p>
<pre><code>client.submit(reqs) → results (streaming)
Limiter:  acquire(key) blocks until token available and inflight &lt; cap; release() on completion
Headers read: X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After; write: If-None-Match, Accept-Encoding, Idempotency-Key</code></pre>

## Design {#http-optimize-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/http-optimize/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

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
  <li><b>Caller → Queue:</b> submit 1M requests (streamed).
    Requests are streamed in rather than materialised as a list, so memory is bounded by the in‑flight window rather than by N.
    A 10M‑request job and a 10K‑request job then use the same amount of memory, which is what makes the client usable at both ends of the range.</li>
  <li><b>Queue:</b> dedupe key = method+url+body hash.
    Real workloads contain far more duplicate requests than people expect — the same entity referenced from many records.
    Collapsing them before they reach the limiter is free throughput: a deduplicated request costs nothing and consumes no rate budget.</li>
  <li><b>Queue → Cache:</b> GET? cached fresh?
    Only safe methods are cache‑eligible, and freshness follows the server's own cache headers rather than a guess.
    The cheapest possible request is one never sent, so the cache is consulted before the limiter rather than after.</li>
  <li><b>Cache → Queue:</b> hit → return (response).
    A hit skips the rate limiter entirely, which matters because the limiter — not the network — is the bottleneck for the whole job.
    Every cache hit is effectively an increase in the allowed rate.</li>
  <li><b>Queue → Limiter:</b> acquire(key).
    Limits are per API key, so the limiter is keyed the same way; a job spanning several keys can run them in parallel at full rate each.
    Acquiring before dispatch means the client never depends on a 429 to discover it went too fast.</li>
  <li><b>Limiter:</b> wait for token + inflight slot.
    Two independent constraints must both be satisfied: a rate limit (requests per minute) and a concurrency limit (simultaneous requests).
    Satisfying only one is the common bug — 10 requests per second is compatible with 50 in flight, and the server will reject the second condition even though the first is met.
    Waiting here rather than spinning is what keeps the client at the ceiling without ever crossing it.</li>
  <li><b>Limiter → Worker:</b> go.
    Because the limiter governs the rate, the worker pool exists only to cover latency — sized from Little's law, not from CPU count.
    A pool much larger than throughput × latency adds queueing and connections without adding a single request per second.</li>
  <li><b>Worker → API:</b> request (keep-alive, gzip, If-None-Match).
    Keep‑alive avoids a TCP and TLS handshake per request, which at small payloads is most of the latency; HTTP/2 goes further by multiplexing over one connection.
    <code>If‑None‑Match</code> turns an unchanged resource into a 304 with no body — cheaper on the network and, on many APIs, cheaper against the quota too.
    These three flags typically matter more than any amount of concurrency tuning.</li>
  <li><b>API → Worker:</b> 200 / 304 / 429 / 5xx (response).
    Four outcomes with four different handlings, and conflating them is where clients get banned: 304 is a success, 429 is a pacing instruction, 5xx is transient, 4xx is usually permanent.</li>
  <li><b>Worker → Limiter:</b> release; update budget from headers.
    The server's <code>x-ratelimit-remaining</code> and reset headers are authoritative; the local bucket is only a model and is corrected from them after every response.
    This feedback loop is what allows the client to track a limit that changes — by tier, by endpoint, or dynamically under server load — without being reconfigured.</li>
  <li><b>Worker → Cache:</b> store ETag/body.
    Storing the ETag alongside the body is what makes the <em>next</em> run cheap: unchanged resources come back as 304s.
    For a job that re‑runs daily over a mostly static corpus, this is the difference between hours and minutes.</li>
  <li><b>Worker:</b> 429 → limiter pauses key until Retry-After; requeue.
    A 429 pauses the whole key, not just this request — continuing to send while throttled is precisely what escalates a rate limit into a ban.
    <code>Retry‑After</code> is obeyed exactly rather than approximated, because the server has told you when it will accept traffic again.
    The request is requeued rather than failed, so a burst of 429s costs time and nothing else.</li>
  <li><b>Worker:</b> 5xx/timeout → backoff+jitter, attempts++.
    Exponential backoff prevents a struggling server from being hammered; jitter prevents thousands of queued requests from retrying in lockstep and re‑creating the spike.
    A bounded attempt count stops a permanently failing request from consuming a slot forever.
    Timeouts must be treated as unknown outcomes, not failures — the request may well have succeeded, which is exactly why writes need an idempotency key.</li>
  <li><b>Worker → Checkpoint:</b> done id.
    Completed ids are recorded durably, turning a crash at 9M of 10M into a few minutes of lost work rather than a full re‑run.
    Checkpointing ids rather than results keeps it small and cheap enough to write continuously.</li>
  <li><b>Worker → Caller:</b> result (response).
    Results stream back as they complete rather than being collected, so the caller can begin processing immediately and memory stays bounded.</li>
  <li><b>Checkpoint → Caller:</b> resume after crash from done set (async).
    Resume is subtraction: skip everything in the done set and run the remainder, which works precisely because requests are deduplicated and identified up front.
    This also makes the job safely re‑runnable — running it twice does the outstanding work once, which is the property that lets someone actually operate it.</li>
</ol>

## Deep dives {#http-optimize-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/http-optimize/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
<div><h4>Fewer bytes, fewer round trips</h4><ul><li>Keep‑alive and HTTP/2 multiplexing: one TLS handshake, many streams; avoids the 1–2 RTT per request that dominates small calls.</li><li>Batch endpoints when available; otherwise coalesce identical in‑flight requests (single‑flight).</li><li>Compression, minimal fields (<code>?fields=</code>), conditional GETs with ETags so unchanged data costs a 304.</li><li>Pipelining order: cheap cached checks first, expensive calls last.</li></ul></div>
<div><h4>Staying inside the limit</h4><ul><li>Local token bucket seeded from documented limits and corrected from response headers; treat the server as truth.</li><li>Concurrency cap separate from rate: many APIs limit both.</li><li>On 429: stop the whole key, not just the request; honor Retry‑After; add jitter so many clients don't resume in lockstep.</li><li>Priority queue so important work isn't starved by bulk; per‑tenant fairness if multiple keys.</li></ul></div>
<div><h4>Correctness</h4><ul><li>Retry only idempotent requests, or send an Idempotency‑Key for POSTs; cap attempts; DLQ the rest.</li><li>Timeouts on connect and read; cancel on shutdown; bounded queue so 10M inputs don't sit in RAM.</li><li>Checkpoint done ids (or offsets) so a crash resumes instead of restarting and re‑spending budget.</li><li>Metrics: achieved rps vs allowed, 429 rate, p95 latency, cache hit rate, retries; stop if 429 rate climbs.</li></ul></div></div>


## Trade-offs {#http-optimize-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Pacing</td><td>Local token bucket, corrected from response headers</td><td>Complexity, and a model that can briefly disagree with the server</td><td>Reacting only to 429s is simpler and gets keys throttled or banned — discovering a limit by violating it is not a strategy</td></tr>
  <tr><td>Pool size</td><td>Little's law: throughput × latency</td><td>Feels too small; adding workers is the instinct</td><td>Larger pools only help if the limit is concurrency rather than rate; otherwise they queue on the limiter and waste connections</td></tr>
  <tr><td>Caching</td><td>ETag/Last‑Modified with conditional requests</td><td>A cache to store, secure and invalidate</td><td>Skip only for one‑shot jobs over volatile data; for repeated runs it is the single biggest win available</td></tr>
  <tr><td>Deduplication</td><td>Collapse identical requests before the limiter</td><td>A dedupe index proportional to distinct requests</td><td>Real workloads contain far more duplicates than expected, and a deduplicated request costs no rate budget at all</td></tr>
  <tr><td>Retries</td><td>Exponential backoff with jitter, bounded attempts</td><td>Some transient failures give up early</td><td>Immediate retries turn a struggling server into a failing one and are the fastest route to being blocked</td></tr>
  <tr><td>Write safety</td><td>Idempotency keys on all non‑GET requests</td><td>The server must support them</td><td>Without them a timeout is unresolvable — you cannot know whether to retry, and both choices are wrong some of the time</td></tr>
  <tr><td>Progress</td><td>Checkpoint completed ids</td><td>A durable store and continuous small writes</td><td>Restarting from zero is acceptable only for short jobs; at 10M requests a crash without a checkpoint is a day lost</td></tr>
</tbody></table>

## Safety-first design {#http-optimize-safety}

<div class="cards">
  <div><h4>Be a good client of someone else's service</h4><ul>
    <li><b>Stay under the ceiling, do not ride it.</b> The published limit is a boundary to keep clear of, not a throughput target to hit precisely.</li>
    <li><b>Obey <code>Retry‑After</code> exactly.</b> The server has told you when it will accept traffic; sending sooner is what escalates a 429 into a ban.</li>
    <li><b>Pause the key, not just the request.</b> Continuing to send other requests on a throttled key defeats the purpose of backing off at all.</li>
    <li><b>Jitter every retry.</b> Without it, a thousand queued requests retry in lockstep and reproduce the exact spike that caused the problem.</li></ul></div>
  <div><h4>Retries must not create duplicates</h4><ul>
    <li><b>A timeout is an unknown, not a failure.</b> The request may have succeeded; treating it as failed and retrying blindly is how duplicate resources appear.</li>
    <li><b>Idempotency keys on every write.</b> They convert an ambiguous outcome into a safe retry, which is the only way to make a long write‑heavy job reliable.</li>
    <li><b>Bound the attempts.</b> A permanently failing request must eventually be reported rather than occupying a slot indefinitely.</li>
    <li><b>Distinguish 4xx from 5xx.</b> Retrying a 400 forever is pure waste and looks like an attack from the server's side.</li></ul></div>
  <div><h4>Long jobs must survive themselves</h4><ul>
    <li><b>Bounded memory regardless of N.</b> Streaming in and streaming out means a 10M‑request job uses the same memory as a 10K one.</li>
    <li><b>Checkpoint continuously.</b> Resume is subtraction from the done set, which also makes the job safe to re‑run.</li>
    <li><b>Track the server's truth.</b> Budgets are corrected from response headers, so a limit that changes mid‑run is absorbed rather than violated.</li>
    <li><b>Protect the cache like data.</b> It holds real responses, so it inherits the retention, encryption and access rules of whatever it cached.</li></ul></div>
</div>

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
