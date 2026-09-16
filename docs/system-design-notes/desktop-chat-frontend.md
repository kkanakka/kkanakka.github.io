---
title: "Desktop AI chat frontend"
slug: /system-design-notes/desktop-chat-frontend
sidebar_position: 27
sidebar_label: "Desktop AI chat frontend"
description: "medium · cross‑platform · streaming state · offline · secure token storage"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/desktop-chat-frontend/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">medium · cross‑platform · streaming state · offline · secure token storage</span>
</header>
<p>A native desktop app (macOS/Windows/Linux) for chatting with an LLM: conversation list, streaming replies, attachments, works through flaky networks, keeps secrets safe. The backend exists (the ChatGPT design); this is the client side and the contract between them.</p>

## Requirements {#desktop-chat-frontend-req}

<div class="board">
  <div><h4>Functional</h4><ol>
      <li>Sign in; list/open/create conversations; send message; see reply stream token by token</li>
      <li>Stop generation; retry; edit and resend; attachments (files, images)</li>
      <li>Works offline for reading history and queuing sends; syncs on reconnect</li>
      <li>Multiple windows / accounts; system tray; keyboard‑first UX</li>
      <li class="out">Voice, plugins, admin features</li>
  </ol></div>
  <div><h4>Non‑functional</h4><ol>
      <li>First token visible &lt; 1 s after backend first token; UI never blocks</li>
      <li>Resumable streams across network drops; no duplicated or lost messages</li>
      <li>Secrets in the OS keychain; no plaintext tokens on disk</li>
      <li>Startup &lt; 2 s with 10K conversations; memory bounded</li>
      <li>Auto‑update with rollback; crash isolation</li>
  </ol></div>
</div>
<div class="note"><b>Stack choice to justify:</b> Electron/Tauri (web UI, one codebase, larger footprint) vs native per platform (best feel, 3× cost). Default: Tauri or Electron with a shared TypeScript core; the interview is about state, streaming and sync, not widgets.</div>

## Entities and API {#desktop-chat-frontend-api}

<p>Conversation · Message (id, clientMessageId, role, status: pending|streaming|done|failed, content, createdAt) · Attachment (local path, uploadStatus, remoteKey) · Draft · SyncCursor (per conversation) · Session (token in keychain).</p>
<pre><code>Backend contract used by the client
  GET  /conversations?cursor=            POST /conversations
  GET  /conversations/:id/messages?cursor=
  POST /conversations/:id/messages {clientMessageId, content, attachments[]}  -&gt; SSE {delta}… {done}
  GET  /conversations/:id/messages/:id/stream?lastEventId=   (resume)
  POST /uploads → presigned URL
Local: SQLite (conversations, messages, drafts, outbox, sync cursors); keychain for tokens</code></pre>

## Design {#desktop-chat-frontend-design}

<figure>
<svg viewBox="0 0 980 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Desktop chat client architecture: UI layer with view models; app core with state store, streaming client, outbox and sync engine; local SQLite and keychain; backend over HTTPS/SSE">
<defs><marker id="dg1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="dg3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#dg1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#dg3);stroke-dasharray:2 4}.lbl{font-size:10.5px;fill:#1F4E9E}</style>
<rect class="box" x="20" y="40" width="150" height="90"></rect><text class="tb" x="95" y="58" text-anchor="middle">UI (React/Svelte)</text>
<text class="ts" x="95" y="74" text-anchor="middle">virtualized message list</text>
<text class="ts" x="95" y="87" text-anchor="middle">optimistic render</text>
<text class="ts" x="95" y="100" text-anchor="middle">stop / retry buttons</text>
<rect class="box" x="210" y="40" width="170" height="90" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="295" y="58" text-anchor="middle">State store</text>
<text class="ts" x="295" y="74" text-anchor="middle">single source of truth</text>
<text class="ts" x="295" y="87" text-anchor="middle">reducers per event</text>
<text class="ts" x="295" y="100" text-anchor="middle">selectors → UI</text>
<rect class="box" x="420" y="20" width="170" height="70"></rect><text class="tb" x="505" y="38" text-anchor="middle">Streaming client</text>
<text class="ts" x="505" y="54" text-anchor="middle">SSE, backoff + resume</text>
<text class="ts" x="505" y="67" text-anchor="middle">Last-Event-ID</text>
<text class="ts" x="505" y="80" text-anchor="middle">token batching (16 ms)</text>
<rect class="box" x="420" y="110" width="170" height="70" stroke="#B45309"></rect><text class="tb" x="505" y="128" text-anchor="middle">Outbox + sync engine</text>
<text class="ts" x="505" y="144" text-anchor="middle">queued sends, retries</text>
<text class="ts" x="505" y="157" text-anchor="middle">pull changes since cursor</text>
<text class="ts" x="505" y="170" text-anchor="middle">conflict: server wins</text>
<rect class="box" x="630" y="40" width="150" height="90" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="tb" x="705" y="58" text-anchor="middle">Backend API</text>
<text class="ts" x="705" y="74" text-anchor="middle">auth, chat, uploads</text>
<text class="ts" x="705" y="87" text-anchor="middle">(ChatGPT design)</text>
<rect class="box" x="210" y="170" width="170" height="70" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="295" y="188" text-anchor="middle">SQLite (local)</text>
<text class="ts" x="295" y="204" text-anchor="middle">messages, drafts, outbox</text>
<text class="ts" x="295" y="217" text-anchor="middle">cursors; encrypted at rest</text>
<rect class="box" x="420" y="200" width="170" height="60"></rect><text class="tb" x="505" y="218" text-anchor="middle">OS keychain</text>
<text class="ts" x="505" y="234" text-anchor="middle">refresh token only</text>
<text class="ts" x="505" y="247" text-anchor="middle">access token in memory</text>
<rect class="box" x="630" y="170" width="150" height="70"></rect><text class="tb" x="705" y="188" text-anchor="middle">Uploader</text>
<text class="ts" x="705" y="204" text-anchor="middle">chunked presigned PUT</text>
<text class="ts" x="705" y="217" text-anchor="middle">progress, resume</text>
<rect class="box" x="810" y="40" width="150" height="90"></rect><text class="tb" x="885" y="58" text-anchor="middle">Auto‑update</text>
<text class="ts" x="885" y="74" text-anchor="middle">signed bundles</text>
<text class="ts" x="885" y="87" text-anchor="middle">staged rollout, rollback</text>
<line class="f" x1="170" y1="85" x2="208" y2="85"></line>
<text class="lbl" x="189" y="79" text-anchor="middle">events</text>
<line class="f" x1="380" y1="70" x2="418" y2="55"></line>
<line class="f" x1="380" y1="100" x2="418" y2="145"></line>
<line class="f" x1="590" y1="55" x2="628" y2="70"></line>
<text class="lbl" x="609" y="56" text-anchor="middle">HTTPS/SSE</text>
<line class="f" x1="590" y1="145" x2="628" y2="100"></line>
<text class="lbl" x="609" y="116" text-anchor="middle">sync</text>
<line class="f" x1="295" y1="130" x2="295" y2="168"></line>
<text class="lbl" x="295" y="143" text-anchor="middle">persist</text>
<line class="f" x1="590" y1="230" x2="628" y2="205"></line>
<text class="ts" x="20" y="250">UI renders from the store only; network and disk never touch the UI thread.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 678" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sending a message from the desktop client">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="5" y="14" width="130" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">UI</text>
<line class="ln" x1="70" y1="48" x2="70" y2="658"></line>
<rect class="sb" x="173" y="14" width="130" height="34"></rect><text class="st" x="238" y="36" text-anchor="middle">State store</text>
<line class="ln" x1="238" y1="48" x2="238" y2="658"></line>
<rect class="sb" x="341" y="14" width="130" height="34"></rect><text class="st" x="406" y="36" text-anchor="middle">Outbox</text>
<line class="ln" x1="406" y1="48" x2="406" y2="658"></line>
<rect class="sb" x="509" y="14" width="130" height="34"></rect><text class="st" x="574" y="36" text-anchor="middle">Streaming client</text>
<line class="ln" x1="574" y1="48" x2="574" y2="658"></line>
<rect class="sb" x="677" y="14" width="130" height="34"></rect><text class="st" x="742" y="36" text-anchor="middle">Backend</text>
<line class="ln" x1="742" y1="48" x2="742" y2="658"></line>
<rect class="sb" x="845" y="14" width="130" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">SQLite</text>
<line class="ln" x1="910" y1="48" x2="910" y2="658"></line>
<line class="a1" x1="78" y1="80" x2="230" y2="80"></line>
<text class="sl" x="154" y="74" text-anchor="middle">send(text) → clientMessageId</text>
<line class="a1" x1="246" y1="114" x2="902" y2="114"></line>
<text class="sl" x="574" y="108" text-anchor="middle">insert user msg pending; add to outbox</text>
<line class="a2" x1="230" y1="148" x2="78" y2="148"></line>
<text class="sl" x="154" y="142" text-anchor="middle">render optimistic message</text>
<line class="a1" x1="414" y1="182" x2="734" y2="182"></line>
<text class="sl" x="574" y="176" text-anchor="middle">POST message (idempotent)</text>
<line class="a2" x1="734" y1="216" x2="414" y2="216"></line>
<text class="sl" x="574" y="210" text-anchor="middle">202 + messageId</text>
<line class="a1" x1="414" y1="250" x2="566" y2="250"></line>
<text class="sl" x="490" y="244" text-anchor="middle">open SSE stream</text>
<line class="a2" x1="734" y1="284" x2="582" y2="284"></line>
<text class="sl" x="658" y="278" text-anchor="middle">deltas</text>
<line class="a1" x1="566" y1="318" x2="246" y2="318"></line>
<text class="sl" x="406" y="312" text-anchor="middle">batched tokens every 16 ms</text>
<line class="a2" x1="230" y1="352" x2="78" y2="352"></line>
<text class="sl" x="154" y="346" text-anchor="middle">append to assistant bubble</text>
<line class="a1" x1="246" y1="386" x2="902" y2="386"></line>
<text class="sl" x="574" y="380" text-anchor="middle">checkpoint content periodically</text>
<rect class="nt" x="464" y="407" width="220" height="22"></rect><text class="sl" x="574" y="422" text-anchor="middle">network drop → reconnect with Last-Event-ID</text>
<line class="a2" x1="734" y1="454" x2="582" y2="454"></line>
<text class="sl" x="658" y="448" text-anchor="middle">missed deltas replayed</text>
<line class="a2" x1="734" y1="488" x2="582" y2="488"></line>
<text class="sl" x="658" y="482" text-anchor="middle">done</text>
<line class="a1" x1="246" y1="522" x2="902" y2="522"></line>
<text class="sl" x="574" y="516" text-anchor="middle">mark done; outbox remove</text>
<line class="a1" x1="78" y1="556" x2="230" y2="556"></line>
<text class="sl" x="154" y="550" text-anchor="middle">stop clicked</text>
<line class="a1" x1="246" y1="590" x2="734" y2="590"></line>
<text class="sl" x="490" y="584" text-anchor="middle">POST stop</text>
<line class="a3" x1="414" y1="624" x2="734" y2="624"></line>
<text class="sl" x="574" y="618" text-anchor="middle">offline: retry on reconnect; sync pull</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>UI → State store:</b> send(text) → clientMessageId</li>
  <li><b>State store → SQLite:</b> insert user msg pending; add to outbox</li>
  <li><b>State store → UI:</b> render optimistic message (response)</li>
  <li><b>Outbox → Backend:</b> POST message (idempotent)</li>
  <li><b>Backend → Outbox:</b> 202 + messageId (response)</li>
  <li><b>Outbox → Streaming client:</b> open SSE stream</li>
  <li><b>Backend → Streaming client:</b> deltas (response)</li>
  <li><b>Streaming client → State store:</b> batched tokens every 16 ms</li>
  <li><b>State store → UI:</b> append to assistant bubble (response)</li>
  <li><b>State store → SQLite:</b> checkpoint content periodically</li>
  <li><b>Streaming client:</b> network drop → reconnect with Last-Event-ID</li>
  <li><b>Backend → Streaming client:</b> missed deltas replayed (response)</li>
  <li><b>Backend → Streaming client:</b> done (response)</li>
  <li><b>State store → SQLite:</b> mark done; outbox remove</li>
  <li><b>UI → State store:</b> stop clicked</li>
  <li><b>State store → Backend:</b> POST stop</li>
  <li><b>Outbox → Backend:</b> offline: retry on reconnect; sync pull (async)</li>
</ol>

## Deep dives {#desktop-chat-frontend-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/desktop-chat-frontend/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
<div><h4>State and streaming</h4><ul><li>One immutable store (Redux/Zustand‑style); every network event becomes an action; UI is a pure function of state, which makes replay/debugging trivial.</li><li>Token batching: coalesce SSE deltas into one UI update per animation frame; unthrottled updates freeze the renderer at 50+ tokens/s.</li><li>Virtualized list; long conversations paged from SQLite, not held in memory.</li></ul></div>
<div><h4>Reliability</h4><ul><li>Idempotent sends via clientMessageId so a retry after a lost 202 doesn't duplicate.</li><li>Stream resume with Last‑Event‑ID from the server buffer; if the buffer is gone, refetch the final message rather than regenerate.</li><li>Outbox pattern for offline: sends persist locally, drain in order on reconnect, surface failures inline.</li><li>Sync: pull changes since cursor per conversation; server is truth; local unsent drafts survive.</li></ul></div>
<div><h4>Security and platform</h4><ul><li>Refresh token in keychain (Keychain/DPAPI/Secret Service); access token in memory; SQLite encrypted (SQLCipher) with a key from the keychain.</li><li>Renderer sandboxed; no Node APIs exposed to UI; IPC allowlist; CSP; external links opened by the OS.</li><li>Auto‑update: signed, staged by percentage, health check on launch, one‑click rollback; crash reporting without message content.</li><li>Accessibility, IME input, high‑DPI, and OS notifications are the platform "gotchas" to mention.</li></ul></div></div>

## Don't leave the room without saying {#desktop-chat-frontend-check}

<ul class="checklist">
  <li>Store is the single truth; UI never blocks on I/O</li>
  <li>Optimistic send with clientMessageId; outbox for offline</li>
  <li>SSE with resume; batch tokens per frame</li>
  <li>SQLite for history and outbox; keychain for secrets; encrypted at rest</li>
  <li>Sync cursor per conversation; server wins</li>
  <li>Sandboxed renderer, IPC allowlist, signed auto‑update with rollback</li>
</ul>

## What each level is expected to drive {#desktop-chat-frontend-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Views, API calls, streaming to UI, local cache</td><td>Resume, outbox, idempotency</td></tr>
  <tr><td>Senior</td><td>Store architecture, streaming backpressure, offline outbox and sync, secure storage, update pipeline</td><td>Multi‑window, memory bounds</td></tr>
  <tr><td>Staff+</td><td>Contract design with the backend (resume buffer, idempotency), failure matrix for every network state, platform security model, telemetry without content leakage</td><td>—</td></tr>
</tbody></table>
