---
title: "Global photo/video storage and sharing (CloudDrive)"
slug: /system-design-notes/clouddrive
sidebar_position: 30
sidebar_label: "Global photo/video storage and sharing (…"
description: "medium · object storage · CDN · sharing/permissions · multi‑region · dedupe"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/clouddrive/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">medium · object storage · CDN · sharing/permissions · multi‑region · dedupe</span>
</header>
<p>Users upload photos and videos from phones and laptops, browse them anywhere in the world, and share albums or single items with people or via link. Close to Dropbox + Instagram's media path, with sharing and geography as the added emphasis.</p>

## Requirements {#clouddrive-req}

<div class="board">
  <div><h4>Functional</h4><ol>
      <li>Upload originals from any device, with progress and resume</li>
      <li>Browse library by time/album; view at device‑appropriate size; play video</li>
      <li>Share with users (view/edit) or via link (optional expiry/password); revoke</li>
      <li>Delete with trash/restore; storage quota</li>
      <li class="out">Editing, face search, comments</li>
  </ol></div>
  <div><h4>Non‑functional</h4><ol>
      <li>Durability 11 nines for originals; availability &gt;&gt; consistency for browsing</li>
      <li>Thumbnail grid loads &lt; 300 ms worldwide; video starts &lt; 1 s</li>
      <li>500M users, 1B uploads/day, avg 3 MB → 3 PB/day</li>
      <li>Sharing changes take effect within seconds; links unforgeable</li>
      <li>Data residency by home region</li>
  </ol></div>
</div>
<div class="note"><b>Numbers:</b> 3 PB/day originals → 1 EB/year; derivatives (thumbs, HLS renditions) add ~30%. Metadata 1B/day × 500 B = 500 GB/day. Reads: each user views ~100 thumbs/day → 50B thumb requests/day ≈ 600K/s, all from CDN.</div>

## Entities and API {#clouddrive-api}

<p>User (homeRegion, quota) · MediaItem (id, ownerId, contentHash, sizes[], takenAt, uploadedAt, state) · Album (id, ownerId, items[]) · Share (subjectId, grantee: user|link, role, expiresAt, token) · Blob (region, key, hash).</p>
<pre><code>POST /uploads {hash, size, mime}           -&gt; {dedupeHit | uploadId + presigned parts}
POST /uploads/:id/complete                   -&gt; mediaItemId
GET  /library?cursor=&amp;album=                 -&gt; items with CDN thumb URLs
GET  /media/:id?size=thumb|display|original  -&gt; 302 signed CDN URL
POST /shares {subject, grantee|link, role, expiresAt}   DELETE /shares/:id
GET  /s/:token                                -&gt; shared view (checks expiry/password)</code></pre>

## Design {#clouddrive-design}

<figure>
<svg viewBox="0 0 980 270" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="CloudDrive: clients upload via presigned multipart to the home-region object store; completion event triggers processing to derivatives; metadata service with sharded DB; sharing service with ACL cache; reads via CDN with signed URLs; cross-region replication of derivatives">
<defs><marker id="dg1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="dg3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#dg1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#dg3);stroke-dasharray:2 4}.lbl{font-size:10.5px;fill:#1F4E9E}</style>
<rect class="box" x="20" y="120" width="110" height="60"></rect><text class="tb" x="75" y="138" text-anchor="middle">Clients</text>
<text class="ts" x="75" y="154" text-anchor="middle">phone / web</text>
<text class="ts" x="75" y="167" text-anchor="middle">chunked upload</text>
<rect class="box" x="170" y="60" width="150" height="80"></rect><text class="tb" x="245" y="78" text-anchor="middle">Upload service</text>
<text class="ts" x="245" y="94" text-anchor="middle">presign, dedupe by hash</text>
<text class="ts" x="245" y="107" text-anchor="middle">quota check</text>
<text class="ts" x="245" y="120" text-anchor="middle">complete → event</text>
<rect class="box" x="170" y="170" width="150" height="80"></rect><text class="tb" x="245" y="188" text-anchor="middle">Media/Library svc</text>
<text class="ts" x="245" y="204" text-anchor="middle">library queries</text>
<text class="ts" x="245" y="217" text-anchor="middle">signed URL issuance</text>
<text class="ts" x="245" y="230" text-anchor="middle">ACL check</text>
<rect class="box" x="360" y="40" width="150" height="80" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="tb" x="435" y="58" text-anchor="middle">Object store (home)</text>
<text class="ts" x="435" y="74" text-anchor="middle">originals, 11 nines</text>
<text class="ts" x="435" y="87" text-anchor="middle">lifecycle → cold</text>
<rect class="box" x="360" y="150" width="150" height="80" stroke="#B45309"></rect><text class="tb" x="435" y="168" text-anchor="middle">Processing</text>
<text class="ts" x="435" y="184" text-anchor="middle">thumbs, display sizes</text>
<text class="ts" x="435" y="197" text-anchor="middle">HLS renditions, EXIF</text>
<rect class="box" x="540" y="40" width="150" height="80" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="tb" x="615" y="58" text-anchor="middle">Derivatives (multi-region)</text>
<text class="ts" x="615" y="74" text-anchor="middle">thumbs + renditions</text>
<text class="ts" x="615" y="87" text-anchor="middle">replicated to all regions</text>
<rect class="box" x="540" y="150" width="150" height="80" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="615" y="168" text-anchor="middle">Metadata DB</text>
<text class="ts" x="615" y="184" text-anchor="middle">items by (owner, takenAt)</text>
<text class="ts" x="615" y="197" text-anchor="middle">albums, shares</text>
<text class="ts" x="615" y="210" text-anchor="middle">sharded by ownerId</text>
<rect class="box" x="720" y="40" width="120" height="80" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="780" y="58" text-anchor="middle">Global CDN</text>
<text class="ts" x="780" y="74" text-anchor="middle">signed URLs</text>
<text class="ts" x="780" y="87" text-anchor="middle">edge cache</text>
<rect class="box" x="720" y="150" width="120" height="80"></rect><text class="tb" x="780" y="168" text-anchor="middle">Sharing svc</text>
<text class="ts" x="780" y="184" text-anchor="middle">ACL, link tokens</text>
<text class="ts" x="780" y="197" text-anchor="middle">revocation → cache</text>
<rect class="box" x="860" y="100" width="100" height="60"></rect><text class="tb" x="910" y="118" text-anchor="middle">Viewer</text>
<text class="ts" x="910" y="134" text-anchor="middle">anywhere</text>
<line class="f" x1="130" y1="140" x2="168" y2="110"></line>
<text class="lbl" x="149" y="119" text-anchor="middle">upload</text>
<line class="f" x1="130" y1="160" x2="168" y2="200"></line>
<text class="lbl" x="149" y="174" text-anchor="middle">browse</text>
<line class="f" x1="320" y1="90" x2="358" y2="80"></line>
<text class="lbl" x="339" y="79" text-anchor="middle">PUT parts</text>
<line class="f" x1="510" y1="80" x2="538" y2="80"></line>
<text class="lbl" x="524" y="74" text-anchor="middle">derive</text>
<line class="fa" x1="320" y1="190" x2="358" y2="190"></line>
<line class="f" x1="690" y1="80" x2="718" y2="80"></line>
<text class="lbl" x="704" y="74" text-anchor="middle">origin</text>
<line class="f" x1="840" y1="80" x2="858" y2="120"></line>
<line class="f" x1="320" y1="210" x2="538" y2="200"></line>
<text class="lbl" x="429" y="199" text-anchor="middle">query</text>
<line class="f" x1="690" y1="190" x2="718" y2="190"></line>
<text class="ts" x="20" y="240">Originals live in one region (residency, cost); small derivatives replicate everywhere so browsing is local.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 746" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Upload, share and view flow">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="17" y="14" width="106" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Owner device</text>
<line class="ln" x1="70" y1="48" x2="70" y2="726"></line>
<rect class="sb" x="137" y="14" width="106" height="34"></rect><text class="st" x="190" y="36" text-anchor="middle">Upload svc</text>
<line class="ln" x1="190" y1="48" x2="190" y2="726"></line>
<rect class="sb" x="257" y="14" width="106" height="34"></rect><text class="st" x="310" y="36" text-anchor="middle">Object store</text>
<line class="ln" x1="310" y1="48" x2="310" y2="726"></line>
<rect class="sb" x="377" y="14" width="106" height="34"></rect><text class="st" x="430" y="36" text-anchor="middle">Processing</text>
<line class="ln" x1="430" y1="48" x2="430" y2="726"></line>
<rect class="sb" x="497" y="14" width="106" height="34"></rect><text class="st" x="550" y="36" text-anchor="middle">Metadata DB</text>
<line class="ln" x1="550" y1="48" x2="550" y2="726"></line>
<rect class="sb" x="617" y="14" width="106" height="34"></rect><text class="st" x="670" y="36" text-anchor="middle">Sharing svc</text>
<line class="ln" x1="670" y1="48" x2="670" y2="726"></line>
<rect class="sb" x="737" y="14" width="106" height="34"></rect><text class="st" x="790" y="36" text-anchor="middle">CDN</text>
<line class="ln" x1="790" y1="48" x2="790" y2="726"></line>
<rect class="sb" x="857" y="14" width="106" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Viewer</text>
<line class="ln" x1="910" y1="48" x2="910" y2="726"></line>
<rect class="nt" x="6" y="67" width="128" height="22"></rect><text class="sl" x="70" y="82" text-anchor="middle">sha256 file; chunk</text>
<line class="a1" x1="78" y1="114" x2="182" y2="114"></line>
<text class="sl" x="130" y="108" text-anchor="middle">POST /uploads {hash}</text>
<line class="a1" x1="198" y1="148" x2="542" y2="148"></line>
<text class="sl" x="370" y="142" text-anchor="middle">hash exists for this user? quota?</text>
<line class="a2" x1="182" y1="182" x2="78" y2="182"></line>
<text class="sl" x="130" y="176" text-anchor="middle">dedupe hit → link existing | presigned parts</text>
<line class="a1" x1="78" y1="216" x2="302" y2="216"></line>
<text class="sl" x="190" y="210" text-anchor="middle">PUT parts</text>
<line class="a1" x1="78" y1="250" x2="182" y2="250"></line>
<text class="sl" x="130" y="244" text-anchor="middle">complete</text>
<line class="a1" x1="198" y1="284" x2="302" y2="284"></line>
<text class="sl" x="250" y="278" text-anchor="middle">CompleteMultipartUpload</text>
<line class="a3" x1="318" y1="318" x2="422" y2="318"></line>
<text class="sl" x="370" y="312" text-anchor="middle">event</text>
<line class="a1" x1="422" y1="352" x2="318" y2="352"></line>
<text class="sl" x="370" y="346" text-anchor="middle">write thumbs, display, HLS to derivatives (all regions)</text>
<line class="a1" x1="438" y1="386" x2="542" y2="386"></line>
<text class="sl" x="490" y="380" text-anchor="middle">item ready with sizes[]</text>
<line class="a1" x1="78" y1="420" x2="662" y2="420"></line>
<text class="sl" x="370" y="414" text-anchor="middle">POST /shares link, expires 7d</text>
<line class="a1" x1="662" y1="454" x2="558" y2="454"></line>
<text class="sl" x="610" y="448" text-anchor="middle">store share token</text>
<line class="a1" x1="902" y1="488" x2="678" y2="488"></line>
<text class="sl" x="790" y="482" text-anchor="middle">GET /s/:token</text>
<line class="a1" x1="662" y1="522" x2="558" y2="522"></line>
<text class="sl" x="610" y="516" text-anchor="middle">valid? not revoked?</text>
<line class="a2" x1="678" y1="556" x2="902" y2="556"></line>
<text class="sl" x="790" y="550" text-anchor="middle">gallery with signed CDN URLs (5 min)</text>
<line class="a1" x1="902" y1="590" x2="798" y2="590"></line>
<text class="sl" x="850" y="584" text-anchor="middle">GET thumb</text>
<line class="a2" x1="798" y1="624" x2="902" y2="624"></line>
<text class="sl" x="850" y="618" text-anchor="middle">edge hit / origin from nearest derivative region</text>
<line class="a1" x1="78" y1="658" x2="662" y2="658"></line>
<text class="sl" x="370" y="652" text-anchor="middle">revoke</text>
<rect class="nt" x="560" y="679" width="220" height="22"></rect><text class="sl" x="670" y="694" text-anchor="middle">ACL cache invalidate; tokens stop signing</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Owner device:</b> sha256 file; chunk</li>
  <li><b>Owner device → Upload svc:</b> POST /uploads {hash}</li>
  <li><b>Upload svc → Metadata DB:</b> hash exists for this user? quota?</li>
  <li><b>Upload svc → Owner device:</b> dedupe hit → link existing | presigned parts (response)</li>
  <li><b>Owner device → Object store:</b> PUT parts</li>
  <li><b>Owner device → Upload svc:</b> complete</li>
  <li><b>Upload svc → Object store:</b> CompleteMultipartUpload</li>
  <li><b>Object store → Processing:</b> event (async)</li>
  <li><b>Processing → Object store:</b> write thumbs, display, HLS to derivatives (all regions)</li>
  <li><b>Processing → Metadata DB:</b> item ready with sizes[]</li>
  <li><b>Owner device → Sharing svc:</b> POST /shares link, expires 7d</li>
  <li><b>Sharing svc → Metadata DB:</b> store share token</li>
  <li><b>Viewer → Sharing svc:</b> GET /s/:token</li>
  <li><b>Sharing svc → Metadata DB:</b> valid? not revoked?</li>
  <li><b>Sharing svc → Viewer:</b> gallery with signed CDN URLs (5 min) (response)</li>
  <li><b>Viewer → CDN:</b> GET thumb</li>
  <li><b>CDN → Viewer:</b> edge hit / origin from nearest derivative region (response)</li>
  <li><b>Owner device → Sharing svc:</b> revoke</li>
  <li><b>Sharing svc:</b> ACL cache invalidate; tokens stop signing</li>
</ol>

## Deep dives {#clouddrive-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/clouddrive/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
<div><h4>Storage layout</h4><ul><li>Originals: home region only, 11‑nines object store, lifecycle to cold after N days without access; content hash as key gives per‑user dedupe (same photo from two devices) and cross‑user dedupe if privacy allows (say the caveat).</li><li>Derivatives: small, replicated to every region; that's what browsing hits. 95% of views never touch the original.</li><li>Metadata sharded by ownerId; timeline query = one partition range on takenAt; album = list of item ids.</li></ul></div>
<div><h4>Sharing and permissions</h4><ul><li>ACL rows per (subject, grantee); link shares are random 128‑bit tokens with optional expiry/password, stored server‑side so they can be revoked (a signed URL alone can't be revoked).</li><li>Every media URL is short‑lived and signed after an ACL check; revocation = stop issuing + short TTL, plus CDN purge for the paranoid case.</li><li>Album share inherits to items; changing membership re‑evaluates; cache ACL decisions per (viewer, subject) for seconds.</li></ul></div>
<div><h4>Delivery and scale</h4><ul><li>CDN with signed URLs, device‑aware variants, prefetch next page of thumbs; video via HLS with adaptive bitrate.</li><li>Upload: presigned multipart, resume by part, client dedupe check before sending bytes saves the majority of duplicate uploads.</li><li>Trash: soft delete with 30‑day retention; hard delete purges originals, derivatives, CDN, and share tokens (privacy law).</li><li>Residency: home region chosen at signup; originals and metadata stay; derivatives replicate only where allowed.</li></ul></div></div>

## Don't leave the room without saying {#clouddrive-check}

<ul class="checklist">
  <li>3 PB/day math and why derivatives, not originals, replicate</li>
  <li>Presigned multipart upload, hash‑based dedupe before bytes move</li>
  <li>Originals single‑region durable + lifecycle; derivatives everywhere</li>
  <li>Shares as revocable server‑side tokens; media URLs short‑lived and signed</li>
  <li>CDN for thumbs/HLS; residency by home region</li>
  <li>Soft delete → purge everywhere</li>
</ul>

## What each level is expected to drive {#clouddrive-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Upload to S3, metadata DB, CDN for viewing, basic share table</td><td>Multipart, dedupe, signed URLs</td></tr>
  <tr><td>Senior</td><td>Full upload/derive/deliver pipeline, sharing model with revocation, region layout, quota, trash</td><td>Cross‑user dedupe privacy, HLS</td></tr>
  <tr><td>Staff+</td><td>Cost model (hot/cold, egress), residency, abuse (link scraping), purge guarantees across caches, migration to new regions</td><td>—</td></tr>
</tbody></table>
