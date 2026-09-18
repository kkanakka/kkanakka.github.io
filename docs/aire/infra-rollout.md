---
title: "Model rollout: canary, promote, roll back without dropping streams"
slug: /aire/infra-rollout
sidebar_position: 33
sidebar_label: "Model rollout: canary, promote, roll bac…"
description: "hard · Anthropic · immutable versions · gates · prefetch · draining"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/infra-rollout/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">hard · Anthropic · immutable versions · gates · prefetch · draining</span>
</header>

## Requirements {#infra-rollout-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Register a new model version and roll it out gradually per region</li>
      <li>Gate each ramp step on automated checks</li>
      <li>Roll back in seconds</li>
      <li>Never drop an in‑flight stream during any of it</li>
      <li class="out">Training; distributing the bytes (#1)</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Rollback ≤ 60 s from decision to 0% traffic</li>
      <li>No client‑visible errors caused by rollout</li>
      <li>Every response attributable to an exact version</li>
      <li>Ramp bake time per step, e.g. 30 min at 5%, 1 h at 25%</li>
    </ol>
  </div>
</div>


## Scale, performance and safety targets {#infra-rollout-targets}

<p>Rollout is a low‑QPS control plane guarding a very high‑QPS data plane. These numbers are what make "roll back in 60 seconds" a design constraint rather than an aspiration.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> the control plane handles a handful of rollouts per week and a few router‑weight writes per minute. The data plane it steers is 100K QPS across thousands of replicas in several regions.</li>
    <li><b>Data volume:</b> a version is hundreds of GB of weights plus small artifacts (tokenizer, serving config, policy version, eval results); the registry itself holds kilobytes per version, with hundreds of versions retained.</li>
    <li><b>Growth:</b> release cadence is rising — assume weekly becomes daily, so anything manual in the ramp becomes a bottleneck; version count and the number of simultaneously live versions both grow.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> rollback ≤ 60 s from decision to 0% of new traffic, and router weight changes propagating fleet‑wide in &lt; 5 s. Bake times are deliberately long — 30 min at 5%, 1 h at 25% — because gates need enough traffic to be statistically meaningful.</li>
    <li><b>Throughput:</b> the new version must sustain the same tokens/s per cell as the old one before ramping past the spare‑capacity headroom; a model that is 20% slower per token needs 20% more replicas, and that must be verified, not assumed.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the threats are internal and procedural — promoting an unevaluated version, a mutable "latest" tag silently changing what is serving, an operator ramping past a failing gate, and a rollout that cannot be attributed afterwards. Immutability, blocking gates and audited actions address each.</li>
    <li><b>Rate limiting:</b> one active rollout per model per region, a minimum bake time per step that cannot be skipped, a cap on how far a single action may ramp, and two‑person approval for promoting to 100% or overriding a gate.</li>
    <li><b>Data sensitivity:</b> gates read production traffic, so evaluation samples must be handled under the same rules as prompts — aggregate where possible, never persist raw content in rollout records, and keep the audit trail to who/what/when rather than payloads.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> zero client‑visible errors attributable to a rollout — the API's four nines must be unaffected by the fact that a deployment is happening at all.</li>
    <li><b>Degraded mode:</b> registry unavailable → the router keeps serving its current weights, because the pointer is cached and rollouts simply pause. Gate signals unavailable → treat as a failing gate and stop ramping, never as a pass. Canary cell unhealthy → weights go to 0 automatically without waiting for a human.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> strong for the registry pointer — it is the one mutable thing in the system and two regions disagreeing about "current" is a real incident. Router weights can converge eventually within seconds.</li>
    <li><b>Durability:</b> every version, its artifacts and its eval results are immutable and retained, because "what exactly was serving when this happened?" must be answerable months later.</li>
    <li><b>Compliance:</b> every response carries its <code>model_version</code>, and every promote, pause, rollback and gate override is an audited, attributable event — this is what makes incident review and any external attestation possible.</li></ul></div>
</div>

## Entities and API {#infra-rollout-api}

<p>ModelVersion (immutable: weightsHash, tokenizer, servingConfig, policyVersion, evals) · Rollout (version, region, stage, weights, gates, status) · Replica (version loaded, state: READY | DRAINING | STOPPED) · RouterWeights (model → {version: %})</p>
<pre><code>POST /registry/versions {artifacts…}                   -&gt; version (immutable)
POST /rollouts {version, region, plan:[1,5,25,50,100]}   -&gt; rolloutId
POST /rollouts/:id/advance | /pause | /rollback
PUT  /router/weights {model, region, {v41:95, v42:5}}
POST /replicas/:id/drain                                -&gt; READY→DRAINING (health: not ready)</code></pre>

## Design {#infra-rollout-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/infra-rollout/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Rollout pipeline: immutable version in registry, prefetch weights to nodes, canary percentage via router, gates on burn rate and quality evals, promote by ramp, rollback by pointer flip, draining keeps in-flight streams on the old version">
  <defs><marker id="r1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker></defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.tm{font-size:10.5px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#r1)}</style>
  <rect class="box" x="20" y="30" width="130" height="60"></rect><text class="tb" x="85" y="50" text-anchor="middle">Registry</text><text class="tm" x="85" y="66" text-anchor="middle">v42 (immutable)</text><text class="ts" x="85" y="82" text-anchor="middle">weights hash, evals, card</text>
  <rect class="box" x="180" y="30" width="130" height="60"></rect><text class="tb" x="245" y="50" text-anchor="middle">Prefetch</text><text class="ts" x="245" y="66" text-anchor="middle">swarm weights to all</text><text class="ts" x="245" y="82" text-anchor="middle">nodes; warm on 1 cell</text>
  <rect class="box" x="340" y="30" width="130" height="60"></rect><text class="tb" x="405" y="50" text-anchor="middle">Canary 1%</text><text class="ts" x="405" y="66" text-anchor="middle">router weight v41:99 v42:1</text><text class="ts" x="405" y="82" text-anchor="middle">sticky per request only</text>
  <rect class="box" x="500" y="30" width="130" height="60" stroke="#B45309"></rect><text class="tb" x="565" y="50" text-anchor="middle">Gates</text><text class="ts" x="565" y="66" text-anchor="middle">burn rate ≤ baseline</text><text class="ts" x="565" y="82" text-anchor="middle">quality + safety evals</text>
  <rect class="box" x="660" y="30" width="130" height="60"></rect><text class="tb" x="725" y="50" text-anchor="middle">Ramp</text><text class="ts" x="725" y="66" text-anchor="middle">5 → 25 → 50 → 100%</text><text class="ts" x="725" y="82" text-anchor="middle">bake time per step</text>
  <rect class="box" x="820" y="30" width="140" height="60"></rect><text class="tb" x="890" y="50" text-anchor="middle">Promote</text><text class="ts" x="890" y="66" text-anchor="middle">flip "current" pointer</text><text class="ts" x="890" y="82" text-anchor="middle">keep v41 loaded (warm)</text>
  <path class="f" d="M150 60 L178 60"></path><path class="f" d="M310 60 L338 60"></path><path class="f" d="M470 60 L498 60"></path><path class="f" d="M630 60 L658 60"></path><path class="f" d="M790 60 L818 60"></path>
  <path class="f" d="M565 90 C 565 130, 430 130, 405 92" stroke-dasharray="4 3"></path><text class="ts" x="440" y="128">gate fails → weight v42:0, keep pods for debugging</text>
  <rect class="box" x="20" y="160" width="450" height="105"></rect><text class="tb" x="30" y="180">Draining a replica (old version) without dropping streams</text>
  <text class="ts" x="30" y="198">1 mark replica DRAINING: health check says "not ready" → router sends no new requests</text>
  <text class="ts" x="30" y="212">2 in‑flight streams continue to completion on the same replica (bounded by max_tokens)</text>
  <text class="ts" x="30" y="226">3 grace period = max stream duration + margin (e.g. 10 min); SIGTERM only after</text>
  <text class="ts" x="30" y="240">4 if a stream must move: it can't; a request is pinned to its KV cache. Let it finish.</text>
  <text class="ts" x="30" y="254">5 gateway keeps the client socket; replica swap is invisible to the client</text>
  <rect class="box" x="500" y="160" width="460" height="105"></rect><text class="tb" x="510" y="180">Rollback</text>
  <text class="ts" x="510" y="198">· pointer flip back to v41, which is still loaded (that's why you keep it warm)</text>
  <text class="ts" x="510" y="212">· seconds, not the minutes a weight reload would take</text>
  <text class="ts" x="510" y="226">· v42 streams in flight finish on v42; new requests go to v41</text>
  <text class="ts" x="510" y="240">· automatic on burn‑rate gate breach; manual override always available</text>
  <text class="ts" x="510" y="254">· never mutate a version; roll forward = new version number</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 678" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Model rollout flow">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="7" y="14" width="126" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Operator</text>
<line class="ln" x1="70" y1="48" x2="70" y2="658"></line>
<rect class="sb" x="147" y="14" width="126" height="34"></rect><text class="st" x="210" y="36" text-anchor="middle">Registry</text>
<line class="ln" x1="210" y1="48" x2="210" y2="658"></line>
<rect class="sb" x="287" y="14" width="126" height="34"></rect><text class="st" x="350" y="36" text-anchor="middle">Distribution</text>
<line class="ln" x1="350" y1="48" x2="350" y2="658"></line>
<rect class="sb" x="427" y="14" width="126" height="34"></rect><text class="st" x="490" y="36" text-anchor="middle">Router</text>
<line class="ln" x1="490" y1="48" x2="490" y2="658"></line>
<rect class="sb" x="567" y="14" width="126" height="34"></rect><text class="st" x="630" y="36" text-anchor="middle">Replicas v41</text>
<line class="ln" x1="630" y1="48" x2="630" y2="658"></line>
<rect class="sb" x="707" y="14" width="126" height="34"></rect><text class="st" x="770" y="36" text-anchor="middle">Replicas v42</text>
<line class="ln" x1="770" y1="48" x2="770" y2="658"></line>
<rect class="sb" x="847" y="14" width="126" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Gates</text>
<line class="ln" x1="910" y1="48" x2="910" y2="658"></line>
<line class="a1" x1="78" y1="80" x2="202" y2="80"></line>
<text class="sl" x="140" y="74" text-anchor="middle">register v42 (immutable)</text>
<line class="a3" x1="218" y1="114" x2="342" y2="114"></line>
<text class="sl" x="280" y="108" text-anchor="middle">prefetch weights to nodes</text>
<line class="a1" x1="358" y1="148" x2="762" y2="148"></line>
<text class="sl" x="560" y="142" text-anchor="middle">load + warm one cell</text>
<line class="a1" x1="78" y1="182" x2="482" y2="182"></line>
<text class="sl" x="280" y="176" text-anchor="middle">canary: v42 weight 1%</text>
<line class="a1" x1="498" y1="216" x2="762" y2="216"></line>
<text class="sl" x="630" y="210" text-anchor="middle">1% of new requests</text>
<line class="a1" x1="498" y1="250" x2="622" y2="250"></line>
<text class="sl" x="560" y="244" text-anchor="middle">99% of new requests</text>
<rect class="nt" x="800" y="271" width="220" height="22"></rect><text class="sl" x="910" y="286" text-anchor="middle">burn rate vs v41, evals, safety canaries, capacity</text>
<line class="a2" x1="902" y1="318" x2="78" y2="318"></line>
<text class="sl" x="490" y="312" text-anchor="middle">pass / fail</text>
<line class="a1" x1="78" y1="352" x2="482" y2="352"></line>
<text class="sl" x="280" y="346" text-anchor="middle">ramp 5 → 25 → 50 → 100</text>
<line class="a1" x1="78" y1="386" x2="202" y2="386"></line>
<text class="sl" x="140" y="380" text-anchor="middle">promote: current = v42</text>
<line class="a1" x1="498" y1="420" x2="622" y2="420"></line>
<text class="sl" x="560" y="414" text-anchor="middle">DRAINING: not ready</text>
<rect class="nt" x="520" y="441" width="220" height="22"></rect><text class="sl" x="630" y="456" text-anchor="middle">in-flight streams finish (≤ max stream)</text>
<rect class="nt" x="520" y="475" width="220" height="22"></rect><text class="sl" x="630" y="490" text-anchor="middle">SIGTERM after grace; keep some v41 warm</text>
<line class="a2" x1="902" y1="522" x2="78" y2="522"></line>
<text class="sl" x="490" y="516" text-anchor="middle">breach detected</text>
<line class="a1" x1="78" y1="556" x2="202" y2="556"></line>
<text class="sl" x="140" y="550" text-anchor="middle">rollback: current = v41</text>
<line class="a1" x1="78" y1="590" x2="482" y2="590"></line>
<text class="sl" x="280" y="584" text-anchor="middle">weights v42 → 0</text>
<rect class="nt" x="675" y="611" width="190" height="22"></rect><text class="sl" x="770" y="626" text-anchor="middle">v42 in-flight streams finish</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Operator → Registry:</b> register v42 (immutable).
    A version is the full bundle — weights hash, tokenizer, serving config, safety policy version and eval results — and any change to any part produces a new version rather than mutating this one.
    Immutability is what makes rollback trivial and attribution possible: "v42" means exactly one thing forever, in every region.
    Registration is not activation; nothing serves yet, which is what lets the expensive preparation happen off the critical path.</li>
  <li><b>Registry → Distribution:</b> prefetch weights to nodes (async).
    Hundreds of GB are pushed to every node <em>before</em> any traffic decision, using the swarm distribution system.
    This is why a ramp step takes seconds instead of minutes: without prefetch, every increase in canary percentage would stall behind a weight load.
    Prefetching early also means a rollback target stays resident, which is what makes the 60‑second rollback possible at all.</li>
  <li><b>Distribution → Replicas v42:</b> load + warm one cell.
    One cell loads the weights and runs warm‑up requests so caches, kernels and memory pools are primed before real users arrive.
    A cold replica's first requests are dramatically slower, and without warming that shows up as a canary failure caused by the rollout mechanism rather than by the model.</li>
  <li><b>Operator → Router:</b> canary: v42 weight 1%.
    The rollout is a routing weight change, not a deployment — both versions are already loaded and ready, so exposure is a dial rather than a rebuild.
    Starting at 1% bounds the blast radius: if the new version is catastrophic, 99% of traffic never touched it.</li>
  <li><b>Router → Replicas v42:</b> 1% of new requests.
    The weight applies at request start only, and a request is then pinned to its replica and version for its whole lifetime.
    Pinning is what makes streaming safe: a long response cannot be half‑generated by v41 and half by v42.</li>
  <li><b>Router → Replicas v41:</b> 99% of new requests.
    The old version keeps serving normally throughout, which is what makes a comparison meaningful — both versions are handling the same traffic mix at the same moment.
    It also means "stop the rollout" requires no recovery: the majority path was never disturbed.</li>
  <li><b>Gates:</b> burn rate vs v41, evals, safety canaries, capacity.
    Gates compare v42 against v41 on the same traffic slice, which controls for time of day, region and customer mix far better than any absolute threshold.
    Four independent signals must hold: SLO burn rate on TTFT/ITL/completion, quality metrics from the online A/B, safety canaries on the new version, and measured cell throughput.
    The capacity gate is the one people forget — a model that is slower per token needs more replicas, and discovering that at 100% is an outage.</li>
  <li><b>Gates → Operator:</b> pass / fail (response).
    A missing or unavailable signal counts as a failure, never as a pass, so a broken gate pauses the rollout instead of waving it through.
    Bake time is enforced here too: a gate that has not seen enough traffic to be statistically meaningful has not passed yet.</li>
  <li><b>Operator → Router:</b> ramp 5 → 25 → 50 → 100.
    Each step multiplies exposure and then bakes, so problems that only appear at scale — memory pressure, cache thrash, a rare prompt pattern — surface while most traffic is still safe.
    Ramping is a weight change at every step, so the cost of advancing and the cost of retreating are identical.</li>
  <li><b>Operator → Registry:</b> promote: current = v42.
    Flipping the registry pointer is the only mutation in the entire design — everything else is immutable artifacts and routing weights.
    Promotion means new replicas start on v42 by default; it does not evict anything, which keeps the previous version available.</li>
  <li><b>Router → Replicas v41:</b> DRAINING: not ready.
    Draining is expressed through health status rather than by killing processes: the replica reports not‑ready, so the router stops sending it new requests while it keeps serving existing ones.
    Using the same health mechanism the router already honours means there is no special rollout code path to get wrong.</li>
  <li><b>Replicas v41:</b> in-flight streams finish (≤ max stream).
    Existing streams run to completion on the version that started them, bounded by max_tokens, so no user sees a truncated or mid‑stream error because of a deployment.
    This is exactly why the grace period must be at least the maximum stream duration — a shorter one turns a rollout into dropped responses.</li>
  <li><b>Replicas v41:</b> SIGTERM after grace; keep some v41 warm.
    Only after the grace period do processes actually stop, and deliberately not all of them: a subset of v41 replicas stays loaded and warm.
    That warm reserve is the rollback plan — without it, rolling back means reloading hundreds of GB and the 60‑second target is unreachable.</li>
  <li><b>Gates → Operator:</b> breach detected (response).
    Detection can happen at any point, including after promotion, since gates keep evaluating past 100%.
    Severe breaches trigger the rollback automatically rather than waiting for a human, because the time to a decision is most of the time to recovery.</li>
  <li><b>Operator → Registry:</b> rollback: current = v41.
    Rollback is the same pointer flip in reverse — the same, well‑exercised code path as promotion, not a special emergency procedure.
    Because v41 is immutable and still loaded, there is nothing to rebuild, re‑fetch or re‑verify.</li>
  <li><b>Operator → Router:</b> weights v42 → 0.
    New traffic stops reaching v42 within seconds of the weight propagating, which is the metric that actually matters for a rollback SLA.
    v42's replicas stay up rather than being torn down, so the failure can be investigated on the live instances that produced it.</li>
  <li><b>Replicas v42:</b> v42 in-flight streams finish.
    Even during a rollback, in‑flight requests complete on the version that started them — unless the breach is a safety issue, in which case streams are cut deliberately.
    That distinction is worth stating out loud: a latency regression drains gracefully, a safety breach does not get to finish its sentence.</li>
</ol>

## How it works, step by step {#infra-rollout-flow}

<ol class="order">
  <li>Version registered; weights prefetched to every node via the distribution system; one cell loads and warms it.</li>
  <li>Rollout starts: router weight 1% to v42 for new requests only; requests are pinned to a replica for their lifetime.</li>
  <li>Gates evaluate continuously: burn rate vs baseline on the same slice, safety canaries, quality metrics, cell throughput.</li>
  <li>Gate pass → advance to next percentage and bake; gate fail → weight 0, keep replicas up for debugging, alert.</li>
  <li>At 100%, flip the registry pointer; keep v41 loaded on a subset of replicas for fast rollback.</li>
  <li>Old replicas drain: health reports not‑ready, no new requests, in‑flight streams finish (bounded by max_tokens), then SIGTERM after grace.</li>
  <li>Rollback = pointer flip + weights; v42 in‑flight streams complete on v42.</li>
</ol>

## Deep dives {#infra-rollout-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/infra-rollout/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
  <div><h4>Immutability and identity</h4><ul>
    <li>A version = weights hash + tokenizer + serving config + safety policy version. Any change is a new version. Responses carry <code>model_version</code> so incidents are attributable.</li>
    <li>Registry pointer "current" per (model, region) is the only mutable thing; changing it is the rollout.</li></ul></div>
  <div><h4>Gates that actually block</h4><ul>
    <li>Burn rate on TTFT/ITL/completion compared against the baseline version on the same traffic slice.</li>
    <li>Quality: offline eval suite before canary; online A/B metrics (refusal rate, length, user feedback) during bake.</li>
    <li>Safety canaries (#4) must pass on the new version.</li>
    <li>Capacity: new version may be slower per token → verify cell throughput before ramping past the +1 headroom.</li></ul></div>
  <div><h4>Streams and connections</h4><ul>
    <li>The client's connection terminates at the gateway, never at the replica; replicas can churn without client‑visible errors.</li>
    <li>Router pins a request to a replica for its lifetime; "canary %" applies at request start only.</li>
    <li>Weight prefetch is why rollout is fast; without it every ramp step is a multi‑minute load (ties to #1).</li></ul></div>
</div>


## Trade-offs {#infra-rollout-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Version identity</td><td>Fully immutable bundles; only the pointer moves</td><td>Storage for many retained versions, and no quick "just patch the config"</td><td>Never — a mutable version means "what was serving?" becomes unanswerable exactly when you most need the answer</td></tr>
  <tr><td>Exposure control</td><td>Percentage canary on new requests</td><td>Two versions live at once, so metrics must be sliced by version to mean anything</td><td>Blue/green when the two versions cannot coexist (incompatible state or tokenizer), at the cost of a much bigger blast radius per flip</td></tr>
  <tr><td>Weight loading</td><td>Prefetch to every node before the first ramp</td><td>Disk and bandwidth spent on a version that may never be promoted</td><td>Load on demand only when weights are small; at hundreds of GB it makes both ramp and rollback minutes‑slow</td></tr>
  <tr><td>Old version lifecycle</td><td>Keep a warm subset of the previous version</td><td>Capacity held for something not serving traffic</td><td>Release it once confidence is high and the error budget is healthy — but "seconds‑fast rollback" and "nothing warm" are mutually exclusive</td></tr>
  <tr><td>Stream handling</td><td>Pin a request to a version for its lifetime; drain gracefully</td><td>Drain takes as long as the longest stream, so rollouts are slow to fully complete</td><td>Cut streams immediately only for safety breaches, where finishing the response is itself the harm</td></tr>
  <tr><td>Gate strictness</td><td>Missing signal = failing gate</td><td>A flaky metrics pipeline can stall a healthy rollout</td><td>Never invert it — treating absent data as a pass is how an unevaluated version reaches 100%</td></tr>
  <tr><td>Bake time</td><td>Long bakes at low percentages</td><td>Rollouts take hours to days, which slows iteration</td><td>Shorten only when traffic volume makes the gates statistically significant sooner; time is a proxy for sample size, not a ritual</td></tr>
</tbody></table>

## Safety-first design {#infra-rollout-safety}

<div class="cards">
  <div><h4>Small blast radius by construction</h4><ul>
    <li><b>Start at 1%.</b> The first real users to touch a new version are a rounding error of traffic, so a catastrophic version is a contained incident rather than an outage.</li>
    <li><b>Both versions serve throughout.</b> The old path is never disturbed, so stopping a rollout requires no recovery — only a weight change.</li>
    <li><b>Automatic rollback on severe breach.</b> Waiting for a human is most of the time to recovery; gates that detect a safety or capacity breach drive the weight to zero themselves.</li>
    <li><b>Region by region.</b> A rollout is orchestrated per region so a bad version cannot be global before anyone has looked at it.</li></ul></div>
  <div><h4>Gates that cannot be waved through</h4><ul>
    <li><b>Safety canaries are a hard gate.</b> A new model version must pass the safety suite on the version actually serving, not on an equivalent build.</li>
    <li><b>Absent signal means stop.</b> A gate with no data has not passed; treating silence as success is how unevaluated versions reach 100%.</li>
    <li><b>Capacity is a safety property.</b> A slower model at full traffic is an availability incident, so measured throughput gates the ramp just like quality does.</li>
    <li><b>Overrides are two‑person and audited.</b> Skipping a gate is sometimes right, but it should be a recorded, deliberate act with a name attached.</li></ul></div>
  <div><h4>Never hurt a request that is already running</h4><ul>
    <li><b>Client connections terminate at the gateway.</b> Replicas can start, drain and stop freely without a customer ever seeing a reset connection.</li>
    <li><b>Pin the version for the request's lifetime.</b> A response is generated entirely by one version, so output can never be a blend of two models.</li>
    <li><b>Grace ≥ maximum stream duration.</b> Draining that is shorter than the longest possible response converts a routine rollout into dropped answers.</li>
    <li><b>Except for safety.</b> A safety breach is the one case where in‑flight streams are cut rather than allowed to finish — stated explicitly, because the default is the opposite.</li></ul></div>
</div>

## Don't leave the room without saying {#infra-rollout-check}

<ul class="checklist">
  <li>Immutable versions; the only mutable thing is the pointer</li>
  <li>Prefetch before flip; why weight load time otherwise dominates</li>
  <li>Gates that block: burn rate, evals, safety canaries, capacity</li>
  <li>Request pinning + gateway‑terminated client connections = no dropped streams</li>
  <li>Draining semantics and grace period ≥ max stream duration</li>
  <li>Keep previous version warm for seconds‑fast rollback</li>
  <li>Responses carry model_version</li>
</ul>

## What each level is expected to drive {#infra-rollout-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Blue/green or canary with a load balancer, manual promote, rollback by redeploy</td><td>Draining, gates</td></tr>
  <tr><td>Senior</td><td>Immutable registry, percentage canary, automated gates, draining without dropping streams, warm rollback</td><td>Capacity gate, prefetch</td></tr>
  <tr><td>Staff+</td><td>Gate design tied to SLOs and safety, multi‑region orchestration, rollout of dependent components (classifiers, tokenizers) together, audit and attribution</td><td>—</td></tr>
</tbody></table>
