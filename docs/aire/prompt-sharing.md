---
title: "Prompt‑sharing platform"
slug: /aire/prompt-sharing
sidebar_position: 34
sidebar_label: "Prompt‑sharing platform"
description: "medium · data model · versioning · permissions · search · forks"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/prompt-sharing/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">medium · data model · versioning · permissions · search · forks</span>
</header>
<p>A place where users publish prompts (and prompt templates with variables), version them, share with teams or publicly, fork and rate others' prompts, and find them by search. Product‑design shape; the interesting parts are the data model (versions, forks), the permission model, and search over text plus metadata.</p>

## Requirements {#prompt-sharing-req}

<div class="board">
  <div><h4>Functional</h4><ol>
      <li>Create/edit prompts with versions; templates with variables and example runs</li>
      <li>Visibility: private, team, org, public; share by link; roles viewer/editor</li>
      <li>Fork a prompt; see lineage; like/rate; comment</li>
      <li>Search by text, tags, model, author; sort by popularity/recency</li>
      <li class="out">Running prompts against models (delegate to the inference API), billing</li>
  </ol></div>
  <div><h4>Non‑functional</h4><ol>
      <li>Reads ≫ writes (browse/search vs publish); p95 search &lt; 300 ms</li>
      <li>Permission checks correct and fast on every read</li>
      <li>Versions immutable; edits never lose history</li>
      <li>10M prompts, 1M users; moderate scale, one relational DB + search index</li>
  </ol></div>
</div>
<div class="note"><b>Model to draw first:</b> Prompt is the mutable head; PromptVersion is immutable content; Fork is a Prompt whose first version points at a source version. Permissions attach to the Prompt (and inherit from team/org), never to versions.</div>


## Scale, performance and safety targets {#prompt-sharing-targets}

<p>This is a read‑heavy product system at moderate scale. The numbers matter less for capacity than for justifying one relational database plus one index — and for making the permission story precise.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> ~20K QPS of reads (browse, open, search) against ~200 QPS of writes — a 100:1 ratio that justifies denormalizing popularity and pre‑filtering in the index.</li>
    <li><b>Data volume:</b> 10M prompts and 1M users; average prompt a few KB with perhaps 5 versions, so ~50M version rows and a few hundred GB including comments and reactions. Comfortably one Postgres cluster.</li>
    <li><b>Growth:</b> ~2× annually. Nothing here needs sharding yet, and saying so explicitly — rather than reaching for a distributed store — is the right call at this size.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> search p95 &lt; 300 ms including the ACL recheck; prompt open p95 &lt; 150 ms; write (new version) p95 &lt; 200 ms. Index freshness after a change under ~5 s.</li>
    <li><b>Throughput:</b> modest — the interesting constraint is that a permission check runs on <em>every</em> read, so it must be cached and batched rather than a per‑row database round trip.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the sharp edges are authorization, not load — leaking a private prompt through a stale search index, an unrevoked link share, or an enumerable id. Beyond that: scraping the public corpus, spam and low‑quality prompt flooding, and prompts written specifically to jailbreak downstream models.</li>
    <li><b>Rate limiting:</b> per‑user caps on publishes and forks (e.g. 60 writes/min), search queries per minute per user and per IP, and comment/reaction limits to blunt spam and vote manipulation.</li>
    <li><b>Data sensitivity:</b> prompts routinely contain business logic, API keys pasted by accident, and customer data in examples. Treat private prompts as confidential by default, scan for secrets on save, never index a private prompt's content into a shared analytics store, and make deletion remove the prompt, its versions and its index entries.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.9%. Reads matter more than writes — a user who cannot publish is inconvenienced, while a user who cannot open their own prompt experiences it as data loss.</li>
    <li><b>Degraded mode:</b> search index unavailable → fall back to database queries on title and tags, slower but correct. Permission cache cold → fall back to direct evaluation with higher latency; <b>never</b> fall back to allowing. CDC lagging → new prompts are briefly unsearchable, which is acceptable; stale ACLs in the index are not, which is why every search result is rechecked.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> strong in Postgres for versions and shares — a revoked share must take effect immediately on the read path. Search is explicitly eventually consistent, which is safe only because results are re‑authorized before being returned.</li>
    <li><b>Durability:</b> versions are immutable and append‑only, so history is never lost and "rollback" is just a new version copying an old one. The search index is fully rebuildable from Postgres.</li>
    <li><b>Compliance:</b> deletion must cover versions, forks' provenance links, comments and index entries; and because a fork copies content, the policy for what happens to forks when the source is deleted needs to be stated rather than discovered.</li></ul></div>
</div>

## Entities and API {#prompt-sharing-api}

<p>User · Team/Org (membership, role) · Prompt (id, ownerId, teamId?, visibility, headVersionId, forkedFromVersionId?, stats) · PromptVersion (id, promptId, seq, content, variables[], modelHints, createdBy, createdAt) · Share (promptId, grantee: user|team|link, role) · Tag · Reaction/Rating · Comment.</p>
<pre><code>POST /prompts {title, content, visibility, teamId?}           -&gt; prompt (v1)
POST /prompts/:id/versions {content, note}                      -&gt; new head version
GET  /prompts/:id?version=                                     -&gt; prompt + version (ACL checked)
POST /prompts/:id/fork                                          -&gt; new prompt, v1 = copy of source version, lineage link
POST /prompts/:id/shares {grantee, role}     DELETE /shares/:id
GET  /search?q=&amp;tags=&amp;model=&amp;sort=popular|recent&amp;cursor=        -&gt; results (ACL-filtered)
POST /prompts/:id/reactions {type}</code></pre>

## Design {#prompt-sharing-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/prompt-sharing/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Prompt platform: gateway, prompt service with versioning, permission service with cached ACL, Postgres for prompts/versions/shares, Elasticsearch fed by CDC for search with visibility filters, stats aggregator">
<defs><marker id="dg1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="dg3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#dg1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#dg3);stroke-dasharray:2 4}.lbl{font-size:10.5px;fill:#1F4E9E}</style>
<rect class="box" x="20" y="100" width="110" height="60"></rect><text class="tb" x="75" y="118" text-anchor="middle">Client</text>
<text class="ts" x="75" y="134" text-anchor="middle">web / IDE plugin</text>
<rect class="box" x="160" y="100" width="110" height="60"></rect><text class="tb" x="215" y="118" text-anchor="middle">API Gateway</text>
<text class="ts" x="215" y="134" text-anchor="middle">auth, rate limit</text>
<rect class="box" x="300" y="40" width="160" height="80"></rect><text class="tb" x="380" y="58" text-anchor="middle">Prompt service</text>
<text class="ts" x="380" y="74" text-anchor="middle">create/version/fork</text>
<text class="ts" x="380" y="87" text-anchor="middle">share, react</text>
<rect class="box" x="300" y="150" width="160" height="80" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="380" y="168" text-anchor="middle">Permission service</text>
<text class="ts" x="380" y="184" text-anchor="middle">visibility + shares</text>
<text class="ts" x="380" y="197" text-anchor="middle">team/org inheritance</text>
<text class="ts" x="380" y="210" text-anchor="middle">cache (user, prompt)</text>
<rect class="box" x="500" y="40" width="160" height="80" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="580" y="58" text-anchor="middle">Postgres</text>
<text class="ts" x="580" y="74" text-anchor="middle">prompts, versions (immutable)</text>
<text class="ts" x="580" y="87" text-anchor="middle">shares, teams, reactions</text>
<rect class="box" x="500" y="150" width="160" height="80" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="580" y="168" text-anchor="middle">Elasticsearch</text>
<text class="ts" x="580" y="184" text-anchor="middle">content + tags + model</text>
<text class="ts" x="580" y="197" text-anchor="middle">visibility, teamIds fields</text>
<text class="ts" x="580" y="210" text-anchor="middle">popularity score</text>
<rect class="box" x="700" y="40" width="120" height="80" stroke="#B45309"></rect><text class="tb" x="760" y="58" text-anchor="middle">CDC</text>
<text class="ts" x="760" y="74" text-anchor="middle">Debezium/Kafka</text>
<text class="ts" x="760" y="87" text-anchor="middle">→ index</text>
<rect class="box" x="700" y="150" width="120" height="80" stroke="#B45309"></rect><text class="tb" x="760" y="168" text-anchor="middle">Stats aggregator</text>
<text class="ts" x="760" y="184" text-anchor="middle">likes, forks, views</text>
<text class="ts" x="760" y="197" text-anchor="middle">popularity decay</text>
<rect class="box" x="860" y="100" width="100" height="60"></rect><text class="tb" x="910" y="118" text-anchor="middle">Search API</text>
<text class="ts" x="910" y="134" text-anchor="middle">ACL-filtered</text>
<text class="ts" x="910" y="147" text-anchor="middle">queries</text>
<line class="f" x1="130" y1="130" x2="158" y2="130"></line>
<line class="f" x1="270" y1="120" x2="298" y2="80"></line>
<line class="f" x1="270" y1="140" x2="298" y2="190"></line>
<line class="f" x1="460" y1="80" x2="498" y2="80"></line>
<line class="fa" x1="660" y1="80" x2="698" y2="80"></line>
<line class="fa" x1="760" y1="120" x2="700" y2="150"></line>
<line class="f" x1="660" y1="190" x2="858" y2="140"></line>
<text class="lbl" x="759" y="159" text-anchor="middle">query</text>
<line class="f" x1="460" y1="190" x2="498" y2="190"></line>
<text class="lbl" x="479" y="184" text-anchor="middle">filter</text>
<text class="ts" x="20" y="230">Search results are pre‑filtered by visibility in the index query (public OR owner=me OR teamId IN mine), then re‑checked by the permission service before return.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 678" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Fork, edit, share, search">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="7" y="14" width="126" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">User B</text>
<line class="ln" x1="70" y1="48" x2="70" y2="658"></line>
<rect class="sb" x="147" y="14" width="126" height="34"></rect><text class="st" x="210" y="36" text-anchor="middle">Prompt service</text>
<line class="ln" x1="210" y1="48" x2="210" y2="658"></line>
<rect class="sb" x="287" y="14" width="126" height="34"></rect><text class="st" x="350" y="36" text-anchor="middle">Permission svc</text>
<line class="ln" x1="350" y1="48" x2="350" y2="658"></line>
<rect class="sb" x="427" y="14" width="126" height="34"></rect><text class="st" x="490" y="36" text-anchor="middle">Postgres</text>
<line class="ln" x1="490" y1="48" x2="490" y2="658"></line>
<rect class="sb" x="567" y="14" width="126" height="34"></rect><text class="st" x="630" y="36" text-anchor="middle">CDC</text>
<line class="ln" x1="630" y1="48" x2="630" y2="658"></line>
<rect class="sb" x="707" y="14" width="126" height="34"></rect><text class="st" x="770" y="36" text-anchor="middle">Elasticsearch</text>
<line class="ln" x1="770" y1="48" x2="770" y2="658"></line>
<rect class="sb" x="847" y="14" width="126" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Search API</text>
<line class="ln" x1="910" y1="48" x2="910" y2="658"></line>
<line class="a1" x1="78" y1="80" x2="202" y2="80"></line>
<text class="sl" x="140" y="74" text-anchor="middle">POST /prompts/A/fork</text>
<line class="a1" x1="218" y1="114" x2="342" y2="114"></line>
<text class="sl" x="280" y="108" text-anchor="middle">can read A? (public or shared)</text>
<line class="a2" x1="342" y1="148" x2="218" y2="148"></line>
<text class="sl" x="280" y="142" text-anchor="middle">yes</text>
<line class="a1" x1="218" y1="182" x2="482" y2="182"></line>
<text class="sl" x="350" y="176" text-anchor="middle">INSERT prompt B (forkedFrom = A.v3); version B.v1 = copy</text>
<line class="a3" x1="498" y1="216" x2="622" y2="216"></line>
<text class="sl" x="560" y="210" text-anchor="middle">change</text>
<line class="a3" x1="638" y1="250" x2="762" y2="250"></line>
<text class="sl" x="700" y="244" text-anchor="middle">index B (visibility private, owner B)</text>
<line class="a1" x1="78" y1="284" x2="202" y2="284"></line>
<text class="sl" x="140" y="278" text-anchor="middle">POST /prompts/B/versions {content}</text>
<line class="a1" x1="218" y1="318" x2="482" y2="318"></line>
<text class="sl" x="350" y="312" text-anchor="middle">INSERT version B.v2; head = v2</text>
<line class="a1" x1="78" y1="352" x2="202" y2="352"></line>
<text class="sl" x="140" y="346" text-anchor="middle">POST /shares {team T, editor}</text>
<line class="a1" x1="218" y1="386" x2="482" y2="386"></line>
<text class="sl" x="350" y="380" text-anchor="middle">INSERT share</text>
<line class="a1" x1="218" y1="420" x2="342" y2="420"></line>
<text class="sl" x="280" y="414" text-anchor="middle">invalidate ACL cache for T members</text>
<line class="a3" x1="638" y1="454" x2="762" y2="454"></line>
<text class="sl" x="700" y="448" text-anchor="middle">reindex B with teamIds += T</text>
<line class="a1" x1="78" y1="488" x2="902" y2="488"></line>
<text class="sl" x="490" y="482" text-anchor="middle">GET /search?q=summarize&amp;sort=popular</text>
<line class="a1" x1="902" y1="522" x2="778" y2="522"></line>
<text class="sl" x="840" y="516" text-anchor="middle">query: text match AND (public OR owner OR teamId IN [T…])</text>
<line class="a2" x1="778" y1="556" x2="902" y2="556"></line>
<text class="sl" x="840" y="550" text-anchor="middle">hits</text>
<line class="a1" x1="902" y1="590" x2="358" y2="590"></line>
<text class="sl" x="630" y="584" text-anchor="middle">batch recheck ACL</text>
<line class="a2" x1="902" y1="624" x2="78" y2="624"></line>
<text class="sl" x="490" y="618" text-anchor="middle">results</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>User B → Prompt service:</b> POST /prompts/A/fork.
    Forking is the platform's core social action, so it gets a first‑class endpoint rather than being a client‑side copy‑paste.
    Making it explicit is what allows provenance to be recorded — a copied prompt with no lineage is just duplicate content.</li>
  <li><b>Prompt service → Permission svc:</b> can read A? (public or shared).
    Authorization happens before anything is created, because a fork is a read of the source as much as a write of a new prompt.
    Effective access is the union of visibility rules, direct shares, team shares and org roles — evaluated in one service so the rule exists in exactly one place.</li>
  <li><b>Permission svc → Prompt service:</b> yes (response).
    Decisions are cached per (user, prompt) with a short TTL, because this same check runs on every single read in the product.
    Caching an authorization decision is only safe with explicit invalidation on share changes, which is why that arrow appears later.</li>
  <li><b>Prompt service → Postgres:</b> INSERT prompt B (forkedFrom = A.v3); version B.v1 = copy.
    The fork points at an exact <em>version</em>, not at the prompt — provenance must survive the source continuing to evolve.
    Content is copied rather than referenced, so B is independent and A's author cannot later change what B contains.
    That copy is also what makes "sync from upstream" a diff between A's current head and B's recorded base, rather than a merge problem.</li>
  <li><b>Postgres → CDC:</b> change (async).
    Change data capture keeps the index in step without the write path depending on Elasticsearch being healthy.
    A synchronous dual write would mean an index outage becomes a publish outage, and would still leave the two stores able to diverge.</li>
  <li><b>CDC → Elasticsearch:</b> index B (visibility private, owner B) (async).
    Permission fields are indexed alongside the text so search can pre‑filter rather than fetching candidates and discarding them.
    A new fork starts private, so it is indexed as visible to exactly one person — the index is populated from the first moment rather than on first share.</li>
  <li><b>User B → Prompt service:</b> POST /prompts/B/versions {content}.
    Editing never mutates an existing version; it appends a new one and moves the head pointer.
    That is what makes history complete and rollback trivial — restoring an old version is simply a new version copying its content.</li>
  <li><b>Prompt service → Postgres:</b> INSERT version B.v2; head = v2.
    Prompt is the mutable head, PromptVersion is immutable content — the single most important line in the data model.
    Permissions attach to the prompt and never to versions, so sharing cannot accidentally expose only part of a history.</li>
  <li><b>User B → Prompt service:</b> POST /shares {team T, editor}.
    Shares are explicit rows rather than a field on the prompt, which is what allows a prompt to be shared with several grantees at different roles.
    Link shares are revocable tokens rather than unguessable URLs alone, so access can actually be withdrawn.</li>
  <li><b>Prompt service → Postgres:</b> INSERT share.
    The share row is the source of truth and is written strongly consistently, because access changes must take effect immediately.</li>
  <li><b>Prompt service → Permission svc:</b> invalidate ACL cache for T members.
    This is the arrow that makes caching authorization safe: a revoked or granted share invalidates the affected cache entries synchronously.
    Waiting for a TTL to expire would mean a revoked colleague keeps access for the length of that TTL — the classic way a permission cache becomes a security incident.</li>
  <li><b>CDC → Elasticsearch:</b> reindex B with teamIds += T (async).
    The index is updated so team members can now find the prompt, but this update is eventually consistent and can lag or fail.
    Which is precisely why the index is treated as a fast candidate generator and never as the authority on access.</li>
  <li><b>User B → Search API:</b> GET /search?q=summarize&amp;sort=popular.
    Search is the main way prompts are discovered, so it carries both the performance target and the largest authorization risk in the system.</li>
  <li><b>Search API → Elasticsearch:</b> query: text match AND (public OR owner OR teamId IN [T…]).
    Permission predicates are part of the query, so the engine returns only plausible candidates instead of fetching thousands and filtering afterwards.
    Filtering after ranking would also corrupt the result count and pagination, which users notice immediately.
    Popularity is a precomputed decayed score stored on the document — computing it at query time would make every search a fan‑out over reactions.</li>
  <li><b>Elasticsearch → Search API:</b> hits (response).
    Hits carry the metadata needed to render a result card, so the common case needs no round trip back to Postgres.</li>
  <li><b>Search API → Permission svc:</b> batch recheck ACL.
    The index may be stale — a share revoked seconds ago may not have propagated — so every result is re‑authorized against the source of truth before it is shown.
    The recheck is batched into a single call for the whole page, which is what keeps it inside the 300 ms budget.
    Pre‑filter for speed, recheck for correctness: skipping the second step is how private prompts leak through a stale index.</li>
  <li><b>Search API → User B:</b> results (response).
    Anything that fails the recheck is dropped silently rather than shown as "access denied", because the existence of a private prompt is itself information.
    View counts are recorded asynchronously so they feed tomorrow's popularity score without slowing today's query.</li>
</ol>

## Deep dives {#prompt-sharing-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/prompt-sharing/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
<div><h4>Versioning and forks</h4><ul><li>Versions are append‑only rows; the prompt points at head. Rollback = new version copying an old one, so history is linear and complete.</li><li>Fork stores forkedFromVersionId, giving exact provenance; a lineage query walks the chain. "Sync from upstream" = show diff between source head and forked base, optional new version.</li><li>Templates: variables parsed at save time and stored as structured fields for validation and search.</li></ul></div>
<div><h4>Permissions</h4><ul><li>Visibility on the prompt + explicit shares; effective access = union(visibility rule, direct share, team share, org role). Evaluate in one service, cache per (user, prompt) with short TTL and explicit invalidation on share change.</li><li>Link shares are revocable tokens (see CloudDrive); public prompts are readable without auth but writes always require ownership/editor.</li><li>Index carries visibility and teamIds so search pre‑filters; final recheck avoids stale index leaks.</li></ul></div>
<div><h4>Search and popularity</h4><ul><li>Elasticsearch over title, content, tags, model hints; boost title and tags; facets for model/tags; synonyms for common prompt terms.</li><li>Popularity = decayed score of likes, forks, views (e.g. half‑life 7 days) computed by the aggregator and written to the index, not computed at query time.</li><li>Small enough for Postgres FTS if the interviewer prefers one system; say the trade‑off.</li></ul></div></div>


## Trade-offs {#prompt-sharing-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Edit model</td><td>Immutable versions with a mutable head pointer</td><td>Storage grows with every edit, and "current" needs a join or a denormalized pointer</td><td>In‑place edits are cheaper but destroy history, which is the feature people actually come for</td></tr>
  <tr><td>Fork semantics</td><td>Copy content, record the source version</td><td>Forks do not receive upstream fixes automatically</td><td>Referencing the source keeps forks in sync but lets the original author silently change what someone else published</td></tr>
  <tr><td>Search stack</td><td>Elasticsearch fed by CDC</td><td>A second system, eventual consistency, and a rebuild path to maintain</td><td>Postgres full‑text search is entirely adequate at 10M rows and removes a whole component — worth naming as the simpler option</td></tr>
  <tr><td>Authorization on search</td><td>Pre‑filter in the index, recheck before returning</td><td>An extra batched call on every search</td><td>Never drop the recheck: the index is eventually consistent, and a revoked share must not be visible for even a few seconds</td></tr>
  <tr><td>Permission evaluation</td><td>One service, cached per (user, prompt), invalidated on change</td><td>Cache invalidation complexity, and a cache that must fail closed</td><td>Evaluating inline every time is simpler and correct but adds a join to every read in a 100:1 read‑heavy product</td></tr>
  <tr><td>Popularity</td><td>Precomputed decayed score written into the index</td><td>Rankings lag reality by the aggregation interval</td><td>Computing at query time is exact but turns every search into a fan‑out over reactions</td></tr>
  <tr><td>Index sync</td><td>CDC rather than dual writes</td><td>Lag between publishing and being findable</td><td>Dual writes look simpler and quietly diverge; worse, they make an index outage into a publish outage</td></tr>
</tbody></table>

## Safety-first design {#prompt-sharing-safety}

<div class="cards">
  <div><h4>The index must never be the authority</h4><ul>
    <li><b>Pre‑filter, then recheck.</b> Permission fields in the index make search fast; a batched recheck against Postgres makes it correct.</li>
    <li><b>Invalidate on share change.</b> A revoked share purges the affected cache entries immediately rather than waiting out a TTL.</li>
    <li><b>Fail closed.</b> If the permission service is unavailable, reads fail or fall back to direct evaluation — never to allowing.</li>
    <li><b>Absence over denial.</b> Results that fail the recheck disappear rather than showing "access denied", because confirming that a private prompt exists is itself a leak.</li></ul></div>
  <div><h4>Prompts contain things people did not mean to publish</h4><ul>
    <li><b>Scan for secrets on save.</b> API keys and tokens end up pasted into prompts constantly; catching them at write time is far better than after a prompt is made public.</li>
    <li><b>Private by default.</b> New prompts and forks start private, so publishing is always a deliberate act.</li>
    <li><b>Warn on visibility change.</b> Going from private to public is the moment to surface what is about to become world‑readable.</li>
    <li><b>Deletion reaches everything.</b> Versions, index entries, comments and provenance links — and the policy for existing forks is stated rather than discovered later.</li></ul></div>
  <div><h4>Keeping a public corpus healthy</h4><ul>
    <li><b>Rate limit writes and reactions.</b> Publish, fork, comment and vote limits blunt spam and popularity manipulation before they distort discovery.</li>
    <li><b>Decayed popularity.</b> A half‑life on likes and forks means old viral content cannot permanently occupy the top of every ranking.</li>
    <li><b>Moderation on public visibility.</b> Prompts written to jailbreak downstream models are a real category; publishing is the right gate for review.</li>
    <li><b>Writes always authorized.</b> Public prompts are readable without auth, but every mutation requires ownership or an editor role — readability never implies writability.</li></ul></div>
</div>

## Don't leave the room without saying {#prompt-sharing-check}

<ul class="checklist">
  <li>Prompt (mutable head) vs PromptVersion (immutable); fork = new prompt with provenance</li>
  <li>Permission = visibility ∪ shares ∪ team/org roles, one service, cached, invalidated on change</li>
  <li>Search index carries visibility fields; pre‑filter + recheck</li>
  <li>Popularity precomputed with decay</li>
  <li>CDC from Postgres to index; eventual consistency acceptable</li>
  <li>Link shares revocable; writes always authorized</li>
</ul>

## What each level is expected to drive {#prompt-sharing-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>CRUD, versions table, visibility flag, basic search</td><td>Forks, team permissions, index filtering</td></tr>
  <tr><td>Senior</td><td>Immutable versions and fork lineage, unified permission model with cache, ACL‑aware search, popularity pipeline</td><td>Template variables, moderation</td></tr>
  <tr><td>Staff+</td><td>Scales the permission model to orgs with nested teams, handles index staleness safely, abuse (spam prompts), and connects to the inference API for "run this prompt"</td><td>—</td></tr>
</tbody></table>
