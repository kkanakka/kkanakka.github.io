---
title: "S5 · Debugging a p99 latency spike (CPU flat)"
slug: /coding/arcoding/s5-debugging-a-p99-latency-spike-cpu-flat
sidebar_position: 7
sidebar_label: "S5 · Debugging a p99 latency spike (CPU fla…"
description: "S5 · Debugging a p99 latency spike (CPU flat)"
---

<div class="arcoding">

## S5 · Debugging a p99 latency spike (CPU flat)

<div class="adm info"><div class="adm-title">ℹ️ Problem</div>
<p>A Python service's p99 jumped 10× after a deploy. Average latency and CPU look normal. Walk through diagnosis — this is a reasoning round; structure beats speed.</p></div>
<h4>Open with the shape of the symptom</h4>
<p>Tail-up-average-flat means a <em>minority</em> of requests wait on something: queueing, head-of-line blocking, a stall — not a uniform per-request cost increase (that would move the average). Saying this in the first 30 seconds reframes the whole search and signals seniority.</p>
<h4>The hypothesis ladder (each with its cheap test)</h4>
<div class="tablewrap"><table>
<tr><th>#</th><th>Hypothesis</th><th>Cheap test</th><th>Expected evidence</th></tr>
<tr><td>1</td><td>A <strong>blocking call in the async event loop</strong> (sync DB/HTTP client, file I/O, CPU-heavy JSON) added by the deploy</td><td>Event-loop lag metric; <code>py-spy dump --pid</code> during a spike; <code>loop.slow_callback_duration</code> in debug mode</td><td>Loop lag spikes correlate with p99; the dump shows the blocking frame</td></tr>
<tr><td>2</td><td><strong>Connection-pool exhaustion</strong> → requests queue for a connection</td><td>Pool wait-time / checked-out-count metrics; did the deploy change pool size or add a call per request?</td><td>Pool at max, wait time ≈ the added tail latency</td></tr>
<tr><td>3</td><td><strong>Retry amplification</strong>: a dependency got slightly slower and new retry logic multiplies it</td><td>Compare dependency p99 vs our p99; request logs for attempt counts</td><td>Our p99 ≈ N × dependency timeout</td></tr>
<tr><td>4</td><td><strong>GIL contention</strong>: a new CPU-bound path in a threaded server starves other threads</td><td><code>py-spy top --pid</code>: one function dominating; total CPU can still look "normal" on a multi-core box</td><td>GIL-holding frames; per-thread wait</td></tr>
<tr><td>5</td><td><strong>GC pauses</strong> from new large-object churn</td><td><code>gc.set_debug(gc.DEBUG_STATS)</code> on a canary; gen-2 collection frequency/duration</td><td>Pause durations align with the p99 delta</td></tr>
<tr><td>6</td><td><strong>Not the app</strong>: noisy neighbor / CPU throttling / DNS</td><td>Is the spike on every replica? cgroup throttle counters; node-level metrics</td><td>Single-node → infra; all nodes since deploy → app</td></tr>
</table></div>
<h4>The measurement you add if it doesn't exist</h4>

```
import asyncio, time

async def loop_lag_monitor(report, interval=0.5):
    """Detects hypothesis #1 directly: if the loop is blocked, the sleep
    wakes late. Export the lag as a histogram; alert on p99 > 100 ms."""
    while True:
        t0 = time.perf_counter()
        await asyncio.sleep(interval)
        lag = time.perf_counter() - t0 - interval
        report("event_loop_lag_seconds", max(lag, 0.0))
```

<h4>Process wrapper (say this too)</h4>
<p>Confirm the deploy is the trigger (overlay deploy markers on the latency graph); if user impact is real, <strong>roll back first and diagnose from the canary</strong> — root cause is not a prerequisite for mitigation; then bisect the deploy's changes on a canary replica with production traffic mirrored. Close with the prevention: event-loop lag and pool-wait metrics on the default dashboard, p99 SLO burn alert, and a lint/CI rule banning sync clients in async code paths.</p>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>This one’s efficiency is about <em>diagnosis</em> cost, not code:</strong> the ladder is ordered by prior probability &times; cheapness of the test, so expected time-to-cause is minimized — check the deploy diff (seconds) before profiling (minutes) before adding instrumentation (a deploy). The loop-lag monitor itself is O(1) work every 500 ms — negligible overhead for permanently closing your biggest blind spot. The meta-point interviewers grade: mitigation (rollback) is O(minutes) and independent of diagnosis, so it comes first when users are burning.</p></div>
<!-- ============================ QUESTION BANK ============================ -->

</div>
