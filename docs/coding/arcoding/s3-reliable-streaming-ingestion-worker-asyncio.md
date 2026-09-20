---
title: "S3 · Reliable streaming ingestion worker (asyncio)"
slug: /coding/arcoding/s3-reliable-streaming-ingestion-worker-asyncio
sidebar_position: 5
sidebar_label: "S3 · Reliable streaming ingestion worker (a…"
description: "S3 · Reliable streaming ingestion worker (asyncio)"
---

<div class="arcoding">

## S3 · Reliable streaming ingestion worker (asyncio)

<p class="covers">Mirrors the reported live-coding session: "build a reliable message ingestion component that handles streaming data with unpredictable latency spikes."</p>
<div class="adm info"><div class="adm-title">ℹ️ Problem</div>
<p>Consume an async stream of messages; process with bounded concurrency; a slow or failing handler must not lose messages or blow up memory; support clean shutdown; expose health metrics. Extend with retry policy and a circuit breaker.</p></div>
<h4>The five properties to name before coding</h4>
<ol>
<li><strong>Backpressure:</strong> a bounded queue — when workers fall behind, <code>put()</code> blocks the reader instead of buffering unboundedly. An unbounded buffer doesn't fix overload, it hides it until OOM.</li>
<li><strong>Timeouts:</strong> every handler call gets <code>wait_for</code> — a hung handler must not wedge a worker forever.</li>
<li><strong>Retry with capped exponential backoff + jitter:</strong> jitter prevents synchronized retry waves after a downstream blip.</li>
<li><strong>Dead-lettering:</strong> after max retries, persist and move on. Silent drops are the unforgivable bug; a poison message must not block the stream (head-of-line).</li>
<li><strong>Delivery semantics:</strong> ack-after-process = at-least-once ⇒ the handler must be idempotent. Say this sentence out loud; it's the highest-value sentence in the interview.</li>
</ol>
<h4>Full solution</h4>

```python
import asyncio
import random
import time
from dataclasses import dataclass, field


@dataclass
class Stats:
    ok: int = 0
    failed: int = 0
    retried: int = 0
    dead_lettered: int = 0
    in_flight: int = 0
    queue_depth: int = 0
    last_success_ts: float = field(default_factory=time.monotonic)


class CircuitBreaker:
    """Open after `threshold` consecutive failures; half-open probe after
    `cooldown` seconds. Protects a struggling downstream from retry pressure."""
    def __init__(self, threshold=10, cooldown=5.0):
        self.threshold, self.cooldown = threshold, cooldown
        self.failures = 0
        self.opened_at = None

    def allow(self):
        if self.opened_at is None:
            return True
        if time.monotonic() - self.opened_at >= self.cooldown:
            return True                      # half-open: let one probe through
        return False

    def record(self, success):
        if success:
            self.failures, self.opened_at = 0, None
        else:
            self.failures += 1
            if self.failures >= self.threshold:
                self.opened_at = time.monotonic()


class Ingestor:
    def __init__(self, source, handler, dead_letter, *,
                 workers=8, queue_size=1000,
                 handler_timeout=5.0, max_retries=3):
        self.source, self.handler, self.dead_letter = source, handler, dead_letter
        self.q = asyncio.Queue(maxsize=queue_size)
        self.workers = workers
        self.handler_timeout = handler_timeout
        self.max_retries = max_retries
        self.stats = Stats()
        self.breaker = CircuitBreaker()
        self._stopping = asyncio.Event()

    async def _handle_with_retries(self, msg):
        for attempt in range(self.max_retries + 1):
            if not self.breaker.allow():
                await asyncio.sleep(0.5)          # breaker open: pause, re-check
                continue
            try:
                await asyncio.wait_for(self.handler(msg),
                                       timeout=self.handler_timeout)
                self.breaker.record(True)
                self.stats.ok += 1
                self.stats.last_success_ts = time.monotonic()
                return
            except asyncio.CancelledError:
                raise                              # shutdown: propagate
            except Exception:
                self.breaker.record(False)
                if attempt == self.max_retries:
                    self.stats.failed += 1
                    self.stats.dead_lettered += 1
                    await self.dead_letter(msg)    # persist; NEVER drop silently
                    return
                self.stats.retried += 1
                backoff = min(0.1 * (2 ** attempt), 2.0)
                await asyncio.sleep(backoff * random.uniform(0.5, 1.5))  # jitter

    async def _worker(self):
        while True:
            msg = await self.q.get()
            self.stats.in_flight += 1
            try:
                await self._handle_with_retries(msg)
            finally:
                self.stats.in_flight -= 1
                self.stats.queue_depth = self.q.qsize()
                self.q.task_done()                 # ack AFTER handling

    async def run(self):
        tasks = [asyncio.create_task(self._worker())
                 for _ in range(self.workers)]
        try:
            async for msg in self.source:
                if self._stopping.is_set():
                    break
                await self.q.put(msg)              # blocks when full: backpressure
                self.stats.queue_depth = self.q.qsize()
            await self.q.join()                    # drain before exit
        finally:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    def health(self):
        s = self.stats
        stalled = time.monotonic() - s.last_success_ts > 30
        return {"ok": not stalled, "queue_depth": s.queue_depth,
                "in_flight": s.in_flight, "dead_lettered": s.dead_lettered}
```

<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>Where's the loss window?</strong> A message pulled off the queue and lost on process crash — that's why real systems ack to the <em>broker</em> after handling (Kafka offsets, SQS delete-after). Map your <code>task_done()</code> to that.</li>
<li><strong>What do you alert on?</strong> Queue depth (leading), dead-letter rate (lagging), time-since-last-success (liveness of the whole pipeline — catches "reader wedged" that per-message metrics miss).</li>
<li><strong>Ordering:</strong> concurrent workers reorder messages. If per-key ordering matters, shard by key → one queue per shard, one worker per shard (Kafka-partition semantics). Raise it before they do.</li>
<li><strong>Why the breaker:</strong> retries against a dying dependency are load — the breaker converts a retry storm into a pause. Tie it to real cascading-failure incidents.</li>
</ul></div>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> O(1) framework overhead per message (queue put/get, stats) plus the handler itself; retries add at most <code>max_retries</code> handler calls for failing messages. <strong>Space:</strong> bounded by design — O(queue_size + workers) messages in memory, ever; that bound IS the backpressure mechanism.</p><p><strong>How efficient is it?</strong> Steady-state throughput ≈ workers / avg_handler_latency, so capacity is one tunable. The circuit breaker keeps efficiency honest under failure: without it, a dying downstream receives retry-multiplied load (the retry storm); with it, wasted work during an outage collapses to periodic probes.</p></div>

### Run it

<p class="covers">Append this to the code above, save as <code>s3_ingestor.py</code>, then run <code>python s3_ingestor.py</code>.</p>

```python
if __name__ == "__main__":
    async def demo():
        processed, dead = [], []

        async def source():
            for i in range(12):
                yield {"id": i}

        async def handler(msg):
            if msg["id"] == 4:
                raise RuntimeError("downstream returned 500")
            if msg["id"] == 7:
                await asyncio.sleep(10)          # exceeds handler_timeout
            processed.append(msg["id"])

        async def dead_letter(msg):
            dead.append(msg["id"])               # persisted, never dropped

        ing = Ingestor(source(), handler, dead_letter, workers=4,
                       queue_size=4, handler_timeout=0.2, max_retries=2)
        await ing.run()

        print("processed     :", sorted(processed))
        print("dead-lettered :", sorted(dead))
        print("stats.ok      :", ing.stats.ok)
        print("stats.retried :", ing.stats.retried, "(2 attempts x 2 bad msgs)")
        print("stats.failed  :", ing.stats.failed)
        print("queue drained :", ing.q.empty())
        print("health        :", ing.health())

    asyncio.run(demo())

    print("\n--- circuit breaker opens after 10 consecutive failures ---")
    cb = CircuitBreaker(threshold=10, cooldown=0.3)
    for i in range(9):
        cb.record(False)
    print("after 9 failures :", cb.allow())
    cb.record(False)
    print("after 10 failures:", cb.allow())      # tripped: shed load

    time.sleep(0.35)
    print("after cooldown   :", cb.allow())      # half-open: one probe
    cb.record(True)
    print("after a success  :", cb.allow(), "| failure count:", cb.failures)
```

<p><strong>Output</strong></p>

```text
processed     : [0, 1, 2, 3, 5, 6, 8, 9, 10, 11]
dead-lettered : [4, 7]
stats.ok      : 10
stats.retried : 4 (2 attempts x 2 bad msgs)
stats.failed  : 2
queue drained : True
health        : {'ok': True, 'queue_depth': 0, 'in_flight': 0, 'dead_lettered': 2}

--- circuit breaker opens after 10 consecutive failures ---
after 9 failures : True
after 10 failures: False
after cooldown   : True
after a success  : True | failure count: 0
```

</div>
