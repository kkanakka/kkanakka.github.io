---
title: "B15 · Thread-safe bounded blocking queue"
slug: /coding/arcoding/b15-thread-safe-bounded-blocking-queue
sidebar_position: 22
sidebar_label: "B15 · Thread-safe bounded blocking queue"
description: "B15 · Thread-safe bounded blocking queue"
---

<div class="arcoding">

## B15 · Thread-safe bounded blocking queue

<p class="covers">Covers: Implement thread-safe blocking queue — the purest concurrency question in the bank; also the building block inside S3 and B6.</p>

```
import threading
import time
from collections import deque


class QueueClosed(Exception):
    pass


class BlockingQueue:
    """Bounded MPMC queue. put() blocks when full, get() blocks when empty.
    Both support timeouts; close() wakes all waiters for clean shutdown."""

    def __init__(self, capacity: int):
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self.cap = capacity
        self.q = deque()
        self._lock = threading.Lock()
        self.not_full = threading.Condition(self._lock)    # SAME lock —
        self.not_empty = threading.Condition(self._lock)   # both conditions
        self.closed = False

    def put(self, item, timeout=None) -> bool:
        deadline = None if timeout is None else time.monotonic() + timeout
        with self.not_full:
            while len(self.q) >= self.cap and not self.closed:
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    return False
                self.not_full.wait(remaining)      # 'while', never 'if'
            if self.closed:
                raise QueueClosed()
            self.q.append(item)
            self.not_empty.notify()
            return True

    def get(self, timeout=None):
        deadline = None if timeout is None else time.monotonic() + timeout
        with self.not_empty:
            while not self.q:
                if self.closed:
                    raise QueueClosed()            # drained AND closed
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    raise TimeoutError()
                self.not_empty.wait(remaining)
            item = self.q.popleft()
            self.not_full.notify()
            return item

    def close(self):
        """Consumers drain remaining items, then see QueueClosed;
        blocked producers are released with QueueClosed."""
        with self._lock:
            self.closed = True
            self.not_full.notify_all()
            self.not_empty.notify_all()
```

<div class="adm tip"><div class="adm-title">💡 What they probe — the two classic bugs, name them unprompted</div>
<ul>
<li><strong><code>if</code> instead of <code>while</code> around <code>wait()</code>:</strong> wakeups can be spurious, and another thread can steal the slot between notify and re-acquire — the predicate must be re-checked. This single word is the most common failure in this question.</li>
<li><strong>Two conditions on <em>different</em> locks:</strong> checking the queue and waiting must be atomic under one lock, or a notify slips between check and wait → deadlock. Both Conditions share <code>self._lock</code> deliberately.</li>
<li><strong>notify vs notify_all:</strong> single <code>notify</code> per state change suffices here (each put enables exactly one get); <code>notify_all</code> on close because <em>every</em> waiter must re-evaluate. Being able to say when each is right is the senior signal.</li>
<li><strong>Alternatives if asked:</strong> two semaphores (slots/items) + a mutex is the textbook equivalent; and in real code you'd reach for <code>queue.Queue</code> — implementing it is the exercise, knowing you wouldn't hand-roll it in prod is the judgment.</li>
</ul></div>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> <code>put/get</code> O(1) of actual work (deque append/popleft) plus blocking time, which is workload, not cost; <code>notify</code> wakes exactly one waiter — O(1) — versus <code>notify_all</code>’s O(waiters) thundering herd, which is why close() is the only place it’s used. <strong>Space:</strong> O(capacity).</p><p><strong>How efficient is it?</strong> Optimal for a lock-based queue; the single shared lock serializes operations, which is fine up to very high throughput. The scaling follow-up answer: two locks (one per end) à la Michael–Scott, or lock-free queues — name them, then say you’d measure before reaching for either, because the lock is rarely the bottleneck next to the work items represent.</p></div>

</div>
