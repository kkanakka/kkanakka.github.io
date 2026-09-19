---
title: "Workflow system distributing tasks to human workers"
slug: /cw/human-workflow
sidebar_position: 2
sidebar_label: "Workflow system distributing tasks to hu…"
description: "hard · task state machine · claim and lease · skill routing · timeouts and escalation · quality review"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/human-workflow/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

## How it works

<header>
  
  <span class="tag">hard · task state machine · claim and lease · skill routing · timeouts and escalation · quality review</span>
</header>
<p>Work is handed to humans through a web UI: labelling, moderation review, data entry, verification. Mechanically it is the same problem as any job queue — claim, lease, reaper — but the workers are people, and that changes the numbers and the failure modes. People close laptops, take lunch, work at wildly different speeds, and if they are paid per task they are incentivised to go fast rather than to be right. <b>The queue mechanics are easy; the quality and fairness layers are the design.</b></p>

## Requirements {#hw-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Create tasks in batches; workers claim and complete them through a UI</li>
      <li>Never hand the same task to two workers at once</li>
      <li>Reclaim tasks from workers who abandon or time out</li>
      <li>Route by skill and priority; support reassignment</li>
      <li>Optional review: N-of-M agreement or a reviewer pass</li>
      <li>Operator progress view and a complete audit history</li>
      <li class="out">Payments, worker recruitment, the labelling UI itself</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Claim is atomic — duplicate assignment is a correctness bug, not a nuisance</li>
      <li>An abandoned task returns to the pool within one lease</li>
      <li>A poison task must not block a batch</li>
      <li>Every state change attributable to a worker and a time</li>
      <li>Fair distribution — no worker can cherry-pick the easy work</li>
    </ol>
  </div>
</div>

<div class="note"><b>Clarifying questions worth asking:</b> are workers interchangeable or skill-based? Does a task need review, and is that one reviewer or N-of-M agreement? What is the SLA — hours or days? Can a task be reassigned mid-flight, and does the original worker's partial answer survive? What audit history is required, and for how long? The answers change the state machine, not just the tuning.</div>

## Scale, performance and safety targets {#hw-targets}

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> tiny by machine standards and that is the point — 5,000 workers each completing ~60 tasks/hour is ~80 claims/s. A single database handles this comfortably; complexity here would be self-inflicted.</li>
    <li><b>Data volume:</b> 10M tasks/month at ~2 KB of payload plus a few hundred bytes of audit per transition — low hundreds of GB per year. Task <em>content</em> (images, documents) lives in object storage with the row holding a pointer.</li>
    <li><b>Growth:</b> worker count grows with volume, but the sharp edge is <b>skill fragmentation</b> — every new skill splits the pool, and a pool of five workers for one skill has completely different queueing behaviour from a pool of five hundred.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> claim p99 &lt; 200 ms — a worker staring at a spinner is paid idle time. Task-available to claimed p50 under a minute in steady state. The SLA that matters is <b>end-to-end completion</b>, typically hours to days.</li>
    <li><b>Throughput:</b> bounded by humans, not machines. The useful metrics are tasks/worker/hour and queue age, and the design goal is keeping workers busy — <b>idle workers are the real cost</b>, not database load.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the adversary is often the worker. Paid per task, people click through without reading, favour tasks that look quick, and share accounts. Add scripted clients hammering the claim endpoint to grab the best work.</li>
    <li><b>Rate limiting:</b> a cap on tasks held concurrently per worker (usually one), claim-rate limits to defeat scripted grabbing, and <b>no visibility into the queue before claiming</b> — you get what you are given, which removes cherry-picking entirely.</li>
    <li><b>Data sensitivity:</b> tasks routinely contain customer content — documents, images, messages. Scope access to the assigned worker only, watermark and audit every view, block download where possible, and honour deletion including from completed tasks and the audit trail's payload references.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.9%. Every minute down is thousands of paid people unable to work, which makes the cost unusually direct and visible.</li>
    <li><b>Degraded mode:</b> database degraded → serve already-claimed tasks read-only so in-flight work can be submitted, but stop issuing new claims. Review pipeline behind → tasks queue in SUBMITTED rather than blocking new work. A worker's connection dropping mid-task must never lose their partial answer — autosave client-side and server-side.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> strong for the claim — it is a conditional update and duplicate assignment is a correctness failure. Progress counters and dashboards can lag.</li>
    <li><b>Durability:</b> submissions and the audit log are durable before acknowledgement. A worker who submitted and got a confirmation must never lose that work — they were paid for it and they will notice.</li>
    <li><b>Auditability:</b> who saw what, when, and what they answered — needed for quality disputes, payment disputes, and any regulated content. It is a first-class requirement, not logging.</li></ul></div>
</div>

## Entities and API {#hw-api}

<p>Task (id, batchId, type, payloadRef, requiredSkills[], priority, state, owner, leaseUntil, attempts, answer) · Batch (id, count, deadline, reviewPolicy) · Worker (id, skills[], trustScore, activeTask) · Assignment (taskId, workerId, claimedAt, submittedAt, durationMs) · Review (taskId, reviewerId, verdict) · AuditEvent (taskId, actor, from, to, at).</p>
<pre><code>POST /batches            {tasks[], requiredSkills, priority, reviewPolicy}  -&gt; batchId
POST /tasks/claim        {workerId}                    -&gt; task | NO_WORK    # server chooses, not the worker
POST /tasks/:id/heartbeat{workerId}                    -&gt; extends the lease
POST /tasks/:id/submit   {workerId, answer}            -&gt; guarded on owner + state
POST /tasks/:id/release  {workerId, reason}            -&gt; voluntary give-back, no penalty
GET  /batches/:id/progress                             -&gt; {available, claimed, submitted, done, failed, ageP95}

Claim (the one transition that must be atomic):
  UPDATE tasks SET state='CLAIMED', owner=:w, lease_until=now()+interval '30 min', attempts=attempts+1
   WHERE id = (SELECT id FROM tasks
                WHERE state='AVAILABLE' AND required_skills &lt;@ :worker_skills
                ORDER BY priority DESC, created_at
                FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING *;</code></pre>

## Design {#hw-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/human-workflow/architecture.svg" alt="The queue mechanics are the easy part. Hiding the queue, gold tasks and trust routing are what make the output worth anything." class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

### Flow between components

<ol class="order">
  <li><b>Operator → Batch API:</b> create a batch of tasks.
    Tasks are materialised as <b>one row each</b> at creation, not held as an opaque batch — that is what makes per-task progress, per-task retry, reassignment and partial failure possible at all.
    Payloads go to object storage with the row holding a pointer, so the table stays small and the claim query stays fast.</li>
  <li><b>Worker → UI → Claim API:</b> "give me work".
    Note the direction: <b>the worker asks, the server chooses.</b> Workers never browse a queue and pick, because given a list people take the quick ones and leave the hard ones to rot.
    Rate-limited per worker so a scripted client cannot poll aggressively to fish for easy tasks.</li>
  <li><b>Claim API → Task store:</b> one conditional UPDATE with SKIP LOCKED.
    The claim <em>is</em> the transaction — select-then-update has a gap where two workers can both win, and duplicate assignment means two people paid for the same task and possibly two different answers.
    <code>SKIP LOCKED</code> lets thousands of workers claim concurrently instead of serialising on the head of the queue.
    Ordering is priority then age, filtered by skill, so urgent work jumps and nothing starves quietly.</li>
  <li><b>Task store → Worker:</b> the task, with a lease.
    The worker now holds <b>time-bounded ownership</b>, not a lock. If they close the laptop, nothing needs to notice.
    Lease length comes from the work: ~2–3× the expected completion time, so a slow-but-working person is not robbed mid-task.</li>
  <li><b>Worker → UI:</b> works on it; the UI autosaves a draft.
    Partial answers are saved both locally and server-side, so a browser crash or a dropped connection does not destroy twenty minutes of someone's effort.
    This matters more with humans than with machines — a lost machine retry costs CPU, a lost human answer costs goodwill and pay.</li>
  <li><b>UI → Heartbeat:</b> extend the lease while the tab is active.
    A live worker proves liveness implicitly; the heartbeat stops when the tab closes, the machine sleeps or the network drops.
    Heartbeats let you use a <b>much shorter lease</b> — minutes instead of hours — so abandoned work returns to the pool quickly instead of sitting invisible.</li>
  <li><b>Worker → Submit API:</b> submit the answer.
    Guarded on <code>owner = :me AND state = 'CLAIMED'</code>. If the lease expired and the task was reassigned, the submit is <b>rejected</b> rather than overwriting someone else's answer.
    That rejection needs a human-shaped message — "this task was reassigned while you were away" — because the worker did nothing wrong and will otherwise think the system ate their work.</li>
  <li><b>Submit API → Task store:</b> durable, then acknowledge.
    The answer and the audit event commit together before the UI confirms. A worker who saw "submitted" must never discover later that it was lost.</li>
  <li><b>Reaper → Task store:</b> expired lease → back to AVAILABLE, attempts++.
    This is the whole abandonment story: <b>no failure detector, no presence tracking, no "is this worker online" service.</b> The lease expires and the task returns.
    Attempts are incremented at <em>claim</em> time, not failure time, so a task that reliably causes people to give up still runs out of budget.</li>
  <li><b>Reaper:</b> attempts ≥ N → escalate, do not just fail.
    A task nobody completes is usually ambiguous rather than broken — the instructions are unclear, the image is unreadable, the case is genuinely hard.
    So it escalates to a senior queue or a supervisor rather than silently failing. <b>Repeated abandonment of one task is a signal about the task, not the workers.</b></li>
  <li><b>Router:</b> skill matching and priority.
    Tasks declare required skills; workers hold granted skills; the claim query intersects them. Priority lets urgent work pre-empt without a separate pipeline.
    Watch the pool size per skill: fragmenting into many narrow skills gives you a dozen tiny queues, each with terrible latency because only three people can serve it.</li>
  <li><b>Review pipeline:</b> SUBMITTED → review policy decides.
    Three shapes, chosen per batch: <b>none</b> (trusted workers, low stakes), <b>N-of-M agreement</b> (send the same task to several workers; agreement means done, disagreement escalates), or <b>reviewer pass</b> (a second, more trusted person checks).
    N-of-M multiplies cost by N and is the only option that gives a measurable confidence number — that trade is the design decision, and it should be per batch rather than global.</li>
  <li><b>Quality sampling:</b> gold tasks seeded into the stream.
    Tasks with known-correct answers are mixed in indistinguishably. A worker's accuracy on them is their trust score.
    This is the defence against click-through behaviour, and it must be <b>invisible</b> — a detectable gold task measures only whether someone can spot gold tasks.</li>
  <li><b>Progress API → Operator:</b> counts, age and blockages.
    Progress is a fold over per-task states — available, claimed, submitted, in review, done, failed, escalated — plus p95 queue age, which is the number that actually predicts whether the deadline will be met.
    The useful operator view is not "70% done" but <b>"what is stuck and why"</b>: skills with no available workers, tasks escalated repeatedly, review backlog growing.</li>
  <li><b>Audit log:</b> every transition, forever.
    Who claimed, when, what they answered, who reviewed, what changed. This is what settles quality disputes, payment disputes and compliance questions.
    It also makes the system debuggable in the only way that matters here: reconstructing exactly what one person saw and did.</li>
</ol>

## How it works, step by step {#hw-flow}

<ol class="order">
  <li>A batch materialises one row per task with required skills, priority and a payload pointer.</li>
  <li>Workers ask for work; the server picks via one conditional UPDATE with <code>SKIP LOCKED</code>, ordered by priority then age and filtered by skill.</li>
  <li>The claim stamps a lease; the UI autosaves drafts and heartbeats to extend it while the tab is alive.</li>
  <li>Submit is guarded on owner and state, so a reassigned task cannot be overwritten by a returning worker.</li>
  <li>A reaper returns expired leases to the pool; after N attempts the task escalates rather than failing.</li>
  <li>Review policy per batch — none, N-of-M agreement, or a reviewer pass — and gold tasks seeded invisibly maintain trust scores.</li>
  <li>Operators watch per-state counts and p95 queue age; every transition lands in an immutable audit log.</li>
</ol>

## Deep dives {#hw-deep}

<div class="cards">
  <div><h4>The state machine</h4><ul>
    <li>CREATED → AVAILABLE → CLAIMED(owner, leaseUntil) → SUBMITTED → IN_REVIEW → COMPLETED | REJECTED</li>
    <li>Plus ESCALATED (attempts exhausted) and CANCELLED (batch aborted).</li>
    <li>REJECTED returns to AVAILABLE with feedback attached, so the next worker sees why the last answer failed.</li>
    <li>Every edge is a guarded conditional update; <b>zero rows updated means "you lost ownership"</b>, and the UI must say so in human language.</li></ul></div>
  <div><h4>Humans change the tuning, not the mechanism</h4><ul>
    <li><b>Leases are minutes-to-hours</b>, not seconds — people think, take breaks, and are not machines.</li>
    <li><b>Heartbeats come free from the UI</b>, which is what lets leases be short despite long tasks.</li>
    <li><b>Autosave partial work.</b> A lost machine retry costs CPU; a lost human answer costs trust and pay.</li>
    <li><b>Rejected work needs an explanation.</b> A machine retries silently; a person needs to know what was wrong or they will repeat it.</li></ul></div>
  <div><h4>Quality is the actual problem</h4><ul>
    <li><b>Gold tasks</b> with known answers, seeded invisibly, give every worker a measurable accuracy.</li>
    <li><b>Trust score routes work</b> — high-trust workers skip review, low-trust get sampled harder, new workers start supervised.</li>
    <li><b>N-of-M agreement</b> buys a confidence number and multiplies cost by N. Use it where being wrong is expensive, not everywhere.</li>
    <li><b>Never show the queue.</b> Cherry-picking is the most common quality failure, and hiding the queue eliminates it by construction rather than by policy.</li></ul></div>
</div>

## Trade-offs {#hw-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Work selection</td><td>Server assigns; worker cannot browse</td><td>Worker autonomy and job satisfaction</td><td>Let workers pick only when the work is genuinely homogeneous — otherwise the hard tasks never get done</td></tr>
  <tr><td>Ownership</td><td>Lease with heartbeat from the UI</td><td>Detection latency equal to the lease</td><td>Presence tracking is more responsive and adds a service that must itself be right; the lease needs nothing to be alive</td></tr>
  <tr><td>Queue</td><td>Database rows with <code>SKIP LOCKED</code></td><td>The database is the hot path</td><td>At ~80 claims/s this is nowhere near a limit; a message queue would give up per-task state, reassignment and audit</td></tr>
  <tr><td>Quality</td><td>Gold tasks plus trust-routed review</td><td>Gold tasks cost real worker time to no output</td><td>N-of-M everywhere gives better confidence at N× the cost; no review at all is fine only for reversible, low-stakes work</td></tr>
  <tr><td>Skills</td><td>Explicit skills, intersected in the claim query</td><td>Pool fragmentation — narrow skills mean tiny pools and bad latency</td><td>Fully interchangeable workers is simpler and routes unqualified people to work they will get wrong</td></tr>
  <tr><td>Exhausted attempts</td><td>Escalate to a senior queue</td><td>Someone senior must actually work the queue</td><td>Failing outright is simpler and throws away the tasks that most need a human decision</td></tr>
  <tr><td>Partial answers</td><td>Autosave, and keep them on reassignment</td><td>Storage, plus a stale draft can mislead the next worker</td><td>Discarding is cleaner and loses work people already did — which they will notice and resent</td></tr>
</tbody></table>

## Safety-first design {#hw-safety}

<div class="cards">
  <div><h4>Exactly one owner, always</h4><ul>
    <li><b>The claim is the transaction.</b> One conditional UPDATE, never select-then-update — two people on one task means two payments and two conflicting answers.</li>
    <li><b>Guard every terminal transition</b> on owner and state, so a worker returning after an expired lease cannot overwrite the replacement's answer.</li>
    <li><b>Say it in human language.</b> "This task was reassigned while you were away" — the worker did nothing wrong and deserves to know.</li>
    <li><b>Cap concurrent tasks per worker</b> at one, so nobody can hoard work they will not finish.</li></ul></div>
  <div><h4>No task disappears, none runs forever</h4><ul>
    <li><b>Durable before acknowledged.</b> A worker who saw "submitted" must never lose that answer.</li>
    <li><b>Leases expire without help.</b> Abandonment needs no presence service and no failure detector.</li>
    <li><b>Attempts counted at claim time</b>, so a task people repeatedly give up on still exhausts its budget.</li>
    <li><b>Escalate, don't fail.</b> A task nobody can do is usually ambiguous — that is information for a supervisor, not a dead end.</li></ul></div>
  <div><h4>The worker is inside the threat model</h4><ul>
    <li><b>Hide the queue.</b> Cherry-picking is eliminated by construction rather than by policy.</li>
    <li><b>Invisible gold tasks.</b> A detectable quality check measures only whether someone can detect it.</li>
    <li><b>Rate-limit claims.</b> Scripted clients must not be able to fish for the easy work.</li>
    <li><b>Scope and audit every view.</b> Task content is customer data; who saw what and when is a first-class record, not a log line.</li></ul></div>
</div>

## Don't leave the room without saying {#hw-check}

<ul class="checklist">
  <li>Draw the state machine first: AVAILABLE → CLAIMED(owner, lease) → SUBMITTED → IN_REVIEW → COMPLETED, plus ESCALATED</li>
  <li>The claim is one conditional UPDATE with <code>SKIP LOCKED</code> — never select-then-update</li>
  <li>Lease, not lock: abandonment needs no presence tracking</li>
  <li>Heartbeat from the UI is what lets the lease be short</li>
  <li>Guard submit on owner and state; explain rejection in human language</li>
  <li>Attempts increment at claim time; exhausted attempts <em>escalate</em> rather than fail</li>
  <li>Server assigns, worker never browses — cherry-picking is the main quality failure</li>
  <li>Gold tasks and trust scores; N-of-M agreement only where being wrong is expensive</li>
  <li>Autosave partial answers — a lost human answer costs more than a lost machine retry</li>
  <li>Operators need p95 queue age and what is stuck, not a percentage</li>
</ul>

## What each level is expected to drive {#hw-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Task table, assign to a worker, mark done, show a progress bar</td><td>Duplicate claims, abandonment, timeouts</td></tr>
  <tr><td>Senior</td><td>Explicit state machine, atomic claim with SKIP LOCKED, leases and heartbeats, reaper, skill and priority routing, guarded submit, audit log</td><td>Review policies, escalation, pool fragmentation</td></tr>
  <tr><td>Staff+</td><td>Quality as the real problem — gold tasks, trust-routed review, hiding the queue — plus escalation as a signal about the task, and worker experience treated as a design constraint rather than a UI detail</td><td>—</td></tr>
</tbody></table>
