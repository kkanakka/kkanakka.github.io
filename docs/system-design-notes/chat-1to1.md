---
title: "1‑to‑1 chat system"
slug: /system-design-notes/chat-1to1
sidebar_position: 22
sidebar_label: "1‑to‑1 chat system"
description: "medium · Anthropic · WebSockets · pub/sub routing · per‑conversation sequence · inbox + in‑flight delivery"
---
<header>
  
  <span class="tag">medium · Anthropic · WebSockets · pub/sub routing · per‑conversation sequence · inbox + in‑flight delivery</span>
</header>
<p>Two users exchange text in near real time; history is durable; offline users get their messages later; senders see delivered/read. No groups. Interviewers here dig into the "how": connection management, ordering under clock skew, exactly what happens when a server dies mid‑delivery.</p>

## Requirements {#ch-requirements}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Send a text message to another user</li>
      <li>Receive in near real time when online</li>
      <li>Scroll conversation history</li>
      <li>Read receipts (and delivered)</li>
      <li>Offline delivery on reconnect; multi‑device</li>
      <li class="out">Groups, channels, media, presence (nice‑to‑have)</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>100M DAU, 1B msgs/day ≈ 11.5K/s avg, ~35K/s peak</li>
      <li>Delivery &lt; 500 ms when online</li>
      <li>Ordered within a conversation (consistency &gt; speed here)</li>
      <li>No message loss: at‑least‑once + dedupe</li>
      <li>99.9%+; 10M concurrent WebSockets at peak</li>
      <li>Storage 200 B × 1B/day ≈ 200 GB/day, ~73 TB/yr</li>
    </ol>
  </div>
</div>

## Entities and API {#ch-entities}

<p>User · Device (deviceId, userId, type, pushToken) · Conversation (participant_1 &lt; participant_2, unique) · Message (conversationId, senderId, clientMessageId, content, sequenceNumber) · MessageStatus (messageId, deviceId, sent|delivered) · ReadReceipt (userId, conversationId, lastReadSequence).</p>
<pre><code>WebSocket, client → server
  {action:"send_message", conversation_id, content, client_message_id}   // idempotency key
  {action:"read_receipt", conversation_id, last_read_sequence}
  {action:"ping"}
WebSocket, server → client
  {event:"new_message", message_id, conversation_id, sender_id, content, sequence_number, ts}
  {event:"delivered", message_id, conversation_id}      {event:"read", conversation_id, reader_id, last_read_sequence}
REST
  GET  /conversations?cursor=&amp;limit=20                          (inbox)
  GET  /conversations/:id/messages?before_sequence=&amp;limit=50    (history)
  POST /conversations {recipient_user_id}                       (get‑or‑create, canonical order)
  GET  /users/presence?user_ids=</code></pre>
<div class="note"><b>Canonical conversation:</b> always store <code>min(userA,userB)</code> as participant_1 with <code>UNIQUE(participant_1, participant_2)</code>. "The conversation between A and B" is one lookup regardless of who started it, and the constraint prevents duplicates from concurrent first messages.</div>

## Design {#ch-diagram}

<figure>
<svg viewBox="0 0 980 420" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="1-to-1 chat: clients hold WebSockets to WS servers behind an L4 load balancer; Message Service assigns per-conversation sequence via Redis INCR, inserts into sharded Postgres, pushes to per-device inbox lists, publishes on user channel; the recipient's WS server subscribed to that channel moves the message to an in-flight list, delivers, and deletes on ACK">
  <defs>
    <marker id="h1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker>
    <marker id="h2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker>
  </defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:11px;fill:#5B6673}.tm{font-size:10.5px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#h1)}.fp{stroke:#6B2D6B;stroke-width:1.6;fill:none;marker-end:url(#h2);stroke-dasharray:5 4}.lbl{font-size:10.5px;fill:#1F4E9E}.lblp{font-size:10.5px;fill:#6B2D6B}</style>
  <rect class="box" x="20" y="80" width="90" height="50"></rect><text class="tb" x="65" y="101" text-anchor="middle">User A</text><text class="ts" x="65" y="118" text-anchor="middle">phone</text>
  <rect class="box" x="20" y="290" width="90" height="50"></rect><text class="tb" x="65" y="311" text-anchor="middle">User B</text><text class="ts" x="65" y="328" text-anchor="middle">phone + laptop</text>
  <rect class="box" x="150" y="180" width="90" height="60"></rect><text class="tb" x="195" y="203" text-anchor="middle">L4 LB</text><text class="ts" x="195" y="220" text-anchor="middle">TCP pass‑through</text><text class="ts" x="195" y="232" text-anchor="middle">least‑connections</text>
  <rect class="box" x="290" y="60" width="150" height="80"></rect><text class="tb" x="365" y="82" text-anchor="middle">WS server 1</text><text class="ts" x="365" y="100" text-anchor="middle">holds A's socket</text><text class="ts" x="365" y="114" text-anchor="middle">SUBSCRIBE user:A</text><text class="ts" x="365" y="128" text-anchor="middle">~100K conns / box</text>
  <rect class="box" x="290" y="280" width="150" height="80"></rect><text class="tb" x="365" y="302" text-anchor="middle">WS server 2</text><text class="ts" x="365" y="320" text-anchor="middle">holds B's sockets</text><text class="ts" x="365" y="334" text-anchor="middle">SUBSCRIBE user:B</text><text class="ts" x="365" y="348" text-anchor="middle">stateless apart from sockets</text>
  <rect class="box" x="500" y="150" width="160" height="100"></rect><text class="tb" x="580" y="172" text-anchor="middle">Message Service</text><text class="ts" x="510" y="190">dedupe by client_message_id</text><text class="ts" x="510" y="204">seq = INCR seq:conv</text><text class="ts" x="510" y="218">INSERT (sync, durable)</text><text class="ts" x="510" y="232">fan‑out to B's device inboxes</text><text class="ts" x="510" y="246">PUBLISH user:B</text>
  <rect class="box" x="720" y="40" width="240" height="120" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="840" y="60" text-anchor="middle">Redis Cluster</text>
  <text class="tm" x="730" y="80">seq:{conv}            INCR</text><text class="tm" x="730" y="94">inbox:{device}        LIST</text><text class="tm" x="730" y="108">inflight:{device}     LIST</text><text class="tm" x="730" y="122">user:{id}             PUB/SUB</text><text class="tm" x="730" y="136">presence:{id}         TTL 60s</text><text class="tm" x="730" y="150">idem:{sender}:{cmid}  TTL</text>
  <rect class="box" x="720" y="200" width="240" height="120"></rect><text class="tb" x="840" y="220" text-anchor="middle">Postgres, sharded by conversation_id</text>
  <text class="tm" x="730" y="240">messages UNIQUE(conv, seq)</text><text class="tm" x="730" y="254">         UNIQUE(conv, sender, cmid)</text><text class="tm" x="730" y="268">  idx (conv, seq DESC)</text><text class="tm" x="730" y="282">message_status (msg, device)</text><text class="tm" x="730" y="296">read_receipts (user, conv, hwm)</text><text class="tm" x="730" y="310">user_conversations index table</text>
  <path class="f" d="M110 105 L148 190"></path><path class="f" d="M240 200 L288 110"></path><text class="lbl" x="200" y="150">WS upgrade</text>
  <path class="fp" d="M288 320 L242 230"></path><path class="fp" d="M148 230 L112 310"></path>
  <path class="f" d="M440 110 L498 170"></path><text class="lbl" x="440" y="130">1 send</text>
  <path class="f" d="M660 190 L718 120"></path><text class="lbl" x="668" y="145">2 INCR · 4 LPUSH · 5 PUBLISH</text>
  <path class="f" d="M660 215 L718 240"></path><text class="lbl" x="668" y="240">3 INSERT</text>
  <path class="fp" d="M720 150 C 600 150, 500 260, 440 300"></path><text class="lblp" x="470" y="275">6 notify (sub)</text>
  <path class="fp" d="M365 280 C 365 250, 600 60, 720 100" stroke-dasharray="2 4"></path><text class="lblp" x="380" y="262">7 BRPOPLPUSH inbox→inflight</text>
  <text class="lblp" x="120" y="380">8 deliver · 9 ACK → LREM inflight, status=delivered → PUBLISH user:A</text>
  <text class="ts" x="500" y="400">Pub/sub only wakes the right server; the inbox list is the durable hand‑off. Losing a pub/sub message costs latency, not the message.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 814" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="1-to-1 chat message flow between components">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="7" y="14" width="126" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">User A</text>
<line class="ln" x1="70" y1="48" x2="70" y2="794"></line>
<rect class="sb" x="147" y="14" width="126" height="34"></rect><text class="st" x="210" y="36" text-anchor="middle">WS server 1</text>
<line class="ln" x1="210" y1="48" x2="210" y2="794"></line>
<rect class="sb" x="287" y="14" width="126" height="34"></rect><text class="st" x="350" y="36" text-anchor="middle">Message Service</text>
<line class="ln" x1="350" y1="48" x2="350" y2="794"></line>
<rect class="sb" x="427" y="14" width="126" height="34"></rect><text class="st" x="490" y="36" text-anchor="middle">Redis</text>
<line class="ln" x1="490" y1="48" x2="490" y2="794"></line>
<rect class="sb" x="567" y="14" width="126" height="34"></rect><text class="st" x="630" y="36" text-anchor="middle">Postgres</text>
<line class="ln" x1="630" y1="48" x2="630" y2="794"></line>
<rect class="sb" x="707" y="14" width="126" height="34"></rect><text class="st" x="770" y="36" text-anchor="middle">WS server 2</text>
<line class="ln" x1="770" y1="48" x2="770" y2="794"></line>
<rect class="sb" x="847" y="14" width="126" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">User B</text>
<line class="ln" x1="910" y1="48" x2="910" y2="794"></line>
<line class="a1" x1="762" y1="80" x2="498" y2="80"></line>
<text class="sl" x="630" y="74" text-anchor="middle">setup: SUBSCRIBE user:B when B connects</text>
<line class="a1" x1="78" y1="114" x2="202" y2="114"></line>
<text class="sl" x="140" y="108" text-anchor="middle">send_message (client_message_id)</text>
<line class="a1" x1="218" y1="148" x2="342" y2="148"></line>
<text class="sl" x="280" y="142" text-anchor="middle">forward</text>
<line class="a1" x1="358" y1="182" x2="622" y2="182"></line>
<text class="sl" x="490" y="176" text-anchor="middle">dedupe by (conv, sender, cmid)</text>
<line class="a1" x1="358" y1="216" x2="482" y2="216"></line>
<text class="sl" x="420" y="210" text-anchor="middle">INCR seq:conv</text>
<line class="a2" x1="482" y1="250" x2="358" y2="250"></line>
<text class="sl" x="420" y="244" text-anchor="middle">seq</text>
<line class="a1" x1="358" y1="284" x2="622" y2="284"></line>
<text class="sl" x="490" y="278" text-anchor="middle">INSERT message (sync)</text>
<line class="a1" x1="358" y1="318" x2="482" y2="318"></line>
<text class="sl" x="420" y="312" text-anchor="middle">LPUSH inbox:B_device</text>
<line class="a1" x1="358" y1="352" x2="482" y2="352"></line>
<text class="sl" x="420" y="346" text-anchor="middle">PUBLISH user:B</text>
<line class="a2" x1="342" y1="386" x2="78" y2="386"></line>
<text class="sl" x="210" y="380" text-anchor="middle">sent (msg_id, seq)</text>
<line class="a3" x1="498" y1="420" x2="762" y2="420"></line>
<text class="sl" x="630" y="414" text-anchor="middle">notify subscriber</text>
<line class="a1" x1="762" y1="454" x2="498" y2="454"></line>
<text class="sl" x="630" y="448" text-anchor="middle">BRPOPLPUSH inbox → inflight</text>
<line class="a2" x1="498" y1="488" x2="762" y2="488"></line>
<text class="sl" x="630" y="482" text-anchor="middle">message</text>
<line class="a1" x1="778" y1="522" x2="902" y2="522"></line>
<text class="sl" x="840" y="516" text-anchor="middle">new_message</text>
<line class="a1" x1="902" y1="556" x2="778" y2="556"></line>
<text class="sl" x="840" y="550" text-anchor="middle">ACK</text>
<line class="a1" x1="762" y1="590" x2="498" y2="590"></line>
<text class="sl" x="630" y="584" text-anchor="middle">LREM inflight; status delivered</text>
<line class="a1" x1="762" y1="624" x2="498" y2="624"></line>
<text class="sl" x="630" y="618" text-anchor="middle">PUBLISH user:A delivered</text>
<line class="a3" x1="482" y1="658" x2="218" y2="658"></line>
<text class="sl" x="350" y="652" text-anchor="middle">notify</text>
<line class="a2" x1="202" y1="692" x2="78" y2="692"></line>
<text class="sl" x="140" y="686" text-anchor="middle">delivered</text>
<line class="a1" x1="902" y1="726" x2="778" y2="726"></line>
<text class="sl" x="840" y="720" text-anchor="middle">read_receipt (debounced)</text>
<line class="a1" x1="762" y1="760" x2="638" y2="760"></line>
<text class="sl" x="700" y="754" text-anchor="middle">hwm update if higher</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>WS server 2 → Redis:</b> setup: SUBSCRIBE user:B when B connects</li>
  <li><b>User A → WS server 1:</b> send_message (client_message_id)</li>
  <li><b>WS server 1 → Message Service:</b> forward</li>
  <li><b>Message Service → Postgres:</b> dedupe by (conv, sender, cmid)</li>
  <li><b>Message Service → Redis:</b> INCR seq:conv</li>
  <li><b>Redis → Message Service:</b> seq (response)</li>
  <li><b>Message Service → Postgres:</b> INSERT message (sync)</li>
  <li><b>Message Service → Redis:</b> LPUSH inbox:B_device</li>
  <li><b>Message Service → Redis:</b> PUBLISH user:B</li>
  <li><b>Message Service → User A:</b> sent (msg_id, seq) (response)</li>
  <li><b>Redis → WS server 2:</b> notify subscriber (async)</li>
  <li><b>WS server 2 → Redis:</b> BRPOPLPUSH inbox → inflight</li>
  <li><b>Redis → WS server 2:</b> message (response)</li>
  <li><b>WS server 2 → User B:</b> new_message</li>
  <li><b>User B → WS server 2:</b> ACK</li>
  <li><b>WS server 2 → Redis:</b> LREM inflight; status delivered</li>
  <li><b>WS server 2 → Redis:</b> PUBLISH user:A delivered</li>
  <li><b>Redis → WS server 1:</b> notify (async)</li>
  <li><b>WS server 1 → User A:</b> delivered (response)</li>
  <li><b>User B → WS server 2:</b> read_receipt (debounced)</li>
  <li><b>WS server 2 → Postgres:</b> hwm update if higher</li>
</ol>

## Sending one message, step by step {#ch-flow}

<ol class="order">
  <li>A's client sends <code>send_message</code> with a <code>client_message_id</code> over its WebSocket to WS1; WS1 forwards to the Message Service.</li>
  <li>Service checks idempotency: <code>UNIQUE(conversation, sender, client_message_id)</code>; on conflict return the existing message_id + sequence, no duplicate.</li>
  <li><code>seq = INCR seq:{conversation}</code> in Redis (~0.1 ms), then synchronous <code>INSERT</code> into the conversation's Postgres shard. Only after commit does A get "sent."</li>
  <li>Fan‑out to B's devices: <code>LPUSH inbox:{device}</code> for each of B's 1–5 devices. This list is the durable hand‑off.</li>
  <li><code>PUBLISH user:B "new_message"</code>. Every WS server holding a B socket is subscribed; offline B means nobody is subscribed and the inbox simply waits.</li>
  <li>WS2 wakes, runs <code>BRPOPLPUSH inbox:{device} inflight:{device}</code> (atomic move), pushes the event down the socket.</li>
  <li>B's client persists locally and ACKs; WS2 <code>LREM inflight</code>, writes <code>message_status = delivered</code>, publishes a delivered receipt to <code>user:A</code>.</li>
  <li>B opens the chat: client debounces and sends <code>read_receipt(last_read_sequence)</code>; server updates the high‑water mark only if higher; publishes read to A.</li>
</ol>

## Deep dives {#ch-deepdives}

### 1. Why WebSockets, and what that costs

<ul>
  <li>Both sides push: client sends, server pushes incoming. SSE is one‑way; polling at 35K/s × 10M users is absurd. WebSocket over one persistent TCP connection.</li>
  <li>L4 load balancer (connections are long‑lived TCP; L7 would terminate them). Least‑connections so a new server doesn't stay idle and an old one doesn't hoard.</li>
  <li>Per box ~100K connections with epoll/async I/O and small per‑connection buffers → ~100 servers for 10M. Heartbeat ping every 30 s to detect dead sockets through NATs and LBs.</li>
  <li>Servers are stateless beyond the socket map: crash → clients reconnect elsewhere via the LB, resubscribe, drain inbox/in‑flight. Nothing is lost because nothing important lived on the server.</li>
</ul>

### 2. Routing: which server has B?

<table>
  <tbody><tr><th>Option</th><th>How</th><th>Verdict</th></tr>
  <tr><td>Connection registry</td><td>Redis map user → server; sender's server looks up and forwards</td><td>Works, but stale entries on crash, an extra lookup per message, and a second hop to design.</td></tr>
  <tr><td><b>Pub/sub (pick)</b></td><td>WS server SUBSCRIBEs <code>user:{id}</code> when a socket for that user attaches; sender PUBLISHes</td><td>No registry to keep correct; a crashed server's subscriptions die with it and the client's reconnect re‑subscribes. Redis Cluster shards channels.</td></tr>
</tbody></table>
<p>Pub/sub is at‑most‑once, which is fine because it only carries "go check your inbox"; the inbox list carries the message.</p>

### 3. Ordering under clock skew

<ul>
  <li>Timestamps from clients or even servers can't order two messages from two senders; clocks skew by ms to seconds. Use a server‑assigned <b>per‑conversation sequence number</b>.</li>
  <li><b>Redis INCR</b> (fast, off the DB) vs <b>Postgres advisory lock + MAX+1</b> (simpler, strictly gap‑free, lower throughput). Pick INCR; accept gaps when an insert fails after increment. <code>UNIQUE(conversation, sequence)</code> guarantees no two messages share a slot.</li>
  <li>Client orders by sequence, detects gaps (5 then 7) and asks for the missing range via the history API; optimistic UI shows the sent message immediately and reorders on confirmation.</li>
  <li>Consistency wins over availability inside a conversation: a slightly delayed message beats a reordered one.</li>
</ul>

### 4. Offline delivery and no message loss

<ul>
  <li>Durable write first (sync INSERT) → inbox list → in‑flight on delivery → delete on ACK. Every hop is idempotent; a crash between hops replays, never drops.</li>
  <li>Reconnect protocol: client sends last known sequence per conversation; server drains inbox in order, backfills any gap from Postgres, client ACKs after local persist, server clears in‑flight. A reaper moves stale in‑flight entries (no ACK in N s) back to inbox.</li>
  <li>Redis Streams with consumer groups + XACK is the same pattern with built‑in pending‑entry tracking; say either.</li>
  <li>Push notification (APNs/FCM) via the device's push_token when no socket is live, so the phone wakes up and connects.</li>
</ul>

### 5. Delivered vs read, at scale

<ul>
  <li><b>Delivered</b> is per device and precise: a row per (message, device) written on ACK.</li>
  <li><b>Read</b> is a high‑water mark per (user, conversation): one row, updated only when the new sequence is higher. Everything ≤ mark is read; no per‑message rows.</li>
  <li>Client debounces read receipts (~2 s) so scrolling doesn't produce hundreds of writes.</li>
</ul>

### 6. Multi‑device

<ul>
  <li>Device table with push tokens; inbox and in‑flight lists per device; each device ACKs independently. Fan‑out is 1–5, trivial compared to group chat.</li>
  <li>Read on one device: high‑water mark is per user, so other devices pick it up on next sync or via the same pub/sub channel.</li>
  <li>Sender's other devices get an echo of the sent message through the same path so the conversation matches everywhere.</li>
</ul>

### 7. Storage and sharding

<ul>
  <li>Shard Postgres by <code>hash(conversation_id)</code>: all of a conversation's messages co‑located; history is one shard, one index range scan on (conversation, sequence DESC).</li>
  <li>"All conversations for user X" would scatter‑gather; keep a <code>user_conversations (user_id, conversation_id, last_message_at, preview)</code> index table sharded by user for the inbox list.</li>
  <li>~73 TB/year before replication; shard count sized by write rate (35K/s peak across shards) and storage; LSM store (Cassandra) is a fine alternative for append‑only messages.</li>
</ul>

### 8. Presence (if time)

<ul>
  <li><code>SETEX presence:{user} 60 online</code> on connect; heartbeat every 30 s refreshes; expiry = offline without any explicit event.</li>
  <li>Notify only users who have an active conversation with the person (a "presence subscribers" set), never the whole contact list.</li>
</ul>

## Don't leave the room without saying {#ch-checklist}

<ul class="checklist">
  <li>Capacity: 11.5K/s avg, 35K/s peak, 10M concurrent sockets, 200 GB/day</li>
  <li>WebSocket + L4 LB + heartbeats; servers stateless apart from sockets</li>
  <li>Pub/sub for routing; inbox list for durability; why losing a pub/sub message is harmless</li>
  <li>Canonical participant ordering with a unique constraint</li>
  <li>Server‑assigned per‑conversation sequence (Redis INCR vs advisory lock) and why not timestamps</li>
  <li>client_message_id idempotency with a unique constraint</li>
  <li>Sync durable write before "sent"; inbox → in‑flight → ACK → delete; reconnect drain + gap backfill</li>
  <li>Delivered per device, read as high‑water mark, debounced</li>
  <li>Shard by conversation; user_conversations index for the inbox</li>
  <li>Consistency over availability within a conversation</li>
</ul>

## What each level is expected to drive {#ch-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>WebSocket servers + DB, send/receive flow, history API, basic delivered/read</td><td>Routing across servers, ordering, offline queue</td></tr>
  <tr><td>Senior</td><td>Pub/sub routing, sequence numbers with the clock‑skew argument, inbox/in‑flight with ACKs, idempotency, sharding by conversation, read high‑water mark</td><td>Multi‑device details, presence, reaper</td></tr>
  <tr><td>Staff+</td><td>Connection management numbers, failure walk‑throughs for every hop (WS crash, Redis failover, DB failover), gap handling protocol, CAP position per component, push‑notification path, storage engine choice with reasons</td><td>—</td></tr>
</tbody></table>
