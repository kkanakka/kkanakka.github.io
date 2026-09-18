---
title: "Hybrid search: text + semantic top-k under 50 ms"
slug: /aire/hybrid-search
sidebar_position: 42
sidebar_label: "Hybrid search: text + semantic top-k und…"
description: "hard · Anthropic · BM25 + ANN · HNSW · fusion · 10M documents · 50 ms budget"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/hybrid-search/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

## How it works

<header>
  
  <span class="tag">hard · Anthropic · BM25 + ANN · HNSW · fusion · 10M documents · 50 ms budget</span>
</header>
<p>Find the top‑k most relevant documents among ten million by combining lexical retrieval with vector similarity, in under 50 milliseconds. The interesting parts are all consequences of that budget: approximate nearest neighbour rather than exact, two retrievers running in parallel rather than in sequence, and a fusion step that has to combine two score distributions that are not comparable.</p>

## Requirements {#hs-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Return top‑k documents for a query, combining keyword and semantic relevance</li>
      <li>Support filters (tenant, date, category) that must be honoured exactly</li>
      <li>Index new and updated documents, including re‑embedding on change</li>
      <li>Tunable balance between lexical and semantic contribution</li>
      <li class="out">Training the embedding model, cross‑encoder reranking at full corpus scale</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>10M+ documents, p95 end‑to‑end &lt; 50 ms including embedding the query</li>
      <li>Recall@10 within a few percent of exhaustive search</li>
      <li>Filters must not silently reduce recall to zero</li>
      <li>Index updates visible within minutes; rebuilds without downtime</li>
    </ol>
  </div>
</div>
<div class="note"><b>Where the 50 ms goes:</b> embed the query 5–15 ms on GPU (or ~1 ms from cache) · ANN search 5–10 ms · BM25 3–5 ms · fusion and hydration 5 ms · network and serialization 5–10 ms. There is no room for a second model call, which is why cross‑encoder reranking is out of scope unless k is tiny.</div>

## Scale, performance and safety targets {#hs-targets}

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> a few thousand queries/s. Each one runs two retrievals plus, usually, one embedding call — so the embedding tier sees the same QPS and is the most expensive component per request.</li>
    <li><b>Data volume:</b> 10M documents. At 768 dimensions in float32 that is ~30 GB of raw vectors, ~7.5 GB quantized to int8, plus an HNSW graph adding roughly 50% — so the whole index fits in memory on one large machine, which is what makes 50 ms achievable.</li>
    <li><b>Growth:</b> ~2× documents annually and embedding dimensionality creeping upward; at ~50M documents a single node stops being comfortable and the index must shard, so plan the shard boundary before it is needed.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> p50 &lt; 25 ms, p95 &lt; 50 ms, hard ceiling 100 ms. Query embedding is the largest single term, which is why caching it and batching the GPU calls matter more than tuning the ANN parameters.</li>
    <li><b>Throughput:</b> HNSW serves thousands of searches/s per node from memory; the binding constraint is the embedding tier's batch throughput, not the vector index.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the expensive shapes are very long queries (embedding cost scales with tokens), high <code>ef_search</code> values if exposed, large k, and highly selective filters that force the ANN search to scan far more of the graph than usual.</li>
    <li><b>Rate limiting:</b> per‑tenant QPS, a maximum query length before embedding, a cap on k, and server‑side‑only search parameters so a client cannot dial the cost up.</li>
    <li><b>Data sensitivity:</b> embeddings are derived from document content and can leak it — inversion attacks can reconstruct meaningful text from a vector. Treat the vector store with the same protection as the documents, enforce tenant isolation inside the search rather than after it, and delete vectors when documents are deleted.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.9%. Both retrievers are independently useful, which gives a natural degradation path that most search systems do not have.</li>
    <li><b>Degraded mode:</b> embedding tier down or slow → return BM25‑only results, flagged, rather than failing. Vector index rebuilding → serve from the previous immutable snapshot. Over budget mid‑query → return whichever retriever finished, since one good half beats a timeout.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> eventual, minutes. The subtle requirement is that a document's text and its embedding must come from the same version — a stale vector paired with fresh text produces confidently wrong semantic matches.</li>
    <li><b>Durability:</b> documents are the system of record; vectors and graph are derived, but re‑embedding 10M documents costs real GPU time, so they are checkpointed rather than casually regenerated.</li>
    <li><b>Recall:</b> state it as a target — ANN is approximate by definition, and "recall@10 within 2% of exhaustive" is a number to tune against rather than a property to assume.</li></ul></div>
</div>

## Entities and API {#hs-api}

<p>Document (id, text, fields, tenantId, version) · Embedding (docId, vector[768], modelVersion, docVersion) · ANNIndex (HNSW graph, M, efConstruction) · InvertedIndex (BM25 postings) · FusionConfig (method, weights, k) · Snapshot (immutable index version).</p>
<pre><code>POST /search  {query, k=10, filters:{tenant,date}, alpha?}  -&gt; {hits[{id, score, lexScore, vecScore}], mode}
POST /documents {id, text, fields}                           -&gt; 202 (embedded and indexed within minutes)
DELETE /documents/:id                                        -&gt; 202 (removed from both indexes)
Internal:
  POST /embed   {texts[]}                                    -&gt; vectors[]      (batched, GPU)
  ann.search(vector, k*3, efSearch, filter)                  -&gt; candidates
  bm25.search(terms, k*3, filter)                            -&gt; candidates</code></pre>

## Design {#hs-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/hybrid-search/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

### Flow between components

<ol class="order">
  <li><b>Client → Search service:</b> POST /search {query, k, filters}.
    Search parameters that control cost — <code>efSearch</code>, candidate depth, timeouts — are server‑side only; the client supplies intent, not tuning.
    A deadline is set here in absolute milliseconds and carried to every downstream call, because a 50 ms budget cannot survive independently chosen timeouts.</li>
  <li><b>Search service → Query cache:</b> seen this query + filter + model version?
    Query distributions are heavily head‑weighted, so a modest cache removes the embedding call — the single largest latency term — for a large share of traffic.
    The key includes the filter set and the embedding model version, so a model upgrade invalidates the cache automatically instead of serving vectors from two different spaces.</li>
  <li><b>Search service → Embedding tier:</b> embed(query) — batched, 5–15 ms.
    The query must be embedded by the <em>same</em> model that produced the document vectors; mixing versions produces silently meaningless similarity scores.
    Requests are micro‑batched over a few milliseconds, because GPU throughput comes from batching and a single‑query call wastes most of the device.
    This is the step to make optional under pressure: everything after it has a working fallback.</li>
  <li><b>Search service → BM25 index:</b> lexical search, k*3 candidates (parallel).
    The two retrievers run concurrently, not in sequence — running them in series would roughly double the latency for no benefit, since neither depends on the other.
    Over‑fetching k*3 gives fusion enough overlap to work with; asking each retriever for exactly k leaves nothing to combine.</li>
  <li><b>Search service → ANN index:</b> vector search, k*3 candidates (parallel).
    HNSW is a navigable small‑world graph: search starts at an entry point and greedily walks toward the query vector, examining a few hundred nodes rather than ten million.
    <code>efSearch</code> is the accuracy dial — higher means more of the graph explored, better recall and more latency — and it is exactly the knob a caller must not control.
    Exact nearest neighbour over 10M vectors is a full scan and is simply not available inside 50 ms, which is why "approximate" is a requirement rather than a compromise.</li>
  <li><b>ANN index:</b> apply filters during traversal, not after.
    Filtering after the search is the classic mistake: ask for 30 candidates, discard those failing the filter, and a selective filter leaves you with two results.
    Filtered HNSW evaluates the predicate while traversing so it keeps exploring until it has enough <em>eligible</em> candidates.
    For very selective filters the right answer flips entirely — pre‑filter to the matching set and brute‑force it, because scanning 5,000 vectors is faster than walking a graph that keeps rejecting nodes.</li>
  <li><b>BM25 index → Search service:</b> lexical candidates + scores (response).
    BM25 scores are unbounded and corpus‑dependent; they cannot be compared to cosine similarities without normalisation, which is the whole difficulty of the next step.</li>
  <li><b>ANN index → Search service:</b> vector candidates + distances (response).
    Distances are converted to similarities in a fixed range, but a cosine of 0.82 and a BM25 of 14.7 still mean nothing to each other.</li>
  <li><b>Search service:</b> fuse — reciprocal rank fusion, or normalised weighted sum.
    Reciprocal rank fusion combines by <em>rank</em> rather than score, which sidesteps the incomparability entirely and is remarkably robust with no tuning.
    A normalised weighted sum with an alpha parameter allows deliberate control of the lexical/semantic balance, but needs per‑query normalisation and is sensitive to outliers.
    RRF is the right default and the weighted sum is the right answer when the balance must be tunable per use case — saying which and why is the point of the question.</li>
  <li><b>Search service:</b> deadline exceeded → fuse whatever arrived.
    If the embedding tier is slow, the lexical results are returned alone and labelled; if BM25 is slow, semantic results stand on their own.
    Two independently useful retrievers give a degradation path that most search systems lack, and using it is better than a timeout.</li>
  <li><b>Search service → Document store:</b> hydrate top-k.
    Only k documents are fetched, from a cache in front of the store, so hydration costs a few milliseconds regardless of how many candidates were considered.
    Indexes hold ids and scores only; fetching full documents for 60 candidates and discarding 50 of them would waste most of the budget.</li>
  <li><b>Search service → Client:</b> hits with lexical and vector scores (response).
    Returning both component scores makes relevance debuggable — "why did this rank third" is answerable rather than mysterious.
    The response states which mode was used (hybrid, lexical‑only, semantic‑only) so a caller can tell a degraded answer from a full one.</li>
  <li><b>Ingest → Embedding tier:</b> embed new/changed documents (async, batched).
    Document embedding runs offline in large batches, where GPU efficiency is an order of magnitude better than the query path.
    Only changed documents are re‑embedded, keyed by document version, because re‑embedding the corpus is hours of GPU time.</li>
  <li><b>Embedding tier → ANN index:</b> insert vectors; rebuild snapshot periodically (async).
    HNSW supports incremental insertion, but deletions only mark nodes, so graph quality degrades over time and periodic rebuilds are a maintenance requirement rather than an optimisation.
    Rebuilds produce an immutable snapshot swapped in atomically, so queries never see a partially built graph.
    Text and vector must be published together — a document whose text updated but whose embedding did not will match confidently and wrongly.</li>
</ol>

## How it works, step by step {#hs-flow}

<ol class="order">
  <li>Documents are embedded in large offline batches and inserted into an HNSW graph alongside a BM25 inverted index, published as immutable snapshots.</li>
  <li>A query is checked against a cache; on a miss it is embedded by the same model version that produced the document vectors.</li>
  <li>Lexical and vector retrieval run in parallel, each returning about 3× the requested candidates, with filters applied during traversal rather than afterwards.</li>
  <li>Results are fused by reciprocal rank fusion (or a normalised weighted sum when the balance must be tunable) into a single top‑k.</li>
  <li>If either retriever misses the deadline, the other's results are returned and labelled, rather than failing the query.</li>
  <li>The top‑k are hydrated from a document cache and returned with both component scores for debuggability.</li>
</ol>

## Deep dives {#hs-deep}

<div class="cards">
  <div><h4>Why ANN, and what it costs</h4><ul>
    <li>Exact search over 10M × 768‑dimensional vectors is a full scan — tens of billions of multiply‑adds per query, far outside 50 ms.</li>
    <li>HNSW walks a layered small‑world graph, touching a few hundred nodes; <code>efSearch</code> trades recall for latency and belongs to the server.</li>
    <li>Quantizing to int8 cuts memory 4× with a small recall loss, which is what keeps the index in RAM as the corpus grows.</li>
    <li>Recall is a tuning target, not an assumption: measure recall@k against exhaustive search on a held‑out set and watch it after every rebuild.</li></ul></div>
  <div><h4>Fusing two incomparable scores</h4><ul>
    <li>BM25 is unbounded and corpus‑dependent; cosine is bounded. Adding them directly is meaningless however it is scaled.</li>
    <li>Reciprocal rank fusion uses only rank position, needs no tuning, and is hard to beat as a default.</li>
    <li>Weighted sums need per‑query normalisation (min‑max over the candidate set) and give explicit control over the lexical/semantic balance.</li>
    <li>Over‑fetch before fusing: each retriever returns ~3k candidates so the fused set has genuine overlap to work with.</li></ul></div>
  <div><h4>Filters are where hybrid search breaks</h4><ul>
    <li>Post‑filtering silently destroys recall — a 1% selective filter on 30 candidates typically leaves nothing.</li>
    <li>Filtered traversal keeps exploring until it has k eligible neighbours, at higher and more variable latency.</li>
    <li>Below a selectivity threshold, pre‑filter and brute‑force the matching subset: scanning 5,000 vectors beats walking a graph that rejects almost everything.</li>
    <li>Tenant isolation is a filter with a security consequence, so it is enforced inside retrieval rather than applied to the results.</li></ul></div>
</div>

## Trade-offs {#hs-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Vector search</td><td>Approximate (HNSW)</td><td>Exactness — a few percent of recall</td><td>Exact search is viable below ~100K vectors, or when the filter is selective enough to brute‑force the subset</td></tr>
  <tr><td>Retriever topology</td><td>Both in parallel, then fuse</td><td>Both costs are paid on every query</td><td>Cascading (lexical first, vectors only on the shortlist) halves cost and misses documents that lexical retrieval never surfaces — which is the reason to have semantic search at all</td></tr>
  <tr><td>Fusion</td><td>Reciprocal rank fusion by default</td><td>No direct control over the lexical/semantic balance</td><td>A normalised weighted sum when the balance must be tunable per tenant or use case, at the cost of normalisation sensitivity</td></tr>
  <tr><td>Filtering</td><td>During graph traversal</td><td>Higher and more variable ANN latency</td><td>Pre‑filter and brute‑force below a selectivity threshold; never post‑filter, which quietly returns near‑empty results</td></tr>
  <tr><td>Vector precision</td><td>int8 quantization</td><td>A small, measurable recall loss</td><td>Keep float32 while the index fits comfortably in memory; quantize before paging to disk, which costs far more than quantization does</td></tr>
  <tr><td>Reranking</td><td>None — no cross‑encoder in the 50 ms path</td><td>The best available ranking quality</td><td>Add one only if k is very small and the budget grows; a cross‑encoder over 50 candidates does not fit in 50 ms</td></tr>
  <tr><td>Index updates</td><td>Incremental inserts plus periodic rebuilds</td><td>Graph quality drifts between rebuilds</td><td>Rebuild‑only is cleaner and makes freshness hours rather than minutes</td></tr>
</tbody></table>

## Safety-first design {#hs-safety}

<div class="cards">
  <div><h4>Filters are a security boundary</h4><ul>
    <li><b>Tenant isolation inside retrieval.</b> A tenant filter applied after ranking is a leak waiting to happen; applied during traversal it cannot be bypassed.</li>
    <li><b>Never post‑filter.</b> Beyond the security issue, it silently returns two results where ten were asked for, and nothing in the response says so.</li>
    <li><b>Server owns the cost knobs.</b> <code>efSearch</code>, candidate depth and k are set server‑side, so no client can dial up its own expense.</li>
    <li><b>Cap query length before embedding.</b> Embedding cost scales with tokens, making a very long query a cheap way to consume GPU time.</li></ul></div>
  <div><h4>Embeddings are derived copies of your data</h4><ul>
    <li><b>Protect vectors like documents.</b> Embedding inversion can reconstruct meaningful text, so the vector store is not harmless derived data.</li>
    <li><b>Delete means delete both.</b> Removing a document must remove its vector; an orphaned embedding still matches queries and still leaks.</li>
    <li><b>Version text and vector together.</b> A stale embedding paired with updated text produces confident, wrong semantic matches that no error surfaces.</li>
    <li><b>Model version in every key.</b> Caches and stored vectors carry the model version, so an upgrade cannot silently mix two embedding spaces.</li></ul></div>
  <div><h4>Two retrievers mean a real fallback</h4><ul>
    <li><b>Lexical‑only is a valid answer.</b> If the embedding tier is down, results are still useful — and the response says which mode produced them.</li>
    <li><b>Deadline, then fuse what arrived.</b> One good half beats a timeout, and the caller is told which half it received.</li>
    <li><b>Atomic snapshot swap.</b> Rebuilds publish a complete immutable graph, so a query never traverses a half‑built index.</li>
    <li><b>Measure recall continuously.</b> Approximate search degrades quietly; without a recall metric against exhaustive search, nobody notices until relevance complaints arrive.</li></ul></div>
</div>

## Don't leave the room without saying {#hs-check}

<ul class="checklist">
  <li>Where the 50 ms actually goes — embedding is the largest term, so cache it and batch it</li>
  <li>Exact search over 10M vectors does not fit; HNSW with <code>efSearch</code> as the recall/latency dial</li>
  <li>Run both retrievers in parallel and over‑fetch ~3k candidates before fusing</li>
  <li>BM25 and cosine are not comparable; RRF by rank, or a normalised weighted sum for tunability</li>
  <li>Filter during traversal, brute‑force when selective, never post‑filter</li>
  <li>Text and embedding must share a document version; model version keys every cache</li>
  <li>Degrade to lexical‑only and say so, rather than timing out</li>
</ul>

## What each level is expected to drive {#hs-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Embed documents, store in a vector database, search by cosine, combine with keyword results</td><td>Why approximate, how to fuse scores</td></tr>
  <tr><td>Senior</td><td>Latency budget broken down, HNSW and its parameters, parallel retrieval with over‑fetch, RRF versus weighted fusion, filtered traversal</td><td>Quantization, rebuild strategy, recall measurement</td></tr>
  <tr><td>Staff+</td><td>Pre‑filter versus filtered‑traversal threshold argued with numbers, embedding lifecycle and model migration, degradation policy, privacy implications of storing embeddings</td><td>—</td></tr>
</tbody></table>
