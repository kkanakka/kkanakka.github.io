---
title: "GPU cluster scheduler and training checkpointing at thousands of GPUs"
slug: /aire/infra-gpu
sidebar_position: 36
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


## Scale, performance and safety targets {#infra-gpu-targets}

<p>State these numbers before designing anything. Every choice below — gang scheduling, checkpoint cadence, manifest‑last — is justified against one of them.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> the control plane is low‑QPS, high‑stakes: ~2,000 job submissions/day, a few hundred scheduling decisions per minute, but each decision commits 512 GPUs for days.</li>
    <li><b>Data volume:</b> 8,000 GPUs across ~1,000 nodes; a 512‑rank job checkpointing 2 GB/rank every 5 min is ~1 TB per checkpoint, ~300 TB/day of checkpoint writes cluster‑wide.</li>
    <li><b>Growth:</b> GPU count roughly 2× annually and model state per rank grows faster than that — assume checkpoint bytes grow 3× a year and size the object store and NVMe accordingly.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> placement decision p50 &lt; 1 s, p99 &lt; 10 s for a 512‑GPU gang; checkpoint stall (GPU→host copy) p99 &lt; 3 s; restore of a 512‑rank job p99 &lt; 5 min.</li>
    <li><b>Throughput:</b> sustain ~40 GB/s aggregate checkpoint upload without starving the training fabric, and keep GPU utilization above 85% while doing it.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the attack surface is internal — a team submitting thousands of tiny jobs to fragment the cluster, a job that never checkpoints and so can never be preempted, or a runaway that pins GPUs forever. Defend with admission control, mandatory checkpoint contracts and max job lifetime.</li>
    <li><b>Rate limiting:</b> per‑team GPU quota (e.g. 25% of cluster), max in‑flight jobs per team, submission rate cap, and a cap on preemptions a single job may cause per hour.</li>
    <li><b>Data sensitivity:</b> checkpoints <em>are</em> the model — the most sensitive artifact in the company. Encrypt at rest, scope read access per job with short‑lived credentials, never log shard URLs, and retain only the last N checkpoints plus tagged milestones (e.g. 30 days rolling).</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> scheduler control plane 99.9% (~8.8 h/year). It does not need four nines because it is not on the training data path — but checkpoint durability does.</li>
    <li><b>Degraded mode:</b> if the scheduler is down, running jobs keep training and keep checkpointing; only new placements and preemptions pause. If S3 is unavailable, fall back to NVMe‑only checkpoints and alarm on the lost durability rather than stalling training.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Durability:</b> eleven nines for checkpoints in object storage; NVMe copies are a latency cache, never the system of record.</li>
    <li><b>Consistency:</b> strong and atomic for the checkpoint manifest — it is the linearization point, and a reader must never see a half‑written checkpoint. Placement state can be eventually consistent and rebuilt from node heartbeats.</li>
    <li><b>Compliance:</b> model weights are often export‑controlled; the scheduler must keep an audit trail of who ran what on which data, and region‑pin checkpoints where the training data requires it.</li></ul></div>
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
  <li><b>Team → Scheduler:</b> submit job: 512 GPUs, same spine.
    The request declares a <em>shape</em>, not a list of machines — GPU count, topology constraint, priority, team, and how often it will checkpoint.
    Declaring the checkpoint contract up front matters: a job that cannot checkpoint cannot be preempted safely, so it is admitted under different rules.
    Admission control also checks the team's quota here, before the job is ever queued.</li>
  <li><b>Scheduler:</b> priority + fair-share queue.
    Jobs are ordered by priority first, then by how far the team is below its fair share, so a big team cannot starve a small one simply by submitting more.
    The queue is deliberately not FIFO: a 512‑GPU job may wait while 8‑GPU jobs slot into gaps, because holding GPUs idle to build a large gang wastes more than it saves.
    Aging pushes long‑waiting jobs up so fairness does not become permanent starvation.</li>
  <li><b>Scheduler → Cluster nodes:</b> find all-or-nothing placement.
    The search is for N free GPUs that also satisfy the fabric constraint: whole nodes first (NVLink inside a node is ~10× the bandwidth of the network between them), then same rack, then same spine.
    It is all‑or‑nothing because a distributed job with 511 of 512 ranks placed makes zero progress while burning 511 GPUs.
    This is the single most important scheduling property to name in an interview: gang scheduling, not incremental allocation.</li>
  <li><b>Cluster nodes → Scheduler:</b> no fit: reserve slots, backfill small jobs (response).
    When the gang does not fit, the scheduler reserves the slots it has found so they are not nibbled away by newer small jobs, and sets a deadline.
    Into the resulting bubble it backfills jobs short enough to finish before the reservation matures — free utilization with no delay to the big job.
    Without backfill, reservations are pure idle time, and fragmentation quietly costs 15–20% of the cluster.</li>
  <li><b>Scheduler → Job ranks:</b> preempt low-prio: checkpoint then evict.
    Preemption is never a kill: the scheduler asks the victim to checkpoint, waits for a valid manifest, and only then evicts.
    That converts "lose hours of training" into "lose the seconds since the last step", which is what makes preemption politically acceptable at all.
    A victim that misses its checkpoint deadline is killed anyway — otherwise a badly behaved job becomes unpreemptable and holds the cluster hostage.</li>
  <li><b>Scheduler → Job ranks:</b> launch gang.
    All ranks start together with a shared rendezvous address, world size and rank IDs; the collectives library will not form a communicator until every rank arrives.
    A launch barrier with a timeout catches the common failure where one node is slow or unhealthy, so the job fails fast instead of hanging in NCCL init.
    The placement is recorded so a later restart can prefer the same topology.</li>
  <li><b>Job ranks:</b> train; step K reached.
    Checkpoint cadence is derived from failure math, not taste: expected lost work is roughly interval/2, and cluster MTBF is node MTBF ÷ node count.
    At a thousand nodes something fails every few hours, so a 5‑minute interval keeps expected loss near 2.5 minutes.
    Checkpointing on a step boundary — not a wall‑clock timer — keeps every rank's state mutually consistent.</li>
  <li><b>Job ranks:</b> snapshot GPU → host RAM (ms), resume training.
    This is the only part that stalls training: a device‑to‑host copy of weights and optimizer state, measured in milliseconds to a couple of seconds.
    Training resumes immediately afterwards; everything downstream happens against the host‑RAM copy, in the background.
    This one trick is what turns checkpointing from a multi‑minute stall into &lt;1% of training time.</li>
  <li><b>Job ranks → Local NVMe:</b> write shard rank-N (background).
    Each rank writes only its own slice of weights and optimizer state — no gather to rank 0, which would push terabytes through a single node's NIC.
    NVMe first because it absorbs the write at local speed and gives a fast restart path for transient failures.
    The shard is hashed as it is written, so integrity is established before it ever leaves the machine.</li>
  <li><b>Local NVMe → S3:</b> upload shard.
    The object store is the durable copy and the one that survives losing the node entirely; NVMe is only a cache in front of it.
    Uploads are rate‑limited and staggered across ranks so 512 simultaneous writers do not saturate the same top‑of‑rack uplink the training traffic needs.
    Each shard is content‑addressed by step and rank, so a retry is idempotent.</li>
  <li><b>S3 → Job ranks:</b> ack (response).
    The ack plus the shard hash is the rank's proof that its slice is durable — a write that returned but cannot be verified is treated as a failure.
    Ranks report acks to rank 0 rather than to the scheduler, keeping the control plane off the checkpoint hot path.</li>
  <li><b>Job ranks → Manifest:</b> rank 0: all acks + hashes → write manifest LAST.
    The manifest lists every shard path and hash for this step, and writing it last is what makes the checkpoint atomic.
    Readers trust a checkpoint only if its manifest exists and every hash verifies, so a crash midway leaves garbage shards that nobody will ever restore from.
    This is the cheapest possible substitute for a distributed transaction across 512 independent writers.</li>
  <li><b>Local NVMe → S3:</b> straggler: retry from NVMe (async).
    One slow rank must not sink the whole checkpoint, so unacked shards are retried from the local copy while the others wait.
    Because NVMe already holds the bytes, a retry costs an upload, not another training stall.
    Persistent stragglers are a signal in their own right — usually a failing NIC or disk on that node.</li>
  <li><b>Job ranks → Manifest:</b> timeout → checkpoint invalid; previous manifest is restore point.
    If the retries do not finish inside the deadline, no manifest is written and this step simply never becomes a checkpoint.
    The previous complete checkpoint remains the restore point, so the failure mode is "lose one interval", never "restore something corrupt".
    Repeated invalid checkpoints should page someone — the job is silently losing its durability guarantee.</li>
  <li><b>Cluster nodes → Scheduler:</b> node failure (async).
    Health comes from heartbeats plus hardware signals: ECC errors, NCCL timeouts, falling per‑rank step time, thermal throttling.
    Detection latency is part of lost work, so the timeouts are seconds, not minutes.
    One dead node kills the whole gang, which is exactly why gang scheduling and cheap restarts must be designed together.</li>
  <li><b>Scheduler → Job ranks:</b> restart from latest complete manifest.
    The scheduler re‑places the gang — preferring the previous topology — and hands the job the newest manifest that fully verifies.
    Restart is normal operation at this scale, not an exception path, so it is instrumented and measured like any other latency.
    If the world size changed because a node is gone, a resharding step converts the old shards to the new rank layout.</li>
  <li><b>Job ranks → S3:</b> each rank reads its shard (parallel).
    Restore is a parallel read: 512 ranks each pull their own shard, so recovery time is bounded by per‑node bandwidth, not by the total checkpoint size.
    Each shard's hash is checked against the manifest before it is loaded, so a corrupted object is caught before it poisons training.
    If the NVMe copy survived on a reused node, the read is local and finishes in seconds.</li>
  <li><b>Cluster nodes → Scheduler:</b> ECC/NCCL errors → fence node (async).
    A node showing memory errors or collective timeouts is drained and taken out of the schedulable pool automatically, before it can poison the next job.
    Quarantine is the right default because a marginal GPU produces slow, silently wrong training rather than a clean crash.
    Nodes return to the pool only after a diagnostic burn‑in passes, and repeat offenders are sent to repair.</li>
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


## Trade-offs {#infra-gpu-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Placement</td><td>Gang scheduling: all ranks or none</td><td>Utilization — reserved slots sit idle while the gang assembles</td><td>Never for synchronous training; incremental placement is fine for elastic/embarrassingly parallel work</td></tr>
  <tr><td>Making room</td><td>Preempt with a checkpoint, then evict</td><td>Preemption takes minutes, not milliseconds, and the victim loses a little work</td><td>Kill immediately only for jobs that opted out of checkpointing, or when a node must be evacuated for hardware reasons</td></tr>
  <tr><td>Checkpoint layout</td><td>Sharded per rank</td><td>Restoring at a different world size needs a resharding step</td><td>Gather to rank 0 only for small models where the whole state fits comfortably on one node</td></tr>
  <tr><td>Checkpoint timing</td><td>Async: snapshot to host RAM, upload in background</td><td>Host memory headroom, and a window where the newest state is not yet durable</td><td>Synchronous checkpoints when host RAM is the binding constraint or the job cannot tolerate any unflushed state</td></tr>
  <tr><td>Atomicity</td><td>Manifest written last, hashes verified on read</td><td>A checkpoint is wasted entirely if one shard misses the deadline</td><td>Acceptable as is — the alternative, trusting partial checkpoints, risks silently restoring a corrupt model</td></tr>
  <tr><td>Storage tiering</td><td>Two levels: NVMe for speed, object store for durability</td><td>Twice the write path and a cache to operate</td><td>Object store only when local disks are small or node reuse after failure is rare</td></tr>
  <tr><td>Topology</td><td>Strict same‑spine placement</td><td>Longer queue waits; a job may wait for topology it could technically run without</td><td>Relax to "any free GPUs" for small jobs and for debugging runs, where a 3× slowdown is cheaper than a 3‑hour wait</td></tr>
</tbody></table>

## Safety-first design {#infra-gpu-safety}

<div class="cards">
  <div><h4>Protecting the cluster from its users</h4><ul>
    <li><b>Quotas before queues.</b> Per‑team GPU ceilings and in‑flight job caps are enforced at admission, so a bad script cannot flood the queue and starve everyone behind it.</li>
    <li><b>Checkpointing is a contract, not a courtesy.</b> A job that does not produce valid checkpoints is preemptible without warning and capped in lifetime — otherwise "never checkpoint" becomes a strategy for never being evicted.</li>
    <li><b>Bounded preemption.</b> Cap how many preemptions one incoming job may cause per hour so a single high‑priority submission cannot cascade through the whole cluster.</li>
    <li><b>Maximum job lifetime.</b> Every job has a wall‑clock ceiling and must be explicitly renewed, which reclaims GPUs from forgotten runs.</li></ul></div>
  <div><h4>Containing blast radius</h4><ul>
    <li><b>Fence first, diagnose later.</b> A node with ECC errors, NCCL timeouts or degraded step time leaves the schedulable pool immediately; a marginal GPU corrupts training silently, which is worse than a crash.</li>
    <li><b>Never restore something unverified.</b> Hashes are checked against the signed manifest on every shard read, so a corrupt object fails the restore instead of poisoning the model.</li>
    <li><b>The control plane is off the data path.</b> A scheduler outage stops new placements but not training or checkpointing, so the worst case is lost utilization rather than lost work.</li>
    <li><b>Rollback is a restore.</b> Because every checkpoint is immutable and self‑verifying, "go back two hours" is a normal operation, not a recovery project.</li></ul></div>
  <div><h4>Protecting the weights</h4><ul>
    <li><b>Checkpoints are the crown jewels.</b> Encrypted at rest, accessed through short‑lived per‑job credentials scoped to that job's prefix, and never reachable by an unrelated job on the same node.</li>
    <li><b>Least privilege between ranks.</b> A rank can write its own shard and read the manifest; only rank 0 can finalize, which limits what a compromised worker can do.</li>
    <li><b>Audit everything that moves weights.</b> Who submitted, what data, which checkpoints were read and by whom — this is the trail that export‑control and incident review both need.</li>
    <li><b>Retention with intent.</b> Keep the last N checkpoints plus tagged milestones; delete the rest on a schedule, because every stale copy is another thing to protect.</li></ul></div>
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
