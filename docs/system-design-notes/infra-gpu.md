---
title: "GPU cluster scheduler and training checkpointing at thousands of GPUs"
slug: /system-design-notes/infra-gpu
sidebar_position: 20
sidebar_label: "GPU cluster scheduler and training check…"
description: "hard · gang scheduling · fragmentation · async sharded checkpoints · manifest · stragglers"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/infra-gpu/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">hard · gang scheduling · fragmentation · async sharded checkpoints · manifest · stragglers</span>
</header>

## Requirements {#infra-gpu-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Schedule training jobs that need N GPUs simultaneously with topology constraints</li>
      <li>Share the cluster fairly across teams with priorities and preemption</li>
      <li>Checkpoint running jobs frequently with minimal training stall</li>
      <li>Restore from the last complete checkpoint after any failure</li>
      <li class="out">The training framework internals; data loading</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Utilization &gt; 85% of GPUs busy despite fragmentation</li>
      <li>Checkpoint stall &lt; 1% of training time</li>
      <li>Lost work per failure &lt; ~10 min at cluster MTBF of hours</li>
      <li>No partial or corrupted checkpoint ever restored</li>
    </ol>
  </div>
</div>

## Entities and API {#infra-gpu-api}

<p>Job (shape: N GPUs, topology needs, priority, team) · Node (GPUs, rack, fabric, health) · Slot/Reservation · Checkpoint (step, shards[], manifest, hashes) · Shard (rank, path, hash)</p>
<pre><code>POST /jobs {gpus:512, topology:"same_spine", priority, checkpointEvery:"5m"} -&gt; jobId
GET  /jobs/:id  -&gt; {state, placement[], lastCheckpoint}
POST /jobs/:id/preempt   (scheduler internal: checkpoint then evict)
Checkpoint: each rank PUT s3://ckpt/job/step/rank-N.safetensors; rank 0 PUT manifest.json last
Restore:    GET manifest (latest complete) → each rank GET its shard, verify hash</code></pre>

## Design {#infra-gpu-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/infra-gpu/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Left: gang scheduler places all-or-nothing jobs on topology-aware slots, backfills small jobs, defragments by preemption. Right: async sharded checkpointing where each rank writes its shard to local NVMe then uploads to object storage; a completion manifest is written last; stragglers handled by timeout and fallback to previous complete checkpoint">
  <defs><marker id="g1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker></defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.tm{font-size:10.5px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#g1)}.cell{stroke:#1B2430;stroke-width:1}</style>
  <text class="tb" x="20" y="24">Gang scheduling (all‑or‑nothing)</text>
  <g>
    <text class="ts" x="20" y="46">node 1</text><rect class="cell" x="70" y="34" width="18" height="16" fill="#1F4E9E"></rect><rect class="cell" x="90" y="34" width="18" height="16" fill="#1F4E9E"></rect><rect class="cell" x="110" y="34" width="18" height="16" fill="#1F4E9E"></rect><rect class="cell" x="130" y="34" width="18" height="16" fill="#1F4E9E"></rect><rect class="cell" x="150" y="34" width="18" height="16" fill="#1F4E9E"></rect><rect class="cell" x="170" y="34" width="18" height="16" fill="#1F4E9E"></rect><rect class="cell" x="190" y="34" width="18" height="16" fill="#1F4E9E"></rect><rect class="cell" x="210" y="34" width="18" height="16" fill="#1F4E9E"></rect>
    <text class="ts" x="20" y="70">node 2</text><rect class="cell" x="70" y="58" width="18" height="16" fill="#1F4E9E"></rect><rect class="cell" x="90" y="58" width="18" height="16" fill="#1F4E9E"></rect><rect class="cell" x="110" y="58" width="18" height="16" fill="#1F4E9E"></rect><rect class="cell" x="130" y="58" width="18" height="16" fill="#1F4E9E"></rect><rect class="cell" x="150" y="58" width="18" height="16" fill="#1F4E9E"></rect><rect class="cell" x="170" y="58" width="18" height="16" fill="#1F4E9E"></rect><rect class="cell" x="190" y="58" width="18" height="16" fill="#1F4E9E"></rect><rect class="cell" x="210" y="58" width="18" height="16" fill="#1F4E9E"></rect>
    <text class="ts" x="20" y="94">node 3</text><rect class="cell" x="70" y="82" width="18" height="16" fill="#B45309"></rect><rect class="cell" x="90" y="82" width="18" height="16" fill="#B45309"></rect><rect class="cell" x="110" y="82" width="18" height="16" fill="#fff"></rect><rect class="cell" x="130" y="82" width="18" height="16" fill="#fff"></rect><rect class="cell" x="150" y="82" width="18" height="16" fill="#B45309"></rect><rect class="cell" x="170" y="82" width="18" height="16" fill="#fff"></rect><rect class="cell" x="190" y="82" width="18" height="16" fill="#fff"></rect><rect class="cell" x="210" y="82" width="18" height="16" fill="#fff"></rect>
    <text class="ts" x="20" y="118">node 4</text><rect class="cell" x="70" y="106" width="18" height="16" fill="#fff"></rect><rect class="cell" x="90" y="106" width="18" height="16" fill="#B45309"></rect><rect class="cell" x="110" y="106" width="18" height="16" fill="#fff"></rect><rect class="cell" x="130" y="106" width="18" height="16" fill="#fff"></rect><rect class="cell" x="150" y="106" width="18" height="16" fill="#fff"></rect><rect class="cell" x="170" y="106" width="18" height="16" fill="#B45309"></rect><rect class="cell" x="190" y="106" width="18" height="16" fill="#fff"></rect><rect class="cell" x="210" y="106" width="18" height="16" fill="#fff"></rect>
  </g>
  <text class="ts" x="240" y="46">blue: 16‑GPU job, 2 full nodes, NVLink + same leaf switch</text>
  <text class="ts" x="240" y="70">amber: small jobs fragmenting nodes 3–4</text>
  <text class="ts" x="240" y="94">10 free GPUs, but no 8‑GPU job can place → fragmentation</text>
  <text class="ts" x="240" y="118">fix: pack small jobs, backfill, preempt low‑prio to defrag</text>
  <rect class="box" x="20" y="140" width="440" height="140"></rect><text class="tb" x="30" y="160">Scheduler loop</text>
  <text class="ts" x="30" y="178">· queue by priority + fair share per team; jobs declare shape (N GPUs, topology needs)</text>
  <text class="ts" x="30" y="192">· gang: reserve all N slots or none; partial placement deadlocks the cluster</text>
  <text class="ts" x="30" y="206">· topology‑aware: whole nodes, then same rack/spine; RDMA fabric matters more than GPU count</text>
  <text class="ts" x="30" y="220">· backfill: while a big job waits for enough free slots, run small short jobs in the gaps</text>
  <text class="ts" x="30" y="234">· reservations with timeouts so held slots don't idle forever</text>
  <text class="ts" x="30" y="248">· health: fence bad GPUs (ECC errors, NCCL failures) out of the pool automatically</text>
  <text class="ts" x="30" y="266">· preemption checkpoints the victim first (right side), then evicts</text>

  <text class="tb" x="500" y="24">Async sharded checkpointing</text>
  <rect class="box" x="500" y="36" width="100" height="44"></rect><text class="tb" x="550" y="54" text-anchor="middle">rank 0</text><text class="ts" x="550" y="70" text-anchor="middle">shard 0</text>
  <rect class="box" x="610" y="36" width="100" height="44"></rect><text class="tb" x="660" y="54" text-anchor="middle">rank 1</text><text class="ts" x="660" y="70" text-anchor="middle">shard 1</text>
  <rect class="box" x="720" y="36" width="100" height="44"></rect><text class="tb" x="770" y="54" text-anchor="middle">rank …</text><text class="ts" x="770" y="70" text-anchor="middle">shard n</text>
  <rect class="box" x="500" y="100" width="320" height="34" stroke="#0F766E" fill="#DDF3F0"></rect><text class="ts" x="660" y="121" text-anchor="middle">1 copy GPU state → host RAM (ms, training resumes)</text>
  <rect class="box" x="500" y="142" width="320" height="34"></rect><text class="ts" x="660" y="163" text-anchor="middle">2 background: write shard to local NVMe → upload to S3</text>
  <rect class="box" x="500" y="184" width="320" height="34" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="ts" x="660" y="205" text-anchor="middle">3 rank 0 writes manifest {step, shards[], hashes} LAST</text>
  <path class="f" d="M550 80 L550 98"></path><path class="f" d="M660 80 L660 98"></path><path class="f" d="M770 80 L770 98"></path>
  <path class="f" d="M660 134 L660 140"></path><path class="f" d="M660 176 L660 182"></path>
  <rect class="box" x="840" y="36" width="120" height="182"></rect><text class="tb" x="900" y="56" text-anchor="middle">Stragglers</text>
  <text class="ts" x="850" y="76">· manifest only after</text><text class="ts" x="850" y="90">  all shards ack</text>
  <text class="ts" x="850" y="108">· shard upload timeout</text><text class="ts" x="850" y="122">  → retry from NVMe</text>
  <text class="ts" x="850" y="140">· still missing → the</text><text class="ts" x="850" y="154">  checkpoint is invalid;</text><text class="ts" x="850" y="168">  last complete manifest</text><text class="ts" x="850" y="182">  is the restore point</text>
  <text class="ts" x="850" y="200">· never partial restore</text>
  <text class="ts" x="500" y="240">Frequency: interval ≈ √(2 × checkpoint_cost × MTBF). 4,000 GPUs with node MTBF 5 y → cluster MTBF ≈ 11 h;</text>
  <text class="ts" x="500" y="254">if a checkpoint costs 2 min of stall, checkpoint every ~50 min. Async makes cost seconds → checkpoint every few min.</text>
  <text class="ts" x="500" y="272">Restore: every rank reads its shard (parallel); resharding on different world size needs a converter.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 712" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="GPU scheduling and checkpoint flow">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="7" y="14" width="126" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Team</text>
<line class="ln" x1="70" y1="48" x2="70" y2="692"></line>
<rect class="sb" x="147" y="14" width="126" height="34"></rect><text class="st" x="210" y="36" text-anchor="middle">Scheduler</text>
<line class="ln" x1="210" y1="48" x2="210" y2="692"></line>
<rect class="sb" x="287" y="14" width="126" height="34"></rect><text class="st" x="350" y="36" text-anchor="middle">Cluster nodes</text>
<line class="ln" x1="350" y1="48" x2="350" y2="692"></line>
<rect class="sb" x="427" y="14" width="126" height="34"></rect><text class="st" x="490" y="36" text-anchor="middle">Job ranks</text>
<line class="ln" x1="490" y1="48" x2="490" y2="692"></line>
<rect class="sb" x="567" y="14" width="126" height="34"></rect><text class="st" x="630" y="36" text-anchor="middle">Local NVMe</text>
<line class="ln" x1="630" y1="48" x2="630" y2="692"></line>
<rect class="sb" x="707" y="14" width="126" height="34"></rect><text class="st" x="770" y="36" text-anchor="middle">S3</text>
<line class="ln" x1="770" y1="48" x2="770" y2="692"></line>
<rect class="sb" x="847" y="14" width="126" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Manifest</text>
<line class="ln" x1="910" y1="48" x2="910" y2="692"></line>
<line class="a1" x1="78" y1="80" x2="202" y2="80"></line>
<text class="sl" x="140" y="74" text-anchor="middle">submit job: 512 GPUs, same spine</text>
<rect class="nt" x="118" y="101" width="183" height="22"></rect><text class="sl" x="210" y="116" text-anchor="middle">priority + fair-share queue</text>
<line class="a1" x1="218" y1="148" x2="342" y2="148"></line>
<text class="sl" x="280" y="142" text-anchor="middle">find all-or-nothing placement</text>
<line class="a2" x1="342" y1="182" x2="218" y2="182"></line>
<text class="sl" x="280" y="176" text-anchor="middle">no fit: reserve slots, backfill small jobs</text>
<line class="a1" x1="218" y1="216" x2="482" y2="216"></line>
<text class="sl" x="350" y="210" text-anchor="middle">preempt low-prio: checkpoint then evict</text>
<line class="a1" x1="218" y1="250" x2="482" y2="250"></line>
<text class="sl" x="350" y="244" text-anchor="middle">launch gang</text>
<rect class="nt" x="417" y="271" width="146" height="22"></rect><text class="sl" x="490" y="286" text-anchor="middle">train; step K reached</text>
<rect class="nt" x="380" y="305" width="220" height="22"></rect><text class="sl" x="490" y="320" text-anchor="middle">snapshot GPU → host RAM (ms), resume training</text>
<line class="a1" x1="498" y1="352" x2="622" y2="352"></line>
<text class="sl" x="560" y="346" text-anchor="middle">write shard rank-N (background)</text>
<line class="a1" x1="638" y1="386" x2="762" y2="386"></line>
<text class="sl" x="700" y="380" text-anchor="middle">upload shard</text>
<line class="a2" x1="762" y1="420" x2="498" y2="420"></line>
<text class="sl" x="630" y="414" text-anchor="middle">ack</text>
<line class="a1" x1="498" y1="454" x2="902" y2="454"></line>
<text class="sl" x="700" y="448" text-anchor="middle">rank 0: all acks + hashes → write manifest LAST</text>
<line class="a3" x1="638" y1="488" x2="762" y2="488"></line>
<text class="sl" x="700" y="482" text-anchor="middle">straggler: retry from NVMe</text>
<line class="a1" x1="498" y1="522" x2="902" y2="522"></line>
<text class="sl" x="700" y="516" text-anchor="middle">timeout → checkpoint invalid; previous manifest is restore point</text>
<line class="a3" x1="342" y1="556" x2="218" y2="556"></line>
<text class="sl" x="280" y="550" text-anchor="middle">node failure</text>
<line class="a1" x1="218" y1="590" x2="482" y2="590"></line>
<text class="sl" x="350" y="584" text-anchor="middle">restart from latest complete manifest</text>
<line class="a1" x1="498" y1="624" x2="762" y2="624"></line>
<text class="sl" x="630" y="618" text-anchor="middle">each rank reads its shard (parallel)</text>
<line class="a3" x1="342" y1="658" x2="218" y2="658"></line>
<text class="sl" x="280" y="652" text-anchor="middle">ECC/NCCL errors → fence node</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Team → Scheduler:</b> submit job: 512 GPUs, same spine</li>
  <li><b>Scheduler:</b> priority + fair-share queue</li>
  <li><b>Scheduler → Cluster nodes:</b> find all-or-nothing placement</li>
  <li><b>Cluster nodes → Scheduler:</b> no fit: reserve slots, backfill small jobs (response)</li>
  <li><b>Scheduler → Job ranks:</b> preempt low-prio: checkpoint then evict</li>
  <li><b>Scheduler → Job ranks:</b> launch gang</li>
  <li><b>Job ranks:</b> train; step K reached</li>
  <li><b>Job ranks:</b> snapshot GPU → host RAM (ms), resume training</li>
  <li><b>Job ranks → Local NVMe:</b> write shard rank-N (background)</li>
  <li><b>Local NVMe → S3:</b> upload shard</li>
  <li><b>S3 → Job ranks:</b> ack (response)</li>
  <li><b>Job ranks → Manifest:</b> rank 0: all acks + hashes → write manifest LAST</li>
  <li><b>Local NVMe → S3:</b> straggler: retry from NVMe (async)</li>
  <li><b>Job ranks → Manifest:</b> timeout → checkpoint invalid; previous manifest is restore point</li>
  <li><b>Cluster nodes → Scheduler:</b> node failure (async)</li>
  <li><b>Scheduler → Job ranks:</b> restart from latest complete manifest</li>
  <li><b>Job ranks → S3:</b> each rank reads its shard (parallel)</li>
  <li><b>Cluster nodes → Scheduler:</b> ECC/NCCL errors → fence node (async)</li>
</ol>

## How it works, step by step {#infra-gpu-flow}

<ol class="order">
  <li>Jobs enter a priority + fair‑share queue declaring shape and topology requirements.</li>
  <li>Scheduler searches for an all‑or‑nothing placement: whole nodes first, then same rack/spine; if unavailable it reserves slots with a timeout and backfills short jobs into the gaps.</li>
  <li>If a higher‑priority job cannot place, the scheduler preempts lower‑priority victims: trigger a checkpoint, wait for the manifest, then evict.</li>
  <li>Running job checkpoints every K steps: each rank snapshots GPU state to host RAM (training resumes immediately), then uploads its shard to NVMe and S3 in the background.</li>
  <li>Rank 0 waits for all shard acks (with per‑shard timeout and retry from NVMe), verifies hashes, then writes the manifest; only then is the checkpoint valid.</li>
  <li>On failure, the job restarts from the latest complete manifest; ranks restore shards in parallel; a converter reshards if the world size changed.</li>
  <li>Bad GPUs (ECC, NCCL errors, slow step times) are fenced out of the pool automatically.</li>
</ol>

## Deep dives {#infra-gpu-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/infra-gpu/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
  <div><h4>Scheduler: what to say</h4><ul>
    <li>Gang scheduling is required because a distributed training job with 15 of 16 ranks placed makes zero progress while burning 15 GPUs.</li>
    <li>Fragmentation is the central cost problem; the answers are bin‑packing, backfill, defrag via preemption, and shaping jobs to node multiples.</li>
    <li>Topology: NVLink within node, InfiniBand/RDMA across; the scheduler must know the fabric. A "random 64 GPUs" placement can be 3× slower.</li>
    <li>Fair share + priority + preemption‑with‑checkpoint are the levers; quotas per team prevent one team from monopolizing.</li></ul></div>
  <div><h4>Checkpointing: what to say</h4><ul>
    <li>Sharded: each rank saves its own slice of weights + optimizer state; no gather to rank 0 (which would be TBs through one node).</li>
    <li>Async: snapshot to host memory in milliseconds, upload in the background; training stall is the copy, not the upload.</li>
    <li>Manifest written last makes the checkpoint atomic: readers only trust checkpoints with a manifest whose shard hashes verify.</li>
    <li>Two‑level: frequent local/NVMe checkpoints for fast restart on transient failures, less frequent object‑store checkpoints for durability.</li></ul></div>
  <div><h4>Failure math</h4><ul>
    <li>Cluster MTBF = node MTBF / node count. Big clusters fail hourly; checkpoint interval must be well under that.</li>
    <li>Lost work per failure ≈ interval/2 + restore time; restore is dominated by reading shards, so parallel reads from many nodes.</li>
    <li>Straggler detection also applies to the training step itself: a slow rank stalls the all‑reduce; monitor per‑rank step time.</li></ul></div>
</div>

## Don't leave the room without saying {#infra-gpu-check}

<ul class="checklist">
  <li>Gang scheduling and why partial placement deadlocks</li>
  <li>Fragmentation: bin‑pack, backfill, defrag via preemption</li>
  <li>Topology‑aware placement (NVLink / RDMA fabric)</li>
  <li>Sharded, async checkpoints; manifest written last for atomicity</li>
  <li>Straggler handling: timeouts, retry from local, never partial restore</li>
  <li>MTBF ÷ nodes math and the checkpoint‑interval formula</li>
  <li>Two‑level checkpoints: local for speed, object store for durability</li>
</ul>

## What each level is expected to drive {#infra-gpu-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Queue of jobs, allocate GPUs, periodic checkpoint to S3</td><td>Gang semantics, fragmentation</td></tr>
  <tr><td>Senior</td><td>Gang + topology + backfill + preemption; sharded async checkpoints with manifest; MTBF math</td><td>Resharding, two‑level checkpoints</td></tr>
  <tr><td>Staff+</td><td>Utilization vs fairness policy, preemption cost model, checkpoint cadence tuning, straggler and hardware‑health integration, cluster‑wide failure budgets</td><td>—</td></tr>
</tbody></table>
