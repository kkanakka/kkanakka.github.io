---
title: "Stream a large file to 1000 hosts as fast as possible"
slug: /system-design-notes/stream-file-1000
sidebar_position: 26
sidebar_label: "Stream a large file to 1000 hosts as fas…"
description: "medium · bandwidth math · pipelined chain vs tree vs swarm · the origin is never the answer"
---
<header>
  
  <span class="tag">medium · bandwidth math · pipelined chain vs tree vs swarm · the origin is never the answer</span>
</header>
<p>One file of size F on an origin with upload bandwidth B; 1000 hosts, each with roughly the same bandwidth; get it to all of them in the minimum time. This is the same family as the weights‑distribution problem, but the interviewer here wants the <b>math and the comparison of topologies</b>, and the word "stream" is a hint: hosts should forward bytes as they arrive, not after they finish.</p>

## Requirements {#sf-requirements}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Every host ends with a byte‑identical, verified copy</li>
      <li>Hosts may join late or fail mid‑transfer; the transfer still completes</li>
      <li>Operator sees progress and can abort</li>
      <li class="out">What the file is used for afterwards</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Minimize wall‑clock time to the last host</li>
      <li>Do not saturate the origin or any single link; respect rack uplinks</li>
      <li>Integrity per chunk; no host loads corrupt bytes</li>
      <li>Robust to a slow or dead host without restarting</li>
    </ol>
  </div>
</div>
<div class="note"><b>Clarify:</b> F and B (say 100 GB, 10 Gb/s = 1.25 GB/s → 80 s to send once). Are hosts symmetric? Same datacenter or WAN? Is multicast available (almost never in cloud)? Is the file already in object storage that can serve many readers? Can hosts talk to each other?</div>

## Entities and API {#sf-entities}

<p>Transfer (id, manifest, topology, state) · Manifest (chunkSize, chunks[{idx, sha256}], rootHash, signature) · Host (id, rack, measured bw, upstream, downstream[], bitmap) · Chunk.</p>
<pre><code>POST /transfers {fileUrl, hosts[], strategy: chain|tree|swarm}     -&gt; transferId
GET  /transfers/:id/plan        -&gt; per-host upstream/downstream assignments
Host agent:  GET upstream:port/chunks/:idx  |  stream socket that forwards as it receives
POST /transfers/:id/progress {hostId, bitmap}   (every few seconds)
GET  /transfers/:id/status      -&gt; {done, slowest, stalled[]}</code></pre>

## The math that decides the design {#sf-math}

<table>
  <tbody><tr><th>Topology</th><th>Time to last host</th><th>With F=100 GB, B=1.25 GB/s, n=1000</th><th>Notes</th></tr>
  <tr><td>Origin sends to each host in turn</td><td>n · F/B</td><td>1000 × 80 s ≈ 22 h</td><td>Origin upload is the bottleneck; hosts' bandwidth unused.</td></tr>
  <tr><td>Origin sends to all in parallel</td><td>n · F/B</td><td>≈ 22 h</td><td>Same total bytes out of one pipe; parallelism doesn't add bandwidth.</td></tr>
  <tr><td>Tree, fan‑out k, whole‑file store‑and‑forward</td><td>k · log_k(n) · F/B</td><td>k=2: 2·10·80 s ≈ 27 min; k=10: 10·3·80 s ≈ 40 min</td><td>Each node splits its upload k ways, and each level waits for the full file. Better, still far from optimal.</td></tr>
  <tr><td><b>Pipelined chain (or tree) with chunks</b></td><td>F/B + (n−1) · c/B</td><td>c=64 MB: 80 s + 999 × 0.05 s ≈ 130 s</td><td>Every host forwards each chunk as soon as it lands. Near the theoretical minimum F/B: every host must receive F bytes over a link of speed B.</td></tr>
  <tr><td>Swarm (BitTorrent‑style)</td><td>≈ F/B · (1 + small overhead)</td><td>≈ 2–5 min in practice</td><td>Same bound, achieved statistically; robust to stragglers, no fixed order.</td></tr>
  <tr><td>Object store fan‑out (S3 + 1000 readers)</td><td>bounded by store egress / per‑prefix throughput</td><td>Often minutes, at significant egress cost</td><td>Works if the store scales; still 1000 × F bytes leave the store.</td></tr>
</tbody></table>
<div class="note"><b>The insight to state:</b> the lower bound is F/B because each host's own download link must carry F bytes. Any design that makes the origin do more than ~F bytes of work is leaving 1000× of aggregate bandwidth on the table. Chunked pipelining gets within (n−1)·c/B of the bound; make c small enough that this term is negligible but big enough that per‑chunk overhead (hash, ack, round trip) isn't.</div>

## Design {#sf-diagram}

<figure>
<svg viewBox="0 0 980 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Pipelined distribution: coordinator computes a rack-aware chain or shallow tree; origin streams chunks to the first hosts; every host forwards each chunk to its downstream while writing it locally; per-chunk hash verification; progress reports to the coordinator; stalled host triggers a splice so its downstream pulls from the next healthy upstream or a swarm peer">
  <defs><marker id="sf1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sf2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.tm{font-size:10.5px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.8;fill:none;marker-end:url(#sf1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#sf2);stroke-dasharray:2 4}.lbl{font-size:10.5px;fill:#1F4E9E}.lbla{font-size:10.5px;fill:#B45309}.pl{fill:none;stroke:#D6DDE5;stroke-dasharray:6 4;rx:8}.pt{font-size:11px;font-weight:700;fill:#5B6673}</style>
  <rect class="box" x="20" y="30" width="150" height="80"></rect><text class="tb" x="95" y="50" text-anchor="middle">Coordinator</text><text class="ts" x="95" y="68" text-anchor="middle">plan: rack‑aware order,</text><text class="ts" x="95" y="82" text-anchor="middle">fastest hosts first</text><text class="ts" x="95" y="96" text-anchor="middle">progress + splice on stall</text>
  <rect class="box" x="20" y="150" width="150" height="60" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="tb" x="95" y="170" text-anchor="middle">Origin</text><text class="ts" x="95" y="188" text-anchor="middle">sends the file ~once</text><text class="ts" x="95" y="202" text-anchor="middle">(k times for tree)</text>
  <rect class="pl" x="200" y="130" width="760" height="110"></rect><text class="pt" x="210" y="148">RACK 1                                                        RACK 2</text>
  <rect class="box" x="220" y="160" width="110" height="60"></rect><text class="tb" x="275" y="180" text-anchor="middle">host 1</text><text class="ts" x="275" y="196" text-anchor="middle">recv · verify · fwd</text><text class="ts" x="275" y="210" text-anchor="middle">ring buffer + NVMe</text>
  <rect class="box" x="360" y="160" width="110" height="60"></rect><text class="tb" x="415" y="180" text-anchor="middle">host 2</text><text class="ts" x="415" y="196" text-anchor="middle">same</text>
  <rect class="box" x="500" y="160" width="110" height="60" stroke="#B45309"></rect><text class="tb" x="555" y="180" text-anchor="middle">host 3 (slow)</text><text class="ts" x="555" y="196" text-anchor="middle">stalls chain</text>
  <rect class="box" x="640" y="160" width="110" height="60"></rect><text class="tb" x="695" y="180" text-anchor="middle">host 4</text><text class="ts" x="695" y="196" text-anchor="middle">spliced upstream</text>
  <rect class="box" x="800" y="160" width="140" height="60"></rect><text class="tb" x="870" y="180" text-anchor="middle">host … 1000</text><text class="ts" x="870" y="196" text-anchor="middle">cross‑rack hop once</text>
  <path class="f" d="M170 190 L218 190"></path><text class="lbl" x="176" y="182">chunks</text>
  <path class="f" d="M330 190 L358 190"></path><path class="f" d="M470 190 L498 190"></path><path class="f" d="M610 190 L638 190" stroke-dasharray="4 3"></path><path class="f" d="M750 190 L798 190"></path>
  <path class="fa" d="M415 160 C 480 110, 640 110, 695 158"></path><text class="lbla" x="500" y="118">splice: host 4 pulls from host 2</text>
  <path class="fa" d="M170 100 C 300 260, 700 280, 870 222"></path><text class="lbla" x="420" y="272">progress bitmaps every few s</text>
  <rect class="box" x="200" y="270" width="760" height="70"></rect><text class="tb" x="210" y="290">Per‑host agent loop, per chunk</text>
  <text class="ts" x="210" y="308">read chunk from upstream socket → sha256 == manifest[idx] ? → write to NVMe + keep in RAM ring → forward to downstream(s) → mark bitmap</text>
  <text class="ts" x="210" y="324">all three (read, write, forward) run concurrently; the ring buffer decouples a slightly slower downstream from the upstream</text>
  <text class="ts" x="210" y="338">bad hash → don't forward; re‑request chunk from upstream (or a peer); bitmap gap is visible to the coordinator</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 678" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Pipelined streaming distribution flow">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="5" y="14" width="130" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Coordinator</text>
<line class="ln" x1="70" y1="48" x2="70" y2="658"></line>
<rect class="sb" x="173" y="14" width="130" height="34"></rect><text class="st" x="238" y="36" text-anchor="middle">Origin</text>
<line class="ln" x1="238" y1="48" x2="238" y2="658"></line>
<rect class="sb" x="341" y="14" width="130" height="34"></rect><text class="st" x="406" y="36" text-anchor="middle">Host 1</text>
<line class="ln" x1="406" y1="48" x2="406" y2="658"></line>
<rect class="sb" x="509" y="14" width="130" height="34"></rect><text class="st" x="574" y="36" text-anchor="middle">Host 2</text>
<line class="ln" x1="574" y1="48" x2="574" y2="658"></line>
<rect class="sb" x="677" y="14" width="130" height="34"></rect><text class="st" x="742" y="36" text-anchor="middle">Host k…1000</text>
<line class="ln" x1="742" y1="48" x2="742" y2="658"></line>
<rect class="sb" x="845" y="14" width="130" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Repair path</text>
<line class="ln" x1="910" y1="48" x2="910" y2="658"></line>
<rect class="nt" x="-40" y="67" width="220" height="22"></rect><text class="sl" x="70" y="82" text-anchor="middle">compute chain/tree order by rack + measured bandwidth</text>
<line class="a1" x1="78" y1="114" x2="230" y2="114"></line>
<text class="sl" x="154" y="108" text-anchor="middle">start: manifest (chunk size, hashes, root)</text>
<line class="a1" x1="78" y1="148" x2="398" y2="148"></line>
<text class="sl" x="238" y="142" text-anchor="middle">your upstream = origin; downstream = host 2</text>
<line class="a1" x1="78" y1="182" x2="566" y2="182"></line>
<text class="sl" x="322" y="176" text-anchor="middle">upstream = host 1; downstream = host 3</text>
<line class="a1" x1="246" y1="216" x2="398" y2="216"></line>
<text class="sl" x="322" y="210" text-anchor="middle">chunk 1</text>
<rect class="nt" x="296" y="237" width="220" height="22"></rect><text class="sl" x="406" y="252" text-anchor="middle">verify hash, write NVMe, keep in RAM ring buffer</text>
<line class="a1" x1="414" y1="284" x2="566" y2="284"></line>
<text class="sl" x="490" y="278" text-anchor="middle">chunk 1 (forward immediately)</text>
<line class="a1" x1="246" y1="318" x2="398" y2="318"></line>
<text class="sl" x="322" y="312" text-anchor="middle">chunk 2</text>
<line class="a1" x1="414" y1="352" x2="566" y2="352"></line>
<text class="sl" x="490" y="346" text-anchor="middle">chunk 2</text>
<line class="a1" x1="582" y1="386" x2="734" y2="386"></line>
<text class="sl" x="658" y="380" text-anchor="middle">chunk 1 …</text>
<rect class="nt" x="632" y="407" width="220" height="22"></rect><text class="sl" x="742" y="422" text-anchor="middle">each host: receive, verify, forward, write, all concurrent</text>
<line class="a3" x1="566" y1="454" x2="78" y2="454"></line>
<text class="sl" x="322" y="448" text-anchor="middle">progress: chunks received (every 5 s)</text>
<rect class="nt" x="-40" y="475" width="220" height="22"></rect><text class="sl" x="70" y="490" text-anchor="middle">host 2 stalled? (no progress in T)</text>
<line class="a3" x1="78" y1="522" x2="902" y2="522"></line>
<text class="sl" x="490" y="516" text-anchor="middle">splice: host 3 pulls from host 1 (or swarm peer)</text>
<line class="a2" x1="902" y1="556" x2="78" y2="556"></line>
<text class="sl" x="490" y="550" text-anchor="middle">host 2 marked bad; reinserted at tail later</text>
<line class="a3" x1="734" y1="590" x2="78" y2="590"></line>
<text class="sl" x="406" y="584" text-anchor="middle">all chunks + root hash ok → done</text>
<rect class="nt" x="-40" y="611" width="220" height="22"></rect><text class="sl" x="70" y="626" text-anchor="middle">done when all 1000 report; total ≈ F/B + n·c/B</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Coordinator:</b> compute chain/tree order by rack + measured bandwidth</li>
  <li><b>Coordinator → Origin:</b> start: manifest (chunk size, hashes, root)</li>
  <li><b>Coordinator → Host 1:</b> your upstream = origin; downstream = host 2</li>
  <li><b>Coordinator → Host 2:</b> upstream = host 1; downstream = host 3</li>
  <li><b>Origin → Host 1:</b> chunk 1</li>
  <li><b>Host 1:</b> verify hash, write NVMe, keep in RAM ring buffer</li>
  <li><b>Host 1 → Host 2:</b> chunk 1 (forward immediately)</li>
  <li><b>Origin → Host 1:</b> chunk 2</li>
  <li><b>Host 1 → Host 2:</b> chunk 2</li>
  <li><b>Host 2 → Host k…1000:</b> chunk 1 …</li>
  <li><b>Host k…1000:</b> each host: receive, verify, forward, write, all concurrent</li>
  <li><b>Host 2 → Coordinator:</b> progress: chunks received (every 5 s) (async)</li>
  <li><b>Coordinator:</b> host 2 stalled? (no progress in T)</li>
  <li><b>Coordinator → Repair path:</b> splice: host 3 pulls from host 1 (or swarm peer) (async)</li>
  <li><b>Repair path → Coordinator:</b> host 2 marked bad; reinserted at tail later (response)</li>
  <li><b>Host k…1000 → Coordinator:</b> all chunks + root hash ok → done (async)</li>
  <li><b>Coordinator:</b> done when all 1000 report; total ≈ F/B + n·c/B</li>
</ol>

## Deep dives {#sf-deepdives}

### 1. Chain vs tree vs swarm: pick by failure tolerance, not by speed

<table>
  <tbody><tr><th></th><th>Pipelined chain</th><th>Pipelined tree (k=2–4)</th><th>Swarm</th></tr>
  <tr><td>Time</td><td>≈ F/B + n·c/B (best)</td><td>≈ k·F/B + depth·c/B (each node uploads k copies)</td><td>≈ F/B + overhead</td></tr>
  <tr><td>Origin load</td><td>1×</td><td>k×</td><td>~1× after first wave</td></tr>
  <tr><td>Slow host</td><td>Stalls everyone downstream until spliced</td><td>Stalls its subtree</td><td>Routed around automatically</td></tr>
  <tr><td>Dead host</td><td>Splice: downstream reconnects to next healthy upstream</td><td>Re‑parent subtree</td><td>Nothing to do</td></tr>
  <tr><td>Complexity</td><td>Lowest: fixed order</td><td>Low</td><td>Tracker, rarest‑first, peer selection</td></tr>
  <tr><td>Pick when</td><td>Homogeneous DC hosts, tight control, absolute fastest</td><td>Want bounded stall blast radius</td><td>Heterogeneous/WAN, churn, don't want to manage order</td></tr>
</tbody></table>
<ul>
  <li>Chain gets the bound because each host uploads exactly F bytes once; a tree with fan‑out k makes each host upload k·F, which divides its uplink by k. So for raw speed, chain wins; tree buys resilience at k× cost; swarm buys resilience with statistical scheduling.</li>
  <li>Hybrid used in practice: a shallow tree (k=2) of chains, rack‑local chains linked by one cross‑rack hop each, and swarm‑style repair for gaps.</li>
</ul>

### 2. Chunk size and pipelining

<ul>
  <li>Pipeline term is (n−1)·c/B; overhead term is per‑chunk (hash + ack + syscall). 16–64 MB chunks put the pipeline term at seconds for n=1000 while keeping overhead trivial. Smaller for WAN (round trips), larger for fewer hosts.</li>
  <li>Each host runs read / verify / write / forward concurrently; a RAM ring buffer of a few chunks absorbs jitter so one slow disk write doesn't block the forward.</li>
  <li>Use several parallel TCP streams per hop or tune window size to the bandwidth‑delay product; a single default TCP connection often can't fill a 10–100 Gb/s link.</li>
</ul>

### 3. Topology awareness

<ul>
  <li>Order hosts so consecutive chain members share a rack: top‑of‑rack bandwidth is plentiful, the spine is the shared bottleneck. One cross‑rack hop per rack, not per host.</li>
  <li>Put hosts with the highest measured bandwidth earliest; a slow host near the head slows everything after it.</li>
  <li>Multi‑datacenter: one chain per DC, each DC's head fed by the origin (or by the previous DC's tail); WAN links carry the file once.</li>
</ul>

### 4. Integrity and failure handling

<ul>
  <li>Signed manifest with per‑chunk SHA‑256 and a Merkle root; every host verifies before forwarding so corruption doesn't propagate. Whole‑file verification at the end.</li>
  <li>Stall detection: no bitmap progress for T seconds → coordinator splices: the stalled host's downstream reconnects to the stalled host's upstream (chain) or to any peer with the missing chunks (swarm‑style repair). The stalled host is reinserted at the tail if it recovers.</li>
  <li>Late joiners attach at the tail and pull from the last host or from any completed host.</li>
  <li>Restart: hosts keep bitmaps on disk; a resumed transfer requests only missing chunks.</li>
</ul>

### 5. Other levers

<ul>
  <li>Compress if the file compresses (weights: little; logs/text: a lot); compress once at origin, hosts forward compressed bytes and decompress locally off the hot path.</li>
  <li>IP multicast would make this one send, but it's unavailable in most cloud networks and unreliable; mention and move on.</li>
  <li>If the file is in object storage that scales (S3, GCS), 1000 parallel range readers can be fast, but you pay 1000×F egress and hit per‑prefix throughput limits; still worth it as the seed for the first few hosts.</li>
</ul>

## Don't leave the room without saying {#sf-checklist}

<ul class="checklist">
  <li>Lower bound is F/B; origin‑centric designs are n× worse</li>
  <li>Chunk and pipeline: forward each chunk as it arrives; time ≈ F/B + n·c/B</li>
  <li>Chain fastest, tree k× origin/host upload, swarm most robust; hybrid in practice</li>
  <li>Chunk size trades pipeline latency vs per‑chunk overhead; ring buffer decouples stages</li>
  <li>Rack‑aware ordering; one cross‑rack hop per rack; fastest hosts first</li>
  <li>Per‑chunk hashes, verify before forward, signed manifest, Merkle root</li>
  <li>Stall detection and splice; late joiners at the tail; resume from bitmap</li>
  <li>Parallel streams / BDP tuning to fill fat links</li>
  <li>Multicast unavailable; object‑store fan‑out costs egress</li>
</ul>

## What each level is expected to drive {#sf-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Chunking, parallel downloads, checksums, a tree so the origin isn't the bottleneck</td><td>Pipelining, the F/B bound</td></tr>
  <tr><td>Senior</td><td>Bandwidth math for each topology, pipelined chain/tree, chunk sizing, rack awareness, integrity, stall/splice handling</td><td>Swarm mechanics, BDP tuning</td></tr>
  <tr><td>Staff+</td><td>States the lower bound first and derives the design from it; chooses topology by failure model; hybrid tree‑of‑chains with repair; operational concerns (progress, abort, resume, heterogeneous hosts, multi‑DC)</td><td>—</td></tr>
</tbody></table>
