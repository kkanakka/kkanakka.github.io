---
title: "Multi-region key-value service at 50K QPS, p95 < 100 ms"
slug: /aire/kv-multiregion
sidebar_position: 47
sidebar_label: "Multi-region key-value service at 50K QP…"
description: "hard · Anthropic · read-heavy KV · consistent hashing · cache stampedes · cross-region replication"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/kv-multiregion/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

## How it works

<header>
  
  <span class="tag">hard · Anthropic · read‑heavy KV · consistent hashing · cache stampedes · cross‑region replication</span>
</header>
<p>An online, read‑heavy key‑value service — a user profile store or an ML feature lookup — serving 50K QPS across several regions with a p95 under 100 ms. Latency is the requirement that decides everything: the speed of light between continents is ~150 ms round trip, so no request may cross a region synchronously, and that single fact forces replication, local reads, and an explicit answer about staleness.</p>

## Requirements {#kv-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li><code>get(key)</code> and <code>multiGet(keys)</code> returning a small value or a miss</li>
      <li><code>put(key, value)</code>, with updates visible in every region within a stated window</li>
      <li>Serve every region locally, with correct behaviour during a region failure</li>
      <li>Batch load and bulk refresh without disturbing online reads</li>
      <li class="out">Range scans, transactions, secondary indexes</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>50K QPS global, ~95% reads; p95 &lt; 100 ms, p99 &lt; 200 ms</li>
      <li>No synchronous cross‑region call on the read path</li>
      <li>99.99% availability; a region loss must not be a global outage</li>
      <li>Stated staleness budget for cross‑region propagation</li>
    </ol>
  </div>
</div>
<div class="note"><b>The number that decides the design:</b> a US‑to‑Europe round trip is ~80–150 ms. With a 100 ms p95 budget, one synchronous cross‑region hop consumes the entire budget before any work happens. So reads are always local, writes replicate asynchronously, and the interesting question becomes not "how do we make it fast" but "what staleness are we willing to publish".</div>

## Scale, performance and safety targets {#kv-targets}

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> 50K global with ~95% reads, so ~47K reads/s and ~2.5K writes/s. Split across four regions that is ~12K reads/s each — small enough that the design is about latency and failure, not about raw throughput.</li>
    <li><b>Data volume:</b> 1B keys at ~1 KB is ~1 TB per region replica. The working set is far smaller: a typical access distribution puts 90% of reads on a few percent of keys, which is why a cache in front does almost all the work.</li>
    <li><b>Growth:</b> ~2× keys annually and more regions over time. Replication cost grows with regions × write rate, so a write‑heavier future changes the design far more than a bigger dataset does.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> p50 &lt; 5 ms (cache hit), p95 &lt; 100 ms, p99 &lt; 200 ms, all measured at the regional edge. A cache miss that reaches the local store is ~10 ms; anything crossing a region is already over budget.</li>
    <li><b>Throughput:</b> at a 95% hit rate the store sees ~600 reads/s per region — trivially served. The cache is not an optimisation here, it is the capacity plan, which means a cold cache is the dominant risk.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the characteristic failures are self‑inflicted — a hot key concentrating traffic on one shard, a cache stampede when a popular key expires, and a cold start after a deploy sending the full 47K reads/s at a store sized for 600.</li>
    <li><b>Rate limiting:</b> per‑caller QPS and multiGet batch size limits, per‑key request coalescing so only one miss reaches the store, and admission control that sheds rather than queues when the store is saturated.</li>
    <li><b>Data sensitivity:</b> profiles and feature vectors are user data replicated to every region, which makes residency a real constraint. Partition by home region where required, encrypt in transit and at rest, and ensure a delete propagates to every replica and every cache rather than expiring quietly.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.99% (~52 min/year). Each region is independently able to serve reads, so a region loss is a routing change rather than an outage.</li>
    <li><b>Degraded mode:</b> local store unavailable → serve stale cache entries past their TTL and alarm, because stale beats down for this workload. Replication lagging → reads stay correct but staler, which is measured and alerted. Write path down → reads continue entirely unaffected, since they share nothing.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> eventual across regions, with a published budget — for example "writes visible in every region within 2 seconds, p99 within 10 seconds". Within a region, read‑your‑writes for the writer, because not seeing your own update reads as a bug every time.</li>
    <li><b>Durability:</b> the store is the system of record and is replicated within and across regions; caches are disposable and never authoritative.</li>
    <li><b>Conflicts:</b> with asynchronous multi‑region writes, two regions can update the same key. Last‑writer‑wins on a version or timestamp is the usual answer, and its consequence — a lost update — must be stated rather than glossed over.</li></ul></div>
</div>

## Entities and API {#kv-api}

<p>Key (string) · Value (blob, small) · Version (monotonic per key: timestamp or counter) · Shard (consistent hash range) · Replica (region, role) · CacheEntry (value, version, softTTL, hardTTL) · ReplicationStream (per‑region log).</p>
<pre><code>GET  /v1/kv/:key                        -&gt; {value, version, ageMs}     # local region only
POST /v1/kv/mget       {keys[]}         -&gt; {key: {value, version}}     # capped batch size
PUT  /v1/kv/:key       {value, ifVersion?} -&gt; {version}                # local write + async replicate
DELETE /v1/kv/:key                      -&gt; tombstone, replicated

Internal:
  replicate(region, [{key, value, version, op}])   # async, ordered per key
  cache: get -&gt; hit | soft-expired (serve + refresh) | miss (single-flight to store)</code></pre>

## Design {#kv-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/kv-multiregion/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

### Flow between components

<ol class="order">
  <li><b>Client → Regional edge:</b> GET /v1/kv/:key.
    DNS or anycast steers the client to the nearest region, so the request is already close before any application logic runs.
    Every region serves the full keyspace rather than a slice of it — partitioning by geography would mean some users always pay a cross‑region hop, which the latency budget forbids.</li>
  <li><b>Regional edge → Cache:</b> look up key.
    The cache is the capacity plan, not an optimisation: at a 95% hit rate the store behind it sees a twentieth of the traffic.
    That framing matters because it makes cold start — not steady state — the dominant risk in the whole design.</li>
  <li><b>Cache → Regional edge:</b> hit → value + version (response).
    The common path is a single in‑memory lookup in the same region, a few milliseconds end to end, comfortably inside a 100 ms budget.
    Returning the version and the entry's age lets a caller reason about staleness instead of guessing.</li>
  <li><b>Cache:</b> soft-expired → serve the stale value and refresh in the background.
    Two TTLs rather than one: at the soft TTL the entry is served <em>and</em> asynchronously refreshed; only at the hard TTL is it treated as absent.
    This removes the latency cliff where a popular key expires and every request suddenly waits on the store.
    Serving slightly stale data for a few milliseconds is invisible; a synchronous refresh on a hot key is a visible spike.</li>
  <li><b>Regional edge → Cache:</b> miss → single-flight: one request fetches, the rest wait.
    Without coalescing, a hot key expiring at 12K reads/s sends 12,000 simultaneous requests to the store for the same value — a stampede that can take down a store sized for 600 reads/s.
    Single‑flight makes one request do the work and hands the result to everyone waiting behind it.
    TTLs also carry jitter so a batch of keys populated together does not later expire together.</li>
  <li><b>Regional edge → Local store:</b> read from the regional replica (consistent hashing to a shard).
    Consistent hashing places keys on shards so that adding or removing a node moves ~1/N of the keyspace rather than remapping everything.
    Virtual nodes smooth the distribution, because a plain hash ring with one token per node produces badly uneven shards.
    The read stays inside the region — this is the invariant the whole latency budget rests on.</li>
  <li><b>Local store → Regional edge:</b> value + version (response).
    Reads go to a local replica rather than a global leader, which is what keeps them fast and what makes them potentially stale.</li>
  <li><b>Regional edge → Cache:</b> populate with jittered TTL; return.
    Populating on read fills the cache with what is actually requested, rather than guessing.
    Jitter on the TTL is a small detail with a large effect: uniform TTLs synchronise expiry and manufacture the stampede that single‑flight then has to absorb.</li>
  <li><b>Client → Regional edge:</b> PUT /v1/kv/:key {value, ifVersion?}.
    Writes are accepted locally and acknowledged locally; waiting for global acknowledgement would cost a cross‑region round trip and blow the budget.
    The optional <code>ifVersion</code> gives compare‑and‑set for callers who need it, which is the honest way to offer conflict avoidance without pretending the system is strongly consistent.</li>
  <li><b>Regional edge → Local store:</b> write with a new version; invalidate the local cache.
    The version is monotonic per key and is what makes replication ordering and conflict resolution possible at all.
    Invalidating rather than updating the cache avoids a subtle bug where a cached value races ahead of or behind the store.
    The writer's subsequent reads are pinned to the local region briefly, giving read‑your‑writes — because not seeing your own update reads as a bug every single time.</li>
  <li><b>Local store → Replication stream:</b> enqueue the change (async).
    Replication is asynchronous and the acknowledgement does not wait for it, which is precisely the trade that buys the latency target.
    The consequence must be stated: a write acknowledged in one region and not yet replicated is lost if that region is destroyed before it propagates.</li>
  <li><b>Replication stream → Other regions:</b> apply ordered per key (async).
    Ordering is required per key, not globally — global ordering would need consensus and a cross‑region round trip per write.
    Each region applies with last‑writer‑wins on the version, so concurrent writes in two regions converge rather than diverging.
    Convergence is not the same as correctness: one of the two updates is silently discarded, and any caller who cannot tolerate that needs compare‑and‑set or a single writer region.</li>
  <li><b>Other regions → Cache:</b> invalidate the key on apply.
    Replicating the data without invalidating the caches leaves every region serving a stale value until its TTL expires, which would make the published staleness budget a fiction.
    Invalidation is the part people forget, and it is what actually determines how quickly a write becomes visible.</li>
  <li><b>Monitoring:</b> replication lag per region, cache hit rate, single-flight waiters, hot-key skew.
    Replication lag is the direct measurement of the published staleness promise, so it is an SLO rather than a debug metric.
    Cache hit rate is a capacity signal: a drop from 95% to 80% quadruples store load and is the earliest warning of trouble.
    Hot‑key skew reveals a shard receiving disproportionate traffic, which consistent hashing spreads but cannot fix — the remedy is replicating that key across shards or caching it at the edge.</li>
  <li><b>Region failure → Routing:</b> shift traffic to the next nearest region; latency rises, service continues.
    Because every region holds the full dataset, failover is a routing change rather than a data migration.
    The surviving region inherits both the traffic and a cold cache for those keys, so the shift is gradual to avoid converting a region failure into a stampede on its neighbour.
    Latency degrades for the affected users and availability holds, which is the right trade to name explicitly.</li>
</ol>

## How it works, step by step {#kv-flow}

<ol class="order">
  <li>Clients reach the nearest region; every region holds the full keyspace so no read ever crosses a region boundary.</li>
  <li>A regional cache serves ~95% of reads; soft TTLs serve stale and refresh in the background, and single‑flight collapses concurrent misses for the same key.</li>
  <li>Misses go to a local store shard chosen by consistent hashing with virtual nodes; the result is cached with a jittered TTL.</li>
  <li>Writes are accepted and acknowledged locally, versioned, and invalidate the local cache; the writer reads from the local region briefly for read‑your‑writes.</li>
  <li>Changes replicate asynchronously, applied per key in version order with last‑writer‑wins, invalidating caches in each destination region.</li>
  <li>Replication lag, hit rate and hot‑key skew are monitored as SLOs; a region loss becomes a gradual routing shift rather than an outage.</li>
</ol>

## Deep dives {#kv-deep}

<div class="cards">
  <div><h4>Why the geography decides everything</h4><ul>
    <li>A cross‑continental round trip is ~80–150 ms; a 100 ms p95 budget cannot contain even one of them.</li>
    <li>So: local reads, local write acknowledgement, asynchronous replication — the architecture is a consequence of physics, not preference.</li>
    <li>The remaining design question is the staleness budget, and it should be published as a number with a p99, not described as "eventually".</li>
    <li>Anything needing strong global consistency needs a different design and a different latency target; saying so is better than pretending.</li></ul></div>
  <div><h4>Cache stampedes and hot keys</h4><ul>
    <li>At a 95% hit rate the store is sized for a twentieth of the traffic, so a cache failure is an immediate 20× overload.</li>
    <li>Single‑flight coalescing means one miss per key reaches the store regardless of how many callers are waiting.</li>
    <li>Soft TTL plus background refresh removes the latency cliff at expiry; jitter stops keys populated together from expiring together.</li>
    <li>A hot key is a shard problem consistent hashing cannot solve — replicate it across shards or pin it at the edge.</li></ul></div>
  <div><h4>Consistent hashing, honestly</h4><ul>
    <li>Adding or removing a node moves ~1/N of keys instead of remapping the whole keyspace, which is what makes scaling and failure non‑events.</li>
    <li>Virtual nodes are required in practice: one token per node gives badly uneven shard sizes.</li>
    <li>It balances <em>keys</em>, not <em>load</em> — a single popular key still lands on one shard.</li>
    <li>Rebalancing must be rate‑limited, or growing the cluster becomes its own incident.</li></ul></div>
</div>

## Trade-offs {#kv-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Consistency model</td><td>Eventual across regions, read‑your‑writes locally</td><td>Global strong consistency</td><td>A single writer region or consensus gives strong consistency and costs a cross‑region round trip per write — incompatible with this budget</td></tr>
  <tr><td>Replication</td><td>Asynchronous</td><td>Writes acknowledged locally can be lost if a region is destroyed before propagating</td><td>Synchronous replication removes that window and puts 150 ms into every write</td></tr>
  <tr><td>Data placement</td><td>Full dataset in every region</td><td>Storage cost multiplied by region count</td><td>Partition by home region when residency demands it, accepting a cross‑region hop for users who travel</td></tr>
  <tr><td>Conflict resolution</td><td>Last‑writer‑wins on version</td><td>Silent lost updates on concurrent writes</td><td>CRDTs converge without losing data for suitable types; vector clocks preserve conflicts and hand the problem to the caller</td></tr>
  <tr><td>Cache expiry</td><td>Soft TTL with background refresh, plus jitter</td><td>Serving values slightly past their TTL</td><td>Hard expiry only is simpler and produces a latency cliff and a stampede on every popular key</td></tr>
  <tr><td>Miss handling</td><td>Single‑flight coalescing</td><td>Callers wait on another caller's fetch</td><td>Letting every miss through is simpler and turns one expiry into 12,000 simultaneous store reads</td></tr>
  <tr><td>Failover</td><td>Gradual traffic shift on region loss</td><td>A longer window where some requests still hit the failing region</td><td>Instant cutover is only safe if the surviving region has both capacity and a warm cache, which after a failure it does not</td></tr>
</tbody></table>

## Safety-first design {#kv-safety}

<div class="cards">
  <div><h4>The cache is the capacity plan</h4><ul>
    <li><b>Treat a cold cache as an incident class.</b> At a 95% hit rate the store is sized for a twentieth of the traffic, so any event that empties the cache is a 20× overload.</li>
    <li><b>Single‑flight every miss.</b> One fetch per key regardless of how many callers wait, which is what makes a popular key's expiry survivable.</li>
    <li><b>Jitter all TTLs.</b> Keys populated together must not expire together, or the design manufactures its own stampede.</li>
    <li><b>Warm before shifting traffic.</b> Failover into a cold cache converts a region failure into an overload of its neighbour.</li></ul></div>
  <div><h4>Publish the staleness, do not hide it</h4><ul>
    <li><b>A number, with a percentile.</b> "Visible in every region within 2 s, p99 10 s" is a contract; "eventually consistent" is an evasion.</li>
    <li><b>Measure lag as an SLO.</b> Replication lag is the direct measurement of that promise and deserves burn‑rate alerting.</li>
    <li><b>Invalidate on apply.</b> Replicating data without invalidating destination caches makes the published budget fictional.</li>
    <li><b>Name the lost update.</b> Last‑writer‑wins discards one of two concurrent writes, and callers who cannot tolerate that need compare‑and‑set.</li></ul></div>
  <div><h4>A region loss is a routing change</h4><ul>
    <li><b>Every region is independently complete.</b> Failover moves traffic, not data, which is what makes 99.99% achievable.</li>
    <li><b>Stale beats down.</b> With the local store unavailable, serving cache entries past their hard TTL and alarming is better than failing reads.</li>
    <li><b>Reads and writes fail independently.</b> They share almost nothing, so a write‑path outage leaves the 95% of traffic that is reads untouched.</li>
    <li><b>Residency bounds failover.</b> Where data may not leave a region, the answer is to shed rather than to route elsewhere — and that ordering belongs in routing policy, not in a runbook.</li></ul></div>
</div>

## Don't leave the room without saying {#kv-check}

<ul class="checklist">
  <li>150 ms cross‑region round trip versus a 100 ms p95 — the budget forbids any synchronous cross‑region hop</li>
  <li>Local reads, local write acknowledgement, asynchronous replication, and the staleness number that follows</li>
  <li>The cache is the capacity plan: 95% hit rate means the store is sized for a twentieth of the load</li>
  <li>Single‑flight, soft TTL with background refresh, and jitter — the three stampede defences</li>
  <li>Consistent hashing with virtual nodes balances keys, not load; hot keys need separate handling</li>
  <li>Last‑writer‑wins converges and loses updates; offer compare‑and‑set for callers who care</li>
  <li>Invalidate caches on replication apply, and monitor lag as an SLO</li>
  <li>Region failure is a gradual routing shift into a cold cache — warm it or shed</li>
</ul>

## What each level is expected to drive {#kv-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>KV store with a cache in front, replicas per region, TTL‑based expiry</td><td>Stampedes, consistent hashing, staleness</td></tr>
  <tr><td>Senior</td><td>Latency arithmetic forcing local reads, single‑flight and soft TTLs, consistent hashing with virtual nodes, async replication with versioned last‑writer‑wins, cache invalidation on apply</td><td>Hot‑key handling, read‑your‑writes, failover warming</td></tr>
  <tr><td>Staff+</td><td>A published staleness SLO with lag alerting, conflict semantics and their product consequences, cold‑cache as a first‑class incident class, residency versus failover ordering</td><td>—</td></tr>
</tbody></table>
