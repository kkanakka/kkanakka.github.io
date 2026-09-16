---
title: "Scale a batch image‑processing pipeline"
slug: /system-design-notes/image-pipeline
sidebar_position: 31
sidebar_label: "Scale a batch image‑processing pipeline"
description: "medium · queues · workers · retries · idempotency · backpressure"
---
<header>
  
  <span class="tag">medium · queues · workers · retries · idempotency · backpressure</span>
</header>
<p>Millions of images per day need resizing, format conversion, moderation scoring, thumbnails. The existing single‑machine cron script can't keep up. Turn it into a queue‑driven pipeline that scales horizontally, survives failures, and never produces duplicate or missing outputs.</p>

## Requirements {#image-pipeline-req}

<div class="board">
  <div><h4>Functional</h4><ol>
      <li>Ingest jobs (image ref + operations) from uploads and backfills</li>
      <li>Run a DAG of steps per image: decode → resize/convert → score → thumbnail</li>
      <li>Store outputs, record status, notify completion</li>
      <li>Reprocess a subset (new size) without redoing everything</li>
      <li class="out">Real‑time editing UI</li>
  </ol></div>
  <div><h4>Non‑functional</h4><ol>
      <li>10M images/day ≈ 115/s average, 1K/s peak; backfills of 100M</li>
      <li>p95 job latency &lt; 60 s for uploads; backfill best‑effort</li>
      <li>At‑least‑once execution, exactly‑once effect (idempotent outputs)</li>
      <li>Poison images can't block the pipeline; retries bounded</li>
      <li>Cost: workers autoscale to zero at night</li>
  </ol></div>
</div>
<div class="note"><b>Sizing:</b> a resize takes ~200 ms of CPU; 1K/s peak = 200 CPU‑s per second ≈ 200 cores. With 8‑core workers that's 25 machines at peak and ~3 at average; the queue absorbs the difference.</div>

## Entities and API {#image-pipeline-api}

<p>Job (id, imageKey, ops[], priority, state, attempts) · Step (jobId, name, state, outputKey) · Output (key = f(imageKey, op, version)) · DLQ entry.</p>
<pre><code>POST /jobs {imageKey, ops:[{resize:512},{format:webp},{score}], priority}   -&gt; jobId
GET  /jobs/:id -&gt; {state, steps[], outputs[]}
POST /reprocess {filter, ops}   -&gt; enqueues only missing outputs
Queue message: {jobId, step, attempt, imageKey, params, dedupeKey}</code></pre>

## Design {#image-pipeline-design}

<figure>
<svg viewBox="0 0 980 290" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Image pipeline: producers enqueue to a priority queue; a dispatcher expands the DAG; per-step queues with worker pools; idempotent outputs keyed by content and params; status store; DLQ; autoscaler on queue depth">
<defs><marker id="dg1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="dg3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#dg1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#dg3);stroke-dasharray:2 4}.lbl{font-size:10.5px;fill:#1F4E9E}</style>
<rect class="box" x="20" y="90" width="120" height="70"></rect><text class="tb" x="80" y="108" text-anchor="middle">Producers</text>
<text class="ts" x="80" y="124" text-anchor="middle">upload event</text>
<text class="ts" x="80" y="137" text-anchor="middle">backfill CLI</text>
<rect class="box" x="170" y="90" width="130" height="70"></rect><text class="tb" x="235" y="108" text-anchor="middle">Job API</text>
<text class="ts" x="235" y="124" text-anchor="middle">validate, dedupe key</text>
<text class="ts" x="235" y="137" text-anchor="middle">record job</text>
<rect class="box" x="330" y="40" width="150" height="70" stroke="#B45309"></rect><text class="tb" x="405" y="58" text-anchor="middle">Queue: decode</text>
<text class="ts" x="405" y="74" text-anchor="middle">priority: upload &gt; backfill</text>
<rect class="box" x="330" y="130" width="150" height="70" stroke="#B45309"></rect><text class="tb" x="405" y="148" text-anchor="middle">Queue: resize/score</text>
<text class="ts" x="405" y="164" text-anchor="middle">fan-out per op</text>
<rect class="box" x="510" y="40" width="150" height="70"></rect><text class="tb" x="585" y="58" text-anchor="middle">Workers (decode)</text>
<text class="ts" x="585" y="74" text-anchor="middle">stateless, autoscale</text>
<text class="ts" x="585" y="87" text-anchor="middle">visibility timeout</text>
<rect class="box" x="510" y="130" width="150" height="70"></rect><text class="tb" x="585" y="148" text-anchor="middle">Workers (ops)</text>
<text class="ts" x="585" y="164" text-anchor="middle">CPU-bound pool</text>
<text class="ts" x="585" y="177" text-anchor="middle">idempotent write</text>
<rect class="box" x="700" y="40" width="140" height="70" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="tb" x="770" y="58" text-anchor="middle">Object store</text>
<text class="ts" x="770" y="74" text-anchor="middle">out/{hash}/{op}/{v}</text>
<text class="ts" x="770" y="87" text-anchor="middle">PUT if absent</text>
<rect class="box" x="700" y="130" width="140" height="70" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="770" y="148" text-anchor="middle">Status store</text>
<text class="ts" x="770" y="164" text-anchor="middle">job/step state</text>
<text class="ts" x="770" y="177" text-anchor="middle">attempts, errors</text>
<rect class="box" x="860" y="90" width="100" height="70" stroke="#B45309"></rect><text class="tb" x="910" y="108" text-anchor="middle">DLQ</text>
<text class="ts" x="910" y="124" text-anchor="middle">poison after N</text>
<text class="ts" x="910" y="137" text-anchor="middle">manual replay</text>
<rect class="box" x="330" y="220" width="330" height="50"></rect><text class="tb" x="495" y="238" text-anchor="middle">Autoscaler</text>
<text class="ts" x="495" y="254" text-anchor="middle">scale on queue depth and oldest message age; scale to zero</text>
<line class="f" x1="140" y1="125" x2="168" y2="125"></line>
<line class="f" x1="300" y1="110" x2="328" y2="80"></line>
<line class="f" x1="660" y1="75" x2="698" y2="75"></line>
<text class="lbl" x="679" y="69" text-anchor="middle">write</text>
<line class="f" x1="660" y1="165" x2="698" y2="165"></line>
<text class="lbl" x="679" y="159" text-anchor="middle">state</text>
<line class="f" x1="660" y1="90" x2="698" y2="140"></line>
<line class="fa" x1="510" y1="160" x2="480" y2="160"></line>
<line class="f" x1="300" y1="140" x2="328" y2="160"></line>
<line class="fa" x1="660" y1="60" x2="858" y2="110"></line>
<text class="lbl" x="759" y="79" text-anchor="middle">fail</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 746" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="One image through the pipeline">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="7" y="14" width="126" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Upload event</text>
<line class="ln" x1="70" y1="48" x2="70" y2="726"></line>
<rect class="sb" x="147" y="14" width="126" height="34"></rect><text class="st" x="210" y="36" text-anchor="middle">Job API</text>
<line class="ln" x1="210" y1="48" x2="210" y2="726"></line>
<rect class="sb" x="287" y="14" width="126" height="34"></rect><text class="st" x="350" y="36" text-anchor="middle">Queue</text>
<line class="ln" x1="350" y1="48" x2="350" y2="726"></line>
<rect class="sb" x="427" y="14" width="126" height="34"></rect><text class="st" x="490" y="36" text-anchor="middle">Worker</text>
<line class="ln" x1="490" y1="48" x2="490" y2="726"></line>
<rect class="sb" x="567" y="14" width="126" height="34"></rect><text class="st" x="630" y="36" text-anchor="middle">Object store</text>
<line class="ln" x1="630" y1="48" x2="630" y2="726"></line>
<rect class="sb" x="707" y="14" width="126" height="34"></rect><text class="st" x="770" y="36" text-anchor="middle">Status store</text>
<line class="ln" x1="770" y1="48" x2="770" y2="726"></line>
<rect class="sb" x="847" y="14" width="126" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">DLQ</text>
<line class="ln" x1="910" y1="48" x2="910" y2="726"></line>
<line class="a1" x1="78" y1="80" x2="202" y2="80"></line>
<text class="sl" x="140" y="74" text-anchor="middle">POST /jobs {imageKey, ops}</text>
<rect class="nt" x="100" y="101" width="220" height="22"></rect><text class="sl" x="210" y="116" text-anchor="middle">dedupeKey = hash(imageKey, ops, version)</text>
<line class="a1" x1="218" y1="148" x2="762" y2="148"></line>
<text class="sl" x="490" y="142" text-anchor="middle">job CREATED (unique dedupeKey)</text>
<line class="a1" x1="218" y1="182" x2="342" y2="182"></line>
<text class="sl" x="280" y="176" text-anchor="middle">enqueue decode step</text>
<line class="a2" x1="202" y1="216" x2="78" y2="216"></line>
<text class="sl" x="140" y="210" text-anchor="middle">202 jobId</text>
<line class="a1" x1="482" y1="250" x2="358" y2="250"></line>
<text class="sl" x="420" y="244" text-anchor="middle">receive (visibility timeout 5 m)</text>
<line class="a1" x1="498" y1="284" x2="622" y2="284"></line>
<text class="sl" x="560" y="278" text-anchor="middle">GET original</text>
<rect class="nt" x="392" y="305" width="196" height="22"></rect><text class="sl" x="490" y="320" text-anchor="middle">decode; validate; size limits</text>
<line class="a1" x1="482" y1="352" x2="358" y2="352"></line>
<text class="sl" x="420" y="346" text-anchor="middle">enqueue resize, score (fan-out)</text>
<line class="a1" x1="482" y1="386" x2="358" y2="386"></line>
<text class="sl" x="420" y="380" text-anchor="middle">ack decode</text>
<line class="a1" x1="482" y1="420" x2="358" y2="420"></line>
<text class="sl" x="420" y="414" text-anchor="middle">receive resize</text>
<rect class="nt" x="432" y="441" width="115" height="22"></rect><text class="sl" x="490" y="456" text-anchor="middle">resize in memory</text>
<line class="a1" x1="498" y1="488" x2="622" y2="488"></line>
<text class="sl" x="560" y="482" text-anchor="middle">PUT out/{hash}/resize512/v3 (if-none-match)</text>
<line class="a1" x1="498" y1="522" x2="762" y2="522"></line>
<text class="sl" x="630" y="516" text-anchor="middle">step DONE</text>
<line class="a1" x1="482" y1="556" x2="358" y2="556"></line>
<text class="sl" x="420" y="550" text-anchor="middle">ack</text>
<rect class="nt" x="380" y="577" width="220" height="22"></rect><text class="sl" x="490" y="592" text-anchor="middle">crash before ack → message reappears; PUT is idempotent</text>
<rect class="nt" x="380" y="611" width="220" height="22"></rect><text class="sl" x="490" y="626" text-anchor="middle">corrupt image → attempts++ with backoff</text>
<line class="a3" x1="358" y1="658" x2="902" y2="658"></line>
<text class="sl" x="630" y="652" text-anchor="middle">attempts ≥ 3 → DLQ</text>
<line class="a3" x1="762" y1="692" x2="218" y2="692"></line>
<text class="sl" x="490" y="686" text-anchor="middle">all steps DONE → job DONE; notify</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Upload event → Job API:</b> POST /jobs {imageKey, ops}</li>
  <li><b>Job API:</b> dedupeKey = hash(imageKey, ops, version)</li>
  <li><b>Job API → Status store:</b> job CREATED (unique dedupeKey)</li>
  <li><b>Job API → Queue:</b> enqueue decode step</li>
  <li><b>Job API → Upload event:</b> 202 jobId (response)</li>
  <li><b>Worker → Queue:</b> receive (visibility timeout 5 m)</li>
  <li><b>Worker → Object store:</b> GET original</li>
  <li><b>Worker:</b> decode; validate; size limits</li>
  <li><b>Worker → Queue:</b> enqueue resize, score (fan-out)</li>
  <li><b>Worker → Queue:</b> ack decode</li>
  <li><b>Worker → Queue:</b> receive resize</li>
  <li><b>Worker:</b> resize in memory</li>
  <li><b>Worker → Object store:</b> PUT out/{hash}/resize512/v3 (if-none-match)</li>
  <li><b>Worker → Status store:</b> step DONE</li>
  <li><b>Worker → Queue:</b> ack</li>
  <li><b>Worker:</b> crash before ack → message reappears; PUT is idempotent</li>
  <li><b>Worker:</b> corrupt image → attempts++ with backoff</li>
  <li><b>Queue → DLQ:</b> attempts ≥ 3 → DLQ (async)</li>
  <li><b>Status store → Job API:</b> all steps DONE → job DONE; notify (async)</li>
</ol>

## Deep dives {#image-pipeline-deep}

<div class="cards">
<div><h4>Idempotency, the whole game</h4><ul><li>Output key is a pure function of (content hash, op, params, code version). Re‑running writes the same key; use conditional PUT so a duplicate is a no‑op.</li><li>Ack the queue message only after the output write and status update; at‑least‑once delivery + idempotent effect = exactly‑once result.</li><li>Job dedupe key at submit prevents double jobs from retried uploads.</li></ul></div>
<div><h4>Failure handling</h4><ul><li>Visibility timeout ≥ worst‑case step time; heartbeat to extend for big images.</li><li>Retries with backoff per message; attempts in the message; DLQ after N with the error; replay tool.</li><li>Poison detection: size/dimension limits before decode, decode in a subprocess with memory/time limits so one bomb image can't kill the worker.</li><li>Partial DAG failure: steps are independent; job state is the aggregate; reprocess targets only missing outputs.</li></ul></div>
<div><h4>Throughput and cost</h4><ul><li>Separate queues per step and per priority so a 100M backfill never delays uploads; workers pull uploads first.</li><li>Autoscale on queue depth and oldest‑message age, not CPU; scale to zero when idle.</li><li>CPU‑bound: process‑based workers (not threads in Python), one per core, streaming decode to bound memory.</li><li>Metrics: throughput per step, p95 latency by priority, retry and DLQ rates, backlog age; alert on backlog age, not size.</li></ul></div></div>

## Don't leave the room without saying {#image-pipeline-check}

<ul class="checklist">
  <li>Output key = f(hash, op, params, version); conditional PUT; ack after write</li>
  <li>Visibility timeout + heartbeat; bounded retries; DLQ with replay</li>
  <li>Per‑step and per‑priority queues; backfill never starves uploads</li>
  <li>Autoscale on depth/age; scale to zero; process‑per‑core workers</li>
  <li>Poison isolation (limits, subprocess)</li>
  <li>Reprocess = enqueue only missing outputs</li>
</ul>

## What each level is expected to drive {#image-pipeline-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Queue + worker pool + retries + output store</td><td>Idempotent keys, DLQ, priorities</td></tr>
  <tr><td>Senior</td><td>Idempotent design end to end, DAG of steps, priority isolation, autoscaling signals, poison handling</td><td>Cost model, reprocessing tooling</td></tr>
  <tr><td>Staff+</td><td>Exactly‑once argument stated precisely, backlog SLOs, migration from the cron script without dual outputs, capacity and cost math</td><td>—</td></tr>
</tbody></table>
