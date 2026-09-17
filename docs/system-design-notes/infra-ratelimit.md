---
title: "Distributed rate limiting and quotas for the API"
slug: /system-design-notes/infra-ratelimit
sidebar_position: 17
sidebar_label: "Distributed rate limiting and quotas for…"
description: "medium · Anthropic · leased local buckets · reserve then settle · never fail open"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/infra-ratelimit/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">medium · Anthropic · leased local buckets · reserve then settle · never fail open</span>
</header>

## Requirements {#infra-ratelimit-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Enforce per‑key limits: tokens/min, requests/min, concurrent streams</li>
      <li>Apply tier‑specific limits and per‑customer overrides</li>
      <li>Return informative 429s with Retry‑After and remaining headers</li>
      <li>Expose usage for billing and dashboards</li>
      <li class="out">Billing itself; abuse detection ML</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>No synchronous cross‑region call on the hot path</li>
      <li>Over‑admission bounded (a few %); under‑admission avoided for paid tiers</li>
      <li>Survives quota‑service outage with conservative behaviour</li>
      <li>Works across hundreds of gateways in multiple regions</li>
    </ol>
  </div>
</div>


## Scale, performance and safety targets {#infra-ratelimit-targets}

<p>A limiter sits in front of every single request, so its budget is measured in microseconds and its failure modes are everyone's failure modes. These are the numbers that force leased local buckets rather than a central counter.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> 100K QPS at peak across hundreds of gateways in several regions. A central check would mean 100K round trips per second to one store; the lease design turns that into ~200 lease calls/s total.</li>
    <li><b>Data volume:</b> millions of API keys, each with 3–4 limit types (tokens/min, requests/min, concurrent streams) — low tens of millions of small counters, plus a settled usage ledger of ~10B events/day for billing.</li>
    <li><b>Growth:</b> 2× annually in QPS and roughly 3× in tokens per request as context windows grow, so budget token accounting to grow faster than request counts.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> the admission decision must be p99 &lt; 1 ms and effectively free — it is pure local memory. Anything with a network call in it (p50 5 ms, p99 50 ms) is disqualified at this QPS.</li>
    <li><b>Throughput:</b> each gateway must decide for its full share of 100K QPS without contention; lease refresh at ~one call per gateway per 2–5 s, and settlement batched so billing never touches the hot path.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> this <em>is</em> the abuse defence — credential sharing across thousands of clients, burst scraping, and deliberately under‑declaring max_tokens to smuggle work past the estimate. Layer limits per key, per org and per IP so no single dimension is the only gate.</li>
    <li><b>Rate limiting:</b> concrete defaults — e.g. 100 req/min and 200K tokens/min per key, 1,000 req/min per org, plus a concurrent‑stream cap; tier‑specific values with per‑customer overrides, and a global capacity brake above all of them.</li>
    <li><b>Data sensitivity:</b> the limiter sees prompts pass by but must store none of them — keys are hashed identifiers, counters are integers, and the usage ledger records token counts, never content. Retain usage events ~90 days for billing disputes, then aggregate.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> effectively the API's own — four nines. The limiter must never be the reason a request fails, which is why the hot path has no dependency that can be down.</li>
    <li><b>Degraded mode:</b> quota service unreachable → keep serving on the current lease until it expires, then fall back to quota ÷ expected gateways ÷ 2 and alarm. Never fail open to unlimited (one bad key could take the fleet down) and never fail fully closed for paid tiers (an outage in a non‑critical service must not become a customer outage).</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> deliberately weak. Limits are approximate — a few percent over‑admission at a minute boundary is acceptable, and the bound is one lease per gateway. Billing does not use these counters; it uses the settled ledger.</li>
    <li><b>Durability:</b> lease state is disposable — losing it costs at most one lease of over‑admission. The settled usage ledger is the opposite: durable, append‑only and reconcilable, because it is what customers are charged from.</li>
    <li><b>Compliance:</b> customer‑visible limit semantics must be documented and stable, 429s must say which limit was hit and when to retry, and usage records need to survive a billing dispute.</li></ul></div>
</div>

## Entities and API {#infra-ratelimit-api}

<p>Quota (key, limitType, perMinute, region split) · Lease (key, gatewayId, amount, expiresAt) · Reservation (requestId, key, amount, ttl) · UsageEvent (settled tokens)</p>
<pre><code>POST /quota/lease {key, gatewayId, want}          -&gt; {granted, expiresAt}   (Lua atomic; every ~2–5 s per gateway)
POST /quota/settle {key, gatewayId, used}          -&gt; ok                     (batched)
Gateway local:  reserve(prompt+max_tokens) → admit or 429; settle(actual) on stream end; refund diff
Response headers: x-ratelimit-limit / -remaining / -reset; 429 body says which limit</code></pre>

## Design {#infra-ratelimit-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/infra-ratelimit/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Quota service leases slices of a key's per-minute budget to gateway instances; gateways run local token buckets; on request they reserve max_tokens, then settle actual usage on completion and refund the difference; if the quota service is unreachable gateways fall back to a conservative local default, never unlimited">
  <defs><marker id="q1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="q2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.tm{font-size:10.5px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#q1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#q2);stroke-dasharray:2 4}.lbl{font-size:10.5px;fill:#1F4E9E}.lbla{font-size:10.5px;fill:#B45309}</style>
  <rect class="box" x="20" y="30" width="200" height="90" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="120" y="50" text-anchor="middle">Quota service (Redis Cluster)</text><text class="tm" x="30" y="68">key:acme tokens/min = 1,000,000</text><text class="tm" x="30" y="82">leased_out = 640,000</text><text class="tm" x="30" y="96">leases: gw7:100k@t+5s, gw9:…</text><text class="ts" x="30" y="112">sharded by api_key; Lua for atomic lease</text>
  <rect class="box" x="300" y="20" width="220" height="110"></rect><text class="tb" x="410" y="40" text-anchor="middle">Gateway gw7: local bucket</text><text class="tm" x="310" y="58">lease: 100k tokens, expires 5 s</text><text class="tm" x="310" y="72">available: 61,300</text><text class="ts" x="310" y="90">admit if available ≥ reserve</text><text class="ts" x="310" y="104">renew lease at 50% used or 2.5 s</text><text class="ts" x="310" y="118">lease size ∝ this gw's recent share</text>
  <rect class="box" x="600" y="20" width="360" height="110"></rect><text class="tb" x="610" y="40">Reserve → settle</text>
  <text class="ts" x="610" y="58">request: prompt 2,000 tok, max_tokens 4,000 → reserve 6,000</text>
  <text class="ts" x="610" y="74">stream ends: actually 2,000 + 900 → settle 2,900, refund 3,100</text>
  <text class="ts" x="610" y="90">stream aborted: settle what was generated so far</text>
  <text class="ts" x="610" y="106">reservation has a TTL (max stream time) so a crash can't leak it</text>
  <text class="ts" x="610" y="122">reserving max_tokens prevents 1,000 parallel calls from each "fitting"</text>
  <rect class="box" x="20" y="160" width="500" height="85" stroke="#B45309"></rect><text class="tb" x="30" y="180">When the quota service is unreachable</text>
  <text class="ts" x="30" y="198">· keep serving on the current lease until it expires (5 s)</text>
  <text class="ts" x="30" y="212">· then fall back to a conservative local default: quota / expected_gw_count / 2</text>
  <text class="ts" x="30" y="226">· never fail open to unlimited; never fail fully closed for paid tiers</text>
  <text class="ts" x="30" y="240">· emit a metric; reconcile over‑admission after recovery (billing, not blocking)</text>
  <rect class="box" x="560" y="160" width="400" height="85"></rect><text class="tb" x="570" y="180">Layers</text>
  <text class="ts" x="570" y="198">1 concurrency cap per key (in‑flight streams) — local + leased the same way</text>
  <text class="ts" x="570" y="212">2 tokens/min (cost) and requests/min (abuse) — both buckets</text>
  <text class="ts" x="570" y="226">3 global capacity brake from healthy GPU count (Inference API §4)</text>
  <text class="ts" x="570" y="240">429 carries Retry‑After and which limit hit; headers expose remaining</text>
  <path class="f" d="M220 75 L298 75"></path><text class="lbl" x="228" y="66">lease</text>
  <path class="fa" d="M298 95 L222 95"></path><text class="lbla" x="232" y="108">settle</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 678" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Distributed rate limiting flow">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="5" y="14" width="130" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Client</text>
<line class="ln" x1="70" y1="48" x2="70" y2="658"></line>
<rect class="sb" x="215" y="14" width="130" height="34"></rect><text class="st" x="280" y="36" text-anchor="middle">Gateway</text>
<line class="ln" x1="280" y1="48" x2="280" y2="658"></line>
<rect class="sb" x="425" y="14" width="130" height="34"></rect><text class="st" x="490" y="36" text-anchor="middle">Local bucket</text>
<line class="ln" x1="490" y1="48" x2="490" y2="658"></line>
<rect class="sb" x="635" y="14" width="130" height="34"></rect><text class="st" x="700" y="36" text-anchor="middle">Quota service</text>
<line class="ln" x1="700" y1="48" x2="700" y2="658"></line>
<rect class="sb" x="845" y="14" width="130" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">GPU</text>
<line class="ln" x1="910" y1="48" x2="910" y2="658"></line>
<line class="a1" x1="288" y1="80" x2="692" y2="80"></line>
<text class="sl" x="490" y="74" text-anchor="middle">lease {key, want} every ~5 s</text>
<line class="a2" x1="692" y1="114" x2="498" y2="114"></line>
<text class="sl" x="595" y="108" text-anchor="middle">granted 100k, expires +5 s</text>
<line class="a1" x1="78" y1="148" x2="272" y2="148"></line>
<text class="sl" x="175" y="142" text-anchor="middle">request (prompt 2k, max_tokens 4k)</text>
<line class="a1" x1="288" y1="182" x2="482" y2="182"></line>
<text class="sl" x="385" y="176" text-anchor="middle">reserve 6,000</text>
<line class="a2" x1="482" y1="216" x2="288" y2="216"></line>
<text class="sl" x="385" y="210" text-anchor="middle">ok (available 61,300)</text>
<line class="a1" x1="288" y1="250" x2="902" y2="250"></line>
<text class="sl" x="595" y="244" text-anchor="middle">inference</text>
<line class="a2" x1="902" y1="284" x2="288" y2="284"></line>
<text class="sl" x="595" y="278" text-anchor="middle">stream, actual 2,900</text>
<line class="a2" x1="272" y1="318" x2="78" y2="318"></line>
<text class="sl" x="175" y="312" text-anchor="middle">response + x-ratelimit-remaining</text>
<line class="a1" x1="288" y1="352" x2="482" y2="352"></line>
<text class="sl" x="385" y="346" text-anchor="middle">settle 2,900, refund 3,100</text>
<line class="a3" x1="288" y1="386" x2="692" y2="386"></line>
<text class="sl" x="490" y="380" text-anchor="middle">batched settle report</text>
<rect class="nt" x="411" y="407" width="159" height="22"></rect><text class="sl" x="490" y="422" text-anchor="middle">renew lease at 50% used</text>
<line class="a1" x1="78" y1="454" x2="272" y2="454"></line>
<text class="sl" x="175" y="448" text-anchor="middle">request</text>
<line class="a2" x1="482" y1="488" x2="288" y2="488"></line>
<text class="sl" x="385" y="482" text-anchor="middle">insufficient</text>
<line class="a2" x1="272" y1="522" x2="78" y2="522"></line>
<text class="sl" x="175" y="516" text-anchor="middle">429 Retry-After</text>
<line class="a1" x1="288" y1="556" x2="692" y2="556"></line>
<text class="sl" x="490" y="550" text-anchor="middle">lease call fails</text>
<rect class="nt" x="170" y="577" width="220" height="22"></rect><text class="sl" x="280" y="592" text-anchor="middle">serve until lease expiry, then quota÷gateways÷2</text>
<rect class="nt" x="380" y="611" width="220" height="22"></rect><text class="sl" x="490" y="626" text-anchor="middle">reservation TTL reaper refunds leaks</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Gateway → Quota service:</b> lease {key, want} every ~5 s.
    The gateway asks for a block of budget up front rather than permission per request — this single inversion is what removes the network call from the hot path.
    The grant is computed atomically (a Lua script or conditional update) so hundreds of gateways can lease the same key without double‑spending it.
    How much it asks for adapts to its recent share of that key's traffic, so a gateway seeing most of a customer's requests gets most of the budget.</li>
  <li><b>Quota service → Local bucket:</b> granted 100k, expires +5 s (response).
    The lease is budget the gateway now owns outright for a few seconds, held as a local token bucket refilling at quota/60 s.
    Short expiry is the safety valve: if this gateway dies, its unused budget returns to the pool automatically within seconds, with no cleanup protocol.
    It also bounds the damage from a stale or partitioned gateway to exactly one lease.</li>
  <li><b>Client → Gateway:</b> request (prompt 2k, max_tokens 4k).
    The declared max_tokens matters as much as the prompt: the true cost of the call is unknown until it finishes, so the client's own upper bound becomes the estimate.
    Limits are layered here — key, organisation, IP and global capacity — and the tightest one wins.</li>
  <li><b>Gateway → Local bucket:</b> reserve 6,000.
    The gateway reserves the worst case, prompt + max_tokens, rather than optimistically charging the prompt alone.
    Reserving the upper bound is what makes concurrency limits mean something: 100 open 4K‑token streams really do hold 400K of budget while they run.
    The reservation carries a TTL equal to the maximum stream duration so a lost stream cannot leak budget forever.</li>
  <li><b>Local bucket → Gateway:</b> ok (available 61,300) (response).
    This is a local memory operation — no lock contention, no network, sub‑microsecond — which is the entire reason the design survives 100K QPS.
    The remaining figure is carried into the response headers so clients can pace themselves instead of discovering limits by being rejected.</li>
  <li><b>Gateway → GPU:</b> inference.
    Admission has already been decided, so the expensive resource is only ever touched by a request that is known to be within budget.
    Getting the order right matters: checking quota after scheduling GPU work would let a rejected request still consume capacity.</li>
  <li><b>GPU → Gateway:</b> stream, actual 2,900 (response).
    Real usage is almost always well below max_tokens, which is exactly why reserve‑then‑settle exists instead of simply charging the estimate.
    Tokens are counted as they stream, so an aborted stream still has an accurate number to settle.</li>
  <li><b>Gateway → Client:</b> response + x-ratelimit-remaining (response).
    Limit, remaining and reset headers on every response turn rate limiting from a surprise into a contract clients can program against.
    Good citizens back off before they are throttled, which reduces 429s far more effectively than any server‑side tuning.</li>
  <li><b>Gateway → Local bucket:</b> settle 2,900, refund 3,100.
    The difference between the reservation and the truth goes straight back into the local bucket, usually within seconds.
    Without this refund, a customer declaring a large max_tokens would be charged for capacity they never used and would hit limits at a fraction of their real quota.</li>
  <li><b>Gateway → Quota service:</b> batched settle report (async).
    Settlements are batched and sent off the hot path, because billing accuracy does not need to be synchronous — admission already happened locally.
    This report, not the limiter's counters, is the billing ledger: durable, append‑only, and reconcilable after the fact.
    Batching also means a slow or briefly unavailable quota service never adds latency to a customer request.</li>
  <li><b>Local bucket:</b> renew lease at 50% used.
    Renewal is triggered by consumption, not by a timer alone, so a bursty key refreshes quickly and an idle one barely talks to the quota service.
    Renewing at half‑consumed leaves headroom to absorb the round trip, so traffic never stalls waiting for budget to arrive.</li>
  <li><b>Client → Gateway:</b> request.
    The same path runs again; nothing about a rejection is special until the bucket actually comes up short.</li>
  <li><b>Local bucket → Gateway:</b> insufficient (response).
    The bucket is empty and the lease cannot be topped up fast enough — the gateway now has to reject, locally and instantly.
    Because the decision is local, a throttled key costs almost nothing to reject, which is what keeps an abusive client from becoming a load problem.</li>
  <li><b>Gateway → Client:</b> 429 Retry-After (response).
    Retry‑After is computed from the refill rate, so it is a real answer rather than a guess, and the body names which limit was hit — key, org, or concurrency.
    A 429 that says "which limit, and when" prevents the retry storms that a bare rejection reliably causes.</li>
  <li><b>Gateway → Quota service:</b> lease call fails.
    A dependency failure here is expected, not exceptional, and the design is judged by what happens next.
    The gateway records the failure as a metric immediately, because silent degradation of limits is how a small outage becomes a large one.</li>
  <li><b>Gateway:</b> serve until lease expiry, then quota÷gateways÷2.
    First it keeps serving on budget it already owns — an outage shorter than the lease is invisible to customers.
    After that it falls back to a conservative static slice: half of the naive per‑gateway share, chosen so that even if every gateway guesses independently the total stays under the real quota.
    Deliberately not fail‑open (one key could then saturate the fleet) and not fail‑closed for paid traffic (a quota outage must not become a customer outage); usage is reconciled from the settled ledger afterwards.</li>
  <li><b>Local bucket:</b> reservation TTL reaper refunds leaks.
    Streams that vanish — client disconnects, worker crashes, timeouts — would otherwise hold their reservation forever and slowly shrink a customer's effective quota.
    The reaper returns anything past its TTL, making the reserve‑then‑settle loop self‑healing rather than dependent on every path settling correctly.
    A rising leak rate is a useful alarm in itself: it usually means streams are dying somewhere upstream.</li>
</ol>

## How it works, step by step {#infra-ratelimit-flow}

<ol class="order">
  <li>Gateway holds a local token bucket per (key, limit type) filled by a lease from the quota service.</li>
  <li>On request: estimate cost = prompt tokens + max_tokens; if the bucket has it, reserve and admit; else 429 with Retry‑After computed from refill rate.</li>
  <li>Lease renewal happens asynchronously at 50% consumption or half the lease TTL; lease size adapts to this gateway’s recent share of the key.</li>
  <li>On stream completion or abort, settle actual usage, refund the reservation difference to the local bucket, batch‑report to the quota service.</li>
  <li>Reservations carry a TTL equal to max stream time; a reaper refunds leaked ones.</li>
  <li>If the quota service is unreachable: serve on the current lease until expiry, then fall back to quota ÷ expected gateways ÷ 2; emit metric; reconcile later.</li>
  <li>Concurrency limits use the same lease mechanism with slots instead of tokens.</li>
</ol>

## Deep dives {#infra-ratelimit-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/infra-ratelimit/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
  <div><h4>Why leased local buckets</h4><ul>
    <li>Zero network calls on the hot path; one lease call per gateway per few seconds instead of one per request.</li>
    <li>Over‑admission bounded by one lease per gateway, a few percent, versus unbounded with independent local buckets.</li>
    <li>Lease sizes adapt to traffic skew: a gateway seeing more of key X gets a bigger slice.</li></ul></div>
  <div><h4>Reserve then settle</h4><ul>
    <li>The cost of a call isn't known until it ends. Reserve the upper bound (<code>prompt + max_tokens</code>), refund the difference at settlement.</li>
    <li>Makes concurrency limits meaningful: 100 concurrent 4k‑token calls really consume 400k of budget until they finish.</li>
    <li>Reservation TTL = max stream time; reaper refunds leaked reservations.</li></ul></div>
  <div><h4>Consistency you accept</h4><ul>
    <li>Limits are approximate by design: a few percent over at the minute boundary is fine; billing uses the settled ledger, not the limiter.</li>
    <li>Multi‑region: partition the key's quota by region (e.g. 60/40 by history) with periodic rebalance, or lease from a home region with higher latency tolerance.</li>
    <li>Sliding window vs fixed: token bucket with refill rate = quota/60 s avoids the double‑burst at minute boundaries.</li></ul></div>
</div>


## Trade-offs {#infra-ratelimit-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Where the decision happens</td><td>Local bucket filled by a lease</td><td>Exactness — limits are approximate, over‑admission bounded by one lease per gateway</td><td>A central per‑request check only at low QPS, or when a limit is legally exact (e.g. a hard spend cap)</td></tr>
  <tr><td>Cost accounting</td><td>Reserve max_tokens, settle actual, refund</td><td>Bookkeeping complexity, reservation TTLs and a reaper to run</td><td>Charge a flat estimate only when request costs are uniform; here they vary by 10× and flat charging would badly under‑serve customers</td></tr>
  <tr><td>Failure policy</td><td>Fail conservative: lease, then quota ÷ gateways ÷ 2</td><td>Paid customers may see limits tighter than they bought during an outage</td><td>Never fail open — one key could then saturate the fleet; never fail fully closed — a quota outage would become a customer outage</td></tr>
  <tr><td>Window algorithm</td><td>Token bucket with continuous refill</td><td>Slightly harder to explain to customers than "N per minute"</td><td>Fixed windows are simpler but allow a 2× burst across the boundary; sliding logs are exact but cost memory per request</td></tr>
  <tr><td>Multi‑region</td><td>Split each key's quota by region, rebalanced periodically</td><td>A key whose traffic shifts regions is throttled before its global quota is used</td><td>Lease from a single home region when traffic is genuinely global and the extra cross‑region latency on lease refresh is tolerable</td></tr>
  <tr><td>Lease length</td><td>A few seconds</td><td>More lease traffic than a long lease would need</td><td>Longer leases reduce quota‑service load but increase both over‑admission and the time a dead gateway's budget stays stranded</td></tr>
  <tr><td>Billing source</td><td>The settled usage ledger, not the limiter</td><td>Two systems of record to keep reconciled</td><td>Never merge them — a limiter tuned for speed and approximation is the wrong thing to invoice from</td></tr>
</tbody></table>

## Safety-first design {#infra-ratelimit-safety}

<div class="cards">
  <div><h4>The limiter is the abuse boundary</h4><ul>
    <li><b>Layer the limits.</b> Per key, per organisation, per IP and a global capacity brake — a stolen key is capped by its org, and a distributed scrape is capped by the global brake.</li>
    <li><b>Reject cheaply.</b> A throttled request is decided in local memory and costs no GPU, no database and no cross‑region call, so an attacker gains nothing by sending more.</li>
    <li><b>Reserve the upper bound.</b> Charging the declared max_tokens up front closes the obvious hole where a client under‑declares cost to smuggle work through.</li>
    <li><b>Concurrency is its own limit.</b> Tokens per minute alone does not stop a thousand simultaneous long streams; a slot limit does.</li></ul></div>
  <div><h4>Failing without taking the API down</h4><ul>
    <li><b>Nothing on the hot path can be down.</b> Admission reads local memory only, so the quota service, the database and the network are all optional at request time.</li>
    <li><b>Neither open nor closed.</b> Fail‑open invites one key to saturate the fleet; fail‑closed turns a minor outage into a customer‑visible one. The conservative middle — half the naive share — is the deliberate choice.</li>
    <li><b>Self‑healing accounting.</b> Reservation TTLs and the reaper mean leaked budget returns on its own, rather than quietly eroding a customer's quota until someone notices.</li>
    <li><b>Degradation is loud.</b> Falling back to static shares emits a metric and an alarm, because a limiter that is silently guessing is a limiter nobody can trust.</li></ul></div>
  <div><h4>Being fair, and being seen to be fair</h4><ul>
    <li><b>Every 429 is explainable.</b> It names the limit that was hit and a Retry‑After derived from the real refill rate — which also prevents retry storms.</li>
    <li><b>Headers on success too.</b> Limit, remaining and reset on every response let clients self‑pace, which reduces throttling far more than server‑side tuning does.</li>
    <li><b>No content, ever.</b> The limiter counts tokens and requests; it stores no prompts and logs no payloads, so the busiest component in the system holds none of the most sensitive data.</li>
    <li><b>Bill from the ledger.</b> Approximate enforcement is fine; approximate invoices are not — so billing reads settled usage, which is durable and auditable.</li></ul></div>
</div>

## Don't leave the room without saying {#infra-ratelimit-check}

<ul class="checklist">
  <li>Why central per‑request check and pure local buckets both fail</li>
  <li>Lease → local bucket; over‑admission bounded by lease size</li>
  <li>Reserve max_tokens, settle actual, refund; reservation TTL + reaper</li>
  <li>Fail conservative, never open to unlimited, never fully closed for paid</li>
  <li>Token bucket refill avoids minute‑boundary double bursts</li>
  <li>Multi‑region quota split with rebalance</li>
  <li>Billing from settled ledger, not the limiter</li>
</ul>

## What each level is expected to drive {#infra-ratelimit-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Redis counter per key checked per request; 429 on excess</td><td>Local buckets, token‑based cost</td></tr>
  <tr><td>Senior</td><td>Leased local buckets, reserve/settle, fallback policy, layered limits, headers</td><td>Multi‑region split, adaptive lease sizing</td></tr>
  <tr><td>Staff+</td><td>Precise over‑admission bounds, region rebalance, interaction with capacity brake and degraded modes, customer‑visible semantics and support tooling</td><td>—</td></tr>
</tbody></table>
