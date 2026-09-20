---
title: "Safely batch reboot N machines in a fleet"
slug: /cw/batch-reboot
sidebar_position: 1
sidebar_label: "Safely batch reboot N machines in a fleet"
description: "hard · disruption budget · waves · drain and verify · halt on anomaly · two state machines"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/batch-reboot/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">hard · disruption budget · waves · drain and verify · halt on anomaly · two state machines</span>
</header>
<p>Operators need to reboot thousands of machines — kernel upgrades, firmware, hardware remediation, node recovery — without taking down capacity they cannot afford to lose. The naive version is a for-loop over a machine list, and it is the single most reliable way to cause an outage with a tool designed to prevent one. The real design is about <b>what you refuse to do</b>: how much may be down at once, who is allowed to say no, and when to stop.</p>

<div class="trap"><b>The framing that scores:</b> a reboot tool is not a scheduler, it is an <em>admission controller</em> that happens to reboot things. Every interesting decision is a permission check — is this machine safe to take, is this service still above its floor, has anything got worse since the last wave. Get that ordering right and the rest is mechanical.</div>

## Requirements {#br-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Submit a reboot request by selector, with a reason and a ticket reference</li>
      <li>Resolve and validate the target set; show a dry run before anything moves</li>
      <li>Reboot in waves that respect per-service and per-failure-domain limits</li>
      <li>Track every machine through drain, reboot, boot, verify, return</li>
      <li>Pause, resume, abort; retry or skip individual machines</li>
      <li class="out">Performing the upgrade itself; provisioning new hardware</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Never breach a service's capacity floor, whatever the request says</li>
      <li>A stuck machine must not stall the whole job</li>
      <li>Every action attributable: who, when, why, which ticket</li>
      <li>Abort must stop within one wave, not one machine</li>
      <li>Safe to run concurrently with other reboot jobs</li>
    </ol>
  </div>
</div>

## Scale, performance and safety targets {#br-targets}

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> a control plane measured in <em>requests per day</em>, not per second — tens of reboot jobs, a few thousand machine transitions/hour at peak. The load is trivial; the consequences are not.</li>
    <li><b>Data volume:</b> 50,000 machines in inventory, each with a service mapping, failure domain and health state. A job's history is a few hundred KB; retained for audit, so tens of GB over years.</li>
    <li><b>Growth:</b> fleet ~1.5× annually. What actually grows is the number of <em>services</em> sharing the fleet, and therefore the number of independent capacity floors the scheduler must respect simultaneously.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> dry-run resolves in &lt; 5 s for a 50K-machine selector. Per machine: drain p95 &lt; 5 min, reboot-to-healthy p95 &lt; 10 min, hard timeout 30 min. Abort takes effect in &lt; 30 s.</li>
    <li><b>Throughput:</b> deliberately capped by safety, not capability. A 10,000-machine job at 2% concurrency is 200 at a time — roughly 10 hours. <b>Going faster is not a goal;</b> the tool's value is that it finishes at all.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the dangerous actor is a well-meaning operator with a bad selector. <code>--all</code>, a typo'd label, a selector that silently matches every control-plane node — these are the incidents. Also: two jobs targeting overlapping sets, and a retry loop rebooting a machine that never comes back.</li>
    <li><b>Rate limiting:</b> a fleet-wide cap on machines in flight, a per-service disruption budget, a per-failure-domain cap, a per-operator job limit, and a maximum job size above which a second approver is required.</li>
    <li><b>Data sensitivity:</b> low on content, high on authority. This system can take production down, so it is the <em>credentials</em> that matter: scoped to a fleet, short-lived, two-person approval for large jobs, and an immutable audit trail of every action.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.9% for the control plane — and crucially, <b>if the controller dies, nothing continues.</b> Machines already draining stay drained; no new reboots are issued. Failing stopped is the correct posture for a destructive tool.</li>
    <li><b>Degraded mode:</b> inventory unreachable → refuse to start new jobs (an unknown machine is not a safe machine). Health signals missing → treat as unhealthy and halt the wave. Kubernetes API down → no new drains; in-flight machines complete or time out.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> the machine claim must be strongly consistent — two jobs must never both own a machine. Progress counters can lag; the per-machine state machine cannot.</li>
    <li><b>Durability:</b> job state and the audit log are durable. A controller restart resumes from the database, not from memory — there is no in-flight state that exists only in a process.</li>
    <li><b>Idempotency:</b> every step is safe to retry. "Reboot this machine" issued twice must not produce two reboots, which is why each attempt carries a token the agent deduplicates on.</li></ul></div>
</div>

## Entities and API {#br-api}

<p>RebootJob (id, selector, reason, ticket, waveSize, policy, state, createdBy) · Target (jobId, machineId, state, attempts, lease, lastError) · Machine (id, failureDomain, services[], health, currentJobId) · DisruptionBudget (service, minAvailable, currentlyDown) · Wave (index, targets[], startedAt, outcome) · AuditEvent (actor, action, machineId, at, reason).</p>
<pre><code>POST /jobs           {selector, reason, ticket, policy}   -&gt; {jobId, dryRun}   # resolves, never acts
POST /jobs/:id/start {expectedCount}                       -&gt; 202               # count must match the dry run
POST /jobs/:id/pause | /resume | /abort
GET  /jobs/:id                                             -&gt; {waves, perState counts, blocked[], eta}
GET  /jobs/:id/targets?state=FAILED                        -&gt; per-machine timeline + lastError
POST /jobs/:id/targets/:machine/skip | /retry

Internal:
  GET  /inventory/machines?selector=                       -&gt; machines + failureDomain + services
  POST /budget/reserve {service, machineId}                -&gt; GRANTED | DENIED(reason)   # atomic
  POST /agent/:machine/reboot {token, deadline}            -&gt; accepted (idempotent on token)</code></pre>

## Design {#br-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/batch-reboot/architecture.svg" alt="A reboot tool is an admission controller that happens to reboot things. Every interesting step is a permission check, and the correct answer is often &quot;no&quot;." class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

### Flow between components

<ol class="order">
  <li><b>Operator → Job API:</b> POST /jobs {selector, reason, ticket}.
    The request is a <em>selector</em>, never a machine list — "kernel &lt; 6.1 and pool = batch", so the set is resolved against live inventory rather than a stale spreadsheet.
    Reason and ticket are mandatory fields, not comments: they are what make the audit log answer "why was production rebooted on a Friday".
    This call <b>resolves and validates only</b>. Nothing moves.</li>
  <li><b>Job API → Inventory:</b> resolve the selector.
    Inventory is the source of truth for which machines exist, what failure domain they are in, and which services run on them — the service mapping is what makes disruption budgets possible at all.
    If inventory is unreachable the job is refused rather than started optimistically: <b>an unknown machine is not a safe machine.</b></li>
  <li><b>Job API → Operator:</b> dry run — count, blast radius, and what it would refuse.
    Returns the matched count, a breakdown per service and failure domain, the machines it would <em>skip</em> and why, and an ETA.
    This is the single highest-value feature in the system. Most bad selectors are obvious the moment someone sees "matches 48,300 machines, including 100% of the control plane".
    <b>Start requires echoing the expected count back</b> — so if inventory changed between the dry run and the start, the mismatch aborts rather than silently rebooting a different set.</li>
  <li><b>Operator → Job API:</b> start {expectedCount}.
    The two-step submit/confirm is deliberate friction on a destructive action, and the count check makes it a real safety gate rather than a confirmation dialog people click through.
    Above a size threshold this requires a second approver, recorded in the audit log.</li>
  <li><b>Scheduler:</b> order targets by failure domain, then cap concurrency.
    Targets are sorted so a wave spreads across racks, power domains and availability zones rather than concentrating — rebooting one rack at a time looks orderly and takes out a whole failure domain at once.
    Concurrency is capped three ways simultaneously: fleet-wide in-flight, per failure domain, and per service. <b>The tightest cap wins</b>, and it is usually the service one.</li>
  <li><b>Scheduler:</b> canary wave — one machine, full verification.
    The first wave is a single machine taken all the way through drain, reboot, boot and verify before anything else starts.
    It catches the failures that make the whole job wrong: a bad kernel that does not boot, an agent that cannot reach the BMC, a verification check that never passes.
    Discovering that on machine 1 costs one machine; discovering it on machine 500 is an incident.</li>
  <li><b>Scheduler → Budget service:</b> reserve {service, machine} — atomically.
    This is the admission control step and the heart of the design. For every service on the machine, the budget service atomically checks "would taking this machine put the service below its floor?" and either grants or denies.
    The reservation is held for the machine's whole lifecycle and released on return, so <b>concurrent reboot jobs and ordinary failures draw from the same budget</b> and cannot collectively breach it.
    A denial is not an error — it is the machine being deferred to a later wave.</li>
  <li><b>Scheduler → Target store:</b> claim the machine with a lease.
    A conditional update stamps owner and expiry, so two jobs can never both own a machine — the same atomic-claim pattern as any work queue.
    The lease is what makes a controller crash survivable: ownership expires on its own, with no failure detector required.</li>
  <li><b>Executor → Kubernetes:</b> cordon, then drain respecting PodDisruptionBudgets.
    Cordon first so the scheduler stops placing new work while eviction is in progress.
    Drain evicts pods and <b>honours PDBs</b>, which means the cluster gets its own veto — a service that would drop below its own minimum simply refuses the eviction, and the drain blocks.
    A blocked drain is information, not a failure: it usually means the service is already degraded, and continuing would make it worse.</li>
  <li><b>Executor:</b> drain timeout → stop, do not force.
    If the drain has not completed within its deadline, the machine is marked BLOCKED, uncordoned, its budget released, and the job moves on.
    <b>Force-deleting pods to meet a schedule is how a reboot tool causes the outage it exists to prevent.</b> The right response to "I cannot do this safely" is to not do it.</li>
  <li><b>Executor → Agent:</b> reboot {token, deadline}.
    The token makes the command idempotent — a retried instruction must not produce a second reboot while the first is in progress.
    The deadline gives the machine a bounded window to come back before it is treated as failed, and it is passed down rather than tracked only centrally so an orphaned agent still gives up.</li>
  <li><b>Machine:</b> reboot; agent re-registers on boot.
    The machine is expected to disappear — losing contact here is the normal path, not an error, and the state machine must say so explicitly.
    Re-registration is the first signal of life, and it carries the new kernel or firmware version so the job can confirm the change actually took.</li>
  <li><b>Executor:</b> verify — health checks, then a functional probe.
    Being reachable is not being ready. The machine must pass node health, rejoin the cluster, and then serve a representative request before it counts.
    <b>Verification is where the goal is actually achieved</b> — a machine that boots but cannot serve is worse than one still rebooting, because it looks fine and will receive traffic.</li>
  <li><b>Executor → Kubernetes:</b> uncordon; release the budget reservation.
    Only after verification does the machine return to service and its budget slot free up, allowing the next machine to be admitted.
    Release-after-verify is what makes the budget honest: released at reboot time, the tool would be counting machines as healthy while they were still booting.</li>
  <li><b>Controller:</b> between waves — re-evaluate, then decide.
    Before the next wave the controller re-reads health, error rates and the budget, because the fleet may have changed for reasons unrelated to this job.
    <b>A wave that produced any failure does not automatically continue.</b> Halt-on-anomaly is the difference between a tool that stops after two bad machines and one that reboots four hundred.
    Anything unhealthy that this job did not cause is also grounds to pause — the fleet is telling you something.</li>
  <li><b>Operator → Job API:</b> abort.
    Abort stops issuing new work immediately and lets in-flight machines finish their current step — mid-drain machines are uncordoned, mid-reboot machines are allowed to come back and verify.
    The one thing abort must never do is leave machines cordoned and forgotten, which is why a reconciliation loop returns any machine with no active job.</li>
</ol>

## How it works, step by step {#br-flow}

<ol class="order">
  <li>Submit a selector with a reason and ticket; the system resolves it against live inventory and returns a dry run with counts, blast radius and what it would refuse.</li>
  <li>Start requires echoing the expected count, and a second approver above a size threshold.</li>
  <li>Targets are ordered to spread across failure domains, then capped by fleet, domain and per-service disruption budgets — tightest cap wins.</li>
  <li>A single-machine canary goes all the way through before any wave runs.</li>
  <li>Per machine: reserve budget → claim with a lease → cordon → drain honouring PDBs → reboot with an idempotent token → wait for re-registration → verify health and a functional probe → uncordon → release budget.</li>
  <li>Drain timeouts block rather than force; boot timeouts fail the machine; any wave failure halts the job for a human decision.</li>
  <li>Between waves the controller re-reads fleet health and refuses to continue into a degrading fleet.</li>
</ol>

## Deep dives {#br-deep}

<div class="cards">
  <div><h4>Two state machines, kept separate</h4><ul>
    <li><b>Job:</b> DRAFT → VALIDATED → RUNNING → PAUSED → COMPLETED | ABORTED. Owned by the operator.</li>
    <li><b>Target (per machine):</b> PENDING → RESERVED → DRAINING → REBOOTING → BOOTING → VERIFYING → RETURNED, plus BLOCKED, FAILED, SKIPPED. Owned by the executor.</li>
    <li>Keeping them separate is what lets a job be "80% done with 3 blocked" — a single flat status cannot express partial completion, and partial completion is the normal outcome.</li>
    <li>Every transition is an audit event with actor, reason and timestamp, so a machine's history reads as a timeline rather than a final status.</li></ul></div>
  <div><h4>Disruption budget is the whole safety story</h4><ul>
    <li>Per service: <code>minAvailable</code> as a count or percentage, checked atomically before any machine is taken.</li>
    <li><b>Shared with reality:</b> organic failures consume the same budget, so a fleet already down 3% gets less reboot concurrency automatically.</li>
    <li>A machine running several services must satisfy <em>all</em> their budgets — the tightest constraint decides.</li>
    <li>Kubernetes PDBs are a second, independent veto at drain time. Belt and braces, because the budget service knows capacity while the cluster knows actual pod placement.</li></ul></div>
  <div><h4>Stuck machines and partial completion</h4><ul>
    <li>Three different timeouts — drain, boot, verify — because they mean different things and need different responses.</li>
    <li><b>Blocked ≠ failed.</b> Blocked means "cannot do this safely right now" and is retried in a later wave; failed means the machine is broken and needs a human.</li>
    <li>Bounded attempts per machine, then park it. A machine that will not come back must not consume the job forever.</li>
    <li>The job completes with a manifest: returned, blocked, failed, skipped. <b>"Finished with 12 failures" is a valid, useful outcome</b>; "still running after three days" is not.</li></ul></div>
</div>

## Trade-offs {#br-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Target specification</td><td>Selector resolved at start</td><td>The set can change between dry run and start</td><td>A frozen machine list is reproducible and rots — it reboots machines that moved service or no longer exist. The echoed-count check covers the drift</td></tr>
  <tr><td>Capacity safety</td><td>Central disruption budget, reserved atomically</td><td>A service to run, and a dependency in the critical path</td><td>Relying on Kubernetes PDBs alone is simpler but blind to anything outside the cluster and to organic failures</td></tr>
  <tr><td>Blocked drains</td><td>Give up and defer</td><td>Jobs take longer and may not finish in a window</td><td>Never force-delete pods to hit a schedule — that is the tool causing the outage it exists to prevent</td></tr>
  <tr><td>Wave failures</td><td>Halt and wait for a human</td><td>Jobs need babysitting</td><td>Auto-continue is fine for genuinely stateless fleets; everywhere else it turns two bad machines into four hundred</td></tr>
  <tr><td>Readiness signal</td><td>Health checks plus a functional probe</td><td>Slower returns, and a probe to maintain per service</td><td>"Responds to ping" is cheaper and puts traffic on machines that boot but cannot serve</td></tr>
  <tr><td>Controller failure</td><td>Fail stopped — nothing continues</td><td>An operator must restart the job</td><td>Never fail open on a destructive tool; a controller that keeps rebooting while blind is the worst case available</td></tr>
  <tr><td>Concurrency</td><td>Conservative, safety-capped</td><td>Long jobs — 10K machines can take a day</td><td>Raise it only with evidence from the canary and real headroom; speed is not the product here</td></tr>
</tbody></table>

## Safety-first design {#br-safety}

<div class="cards">
  <div><h4>Refuse before you act</h4><ul>
    <li><b>Dry run is mandatory and free.</b> Most bad selectors are obvious the moment someone sees the matched count and the blast radius.</li>
    <li><b>Echo the count to start.</b> If inventory shifted since the dry run, the mismatch aborts rather than quietly rebooting a different set.</li>
    <li><b>Reserve budget before touching anything.</b> Admission control first, action second — the same ordering as reserving inventory before taking payment.</li>
    <li><b>Two-person approval above a threshold</b>, recorded with the ticket, because some jobs deserve a second pair of eyes by policy rather than by hope.</li></ul></div>
  <div><h4>Stop early, stop cheaply</h4><ul>
    <li><b>Canary of one.</b> A bad kernel found on machine 1 costs one machine; found on machine 500 it is an incident.</li>
    <li><b>Halt on anomaly between waves.</b> Any failure, or any unrelated fleet degradation, pauses for a human decision.</li>
    <li><b>Blocked is a legitimate outcome.</b> "I cannot do this safely" defers the machine rather than escalating force.</li>
    <li><b>Abort within one wave</b>, and a reconciliation loop that returns any machine left cordoned with no active job.</li></ul></div>
  <div><h4>Everything attributable, nothing ambiguous</h4><ul>
    <li><b>Reason and ticket are required fields</b>, so the audit log answers "why" and not just "what".</li>
    <li><b>Every transition is an event</b> with actor and timestamp — a machine's history is a timeline, not a final status.</li>
    <li><b>Idempotent commands.</b> A retried reboot instruction carries a token the agent deduplicates on, so a flaky network cannot double-reboot a machine.</li>
    <li><b>Leases, not locks.</b> A controller crash releases its claims by expiry, so nothing is stranded owned-by-nobody.</li></ul></div>
</div>

## Don't leave the room without saying {#br-check}

<ul class="checklist">
  <li>A reboot tool is an admission controller that happens to reboot things</li>
  <li>Selector plus dry run plus echoed count — never a machine list, never one-step start</li>
  <li>Disruption budget reserved atomically per service, shared with organic failures</li>
  <li>Kubernetes PDBs as an independent second veto at drain time</li>
  <li>Order waves to spread across failure domains; the tightest cap wins</li>
  <li>Canary of one, all the way through verification, before any wave</li>
  <li>Blocked ≠ failed; never force-delete pods to hit a schedule</li>
  <li>Verify with a functional probe — booted is not ready</li>
  <li>Release the budget after verification, not after reboot</li>
  <li>Halt on anomaly between waves; fail stopped if the controller dies</li>
</ul>

## What each level is expected to drive {#br-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Queue of machines, reboot in batches of N, cordon and drain first, track status</td><td>Disruption budgets, canary, verification, partial completion</td></tr>
  <tr><td>Senior</td><td>Two state machines, atomic budget reservation, failure-domain spreading, canary, drain timeouts that block rather than force, halt on anomaly, functional verification</td><td>Concurrent jobs sharing a budget, reconciliation of orphaned cordons</td></tr>
  <tr><td>Staff+</td><td>Framing it as admission control, budgets shared with organic failure, fail-stopped controller posture, approval policy tied to blast radius, and treating partial completion as the expected outcome rather than an error</td><td>—</td></tr>
</tbody></table>
