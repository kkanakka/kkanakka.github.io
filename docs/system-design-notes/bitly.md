---
title: "Bit.ly (URL shortener)"
slug: /system-design-notes/bitly
sidebar_position: 6
sidebar_label: "Bit.ly (URL shortener)"
description: "easy · scaling reads · unique id generation · 1000:1 read/write"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/bitly/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">easy · scaling reads · unique id generation · 1000:1 read/write</span>
</header>
<p>Turn a long URL into a short code, then redirect anyone who hits the short code. Entry‑level question, but the interviewer is checking whether you notice it's a read‑heavy system and structure everything around that.</p>

## Requirements {#bl-requirements}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Submit long URL → get short URL</li>
      <li>Optional custom alias, optional expiry</li>
      <li>Visit short URL → redirect to original</li>
      <li class="out">Auth/accounts, click analytics</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Short codes unique (one code → exactly one URL)</li>
      <li>Redirect latency &lt; 100 ms</li>
      <li>Availability 99.99%; availability &gt;&gt; consistency</li>
      <li>1B URLs, 100M DAU; reads ≈ 1000× writes</li>
      <li class="out">Real‑time analytics consistency, spam/malware filtering</li>
    </ol>
  </div>
</div>


## Scale, performance and safety targets {#bl-targets}

<p>The whole design follows from one ratio. Say these numbers before drawing anything, and the cache, the 302 and the counter all justify themselves.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> 100M DAU generating ~10K redirect QPS average and ~50K at peak, against ~10 write QPS — a 1000:1 read/write ratio that is the single most important fact about this system.</li>
    <li><b>Data volume:</b> 1B URLs at ~500 bytes per row ≈ 500 GB — small enough for one well‑indexed database, and the hot subset is small enough to cache almost entirely.</li>
    <li><b>Growth:</b> ~100M new URLs/year. At 6 base62 characters there are ~56B codes available, so the keyspace lasts decades; 7 characters buys 3.5 trillion if custom aliases consume more than expected.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> redirect p50 &lt; 20 ms, p95 &lt; 50 ms, hard ceiling p99 &lt; 100 ms — a redirect sits in front of someone else's page load, so it is pure added latency and users blame the destination. Creation is allowed to be slower: p95 &lt; 300 ms.</li>
    <li><b>Throughput:</b> 50K redirect QPS served overwhelmingly from cache — at a 95%+ hit rate the database sees a few thousand QPS, which is why a single primary with read replicas is adequate.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> a URL shortener is an open redirector, so it is used for phishing, malware distribution and laundering blocked domains. Sequential base62 codes are also trivially enumerable, which exposes every link anyone has ever created.</li>
    <li><b>Rate limiting:</b> per‑IP and per‑account creation limits (e.g. 10 creates/min anonymous, 1,000/day authenticated), plus redirect‑side limits per IP to blunt enumeration scans.</li>
    <li><b>Data sensitivity:</b> long URLs frequently contain session tokens, document ids and query parameters with personal data. Never log the full target URL indiscriminately, never make the mapping enumerable, and support takedown — a short code must be revocable within minutes, not on next cache expiry.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.99% (~52 min/year) for redirects, and availability beats consistency decisively: serving a slightly stale mapping is fine, failing to redirect breaks someone else's product.</li>
    <li><b>Degraded mode:</b> database unavailable → keep serving cache hits, and fail misses with a retryable error rather than taking everything down. Counter unavailable → creation pauses (a write outage), while redirects are entirely unaffected — the two paths share almost nothing on purpose.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> eventual is fine. A newly created code may take a second to be visible everywhere; the one thing requiring strong guarantees is code uniqueness, which the counter provides by construction rather than by checking.</li>
    <li><b>Durability:</b> eleven nines — losing a mapping breaks every link ever shared, and unlike most data it cannot be recomputed from anything.</li>
    <li><b>Compliance:</b> a working takedown path with cache invalidation, expiry honoured on the redirect path, and enough audit trail to answer who created an abusive link without keeping a searchable index of everyone's destinations.</li></ul></div>
</div>

## Entities and API {#bl-entities}

<p>OriginalUrl · ShortUrl · User. One table: <code>urls(short_code PK, original_url, created_at, expires_at?, created_by)</code>.</p>
<pre><code>POST /urls  {long_url, custom_alias?, expiration_date?}  -&gt; {short_url: "https://short.ly/abc123"}
GET  /{short_code}                                        -&gt; 302 Found, Location: &lt;original&gt;   (410 Gone if expired, 404 if unknown)</code></pre>
<div class="note"><b>301 vs 302:</b> 301 is cached by the browser, so later clicks never reach you: no analytics, no expiry, no updates. 302 sends every click through your server. Pick 302 and say why.</div>

## Final design {#bl-diagram}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/bitly/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Bitly architecture: client to API gateway; read service checks Redis cache then Postgres and returns 302; write service gets a counter batch from Redis, base62-encodes, writes Postgres">
  <defs><marker id="c1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="c2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:13px;fill:#1B2430;font-weight:600}.ts{font-size:11px;fill:#5B6673}.tm{font-size:11px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#c1)}.fw{stroke:#B45309;stroke-width:1.6;fill:none;marker-end:url(#c2)}.lbl{font-size:11px;fill:#1F4E9E}.lblw{font-size:11px;fill:#B45309}</style>
  <rect class="box" x="20" y="150" width="100" height="56"></rect><text class="tb" x="70" y="173" text-anchor="middle">Client</text><text class="ts" x="70" y="191" text-anchor="middle">browser</text>
  <rect class="box" x="170" y="150" width="120" height="56"></rect><text class="tb" x="230" y="173" text-anchor="middle">API Gateway</text><text class="ts" x="230" y="191" text-anchor="middle">GET → read · POST → write</text>

  <rect class="box" x="360" y="40" width="170" height="70"></rect><text class="tb" x="445" y="62" text-anchor="middle">Read Service (×N)</text><text class="ts" x="445" y="80" text-anchor="middle">cache → DB → 302</text><text class="ts" x="445" y="96" text-anchor="middle">scaled for 1000× traffic</text>
  <rect class="box" x="360" y="250" width="170" height="70" stroke="#B45309"></rect><text class="tb" x="445" y="272" text-anchor="middle">Write Service (×M)</text><text class="ts" x="445" y="290" text-anchor="middle">validate · code gen · insert</text><text class="ts" x="445" y="306" text-anchor="middle">~1 write/sec</text>

  <rect class="box" x="610" y="30" width="170" height="60" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="695" y="52" text-anchor="middle">Cache (Redis)</text><text class="tm" x="695" y="70" text-anchor="middle">short_code → original_url</text>
  <rect class="box" x="610" y="120" width="170" height="110"></rect><text class="tb" x="620" y="140">Postgres (+ replicas)</text><text class="tm" x="620" y="158">urls</text><text class="tm" x="620" y="172">  short_code PK (B‑tree)</text><text class="tm" x="620" y="186">  original_url</text><text class="tm" x="620" y="200">  expires_at, created_by</text><text class="ts" x="620" y="220">1B rows × 500 B ≈ 500 GB, one box</text>
  <rect class="box" x="610" y="260" width="170" height="60" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="695" y="282" text-anchor="middle">Global counter (Redis)</text><text class="tm" x="695" y="300" text-anchor="middle">INCRBY counter 1000</text>

  <path class="f" d="M120 172 L168 172"></path>
  <path class="f" d="M290 165 L358 80"></path><text class="lbl" x="300" y="112">GET /abc123</text>
  <path class="fw" d="M290 190 L358 280"></path><text class="lblw" x="296" y="250">POST /urls</text>
  <path class="f" d="M530 60 L608 60"></path><text class="lbl" x="540" y="52">1 GET key</text>
  <path class="f" d="M530 90 L608 150"></path><text class="lbl" x="540" y="134">2 miss → SELECT</text>
  <path class="fw" d="M530 290 L608 290"></path><text class="lblw" x="540" y="282">1 next batch</text>
  <path class="fw" d="M530 270 L608 220"></path><text class="lblw" x="545" y="250">2 INSERT</text>
  <text class="ts" x="810" y="60">Cache holds the hot few %;</text><text class="ts" x="810" y="74">TTL ≤ expiry; LRU.</text>
  <text class="ts" x="810" y="150">Any DB works: writes are tiny.</text><text class="ts" x="810" y="164">Replicas for HA and read spill.</text>
  <text class="ts" x="810" y="290">Batches of 1000 per instance;</text><text class="ts" x="810" y="304">lost values on failover are fine.</text>
  <text class="ts" x="20" y="345">Split read and write services because the workloads differ by 1000×; scale each on its own.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 712" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Bit.ly flow between components">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="7" y="14" width="126" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Client</text>
<line class="ln" x1="70" y1="48" x2="70" y2="692"></line>
<rect class="sb" x="147" y="14" width="126" height="34"></rect><text class="st" x="210" y="36" text-anchor="middle">API Gateway</text>
<line class="ln" x1="210" y1="48" x2="210" y2="692"></line>
<rect class="sb" x="287" y="14" width="126" height="34"></rect><text class="st" x="350" y="36" text-anchor="middle">Write Service</text>
<line class="ln" x1="350" y1="48" x2="350" y2="692"></line>
<rect class="sb" x="427" y="14" width="126" height="34"></rect><text class="st" x="490" y="36" text-anchor="middle">Redis</text>
<line class="ln" x1="490" y1="48" x2="490" y2="692"></line>
<rect class="sb" x="567" y="14" width="126" height="34"></rect><text class="st" x="630" y="36" text-anchor="middle">Postgres</text>
<line class="ln" x1="630" y1="48" x2="630" y2="692"></line>
<rect class="sb" x="707" y="14" width="126" height="34"></rect><text class="st" x="770" y="36" text-anchor="middle">Read Service</text>
<line class="ln" x1="770" y1="48" x2="770" y2="692"></line>
<rect class="sb" x="847" y="14" width="126" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Cache</text>
<line class="ln" x1="910" y1="48" x2="910" y2="692"></line>
<line class="a1" x1="78" y1="80" x2="202" y2="80"></line>
<text class="sl" x="140" y="74" text-anchor="middle">POST /urls {long_url}</text>
<line class="a1" x1="218" y1="114" x2="342" y2="114"></line>
<text class="sl" x="280" y="108" text-anchor="middle">route</text>
<rect class="nt" x="277" y="135" width="146" height="22"></rect><text class="sl" x="350" y="150" text-anchor="middle">validate, check alias</text>
<line class="a1" x1="358" y1="182" x2="482" y2="182"></line>
<text class="sl" x="420" y="176" text-anchor="middle">INCRBY counter 1000 (batch)</text>
<line class="a2" x1="482" y1="216" x2="358" y2="216"></line>
<text class="sl" x="420" y="210" text-anchor="middle">range start</text>
<rect class="nt" x="296" y="237" width="109" height="22"></rect><text class="sl" x="350" y="252" text-anchor="middle">base62(counter)</text>
<line class="a1" x1="358" y1="284" x2="622" y2="284"></line>
<text class="sl" x="490" y="278" text-anchor="middle">INSERT (short_code UNIQUE)</text>
<line class="a2" x1="622" y1="318" x2="358" y2="318"></line>
<text class="sl" x="490" y="312" text-anchor="middle">ok</text>
<line class="a2" x1="342" y1="352" x2="78" y2="352"></line>
<text class="sl" x="210" y="346" text-anchor="middle">short.ly/abc123</text>
<line class="a1" x1="78" y1="386" x2="202" y2="386"></line>
<text class="sl" x="140" y="380" text-anchor="middle">GET /abc123</text>
<line class="a1" x1="218" y1="420" x2="762" y2="420"></line>
<text class="sl" x="490" y="414" text-anchor="middle">route</text>
<line class="a1" x1="778" y1="454" x2="902" y2="454"></line>
<text class="sl" x="840" y="448" text-anchor="middle">GET abc123</text>
<line class="a2" x1="902" y1="488" x2="778" y2="488"></line>
<text class="sl" x="840" y="482" text-anchor="middle">hit → long url</text>
<line class="a1" x1="762" y1="522" x2="638" y2="522"></line>
<text class="sl" x="700" y="516" text-anchor="middle">miss → SELECT by PK</text>
<line class="a2" x1="638" y1="556" x2="762" y2="556"></line>
<text class="sl" x="700" y="550" text-anchor="middle">row</text>
<line class="a1" x1="778" y1="590" x2="902" y2="590"></line>
<text class="sl" x="840" y="584" text-anchor="middle">SET abc123 TTL≤expiry</text>
<line class="a2" x1="762" y1="624" x2="78" y2="624"></line>
<text class="sl" x="420" y="618" text-anchor="middle">302 Location: long url</text>
<rect class="nt" x="-12" y="645" width="165" height="22"></rect><text class="sl" x="70" y="660" text-anchor="middle">browser follows redirect</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Client → API Gateway:</b> POST /urls {long_url}.
    Creation is the rare path — roughly one write for every thousand reads — so it can afford validation, coordination and a slower latency budget.
    Separating it from the read path at the very front is what lets the two scale and fail independently.</li>
  <li><b>API Gateway → Write Service:</b> route.
    Reads and writes go to different services even though they share a database, because their traffic shapes differ by three orders of magnitude and so do their scaling needs.</li>
  <li><b>Write Service:</b> validate, check alias.
    Validation is a safety gate as much as a correctness one: reject non‑HTTP schemes, private addresses and known‑bad domains before minting a code that can be shared anywhere.
    Custom aliases are checked for availability here and reserved against a blocklist, so nobody claims <code>/login</code> or a brand name.</li>
  <li><b>Write Service → Redis:</b> INCRBY counter 1000 (batch).
    A single global counter guarantees uniqueness without a collision check — but consulting it per request would make it the bottleneck and a single point of failure.
    Claiming a block of 1,000 ids at once means one coordination call per thousand creations, and each service instance then allocates locally at memory speed.
    The cost is gaps in the sequence when an instance dies holding unused ids, which is entirely harmless.</li>
  <li><b>Redis → Write Service:</b> range start (response).
    The returned range is owned exclusively by this instance, so two servers can never mint the same code even with no further communication.</li>
  <li><b>Write Service:</b> base62(counter).
    Base62 packs the id into the shortest URL‑safe form: 6 characters covers 56 billion codes, comfortably beyond the 1B target.
    Encoding a counter rather than hashing the URL avoids collision checks entirely — the uniqueness comes from the source, not from a retry loop.
    The honest downside is that codes are sequential and therefore guessable, which is why the security answer is an unguessable offset or salt rather than pretending it is not a problem.</li>
  <li><b>Write Service → Postgres:</b> INSERT (short_code UNIQUE).
    The unique constraint is a backstop, not the mechanism: it catches bugs and custom‑alias races, but the counter means it should never fire in normal operation.
    One table with the short code as primary key is genuinely enough — 500 GB with a single access pattern does not need anything more exotic.</li>
  <li><b>Postgres → Write Service:</b> ok (response).
    The write is durable before the user is told the link exists, because handing back a short URL that does not resolve is worse than being slightly slower.</li>
  <li><b>Write Service → Client:</b> short.ly/abc123 (response).
    The new code is deliberately <em>not</em> pushed into the cache — a brand new link has no traffic yet, and populating on first read keeps the cache full of things people actually request.</li>
  <li><b>Client → API Gateway:</b> GET /abc123.
    This is the path that matters: it runs thousands of times more often than creation and sits directly in front of someone else's page load.</li>
  <li><b>API Gateway → Read Service:</b> route.
    The read service is stateless and horizontally scaled, so handling a viral link is a matter of adding instances rather than changing the design.</li>
  <li><b>Read Service → Cache:</b> GET abc123.
    Cache first, always. Link popularity follows a heavy power law — a tiny fraction of codes account for almost all traffic — so a modest cache reaches a 95%+ hit rate.
    That hit rate is what keeps the database at a few thousand QPS instead of fifty thousand.</li>
  <li><b>Cache → Read Service:</b> hit → long url (response).
    The common case is a single in‑memory lookup, which is how a sub‑50 ms p95 is met without heroics.</li>
  <li><b>Read Service → Postgres:</b> miss → SELECT by PK.
    A miss is a primary‑key lookup — the cheapest query a relational database can serve — so even the slow path is fast.
    Read replicas absorb this traffic; replication lag is acceptable because a mapping is effectively immutable once created.</li>
  <li><b>Postgres → Read Service:</b> row (response).
    Expiry is evaluated here rather than by deleting rows, so an expired link returns 410 Gone — semantically different from 404, and more useful to whoever follows it.</li>
  <li><b>Read Service → Cache:</b> SET abc123 TTL≤expiry.
    Populating on read means the cache naturally fills with popular links and lets cold ones age out.
    The TTL is capped by the link's own expiry, so a cached entry can never outlive the mapping it represents — the detail that makes takedown and expiry actually work.</li>
  <li><b>Read Service → Client:</b> 302 Location: long url (response).
    302, not 301: a 301 is cached by the browser, so subsequent clicks never reach the server — which silently destroys analytics, expiry, revocation and takedown.
    Choosing 302 is choosing to pay for every click in exchange for keeping control of the link, and saying that trade‑off out loud is the point of the question.</li>
</ol>

## Deep dives {#bl-deepdives}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/bitly/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

### 1. Unique, short, cheap codes

<p>6 chars of base62 (a–z, A–Z, 0–9) = 62⁶ ≈ 56 B codes; 7 chars ≈ 3.5 T. Plenty for 1B.</p>
<table>
  <tbody><tr><th>Approach</th><th>How</th><th>Pro</th><th>Con</th></tr>
  <tr><td>Hash the long URL</td><td>md5/sha → base62 → take first 6–7 chars</td><td>No coordination; same URL → same code (dedupe for free)</td><td>Truncation collides; must check DB and retry with a salt. Same URL for two users can't have different expiry/analytics.</td></tr>
  <tr><td>Random code</td><td>6–7 random base62 chars</td><td>Unpredictable, no coordination</td><td>Collision check on every insert; probability grows with fill rate</td></tr>
  <tr><td>Counter + base62 <b>(pick this)</b></td><td>Global counter → encode → code. 1,000,000 → "4c92"</td><td>Guaranteed unique, no collision check, short</td><td>Needs a coordinated counter; codes are sequential/guessable</td></tr>
</tbody></table>
<ul>
  <li><b>Counter at scale:</b> Redis <code>INCRBY counter 1000</code> hands each write instance a batch; it uses the range locally, comes back when empty. One Redis does 100K+ ops/s, this needs ~1/s. Sentinel or Cluster for failover; gaps from lost batches are fine because you need uniqueness, not continuity. The DB <code>UNIQUE(short_code)</code> is the backstop.</li>
  <li><b>Multi‑region:</b> disjoint ranges per region (A: 0–1B, B: 1B–2B); no cross‑region coordination on writes.</li>
  <li><b>Guessability:</b> if it matters, bijective scramble of the counter (e.g., multiply by a large odd number mod 62ⁿ) or append random bits. Staff‑level mention.</li>
  <li><b>Custom aliases:</b> validate, check existence, and keep them from colliding with future generated codes: separate namespace or a reserved prefix that generated codes never use.</li>
</ul>

### 2. Fast redirects

<ul>
  <li><b>Index:</b> <code>short_code</code> is the primary key → B‑tree lookup, no scan. Say it explicitly; it's what the question is testing at mid‑level.</li>
  <li><b>Cache:</b> cache‑aside in Redis, <code>short_code → original_url</code>. Hit ≈ 1 ms vs 20–50 ms for the DB. LRU; clicks follow a power law so a few GB covers most traffic.</li>
  <li><b>Invalidation:</b> URLs rarely change, so TTL = min(default, time to expiry). On delete/expire, <code>DEL</code> the key.</li>
  <li><b>CDN / edge:</b> a CDN can cache the 302 itself (short TTL) for the hottest links, putting the redirect one hop from the user.</li>
  <li>Expired rows: return 410, purge with a background job or leave with expiry and filter on read.</li>
</ul>

### 3. Scale to 1B URLs and 100M DAU

<ul>
  <li><b>Storage math:</b> ~500 B/row × 1B = 500 GB. One Postgres instance handles it; shard only if asked to grow 10×.</li>
  <li><b>Write rate:</b> 100K URLs/day ≈ 1/s. Any database. Postgres by default.</li>
  <li><b>Read rate:</b> 100M DAU × a few clicks ≈ thousands/s; cache absorbs most, read replicas take the rest.</li>
  <li><b>HA:</b> primary + replicas with failover, backups/snapshots, stateless services behind the gateway, two LBs across zones via DNS.</li>
  <li><b>Read/write split:</b> Read Service and Write Service as separate deployables so redirect capacity scales independently of code generation.</li>
</ul>


## Trade-offs {#bl-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Redirect status</td><td>302 Found</td><td>Every click costs a server round trip forever</td><td>301 is faster and cheaper but the browser caches it, killing analytics, expiry and takedown — only acceptable for permanent, unmanaged links</td></tr>
  <tr><td>Code generation</td><td>Counter + base62, batched in blocks</td><td>Codes are sequential and enumerable; a shared counter is a dependency for writes</td><td>Hashing gives free dedupe but needs collision handling; random codes are unguessable but need a uniqueness check on every insert</td></tr>
  <tr><td>Counter access</td><td>Claim 1,000 ids at a time</td><td>Gaps in the sequence when an instance dies holding a block</td><td>Per‑request increment is exact but makes the counter a hot single point on the write path</td></tr>
  <tr><td>Storage</td><td>One relational table, short code as PK</td><td>Nothing much — this is the right size for it</td><td>Move to a KV store past tens of billions of rows, where the single access pattern makes the relational features unnecessary</td></tr>
  <tr><td>Cache population</td><td>Lazy, on read, TTL capped by expiry</td><td>The first request for any link is always a miss</td><td>Warm on write only for links known to be about to go viral; otherwise it fills the cache with links nobody clicks</td></tr>
  <tr><td>Consistency</td><td>Eventual; read replicas may lag</td><td>A just‑created link can 404 for a moment on a lagging replica</td><td>Read‑your‑writes by pinning the creator to the primary briefly — worth it if sharing immediately after creation is the common flow</td></tr>
  <tr><td>Mutability</td><td>Mappings are immutable once created</td><td>No editing a destination after the fact</td><td>Editable targets make caching far harder and turn a shortener into an open redirect that can be repointed at malware after review</td></tr>
</tbody></table>

## Safety-first design {#bl-safety}

<div class="cards">
  <div><h4>A shortener is an abuse magnet</h4><ul>
    <li><b>Validate before minting.</b> Reject non‑HTTP schemes, private and loopback addresses, and known‑malicious domains at creation — a code, once shared, is permanent.</li>
    <li><b>Reputation check on the destination.</b> Screening against a safe‑browsing feed at create time, and re‑checking popular links, catches targets that turn malicious later.</li>
    <li><b>Rate limit creation.</b> Per‑IP and per‑account caps stop bulk generation of disposable links for a phishing campaign.</li>
    <li><b>Reserve the dangerous aliases.</b> Custom aliases are checked against a blocklist so nobody claims paths that look like your own product or a known brand.</li></ul></div>
  <div><h4>Revocation must actually work</h4><ul>
    <li><b>302 keeps you in the loop.</b> Every click reaches the server, which is the only reason takedown, expiry and revocation are possible at all.</li>
    <li><b>Cache TTL never exceeds expiry.</b> A cached entry cannot outlive the mapping behind it, so an expired or removed link stops working promptly.</li>
    <li><b>Explicit invalidation on takedown.</b> Removing a link purges it from the cache rather than waiting out a TTL, so abuse response is measured in minutes.</li>
    <li><b>410 rather than 404 for expiry.</b> "This existed and is gone" is more useful to the person who followed the link than "never existed".</li></ul></div>
  <div><h4>The long URL is more sensitive than it looks</h4><ul>
    <li><b>Do not make codes enumerable.</b> Sequential base62 lets anyone walk the entire corpus; an unguessable offset or a random component is the fix, and the cost is one design decision.</li>
    <li><b>Do not log full destinations freely.</b> Targets routinely contain session tokens and document ids, so access logs should not become a searchable index of everyone's private URLs.</li>
    <li><b>Strip nothing, assume nothing.</b> The URL is stored verbatim because rewriting it silently breaks links — which is another reason to treat the store as confidential.</li>
    <li><b>Durability is a safety property.</b> Losing the mapping breaks every link ever shared and cannot be recomputed from anything — so this small dataset gets the strongest durability guarantee in the design.</li></ul></div>
</div>

## Don't leave the room without saying {#bl-checklist}

<ul class="checklist">
  <li>Reads ≫ writes (~1000:1); design follows from that</li>
  <li>302 not 301, with the reason</li>
  <li>Base62 math: 6–7 chars is enough</li>
  <li>Counter + base62 beats hashing; batched Redis counter for many writers; UNIQUE constraint as backstop</li>
  <li>Primary key index on short_code, cache‑aside Redis in front</li>
  <li>Cache TTL tied to expiry; 410 for expired</li>
  <li>500 GB fits one DB; ~1 write/s; no sharding needed yet</li>
  <li>Separate read and write services; replicas + failover for 99.99%</li>
  <li>Custom alias namespace can't collide with generated codes</li>
</ul>

## What each level is expected to drive {#bl-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Working create + redirect flow, one uniqueness approach, index on short_code, why 302</td><td>Adding a cache</td></tr>
  <tr><td>Senior</td><td>Hash vs counter tradeoffs, cache with invalidation for expiry, DB choice justified, read/write service split, Redis counter across writers</td><td>Batching, failover</td></tr>
  <tr><td>Staff+</td><td>Read‑heavy framing from minute one, multi‑region counter ranges, Redis failover semantics, predictable‑code security, alias collision prevention, expiry cleanup, evolution as requirements change</td><td>—</td></tr>
</tbody></table>
