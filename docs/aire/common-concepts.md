---
title: "Common concepts across every design — the pre-interview note"
slug: /aire/common-concepts
sidebar_position: 1
sidebar_label: "Common concepts — the pre-interview note"
description: "reference · the ~20 ideas that recombine across all 40 designs · what to use, when, and which page shows it"
---

## How to use this page

<header>
  
  <span class="tag">reference · the ~20 ideas that recombine across all 40 designs · what to use, when, and which page shows it</span>
</header>
<p>Forty designs, but not forty ideas. Mined across every page in this section, the same mechanisms keep reappearing: <b>degraded mode in 39 of them, rate limiting in 37, percentile thinking in 30, batching in 21, leases in 20, idempotency in 19</b>. Learn the mechanism once and you can derive the design; memorise the designs and you can answer only the questions you have already seen.</p>

<p>Each entry below is: <b>what it is · when to reach for it · what software · where it shows up here</b>. Read it the morning of an interview, not the night before — it is a set of triggers, not a script.</p>

<div class="note"><b>The ten reflexes.</b> If you remember nothing else: (1) ask for numbers, then do the arithmetic out loud · (2) reads ≫ writes → cache and denormalize · (3) work is claimed and can be abandoned → lease + heartbeat + reaper · (4) at‑least‑once + idempotent writes, never exactly‑once · (5) anything rolled out → immutable versions + one mutable pointer · (6) fan‑out → the tail is max(N), so hedge and set deadlines · (7) above capacity → shed, never queue unboundedly · (8) a cache hit rate <em>is</em> the capacity plan · (9) derived views must be rebuildable from a system of record · (10) name the failure mode and the abuse vector before they ask.</div>

## 1. Transport: how bytes reach the client {#cc-transport}

<table>
  <tbody><tr><th>Choice</th><th>Use when</th><th>Don't use when</th><th>Seen in</th></tr>
  <tr><td><b>Plain HTTP request/response</b></td><td>Short, bounded work. The default — do not reach past it without a reason.</td><td>Work takes more than a few seconds; intermediate proxies will time it out.</td><td><a href="/docs/aire/inference-api">inference-api</a> (sync outside, async inside)</td></tr>
  <tr><td><b>SSE</b> (server-sent events)</td><td>One‑way server → client streaming. <b>Native reconnect with <code>Last-Event-ID</code></b>, survives proxies, plain HTTP.</td><td>The client needs to push mid‑stream.</td><td><a href="/docs/aire/llm-chat">llm-chat</a>, <a href="/docs/aire/developer-api">developer-api</a>, <a href="/docs/aire/desktop-chat-frontend">desktop-chat-frontend</a></td></tr>
  <tr><td><b>WebSocket</b></td><td>Genuinely bidirectional — chat, presence, collaborative editing.</td><td>Data flows one way. You pay sticky routing and connection management for nothing.</td><td><a href="/docs/aire/chat-1to1">chat-1to1</a> (10M concurrent sockets)</td></tr>
  <tr><td><b>Long polling</b></td><td>Hostile networks or ancient clients.</td><td>Anywhere SSE works — it costs far more per update.</td><td>fallback in <a href="/docs/aire/chat-1to1">chat-1to1</a></td></tr>
  <tr><td><b>Webhook / callback</b></td><td>Work takes minutes to hours; the caller should not hold anything open.</td><td>The receiver may be offline — then pair it with a polling endpoint.</td><td><a href="/docs/system-design-notes/flash-sale">flash-sale</a> (payment), <a href="/docs/aire/infra-batch">infra-batch</a></td></tr>
</tbody></table>

<div class="trap"><b>The line that scores:</b> "SSE, because the data only flows one way and its native <code>Last-Event-ID</code> reconnect means a dropped connection resumes instead of regenerating — which for an LLM response is the difference between a hiccup and paying twice for the same answer."</div>

## 2. Queues and work distribution {#cc-queues}

<h4>Push or pull?</h4>
<ul>
  <li><b>Pull (workers claim)</b> — the queue is the scheduler. Whoever is idle takes the next item, atomically. No global load view to go stale, self‑balancing, retry is free. <b>Default choice.</b> See <a href="/docs/aire/inference-api">inference-api</a>, <a href="/docs/aire/image-job-service">image-job-service</a>.</li>
  <li><b>Push (a scheduler assigns)</b> — needs a fresh view of every worker's load, which is always stale; multiple schedulers then all pick the same "least loaded" worker and stampede it. Earns its complexity only for heterogeneous pools, model affinity or canaries.</li>
</ul>

<h4>Which queue software</h4>
<table>
  <tbody><tr><th>Option</th><th>Use when</th><th>Cost</th><th>Seen in</th></tr>
  <tr><td><b>Database as a queue</b><br/><code>UPDATE … FOR UPDATE SKIP LOCKED</code></td><td>You need per‑item state, progress, cancellation, fair ordering and auditability. Up to thousands of claims/s.</td><td>The database becomes the hot path and the eventual ceiling.</td><td><a href="/docs/aire/infra-batch">infra-batch</a>, <a href="/docs/aire/image-job-service">image-job-service</a></td></tr>
  <tr><td><b>Redis lists</b><br/><code>RPOPLPUSH</code>, <code>BLPOP</code></td><td>Low latency, in‑flight lists for crash safety, simple fan‑out.</td><td>Not durable by default; state is rebuildable only.</td><td><a href="/docs/aire/inference-api">inference-api</a>, <a href="/docs/aire/chat-1to1">chat-1to1</a></td></tr>
  <tr><td><b>Kafka / a durable log</b></td><td>Many independent consumers, replay, ordering per key, decoupling ingest from processing.</td><td>No per‑item state; you cannot cancel item 47.</td><td><a href="/docs/aire/telemetry">telemetry</a>, <a href="/docs/aire/infra-metrics">infra-metrics</a>, <a href="/docs/aire/ai-platform">ai-platform</a></td></tr>
  <tr><td><b>SQS / managed queue</b></td><td>Simple fan‑out with visibility timeouts and a DLQ, no ops.</td><td>Weak ordering; limited per‑item introspection.</td><td><a href="/docs/aire/image-pipeline">image-pipeline</a></td></tr>
</tbody></table>

<h4>The lease pattern — memorise this one</h4>
<p><b>Any time work is claimed and the claimer can die</b>, you need the same three pieces:</p>
<ol class="order">
  <li><b>Atomic claim</b> — one conditional UPDATE that moves state <em>and</em> stamps owner + expiry. Never select‑then‑update: the gap is a race.</li>
  <li><b>Heartbeat</b> — the owner pushes the expiry forward, guarded by <code>owner = me AND state = RUNNING</code>. Batched across all its items.</li>
  <li><b>Reaper</b> — anything past its expiry returns to PENDING with attempts incremented. Detection latency = lease length.</li>
</ol>
<p><b>A lease is not a lock.</b> A lock needs a live holder to release it, so a crash wedges the item forever. A lease expires on its own — no failure detector, no worker registry, no cleanup protocol. Appears in 20 of 40 pages: <a href="/docs/aire/infra-batch">infra-batch</a>, <a href="/docs/aire/image-job-service">image-job-service</a>, <a href="/docs/aire/web-crawler">web-crawler</a>, <a href="/docs/aire/infra-ratelimit">infra-ratelimit</a> (budget leases), <a href="/docs/aire/infra-weights">infra-weights</a> (disk reservations).</p>

<p><b>Poison items:</b> bound the attempts, then move to a <b>DLQ</b>. One bad input must never block the other million — and an unwatched DLQ is just a slower way of dropping work.</p>

## 3. Pick the store {#cc-storage}

<table>
  <tbody><tr><th>Store</th><th>Reach for it when</th><th>Software</th><th>Seen in</th></tr>
  <tr><td><b>Relational</b></td><td>Transactions, constraints as correctness (unique keys!), ad‑hoc queries, modest scale. <b>Start here.</b></td><td>Postgres, MySQL</td><td><a href="/docs/system-design-notes/yelp">yelp</a>, <a href="/docs/system-design-notes/bitly">bitly</a>, <a href="/docs/aire/prompt-sharing">prompt-sharing</a></td></tr>
  <tr><td><b>Wide-column / KV</b></td><td>One access pattern, huge write volume, partition key is obvious. No joins wanted.</td><td>DynamoDB, Cassandra, Bigtable</td><td><a href="/docs/aire/chat-1to1">chat-1to1</a>, <a href="/docs/aire/llm-chat">llm-chat</a>, <a href="/docs/aire/instagram">instagram</a></td></tr>
  <tr><td><b>Object storage</b></td><td>Anything over ~1 MB. Blobs never go in a database.</td><td>S3, GCS</td><td><a href="/docs/aire/clouddrive">clouddrive</a>, <a href="/docs/aire/infra-weights">infra-weights</a>, <a href="/docs/aire/image-pipeline">image-pipeline</a></td></tr>
  <tr><td><b>Time-series (TSDB)</b></td><td>Timestamped numbers by label, rollups, retention tiers.</td><td>Prometheus, ClickHouse, Timescale</td><td><a href="/docs/aire/infra-metrics">infra-metrics</a>, <a href="/docs/aire/telemetry">telemetry</a></td></tr>
  <tr><td><b>Search index</b></td><td>Full text, geo, facets, relevance ranking.</td><td>Elasticsearch, Lucene</td><td><a href="/docs/aire/distributed-search">distributed-search</a>, <a href="/docs/system-design-notes/yelp">yelp</a></td></tr>
  <tr><td><b>Vector / ANN index</b></td><td>Semantic similarity — "find things <em>like</em> this".</td><td>HNSW (FAISS, pgvector, Pinecone)</td><td><a href="/docs/aire/hybrid-search">hybrid-search</a></td></tr>
  <tr><td><b>Columnar files</b></td><td>Analytical scans, immutable history, cheap long retention.</td><td>Parquet on object storage</td><td><a href="/docs/aire/telemetry">telemetry</a> (raw store), <a href="/docs/aire/mapreduce-perf">mapreduce-perf</a></td></tr>
  <tr><td><b>Cache</b></td><td>Read‑heavy, tolerates staleness, rebuildable.</td><td>Redis, Memcached</td><td>almost everywhere</td></tr>
</tbody></table>

<div class="note"><b>Vectors, briefly.</b> An embedding turns text into ~768 floats where distance ≈ meaning. Exact nearest‑neighbour over 10M vectors is a full scan — billions of operations, not available in 50 ms — so you use <b>ANN</b>: HNSW walks a navigable small‑world graph touching a few hundred nodes instead of ten million. <code>efSearch</code> is the recall/latency dial and belongs to the <em>server</em>, never the caller. Quantizing float32 → int8 cuts memory 4× for a small recall loss. See <a href="/docs/aire/hybrid-search">hybrid-search</a>.</div>

<p><b>The answer interviewers want when you pick "NoSQL":</b> not "it scales" — it is <em>"there is exactly one access pattern (fetch a conversation's tail by time), the write volume is huge, and I never need a join, so a wide‑column store partitioned by conversationId gives me a contiguous read and linear write scaling. If I needed ad‑hoc queries I'd stay relational."</em></p>

## 4. Hashing — one word, six different jobs {#cc-hashing}

<table>
  <tbody><tr><th>Kind</th><th>Job</th><th>Use</th><th>Seen in</th></tr>
  <tr><td><b>Content hash / checksum</b><br/>SHA‑256, CRC32</td><td>"Are these bytes what I expect?"</td><td>Integrity on every chunk; deduplication for free; idempotent output keys. CRC32 for cheap corruption detection, SHA‑256 when an adversary might be involved.</td><td><a href="/docs/aire/infra-weights">infra-weights</a>, <a href="/docs/aire/file-dedupe">file-dedupe</a>, <a href="/docs/aire/lru-crash-resilient">lru-crash-resilient</a></td></tr>
  <tr><td><b>Merkle root</b></td><td>"Are these the right chunks of the right thing?"</td><td>Per‑chunk hashes prove each piece; the root proves the assembly. Both, not either.</td><td><a href="/docs/aire/infra-weights">infra-weights</a>, <a href="/docs/aire/stream-file-1000">stream-file-1000</a></td></tr>
  <tr><td><b>Consistent hashing</b></td><td>"Which shard owns this key?"</td><td>Adding/removing a node moves ~1/N of keys instead of everything. <b>Virtual nodes are mandatory</b> — one token per node gives badly uneven shards. Balances <em>keys</em>, not <em>load</em>: a hot key still lands on one shard.</td><td><a href="/docs/aire/kv-multiregion">kv-multiregion</a>, <a href="/docs/aire/network-io-service">network-io-service</a></td></tr>
  <tr><td><b>Bloom filter</b></td><td>"Have I definitely <em>not</em> seen this?"</td><td>1B URLs = 100 GB as strings, ~1.2 GB as a Bloom filter at 1% false positives. False positive = you skip something; false negative is impossible — which is the right direction for a crawler.</td><td><a href="/docs/aire/web-crawler">web-crawler</a></td></tr>
  <tr><td><b>Simhash / MinHash</b></td><td>"Is this <em>nearly</em> the same?"</td><td>Near‑duplicate detection that exact hashing structurally cannot do — mirrors, crawler traps, syndicated content.</td><td><a href="/docs/aire/web-crawler">web-crawler</a>, <a href="/docs/aire/file-dedupe">file-dedupe</a></td></tr>
  <tr><td><b>HMAC / signature</b></td><td>"Did <em>we</em> issue this?"</td><td>Signed URLs, admission tokens, signed manifests. Verifiable without a database lookup — but therefore not revocable before expiry.</td><td><a href="/docs/aire/clouddrive">clouddrive</a>, <a href="/docs/system-design-notes/flash-sale">flash-sale</a></td></tr>
</tbody></table>

<div class="trap"><b>Checksum discipline:</b> verify at the smallest granularity you can afford (per 64 MB chunk, not per 300 GB file), verify <em>before</em> forwarding to anyone else, and treat <b>repeated</b> checksum failure on one node as hardware — fail that node rather than retrying forever and hiding a dying disk behind "slow rollout". (<a href="/docs/aire/infra-weights">infra-weights</a>)</div>

## 5. Caching {#cc-caching}

<ul>
  <li><b>Cache-aside</b> (read, miss, fetch, populate) — the default. Write‑through only when staleness is unacceptable; write‑behind only when you can lose the window.</li>
  <li><b>The hit rate <em>is</em> the capacity plan.</b> At 95%, your store is sized for 1/20th of the traffic — so anything that empties the cache is a <b>20× overload</b>, and cold start becomes a first‑class incident class, not an edge case.</li>
  <li><b>Three stampede defences, all needed:</b>
    <ul>
      <li><b>Single-flight</b> — one fetch per key, everyone else waits. Without it, one popular key expiring at 12K req/s sends 12,000 simultaneous identical queries.</li>
      <li><b>Soft TTL + background refresh</b> — serve stale, refresh async. Removes the latency cliff at expiry.</li>
      <li><b>Jitter</b> — keys populated together must not expire together, or you manufacture the stampede yourself.</li>
    </ul>
  </li>
  <li><b>TTL never exceeds the underlying validity</b> — a cached entry must not outlive the thing it represents, or revocation and expiry silently stop working (<a href="/docs/system-design-notes/bitly">bitly</a>, <a href="/docs/aire/clouddrive">clouddrive</a>).</li>
  <li><b>Domain-specific caches worth naming:</b> CDN for immutable media (<a href="/docs/aire/instagram">instagram</a>, <a href="/docs/aire/clouddrive">clouddrive</a>), KV/prefix cache for a shared LLM system prompt (<a href="/docs/aire/llm-chat">llm-chat</a>), ETag/conditional requests to turn a repeat fetch into a 304 (<a href="/docs/aire/http-optimize">http-optimize</a>).</li>
</ul>

## 6. Throttling: four different mechanisms {#cc-throttling}

<table>
  <tbody><tr><th>Mechanism</th><th>What it does</th><th>Use when</th></tr>
  <tr><td><b>Token bucket</b></td><td>Tokens refill at a rate; a request takes one. Allows a bounded burst.</td><td><b>Default.</b> Continuous refill avoids the 2× burst that fixed windows allow at the boundary.</td></tr>
  <tr><td><b>Fixed / sliding window</b></td><td>Count per window.</td><td>Fixed is simplest and permits a double burst across the boundary; sliding logs are exact and cost memory per request.</td></tr>
  <tr><td><b>Concurrency / slot limit</b></td><td>N in flight at once.</td><td>Tokens‑per‑minute alone does <b>not</b> stop 1,000 simultaneous long streams. You usually need both.</td></tr>
  <tr><td><b>Backpressure</b></td><td>Stop reading; let the producer block.</td><td>Inside a pipeline. TCP windows and bounded buffers do this for free — see <a href="/docs/aire/network-io-service">network-io-service</a>, <a href="/docs/aire/bounded-buffer">bounded-buffer</a>.</td></tr>
</tbody></table>

<p><b>Distributed rate limiting — the pattern to know</b> (<a href="/docs/aire/infra-ratelimit">infra-ratelimit</a>): a central check per request is a round trip at 100K QPS, and independent local buckets over‑admit without bound. The answer is <b>leased local buckets</b>: each gateway leases a block of budget every few seconds and decides locally in microseconds, so over‑admission is bounded by one lease per gateway. For variable‑cost work, <b>reserve the upper bound and settle the actual</b> (<code>prompt + max_tokens</code>, refund the difference).</p>

<p><b>Layer the limits</b> — per key, per org, per IP, plus a global capacity brake. Each stops a different failure: a runaway script, a noisy tenant, a stolen credential, a capacity crunch.</p>

<p><b>Shedding vs queueing:</b> above capacity, <b>shed</b>. A 429 with <code>Retry‑After</code> and the specific limit named costs nothing to serve and lets the client back off. Queueing converts a capacity problem into a latency problem and then into a memory problem. Decide the shedding <em>order</em> in advance — free tier before paid, optional features before core (<a href="/docs/aire/infra-multiregion">infra-multiregion</a>).</p>

## 7. "Token" means four different things {#cc-tokens}

<table>
  <tbody><tr><th>Which token</th><th>What it is</th><th>Watch for</th></tr>
  <tr><td><b>LLM token</b></td><td>~0.75 words. The unit of cost, context window and latency.</td><td>Prefill scales with <em>input</em> tokens — this is why context length is the latency driver and why SLIs must be bucketed by it (<a href="/docs/aire/llm-chat">llm-chat</a>).</td></tr>
  <tr><td><b>Rate-limit token</b></td><td>A unit of permission in a bucket.</td><td>Meter LLM work in tokens, not requests — a 100K‑token call and a 50‑token call are not the same thing (<a href="/docs/aire/developer-api">developer-api</a>).</td></tr>
  <tr><td><b>Auth token</b></td><td>JWT, API key, session, presigned URL.</td><td>Self‑signed = no lookup but <b>not revocable before expiry</b>; stored = a lookup per request but revocable in seconds. That trade‑off is the whole question (<a href="/docs/aire/clouddrive">clouddrive</a>).</td></tr>
  <tr><td><b>Fencing token</b></td><td>A monotonically increasing number proving <em>current</em> leadership.</td><td>Enforced <b>at the resource</b>, not the coordinator. A lock service can only attest to the past; only storage can refuse the write happening now (<a href="/docs/aire/infra-config">infra-config</a>).</td></tr>
</tbody></table>

## 8. Correctness under retries and crashes {#cc-correctness}

<ul>
  <li><b>Delivery semantics.</b> At‑most‑once loses data. Exactly‑once needs distributed transactions. <b>At‑least‑once + idempotent effects</b> gets the same observable outcome for far less — and is the right answer in 19 of these designs.</li>
  <li><b>How to be idempotent:</b> a <b>client-generated key</b> (only the client knows a retry is the <em>same</em> request), a <b>unique constraint</b> in the schema, and <b>content-addressed writes</b> — <code>key = f(job, operation, version)</code>, so a duplicate execution overwrites identical bytes and changes nothing.</li>
  <li><b>A timeout is an unknown, not a failure.</b> The request may have succeeded. Without an idempotency key, both retrying and not retrying are wrong some of the time (<a href="/docs/aire/http-optimize">http-optimize</a>).</li>
  <li><b>Optimistic concurrency:</b> <code>UPDATE … WHERE version = :expected</code>; zero rows updated means someone beat you — re‑read and retry. Use when conflicts are rare; pessimistic locking serialises everything (<a href="/docs/system-design-notes/yelp">yelp</a>, <a href="/docs/system-design-notes/flash-sale">flash-sale</a>).</li>
  <li><b>Immutable versions + one mutable pointer.</b> 18 of 40 pages. Rollback becomes a pointer flip, attribution becomes possible, and caching becomes trivial — <a href="/docs/aire/infra-rollout">infra-rollout</a>, <a href="/docs/aire/prompt-sharing">prompt-sharing</a>, <a href="/docs/aire/distributed-search">distributed-search</a> (segments), <a href="/docs/aire/infra-weights">infra-weights</a>.</li>
  <li><b>System of record vs derived view.</b> Keep raw truth immutable; make everything else rebuildable. This is what makes a wrong decision reversible — most visible in <a href="/docs/aire/telemetry">telemetry</a>, where it is the entire reason a bad metric mapping can be undone.</li>
  <li><b>Atomic activation.</b> Write to staging, then one atomic rename/symlink flip. A crash then leaves complete or absent, never partial (<a href="/docs/aire/infra-weights">infra-weights</a>, <a href="/docs/aire/file-dedupe">file-dedupe</a>, <a href="/docs/aire/lru-crash-resilient">lru-crash-resilient</a>).</li>
</ul>

## 9. Latency, percentiles and tails {#cc-latency}

<ul>
  <li><b>Never average.</b> A mean that "looks a bit worse" can be a quarter of users seeing two seconds. Emit <b>histograms</b>, not pre‑computed percentiles — percentiles cannot be averaged across cells or re‑aggregated over time.</li>
  <li><b>Fan-out tail:</b> query latency is <b>max</b>(N shard latencies). With 100 shards and a per‑shard p99 of 100 ms, ~63% of queries contain at least one slow shard. Remedies: <b>hedged requests</b> after the p95 (a few percent extra load removes most of the tail) and <b>absolute deadlines</b> propagated to every hop (<a href="/docs/aire/distributed-search">distributed-search</a>).</li>
  <li><b>Partial results beat timeouts</b> for search‑like workloads — return what arrived, flagged, with a coverage figure.</li>
  <li><b>Queueing: wait grows as 1/(1−ρ).</b> At 70% utilization a spike costs milliseconds; at 95% the same spike costs seconds. This is why you run at 70% and why a 20× p95 regression with unchanged code is almost always saturation (<a href="/docs/aire/inference-api">inference-api</a>, <a href="/docs/aire/p95-debug">p95-debug</a>).</li>
  <li><b>Streaming SLIs:</b> total latency is the wrong metric — it scales with output length, so a long answer looks like an outage. Use <b>TTFT</b> (responsiveness) and <b>ITL</b> (speed), bucketed by context length (<a href="/docs/aire/infra-slo">infra-slo</a>).</li>
</ul>

## 10. Partitioning, replication, isolation {#cc-partitioning}

<ul>
  <li><b>Shard by the access pattern.</b> By entity id when queries are per‑entity (conversation, user); by hash for even spread; by time only for append‑heavy archival — it makes "now" a hot partition for everything else.</li>
  <li><b>Document sharding vs term sharding</b> (<a href="/docs/aire/distributed-search">distributed-search</a>): document sharding means every query hits every shard (fan‑out cost) but indexing stays local; term sharding narrows the fan‑out and makes multi‑term queries a cross‑machine intersection — worse at scale.</li>
  <li><b>Cells</b> (<a href="/docs/aire/infra-multiregion">infra-multiregion</a>): a self‑contained unit — router + workers + cache + limiter + config, no shared state. The blast radius of a bad deploy or a poisoned cache is one cell, and a cell is also the unit of canary and of drain.</li>
  <li><b>Hot keys/celebrities.</b> Consistent hashing balances keys, not load. The fixes: replicate the hot item across shards, cache it at the edge, or exclude it from the normal path entirely — which is exactly what <a href="/docs/aire/instagram">instagram</a> does with celebrity fan‑out (push for normal accounts, pull at read time for the extreme tail).</li>
  <li><b>Fan-out on write vs read.</b> Write = precompute per consumer, fast reads, expensive for huge audiences. Read = compute at query time, cheap writes, expensive reads. <b>Hybrid is almost always the answer</b>, and knowing <em>where</em> the threshold sits is the senior signal.</li>
</ul>

## 11. Failure, degradation, rollout {#cc-failure}

<ul>
  <li><b>Every system has a behaviour above capacity</b> — the only question is whether you chose it. By omission the default is "accept everything and collapse". Name your degraded modes: <b>pre‑approved, ordered, owned, time‑boxed</b>, with published relaxed SLOs (<a href="/docs/aire/infra-multiregion">infra-multiregion</a>).</li>
  <li><b>Fail closed or fail open — decide explicitly.</b> Safety classifiers fail <em>closed</em> (unavailable ≠ allowed). Config fails to <em>last‑known‑good</em>. Rate limiters do <em>neither</em> — not open (one key saturates the fleet), not closed (a quota outage becomes a customer outage), but a conservative middle (<a href="/docs/aire/infra-safeguards">infra-safeguards</a>, <a href="/docs/aire/infra-config">infra-config</a>, <a href="/docs/aire/infra-ratelimit">infra-ratelimit</a>).</li>
  <li><b>Circuit breakers open to a <em>named</em> mode</b>, not to "allow".</li>
  <li><b>Canary + rollback:</b> immutable versions, start at 1%, gates that actually block (a missing signal is a <em>failing</em> gate, never a pass), keep the previous version warm — otherwise "60‑second rollback" is fiction (<a href="/docs/aire/infra-rollout">infra-rollout</a>).</li>
  <li><b>Retries need all three:</b> exponential backoff, jitter, and a bounded budget. Without them retries amplify the incident that caused them.</li>
  <li><b>Timeouts everywhere, deadlines propagated.</b> No downstream call may extend the caller's budget.</li>
</ul>

## 12. Observability {#cc-observability}

<ul>
  <li><b>RED</b> per endpoint (Rate, Errors, Duration) and <b>USE</b> per resource (Utilization, Saturation, Errors). Saturation signals — queue depth, pool waiters — rise <em>before</em> latency does, which makes them the best early warning you have.</li>
  <li><b>Burn-rate alerts</b> on an SLO with paired windows, not static thresholds — a 2% error rate for 5 minutes and for 5 hours are different events. Fast burn pages, slow burn tickets.</li>
  <li><b>Absence alerts.</b> A component that stops reporting looks identical to a healthy quiet one. Threshold rules are silent exactly when things stop.</li>
  <li><b>Dead-man switch</b> to an external service — the only way to detect total failure of your own monitoring.</li>
  <li><b>Cardinality is the scaling variable</b>, not sample rate. Never put an id in a label; use <b>exemplars</b> to link a slow histogram bucket to a trace (<a href="/docs/aire/infra-metrics">infra-metrics</a>).</li>
  <li><b>Per-hop latency ledger</b> at 100% + traces sampled at 1–10%. Cheap, structured, and the difference between "the service is slow" and "the database span went 8 ms → 1,400 ms for tenant X" (<a href="/docs/aire/infra-slo">infra-slo</a>, <a href="/docs/aire/p95-debug">p95-debug</a>).</li>
</ul>

## 13. Safety and data handling {#cc-safety}

<ul>
  <li><b>Authorize on the query, not the URL.</b> A guessed id must return nothing. In search, filter <em>during</em> matching — post‑filtering leaks existence through counts and pagination (<a href="/docs/aire/distributed-search">distributed-search</a>).</li>
  <li><b>Possession ≠ permission.</b> Re‑check on every request and hand out short‑lived scoped URLs, so revocation is bounded by minutes rather than by a token's lifetime.</li>
  <li><b>Deletion must reach derivatives</b> — summaries, embeddings, thumbnails, caches, indexes, backups. A delete that stops at the primary store is not a delete.</li>
  <li><b>Never log payloads.</b> Log ids, sizes, timings, error classes. Support from a request id plus structured metadata is what makes zero‑retention and real support compatible (<a href="/docs/aire/developer-api">developer-api</a>).</li>
  <li><b>Untrusted input includes model output.</b> A benign prompt can produce harmful text, so classify both directions — and buffer a few tokens so you can cut <em>before</em> display rather than retract after (<a href="/docs/aire/infra-safeguards">infra-safeguards</a>).</li>
  <li><b>Design for revocation, not prevention.</b> Keys leak into public repos; what matters is how fast you can kill one.</li>
</ul>

## 14. Numbers worth memorising {#cc-numbers}

<div class="cards">
  <div><h4>Latency</h4><ul>
    <li>Memory ~100 ns · SSD ~100 µs · same‑DC network ~0.5 ms</li>
    <li>Cross‑country ~70 ms · cross‑continent ~150 ms</li>
    <li>1 Gb/s ≈ 125 MB/s; 10 Gb/s ≈ 1.25 GB/s</li></ul></div>
  <div><h4>Capacity</h4><ul>
    <li>One machine: ~10K QPS, ~1 TB RAM, ~10–100 Gb/s NIC</li>
    <li>Run at ~70% — wait time grows as 1/(1−ρ)</li>
    <li>Cluster MTBF = node MTBF ÷ node count</li></ul></div>
  <div><h4>Arithmetic</h4><ul>
    <li>1M/day ≈ 12/s · 1B/day ≈ 12K/s (86,400 s/day)</li>
    <li>Peak ≈ 2–3× average for consumer traffic</li>
    <li>Base62⁶ ≈ 56B · Gorilla ≈ 1.4 B/metric point</li></ul></div>
</div>

## The pattern frequency, measured {#cc-frequency}

<p>Counted across all 40 pages in this section — this is why the volume is smaller than it looks:</p>

<table>
  <tbody><tr><th>Pattern</th><th>Pages</th><th>Pattern</th><th>Pages</th></tr>
  <tr><td>Degraded mode / shedding</td><td>39</td><td>Object storage for blobs</td><td>16</td></tr>
  <tr><td>Rate limiting / quotas</td><td>37</td><td>Content hash / checksum</td><td>12</td></tr>
  <tr><td>Percentile thinking</td><td>30</td><td>CAS / optimistic locking</td><td>12</td></tr>
  <tr><td>Batching</td><td>21</td><td>Canary + rollback</td><td>11</td></tr>
  <tr><td>Lease + heartbeat + reaper</td><td>20</td><td>Durable log (Kafka)</td><td>10</td></tr>
  <tr><td>Sharding</td><td>19</td><td>Cache stampede defences</td><td>9</td></tr>
  <tr><td>Idempotency</td><td>19</td><td>Backpressure</td><td>9</td></tr>
  <tr><td>Immutable + pointer</td><td>18</td><td>SSE streaming</td><td>8</td></tr>
  <tr><td>PII / retention</td><td>18</td><td>Fail closed</td><td>8</td></tr>
  <tr><td>Replication</td><td>16</td><td>WAL / snapshot</td><td>7</td></tr>
</tbody></table>

## Don't leave the room without saying {#cc-check}

<ul class="checklist">
  <li>Ask for the numbers, then do the capacity arithmetic <b>out loud</b> — the derivation is the answer</li>
  <li>Name the read/write ratio early; it decides where the design budget goes</li>
  <li>At‑least‑once + idempotent writes, and say why not exactly‑once</li>
  <li>Lease + heartbeat + reaper wherever work is claimed</li>
  <li>Immutable versions, one mutable pointer, derived views rebuildable from a system of record</li>
  <li>The tail, not the average: fan‑out is max(N), hedge and set deadlines</li>
  <li>Above capacity: shed in a published order, never queue unboundedly</li>
  <li>State the degraded mode — if you don't choose one, you have chosen "collapse"</li>
  <li>Name the abuse vector and what bounds the blast radius</li>
  <li>Say what you'd measure and what alert would have caught it</li>
</ul>
