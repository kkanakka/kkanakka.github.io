---
title: "Kubernetes deployment pipeline: commit to production"
slug: /cw/k8s-deploy-pipeline
sidebar_position: 8
sidebar_label: "Kubernetes deployment pipeline: commit …"
description: "hard · immutable artifacts · GitOps reconciliation · progressive delivery · gates that block · rollback in seconds"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/k8s-deploy-pipeline/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">hard · immutable artifacts · GitOps reconciliation · progressive delivery · gates that block · rollback in seconds</span>
</header>
<p>A commit becomes a running pod across many clusters, safely, hundreds of times a day. The pipeline part is easy — build, test, push, apply. <b>The design is everything that decides not to proceed:</b> which artifact is allowed to run, who may promote it, what evidence gates each environment, and how fast you can undo it. A deploy pipeline is a supply chain with a rollback button, and both halves need designing.</p>

<div class="trap"><b>The framing that scores:</b> build and deploy are two different systems joined by one immutable artifact. The build side is a <em>supply chain</em> problem — provenance, signing, reproducibility. The deploy side is a <em>control loop</em> — desired state, observed state, reconcile. Conflating them gives you the anti-pattern where CI has production credentials and pushes directly, which is both the security hole and the reason nobody can tell what is actually running.</div>

## Requirements {#kdp-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Commit → build → test → signed immutable artifact</li>
      <li>Promote the same artifact through dev, staging, production</li>
      <li>Progressive rollout per cluster with automated gates</li>
      <li>Roll back to the previous known-good in seconds</li>
      <li>Show what is running where, and which commit produced it</li>
      <li class="out">Writing the tests, cluster provisioning, the application itself</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>The artifact promoted is byte-identical across environments</li>
      <li>No pipeline component holds standing production credentials</li>
      <li>Rollback ≤ 2 min from decision to healthy old version</li>
      <li>A failed gate stops the rollout; it never warns and proceeds</li>
      <li>Every production change attributable to a commit and an approver</li>
    </ol>
  </div>
</div>

## Scale, performance and safety targets {#kdp-targets}

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>Throughput:</b> ~500 commits/day across ~300 services, ~150 production deploys/day. Peak is a weekday afternoon, and the queue that matters is <em>builds</em>, not deploys.</li>
    <li><b>Data volume:</b> container images at ~200 MB–1 GB each, ~2,000 builds/day → ~1 TB/day of new layers before dedup; with content-addressed layers the real growth is a fraction of that. Manifests and provenance are kilobytes.</li>
    <li><b>Growth:</b> services grow faster than commits per service, so the sharp edge is <b>fan-out</b> — one platform change touching 300 services is 300 rollouts, and that is the case the design must survive.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> commit → artifact p95 &lt; 10 min (developers context-switch past that); artifact → staging &lt; 5 min; a full production progressive rollout 30–60 min deliberately, because bake time is the point. <b>Rollback &lt; 2 min.</b></li>
    <li><b>Throughput:</b> the build farm sizes to peak commits, not average — a queue of 40 minutes at 4pm is the most common developer-facing complaint about any pipeline.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> a deploy pipeline is the highest-value target in the organisation — it has, by definition, the ability to run arbitrary code in production. The threats are a malicious dependency, a compromised build runner, a tampered image between build and deploy, and an insider pushing straight to prod.</li>
    <li><b>Rate limiting:</b> concurrent rollouts capped per cluster and fleet-wide so a platform-wide change cannot deploy to everything at once; a cap on how many services one change may touch without extra approval; and a deployment freeze window that is enforced rather than announced.</li>
    <li><b>Data sensitivity:</b> secrets must never enter an image or a manifest in git. They are injected at runtime from a secrets manager via workload identity, so the artifact is safe to store, copy and inspect, and a leaked image is not a leaked credential.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.9% for the pipeline — but the real requirement is that <b>a pipeline outage must not prevent a rollback.</b> The emergency path has to work when the normal path is broken.</li>
    <li><b>Degraded mode:</b> CI down → running workloads unaffected, and rollback still works because it is a git revert plus a reconcile, not a rebuild. Registry down → nodes with the image cached keep running; new pods cannot start, which is why pre-pull matters. Reconciler down → clusters keep running the last applied state, which is exactly the right failure.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> git is the source of truth for desired state and is strongly consistent. Cluster state converges eventually, and <b>drift is expected rather than exceptional</b> — the reconciler's job is to notice and correct it continuously.</li>
    <li><b>Immutability:</b> images are referenced by digest, never by tag. A mutable tag means the artifact you tested is not provably the artifact you ran, which destroys every other guarantee in the chain.</li>
    <li><b>Attribution:</b> every running pod traces to a digest, a commit, a build, and an approver — and that chain must be queryable during an incident, not reconstructable afterwards.</li></ul></div>
</div>

## Entities and API {#kdp-api}

<p>Commit (sha, author, repo) · Build (id, commitSha, artifactDigest, provenance, testResults) · Artifact (digest, signature, SBOM) · Release (artifactDigest, version, approvals[]) · Environment (name, clusters[], policy) · Rollout (releaseId, cluster, strategy, stage, gates[], state) · DesiredState (git path → manifest with digest) · Drift (cluster, resource, expected, observed).</p>
<pre><code>CI:        commit -&gt; build -&gt; test -&gt; push image by DIGEST -&gt; sign + attest provenance
Promotion: PUT  env/staging/service.yaml   image: repo@sha256:abc…     # a git commit, reviewed
Reconcile: agent pulls git, diffs against cluster, applies difference  # pull, never push
Rollout:   kubectl-visible strategy (canary %, bake, gates) driven by a progressive-delivery controller
Rollback:  git revert the promotion commit -&gt; reconcile -&gt; previous digest, already cached on nodes

POST /releases/:digest/promote {env, approver}   -&gt; opens a promotion PR / commit
GET  /whatsrunning?service=&amp;cluster=             -&gt; digest, commit, deployedAt, approver
POST /rollouts/:id/abort                          -&gt; halt and revert to the last healthy stage</code></pre>

## Design {#kdp-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/k8s-deploy-pipeline/architecture.svg" alt="Build and deploy are two systems joined by one immutable artifact. CI never holds cluster credentials — the cluster pulls, so a compromised pipeline can propose but not deploy." class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

### Flow between components

<ol class="order">
  <li><b>Developer → Git:</b> merge to main.
    Main is the trigger, and branch protection plus review is the first gate — everything downstream assumes the commit was seen by a second person.
    The commit sha is the identity that will travel all the way to a running pod; every later artifact references it.</li>
  <li><b>Git → CI:</b> build in an ephemeral, hermetic runner.
    A fresh runner per build means a compromised build cannot persist into the next one — the single most valuable property of the build tier.
    Dependencies are resolved from a pinned lockfile against an internal mirror, because "the build pulls whatever is latest from the internet" is the supply-chain hole most pipelines still have.</li>
  <li><b>CI:</b> test, then produce one immutable image.
    Unit and integration tests run here because this is the cheapest place to fail. The output is a single artifact that will be promoted unchanged — <b>never rebuilt per environment.</b>
    Rebuilding for staging and again for production means you tested one binary and shipped a different one, and every difference between them is invisible.</li>
  <li><b>CI → Registry:</b> push, and reference by digest forever after.
    The image is addressed as <code>repo@sha256:…</code>, not <code>repo:v1.2</code>. A tag is a mutable pointer someone can move; a digest is the content.
    This is the same immutable-artifact-plus-pointer pattern as any rollout system — the digest is the artifact, the environment file is the pointer.</li>
  <li><b>CI → Attestation store:</b> sign the image and record provenance.
    Signature proves it came from this pipeline; the provenance attestation records which commit, which builder, which dependencies; the SBOM records what is inside.
    None of this matters until the day it does — a vulnerability disclosure where the only useful question is "which of our running images contain this package", answerable in seconds or not at all.</li>
  <li><b>CI → Env repo:</b> open a promotion change for staging.
    Promotion is a <b>commit to a git repository</b>, not an API call to a cluster — so the desired state of every environment is reviewable, diffable and revertible with ordinary tools.
    Staging usually auto-promotes; production requires an approval, and that difference is policy expressed as branch protection rather than as code.</li>
  <li><b>Reconciler → Env repo:</b> pull the desired state.
    The agent runs <em>inside</em> the cluster and <b>pulls</b>. CI never holds cluster credentials, which removes the single most dangerous permission in the organisation from the most exposed system.
    A compromised CI can then propose a bad change, but it still has to pass review and policy — one compromise is no longer game over.</li>
  <li><b>Reconciler → Cluster:</b> diff desired against observed, apply the difference.
    This is a control loop, not a deployment event: it runs continuously, so manual <code>kubectl edit</code> drift is detected and corrected rather than silently persisting until the next deploy surprises someone.
    Reconciling toward a declared state also makes a partially applied change self-healing instead of leaving the cluster in a half-updated state.</li>
  <li><b>Admission control:</b> refuse anything that violates policy.
    The cluster gets its own veto: only signed images from the approved registry, no <code>:latest</code>, resource limits present, no privileged containers, required labels.
    <b>This is the backstop that does not depend on the pipeline being correct</b> — it catches what review missed and what a compromised pipeline might try.</li>
  <li><b>Progressive delivery controller → Cluster:</b> shift traffic in stages.
    Not "replace all pods": route 5% → 25% → 50% → 100%, baking at each step so problems surface while most traffic is still on the old version.
    Both versions serve throughout, so stopping requires no recovery — it is a weight change, exactly as in a model rollout.</li>
  <li><b>Gates → Controller:</b> evaluate, and block.
    Error rate and latency compared against the <em>previous version on the same traffic slice</em>, not against an absolute threshold — that controls for time of day and traffic mix.
    <b>A missing signal is a failing gate.</b> If metrics are unavailable the rollout pauses; treating absent data as a pass is how an unverified version reaches 100%.</li>
  <li><b>Controller:</b> gate fails → halt and revert this stage.
    Traffic returns to the previous version within seconds, because the old pods are still running — nothing to rebuild, nothing to pull.
    The failed version is left in place, not torn down, so it can be investigated on the instance that actually failed.</li>
  <li><b>Operator → Env repo:</b> rollback is a git revert.
    Reverting the promotion commit restores the previous digest, the reconciler applies it, and the image is already cached on the nodes — which is what makes the two-minute target achievable.
    Crucially this path <b>does not need CI</b>: rollback works when the build system is down, which is exactly when you are most likely to need it.</li>
  <li><b>Everything → Inventory:</b> what is running, where, from which commit.
    A queryable map from running pod → digest → build → commit → approver, maintained continuously rather than reconstructed during an incident.
    "Is the fix deployed everywhere?" and "which clusters still run the bad version?" are the two questions asked in every rollout incident, and they should be one query.</li>
</ol>

## How it works, step by step {#kdp-flow}

<ol class="order">
  <li>Merge to main triggers a hermetic build in an ephemeral runner with pinned dependencies.</li>
  <li>Tests run once; the output is a single immutable image, pushed and referenced by digest, then signed with provenance and an SBOM.</li>
  <li>Promotion is a reviewed commit to an environment repo — staging auto, production with approval.</li>
  <li>An in-cluster reconciler pulls desired state and continuously converges the cluster toward it; CI never holds cluster credentials.</li>
  <li>Admission control independently refuses unsigned images, mutable tags and missing limits.</li>
  <li>A progressive delivery controller shifts traffic 5 → 25 → 50 → 100% with gates comparing against the previous version on the same slice; a missing signal blocks.</li>
  <li>A failed gate halts and reverts in seconds; a full rollback is a git revert that works even with CI down.</li>
</ol>

## Deep dives {#kdp-deep}

<div class="cards">
  <div><h4>Push versus pull, and why pull wins</h4><ul>
    <li><b>Push:</b> CI runs <code>kubectl apply</code>. Simple, and it requires CI to hold production credentials — handing the keys to the most internet-exposed system you own.</li>
    <li><b>Pull:</b> an in-cluster agent fetches desired state. Credentials never leave the cluster, and the cluster can be behind a firewall with no inbound path.</li>
    <li>Pull also gives <b>continuous reconciliation</b> for free: drift is corrected, not just overwritten at the next deploy.</li>
    <li>The cost is indirection — "I merged, why isn't it live" needs a visible reconciliation status, or people lose trust in the pipeline.</li></ul></div>
  <div><h4>Supply chain: the parts that matter</h4><ul>
    <li><b>Hermetic, ephemeral builds</b> — pinned dependencies from an internal mirror, fresh runner each time, so a compromise cannot persist.</li>
    <li><b>Sign the artifact, verify at admission.</b> Signing alone is theatre if nothing checks it; the cluster must refuse unsigned images.</li>
    <li><b>Provenance + SBOM</b> turn "are we affected by this CVE" into a query rather than a week of archaeology.</li>
    <li><b>Digest, never tag.</b> A mutable tag means the thing you tested is not provably the thing you ran.</li></ul></div>
  <div><h4>Making rollback genuinely fast</h4><ul>
    <li><b>The old version is still running</b> during a progressive rollout, so reverting is a traffic shift, not a deployment.</li>
    <li><b>Old images stay cached on nodes</b> — image pull is usually the slowest step, and skipping it is most of the two-minute target.</li>
    <li><b>Rollback must not need CI.</b> Git revert plus reconcile works when the build system is down, which is when you need it most.</li>
    <li><b>Database migrations are the exception</b>, and the reason rollback plans fail — expand/contract, backwards-compatible for at least one release, never a destructive change in the same deploy as the code that needs it.</li></ul></div>
</div>

## Trade-offs {#kdp-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Delivery model</td><td>Pull-based reconciliation (GitOps)</td><td>Indirection — merge and deploy are decoupled</td><td>Push is simpler and gives CI production credentials, which is the worst permission grant in the organisation</td></tr>
  <tr><td>Artifact identity</td><td>Digest, built once, promoted unchanged</td><td>Environment-specific builds are impossible — config must be injected</td><td>Never rebuild per environment: you would test one binary and ship another</td></tr>
  <tr><td>Rollout strategy</td><td>Progressive traffic shifting with gates</td><td>Deploys take 30–60 min, and two versions coexist</td><td>Rolling update is faster and gives no automated evidence before full exposure; blue/green doubles capacity but flips all at once</td></tr>
  <tr><td>Gate posture</td><td>Missing signal = failing gate</td><td>A flaky metrics pipeline can stall healthy rollouts</td><td>Never invert it — treating absent data as a pass is how an unverified version reaches 100%</td></tr>
  <tr><td>Config and secrets</td><td>Injected at runtime, never in the image</td><td>A secrets manager and workload identity to operate</td><td>Baking config in makes the artifact environment-specific and a leaked image into a leaked credential</td></tr>
  <tr><td>Policy enforcement</td><td>Admission control in the cluster</td><td>Another component, and a new way for deploys to be refused</td><td>Relying on the pipeline alone means one compromised pipeline is total compromise</td></tr>
  <tr><td>Environment promotion</td><td>Same artifact, reviewed commit per environment</td><td>More commits, and promotion is not instant</td><td>Auto-promoting to production is faster and removes the last human checkpoint before customer impact</td></tr>
</tbody></table>

## Safety-first design {#kdp-safety}

<div class="cards">
  <div><h4>The pipeline is the highest-value target you own</h4><ul>
    <li><b>CI holds no production credentials.</b> Pull-based reconciliation means a compromised build system can propose, not deploy.</li>
    <li><b>Ephemeral hermetic runners.</b> A compromise cannot persist into the next build, and dependencies come from a pinned internal mirror.</li>
    <li><b>Verify signatures at admission, not just at build.</b> Signing that nothing checks is decoration.</li>
    <li><b>Secrets never enter the artifact</b>, so a leaked image is not a leaked credential and images stay safe to cache and inspect.</li></ul></div>
  <div><h4>Gates that actually stop things</h4><ul>
    <li><b>Compare against the previous version on the same slice</b>, which controls for time of day and traffic mix far better than an absolute threshold.</li>
    <li><b>Absent data blocks.</b> A gate with no signal has not passed.</li>
    <li><b>Bake time is sample size</b>, not ritual — shorten it only when traffic makes the comparison significant sooner.</li>
    <li><b>Cap the blast radius of one change.</b> A platform change touching 300 services needs a different approval path than a one-service fix.</li></ul></div>
  <div><h4>Make the undo path the reliable one</h4><ul>
    <li><b>Rollback must work with CI down.</b> Git revert plus reconcile, no rebuild — because outages rarely arrive one at a time.</li>
    <li><b>Keep the old version warm.</b> Still-running pods and cached images are what turn "rollback" from a deploy into a traffic shift.</li>
    <li><b>Migrations expand/contract.</b> The classic reason a rollback plan fails is a schema change that the previous code cannot read.</li>
    <li><b>Know what is running.</b> Pod → digest → commit → approver, queryable during the incident rather than reconstructed after it.</li></ul></div>
</div>

## Don't leave the room without saying {#kdp-check}

<ul class="checklist">
  <li>Build and deploy are two systems joined by one immutable artifact — supply chain, then control loop</li>
  <li>Build once, promote unchanged; reference by digest, never by tag</li>
  <li>Pull-based reconciliation so CI never holds production credentials</li>
  <li>Continuous reconciliation means drift is corrected, not discovered at the next deploy</li>
  <li>Admission control as an independent veto — signed images, no <code>:latest</code>, limits present</li>
  <li>Progressive traffic shifting with gates compared against the previous version on the same slice</li>
  <li>A missing signal is a failing gate</li>
  <li>Rollback is a git revert that works with CI down, against pods still running and images still cached</li>
  <li>Expand/contract migrations, or the rollback plan is fiction</li>
  <li>Pod → digest → commit → approver, queryable during the incident</li>
</ul>

## What each level is expected to drive {#kdp-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>CI builds an image, pushes to a registry, <code>kubectl apply</code> per environment, rollback by redeploying the old tag</td><td>Digests vs tags, pull vs push, progressive delivery</td></tr>
  <tr><td>Senior</td><td>Build once and promote by digest, GitOps reconciliation, progressive rollout with blocking gates, admission policy, runtime secret injection, fast rollback via revert</td><td>Provenance and SBOM, migration strategy, drift handling</td></tr>
  <tr><td>Staff+</td><td>Supply chain and control loop as distinct problems, credential blast radius driving the pull decision, gates as evidence rather than ceremony, and designing the rollback path to work when the rest of the pipeline does not</td><td>—</td></tr>
</tbody></table>
