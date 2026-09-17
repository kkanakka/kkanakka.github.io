---
title: "Concurrent web crawler"
slug: /aire/web-crawler
sidebar_position: 25
sidebar_label: "Concurrent web crawler"
description: "medium · combines \"design a crawler\" + \"scale with a thread pool\" + \"locked concurrent crawler\" · frontier · politeness · dedupe · termination"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/web-crawler/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">medium · combines "design a crawler" + "scale with a thread pool" + "locked concurrent crawler" · frontier · politeness · dedupe · termination</span>
</header>
<p>Start from seed URLs, fetch pages, extract links, keep going. Interviewers ask it three ways: as a distributed system (billions of pages), as a coding exercise (crawl one domain with a thread pool), and as a concurrency puzzle (what needs a lock, when do you stop). All three share one skeleton: a <b>frontier</b> of URLs to visit, a <b>visited</b> set, N <b>workers</b>, and a rule for knowing you're done.</p>

## Requirements {#cr-requirements}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Crawl from seed URLs, following links within a scope (domain, depth, or the open web)</li>
      <li>Store page content and the link graph for downstream indexing</li>
      <li>Never fetch the same URL twice; avoid near‑duplicate content</li>
      <li>Respect robots.txt and per‑host rate limits</li>
      <li class="out">Rendering JavaScript, ranking, search</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Scale: e.g. 1B pages/month ≈ 400 pages/s average; peak 10×</li>
      <li>Politeness: ≤ 1 request/s per host, obey crawl‑delay</li>
      <li>Freshness: recrawl by change rate; priority for important pages</li>
      <li>Robust: traps, huge pages, slow hosts, redirects; no worker can wedge the crawl</li>
      <li>Resumable after crash; at‑least‑once fetch with dedupe</li>
    </ol>
  </div>
</div>
<div class="note"><b>Numbers:</b> 400 pages/s × 100 KB avg ≈ 40 MB/s ≈ 3.5 TB/day raw HTML (compress ~5×). 1B URLs × ~100 B ≈ 100 GB for the visited set as exact strings; a Bloom filter with 1% false positives needs ~1.2 GB. Each fetch waits ~200–500 ms on the network, so one worker does ~2–5 pages/s; 400/s needs ~100–200 concurrent fetches, which is a thread pool or async I/O, not 200 machines.</div>


## Scale, performance and safety targets {#cr-targets}

<p>A crawler is judged on politeness and termination far more than on raw speed. These are the numbers to commit to, including the ingestion and indexing tail that makes the crawl useful.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> 1B documents/month ≈ 400 fetches/s average, 4,000/s at peak — but capped at ≤ 1 request/s per host, so throughput comes from breadth across millions of hosts, never from depth on one.</li>
    <li><b>Data volume:</b> ~100 KB average page → ~40 MB/s, ~3.5 TB/day raw HTML (~700 GB compressed). The frontier holds billions of URLs; the visited set is ~100 GB as exact strings, or ~1.2 GB as a Bloom filter at 1% false positives.</li>
    <li><b>Growth:</b> the crawlable web grows faster than any budget, so the design assumes a permanent <em>budget</em> per crawl and prioritisation rather than completeness — 2× capacity buys 2× coverage, never "done".</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> per‑fetch p50 ~300 ms, p95 &lt; 2 s, hard timeout 10 s with a size cap; discovered URL to indexed document p95 &lt; 10 min. Individual latency barely matters — concurrency does, because every fetch is network‑bound.</li>
    <li><b>Throughput:</b> one worker achieves ~2–5 pages/s while waiting on the network, so 400/s needs ~100–200 concurrent fetches. That is a thread pool or async I/O on a handful of machines, not 200 machines — a point worth making explicitly.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> a crawler is mostly a danger to <em>others</em> — an impolite crawler is a distributed denial of service with good intentions. Inbound, the hazards are crawler traps (infinite calendars, session‑id URLs), circular reference loops, zip bombs and enormous pages, and hostile servers that hang connections to exhaust the pool.</li>
    <li><b>Rate limiting:</b> ≤ 1 request/s per host with <code>crawl‑delay</code> honoured when longer, a global cap per IP block so many hosts behind one address are not collectively hammered, per‑host connection limits, and a per‑crawl budget of pages and depth.</li>
    <li><b>Data sensitivity:</b> obey robots.txt and <code>noindex</code> as policy, not as a suggestion; skip pages behind authentication; strip credentials from URLs before storing; and honour takedown by removing both the stored blob and its index entries. Retention of raw HTML should be finite and stated.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> no user‑facing SLA — this is batch work. The real requirement is <b>resumability</b>: after a crash the crawl continues from durable frontier state, having lost minutes rather than days.</li>
    <li><b>Degraded mode:</b> a host returning 5xx or timing out is backed off exponentially and eventually parked, never retried in a tight loop. Parser or index falling behind → keep fetching and buffer raw pages, because re‑fetching is far more expensive (and ruder) than re‑parsing. Frontier storage degraded → stop claiming new URLs and let in‑flight work drain.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> at‑least‑once fetching with dedupe on canonical URL and on content hash. The visited set is the only shared state needing atomic test‑and‑set; everything else tolerates duplication.</li>
    <li><b>Durability:</b> the frontier and visited set must survive a crash, because rebuilding them means re‑crawling — which costs bandwidth and, worse, hits other people's servers again. Raw pages are durable in object storage; the index is derived and rebuildable.</li>
    <li><b>Termination:</b> the condition is explicit — frontier empty <em>and</em> in‑flight count zero — because "the queue looks empty" is the classic way a concurrent crawler stops early while workers still hold URLs.</li></ul></div>
</div>

## Entities and API {#cr-entities}

<p>URL (canonical string, host, priority, depth, discoveredAt, lastCrawledAt, state) · Host (robots rules, crawl_delay, next_allowed_at, failures) · Page (url, contentHash, simhash, fetchedAt, status, blobKey) · Link (from → to) · CrawlJob (seeds, scope, budget).</p>
<pre><code>POST /crawls {seeds[], scope: domain|prefix|open, maxDepth, budget}   -&gt; crawlId
GET  /crawls/:id/status   -&gt; {queued, inFlight, done, failed, pagesPerSec}
Internal worker loop:  claim() → fetch() → parse() → dedupe() → enqueue(new) → ack()</code></pre>

## Design {#cr-diagram}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/web-crawler/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 400" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Crawler architecture: scheduler seeds a URL frontier partitioned by host with per-host politeness; fetcher workers consult robots and DNS caches, fetch with timeouts, store raw pages in blob storage, parse links, canonicalize, check URL and content dedupe, push new URLs back to the frontier; metadata in a URL store; recrawl scheduler feeds priorities">
  <defs><marker id="cw1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="cw2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.tm{font-size:10.5px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#cw1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#cw2);stroke-dasharray:2 4}.lbl{font-size:10.5px;fill:#1F4E9E}.lbla{font-size:10.5px;fill:#B45309}</style>
  <rect class="box" x="20" y="150" width="120" height="70"></rect><text class="tb" x="80" y="170" text-anchor="middle">Scheduler</text><text class="ts" x="80" y="188" text-anchor="middle">seeds, priorities,</text><text class="ts" x="80" y="202" text-anchor="middle">recrawl by change rate</text>
  <rect class="box" x="180" y="120" width="170" height="130" stroke="#B45309"></rect><text class="tb" x="265" y="140" text-anchor="middle">URL Frontier</text><text class="ts" x="190" y="158">front queues: by priority</text><text class="ts" x="190" y="172">back queues: one per host</text><text class="ts" x="190" y="186">host heap keyed next_allowed_at</text><text class="ts" x="190" y="200">Kafka partitions by host hash</text><text class="ts" x="190" y="214">or Redis sorted sets</text><text class="ts" x="190" y="232">claim = lease with timeout</text>
  <rect class="box" x="400" y="120" width="160" height="130"></rect><text class="tb" x="480" y="140" text-anchor="middle">Fetcher workers (×N)</text><text class="ts" x="410" y="158">thread pool / async I/O</text><text class="ts" x="410" y="172">per-host concurrency = 1</text><text class="ts" x="410" y="186">timeouts, size cap, UA</text><text class="ts" x="410" y="200">retry w/ backoff; circuit</text><text class="ts" x="410" y="214">breaker per host</text><text class="ts" x="410" y="232">ack after enqueue of children</text>
  <rect class="box" x="400" y="20" width="160" height="70" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="480" y="40" text-anchor="middle">Robots + DNS cache</text><text class="ts" x="480" y="58" text-anchor="middle">robots.txt per host, TTL</text><text class="ts" x="480" y="72" text-anchor="middle">DNS resolutions, TTL</text>
  <rect class="box" x="610" y="120" width="140" height="70"></rect><text class="tb" x="680" y="140" text-anchor="middle">Parser / extractor</text><text class="ts" x="680" y="158" text-anchor="middle">links, canonicalize</text><text class="ts" x="680" y="172" text-anchor="middle">scope filter, depth</text>
  <rect class="box" x="610" y="210" width="140" height="70" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="680" y="230" text-anchor="middle">Dedupe</text><text class="ts" x="680" y="248" text-anchor="middle">URL: Bloom + exact set</text><text class="ts" x="680" y="262" text-anchor="middle">content: sha256 + simhash</text>
  <rect class="box" x="800" y="60" width="160" height="60" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="tb" x="880" y="80" text-anchor="middle">Blob store (S3)</text><text class="ts" x="880" y="98" text-anchor="middle">raw HTML by content hash</text>
  <rect class="box" x="800" y="140" width="160" height="60"></rect><text class="tb" x="880" y="160" text-anchor="middle">URL / page metadata</text><text class="ts" x="880" y="178" text-anchor="middle">state, lastCrawled, hash</text><text class="ts" x="880" y="192" text-anchor="middle">(Cassandra / DynamoDB)</text>
  <rect class="box" x="800" y="220" width="160" height="60"></rect><text class="tb" x="880" y="240" text-anchor="middle">Link graph / index feed</text><text class="ts" x="880" y="258" text-anchor="middle">Kafka → indexer</text>
  <rect class="box" x="20" y="300" width="330" height="60"></rect><text class="tb" x="185" y="320" text-anchor="middle">Monitoring</text><text class="ts" x="185" y="338" text-anchor="middle">pages/s, frontier depth, in-flight, per-host errors, dup rate</text><text class="ts" x="185" y="352" text-anchor="middle">absence alert when workers stall</text>
  <path class="f" d="M140 185 L178 185"></path><path class="f" d="M350 185 L398 185"></path><text class="lbl" x="354" y="178">claim</text>
  <path class="f" d="M480 120 L480 92"></path><text class="lbl" x="486" y="110">allowed?</text>
  <path class="f" d="M560 155 L608 155"></path><text class="lbl" x="566" y="148">html</text>
  <path class="f" d="M560 130 C 700 60, 780 60, 798 90"></path><text class="lbl" x="640" y="70">store raw</text>
  <path class="f" d="M680 190 L680 208"></path>
  <path class="f" d="M750 245 L798 250"></path><text class="lbl" x="754" y="242">links</text>
  <path class="f" d="M750 160 L798 165"></path>
  <path class="fa" d="M610 245 C 500 300, 300 290, 265 252"></path><text class="lbla" x="380" y="292">new URLs → frontier</text>
  <path class="fa" d="M400 240 C 330 270, 300 260, 300 252"></path><text class="lbla" x="330" y="268">ack / set next_allowed_at</text>
  <text class="ts" x="400" y="330">The frontier is the heart: it decides what to fetch next (priority) and when (politeness). Everything else is stateless workers around it.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 644" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Distributed crawler flow between components">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="17" y="14" width="106" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Seeds/Scheduler</text>
<line class="ln" x1="70" y1="48" x2="70" y2="624"></line>
<rect class="sb" x="137" y="14" width="106" height="34"></rect><text class="st" x="190" y="36" text-anchor="middle">Frontier (Kafka/Redis)</text>
<line class="ln" x1="190" y1="48" x2="190" y2="624"></line>
<rect class="sb" x="257" y="14" width="106" height="34"></rect><text class="st" x="310" y="36" text-anchor="middle">Fetcher worker</text>
<line class="ln" x1="310" y1="48" x2="310" y2="624"></line>
<rect class="sb" x="377" y="14" width="106" height="34"></rect><text class="st" x="430" y="36" text-anchor="middle">Robots/DNS cache</text>
<line class="ln" x1="430" y1="48" x2="430" y2="624"></line>
<rect class="sb" x="497" y="14" width="106" height="34"></rect><text class="st" x="550" y="36" text-anchor="middle">Web host</text>
<line class="ln" x1="550" y1="48" x2="550" y2="624"></line>
<rect class="sb" x="617" y="14" width="106" height="34"></rect><text class="st" x="670" y="36" text-anchor="middle">Parser</text>
<line class="ln" x1="670" y1="48" x2="670" y2="624"></line>
<rect class="sb" x="737" y="14" width="106" height="34"></rect><text class="st" x="790" y="36" text-anchor="middle">Dedupe (Bloom/set)</text>
<line class="ln" x1="790" y1="48" x2="790" y2="624"></line>
<rect class="sb" x="857" y="14" width="106" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Blob + index</text>
<line class="ln" x1="910" y1="48" x2="910" y2="624"></line>
<line class="a1" x1="78" y1="80" x2="182" y2="80"></line>
<text class="sl" x="130" y="74" text-anchor="middle">push seed URLs (priority, depth 0)</text>
<line class="a1" x1="302" y1="114" x2="198" y2="114"></line>
<text class="sl" x="250" y="108" text-anchor="middle">claim next URL for a host whose politeness timer expired</text>
<line class="a2" x1="198" y1="148" x2="302" y2="148"></line>
<text class="sl" x="250" y="142" text-anchor="middle">URL + host lease</text>
<line class="a1" x1="318" y1="182" x2="422" y2="182"></line>
<text class="sl" x="370" y="176" text-anchor="middle">robots.txt allowed? DNS?</text>
<line class="a2" x1="422" y1="216" x2="318" y2="216"></line>
<text class="sl" x="370" y="210" text-anchor="middle">cached answer</text>
<line class="a1" x1="318" y1="250" x2="542" y2="250"></line>
<text class="sl" x="430" y="244" text-anchor="middle">GET (timeout, size cap, UA)</text>
<line class="a2" x1="542" y1="284" x2="318" y2="284"></line>
<text class="sl" x="430" y="278" text-anchor="middle">200 html | 3xx | 4xx/5xx</text>
<line class="a1" x1="318" y1="318" x2="902" y2="318"></line>
<text class="sl" x="610" y="312" text-anchor="middle">store raw page (content hash key)</text>
<line class="a1" x1="318" y1="352" x2="662" y2="352"></line>
<text class="sl" x="490" y="346" text-anchor="middle">parse</text>
<rect class="nt" x="560" y="373" width="220" height="22"></rect><text class="sl" x="670" y="388" text-anchor="middle">extract links, normalize, canonicalize</text>
<line class="a1" x1="678" y1="420" x2="782" y2="420"></line>
<text class="sl" x="730" y="414" text-anchor="middle">seen(url)? seen(content simhash)?</text>
<line class="a2" x1="782" y1="454" x2="678" y2="454"></line>
<text class="sl" x="730" y="448" text-anchor="middle">new / seen</text>
<line class="a1" x1="662" y1="488" x2="198" y2="488"></line>
<text class="sl" x="430" y="482" text-anchor="middle">push new URLs (depth+1, priority)</text>
<line class="a3" x1="302" y1="522" x2="198" y2="522"></line>
<text class="sl" x="250" y="516" text-anchor="middle">ack URL, set host next_allowed_at</text>
<rect class="nt" x="200" y="543" width="220" height="22"></rect><text class="sl" x="310" y="558" text-anchor="middle">retry with backoff on 5xx/timeout; give up after N</text>
<rect class="nt" x="-40" y="577" width="220" height="22"></rect><text class="sl" x="70" y="592" text-anchor="middle">termination: frontier empty AND in-flight = 0</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Seeds/Scheduler → Frontier (Kafka/Redis):</b> push seed URLs (priority, depth 0).
    Seeds define the scope — one domain, a URL prefix, or the open web — and depth 0 starts the counter that will eventually bound the crawl.
    The frontier is durable rather than in‑memory, because losing it means re‑crawling, which costs bandwidth and hits other people's servers a second time.</li>
  <li><b>Fetcher worker → Frontier (Kafka/Redis):</b> claim next URL for a host whose politeness timer expired.
    Politeness is enforced at claim time, not at fetch time — a worker is simply not given a URL for a host it is too early to visit.
    This inverts the naive design where workers fetch and then sleep, which wastes concurrency and still risks bursts when several workers pick the same host.
    Because hosts are partitioned across workers, per‑host ordering needs no global lock.</li>
  <li><b>Frontier (Kafka/Redis) → Fetcher worker:</b> URL + host lease (response).
    The claim is atomic and carries a lease, so a worker that dies does not take its URL with it — the lease expires and the URL becomes claimable again.
    Leases are what make at‑least‑once fetching safe and crashes uninteresting.</li>
  <li><b>Fetcher worker → Robots/DNS cache:</b> robots.txt allowed? DNS?
    Both are cached aggressively: fetching robots.txt before every page would triple the load on every site you crawl, which is itself impolite.
    DNS caching matters just as much — resolution is often slower than the fetch, and uncached lookups add a hidden round trip to every request.</li>
  <li><b>Robots/DNS cache → Fetcher worker:</b> cached answer (response).
    Robots rules are honoured as policy, including <code>crawl‑delay</code> when it is longer than the default, and a disallowed URL is dropped rather than queued for later.
    A missing or unreachable robots.txt is treated conservatively — assume restrictive rather than open season.</li>
  <li><b>Fetcher worker → Web host:</b> GET (timeout, size cap, UA).
    Every request carries a hard timeout, a maximum response size and an identifying user agent with a contact URL, so site owners can see who is crawling and complain.
    The size cap is a real defence: without it a single enormous or maliciously generated response can exhaust a worker's memory.
    Conditional requests using <code>If‑Modified‑Since</code> or <code>ETag</code> turn most recrawls into cheap 304s.</li>
  <li><b>Web host → Fetcher worker:</b> 200 html | 3xx | 4xx/5xx (response).
    Redirects are followed to a bounded depth and the final URL is what gets recorded — redirect chains are a common way to create loops.
    4xx is terminal and remembered; 5xx is transient and goes to backoff, and conflating the two either loses pages or retries dead ones forever.</li>
  <li><b>Fetcher worker → Blob + index:</b> store raw page (content hash key).
    Raw HTML is stored before parsing, so a parser bug or an index change is fixed by reprocessing rather than by re‑crawling the web.
    Keying by content hash deduplicates identical bytes across URLs automatically, which matters because mirrors and syndicated content are everywhere.
    This store is the ingestion boundary: everything downstream — parsing, indexing, embedding — reads from here, not from the network.</li>
  <li><b>Fetcher worker → Parser:</b> parse.
    Parsing is decoupled from fetching so that a slow or backed‑up indexing pipeline never causes the crawler to re‑hit a website.
    It also lets the two scale independently: fetching is network‑bound, parsing is CPU‑bound.</li>
  <li><b>Parser:</b> extract links, normalize, canonicalize.
    Canonicalization is where most duplicate crawling is prevented: lowercase the host, drop default ports and fragments, sort or strip tracking query parameters, resolve relative links, honour <code>rel=canonical</code>.
    Without it, <code>example.com/a</code>, <code>example.com/a?utm_source=x</code> and <code>example.com/a#top</code> are three separate crawls of one page.
    This is also the first line of defence against traps: session ids and infinite calendar parameters are normalised away or pattern‑blocked here.</li>
  <li><b>Parser → Dedupe (Bloom/set):</b> seen(url)? seen(content simhash)?
    Two different questions. URL dedupe is what breaks <b>circular references</b> — A links to B, B links back to A — because the second visit is simply never enqueued.
    Content dedupe with a simhash catches near‑duplicates that URL dedupe cannot: the same article under a thousand different URLs, or a trap generating endless slightly different pages.
    A Bloom filter makes the URL check fit in ~1.2 GB instead of 100 GB, at the cost of occasionally skipping a page it wrongly believes it has seen — an acceptable trade, because false positives lose coverage while false negatives would break termination.</li>
  <li><b>Dedupe (Bloom/set) → Parser:</b> new / seen (response).
    The check must be an atomic test‑and‑set: with hundreds of concurrent workers, "check then add" as two steps lets the same URL through twice.
    This is the one piece of genuinely shared state in the whole design, which is exactly why the concurrency round of this interview focuses on it.</li>
  <li><b>Parser → Frontier (Kafka/Redis):</b> push new URLs (depth+1, priority).
    Depth is incremented and checked against the crawl's limit, which bounds even a graph with cycles that dedupe somehow missed.
    Priority makes the frontier a scheduling decision rather than a queue: important, frequently changing pages are crawled first, because the budget always runs out before the web does.</li>
  <li><b>Fetcher worker → Frontier (Kafka/Redis):</b> ack URL, set host next_allowed_at (async).
    The ack releases the lease, and stamping the host's next allowed time is what enforces the politeness delay for whoever claims next.
    Doing both together means politeness state cannot drift from crawl state even if a worker dies in between.</li>
  <li><b>Fetcher worker:</b> retry with backoff on 5xx/timeout; give up after N.
    Exponential backoff with jitter, then parking the host entirely, is what stops a struggling site from being hammered by the very crawler that is struggling to read it.
    A bounded retry count is also a termination requirement: unbounded retries mean a handful of dead hosts keep the crawl alive forever.</li>
  <li><b>Seeds/Scheduler:</b> termination: frontier empty AND in-flight = 0.
    Both conditions are required. An empty frontier alone is the classic bug — workers still holding claimed URLs are about to enqueue more links, so stopping there ends the crawl early and silently.
    The in‑flight count must be maintained atomically with claim and ack; tracking it loosely reintroduces exactly the race it exists to prevent.
    For an open‑web crawl the practical stop is a budget or a schedule rather than emptiness, and saying which one applies is part of answering the question.</li>
</ol>

## Version 1: single machine, thread pool, one lock (the coding round) {#cr-single}

<p>Crawl everything under one hostname starting from a URL, using up to N threads. The three things the interviewer checks: shared state is protected, no URL is fetched twice, and the program terminates.</p>
<pre><code>import threading, queue
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

class Crawler:
    def __init__(self, start, fetcher, workers=16):
        self.host = urlparse(start).hostname
        self.fetch = fetcher                 # fetcher.get(url) -&gt; list[url]
        self.q = queue.Queue()               # thread-safe frontier
        self.visited = set()                 # shared; guarded by self.lock
        self.lock = threading.Lock()
        self.pending = 0                     # URLs claimed but not finished; guarded by self.lock
        self.done = threading.Condition(self.lock)
        self.workers = workers

    def _try_enqueue(self, url):
        # single critical section: check-and-add to visited, bump pending
        with self.lock:
            if url in self.visited or urlparse(url).hostname != self.host:
                return
            self.visited.add(url)
            self.pending += 1
        self.q.put(url)

    def _worker(self):
        while True:
            url = self.q.get()
            if url is None:                  # poison pill → exit
                return
            try:
                for link in self.fetch.get(url):
                    self._try_enqueue(link)
            except Exception:
                pass                         # log; optionally requeue with attempts
            finally:
                with self.lock:
                    self.pending -= 1
                    if self.pending == 0:
                        self.done.notify_all()

    def run(self, start):
        self._try_enqueue(start)
        with ThreadPoolExecutor(self.workers) as pool:
            for _ in range(self.workers):
                pool.submit(self._worker)
            with self.done:
                while self.pending &gt; 0:
                    self.done.wait()
            for _ in range(self.workers):    # shut down
                self.q.put(None)
        return list(self.visited)</code></pre>
<div class="cards">
  <div><h4>What the lock protects, and only that</h4><ul>
    <li><code>visited</code> check‑and‑add must be atomic, otherwise two threads both see "unseen" and fetch twice. That's the whole reason for the lock.</li>
    <li><code>pending</code> is the termination counter; it must move under the same lock so "pending == 0" is never observed mid‑update.</li>
    <li>Never hold the lock during <code>fetch</code>: network I/O under a lock serializes the crawler back to one thread.</li>
    <li>Alternatives to a lock: a concurrent set with atomic <code>putIfAbsent</code> (Java <code>ConcurrentHashMap.newKeySet()</code>), or an <code>AtomicInteger</code> for pending. Same semantics, less contention.</li></ul></div>
  <div><h4>Termination, the part people get wrong</h4><ul>
    <li>"Queue empty" is not "done": a worker may be mid‑fetch and about to enqueue 50 links. Done = queue empty <b>and</b> no URL in flight, hence the pending counter incremented at enqueue and decremented after the children are enqueued.</li>
    <li>Wake the coordinator with a condition variable when pending hits 0; then send poison pills so blocked <code>q.get()</code> calls exit.</li>
    <li>Same idea in Java: <code>Phaser</code>/<code>CountDownLatch</code> won't work because the count is unknown up front; use an atomic counter + <code>CompletableFuture</code> chaining or a <code>ForkJoinPool</code> with recursive tasks and <code>join()</code>.</li></ul></div>
  <div><h4>Thread pool sizing and I/O</h4><ul>
    <li>Fetching is I/O‑bound: threads ≈ target concurrency, not CPU count. 16–64 threads on one box is fine; beyond that use async I/O (asyncio + aiohttp, Java NIO) so 1,000 in‑flight fetches don't cost 1,000 stacks.</li>
    <li>Per‑host politeness even here: a semaphore or timestamp per host so 16 threads don't hammer one server; hosts are effectively a queue of queues.</li>
    <li>Timeouts on every fetch, max page size, max depth, and a URL normalizer (lowercase host, strip fragment, sort query, resolve <code>..</code>) so the visited set actually catches duplicates.</li></ul></div>
</div>

## Version 2: distributed crawler deep dives {#cr-deepdives}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/web-crawler/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

### 1. The frontier: what next, and when

<ul>
  <li><b>Two‑level queues (Mercator design):</b> front queues by priority (page importance, change rate, depth); back queues one per host, each fed from the front queues; a min‑heap of hosts keyed by <code>next_allowed_at</code>. A worker pops the earliest‑ready host, takes one URL from its back queue, fetches, then sets the host's next time = now + crawl_delay.</li>
  <li><b>Distributed:</b> partition the frontier by host hash so all URLs for a host land on one partition and politeness is enforced by exactly one consumer. Kafka partitions (durable, replayable) or Redis sorted sets per host (fast, needs AOF). Workers claim with a lease; a reaper requeues expired leases.</li>
  <li><b>Priority signals:</b> PageRank‑like importance, historical change frequency (recrawl news hourly, static docs monthly), depth, explicit seed lists.</li>
</ul>

### 2. Dedupe: URLs and content

<ul>
  <li><b>URL seen test:</b> canonicalize first (scheme/host lowercase, default ports, sort query params, drop tracking params and fragments, resolve relative). Then a Bloom filter in memory per partition (1B URLs ≈ 1.2 GB at 1% FP) backed by the exact set in the metadata store for the rare false positive check when it matters. False positives only skip a page; never fatal.</li>
  <li><b>Content dedupe:</b> exact sha256 of the body catches mirrors; <b>simhash</b> (64‑bit fingerprint, Hamming distance ≤ 3) catches near‑duplicates like boilerplate variations; store fingerprint in an index bucketed by rotated bits for fast neighbor lookup.</li>
  <li>Dedupe check happens before enqueue, so duplicates never consume frontier or fetch capacity.</li>
</ul>

### 3. Politeness and robots

<ul>
  <li>Fetch and cache <code>robots.txt</code> per host (TTL ~24 h); honor Disallow, Crawl‑delay, and the user‑agent rules. Identify yourself with a UA and contact URL.</li>
  <li>One in‑flight request per host, default 1 req/s or the site's crawl‑delay; back off harder on 429/503 and open a per‑host circuit breaker after repeated failures.</li>
  <li>DNS cache with TTL so 400 fetches/s don't become 400 DNS lookups/s.</li>
</ul>

### 4. Fetcher robustness

<ul>
  <li>Connect/read timeouts, max body size (skip &gt; few MB), accept only html/text content types for parsing, follow ≤ 5 redirects, retries with exponential backoff on 5xx/timeouts, give up after N attempts and record the failure.</li>
  <li><b>Spider traps:</b> calendars, infinite query params, session ids in URLs. Defenses: max depth, max URLs per host per crawl, URL length cap, pattern detection (same path with growing params), and the content‑dedupe check (trap pages look alike).</li>
  <li>Workers are stateless and idempotent: ack the frontier only after children are enqueued and the page is stored; a crash mid‑page means the lease expires and another worker redoes it, with dedupe preventing double enqueue.</li>
</ul>

### 5. Storage and downstream

<ul>
  <li>Raw HTML in blob storage keyed by content hash (natural dedupe, cheap); metadata (url, state, timestamps, hash, headers) in a wide‑column store keyed by URL hash; link edges streamed to Kafka for the indexer and the graph.</li>
  <li>3.5 TB/day raw → compressed ~0.7 TB/day; lifecycle old snapshots to cold storage.</li>
</ul>

### 6. Scaling and operations

<ul>
  <li>Throughput ceiling is politeness, not CPU: 1 req/s/host means 400 pages/s needs ≥ 400 distinct hosts ready at any moment. Spread the frontier so the host heap always has ready hosts; a crawl dominated by a few huge hosts will be slow by design.</li>
  <li>Scale workers horizontally per frontier partition; add partitions by resharding host hashes. Regional workers near the target hosts reduce latency.</li>
  <li>Metrics: pages/s, frontier depth per priority, in‑flight count, per‑host error and 429 rates, dedupe hit rate, average fetch latency, worker utilization; absence alert if pages/s hits 0 with frontier non‑empty (wedged crawl).</li>
  <li>Resumability: frontier is durable, visited set persisted (Bloom snapshots + metadata store), so a restart continues instead of recrawling.</li>
</ul>


## Trade-offs {#cr-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Visited set</td><td>Bloom filter over billions of URLs</td><td>~1% of pages are wrongly skipped as already seen</td><td>An exact set when coverage must be complete and 100 GB of memory (or a sharded KV store) is affordable</td></tr>
  <tr><td>Politeness enforcement</td><td>At claim time, via a per‑host next‑allowed timestamp</td><td>Workers can idle when the frontier is dominated by a few hosts</td><td>Sleeping after fetch is simpler but wastes concurrency and still allows bursts when workers collide on one host</td></tr>
  <tr><td>Frontier</td><td>Durable, partitioned by host</td><td>Operating a queue, and rebalancing when host partitions are skewed</td><td>An in‑memory queue is fine for a single‑machine, single‑domain crawl; at scale losing it means re‑crawling the web</td></tr>
  <tr><td>Fetch and parse</td><td>Decoupled through blob storage</td><td>Storage cost for raw HTML, and a second pipeline stage</td><td>Parsing inline is simpler but means every parser bug or schema change requires re‑crawling — which hits other people's servers again</td></tr>
  <tr><td>Duplicate detection</td><td>Canonical URL <em>and</em> content simhash</td><td>Simhash computation per page, plus a similarity index</td><td>URL dedupe alone is cheap but misses mirrors and traps that generate endless near‑identical pages</td></tr>
  <tr><td>Concurrency model</td><td>~100–200 concurrent fetches on a few machines</td><td>Nothing much — fetches are network‑bound, so threads are nearly free</td><td>More machines only when bandwidth or host diversity, not CPU, is the limit; adding machines for a network‑bound crawl is a common over‑design</td></tr>
  <tr><td>Recrawl policy</td><td>Priority by estimated change rate, with conditional requests</td><td>Complexity in estimating freshness per page</td><td>A fixed interval is simpler but wastes most of the budget re‑fetching pages that never change</td></tr>
</tbody></table>

## Safety-first design {#cr-safety}

<div class="cards">
  <div><h4>Do not become a denial of service</h4><ul>
    <li><b>One request per second per host, always.</b> Enforced at claim time so no combination of workers can burst against a single site.</li>
    <li><b>Limit by IP block, not just by hostname.</b> Thousands of hosts can share one server, and per‑host politeness alone still floods it.</li>
    <li><b>Back off and park.</b> 5xx and timeouts trigger exponential backoff with jitter, then removal from the schedule — a struggling site must not be hammered by the crawler reading it.</li>
    <li><b>Identify yourself.</b> A user agent with a contact URL, and prompt honouring of robots.txt and <code>crawl‑delay</code>, is what keeps a crawler welcome.</li></ul></div>
  <div><h4>Surviving a hostile web</h4><ul>
    <li><b>Cycles are handled by dedupe, not by hope.</b> Circular references terminate because the second visit is never enqueued; a depth limit bounds anything dedupe misses.</li>
    <li><b>Traps are bounded by canonicalization and simhash.</b> Infinite calendars and session‑id URLs collapse under normalisation, and near‑duplicate detection catches the rest.</li>
    <li><b>Hard caps on every fetch.</b> Timeout, maximum response size and redirect depth stop one hostile response from wedging a worker or exhausting memory.</li>
    <li><b>No worker can wedge the crawl.</b> Leases expire and URLs return to the frontier, so a hung fetch costs one lease interval rather than a stalled pipeline.</li></ul></div>
  <div><h4>Respecting what you collect</h4><ul>
    <li><b>robots.txt and noindex are policy.</b> Treated as rules rather than hints, including for pages already stored from an earlier crawl.</li>
    <li><b>Strip credentials, skip authenticated pages.</b> URLs with embedded tokens are sanitised before storage so the corpus does not become a credential dump.</li>
    <li><b>Takedown reaches the derivatives.</b> Removing a page deletes the stored blob, the index entries and any embeddings derived from it.</li>
    <li><b>Finite retention on raw HTML.</b> Keeping everything forever is a growing liability; the index is rebuildable from a bounded window.</li></ul></div>
</div>

## Don't leave the room without saying {#cr-checklist}

<ul class="checklist">
  <li>Frontier + visited + workers + termination rule; everything else hangs off that</li>
  <li>Single lock (or atomic putIfAbsent) around check‑and‑add; never hold it during fetch</li>
  <li>Done = queue empty AND in‑flight = 0; pending counter and poison pills</li>
  <li>I/O‑bound → thread count is target concurrency; async I/O beyond ~100</li>
  <li>Canonicalize URLs before dedupe; Bloom filter sizing; simhash for near‑duplicates</li>
  <li>Per‑host back queues keyed by next_allowed_at; robots.txt cache; 1 req/s/host</li>
  <li>Partition frontier by host hash so politeness has one owner; lease + reaper</li>
  <li>Timeouts, size caps, redirect limits, trap defenses (depth, per‑host caps, patterns)</li>
  <li>Ack after children enqueued; idempotent workers; resumable from durable frontier</li>
  <li>Throughput is bounded by distinct ready hosts, not machines</li>
</ul>

## What each level is expected to drive {#cr-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Correct thread‑pool crawler with a lock, visited set, and termination; basic distributed picture (queue + workers + storage)</td><td>Politeness, Bloom filter, canonicalization</td></tr>
  <tr><td>Senior</td><td>Two‑level frontier with per‑host politeness, host‑partitioned distribution, URL + content dedupe, fetcher robustness and traps, lease/ack semantics, capacity math</td><td>Recrawl scheduling, simhash indexing</td></tr>
  <tr><td>Staff+</td><td>Identifies politeness as the throughput ceiling, designs priority and freshness policy, operational story (resumability, wedged‑crawl detection, per‑host breakers), and explains exactly which shared state needs which synchronization and why</td><td>—</td></tr>
</tbody></table>
