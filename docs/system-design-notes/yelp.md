---
title: "Yelp (local business search + reviews)"
slug: /system-design-notes/yelp
sidebar_position: 10
sidebar_label: "Yelp (local business search + reviews)"
description: "medium · scaling reads · geospatial index · optimistic locking · \"keep it simple\" is the senior signal"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/yelp/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">medium · scaling reads · geospatial index · optimistic locking · "keep it simple" is the senior signal</span>
</header>
<p>Search businesses by term, location, category; view a business and its reviews; leave a review. Reads outnumber writes ~1000:1 and the whole dataset fits on one box, so the interview rewards the candidate who says "this is small" and spends the time on search.</p>

## Requirements {#yp-requirements}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Search by name/term, lat‑long, category</li>
      <li>View a business and its reviews</li>
      <li>Leave a review: 1–5 stars required, text optional</li>
      <li class="out">Admin CRUD, map view, recommendations</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Search &lt; 500 ms</li>
      <li>Availability &gt;&gt; consistency (eventual is fine)</li>
      <li>100M DAU, 10M businesses</li>
      <li>Constraint (senior+): one review per user per business</li>
      <li class="out">GDPR, fault tolerance, spam</li>
    </ol>
  </div>
</div>
<div class="note"><b>Size it early:</b> 10M businesses × ~100 reviews × ~1 KB ≈ 1 TB. 100M DAU at 1000:1 → ~100K reviews/day ≈ 1 write/s. One Postgres with replicas handles both; no sharding, no queue.</div>


## Scale, performance and safety targets {#yp-targets}

<p>The senior signal in this question is recognising how small the data actually is. Do the arithmetic out loud — it is what licenses a simple design and frees the time for search.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> 100M DAU doing a few searches each ≈ 10K–20K QPS of reads at peak, against perhaps 10–50 review writes/s. A 1000:1 ratio, and the writes are trivial in absolute terms.</li>
    <li><b>Data volume:</b> 10M businesses at ~1 KB ≈ 10 GB, plus maybe 100M reviews at ~1 KB ≈ 100 GB. The entire dataset fits on a single machine, and the business table fits in RAM.</li>
    <li><b>Growth:</b> businesses grow slowly — a few percent a year — while reviews grow steadily. Nothing here needs sharding for years, and saying so is more valuable than designing a shard key nobody needs.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> search p95 &lt; 500 ms, p99 &lt; 1 s; business page p95 &lt; 200 ms; review submission p95 &lt; 300 ms. Index freshness after an edit within ~10 s.</li>
    <li><b>Throughput:</b> a single Postgres primary with read replicas covers all of it comfortably. The search index exists for geospatial and full‑text query shape, not because the data is too big.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> review platforms are attacked through content, not load — fake positive reviews from business owners, review bombing by competitors, sockpuppet accounts, and scraping of the whole business corpus.</li>
    <li><b>Rate limiting:</b> one review per user per business enforced in the schema, reviews per user per day, per‑IP search limits to blunt scraping, and velocity checks on a business suddenly receiving an unusual burst of reviews.</li>
    <li><b>Data sensitivity:</b> reviews are public and attributable, which makes them a harassment surface. Store the author identity, allow deletion, do not expose precise user location in search requests, and keep moderation decisions auditable.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.9%, availability well ahead of consistency. A review appearing a few seconds late is invisible; search failing is the product being down.</li>
    <li><b>Degraded mode:</b> search index unavailable → fall back to database queries by category and bounding box, slower but correct. Replica lag → a user may not immediately see their own review, so read their own writes from the primary. Write path degraded → reads continue entirely unaffected, since they share almost nothing.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> eventual for search results and average ratings; <b>strong for the one‑review‑per‑user constraint</b>, which is a unique key rather than an application check. The running average uses optimistic concurrency — update where the count still matches, retry on zero rows.</li>
    <li><b>Durability:</b> reviews are user‑generated content that cannot be recreated, so they get full durability; the search index is entirely rebuildable from Postgres.</li>
    <li><b>Simplicity:</b> worth stating as an explicit target. The dataset fits on one box, so the correct answer is one relational database plus one index — and recognising that is the thing being assessed.</li></ul></div>
</div>

## Entities and API {#yp-entities}

<p>Business (id, name, description, lat/long, address, category, avgRating, numRatings, locationNames[]) · User · Review (userId, businessId, rating, text) · Location (name, type, polygon).</p>
<pre><code>GET  /businesses?query&amp;location&amp;category&amp;page      -&gt; Business[] (partial: name, rating, category, distance)
GET  /businesses/:id                               -&gt; Business
GET  /businesses/:id/reviews?page=                 -&gt; Review[]
POST /businesses/:id/reviews  {rating, text?}      -&gt; Review   (userId from JWT)</code></pre>

## Final design {#yp-diagram}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/yelp/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 380" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Yelp architecture: gateway to Business Service (search, view) and Review Service (write); Postgres with Business, Reviews, Locations tables; Elasticsearch fed by CDC with geo, full-text and category indexes; review writes synchronously update avgRating with a conditional update">
  <defs><marker id="y1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="y2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:13px;fill:#1B2430;font-weight:600}.ts{font-size:11px;fill:#5B6673}.tm{font-size:11px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#y1)}.fw{stroke:#B45309;stroke-width:1.6;fill:none;marker-end:url(#y2)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#y2);stroke-dasharray:2 4}.lbl{font-size:11px;fill:#1F4E9E}.lblw{font-size:11px;fill:#B45309}</style>
  <rect class="box" x="20" y="160" width="90" height="50"></rect><text class="tb" x="65" y="189" text-anchor="middle">Client</text>
  <rect class="box" x="140" y="160" width="110" height="50"></rect><text class="tb" x="195" y="181" text-anchor="middle">API Gateway</text><text class="ts" x="195" y="198" text-anchor="middle">auth · rate limit</text>
  <rect class="box" x="310" y="60" width="160" height="80"></rect><text class="tb" x="390" y="82" text-anchor="middle">Business Service</text><text class="ts" x="390" y="100" text-anchor="middle">search(term, loc, cat)</text><text class="ts" x="390" y="114" text-anchor="middle">view(id)</text><text class="ts" x="390" y="130" text-anchor="middle">read‑heavy, scale wide</text>
  <rect class="box" x="310" y="240" width="160" height="80" stroke="#B45309"></rect><text class="tb" x="390" y="262" text-anchor="middle">Review Service</text><text class="ts" x="390" y="280" text-anchor="middle">insert review +</text><text class="ts" x="390" y="294" text-anchor="middle">conditional avg update</text><text class="ts" x="390" y="310" text-anchor="middle">~1 write/s</text>
  <rect class="box" x="540" y="180" width="220" height="150"></rect><text class="tb" x="550" y="200">Postgres (+ read replicas)</text>
  <text class="tm" x="550" y="218">Business: …, avgRating,</text><text class="tm" x="550" y="232">  numRatings, locationNames[]</text>
  <text class="tm" x="550" y="250">Reviews: UNIQUE(userId,</text><text class="tm" x="550" y="264">  businessId), rating, text</text>
  <text class="tm" x="550" y="282">Locations: name, type,</text><text class="tm" x="550" y="296">  polygon (PostGIS)</text>
  <text class="ts" x="550" y="318">~1 TB, one primary</text>
  <rect class="box" x="540" y="40" width="220" height="100" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="650" y="60" text-anchor="middle">Elasticsearch</text><text class="ts" x="550" y="80">geo_point index (lat/long)</text><text class="ts" x="550" y="94">inverted index: name, description</text><text class="ts" x="550" y="108">keyword: category, location_names</text><text class="ts" x="550" y="126">read replica of the truth</text>
  <rect class="box" x="800" y="120" width="120" height="50" stroke="#B45309"></rect><text class="tb" x="860" y="141" text-anchor="middle">CDC</text><text class="ts" x="860" y="158" text-anchor="middle">Debezium/Kafka</text>
  <path class="f" d="M110 185 L138 185"></path>
  <path class="f" d="M250 175 L308 110"></path><text class="lbl" x="250" y="130">GET</text>
  <path class="fw" d="M250 195 L308 270"></path><text class="lblw" x="252" y="250">POST review</text>
  <path class="f" d="M470 90 L538 90"></path><text class="lbl" x="478" y="82">search</text>
  <path class="f" d="M470 120 L538 200"></path><text class="lbl" x="478" y="170">view by id</text>
  <path class="fw" d="M470 275 L538 260"></path><text class="lblw" x="480" y="256">txn</text>
  <path class="fa" d="M760 255 C 790 255, 830 220, 850 172"></path><text class="lblw" x="790" y="240">WAL</text>
  <path class="fa" d="M820 120 C 800 90, 780 80, 762 80"></path><text class="lblw" x="775" y="70">index</text>
  <text class="ts" x="20" y="365">Search hits Elasticsearch; view and write hit Postgres. ES lags by seconds, which "eventual consistency is fine" allows.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 712" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Yelp search, view and review flow between components">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="7" y="14" width="126" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Client</text>
<line class="ln" x1="70" y1="48" x2="70" y2="692"></line>
<rect class="sb" x="147" y="14" width="126" height="34"></rect><text class="st" x="210" y="36" text-anchor="middle">API Gateway</text>
<line class="ln" x1="210" y1="48" x2="210" y2="692"></line>
<rect class="sb" x="287" y="14" width="126" height="34"></rect><text class="st" x="350" y="36" text-anchor="middle">Business Service</text>
<line class="ln" x1="350" y1="48" x2="350" y2="692"></line>
<rect class="sb" x="427" y="14" width="126" height="34"></rect><text class="st" x="490" y="36" text-anchor="middle">Elasticsearch</text>
<line class="ln" x1="490" y1="48" x2="490" y2="692"></line>
<rect class="sb" x="567" y="14" width="126" height="34"></rect><text class="st" x="630" y="36" text-anchor="middle">Postgres</text>
<line class="ln" x1="630" y1="48" x2="630" y2="692"></line>
<rect class="sb" x="707" y="14" width="126" height="34"></rect><text class="st" x="770" y="36" text-anchor="middle">Review Service</text>
<line class="ln" x1="770" y1="48" x2="770" y2="692"></line>
<rect class="sb" x="847" y="14" width="126" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">CDC</text>
<line class="ln" x1="910" y1="48" x2="910" y2="692"></line>
<line class="a1" x1="78" y1="80" x2="202" y2="80"></line>
<text class="sl" x="140" y="74" text-anchor="middle">GET /businesses?query&amp;location&amp;category</text>
<line class="a1" x1="218" y1="114" x2="342" y2="114"></line>
<text class="sl" x="280" y="108" text-anchor="middle">route</text>
<rect class="nt" x="261" y="135" width="177" height="22"></rect><text class="sl" x="350" y="150" text-anchor="middle">name → location_names slug</text>
<line class="a1" x1="358" y1="182" x2="482" y2="182"></line>
<text class="sl" x="420" y="176" text-anchor="middle">geo/keyword + text query</text>
<line class="a2" x1="482" y1="216" x2="358" y2="216"></line>
<text class="sl" x="420" y="210" text-anchor="middle">ranked ids + partials</text>
<line class="a2" x1="342" y1="250" x2="78" y2="250"></line>
<text class="sl" x="210" y="244" text-anchor="middle">results with avgRating</text>
<line class="a1" x1="78" y1="284" x2="202" y2="284"></line>
<text class="sl" x="140" y="278" text-anchor="middle">GET /businesses/:id</text>
<line class="a1" x1="218" y1="318" x2="342" y2="318"></line>
<text class="sl" x="280" y="312" text-anchor="middle">route</text>
<line class="a1" x1="358" y1="352" x2="622" y2="352"></line>
<text class="sl" x="490" y="346" text-anchor="middle">SELECT business + reviews (replica)</text>
<line class="a2" x1="622" y1="386" x2="358" y2="386"></line>
<text class="sl" x="490" y="380" text-anchor="middle">rows</text>
<line class="a2" x1="342" y1="420" x2="78" y2="420"></line>
<text class="sl" x="210" y="414" text-anchor="middle">business page</text>
<line class="a1" x1="78" y1="454" x2="202" y2="454"></line>
<text class="sl" x="140" y="448" text-anchor="middle">POST /businesses/:id/reviews</text>
<line class="a1" x1="218" y1="488" x2="762" y2="488"></line>
<text class="sl" x="490" y="482" text-anchor="middle">route</text>
<line class="a1" x1="762" y1="522" x2="638" y2="522"></line>
<text class="sl" x="700" y="516" text-anchor="middle">BEGIN; INSERT review; UPDATE avg WHERE num_ratings=:n; COMMIT</text>
<line class="a2" x1="638" y1="556" x2="762" y2="556"></line>
<text class="sl" x="700" y="550" text-anchor="middle">ok | 409 duplicate | 0 rows → retry</text>
<line class="a2" x1="762" y1="590" x2="78" y2="590"></line>
<text class="sl" x="420" y="584" text-anchor="middle">review created</text>
<line class="a3" x1="638" y1="624" x2="902" y2="624"></line>
<text class="sl" x="770" y="618" text-anchor="middle">WAL change</text>
<line class="a3" x1="902" y1="658" x2="498" y2="658"></line>
<text class="sl" x="700" y="652" text-anchor="middle">index business doc</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Client → API Gateway:</b> GET /businesses?query&amp;location&amp;category.
    Search is the dominant operation by three orders of magnitude, so it gets the design attention and the latency budget.
    Three filter dimensions — text, geography and category — is what makes a plain relational query awkward and an index worth having.</li>
  <li><b>API Gateway → Business Service:</b> route.
    Read and write paths are separated so the review path can be transactional and careful while the search path is cached and fast.</li>
  <li><b>Business Service:</b> name → location_names slug.
    Human place names are normalised to canonical identifiers before querying, so "SF", "San Francisco" and "san francisco" all resolve to one thing.
    Doing this before the index rather than inside it keeps the index simple and the normalisation testable on its own.</li>
  <li><b>Business Service → Elasticsearch:</b> geo/keyword + text query.
    One query combines a geospatial filter, category keywords and full‑text matching — the combination is the reason for a search engine, not the data volume.
    Geospatial indexing (geohash or R‑tree) is what makes "within 5 km" a bounded lookup instead of a distance calculation over 10M rows.
    Precomputed average rating lives on the document so results can be ranked and displayed without a second lookup.</li>
  <li><b>Elasticsearch → Business Service:</b> ranked ids + partials (response).
    Enough fields are returned to render a result card directly, so the common path needs no round trip back to Postgres.
    The index is eventually consistent and explicitly not the source of truth — an edit that has not propagated yet shows stale text, which is acceptable here in a way that stale permissions would not be.</li>
  <li><b>Business Service → Client:</b> results with avgRating (response).
    The average comes from a maintained column rather than an aggregate over reviews — computing <code>AVG()</code> per result would make every search a fan‑out over the review table.</li>
  <li><b>Client → API Gateway:</b> GET /businesses/:id.
    The detail page is a simple keyed read, and it is the second most common operation after search.</li>
  <li><b>API Gateway → Business Service:</b> route.
    Same service, different query shape; there is no reason to split further at this size.</li>
  <li><b>Business Service → Postgres:</b> SELECT business + reviews (replica).
    Replicas absorb the read traffic; a few seconds of replication lag is invisible for a business page.
    Reviews are paginated by cursor, because a popular business can have tens of thousands.</li>
  <li><b>Postgres → Business Service:</b> rows (response).
    Postgres is the source of truth for everything; the index is derived and rebuildable, which is what makes the eventual consistency above safe.</li>
  <li><b>Business Service → Client:</b> business page (response).
    Cached briefly with a short TTL, since business details change rarely and the page is requested constantly.</li>
  <li><b>Client → API Gateway:</b> POST /businesses/:id/reviews.
    The write path is rare — tens per second — which is exactly why it can afford to be strict and transactional.</li>
  <li><b>API Gateway → Review Service:</b> route.
    A separate service for writes keeps the transactional logic in one place and keeps it off the read path entirely.</li>
  <li><b>Review Service → Postgres:</b> BEGIN; INSERT review; UPDATE avg WHERE num_ratings=:n; COMMIT.
    Two things happen in one transaction: the review is inserted, and the running average is updated with an optimistic check on the count.
    The <code>WHERE num_ratings = :n</code> clause is the optimistic lock — if another review landed concurrently, zero rows update and the transaction retries with fresh values.
    Pessimistic locking would serialise every review for a popular business; optimistic concurrency costs a rare retry instead, which is the right trade when conflicts are uncommon.</li>
  <li><b>Postgres → Review Service:</b> ok | 409 duplicate | 0 rows → retry (response).
    The one‑review‑per‑user rule is a unique constraint on (user, business), not an application check — a check‑then‑insert has a race that a database constraint simply does not.
    Three distinct outcomes get three distinct handlings: success, a genuine duplicate the user should be told about, and a concurrency conflict the server retries silently.
    Maintaining a running average rather than recomputing it is what keeps this write cheap and the read path free of aggregation.</li>
  <li><b>Review Service → Client:</b> review created (response).
    The author is served from the primary for a short window afterwards, so they see their own review immediately rather than waiting on replica lag.
    Index update happens asynchronously, so the new average appears in search within seconds — which is well inside what anyone notices.</li>
</ol>
<div class="note"><b>Service split rule:</b> split when functionality is unrelated or the read/write patterns differ enough to need independent scaling. Search and view are both read‑heavy → one Business Service. Reviews are rare writes → separate Review Service. Same database for both is fine at this size; "one DB per microservice" is a preference, not a law.</div>

## Deep dives {#yp-deepdives}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/yelp/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

### 1. Average rating in search results

<table>
  <tbody><tr><th>Option</th><th>How</th><th>Verdict</th></tr>
  <tr><td>Compute on read</td><td><code>AVG(rating)</code> per business per search</td><td>No. Aggregation on every query.</td></tr>
  <tr><td>Cron precompute</td><td>Hourly/daily job writes <code>avgRating</code></td><td>Cheap, but a new 5‑star on a 3‑review business doesn't show for hours.</td></tr>
  <tr><td><b>Synchronous incremental update</b></td><td>Store <code>avgRating, numRatings</code>; new = (avg × n + r) / (n + 1) in the same transaction as the insert</td><td>Yes. A few CPU cycles, real‑time, and the write rate is ~1/s.</td></tr>
</tbody></table>
<p><b>The race:</b> two reviewers read n=100, avg=4.0; both compute against 100; the second write overwrites the first and one rating is lost. Fix with <b>optimistic locking</b>, using <code>numRatings</code> itself as the version:</p>
<pre><code>BEGIN;
INSERT INTO reviews(user_id, business_id, rating, text) VALUES (...);
UPDATE businesses
   SET avg_rating  = (avg_rating * num_ratings + :r) / (num_ratings + 1),
       num_ratings = num_ratings + 1
 WHERE id = :b AND num_ratings = :n_read;      -- 0 rows → re-read and retry
COMMIT;</code></pre>
<p>Even simpler: do the arithmetic inside the UPDATE (as above) so the read and write are one statement under the row lock, and the version check becomes belt‑and‑braces. Either way, no queue.</p>
<div class="trap"><b>Don't reach for a message queue.</b> Senior candidates propose "reviews → Kafka → consumer updates the average." At 1 write/s that's complexity with no benefit. Saying "the write volume is tiny, a synchronous transaction is enough, here's when I <em>would</em> add a queue" is the staff signal in this question.</div>

### 2. One review per user per business

<table>
  <tbody><tr><th>Option</th><th>Where</th><th>Verdict</th></tr>
  <tr><td>Check in the service</td><td>SELECT then INSERT</td><td>Race between check and insert; two requests both pass.</td></tr>
  <tr><td>Redis / distributed lock per (user, business)</td><td>Lock, check, insert, unlock</td><td>Works but adds a component to protect a 1/s write path.</td></tr>
  <tr><td><b>Database constraint</b></td><td><code>UNIQUE (user_id, business_id)</code> on reviews</td><td>Yes. Enforce constraints as close to persistence as possible; the DB rejects the duplicate atomically, service maps the error to 409.</td></tr>
</tbody></table>

### 3. Search: the crux

<p>The naive query is a full table scan on two fronts: range predicates on lat/long with no spatial index, and <code>name LIKE '%coffee%'</code> with no text index.</p>
<table>
  <tbody><tr><th>Option</th><th>Geo</th><th>Text</th><th>Verdict</th></tr>
  <tr><td>Plain Postgres B‑tree</td><td>Two range scans, can't combine well</td><td>LIKE = scan</td><td>Too slow at 10M rows.</td></tr>
  <tr><td>Postgres + PostGIS + GIN</td><td>GiST spatial index (R‑tree), <code>ST_DWithin</code>, polygons via <code>ST_Contains</code></td><td>GIN full‑text index</td><td>Strong pick: one system, no sync lag, no consistency issues. Staff candidates lead with this.</td></tr>
  <tr><td>Elasticsearch via CDC</td><td><code>geo_point</code> / <code>geo_shape</code> queries</td><td>Inverted index, fuzzy, relevance scoring</td><td>Best search features; adds a system and seconds of lag. Fine because eventual consistency is allowed.</td></tr>
</tbody></table>
<p><b>If the interviewer bans Elasticsearch</b>, they want three things:</p>
<ul>
  <li><b>Geospatial index choice.</b> Geohash: encode lat/long into a prefix string, index it, query by prefix; simple, uniform grid, bad at boundaries and dense areas. Quadtree: recursively split cells until each holds ≤ k businesses; adapts to density (NYC vs. Nevada), cheap to hold in memory since updates are rare. Prefer quadtree here; mention R‑tree (what PostGIS uses) if you know it.</li>
  <li><b>Second‑pass filter.</b> The index returns a cell/box; compute exact distance with the Haversine formula and drop anything outside the radius.</li>
  <li><b>Phase ordering.</b> Apply the most selective filter first, which is almost always distance, then category and text on the small remaining set.</li>
</ul>

### 4. Search by place name ("pizza in the Mission")

<p>Asked of staff candidates, or seniors who moved fast and clean. The design so far takes a lat/long; users type "NYC" or "The Mission". Neighborhoods aren't circles, so a radius from a center point is the wrong model. You need polygons.</p>
<ol class="order">
  <li><b>Name → polygon.</b> A <code>locations</code> table: <code>name</code>, <code>type</code> (city, neighborhood, zip, state), <code>polygon</code> (GeoJSON, a list of lat/long points, from public datasets like Geoapify or OpenStreetMap). B‑tree or trigram index on <code>name</code> for lookup and autocomplete.</li>
  <li><b>Polygon → businesses.</b> PostGIS <code>ST_Contains(polygon, point)</code> with a GiST index, or Elasticsearch <code>geo_shape</code> / <code>geo_bounding_box</code>:
<pre><code>{ "query": { "geo_bounding_box": { "location": {
      "top_left":     { "lat": 42, "lon": -74 },
      "bottom_right": { "lat": 40, "lon": -72 } } } } }</code></pre>
  Correct, but a geometry computation on every search.</li>
  <li><b>Precompute at write time instead.</b> When a business is created or moves, run point‑in‑polygon once against all locations and store the containing names on the document:
<pre><code>{ "id": "123", "name": "Pizza Place", "category": "restaurant",
  "location_names": ["bay_area", "san_francisco", "mission_district"] }</code></pre>
  Index <code>location_names</code> as an ES <code>keyword</code> field (or a Postgres array with a GIN index). "Pizza in the Mission" becomes a term filter <code>location_names: mission_district</code> AND text match on "pizza": pure inverted‑index lookups, no geometry per query. The expensive step runs once per business, and businesses change rarely.</li>
</ol>
<div class="note"><b>Trade‑off to say:</b> precomputed names are stale if a polygon is redrawn; re‑run the tagging job for affected businesses. Nested areas (neighborhood ⊂ city ⊂ metro) fall out naturally because a point is in all of them.</div>

### How the client supplies location (what the browser actually sends)

<figure>
<svg viewBox="0 0 980 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three location sources from the client: browser geolocation API gives lat/long; IP geolocation fallback gives coarse lat/long; typed place name resolved by locations table to a polygon or precomputed name filter">
  <defs><marker id="z1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker></defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:11px;fill:#5B6673}.tm{font-size:11px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#z1)}.lbl{font-size:11px;fill:#1F4E9E}</style>
  <rect class="box" x="20" y="20" width="200" height="50"></rect><text class="tb" x="120" y="40" text-anchor="middle">Browser Geolocation API</text><text class="tm" x="120" y="58" text-anchor="middle">navigator.geolocation → lat,lng</text>
  <rect class="box" x="20" y="80" width="200" height="50"></rect><text class="tb" x="120" y="100" text-anchor="middle">IP geolocation (fallback)</text><text class="ts" x="120" y="118" text-anchor="middle">gateway looks up client IP → city‑level</text>
  <rect class="box" x="20" y="140" width="200" height="50"></rect><text class="tb" x="120" y="160" text-anchor="middle">Typed place name</text><text class="ts" x="120" y="178" text-anchor="middle">"The Mission", "NYC" (autocomplete)</text>
  <rect class="box" x="330" y="50" width="170" height="60"></rect><text class="tb" x="415" y="72" text-anchor="middle">GET /businesses</text><text class="tm" x="415" y="90" text-anchor="middle">?lat&amp;lng&amp;radius | ?location=</text>
  <rect class="box" x="600" y="20" width="170" height="50"></rect><text class="tb" x="685" y="40" text-anchor="middle">Geo query</text><text class="ts" x="685" y="58" text-anchor="middle">geo_distance / ST_DWithin</text>
  <rect class="box" x="600" y="120" width="170" height="60"></rect><text class="tb" x="685" y="140" text-anchor="middle">Locations lookup</text><text class="ts" x="685" y="156" text-anchor="middle">name → slug/polygon</text><text class="ts" x="685" y="172" text-anchor="middle">→ term filter location_names</text>
  <rect class="box" x="830" y="70" width="130" height="60" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="895" y="92" text-anchor="middle">Search index</text><text class="ts" x="895" y="110" text-anchor="middle">+ text + category</text>
  <path class="f" d="M220 45 L328 70"></path><path class="f" d="M220 105 L328 85"></path><path class="f" d="M220 165 L328 100"></path>
  <path class="f" d="M500 70 L598 48"></path><text class="lbl" x="510" y="52">lat/lng</text>
  <path class="f" d="M500 95 L598 145"></path><text class="lbl" x="510" y="130">name</text>
  <path class="f" d="M770 45 L828 90"></path><path class="f" d="M770 150 L828 110"></path>
</svg>
</figure>
<ul>
  <li><b>Precise:</b> <code>navigator.geolocation.getCurrentPosition()</code> asks the user for permission and returns lat/long (GPS on mobile, Wi‑Fi/cell on laptops). Client sends <code>?lat=37.76&amp;lng=-122.42&amp;radius=2000</code>. Requires HTTPS.</li>
  <li><b>Coarse fallback:</b> if permission is denied, the gateway resolves the client IP through a GeoIP database (MaxMind) to city‑level coordinates and injects them as the default location. Good enough for "restaurants near me" on first load.</li>
  <li><b>Explicit:</b> user types a place. Autocomplete hits the <code>locations</code> table by name prefix; the client sends <code>?location=mission_district</code> (the slug), and the service applies the precomputed <code>location_names</code> filter. If the user typed an address instead, geocode it (address → lat/long) and fall back to the radius path.</li>
  <li><b>Never trust it blindly:</b> lat/long from the client is an input like any other; validate ranges and cap the radius so a client can't request a full‑table scan.</li>
  <li>Sort by distance in the response using the user's point (Haversine) even when the filter was a polygon; the polygon says "inside the Mission", distance says "closest first".</li>
</ul>

### 5. Scale (short, because it's small)

<ul>
  <li>Business Service horizontally scaled; Postgres primary + read replicas; Redis cache for hot business pages and popular searches (TTL minutes; a stale rating by a minute is fine).</li>
  <li>ES cluster with a few shards and replicas for search throughput.</li>
  <li>No sharding of Postgres: 1 TB and 1 write/s don't justify it. Say so.</li>
</ul>


## Trade-offs {#yp-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Overall architecture</td><td>One Postgres plus one search index</td><td>The appearance of scale — no sharding, no exotic stores</td><td>The data is 110 GB; proposing a distributed architecture here signals you did not do the arithmetic, which is the actual test</td></tr>
  <tr><td>Average rating</td><td>Maintained column updated in the write transaction</td><td>A column that can drift if a write path bypasses it</td><td>Computing <code>AVG()</code> per query is always correct and turns every search into an aggregation over the review table</td></tr>
  <tr><td>Concurrency</td><td>Optimistic: update where the count matches, retry on conflict</td><td>Occasional retries under a burst of reviews</td><td>Pessimistic locking serialises every review for a popular business; a separate counter table trades accuracy for throughput</td></tr>
  <tr><td>One review per user</td><td>Unique constraint in the schema</td><td>A 409 the application must translate into a sensible message</td><td>An application‑level check has a race condition that a constraint does not — never rely on check‑then‑insert</td></tr>
  <tr><td>Search</td><td>Elasticsearch fed asynchronously from Postgres</td><td>A second system, and results that lag by seconds</td><td>PostGIS plus full‑text search in Postgres is entirely viable at this size and removes a component — worth naming as the simpler option</td></tr>
  <tr><td>Consistency</td><td>Eventual for search and ratings</td><td>A new review is briefly absent from search results</td><td>Synchronous index updates would put an external system inside the write transaction, which is a much worse failure mode</td></tr>
  <tr><td>Read‑your‑writes</td><td>Pin the author to the primary briefly</td><td>A little extra primary load</td><td>Serving the author from a replica means they may not see their own review, which reads as a bug every time</td></tr>
</tbody></table>

## Safety-first design {#yp-safety}

<div class="cards">
  <div><h4>Let the database enforce the rules</h4><ul>
    <li><b>Unique constraint, not an application check.</b> One review per user per business is a schema guarantee; check‑then‑insert has a race that will eventually be exploited or hit by accident.</li>
    <li><b>Optimistic locking on the aggregate.</b> Updating where the count still matches means concurrent reviews cannot silently produce a wrong average.</li>
    <li><b>One transaction for both writes.</b> The review and the rating update commit together, so the average can never reflect a review that does not exist.</li>
    <li><b>Handle all three outcomes.</b> Success, duplicate and conflict are different things and conflating them produces either lost reviews or confusing errors.</li></ul></div>
  <div><h4>The attack is content, not load</h4><ul>
    <li><b>Velocity checks per business.</b> A sudden burst of reviews on one business is the signature of both astroturfing and review bombing.</li>
    <li><b>Account age and history matter.</b> Weighting or holding reviews from brand‑new accounts is the cheapest effective defence against sockpuppets.</li>
    <li><b>Rate limit search, not just writes.</b> The business corpus is valuable and scrapable; per‑IP limits on unauthenticated search are the practical protection.</li>
    <li><b>Keep moderation auditable.</b> Removing a review is a consequential act, so who removed it and why should be recorded.</li></ul></div>
  <div><h4>Stay boring on purpose</h4><ul>
    <li><b>Do the arithmetic first.</b> 10M businesses is 10 GB; recognising that the data fits on one machine is the senior signal this question is designed to elicit.</li>
    <li><b>The index is rebuildable.</b> Postgres is the source of truth, so a corrupted or lost index is a reindex rather than an incident.</li>
    <li><b>Reads and writes fail independently.</b> They share almost nothing, so a problem in the review path leaves search entirely unaffected.</li>
    <li><b>Degrade to the database.</b> With the index down, category and bounding‑box queries in Postgres still answer most searches — slower, but correct.</li></ul></div>
</div>

## Don't leave the room without saying {#yp-checklist}

<ul class="checklist">
  <li>Size it: ~1 TB, ~1 write/s, 1000:1 reads → replicas + cache, no shards, no queue</li>
  <li>avgRating + numRatings stored on the business, updated synchronously in the review transaction</li>
  <li>The lost‑update race and the conditional UPDATE (numRatings as version)</li>
  <li>UNIQUE(userId, businessId) enforces one review per user at the DB</li>
  <li>Why the naive lat/long + LIKE query scans; spatial index + inverted index</li>
  <li>PostGIS vs Elasticsearch trade‑off; CDC lag is acceptable given eventual consistency</li>
  <li>Geohash vs quadtree, Haversine second pass, distance filter first</li>
  <li>Place names = polygons; precompute location_names per business and index as keywords</li>
  <li>Split Review Service by write pattern; same DB is fine</li>
</ul>

## What each level is expected to drive {#yp-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Working HLD; reasonable answers on average rating and search indexing; brainstorm toward DB‑level constraint</td><td>Index types, optimistic locking</td></tr>
  <tr><td>Senior</td><td>Most deep dives: incremental rating with locking, unique constraint, spatial + text indexes with tradeoffs, no over‑engineering</td><td>Place‑name search</td></tr>
  <tr><td>Staff+</td><td>Key insights driving simple choices: PostGIS to avoid a new system, no queue at 1 write/s, no sharding at 1 TB; articulate when the complex option would be justified; place‑name precompute</td><td>—</td></tr>
</tbody></table>
