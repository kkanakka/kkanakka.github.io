---
title: "AI chat platform, end to end"
slug: /system-design-notes/ai-platform
sidebar_position: 9
sidebar_label: "AI chat platform, end to end"
description: "ties together ChatGPT chat + Inference API + metering + training · who does what"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/ai-platform/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">ties together ChatGPT chat + Inference API + metering + training · who does what</span>
</header>
<p>The two earlier designs are layers of one system. This section stacks them, adds the planes they leave out (metering, training, safety, ops), and answers the "who does X" questions: who trims context, what a turn is, what a reaper does, where token usage is counted.</p>

## Vocabulary {#ap-vocab}

<table>
  <tbody><tr><th>Term</th><th>Meaning</th><th>Owned by</th></tr>
  <tr><td>Turn</td><td>One user message + the assistant reply to it. A conversation is an ordered list of turns.</td><td>Conversation store (as message rows)</td></tr>
  <tr><td>Context</td><td>The exact text the model sees for one call: system prompt + memory + summary + recent turns + new message, within the window.</td><td>Context Builder, rebuilt every turn, never stored</td></tr>
  <tr><td>Trimming</td><td>Dropping/summarizing old turns so context fits the window minus reserved output.</td><td>Context Builder (in the Chat Service)</td></tr>
  <tr><td>Rolling summary</td><td>Model‑written digest of turns older than the cut; regenerated async every K turns.</td><td>Summarizer worker</td></tr>
  <tr><td>Memory</td><td>Durable per‑user facts spanning conversations, user‑visible/editable.</td><td>Memory Service + extraction worker</td></tr>
  <tr><td>Inference job</td><td>One prompt → output request to the serving layer; sync or streamed.</td><td>Inference Gateway → GPU workers</td></tr>
  <tr><td>Reaper</td><td>Background loop that finds work claimed but not finished within T and requeues or fails it.</td><td>Any queue with an in‑flight list</td></tr>
  <tr><td>Usage event</td><td>{userId, model, tokens_in, tokens_out, latency, ts} emitted per inference.</td><td>Chat Service → Kafka → Metering</td></tr>
  <tr><td>Training job</td><td>Offline run that produces a new model version from curated data.</td><td>Training plane, separate cluster</td></tr>
</tbody></table>

## Platform map {#ap-diagram}

<figure>
<svg viewBox="0 0 980 640" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="AI chat platform in planes: edge and product plane with chat service and context builder; data plane with conversation store, memory, blob; serving plane with inference gateway, batch queue, GPU workers, model registry; metering and billing plane fed by Kafka usage events; training plane with data pipeline, training cluster, evals, registry and canary rollout; ops plane">
  <defs>
    <marker id="f1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker>
    <marker id="f2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker>
    <marker id="f3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker>
  </defs>
  <style>.pl{fill:none;stroke:#D6DDE5;stroke-dasharray:6 4;rx:10}.pt{font-size:12px;font-weight:700;fill:#5B6673;letter-spacing:.06em}.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#f1)}.fa{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#f2);stroke-dasharray:2 4}.ft{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#f3);stroke-dasharray:5 4}.lbl{font-size:10.5px;fill:#1F4E9E}.lbla{font-size:10.5px;fill:#B45309}.lblt{font-size:10.5px;fill:#6B2D6B}</style>

  <!-- product plane -->
  <rect class="pl" x="10" y="10" width="600" height="190"></rect><text class="pt" x="20" y="28">PRODUCT PLANE (online, per turn)</text>
  <rect class="box" x="20" y="60" width="80" height="44"></rect><text class="tb" x="60" y="86" text-anchor="middle">Client</text>
  <rect class="box" x="120" y="60" width="90" height="44"></rect><text class="tb" x="165" y="80" text-anchor="middle">Gateway</text><text class="ts" x="165" y="96" text-anchor="middle">auth · quota</text>
  <rect class="box" x="230" y="40" width="170" height="90"></rect><text class="tb" x="315" y="60" text-anchor="middle">Chat Service</text>
  <text class="ts" x="240" y="78">persist turn</text><text class="ts" x="240" y="92">Context Builder: trim/budget</text><text class="ts" x="240" y="106">relay stream · safety</text><text class="ts" x="240" y="120">emit usage + events</text>
  <rect class="box" x="420" y="40" width="180" height="44"></rect><text class="tb" x="510" y="58" text-anchor="middle">Safety Service</text><text class="ts" x="510" y="74" text-anchor="middle">input/output classifiers</text>
  <rect class="box" x="420" y="96" width="180" height="44"></rect><text class="tb" x="510" y="114" text-anchor="middle">Memory Service</text><text class="ts" x="510" y="130" text-anchor="middle">read facts for prompt</text>
  <rect class="box" x="230" y="145" width="370" height="44" stroke="#B45309"></rect><text class="tb" x="415" y="163" text-anchor="middle">Async workers (Kafka consumers)</text><text class="ts" x="415" y="179" text-anchor="middle">title · rolling summary · memory extraction · feedback capture</text>

  <!-- data plane -->
  <rect class="pl" x="10" y="215" width="600" height="110"></rect><text class="pt" x="20" y="233">DATA PLANE (system of record)</text>
  <rect class="box" x="20" y="250" width="180" height="60"></rect><text class="tb" x="110" y="270" text-anchor="middle">Conversation store</text><text class="ts" x="110" y="286" text-anchor="middle">PK conversationId · SK time</text><text class="ts" x="110" y="300" text-anchor="middle">messages, summary, tokenCount</text>
  <rect class="box" x="220" y="250" width="130" height="60"></rect><text class="tb" x="285" y="270" text-anchor="middle">Memory store</text><text class="ts" x="285" y="286" text-anchor="middle">user facts, embeddings</text>
  <rect class="box" x="370" y="250" width="100" height="60" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="tb" x="420" y="270" text-anchor="middle">S3</text><text class="ts" x="420" y="286" text-anchor="middle">attachments</text>
  <rect class="box" x="490" y="250" width="110" height="60" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="545" y="270" text-anchor="middle">Redis</text><text class="ts" x="545" y="286" text-anchor="middle">hot tails · limits</text><text class="ts" x="545" y="300" text-anchor="middle">stream resume buffer</text>

  <!-- serving plane -->
  <rect class="pl" x="630" y="10" width="340" height="315"></rect><text class="pt" x="640" y="28">SERVING PLANE (Inference API)</text>
  <rect class="box" x="640" y="45" width="150" height="70"></rect><text class="tb" x="715" y="65" text-anchor="middle">Inference Gateway</text><text class="ts" x="715" y="81" text-anchor="middle">tier queues · admission</text><text class="ts" x="715" y="95" text-anchor="middle">batcher · route by model</text><text class="ts" x="715" y="109" text-anchor="middle">reaper on inflight</text>
  <rect class="box" x="810" y="45" width="150" height="70" stroke="#0F766E"></rect><text class="tb" x="885" y="65" text-anchor="middle">GPU workers</text><text class="ts" x="885" y="81" text-anchor="middle">pull batches · KV cache</text><text class="ts" x="885" y="95" text-anchor="middle">continuous batching</text><text class="ts" x="885" y="109" text-anchor="middle">return tokens_in/out</text>
  <rect class="box" x="640" y="135" width="320" height="44"></rect><text class="tb" x="800" y="153" text-anchor="middle">Model Registry + Router</text><text class="ts" x="800" y="169" text-anchor="middle">versions, weights in S3, which replicas serve which model, canary %</text>
  <rect class="box" x="640" y="200" width="320" height="44"></rect><text class="tb" x="800" y="218" text-anchor="middle">Capacity / autoscaler</text><text class="ts" x="800" y="234" text-anchor="middle">healthy GPU count → rate limiter; queue depth, P95 → scale</text>
  <rect class="box" x="640" y="260" width="320" height="44"></rect><text class="tb" x="800" y="278" text-anchor="middle">Small models pool</text><text class="ts" x="800" y="294" text-anchor="middle">summaries, titles, memory extraction, classifiers; cheap GPUs</text>

  <!-- metering plane -->
  <rect class="pl" x="10" y="340" width="600" height="120"></rect><text class="pt" x="20" y="358">METERING &amp; BILLING PLANE</text>
  <rect class="box" x="20" y="380" width="120" height="60" stroke="#B45309"></rect><text class="tb" x="80" y="400" text-anchor="middle">Kafka</text><text class="ts" x="80" y="416" text-anchor="middle">usage.events</text><text class="ts" x="80" y="430" text-anchor="middle">message.created</text>
  <rect class="box" x="160" y="380" width="160" height="60"></rect><text class="tb" x="240" y="400" text-anchor="middle">Metering Service</text><text class="ts" x="240" y="416" text-anchor="middle">tokens per user/model/day</text><text class="ts" x="240" y="430" text-anchor="middle">→ Redis (live) + warehouse</text>
  <rect class="box" x="340" y="380" width="120" height="60"></rect><text class="tb" x="400" y="400" text-anchor="middle">Billing</text><text class="ts" x="400" y="416" text-anchor="middle">plans, invoices,</text><text class="ts" x="400" y="430" text-anchor="middle">quota resets</text>
  <rect class="box" x="480" y="380" width="120" height="60"></rect><text class="tb" x="540" y="400" text-anchor="middle">Warehouse</text><text class="ts" x="540" y="416" text-anchor="middle">analytics, abuse,</text><text class="ts" x="540" y="430" text-anchor="middle">dashboards</text>

  <!-- training plane -->
  <rect class="pl" x="10" y="475" width="960" height="155"></rect><text class="pt" x="20" y="493">TRAINING PLANE (offline, never on the request path)</text>
  <rect class="box" x="20" y="515" width="150" height="70"></rect><text class="tb" x="95" y="535" text-anchor="middle">Data pipeline</text><text class="ts" x="95" y="551" text-anchor="middle">opt‑in filter · de‑identify</text><text class="ts" x="95" y="565" text-anchor="middle">dedupe · quality/safety</text><text class="ts" x="95" y="579" text-anchor="middle">→ dataset in S3</text>
  <rect class="box" x="190" y="515" width="140" height="70"></rect><text class="tb" x="260" y="535" text-anchor="middle">Feedback store</text><text class="ts" x="260" y="551" text-anchor="middle">👍👎, edits, regenerate</text><text class="ts" x="260" y="565" text-anchor="middle">human ratings (RLHF)</text>
  <rect class="box" x="350" y="515" width="150" height="70" stroke="#0F766E"></rect><text class="tb" x="425" y="535" text-anchor="middle">Training cluster</text><text class="ts" x="425" y="551" text-anchor="middle">scheduler (Slurm/K8s)</text><text class="ts" x="425" y="565" text-anchor="middle">SFT / RL runs, checkpoints</text><text class="ts" x="425" y="579" text-anchor="middle">separate GPUs from serving</text>
  <rect class="box" x="520" y="515" width="130" height="70"></rect><text class="tb" x="585" y="535" text-anchor="middle">Evals</text><text class="ts" x="585" y="551" text-anchor="middle">benchmarks, safety,</text><text class="ts" x="585" y="565" text-anchor="middle">regression gates</text>
  <rect class="box" x="670" y="515" width="130" height="70"></rect><text class="tb" x="735" y="535" text-anchor="middle">Model Registry</text><text class="ts" x="735" y="551" text-anchor="middle">version, weights, card</text><text class="ts" x="735" y="565" text-anchor="middle">promote / rollback</text>
  <rect class="box" x="820" y="515" width="140" height="70"></rect><text class="tb" x="890" y="535" text-anchor="middle">Rollout</text><text class="ts" x="890" y="551" text-anchor="middle">load weights to replicas</text><text class="ts" x="890" y="565" text-anchor="middle">canary 1% → 100%</text>

  <!-- flows -->
  <path class="f" d="M100 82 L118 82"></path><path class="f" d="M210 82 L228 82"></path>
  <path class="f" d="M315 130 L315 248"></path><text class="lbl" x="320" y="215">read/write turns</text>
  <path class="f" d="M400 118 L418 118"></path><path class="f" d="M400 62 L418 62"></path>
  <path class="f" d="M400 100 C 520 30, 600 30, 638 60"></path><text class="lbl" x="470" y="36">prompt → tokens stream back</text>
  <path class="f" d="M790 80 L808 80"></path>
  <path class="fa" d="M315 189 C 315 230, 140 300, 80 378"></path><text class="lbla" x="130" y="340">usage + events</text>
  <path class="fa" d="M140 410 L158 410"></path><path class="fa" d="M320 410 L338 410"></path><path class="fa" d="M460 410 L478 410"></path>
  <path class="fa" d="M240 380 C 300 330, 480 330, 545 312"></path><text class="lbla" x="330" y="336">live counters for limits</text>
  <path class="ft" d="M110 310 C 60 400, 60 460, 80 513"></path><text class="lblt" x="20" y="470">opted‑in transcripts</text>
  <path class="ft" d="M170 550 L188 550"></path><path class="ft" d="M330 550 L348 550"></path><path class="ft" d="M500 550 L518 550"></path><path class="ft" d="M650 550 L668 550"></path><path class="ft" d="M800 550 L818 550"></path>
  <path class="ft" d="M890 513 C 890 400, 850 250, 820 182"></path><text class="lblt" x="900" y="400">new version</text>
  <path class="fa" d="M800 244 L800 224" stroke="none"></path>
</svg>
<figcaption>Online planes on top, offline plane at the bottom. The only thing that crosses from training to serving is a new model version through the registry; the only thing that crosses from serving to training is curated, opted‑in data through the pipeline.</figcaption>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 746" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="AI chat platform end-to-end flow across planes">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="17" y="14" width="106" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Client</text>
<line class="ln" x1="70" y1="48" x2="70" y2="726"></line>
<rect class="sb" x="137" y="14" width="106" height="34"></rect><text class="st" x="190" y="36" text-anchor="middle">Gateway</text>
<line class="ln" x1="190" y1="48" x2="190" y2="726"></line>
<rect class="sb" x="257" y="14" width="106" height="34"></rect><text class="st" x="310" y="36" text-anchor="middle">Chat Service</text>
<line class="ln" x1="310" y1="48" x2="310" y2="726"></line>
<rect class="sb" x="377" y="14" width="106" height="34"></rect><text class="st" x="430" y="36" text-anchor="middle">Data plane</text>
<line class="ln" x1="430" y1="48" x2="430" y2="726"></line>
<rect class="sb" x="497" y="14" width="106" height="34"></rect><text class="st" x="550" y="36" text-anchor="middle">Inference GW</text>
<line class="ln" x1="550" y1="48" x2="550" y2="726"></line>
<rect class="sb" x="617" y="14" width="106" height="34"></rect><text class="st" x="670" y="36" text-anchor="middle">Kafka</text>
<line class="ln" x1="670" y1="48" x2="670" y2="726"></line>
<rect class="sb" x="737" y="14" width="106" height="34"></rect><text class="st" x="790" y="36" text-anchor="middle">Metering</text>
<line class="ln" x1="790" y1="48" x2="790" y2="726"></line>
<rect class="sb" x="857" y="14" width="106" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Training</text>
<line class="ln" x1="910" y1="48" x2="910" y2="726"></line>
<line class="a1" x1="78" y1="80" x2="182" y2="80"></line>
<text class="sl" x="130" y="74" text-anchor="middle">message</text>
<rect class="nt" x="80" y="101" width="220" height="22"></rect><text class="sl" x="190" y="116" text-anchor="middle">quota check (Redis usage counters)</text>
<line class="a1" x1="198" y1="148" x2="302" y2="148"></line>
<text class="sl" x="250" y="142" text-anchor="middle">forward</text>
<line class="a1" x1="318" y1="182" x2="422" y2="182"></line>
<text class="sl" x="370" y="176" text-anchor="middle">persist turn; read summary, memory, tail</text>
<line class="a2" x1="422" y1="216" x2="318" y2="216"></line>
<text class="sl" x="370" y="210" text-anchor="middle">context inputs</text>
<rect class="nt" x="206" y="237" width="208" height="22"></rect><text class="sl" x="310" y="252" text-anchor="middle">Context Builder trims to window</text>
<line class="a1" x1="318" y1="284" x2="542" y2="284"></line>
<text class="sl" x="430" y="278" text-anchor="middle">prompt</text>
<rect class="nt" x="440" y="305" width="220" height="22"></rect><text class="sl" x="550" y="320" text-anchor="middle">queue, batch, pull dispatch, reaper</text>
<line class="a2" x1="542" y1="352" x2="318" y2="352"></line>
<text class="sl" x="430" y="346" text-anchor="middle">token stream + usage</text>
<line class="a2" x1="302" y1="386" x2="78" y2="386"></line>
<text class="sl" x="190" y="380" text-anchor="middle">SSE</text>
<line class="a1" x1="318" y1="420" x2="422" y2="420"></line>
<text class="sl" x="370" y="414" text-anchor="middle">persist assistant msg</text>
<line class="a3" x1="318" y1="454" x2="662" y2="454"></line>
<text class="sl" x="490" y="448" text-anchor="middle">usage.event, message.created</text>
<line class="a3" x1="678" y1="488" x2="782" y2="488"></line>
<text class="sl" x="730" y="482" text-anchor="middle">aggregate tokens</text>
<line class="a3" x1="782" y1="522" x2="198" y2="522"></line>
<text class="sl" x="490" y="516" text-anchor="middle">live counters → Redis</text>
<rect class="nt" x="698" y="543" width="183" height="22"></rect><text class="sl" x="790" y="558" text-anchor="middle">ledger → billing, warehouse</text>
<line class="a3" x1="662" y1="590" x2="438" y2="590"></line>
<text class="sl" x="550" y="584" text-anchor="middle">workers: summary, memory, title</text>
<line class="a3" x1="438" y1="624" x2="902" y2="624"></line>
<text class="sl" x="670" y="618" text-anchor="middle">opt-in transcripts → data pipeline</text>
<rect class="nt" x="812" y="645" width="196" height="22"></rect><text class="sl" x="910" y="660" text-anchor="middle">train, eval, register version</text>
<line class="a3" x1="902" y1="692" x2="558" y2="692"></line>
<text class="sl" x="730" y="686" text-anchor="middle">canary rollout of new version</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Client → Gateway:</b> message</li>
  <li><b>Gateway:</b> quota check (Redis usage counters)</li>
  <li><b>Gateway → Chat Service:</b> forward</li>
  <li><b>Chat Service → Data plane:</b> persist turn; read summary, memory, tail</li>
  <li><b>Data plane → Chat Service:</b> context inputs (response)</li>
  <li><b>Chat Service:</b> Context Builder trims to window</li>
  <li><b>Chat Service → Inference GW:</b> prompt</li>
  <li><b>Inference GW:</b> queue, batch, pull dispatch, reaper</li>
  <li><b>Inference GW → Chat Service:</b> token stream + usage (response)</li>
  <li><b>Chat Service → Client:</b> SSE (response)</li>
  <li><b>Chat Service → Data plane:</b> persist assistant msg</li>
  <li><b>Chat Service → Kafka:</b> usage.event, message.created (async)</li>
  <li><b>Kafka → Metering:</b> aggregate tokens (async)</li>
  <li><b>Metering → Gateway:</b> live counters → Redis (async)</li>
  <li><b>Metering:</b> ledger → billing, warehouse</li>
  <li><b>Kafka → Data plane:</b> workers: summary, memory, title (async)</li>
  <li><b>Data plane → Training:</b> opt-in transcripts → data pipeline (async)</li>
  <li><b>Training:</b> train, eval, register version</li>
  <li><b>Training → Inference GW:</b> canary rollout of new version (async)</li>
</ol>

## Who does what, one turn at a time {#ap-who}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/ai-platform/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<ol class="order">
  <li><b>Gateway:</b> verify JWT, check Redis quota (tokens/min for the tier, messages/day), route.</li>
  <li><b>Chat Service:</b> append user message to the Conversation store (with its token count). Call Safety on the input.</li>
  <li><b>Context Builder (inside Chat Service):</b> budget = window − reserved output. Take system prompt, then Memory Service facts, then the conversation's stored rolling summary, then turns newest‑first until the budget is spent. Older turns are simply not included. This is "trimming"; it costs a few arithmetic ops because token counts were stored at write time.</li>
  <li><b>Inference Gateway:</b> put the prompt on the right queue (model, tier), batch, dispatch to a GPU worker that pulls, stream tokens back; a reaper requeues anything stuck in‑flight.</li>
  <li><b>Chat Service:</b> relay tokens to the client (SSE), run output safety, persist the assistant message + <code>tokens_in/out</code> from the inference response.</li>
  <li><b>Chat Service:</b> emit <code>usage.event</code> and <code>message.created</code> to Kafka. Turn is over from the user's point of view.</li>
  <li><b>Workers (async):</b> if the conversation crossed K turns since last summary, call a small model to regenerate the rolling summary and write it to the conversation row; extract memory facts; generate a title on turn 1; capture 👍👎 into the Feedback store.</li>
  <li><b>Metering Service:</b> consume usage events → increment Redis counters (what the Gateway checks next turn) → append to warehouse for billing and dashboards.</li>
</ol>

## Token usage per user: the metering design {#ap-metering}

<ul>
  <li><b>Source of truth for tokens:</b> the inference response. Workers count what they actually processed; nothing upstream estimates.</li>
  <li><b>Hot path:</b> Chat Service emits one event per inference; no synchronous DB write. Event carries requestId for idempotent consumption.</li>
  <li><b>Live counters (Redis):</b> <code>usage:{userId}:{window}</code> with INCRBY and TTL, e.g. per‑minute and per‑day keys. The Gateway reads these for rate limiting. Losing a counter on Redis failover means a user gets a slightly larger window; acceptable.</li>
  <li><b>Durable ledger:</b> Metering consumer writes to a warehouse (or Postgres partitioned by day) keyed by (userId, model, day) with idempotent upserts. Billing runs off the ledger, never off Redis.</li>
  <li><b>Reconciliation:</b> nightly job compares ledger totals to Redis and to inference‑side logs; drift is alerted.</li>
  <li><b>Why not count in the Gateway?</b> It only knows the prompt size, not the output, and a stream can be stopped early. Count at the source, enforce at the edge.</li>
</ul>

## Training plane: how it connects without touching latency {#ap-training}

<ul>
  <li><b>Input:</b> conversation transcripts only for users who opted in, passed through de‑identification, dedupe, quality filters, safety filters. Plus the feedback store (ratings, regenerations, edits) and human‑labeled preference data.</li>
  <li><b>Jobs:</b> a scheduler (Kubernetes / Slurm) runs SFT and RL jobs on a training cluster physically separate from serving GPUs, checkpointing to S3. Long‑running, batch, retryable from checkpoint.</li>
  <li><b>Gate:</b> Evals (benchmarks, safety suites, regression vs. current prod) must pass before a version is promoted in the Model Registry.</li>
  <li><b>Rollout:</b> Router sends 1% of traffic to replicas loaded with the new weights, compares latency/quality/safety metrics, ramps to 100% or rolls back by flipping the registry pointer. Replicas load weights from S3, which is why scale‑out takes minutes.</li>
  <li><b>Separation rule:</b> training reads data, serving reads models. Neither writes into the other's store directly.</li>
</ul>

## Reapers in this platform {#ap-reaper}

<table>
  <tbody><tr><th>Where</th><th>Stuck state</th><th>Reaper action</th></tr>
  <tr><td>Inference in‑flight lists</td><td>Batcher crashed after RPOPLPUSH</td><td>Move back to tier queue after T; cap retries</td></tr>
  <tr><td>Streaming buffer</td><td>Client never reconnected</td><td>Expire buffer, finalize message as complete</td></tr>
  <tr><td>Pending gateway map</td><td>Response never arrived</td><td>Time out socket with 504, delete routing key</td></tr>
  <tr><td>Summary/memory jobs</td><td>Worker died mid‑job</td><td>Kafka rebalances the partition; job is idempotent so re‑run is safe</td></tr>
  <tr><td>Training checkpoints</td><td>Node preempted</td><td>Scheduler restarts from last checkpoint</td></tr>
</tbody></table>

## Don't leave the room without saying {#ap-checklist}

<ul class="checklist">
  <li>Turn = user message + reply; context is rebuilt from stored turns by the Context Builder, never stored itself</li>
  <li>Trimming happens in the Chat Service using stored token counts; summaries are made async by a small model</li>
  <li>Inference is a separate plane with its own queues, batching, pull dispatch, reaper, and capacity feedback</li>
  <li>Tokens counted at the GPU, emitted as events, aggregated by Metering into Redis (enforce) and a ledger (bill)</li>
  <li>Training is offline: opt‑in data → pipeline → separate cluster → evals → registry → canary rollout</li>
  <li>Reapers exist wherever work can be claimed and abandoned</li>
  <li>Small‑model pool for all the side jobs so the big model serves only user turns</li>
</ul>
