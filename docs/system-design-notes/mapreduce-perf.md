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

## Job anatomy and knobs {#mapreduce-perf-api}

<p>Map tasks (one per input split, ~128 MB) · Combiner (map‑side pre‑aggregation) · Partitioner (key → reducer) · Shuffle (spill, sort, merge, fetch) · Reduce tasks · Output commit. Knobs: split size, #reducers, combiner, partitioner, compression, memory buffers, speculative execution.</p>
<pre><code>Diagnose: task time histogram (map vs reduce), bytes shuffled per task, reducer input sizes (skew), data-local vs rack-local vs remote map %, GC time, spill count.
Levers:  combiner · map-side join / broadcast small side · partitioner for skew (salting) · #reducers ≈ 1–2× slots · compress map output (LZ4/Snappy) · larger splits · columnar input + predicate pushdown · reuse objects, avoid per-record allocation · speculative execution on</code></pre>

## Design {#mapreduce-perf-design}

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
  <li><b>Engineer → Job history / profiler:</b> pull task timelines, bytes shuffled, locality %</li>
  <li><b>Job history / profiler → Engineer:</b> 60% shuffle, 3 reducers take 5× longer, 40% remote reads (response)</li>
  <li><b>Engineer → Input layout:</b> convert to columnar; bigger splits; co-locate with compute</li>
  <li><b>Input layout → Map stage:</b> data-local maps ↑</li>
  <li><b>Engineer → Map stage:</b> add combiner; reuse objects; broadcast small join side</li>
  <li><b>Map stage → Shuffle:</b> map output bytes ↓ 20×</li>
  <li><b>Engineer → Shuffle:</b> compress map output; raise sort buffer; fewer spills</li>
  <li><b>Engineer → Reduce stage:</b> set reducers ≈ 1.5× slots; salt hot keys</li>
  <li><b>Reduce stage:</b> balanced reducer input; stragglers gone</li>
  <li><b>Engineer → Reduce stage:</b> enable speculative execution for residual slow nodes</li>
  <li><b>Engineer → Job history / profiler:</b> re-profile; iterate on the new largest bar</li>
</ol>

## Deep dives {#mapreduce-perf-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/mapreduce-perf/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
<div><h4>Shuffle</h4><ul><li>Combiner (or map‑side aggregation in Spark) is the single biggest win for aggregations: sum/count/max are associative; average needs (sum, count).</li><li>Compress map output; use a binary, compact serialization; increase sort buffer to avoid multiple spills; ensure enough reducers to parallelize fetch.</li><li>Map‑side joins: broadcast the small table; avoid shuffling the big one. Bucketed/pre‑partitioned inputs let joins skip shuffle entirely.</li></ul></div>
<div><h4>Locality and input</h4><ul><li>Schedule maps on nodes holding the block (HDFS) or in the same zone as the bucket (S3); remote reads can double map time.</li><li>Columnar formats (Parquet/ORC) with predicate and projection pushdown read a fraction of the bytes.</li><li>Small‑files problem: thousands of tiny splits = scheduling overhead; compact them. Too‑large splits = few maps, poor parallelism.</li></ul></div>
<div><h4>Skew and parallelism</h4><ul><li>Skew shows as a few long reducers. Fixes: salt hot keys into K sub‑keys and merge in a second stage; custom partitioner; handle the top‑N hot keys map‑side; sample keys to build range partitions.</li><li>#reducers: too few → long tasks and OOM; too many → tiny outputs and overhead. Start at 1–2× reduce slots; target 1–5 GB input per reducer.</li><li>Speculative execution for hardware stragglers, not for skew (it just duplicates the big task).</li><li>Memory: avoid per‑record allocations, tune JVM heap vs sort buffer, watch GC time in task logs.</li></ul></div></div>

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
