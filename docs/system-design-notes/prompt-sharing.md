---
title: "Prompt‑sharing platform"
slug: /system-design-notes/prompt-sharing
sidebar_position: 34
sidebar_label: "Prompt‑sharing platform"
description: "medium · data model · versioning · permissions · search · forks"
---
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
  <li><b>User B → Prompt service:</b> POST /prompts/A/fork</li>
  <li><b>Prompt service → Permission svc:</b> can read A? (public or shared)</li>
  <li><b>Permission svc → Prompt service:</b> yes (response)</li>
  <li><b>Prompt service → Postgres:</b> INSERT prompt B (forkedFrom = A.v3); version B.v1 = copy</li>
  <li><b>Postgres → CDC:</b> change (async)</li>
  <li><b>CDC → Elasticsearch:</b> index B (visibility private, owner B) (async)</li>
  <li><b>User B → Prompt service:</b> POST /prompts/B/versions {content}</li>
  <li><b>Prompt service → Postgres:</b> INSERT version B.v2; head = v2</li>
  <li><b>User B → Prompt service:</b> POST /shares {team T, editor}</li>
  <li><b>Prompt service → Postgres:</b> INSERT share</li>
  <li><b>Prompt service → Permission svc:</b> invalidate ACL cache for T members</li>
  <li><b>CDC → Elasticsearch:</b> reindex B with teamIds += T (async)</li>
  <li><b>User B → Search API:</b> GET /search?q=summarize&amp;sort=popular</li>
  <li><b>Search API → Elasticsearch:</b> query: text match AND (public OR owner OR teamId IN [T…])</li>
  <li><b>Elasticsearch → Search API:</b> hits (response)</li>
  <li><b>Search API → Permission svc:</b> batch recheck ACL</li>
  <li><b>Search API → User B:</b> results (response)</li>
</ol>

## Deep dives {#prompt-sharing-deep}

<div class="cards">
<div><h4>Versioning and forks</h4><ul><li>Versions are append‑only rows; the prompt points at head. Rollback = new version copying an old one, so history is linear and complete.</li><li>Fork stores forkedFromVersionId, giving exact provenance; a lineage query walks the chain. "Sync from upstream" = show diff between source head and forked base, optional new version.</li><li>Templates: variables parsed at save time and stored as structured fields for validation and search.</li></ul></div>
<div><h4>Permissions</h4><ul><li>Visibility on the prompt + explicit shares; effective access = union(visibility rule, direct share, team share, org role). Evaluate in one service, cache per (user, prompt) with short TTL and explicit invalidation on share change.</li><li>Link shares are revocable tokens (see CloudDrive); public prompts are readable without auth but writes always require ownership/editor.</li><li>Index carries visibility and teamIds so search pre‑filters; final recheck avoids stale index leaks.</li></ul></div>
<div><h4>Search and popularity</h4><ul><li>Elasticsearch over title, content, tags, model hints; boost title and tags; facets for model/tags; synonyms for common prompt terms.</li><li>Popularity = decayed score of likes, forks, views (e.g. half‑life 7 days) computed by the aggregator and written to the index, not computed at query time.</li><li>Small enough for Postgres FTS if the interviewer prefers one system; say the trade‑off.</li></ul></div></div>

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
