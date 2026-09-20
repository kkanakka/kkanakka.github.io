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

### The approach

<img src="/diagrams/arcoding/s5.svg" alt="Diagnosis starts by computing the tail-to-median ratio to decide whether a subset is stalling or every request shifted, then walks a hypothesis ladder cheapest-test-first and adds a per-request phase ledger." class="doc-diagram doc-diagram-seq" />

<p>Before touching any hypothesis, compute the <strong>shape</strong>: tail up with the average flat means a minority of requests are waiting on something, while everything moving together means a uniform per-request cost. Those two findings lead down completely different paths, so saying which one you have — in the first thirty seconds — reframes the whole search. Then walk the ladder cheapest test first, and if the data to distinguish the hypotheses does not exist, the answer is to add it: a per-request phase ledger whose unaccounted gap is precisely the time spent queued before any phase began.</p>
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

```python
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


<h4>Runnable diagnostics for each rung of the ladder</h4>
<p>The ladder above is the reasoning. This is the code you would actually paste into a canary — every block is self-contained, cheap enough to leave running, and answers exactly one hypothesis.</p>

<p><strong>0 · First, confirm it really is a subset.</strong> This decides everything after it, and it is one query, not a profiler.</p>

```python
import statistics

def shape_of_the_spike(latencies_ms):
    """Tail up + average flat == a MINORITY of requests are waiting.
    Everything moving together == a uniform per-request cost increase.

    These two findings send you down completely different paths, so this
    is the first thing to compute and the first thing to say out loud."""
    xs = sorted(latencies_ms)
    n  = len(xs)
    p = lambda q: xs[min(n - 1, int(q * n))]          # nearest-rank percentile

    mean, p50, p95, p99 = statistics.fmean(xs), p(0.50), p(0.95), p(0.99)

    # Ratio, not difference: it stays meaningful across services and scales.
    tail_ratio = p99 / p50 if p50 else float("inf")

    return {
        "mean": mean, "p50": p50, "p95": p95, "p99": p99,
        "tail_ratio": tail_ratio,
        # A healthy service is usually 3-5x. Past ~10x a subset is stalling.
        "verdict": "subset stalling" if tail_ratio > 10 else "uniform shift",
    }
```

<p><strong>1 · Blocking call in the event loop.</strong> The monitor above detects it; this catches it <em>in the act</em> and names the offending function, which is what you actually need to fix it.</p>

```python
import asyncio, logging

def arm_slow_callback_detector(threshold_s=0.1):
    """asyncio already measures how long each callback occupies the loop.
    Debug mode logs any callback exceeding slow_callback_duration, WITH the
    source location — so you get 'this exact line blocked for 800 ms'.

    Cheap enough for a canary; do not leave debug mode on fleet-wide."""
    loop = asyncio.get_running_loop()
    loop.set_debug(True)
    loop.slow_callback_duration = threshold_s      # default is 0.1s
    logging.getLogger("asyncio").setLevel(logging.WARNING)
    return loop


# The classic offender this finds: a sync client inside an async handler.
#
#   async def handler(req):
#       r = requests.get(url)        # <-- BLOCKS the whole loop, not just
#       return r.json()              #     this one request
#
# Correct:  async with httpx.AsyncClient() as c: r = await c.get(url)
# Or, when no async client exists, push it off the loop entirely:
#       r = await asyncio.to_thread(requests.get, url)
```

<p><strong>2 · Connection-pool exhaustion.</strong> The signature is that <em>wait</em> time grows while <em>service</em> time stays flat — so measure them separately, or the two are indistinguishable.</p>

```python
import time, contextlib

@contextlib.asynccontextmanager
async def timed_pool_acquire(pool, report):
    """Queueing for a connection and using it are different problems with
    different fixes (more connections vs faster queries). Timing them as
    one number is why pool exhaustion so often gets misdiagnosed as 'the
    database got slower'."""
    t0 = time.perf_counter()
    conn = await pool.acquire()                    # may queue here
    waited = time.perf_counter() - t0
    report("pool_wait_seconds", waited)
    report("pool_in_use", pool.get_size() - pool.get_idle_size())
    try:
        t1 = time.perf_counter()
        yield conn
    finally:
        report("query_seconds", time.perf_counter() - t1)
        await pool.release(conn)

# Reading it: pool_wait ~= your added tail latency AND pool_in_use pinned at
# max => exhaustion. If wait is ~0 and query_seconds grew, the dependency
# really did get slower and you are one rung down the ladder.
```

<p><strong>3 · Retry amplification.</strong> The tell is arithmetic: your p99 lands suspiciously close to a multiple of the downstream timeout.</p>

```python
def looks_like_retry_amplification(our_p99_ms, dep_timeout_ms, max_attempts):
    """A dependency that got slightly slower becomes a cliff once retries
    multiply it. Retries need all three of: backoff, jitter, and a budget —
    without them they amplify the very incident that triggered them."""
    for attempts in range(1, max_attempts + 1):
        expected = attempts * dep_timeout_ms
        if abs(our_p99_ms - expected) / expected < 0.15:      # within 15%
            return f"p99 ~= {attempts} x dependency timeout — retry storm"
    return None

# Also check request rate: if RPS to the dependency rose while your inbound
# RPS did not, the extra traffic is your own retries.
```

<p><strong>5 · GC pauses.</strong> Measure the pause itself rather than inferring it from collection counts.</p>

```python
import gc, time

def arm_gc_pause_monitor(report, threshold_s=0.05):
    """gc callbacks fire around each collection, so the delta between them
    IS the stop-the-world pause. Generation 2 is the one that hurts: it
    walks every tracked object, so it scales with live-object count."""
    state = {}

    def on_gc(phase, info):
        if phase == "start":
            state["t0"] = time.perf_counter()
        elif "t0" in state:
            pause = time.perf_counter() - state.pop("t0")
            report("gc_pause_seconds", pause, gen=info["generation"])
            if pause > threshold_s and info["generation"] == 2:
                report("gc_long_pause", pause)

    gc.callbacks.append(on_gc)

# If gen-2 pauses line up with the p99 delta: the fix is fewer long-lived
# objects, or gc.freeze() after startup to keep the permanent heap out of
# every subsequent collection.
```

<p><strong>The instrumentation that would have made all of this unnecessary</strong> — a per-hop ledger on 100% of requests. It is small, structured, and turns "the service is slow" into "the database span went 8 ms to 1,400 ms".</p>

```python
import time, contextlib

class LatencyLedger:
    """One dict per request recording where the time went. Cheap enough for
    every request (a few microseconds), unlike tracing which you sample.

    Emit it as structured log + histogram per phase. The first question in
    any latency incident is 'which hop?', and this answers it in one query."""

    __slots__ = ("phases", "_start")

    def __init__(self):
        self.phases = {}
        self._start = time.perf_counter()

    @contextlib.contextmanager
    def phase(self, name):
        t0 = time.perf_counter()
        try:
            yield
        finally:
            # += so a phase entered twice (a retry) accumulates rather than
            # overwriting — otherwise retries hide inside a single number.
            self.phases[name] = self.phases.get(name, 0.0) + (time.perf_counter() - t0)

    def finish(self):
        total = time.perf_counter() - self._start
        accounted = sum(self.phases.values())
        # The gap is the finding: time the request spent queued BEFORE any
        # phase started. Unaccounted time is not a measurement error.
        self.phases["unaccounted"] = max(0.0, total - accounted)
        self.phases["total"] = total
        return self.phases


# usage
# led = LatencyLedger()
# with led.phase("auth"):   ...
# with led.phase("db"):     ...
# log.info("request", extra=led.finish())
```

<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>Do you measure before you profile?</strong> Reaching for a profiler first is the common wrong move — a 10× p99 with a flat mean is almost never CPU inside your own code.</li>
<li><strong>Do you separate wait from service time?</strong> Conflating them is why pool exhaustion gets misdiagnosed as a slow dependency, every time.</li>
<li><strong>Do you know that unaccounted time is a finding?</strong> If the hops do not sum to the total, the remainder is queueing — and queueing is the single most common cause of this exact symptom.</li>
<li><strong>Do you mitigate before diagnosing?</strong> Rollback does not require root cause, and it is also evidence: if reverting fixes it, the search space collapsed to one change.</li>
</ul></div>

### Run it

<p class="covers">Append this to the code above, save as <code>s5_latency_tools.py</code>, then run <code>python s5_latency_tools.py</code>. This drives three of the tools above — <code>shape_of_the_spike</code>, <code>looks_like_retry_amplification</code> and <code>LatencyLedger</code>.</p>

```python
if __name__ == "__main__":
    import random, time

    random.seed(7)
    base = [random.gauss(40, 6) for _ in range(1000)]

    # (a) a uniform shift: every request pays the same extra cost
    uniform = [x + 25 for x in base]
    # (b) a stalling subset: 2% of requests wait on something
    stalling = base[:980] + [x + 900 for x in base[980:]]

    for name, xs in (("baseline", base), ("uniform shift", uniform),
                     ("2% stalling", stalling)):
        s = shape_of_the_spike(xs)
        print(f"{name:<14} mean={s['mean']:7.1f}  p50={s['p50']:6.1f}  "
              f"p99={s['p99']:7.1f}  tail={s['tail_ratio']:5.1f}x  "
              f"-> {s['verdict']}")

    print("\n--- is the p99 just retries x a dependency timeout? ---")
    for p99 in (980, 2050, 3100, 640):
        print(f"  p99={p99:<5} ->",
              looks_like_retry_amplification(p99, dep_timeout_ms=1000,
                                             max_attempts=3) or "no clean multiple")

    print("\n--- where did one request's time actually go? ---")
    led = LatencyLedger()
    time.sleep(0.10)                       # queued before any phase started
    with led.phase("auth"):
        time.sleep(0.10)
    with led.phase("db"):
        time.sleep(0.20)
    with led.phase("db"):                  # a retry: accumulates, not overwrites
        time.sleep(0.10)
    phases = led.finish()
    for k in ("auth", "db", "unaccounted", "total"):
        print(f"  {k:<12} {phases[k]:.1f}s")
    print("\n  the 0.1s 'unaccounted' is the queue wait — a finding, not noise")
```

<p><strong>Output</strong></p>

```text
baseline       mean=   40.2  p50=  40.2  p99=   54.5  tail=  1.4x  -> uniform shift
uniform shift  mean=   65.2  p50=  65.2  p99=   79.5  tail=  1.2x  -> uniform shift
2% stalling    mean=   58.2  p50=  40.5  p99=  939.9  tail= 23.2x  -> subset stalling

--- is the p99 just retries x a dependency timeout? ---
  p99=980   -> p99 ~= 1 x dependency timeout — retry storm
  p99=2050  -> p99 ~= 2 x dependency timeout — retry storm
  p99=3100  -> p99 ~= 3 x dependency timeout — retry storm
  p99=640   -> no clean multiple

--- where did one request's time actually go? ---
  auth         0.1s
  db           0.3s
  unaccounted  0.1s
  total        0.5s

  the 0.1s 'unaccounted' is the queue wait — a finding, not noise
```

</div>
