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

### The approach

<img src="/diagrams/arcoding/b15.svg" alt="One lock carries two condition variables; put waits for not-full and get waits for not-empty, each re-checking its predicate in a while loop, and close wakes everyone." class="doc-diagram doc-diagram-seq" />

<p>Both conditions must share <strong>one lock</strong>, or a thread could check a predicate and then sleep through the very notification it was waiting for. Each wait sits in a <code>while</code> loop, never an <code>if</code>: a wake-up is a hint that something changed, not a guarantee that it is still true by the time you re-acquire the lock. <code>close()</code> notifies both conditions, which gives a clean shutdown — consumers drain what remains and then see the closed state, and blocked producers are released rather than hanging forever.</p>

### What it looks like in memory

<p>The queue mid-run, with the producer and two consumers parked in their respective waiting rooms.</p>

<img src="/diagrams/arcoding-state/b15.svg" alt="A full two-slot queue with a producer parked on not-full and two consumers parked on not-empty." class="doc-diagram doc-diagram-seq" />

```python
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
        """Append an item, blocking while the queue is full. Returns True, or False on timeout.

        Example:
            >>> q = BlockingQueue(1)
            >>> q.put('a')
            True
            >>> q.put('b', timeout=0.01)
            False
        """
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
        """Remove and return the oldest item, blocking while empty (TimeoutError on timeout).

        Example:
            >>> q = BlockingQueue(2)
            >>> q.put('a')
            True
            >>> q.get()
            'a'
        """
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
        blocked producers are released with QueueClosed.

        Example:
            q.close()      # wakes every blocked producer and consumer
            q.get()        # once the queue is drained AND closed -> raises QueueClosed
        """
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

### Run it

<p class="covers">Append this to the code above, save as <code>b15_blocking_queue.py</code>, then run <code>python b15_blocking_queue.py</code>.</p>

```python
if __name__ == "__main__":
    import threading

    q = BlockingQueue(capacity=2)
    consumed, lock = [], threading.Lock()

    def consumer(cid):
        while True:
            try:
                item = q.get(timeout=2.0)
            except QueueClosed:
                return                       # drained AND closed: clean exit
            with lock:
                consumed.append(item)

    threads = [threading.Thread(target=consumer, args=(i,)) for i in range(3)]
    for t in threads:
        t.start()

    for i in range(10):
        q.put(i)                             # blocks whenever 2 are pending
    q.close()
    for t in threads:
        t.join()

    print("capacity        :", q.cap)
    print("items consumed  :", len(consumed))
    print("nothing lost    :", sorted(consumed) == list(range(10)))
    print("all threads done:", not any(t.is_alive() for t in threads))

    print("\n--- put() on a full queue times out instead of hanging ---")
    q2 = BlockingQueue(capacity=1)
    print("put 'a'         :", q2.put("a", timeout=0.1))
    print("put 'b' (full)  :", q2.put("b", timeout=0.1))

    print("\n--- get() on an empty queue times out ---")
    try:
        BlockingQueue(2).get(timeout=0.1)
    except TimeoutError:
        print("TimeoutError raised")

    print("\n--- put() after close is refused ---")
    q2.close()
    try:
        q2.put("c")
    except QueueClosed:
        print("QueueClosed raised")

    try:
        BlockingQueue(0)
    except ValueError as e:
        print("ValueError:", e)
```

<p><strong>Output</strong></p>

```text
capacity        : 2
items consumed  : 10
nothing lost    : True
all threads done: True

--- put() on a full queue times out instead of hanging ---
put 'a'         : True
put 'b' (full)  : False

--- get() on an empty queue times out ---
TimeoutError raised

--- put() after close is refused ---
QueueClosed raised
ValueError: capacity must be positive
```

</div>
