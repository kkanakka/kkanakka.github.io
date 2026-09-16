---
title: "Safeguard / classifier serving in the request path"
slug: /system-design-notes/infra-safeguards
sidebar_position: 15
sidebar_label: "Safeguard / classifier serving in the re…"
description: "hard · Anthropic · tier‑0 dependency · fail‑closed · degraded modes · canaries"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/infra-safeguards/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">hard · Anthropic · tier‑0 dependency · fail‑closed · degraded modes · canaries</span>
</header>

## Requirements {#infra-safeguards-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Classify every input before generation and every output during streaming</li>
      <li>Block, allow, or flag according to a versioned policy</li>
      <li>Never emit blocked content to a client</li>
      <li>Continuously prove the classifiers are working</li>
      <li class="out">Training the classifiers; policy authoring</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Adds ≤ 30 ms to TTFT and ≤ a few ms per token</li>
      <li>Tier‑0: availability ≥ the main model’s; independent failure domain</li>
      <li>Fail closed; degraded behaviour only from a pre‑approved list</li>
      <li>Every decision auditable with request id, scores, versions</li>
    </ol>
  </div>
</div>

## Entities and API {#infra-safeguards-api}

<p>ClassifierVersion · PolicyVersion · Decision (requestId, stage, scores, action, versions, ts) · DegradedMode · Canary (prompt, expectedAction, cadence)</p>
<pre><code>POST /classify/input  {text, policyVersion}                -&gt; {action, scores, version}   (≤30 ms budget)
POST /classify/stream {requestId, windowTokens}            -&gt; {action}   (called per N tokens, lookahead held)
POST /classify/final  {requestId, fullText}                -&gt; {action}
GET  /internal/canaries/results                            -&gt; {blockedRate, allowedRate, failures[]}</code></pre>

## Design {#infra-safeguards-design}

<figure>
<svg viewBox="0 0 980 270" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Request path with input classifier before inference and output classifier over the stream; classifier fleet is a tier-0 service with its own cells; fail-closed policy with pre-approved degraded modes; synthetic canary requests that must be blocked">
  <defs><marker id="c1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="c2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#c1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#c2);stroke-dasharray:2 4}.lbla{font-size:10.5px;fill:#B45309}</style>
  <rect class="box" x="20" y="60" width="90" height="50"></rect><text class="tb" x="65" y="89" text-anchor="middle">Gateway</text>
  <rect class="box" x="150" y="40" width="130" height="90" stroke="#B45309"></rect><text class="tb" x="215" y="60" text-anchor="middle">Input classifier</text><text class="ts" x="215" y="78" text-anchor="middle">small model, &lt;30 ms</text><text class="ts" x="215" y="92" text-anchor="middle">block / allow / flag</text><text class="ts" x="215" y="106" text-anchor="middle">runs in parallel with</text><text class="ts" x="215" y="120" text-anchor="middle">prefill; gate before decode</text>
  <rect class="box" x="320" y="60" width="120" height="50" stroke="#0F766E"></rect><text class="tb" x="380" y="80" text-anchor="middle">Main model</text><text class="ts" x="380" y="98" text-anchor="middle">streams tokens</text>
  <rect class="box" x="480" y="40" width="150" height="90" stroke="#B45309"></rect><text class="tb" x="555" y="60" text-anchor="middle">Output classifier</text><text class="ts" x="555" y="78" text-anchor="middle">sliding window over stream</text><text class="ts" x="555" y="92" text-anchor="middle">hold N tokens of lookahead</text><text class="ts" x="555" y="106" text-anchor="middle">can cut + replace</text><text class="ts" x="555" y="120" text-anchor="middle">final pass on completion</text>
  <rect class="box" x="670" y="60" width="90" height="50"></rect><text class="tb" x="715" y="89" text-anchor="middle">Client</text>
  <path class="f" d="M110 85 L148 85"></path><path class="f" d="M280 85 L318 85"></path><path class="f" d="M440 85 L478 85"></path><path class="f" d="M630 85 L668 85"></path>
  <rect class="box" x="20" y="160" width="360" height="95"></rect><text class="tb" x="30" y="180">Fail‑closed, with pre‑approved degraded modes</text>
  <text class="ts" x="30" y="198">classifier timeout/error → do NOT skip the check</text>
  <text class="ts" x="30" y="212">mode A: retry once on another cell (budget 30 ms)</text>
  <text class="ts" x="30" y="226">mode B: fall back to a cheaper/rule‑based classifier (approved)</text>
  <text class="ts" x="30" y="240">mode C: block the request with a clear error; never "allow by default"</text>
  <rect class="box" x="420" y="160" width="340" height="95"></rect><text class="tb" x="430" y="180">Synthetic canaries that must be blocked</text>
  <text class="ts" x="430" y="198">Every minute, per cell: send known‑violating prompts</text>
  <text class="ts" x="430" y="212">tagged as synthetic. Expect: blocked.</text>
  <text class="ts" x="430" y="226">If any passes → page immediately, auto‑drain that cell.</text>
  <text class="ts" x="430" y="240">Also send known‑benign: expect allowed (false‑positive rate).</text>
  <rect class="box" x="790" y="40" width="170" height="215"></rect><text class="tb" x="800" y="60">Tier‑0 properties</text>
  <text class="ts" x="800" y="80">· own cells, own capacity, N+1</text>
  <text class="ts" x="800" y="96">· deployed by the rollout system</text>
  <text class="ts" x="800" y="112">  with its own eval gates</text>
  <text class="ts" x="800" y="128">· immutable versions; a policy</text>
  <text class="ts" x="800" y="142">  version pinned per request</text>
  <text class="ts" x="800" y="160">· latency SLO inside the TTFT budget</text>
  <text class="ts" x="800" y="178">· every decision logged with</text>
  <text class="ts" x="800" y="192">  request id, scores, version</text>
  <text class="ts" x="800" y="210">· no dependency on the main</text>
  <text class="ts" x="800" y="224">  model fleet (independent failure)</text>
  <text class="ts" x="800" y="244">· rate limit exempt (never shed)</text>
  <path class="fa" d="M555 130 L555 158"></path><text class="lbla" x="562" y="150">canaries target both</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 712" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Safeguard serving flow">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="5" y="14" width="130" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Client</text>
<line class="ln" x1="70" y1="48" x2="70" y2="692"></line>
<rect class="sb" x="173" y="14" width="130" height="34"></rect><text class="st" x="238" y="36" text-anchor="middle">Gateway</text>
<line class="ln" x1="238" y1="48" x2="238" y2="692"></line>
<rect class="sb" x="341" y="14" width="130" height="34"></rect><text class="st" x="406" y="36" text-anchor="middle">Input classifier</text>
<line class="ln" x1="406" y1="48" x2="406" y2="692"></line>
<rect class="sb" x="509" y="14" width="130" height="34"></rect><text class="st" x="574" y="36" text-anchor="middle">Serving</text>
<line class="ln" x1="574" y1="48" x2="574" y2="692"></line>
<rect class="sb" x="677" y="14" width="130" height="34"></rect><text class="st" x="742" y="36" text-anchor="middle">Output classifier</text>
<line class="ln" x1="742" y1="48" x2="742" y2="692"></line>
<rect class="sb" x="845" y="14" width="130" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Canary runner</text>
<line class="ln" x1="910" y1="48" x2="910" y2="692"></line>
<line class="a1" x1="78" y1="80" x2="230" y2="80"></line>
<text class="sl" x="154" y="74" text-anchor="middle">prompt</text>
<line class="a1" x1="246" y1="114" x2="398" y2="114"></line>
<text class="sl" x="322" y="108" text-anchor="middle">classify input (30 ms budget)</text>
<line class="a1" x1="246" y1="148" x2="566" y2="148"></line>
<text class="sl" x="406" y="142" text-anchor="middle">prefill concurrently</text>
<line class="a2" x1="398" y1="182" x2="246" y2="182"></line>
<text class="sl" x="322" y="176" text-anchor="middle">allow / block / flag</text>
<rect class="nt" x="143" y="203" width="190" height="22"></rect><text class="sl" x="238" y="218" text-anchor="middle">block → policy message, stop</text>
<line class="a1" x1="246" y1="250" x2="566" y2="250"></line>
<text class="sl" x="406" y="244" text-anchor="middle">allow → start decode</text>
<line class="a2" x1="566" y1="284" x2="246" y2="284"></line>
<text class="sl" x="406" y="278" text-anchor="middle">tokens</text>
<rect class="nt" x="162" y="305" width="152" height="22"></rect><text class="sl" x="238" y="320" text-anchor="middle">hold 8-token lookahead</text>
<line class="a1" x1="246" y1="352" x2="734" y2="352"></line>
<text class="sl" x="490" y="346" text-anchor="middle">sliding window classify</text>
<line class="a2" x1="734" y1="386" x2="246" y2="386"></line>
<text class="sl" x="490" y="380" text-anchor="middle">ok / cut</text>
<line class="a2" x1="230" y1="420" x2="78" y2="420"></line>
<text class="sl" x="154" y="414" text-anchor="middle">tokens released</text>
<line class="a1" x1="246" y1="454" x2="734" y2="454"></line>
<text class="sl" x="490" y="448" text-anchor="middle">final full-text pass</text>
<line class="a2" x1="734" y1="488" x2="246" y2="488"></line>
<text class="sl" x="490" y="482" text-anchor="middle">ok</text>
<line class="a2" x1="230" y1="522" x2="78" y2="522"></line>
<text class="sl" x="154" y="516" text-anchor="middle">done</text>
<line class="a2" x1="398" y1="556" x2="246" y2="556"></line>
<text class="sl" x="322" y="550" text-anchor="middle">timeout / error</text>
<rect class="nt" x="128" y="577" width="220" height="22"></rect><text class="sl" x="238" y="592" text-anchor="middle">retry once → approved degraded mode; never allow-by-default</text>
<line class="a3" x1="902" y1="624" x2="246" y2="624"></line>
<text class="sl" x="574" y="618" text-anchor="middle">must-block synthetic prompt (per minute, per cell)</text>
<line class="a2" x1="246" y1="658" x2="902" y2="658"></line>
<text class="sl" x="574" y="652" text-anchor="middle">blocked? else page + drain cell</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Client → Gateway:</b> prompt</li>
  <li><b>Gateway → Input classifier:</b> classify input (30 ms budget)</li>
  <li><b>Gateway → Serving:</b> prefill concurrently</li>
  <li><b>Input classifier → Gateway:</b> allow / block / flag (response)</li>
  <li><b>Gateway:</b> block → policy message, stop</li>
  <li><b>Gateway → Serving:</b> allow → start decode</li>
  <li><b>Serving → Gateway:</b> tokens (response)</li>
  <li><b>Gateway:</b> hold 8-token lookahead</li>
  <li><b>Gateway → Output classifier:</b> sliding window classify</li>
  <li><b>Output classifier → Gateway:</b> ok / cut (response)</li>
  <li><b>Gateway → Client:</b> tokens released (response)</li>
  <li><b>Gateway → Output classifier:</b> final full-text pass</li>
  <li><b>Output classifier → Gateway:</b> ok (response)</li>
  <li><b>Gateway → Client:</b> done (response)</li>
  <li><b>Input classifier → Gateway:</b> timeout / error (response)</li>
  <li><b>Gateway:</b> retry once → approved degraded mode; never allow-by-default</li>
  <li><b>Canary runner → Gateway:</b> must-block synthetic prompt (per minute, per cell) (async)</li>
  <li><b>Gateway → Canary runner:</b> blocked? else page + drain cell (response)</li>
</ol>

## How it works, step by step {#infra-safeguards-flow}

<ol class="order">
  <li>Gateway forwards the prompt to the input classifier and the serving replica concurrently; decode is gated on the classifier’s allow.</li>
  <li>Serving streams tokens into the gateway, which holds a lookahead buffer of ~8 tokens and calls the stream classifier on a sliding window.</li>
  <li>On block: cut the stream, replace with a policy message, log the decision, refund tokens.</li>
  <li>On completion: final full‑text pass; result logged; only then is the response marked complete.</li>
  <li>Classifier error/timeout: retry once within budget on another cell; then apply the current approved degraded mode (cheaper classifier or block); never treat timeout as allow.</li>
  <li>Every minute per cell, synthetic must‑block and must‑allow prompts run through the real path; deviations page and auto‑drain the cell.</li>
  <li>New classifier versions shadow‑score real traffic without acting; promoted through the rollout system with canary results as a gate.</li>
</ol>

## Deep dives {#infra-safeguards-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/infra-safeguards/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
  <div><h4>Latency without weakening</h4><ul>
    <li>Run the input classifier concurrently with prefill; gate before the first token leaves. Cost hidden under prefill.</li>
    <li>Output classifier on a sliding window with a small token lookahead buffer (e.g. hold 8 tokens): you can cut before the user sees them. Final full‑text pass at completion.</li>
    <li>Cache decisions by prompt hash for repeated prompts (with policy version in the key).</li></ul></div>
  <div><h4>Fail closed, deliberately</h4><ul>
    <li>Circuit breakers on a tier‑0 dep must not "open to allow." They open to a <em>named</em> degraded mode that was approved offline.</li>
    <li>Modes are ordered and each has a max duration; exceeding it pages a human.</li>
    <li>Distinguish "classifier unavailable" (fail closed) from "classifier says allow" (proceed); never conflate a timeout with an allow.</li></ul></div>
  <div><h4>Proving it works</h4><ul>
    <li>Canaries are the SLO for correctness, not just uptime: "blocked‑rate of must‑block canaries = 100%" is an SLI with a burn‑rate alert.</li>
    <li>Shadow‑deploy a new classifier version: score everything, block nothing, compare decisions before promotion.</li>
    <li>Audit log every decision with the version that made it, so a policy regression can be traced to a rollout.</li></ul></div>
</div>

## Don't leave the room without saying {#infra-safeguards-check}

<ul class="checklist">
  <li>Tier‑0: own cells, own N+1, rate‑limit exempt, no dependency on the main fleet</li>
  <li>Hide input classification under prefill; stream classification with lookahead</li>
  <li>Fail closed; timeout ≠ allow; degraded modes are named and time‑boxed</li>
  <li>Synthetic must‑block canaries as an SLI with burn‑rate alerting</li>
  <li>Shadow deploy and audit log with versions</li>
  <li>Decision cache keyed by (prompt hash, policy version)</li>
</ul>

## What each level is expected to drive {#infra-safeguards-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Classifier call before and after generation; block on positive</td><td>Streaming classification, fail‑closed semantics</td></tr>
  <tr><td>Senior</td><td>Latency hiding, lookahead buffer, fail‑closed with approved fallbacks, canaries, audit log</td><td>Shadow deploys, tier‑0 capacity</td></tr>
  <tr><td>Staff+</td><td>Degraded‑mode governance, independent failure domain argument, canary SLOs, policy versioning across rollouts, cost of false positives vs negatives</td><td>—</td></tr>
</tbody></table>
