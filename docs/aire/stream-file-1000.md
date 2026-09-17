---
title: "Stream a large file to 1000 hosts as fast as possible"
slug: /aire/stream-file-1000
sidebar_position: 26
sidebar_label: "Stream a large file to 1000 hosts as fas…"
description: "medium · bandwidth math · pipelined chain vs tree vs swarm · the origin is never the answer"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/stream-file-1000/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

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


## Scale, performance and safety targets {#sf-targets}

<p>This question is won or lost on arithmetic. State the numbers, then let them eliminate the topologies that cannot work.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> essentially one operation — but it moves F × 1000 bytes. At F = 500 GB that is 500 TB of transfer, which is why "how many requests" is the wrong question and "how many bytes cross which link" is the right one.</li>
    <li><b>Data volume:</b> 500 GB in ~8,000 chunks of 64 MB, delivered to 1,000 hosts. Control traffic — manifests, progress, chunk hashes — is a few MB total and never the constraint.</li>
    <li><b>Growth:</b> both F and host count grow, and the naive origin‑fan‑out time grows as their product — which is precisely why the topology, not the bandwidth purchase, is the answer.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> the metric is wall‑clock to the <em>last</em> host, not the first. Direct fan‑out is F×n/B — at 10 Gb/s and 500 TB, about 5 days. A pipelined chain is ≈ F/B + n·c/B, roughly 7 minutes plus a small per‑hop term: three orders of magnitude, from topology alone.</li>
    <li><b>Throughput:</b> every host must saturate both its inbound and outbound link simultaneously, since forwarding while receiving is the entire trick. Rack uplinks, not host NICs, are usually the real ceiling.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the threats are structural rather than adversarial — a saturated origin, a rack uplink congested to the point of harming unrelated traffic, and a compromised host in the chain serving altered bytes to everyone downstream of it.</li>
    <li><b>Rate limiting:</b> a hard cap on origin connections, per‑host send rate limits so forwarding never starves the host's own workload, and a cap on cross‑rack streams to protect shared uplinks.</li>
    <li><b>Data sensitivity:</b> the payload is usually proprietary — model weights or a build artifact. Authenticate every peer, encrypt in transit, and sign the manifest so a relay host cannot substitute content it is merely forwarding.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> not a service — the requirement is that a single slow or dead host cannot restart or stall the transfer. With 1,000 hosts, at least one failing mid‑transfer is the expected case, not the exception.</li>
    <li><b>Degraded mode:</b> a stalled relay is spliced out and its downstream re‑parented within seconds. Origin lost after seeding → the chain completes anyway. A host that misses the window rejoins at the tail and pulls from any peer that already has the data.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> trivially strong, because the artifact is immutable — every host either has the verified file or does not. There is nothing to reconcile, which is what makes aggressive peer‑to‑peer forwarding safe here.</li>
    <li><b>Durability:</b> the origin holds the only copy that must survive; every host copy is reproducible, so a wiped host simply re‑pulls.</li>
    <li><b>Integrity:</b> per‑chunk hashes under a signed manifest plus a final root hash. With bytes passing through up to 1,000 intermediaries, verifying at every hop is not optional — one corrupt relay would otherwise poison everything behind it.</li></ul></div>
</div>

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

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/stream-file-1000/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

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
  <li><b>Coordinator:</b> compute chain/tree order by rack + measured bandwidth.
    Order is computed from topology and measured throughput, not from a host list — neighbours within a rack are connected by a top‑of‑rack switch, while crossing racks consumes a shared uplink.
    Slow hosts are placed near the tail so they cannot become a bottleneck that every host behind them inherits.
    This planning step is cheap and is worth more than any transfer optimisation that follows.</li>
  <li><b>Coordinator → Origin:</b> start: manifest (chunk size, hashes, root).
    The manifest is computed once and signed: a hash per 64 MB chunk plus a Merkle root over all of them.
    Per‑chunk hashes are what allow verification to happen as bytes stream, rather than only after a 500 GB file has fully landed.</li>
  <li><b>Coordinator → Host 1:</b> your upstream = origin; downstream = host 2.
    Each host is told only its immediate neighbours, so there is no global state for a host to hold or get wrong.
    Purely local knowledge is also what makes repair cheap: fixing a break means rewriting two pointers, not recomputing a plan.</li>
  <li><b>Coordinator → Host 2:</b> upstream = host 1; downstream = host 3.
    The same instruction shape for every host means one code path, and a chain that can be re‑spliced anywhere without special cases.</li>
  <li><b>Origin → Host 1:</b> chunk 1.
    The origin sends the file <em>once</em>, to one host. Its total upload is F, not F×1000 — which is the single decision that turns 5 days into minutes.
    Any design where the origin's egress scales with host count has already lost, regardless of how it is tuned.</li>
  <li><b>Host 1:</b> verify hash, write NVMe, keep in RAM ring buffer.
    Verification happens before forwarding, so a corrupt chunk stops at the first host instead of propagating down 999 hops.
    The RAM ring buffer is what makes this streaming rather than store‑and‑forward: bytes leave for the next host while later chunks are still arriving, and the disk write happens in parallel.
    Waiting for the full file before forwarding would multiply total time by the number of hops — this buffer is the difference between a pipeline and a relay race.</li>
  <li><b>Host 1 → Host 2:</b> chunk 1 (forward immediately).
    Forwarding starts after one chunk, not one file, so the pipeline fills in seconds and every host is transmitting almost immediately.
    This is precisely why the word "stream" in the question is a hint rather than decoration.</li>
  <li><b>Origin → Host 1:</b> chunk 2.
    Host 1 is now receiving and sending simultaneously, saturating both directions of its link — full‑duplex use is what keeps the steady‑state rate equal to B rather than B/2.</li>
  <li><b>Host 1 → Host 2:</b> chunk 2.
    In steady state every host in the chain is doing exactly this, so aggregate throughput is n×B while the origin contributes only B.</li>
  <li><b>Host 2 → Host k…1000:</b> chunk 1 …
    The pipeline fills hop by hop; host k starts receiving after roughly k chunk‑times, which is the small additive n·c/B term.
    Because c (chunk size) is tiny relative to F, that fill cost is minutes at worst — the chain is nearly as fast as a single copy.</li>
  <li><b>Host k…1000:</b> each host: receive, verify, forward, write, all concurrent.
    Every host runs identical logic with no role distinction, so there is no special "root" or "leaf" code to maintain.
    Verifying at every hop means corruption is localised to one link rather than inherited by an entire subtree.</li>
  <li><b>Host 2 → Coordinator:</b> progress: chunks received (every 5 s) (async).
    Progress reporting is off the data path, so a slow or unavailable coordinator delays repair rather than stopping the transfer.
    Per‑host progress is also the only way stragglers become visible before they become the reason the transfer is late.</li>
  <li><b>Coordinator:</b> host 2 stalled? (no progress in T).
    With 1,000 hosts, a failure mid‑transfer is expected, so stall detection is a normal control loop rather than an exception handler.
    The timeout is seconds: in a chain, one stalled host stops everything downstream of it, so detection latency is directly transfer latency.</li>
  <li><b>Coordinator → Repair path:</b> splice: host 3 pulls from host 1 (or swarm peer) (async).
    Repair is a local rewiring — host 3's upstream becomes host 1 — and the chain closes over the failure in seconds.
    Host 3 resumes from its last verified chunk, so nothing already transferred is repeated.
    This is the chain's main weakness made survivable, and it is exactly the weakness a swarm avoids structurally by having many sources.</li>
  <li><b>Repair path → Coordinator:</b> host 2 marked bad; reinserted at tail later (response).
    A recovered host rejoins at the tail, where being slow costs nobody else anything.
    Never re‑inserting it mid‑chain is deliberate: a host that failed once is the last thing you want between 998 hosts and their data.</li>
  <li><b>Host k…1000 → Coordinator:</b> all chunks + root hash ok → done (async).
    Per‑chunk hashes proved each piece; the root hash proves the host assembled the right pieces of the right file.
    Only then does a host count as complete, so "done" means verified rather than merely finished.</li>
  <li><b>Coordinator:</b> done when all 1000 report; total ≈ F/B + n·c/B.
    The formula is the answer to the question: one file‑time to push F once, plus a small pipeline‑fill term proportional to hops and chunk size.
    Compare aloud with direct fan‑out (F·n/B, days) and a k‑ary tree (F/B · log_k n, better but still multiplicative) to show why pipelining wins.
    Say the trade‑off too: a chain is optimal and fragile, a tree is robust and slower, a swarm is fastest under churn and hardest to reason about.</li>
</ol>

## Deep dives {#sf-deepdives}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/stream-file-1000/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

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


## Trade-offs {#sf-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Topology</td><td>Pipelined chain</td><td>Fragility — one stalled host blocks everything behind it</td><td>A tree when host failure is frequent and repair latency is worse than the extra hops; a swarm when churn is constant</td></tr>
  <tr><td>Forwarding</td><td>Stream: forward each chunk on arrival</td><td>RAM for a ring buffer, and verification on the hot path</td><td>Store‑and‑forward is simpler but multiplies total time by the number of hops — it turns minutes into hours</td></tr>
  <tr><td>Origin's role</td><td>Send the file exactly once</td><td>No fallback if the single seed path fails early</td><td>Seed two or three hosts for redundancy; seeding all of them is the design that takes five days</td></tr>
  <tr><td>Chunk size</td><td>64 MB</td><td>Coarse retry granularity, and a larger pipeline‑fill term</td><td>Smaller chunks fill the pipeline faster and cost more per‑chunk overhead; the fill term is n·c/B, so c matters most when n is large</td></tr>
  <tr><td>Failure handling</td><td>Splice out and re‑parent</td><td>A coordinator that must detect stalls quickly</td><td>A swarm needs no splicing because every host has many potential sources — the structural answer to the same problem</td></tr>
  <tr><td>Verification</td><td>Per chunk at every hop</td><td>Hashing cost on every host, on the critical path</td><td>Never skip it — with up to 1,000 intermediaries, one corrupt relay would otherwise poison every host behind it</td></tr>
  <tr><td>Ordering</td><td>Sequential chunks along the chain</td><td>No opportunistic fetching of whatever is available</td><td>Rarest‑first is better under churn, but needs a swarm and a tracker; in a chain, order is already optimal</td></tr>
</tbody></table>

## Safety-first design {#sf-safety}

<div class="cards">
  <div><h4>Verify before you forward</h4><ul>
    <li><b>Hash every chunk at every hop.</b> A relay that passes on bytes it has not verified poisons everything downstream of it.</li>
    <li><b>Signed manifest.</b> The hash list is trustworthy even though the hosts relaying it are not necessarily so.</li>
    <li><b>Root hash before "done".</b> Chunk hashes prove the pieces; only the root proves you assembled the right file.</li>
    <li><b>Authenticate peers.</b> Every host both receives from and sends to another machine, so mutual authentication is what stops an outsider from injecting itself into the chain.</li></ul></div>
  <div><h4>Never take out the network you run on</h4><ul>
    <li><b>Origin sends the file once.</b> There is no configuration in which 1,000 hosts can stampede the origin, because none of them ever talk to it.</li>
    <li><b>Respect rack uplinks.</b> Chain order follows topology so most transfers stay within a rack and shared uplinks are crossed a bounded number of times.</li>
    <li><b>Cap forwarding rate.</b> A host relaying at full line rate can starve whatever else it is running; the transfer must not damage the service.</li>
    <li><b>Abort is available.</b> The coordinator can stop the whole transfer in one action, which matters when a distribution is discovered to be wrong.</li></ul></div>
  <div><h4>Assume hosts will fail mid-transfer</h4><ul>
    <li><b>Detect in seconds.</b> In a chain, detection latency is transfer latency for everyone downstream — so stall timeouts are tight and progress is continuous.</li>
    <li><b>Repair locally.</b> Splicing rewrites two pointers; nothing is recomputed, and nothing already transferred is repeated.</li>
    <li><b>Resume, never restart.</b> Hosts continue from their last verified chunk, so a failure costs one chunk rather than a file.</li>
    <li><b>Failed hosts rejoin at the tail.</b> A host that stalled once is never put back between everyone else and their data.</li></ul></div>
</div>

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
