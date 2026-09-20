---
title: "System design & SRE scenarios"
slug: /coding/arcoding/system-design-sre-scenarios
sidebar_position: 24
sidebar_label: "System design & SRE scenarios"
description: "System design & SRE scenarios"
---

<div class="arcoding">

## System design & SRE scenarios

<div class="card">
<h3 style="margin-top:0">D1 · Design an API for serving LLM inference at scale (the signature question)</h3>
<p><em>Interactive chat/completions on GPUs; high concurrency; per-request latency SLOs; GPU throughput is far higher when requests are batched.</em></p>
<ul>
<li><strong>Requirements first (2 min):</strong> streaming vs non-streaming; SLOs — TTFT p99 &lt; 1 s, inter-token p99 &lt; 100 ms; mixed workload (short chat + long-context + batch); multi-tenant fairness. State the core tension: batching raises throughput but adds queueing delay — the design manages that tradeoff per priority class.</li>
<li><strong>Napkin math:</strong> a 70B-class model on 8 GPUs sustains a few thousand tokens/s; at ~300 output tokens per request that's ~10 req/s per replica — 1,000 req/s ⇒ ~100 replicas. Doing this unprompted is a strong signal.</li>
<li><strong>Architecture:</strong> gateway (authn, rate limiting, admission control) → router (load-aware on queue depth and free KV blocks, not CPU) → per-replica <strong>continuous batching</strong> scheduler; chunked prefill so a 100k-token prompt can't stall decode; PagedAttention-style KV paging; prefix caching for shared system prompts.</li>
<li><strong>Queuing:</strong> per-class queues (interactive &gt; standard &gt; batch); admission control rejects early with 429 + Retry-After when projected TTFT exceeds SLO — rejecting fast is a feature; queueing forever is an outage. Batch traffic is the shock absorber.</li>
<li><strong>Streaming:</strong> SSE; gateway must not buffer; heartbeats distinguish slow generation from dead connections; client disconnect cancels and frees KV blocks immediately (leaked generations are a classic incident).</li>
<li><strong>Failures:</strong> replica crash mid-generation → retriable error or replay-from-prompt with idempotency keys (beware double-billing); OOM → preempt lowest-priority sequences (swap vs recompute); health checks measure <em>generation</em> latency, not TCP liveness.</li>
<li><strong>Observability:</strong> TTFT, TPOT, tokens/s, queue depth by class, KV occupancy, preemption rate, admission rejects; alert on SLO burn rate, not raw p99.</li>
</ul>
</div>
<div class="card">
<h3 style="margin-top:0">D2 · Request routing with sticky assignment (reported senior-loop question)</h3>
<ul>
<li><strong>Why sticky:</strong> re-hitting a replica with a warm prefix cache slashes prefill cost for multi-turn conversations. Frame it as <em>affinity with escape hatches</em>, not hard stickiness.</li>
<li><strong>Mechanism:</strong> consistent hashing on conversation ID with bounded loads — route to the affine replica unless load &gt; ~1.25× mean, then spill. Cache miss on spill is a latency cost, not a correctness failure — always classify which failures are graceful.</li>
<li><strong>Capacity:</strong> the scarce resource is KV-cache memory. Router tracks per-replica free-block estimates via piggybacked responses or 1–2 s gossip; bounded staleness is fine — quantify it.</li>
<li><strong>Failures:</strong> replica death redistributes only its ring segment; conversations lose warmth (slower, not broken). Router is stateless (affinity derives from hashing) — avoid an external affinity DB, which becomes the SPOF.</li>
<li><strong>Hot key:</strong> one giant tenant hashing to one replica — detect and shard that tenant across k replicas with power-of-two-choices.</li>
</ul>
</div>
<div class="card">
<h3 style="margin-top:0">D3 · GPU fleet scheduler across clusters</h3>
<ul>
<li><strong>Two loops, two timescales:</strong> slow placement (minutes: which models get replicas where — bin-pack by GPU memory + interconnect) and fast routing (ms). The fast loop never waits on the slow one.</li>
<li><strong>Placement inputs:</strong> demand forecast, cold-start cost (model load = minutes → keep N+2 warm spares for large models), GPU-type constraints, data residency.</li>
<li><strong>Losing 30% of a region, in order:</strong> (1) tighten admission immediately — shed batch, protect interactive; (2) spill cross-region within the latency budget; (3) rebalance placement toward surviving capacity; (4) degrade explicitly (smaller default model, context caps, tenant quota clamps) in a priority order agreed <em>in peacetime</em>.</li>
</ul>
</div>
<div class="card">
<h3 style="margin-top:0">D4 · Incident: TTFT p99 doubled in one region, errors flat</h3>
<p>First 2 minutes: severity by SLO burn; check regional deploys/config/model rollouts (change is cause #1); check traffic-mix shift — TTFT is prefill-dominated, so a surge of long prompts raises it with zero errors. Ladder: prompt-length histogram → replica count &amp; queue depth (autoscaler flap? node preemption?) → prefix-cache hit rate after router changes → batch jobs admitted into interactive pools. Mitigate smallest-blast-radius first: tighten in-region admission for batch/long-context → spill interactive cross-region → roll back the suspect change. Verify on burn rate; postmortem adds a prompt-mix alert so the pager beats the SLO.</p>
</div>
<div class="card">
<h3 style="margin-top:0">D5 · Incident: silent quality degradation</h3>
<p>Treat quality as an SLI. Diff everything in the serving path in the window: model revision, quantization/KV precision, speculative-decoding settings, sampling defaults, tokenizer, prompt templates, partial canaries. Bisect by routing a traffic slice to the previous config; verify with a golden prompt set (pinned seeds) and per-revision distributions (output length, refusal rate, logprob stats). Prevention: quality gates on every model/config canary + full versioning of every layer so "what changed" is a query, not an investigation.</p>
</div>
<div class="card">
<h3 style="margin-top:0">D6 · SLOs for a token-streaming API</h3>
<p>Per traffic class: interactive gets availability, TTFT p99, inter-token p99, and <strong>stream-completion rate</strong> (streams ending with a proper finish reason vs dying mid-generation — the commonly missed SLI); batch gets throughput and completion-by-deadline. Targets from measured baselines; burn-rate alerting (fast burn pages, slow burn tickets). The sharp edge that impresses: per-token metrics let one long generation contribute thousands of samples — aggregate per-request first or a single bad request distorts the SLI.</p>
</div>
<!-- ============================ VALUES ============================ -->

</div>
