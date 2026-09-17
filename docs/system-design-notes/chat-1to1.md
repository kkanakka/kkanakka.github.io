---
title: "1‑to‑1 chat system"
slug: /system-design-notes/chat-1to1
sidebar_position: 22
sidebar_label: "1‑to‑1 chat system"
description: "medium · Anthropic · WebSockets · pub/sub routing · per‑conversation sequence · inbox + in‑flight delivery"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/chat-1to1/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

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


## Scale, performance and safety targets {#ch-targets}

<p>Chat is deceptive: the message rate is modest, but ten million <em>simultaneously open connections</em> is what actually shapes the design.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> 1B messages/day ≈ 11.5K/s average, ~35K/s at peak — unremarkable. The real number is 10M concurrent WebSockets, which is a connection‑management problem, not a throughput one.</li>
    <li><b>Data volume:</b> ~200 bytes per message → ~200 GB/day, ~73 TB/year, growing forever because chat history is never deleted. Read receipts and delivery status add roughly one small row per message per device.</li>
    <li><b>Growth:</b> ~2× annually in users and connections. Message storage grows monotonically, so partitioning by conversation and tiering cold history are decisions to make now rather than later.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> end‑to‑end delivery p50 &lt; 150 ms, p95 &lt; 500 ms when both parties are online; send acknowledgement to the sender p99 &lt; 200 ms; history page load p95 &lt; 300 ms; reconnect and backlog replay under 2 s.</li>
    <li><b>Throughput:</b> a single WebSocket server holds ~100K connections, so 10M concurrent needs ~100 servers — and connection memory, not CPU, is the sizing constraint.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> chat is a direct channel between strangers, so spam, harassment, phishing links and scraping of user existence through presence are the real threats. A malicious client can also try to forge sequence numbers or send on someone else's behalf.</li>
    <li><b>Rate limiting:</b> messages per minute per sender and per conversation, new‑conversation creation limits (the anti‑spam lever that matters most), connection attempts per IP, and a payload size cap.</li>
    <li><b>Data sensitivity:</b> message content is private correspondence. Encrypt in transit and at rest, scope every read by participant, never log content, support deletion for both participants, and treat presence as opt‑in because "is this person online" leaks more than it appears to.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.9%+, with the stronger requirement that <b>no acknowledged message is ever lost</b> — a dropped connection is forgivable, a vanished message is not.</li>
    <li><b>Degraded mode:</b> recipient offline → the message waits in their inbox and a push notification is sent. WebSocket server dies mid‑delivery → the in‑flight entry is reclaimed and redelivered, which is why at‑least‑once plus dedupe is the chosen contract. Redis pub/sub unavailable → messages are still persisted, and clients catch up by pulling on reconnect.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> strong ordering <em>within</em> a conversation via a per‑conversation sequence number — consistency beats speed here, because messages arriving out of order is the most visible possible bug. Across conversations, no ordering is promised and none is needed.</li>
    <li><b>Durability:</b> a message is durable in Postgres before the sender is told it was sent; the Redis inbox is a delivery accelerator, never the system of record.</li>
    <li><b>Compliance:</b> export and deletion covering both participants' copies, retention stated per account, and an audit path for abuse reports that does not require indexing everyone's messages.</li></ul></div>
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

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/chat-1to1/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

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
  <li><b>WS server 2 → Redis:</b> setup: SUBSCRIBE user:B when B connects.
    Routing is established at connect time: whichever server holds B's socket subscribes to B's channel, so senders never need to know where B is connected.
    This is what keeps the fan‑out problem tractable — no service discovery, no connection registry to keep consistent, just a subscription that dies with the connection.</li>
  <li><b>User A → WS server 1:</b> send_message (client_message_id).
    The client generates the idempotency key, because only the client knows that a retry is the <em>same</em> message rather than a new one.
    Without it, a send that times out after the server persisted it produces a duplicate on retry — the most common bug in chat systems.</li>
  <li><b>WS server 1 → Message Service:</b> forward.
    WebSocket servers stay deliberately dumb: they own sockets and nothing else, so they can be restarted and scaled without touching messaging logic.
    All the stateful decisions happen in a service that any connection server can call.</li>
  <li><b>Message Service → Postgres:</b> dedupe by (conv, sender, cmid).
    A unique constraint on the triple makes retries idempotent at the database level rather than by convention.
    Checking here — before a sequence number is assigned — means a duplicate cannot consume a sequence slot and leave a permanent gap.</li>
  <li><b>Message Service → Redis:</b> INCR seq:conv.
    Ordering comes from a per‑conversation counter, not from timestamps: clocks skew between servers, and two messages a millisecond apart would otherwise sort arbitrarily.
    Per‑conversation rather than global means contention is essentially zero — one counter per two people — while still giving total order exactly where users can perceive it.
    This single decision is what makes "ordered within a conversation" achievable without any distributed coordination.</li>
  <li><b>Redis → Message Service:</b> seq (response).
    The sequence number is also the pagination cursor and the read‑receipt high‑water mark, so one construct serves ordering, history and receipts.</li>
  <li><b>Message Service → Postgres:</b> INSERT message (sync).
    Persistence is synchronous and happens before anything is acknowledged or delivered — the durability boundary is here, and everything after it is an optimisation.
    Messages are partitioned by conversation and sorted by sequence, so loading history is one contiguous read.</li>
  <li><b>Message Service → Redis:</b> LPUSH inbox:B_device.
    Every device gets its own inbox, which is what makes multi‑device work: the same message is delivered and acknowledged independently per device.
    The inbox also handles the offline case with no special path — an offline device simply has a queue that nobody is draining yet.</li>
  <li><b>Message Service → Redis:</b> PUBLISH user:B.
    The publish is only a nudge saying "you have mail", not the message itself — so a missed notification costs latency rather than data.
    Pub/sub is fire‑and‑forget, which is acceptable precisely because the durable inbox is the real delivery mechanism.</li>
  <li><b>Message Service → User A:</b> sent (msg_id, seq) (response).
    "Sent" means durably stored, not delivered — being precise about which of sent, delivered and read a tick represents is most of the product here.
    The sequence number returned lets A's own UI order its view without waiting for anything else.</li>
  <li><b>Redis → WS server 2:</b> notify subscriber (async).
    Only the server holding B's connection is subscribed, so exactly one machine reacts — no broadcast, no fan‑out to a hundred servers.</li>
  <li><b>WS server 2 → Redis:</b> BRPOPLPUSH inbox → inflight.
    The message moves atomically from the inbox to an in‑flight list rather than being popped and held in memory.
    If this server dies mid‑delivery, the message is sitting in a durable in‑flight list and a reaper returns it — losing the socket costs a redelivery, never the message.
    This is the mechanism behind the at‑least‑once guarantee, and the reason the client's dedupe key matters on the receive side too.</li>
  <li><b>Redis → WS server 2:</b> message (response).
    The blocking pop means an idle server consumes nothing and reacts the instant work exists, without a polling interval to tune.</li>
  <li><b>WS server 2 → User B:</b> new_message.
    B receives the message with its sequence number, so the client can detect a gap and request whatever it missed rather than silently displaying an incomplete conversation.</li>
  <li><b>User B → WS server 2:</b> ACK.
    Delivery is confirmed by the recipient, not assumed by the sender — a socket write succeeding says nothing about whether the app received or rendered it.</li>
  <li><b>WS server 2 → Redis:</b> LREM inflight; status delivered.
    Only an acknowledged message leaves the in‑flight list; anything still there after a timeout is redelivered.
    At‑least‑once plus the client's dedupe key is a deliberate choice over exactly‑once, which would need distributed transactions for a guarantee users cannot perceive.</li>
  <li><b>WS server 2 → Redis:</b> PUBLISH user:A delivered.
    Status flows back through the same routing mechanism as messages, so there is one delivery path to build, test and reason about rather than two.</li>
  <li><b>Redis → WS server 1:</b> notify (async).
    A missed status notification is cosmetic: A's tick updates on next sync, whereas a missed message would be a correctness failure — which is why they share a mechanism but not a guarantee.</li>
  <li><b>WS server 1 → User A:</b> delivered (response).
    The second tick appears, and its meaning is precise: B's device has it, which is different from B having read it.</li>
  <li><b>User B → WS server 2:</b> read_receipt (debounced).
    Receipts are debounced because scrolling through a conversation would otherwise emit one event per message — turning a read into a burst of writes.
    Sending only the highest sequence read collapses an unbounded stream of events into one small update.</li>
  <li><b>WS server 2 → Postgres:</b> hwm update if higher.
    Read state is one high‑water mark per user per conversation, not a row per message — which is the difference between a few hundred million rows and tens of billions.
    Updating only when the value increases makes the operation idempotent and safe to retry, and makes out‑of‑order receipts harmless.
    Unread counts then become arithmetic on two sequence numbers rather than a count over messages.</li>
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

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/chat-1to1/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

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


## Trade-offs {#ch-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Ordering</td><td>Per‑conversation sequence from Redis</td><td>A dependency on the counter for every send</td><td>Timestamps are free but skew between servers, so two near‑simultaneous messages sort arbitrarily — visible and unacceptable in chat</td></tr>
  <tr><td>Delivery guarantee</td><td>At‑least‑once plus client dedupe key</td><td>Occasional duplicate delivery the client must suppress</td><td>Exactly‑once needs distributed transactions for a property users cannot perceive; at‑most‑once loses messages, which they certainly can</td></tr>
  <tr><td>Transport</td><td>WebSockets</td><td>10M open connections to hold, and sticky routing to manage</td><td>Long polling survives hostile networks better and costs far more; SSE is one‑way and chat needs both directions</td></tr>
  <tr><td>Routing</td><td>Redis pub/sub keyed by user</td><td>Fire‑and‑forget delivery, so notifications can be missed</td><td>Acceptable only because the durable inbox is the real mechanism; a registry of user→server is exact but must be kept consistent as connections churn</td></tr>
  <tr><td>Queueing</td><td>Per‑device inbox plus in‑flight list</td><td>More Redis structures, and a reaper to run</td><td>A single per‑user queue is simpler but breaks multi‑device, where each device must acknowledge independently</td></tr>
  <tr><td>Read receipts</td><td>Debounced high‑water mark</td><td>No per‑message read state</td><td>Per‑message receipts are needed for group read‑by lists; for 1:1 they multiply storage by an order of magnitude for no product gain</td></tr>
  <tr><td>Conversation identity</td><td>Canonical <code>min(a,b)</code> with a unique constraint</td><td>Nothing meaningful</td><td>Never allow two rows for one pair — concurrent first messages will create duplicates and split the history</td></tr>
</tbody></table>

## Safety-first design {#ch-safety}

<div class="cards">
  <div><h4>An acknowledged message is never lost</h4><ul>
    <li><b>Durable before acknowledged.</b> The sender's "sent" confirmation follows the database write, so a crash immediately after can never lose a message the user believes was delivered.</li>
    <li><b>In‑flight lists survive a dead server.</b> Moving atomically from inbox to in‑flight means losing a socket costs a redelivery, not a message.</li>
    <li><b>Redis is an accelerator, not the record.</b> Losing the cache entirely degrades latency and status; history and content live in Postgres.</li>
    <li><b>Gaps are detectable.</b> Sequence numbers let a client notice it missed something and pull it, instead of silently showing an incomplete conversation.</li></ul></div>
  <div><h4>Protecting people from each other</h4><ul>
    <li><b>Limit new conversations, not just messages.</b> The spam lever that matters is how many strangers one account can open a conversation with per hour.</li>
    <li><b>Presence is opt‑in.</b> "Online now" reveals daily routine; treating it as a privacy setting rather than a default is the safer starting point.</li>
    <li><b>Authorise on the conversation, every time.</b> Membership is checked on every read and send, so a guessed conversation id yields nothing.</li>
    <li><b>Server assigns identity and order.</b> Sender id comes from the authenticated session and sequence numbers from the server — a client can never forge either.</li></ul></div>
  <div><h4>Private correspondence stays private</h4><ul>
    <li><b>Never log content.</b> Operational logs carry ids, sizes and timings; a debugging pipeline must not become a searchable archive of people's messages.</li>
    <li><b>Deletion covers both sides.</b> A message exists in two participants' views and in per‑device inboxes — a delete that misses any of those is not a delete.</li>
    <li><b>Encrypted in transit and at rest.</b> Table stakes, and worth stating because the store is partitioned and replicated in several places.</li>
    <li><b>Abuse reports without mass indexing.</b> Reported conversations are retrievable by participants and report id, rather than by maintaining a searchable index over everyone's messages.</li></ul></div>
</div>

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
