---
title: "Prompt playground for very large prompts"
slug: /aire/prompt-playground
sidebar_position: 45
sidebar_label: "Prompt playground for very large prompts"
description: "hard · Anthropic · versioned prompts · very large payloads · runs and comparison · safe execution"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/prompt-playground/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

## How it works

<header>
  
  <span class="tag">hard · Anthropic · versioned prompts · very large payloads · runs and comparison · safe execution</span>
</header>
<p>Developers write prompts, pick model settings, run them against models, and come back later to see what they tried. Two things make it more than CRUD: prompts can be <b>very large</b> — hundreds of KB to tens of MB once documents are pasted in — and the valuable artifact is not the prompt but the <b>run</b>: prompt version, settings, model version and output, captured together so a result can be reproduced and compared.</p>

## Requirements {#pp-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Create, edit and version prompts, including templates with variables</li>
      <li>Handle very large prompt bodies and attached documents without the editor degrading</li>
      <li>Run against a chosen model with settings; stream the output; stop a run</li>
      <li>Revisit, diff and compare runs side by side; share a prompt or a run</li>
      <li class="out">Training models, production serving, evaluation harnesses</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Editor stays responsive at 10 MB of prompt text; autosave never blocks typing</li>
      <li>Every run is reproducible: exact prompt version, settings and model version</li>
      <li>Runs are expensive — a large prompt is a large bill, so cost is visible before running</li>
      <li>Nothing a user pastes is ever treated as an instruction to the platform</li>
    </ol>
  </div>
</div>
<div class="note"><b>The shape to draw first:</b> Prompt is a mutable head pointing at immutable PromptVersions; a Run is an immutable record referencing (promptVersionId, settings, modelVersion, outputRef). Large bodies live in object storage with the row holding only a pointer and a hash. That separation is what makes versioning cheap, runs reproducible, and 10 MB prompts possible at all.</div>

## Scale, performance and safety targets {#pp-targets}

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> a developer tool, so modest — a few thousand API requests/s, of which perhaps 50/s are actual model runs. Autosave and editor traffic dominate the request count while runs dominate the cost.</li>
    <li><b>Data volume:</b> prompt bodies from 1 KB to 10 MB, averaging perhaps 50 KB; 100K prompts with 20 versions each and several runs per version means tens of millions of immutable blobs and low double‑digit TB.</li>
    <li><b>Growth:</b> context windows are growing faster than user count, so average prompt size grows faster than anything else — design for the body to outgrow the metadata by another order of magnitude.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> keystroke to echo &lt; 16 ms regardless of document size; autosave acknowledged p95 &lt; 300 ms and never blocking; prompt open p95 &lt; 500 ms for 10 MB; time to first token matching the underlying model API.</li>
    <li><b>Throughput:</b> uploads and loads of large bodies go directly to and from object storage, so the API tier's capacity is independent of prompt size — the same property that makes a file service work.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the sharp edges are cost and content. A 10 MB prompt run in a loop is an expensive denial of wallet; prompts are often written specifically to jailbreak a model; and pasted documents may contain injection aimed at whatever consumes the output later.</li>
    <li><b>Rate limiting:</b> runs per user per hour and a token‑spend budget per user and per org, a hard cap on prompt body size, a cap on concurrent runs, and autosave throttled so an editor cannot hammer the API.</li>
    <li><b>Data sensitivity:</b> pasted content is the most sensitive data in the product — customer documents, internal specs, and pasted credentials. Private by default, secret‑scan on save, encrypt at rest, share only through explicit revocable grants, and make deletion remove bodies, versions, runs and outputs together.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.9%. Losing work in progress is the failure users care about far more than an outage, so autosave durability matters more than availability.</li>
    <li><b>Degraded mode:</b> model API unavailable → the run is recorded as failed with its inputs intact so it can be replayed, never silently lost. Object storage slow → editing continues from the local buffer and autosave retries. Streaming dropped mid‑run → reconnect and resume from the buffered output rather than re‑running and re‑billing.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> strong for versions and runs — a run must reference an exact immutable version, or reproducibility is a claim rather than a fact. Listing and search can be eventual.</li>
    <li><b>Durability:</b> prompt bodies and run outputs are user work that cannot be regenerated cheaply (a large run costs real money), so both get full durability rather than being treated as cache.</li>
    <li><b>Reproducibility:</b> the product's core promise. A run pins prompt version, every setting including temperature and seed, and the model version — and if the model version is later retired, the run says so instead of silently becoming unreproducible.</li></ul></div>
</div>

## Entities and API {#pp-api}

<p>Prompt (id, ownerId, visibility, headVersionId, title) · PromptVersion (id, promptId, seq, bodyRef, bodyHash, bodySize, variables[], createdBy) · Run (id, promptVersionId, settings, modelVersion, status, outputRef, tokensIn/Out, cost, startedAt) · Attachment (blobRef, extractedTextRef) · Share (grantee, role).</p>
<pre><code>POST /prompts                          {title, visibility}      -&gt; prompt (v1, empty)
POST /prompts/:id/versions/upload-url  {size, hash}             -&gt; presigned PUT (bodies &gt; 256 KB)
POST /prompts/:id/versions             {bodyRef|bodyInline, note} -&gt; new immutable version, head moves
POST /runs                             {promptVersionId, settings, model} -&gt; SSE stream of deltas, then {runId, usage, cost}
POST /runs/:id/stop
GET  /runs?promptId=&amp;cursor=                                     -&gt; run history for comparison
GET  /runs/:a/diff/:b                                            -&gt; settings diff + output diff</code></pre>

## Design {#pp-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/prompt-playground/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

### Flow between components

<ol class="order">
  <li><b>Editor → Local buffer:</b> user types; edits applied locally first.
    The editor never waits on the network to render a keystroke, which is the only way to stay responsive at 10 MB.
    Large documents are virtualised so rendering cost depends on the viewport rather than on document size — the same technique a code editor uses.</li>
  <li><b>Editor → Prompt service:</b> autosave a draft (debounced, delta if possible).
    Autosave is debounced and sends a delta rather than the whole body, because re‑uploading 10 MB every few seconds is unusable and expensive.
    Drafts are separate from versions: saving continuously must not create a hundred versions an hour, so a version is created only when the user asks or on a meaningful boundary.
    Losing typed work is the failure users punish hardest, so the draft is durable even though it is not yet a version.</li>
  <li><b>Prompt service → Object store:</b> large bodies go direct via a presigned URL.
    Above a threshold — a few hundred KB — the body bypasses the API entirely and the client PUTs it straight to object storage.
    This is the same decision as a file service: proxying multi‑megabyte payloads through the API makes its capacity a function of prompt size, which is exactly what must not happen.
    Small bodies stay inline in the database, because a round trip to object storage for 2 KB is pure latency.</li>
  <li><b>Prompt service → Metadata DB:</b> create immutable PromptVersion {bodyRef, hash, size}.
    The version row is tiny — a pointer, a hash and a size — so versioning a 10 MB prompt costs bytes, not megabytes.
    Content addressing by hash means an unchanged body across versions is stored once, which matters when someone edits a sentence in a huge document.
    Immutability is what makes a run reproducible: the version a run points at can never change underneath it.</li>
  <li><b>User → Run service:</b> POST /runs {promptVersionId, settings, model}.
    A run references a version rather than "the current prompt", so a later edit cannot retroactively change what a run was.
    Settings and model version are captured explicitly rather than defaulted, because "which temperature was that?" is the question the product exists to answer.</li>
  <li><b>Run service:</b> estimate tokens and cost; check budget; show it before spending.
    A 10 MB prompt is an expensive request, and a user who runs one by accident should find out beforehand.
    Token estimation and a per‑user and per‑org budget check happen here, before any model call, so the expensive resource is only reached by a run that is known to be affordable.
    This admission step is the difference between a playground and a denial‑of‑wallet vector.</li>
  <li><b>Run service → Object store:</b> fetch the body by ref.
    The body is streamed from storage rather than held in the service, so memory per run is bounded regardless of prompt size.
    The hash is verified on the way through, so a run is never made against a body that differs from the version it claims.</li>
  <li><b>Run service → Safety:</b> classify input before generating.
    Pasted content is untrusted by construction — it may be a jailbreak attempt or an injection aimed at whatever reads the output later.
    Classification happens concurrently with prefill so it adds no perceptible latency, but no token is released until it passes.</li>
  <li><b>Run service → Model API:</b> stream with the pinned model version.
    Pinning the version rather than an alias like "latest" is what keeps the run reproducible — an alias silently changes what a saved run meant.
    If a pinned version is later retired, the run records that fact rather than quietly re‑running against something else.</li>
  <li><b>Model API → Run service:</b> token stream (response).
    Output is streamed so a long generation is visible immediately, and buffered so a dropped browser connection does not require paying for the run twice.</li>
  <li><b>Run service → Editor:</b> SSE deltas (response).
    The client reconnects with a last‑event id and resumes from the buffer, because re‑running is both slow and billable.
    Output safety runs on the stream with a small lookahead so unsafe content is cut before display rather than retracted after.</li>
  <li><b>Run service → Object store:</b> persist the full output; record usage and cost.
    Outputs are stored as blobs for the same reason prompts are — they can be large, and the row should hold a pointer.
    Token counts and cost come from the model API's own accounting rather than from an estimate, so the recorded figure is the real one.</li>
  <li><b>Run service → Metadata DB:</b> mark the run COMPLETE (or FAILED with inputs intact).
    A failed run keeps its inputs and its error so it can be replayed — silently losing an expensive run's parameters is the worst outcome available here.
    The run row is immutable once terminal, which is what makes run history a reliable record rather than a mutable log.</li>
  <li><b>User → Run service:</b> compare runs A and B side by side.
    Comparison is the reason the product stores runs at all: what changed in the prompt, what changed in the settings, and what changed in the output.
    Because both runs pin immutable versions, the diff is exact rather than reconstructed — which is only possible because of the decisions made in steps four and nine.
    A settings diff sits alongside the output diff, since a difference caused by temperature is a completely different finding from one caused by a prompt edit.</li>
  <li><b>User → Sharing:</b> share a prompt or a run; permission checked on every read.
    Sharing a <em>run</em> is distinct from sharing a prompt — it exposes an output and its inputs, which may include pasted confidential documents.
    Authorization is evaluated on each read rather than baked into a link, so revocation takes effect immediately.
    A warning at the moment of sharing is worth more than a policy page, because the person sharing usually has not thought about what is inside a 10 MB paste.</li>
</ol>

## How it works, step by step {#pp-flow}

<ol class="order">
  <li>The editor applies edits locally and autosaves debounced drafts; large bodies go straight to object storage through presigned URLs.</li>
  <li>Committing a draft creates an immutable PromptVersion whose row holds only a content‑addressed pointer, hash and size.</li>
  <li>A run references an exact version, pins model version and settings, and is admitted only after a token and cost estimate passes the user's budget.</li>
  <li>Input safety runs concurrently with prefill; the model streams output, which is buffered so a dropped connection resumes rather than re‑runs.</li>
  <li>The run is persisted with its output blob and real usage figures, immutable once terminal — including failures, which keep their inputs for replay.</li>
  <li>Runs are compared side by side, diffing prompt version, settings and output, which is exact because every referenced artifact is immutable.</li>
</ol>

## Deep dives {#pp-deep}

<div class="cards">
  <div><h4>Very large prompts</h4><ul>
    <li><b>Bodies in object storage, pointers in rows.</b> A 10 MB prompt with 20 versions is 200 MB of blobs and a few KB of metadata.</li>
    <li><b>Content addressing.</b> Editing one sentence in a huge document stores one new blob, and identical bodies across versions are stored once.</li>
    <li><b>Direct upload and download.</b> Presigned URLs keep multi‑megabyte payloads off the API tier entirely.</li>
    <li><b>Virtualised editor plus delta autosave.</b> Rendering cost follows the viewport and save cost follows the edit, not the document.</li></ul></div>
  <div><h4>Runs are the real artifact</h4><ul>
    <li>A run pins prompt version, every setting, and the exact model version — reproducibility is a data‑model property, not a feature.</li>
    <li>Aliases like "latest" silently destroy reproducibility; pin versions and record when one is retired.</li>
    <li>Failed runs keep their inputs and error so they can be replayed; an expensive run whose parameters vanish is the worst failure here.</li>
    <li>Comparison — prompt diff, settings diff, output diff — is the feature that justifies storing all of it.</li></ul></div>
  <div><h4>Cost is a first-class concern</h4><ul>
    <li>Estimate tokens and show cost before the run, because a 10 MB prompt is a meaningful bill and accidents are easy.</li>
    <li>Budgets per user and per org, enforced at admission, so a loop cannot spend without limit.</li>
    <li>Buffer output for resume: paying twice for the same generation because a laptop slept is avoidable and annoying.</li>
    <li>Record actual usage from the model API rather than the estimate, so history reflects real spend.</li></ul></div>
</div>

## Trade-offs {#pp-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Where bodies live</td><td>Object storage above a size threshold; inline below it</td><td>Two storage paths and a threshold to tune</td><td>All‑inline is simpler and makes a 10 MB prompt a database problem; all‑blob adds a round trip to every 2 KB prompt</td></tr>
  <tr><td>Versioning</td><td>Immutable versions, content‑addressed bodies</td><td>Storage grows with edits; "current" needs a head pointer</td><td>In‑place editing is cheaper and makes every past run unreproducible, which is the product's core promise</td></tr>
  <tr><td>Drafts versus versions</td><td>Autosave drafts separately; versions are explicit</td><td>Two concepts users must understand</td><td>Versioning every autosave is simpler and produces hundreds of meaningless versions per session</td></tr>
  <tr><td>Model reference</td><td>Pin the exact version in every run</td><td>Runs can reference retired models</td><td>An alias always resolves and silently changes what a saved run meant — the opposite of reproducible</td></tr>
  <tr><td>Cost control</td><td>Estimate and check budget before running</td><td>An extra step before an expensive action</td><td>Running first and billing after is friendlier right up until someone loops a 10 MB prompt</td></tr>
  <tr><td>Stream recovery</td><td>Buffer output for resume</td><td>Memory per in‑flight run</td><td>Re‑running is simpler and charges the user twice for the same generation</td></tr>
  <tr><td>Sharing granularity</td><td>Prompts and runs shared separately</td><td>Two permission surfaces</td><td>One combined grant is simpler and means sharing a prompt silently exposes every document ever pasted into a run of it</td></tr>
</tbody></table>

## Safety-first design {#pp-safety}

<div class="cards">
  <div><h4>Everything pasted is untrusted</h4><ul>
    <li><b>Prompts are data, never instructions.</b> Nothing a user writes or pastes is interpreted as an instruction to the platform itself.</li>
    <li><b>Classify input and output.</b> Prompts written to jailbreak a model are a primary use of a playground, so safety runs on the real path, not a test one.</li>
    <li><b>Render, never execute.</b> Output is displayed as text and markdown; a playground that evaluates model output has created a code‑execution service by accident.</li>
    <li><b>Injection travels downstream.</b> A pasted document may target whatever consumes the output later, which is worth flagging when a run is shared or exported.</li></ul></div>
  <div><h4>Pasted documents are the sensitive asset</h4><ul>
    <li><b>Private by default.</b> Prompts and runs start private, so publishing is always deliberate.</li>
    <li><b>Scan for secrets on save.</b> API keys and tokens get pasted into prompts constantly; catching them at write time beats discovering them after a share.</li>
    <li><b>Warn at the moment of sharing.</b> The person sharing a 10 MB prompt usually has not re‑read what is inside it.</li>
    <li><b>Deletion reaches everything.</b> Bodies, versions, runs, outputs and attachments — a delete that leaves the run output behind has not deleted the document.</li></ul></div>
  <div><h4>Never lose or silently spend</h4><ul>
    <li><b>Durable drafts.</b> Autosave is durable before it is acknowledged, because losing typed work is the failure users punish hardest.</li>
    <li><b>Show cost before spending.</b> A token and cost estimate ahead of an expensive run turns a surprise bill into a decision.</li>
    <li><b>Budgets at admission.</b> Per‑user and per‑org caps are enforced before the model is called, so a loop cannot run away.</li>
    <li><b>Failures keep their inputs.</b> A failed run is replayable; an expensive run whose parameters vanished is the worst possible outcome.</li></ul></div>
</div>

## Don't leave the room without saying {#pp-check}

<ul class="checklist">
  <li>Prompt is a mutable head; PromptVersion is immutable; Run is an immutable record referencing both</li>
  <li>Large bodies in object storage via presigned URLs, content‑addressed; rows hold pointers</li>
  <li>Drafts autosave as deltas; versions are explicit, so a session does not create a hundred of them</li>
  <li>Runs pin prompt version, settings and exact model version — aliases destroy reproducibility</li>
  <li>Estimate tokens and check budget before running; record real usage afterwards</li>
  <li>Buffer output for resume so a dropped connection does not re‑bill a run</li>
  <li>Private by default, secret‑scan on save, permissions checked on every read, deletion reaches runs and outputs</li>
</ul>

## What each level is expected to drive {#pp-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>CRUD for prompts, call the model API, store history in a database</td><td>Versioning, large payloads, reproducibility</td></tr>
  <tr><td>Senior</td><td>Immutable versions with blob bodies, runs as the reproducible artifact, presigned direct upload, streaming with resume, cost estimation</td><td>Content addressing, draft/version split, share granularity</td></tr>
  <tr><td>Staff+</td><td>Reproducibility as a data‑model property including model retirement, denial‑of‑wallet defences, secret and injection handling for pasted content, comparison and diff as the product's reason to exist</td><td>—</td></tr>
</tbody></table>
