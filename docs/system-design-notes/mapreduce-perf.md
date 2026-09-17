---
title: "Optimize MapReduce performance"
slug: /system-design-notes/mapreduce-perf
sidebar_position: 33
sidebar_label: "Optimize MapReduce performance"
description: "medium · shuffle · data locality · skew · combiners · parallelism"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/mapreduce-perf/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">medium · shuffle · data locality · skew · combiners · parallelism</span>
</header>
<p>A job over terabytes runs too slowly. The framework (Hadoop/Spark‑style) is fixed; you tune the job and the cluster. Nearly every win comes from one of four places: less data crossing the network (shuffle), reading data where it lives (locality), balanced work (skew), and the right amount of parallelism.</p>

## Requirements {#mapreduce-perf-req}

<div class="board">
  <div><h4>Functional</h4><ol>
      <li>Run map → shuffle → reduce over N TB in a target time</li>
      <li>Handle skewed keys and stragglers</li>
      <li>Produce identical output to the unoptimized job</li>
      <li class="out">Changing the algorithm's semantics</li>
  </ol></div>
  <div><h4>Non‑functional</h4><ol>
      <li>Wall clock: e.g. 4 h → &lt; 1 h</li>
      <li>Cluster utilization &gt; 80% during the job</li>
      <li>Fault tolerance: task retry, speculative execution</li>
      <li>Cost: fewer, fuller tasks</li>
  </ol></div>
</div>
<div class="note"><b>Where the time goes:</b> profile first. Typical breakdown of a slow job: 60% shuffle (serialize + spill + network + merge), 20% waiting on a few straggler reducers (skew), 15% map input over the network (bad locality), 5% actual compute. Optimizing the compute is usually last.</div>


## Scale, performance and safety targets {#mapreduce-perf-targets}

<p>This is an optimisation question, so the targets <em>are</em> the answer. Name the baseline, the goal and the budget before touching a single knob.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>Work per run:</b> N TB of input across thousands of map tasks (one per ~128 MB split) and hundreds to thousands of reducers. The job runs on a schedule, so a 4× speed‑up compounds daily.</li>
    <li><b>Data volume:</b> the number that matters is <em>bytes shuffled</em>, not bytes read. A job reading 10 TB and shuffling 8 TB is network‑bound; the same job with a combiner might shuffle 400 GB and finish in a quarter of the time.</li>
    <li><b>Growth:</b> input grows ~2× annually while cluster size does not, so per‑byte efficiency — columnar formats, predicate pushdown, pre‑aggregation — is what keeps the runtime flat.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> the target is wall clock — e.g. 4 h → under 1 h. Because a job finishes only when its slowest reducer does, the p99 task time matters far more than the mean.</li>
    <li><b>Throughput:</b> cluster utilization above 80% <em>for the whole job</em>, not just the map phase. A job that runs at 95% for 40 minutes and then waits 20 minutes on three reducers is a skew problem, not a capacity one.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Correctness hazards:</b> the danger in tuning is changing the answer. A combiner is only valid for commutative and associative operations; salting hot keys requires a second aggregation pass; object reuse produces silently wrong results if a reference escapes the loop.</li>
    <li><b>Rate limiting:</b> resource quotas per job and per queue so one enormous run cannot starve everything else, and caps on speculative execution so duplicate tasks do not consume a third of the cluster.</li>
    <li><b>Data sensitivity:</b> intermediate shuffle data lands on local disks across the cluster and is often overlooked — encrypt it if the input is sensitive, and make sure it is cleaned up when a job is killed rather than only when it succeeds.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> not a service. The requirement is that the optimised job produces <b>byte‑identical output</b> to the unoptimised one — a faster job with different results has not been optimised, it has been broken.</li>
    <li><b>Degraded mode:</b> a lost node re‑runs its tasks from durable input rather than restarting the job. Speculative execution covers slow nodes without a diagnosis. If a tuned configuration underperforms, the previous one is one config change away, because none of this changes the algorithm.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> output commit is atomic per task — a task writes to a temporary location and commits on success, so a retried or speculative task cannot produce duplicate output.</li>
    <li><b>Durability:</b> input is durable and immutable, which is what makes task retry free and the whole fault‑tolerance model work.</li>
    <li><b>Method:</b> profile before tuning, and re‑profile after every change. The typical slow job is 60% shuffle, 20% straggler wait, 15% remote reads and 5% compute — optimising the compute first is the classic wasted week.</li></ul></div>
</div>

## Job anatomy and knobs {#mapreduce-perf-api}

<p>Map tasks (one per input split, ~128 MB) · Combiner (map‑side pre‑aggregation) · Partitioner (key → reducer) · Shuffle (spill, sort, merge, fetch) · Reduce tasks · Output commit. Knobs: split size, #reducers, combiner, partitioner, compression, memory buffers, speculative execution.</p>
<pre><code>Diagnose: task time histogram (map vs reduce), bytes shuffled per task, reducer input sizes (skew), data-local vs rack-local vs remote map %, GC time, spill count.
Levers:  combiner · map-side join / broadcast small side · partitioner for skew (salting) · #reducers ≈ 1–2× slots · compress map output (LZ4/Snappy) · larger splits · columnar input + predicate pushdown · reuse objects, avoid per-record allocation · speculative execution on</code></pre>

## Design {#mapreduce-perf-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/mapreduce-perf/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="MapReduce dataflow with the four optimization points: locality at input, combiner before shuffle, partitioner and salting against skew, reducer parallelism and output">
<defs><marker id="dg1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="dg3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#dg1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#dg3);stroke-dasharray:2 4}.lbl{font-size:10.5px;fill:#1F4E9E}</style>
<rect class="box" x="20" y="80" width="140" height="80" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="tb" x="90" y="98" text-anchor="middle">Input (HDFS/S3)</text>
<text class="ts" x="90" y="114" text-anchor="middle">splits ~128–512 MB</text>
<text class="ts" x="90" y="127" text-anchor="middle">columnar, compressed</text>
<text class="ts" x="90" y="140" text-anchor="middle">predicate pushdown</text>
<rect class="box" x="200" y="80" width="150" height="80"></rect><text class="tb" x="275" y="98" text-anchor="middle">Map tasks</text>
<text class="ts" x="275" y="114" text-anchor="middle">run where data lives</text>
<text class="ts" x="275" y="127" text-anchor="middle">object reuse, no GC churn</text>
<text class="ts" x="275" y="140" text-anchor="middle">emit (k, v)</text>
<rect class="box" x="390" y="80" width="150" height="80" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="465" y="98" text-anchor="middle">Combiner</text>
<text class="ts" x="465" y="114" text-anchor="middle">local pre-aggregate</text>
<text class="ts" x="465" y="127" text-anchor="middle">cuts shuffle 10–100×</text>
<text class="ts" x="465" y="140" text-anchor="middle">must be associative</text>
<rect class="box" x="580" y="80" width="150" height="80" stroke="#B45309"></rect><text class="tb" x="655" y="98" text-anchor="middle">Shuffle</text>
<text class="ts" x="655" y="114" text-anchor="middle">partition → spill → sort</text>
<text class="ts" x="655" y="127" text-anchor="middle">compress LZ4</text>
<text class="ts" x="655" y="140" text-anchor="middle">fetch + merge</text>
<rect class="box" x="770" y="80" width="190" height="80"></rect><text class="tb" x="865" y="98" text-anchor="middle">Reduce tasks</text>
<text class="ts" x="865" y="114" text-anchor="middle">#reducers ≈ slots</text>
<text class="ts" x="865" y="127" text-anchor="middle">skew: salt hot keys</text>
<text class="ts" x="865" y="140" text-anchor="middle">speculative execution</text>
<rect class="box" x="390" y="200" width="340" height="60"></rect><text class="tb" x="560" y="218" text-anchor="middle">Partitioner</text>
<text class="ts" x="560" y="234" text-anchor="middle">hash(key) → reducer; hot keys → key#salt, second pass to merge</text>
<line class="f" x1="160" y1="120" x2="198" y2="120"></line>
<text class="lbl" x="179" y="114" text-anchor="middle">locality</text>
<line class="f" x1="350" y1="120" x2="388" y2="120"></line>
<line class="f" x1="540" y1="120" x2="578" y2="120"></line>
<text class="lbl" x="559" y="114" text-anchor="middle">less data</text>
<line class="f" x1="730" y1="120" x2="768" y2="120"></line>
<line class="fa" x1="560" y1="200" x2="600" y2="160"></line>
<text class="ts" x="20" y="250">Rule: the cheapest byte is the one you never shuffle; the cheapest task is the one that never waits on a straggler.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 474" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Optimizing a slow job">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="5" y="14" width="130" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Engineer</text>
<line class="ln" x1="70" y1="48" x2="70" y2="454"></line>
<rect class="sb" x="173" y="14" width="130" height="34"></rect><text class="st" x="238" y="36" text-anchor="middle">Job history / profiler</text>
<line class="ln" x1="238" y1="48" x2="238" y2="454"></line>
<rect class="sb" x="341" y="14" width="130" height="34"></rect><text class="st" x="406" y="36" text-anchor="middle">Input layout</text>
<line class="ln" x1="406" y1="48" x2="406" y2="454"></line>
<rect class="sb" x="509" y="14" width="130" height="34"></rect><text class="st" x="574" y="36" text-anchor="middle">Map stage</text>
<line class="ln" x1="574" y1="48" x2="574" y2="454"></line>
<rect class="sb" x="677" y="14" width="130" height="34"></rect><text class="st" x="742" y="36" text-anchor="middle">Shuffle</text>
<line class="ln" x1="742" y1="48" x2="742" y2="454"></line>
<rect class="sb" x="845" y="14" width="130" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Reduce stage</text>
<line class="ln" x1="910" y1="48" x2="910" y2="454"></line>
<line class="a1" x1="78" y1="80" x2="230" y2="80"></line>
<text class="sl" x="154" y="74" text-anchor="middle">pull task timelines, bytes shuffled, locality %</text>
<line class="a2" x1="230" y1="114" x2="78" y2="114"></line>
<text class="sl" x="154" y="108" text-anchor="middle">60% shuffle, 3 reducers take 5× longer, 40% remote reads</text>
<line class="a1" x1="78" y1="148" x2="398" y2="148"></line>
<text class="sl" x="238" y="142" text-anchor="middle">convert to columnar; bigger splits; co-locate with compute</text>
<line class="a1" x1="414" y1="182" x2="566" y2="182"></line>
<text class="sl" x="490" y="176" text-anchor="middle">data-local maps ↑</text>
<line class="a1" x1="78" y1="216" x2="566" y2="216"></line>
<text class="sl" x="322" y="210" text-anchor="middle">add combiner; reuse objects; broadcast small join side</text>
<line class="a1" x1="582" y1="250" x2="734" y2="250"></line>
<text class="sl" x="658" y="244" text-anchor="middle">map output bytes ↓ 20×</text>
<line class="a1" x1="78" y1="284" x2="734" y2="284"></line>
<text class="sl" x="406" y="278" text-anchor="middle">compress map output; raise sort buffer; fewer spills</text>
<line class="a1" x1="78" y1="318" x2="902" y2="318"></line>
<text class="sl" x="490" y="312" text-anchor="middle">set reducers ≈ 1.5× slots; salt hot keys</text>
<rect class="nt" x="800" y="339" width="220" height="22"></rect><text class="sl" x="910" y="354" text-anchor="middle">balanced reducer input; stragglers gone</text>
<line class="a1" x1="78" y1="386" x2="902" y2="386"></line>
<text class="sl" x="490" y="380" text-anchor="middle">enable speculative execution for residual slow nodes</text>
<line class="a1" x1="78" y1="420" x2="230" y2="420"></line>
<text class="sl" x="154" y="414" text-anchor="middle">re-profile; iterate on the new largest bar</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Engineer → Job history / profiler:</b> pull task timelines, bytes shuffled, locality %.
    Measurement comes first, always — intuition about where a distributed job spends its time is wrong more often than not.
    The four numbers worth pulling are the task time histogram, bytes shuffled per task, reducer input sizes, and the data‑local versus remote read ratio.
    Each maps to one of the four levers, so the profile directly selects which fix to apply.</li>
  <li><b>Job history / profiler → Engineer:</b> 60% shuffle, 3 reducers take 5× longer, 40% remote reads (response).
    This profile diagnoses three separate problems: a shuffle problem, a skew problem and a locality problem — and only ~5% of the time is actual computation.
    Reading the histogram rather than the average is what surfaces the three slow reducers; a mean task time would have hidden them completely.</li>
  <li><b>Engineer → Input layout:</b> convert to columnar; bigger splits; co-locate with compute.
    Columnar formats with predicate pushdown mean the job reads only the columns and row groups it needs — often a several‑fold reduction before any tuning.
    Larger splits mean fewer, fuller tasks, which cuts scheduling overhead; thousands of tiny tasks spend more time being scheduled than working.
    Co‑location is the cheapest win available: moving compute to data is free, moving terabytes to compute is not.</li>
  <li><b>Input layout → Map stage:</b> data-local maps ↑.
    Locality rising from 60% to 95% removes most of the remote read time without changing a line of job logic.
    This is why layout is addressed before tuning knobs — it changes the physics the rest of the job operates under.</li>
  <li><b>Engineer → Map stage:</b> add combiner; reuse objects; broadcast small join side.
    The combiner is the single highest‑leverage change: pre‑aggregating on the map side means the network carries aggregates instead of raw records.
    It is only valid for commutative and associative operations — applying it to an average or a median silently produces wrong answers, which is worse than a slow job.
    Broadcasting a small join side eliminates that side of the shuffle entirely; object reuse removes per‑record allocation and the GC pressure behind it.</li>
  <li><b>Map stage → Shuffle:</b> map output bytes ↓ 20×.
    A 20× reduction in shuffled bytes attacks the largest bar in the profile directly, and it compounds: less to serialize, less to spill, less to send, less to merge.
    Every subsequent optimisation now operates on a much smaller problem.</li>
  <li><b>Engineer → Shuffle:</b> compress map output; raise sort buffer; fewer spills.
    Compression trades CPU for network, and at these ratios LZ4 or Snappy is almost always the right trade — decompression is far cheaper than the bandwidth it saves.
    A larger sort buffer means fewer spills to disk, and each avoided spill is a full write and re‑read of that data.
    Spill count is the metric to watch: a job spilling several times per task is doing multiples of the necessary I/O.</li>
  <li><b>Engineer → Reduce stage:</b> set reducers ≈ 1.5× slots; salt hot keys.
    Reducer count around 1.5× available slots gives one full wave plus a little slack for stragglers; far more produces scheduling overhead, far fewer leaves the cluster idle.
    Salting appends a random suffix to hot keys so one enormous key spreads across many reducers — and it requires a second aggregation pass to combine the salted partials, which must be stated or the result is wrong.
    Skew is the failure mode that scaling cannot fix: adding machines does nothing when one key is 40% of the data.</li>
  <li><b>Reduce stage:</b> balanced reducer input; stragglers gone.
    With input balanced, the job finishes when the average reducer finishes rather than when the worst one does — and since a job's duration is its slowest task, this is often the largest single win.</li>
  <li><b>Engineer → Reduce stage:</b> enable speculative execution for residual slow nodes.
    Speculative execution launches a duplicate of a straggling task and takes whichever finishes first, covering slow hardware without needing to diagnose it.
    It is a remedy for <em>node</em> problems, not data problems: running it against skew just duplicates the same oversized task and wastes a slot.
    Fixing skew first and speculating second is the right order, and it is worth capping duplicates so they cannot consume a meaningful share of the cluster.</li>
  <li><b>Engineer → Job history / profiler:</b> re-profile; iterate on the new largest bar.
    Optimisation is iterative because fixing the largest bar promotes a different one — a shuffle‑bound job often becomes CPU‑bound afterwards.
    Each round must also verify byte‑identical output, since several of these changes can alter results if applied to the wrong kind of operation.
    Stopping is a decision too: once the profile shows mostly real computation, further tuning is cost without benefit.</li>
</ol>

## Deep dives {#mapreduce-perf-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/mapreduce-perf/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
<div><h4>Shuffle</h4><ul><li>Combiner (or map‑side aggregation in Spark) is the single biggest win for aggregations: sum/count/max are associative; average needs (sum, count).</li><li>Compress map output; use a binary, compact serialization; increase sort buffer to avoid multiple spills; ensure enough reducers to parallelize fetch.</li><li>Map‑side joins: broadcast the small table; avoid shuffling the big one. Bucketed/pre‑partitioned inputs let joins skip shuffle entirely.</li></ul></div>
<div><h4>Locality and input</h4><ul><li>Schedule maps on nodes holding the block (HDFS) or in the same zone as the bucket (S3); remote reads can double map time.</li><li>Columnar formats (Parquet/ORC) with predicate and projection pushdown read a fraction of the bytes.</li><li>Small‑files problem: thousands of tiny splits = scheduling overhead; compact them. Too‑large splits = few maps, poor parallelism.</li></ul></div>
<div><h4>Skew and parallelism</h4><ul><li>Skew shows as a few long reducers. Fixes: salt hot keys into K sub‑keys and merge in a second stage; custom partitioner; handle the top‑N hot keys map‑side; sample keys to build range partitions.</li><li>#reducers: too few → long tasks and OOM; too many → tiny outputs and overhead. Start at 1–2× reduce slots; target 1–5 GB input per reducer.</li><li>Speculative execution for hardware stragglers, not for skew (it just duplicates the big task).</li><li>Memory: avoid per‑record allocations, tune JVM heap vs sort buffer, watch GC time in task logs.</li></ul></div></div>


## Trade-offs {#mapreduce-perf-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Combiner</td><td>Pre‑aggregate on the map side</td><td>Only valid for commutative, associative operations</td><td>Never for averages, medians or anything order‑dependent — a wrong answer arrived at quickly is not an optimisation</td></tr>
  <tr><td>Skew handling</td><td>Salt hot keys, then re‑aggregate</td><td>An extra pass, and more complex job logic</td><td>A custom partitioner is cleaner when the hot keys are known and stable; salting handles the general case</td></tr>
  <tr><td>Shuffle compression</td><td>LZ4/Snappy on map output</td><td>CPU on both sides of the shuffle</td><td>Skip it only when the network is genuinely idle and CPU is the bottleneck — rare in a shuffle‑bound job</td></tr>
  <tr><td>Split size</td><td>Larger splits, fewer tasks</td><td>Coarser retry granularity and less scheduling flexibility</td><td>Smaller splits when tasks fail often or the cluster is heavily shared; thousands of tiny tasks waste more in scheduling than they gain</td></tr>
  <tr><td>Reducer count</td><td>≈ 1.5× available slots</td><td>Some tuning sensitivity as the cluster changes</td><td>More reducers help with skew but add overhead; fewer leave slots idle for the entire reduce phase</td></tr>
  <tr><td>Speculative execution</td><td>On, with a cap</td><td>Duplicate work consuming slots</td><td>Turn it off for jobs with non‑idempotent side effects, and never rely on it to paper over skew</td></tr>
  <tr><td>Object reuse</td><td>Reuse mutable objects in the map loop</td><td>A genuine correctness hazard if a reference escapes</td><td>Skip it when the allocation profile is fine — the GC saving is real but so is the class of bug it introduces</td></tr>
</tbody></table>

## Safety-first design {#mapreduce-perf-safety}

<div class="cards">
  <div><h4>Faster must still mean correct</h4><ul>
    <li><b>Byte‑identical output is the acceptance test.</b> Every optimisation is verified against the unoptimised run, because several of them can silently change results.</li>
    <li><b>Combiners have preconditions.</b> Commutative and associative, or the answer is wrong — and wrong quietly, on a subset of keys.</li>
    <li><b>Salting needs its second pass.</b> Splitting a hot key across reducers produces partial aggregates that must be recombined, which is easy to forget and hard to notice.</li>
    <li><b>Object reuse can leak.</b> A reused buffer whose reference escapes the loop corrupts results in ways that look like data problems rather than code problems.</li></ul></div>
  <div><h4>Measure, then change one thing</h4><ul>
    <li><b>Profile before tuning.</b> The typical slow job is 60% shuffle and 5% compute; optimising the compute first is the classic wasted week.</li>
    <li><b>Read histograms, not averages.</b> A job ends when its slowest task ends, so the mean hides exactly the tasks that matter.</li>
    <li><b>Re‑profile after every change.</b> Fixing the largest bar promotes a different one, and the next fix is rarely the one you planned.</li>
    <li><b>Know when to stop.</b> Once the profile is mostly real computation, further tuning costs engineering time and returns nothing.</li></ul></div>
  <div><h4>One job must not endanger the cluster</h4><ul>
    <li><b>Quotas per job and per queue.</b> A single enormous run must not be able to starve every other tenant of the cluster.</li>
    <li><b>Cap speculative duplicates.</b> Unbounded speculation turns a straggler problem into a capacity problem.</li>
    <li><b>Clean up intermediates on kill.</b> Shuffle data on local disks must be removed when a job is cancelled, not only when it succeeds.</li>
    <li><b>Atomic output commit.</b> Tasks write to a temporary location and commit on success, so retries and speculative duplicates cannot produce doubled output.</li></ul></div>
</div>

## Don't leave the room without saying {#mapreduce-perf-check}

<ul class="checklist">
  <li>Profile first: where is the time (shuffle, skew, locality, compute)?</li>
  <li>Combiner / map‑side aggregation; broadcast joins</li>
  <li>Compress + right‑size sort buffers; fewer spills</li>
  <li>Columnar input, pushdown, split sizing, data locality</li>
  <li>Salting/custom partitioner for skew; speculative execution for stragglers</li>
  <li>Reducer count from data size and slots; iterate with measurements</li>
</ul>

## What each level is expected to drive {#mapreduce-perf-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Add combiner, more reducers, compression</td><td>Skew handling, locality</td></tr>
  <tr><td>Senior</td><td>Diagnoses from task histograms, applies the four levers with numbers, salting for skew, join strategies</td><td>Bucketing, memory tuning</td></tr>
  <tr><td>Staff+</td><td>Reshapes the pipeline (pre‑partitioned inputs, fewer stages, incremental jobs), cost/latency trade‑offs, and knows when MapReduce is the wrong tool</td><td>—</td></tr>
</tbody></table>
