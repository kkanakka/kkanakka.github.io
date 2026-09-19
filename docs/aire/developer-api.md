---
title: "Developer API platform: secure, efficient access to the models"
slug: /aire/developer-api
sidebar_position: 7
sidebar_label: "Developer API platform: secure, efficien…"
description: "hard · Anthropic · keys and scoping · quotas · streaming contract · idempotency · versioning"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/developer-api/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

## How it works

<header>
  
  <span class="tag">hard · Anthropic · keys and scoping · quotas · streaming contract · idempotency · versioning</span>
</header>
<p>The public surface developers actually build against: authenticate, authorise, meter, stream, version and support. The GPU machinery behind it is a different design — here the product <em>is</em> the contract. Almost every decision is irreversible in a way internal systems are not, because once a header is published and someone's production code depends on it, you own it for years.</p>

## Requirements {#da-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Issue and revoke scoped credentials; organisations, workspaces and per‑key limits</li>
      <li>Synchronous and streaming completions with a stable, versioned contract</li>
      <li>Meter usage accurately enough to bill from, and expose it to the customer</li>
      <li>Safe retries, informative errors, and self‑service debugging by request id</li>
      <li class="out">The inference engine and batching (see the inference API page), the model itself</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Auth and limit decisions add &lt; 5 ms to every request</li>
      <li>99.99% availability; the platform must not be the reason a model call fails</li>
      <li>A leaked key must be revocable in seconds, fleet‑wide</li>
      <li>Backwards compatibility measured in years, not releases</li>
    </ol>
  </div>
</div>
<div class="trap"><b>What makes this different from an internal service:</b> you cannot deploy a fix to your callers. A field you add is a field you support forever, an error code you return becomes someone's control flow, and a latency regression breaks a product you have never heard of. Design as if every response shape is permanent, because to your customers it is.</div>

## Scale, performance and safety targets {#da-targets}

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> 100K requests/s at peak, ~90% streaming and long‑lived, so the edge holds millions of concurrent connections rather than serving short request/response cycles.</li>
    <li><b>Data volume:</b> ~10 KB average request, responses of a few hundred to many thousands of tokens; one usage record per request means ~8.6B billing rows/day, which is the largest durable write stream in the system.</li>
    <li><b>Growth:</b> ~2× requests annually and tokens per request growing faster as context windows expand — so metering and quota accounting grow faster than request count, and both must be sized on tokens.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> the platform's own overhead is the SLI that matters — auth, limit check and routing at p99 &lt; 5 ms. Time to first token is the model's; the platform must not add measurably to it.</li>
    <li><b>Throughput:</b> every hot‑path decision is local memory or a same‑region cache. Anything requiring a cross‑region or database round trip per request is disqualified at 100K QPS.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the dominant threats are credential‑centric — keys committed to public repositories, one stolen key draining an organisation's budget, key sharing across many clients, and scraping via distributed low‑rate requests. Beyond that: prompt injection and jailbreak attempts, and denial‑of‑wallet through expensive requests.</li>
    <li><b>Rate limiting:</b> layered and all enforced — per key, per workspace, per organisation, per IP for unauthenticated surfaces, plus a global capacity brake. Concrete defaults: 100 req/min and 200K tokens/min per key, 1,000 req/min per org, a concurrent‑stream cap, and a spend ceiling per billing period.</li>
    <li><b>Data sensitivity:</b> prompts are customer data and frequently contain their <em>own</em> users' PII, which makes this a processor relationship rather than a controller one. Never log payloads, offer a zero‑retention mode, encrypt in transit and at rest, scope every record by organisation, and publish retention as a number.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.99% (~52 min/year). Customers build production systems on this, so the platform layer must be more reliable than the capacity behind it.</li>
    <li><b>Degraded mode:</b> auth store unreachable → serve on cached key material until its lease expires, then fail closed for new keys rather than open. Metering pipeline lagging → enforce on slightly stale counters, which over‑grants marginally rather than blocking working customers. Capacity exhausted → 429 with <code>Retry‑After</code> and a clear reason, never a silent timeout.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> key revocation must be strongly consistent and fast — a leaked key that keeps working for a TTL is a security incident. Usage counters are deliberately eventual; the billing ledger is durable and reconciled.</li>
    <li><b>Durability:</b> the usage ledger needs full durability because invoices are generated from it and disputed against it. Request payloads are, by policy, <em>not</em> durable.</li>
    <li><b>Compatibility:</b> a dated version header, additive‑only changes within a version, and a deprecation policy with a stated notice period. This is a contract commitment more than a technical one.</li></ul></div>
</div>

## Entities and API {#da-api}

<p>Organization (billing account, spend limits) · Workspace (isolation boundary within an org) · ApiKey (hashed, scoped, prefixed, last‑used, revocable) · Scope (permission set) · RateBudget (per key/workspace/org) · UsageRecord (requestId, tokens in/out, model, cost) · ApiVersion (dated).</p>
<pre><code>POST /v1/messages           {model, messages[], max_tokens, stream}   -&gt; JSON or SSE
  Headers:  authorization: Bearer sk-ant-…     anthropic-version: 2026-01-15
            idempotency-key: &lt;uuid&gt;            (safe retry of a non-idempotent call)
  Response: request-id: req_01H…               (the support handle)
            x-ratelimit-limit / -remaining / -reset       (per key and per org)

POST /v1/keys      {workspaceId, scopes[], name}  -&gt; {key}   # shown once, stored hashed
DELETE /v1/keys/:id                                -&gt; revoked, effective in seconds
GET  /v1/usage?start=&amp;end=&amp;group_by=workspace      -&gt; metered usage and cost
GET  /v1/models                                    -&gt; available models and their versions</code></pre>

## Design {#da-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/developer-api/architecture.svg" alt="Architecture — identity, limits, metering, streaming contract" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

### Flow between components

<ol class="order">
  <li><b>Client → Edge:</b> POST /v1/messages with a bearer key and a version header.
    TLS terminates at the edge, closest to the caller, and the connection will stay open for the whole generation — so the edge is sized for millions of concurrent idle sockets rather than for request throughput.
    The version header is required rather than optional: a request that does not state which contract it expects cannot be served safely across years of evolution.</li>
  <li><b>Edge → Auth:</b> resolve the key from a local cache.
    The key is hashed and looked up in an in‑region cache with a short lease, so the hot path never makes a cross‑region call — at 100K QPS a database read per request is not available.
    Only the hash is ever stored or compared; the plaintext key exists once, at creation, and is never recoverable. A key prefix (<code>sk-ant-</code>) is kept in clear so secret scanners can recognise it in public repositories.
    Revocation pushes an invalidation rather than waiting for the lease, because a leaked key that keeps working for five minutes is a security incident rather than a cache nuance.</li>
  <li><b>Auth → Edge:</b> {orgId, workspaceId, scopes, tier} (response).
    Identity resolves to an organisation and a workspace, not just a key — every later decision (limits, isolation, billing, data residency) is made against those.
    Scopes are checked here: a key issued for one model or one workspace cannot reach another, so the blast radius of a leak is bounded at issue time rather than at incident time.</li>
  <li><b>Edge → Limiter:</b> check key, workspace, org and global budgets.
    All four layers are evaluated, because each stops a different failure: a runaway script (key), a noisy team (workspace), a compromised account (org) and a capacity crunch (global).
    The check reads a local leased token bucket, so it costs microseconds; a central per‑request check would make the limiter the availability ceiling of the whole platform.
    The estimate charged is <code>prompt + max_tokens</code> — the upper bound — because the true cost is unknown until the response ends, and charging only the prompt lets a caller reserve far more capacity than they are accounted for.</li>
  <li><b>Edge → Client:</b> 429 with Retry-After and which limit was hit (response).
    A rejection names the specific limit — key tokens/min, org requests/min, concurrent streams — and gives a real retry time derived from the refill rate.
    That specificity is what prevents retry storms and what stops a support ticket: a developer who can see <em>which</em> limit they hit fixes it themselves.</li>
  <li><b>Edge → API service:</b> forward with the resolved identity attached.
    Identity is resolved once at the edge and passed downstream as trusted context, so no service re‑parses a credential and there is exactly one place where authentication logic lives.</li>
  <li><b>API service:</b> validate against the requested version; apply idempotency.
    Validation is performed against the contract the caller asked for, which is how one deployment serves several dated versions simultaneously.
    If an <code>idempotency-key</code> is present, a prior result for that key is returned instead of running again — this is what makes a retry after an ambiguous timeout safe, and without it the honest answer to "did my expensive call go through?" is "nobody knows".</li>
  <li><b>API service → Safety:</b> classify the input.
    Runs concurrently with prefill so its cost is hidden, but no token is released until it passes.
    A refusal returns a documented error type rather than an opaque failure, because a developer needs to distinguish "my request was rejected on policy" from "the service is broken" in order to handle it in code.</li>
  <li><b>API service → Inference:</b> submit to the serving fleet.
    Everything about batching, GPU scheduling and capacity lives behind this boundary; the platform's job is to have decided <em>whether</em> this request should exist before it consumes a GPU slot.</li>
  <li><b>Inference → API service:</b> token stream (response).
    Streaming is the default because a multi‑second generation behind a single response would hold a connection with no feedback and time out in every intermediate proxy.
    Events carry ids so a client can resume with <code>Last-Event-ID</code> — but because this is a POST endpoint, <code>EventSource</code> is unavailable and the SDK drives that reconnect loop itself, which is part of what the official SDKs are for.</li>
  <li><b>API service → Client:</b> SSE events with a stable schema (response).
    Event types and their fields are part of the versioned contract, so a client parsing them today keeps working for years — adding a new optional field is safe, changing an existing one is not.
    Errors mid‑stream are a terminal event carrying a type and the request id, never a dropped connection, because a truncated stream is indistinguishable from a network failure and forces the caller to guess.</li>
  <li><b>API service → Client:</b> final event with usage and stop reason (response).
    Returning the actual token counts lets a customer reconcile their own spend without calling a second API, and the stop reason distinguishes "finished" from "hit max_tokens" — different situations that look identical without it.</li>
  <li><b>API service → Metering:</b> emit a usage record (async).
    Counts come from the inference layer, the only component that knows the true totals; the edge sees the prompt but not the output, and a stream can be stopped early.
    Emission is asynchronous and keyed by request id so the pipeline is idempotent under replay — <em>count at the source, enforce at the edge</em> is the split that keeps billing accurate and limiting fast.</li>
  <li><b>Metering → Limiter:</b> refresh live counters (async).
    The limiter's buckets are corrected from settled usage, so the estimate charged up front is reconciled against reality within seconds and unused reservation returns to the customer.</li>
  <li><b>Metering → Ledger:</b> durable, idempotent upsert for billing.
    The ledger is the system of record for invoices and is reconciled nightly against inference‑side logs; drift is alerted rather than discovered by a customer.
    Enforcement counters are explicitly <em>not</em> the billing source — one is tuned for speed and approximation, the other must survive a dispute.</li>
  <li><b>Support path:</b> customer quotes a request id; you answer without their payload.
    Every response carries a request id, and the platform stores enough structured metadata against it — timings per hop, model version, token counts, error type, limits at that moment — to diagnose a problem <b>without ever having logged the prompt</b>.
    This is the design decision that makes a zero‑retention offering compatible with being able to support customers at all.</li>
</ol>

## How it works, step by step {#da-flow}

<ol class="order">
  <li>The edge terminates TLS, resolves a hashed key from a leased local cache, and attaches organisation, workspace and scopes.</li>
  <li>Four layers of limits are checked against local token buckets, charging <code>prompt + max_tokens</code> as an upper bound; a rejection names the limit and a real retry time.</li>
  <li>The API service validates against the requested dated version and short‑circuits on an idempotency key if this request has already run.</li>
  <li>Input safety runs concurrently with prefill, then the request enters the inference fleet — the platform's job was to decide whether it should exist at all.</li>
  <li>Tokens stream back under a versioned event schema; errors are terminal events with a type and request id, never dropped connections.</li>
  <li>Usage is emitted asynchronously from the inference layer, refreshes the limiter's counters, and lands in a durable ledger that invoices are generated from and reconciled against.</li>
</ol>

## Deep dives {#da-deep}

<div class="cards">
  <div><h4>Credentials that fail safely</h4><ul>
    <li><b>Store hashes, never keys.</b> The plaintext exists once, at creation; a database leak yields nothing usable.</li>
    <li><b>Recognisable prefixes.</b> <code>sk-ant-</code> lets GitHub and other scanners detect a committed key and notify you — an enormous practical win, since public repositories are the single largest source of leaks.</li>
    <li><b>Scope at issue time.</b> A key limited to one workspace and one model bounds the damage before any incident happens, which is the only time bounding is cheap.</li>
    <li><b>Revoke by push, not by TTL.</b> Invalidation propagates in seconds; waiting out a cache lease is the difference between an incident and a footnote.</li>
    <li><b>Show last‑used metadata.</b> Customers can spot a key being used from an unexpected place or one that is simply forgotten.</li></ul></div>
  <div><h4>The contract is the product</h4><ul>
    <li><b>Dated version header.</b> One deployment serves many contracts; customers upgrade on their schedule, not yours.</li>
    <li><b>Additive‑only within a version.</b> New optional fields are safe; changing a type, a default or an error code is not, because someone has written <code>if (error.type === …)</code>.</li>
    <li><b>Errors are an API surface.</b> Stable machine‑readable types, human messages, and the request id — a developer must be able to branch on the type without parsing prose.</li>
    <li><b>Deprecation with a stated notice period,</b> usage data showing who is still on an old version, and direct outreach rather than a blog post.</li></ul></div>
  <div><h4>Metering you can invoice from</h4><ul>
    <li><b>Count at the source.</b> Only the inference layer knows real token counts; the edge sees the prompt but not the completion, and a stopped stream ends early.</li>
    <li><b>Enforce at the edge.</b> Local leased buckets keep the decision in microseconds; a central check would gate availability on the metering pipeline.</li>
    <li><b>Reserve the upper bound, settle the actual.</b> Charging <code>prompt + max_tokens</code> and refunding the difference is what makes concurrency limits meaningful.</li>
    <li><b>Two records, deliberately.</b> Fast approximate counters for enforcement, a durable reconciled ledger for billing — merging them gets you a slow limiter and a disputable invoice.</li></ul></div>
</div>

## Trade-offs {#da-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Versioning</td><td>Dated header, additive‑only within a version</td><td>Carrying old behaviour in the codebase for years</td><td>URL versioning (<code>/v2/</code>) forces a migration per change and fragments documentation; breaking changes in place are simply not available on a public API</td></tr>
  <tr><td>Auth on the hot path</td><td>Leased local cache of hashed keys</td><td>Revocation needs an explicit invalidation push</td><td>A per‑request lookup is exact and makes the auth store the availability ceiling of the platform</td></tr>
  <tr><td>Cost accounting</td><td>Reserve <code>prompt + max_tokens</code>, settle actual</td><td>Bookkeeping, reservation TTLs and a reaper</td><td>Charging the prompt only is simpler and lets a caller hold far more capacity than they are accounted for</td></tr>
  <tr><td>Retry safety</td><td>Idempotency keys on every non‑idempotent call</td><td>A store of recent results and a TTL to operate</td><td>Without it, an ambiguous timeout on an expensive call is unresolvable — both retrying and not retrying are wrong some of the time</td></tr>
  <tr><td>Payload logging</td><td>Never; structured metadata against a request id instead</td><td>Debugging without the actual prompt is harder</td><td>Logging payloads makes support easy and makes zero‑retention impossible — and a log pipeline becomes a second copy of every customer's data</td></tr>
  <tr><td>Failure posture</td><td>Fail closed on auth, conservative on limits</td><td>An auth outage becomes a customer outage</td><td>Never fail open on authentication; for limits, the conservative middle avoids both an unlimited key and a self‑inflicted outage</td></tr>
  <tr><td>Streaming</td><td>SSE with a versioned event schema and per‑event ids</td><td>A second contract surface to keep compatible</td><td>Buffering the whole response is simpler and times out in intermediate proxies on any long generation</td></tr>
</tbody></table>

## Safety-first design {#da-safety}

<div class="cards">
  <div><h4>Assume every key will leak</h4><ul>
    <li><b>Design for revocation, not prevention.</b> Keys end up in public repositories, CI logs and screenshots; what matters is how fast you can kill one.</li>
    <li><b>Scoped at issue.</b> Workspace and model scoping bounds the damage before anything goes wrong, which is the only moment it is cheap to bound.</li>
    <li><b>Layered limits.</b> A stolen key is still capped by its workspace, which is capped by the organisation, which is capped by the global brake.</li>
    <li><b>Spend ceilings, not just rate limits.</b> Requests per minute does not stop a slow, expensive drain; a hard spend cap per billing period does.</li></ul></div>
  <div><h4>Customer data you never hold</h4><ul>
    <li><b>Prompts are not logged.</b> Support works from a request id and structured metadata, which is what makes zero‑retention and real support compatible.</li>
    <li><b>You are a processor.</b> Prompts often contain the customer's own users' data, so retention, deletion and residency are contractual rather than discretionary.</li>
    <li><b>Organisation‑scoped everything.</b> Usage, logs and support records are partitioned by org, so a query bug cannot cross an account boundary.</li>
    <li><b>Publish retention as a number,</b> and make deletion reach usage records and support metadata, not only the primary store.</li></ul></div>
  <div><h4>Never be the reason a call fails</h4><ul>
    <li><b>Nothing on the hot path can be down.</b> Auth and limits read local memory, so the database, the metering pipeline and cross‑region links are all optional at request time.</li>
    <li><b>429 beats a timeout.</b> An explicit rejection with a reason and a retry time is actionable; a silent stall is the worst possible failure for someone else's production system.</li>
    <li><b>Errors are terminal events, not dropped streams.</b> A truncated connection forces the caller to guess whether the work happened.</li>
    <li><b>Degrade conservatively.</b> Fail closed on authentication, and on limits fall back to a tightened static share rather than either unlimited or refusing paying customers.</li></ul></div>
</div>

## Don't leave the room without saying {#da-check}

<ul class="checklist">
  <li>You cannot deploy a fix to your callers — every response shape is permanent in practice</li>
  <li>Hashed keys with recognisable prefixes, scoped at issue, revoked by push in seconds</li>
  <li>Identity resolves to org + workspace + scopes, not just "a valid key"</li>
  <li>Four limit layers — key, workspace, org, global — all local‑memory decisions</li>
  <li>Reserve <code>prompt + max_tokens</code>, settle actual; count at the source, enforce at the edge</li>
  <li>Idempotency keys, or an ambiguous timeout on an expensive call is unresolvable</li>
  <li>Dated version header, additive‑only, errors as a stable machine‑readable surface</li>
  <li>Request id on every response; support from metadata, never from logged payloads</li>
  <li>Enforcement counters and the billing ledger are two different stores on purpose</li>
</ul>

## What each level is expected to drive {#da-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>API keys, rate limiting, HTTPS, usage tracking in a database</td><td>Scoping, versioning, idempotency, streaming contract</td></tr>
  <tr><td>Senior</td><td>Hashed scoped keys with fast revocation, layered local limits, reserve/settle metering, dated versioning, idempotency, SSE contract and error taxonomy</td><td>Ledger vs counters split, zero‑retention support model</td></tr>
  <tr><td>Staff+</td><td>Treating the contract as a multi‑year commitment, deprecation policy with usage data behind it, supporting customers without holding their data, and the processor/controller distinction driving retention and residency</td><td>—</td></tr>
</tbody></table>
