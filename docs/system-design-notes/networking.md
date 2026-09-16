---
title: "Networking essentials, compact"
slug: /system-design-notes/networking
sidebar_position: 3
sidebar_label: "Networking essentials, compact"
description: "layers · TCP/UDP · HTTP · API styles · realtime · load balancing · failure handling"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/networking/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">layers · TCP/UDP · HTTP · API styles · realtime · load balancing · failure handling</span>
</header>
<p>Infra and distributed‑systems interviews probe this; product interviews only need the surface. Either way, know the defaults and be able to say why you'd deviate.</p>

## One web request, layer by layer {#nw-request}

<figure>
<svg viewBox="0 0 980 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sequence: DNS lookup, TCP three-way handshake, HTTP request and response, TCP four-way teardown, with layer labels">
  <defs><marker id="a9" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1B2430"></path></marker></defs>
  <style>.h{font-size:13px;font-weight:600;fill:#1B2430}.s{font-size:11px;fill:#5B6673}.m{font-size:11px;font-family:"IBM Plex Mono",Menlo,monospace;fill:#1B2430}.ln{stroke:#1B2430;stroke-width:1.3;fill:none;marker-end:url(#a9)}.band{rx:6;opacity:.9}</style>
  <text class="h" x="20" y="24">Client</text><text class="h" x="900" y="24">Server</text>
  <line x1="50" y1="32" x2="50" y2="215" stroke="#D6DDE5" stroke-width="2"></line><line x1="920" y1="32" x2="920" y2="215" stroke="#D6DDE5" stroke-width="2"></line>
  <rect class="band" x="70" y="36" width="820" height="26" fill="#F1E3F1"></rect><text class="m" x="80" y="53">L7 DNS: hellointerview.com → 32.42.52.62  (UDP, cached by TTL)</text>
  <rect class="band" x="70" y="68" width="820" height="44" fill="#DDF3F0"></rect>
  <path class="ln" d="M60 80 L910 80"></path><text class="m" x="440" y="76">SYN</text>
  <path class="ln" d="M910 92 L60 92"></path><text class="m" x="430" y="104">SYN‑ACK</text>
  <path class="ln" d="M60 104 L910 104"></path><text class="m" x="700" y="100">ACK  → TCP established (1 RTT)</text>
  <rect class="band" x="70" y="118" width="820" height="44" fill="#E4ECF9"></rect>
  <path class="ln" d="M60 132 L910 132"></path><text class="m" x="400" y="128">HTTP GET /posts/1  (TLS handshake first if HTTPS, +1–2 RTT)</text>
  <path class="ln" d="M910 152 L60 152"></path><text class="m" x="410" y="148">HTTP/1.1 200 OK + JSON</text>
  <rect class="band" x="70" y="168" width="820" height="44" fill="#DDF3F0"></rect>
  <path class="ln" d="M60 180 L910 180"></path><text class="m" x="440" y="176">FIN</text>
  <path class="ln" d="M910 190 L60 190"></path><text class="m" x="440" y="202">ACK, FIN</text>
  <path class="ln" d="M60 204 L910 204"></path><text class="m" x="700" y="200">ACK → closed (4‑way)</text>
  <text class="s" x="70" y="226">Every request repeats the handshakes unless you keep the connection alive (HTTP keep‑alive, HTTP/2 multiplexing). That overhead is why persistent connections and L4 vs L7 matter.</text>
</svg>
</figure>
<div class="cards">
  <div><h4>Layers that matter</h4><ul>
    <li><b>L3 Network:</b> IP. Addressing + routing, best‑effort packets. Public IPs are routable; private ones aren't.</li>
    <li><b>L4 Transport:</b> TCP, UDP, QUIC. Reliability, ordering, flow/congestion control (or not).</li>
    <li><b>L7 Application:</b> DNS, HTTP, WebSocket, WebRTC, gRPC. Runs in user space, easy to change.</li>
    <li>Higher layer = more latency and processing per hop.</li></ul></div>
  <div><h4>TCP vs UDP</h4><ul>
    <li><b>TCP:</b> connection, guaranteed in‑order delivery, flow + congestion control, 20–60 B header. Default; usually unspoken.</li>
    <li><b>UDP:</b> connectionless, no delivery/order guarantees, 8 B header, lowest latency. "Spray and pray."</li>
    <li><b>Pick UDP when:</b> latency beats reliability and loss is tolerable: live video, gaming, VoIP, DNS, telemetry/logs. Browsers only get UDP via WebRTC, so plan a fallback for web clients.</li>
    <li><b>QUIC/HTTP‑3:</b> TCP‑like guarantees over UDP with faster setup. Mention, don't dwell.</li></ul></div>
  <div><h4>HTTP essentials</h4><ul>
    <li>Stateless request/response; keep servers stateless too.</li>
    <li><b>Methods:</b> GET (idempotent, no body) · POST create · PUT replace · PATCH partial · DELETE (idempotent).</li>
    <li><b>Codes:</b> 200 · 201 created · 301/302 moved · 400 · 401 unauthenticated · 403 forbidden · 404 · 409 conflict · 429 rate limited · 500 · 502 bad upstream · 503 overloaded.</li>
    <li>Headers = flexible key/values; content negotiation (<code>Accept‑Encoding: gzip, br</code>) is the model for extensible APIs.</li>
    <li><b>HTTPS = HTTP + TLS.</b> Encrypted in transit, but the body is still untrusted: never take userId from the body; take it from the verified token.</li></ul></div>
</div>

## API styles {#nw-api}

<table>
  <tbody><tr><th>Style</th><th>What</th><th>Use when</th><th>Avoid when</th></tr>
  <tr><td>REST</td><td>Resources as URLs, HTTP verbs, JSON. <code>GET /users/{id}</code>, <code>GET /users/{id}/posts</code>. Think nouns, not <code>updateUser</code>: <code>startGame</code> → <code>PATCH /games/{id} {status:"started"}</code>.</td><td>Default for every interview; public APIs.</td><td>Extreme throughput where JSON parsing dominates (rare).</td></tr>
  <tr><td>GraphQL</td><td>Client declares exactly the fields it wants; one query replaces N REST calls. Fixes under‑fetching (many round trips) and over‑fetching (bloated responses).</td><td>Many client teams iterating fast on overlapping data; mobile bandwidth.</td><td>Interviews with fixed requirements; resolvers hide the query patterns the interviewer wants to see.</td></tr>
  <tr><td>gRPC</td><td>Protobuf (binary, schema, ~3× smaller than JSON) over HTTP/2. Typed stubs, streaming, deadlines, built‑in client‑side LB.</td><td>Internal service‑to‑service when network dominates latency.</td><td>Public APIs / browsers (no native support). Say "REST outside, gRPC inside."</td></tr>
</tbody></table>

## Realtime: pick the weakest tool that works {#nw-realtime}

<table>
  <tbody><tr><th>Tool</th><th>Direction</th><th>How</th><th>Use</th><th>Cost</th></tr>
  <tr><td>Polling</td><td>client asks</td><td>GET every N seconds</td><td>Few clients, short waits (purchase status)</td><td>Wasted calls, N‑second lag</td></tr>
  <tr><td>Long polling</td><td>client asks, server holds</td><td>Request parks until data or timeout</td><td>Near‑realtime without infra changes</td><td>One open request per client</td></tr>
  <tr><td>SSE</td><td>server → client</td><td>One HTTP response streamed as <code>data:</code> chunks; <code>EventSource</code> auto‑reconnects with Last‑Event‑ID</td><td>Notifications, auction prices, live feeds, progress</td><td>Proxies may cut or buffer it; server must replay missed events</td></tr>
  <tr><td>WebSocket</td><td>both ways</td><td>HTTP Upgrade → raw bidirectional frames on the same TCP; you define the message schema (JSON)</td><td>Chat, collaborative editing, games, tickers</td><td>Stateful connections: L4 LB, connection registry, reconnect logic, every middlebox must support it. Justify or get a thumbs‑down.</td></tr>
  <tr><td>WebRTC</td><td>peer ↔ peer</td><td>UDP; signaling server to find peers, STUN for NAT hole‑punching, TURN relay as fallback</td><td>Audio/video calls and conferencing only</td><td>Painful, lossy; don't reach for it for docs or chat</td></tr>
</tbody></table>

## Load balancing {#nw-lb}

<figure>
<svg viewBox="0 0 980 190" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="L4 load balancer passes TCP connection through to one server; L7 load balancer terminates the connection and forwards HTTP requests, possibly to different servers">
  <defs><marker id="a10" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker></defs>
  <style>.b{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.h{font-size:13px;font-weight:600;fill:#1B2430}.s{font-size:11px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#a10)}.an{font-size:11px;fill:#1F4E9E}</style>
  <text class="h" x="20" y="24">L4 (NLB): TCP pass‑through</text>
  <rect class="b" x="20" y="60" width="80" height="40"></rect><text class="h" x="60" y="85" text-anchor="middle">Client</text>
  <rect class="b" x="170" y="60" width="90" height="40" stroke="#0F766E"></rect><text class="h" x="215" y="85" text-anchor="middle">L4 LB</text>
  <rect class="b" x="340" y="40" width="80" height="34"></rect><text class="s" x="380" y="62" text-anchor="middle">server 1</text>
  <rect class="b" x="340" y="86" width="80" height="34"></rect><text class="s" x="380" y="108" text-anchor="middle">server 2</text>
  <path class="f" d="M100 80 L168 80"></path><path class="f" d="M260 80 L338 60"></path>
  <text class="s" x="20" y="140">Routes by IP:port only. One TCP connection sticks to one</text>
  <text class="s" x="20" y="156">server for its lifetime → WebSockets, raw speed.</text>
  <text class="s" x="20" y="172">Can't see the HTTP inside.</text>

  <text class="h" x="540" y="24">L7 (ALB): terminate + re‑open</text>
  <rect class="b" x="540" y="60" width="80" height="40"></rect><text class="h" x="580" y="85" text-anchor="middle">Client</text>
  <rect class="b" x="690" y="60" width="90" height="40" stroke="#1F4E9E"></rect><text class="h" x="735" y="85" text-anchor="middle">L7 LB</text>
  <rect class="b" x="860" y="40" width="100" height="34"></rect><text class="s" x="910" y="62" text-anchor="middle">/api → svc A</text>
  <rect class="b" x="860" y="86" width="100" height="34"></rect><text class="s" x="910" y="108" text-anchor="middle">/web → svc B</text>
  <path class="f" d="M620 80 L688 80"></path><path class="f" d="M780 72 L858 58"></path><path class="f" d="M780 88 L858 102"></path>
  <text class="s" x="540" y="140">Reads URL, headers, cookies; TLS termination; per‑request routing.</text>
  <text class="s" x="540" y="156">More CPU, more features. Default for HTTP, long polling, SSE.</text>
  <text class="s" x="540" y="172">Overlaps with API gateway duties.</text>
</svg>
</figure>
<div class="cards">
  <div><h4>Client‑side vs dedicated</h4><ul>
    <li><b>Client‑side:</b> client fetches server list from a registry and picks itself. No extra hop. Works with few controlled clients (gRPC, Redis Cluster's slot map) or many clients that tolerate slow updates (DNS round‑robin, bounded by TTL).</li>
    <li><b>Dedicated:</b> extra hop, but instant membership updates and fine routing control. Default for anything public.</li>
    <li>LB single point of failure? Two LBs in different zones, rotated via DNS.</li></ul></div>
  <div><h4>Algorithms</h4><ul>
    <li><b>Round robin / random:</b> stateless services; new servers pick up traffic automatically.</li>
    <li><b>Least connections:</b> persistent connections (SSE, WebSocket) so one box doesn't accumulate them all.</li>
    <li><b>Least response time:</b> heterogeneous backends.</li>
    <li><b>IP hash:</b> stickiness without cookies; hurts balance.</li></ul></div>
  <div><h4>Health checks and scale</h4><ul>
    <li>L4 check: TCP connect. L7 check: <code>GET /health</code> expects 200. Failing servers are pulled, restored on recovery.</li>
    <li>Software (nginx, HAProxy, Envoy) and cloud (ELB/ALB/NLB) LBs are enough; if asked about 100M+ req/s, say hardware (F5).</li>
    <li>Prefer vertical scaling where it works; horizontal + LB is what interviews expect.</li></ul></div>
</div>

## Regionalization and latency {#nw-geo}

<div class="cards">
  <div><h4>Physics</h4><ul>
    <li>Light in fiber ≈ 200,000 km/s. NY↔London ≈ 5,600 km → ≥56 ms round trip before any processing. Same‑region &lt;1 ms.</li>
    <li>Regions contain multiple availability zones (separate buildings/power); replicate across regions for global users.</li>
    <li>Rule: put the data next to the compute, and both next to the user.</li></ul></div>
  <div><h4>Two levers</h4><ul>
    <li><b>CDN:</b> edge caches in hundreds of cities. Static media always; also cacheable dynamic responses (search results, product pages).</li>
    <li><b>Regional partitioning:</b> shard by geography when queries are local (Uber: Miami riders never need NY drivers). Regional services + regional DB co‑located = fast; cross‑region only for the rare global query.</li></ul></div>
</div>

## Failure handling deep dives (senior+ bait) {#nw-failures}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/networking/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<figure>
<svg viewBox="0 0 980 150" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Circuit breaker states: closed, open, half-open with transitions">
  <defs><marker id="a11" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker></defs>
  <style>.b{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.h{font-size:13px;font-weight:600;fill:#1B2430}.s{font-size:11px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#a11)}.an{font-size:11px;fill:#1F4E9E}</style>
  <text class="h" x="20" y="24">Circuit breaker</text>
  <rect class="b" x="40" y="50" width="150" height="50" stroke="#0F766E" fill="#DDF3F0"></rect><text class="h" x="115" y="71" text-anchor="middle">CLOSED</text><text class="s" x="115" y="88" text-anchor="middle">calls flow, count failures</text>
  <rect class="b" x="415" y="50" width="150" height="50" stroke="#B45309" fill="#FBEBD5"></rect><text class="h" x="490" y="71" text-anchor="middle">OPEN</text><text class="s" x="490" y="88" text-anchor="middle">fail fast, no calls</text>
  <rect class="b" x="790" y="50" width="150" height="50"></rect><text class="h" x="865" y="71" text-anchor="middle">HALF‑OPEN</text><text class="s" x="865" y="88" text-anchor="middle">let one test call through</text>
  <path class="f" d="M190 68 L413 68"></path><text class="an" x="240" y="62">failures &gt; threshold</text>
  <path class="f" d="M565 68 L788 68"></path><text class="an" x="640" y="62">after timeout</text>
  <path class="f" d="M865 100 C 865 135, 115 135, 115 102"></path><text class="an" x="430" y="132">test succeeds → close</text>
  <path class="f" d="M790 90 C 700 115, 600 115, 565 92"></path><text class="an" x="620" y="112">test fails → reopen</text>
</svg>
</figure>
<div class="cards">
  <div><h4>Timeouts, retries, backoff, jitter</h4><ul>
    <li>Every network call gets a timeout. Assume the network is not reliable.</li>
    <li>Retry transient failures; only safe if the API is idempotent.</li>
    <li>Say the phrase: <b>"retry with exponential backoff and jitter."</b> Without jitter, all clients retry in lockstep and jackhammer the recovering service.</li></ul></div>
  <div><h4>Idempotency</h4><ul>
    <li>GET/DELETE are naturally idempotent; writes need an <b>idempotency key</b> (client‑generated UUID, or e.g. userId+date).</li>
    <li>Server stores the key with the result; a duplicate returns the stored result (friendly) or 409 (less friendly). Either way the card is charged once.</li>
    <li>Flash Sale: idempotency key on <code>POST /reservations</code> and on the Stripe webhook by event id.</li></ul></div>
  <div><h4>Cascading failures</h4><ul>
    <li>"What happens when this service goes down?" Answer with the chain: timeouts pile up → threads exhausted → callers fail → their callers fail.</li>
    <li>Thundering herd on recovery: DB comes back one node at a time and retries pin it down.</li>
    <li>Circuit breaker sites: third‑party APIs, DB connections, service‑to‑service calls, anything slow. Pair with fallbacks (cached value, degraded response) and load shedding.</li></ul></div>
</div>
