---
title: "Instagram"
slug: /system-design-notes/instagram
sidebar_position: 23
sidebar_label: "Instagram"
description: "medium · scaling reads · fan‑out on write · celebrity problem · large blobs + CDN"
---
<header>
  
  <span class="tag">medium · scaling reads · fan‑out on write · celebrity problem · large blobs + CDN</span>
</header>
<p>Post photos/videos, follow people, see a chronological feed of what they posted. Same bones as FB News Feed plus Dropbox's media path. The two things that decide the interview: how the feed is built (fan‑out on read vs write vs hybrid) and how media gets uploaded and served.</p>

## Requirements {#ig-requirements}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Create a post: photo or video + caption</li>
      <li>Follow other users (one‑directional)</li>
      <li>Chronological feed of followed users' posts</li>
      <li class="out">Likes/comments, search, stories, live</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Availability &gt;&gt; consistency (feed may lag up to ~2 min)</li>
      <li>Feed load &lt; 500 ms end to end</li>
      <li>Media renders instantly (&lt; 200 ms), photos ≤ 8 MB, videos ≤ 4 GB</li>
      <li>500M DAU, 100M posts/day</li>
      <li class="out">Security/PII, analytics</li>
    </ol>
  </div>
</div>
<div class="note"><b>Scale math to say early:</b> 100M posts/day ≈ 1,160/s writes. 500M DAU × 5 refreshes ≈ 2.5B feed reads/day, ~150K/s at peak. Media 100M × 2 MB ≈ 200 TB/day (~750 PB over 10 years); metadata 100M × 1 KB ≈ 100 GB/day. Reads dwarf writes by orders of magnitude.</div>

## Entities and API {#ig-entities}

<p>User · Post (postId, userId, caption, mediaKey, uploadStatus, createdAt) · Media (bytes in S3) · Follow (followerId, followedId).</p>
<pre><code>POST /posts  {caption, mediaType, size}   -&gt; {postId, presignedUploadUrl | multipart parts}
POST /follows {followedId}                 (followerId from JWT)
GET  /feed?cursor=&amp;limit=                  -&gt; {posts[], nextCursor}   (cursor = createdAt#postId)</code></pre>

## Final design {#ig-diagram}

<figure>
<svg viewBox="0 0 980 440" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Instagram architecture: client uploads media straight to S3 by presigned URL; S3 notifies Post Service and an image processing pipeline; Post Service writes DynamoDB and emits postId to a queue; Feed Fan-out Service pushes the postId into each follower's precomputed Redis feed except for celebrity authors; feed read merges Redis feed with recent celebrity posts; media served from S3 through a global CDN">
  <defs>
    <marker id="ig1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker>
    <marker id="ig2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker>
    <marker id="ig3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker>
  </defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:11px;fill:#5B6673}.tm{font-size:10.5px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#ig1)}.fp{stroke:#6B2D6B;stroke-width:1.6;fill:none;marker-end:url(#ig2);stroke-dasharray:5 4}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#ig3);stroke-dasharray:2 4}.lbl{font-size:10.5px;fill:#1F4E9E}.lblp{font-size:10.5px;fill:#6B2D6B}.lbla{font-size:10.5px;fill:#B45309}</style>
  <rect class="box" x="20" y="180" width="90" height="56"></rect><text class="tb" x="65" y="203" text-anchor="middle">Client</text><text class="ts" x="65" y="221" text-anchor="middle">app / web</text>
  <rect class="box" x="150" y="180" width="110" height="56"></rect><text class="tb" x="205" y="203" text-anchor="middle">API Gateway</text><text class="ts" x="205" y="221" text-anchor="middle">auth · rate limit</text>
  <rect class="box" x="310" y="60" width="150" height="80"></rect><text class="tb" x="385" y="82" text-anchor="middle">Post Service</text><text class="ts" x="385" y="100" text-anchor="middle">create post, presign</text><text class="ts" x="385" y="114" text-anchor="middle">feed read: merge</text><text class="ts" x="385" y="128" text-anchor="middle">cache + celebrities</text>
  <rect class="box" x="310" y="300" width="150" height="56"></rect><text class="tb" x="385" y="322" text-anchor="middle">Follow Service</text><text class="ts" x="385" y="340" text-anchor="middle">follow / unfollow</text>
  <rect class="box" x="520" y="40" width="200" height="120"></rect><text class="tb" x="530" y="60">DynamoDB</text>
  <text class="tm" x="530" y="78">Posts: PK userId</text><text class="tm" x="530" y="92">  SK createdAt#postId</text><text class="tm" x="530" y="110">Follows: PK followerId</text><text class="tm" x="530" y="124">  SK followedId</text><text class="tm" x="530" y="142">GSI followedId → followers</text>
  <rect class="box" x="520" y="190" width="120" height="50" stroke="#B45309"></rect><text class="tb" x="580" y="211" text-anchor="middle">Queue</text><text class="ts" x="580" y="228" text-anchor="middle">new postIds</text>
  <rect class="box" x="680" y="190" width="150" height="70"></rect><text class="tb" x="755" y="210" text-anchor="middle">Feed Fan‑out Service</text><text class="ts" x="755" y="228" text-anchor="middle">lookup followers</text><text class="ts" x="755" y="242" text-anchor="middle">skip if author is celebrity</text>
  <rect class="box" x="860" y="180" width="110" height="90" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="915" y="200" text-anchor="middle">Feed cache</text><text class="tm" x="915" y="218" text-anchor="middle">feed:{userId}</text><text class="ts" x="915" y="234" text-anchor="middle">sorted set, cap 500</text><text class="ts" x="915" y="248" text-anchor="middle">postIds by time</text><text class="ts" x="915" y="262" text-anchor="middle">AOF + Sentinel</text>
  <rect class="box" x="520" y="300" width="120" height="60" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="tb" x="580" y="322" text-anchor="middle">S3</text><text class="ts" x="580" y="340" text-anchor="middle">originals + variants</text><text class="ts" x="580" y="352" text-anchor="middle">multipart upload</text>
  <rect class="box" x="680" y="300" width="150" height="60"></rect><text class="tb" x="755" y="322" text-anchor="middle">Media processing</text><text class="ts" x="755" y="340" text-anchor="middle">resize, transcode, thumbs</text><text class="ts" x="755" y="352" text-anchor="middle">(queue + workers)</text>
  <rect class="box" x="860" y="300" width="110" height="60" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="915" y="322" text-anchor="middle">Global CDN</text><text class="ts" x="915" y="340" text-anchor="middle">signed URLs</text><text class="ts" x="915" y="352" text-anchor="middle">device‑sized variants</text>
  <path class="f" d="M110 208 L148 208"></path>
  <path class="f" d="M260 195 L308 110"></path><text class="lbl" x="255" y="150">POST /posts · GET /feed</text>
  <path class="f" d="M260 220 L308 320"></path><text class="lbl" x="230" y="290">POST /follows</text>
  <path class="f" d="M460 90 L518 90"></path><text class="lbl" x="466" y="82">metadata</text>
  <path class="f" d="M460 330 L518 330" stroke-dasharray="3 3"></path><text class="lbl" x="466" y="322">rows</text>
  <path class="fa" d="M460 120 C 500 160, 500 215, 518 215"></path><text class="lbla" x="470" y="175">postId</text>
  <path class="fa" d="M640 215 L678 215"></path><path class="fa" d="M755 190 C 755 160, 640 150, 640 160" stroke="none"></path>
  <path class="fa" d="M720 190 C 720 170, 660 165, 660 160"></path><text class="lbla" x="690" y="178">followers</text>
  <path class="fa" d="M830 225 L858 225"></path><text class="lbla" x="836" y="216">ZADD</text>
  <path class="f" d="M460 70 C 700 20, 900 60, 915 178" stroke-dasharray="4 3"></path><text class="lbl" x="700" y="28">feed read: ZREVRANGE + celebrity posts + hydrate</text>
  <path class="fp" d="M65 236 C 65 400, 480 400, 520 350"></path><text class="lblp" x="200" y="392">upload chunks directly (presigned)</text>
  <path class="fp" d="M580 300 C 580 250, 400 250, 385 142"></path><text class="lblp" x="440" y="248">S3 event: uploadStatus=complete</text>
  <path class="fp" d="M640 330 L678 330"></path><path class="fp" d="M830 330 L858 330"></path>
  <path class="fp" d="M860 340 C 700 430, 200 430, 100 236"></path><text class="lblp" x="380" y="424">render media from edge</text>
</svg>
<figcaption>Writes are cheap (~1K/s) so we spend them precomputing feeds; reads are huge (~150K/s) so each one is a cache range read plus a small merge.</figcaption>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 882" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Instagram post, fan-out and feed flow between components">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="17" y="14" width="106" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Client</text>
<line class="ln" x1="70" y1="48" x2="70" y2="862"></line>
<rect class="sb" x="137" y="14" width="106" height="34"></rect><text class="st" x="190" y="36" text-anchor="middle">Post Service</text>
<line class="ln" x1="190" y1="48" x2="190" y2="862"></line>
<rect class="sb" x="257" y="14" width="106" height="34"></rect><text class="st" x="310" y="36" text-anchor="middle">DynamoDB</text>
<line class="ln" x1="310" y1="48" x2="310" y2="862"></line>
<rect class="sb" x="377" y="14" width="106" height="34"></rect><text class="st" x="430" y="36" text-anchor="middle">S3</text>
<line class="ln" x1="430" y1="48" x2="430" y2="862"></line>
<rect class="sb" x="497" y="14" width="106" height="34"></rect><text class="st" x="550" y="36" text-anchor="middle">Queue</text>
<line class="ln" x1="550" y1="48" x2="550" y2="862"></line>
<rect class="sb" x="617" y="14" width="106" height="34"></rect><text class="st" x="670" y="36" text-anchor="middle">Fan-out Service</text>
<line class="ln" x1="670" y1="48" x2="670" y2="862"></line>
<rect class="sb" x="737" y="14" width="106" height="34"></rect><text class="st" x="790" y="36" text-anchor="middle">Redis feeds</text>
<line class="ln" x1="790" y1="48" x2="790" y2="862"></line>
<rect class="sb" x="857" y="14" width="106" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">CDN</text>
<line class="ln" x1="910" y1="48" x2="910" y2="862"></line>
<line class="a1" x1="78" y1="80" x2="182" y2="80"></line>
<text class="sl" x="130" y="74" text-anchor="middle">POST /posts {caption}</text>
<line class="a1" x1="198" y1="114" x2="302" y2="114"></line>
<text class="sl" x="250" y="108" text-anchor="middle">PutItem uploadStatus=pending</text>
<line class="a2" x1="182" y1="148" x2="78" y2="148"></line>
<text class="sl" x="130" y="142" text-anchor="middle">postId + presigned URLs</text>
<line class="a1" x1="78" y1="182" x2="422" y2="182"></line>
<text class="sl" x="250" y="176" text-anchor="middle">multipart upload</text>
<line class="a3" x1="422" y1="216" x2="198" y2="216"></line>
<text class="sl" x="310" y="210" text-anchor="middle">completion event</text>
<line class="a1" x1="198" y1="250" x2="302" y2="250"></line>
<text class="sl" x="250" y="244" text-anchor="middle">uploadStatus=complete</text>
<line class="a3" x1="198" y1="284" x2="542" y2="284"></line>
<text class="sl" x="370" y="278" text-anchor="middle">enqueue postId</text>
<line class="a3" x1="438" y1="318" x2="542" y2="318"></line>
<text class="sl" x="490" y="312" text-anchor="middle">media processing job</text>
<line class="a1" x1="662" y1="352" x2="558" y2="352"></line>
<text class="sl" x="610" y="346" text-anchor="middle">consume postId</text>
<line class="a1" x1="662" y1="386" x2="318" y2="386"></line>
<text class="sl" x="490" y="380" text-anchor="middle">query GSI followers of author</text>
<line class="a2" x1="318" y1="420" x2="662" y2="420"></line>
<text class="sl" x="490" y="414" text-anchor="middle">follower ids (pages)</text>
<rect class="nt" x="578" y="441" width="183" height="22"></rect><text class="sl" x="670" y="456" text-anchor="middle">skip if author is celebrity</text>
<line class="a1" x1="678" y1="488" x2="782" y2="488"></line>
<text class="sl" x="730" y="482" text-anchor="middle">ZADD feed:{follower} score=createdAt</text>
<line class="a1" x1="678" y1="522" x2="782" y2="522"></line>
<text class="sl" x="730" y="516" text-anchor="middle">ZREMRANGEBYRANK trim to 500</text>
<line class="a1" x1="78" y1="556" x2="182" y2="556"></line>
<text class="sl" x="130" y="550" text-anchor="middle">GET /feed?cursor</text>
<line class="a1" x1="198" y1="590" x2="782" y2="590"></line>
<text class="sl" x="490" y="584" text-anchor="middle">ZREVRANGEBYSCORE feed:{user}</text>
<line class="a2" x1="782" y1="624" x2="198" y2="624"></line>
<text class="sl" x="490" y="618" text-anchor="middle">postIds</text>
<line class="a1" x1="198" y1="658" x2="782" y2="658"></line>
<text class="sl" x="490" y="652" text-anchor="middle">recent posts of followed celebrities</text>
<line class="a1" x1="198" y1="692" x2="302" y2="692"></line>
<text class="sl" x="250" y="686" text-anchor="middle">BatchGetItem posts</text>
<line class="a2" x1="302" y1="726" x2="198" y2="726"></line>
<text class="sl" x="250" y="720" text-anchor="middle">post rows</text>
<line class="a2" x1="182" y1="760" x2="78" y2="760"></line>
<text class="sl" x="130" y="754" text-anchor="middle">page + nextCursor + CDN URLs</text>
<line class="a1" x1="78" y1="794" x2="902" y2="794"></line>
<text class="sl" x="490" y="788" text-anchor="middle">GET media variant</text>
<line class="a2" x1="902" y1="828" x2="78" y2="828"></line>
<text class="sl" x="490" y="822" text-anchor="middle">bytes from edge</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Client → Post Service:</b> POST /posts {caption}</li>
  <li><b>Post Service → DynamoDB:</b> PutItem uploadStatus=pending</li>
  <li><b>Post Service → Client:</b> postId + presigned URLs (response)</li>
  <li><b>Client → S3:</b> multipart upload</li>
  <li><b>S3 → Post Service:</b> completion event (async)</li>
  <li><b>Post Service → DynamoDB:</b> uploadStatus=complete</li>
  <li><b>Post Service → Queue:</b> enqueue postId (async)</li>
  <li><b>S3 → Queue:</b> media processing job (async)</li>
  <li><b>Fan-out Service → Queue:</b> consume postId</li>
  <li><b>Fan-out Service → DynamoDB:</b> query GSI followers of author</li>
  <li><b>DynamoDB → Fan-out Service:</b> follower ids (pages) (response)</li>
  <li><b>Fan-out Service:</b> skip if author is celebrity</li>
  <li><b>Fan-out Service → Redis feeds:</b> ZADD feed:{follower} score=createdAt</li>
  <li><b>Fan-out Service → Redis feeds:</b> ZREMRANGEBYRANK trim to 500</li>
  <li><b>Client → Post Service:</b> GET /feed?cursor</li>
  <li><b>Post Service → Redis feeds:</b> ZREVRANGEBYSCORE feed:{user}</li>
  <li><b>Redis feeds → Post Service:</b> postIds (response)</li>
  <li><b>Post Service → Redis feeds:</b> recent posts of followed celebrities</li>
  <li><b>Post Service → DynamoDB:</b> BatchGetItem posts</li>
  <li><b>DynamoDB → Post Service:</b> post rows (response)</li>
  <li><b>Post Service → Client:</b> page + nextCursor + CDN URLs (response)</li>
  <li><b>Client → CDN:</b> GET media variant</li>
  <li><b>CDN → Client:</b> bytes from edge (response)</li>
</ol>

## High‑level design, by requirement {#ig-hld}

### 1. Create a post

<ul>
  <li>Post Service writes metadata with <code>uploadStatus=pending</code>, returns postId and a presigned URL (multipart for videos). Client uploads straight to S3; the gateway never sees media bytes.</li>
  <li>S3 completion event → Post Service sets <code>uploadStatus=complete</code> and enqueues postId. Server‑driven completion beats a client PATCH because you don't trust the client to report it.</li>
</ul>

### 2. Follow

<ul>
  <li><code>Follows(PK followerId, SK followedId)</code> answers "who do I follow"; a GSI on followedId answers "who follows X" for fan‑out. Separate Follow Service because the traffic pattern differs; same database is fine, say the trade‑off if asked.</li>
</ul>

### 3. Feed, naive version (fan‑out on read)

<ul>
  <li>Get followees → query Posts by each userId (PK) newest‑first → merge‑sort → page. Works at small scale; a user following 1,000 accounts means 1,000 partition queries per refresh.</li>
  <li>DynamoDB: Posts PK userId, SK createdAt#postId so per‑author recent posts is one range query.</li>
</ul>

## Deep dives {#ig-deepdives}

### 1. Feed under 500 ms: fan‑out on write and the celebrity problem

<p>Why fan‑out on read fails: read amplification (2.5B feed builds/day, each touching ~10K posts), repeated work (the same popular post fetched millions of times), and unpredictable latency proportional to follow count. Batch reads cap at 100 items, so 1,000 followees is ≥10 round trips per refresh.</p>
<table>
  <tbody><tr><th>Option</th><th>How</th><th>Pro</th><th>Con</th></tr>
  <tr><td>Fan‑out on read</td><td>Build at request time</td><td>No precompute, always fresh, cheap writes</td><td>Slow, expensive, latency ∝ followees</td></tr>
  <tr><td>Fan‑out on write</td><td>On post: push postId into every follower's precomputed feed (Redis sorted set per user)</td><td>Feed read = one range query, constant time</td><td>Write amplification: a 100M‑follower account creates 100M writes per post; delay before feed updates</td></tr>
  <tr><td><b>Hybrid (pick)</b></td><td>Fan‑out on write for authors under a follower threshold (~10K–100K); for celebrities, don't fan out. At read time merge the precomputed feed with the recent posts of the few celebrities the user follows.</td><td>Bounded write amplification, fast reads, freshness for big accounts</td><td>Read path has two sources to merge; threshold to tune</td></tr>
</tbody></table>
<ul>
  <li><b>Fan‑out pipeline:</b> Post Service enqueues postId → Feed Fan‑out workers read followers via GSI in pages → <code>ZADD feed:{follower} score=createdAt member=postId</code> → trim each set to ~500 entries. Async, idempotent (ZADD twice is a no‑op), retriable; this is the "long‑running task" pattern and why 2 minutes of staleness is acceptable.</li>
  <li><b>Read path:</b> <code>ZREVRANGEBYSCORE feed:{user} max=cursor limit</code> → union with a per‑celebrity recent‑posts cache for the celebrities this user follows (a small list) → sort → hydrate postIds from a post cache/DB in one batch → return with nextCursor = last (createdAt#postId).</li>
  <li><b>Inactive users:</b> skip fan‑out for users who haven't opened the app in N days; rebuild their feed on read when they return. Cuts write volume by the inactive fraction.</li>
  <li><b>Redis durability:</b> feeds are rebuildable, but losing them for 500M users at once is an outage. AOF persistence, Sentinel/Cluster failover, and a fallback to fan‑out on read for a cold feed. Say this before the interviewer asks.</li>
  <li><b>Storage:</b> 500M users × 500 postIds × ~16 B ≈ 4 TB of feed data in Redis; shard by userId.</li>
</ul>

### 2. Media: upload 4 GB videos and render in 200 ms

<ul>
  <li><b>Upload:</b> client‑side chunking with S3 multipart via presigned part URLs (see Dropbox); progress and resume per part; completion via S3 event, not client claim.</li>
  <li><b>Processing:</b> S3 event → queue → workers generate multiple sizes (thumbnail, feed, full) and video renditions (HLS/DASH bitrates); write variants to S3; update post with variant keys. The post is "publishable" only when required variants exist.</li>
  <li><b>Delivery:</b> global CDN in front of S3 with signed URLs; client requests the variant matching its screen and network; image formats negotiated (WebP/AVIF). First‑byte from the nearest edge, not the origin region.</li>
  <li><b>Prefetch:</b> feed response includes CDN URLs for the next page's thumbnails so the client can warm them while the user scrolls.</li>
</ul>

### 3. Scaling to 500M DAU

<ul>
  <li>Stateless services autoscaled behind load balancers; DynamoDB partitions by userId (posts) and followerId (follows) spread naturally because ids are random.</li>
  <li>Hot partition risk: a celebrity's Posts partition is read heavily → cache their recent posts (the same celebrity cache the hybrid read uses).</li>
  <li>Storage tiering: media untouched for months → S3 Glacier; old post metadata → cheaper store. CDN → memory → SSD → HDD → tape, move cold data down.</li>
  <li>Evolution story for staff: 1M users = fan‑out on read on Postgres with indexes; 10M = add feed cache; 100M+ = fan‑out on write with celebrity carve‑out; sharding and tiering as storage grows.</li>
</ul>

## Don't leave the room without saying {#ig-checklist}

<ul class="checklist">
  <li>Numbers: ~1K posts/s vs ~150K feed reads/s; 200 TB/day media</li>
  <li>Presigned multipart upload straight to S3; S3 event marks completion</li>
  <li>Posts keyed by (userId, createdAt#postId); Follows by (followerId, followedId) + GSI</li>
  <li>Why fan‑out on read fails at this scale (amplification, repeated work, latency ∝ followees)</li>
  <li>Hybrid: fan‑out on write below a follower threshold, merge celebrities at read</li>
  <li>Feed cache as sorted set per user, capped, ZADD idempotent, async workers off a queue</li>
  <li>Redis durability plan and cold‑feed fallback</li>
  <li>Media processing pipeline → variants → CDN with signed URLs</li>
  <li>Cursor pagination on createdAt#postId</li>
  <li>Storage tiering for a 750 PB decade</li>
</ul>

## What each level is expected to drive {#ig-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Upload/follow/feed HLD, simple schema, S3 + CDN awareness; fan‑out on read first</td><td>Recognizing its limits and moving to fan‑out on write</td></tr>
  <tr><td>Senior</td><td>Fan‑out read vs write vs hybrid with the celebrity argument, feed cache design, multipart upload, indexing for the read‑heavy workload, justified DB choice</td><td>Media variants pipeline details</td></tr>
  <tr><td>Staff+</td><td>Identifies feed + media as the only two real problems and spends time there; evolution from 1M to 500M with when‑to‑add for each piece; failure modes (Redis loss, hot partitions, fan‑out backlog); cost tiering</td><td>—</td></tr>
</tbody></table>
