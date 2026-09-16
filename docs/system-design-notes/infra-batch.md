---
title: "Job scheduler / batch inference queue"
slug: /system-design-notes/infra-batch
sidebar_position: 19
sidebar_label: "Job scheduler / batch inference queue"
description: "medium · materialized executions · atomic claim · leases · priority isolation"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/infra-batch/sequence.svg" alt="How it works — infra-batch" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
<header>
  
  <span class="tag">medium · materialized executions · atomic claim · leases · priority isolation</span>
</header>

## Requirements {#infra-batch-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Submit a batch of prompts as one job; retrieve results as one output</li>
      <li>Track progress; retry failed items; cancel a job</li>
      <li>Guarantee each item is processed at least once and results are idempotent</li>
      <li>Batch never degrades interactive latency</li>
      <li class="out">Pricing; the inference engine itself</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Jobs up to millions of items; thousands of concurrent jobs</li>
      <li>Completion within a window (e.g. 24 h) with best‑effort earlier</li>
      <li>Worker crashes lose no work and create no duplicates in output</li>
      <li>Fair scheduling across customers</li>
    </ol>
  </div>
</div>

## Entities and API {#infra-batch-api}

<p>Job (id, customer, inputUrl, outputUrl, state, counts) · Execution (id, jobId, idx, state PENDING|RUNNING|DONE|FAILED, owner, leaseUntil, attempts, resultKey) · Worker · Lease</p>
<pre><code>POST /batches {inputFileUrl, model}        -&gt; {jobId}
GET  /batches/:id                           -&gt; {state, done, failed, total, outputUrl?}
POST /batches/:id/cancel
Worker:  claim(n) → UPDATE … SKIP LOCKED;  heartbeat(execIds);  complete(execId, resultKey) | fail(execId, err)</code></pre>

## Design {#infra-batch-design}

<figure>
<svg viewBox="0 0 980 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Batch pipeline: job submitted, materialized into per-item executions in a DB, workers claim items atomically with a lease, heartbeat, process via the low-priority inference path, write results to S3, reaper reclaims expired leases; separate GPU pool or priority so batch yields to interactive">
  <defs><marker id="b1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="b2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.tm{font-size:10.5px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#b1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#b2);stroke-dasharray:2 4}</style>
  <rect class="box" x="20" y="40" width="110" height="60"></rect><text class="tb" x="75" y="60" text-anchor="middle">Submit</text><text class="ts" x="75" y="76" text-anchor="middle">POST /batches</text><text class="ts" x="75" y="90" text-anchor="middle">input file in S3</text>
  <rect class="box" x="160" y="30" width="170" height="80"></rect><text class="tb" x="245" y="50" text-anchor="middle">Materialize</text><text class="ts" x="245" y="66" text-anchor="middle">1 job row + N execution rows</text><text class="tm" x="245" y="82" text-anchor="middle">exec(id, job, idx, state,</text><text class="tm" x="245" y="96" text-anchor="middle">lease_until, owner, attempts)</text>
  <rect class="box" x="360" y="30" width="200" height="80"></rect><text class="tb" x="460" y="50" text-anchor="middle">Atomic claim</text><text class="tm" x="370" y="68">UPDATE exec SET owner=w, state=RUN,</text><text class="tm" x="370" y="82">lease_until=now+5m WHERE id IN (</text><text class="tm" x="370" y="96"> SELECT … PENDING LIMIT 50 SKIP LOCKED)</text>
  <rect class="box" x="590" y="30" width="150" height="80" stroke="#0F766E"></rect><text class="tb" x="665" y="50" text-anchor="middle">Workers</text><text class="ts" x="665" y="66" text-anchor="middle">heartbeat extends lease</text><text class="ts" x="665" y="80" text-anchor="middle">call inference, priority=batch</text><text class="ts" x="665" y="94" text-anchor="middle">write result to S3, mark DONE</text>
  <rect class="box" x="770" y="30" width="190" height="80"></rect><text class="tb" x="865" y="50" text-anchor="middle">Priority isolation</text><text class="ts" x="865" y="66" text-anchor="middle">batch queue drained only when</text><text class="ts" x="865" y="80" text-anchor="middle">interactive queue depth &lt; k, or</text><text class="ts" x="865" y="94" text-anchor="middle">a separate cheaper GPU pool</text>
  <rect class="box" x="160" y="150" width="200" height="60" stroke="#B45309"></rect><text class="tb" x="260" y="170" text-anchor="middle">Reaper</text><text class="ts" x="260" y="186" text-anchor="middle">lease_until &lt; now → PENDING</text><text class="ts" x="260" y="200" text-anchor="middle">attempts ≥ 3 → FAILED (item, not job)</text>
  <rect class="box" x="400" y="150" width="340" height="60"></rect><text class="tb" x="570" y="170" text-anchor="middle">Completion</text><text class="ts" x="570" y="186" text-anchor="middle">job DONE when count(DONE|FAILED)=N; assemble output file</text><text class="ts" x="570" y="200" text-anchor="middle">idempotent: result key = job/idx, rewrite on retry is harmless</text>
  <path class="f" d="M130 70 L158 70"></path><path class="f" d="M330 70 L358 70"></path><path class="f" d="M560 70 L588 70"></path><path class="f" d="M740 70 L768 70"></path>
  <path class="fa" d="M260 150 C 260 130, 400 120, 460 112"></path><path class="fa" d="M665 110 C 665 140, 600 150, 570 150"></path>
  <text class="ts" x="20" y="240">Why materialize: per‑item state gives progress, partial failure, resume, and fair scheduling across jobs (round‑robin claims by job/customer) instead of one giant blob.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 746" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Batch inference job flow">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="7" y="14" width="126" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Customer</text>
<line class="ln" x1="70" y1="48" x2="70" y2="726"></line>
<rect class="sb" x="147" y="14" width="126" height="34"></rect><text class="st" x="210" y="36" text-anchor="middle">Batch API</text>
<line class="ln" x1="210" y1="48" x2="210" y2="726"></line>
<rect class="sb" x="287" y="14" width="126" height="34"></rect><text class="st" x="350" y="36" text-anchor="middle">Materializer</text>
<line class="ln" x1="350" y1="48" x2="350" y2="726"></line>
<rect class="sb" x="427" y="14" width="126" height="34"></rect><text class="st" x="490" y="36" text-anchor="middle">Executions DB</text>
<line class="ln" x1="490" y1="48" x2="490" y2="726"></line>
<rect class="sb" x="567" y="14" width="126" height="34"></rect><text class="st" x="630" y="36" text-anchor="middle">Worker</text>
<line class="ln" x1="630" y1="48" x2="630" y2="726"></line>
<rect class="sb" x="707" y="14" width="126" height="34"></rect><text class="st" x="770" y="36" text-anchor="middle">Inference GW</text>
<line class="ln" x1="770" y1="48" x2="770" y2="726"></line>
<rect class="sb" x="847" y="14" width="126" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">S3</text>
<line class="ln" x1="910" y1="48" x2="910" y2="726"></line>
<line class="a1" x1="78" y1="80" x2="202" y2="80"></line>
<text class="sl" x="140" y="74" text-anchor="middle">POST /batches (file in S3)</text>
<line class="a1" x1="218" y1="114" x2="482" y2="114"></line>
<text class="sl" x="350" y="108" text-anchor="middle">INSERT job</text>
<line class="a3" x1="218" y1="148" x2="342" y2="148"></line>
<text class="sl" x="280" y="142" text-anchor="middle">materialize</text>
<line class="a1" x1="358" y1="182" x2="902" y2="182"></line>
<text class="sl" x="630" y="176" text-anchor="middle">stream input file</text>
<line class="a1" x1="358" y1="216" x2="482" y2="216"></line>
<text class="sl" x="420" y="210" text-anchor="middle">INSERT N executions PENDING (batched)</text>
<line class="a1" x1="622" y1="250" x2="498" y2="250"></line>
<text class="sl" x="560" y="244" text-anchor="middle">UPDATE … SKIP LOCKED LIMIT 50 → RUNNING, lease 5 m</text>
<line class="a2" x1="498" y1="284" x2="622" y2="284"></line>
<text class="sl" x="560" y="278" text-anchor="middle">claimed rows</text>
<line class="a1" x1="638" y1="318" x2="762" y2="318"></line>
<text class="sl" x="700" y="312" text-anchor="middle">inference priority=batch</text>
<rect class="nt" x="660" y="339" width="220" height="22"></rect><text class="sl" x="770" y="354" text-anchor="middle">admit only if interactive depth low</text>
<line class="a2" x1="762" y1="386" x2="638" y2="386"></line>
<text class="sl" x="700" y="380" text-anchor="middle">result</text>
<line class="a1" x1="638" y1="420" x2="902" y2="420"></line>
<text class="sl" x="770" y="414" text-anchor="middle">PUT result job/idx</text>
<line class="a1" x1="622" y1="454" x2="498" y2="454"></line>
<text class="sl" x="560" y="448" text-anchor="middle">DONE; job.done += 1</text>
<line class="a3" x1="622" y1="488" x2="498" y2="488"></line>
<text class="sl" x="560" y="482" text-anchor="middle">heartbeat extends lease</text>
<rect class="nt" x="380" y="509" width="220" height="22"></rect><text class="sl" x="490" y="524" text-anchor="middle">reaper: expired lease → PENDING, attempts++</text>
<rect class="nt" x="401" y="543" width="177" height="22"></rect><text class="sl" x="490" y="558" text-anchor="middle">attempts ≥ 3 → FAILED item</text>
<line class="a1" x1="218" y1="590" x2="482" y2="590"></line>
<text class="sl" x="350" y="584" text-anchor="middle">done+failed = total?</text>
<line class="a1" x1="218" y1="624" x2="902" y2="624"></line>
<text class="sl" x="560" y="618" text-anchor="middle">assemble output file</text>
<line class="a1" x1="78" y1="658" x2="202" y2="658"></line>
<text class="sl" x="140" y="652" text-anchor="middle">GET /batches/:id</text>
<line class="a2" x1="202" y1="692" x2="78" y2="692"></line>
<text class="sl" x="140" y="686" text-anchor="middle">progress / output URL</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Customer → Batch API:</b> POST /batches (file in S3)</li>
  <li><b>Batch API → Executions DB:</b> INSERT job</li>
  <li><b>Batch API → Materializer:</b> materialize (async)</li>
  <li><b>Materializer → S3:</b> stream input file</li>
  <li><b>Materializer → Executions DB:</b> INSERT N executions PENDING (batched)</li>
  <li><b>Worker → Executions DB:</b> UPDATE … SKIP LOCKED LIMIT 50 → RUNNING, lease 5 m</li>
  <li><b>Executions DB → Worker:</b> claimed rows (response)</li>
  <li><b>Worker → Inference GW:</b> inference priority=batch</li>
  <li><b>Inference GW:</b> admit only if interactive depth low</li>
  <li><b>Inference GW → Worker:</b> result (response)</li>
  <li><b>Worker → S3:</b> PUT result job/idx</li>
  <li><b>Worker → Executions DB:</b> DONE; job.done += 1</li>
  <li><b>Worker → Executions DB:</b> heartbeat extends lease (async)</li>
  <li><b>Executions DB:</b> reaper: expired lease → PENDING, attempts++</li>
  <li><b>Executions DB:</b> attempts ≥ 3 → FAILED item</li>
  <li><b>Batch API → Executions DB:</b> done+failed = total?</li>
  <li><b>Batch API → S3:</b> assemble output file</li>
  <li><b>Customer → Batch API:</b> GET /batches/:id</li>
  <li><b>Batch API → Customer:</b> progress / output URL (response)</li>
</ol>

## How it works, step by step {#infra-batch-flow}

<ol class="order">
  <li>Submit validates the file and creates one job row; a materializer streams the file and inserts N execution rows (batched inserts, S3 offsets not prompt text).</li>
  <li>Workers claim up to 50 PENDING rows with one conditional UPDATE using SKIP LOCKED, setting owner and a 5‑minute lease; claims round‑robin across jobs for fairness.</li>
  <li>Worker calls the inference gateway with priority=batch; the gateway admits batch work only when interactive queue depth is low and can preempt it.</li>
  <li>Worker heartbeats extend leases; results are written to S3 keyed by (job, idx); execution marked DONE with a completion counter increment on the job.</li>
  <li>Reaper returns expired leases to PENDING and bumps attempts; after 3 attempts the item is FAILED, not the job.</li>
  <li>When done + failed = total, an assembler concatenates results into the output file and marks the job complete; cancel flips remaining items to CANCELLED and stops claims.</li>
</ol>

## Deep dives {#infra-batch-deep}

<div class="cards">
  <div><h4>Exactly the mechanisms</h4><ul>
    <li><b>Materialized executions:</b> the job is split into rows at submit time; every row has its own state machine.</li>
    <li><b>Atomic claim:</b> one conditional UPDATE (or DynamoDB condition) moves PENDING → RUNNING with owner + lease. <code>FOR UPDATE SKIP LOCKED</code> lets many workers claim in parallel.</li>
    <li><b>Lease + heartbeat:</b> a worker must extend its lease; a dead worker's lease expires and the reaper reclaims. Retries counted per item; poison items fail individually.</li>
    <li><b>Idempotent results:</b> keyed by (job, idx); duplicate execution after a late heartbeat overwrites the same key.</li></ul></div>
  <div><h4>Yielding to interactive</h4><ul>
    <li>Same GPU pool: batch requests carry priority=batch; the inference gateway admits them only when interactive queue depth is below a threshold and preempts them (re‑queue) when it rises. Cheapest, best utilization.</li>
    <li>Separate pool: predictable, no interference, worse utilization; use for guaranteed batch SLAs.</li>
    <li>Fairness across customers: claim round‑robin by job so one 1M‑item job doesn't starve small jobs.</li></ul></div>
  <div><h4>Scale notes</h4><ul>
    <li>Claims are the hot query; index on (state, priority, created_at). Partition the executions table by job_id hash when it exceeds tens of millions of live rows.</li>
    <li>Don't put the prompt text in the row; store S3 offset. Rows stay small, claims stay fast.</li>
    <li>Expose per‑job progress from a counter updated by the completion path, not by COUNT(*).</li></ul></div>
</div>

## Don't leave the room without saying {#infra-batch-check}

<ul class="checklist">
  <li>Materialize items into rows: progress, partial failure, fairness</li>
  <li>Atomic claim with conditional update / SKIP LOCKED</li>
  <li>Lease + heartbeat + reaper; attempts per item</li>
  <li>Idempotent result keys; at‑least‑once is safe</li>
  <li>Priority isolation: yield to interactive or separate pool</li>
  <li>Fair round‑robin across jobs and customers</li>
  <li>Keep rows small; index the claim query; partition when large</li>
</ul>

## What each level is expected to drive {#infra-batch-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Queue + workers + results in S3; retry on failure</td><td>Leases, duplicates, fairness</td></tr>
  <tr><td>Senior</td><td>Materialized executions, atomic claims, leases and reaper, idempotency, batch/interactive isolation</td><td>Partitioning at scale, preemption</td></tr>
  <tr><td>Staff+</td><td>Preemption semantics with the inference gateway, SLA modelling for the 24 h window, cost of separate pool vs shared, multi‑tenant fairness and abuse</td><td>—</td></tr>
</tbody></table>
