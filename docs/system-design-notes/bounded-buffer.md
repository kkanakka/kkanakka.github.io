---
title: "Thread‑safe producer‑consumer buffer"
slug: /system-design-notes/bounded-buffer
sidebar_position: 29
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
  <li><b>Producer A → Buffer (lock):</b> put: lock; len==cap → wait(not_full) (releases lock)</li>
  <li><b>Producer B → Buffer (lock):</b> put: lock; also full → wait</li>
  <li><b>Consumer X → Buffer (lock):</b> take: lock; popleft; notify(not_full); unlock</li>
  <li><b>Buffer (lock) → Producer A:</b> A wakes, re-acquires lock, re-checks while (response)</li>
  <li><b>Producer A → Buffer (lock):</b> append; notify(not_empty); unlock</li>
  <li><b>Buffer (lock) → Producer B:</b> B still waiting (only one notified) (response)</li>
  <li><b>Consumer X → Buffer (lock):</b> take: lock; queue empty → wait(not_empty)</li>
  <li><b>Producer A → Buffer (lock):</b> put: append; notify(not_empty)</li>
  <li><b>Buffer (lock) → Consumer X:</b> X wakes, takes item (response)</li>
  <li><b>Buffer (lock):</b> close(): closed=True; notify_all both</li>
  <li><b>Producer B → Buffer (lock):</b> B wakes: closed → raise</li>
  <li><b>Consumer X → Buffer (lock):</b> X: drains remaining, then gets None</li>
</ol>

## Deep dives {#bounded-buffer-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/bounded-buffer/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
<div><h4>Why two conditions on one lock</h4><ul><li>One lock guards the whole invariant (queue contents + closed). Two conditions let you wake the right side: a put wakes a consumer, a take wakes a producer. A single condition with <code>notify_all</code> works but thunders.</li><li><code>notify()</code> not <code>notify_all()</code> for the normal path: one item admits exactly one waiter. <code>notify_all()</code> only on close.</li><li>Always <code>while</code>, never <code>if</code>: another thread may consume the slot between the notify and your wake, and spurious wakeups exist.</li></ul></div>
<div><h4>Alternatives and language notes</h4><ul><li>Two semaphores (slots, items) + a mutex is the classic textbook form; equivalent, harder to add close/timeouts.</li><li>Java: <code>ArrayBlockingQueue</code> already does this; be able to write it with <code>ReentrantLock</code> + two <code>Condition</code>s. Go: buffered channel is the primitive; <code>close(ch)</code> gives the drain semantics.</li><li>Lock‑free ring buffers (Disruptor) for single producer/consumer at millions/s; not needed unless asked.</li></ul></div>
<div><h4>Edge cases to name</h4><ul><li>Capacity 0 (rendezvous) needs handoff semantics; say you'd require cap ≥ 1.</li><li>Fairness: Python conditions are FIFO‑ish; if strict fairness matters, ticket the waiters.</li><li>Backpressure is the feature: a full buffer is how consumers slow producers; unbounded queues just move the OOM later.</li><li>Test: N producers × M items, N consumers, assert multiset equality and no deadlock with a watchdog timeout.</li></ul></div></div>

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
