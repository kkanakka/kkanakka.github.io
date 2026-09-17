---
title: "Scale a batch image‑processing pipeline"
slug: /system-design-notes/image-pipeline
sidebar_position: 31
sidebar_label: "Scale a batch image‑processing pipeline"
description: "medium · queues · workers · retries · idempotency · backpressure"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/image-pipeline/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

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


## Scale, performance and safety targets {#image-pipeline-targets}

<p>Two workloads share one pipeline: latency‑sensitive uploads and enormous backfills. Almost every decision below exists to stop the second from starving the first.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> 10M images/day ≈ 115/s average with 1K/s peaks, plus backfills of 100M images that arrive as one burst. Each image fans out into 4–5 steps, so the queue sees ~5K messages/s at peak.</li>
    <li><b>Data volume:</b> ~3 MB average original, ~30 TB/day ingested; outputs (several sizes plus thumbnails) add roughly 50% more. Status rows are small but numerous — ~50M step rows/day.</li>
    <li><b>Growth:</b> ~2× annually in volume, and output variants grow with the product — each new size is a full reprocess of the corpus, which is why output keys must be versioned from day one.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> upload jobs p95 &lt; 60 s end to end, p99 &lt; 3 min; backfill is explicitly best‑effort with no latency target at all. Stating that difference is what justifies separate priorities.</li>
    <li><b>Throughput:</b> a resize is ~200 ms of CPU, so 1K/s peak is ~200 cores — about 25 eight‑core workers at peak and 3 at average. The queue absorbs the difference, and workers scale to zero overnight.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> image decoders are a classic attack surface — decompression bombs that expand to gigabytes, malformed files that crash or hang the decoder, and deeply nested formats. Uploaded content may also be illegal or harmful, which is why moderation scoring is a pipeline step rather than an afterthought.</li>
    <li><b>Rate limiting:</b> per‑tenant job submission caps, a dimension and pixel‑count limit checked <em>before</em> decode, a memory cap per worker, and a hard timeout per step so one image cannot occupy a worker indefinitely.</li>
    <li><b>Data sensitivity:</b> user photos carry EXIF location and faces. Strip metadata unless explicitly retained, scope output buckets per tenant, never log image bytes, and make deletion remove originals, every derived variant and the status rows together.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.9% for job submission; processing may lag without being "down". The real requirement is that <b>no accepted job is silently dropped</b> — it either completes or lands in the DLQ where someone can see it.</li>
    <li><b>Degraded mode:</b> workers saturated → the queue grows and backfill priority is shed first, protecting upload latency. A poison image fails three times and moves to the DLQ rather than blocking the queue. Object store degraded → jobs retry with backoff; nothing is lost because the queue holds them.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> at‑least‑once delivery with exactly‑once <em>effect</em>. Output keys are a pure function of (image, operation, version), so a duplicate execution overwrites identical bytes and changes nothing observable.</li>
    <li><b>Durability:</b> originals are the system of record at eleven nines; every derived output is reproducible, which is what makes reprocessing a new variant a routine batch job rather than a migration.</li>
    <li><b>Compliance:</b> deletion that reaches derivatives, per‑tenant isolation on both input and output buckets, and an auditable record of moderation decisions without retaining the content those decisions were about.</li></ul></div>
</div>

## Entities and API {#image-pipeline-api}

<p>Job (id, imageKey, ops[], priority, state, attempts) · Step (jobId, name, state, outputKey) · Output (key = f(imageKey, op, version)) · DLQ entry.</p>
<pre><code>POST /jobs {imageKey, ops:[{resize:512},{format:webp},{score}], priority}   -&gt; jobId
GET  /jobs/:id -&gt; {state, steps[], outputs[]}
POST /reprocess {filter, ops}   -&gt; enqueues only missing outputs
Queue message: {jobId, step, attempt, imageKey, params, dedupeKey}</code></pre>

## Design {#image-pipeline-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/image-pipeline/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

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
  <li><b>Upload event → Job API:</b> POST /jobs {imageKey, ops}.
    Jobs reference an image already in object storage rather than carrying bytes, so the API stays small and fast regardless of image size.
    Operations are declared per job, which is what allows a later reprocess to request only the new variant instead of redoing everything.</li>
  <li><b>Job API:</b> dedupeKey = hash(imageKey, ops, version).
    The key is a pure function of what the work <em>is</em>, so submitting the same job twice — a retried upload event, a re‑run backfill — collapses into one.
    Including the version means a code change deliberately produces a different key and therefore new outputs, rather than silently reusing stale ones.</li>
  <li><b>Job API → Status store:</b> job CREATED (unique dedupeKey).
    A unique constraint enforces deduplication at the database rather than by convention, so concurrent duplicate submissions cannot both win.
    Creating the record before enqueuing means an accepted job always has a durable trace, even if the enqueue fails and has to be retried.</li>
  <li><b>Job API → Queue:</b> enqueue decode step.
    Only the first step is enqueued; later steps are created by the steps before them, so the DAG unfolds as it executes rather than being materialised up front.
    That keeps fan‑out proportional to what actually runs when a step fails or is skipped.</li>
  <li><b>Job API → Upload event:</b> 202 jobId (response).
    Accepted, not completed — and saying so honestly is what allows the pipeline to absorb a 1K/s spike into a queue instead of into the caller's timeout.</li>
  <li><b>Worker → Queue:</b> receive (visibility timeout 5 m).
    The visibility timeout is the lease: a worker that dies simply stops extending it, and the message reappears for someone else.
    Five minutes is chosen from the slowest realistic step — too short and slow jobs get processed twice concurrently, too long and crash recovery drags.</li>
  <li><b>Worker → Object store:</b> GET original.
    The original is fetched per step rather than passed between steps, keeping messages small and steps independently retryable.
    Steps that need it stream rather than buffer, so a large image does not become a worker memory spike.</li>
  <li><b>Worker:</b> decode; validate; size limits.
    Validation happens <em>before</em> full decode: dimensions and pixel count are checked from the header, because a decompression bomb is a small file that expands to gigabytes.
    Hard limits on memory and wall‑clock per step mean a malicious or malformed image costs one failed step rather than a wedged worker.
    Image decoding is one of the most exploited surfaces in any pipeline, so this step is a security boundary, not a formality.</li>
  <li><b>Worker → Queue:</b> enqueue resize, score (fan-out).
    Independent steps become independent messages, so they run in parallel and fail in isolation — a moderation service outage does not stop thumbnails from being produced.
    Fan‑out is enqueued before the parent is acked, so the children always exist before the parent disappears.</li>
  <li><b>Worker → Queue:</b> ack decode.
    Acking last is the whole discipline: work is durable, children are enqueued, and only then is the parent message released.</li>
  <li><b>Worker → Queue:</b> receive resize.
    Any worker can take any step; there is no affinity, so the pool is homogeneous and scales purely on queue depth.</li>
  <li><b>Worker:</b> resize in memory.
    Held in memory rather than round‑tripping to disk, because at 200 ms of CPU per image an extra I/O round trip is a significant fraction of the step.</li>
  <li><b>Worker → Object store:</b> PUT out/{hash}/resize512/v3 (if-none-match).
    The output key is derived from the content hash, the operation and the version — the same inputs always produce the same key.
    That is what converts at‑least‑once execution into exactly‑once <em>effect</em>: a duplicate run writes identical bytes to the same place.
    The conditional put avoids paying for a write that would change nothing, and makes the whole pipeline safe to re‑run over any subset.</li>
  <li><b>Worker → Status store:</b> step DONE.
    Status is updated after the durable output exists, so the record never claims something that is not there.
    Per‑step status is what makes partial progress visible and lets a reprocess skip completed work.</li>
  <li><b>Worker → Queue:</b> ack.
    Ack after the side effect, always — acking first turns any subsequent crash into silently lost work.</li>
  <li><b>Worker:</b> crash before ack → message reappears; PUT is idempotent.
    The failure path costs duplicated compute and nothing else, which is exactly the trade the idempotent key was chosen to enable.
    Designing for at‑least‑once and making effects idempotent is far cheaper than chasing exactly‑once delivery.</li>
  <li><b>Worker:</b> corrupt image → attempts++ with backoff.
    Attempts are counted per step so one bad operation does not condemn the whole job, and backoff prevents a poison message from consuming the pool in a tight loop.
    Transient failures (a slow object store) and permanent ones (an unreadable file) both funnel here, and the attempt budget resolves them without needing to tell them apart.</li>
  <li><b>Queue → DLQ:</b> attempts ≥ 3 → DLQ (async).
    After three attempts the message leaves the main queue entirely — the single most important property of the pipeline is that one bad image cannot block the other ten million.
    The DLQ is a work queue for humans, not a wastebasket: it is monitored, and a rising DLQ rate is an alert in its own right.</li>
  <li><b>Status store → Job API:</b> all steps DONE → job DONE; notify (async).
    Completion is derived from step records rather than tracked separately, so it cannot disagree with reality.
    Notification is the last thing to happen and is itself retried, because a completed job nobody hears about is indistinguishable from a lost one.</li>
</ol>

## Deep dives {#image-pipeline-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/image-pipeline/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
<div><h4>Idempotency, the whole game</h4><ul><li>Output key is a pure function of (content hash, op, params, code version). Re‑running writes the same key; use conditional PUT so a duplicate is a no‑op.</li><li>Ack the queue message only after the output write and status update; at‑least‑once delivery + idempotent effect = exactly‑once result.</li><li>Job dedupe key at submit prevents double jobs from retried uploads.</li></ul></div>
<div><h4>Failure handling</h4><ul><li>Visibility timeout ≥ worst‑case step time; heartbeat to extend for big images.</li><li>Retries with backoff per message; attempts in the message; DLQ after N with the error; replay tool.</li><li>Poison detection: size/dimension limits before decode, decode in a subprocess with memory/time limits so one bomb image can't kill the worker.</li><li>Partial DAG failure: steps are independent; job state is the aggregate; reprocess targets only missing outputs.</li></ul></div>
<div><h4>Throughput and cost</h4><ul><li>Separate queues per step and per priority so a 100M backfill never delays uploads; workers pull uploads first.</li><li>Autoscale on queue depth and oldest‑message age, not CPU; scale to zero when idle.</li><li>CPU‑bound: process‑based workers (not threads in Python), one per core, streaming decode to bound memory.</li><li>Metrics: throughput per step, p95 latency by priority, retry and DLQ rates, backlog age; alert on backlog age, not size.</li></ul></div></div>


## Trade-offs {#image-pipeline-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Delivery semantics</td><td>At‑least‑once with content‑addressed outputs</td><td>Duplicate compute on retries</td><td>Exactly‑once delivery costs distributed transactions for an outcome idempotent writes already provide</td></tr>
  <tr><td>DAG execution</td><td>One queue message per step, fanned out as it runs</td><td>More messages, and job completion must be derived from step records</td><td>A single message carrying the whole DAG is simpler but makes one failed step re‑run everything before it</td></tr>
  <tr><td>Output naming</td><td>Key = f(content hash, operation, version)</td><td>A version bump reprocesses the entire corpus</td><td>That is the point — mutable keys make it impossible to tell which code produced which output</td></tr>
  <tr><td>Failure isolation</td><td>Bounded attempts, then DLQ</td><td>Failed images need a human to look at the DLQ</td><td>Unbounded retries let one poison image consume the worker pool forever</td></tr>
  <tr><td>Priority</td><td>Separate lanes for uploads and backfill</td><td>Two queues to size and monitor</td><td>A single queue is simpler until a 100M‑image backfill puts every upload behind it</td></tr>
  <tr><td>Worker model</td><td>Homogeneous workers, any step</td><td>No specialisation — GPU steps get the same pool as CPU ones</td><td>Split pools when steps have genuinely different hardware needs, at the cost of separate scaling decisions</td></tr>
  <tr><td>Scaling</td><td>Autoscale on queue depth, down to zero</td><td>Cold‑start latency on the first job after an idle period</td><td>Keep a warm floor when p95 latency matters more than overnight cost</td></tr>
</tbody></table>

## Safety-first design {#image-pipeline-safety}

<div class="cards">
  <div><h4>Decoders are an attack surface</h4><ul>
    <li><b>Check dimensions before decoding.</b> A decompression bomb is a small file that expands to gigabytes; the header tells you that before the decoder does.</li>
    <li><b>Hard memory and time limits per step.</b> A malformed image costs one failed step rather than a wedged worker or an out‑of‑memory kill.</li>
    <li><b>Isolate the decode.</b> Running untrusted image parsing in a constrained sandbox limits what a decoder exploit can reach.</li>
    <li><b>Moderation is a pipeline step.</b> Scoring content is part of processing, not something bolted on after the outputs are already public.</li></ul></div>
  <div><h4>No accepted job disappears</h4><ul>
    <li><b>Durable before acknowledged.</b> The job row exists before the API returns 202, so an accepted job always has a trace.</li>
    <li><b>Ack after the side effect.</b> Output written, status updated, children enqueued — then ack. Any other order loses work on a crash.</li>
    <li><b>Poison messages leave the queue.</b> Three attempts and it moves to the DLQ, so one bad image cannot block ten million good ones.</li>
    <li><b>The DLQ is monitored.</b> It is a queue of work for humans; an unwatched DLQ is just a slower way of dropping jobs.</li></ul></div>
  <div><h4>User photos need careful handling</h4><ul>
    <li><b>Strip metadata by default.</b> EXIF carries GPS coordinates and device identifiers that users do not expect to publish with a thumbnail.</li>
    <li><b>Tenant‑scoped buckets.</b> Inputs and outputs are isolated per tenant, so a key collision or a path bug cannot cross an account boundary.</li>
    <li><b>Deletion reaches derivatives.</b> Original, every variant, thumbnails and status rows — a delete that leaves a thumbnail behind has not deleted the photo.</li>
    <li><b>Never log the bytes.</b> Errors record keys, sizes and error classes; a debug pipeline must not become a second copy of user photos.</li></ul></div>
</div>

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
