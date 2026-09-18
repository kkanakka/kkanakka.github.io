---
title: "ChatGPT / Claude‑style chat"
slug: /aire/llm-chat
sidebar_position: 2
sidebar_label: "ChatGPT / Claude‑style chat"
description: "hard · streaming · stateless model, stateful product · GPU capacity · where context lives"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/llm-chat/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">hard · streaming · stateless model, stateful product · GPU capacity · where context lives</span>
</header>
<p>Users have conversations with an LLM. Every turn, the model must see the whole conversation, the answer streams token by token, and the expensive part (GPU inference) has a hard capacity ceiling. The product is stateful; the model is not. Everything interesting is in the gap between those two facts.</p>

## Requirements {#lc-requirements}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Send a message in a conversation and receive a streamed reply</li>
      <li>Conversations persist; user can list, reopen, continue any of them</li>
      <li>Model remembers earlier turns (context) and, optionally, facts across conversations (memory)</li>
      <li class="out">Attachments/RAG, tools, voice, team sharing, billing</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Low time‑to‑first‑token (&lt;1 s) then smooth streaming</li>
      <li>Scale: 100M+ users, ~10M concurrent streams at peak; GPU throughput is the bottleneck</li>
      <li>Durability of chat history; safety and abuse controls</li>
      <li class="out">Model training, evals, fine‑tuning pipeline</li>
    </ol>
  </div>
</div>


## Scale, performance and safety targets {#lc-targets}

<p>State these before anything else. The context‑window budget, the storage split and the streaming design are all consequences of these numbers.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> 100M+ users, ~10M concurrent streams at peak. Message sends are ~200K QPS; sidebar and transcript reads are perhaps 10× that, which is why the conversation list is denormalized rather than computed.</li>
    <li><b>Data volume:</b> ~2 KB per message, tens of billions of messages retained — hundreds of TB growing continuously. A single turn's prompt can be 100K+ tokens once history is included, so bytes sent to the GPU dwarf bytes stored.</li>
    <li><b>Growth:</b> ~2× users annually but tokens per turn growing faster as context windows expand — assume GPU demand grows ~3× a year while storage grows ~2×.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> time to first token p50 &lt; 600 ms, p95 &lt; 1 s, ceiling 3 s; inter‑token latency p95 &lt; 60 ms so text appears faster than people read. Sidebar load p95 &lt; 200 ms.</li>
    <li><b>Throughput:</b> GPU tokens/s is the binding constraint, not web capacity. Prefix caching of the shared system prompt and routing by prefix affinity are worth double‑digit percentages of effective throughput.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> prompt injection through pasted content, jailbreak attempts, automated scraping of model output, and account sharing. Input and output classifiers sit on the request path, and the gateway enforces per‑user limits before any GPU work happens.</li>
    <li><b>Rate limiting:</b> tokens/min and messages/day per user, concurrent streams per account, and a per‑IP cap for unauthenticated surfaces — e.g. 50 messages/day free, 200K tokens/min paid, 3 concurrent streams.</li>
    <li><b>Data sensitivity:</b> the transcript <em>is</em> the sensitive data — conversations routinely contain PII, health and financial details. Encrypt at rest, scope every read by user id, keep memory facts user‑visible and editable, honour deletion across transcript, summary, memory and derived indexes, and state a retention policy (e.g. 30 days after deletion before hard removal).</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.9% for sending messages; reading history should be higher, because a user who cannot reach their own transcript experiences it as data loss rather than an outage.</li>
    <li><b>Degraded mode:</b> GPU capacity exhausted → queue with a visible wait, shed free tier first, never silently truncate context. Memory or summary workers down → fall back to last N messages verbatim, which is degraded quality, not an error. Stream dropped → resume from the buffer using <code>lastEventId</code> rather than regenerating.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> strong within a conversation — messages must appear in order and a send must never be lost or duplicated, which the idempotency key guarantees. The conversation list can lag a second; memory and summaries are explicitly eventually consistent.</li>
    <li><b>Durability:</b> the transcript is the system of record and needs eleven nines; the KV cache, the hot tail in Redis and the rolling summary are all rebuildable, and losing them costs latency or quality, never correctness.</li>
    <li><b>Compliance:</b> GDPR‑style export and deletion must cover derived data too — summaries, memory facts and embeddings are copies of user content, and a deletion that leaves them behind is not a deletion.</li></ul></div>
</div>

## Entities and API {#lc-entities}

<p>User · Conversation · Message (role: user | assistant | system, content, tokens, createdAt) · Memory (per user, distilled facts) · Attachment (blob pointer).</p>
<pre><code>POST /conversations                            -&gt; Conversation
GET  /conversations?cursor=                    -&gt; [Conversation]   (list, newest first)
GET  /conversations/:id/messages?cursor=       -&gt; [Message]
POST /conversations/:id/messages  {content}    -&gt; SSE stream of {delta} … {done, messageId, usage}
POST /conversations/:id/messages/:id/stop      -&gt; cancel generation
Idempotency-Key header on the POST; client retries after a dropped stream resume with lastEventId.</code></pre>

## High‑level design {#lc-diagram}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/llm-chat/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 560" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="LLM chat architecture: client streams over SSE through gateway to chat service; chat service reads conversation store and memory store, builds prompt, calls inference gateway that batches onto GPU model servers with KV cache; assistant tokens are appended to the conversation store; async workers summarize and extract memory; safety filters on both sides">
  <defs>
    <marker id="b1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker>
    <marker id="b2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker>
    <marker id="b3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker>
  </defs>
  <style>
    .box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:13px;fill:#1B2430;font-weight:600}.ts{font-size:11px;fill:#5B6673}.tm{font-size:11px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}
    .flow{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#b1)}.flowp{stroke:#6B2D6B;stroke-width:1.6;fill:none;marker-end:url(#b2);stroke-dasharray:5 4}.flowa{stroke:#B45309;stroke-width:1.6;fill:none;marker-end:url(#b3);stroke-dasharray:2 4}
    .lbl{font-size:11px;fill:#1F4E9E}.lblp{font-size:11px;fill:#6B2D6B}.lbla{font-size:11px;fill:#B45309}
  </style>

  <!-- client / gateway -->
  <rect class="box" x="20" y="220" width="100" height="56"></rect><text class="tb" x="70" y="243" text-anchor="middle">Client</text><text class="ts" x="70" y="261" text-anchor="middle">EventSource</text>
  <rect class="box" x="160" y="220" width="110" height="56"></rect><text class="tb" x="215" y="243" text-anchor="middle">API Gateway</text><text class="ts" x="215" y="261" text-anchor="middle">auth · quota · L7</text>

  <!-- chat service -->
  <rect class="box" x="320" y="200" width="170" height="96"></rect><text class="tb" x="405" y="222" text-anchor="middle">Chat Service (×N)</text>
  <text class="ts" x="330" y="240">1 persist user msg</text><text class="ts" x="330" y="254">2 build prompt (context)</text><text class="ts" x="330" y="268">3 stream + relay tokens</text><text class="ts" x="330" y="282">4 persist assistant msg</text>

  <!-- conversation store -->
  <rect class="box" x="320" y="40" width="200" height="110"></rect><text class="tb" x="330" y="60">Conversation store</text>
  <text class="ts" x="330" y="76">DynamoDB / Cassandra (or sharded PG)</text>
  <text class="tm" x="330" y="94">PK conversationId</text><text class="tm" x="330" y="108">SK createdAt#messageId</text>
  <text class="tm" x="330" y="122">GSI userId → convs by updatedAt</text>
  <text class="ts" x="330" y="140">append‑only, TTL‑free, system of record</text>

  <!-- cache -->
  <rect class="box" x="560" y="40" width="150" height="50" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="635" y="61" text-anchor="middle">Redis</text><text class="ts" x="635" y="78" text-anchor="middle">hot conv tail · rate limits</text>

  <!-- memory store -->
  <rect class="box" x="560" y="110" width="150" height="60"></rect><text class="tb" x="635" y="131" text-anchor="middle">Memory store</text><text class="ts" x="635" y="147" text-anchor="middle">per‑user facts + summaries</text><text class="ts" x="635" y="161" text-anchor="middle">optional vector index</text>

  <!-- blob -->
  <rect class="box" x="760" y="40" width="120" height="50" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="tb" x="820" y="61" text-anchor="middle">S3</text><text class="ts" x="820" y="78" text-anchor="middle">attachments</text>

  <!-- safety -->
  <rect class="box" x="320" y="330" width="170" height="44" stroke="#B45309"></rect><text class="tb" x="405" y="349" text-anchor="middle">Safety / policy</text><text class="ts" x="405" y="365" text-anchor="middle">input + output classifiers</text>

  <!-- inference gateway -->
  <rect class="box" x="560" y="200" width="170" height="96"></rect><text class="tb" x="645" y="222" text-anchor="middle">Inference Gateway</text>
  <text class="ts" x="570" y="240">admission / priority queue</text><text class="ts" x="570" y="254">continuous batching</text><text class="ts" x="570" y="268">route by model + prefix hash</text><text class="ts" x="570" y="282">backpressure → 429/503</text>

  <!-- GPU pool -->
  <rect class="box" x="780" y="190" width="180" height="120" stroke="#0F766E"></rect><text class="tb" x="870" y="212" text-anchor="middle">Model servers (GPU)</text>
  <rect x="795" y="222" width="150" height="22" fill="#DDF3F0" stroke="#0F766E" rx="4"></rect><text class="tm" x="870" y="237" text-anchor="middle">replica · KV cache</text>
  <rect x="795" y="250" width="150" height="22" fill="#DDF3F0" stroke="#0F766E" rx="4"></rect><text class="tm" x="870" y="265" text-anchor="middle">replica · KV cache</text>
  <rect x="795" y="278" width="150" height="22" fill="#DDF3F0" stroke="#0F766E" rx="4"></rect><text class="tm" x="870" y="293" text-anchor="middle">replica · KV cache</text>

  <!-- async -->
  <rect class="box" x="560" y="420" width="120" height="50" stroke="#B45309"></rect><text class="tb" x="620" y="441" text-anchor="middle">Event stream</text><text class="ts" x="620" y="458" text-anchor="middle">Kafka: message.created</text>
  <rect class="box" x="740" y="400" width="200" height="90"></rect><text class="tb" x="840" y="420" text-anchor="middle">Async workers</text>
  <text class="ts" x="750" y="438">· title generation</text><text class="ts" x="750" y="452">· rolling summary of long convs</text><text class="ts" x="750" y="466">· memory extraction → Memory store</text><text class="ts" x="750" y="480">· usage / billing, analytics, abuse</text>

  <!-- flows -->
  <path class="flow" d="M120 248 L158 248"></path><text class="lbl" x="122" y="240">POST</text>
  <path class="flow" d="M270 248 L318 248"></path>
  <path class="flow" d="M405 200 L405 152"></path><text class="lbl" x="410" y="180">read last N msgs</text>
  <path class="flow" d="M490 220 L558 90"></path><text class="lbl" x="500" y="150">tail cache</text>
  <path class="flow" d="M490 236 L558 150"></path><text class="lbl" x="520" y="196">memory</text>
  <path class="flow" d="M490 248 L558 248"></path><text class="lbl" x="495" y="240">prompt</text>
  <path class="flow" d="M730 248 L778 248"></path>
  <path class="flowp" d="M778 262 L732 262"></path><path class="flowp" d="M558 262 L492 262"></path><path class="flowp" d="M318 262 L272 262"></path><path class="flowp" d="M158 262 L122 262"></path>
  <text class="lblp" x="200" y="300">tokens stream back (SSE)</text>
  <path class="flow" d="M405 296 L405 328"></path><text class="lbl" x="412" y="316">both ways</text>
  <path class="flowa" d="M450 296 C 480 400, 520 445, 558 445"></path><text class="lbla" x="470" y="420">emit event</text>
  <path class="flowa" d="M680 445 L738 445"></path>
  <path class="flowa" d="M840 400 C 840 340, 700 190, 700 172"></path><text class="lbla" x="720" y="330">write facts</text>
  <path class="flow" d="M405 296 C 405 520, 500 530, 560 530" stroke="none"></path>
  <text class="ts" x="20" y="540">Solid blue = request path · dashed plum = token stream · dotted amber = async. GPU pool is the only box you can't scale by adding cheap instances.</text>
</svg>
<figcaption>The model is stateless: every turn, the Chat Service rebuilds the full prompt from storage and sends it. Nothing about the conversation lives on the GPU beyond the life of the request (and its KV cache).</figcaption>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 712" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="LLM chat turn flow between components">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="7" y="14" width="126" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Client</text>
<line class="ln" x1="70" y1="48" x2="70" y2="692"></line>
<rect class="sb" x="147" y="14" width="126" height="34"></rect><text class="st" x="210" y="36" text-anchor="middle">Gateway</text>
<line class="ln" x1="210" y1="48" x2="210" y2="692"></line>
<rect class="sb" x="287" y="14" width="126" height="34"></rect><text class="st" x="350" y="36" text-anchor="middle">Chat Service</text>
<line class="ln" x1="350" y1="48" x2="350" y2="692"></line>
<rect class="sb" x="427" y="14" width="126" height="34"></rect><text class="st" x="490" y="36" text-anchor="middle">Conv/Memory store</text>
<line class="ln" x1="490" y1="48" x2="490" y2="692"></line>
<rect class="sb" x="567" y="14" width="126" height="34"></rect><text class="st" x="630" y="36" text-anchor="middle">Inference GW</text>
<line class="ln" x1="630" y1="48" x2="630" y2="692"></line>
<rect class="sb" x="707" y="14" width="126" height="34"></rect><text class="st" x="770" y="36" text-anchor="middle">GPU worker</text>
<line class="ln" x1="770" y1="48" x2="770" y2="692"></line>
<rect class="sb" x="847" y="14" width="126" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Kafka + workers</text>
<line class="ln" x1="910" y1="48" x2="910" y2="692"></line>
<line class="a1" x1="78" y1="80" x2="202" y2="80"></line>
<text class="sl" x="140" y="74" text-anchor="middle">POST message (SSE)</text>
<rect class="nt" x="149" y="101" width="121" height="22"></rect><text class="sl" x="210" y="116" text-anchor="middle">JWT + token quota</text>
<line class="a1" x1="218" y1="148" x2="342" y2="148"></line>
<text class="sl" x="280" y="142" text-anchor="middle">forward + idempotency key</text>
<line class="a1" x1="358" y1="182" x2="482" y2="182"></line>
<text class="sl" x="420" y="176" text-anchor="middle">append user msg (tokenCount)</text>
<line class="a1" x1="358" y1="216" x2="482" y2="216"></line>
<text class="sl" x="420" y="210" text-anchor="middle">read summary + last N + memory</text>
<line class="a2" x1="482" y1="250" x2="358" y2="250"></line>
<text class="sl" x="420" y="244" text-anchor="middle">rows</text>
<rect class="nt" x="240" y="271" width="220" height="22"></rect><text class="sl" x="350" y="286" text-anchor="middle">build prompt within window budget</text>
<line class="a1" x1="358" y1="318" x2="622" y2="318"></line>
<text class="sl" x="490" y="312" text-anchor="middle">prompt</text>
<line class="a1" x1="638" y1="352" x2="762" y2="352"></line>
<text class="sl" x="700" y="346" text-anchor="middle">batch, dispatch</text>
<line class="a2" x1="762" y1="386" x2="638" y2="386"></line>
<text class="sl" x="700" y="380" text-anchor="middle">token stream</text>
<line class="a2" x1="622" y1="420" x2="358" y2="420"></line>
<text class="sl" x="490" y="414" text-anchor="middle">token stream</text>
<rect class="nt" x="243" y="441" width="214" height="22"></rect><text class="sl" x="350" y="456" text-anchor="middle">output safety, buffer for resume</text>
<line class="a2" x1="342" y1="488" x2="78" y2="488"></line>
<text class="sl" x="210" y="482" text-anchor="middle">SSE deltas</text>
<line class="a2" x1="762" y1="522" x2="638" y2="522"></line>
<text class="sl" x="700" y="516" text-anchor="middle">done + tokens_in/out</text>
<line class="a1" x1="358" y1="556" x2="482" y2="556"></line>
<text class="sl" x="420" y="550" text-anchor="middle">append assistant msg + usage</text>
<line class="a2" x1="342" y1="590" x2="78" y2="590"></line>
<text class="sl" x="210" y="584" text-anchor="middle">done event</text>
<line class="a3" x1="358" y1="624" x2="902" y2="624"></line>
<text class="sl" x="630" y="618" text-anchor="middle">message.created, usage.event</text>
<line class="a3" x1="902" y1="658" x2="498" y2="658"></line>
<text class="sl" x="700" y="652" text-anchor="middle">summary / memory / title updates</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Client → Gateway:</b> POST message (SSE).
    Server‑sent events rather than WebSockets: the data flows one way, SSE reconnects natively with <code>lastEventId</code>, and it survives proxies that mangle long‑lived upgrades.
    The connection will stay open for the whole generation, so the gateway must be built for millions of idle‑but‑open sockets rather than short request/response cycles.</li>
  <li><b>Gateway:</b> JWT + token quota.
    Identity and quota are checked before any expensive work, so an over‑limit user costs a Redis lookup rather than a GPU slot.
    Quota is counted in tokens, not messages, because a 100K‑token context costs far more than a one‑line question and charging per message would be wildly unfair in both directions.</li>
  <li><b>Gateway → Chat Service:</b> forward + idempotency key.
    The idempotency key is what makes a client retry safe: a dropped connection mid‑send must not append the user's message twice.
    Any gateway can serve any request, because all conversation state lives in the store rather than in gateway memory.</li>
  <li><b>Chat Service → Conv/Memory store:</b> append user msg (tokenCount).
    The user's message is persisted before generation starts, so a failure during inference never loses what the person actually typed.
    Token count is computed and stored at write time — this single denormalization turns context assembly into cheap arithmetic instead of re‑tokenizing the entire history on every turn.</li>
  <li><b>Chat Service → Conv/Memory store:</b> read summary + last N + memory.
    Three different things are fetched because they play three different roles: durable per‑user facts, a rolling summary of old turns, and the most recent messages verbatim.
    Active conversations are served from a Redis hot tail, so a rapid back‑and‑forth does not hit the system of record on every turn.</li>
  <li><b>Conv/Memory store → Chat Service:</b> rows (response).
    The store is partitioned by conversation id and sorted by time, so "fetch the tail of this conversation" is one contiguous read — the single access pattern the schema is designed around.</li>
  <li><b>Chat Service:</b> build prompt within window budget.
    This is the heart of the product: the model is stateless, so "memory" is an illusion reconstructed from storage on every single turn.
    The budget is arithmetic — system prompt + memory facts + summary + last N messages, trimmed to the window minus room for the reply — made cheap by the token counts saved at write time.
    What gets dropped first is a product decision, not a technical one: older turns lose fidelity to a summary while recent turns stay verbatim, because recency is what users notice.</li>
  <li><b>Chat Service → Inference GW:</b> prompt.
    The whole conversation is sent every turn; nothing persists on the GPU between requests.
    That is what makes the serving fleet stateless and freely replaceable — any replica can serve any turn of any conversation.</li>
  <li><b>Inference GW → GPU worker:</b> batch, dispatch.
    Requests are batched for throughput and routed by prefix affinity so a replica that already has the shared system prompt in its KV cache is preferred.
    Prefix caching is not a micro‑optimisation here: the shared prefix is identical across millions of requests, and reusing it is worth a large fraction of effective capacity.</li>
  <li><b>GPU worker → Inference GW:</b> token stream (response).
    Tokens stream as they are produced rather than being collected — the user sees output within a second instead of waiting for a complete response.
    Continuous batching admits new sequences as others finish, so one long generation does not block the whole batch behind it.</li>
  <li><b>Inference GW → Chat Service:</b> token stream (response).
    The stream passes through the chat service rather than going straight to the client, precisely so the next two things can happen.</li>
  <li><b>Chat Service:</b> output safety, buffer for resume.
    Output is classified as it streams, with a small lookahead, so unsafe content can be cut before the user sees it rather than retracted afterwards.
    The same buffer serves resume: if the connection drops, the client reconnects with <code>lastEventId</code> and continues from that offset instead of paying for regeneration.
    Buffering is cheap and regeneration is not, which makes this one of the highest‑value few hundred kilobytes in the system.</li>
  <li><b>Chat Service → Client:</b> SSE deltas (response).
    Deltas are sent as they clear safety, so perceived latency is governed by first token and inter‑token gaps rather than total generation time.
    Each event carries an id, which is what makes resume possible at all.</li>
  <li><b>GPU worker → Inference GW:</b> done + tokens_in/out (response).
    Usage is reported by the worker because it is the only component that knows the true token counts, and those numbers drive both quota and billing.</li>
  <li><b>Chat Service → Conv/Memory store:</b> append assistant msg + usage.
    The assistant message is persisted with its token counts, keeping the transcript complete and the next turn's budget arithmetic exact.
    A cancelled or disconnected generation still persists what was produced, so the conversation shows what actually happened rather than a gap.</li>
  <li><b>Chat Service → Client:</b> done event (response).
    An explicit terminal event distinguishes "finished" from "connection died", which is what lets the client decide between showing completion and attempting a resume.</li>
  <li><b>Chat Service → Kafka + workers:</b> message.created, usage.event (async).
    Everything that does not have to happen before the user sees their answer is pushed off the request path — titles, summaries, memory extraction and billing.
    Publishing events rather than calling services keeps the latency‑critical path independent of how many downstream consumers exist.</li>
  <li><b>Kafka + workers → Conv/Memory store:</b> summary / memory / title updates (async).
    The rolling summary is regenerated when a conversation crosses a size threshold, which is what lets a 500‑turn chat keep fitting a fixed window.
    Memory extraction distils durable facts across conversations, and keeping them user‑visible and editable is both a product feature and a privacy requirement.
    All of this is eventually consistent by design: a title arriving a few seconds late is invisible, while doing it inline would add seconds to every first turn.</li>
</ol>

## Request flow, one turn {#lc-flow}

<ol class="order">
  <li>Client opens <code>POST /conversations/:id/messages</code> with <code>Accept: text/event-stream</code>; gateway validates JWT, checks per‑user quota in Redis (tokens/min, messages/day), routes to a Chat Service instance.</li>
  <li>Chat Service persists the user message (append; idempotency key dedupes retries) and runs input safety.</li>
  <li><b>Context build:</b> system prompt + user memory facts + rolling summary of older turns + the last N messages verbatim, trimmed to fit the model's window minus room for the reply. Token counts stored per message make this a cheap arithmetic pass, no re‑tokenizing.</li>
  <li>Sends the prompt to the Inference Gateway, which queues it, batches it with other in‑flight requests on a replica that likely already has the shared prefix (system prompt) cached, and streams tokens back.</li>
  <li>Chat Service relays tokens as SSE <code>data:</code> events, runs output safety on the stream, and buffers the full text.</li>
  <li>On completion (or stop/disconnect), persists the assistant message with usage, emits <code>message.created</code> to Kafka, sends <code>done</code>.</li>
  <li>Workers pick up the event: generate a title on first turn, refresh the rolling summary when the conversation crosses a size threshold, extract durable facts into memory, record billing.</li>
</ol>

## Worked example: turn 47 of a long conversation {#lc-example}

<p>The abstract version of this design is easy to nod along to and hard to reproduce under pressure. Here is one concrete turn with real numbers, in a conversation that is long enough for the interesting parts to bite.</p>

<p><b>Setup:</b> user has a 46‑turn conversation about debugging a Kubernetes cluster. Total history if sent verbatim: ~38,000 tokens. Model window: 32,000 tokens. They type <em>"so what should I check first?"</em> — 8 tokens.</p>

<ol class="order">
  <li><b>T+0ms · Client opens the stream.</b>
    <code>POST /conversations/c_7d31/messages</code> with <code>Accept: text/event-stream</code> and an idempotency key <code>cm_a91f</code> generated client‑side.
    <em>The key matters because the next step is a write:</em> if the connection drops and the client retries, that key is what stops the message being appended twice.</li>
  <li><b>T+3ms · Gateway checks identity and quota.</b>
    JWT valid; Redis counters say this user has used 48,000 of 200,000 tokens this minute and 34 of 200 messages today. Admitted.
    <em>Quota is counted in tokens, not messages,</em> because this turn will cost ~12,000 tokens of prefill while a one‑line question in a fresh chat costs 50 — charging per message would be wildly unfair in both directions.</li>
  <li><b>T+8ms · Persist the user message.</b>
    The chat service appends <code>{role: user, content: "so what should I check first?", tokens: 8}</code> to the conversation store, keyed by <code>c_7d31</code>, sorted by time.
    <b>Durable before generation starts.</b> If inference fails at T+900ms, what the user typed is not lost.
    Token count is computed and stored <em>now</em> — this one denormalization is what makes step 5 arithmetic instead of re‑tokenizing 38,000 tokens on every turn.</li>
  <li><b>T+12ms · Read the three context inputs.</b>
    From the hot tail in Redis (this conversation is active): the last 12 messages verbatim, ~6,400 tokens.
    From the conversation row: the rolling summary of turns 1–34, ~800 tokens.
    From the memory store: 4 durable facts about this user, ~120 tokens. <em>e.g. "prefers concise answers", "works in Go".</em></li>
  <li><b>T+14ms · Build the prompt within budget.</b>
    Budget = 32,000 window − 4,000 reserved for the reply = <b>28,000 tokens</b>.
    Assemble: system prompt (600) + memory facts (120) + rolling summary (800) + recent messages newest‑first until the budget is spent.
    That fits 21 messages (~11,200 tokens) — <b>turns 1–25 are simply not included</b>, they are represented only by the summary.
    <em>This is the whole illusion: the model is stateless and "remembers" nothing. The chat service reconstructs a plausible memory from storage on every single turn.</em>
    Total prompt: ~12,720 tokens. Cost of building it: a few hundred microseconds of integer addition, because every token count was stored at write time.</li>
  <li><b>T+15ms · Send to the inference gateway.</b>
    The <em>entire</em> 12,720‑token prompt goes over the wire. Nothing about this conversation lives on any GPU between turns — which is exactly why any replica can serve any turn and the serving fleet is freely replaceable.</li>
  <li><b>T+18ms · Batch and route by prefix.</b>
    The gateway routes to a replica that already has the shared system prompt (600 tokens, identical across millions of requests) in its KV cache. That prefix cache hit saves real prefill work.
    Continuous batching admits this sequence alongside others already decoding, so one long generation does not block the batch behind it.</li>
  <li><b>T+18ms → T+520ms · Prefill.</b>
    The GPU processes 12,720 input tokens. <b>This is where context length becomes latency</b> — prefill scales with input size, which is why SLIs are bucketed by context length. A 200‑token prompt would have been ~40ms here.
    Concurrently, the input safety classifier runs; it finishes at T+190ms, well before the first token, so its cost is entirely hidden.</li>
  <li><b>T+540ms · First token.</b>
    <b>TTFT = 540ms.</b> This is the number the user experiences as responsiveness, and the reason total latency is a bad SLI: this reply will run 380 tokens and take 12 seconds, which says nothing about whether the product felt fast.</li>
  <li><b>T+540ms → T+11.9s · Stream, with an 8-token buffer.</b>
    Tokens arrive at ~32/s (ITL ≈ 31ms). The chat service holds an 8‑token lookahead and runs the output classifier on a sliding window before releasing anything.
    <b>The buffer is what makes cutting possible rather than apologising:</b> if the classifier flags content at token 200, tokens 193–200 have not been shown, so the user never sees them.
    Each SSE event carries an id. The full text is buffered as it goes.</li>
  <li><b>T+6.2s · The user's train enters a tunnel.</b>
    Connection drops at token 190. The client reconnects 4 seconds later with <code>Last-Event-ID: 190</code>; the service replays from its buffer and streaming continues at token 191.
    <em>Without that buffer this costs a full regeneration — 12 seconds of the user's time and a second full GPU bill for an answer that was already computed.</em></li>
  <li><b>T+11.9s · Done.</b>
    Worker reports <code>tokens_in: 12,720, tokens_out: 380</code>. The assistant message is persisted with its token counts, so turn 48's budget arithmetic is exact. A <code>done</code> event is sent — explicitly distinguishable from a dropped connection, which is what lets the client choose between completing and resuming.</li>
  <li><b>T+11.9s · Emit events and return.</b>
    <code>message.created</code> and <code>usage.event</code> go to Kafka. The turn is over from the user's point of view; everything after this is decoupled.</li>
  <li><b>T+14s · Async workers do the rest.</b>
    The metering consumer increments Redis counters (which the gateway will read on turn 48) and appends to the durable billing ledger keyed by request id, so a partition replay cannot double‑bill.
    The conversation crossed the summary threshold at turn 45, so a <em>small</em> model regenerates the rolling summary to now cover turns 1–40 — on a small‑model pool, so the large model serves only user turns.
    A memory‑extraction worker notices "I'm on EKS, not GKE" from turn 46 and proposes a new durable fact, user‑visible and editable.
    <em>All of this is seconds late and nobody notices. Doing it inline would have added seconds to the turn.</em></li>
</ol>

<div class="trap"><b>What turn 47 shows that turn 2 does not.</b> At turn 2 the whole history fits and every design is equivalent. At turn 47 three things bite at once: history exceeds the window so <b>trimming policy becomes a product decision</b> (old turns degrade to a summary, recent ones stay verbatim, because recency is what users notice); prefill is 13× the cost of decode's first token so <b>context length is the latency driver</b>; and the summary that makes it fit was generated asynchronously by a different, smaller model. If you can narrate turn 47 you have explained the design — turn 2 explains nothing.</div>

## Where is the "chat" actually stored? {#lc-storage}

<table>
  <tbody><tr><th>Thing</th><th>Where</th><th>Why there</th></tr>
  <tr><td>Messages (the transcript)</td><td>Wide‑column / KV store partitioned by <code>conversationId</code>, sorted by time (DynamoDB, Cassandra, Bigtable). Sharded Postgres also works.</td><td>Append‑only, one access pattern (fetch a conversation's tail in order), huge write volume, needs durability. System of record.</td></tr>
  <tr><td>Conversation list per user</td><td>Same store, GSI / second table keyed by <code>userId</code> sorted by <code>updatedAt</code>, with title and snippet denormalized.</td><td>Sidebar query without scanning messages.</td></tr>
  <tr><td>Hot tail of active conversations</td><td>Redis (list or hash per conversation, short TTL).</td><td>Avoid a DB read on every turn while the user is actively chatting. Rebuildable.</td></tr>
  <tr><td>Context the model sees</td><td>Nowhere persistent. Assembled per request from the rows above, sent as the prompt, discarded.</td><td>The model is stateless; "memory" is an illusion the Chat Service reconstructs each turn.</td></tr>
  <tr><td>KV cache (attention state for the prompt)</td><td>GPU memory on the model server, for the duration of the request; prefix caching may keep the shared system‑prompt portion warm across requests.</td><td>Speeds generation; losing it costs latency, never correctness. Not storage.</td></tr>
  <tr><td>Rolling summary of old turns</td><td>Stored on the Conversation row, regenerated async as the conversation grows.</td><td>Lets a 500‑turn chat fit a fixed window: summary + recent verbatim.</td></tr>
  <tr><td>Cross‑conversation memory</td><td>Memory store: per‑user list of facts (and optionally embeddings for retrieval), written by async workers, user‑visible and editable.</td><td>"Remembers you like concise answers" without shipping every past chat.</td></tr>
  <tr><td>Attachments</td><td>S3 via presigned URLs; message holds the pointer; extracted text stored alongside for prompting.</td><td>Blobs never in the DB.</td></tr>
</tbody></table>
<div class="note"><b>Interview line:</b> "The transcript is durable in a partitioned store keyed by conversation; the model never stores anything. Each turn I rebuild context: system prompt + memory + summary of the old part + last N messages verbatim, budgeted by token counts I saved at write time."</div>

## What actually happens inside "call the model" {#lc-model}

<p>The weights are fixed: billions of numbers learned in training, identical for every request. Your text becomes numbers that the weights are applied to, one token at a time.</p>
<figure>
<svg viewBox="0 0 980 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Inference loop: text tokenized to ids, ids embedded to vectors, vectors pass through transformer layers, final vector scored against vocabulary, one token sampled, appended, loop repeats until end token; prefill covers the whole prompt in parallel, decode produces one token per pass using the KV cache">
  <defs><marker id="lm1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker></defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.tm{font-size:10.5px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#lm1)}.lbl{font-size:10.5px;fill:#1F4E9E}.pl{fill:none;stroke:#D6DDE5;stroke-dasharray:6 4;rx:8}.pt{font-size:11px;font-weight:700;fill:#5B6673}</style>
  <rect class="pl" x="10" y="10" width="560" height="140"></rect><text class="pt" x="20" y="28">PREFILL (whole prompt, parallel, cost ∝ context length)</text>
  <rect class="box" x="20" y="45" width="120" height="70"></rect><text class="tb" x="80" y="65" text-anchor="middle">1 Tokenize</text><text class="tm" x="80" y="83" text-anchor="middle">"Hello, how" →</text><text class="tm" x="80" y="97" text-anchor="middle">[9906, 11, 1268]</text>
  <rect class="box" x="160" y="45" width="120" height="70"></rect><text class="tb" x="220" y="65" text-anchor="middle">2 Embed</text><text class="ts" x="220" y="83" text-anchor="middle">id → vector (4k floats)</text><text class="ts" x="220" y="97" text-anchor="middle">+ position</text>
  <rect class="box" x="300" y="45" width="130" height="70" stroke="#0F766E"></rect><text class="tb" x="365" y="65" text-anchor="middle">3 N layers</text><text class="ts" x="365" y="83" text-anchor="middle">attention: mix across tokens</text><text class="ts" x="365" y="97" text-anchor="middle">feed‑forward: transform each</text>
  <rect class="box" x="450" y="45" width="110" height="70" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="505" y="65" text-anchor="middle">KV cache</text><text class="ts" x="505" y="83" text-anchor="middle">attention state saved</text><text class="ts" x="505" y="97" text-anchor="middle">so decode doesn't redo it</text>
  <path class="f" d="M140 80 L158 80"></path><path class="f" d="M280 80 L298 80"></path><path class="f" d="M430 80 L448 80"></path>
  <rect class="pl" x="10" y="160" width="960" height="130"></rect><text class="pt" x="20" y="178">DECODE (one token per pass, latency‑bound, repeats until end token or max_tokens)</text>
  <rect class="box" x="20" y="195" width="150" height="70"></rect><text class="tb" x="95" y="215" text-anchor="middle">4 Score vocabulary</text><text class="ts" x="95" y="233" text-anchor="middle">last vector × output matrix</text><text class="ts" x="95" y="247" text-anchor="middle">→ 100K logits → softmax</text>
  <rect class="box" x="190" y="195" width="150" height="70"></rect><text class="tb" x="265" y="215" text-anchor="middle">5 Sample one token</text><text class="tm" x="265" y="233" text-anchor="middle">"I" 31% "Sure" 9% …</text><text class="ts" x="265" y="247" text-anchor="middle">temperature = how adventurous</text>
  <rect class="box" x="360" y="195" width="150" height="70"></rect><text class="tb" x="435" y="215" text-anchor="middle">6 Append, run again</text><text class="ts" x="435" y="233" text-anchor="middle">only the new token goes</text><text class="ts" x="435" y="247" text-anchor="middle">through layers 3 (cache)</text>
  <rect class="box" x="530" y="195" width="130" height="70"></rect><text class="tb" x="595" y="215" text-anchor="middle">7 Detokenize</text><text class="ts" x="595" y="233" text-anchor="middle">id → text piece</text><text class="ts" x="595" y="247" text-anchor="middle">streamed to client</text>
  <rect class="box" x="690" y="195" width="270" height="70"></rect><text class="tb" x="825" y="215" text-anchor="middle">Why it matters for the infra</text><text class="ts" x="700" y="233">TTFT ≈ prefill time ∝ prompt length</text><text class="ts" x="700" y="247">ITL ≈ one decode pass; batching packs many users' passes</text><text class="ts" x="700" y="261">prefix cache = reuse KV for identical system prompt</text>
  <path class="f" d="M170 230 L188 230"></path><path class="f" d="M340 230 L358 230"></path><path class="f" d="M510 230 L528 230"></path>
  <path class="f" d="M435 195 C 435 150, 200 150, 95 195" stroke-dasharray="4 3"></path><text class="lbl" x="230" y="158">loop</text>
</svg>
</figure>
<ol class="order">
  <li><b>Tokenize.</b> A fixed vocabulary (~100K pieces) splits text into sub‑word tokens and maps each to an integer. "unbelievable" → <code>un</code> <code>believ</code> <code>able</code>. This is why usage is billed in tokens and why context limits are in tokens, not characters.</li>
  <li><b>Embed.</b> Each id selects a row of the embedding matrix (part of the weights): a vector of a few thousand floats. Positional information is added so order matters.</li>
  <li><b>Transformer layers.</b> The token vectors pass through dozens of identical layers. Attention lets each token's vector pull information from every other token (how "it" resolves to the thing it refers to); a feed‑forward block transforms each vector. Same weights every request; only the vectors change. Running this over the whole prompt is <b>prefill</b>.</li>
  <li><b>Score the vocabulary.</b> The last position's vector is multiplied by the output matrix to give one score per vocabulary entry; softmax turns scores into probabilities.</li>
  <li><b>Sample.</b> Pick one token from that distribution. Temperature 0 always takes the top; higher values spread the choice. There is no separate "decide the answer" step: choosing the next token is the decision.</li>
  <li><b>Append and repeat.</b> The chosen token joins the sequence and the model runs again for the next one. Thanks to the <b>KV cache</b>, only the new token goes through the layers; earlier attention state is reused. Stops at an end‑of‑sequence token or <code>max_tokens</code>. This is <b>decode</b>.</li>
  <li><b>Detokenize.</b> Output ids map back to text pieces and are streamed to the client as they're produced.</li>
</ol>
<div class="note"><b>Consequences the design leans on:</b> prefill cost grows with prompt length, so TTFT depends on context size and the Context Builder's trimming directly buys latency; decode is one pass per token, so ITL is roughly constant and batching many users' decode steps into one GPU pass is how throughput scales; the KV cache lives in GPU memory only for the request, which is why nothing about the chat persists on the model server; and identical system‑prompt prefixes can share cached attention state (prefix caching), which is why the system prompt is kept byte‑identical across users.</div>

## Deep dives {#lc-deepdives}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/llm-chat/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

### 1. Streaming and the stateful connection

<ul>
  <li>SSE, not WebSocket: traffic is server → client, one response per turn, works through plain HTTP infra. Client sends <code>stop</code> as a separate POST.</li>
  <li>Connection dies mid‑stream (mobile): server keeps generating and buffering; client reconnects with <code>Last-Event-ID</code> and gets the missed deltas from the buffer (Redis, keyed by messageId). Never regenerate; it costs GPU time and gives a different answer.</li>
  <li>L7 load balancer with idle timeouts raised; least‑connections so streams spread evenly; Chat Service instances are stateless apart from the in‑flight buffer.</li>
</ul>

### 2. Context window management

<ul>
  <li>Budget: window − reserved output − system prompt − memory = room for history. Fill newest‑first until full.</li>
  <li>Long conversations: rolling summary replaces turns older than the cut; summary regenerated asynchronously every K turns so the hot path never waits on a second model call.</li>
  <li>Store <code>tokenCount</code> per message at write time so trimming is O(N) arithmetic.</li>
  <li>Keep the system prompt byte‑identical across users so inference can reuse the cached prefix.</li>
</ul>

### 3. GPU capacity: the flash‑sale bottleneck of this problem

<ul>
  <li>Do the math: replicas × tokens/sec per replica vs. concurrent streams × tokens/sec per stream. That gap is the whole scaling story; more Chat Service pods change nothing.</li>
  <li>Inference gateway does admission control: priority queue (paid &gt; free), per‑user concurrency limits, 429 with Retry‑After when the queue depth exceeds the SLA, and a waiting‑room UX under overload rather than timeouts.</li>
  <li>Continuous batching packs many streams into one forward pass; prefix caching skips recomputing the shared system prompt; route by (model, prefix hash) so cache hits cluster.</li>
  <li>Smaller/cheaper model for title generation, summaries, memory extraction, and low‑tier traffic. Keep the big model for the user‑facing turn.</li>
</ul>

### 4. Storage scale

<ul>
  <li>Partition by <code>conversationId</code> (high cardinality, all reads are per‑conversation). A user with 10K chats is fine; a single 100K‑message chat is the hot‑partition risk, which the rolling summary also mitigates since you stop reading the whole thing.</li>
  <li>Writes are append‑only, so LSM stores (Cassandra) shine. Reads are "tail of one partition," which is exactly the sort‑key range query.</li>
  <li>Deletion / retention: user deletes → tombstone + async purge from store, cache, memory, and any index; needed for privacy regulations.</li>
</ul>

### 5. Safety, abuse, cost

<ul>
  <li>Input classifier before inference (cheap, blocks obvious abuse from burning GPU); output classifier on the stream with the ability to cut and replace.</li>
  <li>Rate limits in tokens, not requests, because a 100K‑token prompt costs 1000× a short one.</li>
  <li>Usage events to Kafka → billing and abuse detection off the hot path.</li>
</ul>


## Trade-offs {#lc-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Where context lives</td><td>Rebuild the prompt from storage every turn</td><td>Bandwidth and prefill cost — the whole history is re‑sent each time</td><td>Session‑pinned KV cache on a replica saves prefill but couples a conversation to a machine, which breaks failover and load balancing</td></tr>
  <tr><td>Long conversations</td><td>Rolling summary of old turns + last N verbatim</td><td>Fidelity — summarised turns lose detail the user may later reference</td><td>Retrieve specific old turns by embedding search when conversations are long and reference‑heavy; it costs a retrieval hop per turn</td></tr>
  <tr><td>Transport</td><td>SSE</td><td>Bidirectional messaging, so interactive features need a second channel</td><td>WebSockets when the client must push mid‑generation (live collaboration, voice); SSE's native resume is worth a lot otherwise</td></tr>
  <tr><td>Transcript store</td><td>Wide‑column partitioned by conversation id</td><td>Ad‑hoc queries and joins — analytics needs a separate pipeline</td><td>Sharded Postgres is fine at smaller scale and much easier to query; the single access pattern here makes the KV shape a clean win</td></tr>
  <tr><td>Sidebar</td><td>Denormalized list keyed by user, sorted by updatedAt</td><td>A second write per turn, and a window where list and transcript disagree</td><td>Computing it from messages is simpler but scans; at 100M users it is not viable</td></tr>
  <tr><td>Stream reliability</td><td>Buffer output for resume by <code>lastEventId</code></td><td>Memory per in‑flight stream, multiplied by 10M concurrent</td><td>Regenerating on reconnect is simpler but pays full GPU cost twice for the same answer</td></tr>
  <tr><td>Post‑turn work</td><td>Async via Kafka</td><td>Titles, summaries and memory lag by seconds</td><td>Inline only when the result must be visible immediately — which for titles and summaries it is not</td></tr>
</tbody></table>

## Safety-first design {#lc-safety}

<div class="cards">
  <div><h4>Nothing unsafe reaches the screen</h4><ul>
    <li><b>Classify input before generating.</b> The check runs concurrently with prefill so it costs no perceptible latency, but no token is released until it passes.</li>
    <li><b>Classify output as it streams.</b> A small lookahead buffer means unsafe content is cut before display rather than retracted after — the user never sees it.</li>
    <li><b>Treat pasted content as untrusted.</b> Text a user pastes may contain injection attempts aimed at the system prompt; it is data in the conversation, never instructions to the service.</li>
    <li><b>Never silently truncate.</b> If context does not fit, what is dropped follows a stated policy, because quietly losing part of the conversation is a correctness failure the user cannot see.</li></ul></div>
  <div><h4>The transcript is the sensitive asset</h4><ul>
    <li><b>Every read is scoped by user.</b> Authorization is on the query, not on the URL, so a guessed conversation id returns nothing.</li>
    <li><b>Deletion reaches the derivatives.</b> Summaries, memory facts and embeddings are copies of user content; deleting the transcript without them is not deletion.</li>
    <li><b>Memory is visible and editable.</b> A user can see and remove what the system remembers about them, which makes cross‑conversation memory a feature rather than a surprise.</li>
    <li><b>Logs hold no message content.</b> Debugging records ids, token counts and latencies, so operational data never becomes a second copy of private conversations.</li></ul></div>
  <div><h4>Degrade in ways users can understand</h4><ul>
    <li><b>Queue visibly under GPU pressure.</b> A shown wait is honest; a silently slower response looks like a broken product.</li>
    <li><b>Shed free tier first, by published policy.</b> The order is decided in advance, so behaviour during a capacity crunch is predictable.</li>
    <li><b>Resume rather than regenerate.</b> A dropped connection continues from the buffer, which protects both the user's answer and the GPU capacity everyone else is waiting for.</li>
    <li><b>Persist partial generations.</b> A cancelled or interrupted turn still shows what was produced, so the transcript reflects what actually happened.</li></ul></div>
</div>

## Don't leave the room without saying {#lc-checklist}

<ul class="checklist">
  <li>Model is stateless; the product is stateful; the Chat Service bridges them by rebuilding context every turn</li>
  <li>SSE for the stream, resumable by Last‑Event‑ID from a server‑side buffer</li>
  <li>Transcript in a partitioned append‑only store keyed by conversation; sidebar via user index; hot tail in Redis</li>
  <li>Context budget: system + memory + summary + recent turns, using stored token counts</li>
  <li>GPU throughput is the ceiling; inference gateway with queueing, priority, batching, backpressure</li>
  <li>Async workers for summaries, memory, titles, billing, keep the hot path to one model call</li>
  <li>Safety on both sides of the model; rate limit by tokens</li>
  <li>Deletion propagates to store, cache, memory, indexes</li>
</ul>

## What each level is expected to drive {#lc-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Conversation/message model, persist then call model, streaming with SSE</td><td>Context trimming, GPU as bottleneck</td></tr>
  <tr><td>Senior</td><td>Context budget + rolling summary, resumable streams, partitioned message store, inference queue with backpressure</td><td>Prefix caching, priority tiers</td></tr>
  <tr><td>Staff+</td><td>Quantitative GPU capacity plan, admission control and load shedding, batching/prefix‑cache routing, memory design with privacy/deletion, cost per token as a design input</td><td>—</td></tr>
</tbody></table>
