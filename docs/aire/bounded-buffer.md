---
title: "Thread‑safe producer‑consumer buffer"
slug: /aire/bounded-buffer
sidebar_position: 10
sidebar_label: "Thread‑safe producer‑consumer buffer"
description: "coding · mutex + condition variables · bounded queue · shutdown · fairness"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/bounded-buffer/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">coding · mutex + condition variables · bounded queue · shutdown · fairness</span>
</header>
<p>Implement a fixed‑capacity queue that any number of producer threads can put into and consumer threads can take from: put blocks when full, take blocks when empty, no busy‑waiting, no lost or duplicated items, clean shutdown. This is the primitive under every worker pool in the doc.</p>

## Requirements {#bounded-buffer-req}

<div class="board">
  <div><h4>Functional</h4><ol>
      <li>put(item) blocks while full; take() blocks while empty</li>
      <li>Many producers and consumers concurrently</li>
      <li>close(): producers fail fast, consumers drain then get "closed"</li>
      <li>Optional: timeouts, try_put/try_take, peek size</li>
      <li class="out">Priorities, persistence</li>
  </ol></div>
  <div><h4>Non‑functional</h4><ol>
      <li>No busy‑wait; threads sleep on a condition</li>
      <li>No lost wakeups; correct under spurious wakeups</li>
      <li>Fair enough: no producer or consumer starves indefinitely</li>
      <li>Low contention: one lock, two conditions</li>
  </ol></div>
</div>
<div class="note"><b>The two bugs interviewers look for:</b> using <code>if</code> instead of <code>while</code> around the wait (spurious wakeups and multiple waiters), and notifying the wrong condition or forgetting to notify at all (deadlock with a full queue and sleeping producers).</div>


## Scale, performance and safety targets {#bounded-buffer-targets}

<p>A primitive still deserves numbers — they are what decide one lock versus a lock‑free ring, and what "fair" has to mean here.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>Throughput:</b> target ~1–5M put/take pairs per second on one machine with 8–32 threads. Above that, a single mutex becomes the bottleneck and the answer is sharding or a lock‑free ring, not a better condition variable.</li>
    <li><b>Data volume:</b> capacity is a deliberate, small number — hundreds to a few thousand items. The bound <em>is</em> the feature: it is what converts unbounded memory growth into back‑pressure.</li>
    <li><b>Growth:</b> more producers and consumers increase lock contention superlinearly, so past ~32 threads plan to shard into several buffers rather than widening one.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> uncontended put/take in the low hundreds of nanoseconds; a blocked thread must wake within microseconds of a notify. No operation may spin — a busy‑wait burns a core to save a context switch and destroys throughput for everyone else.</li>
    <li><b>Throughput:</b> the critical section holds only a deque operation and a notify, so lock hold time stays in the tens of nanoseconds. Anything expensive inside the lock — allocation, I/O, logging — is what actually kills a design like this.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the "attacks" here are structural. A producer faster than every consumer will pin the buffer at capacity forever; the bound is what stops that from becoming an out‑of‑memory crash. A consumer that blocks while holding an item stalls the pipeline behind it.</li>
    <li><b>Rate limiting:</b> the capacity is the rate limiter — blocking on a full buffer is back‑pressure propagating upstream, which is the correct behaviour and must not be "fixed" by growing the queue.</li>
    <li><b>Data sensitivity:</b> items pass through memory only and are never logged; a buffer that logs its contents for debugging quietly becomes a copy of whatever data flows through it.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> correctness is absolute — no lost item, no duplicated item, no deadlock, ever. This primitive sits under every worker pool, so a rare bug here surfaces as an inexplicable hang somewhere else entirely.</li>
    <li><b>Degraded mode:</b> on <code>close()</code>, producers fail fast while consumers drain and then see the closed signal — the asymmetry matters, because dropping buffered work on shutdown loses data that was already accepted. Timeouts give callers an escape from indefinite blocking without resorting to polling.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> all state transitions happen under one mutex, so every observer sees a consistent view. <code>size()</code> is inherently a snapshot and must be treated as advisory — deciding anything on it is a race by construction.</li>
    <li><b>Durability:</b> none, deliberately. This is in‑memory; a process crash loses buffered items, which is why anything requiring durability puts a persistent queue underneath rather than enlarging this one.</li>
    <li><b>Fairness:</b> no producer or consumer may starve indefinitely. Condition‑variable wakeups are not FIFO, so genuine fairness needs explicit ticketing — worth stating as a known limit rather than assumed.</li></ul></div>
</div>

## Interface and implementation {#bounded-buffer-api}

<p>BoundedBuffer(capacity) · put(item) · take() → item · close() · size(). Internals: ring buffer (deque), one mutex, not_full and not_empty condition variables, closed flag.</p>
<pre><code>import threading
from collections import deque

class BoundedBuffer:
    def __init__(self, capacity):
        self.cap = capacity
        self.q = deque()
        self.lock = threading.Lock()
        self.not_full = threading.Condition(self.lock)
        self.not_empty = threading.Condition(self.lock)
        self.closed = False

    def put(self, item, timeout=None):
        with self.not_full:                       # acquires self.lock
            while len(self.q) &gt;= self.cap and not self.closed:
                if not self.not_full.wait(timeout):   # False on timeout
                    raise TimeoutError
            if self.closed:
                raise RuntimeError("closed")
            self.q.append(item)
            self.not_empty.notify()               # exactly one consumer can proceed

    def take(self, timeout=None):
        with self.not_empty:
            while not self.q and not self.closed:
                if not self.not_empty.wait(timeout):
                    raise TimeoutError
            if not self.q:                        # closed and drained
                return None
            item = self.q.popleft()
            self.not_full.notify()                # exactly one producer can proceed
            return item

    def close(self):
        with self.lock:
            self.closed = True
            self.not_full.notify_all()            # wake everyone so they observe closed
            self.not_empty.notify_all()</code></pre>

## Design {#bounded-buffer-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/bounded-buffer/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Bounded buffer: producers wait on not_full, consumers wait on not_empty, both under one mutex guarding a ring buffer with a closed flag">
<defs><marker id="dg1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="dg3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#dg1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#dg3);stroke-dasharray:2 4}.lbl{font-size:10.5px;fill:#1F4E9E}</style>
<rect class="box" x="20" y="60" width="150" height="80"></rect><text class="tb" x="95" y="78" text-anchor="middle">Producers ×P</text>
<text class="ts" x="95" y="94" text-anchor="middle">put(item)</text>
<text class="ts" x="95" y="107" text-anchor="middle">block while full</text>
<text class="ts" x="95" y="120" text-anchor="middle">fail if closed</text>
<rect class="box" x="330" y="40" width="320" height="120" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="490" y="58" text-anchor="middle">BoundedBuffer</text>
<text class="ts" x="490" y="74" text-anchor="middle">mutex</text>
<text class="ts" x="490" y="87" text-anchor="middle">ring buffer [cap]</text>
<text class="ts" x="490" y="100" text-anchor="middle">not_full cond   not_empty cond</text>
<text class="ts" x="490" y="113" text-anchor="middle">closed flag</text>
<rect class="box" x="800" y="60" width="150" height="80"></rect><text class="tb" x="875" y="78" text-anchor="middle">Consumers ×C</text>
<text class="ts" x="875" y="94" text-anchor="middle">take()</text>
<text class="ts" x="875" y="107" text-anchor="middle">block while empty</text>
<text class="ts" x="875" y="120" text-anchor="middle">None when closed+drained</text>
<line class="f" x1="170" y1="90" x2="328" y2="90"></line>
<text class="lbl" x="249" y="84" text-anchor="middle">append; notify not_empty</text>
<line class="f" x1="650" y1="110" x2="798" y2="110"></line>
<text class="lbl" x="724" y="104" text-anchor="middle">popleft; notify not_full</text>
<line class="fa" x1="170" y1="120" x2="328" y2="120"></line>
<text class="lbl" x="249" y="114" text-anchor="middle">wait(not_full) while full</text>
<line class="fa" x1="650" y1="80" x2="798" y2="80"></line>
<text class="lbl" x="724" y="74" text-anchor="middle">wait(not_empty) while empty</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 508" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Put and take under contention">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="5" y="14" width="130" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Producer A</text>
<line class="ln" x1="70" y1="48" x2="70" y2="488"></line>
<rect class="sb" x="285" y="14" width="130" height="34"></rect><text class="st" x="350" y="36" text-anchor="middle">Producer B</text>
<line class="ln" x1="350" y1="48" x2="350" y2="488"></line>
<rect class="sb" x="565" y="14" width="130" height="34"></rect><text class="st" x="630" y="36" text-anchor="middle">Buffer (lock)</text>
<line class="ln" x1="630" y1="48" x2="630" y2="488"></line>
<rect class="sb" x="845" y="14" width="130" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Consumer X</text>
<line class="ln" x1="910" y1="48" x2="910" y2="488"></line>
<line class="a1" x1="78" y1="80" x2="622" y2="80"></line>
<text class="sl" x="350" y="74" text-anchor="middle">put: lock; len==cap → wait(not_full) (releases lock)</text>
<line class="a1" x1="358" y1="114" x2="622" y2="114"></line>
<text class="sl" x="490" y="108" text-anchor="middle">put: lock; also full → wait</text>
<line class="a1" x1="902" y1="148" x2="638" y2="148"></line>
<text class="sl" x="770" y="142" text-anchor="middle">take: lock; popleft; notify(not_full); unlock</text>
<line class="a2" x1="622" y1="182" x2="78" y2="182"></line>
<text class="sl" x="350" y="176" text-anchor="middle">A wakes, re-acquires lock, re-checks while</text>
<line class="a1" x1="78" y1="216" x2="622" y2="216"></line>
<text class="sl" x="350" y="210" text-anchor="middle">append; notify(not_empty); unlock</text>
<line class="a2" x1="622" y1="250" x2="358" y2="250"></line>
<text class="sl" x="490" y="244" text-anchor="middle">B still waiting (only one notified)</text>
<line class="a1" x1="902" y1="284" x2="638" y2="284"></line>
<text class="sl" x="770" y="278" text-anchor="middle">take: lock; queue empty → wait(not_empty)</text>
<line class="a1" x1="78" y1="318" x2="622" y2="318"></line>
<text class="sl" x="350" y="312" text-anchor="middle">put: append; notify(not_empty)</text>
<line class="a2" x1="638" y1="352" x2="902" y2="352"></line>
<text class="sl" x="770" y="346" text-anchor="middle">X wakes, takes item</text>
<rect class="nt" x="520" y="373" width="220" height="22"></rect><text class="sl" x="630" y="388" text-anchor="middle">close(): closed=True; notify_all both</text>
<line class="a1" x1="358" y1="420" x2="622" y2="420"></line>
<text class="sl" x="490" y="414" text-anchor="middle">B wakes: closed → raise</text>
<line class="a1" x1="902" y1="454" x2="638" y2="454"></line>
<text class="sl" x="770" y="448" text-anchor="middle">X: drains remaining, then gets None</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Producer A → Buffer (lock):</b> put: lock; len==cap → wait(not_full) (releases lock).
    The wait atomically releases the mutex and sleeps — that atomicity is the entire point of a condition variable and the reason this cannot be built from a mutex and a flag.
    Releasing the lock is what allows a consumer to make progress; a producer that slept holding the lock would deadlock the buffer instantly.
    The wait sits inside a <code>while</code>, not an <code>if</code>, which is the first of the two bugs interviewers are watching for.</li>
  <li><b>Producer B → Buffer (lock):</b> put: lock; also full → wait.
    Multiple waiters on the same condition are normal, and they are the exact reason <code>while</code> is required: B may be woken when the buffer is full again, and must re‑check rather than assume.
    Both producers are now asleep consuming no CPU — the design goal is that blocked threads cost nothing, not that they spin politely.</li>
  <li><b>Consumer X → Buffer (lock):</b> take: lock; popleft; notify(not_full); unlock.
    A single mutex guards every field, so the queue, the closed flag and both conditions can never be observed in disagreement.
    Notifying the <em>not_full</em> condition — the one whose predicate just became true — is what makes this correct. Notifying the wrong condition is the second classic bug and produces a deadlock with a full queue and sleeping producers.</li>
  <li><b>Buffer (lock) → Producer A:</b> A wakes, re-acquires lock, re-checks while (response).
    Waking is only permission to look again, never a guarantee the condition holds: another producer may have been scheduled first and refilled the slot.
    Re‑acquiring the lock before re‑checking is what keeps the check and the subsequent append indivisible.</li>
  <li><b>Producer A → Buffer (lock):</b> append; notify(not_empty); unlock.
    Having filled a slot, A signals the opposite condition, because it has just made <em>not_empty</em> true for some waiting consumer.
    Signalling while still holding the lock is fine and simplest; the woken thread simply waits for the lock to be released a moment later.</li>
  <li><b>Buffer (lock) → Producer B:</b> B still waiting (only one notified) (response).
    <code>notify()</code> wakes exactly one waiter, which is deliberate: one slot became free, so waking all producers would create a thundering herd where every thread wakes, contends for the lock, and all but one goes back to sleep.
    Waking one per available slot keeps contention proportional to real work.</li>
  <li><b>Consumer X → Buffer (lock):</b> take: lock; queue empty → wait(not_empty).
    The consumer side is the exact mirror of the producer side, which is what makes the implementation easy to verify by inspection.
    Symmetry here is worth more than cleverness — asymmetric fast paths are where subtle lost‑wakeup bugs live.</li>
  <li><b>Producer A → Buffer (lock):</b> put: append; notify(not_empty).
    Because the notify happens under the same lock that the consumer must hold to check its predicate, there is no window in which an item is added while a consumer is between checking and sleeping.
    Closing that window is precisely what a lost wakeup is, and the single‑mutex design makes it impossible.</li>
  <li><b>Buffer (lock) → Consumer X:</b> X wakes, takes item (response).
    X re‑checks in its <code>while</code>, finds an item, removes it and notifies <em>not_full</em> — the cycle is symmetric and self‑sustaining.</li>
  <li><b>Buffer (lock):</b> close(): closed=True; notify_all both.
    Shutdown is the one place <code>notify_all</code> is right: every waiter's predicate has changed, and no number of single notifications would reach them all.
    Setting the flag under the same lock means no thread can be between checking <code>closed</code> and sleeping when it flips.
    Without this, closing a buffer with blocked threads leaves them asleep forever — a hang at shutdown that is maddening to diagnose.</li>
  <li><b>Producer B → Buffer (lock):</b> B wakes: closed → raise.
    Producers fail fast, because accepting an item into a closing buffer promises delivery that will not happen.
    Raising rather than silently dropping is the honest contract: the caller still holds the item and can decide what to do with it.</li>
  <li><b>Consumer X → Buffer (lock):</b> X: drains remaining, then gets None.
    Consumers drain before seeing closed, which is the deliberate asymmetry: items already accepted are already someone's responsibility and must not be discarded.
    The terminal <code>None</code> is distinguishable from "no item yet", so worker loops exit cleanly instead of spinning on an empty closed buffer.
    Drain‑then‑close is what makes this primitive safe to use under a worker pool that must shut down without losing work.</li>
</ol>

## Deep dives {#bounded-buffer-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/bounded-buffer/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
<div><h4>Why two conditions on one lock</h4><ul><li>One lock guards the whole invariant (queue contents + closed). Two conditions let you wake the right side: a put wakes a consumer, a take wakes a producer. A single condition with <code>notify_all</code> works but thunders.</li><li><code>notify()</code> not <code>notify_all()</code> for the normal path: one item admits exactly one waiter. <code>notify_all()</code> only on close.</li><li>Always <code>while</code>, never <code>if</code>: another thread may consume the slot between the notify and your wake, and spurious wakeups exist.</li></ul></div>
<div><h4>Alternatives and language notes</h4><ul><li>Two semaphores (slots, items) + a mutex is the classic textbook form; equivalent, harder to add close/timeouts.</li><li>Java: <code>ArrayBlockingQueue</code> already does this; be able to write it with <code>ReentrantLock</code> + two <code>Condition</code>s. Go: buffered channel is the primitive; <code>close(ch)</code> gives the drain semantics.</li><li>Lock‑free ring buffers (Disruptor) for single producer/consumer at millions/s; not needed unless asked.</li></ul></div>
<div><h4>Edge cases to name</h4><ul><li>Capacity 0 (rendezvous) needs handoff semantics; say you'd require cap ≥ 1.</li><li>Fairness: Python conditions are FIFO‑ish; if strict fairness matters, ticket the waiters.</li><li>Backpressure is the feature: a full buffer is how consumers slow producers; unbounded queues just move the OOM later.</li><li>Test: N producers × M items, N consumers, assert multiset equality and no deadlock with a watchdog timeout.</li></ul></div></div>


## Trade-offs {#bounded-buffer-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Locking</td><td>One mutex with two condition variables</td><td>Throughput ceiling — all producers and consumers serialise on one lock</td><td>Shard into N buffers, or move to a lock‑free ring, past a few million ops/s; below that the added complexity buys nothing</td></tr>
  <tr><td>Wakeup strategy</td><td><code>notify()</code> for items, <code>notify_all()</code> only on close</td><td>Slightly more care about which condition to signal</td><td><code>notify_all</code> everywhere is safer against a signalling bug but causes a thundering herd on every single operation</td></tr>
  <tr><td>Capacity</td><td>Bounded, blocking when full</td><td>Producers stall instead of running ahead</td><td>An unbounded queue never blocks and instead converts back‑pressure into unbounded memory growth and an eventual crash</td></tr>
  <tr><td>Shutdown</td><td>Producers raise; consumers drain then stop</td><td>Close is not instant — it waits for the buffer to empty</td><td>Discarding on close is faster but loses items the buffer already accepted, which callers reasonably assume are safe</td></tr>
  <tr><td>Blocking model</td><td>Condition variables, never spinning</td><td>A context switch per block, which costs microseconds</td><td>Spinning wins only for extremely short, predictable waits on dedicated cores; here it would burn CPU other threads need</td></tr>
  <tr><td>Fairness</td><td>Whatever the condition variable gives</td><td>No FIFO guarantee — a thread can be repeatedly passed over</td><td>Add explicit ticketing when starvation is observed; it costs throughput, so only pay for it when needed</td></tr>
  <tr><td>Observability</td><td><code>size()</code> as an advisory snapshot</td><td>Callers may misuse it as a decision input</td><td>There is no way to make it authoritative without holding the lock across the caller's decision, which defeats the purpose</td></tr>
</tbody></table>

## Safety-first design {#bounded-buffer-safety}

<div class="cards">
  <div><h4>The two bugs that define this question</h4><ul>
    <li><b><code>while</code>, never <code>if</code>.</b> A wakeup is permission to re‑check, not proof the predicate holds — spurious wakeups and multiple waiters both break the <code>if</code> version.</li>
    <li><b>Notify the condition you made true.</b> Signalling the wrong one produces a deadlock with a full queue and sleeping producers, which looks like a hang with no obvious cause.</li>
    <li><b>One mutex for all state.</b> Queue, closed flag and both conditions under one lock means there is no window in which a thread checks a predicate and then sleeps through the notification.</li>
    <li><b>Never sleep holding the lock.</b> The condition variable's atomic release‑and‑wait is exactly what makes that impossible here.</li></ul></div>
  <div><h4>Back-pressure is the feature</h4><ul>
    <li><b>The bound is a safety limit.</b> Blocking a fast producer is how memory pressure is prevented; growing the queue to avoid blocking converts a stall into a crash.</li>
    <li><b>Back-pressure propagates.</b> A blocked producer slows whatever feeds it, which is how the whole pipeline finds its natural rate without a central controller.</li>
    <li><b>Timeouts, not polling.</b> A caller that cannot block forever gets a bounded wait, so escaping a stall never requires a busy loop.</li>
    <li><b>Keep the critical section tiny.</b> No allocation, no I/O, no logging under the lock — expensive work inside the mutex is what turns a fine design into a bottleneck.</li></ul></div>
  <div><h4>Shutdown without losing work</h4><ul>
    <li><b>Wake everyone exactly once.</b> <code>notify_all</code> on close is the one correct use, because every waiter's predicate changed simultaneously.</li>
    <li><b>Producers fail, consumers drain.</b> The asymmetry is deliberate: refuse new work, but never discard work already accepted.</li>
    <li><b>A distinct terminal signal.</b> "Closed and empty" must be distinguishable from "empty for now", or worker loops spin instead of exiting.</li>
    <li><b>No item lost, no item twice.</b> Every transition happens under the lock, so an item is either in the queue or with exactly one consumer — never both, never neither.</li></ul></div>
</div>

## Don't leave the room without saying {#bounded-buffer-check}

<ul class="checklist">
  <li>One mutex, two condition variables, ring buffer</li>
  <li>while‑loop around wait; notify one on put/take, notify_all on close</li>
  <li>Closed semantics: producers fail, consumers drain then None</li>
  <li>Timeouts return cleanly; no busy‑wait</li>
  <li>Why bounded = backpressure</li>
  <li>How to test for lost items and deadlock</li>
</ul>

## What each level is expected to drive {#bounded-buffer-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Correct blocking put/take with one lock and conditions</td><td>Close semantics, timeouts</td></tr>
  <tr><td>Senior</td><td>Clean close/drain, timeouts, fairness discussion, semaphore alternative, language primitives</td><td>Lock‑free variants</td></tr>
  <tr><td>Staff+</td><td>Reasons about memory model and spurious wakeups precisely, relates it to worker pools and backpressure across the system, testing strategy</td><td>—</td></tr>
</tbody></table>
