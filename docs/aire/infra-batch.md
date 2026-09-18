---
title: "Job scheduler / batch inference queue"
slug: /aire/infra-batch
sidebar_position: 35
sidebar_label: "Job scheduler / batch inference queue"
description: "medium · materialized executions · atomic claim · leases · priority isolation"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/infra-batch/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

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


## Scale, performance and safety targets {#infra-batch-targets}

<p>Batch is a throughput system with a deadline, not a latency system. Pin these numbers first — they are what justify materialized rows, leases and priority isolation.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> the API itself is quiet (~100 submissions/s, a few thousand status polls/s), but the claim query runs hot — thousands of workers claiming 50 rows each, tens of thousands of row transitions per second.</li>
    <li><b>Data volume:</b> jobs up to 1M items; thousands of concurrent jobs means 100M+ live execution rows. Average prompt ~10 KB, so a single large job is ~10 GB of input and a similar amount of output.</li>
    <li><b>Growth:</b> roughly 2× annually in both job count and items per job — which is why the executions table must be partitionable by job_id hash before it is actually needed.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> submit ack p99 &lt; 500 ms (materialization is async); status poll p99 &lt; 100 ms because it reads a counter, not a COUNT(*); claim query p99 &lt; 50 ms — it is on every worker's hot loop.</li>
    <li><b>Throughput:</b> complete a 1M‑item job inside the 24 h window, which is ~12 items/s sustained; the system should do far better than that when the interactive fleet is idle, and gracefully do nothing when it is not.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the real threats are resource abuse rather than network attacks — a customer submitting a 100M‑item job to monopolize the fleet, a poison item retried forever, and batch traffic silently eating the interactive capacity that paying latency‑sensitive users depend on.</li>
    <li><b>Rate limiting:</b> per‑customer caps on concurrent jobs, total in‑flight items and submissions per hour; round‑robin claiming so no single job can dominate; per‑item attempt cap of 3 so a poison prompt dies instead of looping.</li>
    <li><b>Data sensitivity:</b> input files are customer prompts and may contain PII. Store them in customer‑scoped buckets, keep only S3 offsets in the rows (never prompt text in the database), encrypt at rest, and expire inputs and outputs on a stated retention — e.g. 30 days.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.9% for the submit/status API. The processing plane is allowed to pause entirely — a batch job that stalls for an hour and still meets its 24 h window has not violated anything.</li>
    <li><b>Degraded mode:</b> inference gateway saturated → batch simply stops being admitted and the queue drains later. Executions DB unavailable → workers finish their leased items and stop claiming; nothing is lost because leases expire and items return to PENDING. Output assembly failing → the job stays "processing" with results already durable in S3.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Durability:</b> eleven nines for inputs and results in object storage; an acknowledged submit must never be silently dropped, which is why the job row and the input file are both durable before the API returns.</li>
    <li><b>Consistency:</b> strong for the claim — it is a conditional update and must be linearizable, or two workers process the same item. Progress counters can be eventually consistent, and at‑least‑once delivery is made safe by idempotent (job, idx) result keys.</li>
    <li><b>Compliance:</b> per‑customer data residency for inputs and outputs, a deletion path that actually removes both, and audit records of who submitted and who downloaded each job.</li></ul></div>
</div>

## Entities and API {#infra-batch-api}

<p>Job (id, customer, inputUrl, outputUrl, state, counts) · Execution (id, jobId, idx, state PENDING|RUNNING|DONE|FAILED, owner, leaseUntil, attempts, resultKey) · Worker · Lease</p>
<pre><code>POST /batches {inputFileUrl, model}        -&gt; {jobId}
GET  /batches/:id                           -&gt; {state, done, failed, total, outputUrl?}
POST /batches/:id/cancel
Worker:  claim(n) → UPDATE … SKIP LOCKED;  heartbeat(execIds);  complete(execId, resultKey) | fail(execId, err)</code></pre>

## Design {#infra-batch-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/infra-batch/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

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
  <li><b>Customer → Batch API:</b> POST /batches (file in S3).
    The customer uploads the input file first and submits a reference to it, so the API never streams gigabytes through a request body.
    Submit validates cheaply — the file exists, the model is real, the customer is under quota — and returns fast; the expensive expansion happens afterwards.
    An idempotency key on the submit stops a client retry from creating two identical million‑item jobs.</li>
  <li><b>Batch API → Executions DB:</b> INSERT job.
    One row records the job's identity, customer, input and output locations, state and counters — this is what a status poll reads.
    Writing it before acknowledging is what makes the submit durable: if the API dies immediately after, the job still exists and materialization will be retried.</li>
  <li><b>Batch API → Materializer:</b> materialize (async).
    Expanding a file into a million rows can take minutes, so it happens off the request path and the customer sees the job in a "materializing" state.
    Decoupling also means materialization can be retried or resumed independently without the client holding a connection open.</li>
  <li><b>Materializer → S3:</b> stream input file.
    The file is streamed, never loaded into memory, so a 10 GB input costs constant memory regardless of size.
    As it streams it records byte offsets per item, which is what lets the execution row stay tiny.</li>
  <li><b>Materializer → Executions DB:</b> INSERT N executions PENDING (batched).
    This is the central design decision: the job is materialized into one row per item, each with its own state machine, attempt count and lease.
    That is what makes per‑item progress, per‑item retry, partial failure and fair scheduling possible at all — a single opaque "job" has none of those properties.
    Rows store the S3 offset rather than the prompt text, so the table stays small and the claim query stays fast; inserts are batched in thousands to keep write amplification down.</li>
  <li><b>Worker → Executions DB:</b> UPDATE … SKIP LOCKED LIMIT 50 → RUNNING, lease 5 m.
    A single conditional UPDATE moves rows PENDING → RUNNING while stamping owner and lease expiry — the claim is the transaction, so two workers can never hold the same item.
    <code>SKIP LOCKED</code> is what lets thousands of workers claim concurrently without queueing behind each other on the same hot rows.
    Claiming 50 at a time amortizes the round trip; claims are ordered round‑robin across jobs so one huge job cannot starve small ones.</li>
  <li><b>Executions DB → Worker:</b> claimed rows (response).
    The worker gets the item indices and input offsets — enough to fetch its own prompts directly from S3 without the database carrying payloads.
    If fewer rows come back than requested, the worker backs off; an empty claim is the normal signal that the queue is drained.</li>
  <li><b>Worker → Inference GW:</b> inference priority=batch.
    Every batch call is explicitly tagged as low priority, which is the mechanism that keeps batch from cannibalizing interactive capacity.
    The worker sends the request with a generous timeout because being slow is fine here; being dropped is also fine, since the lease will reclaim the item.</li>
  <li><b>Inference GW:</b> admit only if interactive depth low.
    The gateway is the arbiter: batch is admitted only while the interactive queue is shallow, and in‑flight batch work can be preempted and re‑queued when it deepens.
    This gives near‑free utilization of idle GPUs while making the isolation guarantee concrete rather than aspirational.
    The alternative — a separate pool — is predictable but wastes capacity, and is worth it only when batch itself carries a hard SLA.</li>
  <li><b>Inference GW → Worker:</b> result (response).
    A rejection here is not an error: the worker releases the item or lets the lease lapse, and it returns to PENDING for a later, quieter moment.
    Only genuine model or input errors count against the item's attempt budget.</li>
  <li><b>Worker → S3:</b> PUT result job/idx.
    Results are written under a deterministic key derived from job and item index, which is what makes at‑least‑once processing safe.
    A duplicate execution after a late heartbeat simply overwrites the same object with the same content — no duplicates ever reach the output file.
    Writing the result before marking the row DONE means the durable artifact always exists before the state claims it does.</li>
  <li><b>Worker → Executions DB:</b> DONE; job.done += 1.
    The state transition and the counter increment happen together, so progress is a cheap counter read rather than a COUNT(*) over a hundred million rows.
    The update is conditional on the worker still owning the lease, so a worker that was already reaped cannot resurrect a stale item.</li>
  <li><b>Worker → Executions DB:</b> heartbeat extends lease (async).
    A live worker proves it is alive by pushing its lease out; the lease is the only thing standing between a crashed worker and a permanently stuck item.
    Heartbeats are batched across all of the worker's in‑flight items, so liveness costs one small write, not fifty.
    Lease length is a tuning knob: too short and slow items get stolen, too long and crash recovery drags.</li>
  <li><b>Executions DB:</b> reaper: expired lease → PENDING, attempts++.
    The reaper is what turns worker crashes into a non‑event: any RUNNING row whose lease has passed goes back to PENDING and becomes claimable again.
    Incrementing attempts at reclaim time is what stops an item that reliably kills its worker from cycling forever.
    Because results are idempotent, a reclaimed item that was actually nearly finished costs duplicate work, never duplicate output.</li>
  <li><b>Executions DB:</b> attempts ≥ 3 → FAILED item.
    A poison item fails on its own without failing the job, which is the whole point of materializing executions.
    The failure is recorded with the last error so the customer can see exactly which of their million inputs were bad and why.</li>
  <li><b>Batch API → Executions DB:</b> done+failed = total?
    Completion is detected from counters rather than by scanning rows, so the check is O(1) no matter how large the job.
    Comparing against the total established at materialization time is also the guard against a partially materialized job being declared complete.</li>
  <li><b>Batch API → S3:</b> assemble output file.
    Results are concatenated in input order — customers expect line N of the output to correspond to line N of the input, which the (job, idx) keying makes trivial.
    Assembly is itself idempotent and restartable: it reads durable objects and writes one more.
    Failed items appear in the output with their error, rather than being silently missing.</li>
  <li><b>Customer → Batch API:</b> GET /batches/:id.
    Polling is the interface, so it must be cheap: one row read for state and counters, no joins, no aggregation.
    Rate limits apply here too — a client polling every 100 ms for 24 h is its own small denial of service.</li>
  <li><b>Batch API → Customer:</b> progress / output URL (response).
    While running it returns done/failed/total so a client can show real progress instead of a spinner.
    On completion it returns a pre‑signed, expiring URL scoped to that customer's output, so results are never served through a shared, long‑lived link.</li>
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

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/infra-batch/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

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


## Trade-offs {#infra-batch-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Job representation</td><td>Materialize one row per item at submit</td><td>Hundreds of millions of rows to store, index and partition</td><td>Keep the job opaque only when items are few, or when per‑item progress and partial failure genuinely do not matter</td></tr>
  <tr><td>Work distribution</td><td>Pull: workers claim with a conditional UPDATE + SKIP LOCKED</td><td>The database becomes the hot path and the scaling limit</td><td>Push through a real queue (SQS/Kafka) when claim QPS outgrows the database — at the cost of losing easy per‑item state and fair round‑robin</td></tr>
  <tr><td>Delivery semantics</td><td>At‑least‑once plus idempotent (job, idx) result keys</td><td>Duplicate compute on rare double‑execution</td><td>Exactly‑once is not worth the distributed‑transaction cost here; idempotent writes get the same observable outcome for far less</td></tr>
  <tr><td>Failure detection</td><td>Leases and heartbeats with a reaper</td><td>Detection latency equal to the lease, and tuning pain when item durations vary widely</td><td>Shorter leases when items are uniformly quick; per‑item adaptive leases when they are not</td></tr>
  <tr><td>Capacity isolation</td><td>Shared GPU pool with priority=batch and preemption</td><td>No guaranteed batch throughput — a busy week for interactive means batch crawls</td><td>A dedicated batch pool when batch itself carries a contractual SLA and predictability beats utilization</td></tr>
  <tr><td>Row contents</td><td>Store S3 offsets, not prompt text</td><td>An extra fetch per item, and a dependency on the input file staying put</td><td>Inline the payload only for tiny items where the extra read dominates</td></tr>
  <tr><td>Progress reporting</td><td>Counters maintained by the completion path</td><td>Counters can drift and need a periodic reconciliation job</td><td>COUNT(*) is fine for small jobs; it stops being fine the moment a job has millions of rows</td></tr>
</tbody></table>

## Safety-first design {#infra-batch-safety}

<div class="cards">
  <div><h4>Interactive traffic is never collateral</h4><ul>
    <li><b>Batch is admitted, not entitled.</b> Every request is tagged priority=batch and the gateway drops it the moment interactive queue depth rises — the isolation lives in one enforcement point, not in politeness.</li>
    <li><b>Preemption is free.</b> Because leases return work to PENDING, cancelling in‑flight batch inference costs nothing but wasted compute; there is no partial state to unwind.</li>
    <li><b>Backpressure, not buffering.</b> When capacity is gone, items stay in the queue rather than piling into memory or timing out noisily.</li></ul></div>
  <div><h4>Containing bad jobs and bad items</h4><ul>
    <li><b>Poison items fail alone.</b> Three attempts and an item is marked FAILED with its error; the other 999,999 items are unaffected, and the customer sees exactly what went wrong.</li>
    <li><b>Round‑robin claiming.</b> Fairness is enforced where work is handed out, so one enormous job cannot starve every small one behind it.</li>
    <li><b>Quotas at submit.</b> Concurrent jobs, in‑flight items and submission rate are all capped per customer, before any resources are committed.</li>
    <li><b>Cancel is immediate and total.</b> Cancelling flips remaining items to CANCELLED and stops claims, so a runaway job can be stopped in one action.</li></ul></div>
  <div><h4>Handling customer data</h4><ul>
    <li><b>Prompts stay in object storage.</b> The database holds offsets, not content — which keeps PII out of database backups, replicas and query logs entirely.</li>
    <li><b>Scoped, expiring access.</b> Results are handed over as short‑lived pre‑signed URLs scoped to the owning customer; there is no shared, permanent results endpoint.</li>
    <li><b>Retention with a real delete path.</b> Inputs, per‑item results and the assembled output all expire on the same schedule, and a deletion request removes all three.</li>
    <li><b>Never log the payload.</b> Errors record item index and error class, not prompt text, so debugging does not quietly create a second copy of customer data.</li></ul></div>
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
