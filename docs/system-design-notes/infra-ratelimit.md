---
title: "Distributed rate limiting and quotas for the API"
slug: /system-design-notes/infra-ratelimit
sidebar_position: 17
sidebar_label: "Distributed rate limiting and quotas for…"
description: "medium · Anthropic · leased local buckets · reserve then settle · never fail open"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/infra-ratelimit/sequence.svg" alt="How it works — infra-ratelimit" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
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

## Entities and API {#infra-ratelimit-api}

<p>Quota (key, limitType, perMinute, region split) · Lease (key, gatewayId, amount, expiresAt) · Reservation (requestId, key, amount, ttl) · UsageEvent (settled tokens)</p>
<pre><code>POST /quota/lease {key, gatewayId, want}          -&gt; {granted, expiresAt}   (Lua atomic; every ~2–5 s per gateway)
POST /quota/settle {key, gatewayId, used}          -&gt; ok                     (batched)
Gateway local:  reserve(prompt+max_tokens) → admit or 429; settle(actual) on stream end; refund diff
Response headers: x-ratelimit-limit / -remaining / -reset; 429 body says which limit</code></pre>

## Design {#infra-ratelimit-design}

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
  <li><b>Gateway → Quota service:</b> lease {key, want} every ~5 s</li>
  <li><b>Quota service → Local bucket:</b> granted 100k, expires +5 s (response)</li>
  <li><b>Client → Gateway:</b> request (prompt 2k, max_tokens 4k)</li>
  <li><b>Gateway → Local bucket:</b> reserve 6,000</li>
  <li><b>Local bucket → Gateway:</b> ok (available 61,300) (response)</li>
  <li><b>Gateway → GPU:</b> inference</li>
  <li><b>GPU → Gateway:</b> stream, actual 2,900 (response)</li>
  <li><b>Gateway → Client:</b> response + x-ratelimit-remaining (response)</li>
  <li><b>Gateway → Local bucket:</b> settle 2,900, refund 3,100</li>
  <li><b>Gateway → Quota service:</b> batched settle report (async)</li>
  <li><b>Local bucket:</b> renew lease at 50% used</li>
  <li><b>Client → Gateway:</b> request</li>
  <li><b>Local bucket → Gateway:</b> insufficient (response)</li>
  <li><b>Gateway → Client:</b> 429 Retry-After (response)</li>
  <li><b>Gateway → Quota service:</b> lease call fails</li>
  <li><b>Gateway:</b> serve until lease expiry, then quota÷gateways÷2</li>
  <li><b>Local bucket:</b> reservation TTL reaper refunds leaks</li>
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
