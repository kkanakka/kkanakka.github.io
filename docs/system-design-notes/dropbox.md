---
title: "Dropbox"
slug: /system-design-notes/dropbox
sidebar_position: 7
sidebar_label: "Dropbox"
description: "easy · handling large blobs · presigned URLs · chunking · sync"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/dropbox/sequence.svg" alt="How it works — dropbox" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
<header>
  
  <span class="tag">easy · handling large blobs · presigned URLs · chunking · sync</span>
</header>
<p>Store, download, share, and sync files across devices, up to 50 GB each. The whole interview is really one question: how do you move a huge file without ever routing its bytes through your servers, and how do you survive interruptions halfway through.</p>

## Requirements {#db-requirements}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Upload a file from any device</li>
      <li>Download a file from any device</li>
      <li>Share a file with other users; see files shared with me</li>
      <li>Auto‑sync files across devices</li>
      <li class="out">Edit in place, preview without download</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Availability &gt; consistency (a few seconds of sync lag is fine)</li>
      <li>Files up to 50 GB</li>
      <li>Secure and durable; recover from loss/corruption</li>
      <li>Fast upload, download, sync</li>
      <li class="out">Per‑user quota, versioning, malware scanning</li>
    </ol>
  </div>
</div>
<div class="note"><b>CAP answer:</b> you only pick consistency when every read must see the latest write or the system breaks (trading, inventory). A file appearing in the US two seconds after a German upload is fine, so availability wins.</div>

## Entities and API {#db-entities}

<p>File (bytes) · FileMetadata (name, size, mimeType, uploadedBy, status, s3Key, chunks[]) · User · SharedFiles (userId, fileId).</p>
<pre><code>POST /files                       {name, size, mimeType, fingerprint}  -&gt; {fileId, uploadId, presignedUrls[]}   (start)
PATCH /files/{fileId}/chunks/{n}   {etag}                               -&gt; chunk marked uploaded
POST /files/{fileId}/complete                                          -&gt; CompleteMultipartUpload, status=uploaded
GET  /files/{fileId}                                                   -&gt; metadata + CDN signed download URL (5 min)
POST /files/{fileId}/share        {userIds[]}
GET  /files/changes?since={ts}                                         -&gt; [ChangeEvent{fileId, type, metadata}]
User comes from the JWT, never the body.</code></pre>

## Final design {#db-diagram}

<figure>
<svg viewBox="0 0 980 420" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Dropbox architecture: uploader chunks file and puts chunks straight to S3 with presigned URLs; File Service is the control plane over the metadata DB; S3 notifies on completion; downloads go through a CDN with signed URLs; sync via WebSocket push plus polling fallback">
  <defs>
    <marker id="d1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker>
    <marker id="d2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker>
    <marker id="d3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#0F766E"></path></marker>
  </defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:13px;fill:#1B2430;font-weight:600}.ts{font-size:11px;fill:#5B6673}.tm{font-size:11px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#d1)}.fp{stroke:#6B2D6B;stroke-width:1.8;fill:none;marker-end:url(#d2)}.ft{stroke:#0F766E;stroke-width:1.6;fill:none;marker-end:url(#d3);stroke-dasharray:4 3}.lbl{font-size:11px;fill:#1F4E9E}.lblp{font-size:11px;fill:#6B2D6B}.lblt{font-size:11px;fill:#0F766E}</style>

  <rect class="box" x="20" y="60" width="130" height="80"></rect><text class="tb" x="85" y="82" text-anchor="middle">Uploader client</text><text class="ts" x="85" y="98" text-anchor="middle">watch folder (FSEvents)</text><text class="ts" x="85" y="112" text-anchor="middle">chunk 5–10 MB · fingerprint</text><text class="ts" x="85" y="126" text-anchor="middle">parallel PUTs, progress</text>
  <rect class="box" x="20" y="280" width="130" height="80"></rect><text class="tb" x="85" y="302" text-anchor="middle">Downloader client</text><text class="ts" x="85" y="318" text-anchor="middle">WebSocket/SSE for pushes</text><text class="ts" x="85" y="332" text-anchor="middle">poll /changes as fallback</text><text class="ts" x="85" y="346" text-anchor="middle">Range requests</text>

  <rect class="box" x="220" y="170" width="120" height="70"></rect><text class="tb" x="280" y="192" text-anchor="middle">API GW + LB</text><text class="ts" x="280" y="208" text-anchor="middle">auth · rate limit</text><text class="ts" x="280" y="222" text-anchor="middle">10 MB body cap!</text>

  <rect class="box" x="400" y="160" width="170" height="90"></rect><text class="tb" x="485" y="182" text-anchor="middle">File Service</text><text class="ts" x="410" y="200">control plane only</text><text class="ts" x="410" y="214">sign URLs locally (no S3 call)</text><text class="ts" x="410" y="228">start/track/complete uploads</text><text class="ts" x="410" y="242">enforce ACL, emit changes</text>

  <rect class="box" x="640" y="150" width="190" height="110"></rect><text class="tb" x="650" y="170">Metadata DB (DynamoDB/PG)</text>
  <text class="tm" x="650" y="188">FileMetadata: fileId PK,</text><text class="tm" x="650" y="202"> fingerprint, status, s3Key,</text><text class="tm" x="650" y="216"> chunks[{id,status,etag}]</text>
  <text class="tm" x="650" y="234">SharedFiles: userId PK,</text><text class="tm" x="650" y="248"> fileId SK</text>

  <rect class="box" x="640" y="40" width="190" height="60" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="tb" x="735" y="62" text-anchor="middle">S3</text><text class="ts" x="735" y="78" text-anchor="middle">multipart upload · SSE‑at‑rest</text><text class="ts" x="735" y="92" text-anchor="middle">event on CompleteMultipartUpload</text>

  <rect class="box" x="640" y="300" width="190" height="60" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="735" y="322" text-anchor="middle">CDN (CloudFront)</text><text class="ts" x="735" y="338" text-anchor="middle">signed URL, 5‑min expiry</text><text class="ts" x="735" y="352" text-anchor="middle">miss → S3, hit → edge</text>

  <rect class="box" x="870" y="150" width="100" height="110" stroke="#B45309"></rect><text class="tb" x="920" y="172" text-anchor="middle">Notifier</text><text class="ts" x="920" y="190" text-anchor="middle">change events</text><text class="ts" x="920" y="204" text-anchor="middle">→ per‑device</text><text class="ts" x="920" y="218" text-anchor="middle">connections</text><text class="ts" x="920" y="240" text-anchor="middle">(Redis pub/sub)</text>

  <path class="f" d="M150 110 L218 185"></path><text class="lbl" x="150" y="150">1 POST /files</text>
  <path class="f" d="M340 205 L398 205"></path><path class="f" d="M570 205 L638 205"></path>
  <path class="f" d="M398 195 L342 195" stroke="none"></path>
  <text class="lbl" x="350" y="196">→ uploadId + signed URLs</text>
  <path class="fp" d="M150 80 C 350 20, 500 20, 638 60"></path><text class="lblp" x="300" y="34">2 PUT chunks straight to S3 (parallel)</text>
  <path class="f" d="M150 125 C 250 250, 350 260, 398 240" stroke-dasharray="2 4"></path><text class="lbl" x="200" y="262">3 PATCH chunk done (etag)</text>
  <path class="fp" d="M735 100 L735 148"></path><text class="lblp" x="742" y="128">4 complete → status=uploaded</text>
  <path class="f" d="M830 205 L868 205"></path><text class="lbl" x="832" y="198">5 event</text>
  <path class="ft" d="M870 240 C 700 420, 300 420, 150 330"></path><text class="lblt" x="330" y="404">6 push: file changed</text>
  <path class="f" d="M150 300 L218 225"></path><text class="lbl" x="155" y="285">7 GET /files/id → CDN URL</text>
  <path class="ft" d="M150 345 L638 335"></path><text class="lblt" x="330" y="330">8 download from edge</text>
  <path class="fp" d="M735 300 L735 102" stroke-dasharray="3 3"></path>
</svg>
<figcaption>File bytes never touch the File Service or the gateway. It signs URLs, tracks state, and enforces permissions; S3 and the CDN move data.</figcaption>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 882" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Dropbox upload, download and sync flow between components">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="7" y="14" width="126" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Uploader</text>
<line class="ln" x1="70" y1="48" x2="70" y2="862"></line>
<rect class="sb" x="147" y="14" width="126" height="34"></rect><text class="st" x="210" y="36" text-anchor="middle">File Service</text>
<line class="ln" x1="210" y1="48" x2="210" y2="862"></line>
<rect class="sb" x="287" y="14" width="126" height="34"></rect><text class="st" x="350" y="36" text-anchor="middle">Metadata DB</text>
<line class="ln" x1="350" y1="48" x2="350" y2="862"></line>
<rect class="sb" x="427" y="14" width="126" height="34"></rect><text class="st" x="490" y="36" text-anchor="middle">S3</text>
<line class="ln" x1="490" y1="48" x2="490" y2="862"></line>
<rect class="sb" x="567" y="14" width="126" height="34"></rect><text class="st" x="630" y="36" text-anchor="middle">CDN</text>
<line class="ln" x1="630" y1="48" x2="630" y2="862"></line>
<rect class="sb" x="707" y="14" width="126" height="34"></rect><text class="st" x="770" y="36" text-anchor="middle">Notifier</text>
<line class="ln" x1="770" y1="48" x2="770" y2="862"></line>
<rect class="sb" x="847" y="14" width="126" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Downloader</text>
<line class="ln" x1="910" y1="48" x2="910" y2="862"></line>
<rect class="nt" x="-40" y="67" width="220" height="22"></rect><text class="sl" x="70" y="82" text-anchor="middle">chunk 5–10 MB, fingerprint file + chunks</text>
<line class="a1" x1="78" y1="114" x2="202" y2="114"></line>
<text class="sl" x="140" y="108" text-anchor="middle">POST /files {fingerprint}</text>
<line class="a1" x1="218" y1="148" x2="342" y2="148"></line>
<text class="sl" x="280" y="142" text-anchor="middle">exists? resume if uploading</text>
<line class="a2" x1="342" y1="182" x2="218" y2="182"></line>
<text class="sl" x="280" y="176" text-anchor="middle">metadata</text>
<line class="a1" x1="218" y1="216" x2="482" y2="216"></line>
<text class="sl" x="350" y="210" text-anchor="middle">CreateMultipartUpload</text>
<rect class="nt" x="137" y="237" width="146" height="22"></rect><text class="sl" x="210" y="252" text-anchor="middle">sign one URL per part</text>
<line class="a1" x1="218" y1="284" x2="342" y2="284"></line>
<text class="sl" x="280" y="278" text-anchor="middle">INSERT status=uploading, chunks[]</text>
<line class="a2" x1="202" y1="318" x2="78" y2="318"></line>
<text class="sl" x="140" y="312" text-anchor="middle">uploadId + part URLs</text>
<line class="a1" x1="78" y1="352" x2="482" y2="352"></line>
<text class="sl" x="280" y="346" text-anchor="middle">PUT parts in parallel</text>
<line class="a1" x1="78" y1="386" x2="202" y2="386"></line>
<text class="sl" x="140" y="380" text-anchor="middle">PATCH chunk n done (etag)</text>
<line class="a1" x1="218" y1="420" x2="342" y2="420"></line>
<text class="sl" x="280" y="414" text-anchor="middle">mark chunk uploaded</text>
<line class="a1" x1="218" y1="454" x2="482" y2="454"></line>
<text class="sl" x="350" y="448" text-anchor="middle">CompleteMultipartUpload</text>
<line class="a3" x1="482" y1="488" x2="218" y2="488"></line>
<text class="sl" x="350" y="482" text-anchor="middle">completion event</text>
<line class="a1" x1="218" y1="522" x2="342" y2="522"></line>
<text class="sl" x="280" y="516" text-anchor="middle">status=uploaded</text>
<line class="a3" x1="218" y1="556" x2="762" y2="556"></line>
<text class="sl" x="490" y="550" text-anchor="middle">file changed</text>
<line class="a3" x1="778" y1="590" x2="902" y2="590"></line>
<text class="sl" x="840" y="584" text-anchor="middle">push over WebSocket/SSE</text>
<line class="a1" x1="902" y1="624" x2="218" y2="624"></line>
<text class="sl" x="560" y="618" text-anchor="middle">GET /files/:id</text>
<line class="a1" x1="218" y1="658" x2="342" y2="658"></line>
<text class="sl" x="280" y="652" text-anchor="middle">ACL check</text>
<line class="a2" x1="218" y1="692" x2="902" y2="692"></line>
<text class="sl" x="560" y="686" text-anchor="middle">CDN signed URL (5 min)</text>
<line class="a1" x1="902" y1="726" x2="638" y2="726"></line>
<text class="sl" x="770" y="720" text-anchor="middle">GET signed URL</text>
<line class="a1" x1="622" y1="760" x2="498" y2="760"></line>
<text class="sl" x="560" y="754" text-anchor="middle">miss → fetch</text>
<line class="a2" x1="638" y1="794" x2="902" y2="794"></line>
<text class="sl" x="770" y="788" text-anchor="middle">bytes from edge</text>
<line class="a3" x1="902" y1="828" x2="218" y2="828"></line>
<text class="sl" x="560" y="822" text-anchor="middle">periodic GET /changes?since (fallback)</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Uploader → File Service:</b> POST /files {fingerprint}</li>
  <li><b>File Service → Metadata DB:</b> exists? resume if uploading</li>
  <li><b>Metadata DB → File Service:</b> metadata (response)</li>
  <li><b>File Service → S3:</b> CreateMultipartUpload</li>
  <li><b>File Service:</b> sign one URL per part</li>
  <li><b>File Service → Metadata DB:</b> INSERT status=uploading, chunks[]</li>
  <li><b>File Service → Uploader:</b> uploadId + part URLs (response)</li>
  <li><b>Uploader → S3:</b> PUT parts in parallel</li>
  <li><b>Uploader → File Service:</b> PATCH chunk n done (etag)</li>
  <li><b>File Service → Metadata DB:</b> mark chunk uploaded</li>
  <li><b>File Service → S3:</b> CompleteMultipartUpload</li>
  <li><b>S3 → File Service:</b> completion event (async)</li>
  <li><b>File Service → Metadata DB:</b> status=uploaded</li>
  <li><b>File Service → Notifier:</b> file changed (async)</li>
  <li><b>Notifier → Downloader:</b> push over WebSocket/SSE (async)</li>
  <li><b>Downloader → File Service:</b> GET /files/:id</li>
  <li><b>File Service → Metadata DB:</b> ACL check</li>
  <li><b>File Service → Downloader:</b> CDN signed URL (5 min) (response)</li>
  <li><b>Downloader → CDN:</b> GET signed URL</li>
  <li><b>CDN → S3:</b> miss → fetch</li>
  <li><b>CDN → Downloader:</b> bytes from edge (response)</li>
  <li><b>Downloader → File Service:</b> periodic GET /changes?since (fallback) (async)</li>
</ol>

## High‑level design, by requirement {#db-hld}

### Upload: three options, pick the third

<table>
  <tbody><tr><th>Option</th><th>Flow</th><th>Verdict</th></tr>
  <tr><td>Bytes in the DB</td><td>POST file to server → store as blob column</td><td>No. Expensive, slow, DBs aren't built for 50 GB rows.</td></tr>
  <tr><td>Server proxies to S3</td><td>POST to server → server streams to S3 → writes metadata</td><td>Uploads everything twice; server bandwidth is the bottleneck; gateway body limits (API GW: 10 MB) kill it outright.</td></tr>
  <tr><td><b>Presigned URL, direct to S3</b></td><td>Client asks File Service → gets signed URL(s) → PUTs to S3 → S3 event marks metadata <code>uploaded</code></td><td>Yes. Server is a control plane; S3 scales the bytes. Signing is a local crypto op, no S3 round trip.</td></tr>
</tbody></table>

### Download

<ul>
  <li>Same idea in reverse: File Service checks ACL, returns a short‑lived <b>CDN signed URL</b>; client fetches from the nearest edge, CDN pulls from S3 on miss.</li>
  <li>Never a presigned S3 URL straight to the client if you have a CDN; the edge is closer and cheaper.</li>
</ul>

### Share

<ul>
  <li><code>SharedFiles(userId PK, fileId SK)</code> answers "files shared with me" in one partition read; a reverse index (fileId → users) answers "who has access" for ACL checks. Or a <code>shareList</code> on the file plus a per‑user cache.</li>
  <li>Share by email → resolve to userId → write both directions → emit a change event so the recipient's devices pick it up.</li>
</ul>

### Sync

<ul>
  <li><b>Local → remote:</b> client agent watches the folder (FSEvents / FileSystemWatcher), queues changed files, uploads via the same chunked flow, updates metadata. Remote is the source of truth. Conflicts: last‑write‑wins (versioning is out of scope, but say you'd write a new version and move a pointer rather than overwrite).</li>
  <li><b>Remote → local:</b> hybrid. One WebSocket/SSE per device; server pushes change events for anything the user can see. Plus periodic <code>GET /files/changes?since=</code> as the safety net for dropped connections and missed messages. Real‑time when it works, eventually consistent when it doesn't.</li>
</ul>

## Deep dives {#db-deepdives}

### 1. Large files (where the interview time goes)

<p>Why a single POST fails: 50 GB at 100 Mbps = 50 × 8 / 100 = 4,000 s ≈ 1.1 h. Timeouts fire, gateways cap bodies at MBs, one dropped packet restarts everything, and the user sees a spinner for an hour.</p>
<ul>
  <li><b>Chunk on the client</b>, 5–10 MB pieces (chunking on the server defeats the purpose: the whole file already crossed the wire). Progress bar = chunks done / total.</li>
  <li><b>Fingerprint</b> the whole file and each chunk (SHA‑256). File fingerprint answers "have I uploaded this before?" (dedupe, resume); chunk fingerprints answer "which parts are done?". <code>fileId</code> stays a UUID; fingerprint is a separate indexed field, because two users can upload identical bytes.</li>
  <li><b>Resumable state</b> lives in metadata: <code>status: uploading</code>, <code>chunks: [{id, status, etag}]</code>. Keep it truthful two ways: client PATCHes after each chunk and the server verifies with S3 <code>ListParts</code>, or trust the ETags and reconcile on completion. S3 events only fire on completion, not per part.</li>
  <li><b>Flow:</b> client fingerprints → asks if file exists (resume if <code>uploading</code>) → server <code>CreateMultipartUpload</code>, signs a URL per part (uploadId + partNumber), stores metadata → client PUTs parts in parallel → PATCH per part → when all parts marked, server <code>CompleteMultipartUpload</code> with part numbers + ETags → status <code>uploaded</code>.</li>
  <li>This is S3 Multipart Upload. Name it, but be able to build it yourself.</li>
  <li><b>Downloads don't need chunk knowledge:</b> after completion it's one object. HTTP <code>Range</code> requests give parallel and resumable downloads for free.</li>
</ul>

### 2. Speed

<ul>
  <li>Parallel chunk uploads and adaptive chunk size fill the pipe; CDN shortens the download path.</li>
  <li><b>Delta sync:</b> only re‑upload changed chunks. Fixed‑size chunks break on an insert near the start (every boundary shifts). Use <b>content‑defined chunking</b> (rolling hash / Rabin fingerprint) so boundaries follow content and a small edit changes only its neighbors. This is what real Dropbox does.</li>
  <li><b>Compression on the client</b> (backend is out of the data path): worth it for text (5 GB → ~1 GB), useless for already‑compressed media (png, mp4). Decide per file type + size + network. zstd for speed, brotli for ratio, gzip for ubiquity. Always compress before encrypt; encrypted bytes don't compress.</li>
</ul>

### 3. Security

<ul>
  <li>HTTPS in transit; S3 server‑side encryption at rest with keys stored separately.</li>
  <li>ACL = SharedFiles; File Service checks it before signing any URL.</li>
  <li>Signed URLs are <b>bearer tokens</b>: anyone holding an unexpired one can download. Keep expiry short (~5 min); for higher security bind to IP or require auth cookies alongside. CDN validates signature + expiry with the registered public key and serves or denies at the edge.</li>
</ul>

## Don't leave the room without saying {#db-checklist}

<ul class="checklist">
  <li>Availability over consistency, with the "would a stale read break it?" test</li>
  <li>Metadata in a DB, bytes in S3, DB holds the pointer</li>
  <li>Presigned URLs so bytes bypass your servers; signing is local</li>
  <li>50 GB math (~1 h at 100 Mbps) → client‑side chunking, parallel, progress</li>
  <li>Fingerprints for dedupe + resume; chunk state in metadata; S3 multipart by name</li>
  <li>CDN signed URLs for download, short expiry, bearer‑token caveat</li>
  <li>Sync = push (one connection per device) + poll fallback; remote is truth; LWW conflicts</li>
  <li>Content‑defined chunking for delta sync; compress before encrypt, only when it pays</li>
  <li>User identity from the token, never the body</li>
</ul>

## What each level is expected to drive {#db-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>APIs, data model, working upload/download/share; explain what each box does</td><td>Presigned URLs, chunking, resumability ("you're uploading twice, how do we avoid that?")</td></tr>
  <tr><td>Senior</td><td>Fast through HLD; drive the large‑file deep dive with options and a chosen solution; CDN, blob storage tradeoffs; likely knows multipart upload from experience</td><td>CDC, compression details</td></tr>
  <tr><td>Staff+</td><td>All deep dives at practitioner depth: multipart internals, fingerprinting and dedupe, delta sync with CDC, signed‑URL security limits, sync reliability; steers to what's interesting and treats the interviewer as a peer</td><td>—</td></tr>
</tbody></table>
