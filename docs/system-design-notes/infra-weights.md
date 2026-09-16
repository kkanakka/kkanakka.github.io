---
title: "Distribute a large file (model weights) to thousands of machines"
slug: /system-design-notes/infra-weights
sidebar_position: 12
sidebar_label: "Distribute a large file (model weights) …"
description: "hard · Anthropic · chunking · swarm · rarest‑first · per‑chunk hashes"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/infra-weights/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">hard · Anthropic · chunking · swarm · rarest‑first · per‑chunk hashes</span>
</header>

## Requirements {#infra-weights-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Publish a new weights version (hundreds of GB) and have every node in a fleet obtain an identical, verified copy</li>
      <li>Nodes can join late, restart mid‑download, and resume</li>
      <li>Operators can see progress per node and abort/rollback a distribution</li>
      <li class="out">Serving the weights, choosing when to flip traffic (rollout system)</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Origin egress is limited (single‑digit Gb/s) but per‑rack bandwidth is plentiful</li>
      <li>Integrity: a corrupted or tampered chunk must never be loaded</li>
      <li>Complete 500 GB to 5,000 nodes in ~1–2 h, not days</li>
      <li>Fault tolerant to node churn and slow peers</li>
    </ol>
  </div>
</div>

## Entities and API {#infra-weights-api}

<p>Distribution (version, manifest, state) · Manifest (chunkSize, chunks[{idx, sha256}], merkleRoot, signature) · Node (id, rack, zone, bitmap) · Chunk</p>
<pre><code>POST /distributions {version, manifestUrl}          -&gt; distributionId   (operator)
GET  /distributions/:id/manifest                     -&gt; signed manifest
POST /tracker/announce {nodeId, rack, bitmap}        -&gt; [peers with bitmaps]   (every 30 s)
GET  peer:port/chunks/:idx                           -&gt; bytes                   (node ↔ node)
GET  /distributions/:id/progress                     -&gt; {done, inProgress, failed[]}</code></pre>

## Design {#infra-weights-design}

<figure>
<svg viewBox="0 0 980 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Weights distribution: manifest with per-chunk hashes; origin seeds a few nodes; tracker knows which nodes have which chunks; nodes pull rarest chunks first from peers, prefer same-rack peers; verify each chunk">
  <defs><marker id="w1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="w2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:11px;fill:#5B6673}.tm{font-size:10.5px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#w1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#w2);stroke-dasharray:2 4}.lbl{font-size:11px;fill:#1F4E9E}.lbla{font-size:11px;fill:#B45309}</style>
  <rect class="box" x="20" y="30" width="180" height="90"></rect><text class="tb" x="110" y="50" text-anchor="middle">Manifest (signed)</text><text class="tm" x="30" y="68">version: v42</text><text class="tm" x="30" y="82">chunk_size: 64MB</text><text class="tm" x="30" y="96">chunks: [{idx, sha256}] ×8000</text><text class="tm" x="30" y="110">root_hash (merkle)</text>
  <rect class="box" x="20" y="150" width="180" height="60" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="tb" x="110" y="172" text-anchor="middle">Origin (S3 / seeders)</text><text class="ts" x="110" y="190" text-anchor="middle">serves a few nodes only</text><text class="ts" x="110" y="204" text-anchor="middle">rate‑limited</text>
  <rect class="box" x="260" y="90" width="150" height="70" stroke="#B45309"></rect><text class="tb" x="335" y="112" text-anchor="middle">Tracker</text><text class="ts" x="335" y="130" text-anchor="middle">node → chunk bitmap</text><text class="ts" x="335" y="144" text-anchor="middle">rack/zone of each node</text>
  <g>
    <rect class="box" x="480" y="30" width="120" height="44"></rect><text class="tb" x="540" y="48" text-anchor="middle">node A</text><text class="tm" x="540" y="66" text-anchor="middle">1111100000</text>
    <rect class="box" x="480" y="94" width="120" height="44"></rect><text class="tb" x="540" y="112" text-anchor="middle">node B</text><text class="tm" x="540" y="130" text-anchor="middle">0011111000</text>
    <rect class="box" x="480" y="158" width="120" height="44"></rect><text class="tb" x="540" y="176" text-anchor="middle">node C</text><text class="tm" x="540" y="194" text-anchor="middle">0000011111</text>
    <rect class="box" x="480" y="222" width="120" height="44"></rect><text class="tb" x="540" y="240" text-anchor="middle">node D (new)</text><text class="tm" x="540" y="258" text-anchor="middle">0000000000</text>
  </g>
  <text class="ts" x="620" y="48">rack 1</text><text class="ts" x="620" y="112">rack 1</text><text class="ts" x="620" y="176">rack 2</text><text class="ts" x="620" y="240">rack 2</text>
  <rect class="box" x="700" y="60" width="260" height="170"></rect><text class="tb" x="710" y="80">Node download loop</text>
  <text class="ts" x="710" y="98">1 fetch manifest, verify signature</text><text class="ts" x="710" y="112">2 ask tracker: who has what</text><text class="ts" x="710" y="126">3 pick rarest chunk among peers</text><text class="ts" x="710" y="140">4 prefer same‑rack peer (top‑of‑rack bw)</text><text class="ts" x="710" y="154">5 N parallel streams, per‑chunk sha256</text><text class="ts" x="710" y="168">6 write to local NVMe, announce bitmap</text><text class="ts" x="710" y="182">7 bad hash → drop, re‑pull from other peer</text><text class="ts" x="710" y="196">8 done when bitmap full + root hash ok</text><text class="ts" x="710" y="214">keep seeding for a window after done</text>
  <path class="f" d="M200 180 L478 60"></path><text class="lbl" x="300" y="200">seed first wave</text>
  <path class="fa" d="M410 120 L478 118"></path><path class="fa" d="M600 244 C 640 244, 650 200, 600 190"></path><text class="lbla" x="612" y="270">D pulls from C (same rack)</text>
  <path class="f" d="M480 244 C 440 244, 440 60, 478 52" stroke-dasharray="4 3"></path><text class="lbl" x="420" y="260">rare chunk from A</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 712" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Weights distribution flow">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="5" y="14" width="130" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Operator</text>
<line class="ln" x1="70" y1="48" x2="70" y2="692"></line>
<rect class="sb" x="173" y="14" width="130" height="34"></rect><text class="st" x="238" y="36" text-anchor="middle">Origin/S3</text>
<line class="ln" x1="238" y1="48" x2="238" y2="692"></line>
<rect class="sb" x="341" y="14" width="130" height="34"></rect><text class="st" x="406" y="36" text-anchor="middle">Tracker</text>
<line class="ln" x1="406" y1="48" x2="406" y2="692"></line>
<rect class="sb" x="509" y="14" width="130" height="34"></rect><text class="st" x="574" y="36" text-anchor="middle">Node D (new)</text>
<line class="ln" x1="574" y1="48" x2="574" y2="692"></line>
<rect class="sb" x="677" y="14" width="130" height="34"></rect><text class="st" x="742" y="36" text-anchor="middle">Peer C (same rack)</text>
<line class="ln" x1="742" y1="48" x2="742" y2="692"></line>
<rect class="sb" x="845" y="14" width="130" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Peer A</text>
<line class="ln" x1="910" y1="48" x2="910" y2="692"></line>
<line class="a1" x1="78" y1="80" x2="230" y2="80"></line>
<text class="sl" x="154" y="74" text-anchor="middle">upload weights + signed manifest</text>
<line class="a1" x1="78" y1="114" x2="398" y2="114"></line>
<text class="sl" x="238" y="108" text-anchor="middle">create distribution</text>
<line class="a1" x1="246" y1="148" x2="902" y2="148"></line>
<text class="sl" x="574" y="142" text-anchor="middle">seed first wave (rate-limited)</text>
<line class="a1" x1="902" y1="182" x2="414" y2="182"></line>
<text class="sl" x="658" y="176" text-anchor="middle">announce bitmap</text>
<line class="a1" x1="566" y1="216" x2="246" y2="216"></line>
<text class="sl" x="406" y="210" text-anchor="middle">fetch manifest, verify signature</text>
<line class="a1" x1="566" y1="250" x2="414" y2="250"></line>
<text class="sl" x="490" y="244" text-anchor="middle">announce empty bitmap</text>
<line class="a2" x1="414" y1="284" x2="566" y2="284"></line>
<text class="sl" x="490" y="278" text-anchor="middle">peers + bitmaps + rack tags</text>
<rect class="nt" x="464" y="305" width="220" height="22"></rect><text class="sl" x="574" y="320" text-anchor="middle">pick rarest chunk, prefer same rack</text>
<line class="a1" x1="582" y1="352" x2="734" y2="352"></line>
<text class="sl" x="658" y="346" text-anchor="middle">GET chunk 17</text>
<line class="a2" x1="734" y1="386" x2="582" y2="386"></line>
<text class="sl" x="658" y="380" text-anchor="middle">bytes</text>
<rect class="nt" x="498" y="407" width="152" height="22"></rect><text class="sl" x="574" y="422" text-anchor="middle">sha256 ok → write NVMe</text>
<line class="a1" x1="582" y1="454" x2="902" y2="454"></line>
<text class="sl" x="742" y="448" text-anchor="middle">GET rare chunk 902</text>
<line class="a2" x1="902" y1="488" x2="582" y2="488"></line>
<text class="sl" x="742" y="482" text-anchor="middle">bytes</text>
<line class="a3" x1="566" y1="522" x2="414" y2="522"></line>
<text class="sl" x="490" y="516" text-anchor="middle">announce updated bitmap (30 s)</text>
<rect class="nt" x="479" y="543" width="190" height="22"></rect><text class="sl" x="574" y="558" text-anchor="middle">bitmap full + merkle root ok</text>
<line class="a3" x1="566" y1="590" x2="414" y2="590"></line>
<text class="sl" x="490" y="584" text-anchor="middle">complete; keep seeding</text>
<line class="a1" x1="78" y1="624" x2="398" y2="624"></line>
<text class="sl" x="238" y="618" text-anchor="middle">progress query</text>
<line class="a2" x1="398" y1="658" x2="78" y2="658"></line>
<text class="sl" x="238" y="652" text-anchor="middle">done / in progress / failed</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Operator → Origin/S3:</b> upload weights + signed manifest</li>
  <li><b>Operator → Tracker:</b> create distribution</li>
  <li><b>Origin/S3 → Peer A:</b> seed first wave (rate-limited)</li>
  <li><b>Peer A → Tracker:</b> announce bitmap</li>
  <li><b>Node D (new) → Origin/S3:</b> fetch manifest, verify signature</li>
  <li><b>Node D (new) → Tracker:</b> announce empty bitmap</li>
  <li><b>Tracker → Node D (new):</b> peers + bitmaps + rack tags (response)</li>
  <li><b>Node D (new):</b> pick rarest chunk, prefer same rack</li>
  <li><b>Node D (new) → Peer C (same rack):</b> GET chunk 17</li>
  <li><b>Peer C (same rack) → Node D (new):</b> bytes (response)</li>
  <li><b>Node D (new):</b> sha256 ok → write NVMe</li>
  <li><b>Node D (new) → Peer A:</b> GET rare chunk 902</li>
  <li><b>Peer A → Node D (new):</b> bytes (response)</li>
  <li><b>Node D (new) → Tracker:</b> announce updated bitmap (30 s) (async)</li>
  <li><b>Node D (new):</b> bitmap full + merkle root ok</li>
  <li><b>Node D (new) → Tracker:</b> complete; keep seeding (async)</li>
  <li><b>Operator → Tracker:</b> progress query</li>
  <li><b>Tracker → Operator:</b> done / in progress / failed (response)</li>
</ol>

## How it works, step by step {#infra-weights-flow}

<ol class="order">
  <li>Operator uploads weights to origin, generates manifest (chunk hashes + Merkle root), signs it, creates the distribution.</li>
  <li>Origin seeds the first wave: a few nodes per rack pull chunks directly, rate‑limited.</li>
  <li>Every node announces its bitmap to the tracker every ~30 s and receives peers, with rack/zone tags.</li>
  <li>Node picks the rarest chunk it lacks among reachable peers, preferring same‑rack, pulls N in parallel, verifies SHA‑256 before writing.</li>
  <li>On a bad hash it discards, marks that peer bad for that chunk, and re‑pulls elsewhere.</li>
  <li>When the bitmap is full and the Merkle root matches, the node reports complete and keeps seeding for a window.</li>
  <li>Progress endpoint aggregates bitmaps; abort deletes the distribution and nodes stop serving that version.</li>
</ol>

## Deep dives {#infra-weights-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/infra-weights/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
  <div><h4>Mechanisms</h4><ul>
    <li><b>Chunk</b> 32–128 MB; per‑chunk SHA‑256 in a signed manifest; Merkle root for whole‑file verification. Chunks are independently verifiable and resumable.</li>
    <li><b>Swarm (BitTorrent‑style):</b> every downloader is an uploader. Origin seeds a handful; tracker (or gossip/DHT) maps chunks → holders.</li>
    <li><b>Rarest‑first</b> selection so the swarm doesn't converge on the same popular chunks and starve the rest; endgame mode requests the last chunks from multiple peers.</li>
    <li><b>Topology awareness:</b> prefer same‑rack, then same‑zone; cap cross‑zone streams. Bandwidth is per top‑of‑rack switch, not global.</li>
    <li><b>Tree alternative:</b> origin → 10 tier‑1 → 100 tier‑2 → all. Simpler, deterministic, but a slow tier‑1 node stalls its subtree; swarm routes around stragglers.</li></ul></div>
  <div><h4>Numbers to say</h4><ul>
    <li>Swarm completes in ~O(log N) "rounds" of file‑size/bandwidth: 500 GB at 10 Gb/s ≈ 7 min per round, ×~13 for 5,000 nodes ≈ 1.5 h vs. 23 days.</li>
    <li>Parallel streams per node 8–16; per‑peer upload cap so no node saturates.</li>
    <li>Prefetch weights <em>before</em> the rollout flips traffic (ties to the rollout design).</li></ul></div>
  <div><h4>Failure modes</h4><ul>
    <li>Corrupt chunk: hash fails, ban the peer for that chunk, re‑pull.</li>
    <li>Tracker down: nodes keep peer lists; gossip fills in; tracker is stateless enough to rebuild from announces.</li>
    <li>Origin overload: hard cap origin connections; swarm carries the load after the first wave.</li>
    <li>Thundering herd at rollout: stagger node start times with jitter.</li>
    <li>Tools that do this: Uber Kraken, Dragonfly, Facebook's torrent‑based deploys.</li></ul></div>
</div>

## Don't leave the room without saying {#infra-weights-check}

<ul class="checklist">
  <li>Origin math: bytes × nodes ÷ egress = days; peers must serve peers</li>
  <li>Chunk 32–128 MB, hash per chunk, signed manifest, Merkle root</li>
  <li>Rarest‑first and endgame mode; why not sequential</li>
  <li>Rack/zone locality and per‑peer upload caps</li>
  <li>Resume from bitmap; late joiners; keep seeding after done</li>
  <li>Tree vs swarm trade‑off and why swarm handles stragglers</li>
  <li>Tracker is soft state; gossip fallback</li>
</ul>

## What each level is expected to drive {#infra-weights-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Chunk + hash + parallel download from origin; resume by chunk</td><td>Peer‑to‑peer, tracker</td></tr>
  <tr><td>Senior</td><td>Swarm with tracker, rarest‑first, locality, integrity; origin/egress math</td><td>Endgame, gossip fallback, tree alternative</td></tr>
  <tr><td>Staff+</td><td>All of it plus rollout integration (prefetch before flip), abuse/tamper model, capacity of top‑of‑rack, operational tooling; cites Kraken/Dragonfly</td><td>—</td></tr>
</tbody></table>
