---
title: "Distributed search at a billion documents and a million QPS"
slug: /aire/distributed-search
sidebar_position: 5
sidebar_label: "Distributed search at a billion document…"
description: "hard · Anthropic · sharded inverted index · scatter-gather · tail latency · LLM reranking at 10K rps"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/distributed-search/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">hard · Anthropic · sharded inverted index · scatter‑gather · tail latency · LLM reranking at 10K rps</span>
</header>
<p>A billion documents, a million queries per second, and an LLM in the loop for roughly 1% of them. Three systems in one question: an index that has to be sharded and replicated, a fan‑out whose latency is governed by its slowest shard, and a GPU tier three orders of magnitude smaller than the query tier that must never become the thing everyone waits for.</p>

## Requirements {#ds-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Keyword search over a billion documents with filters and pagination</li>
      <li>Rank results; optionally rerank the top‑k with an LLM</li>
      <li>Ingest new and updated documents and make them searchable</li>
      <li>Return results with a stable ordering for a given query and index version</li>
      <li class="out">Crawling the documents (see the crawler page), personalization</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>1M QPS at peak; 10K rps of those touch the LLM tier</li>
      <li>p50 &lt; 40 ms, p99 &lt; 200 ms without the LLM; p99 &lt; 800 ms with it</li>
      <li>A slow or dead shard must degrade results, never fail the query</li>
      <li>Index freshness: new documents searchable within minutes</li>
    </ol>
  </div>
</div>
<div class="note"><b>The number that shapes everything:</b> at 1M QPS a scatter‑gather across 100 shards is 100M shard requests per second. Every shard therefore has ~microseconds of budget per request, and the query's latency is the <em>maximum</em> of 100 shard latencies — so a p99 that would be fine for one shard becomes the common case for the query. Tail tolerance is the design, not an optimization.</div>

## Scale, performance and safety targets {#ds-targets}

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> 1M queries/s at peak, fanning out to ~100M shard requests/s. The LLM tier sees 10K rps — a hundredth of the traffic and by far the most expensive hundredth.</li>
    <li><b>Data volume:</b> 1B documents at ~10 KB each is ~10 TB of raw text; the inverted index is roughly 20–30% of that after compression, so ~3 TB spread across ~100 shards of ~30 GB each — small enough to hold in memory per shard, which is the point.</li>
    <li><b>Growth:</b> ~2× documents annually and faster growth in LLM‑assisted queries, so shard count and the GPU tier grow on different curves and must scale independently.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> p50 &lt; 40 ms and p99 &lt; 200 ms for keyword search; p99 &lt; 800 ms when an LLM rerank is involved. The hard ceiling is 1 s, after which the query is answered without the LLM.</li>
    <li><b>Throughput:</b> each shard replica serves ~10K queries/s from memory; the LLM tier sustains 10K rps only through batching, and its throughput — not the index — is what caps LLM‑assisted coverage.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> expensive queries are the attack. Wildcard‑heavy terms, very long queries, deep pagination and requests that force an LLM rerank all cost orders of magnitude more than a normal search, and a small number of them can consume the fleet.</li>
    <li><b>Rate limiting:</b> per‑client QPS limits, a hard cap on query length and term count, a maximum pagination depth, and a separate much tighter budget for LLM‑assisted queries — e.g. 10 req/min per user against 600 for plain search.</li>
    <li><b>Data sensitivity:</b> queries are sensitive in their own right and must not be logged with user identity beyond a short retention. Document‑level access control has to be applied <em>inside</em> the shard query, not filtered afterwards, or result counts and pagination leak the existence of documents the user cannot see.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.99% for search. Every shard has 3 replicas, so a replica loss is invisible and a whole shard loss degrades recall rather than failing the query.</li>
    <li><b>Degraded mode:</b> shard times out → return results from the shards that answered, flagged as partial. LLM tier saturated → serve the keyword ranking and skip reranking, which is a quality reduction rather than an error. Ingestion behind → search stays correct on slightly older data.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> eventual, with a stated freshness budget of minutes. Queries read an immutable index segment version, which is what makes pagination stable — a document arriving mid‑pagination must not shift page 2.</li>
    <li><b>Durability:</b> the document store is the system of record at eleven nines; the index is entirely derived and rebuildable, which is what allows aggressive segment merging and replacement.</li>
    <li><b>Compliance:</b> deletion must remove a document from the store, every index segment containing it and any cached results — and until a merge happens, a deleted document is suppressed by a tombstone rather than actually removed.</li></ul></div>
</div>

## Entities and API {#ds-api}

<p>Document (id, fields, aclIds[], version) · Shard (id, segments[], replicas[]) · Segment (immutable, postings + doc values + tombstones) · PostingList (term → docIds, positions, scores) · QueryPlan (terms, filters, k, rerank?) · IndexVersion.</p>
<pre><code>GET  /search?q=&amp;filters=&amp;k=20&amp;cursor=&amp;rerank=auto        -&gt; {hits[], nextCursor, indexVersion, partial?}
POST /documents            {id, fields, acl}              -&gt; 202 (indexed within minutes)
DELETE /documents/:id                                     -&gt; 202 (tombstone now, purged on merge)
Internal:
  POST shard:port/query    {terms, filters, k, timeoutMs} -&gt; top-k with scores   (fan-out, 1 per shard)
  POST rerank              {query, candidates[50]}        -&gt; reordered top-k     (batched, GPU tier)</code></pre>

## Design {#ds-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/distributed-search/architecture.svg" alt="Architecture — scatter-gather, tail control, optional rerank" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

### Flow between components

<ol class="order">
  <li><b>Client → Query coordinator:</b> GET /search?q=…&amp;k=20.
    The coordinator is the only stateful decision point per query: it owns the latency budget and spends it across shards, rerank and assembly.
    Budget is assigned in absolute milliseconds at the start, so every downstream call inherits a deadline rather than a timeout invented locally.</li>
  <li><b>Query coordinator:</b> parse, rewrite, plan; reject pathological queries.
    Parsing produces a plan — terms, filters, k — and this is where a query that would cost a thousand times a normal one is refused rather than admitted.
    Rewriting (stemming, synonyms, stop‑word handling) happens once here rather than on every shard, so 100 shards do identical, cheap work.
    Deep pagination is capped here too: page 5,000 of a billion results is almost always abuse, and it is the single most expensive shape a search engine can be asked for.</li>
  <li><b>Query coordinator → Shard replicas:</b> scatter query to all ~100 shards (deadline attached).
    Documents are sharded by id hash rather than by term, so every query goes to every shard — the trade that keeps indexing simple and makes fan‑out unavoidable.
    Term‑sharding would send each query to only the shards holding its terms, but makes multi‑term queries require cross‑shard intersection, which is far worse at this scale.
    Each shard is asked for its own top‑k, not for all matches, so the response is bounded regardless of how many documents match.</li>
  <li><b>Query coordinator → Shard replicas:</b> hedge: re-issue to a second replica after p95.
    A request that has already exceeded the shard's p95 is likely to be slow for a reason that will not resolve, so a duplicate is sent to another replica.
    This costs a few percent extra load and removes most of the tail, because the query takes the <em>maximum</em> of 100 shard latencies — without hedging, a 1‑in‑100 slow shard makes almost every query slow.
    Hedging is the single highest‑value technique in a scatter‑gather design and is worth naming explicitly.</li>
  <li><b>Shard replicas:</b> intersect posting lists; apply ACL filter; score; return local top-k.
    Everything is in memory: posting lists are skip‑list encoded and intersected cheapest‑term‑first so the smallest list drives the scan.
    Access control is applied as part of matching, not afterwards — filtering post‑hoc leaks the existence of restricted documents through counts and pagination.
    A heap of size k keeps memory bounded and lets the shard stop scoring once it can prove nothing further can enter the top‑k.</li>
  <li><b>Shard replicas → Query coordinator:</b> top-k + scores (response).
    Only k results per shard cross the network — 100 shards × 20 hits is 2,000 small records, not a million.
    Each response carries the segment version it answered from, which is what lets the coordinator detect an inconsistent mix.</li>
  <li><b>Query coordinator:</b> deadline hit → proceed with the shards that answered.
    Partial results are the default behaviour, not an error path: waiting for the slowest shard converts one sick machine into a fleet‑wide latency incident.
    The response is flagged partial with a coverage figure, so a caller that genuinely needs completeness can retry rather than being misled.
    Choosing "slightly worse recall" over "no answer" is the correct trade for search, and stating it is the point.</li>
  <li><b>Query coordinator:</b> merge, dedupe, global top-k.
    Merging 100 sorted lists into one global top‑k is a bounded heap merge, cheap enough to be irrelevant to the latency budget.
    Scores must be globally comparable, which means IDF and other corpus statistics are computed globally rather than per shard — per‑shard IDF makes identical documents rank differently depending on where they landed.</li>
  <li><b>Query coordinator → LLM rerank tier:</b> top-50 candidates, only if budget allows.
    Reranking is applied to a shortlist, never to the corpus: 50 candidates is affordable at 10K rps, and 1,000 would not be.
    The call is made only when enough of the latency budget remains, so an already‑slow query does not have an expensive optional step added to it.
    This admission decision is what keeps a GPU tier a hundredth the size of the query tier from becoming the bottleneck for everything.</li>
  <li><b>LLM rerank tier:</b> batch compatible requests; reject when queue depth is high.
    Batching is what makes 10K rps achievable at all — individual GPU calls would need an order of magnitude more hardware for the same throughput.
    The tier sheds rather than queues: a rejected rerank means the keyword ranking is used, which is a graceful quality reduction with no latency cost.
    Queueing instead would convert GPU saturation into a latency spike across every LLM‑assisted query, which is much worse than slightly worse ordering.</li>
  <li><b>LLM rerank tier → Query coordinator:</b> reordered top-k (response).
    Reranking changes order only; it cannot introduce documents the user is not allowed to see, because the candidate set was already ACL‑filtered at the shards.
    That ordering — filter first, rerank second — is a safety property, not just an efficiency one.</li>
  <li><b>Query coordinator → Client:</b> hits + cursor + indexVersion (+ partial flag).
    The cursor encodes the index version and the last position, so pagination is stable even while documents are being added and removed underneath.
    Returning the index version makes results reproducible and debuggable — "this query returned that" becomes answerable rather than a guess.</li>
  <li><b>Ingest → Document store:</b> upsert document (async).
    The document store is the source of truth and is written first, so the index can always be rebuilt from it after any bug or corruption.</li>
  <li><b>Document store → Indexer:</b> change stream (async).
    Indexing consumes a change log rather than being called synchronously, so a slow indexer delays freshness instead of failing writes.</li>
  <li><b>Indexer → Shard replicas:</b> build immutable segment; publish new index version (async).
    Segments are immutable and published atomically, so a query either sees a segment fully or not at all — never a half‑built one.
    Deletes are tombstones until a merge physically removes the document, which is why a deletion SLA has to be stated rather than assumed instant.
    Background merges keep segment count bounded, because query cost grows with the number of segments a shard must consult.</li>
</ol>

## How it works, step by step {#ds-flow}

<ol class="order">
  <li>Documents are written to a durable store; a change stream feeds an indexer that builds immutable segments and publishes them per shard.</li>
  <li>A query is parsed, rewritten and planned once at the coordinator, which assigns an absolute deadline and rejects pathological shapes.</li>
  <li>The query scatters to all ~100 shards, each returning only its local top‑k with globally comparable scores, with hedged requests covering slow replicas.</li>
  <li>At the deadline the coordinator merges whatever arrived into a global top‑k, flagging the response partial if some shards missed it.</li>
  <li>If enough budget remains, the top ~50 candidates go to a batched LLM rerank tier, which sheds load rather than queueing when saturated.</li>
  <li>Results return with a cursor encoding the index version, so pagination stays stable while the index changes underneath.</li>
</ol>

## Deep dives {#ds-deep}

<div class="cards">
  <div><h4>Sharding and fan-out</h4><ul>
    <li><b>Document sharding, not term sharding.</b> Every query hits every shard, which is the cost; in exchange indexing is local, rebalancing is simple, and multi‑term queries need no cross‑shard intersection.</li>
    <li><b>Replicas are for throughput and tails, not just failure.</b> Three replicas per shard let the coordinator hedge, which is what actually controls p99.</li>
    <li><b>Global statistics.</b> IDF and document counts must be corpus‑wide, or the same document scores differently depending on which shard holds it.</li>
    <li><b>Shard count is a latency decision.</b> More shards means smaller, faster shards but a wider fan‑out and a worse maximum‑of‑N tail.</li></ul></div>
  <div><h4>Tail latency at fan-out</h4><ul>
    <li>Query latency is max(shard latencies). With 100 shards, a per‑shard p99 of 100 ms means roughly 63% of queries contain at least one 100 ms shard.</li>
    <li>Hedged requests after the shard p95 cost a few percent extra load and remove most of that tail.</li>
    <li>Deadlines are absolute and propagated, so no downstream call can extend the query's total budget.</li>
    <li>Partial results with a coverage figure are better than a timeout: search degrades in quality far more gracefully than it degrades in availability.</li></ul></div>
  <div><h4>Putting an LLM behind a million QPS</h4><ul>
    <li>Rerank a shortlist, never the corpus. 50 candidates per query at 1% of traffic is 500K documents/s scored — already a large GPU fleet.</li>
    <li>Admission control by remaining budget: an optional expensive step must never be added to an already‑slow query.</li>
    <li>Shed, do not queue. A rejected rerank costs ordering quality; a queued one costs latency on every LLM‑assisted query.</li>
    <li>Cache rerank results by (query, candidate set, model version) — head queries repeat constantly and are the cheapest thing to avoid recomputing.</li></ul></div>
</div>

## Trade-offs {#ds-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Sharding scheme</td><td>By document id</td><td>Every query fans out to every shard</td><td>Term sharding sends queries to fewer shards and makes multi‑term intersection a cross‑machine problem, which is worse at a billion documents</td></tr>
  <tr><td>Tail control</td><td>Hedged requests to a second replica</td><td>A few percent of duplicated work</td><td>Skip hedging only with very few shards, where the maximum‑of‑N effect is small</td></tr>
  <tr><td>Slow shards</td><td>Partial results at the deadline</td><td>Recall — some matching documents are missing</td><td>Waiting for completeness is right for billing or legal queries, and wrong for search, where an answer beats a perfect answer</td></tr>
  <tr><td>LLM reranking</td><td>Top‑50 shortlist, budget‑gated, shed under load</td><td>Ranking quality on queries that miss the budget</td><td>Rerank more candidates when the GPU tier is over‑provisioned; never make it mandatory, or it becomes the availability of search</td></tr>
  <tr><td>Index updates</td><td>Immutable segments plus tombstones</td><td>Deleted documents persist until a merge</td><td>In‑place mutation gives instant deletes and makes concurrent reads and pagination stability far harder</td></tr>
  <tr><td>Access control</td><td>Applied inside the shard query</td><td>More complex matching, and ACLs indexed alongside documents</td><td>Filtering after ranking is simpler and leaks the existence of restricted documents through counts and pagination</td></tr>
  <tr><td>Pagination</td><td>Cursor pinned to an index version</td><td>Cursors expire when their segments are merged away</td><td>Offset pagination is trivial and degrades badly with depth while shifting under concurrent writes</td></tr>
</tbody></table>

## Safety-first design {#ds-safety}

<div class="cards">
  <div><h4>Expensive queries are the attack surface</h4><ul>
    <li><b>Reject at the planner.</b> Query length, term count, wildcard use and pagination depth are capped before a single shard is contacted.</li>
    <li><b>Separate budget for LLM work.</b> A much tighter per‑user limit on reranked queries, because they cost orders of magnitude more than a keyword search.</li>
    <li><b>Absolute deadlines everywhere.</b> No downstream call can extend the query's budget, so one slow component cannot hold resources open fleet‑wide.</li>
    <li><b>Bounded work per shard.</b> Top‑k heaps and early termination mean a term matching a hundred million documents costs the same as one matching a thousand.</li></ul></div>
  <div><h4>Never leak a document through metadata</h4><ul>
    <li><b>Filter during matching.</b> ACLs are part of the shard query, so restricted documents never enter scoring, counts or pagination.</li>
    <li><b>Rerank cannot add documents.</b> The shortlist is already filtered, so the LLM can only reorder what the user was allowed to see.</li>
    <li><b>Counts are filtered too.</b> "About 4,000 results" computed before ACLs is itself a disclosure.</li>
    <li><b>Deletion has a stated SLA.</b> Tombstones suppress immediately; physical removal follows a merge, and saying so is more honest than claiming instant deletion.</li></ul></div>
  <div><h4>Degrade in quality, not availability</h4><ul>
    <li><b>Partial results are normal.</b> A missing shard reduces recall and is reported, rather than failing the query.</li>
    <li><b>LLM is always optional.</b> Every query has a complete answer without it, so the GPU tier can fail entirely without taking search down.</li>
    <li><b>The index is rebuildable.</b> The document store is the record, so a corrupt segment is a reindex rather than data loss.</li>
    <li><b>Stable pagination under change.</b> Pinning to an index version stops documents from appearing twice or vanishing between pages as the corpus shifts.</li></ul></div>
</div>

## Don't leave the room without saying {#ds-check}

<ul class="checklist">
  <li>Query latency is max(shard latencies) — the fan‑out tail, not the average, is the problem</li>
  <li>Hedged requests after p95, and absolute deadlines propagated to every hop</li>
  <li>Document sharding with per‑shard top‑k, and global IDF so scores are comparable</li>
  <li>Partial results with a coverage flag beat waiting for a sick shard</li>
  <li>LLM reranks a shortlist, is budget‑gated, and sheds rather than queues</li>
  <li>ACLs applied inside matching, never as a post‑filter</li>
  <li>Immutable segments, tombstones, merges, and cursors pinned to an index version</li>
</ul>

## What each level is expected to drive {#ds-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Inverted index, shard and replicate, scatter‑gather, cache popular queries</td><td>Tail latency, hedging, partial results</td></tr>
  <tr><td>Senior</td><td>Fan‑out tail math, hedged requests, deadlines, per‑shard top‑k with global IDF, immutable segments, LLM as an optional shortlist rerank</td><td>ACL‑aware matching, cursor stability, merge policy</td></tr>
  <tr><td>Staff+</td><td>Capacity model for the GPU tier against 1% of 1M QPS, shard‑count versus tail trade‑off argued with numbers, degradation policy and its product consequences, deletion and compliance SLAs</td><td>—</td></tr>
</tbody></table>
