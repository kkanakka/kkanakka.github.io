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
