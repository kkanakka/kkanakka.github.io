---
title: "Scalable network I/O service (upload / download / streaming)"
slug: /aire/network-io-service
sidebar_position: 35
sidebar_label: "Scalable network I/O service (upload / d…"
description: "hard · high‑volume bytes · zero‑copy · backpressure · range requests · resumable"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/network-io-service/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">hard · high‑volume bytes · zero‑copy · backpressure · range requests · resumable</span>
</header>
<p>A service whose job is moving bytes: clients upload large objects, download them, and stream media, at tens of Gb/s aggregate. The interesting design is in the data plane: how a single node pushes bytes without copying them through userspace, how it applies backpressure, and how the control plane stays out of the way.</p>

## Requirements {#network-io-service-req}

<div class="board">
  <div><h4>Functional</h4><ol>
      <li>Upload objects up to TBs with resume; download with HTTP Range; stream media with seeking</li>
      <li>Authenticated, quota‑enforced, integrity‑checked</li>
      <li>Horizontal scale across nodes and regions</li>
      <li class="out">Transcoding, search</li>
  </ol></div>
  <div><h4>Non‑functional</h4><ol>
      <li>Per node: saturate 25–100 Gb/s NICs with low CPU</li>
      <li>Aggregate: 100K concurrent streams; p99 time‑to‑first‑byte &lt; 100 ms</li>
      <li>No unbounded buffering: slow clients must not consume node memory</li>
      <li>Resumable and idempotent transfers; end‑to‑end checksums</li>
  </ol></div>
</div>
<div class="note"><b>Per‑node math:</b> 100 Gb/s ≈ 12.5 GB/s. If every byte is copied kernel→user→kernel that's ~4 memory copies per byte and the CPU becomes the bottleneck. sendfile/splice (zero‑copy) and io_uring or epoll‑based async I/O keep the CPU at a few percent per 10 Gb/s.</div>


## Scale, performance and safety targets {#network-io-service-targets}

<p>This is a data‑plane question. The numbers are per node and per byte, and they are what rule out every design that touches bytes in userspace.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> 100K concurrent streams across the fleet, but only tens of thousands of control‑plane operations per second — the request count is small and the byte count is enormous.</li>
    <li><b>Data volume:</b> 100 Gb/s per node ≈ 12.5 GB/s. Objects range from kilobytes to terabytes, uploaded in parts; a single node moves petabytes per day.</li>
    <li><b>Growth:</b> object sizes and stream counts both grow ~2× annually, while NIC speeds step in generations — so per‑byte CPU cost is the thing that must stay near zero, not the number of cores.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> time to first byte p99 &lt; 100 ms including a range seek; upload part acknowledgement p99 &lt; 200 ms. Total transfer time is bandwidth‑bound and deliberately not an SLA.</li>
    <li><b>Throughput:</b> saturate a 25–100 Gb/s NIC at a few percent CPU. Copying every byte kernel→user→kernel costs ~4 copies per byte and makes the CPU the bottleneck long before the NIC is — which is why <code>sendfile</code>/<code>splice</code> and io_uring are requirements rather than optimisations.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the characteristic attacks are resource‑exhaustion by design — slowloris clients holding thousands of connections open, slow readers forcing the server to buffer, range requests crafted to defeat caching, and uploads that never complete but hold staging space.</li>
    <li><b>Rate limiting:</b> per‑connection and per‑account bandwidth caps, a limit on concurrent streams per account, idle and total timeouts on every transfer, a cap on parts per upload and a TTL on abandoned upload sessions.</li>
    <li><b>Data sensitivity:</b> arbitrary user objects. Encrypt at rest and in transit, authorise every range request rather than trusting a URL, checksum end to end so corruption is detected rather than served, and ensure deletion reaches staging caches and CDN edges as well as origin.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.99% for downloads. Individual node failure must be invisible — sessions are resumable, so a client reconnects and continues rather than restarting a terabyte.</li>
    <li><b>Degraded mode:</b> NVMe staging full → flush aggressively and reject new uploads with a retryable error rather than stalling active ones. Object storage slow → serve from staging and let flushes lag. Node saturated → shed new connections at the load balancer instead of degrading every existing stream.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> an object becomes visible only when its manifest is committed, so a partially uploaded terabyte is never readable. Parts themselves are immutable and content‑addressed, making re‑uploads idempotent.</li>
    <li><b>Durability:</b> eleven nines once committed to object storage; NVMe staging is explicitly a cache and never the system of record, which is what allows a staging node to be wiped without ceremony.</li>
    <li><b>Backpressure:</b> the defining property. A slow client must consume socket buffers and nothing else — any design where a slow reader grows server memory will fall over the first time 10,000 of them arrive together.</li></ul></div>
</div>

## Entities and API {#network-io-service-api}

<p>Object (id, size, etag, parts[], storageLocations) · Upload session (id, received ranges, expiry) · Stream session (id, offset, bitrate) · Node (capacity, load) · Lease (upload → node affinity).</p>
<pre><code>PUT  /objects/:id?uploadId=&amp;part=N       (chunked/multipart, Content-Range, resumable)
POST /objects/:id/uploads                 -&gt; uploadId;  POST …/complete {parts, etags}
GET  /objects/:id     Range: bytes=a-b     -&gt; 206 Partial Content, ETag, Accept-Ranges
GET  /stream/:id/playlist.m3u8            -&gt; HLS/DASH segments served as normal ranged GETs
HEAD /objects/:id                          -&gt; size, etag (for resume)</code></pre>

## Design {#network-io-service-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/network-io-service/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Network I/O service: L4 load balancer to I/O nodes running an async event loop with zero-copy send and bounded per-connection buffers; upload path streams chunks to local NVMe staging then object storage; download path serves from local cache or storage via sendfile; control plane holds metadata and sessions">
<defs><marker id="dg1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="dg3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#dg1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#dg3);stroke-dasharray:2 4}.lbl{font-size:10.5px;fill:#1F4E9E}</style>
<rect class="box" x="20" y="110" width="100" height="60"></rect><text class="tb" x="70" y="128" text-anchor="middle">Clients</text>
<text class="ts" x="70" y="144" text-anchor="middle">range GETs</text>
<text class="ts" x="70" y="157" text-anchor="middle">resumable PUTs</text>
<rect class="box" x="150" y="110" width="100" height="60"></rect><text class="tb" x="200" y="128" text-anchor="middle">L4 LB</text>
<text class="ts" x="200" y="144" text-anchor="middle">consistent hash</text>
<text class="ts" x="200" y="157" text-anchor="middle">by object id</text>
<rect class="box" x="290" y="40" width="200" height="130" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="390" y="58" text-anchor="middle">I/O node (×N)</text>
<text class="ts" x="390" y="74" text-anchor="middle">epoll / io_uring event loop</text>
<text class="ts" x="390" y="87" text-anchor="middle">zero-copy sendfile / splice</text>
<text class="ts" x="390" y="100" text-anchor="middle">per-conn bounded buffers</text>
<text class="ts" x="390" y="113" text-anchor="middle">TLS offload (kTLS)</text>
<text class="ts" x="390" y="126" text-anchor="middle">local NVMe cache</text>
<rect class="box" x="530" y="40" width="140" height="60" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="tb" x="600" y="58" text-anchor="middle">Object storage</text>
<text class="ts" x="600" y="74" text-anchor="middle">durable, erasure coded</text>
<rect class="box" x="530" y="120" width="140" height="60"></rect><text class="tb" x="600" y="138" text-anchor="middle">NVMe staging</text>
<text class="ts" x="600" y="154" text-anchor="middle">uploads land here</text>
<text class="ts" x="600" y="167" text-anchor="middle">async flush to storage</text>
<rect class="box" x="700" y="40" width="140" height="60"></rect><text class="tb" x="770" y="58" text-anchor="middle">Control plane</text>
<text class="ts" x="770" y="74" text-anchor="middle">metadata, sessions</text>
<text class="ts" x="770" y="87" text-anchor="middle">auth, quota</text>
<rect class="box" x="700" y="120" width="140" height="60" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="770" y="138" text-anchor="middle">Metadata DB</text>
<text class="ts" x="770" y="154" text-anchor="middle">objects, parts, etags</text>
<rect class="box" x="870" y="60" width="90" height="100" stroke="#B45309"></rect><text class="tb" x="915" y="78" text-anchor="middle">Telemetry</text>
<text class="ts" x="915" y="94" text-anchor="middle">bytes/s, TTFB</text>
<text class="ts" x="915" y="107" text-anchor="middle">buffer pressure</text>
<line class="f" x1="120" y1="140" x2="148" y2="140"></line>
<line class="f" x1="250" y1="140" x2="288" y2="140"></line>
<line class="f" x1="490" y1="80" x2="528" y2="70"></line>
<text class="lbl" x="509" y="69" text-anchor="middle">read/write</text>
<line class="f" x1="490" y1="140" x2="528" y2="150"></line>
<text class="lbl" x="509" y="139" text-anchor="middle">stage</text>
<line class="f" x1="670" y1="70" x2="698" y2="70"></line>
<text class="lbl" x="684" y="64" text-anchor="middle">lookup</text>
<line class="f" x1="770" y1="100" x2="770" y2="118"></line>
<line class="fa" x1="490" y1="60" x2="698" y2="50"></line>
<text class="ts" x="20" y="180">Data plane nodes never call the control plane per byte; one session lookup at connection start, then pure I/O.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 712" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Upload and ranged download">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="5" y="14" width="130" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Client</text>
<line class="ln" x1="70" y1="48" x2="70" y2="692"></line>
<rect class="sb" x="173" y="14" width="130" height="34"></rect><text class="st" x="238" y="36" text-anchor="middle">L4 LB</text>
<line class="ln" x1="238" y1="48" x2="238" y2="692"></line>
<rect class="sb" x="341" y="14" width="130" height="34"></rect><text class="st" x="406" y="36" text-anchor="middle">I/O node</text>
<line class="ln" x1="406" y1="48" x2="406" y2="692"></line>
<rect class="sb" x="509" y="14" width="130" height="34"></rect><text class="st" x="574" y="36" text-anchor="middle">NVMe staging</text>
<line class="ln" x1="574" y1="48" x2="574" y2="692"></line>
<rect class="sb" x="677" y="14" width="130" height="34"></rect><text class="st" x="742" y="36" text-anchor="middle">Object storage</text>
<line class="ln" x1="742" y1="48" x2="742" y2="692"></line>
<rect class="sb" x="845" y="14" width="130" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Control plane</text>
<line class="ln" x1="910" y1="48" x2="910" y2="692"></line>
<line class="a1" x1="78" y1="80" x2="230" y2="80"></line>
<text class="sl" x="154" y="74" text-anchor="middle">POST /objects/:id/uploads</text>
<line class="a1" x1="246" y1="114" x2="398" y2="114"></line>
<text class="sl" x="322" y="108" text-anchor="middle">route by object hash</text>
<line class="a1" x1="414" y1="148" x2="902" y2="148"></line>
<text class="sl" x="658" y="142" text-anchor="middle">auth, quota, create session</text>
<line class="a2" x1="902" y1="182" x2="414" y2="182"></line>
<text class="sl" x="658" y="176" text-anchor="middle">uploadId</text>
<line class="a2" x1="398" y1="216" x2="78" y2="216"></line>
<text class="sl" x="238" y="210" text-anchor="middle">uploadId</text>
<line class="a1" x1="78" y1="250" x2="398" y2="250"></line>
<text class="sl" x="238" y="244" text-anchor="middle">PUT part 1 (Content-Range, sha256)</text>
<rect class="nt" x="296" y="271" width="220" height="22"></rect><text class="sl" x="406" y="286" text-anchor="middle">stream socket → file, bounded 1 MB buffer; TCP window = backpressure</text>
<line class="a1" x1="414" y1="318" x2="566" y2="318"></line>
<text class="sl" x="490" y="312" text-anchor="middle">write part</text>
<line class="a3" x1="582" y1="352" x2="734" y2="352"></line>
<text class="sl" x="658" y="346" text-anchor="middle">async flush</text>
<line class="a2" x1="398" y1="386" x2="78" y2="386"></line>
<text class="sl" x="238" y="380" text-anchor="middle">200 etag</text>
<line class="a1" x1="78" y1="420" x2="398" y2="420"></line>
<text class="sl" x="238" y="414" text-anchor="middle">PUT part 2 … resume after drop via HEAD</text>
<line class="a1" x1="78" y1="454" x2="398" y2="454"></line>
<text class="sl" x="238" y="448" text-anchor="middle">complete {parts, etags}</text>
<line class="a1" x1="414" y1="488" x2="902" y2="488"></line>
<text class="sl" x="658" y="482" text-anchor="middle">assemble manifest; mark durable</text>
<line class="a1" x1="78" y1="522" x2="398" y2="522"></line>
<text class="sl" x="238" y="516" text-anchor="middle">GET Range: bytes=0-1048575</text>
<line class="a1" x1="414" y1="556" x2="566" y2="556"></line>
<text class="sl" x="490" y="550" text-anchor="middle">in cache?</text>
<line class="a1" x1="414" y1="590" x2="734" y2="590"></line>
<text class="sl" x="574" y="584" text-anchor="middle">else fetch range</text>
<line class="a2" x1="398" y1="624" x2="78" y2="624"></line>
<text class="sl" x="238" y="618" text-anchor="middle">206 via sendfile; slow client → stop reading source</text>
<rect class="nt" x="296" y="645" width="220" height="22"></rect><text class="sl" x="406" y="660" text-anchor="middle">client stalls: no growth in memory, only socket buffers</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Client → L4 LB:</b> POST /objects/:id/uploads.
    An L4 load balancer forwards packets without terminating or inspecting the stream, so it never becomes a bottleneck for the bytes that follow.
    An L7 proxy here would buffer and re‑emit every byte, doubling the copies on the most expensive path in the system.</li>
  <li><b>L4 LB → I/O node:</b> route by object hash.
    Routing by object hash gives cache affinity: parts of the same object and repeat reads of it land on the node likely to have it staged.
    It also makes resume trivial, since a reconnecting client is steered back to the node holding its partial state.</li>
  <li><b>I/O node → Control plane:</b> auth, quota, create session.
    Authentication, quota and session creation happen once per transfer, not once per byte — the control plane is consulted at the boundaries and then stays out of the way.
    This separation is what lets a slow control plane coexist with a data plane running at line rate.</li>
  <li><b>Control plane → I/O node:</b> uploadId (response).
    The session is durable, so a client that disconnects at 900 GB of a terabyte can resume against the same id rather than starting over.</li>
  <li><b>I/O node → Client:</b> uploadId (response).
    From here the client talks only to the data plane until it completes, keeping the control plane's load proportional to transfers rather than to bytes.</li>
  <li><b>Client → I/O node:</b> PUT part 1 (Content-Range, sha256).
    Parts make a terabyte tractable: independently retryable, uploadable in parallel, and individually verifiable.
    The client supplies a checksum per part, so integrity is established at the boundary rather than inferred later.</li>
  <li><b>I/O node:</b> stream socket → file, bounded 1 MB buffer; TCP window = backpressure.
    This is the central mechanic: a small fixed buffer, and TCP's own flow control does the rest.
    When the disk or downstream is slow, the node simply stops reading the socket; the TCP window closes and the <em>client</em> slows down — backpressure propagates without any application‑level protocol.
    A design that buffers whatever the client sends will consume memory proportional to (clients × their speed), which is the classic way a byte‑moving service dies.</li>
  <li><b>I/O node → NVMe staging:</b> write part.
    Local NVMe absorbs the write at local speed, decoupling the client's upload rate from object storage's acknowledgement latency.
    Staging is explicitly a cache, so a node can be wiped and rebuilt without data loss.</li>
  <li><b>NVMe staging → Object storage:</b> async flush (async).
    Flushing happens off the client's path, so durability is achieved without making the client wait for a cross‑network write.
    The gap between staged and flushed is the window where the node matters — which is exactly why the object is not yet visible.</li>
  <li><b>I/O node → Client:</b> 200 etag (response).
    The ETag lets the client verify what the server stored and lets a retry be recognised as a duplicate rather than a new part.</li>
  <li><b>Client → I/O node:</b> PUT part 2 … resume after drop via HEAD.
    A HEAD against the session reports which parts are present, so resume needs no client‑side bookkeeping to survive a crash or a device change.
    Because parts are immutable and content‑addressed, re‑uploading one is harmless — which makes "just retry" a safe default.</li>
  <li><b>Client → I/O node:</b> complete {parts, etags}.
    Completion is the client asserting the full part list, and the server verifying it against what it holds — a mismatch fails rather than producing a truncated object.</li>
  <li><b>I/O node → Control plane:</b> assemble manifest; mark durable.
    The manifest commit is the object's moment of existence: before it, nothing is readable; after it, the object is complete and verified.
    Making visibility a single atomic step is what guarantees a reader can never see a half‑uploaded terabyte.</li>
  <li><b>Client → I/O node:</b> GET Range: bytes=0-1048575.
    Range requests are what make video seeking and resumable downloads work, and they are the normal case rather than an exception.
    Every range is authorised on its own, so possession of a URL is never sufficient to read arbitrary offsets.</li>
  <li><b>I/O node → NVMe staging:</b> in cache?
    Popular objects are served from local NVMe, which is both faster and cheaper than reaching origin for every request.
    Hash‑based routing is what makes this cache effective — the same object consistently lands on the same node.</li>
  <li><b>I/O node → Object storage:</b> else fetch range.
    Only the requested range is fetched, not the whole object, so seeking into the middle of a 10 GB video costs one range read.</li>
  <li><b>I/O node → Client:</b> 206 via sendfile; slow client → stop reading source (response).
    <code>sendfile</code>/<code>splice</code> moves bytes from page cache to socket without ever entering userspace — no copies, no application buffers, a few percent of a core per 10 Gb/s.
    For a slow client the node simply stops pulling from the source; the data sits where it already is rather than accumulating in server memory.
    Zero‑copy plus stop‑reading is the entire answer to "how do you serve 100K streams on one box".</li>
  <li><b>I/O node:</b> client stalls: no growth in memory, only socket buffers.
    The invariant worth stating explicitly: server memory is a function of connection count, never of how slow those connections are.
    That is what makes 10,000 simultaneously stalled clients a bounded, uninteresting condition instead of an outage.
    Idle timeouts then reclaim the connections themselves, so even the bounded cost is not held indefinitely.</li>
</ol>

## Deep dives {#network-io-service-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/network-io-service/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
<div><h4>Node data plane</h4><ul><li>Async I/O (epoll/io_uring), one event loop per core, no thread per connection; 100K connections is memory for sockets, not stacks.</li><li>Zero‑copy: <code>sendfile</code>/<code>splice</code> from page cache or NVMe to socket; kTLS so encryption happens in kernel; avoid userspace buffers on the hot path.</li><li>Bounded per‑connection buffers; read from the source only when the socket is writable. TCP flow control is the backpressure mechanism, so a slow client slows only its own stream.</li><li>Large NIC offloads (TSO/GRO), pinned IRQs, huge pages: mention, don't dwell.</li></ul></div>
<div><h4>Uploads</h4><ul><li>Multipart with per‑part checksum and etag; parts land on local NVMe and flush asynchronously to durable storage; the client sees 200 only after the part is durable enough per the SLA (say which).</li><li>Resume via HEAD (what do you have?) and Content‑Range; idempotent part PUTs by (uploadId, partNumber, checksum).</li><li>Node affinity for an upload via consistent hashing on object id, with a lease so a failed node's session can be resumed elsewhere from storage.</li></ul></div>
<div><h4>Downloads and streaming</h4><ul><li>Range requests are the whole story: seeking, parallel downloads, resume, and HLS/DASH segments are all ranged GETs. Always return Accept‑Ranges and strong ETags.</li><li>Local NVMe cache with LRU; hot objects served from page cache; cold from storage with readahead sized to bitrate.</li><li>Rate limiting per client in bytes/s (token bucket on the send side) and per node admission control on open streams; shed with 503 + Retry‑After before memory pressure.</li><li>End‑to‑end integrity: checksum trailers; client verifies.</li></ul></div></div>


## Trade-offs {#network-io-service-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Byte movement</td><td>Zero‑copy <code>sendfile</code>/<code>splice</code></td><td>No inspection or transformation of bytes in flight</td><td>Read into userspace only when you must transform (transcode, encrypt per request) — and accept roughly an order of magnitude more CPU per byte</td></tr>
  <tr><td>Load balancing</td><td>L4, packets not streams</td><td>No request‑level routing, headers or retries at the LB</td><td>L7 gives richer routing and doubles the copies on the hottest path in the system</td></tr>
  <tr><td>Backpressure</td><td>Small fixed buffer; let the TCP window do the work</td><td>No smoothing of bursty clients</td><td>Application‑level buffering helps burstiness and makes memory a function of client speed, which is exactly the failure being avoided</td></tr>
  <tr><td>Staging</td><td>NVMe in front of object storage</td><td>Local disks to manage, and a flush pipeline</td><td>Write straight through when objects are small; at terabyte scale it makes the client wait on a cross‑network write</td></tr>
  <tr><td>Routing</td><td>By object hash for cache affinity</td><td>Hot objects concentrate on one node</td><td>Add replication for known‑hot objects; random routing spreads load evenly and destroys the cache hit rate</td></tr>
  <tr><td>Visibility</td><td>Manifest commit makes the object readable</td><td>An extra control‑plane round trip at the end</td><td>Never expose parts before commit — a reader would see a truncated object with no way to tell</td></tr>
  <tr><td>Async I/O</td><td>io_uring or epoll, not thread per connection</td><td>More complex code than blocking I/O</td><td>Thread‑per‑connection is fine into the low thousands; at 100K streams the context switching alone consumes the machine</td></tr>
</tbody></table>

## Safety-first design {#network-io-service-safety}

<div class="cards">
  <div><h4>Memory must not track client behaviour</h4><ul>
    <li><b>Bounded buffers everywhere.</b> Server memory is a function of connection count, never of how slow or bursty those connections are.</li>
    <li><b>Slow readers cost nothing.</b> Stop reading the source and let the data stay where it already is; 10,000 stalled clients becomes a boring condition rather than an outage.</li>
    <li><b>Timeouts on idle and total duration.</b> Slowloris only works against a server willing to wait forever.</li>
    <li><b>Shed at the edge.</b> A saturated node refuses new connections rather than degrading every stream it already has.</li></ul></div>
  <div><h4>Never serve something you cannot vouch for</h4><ul>
    <li><b>Checksums end to end.</b> Verified per part on upload and on read, so corruption is detected rather than delivered.</li>
    <li><b>Commit makes it visible.</b> A partially uploaded object is unreadable by construction, not by convention.</li>
    <li><b>Authorise every range.</b> Each request is checked on its own, so a URL can never be edited into reading a different object or offset.</li>
    <li><b>Staging is never the record.</b> A wiped node loses cache, not data, which makes replacing hardware routine.</li></ul></div>
  <div><h4>Long transfers survive real networks</h4><ul>
    <li><b>Resume without client bookkeeping.</b> A HEAD reports which parts exist, so a client that crashed can continue from a different device.</li>
    <li><b>Immutable, content‑addressed parts.</b> Re‑uploading is idempotent, which makes "just retry" a safe default for a terabyte transfer.</li>
    <li><b>Reclaim abandoned sessions.</b> Uploads that stop halfway expire on a TTL so staging space is not held hostage.</li>
    <li><b>Node failure is invisible.</b> Sessions are durable and routable, so a client reconnects and continues instead of restarting.</li></ul></div>
</div>

## Don't leave the room without saying {#network-io-service-check}

<ul class="checklist">
  <li>Bytes/s math per node; zero‑copy + async I/O keep CPU out of the way</li>
  <li>TCP flow control as backpressure; bounded buffers; never read faster than you can send</li>
  <li>Multipart resumable uploads with checksums, idempotent parts, NVMe staging → durable flush</li>
  <li>Range requests everywhere; strong ETags; HLS as ranged GETs</li>
  <li>Control plane off the hot path: one lookup per connection</li>
  <li>Admission control and byte‑rate limits before memory pressure</li>
</ul>

## What each level is expected to drive {#network-io-service-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Nodes behind LB, chunked upload, range download, object storage</td><td>Backpressure, zero‑copy</td></tr>
  <tr><td>Senior</td><td>Async event loop, sendfile/kTLS, bounded buffers, resumable idempotent uploads, staging + durability semantics, caching</td><td>io_uring, NIC offloads</td></tr>
  <tr><td>Staff+</td><td>Capacity per node with measurements, failure of a node mid‑upload, regional placement and egress cost, admission control policy, observability of buffer pressure</td><td>—</td></tr>
</tbody></table>
