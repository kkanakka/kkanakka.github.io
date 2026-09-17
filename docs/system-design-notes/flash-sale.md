---
title: "Flash sale"
slug: /system-design-notes/flash-sale
sidebar_position: 4
sidebar_label: "Flash sale"
description: "hard · contention · scaling writes · fairness"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/flash-sale/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">hard · contention · scaling writes · fairness</span>
</header>
<p>Nike drops 10,000 pairs at noon; tens of millions try to buy in the first few seconds. The whole problem is: hand out each unit exactly once, don't fall over, and be fair about who gets a shot.</p>

## Requirements (say these out loud, in this order) {#fs-requirements}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>View the sale item</li>
      <li>Reserve a unit for a limited time</li>
      <li>Pay for the reserved unit</li>
      <li class="out">Catalog, refunds, admin tooling</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Never oversell (correctness under contention)</li>
      <li>Absorb ~10M users arriving in seconds</li>
      <li>Fair chance for everyone present at start</li>
      <li class="out">GDPR, fault tolerance, PCI</li>
    </ol>
  </div>
</div>
<div class="trap"><b>Most‑missed point:</b> the reservation step. Payment goes through a third party and takes seconds; you cannot hold a DB transaction open that long. Reserve first (take the unit off the table), settle money after. Arrive here yourself, don't wait to be led.</div>


## Scale, performance and safety targets {#fs-targets}

<p>The defining number is not the total traffic — it is how compressed in time it is. 10M users in 10 seconds is a different system from 10M users in a day.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> ~10M users arriving within the first few seconds — a burst of 1M+ QPS against a steady‑state baseline of nearly nothing. Only ~10,000 of those requests can possibly succeed, so the design is mostly about rejecting 99.9% of traffic cheaply.</li>
    <li><b>Data volume:</b> tiny. 10,000 units, 10,000 reservations, 10,000 purchases — kilobytes of data that matters, surrounded by millions of requests that must never touch it.</li>
    <li><b>Growth:</b> sale size grows with popularity, and traffic grows superlinearly with it — a drop twice as hyped draws far more than twice the load, so the waiting room must scale independently of the inventory.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> waiting‑room join p99 &lt; 200 ms (it must absorb the stampede); reservation p99 &lt; 500 ms once admitted; payment is seconds and explicitly off the critical section. Reservation TTL of ~10 minutes bounds how long a unit is held.</li>
    <li><b>Throughput:</b> the database only ever sees admitted traffic — a few hundred reservation attempts per second — because the waiting room converts a 1M QPS spike into a controlled trickle. That conversion is the entire architecture.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> flash sales attract bots more than people. The threats are scripted clients hitting the endpoint before the queue, one buyer taking hundreds of units through many accounts, scalper farms, and simple DDoS from the crowd itself.</li>
    <li><b>Rate limiting:</b> one reservation in flight per user, a per‑account unit cap, per‑IP and per‑device limits on waiting‑room joins, and signed single‑use admission tokens so the reservation endpoint cannot be called without passing through the queue.</li>
    <li><b>Data sensitivity:</b> card details never touch the service — the client talks to the payment provider directly with a client secret, which keeps the system out of PCI scope. Store the payment intent id, never a card number, and keep addresses under normal PII handling with a stated retention.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.9% overall, but the sale window itself is effectively four nines — being down for five minutes at noon is the same as not holding the sale. Correctness beats availability: refusing to sell is recoverable, overselling is not.</li>
    <li><b>Degraded mode:</b> payment provider slow or down → reservations still succeed and are held; only settlement waits, and the TTL protects the inventory. Redis waiting room lost → it is rebuildable queue state, so the sale pauses briefly rather than overselling, because ownership lives in Postgres. Database saturated → shed at the waiting room, never by accepting reservations that cannot be honoured.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> strong and transactional where a unit changes hands — <code>SELECT … FOR UPDATE SKIP LOCKED</code> plus an insert in one transaction. Everything else (queue position, units‑left display) is eventual and allowed to be approximate.</li>
    <li><b>Durability:</b> a reservation and a purchase must survive any crash; the waiting‑room queue need not, and deliberately holds nothing that cannot be reconstructed.</li>
    <li><b>Fairness:</b> worth stating as an explicit requirement — everyone present at the start gets a fair shot. Randomising the cohort at open, then serving FIFO, prevents both "fastest network wins" and "whoever retried hardest wins".</li></ul></div>
</div>

## Entities and API {#fs-entities}

<p>Product · Reservation · Purchase · User. Three endpoints, one per requirement:</p>
<pre><code>GET  /products/:productId                       -&gt; Product (price, window, unitsLeft)
POST /products/:productId/reservations          -&gt; Reservation (id, productId, expiresAt)
POST /reservations/:reservationId/purchases     -&gt; Purchase (status PENDING|COMPLETE|FAILED)
GET  /purchases/:purchaseId                     -&gt; poll until Stripe webhook lands</code></pre>

## Final design {#fs-diagram}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/flash-sale/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 520" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Flash sale architecture: client to API gateway, waiting room on sharded Redis, sale service, Postgres with ReservationUnit rows, Stripe with webhook">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path>
    </marker>
    <marker id="arrp" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path>
    </marker>
    <marker id="arrt" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0L10 5L0 10z" fill="#0F766E"></path>
    </marker>
  </defs>
  <style>
    .box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}
    .t{font-size:13px;fill:#1B2430}
    .tb{font-size:13px;fill:#1B2430;font-weight:600}
    .ts{font-size:11px;fill:#5B6673}
    .tm{font-size:11px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}
    .flow{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#arr)}
    .flowp{stroke:#6B2D6B;stroke-width:1.6;fill:none;marker-end:url(#arrp);stroke-dasharray:5 4}
    .flowt{stroke:#0F766E;stroke-width:1.6;fill:none;marker-end:url(#arrt)}
    .lbl{font-size:11px;fill:#1F4E9E}
    .lblp{font-size:11px;fill:#6B2D6B}
    .lblt{font-size:11px;fill:#0F766E}
  </style>

  <!-- Client -->
  <rect class="box" x="20" y="200" width="100" height="56"></rect>
  <text class="tb" x="70" y="224" text-anchor="middle">Client</text>
  <text class="ts" x="70" y="242" text-anchor="middle">web / mobile</text>

  <!-- API Gateway -->
  <rect class="box" x="170" y="200" width="110" height="56"></rect>
  <text class="tb" x="225" y="224" text-anchor="middle">API Gateway</text>
  <text class="ts" x="225" y="242" text-anchor="middle">auth · rate limit</text>

  <!-- Waiting Room Service -->
  <rect class="box" x="330" y="60" width="150" height="64" stroke="#0F766E"></rect>
  <text class="tb" x="405" y="86" text-anchor="middle">Waiting Room</text>
  <text class="ts" x="405" y="104" text-anchor="middle">admission control</text>

  <!-- Redis shards -->
  <g>
    <rect class="box" x="540" y="30" width="70" height="40" stroke="#0F766E" fill="#DDF3F0"></rect>
    <rect class="box" x="540" y="76" width="70" height="40" stroke="#0F766E" fill="#DDF3F0"></rect>
    <rect class="box" x="540" y="122" width="70" height="40" stroke="#0F766E" fill="#DDF3F0"></rect>
    <text class="tm" x="575" y="54" text-anchor="middle">redis 0</text>
    <text class="tm" x="575" y="100" text-anchor="middle">redis 1</text>
    <text class="tm" x="575" y="146" text-anchor="middle">redis 2</text>
    <text class="ts" x="640" y="100" text-anchor="start">queue state, sharded</text>
    <text class="ts" x="640" y="114" text-anchor="start">global order value per user</text>
  </g>
  <path class="flowt" d="M480 92 L538 50"></path>
  <path class="flowt" d="M480 92 L538 96"></path>
  <path class="flowt" d="M480 92 L538 142"></path>

  <!-- Sale Service -->
  <rect class="box" x="330" y="200" width="150" height="64"></rect>
  <text class="tb" x="405" y="226" text-anchor="middle">Sale Service</text>
  <text class="ts" x="405" y="244" text-anchor="middle">N instances, stateless</text>

  <!-- Postgres -->
  <rect class="box" x="560" y="190" width="400" height="200"></rect>
  <text class="tb" x="580" y="212">Postgres (system of record)</text>
  <g class="tm">
    <rect x="580" y="224" width="170" height="70" fill="#F6F8FA" stroke="#D6DDE5" rx="4"></rect>
    <text x="588" y="240">Product</text>
    <text x="588" y="254" class="ts">productId, price,</text>
    <text x="588" y="266" class="ts">saleStart, saleEnd,</text>
    <text x="588" y="278" class="ts">inventoryCount (display only)</text>

    <rect x="770" y="224" width="170" height="70" fill="#FBEBD5" stroke="#B45309" rx="4"></rect>
    <text x="778" y="240">ReservationUnit</text>
    <text x="778" y="254" class="ts">productId, unitId</text>
    <text x="778" y="266" class="ts">one row per pair</text>
    <text x="778" y="278" class="ts">FOR UPDATE SKIP LOCKED</text>

    <rect x="580" y="304" width="170" height="70" fill="#F6F8FA" stroke="#D6DDE5" rx="4"></rect>
    <text x="588" y="320">Reservation</text>
    <text x="588" y="334" class="ts">userId, unitId, expiresAt</text>
    <text x="588" y="346" class="ts">ACTIVE | PURCHASED |</text>
    <text x="588" y="358" class="ts">EXPIRED</text>

    <rect x="770" y="304" width="170" height="70" fill="#F6F8FA" stroke="#D6DDE5" rx="4"></rect>
    <text x="778" y="320">Purchase</text>
    <text x="778" y="334" class="ts">reservationId, userId</text>
    <text x="778" y="346" class="ts">PENDING | COMPLETE |</text>
    <text x="778" y="358" class="ts">FAILED</text>
  </g>

  <!-- Stripe -->
  <rect class="box" x="330" y="420" width="150" height="56" stroke="#6B2D6B" fill="#F1E3F1"></rect>
  <text class="tb" x="405" y="444" text-anchor="middle">Stripe</text>
  <text class="ts" x="405" y="462" text-anchor="middle">PaymentIntent</text>

  <!-- Expiry worker -->
  <rect class="box" x="620" y="420" width="180" height="56" stroke="#B45309"></rect>
  <text class="tb" x="710" y="444" text-anchor="middle">Expiry release</text>
  <text class="ts" x="710" y="462" text-anchor="middle">return unit the moment it lapses</text>

  <!-- flows -->
  <path class="flow" d="M120 228 L168 228"></path>
  <text class="lbl" x="128" y="220">1</text>

  <path class="flow" d="M280 216 L328 104"></path>
  <text class="lbl" x="285" y="150">2 join queue</text>

  <path class="flow" d="M280 228 L328 228"></path>
  <text class="lbl" x="286" y="248">3 signed token</text>

  <path class="flow" d="M480 232 L558 232"></path>
  <text class="lbl" x="484" y="222">4 claim unit + insert Reservation</text>
  <text class="lbl" x="484" y="248">(one txn)</text>

  <path class="flowp" d="M405 264 L405 418"></path>
  <text class="lblp" x="412" y="300">5 create</text>
  <text class="lblp" x="412" y="314">PaymentIntent</text>

  <path class="flowp" d="M330 448 C 250 448, 150 400, 90 258"></path>
  <text class="lblp" x="150" y="400">6 client pays Stripe directly</text>

  <path class="flowp" d="M480 448 C 520 448, 520 300, 480 262"></path>
  <text class="lblp" x="500" y="330">7 webhook:</text>
  <text class="lblp" x="500" y="344">COMPLETE /</text>
  <text class="lblp" x="500" y="358">FAILED</text>

  <path class="flow" d="M710 418 L710 392"></path>
  <text class="lbl" x="720" y="408">reclaim</text>

  <path class="flow" d="M70 256 C 70 330, 90 330, 120 330 L 300 330" stroke-dasharray="2 4"></path>
  <text class="lbl" x="130" y="322">8 poll GET /purchases/:id until final</text>
</svg>
<figcaption>Flow numbered in request order. Redis holds only rebuildable queue state; every fact about who owns a unit lives in Postgres.</figcaption>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 882" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Flash sale flow between components">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="5" y="14" width="130" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Client</text>
<line class="ln" x1="70" y1="48" x2="70" y2="862"></line>
<rect class="sb" x="173" y="14" width="130" height="34"></rect><text class="st" x="238" y="36" text-anchor="middle">API Gateway</text>
<line class="ln" x1="238" y1="48" x2="238" y2="862"></line>
<rect class="sb" x="341" y="14" width="130" height="34"></rect><text class="st" x="406" y="36" text-anchor="middle">Waiting Room</text>
<line class="ln" x1="406" y1="48" x2="406" y2="862"></line>
<rect class="sb" x="509" y="14" width="130" height="34"></rect><text class="st" x="574" y="36" text-anchor="middle">Sale Service</text>
<line class="ln" x1="574" y1="48" x2="574" y2="862"></line>
<rect class="sb" x="677" y="14" width="130" height="34"></rect><text class="st" x="742" y="36" text-anchor="middle">Postgres</text>
<line class="ln" x1="742" y1="48" x2="742" y2="862"></line>
<rect class="sb" x="845" y="14" width="130" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Stripe</text>
<line class="ln" x1="910" y1="48" x2="910" y2="862"></line>
<line class="a1" x1="78" y1="80" x2="230" y2="80"></line>
<text class="sl" x="154" y="74" text-anchor="middle">GET /products/:id (before noon)</text>
<line class="a1" x1="246" y1="114" x2="566" y2="114"></line>
<text class="sl" x="406" y="108" text-anchor="middle">read product</text>
<line class="a1" x1="582" y1="148" x2="734" y2="148"></line>
<text class="sl" x="658" y="142" text-anchor="middle">SELECT product</text>
<line class="a2" x1="734" y1="182" x2="582" y2="182"></line>
<text class="sl" x="658" y="176" text-anchor="middle">row</text>
<line class="a2" x1="566" y1="216" x2="78" y2="216"></line>
<text class="sl" x="322" y="210" text-anchor="middle">product + sale window</text>
<line class="a1" x1="78" y1="250" x2="398" y2="250"></line>
<text class="sl" x="238" y="244" text-anchor="middle">join waiting room, hold until noon</text>
<rect class="nt" x="296" y="271" width="220" height="22"></rect><text class="sl" x="406" y="286" text-anchor="middle">noon: randomize cohort, then FIFO</text>
<line class="a2" x1="398" y1="318" x2="78" y2="318"></line>
<text class="sl" x="238" y="312" text-anchor="middle">signed admission token</text>
<line class="a1" x1="78" y1="352" x2="230" y2="352"></line>
<text class="sl" x="154" y="346" text-anchor="middle">POST /reservations + token</text>
<line class="a1" x1="246" y1="386" x2="566" y2="386"></line>
<text class="sl" x="406" y="380" text-anchor="middle">verify token, forward</text>
<line class="a1" x1="582" y1="420" x2="734" y2="420"></line>
<text class="sl" x="658" y="414" text-anchor="middle">BEGIN; SELECT unit FOR UPDATE SKIP LOCKED; INSERT reservation; COMMIT</text>
<line class="a2" x1="734" y1="454" x2="582" y2="454"></line>
<text class="sl" x="658" y="448" text-anchor="middle">reservation row</text>
<line class="a2" x1="566" y1="488" x2="78" y2="488"></line>
<text class="sl" x="322" y="482" text-anchor="middle">reservation (expiresAt)</text>
<line class="a1" x1="78" y1="522" x2="566" y2="522"></line>
<text class="sl" x="322" y="516" text-anchor="middle">POST /reservations/:id/purchases</text>
<line class="a1" x1="582" y1="556" x2="902" y2="556"></line>
<text class="sl" x="742" y="550" text-anchor="middle">create PaymentIntent</text>
<line class="a2" x1="902" y1="590" x2="582" y2="590"></line>
<text class="sl" x="742" y="584" text-anchor="middle">client secret</text>
<line class="a2" x1="566" y1="624" x2="78" y2="624"></line>
<text class="sl" x="322" y="618" text-anchor="middle">client secret</text>
<line class="a1" x1="78" y1="658" x2="902" y2="658"></line>
<text class="sl" x="490" y="652" text-anchor="middle">submit card, confirm</text>
<line class="a3" x1="902" y1="692" x2="582" y2="692"></line>
<text class="sl" x="742" y="686" text-anchor="middle">webhook: succeeded</text>
<line class="a1" x1="582" y1="726" x2="734" y2="726"></line>
<text class="sl" x="658" y="720" text-anchor="middle">purchase=COMPLETE, reservation=PURCHASED</text>
<line class="a1" x1="78" y1="760" x2="566" y2="760"></line>
<text class="sl" x="322" y="754" text-anchor="middle">poll GET /purchases/:id</text>
<line class="a2" x1="566" y1="794" x2="78" y2="794"></line>
<text class="sl" x="322" y="788" text-anchor="middle">COMPLETE</text>
<line class="a3" x1="582" y1="828" x2="734" y2="828"></line>
<text class="sl" x="658" y="822" text-anchor="middle">expiry worker: release lapsed units</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Client → API Gateway:</b> GET /products/:id (before noon).
    Pre‑sale reads are pure cache: the product page is identical for everyone and should never reach the database.
    Getting this right matters because the pre‑noon browse traffic is itself substantial, and it must not consume the capacity the sale needs.</li>
  <li><b>API Gateway → Sale Service:</b> read product.
    Read and write paths are separated from the start; the read path scales with a CDN, the write path scales by admitting fewer people.</li>
  <li><b>Sale Service → Postgres:</b> SELECT product.
    A single cheap read, cached aggressively with a short TTL. The units‑left figure shown here is deliberately approximate — displaying an exact live count would put every browsing user on the contended path.</li>
  <li><b>Postgres → Sale Service:</b> row (response).
    Postgres is the system of record for everything that decides ownership; Redis will only ever hold state that can be thrown away.</li>
  <li><b>Sale Service → Client:</b> product + sale window (response).
    Returning the sale window lets clients synchronise to server time rather than local clocks, which removes one reason for people to start hammering early.</li>
  <li><b>Client → Waiting Room:</b> join waiting room, hold until noon.
    This is the component that makes the whole design work: a cheap, horizontally scalable holding pen that absorbs 10M arrivals without any of them touching the database.
    Joining costs one Redis write and a held connection — no transactions, no locks, no inventory involvement.
    A visible queue position also changes behaviour: users who can see they are 400,000th stop refreshing, which removes the retry storm that would otherwise be the real load.</li>
  <li><b>Waiting Room:</b> noon: randomize cohort, then FIFO.
    Everyone present at the open is shuffled before being ordered, which is the fairness decision. Pure FIFO would reward the fastest network and the most aggressive bot, not the earliest genuine user.
    After the shuffle, FIFO is honest and explainable — position only improves as people ahead are served.
    Admission is then released at a rate the database can actually sustain, converting a 1M QPS spike into a few hundred controlled attempts per second.</li>
  <li><b>Waiting Room → Client:</b> signed admission token (response).
    The token is signed, short‑lived and single‑use, which is what stops anyone from skipping the queue by calling the reservation endpoint directly.
    Without it the waiting room would be advisory, and a scripted client would simply ignore it.</li>
  <li><b>Client → API Gateway:</b> POST /reservations + token.
    Only admitted users reach this endpoint, so it sees a manageable trickle rather than the crowd.</li>
  <li><b>API Gateway → Sale Service:</b> verify token, forward.
    Verification is a signature check with no state lookup, so rejecting a forged or reused token costs almost nothing — important, because that is the path bots will hit hardest.</li>
  <li><b>Sale Service → Postgres:</b> BEGIN; SELECT unit FOR UPDATE SKIP LOCKED; INSERT reservation; COMMIT.
    This is the critical section, and it is deliberately tiny: claim a row, write a reservation, commit — milliseconds, no external calls.
    <code>FOR UPDATE SKIP LOCKED</code> is what lets many concurrent buyers claim <em>different</em> units in parallel instead of serialising behind one lock on a counter.
    Decrementing a units‑left integer would be the obvious approach and is exactly wrong: it makes one row the bottleneck for the entire sale and turns contention into deadlocks.</li>
  <li><b>Postgres → Sale Service:</b> reservation row (response).
    The unit is now off the table with a TTL attached. Correctness is established here, before any money is involved — which is the insight the whole design is built around.</li>
  <li><b>Sale Service → Client:</b> reservation (expiresAt) (response).
    The user is told exactly how long they have, so the deadline is honest rather than a surprise.
    The TTL is the mechanism that stops abandoned checkouts from permanently consuming inventory.</li>
  <li><b>Client → Sale Service:</b> POST /reservations/:id/purchases.
    Payment is a separate step precisely because it is slow and involves a third party — and no database transaction can be held open across it.
    This separation is the single most‑missed point in the question: reserve first, settle money afterwards.</li>
  <li><b>Sale Service → Stripe:</b> create PaymentIntent.
    The intent is created server‑side and tied to the reservation, so a payment can never be associated with a unit the user does not hold.
    Idempotency keys make a client retry safe rather than double‑charging.</li>
  <li><b>Stripe → Sale Service:</b> client secret (response).
    Only a secret is returned; card details never pass through this service, which keeps it out of PCI scope entirely.</li>
  <li><b>Sale Service → Client:</b> client secret (response).
    The client will talk to the payment provider directly from here, so the service is not in the path of the slowest, least reliable step.</li>
  <li><b>Client → Stripe:</b> submit card, confirm.
    This can take seconds, involve 3‑D Secure, or fail — all of which is fine, because the unit is already reserved and the service is not waiting on it.</li>
  <li><b>Stripe → Sale Service:</b> webhook: succeeded (async).
    The webhook is the authoritative signal, not the client's claim of success — a client can lie, close the tab, or lose its connection.
    Webhooks must be verified, idempotent and replay‑safe, because they arrive at least once and occasionally out of order.</li>
  <li><b>Sale Service → Postgres:</b> purchase=COMPLETE, reservation=PURCHASED.
    The state transition is conditional on the reservation still being valid, so a payment arriving after expiry is refunded rather than silently overselling a unit already released.
    This is the point at which ownership becomes permanent.</li>
  <li><b>Client → Sale Service:</b> poll GET /purchases/:id.
    Polling rather than holding a connection means the client survives the webhook arriving late, and the server holds no per‑user state while waiting.</li>
  <li><b>Sale Service → Client:</b> COMPLETE (response).
    The user learns the outcome from the server's record of the webhook, so the confirmation reflects settled money rather than an optimistic client‑side guess.</li>
  <li><b>Sale Service → Postgres:</b> expiry worker: release lapsed units (async).
    Reservations that pass their TTL without payment return to the pool, which is what prevents abandoned carts from permanently destroying inventory.
    Release must be atomic and conditional so it cannot race a payment landing at the same moment — the classic double‑sell in this design.
    Released units go back through the waiting room rather than being first‑come‑first‑served, keeping the fairness property intact to the end of the sale.</li>
</ol>
<div class="legend">
  <span class="l-blue">request / DB path</span>
  <span class="l-teal">waiting room + Redis</span>
  <span class="l-plum">external payment (async)</span>
  <span class="l-amber">where the hard parts live</span>
</div>

## Deep dives (the four things the interviewer is waiting for) {#fs-deepdives}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/flash-sale/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

### 1. Correctness under contention: the hot row

<p>The naive fix is correct but slow:</p>
<pre><code>UPDATE Product SET inventoryCount = inventoryCount - 1
WHERE productId = ? AND inventoryCount &gt; 0;   -- 1 row = got it, 0 rows = sold out</code></pre>
<p>Every request serializes on one row lock. Adding app servers changes nothing; there is still one register. Fix: one row per unit and let Postgres hand out the next free one without waiting:</p>
<pre><code>BEGIN;
SELECT unitId FROM ReservationUnit
 WHERE productId = ? AND status = 'AVAILABLE'
 LIMIT 1 FOR UPDATE SKIP LOCKED;
-- update that unit to RESERVED, insert Reservation with expiresAt = now()+10min
COMMIT;</code></pre>
<table>
  <tbody><tr><th>Option</th><th>Pro</th><th>Con</th></tr>
  <tr><td>Redis DECR / Lua</td><td>~100K+ ops/s, single-threaded so atomic for free</td><td>Still one hot key; source of truth split across two systems; async replication can lose the last writes on failover</td></tr>
  <tr><td>ReservationUnit + SKIP LOCKED</td><td>Concurrency across rows, claim and reservation in one ACID txn, one source of truth</td><td>Row per unit; for millions of units use bucketed counters instead (Shopify's approach)</td></tr>
</tbody></table>
<div class="note"><b>Say the invariant:</b> "reservations issued can never exceed units that exist." Every choice is judged against that sentence.</div>

### 2. Releasing expired reservations

<p>A cron every 10s means a unit expiring at 12:10:01 is dead until 12:10:10, and someone gets told "sold out" while stock exists. Options, in order of how often they come up:</p>
<ul>
  <li>Workers continuously run <code>SELECT ... WHERE expiresAt &lt; now() AND status='ACTIVE' FOR UPDATE SKIP LOCKED</code> in a tight loop, tiny batches. Same trick as the claim path, no new component.</li>
  <li>Lazy release: the claim query itself treats <code>RESERVED AND expiresAt &lt; now()</code> as available, so the next claim reclaims it. Zero latency, no worker; expiry status updated on the way through.</li>
  <li>Redis key with TTL + keyspace notifications or a delay queue. Works, but reintroduces "Redis knows something Postgres doesn't."</li>
</ul>
<p>Whatever you pick: expiring and returning the unit must be one transaction, or you leak inventory nobody can buy.</p>

### 3. Millions arriving at once: admission control

<p>Even with SKIP LOCKED, the DB has a ceiling; quote a number ("load test says ~10K reservation txns/s"). No query fixes that, so throttle upstream with a virtual waiting room:</p>
<ul>
  <li>Client joins the queue; Waiting Room Service stores position in Redis (sorted set keyed by sale).</li>
  <li>An admission controller releases users at the DB's safe rate and issues a short‑lived signed token (JWT with userId, saleId, expiry).</li>
  <li>Reservation endpoint rejects any request without a valid token, so nobody bypasses the line.</li>
  <li>Users poll / SSE for position. Millions polling the waiting room is fine because it's a Redis read, not a DB write.</li>
</ul>

### 4. Fairness

<ul>
  <li>Pure FIFO rewards latency and bots. Instead: open the room before noon, at noon randomly shuffle everyone present, then FIFO for late arrivals.</li>
  <li>One queue entry per authenticated user per sale; CAPTCHA or bot challenge at the door.</li>
  <li>Sharded Redis still needs a global order: assign each user an ordering value at admission time so shards don't independently pick "next".</li>
</ul>

## Redis questions that came up (Anthropic round) {#fs-redis}

<details>
  <summary>If a Redis node crashes, is the state gone?</summary>
  <p>Depends on config. In‑memory by default; RDB snapshots lose everything since last snapshot, AOF <code>everysec</code> loses ≤1s, replication is async so failover can drop the last few ms of acknowledged writes. If all replicas die at once you fall back to whatever was fsync'd. Rule: things you can rebuild go in Redis, things that are the record go in a database.</p>
</details>
<details>
  <summary>Cache or database? Couchbase vs Redis vs Espresso</summary>
  <p>Couchbase/Espresso: disk‑backed, durable by default, memory is the optimization. Redis: memory is primary, disk is optional. "Espresso is where truth lives, Redis is where speed lives." If Redis is the only copy of something important, that's the signal to move it.</p>
</details>
<details>
  <summary>System of record?</summary>
  <p>The one authoritative copy; if two systems disagree it wins and everything else is rebuilt from it. It must survive every failure you care about, receive writes first, and be the source in any recovery. Here that's Postgres (ReservationUnit, Reservation, Purchase).</p>
</details>
<details>
  <summary>How does Redis partition millions of users? How does a client find a user's lock?</summary>
  <p>Redis Cluster splits keys, not users, into 16,384 hash slots via <code>CRC16(key) mod 16384</code>; each primary owns a slot range. Cluster‑aware clients cache the slot map, compute the slot locally, send directly to the owning node, and follow <code>MOVED</code> on a stale map. Hash tags <code>{user:123}:lock</code> co‑locate related keys. A lock is <code>SET key token NX PX ttl</code>; atomic because one node runs one command at a time.</p>
</details>
<details>
  <summary>What if node A/B/C is saturated?</summary>
  <p>Diagnose first. Uniform load: add a node and migrate slots live (<code>ASK</code>/<code>MOVED</code>), or send reads to replicas. Hot key: resharding does nothing, one key lives on one node. Split it yourself (<code>inventory:shoe:0..9</code>, 1,000 units each, client picks at random), cut traffic upstream with the waiting room, or cache reads app‑side.</p>
</details>


## Trade-offs {#fs-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Inventory model</td><td>One row per unit, claimed with <code>FOR UPDATE SKIP LOCKED</code></td><td>10,000 rows instead of one integer, and a row‑per‑unit schema</td><td>A counter is simpler but serialises the entire sale behind one row; only viable when concurrency is low</td></tr>
  <tr><td>Order of operations</td><td>Reserve first, pay second</td><td>Units can be held by people who never pay, for the length of the TTL</td><td>Charging first avoids abandoned holds but means holding a transaction across a third‑party call — which is not possible at this concurrency</td></tr>
  <tr><td>Load absorption</td><td>Waiting room in front of everything</td><td>A component to build, and users experience a queue</td><td>Rate limiting alone is simpler but turns the sale into a retry storm where the most aggressive client wins</td></tr>
  <tr><td>Fairness</td><td>Randomise the cohort at open, then FIFO</td><td>Users who genuinely arrived first do not get priority</td><td>Pure FIFO feels fairer but rewards the fastest network and the best bot, not the earliest person</td></tr>
  <tr><td>Redis's role</td><td>Queue state only; ownership lives in Postgres</td><td>An extra hop, and no inventory speedup from Redis</td><td>Never hold inventory in Redis: losing it would oversell, and "we lost the queue" is recoverable while "we sold 200 extra units" is not</td></tr>
  <tr><td>Payment confirmation</td><td>Trust the webhook, not the client</td><td>Webhook plumbing, idempotency and a polling endpoint</td><td>Never trust the client's success claim — it is the easiest thing in the flow to forge</td></tr>
  <tr><td>Units‑left display</td><td>Approximate, cached</td><td>Users may see a number that is briefly wrong</td><td>An exact live count puts every browsing user on the contended path, which is the one thing the design cannot afford</td></tr>
</tbody></table>

## Safety-first design {#fs-safety}

<div class="cards">
  <div><h4>Never oversell, even while failing</h4><ul>
    <li><b>Ownership is transactional.</b> A unit changes hands inside one short database transaction; nothing outside Postgres is ever authoritative about who holds what.</li>
    <li><b>Redis holds only disposable state.</b> Losing the waiting room pauses the sale; it cannot cause a double sale, because inventory was never there.</li>
    <li><b>Expiry and payment cannot race.</b> Releasing a lapsed reservation and completing a payment are both conditional updates, so exactly one wins.</li>
    <li><b>Late payments are refunded, not honoured.</b> A webhook arriving after expiry refunds rather than reviving a unit that has already been resold.</li></ul></div>
  <div><h4>The crowd is mostly bots</h4><ul>
    <li><b>Signed, single‑use admission tokens.</b> The reservation endpoint cannot be reached without passing through the queue, so scripting past it does not work.</li>
    <li><b>Limits per account, device and IP.</b> One reservation in flight per user and a hard unit cap blunt the scalper farm that would otherwise take the whole drop.</li>
    <li><b>Rejection is cheap.</b> Token verification is a signature check with no state lookup, so the path bots hammer hardest costs the least to serve.</li>
    <li><b>Queue position calms the storm.</b> Showing users where they stand removes the incentive to refresh, which is where most of the accidental load comes from.</li></ul></div>
  <div><h4>Stay out of the blast radius of money</h4><ul>
    <li><b>Card data never touches the service.</b> The client talks to the payment provider directly with a client secret, keeping the system out of PCI scope.</li>
    <li><b>The slow dependency is off the critical section.</b> Payment takes seconds and can fail; because the unit is already reserved, none of that threatens correctness.</li>
    <li><b>Idempotency everywhere money moves.</b> Payment intents and webhooks are keyed so retries and duplicate deliveries cannot double‑charge or double‑fulfil.</li>
    <li><b>Refusing to sell beats selling wrong.</b> Under extreme load the system sheds at the waiting room rather than accepting reservations it cannot honour.</li></ul></div>
</div>

## Don't leave the room without saying {#fs-checklist}

<ul class="checklist">
  <li>Reserve → pay, never pay inside an inventory transaction</li>
  <li>Check and decrement are one atomic operation; name the invariant</li>
  <li>The single inventory row is a hot spot; more app servers don't help</li>
  <li>Spread contention across rows with <code>FOR UPDATE SKIP LOCKED</code>, or explain why you'd take Redis's hot key and split source of truth instead</li>
  <li>Expiry must return the unit immediately and transactionally</li>
  <li>Give a throughput number for the DB and put a waiting room in front of it</li>
  <li>Signed admission token so the line can't be skipped</li>
  <li>Randomize the pre‑sale cohort, FIFO after; one entry per user; bot challenge</li>
  <li>Reads: product page served from cache/CDN, count can be a second stale; only reservation holders poll purchase status</li>
  <li>Redis durability caveat whenever Redis appears in the design</li>
</ul>

## What each level is expected to drive {#fs-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>End‑to‑end flow, atomic check+decrement, cron cleanup</td><td>Hot row, waiting room, SKIP LOCKED</td></tr>
  <tr><td>Senior</td><td>Hot row, Redis vs SKIP LOCKED tradeoff, clean expiry, finite DB ceiling</td><td>Waiting room design</td></tr>
  <tr><td>Staff+</td><td>All four deep dives, quantitative capacity, fairness incl. randomization, dedupe, bots, global ordering across shards</td><td>—</td></tr>
</tbody></table>
