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

## What "weights" are, and why a tracker {#infra-weights-primer}

<p>Two things trip people up before the design even starts: what exactly is being copied, and why a swarm needs a directory at all. Both answers drive every decision below.</p>

<div class="cards">
  <div><h4>What "weights" are</h4><ul>
    <li><b>A trained model is a pile of numbers.</b> Training produces billions of learned parameters — the weights — serialized as a handful of tensor shards (safetensors / GGUF) plus the tokenizer and config. For a frontier model that is hundreds of GB, not a few hundred MB.</li>
    <li><b>They are immutable per version.</b> Once v42 is published its bytes never change; there is no write path, no reconciliation, no conflict. That is precisely what makes them safe to chunk, hash, cache and serve peer‑to‑peer.</li>
    <li><b>Nothing serves until the file is local.</b> A replica cannot emit a single token until the whole blob is on local NVMe and loaded into GPU HBM. So distribution sits on the critical path of every launch and every rollback — minutes here are minutes of stale model in production.</li>
    <li><b>The size is the whole problem.</b> 500 GB × 5,000 nodes is 2.5 PB of copying. At single‑digit Gb/s of origin egress that is ~23 days, which is why the fleet cannot simply download from S3.</li></ul></div>
  <div><h4>Why we need a tracker</h4><ul>
    <li><b>Peers must serve peers, so someone must know who has what.</b> The moment nodes stop pulling from origin and start pulling from each other, every node needs an answer to "who currently holds chunk 4,217?" The tracker is that directory: node → chunk bitmap, refreshed by announces.</li>
    <li><b>Rarest‑first needs global counts.</b> To avoid the swarm converging on the same popular chunks while rare ones sit on one about‑to‑reboot node, a node must know how many holders each chunk has. That count only exists if bitmaps are aggregated somewhere.</li>
    <li><b>Locality needs topology.</b> A chunk from the same rack costs ToR bandwidth; the same chunk cross‑zone costs scarce, billed capacity. The tracker tags each node with rack/zone so peers can be ranked by distance, not just availability.</li>
    <li><b>It is soft state, never the data path.</b> Bytes flow node ↔ node; the tracker only brokers introductions. Every node re‑announces its full bitmap every ~30 s, so a tracker that restarts rebuilds itself within one announce interval, and while it is down nodes keep transferring from the peer lists they already hold.</li></ul></div>
</div>

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


## Scale, performance and safety targets {#infra-weights-targets}

<p>Say these numbers out loud before drawing anything — the swarm, the rarest‑first rule and the manifest all fall out of them.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> the tracker handles ~5,000 nodes announcing every 30 s ≈ 170 announce/s, plus peer‑list queries — tiny. The bytes, not the requests, are the scale problem.</li>
    <li><b>Data volume:</b> 500 GB per version in ~8,000 chunks of 64 MB, delivered to 5,000 nodes = 2.5 PB of transfer per release; bitmaps are ~1 KB per node, so all of "who has what" is ~5 MB of state.</li>
    <li><b>Growth:</b> model size is growing faster than fleet size — assume weights roughly 2–3× per year and node count ~2×, so plan for 5–10 PB per release within two years.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> fleet‑wide completion p50 &lt; 1 h, p99 &lt; 2 h, hard ceiling 4 h; a late‑joining single node should reach 100% in &lt; 20 min because the swarm already holds every chunk.</li>
    <li><b>Throughput:</b> ~700 GB/s aggregate across the swarm at peak, while origin egress stays pinned under its single‑digit Gb/s cap and per‑peer upload never crowds out serving traffic.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the threat is a malicious or compromised peer serving tampered weights, a node claiming chunks it does not have to attract connections, and accidental self‑DDoS of the origin at rollout time. Signed manifests, per‑chunk hashes and origin connection caps cover all three.</li>
    <li><b>Rate limiting:</b> hard cap on concurrent origin connections (tens, not thousands), per‑peer upload cap so no node saturates its NIC, 8–16 in‑flight chunk requests per downloader, and an announce floor of ~30 s.</li>
    <li><b>Data sensitivity:</b> weights are proprietary and often export‑controlled, not user data — no PII, but the confidentiality bar is high. Encrypt in transit between peers, authenticate peers with short‑lived fleet credentials, and delete superseded versions on a schedule.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> tracker 99.9% is plenty because it is off the data path; origin availability matters only during the first wave. The real target is "no release blocked by distribution", measured per rollout.</li>
    <li><b>Degraded mode:</b> tracker down → nodes keep transferring using the peer lists they already hold, and gossip fills gaps. Origin down after seeding → the swarm completes anyway. Swarm starved → fall back to slow, rate‑limited direct pulls from origin and accept a much longer completion.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Durability:</b> eleven nines at origin; the swarm is a delivery mechanism, never the system of record, so any node can be wiped and refilled.</li>
    <li><b>Consistency:</b> immutable versions make this easy — a node has v42 completely or it does not have it. Tracker state is deliberately eventually consistent and rebuilt from announces.</li>
    <li><b>Compliance:</b> region‑pin where weights may travel, keep an audit trail of which node fetched which version, and make deletion of a revoked version verifiable across the fleet.</li></ul></div>
</div>

## Entities and API {#infra-weights-api}

<p>Distribution (version, manifest, state) · Manifest (chunkSize, chunks[{idx, sha256}], merkleRoot, signature) · Node (id, rack, zone, bitmap) · Chunk</p>
<pre><code>POST /distributions {version, manifestUrl}          -&gt; distributionId   (operator)
GET  /distributions/:id/manifest                     -&gt; signed manifest
POST /tracker/announce {nodeId, rack, bitmap}        -&gt; [peers with bitmaps]   (every 30 s)
GET  peer:port/chunks/:idx                           -&gt; bytes                   (node ↔ node)
GET  /distributions/:id/progress                     -&gt; {done, inProgress, failed[]}</code></pre>

## Design {#infra-weights-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/infra-weights/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

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
  <li><b>Operator → Origin/S3:</b> upload weights + signed manifest.
    The weights go up once as immutable object‑store blobs — v42's bytes never change after this moment.
    The manifest is generated alongside them: chunk size, a SHA‑256 per 64 MB chunk, and a Merkle root over the whole list.
    It is signed with the release key, so a node can trust the hash list even when the bytes themselves arrive from an untrusted peer.</li>
  <li><b>Operator → Tracker:</b> create distribution.
    This registers {version, manifestUrl} and opens the swarm; until it exists no node will pull anything, which is what makes publishing an explicit, auditable act.
    The tracker allocates the per‑distribution state — the node → bitmap table — and starts accepting announces.
    It is also the abort handle: deleting the distribution is how an operator stops 5,000 nodes at once.</li>
  <li><b>Origin/S3 → Peer A:</b> seed first wave (rate-limited).
    Origin serves only a handful of nodes, a few per rack, behind a hard connection cap, because its egress is the one resource that cannot be scaled by adding nodes.
    Seeds need not each take the whole file — different seeds pull different chunk ranges, so the swarm collectively holds 100% of the file far sooner than any single node does.
    After this wave origin is deliberately off the data path; peers carry the remaining ~99% of the bytes.</li>
  <li><b>Peer A → Tracker:</b> announce bitmap.
    A bitmap is one bit per chunk — 8,000 chunks is 1 KB — so "who has what" is cheap enough to ship whole rather than as deltas.
    This first announce is what makes A discoverable; before it, no one knows A holds anything worth asking for.
    The announce carries A's rack and zone too, which is what lets the tracker answer locality questions later.</li>
  <li><b>Node D (new) → Origin/S3:</b> fetch manifest, verify signature.
    The manifest is a few hundred KB, so every node can take it straight from origin without denting egress.
    D verifies the signature before anything else: an unsigned or mismatched manifest means abort, not download.
    From here on the manifest — not any peer, and not the tracker — is D's sole authority on what correct bytes look like.</li>
  <li><b>Node D (new) → Tracker:</b> announce empty bitmap.
    D announces all zeros: it is a pure leecher right now, but it joins the swarm through exactly the same call a seeder uses.
    A node that restarted mid‑download announces its partial bitmap instead, which is the entire resume mechanism — no separate protocol, no checkpoint negotiation.
    That works because the bitmap is persisted on local disk next to the chunks it describes.</li>
  <li><b>Tracker → Node D (new):</b> peers + bitmaps + rack tags (response).
    D gets a subset of peers — tens, not thousands — with their bitmaps, which is enough to compute what is rare and what is near.
    Rack and zone tags come with it, because the real cost of a chunk depends far more on where a peer sits than on who it is.
    This response is the reason the tracker exists: it turns "500 GB from somewhere" into a ranked list of concrete, reachable sources.</li>
  <li><b>Node D (new):</b> pick rarest chunk, prefer same rack.
    Rarest‑first: count holders per chunk across the peer set and fetch the lowest count first, so scarce chunks replicate before the one node holding them reboots.
    Among the peers that do hold the chosen chunk, prefer same rack — ToR bandwidth is plentiful, cross‑zone is scarce and billed.
    D keeps 8–16 such requests in flight rather than walking chunks one at a time, and switches to endgame mode (ask several peers for the last few chunks) at the tail.</li>
  <li><b>Node D (new) → Peer C (same rack):</b> GET chunk 17.
    A plain ranged HTTP GET against the peer's chunk server — no bespoke protocol, just an offset and a length.
    Same rack means the transfer rides the top‑of‑rack switch and spends none of the cross‑zone budget.
    C applies its own per‑peer upload cap, so serving D never starves C's own download or its serving traffic.</li>
  <li><b>Peer C (same rack) → Node D (new):</b> bytes (response).
    64 MB moves node‑to‑node and origin sees none of it — this substitution is what turns a 23‑day copy into a 1–2 h one.
    If C stalls or dies mid‑stream, D simply re‑requests that chunk from another holder; only the in‑flight chunk is lost, never the download.</li>
  <li><b>Node D (new):</b> sha256 ok → write NVMe.
    The chunk is hashed and compared against the signed manifest before it is trusted, so a corrupt or tampered chunk can never reach the model loader.
    A bad hash means: discard the bytes, mark that peer bad for that chunk, re‑pull elsewhere — cheap, because the blast radius is one chunk.
    On success D sets the bit and can immediately serve chunk 17 to others; a downloader becomes an uploader from its first verified chunk, not at 100%.</li>
  <li><b>Node D (new) → Peer A:</b> GET rare chunk 902.
    Not every chunk has a same‑rack holder, so for rare ones D deliberately reaches across racks or zones.
    Fetching the rare chunk early and then seeding it locally is what stops a whole rack from queueing behind one distant holder.</li>
  <li><b>Peer A → Node D (new):</b> bytes (response).
    Same verify‑then‑write path: where a chunk came from has no bearing on how much it is trusted.
    Once written, chunk 902 is no longer rare inside D's rack, and D's neighbours can now source it locally instead of crossing the fabric again.</li>
  <li><b>Node D (new) → Tracker:</b> announce updated bitmap (30 s) (async).
    The periodic re‑announce is both progress reporting and a liveness heartbeat — a node that stops announcing simply ages out of other nodes' peer lists.
    It is off the data path, so a slow or missing tracker delays peer discovery but never stalls transfers already in flight.
    5,000 nodes × ~1 KB every 30 s is negligible traffic, which is why full bitmaps can be sent instead of diffs.</li>
  <li><b>Node D (new):</b> bitmap full + merkle root ok.
    Every chunk already passed its own hash; the Merkle root is the final check that D assembled the right chunks, in the right order, of the right version.
    Only now is v42 considered present on this node and safe for the rollout system to load and flip traffic onto.</li>
  <li><b>Node D (new) → Tracker:</b> complete; keep seeding (async).
    D stays a seeder for a window after finishing, because late joiners, restarted nodes and replaced hardware still need sources.
    Leaving the swarm the instant it finishes would push the fleet's tail back onto origin — exactly the bottleneck the whole design exists to avoid.</li>
  <li><b>Operator → Tracker:</b> progress query.
    The tracker already holds every node's bitmap, so progress is a fold over state it has rather than a fresh fleet‑wide poll.
    This is what makes stragglers visible: a node stuck at 40% after an hour is a bad disk or a bad NIC, not a slow swarm.</li>
  <li><b>Tracker → Operator:</b> done / in progress / failed (response).
    Returns the counts plus the specific failing node IDs, which is the input to "wait", "replace the node", or "abort".
    Abort deletes the distribution: nodes stop pulling and serving v42, and the rollout never gets the green light to flip traffic to it.</li>
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


## Trade-offs {#infra-weights-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Topology</td><td>Swarm: every downloader is an uploader</td><td>Non‑deterministic transfer paths, harder to reason about and debug</td><td>A fixed distribution tree when the fleet is small and homogeneous and predictability matters more than tail latency</td></tr>
  <tr><td>Chunk selection</td><td>Rarest‑first</td><td>Chunks arrive out of order, so nothing is usable until the whole file lands</td><td>Sequential when the consumer can stream the file as it arrives; here it cannot, so rarest‑first is strictly better</td></tr>
  <tr><td>Chunk size</td><td>64 MB</td><td>Coarse retry granularity — a failure wastes up to 64 MB</td><td>Smaller chunks on lossy or long‑haul links; larger when manifest size and per‑request overhead start to dominate</td></tr>
  <tr><td>Peer discovery</td><td>Central tracker with bitmaps</td><td>A component to run, and a soft dependency at join time</td><td>Gossip or a DHT when you cannot operate a tracker, or at a fleet size where the bitmap table stops fitting comfortably in memory</td></tr>
  <tr><td>Integrity</td><td>Per‑chunk SHA‑256 under a signed manifest</td><td>Hashing cost on every chunk, and a signing key to manage</td><td>Never relax it — unverified bytes from an untrusted peer is the entire risk of running a swarm</td></tr>
  <tr><td>Locality</td><td>Prefer same rack, then same zone</td><td>Rare chunks can bottleneck behind a single distant holder</td><td>Ignore topology only in small, flat networks where every link is equivalent</td></tr>
  <tr><td>After completion</td><td>Keep seeding for a window</td><td>Disk and bandwidth held longer than strictly needed</td><td>Stop immediately only if late joiners are impossible — otherwise the tail of the fleet falls back onto origin</td></tr>
</tbody></table>

## Safety-first design {#infra-weights-safety}

<div class="cards">
  <div><h4>Never load a byte you cannot prove</h4><ul>
    <li><b>Trust the manifest, not the peer.</b> The signature is verified before any chunk is requested, so the hash list is trustworthy even when every peer is not.</li>
    <li><b>Verify at chunk granularity.</b> A bad hash costs one 64 MB re‑pull and a note that this peer is bad for this chunk — the blast radius of a tampered or corrupt chunk is as small as it can be.</li>
    <li><b>Merkle root as the final gate.</b> Per‑chunk hashes prove each piece; the root proves you assembled the right pieces of the right version before anything is loaded onto a GPU.</li>
    <li><b>Fail closed.</b> An unsigned, expired or mismatched manifest aborts the distribution rather than degrading to "download anyway".</li></ul></div>
  <div><h4>Protecting the origin and the network</h4><ul>
    <li><b>Hard connection cap at origin.</b> The first wave is a fixed, small number of nodes; there is no configuration in which 5,000 nodes can stampede S3.</li>
    <li><b>Per‑peer upload caps.</b> A node serving its neighbours must never starve its own download or, worse, the inference traffic it is also serving.</li>
    <li><b>Jitter at rollout.</b> Node start times are staggered so a fleet‑wide release does not become a synchronized thundering herd.</li>
    <li><b>Respect the fabric.</b> Same‑rack preference and a cap on cross‑zone streams keep the expensive, shared links out of the critical path.</li></ul></div>
  <div><h4>Operating safely</h4><ul>
    <li><b>Abort is a first‑class operation.</b> Deleting the distribution stops 5,000 nodes from pulling and serving a version — the kill switch for a bad or revoked release.</li>
    <li><b>Progress is visible per node.</b> Aggregated bitmaps make stragglers obvious, so a bad NIC surfaces as a slow node rather than as a mysterious rollout delay.</li>
    <li><b>Distribution is decoupled from activation.</b> Nodes prefetch weights long before the rollout flips traffic, so a slow copy never turns into user‑visible downtime.</li>
    <li><b>Authenticated peers only.</b> Chunk servers require short‑lived fleet credentials, so an outsider cannot join the swarm to harvest weights or poison it.</li></ul></div>
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
