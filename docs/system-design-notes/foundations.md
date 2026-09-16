---
title: "Before any design: the checklist"
slug: /system-design-notes/foundations
sidebar_position: 1
sidebar_label: "Before any design: the checklist"
description: "read this first · cross‑cutting concerns · building blocks"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/foundations/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">read this first · cross‑cutting concerns · building blocks</span>
</header>
<p>Every design gets walked in the same order. The interviewer is scoring whether you drive it, so say the step names as you go.</p>
<ol class="order">
  <li><b>Requirements</b> — 3 functional, 3 non‑functional, list what's out of scope. Non‑functional decide the deep dives.</li>
  <li><b>Entities</b> — the nouns. Just names, not columns.</li>
  <li><b>API</b> — one REST endpoint per functional requirement, 2 minutes max.</li>
  <li><b>High‑level design</b> — satisfy each requirement with the simplest thing that works. Client → gateway → service → DB.</li>
  <li><b>Deep dives</b> — take each non‑functional requirement and find where the simple design breaks. Do the math before adding a component.</li>
</ol>
<div class="trap"><b>Don't:</b> debate SQL vs NoSQL, draw a load balancer in front of every box, shard at 500 GB, propose WebSockets when polling works, or spend 10 minutes on API fields.</div>

## Non‑functional prompts: scan while writing requirements {#fd-nfr}

<table>
  <tbody><tr><th>Ask</th><th>Look for</th></tr>
  <tr><td>CAP</td><td>Consistency or availability? Partition tolerance is a given. Strong for money, inventory, bookings; eventual for feeds, search, analytics.</td></tr>
  <tr><td>Environment</td><td>Mobile battery, low memory, weak bandwidth (video on 3G), offline.</td></tr>
  <tr><td>Scalability</td><td>Bursty traffic (noon drop, holidays)? Read:write ratio — which side needs to scale?</td></tr>
  <tr><td>Latency</td><td>Any request with real computation? Low‑latency search, matching, feed ranking.</td></tr>
  <tr><td>Durability</td><td>Can we lose data? Social post maybe; bank transaction never.</td></tr>
  <tr><td>Security</td><td>Data protection, access control, PII.</td></tr>
  <tr><td>Fault tolerance</td><td>Redundancy, failover, recovery; what happens when X dies?</td></tr>
  <tr><td>Compliance</td><td>GDPR, HIPAA, PCI, data residency.</td></tr>
</tbody></table>
<p>Pick the 3 that shape this system, name the rest as out of scope.</p>

## The standard request path and what lives where {#fd-path}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/foundations/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Standard request path: client, CDN, API gateway with cross-cutting concerns, services, cache, database, queue and workers">
  <defs><marker id="a2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker></defs>
  <style>
    .b{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.h{font-size:13px;font-weight:600;fill:#1B2430}.s{font-size:11px;fill:#5B6673}
    .f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#a2)}.ann{font-size:11px;fill:#1F4E9E}
  </style>
  <rect class="b" x="20" y="120" width="90" height="50"></rect><text class="h" x="65" y="141" text-anchor="middle">Client</text><text class="s" x="65" y="158" text-anchor="middle">HTTPS only</text>
  <rect class="b" x="150" y="120" width="90" height="50" stroke="#0F766E"></rect><text class="h" x="195" y="141" text-anchor="middle">CDN</text><text class="s" x="195" y="158" text-anchor="middle">static + cacheable GETs</text>
  <rect class="b" x="280" y="100" width="150" height="90"></rect><text class="h" x="355" y="121" text-anchor="middle">API Gateway / LB</text>
  <text class="s" x="290" y="140">authN (JWT / session)</text><text class="s" x="290" y="154">rate limit → 429</text><text class="s" x="290" y="168">TLS termination, WAF</text><text class="s" x="290" y="182">request id, access log</text>
  <rect class="b" x="480" y="100" width="130" height="90"></rect><text class="h" x="545" y="121" text-anchor="middle">Service (×N)</text>
  <text class="s" x="490" y="140">authZ: owns resource?</text><text class="s" x="490" y="154">validation → 400</text><text class="s" x="490" y="168">idempotency key</text><text class="s" x="490" y="182">metrics + traces</text>
  <rect class="b" x="660" y="40" width="120" height="50" stroke="#0F766E" fill="#DDF3F0"></rect><text class="h" x="720" y="61" text-anchor="middle">Cache (Redis)</text><text class="s" x="720" y="78" text-anchor="middle">cache‑aside, TTL</text>
  <rect class="b" x="660" y="120" width="120" height="50"></rect><text class="h" x="720" y="141" text-anchor="middle">Database</text><text class="s" x="720" y="158" text-anchor="middle">system of record</text>
  <rect class="b" x="660" y="200" width="120" height="50" stroke="#B45309"></rect><text class="h" x="720" y="221" text-anchor="middle">Queue</text><text class="s" x="720" y="238" text-anchor="middle">bursty / async work</text>
  <rect class="b" x="830" y="200" width="120" height="50"></rect><text class="h" x="890" y="221" text-anchor="middle">Workers</text><text class="s" x="890" y="238" text-anchor="middle">retries, DLQ</text>
  <rect class="b" x="830" y="120" width="120" height="50" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="h" x="890" y="141" text-anchor="middle">Blob (S3)</text><text class="s" x="890" y="158" text-anchor="middle">presigned URLs</text>
  <path class="f" d="M110 145 L148 145"></path><path class="f" d="M240 145 L278 145"></path><path class="f" d="M430 145 L478 145"></path>
  <path class="f" d="M610 130 L658 70"></path><path class="f" d="M610 145 L658 145"></path><path class="f" d="M610 160 L658 220"></path>
  <path class="f" d="M780 225 L828 225"></path><path class="f" d="M780 145 L828 145"></path>
  <text class="ann" x="620" y="100">read: cache first</text>
  <text class="ann" x="617" y="195">write: enqueue</text>
  <text class="ann" x="785" y="140">url pointer</text>
</svg>
<figcaption>Put cross‑cutting concerns at the gateway, business rules in the service. Mention each once and move on.</figcaption>
</figure>

## Cross‑cutting concerns to name in every design {#fd-crosscutting}

<table>
  <tbody><tr><th>Concern</th><th>Where</th><th>What to say</th></tr>
  <tr><td>Authentication</td><td>Gateway</td><td>JWT for users (stateless, contains userId + expiry), API keys or mTLS for service‑to‑service. Gateway rejects with 401 before anything downstream runs.</td></tr>
  <tr><td>Authorization</td><td>Service</td><td>Gateway knows <em>who</em>, only the service knows <em>whether they may</em>. Check resource ownership / role in the service, 403 on failure.</td></tr>
  <tr><td>Rate limiting</td><td>Gateway (Redis counter)</td><td>Token bucket or sliding window per user / IP / API key. Return 429 with Retry‑After. Protects against abuse, not against a legit flash crowd.</td></tr>
  <tr><td>Throttling / backpressure</td><td>Service ↔ queue</td><td>When downstream is at capacity, reject early (503) or slow producers instead of letting a queue grow forever. A queue hides missing capacity, it doesn't create it.</td></tr>
  <tr><td>Admission control</td><td>In front of the hot path</td><td>Waiting room / queue that releases users at the rate the bottleneck can absorb. Signed token proves you were admitted.</td></tr>
  <tr><td>Idempotency</td><td>Service + DB</td><td>Client sends an idempotency key on POSTs; store it so retries don't create two orders / two charges.</td></tr>
  <tr><td>Error codes</td><td>API</td><td>400 bad input · 401 not logged in · 403 not allowed · 404 · 409 conflict (already reserved, version mismatch) · 429 rate limited · 500 · 503 overloaded. Never leak stack traces.</td></tr>
  <tr><td>Observability</td><td>Everywhere</td><td>Structured logs with a request/correlation id, RED metrics (rate, errors, duration) per endpoint, distributed tracing across services. Alert on SLOs, not on CPU.</td></tr>
  <tr><td>Security</td><td>Edge + data</td><td>TLS in transit, encryption at rest, secrets in a vault not config, input validation, presigned URLs for blobs, least‑privilege IAM, WAF/DDoS at the CDN.</td></tr>
  <tr><td>Fault tolerance</td><td>Every hop</td><td>Timeouts, retries with backoff + jitter, circuit breakers, health checks, replicas in ≥2 AZs. Say "stateless services behind an LB so any instance can die."</td></tr>
</tbody></table>

## Protocols: pick and justify in one sentence {#fd-protocols}

<div class="cards">
  <div><h4>HTTP vs HTTPS / TLS</h4><ul>
    <li>HTTPS = HTTP inside TLS. Encrypts + authenticates the server via certificate.</li>
    <li>Always HTTPS externally; terminate TLS at the LB/gateway, optionally mTLS inside.</li>
    <li>TLS handshake costs 1–2 RTTs; keep‑alive connections amortize it.</li></ul></div>
  <div><h4>REST vs gRPC</h4><ul>
    <li>REST/JSON for public APIs: browsers, tooling, caching.</li>
    <li>gRPC (protobuf over HTTP/2) for internal service‑to‑service when latency or payload size matters. Typed contracts, streaming.</li>
    <li>Default line: "REST at the edge, gRPC inside."</li></ul></div>
  <div><h4>Real‑time: polling → SSE → WebSocket</h4><ul>
    <li>Polling: few clients, short waits, simplest.</li>
    <li>SSE: server → client push over plain HTTP; one direction. Feeds, notifications, progress.</li>
    <li>WebSocket: both directions, stateful; chat, collaboration, games. Needs L4 LB + connection registry.</li></ul></div>
  <div><h4>Load balancer L4 vs L7</h4><ul>
    <li>L7 reads HTTP: route by path, header, cookie. Default.</li>
    <li>L4 forwards TCP: faster, needed for persistent connections (WebSockets).</li>
    <li>Sticky sessions are a smell; keep services stateless instead.</li></ul></div>
</div>

### Webhooks: when another system needs to tell you something happened

<figure>
<svg viewBox="0 0 980 170" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Webhook flow: external system posts an event to your endpoint, you verify signature, store, ack fast, process async">
  <defs><marker id="a4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="a5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker></defs>
  <style>.b{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.h{font-size:13px;font-weight:600;fill:#1B2430}.s{font-size:11px;fill:#5B6673}.fp{stroke:#6B2D6B;stroke-width:1.6;fill:none;marker-end:url(#a4)}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#a5)}.ap{font-size:11px;fill:#6B2D6B}.an{font-size:11px;fill:#1F4E9E}</style>
  <rect class="b" x="20" y="50" width="130" height="56" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="h" x="85" y="74" text-anchor="middle">Stripe / GitHub</text><text class="s" x="85" y="92" text-anchor="middle">event happens</text>
  <rect class="b" x="260" y="50" width="190" height="56"></rect><text class="h" x="355" y="74" text-anchor="middle">POST /webhooks/stripe</text><text class="s" x="355" y="92" text-anchor="middle">verify HMAC · dedupe by event id</text>
  <rect class="b" x="540" y="50" width="120" height="56" stroke="#B45309"></rect><text class="h" x="600" y="74" text-anchor="middle">Queue</text><text class="s" x="600" y="92" text-anchor="middle">persist first</text>
  <rect class="b" x="750" y="50" width="130" height="56"></rect><text class="h" x="815" y="74" text-anchor="middle">Worker</text><text class="s" x="815" y="92" text-anchor="middle">update Purchase, etc.</text>
  <path class="fp" d="M150 70 L258 70"></path><text class="ap" x="160" y="62">1 signed HTTP POST</text>
  <path class="fp" d="M260 90 L152 90"></path><text class="ap" x="162" y="118">2 return 200 fast (&lt;5s)</text>
  <path class="f" d="M450 78 L538 78"></path><text class="an" x="460" y="70">3 enqueue</text>
  <path class="f" d="M660 78 L748 78"></path><text class="an" x="670" y="70">4 process</text>
  <text class="s" x="20" y="150">No 200 within the timeout → sender retries with backoff, possibly for days. Retries mean duplicates; handle them.</text>
</svg>
</figure>
<div class="cards">
  <div><h4>What it is</h4><ul>
    <li>Reverse of polling: instead of you asking "done yet?", the other system calls a URL you registered when the event occurs.</li>
    <li>Plain HTTP POST with a JSON body; you are the server now.</li>
    <li>Common: payment results (Stripe), repo events (GitHub), upload complete (S3 → SNS), delivery status (Twilio).</li></ul></div>
  <div><h4>Must‑say checklist</h4><ul>
    <li><b>Verify the signature</b> (HMAC header with a shared secret) or anyone can POST "payment succeeded".</li>
    <li><b>Idempotent</b>: store the event id, ignore repeats. Senders retry on any non‑2xx or timeout.</li>
    <li><b>Ack fast, process async</b>: persist to a queue, return 200, do the work in a worker.</li>
    <li><b>Ordering isn't guaranteed</b>: "failed" may arrive after "succeeded". Use event timestamps / state machine, not arrival order.</li>
    <li><b>Reconcile</b>: a periodic job that polls the source for anything you missed.</li></ul></div>
  <div><h4>Webhook vs polling vs SSE</h4><ul>
    <li>Webhook: server‑to‑server, event‑driven, needs a public endpoint.</li>
    <li>Polling: client‑to‑server, simple, wastes calls when nothing changed.</li>
    <li>SSE/WebSocket: server‑to‑browser push. Browsers can't receive webhooks, so the pattern is webhook → your backend → SSE or poll → client, exactly the purchase‑status flow in Flash Sale.</li></ul></div>
</div>

## Caching: which cache, where, and how it goes wrong {#fd-cache}

<figure>
<svg viewBox="0 0 980 190" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Cache-aside read and write flow">
  <defs><marker id="a3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker></defs>
  <style>.b{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.h{font-size:13px;font-weight:600;fill:#1B2430}.s{font-size:11px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#a3)}.ann{font-size:11px;fill:#1F4E9E}</style>
  <text class="h" x="20" y="30">Read (cache‑aside)</text>
  <rect class="b" x="20" y="50" width="90" height="44"></rect><text class="h" x="65" y="77" text-anchor="middle">Service</text>
  <rect class="b" x="180" y="50" width="100" height="44" stroke="#0F766E" fill="#DDF3F0"></rect><text class="h" x="230" y="77" text-anchor="middle">Redis</text>
  <rect class="b" x="350" y="50" width="100" height="44"></rect><text class="h" x="400" y="77" text-anchor="middle">DB</text>
  <path class="f" d="M110 66 L178 66"></path><text class="ann" x="118" y="60">1 GET key</text>
  <path class="f" d="M280 78 L352 78"></path><text class="ann" x="284" y="108">2 miss → query</text>
  <path class="f" d="M350 60 C 320 30, 280 30, 250 48"></path><text class="ann" x="262" y="34">3 SET key, TTL</text>
  <text class="s" x="20" y="130">Hit ≈ 1 ms, miss ≈ 20–50 ms. Aim for &gt;80% hit rate.</text>

  <text class="h" x="540" y="30">Write</text>
  <rect class="b" x="540" y="50" width="90" height="44"></rect><text class="h" x="585" y="77" text-anchor="middle">Service</text>
  <rect class="b" x="700" y="50" width="100" height="44"></rect><text class="h" x="750" y="77" text-anchor="middle">DB</text>
  <rect class="b" x="860" y="50" width="100" height="44" stroke="#0F766E" fill="#DDF3F0"></rect><text class="h" x="910" y="77" text-anchor="middle">Redis</text>
  <path class="f" d="M630 66 L698 66"></path><text class="ann" x="640" y="60">1 UPDATE</text>
  <path class="f" d="M800 66 L858 66"></path><text class="ann" x="804" y="60">2 DEL key</text>
  <text class="s" x="540" y="130">Delete, don't update, the cached value: next read repopulates. Short TTL as safety net.</text>
</svg>
</figure>
<table>
  <tbody><tr><th>Layer</th><th>Use for</th><th>Notes</th></tr>
  <tr><td>CDN (Cloudflare, CloudFront)</td><td>Images, video, JS, public GET responses that change rarely</td><td>Edge, geographic. TTL + purge on change.</td></tr>
  <tr><td>In‑process (local map, Caffeine)</td><td>Config, feature flags, tiny hot values</td><td>Per instance, inconsistent across fleet, survives a Redis outage.</td></tr>
  <tr><td>Distributed (Redis, Memcached)</td><td>Sessions, hot rows, expensive query results, precomputed feeds, counters</td><td>Redis when you need data structures (sorted set, hash, list) or atomic ops; Memcached for plain strings with multi‑threaded throughput.</td></tr>
</tbody></table>
<div class="cards">
  <div><h4>Kinds of caches (closest to user first)</h4><ul>
    <li><b>Browser / HTTP cache:</b> Cache‑Control, ETag; free, per user. Static assets, GET responses.</li>
    <li><b>CDN:</b> edge PoPs, geographic. Media, public pages, cacheable APIs.</li>
    <li><b>In‑process (local):</b> map in app memory (Caffeine, Guava). Config, flags, tiny hot values; per instance, can drift.</li>
    <li><b>Distributed (Redis, Memcached):</b> shared across the fleet. Sessions, hot rows, query results, counters.</li>
    <li><b>Database‑side:</b> buffer pool / query cache, materialized views, precomputed tables. Free with the DB, limited control.</li>
    <li><b>Application‑level precompute:</b> feed stored per user (fan‑out on write) is a cache in disguise.</li></ul></div>
  <div><h4>Eviction policy (what goes when it's full)</h4><ul>
    <li><b>LRU:</b> drop the least recently accessed. Default; good for temporal locality.</li>
    <li><b>LFU:</b> drop the least frequently accessed. Better for skewed/hot‑set workloads (celebrity pages), resists one‑off scans.</li>
    <li><b>FIFO:</b> drop the oldest inserted. Simple, ignores popularity; rarely the right pick.</li>
    <li><b>TTL:</b> not eviction, expiry; pair with any of the above as a staleness cap.</li>
    <li>Redis: <code>allkeys-lru</code> / <code>allkeys-lfu</code> / <code>volatile-ttl</code>; Memcached is LRU.</li></ul></div>
  <div><h4>Invalidation (keeping it correct)</h4><ul>
    <li><b>Delete on write:</b> after the DB commit, <code>DEL key</code>; next read repopulates. Default.</li>
    <li><b>TTL:</b> bounded staleness with no code paths to forget; use as the safety net under delete‑on‑write.</li>
    <li><b>Event‑driven:</b> CDC / Kafka event → invalidate or refresh consumers (Ticketmaster: venue changes → drop <code>event:123</code>).</li>
    <li><b>Versioned keys:</b> <code>event:123:v7</code>; bump the version, old key ages out. Avoids the delete/read race.</li>
    <li>State the acceptable staleness out loud: "a few seconds is fine for the event page, never for seat availability."</li></ul></div>
  <div><h4>Write strategy (how writes reach the cache)</h4><ul>
    <li><b>Cache‑aside:</b> app writes DB, invalidates cache, fills on next miss. Default; simple, cache only holds what's read.</li>
    <li><b>Write‑through:</b> write cache and DB together. Always consistent, writes pay for both; use when reads follow writes immediately.</li>
    <li><b>Write‑around:</b> write DB only, skip cache. Avoids polluting cache with data nobody reads (bulk imports, logs).</li>
    <li><b>Write‑back / write‑behind:</b> write cache, flush to DB async. Fastest writes, absorbs bursts (counters, likes), but loses data if the cache dies first.</li></ul></div>
  <div><h4>Say the data structure</h4><ul>
    <li>Sorted set: leaderboards, waiting‑room order, timelines by score</li>
    <li>Hash: an object's fields, partial updates</li>
    <li>List: recent items, simple queue</li>
    <li>String + INCR/DECR: counters, rate limits</li>
    <li>Set: membership, dedupe</li></ul></div>
  <div><h4>Failure modes to mention</h4><ul>
    <li>Stampede / thundering herd: hot key expires, thousands hit DB → lock / single‑flight, refresh early, jitter TTLs</li>
    <li>Cache down: circuit breaker, in‑process fallback, load shed until it recovers</li>
    <li>Hot key: one node saturated → split key, replicate reads, cache app‑side</li>
    <li>Cache pollution: caching everything; cache only read‑often, change‑rarely data</li>
    <li>Delete/read race: read fills stale value after a concurrent delete → short TTL or versioned keys</li></ul></div>
</div>

### Memcached vs Redis: the difference is what the value can be

<div class="cards">
  <div>
    <h4>Memcached: key → blob</h4>
<pre><code>"user:123" ──► "Kiran,40,San Jose"
"product:123" ──► '{"name":"iPhone","price":999}'</code></pre>
    <ul>
      <li>Value is opaque bytes; Memcached doesn't know there are fields inside.</li>
      <li>Multi‑threaded, very high throughput for simple get/set.</li>
      <li>Good for: page/HTML cache, DB query results, API response cache, session blobs.</li>
    </ul>
  </div>
  <div>
    <h4>Redis: key → data structure</h4>
<pre><code>"user:123"    ──► HASH        name=Kiran age=40
"jobs"        ──► LIST        [job1, job2, job3]
"leaderboard" ──► SORTED SET  alice→950 bob→800
"page_views"  ──► INTEGER     1042
"events"      ──► STREAM      append‑only log</code></pre>
    <ul>
      <li>Use when the app needs to operate on the cached data itself, not just fetch it.</li>
      <li>Each command is atomic (single thread), so counters, locks, and queues need no extra coordination.</li>
    </ul>
  </div>
</div>
<pre><code>INCR page_views                      # counter
HSET user:123 name Kiran age 40      # object with fields, partial update
ZADD leaderboard 950 alice           # ranked set
LPUSH jobs job123 ; RPOP jobs        # queue
SET lock:ticket:9 tok NX PX 30000    # distributed lock with TTL</code></pre>
<table>
  <tbody><tr><th>Need</th><th>Choose</th></tr>
  <tr><td>Simple key → blob cache</td><td>Memcached (or either)</td></tr>
  <tr><td>Very high‑throughput simple cache</td><td>Memcached</td></tr>
  <tr><td>Cache DB query as one JSON blob</td><td>Either</td></tr>
  <tr><td>Key → value plus richer operations</td><td>Redis</td></tr>
  <tr><td>Counters, rate limiter</td><td>Redis STRING + INCR</td></tr>
  <tr><td>Session / user object with fields</td><td>Redis HASH</td></tr>
  <tr><td>Leaderboard, ranking, waiting‑room order</td><td>Redis SORTED SET</td></tr>
  <tr><td>Queue</td><td>Redis LIST / STREAM (Kafka if you need retention and replay)</td></tr>
  <tr><td>Distributed lock</td><td>Redis SET NX PX</td></tr>
</tbody></table>
<div class="note"><b>Interview line:</b> "Memcached is a blob cache; Redis is a data‑structure server. I pick Memcached when I only ever get and set, Redis when I need to increment, rank, push/pop, or lock."</div>

## Data modeling: primary keys, indexes, and the one rule {#fd-data}

<figure>
<svg viewBox="0 0 980 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Example normalized schema with primary keys, foreign keys and indexes, plus a DynamoDB key design">
  <style>.b{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.h{font-size:13px;font-weight:600;fill:#1B2430}.m{font-size:11px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.s{font-size:11px;fill:#5B6673}.k{font-size:11px;fill:#1F4E9E;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.4;fill:none}</style>
  <text class="h" x="20" y="24">Relational (Postgres)</text>
  <rect class="b" x="20" y="40" width="190" height="96"></rect><text class="h" x="30" y="60">Users</text>
  <text class="k" x="30" y="78">userId  PK (uuid/bigint)</text><text class="m" x="30" y="94">email   UNIQUE index</text><text class="m" x="30" y="110">name</text><text class="m" x="30" y="126">createdAt</text>
  <rect class="b" x="260" y="40" width="210" height="112"></rect><text class="h" x="270" y="60">Orders</text>
  <text class="k" x="270" y="78">orderId PK</text><text class="k" x="270" y="94">userId  FK → index</text><text class="m" x="270" y="110">status</text><text class="m" x="270" y="126">createdAt</text>
  <text class="k" x="270" y="142">idx(userId, createdAt DESC)</text>
  <path class="f" d="M210 78 L258 94"></path>
  <text class="s" x="20" y="180">Index what you filter/sort by. Composite index order = query order.</text>
  <text class="s" x="20" y="196">Every index slows writes; don't index columns you never query.</text>
  <text class="s" x="20" y="212">Start normalized; denormalize a hot read path only with a reason.</text>

  <text class="h" x="540" y="24">NoSQL (DynamoDB) — design from the query</text>
  <rect class="b" x="540" y="40" width="420" height="112"></rect><text class="h" x="550" y="60">Posts</text>
  <text class="k" x="550" y="78">PK: userId          → "all posts for user X" = one partition</text>
  <text class="k" x="550" y="94">SK: createdAt#postId → sorted, range queries, pagination</text>
  <text class="m" x="550" y="110">GSI on hashtag if you also need "posts with #tag"</text>
  <text class="m" x="550" y="126">no joins: embed or duplicate what the read needs</text>
  <text class="m" x="550" y="142">high‑cardinality PK, or you get a hot partition</text>
  <text class="s" x="540" y="180">Know your access patterns first, then choose keys. Unplanned queries = full scan.</text>
  <text class="s" x="540" y="196">Search / geo / full text → external index (Elasticsearch, PostGIS) fed by CDC.</text>
</svg>
</figure>

## Scaling ladder: earn each rung with numbers {#fd-scale}

<ol class="order">
  <li><b>Vertical + tune</b> — a single Postgres does tens of thousands of QPS and terabytes. Say the number before adding anything.</li>
  <li><b>Read replicas</b> — reads scale out, writes still one primary, replica lag is eventual consistency.</li>
  <li><b>Cache</b> — takes the read load off the DB; only for read‑heavy, rarely‑changing data.</li>
  <li><b>Queue</b> — decouple and absorb write bursts; not for anything with a tight latency SLA.</li>
  <li><b>Shard</b> — when writes &gt; ~10K TPS or data &gt; tens of TB. Choose the shard key by the dominant query, state what becomes slow (cross‑shard queries, transactions), watch for hot shards (celebrity problem).</li>
</ol>
<div class="cards">
  <div><h4>Consistent hashing</h4><ul>
    <li>Servers and keys on a ring; key → next server clockwise.</li>
    <li>Add/remove a node moves ~1/N of keys, not ~all like <code>hash % N</code>.</li>
    <li>Virtual nodes smooth the distribution.</li>
    <li>Mention it for caches, Cassandra/Dynamo sharding, elastic scaling. Redis Cluster uses fixed hash slots instead.</li></ul></div>
  <div><h4>CAP / PACELC</h4><ul>
    <li>Under partition: consistency or availability. Normally: consistency or latency.</li>
    <li>Default eventual consistency for feeds, search, analytics.</li>
    <li>Strong consistency for money, inventory, bookings, uniqueness.</li>
    <li>Mix per component in one system; say which is which.</li></ul></div>
  <div><h4>Queues vs streams</h4><ul>
    <li>Queue (SQS): work items, consumed once, retries, DLQ.</li>
    <li>Stream (Kafka): retained log, many consumer groups, replay, ordering per partition key.</li>
    <li>Always pair a queue with backpressure or you're hiding a capacity gap.</li></ul></div>
  <div><h4>Distributed locks</h4><ul>
    <li>Redis <code>SET NX PX</code> with TTL for short holds; ZooKeeper/etcd (consensus) when correctness must survive node loss.</li>
    <li>Prefer DB row locks / conditional updates when the resource already lives in the DB.</li>
    <li>Deadlock prevention: acquire in a fixed global order, always use timeouts.</li></ul></div>
</div>

## Numbers to keep in your head {#fd-numbers}

<table>
  <tbody><tr><th>Thing</th><th>Number</th><th>When it matters</th></tr>
  <tr><td>Memory / SSD / same‑DC network / cross‑continent</td><td>ns / µs / 1–10 ms / 80–150 ms</td><td>Cache or not, regional deployment or not</td></tr>
  <tr><td>Redis node</td><td>~100K+ ops/s, ~1 ms, memory‑bound</td><td>Hot key ceiling, when to shard the cache</td></tr>
  <tr><td>Postgres node</td><td>~10–50K TPS, few TB comfortable</td><td>When sharding is justified</td></tr>
  <tr><td>App server</td><td>~5–10K req/s, 100K+ open connections</td><td>Fleet sizing, WebSocket capacity</td></tr>
  <tr><td>Kafka broker</td><td>up to ~1M msg/s</td><td>Almost never the bottleneck</td></tr>
  <tr><td>Blob storage (S3)</td><td>treat as unlimited, ~$0.02/GB‑month</td><td>Never put media in the DB</td></tr>
</tbody></table>

### Per component: capacity and when to scale it

<table>
  <tbody><tr><th>Component</th><th>Key metrics</th><th>Scale triggers</th></tr>
  <tr><td>Caching</td><td>~1 ms latency · 100K+ ops/s · memory‑bound (up to ~1 TB)</td><td>Hit rate &lt; 80% · latency &gt; 1 ms · memory &gt; 80% · churn / thrashing</td></tr>
  <tr><td>Databases</td><td>Up to ~50K TPS · sub‑5 ms cached reads · 64 TiB+ storage</td><td>Writes &gt; 10K TPS · uncached read latency &gt; 5 ms · geographic distribution needs</td></tr>
  <tr><td>App servers</td><td>100K+ concurrent connections · 8–64 cores @ 2–4 GHz · 64–512 GB RAM (up to 2 TB)</td><td>CPU &gt; 70% · latency &gt; SLA · connections near 100K/instance · memory &gt; 80%</td></tr>
  <tr><td>Message queues</td><td>Up to ~1M msgs/s per broker · sub‑5 ms end‑to‑end · up to ~50 TB storage</td><td>Throughput near 800K msgs/s · ~200K partitions per cluster · growing consumer lag</td></tr>
</tbody></table>

## Default picks (know one per box, deeply) {#fd-defaults}

<table>
  <tbody><tr><th>Need</th><th>Pick</th><th>One‑line justification</th></tr>
  <tr><td>Core DB, product design</td><td>Postgres</td><td>ACID transactions protect invariants; indexes for every query shape</td></tr>
  <tr><td>Core DB, infra / huge write scale</td><td>DynamoDB or Cassandra</td><td>Partition‑key design, horizontal scale; Cassandra for append‑heavy</td></tr>
  <tr><td>Cache</td><td>Redis</td><td>Data structures + atomic ops; rebuildable data only</td></tr>
  <tr><td>Blobs</td><td>S3 + CDN</td><td>Presigned upload/download; DB holds the URL</td></tr>
  <tr><td>Search</td><td>Elasticsearch</td><td>Inverted index, fuzzy; synced by CDC, slightly stale</td></tr>
  <tr><td>Queue / stream</td><td>SQS / Kafka</td><td>Burst buffer / replayable log with consumer groups</td></tr>
  <tr><td>Stream processing</td><td>Flink</td><td>Windowed aggregates in real time</td></tr>
  <tr><td>Coordination / locks</td><td>Redis, or ZooKeeper if it must be correct under failure</td><td>Short TTL locks vs consensus</td></tr>
  <tr><td>Edge</td><td>API Gateway (or nginx) + L7 LB</td><td>Auth, rate limit, routing in one place</td></tr>
</tbody></table>
