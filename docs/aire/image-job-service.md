---
title: "Concurrent image-processing job service: one worker to many"
slug: /aire/image-job-service
sidebar_position: 17
sidebar_label: "Concurrent image-processing job service:…"
description: "hard · Anthropic · state machine · leases and ownership · idempotency · safe evolution"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/image-job-service/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

## How it works

<header>
  
  <span class="tag">hard · Anthropic · state machine · leases and ownership · idempotency · safe evolution</span>
</header>
<p>An image‑processing service that works today with one worker must become many, without ever processing an image twice, losing one, or leaving a job wedged forever. The question is not "add a queue" — it is the state machine, who owns a job while it runs, how ownership expires, and how you get from one worker to many <b>while the service stays up</b>.</p>

## Requirements {#ijs-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Submit an image job; track its state; fetch the result</li>
      <li>Many workers process concurrently, each job processed by exactly one at a time</li>
      <li>A worker crash must not lose or wedge a job</li>
      <li>Migrate from single‑worker to multi‑worker with no downtime and no double processing</li>
      <li class="out">The image algorithms themselves, autoscaling policy</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>At‑least‑once execution with exactly‑once observable effect</li>
      <li>Crash detection and recovery bounded by the lease, in minutes not hours</li>
      <li>A poison image can never block other jobs</li>
      <li>State transitions are auditable: every job's history is reconstructable</li>
    </ol>
  </div>
</div>
<div class="note"><b>Draw the state machine first:</b> PENDING → RUNNING(owner, leaseUntil) → DONE | FAILED, plus CANCELLED. Every transition is a conditional update guarded by the current state and the owner. If you can state which transitions are legal and which are guarded by what, the rest of the design writes itself — and if you cannot, no amount of queue machinery will save it.</div>

## Scale, performance and safety targets {#ijs-targets}

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> ~500 submissions/s at peak with bursts of tens of thousands from batch imports. The claim query is the hot path — 100 workers claiming every few seconds is the load the database actually feels.</li>
    <li><b>Data volume:</b> a few million live job rows plus history; images average ~3 MB in object storage with rows holding only references, so the database stays small while storage grows.</li>
    <li><b>Growth:</b> worker count grows with volume, and claim contention grows with worker count — so the claim must be contention‑free by construction (<code>SKIP LOCKED</code> or a conditional update), not merely fast today.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> submit acknowledged p99 &lt; 200 ms; job picked up p95 &lt; 5 s when capacity exists; processing p95 &lt; 30 s per image; crash recovery bounded by the lease, so 2–5 minutes.</li>
    <li><b>Throughput:</b> a resize is ~200 ms of CPU, so ~5 jobs/s per core; 500/s peak is ~100 cores. Workers scale horizontally on queue depth, and the database must not become the ceiling before the CPUs do.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> image decoding is a genuine attack surface — decompression bombs, malformed files that hang a decoder, and deeply nested formats. Operationally, a poison image that crashes its worker can consume the entire pool in a retry loop.</li>
    <li><b>Rate limiting:</b> per‑tenant submission caps, dimension and pixel limits checked from the header before decode, a memory and wall‑clock cap per job, and a bounded attempt count so a poison job dies rather than cycling.</li>
    <li><b>Data sensitivity:</b> user images with EXIF location and faces. Strip metadata, scope input and output buckets per tenant, never log image bytes, and make deletion remove the original, every output and the job history together.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.9% for submission; processing is allowed to lag. The absolute requirement is that <b>no accepted job is silently lost</b> — it reaches DONE, FAILED or CANCELLED, and never sits in RUNNING forever.</li>
    <li><b>Degraded mode:</b> workers saturated → queue grows, latency rises, nothing is dropped. Worker crashes → the lease expires and the job returns to PENDING with an incremented attempt count. Object storage degraded → jobs fail with a retryable error and are retried, because the durable row survives.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> the claim must be linearizable — it is a conditional update, and two workers claiming the same job is the failure the whole design exists to prevent. Everything else tolerates eventual consistency.</li>
    <li><b>Idempotency:</b> at‑least‑once plus output keys derived from (job, operation, version), so a duplicated execution overwrites identical bytes and changes nothing observable.</li>
    <li><b>Migration:</b> the single‑to‑many transition is part of the requirements, not an afterthought — it has to be doable live, incrementally, and reversibly.</li></ul></div>
</div>

## Entities and API {#ijs-api}

<p>Job (id, tenantId, imageRef, ops[], state, owner, leaseUntil, attempts, outputRef, error, version) · State (PENDING | RUNNING | DONE | FAILED | CANCELLED) · Lease (owner + expiry) · Worker (id, heartbeat) · Transition (jobId, from, to, at, by).</p>
<pre><code>POST /jobs {imageRef, ops, idempotencyKey}   -&gt; 202 {jobId}     # unique on (tenant, idempotencyKey)
GET  /jobs/:id                                -&gt; {state, attempts, outputRef?, error?}
POST /jobs/:id/cancel                         -&gt; CANCELLED if not terminal

Claim (the one transition that must be atomic):
  UPDATE jobs SET state='RUNNING', owner=:w, lease_until=now()+interval '5 min', attempts=attempts+1
   WHERE id IN (SELECT id FROM jobs WHERE state='PENDING' ORDER BY created_at
                FOR UPDATE SKIP LOCKED LIMIT 10) RETURNING *;
Heartbeat:  UPDATE jobs SET lease_until=now()+5min WHERE id=ANY(:ids) AND owner=:w AND state='RUNNING';
Complete:   UPDATE jobs SET state='DONE', output_ref=:o WHERE id=:id AND owner=:w AND state='RUNNING';
Reaper:     UPDATE jobs SET state='PENDING', owner=NULL WHERE state='RUNNING' AND lease_until &lt; now();</code></pre>

## Design {#ijs-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/image-job-service/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

### Flow between components

<ol class="order">
  <li><b>Client → Job API:</b> POST /jobs {imageRef, ops, idempotencyKey}.
    The request references an image already in object storage rather than carrying bytes, keeping the API small and fast.
    The idempotency key is enforced by a unique constraint, so a client retry after an ambiguous timeout returns the existing job instead of creating a second one.</li>
  <li><b>Job API → Database:</b> INSERT job state=PENDING.
    The row is durable before the API returns, which is what makes "no accepted job is lost" a property rather than a hope.
    PENDING with no owner is the only legal initial state, and every later state is reached through a guarded transition.</li>
  <li><b>Job API → Client:</b> 202 {jobId} (response).
    Accepted, not completed — being explicit about that is what lets the service absorb a burst into the queue rather than into the caller's timeout.</li>
  <li><b>Worker → Database:</b> claim: conditional UPDATE … FOR UPDATE SKIP LOCKED, set owner and lease.
    This single statement is the heart of the design: it selects PENDING rows, marks them RUNNING, stamps an owner and a lease expiry, and increments attempts — atomically.
    Because the claim <em>is</em> the transaction, two workers can never own the same job; there is no window between "find work" and "take work".
    <code>SKIP LOCKED</code> is what lets a hundred workers claim concurrently instead of serialising behind each other on the same head rows — it is the difference between scaling to many workers and merely having many.</li>
  <li><b>Database → Worker:</b> claimed rows with owner and leaseUntil (response).
    The worker now holds time‑bounded ownership, which is the crucial framing: ownership is a lease, not a lock, so it expires on its own if the owner dies.
    A lock needs someone alive to release it; a lease needs nobody.</li>
  <li><b>Worker → Object store:</b> GET the original image.
    Streamed rather than buffered, so a large image does not become a memory spike; the worker's footprint is bounded regardless of input.</li>
  <li><b>Worker:</b> validate header — dimensions, pixel count, format — before decoding.
    A decompression bomb is a small file that expands to gigabytes, so the limits are checked from the header before the decoder is handed anything.
    Hard memory and wall‑clock caps per job mean a malformed or hostile image costs one failed job rather than a dead worker.
    Image decoding is among the most exploited surfaces in any pipeline, which makes this a security boundary rather than a formality.</li>
  <li><b>Worker → Database:</b> heartbeat: extend the lease, guarded by owner and state.
    A live worker proves liveness by pushing its lease forward; the guard on <code>owner = :me AND state = 'RUNNING'</code> is what stops a worker that was already reaped from resurrecting a job someone else now owns.
    Heartbeats are batched across all in‑flight jobs, so liveness costs one small write rather than one per job.
    Lease length is the tuning knob: too short and slow jobs get stolen mid‑flight, too long and crash recovery drags.</li>
  <li><b>Worker → Object store:</b> PUT output at a key derived from (job, op, version).
    The output key is a pure function of the work, so a duplicated execution writes identical bytes to the same location.
    This is what converts at‑least‑once execution into exactly‑once <em>effect</em> — far cheaper than chasing exactly‑once delivery and observably equivalent.</li>
  <li><b>Worker → Database:</b> complete: UPDATE … WHERE owner = me AND state = RUNNING.
    The guard is essential: a worker whose lease expired during a long GC pause must not be able to mark DONE a job that has since been reclaimed and reprocessed.
    Updating zero rows is the signal that ownership was lost, and the worker must treat that as "my work was discarded" rather than as an error to retry.
    Output written before the state transition means the record never claims a result that does not exist.</li>
  <li><b>Reaper → Database:</b> RUNNING with an expired lease → back to PENDING.
    The reaper is what makes a worker crash a non‑event: no cleanup protocol, no worker registry, just expiry.
    Attempts were already incremented at claim time, so a job that reliably kills its worker cannot cycle forever.
    Detection latency equals the lease, which is the honest cost of this simplicity and worth stating.</li>
  <li><b>Reaper → Database:</b> attempts ≥ 3 → FAILED with the last error.
    A poison image fails alone; the other jobs are unaffected, which is the entire point of per‑job state rather than a shared batch.
    Failed jobs are visible and queryable, not silently dropped, so a rising failure rate is an alert rather than a mystery.</li>
  <li><b>Client → Job API:</b> cancel → CANCELLED if not terminal.
    Cancellation is a guarded transition too: it succeeds from PENDING or RUNNING and is a no‑op once the job is terminal.
    A cancelled job that a worker is still processing discovers it on its next guarded update, and simply discards its output.</li>
  <li><b>Migration:</b> single worker → many, live.
    The order matters and is the part most answers skip. First add the state machine, lease and idempotent output keys while still running one worker — the behaviour is unchanged, so this is safe to deploy alone.
    Then start the reaper, still with one worker, and confirm that killing it results in recovery rather than a wedged job.
    Only then add a second worker: the claim was already atomic, so concurrency introduces no new failure mode. Scaling from two to a hundred is then just capacity, and rolling back means removing workers rather than reverting a design.</li>
</ol>

## How it works, step by step {#ijs-flow}

<ol class="order">
  <li>Submit creates a durable PENDING row keyed by an idempotency key, then acknowledges.</li>
  <li>Workers claim with a single conditional UPDATE using <code>SKIP LOCKED</code>, taking time‑bounded ownership rather than a lock.</li>
  <li>The worker validates the image header before decoding, processes with hard memory and time caps, and heartbeats to extend its lease.</li>
  <li>Output is written to a key derived from (job, operation, version), then the state is updated with a guard on owner and state.</li>
  <li>A reaper returns expired leases to PENDING; after a bounded number of attempts the job becomes FAILED with its error.</li>
  <li>Migration proceeds in order — state machine and leases first, then the reaper, then a second worker — so each step is independently safe and reversible.</li>
</ol>

## Deep dives {#ijs-deep}

<div class="cards">
  <div><h4>Leases, not locks</h4><ul>
    <li>A lock needs a live holder to release it; a crashed holder wedges the job until a human intervenes.</li>
    <li>A lease expires on its own, so crash recovery needs no detection protocol, no worker registry and no heartbeat service.</li>
    <li>Every terminal transition is guarded by <code>owner = :me AND state = 'RUNNING'</code>, so a paused worker whose lease expired cannot act on a job someone else now owns.</li>
    <li>Zero rows updated is meaningful, not an error: it means ownership was lost and the work should be discarded.</li></ul></div>
  <div><h4>The claim is the whole concurrency story</h4><ul>
    <li>Select‑then‑update as two statements has a race; one conditional UPDATE does not.</li>
    <li><code>SKIP LOCKED</code> lets many workers claim different rows concurrently instead of queueing on the same head of the table.</li>
    <li>Claiming a small batch amortises the round trip while keeping the blast radius of a crash small.</li>
    <li>Incrementing attempts at claim time — not at failure time — is what bounds a job that kills its worker before it can report anything.</li></ul></div>
  <div><h4>Evolving a live system</h4><ul>
    <li>Add the state machine and idempotent outputs first: behaviour is unchanged with one worker, so it ships on its own.</li>
    <li>Enable the reaper next and test recovery by killing the single worker deliberately.</li>
    <li>Add the second worker only once the claim is atomic — concurrency then introduces no new failure mode.</li>
    <li>Every step is independently reversible, which is what makes this a migration rather than a rewrite.</li></ul></div>
</div>

## Trade-offs {#ijs-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Work distribution</td><td>Pull: workers claim with a conditional UPDATE</td><td>The database is on the hot path and becomes the scaling ceiling</td><td>A dedicated queue (SQS, Kafka) scales further and makes per‑job state, cancellation and fair ordering much harder</td></tr>
  <tr><td>Ownership</td><td>Time‑bounded lease</td><td>Detection latency equal to the lease</td><td>Shorter leases detect faster and steal jobs from slow workers; a lock detects instantly and wedges on crash</td></tr>
  <tr><td>Delivery semantics</td><td>At‑least‑once plus idempotent output keys</td><td>Duplicate compute on rare double execution</td><td>Exactly‑once needs distributed transactions for an outcome content‑addressed writes already provide</td></tr>
  <tr><td>Attempt counting</td><td>Increment at claim time</td><td>A job that times out through no fault of its own still burns an attempt</td><td>Counting at failure time misses the case where the worker dies before reporting — which is exactly the case that matters</td></tr>
  <tr><td>Poison handling</td><td>Bounded attempts, then FAILED</td><td>Failed jobs need a human to look at them</td><td>Unbounded retries let one malformed image consume the worker pool indefinitely</td></tr>
  <tr><td>Job state store</td><td>Relational rows, one per job</td><td>Row volume, and the claim query must stay indexed</td><td>An opaque queue message is simpler and gives up per‑job progress, cancellation and auditability</td></tr>
  <tr><td>Migration path</td><td>Incremental: state machine, then reaper, then workers</td><td>Three deployments instead of one</td><td>A single cutover is faster and makes "did we double‑process anything?" unanswerable</td></tr>
</tbody></table>

## Safety-first design {#ijs-safety}

<div class="cards">
  <div><h4>Exactly one owner, always</h4><ul>
    <li><b>The claim is the transaction.</b> One conditional UPDATE, never select‑then‑update, so there is no window in which two workers both believe they own a job.</li>
    <li><b>Guard every terminal transition.</b> <code>owner = :me AND state = 'RUNNING'</code> stops a reaped worker from completing a job that has been reassigned.</li>
    <li><b>Zero rows updated means stop.</b> Losing ownership is a normal outcome, and the correct response is to discard the work rather than retry it.</li>
    <li><b>Leases expire without help.</b> No worker registry, no failure detector, no cleanup protocol — expiry does the whole job.</li></ul></div>
  <div><h4>No job is lost, none runs forever</h4><ul>
    <li><b>Durable before acknowledged.</b> The row exists before the 202, so an accepted job always has a trace.</li>
    <li><b>Every job reaches a terminal state.</b> DONE, FAILED or CANCELLED — RUNNING forever is the failure mode the reaper exists to eliminate.</li>
    <li><b>Bounded attempts.</b> Incremented at claim time so a job that kills its worker silently still counts against its budget.</li>
    <li><b>Idempotent outputs.</b> A duplicated execution writes the same bytes to the same key, so at‑least‑once is safe by construction.</li></ul></div>
  <div><h4>Images are hostile until proven otherwise</h4><ul>
    <li><b>Check the header before decoding.</b> A decompression bomb is small on disk and enormous in memory; the header reveals that before the decoder does.</li>
    <li><b>Hard memory and time caps.</b> A malformed image costs one failed job, never a wedged or OOM‑killed worker.</li>
    <li><b>Strip metadata, scope buckets.</b> EXIF location is removed, and input and output buckets are isolated per tenant.</li>
    <li><b>Deletion covers job history.</b> Original, outputs and the job record go together — leaving the row behind leaves a description of the image.</li></ul></div>
</div>

## Don't leave the room without saying {#ijs-check}

<ul class="checklist">
  <li>Draw the state machine: PENDING → RUNNING(owner, leaseUntil) → DONE | FAILED | CANCELLED</li>
  <li>The claim is one conditional UPDATE with <code>SKIP LOCKED</code> — never select‑then‑update</li>
  <li>Ownership is a lease, not a lock: it expires without anyone alive to release it</li>
  <li>Guard every terminal transition on owner and state; zero rows updated means ownership was lost</li>
  <li>Attempts increment at claim time, so a worker that dies silently still burns budget</li>
  <li>Output keys derived from (job, op, version) turn at‑least‑once into exactly‑once effect</li>
  <li>Validate image headers before decode; hard memory and time caps per job</li>
  <li>Migrate in order — state machine, then reaper, then a second worker — each step reversible</li>
</ul>

## What each level is expected to drive {#ijs-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Add a queue and several workers; retry failed jobs</td><td>Double processing, crash recovery, ownership</td></tr>
  <tr><td>Senior</td><td>Explicit state machine, atomic claim with SKIP LOCKED, leases and heartbeats, reaper, idempotent outputs, bounded attempts</td><td>Guarded transitions, attempt‑at‑claim, decoder safety</td></tr>
  <tr><td>Staff+</td><td>The live migration path and why its order matters, lease tuning against job duration, database‑as‑queue limits and when to move off it, poison and decoder threat model</td><td>—</td></tr>
</tbody></table>
