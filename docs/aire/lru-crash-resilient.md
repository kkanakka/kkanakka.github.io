---
title: "Crash-resilient LRU cache"
slug: /aire/lru-crash-resilient
sidebar_position: 27
sidebar_label: "Crash-resilient LRU cache"
description: "hard · Anthropic · O(1) get/put · durability without losing O(1) · WAL · snapshot + replay"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/lru-crash-resilient/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">hard · Anthropic · O(1) get/put · durability without losing O(1) · WAL · snapshot + replay</span>
</header>
<p>Start from the standard in‑memory LRU — a hash map plus a doubly linked list, both operations O(1) — and make it survive a process crash. The tension is the whole question: durability means writing to disk, disk writes are not O(1) in any useful sense, and an LRU mutates on <em>reads</em>, so even a pure lookup dirties state.</p>

## Requirements {#lru-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li><code>get(key)</code> and <code>put(key, value)</code>, both O(1) amortized</li>
      <li>Fixed capacity N; least‑recently‑used eviction</li>
      <li>After a crash, restart with contents and eviction order intact (or acceptably close)</li>
      <li>Bounded recovery time, independent of how long the process ran</li>
      <li class="out">Distribution, replication, TTLs</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Steady‑state throughput within a small factor of the pure in‑memory cache</li>
      <li>A crash must never produce a corrupt or partially applied entry</li>
      <li>Disk footprint bounded — never a full history of every access</li>
      <li>Explicit, stated durability guarantee (what exactly can be lost)</li>
    </ol>
  </div>
</div>
<div class="trap"><b>The trap:</b> "make it durable" sounds like "write every operation to disk". A cache at a million ops/s would then need a million fsyncs per second, and <code>get</code> — which reorders the list — would become a write. The answer is to decide what actually has to survive: the <em>contents</em> are worth persisting, the exact recency order mostly is not.</div>

## Scale, performance and safety targets {#lru-targets}

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> 100K–1M operations/s on a single process, with a read‑heavy mix — typically 90%+ <code>get</code>. That ratio is the key fact: the common operation is the one that is awkward to persist.</li>
    <li><b>Data volume:</b> capacity N of 1–10M entries at ~1 KB each — a few GB in memory. The WAL must be bounded by compaction, not by uptime, or a long‑running process fills the disk.</li>
    <li><b>Growth:</b> capacity grows with memory, and recovery time grows with capacity — so the snapshot mechanism must stay proportional to N rather than to the number of operations performed.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> <code>get</code> p99 &lt; 1 µs from memory; <code>put</code> p99 &lt; 10 µs with an async log append, or ~1 ms if every write is fsynced — a thousandfold difference that is precisely the durability knob.</li>
    <li><b>Throughput:</b> recovery must be bounded: snapshot load plus a bounded WAL tail, targeting seconds rather than minutes, and independent of how long the process had been running.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the hazards are internal. An unbounded WAL fills the disk and takes the host down with it; a torn write produces a silently corrupt entry; and a key or value with no size limit lets one caller consume the whole cache.</li>
    <li><b>Rate limiting:</b> cap key and value sizes, cap the WAL by triggering compaction on size rather than on time, and reserve disk headroom so the log can always be written during recovery.</li>
    <li><b>Data sensitivity:</b> persisting a cache turns transient memory into durable data on disk, which changes its handling entirely. Cached values may be user data — encrypt the snapshot and WAL at rest, and make sure eviction and deletion actually remove the entry from disk, not just from memory.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> a cache is allowed to be empty — correctness never depends on a hit. That is what makes a relaxed durability guarantee acceptable here and unacceptable in a database.</li>
    <li><b>Degraded mode:</b> corrupt WAL tail → truncate at the last valid checksummed record and continue. Snapshot unreadable → start empty and warm from the origin, which is slower but always correct. Disk full → keep serving from memory and alarm, since losing durability is far better than losing the cache.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>The durability guarantee, stated precisely:</b> "entries acknowledged more than X milliseconds ago survive a crash; recency ordering is approximate after recovery." Vagueness here is the main way this question is failed.</li>
    <li><b>Consistency:</b> every persisted record is all‑or‑nothing, enforced by a checksum per record, so recovery never applies half an entry.</li>
    <li><b>What recovery is for:</b> avoiding a cold‑start thundering herd on the origin. That is the actual business reason, and it tells you how much order fidelity is worth paying for — very little.</li></ul></div>
</div>

## Entities and API {#lru-api}

<p>Entry (key, value, node pointer) · HashMap (key → node) · DoublyLinkedList (MRU head, LRU tail) · WAL (append‑only records: PUT, DELETE, EVICT, CHECKPOINT) · Snapshot (full contents + approximate order, sequence number) · Compactor.</p>
<pre><code>get(key)   -&gt; value | miss      # O(1): map lookup, move node to head. No disk write.
put(k, v)  -&gt; void              # O(1): map insert + head insert (+ tail evict); append to WAL
delete(k)  -&gt; void              # O(1): unlink + map erase; append tombstone

WAL record: {seq, op, key, valueLen, value, crc32}    # crc makes a torn tail detectable
Snapshot:   {seq, entries[] in LRU order}             # written by the compactor, atomically renamed
Recovery:   load newest valid snapshot -&gt; replay WAL records with seq &gt; snapshot.seq</code></pre>

## Design {#lru-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/lru-crash-resilient/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

### Flow between components

<ol class="order">
  <li><b>Caller → Cache:</b> get(key).
    The map lookup finds the node in O(1) and the node is moved to the head of the list, also O(1) because the node holds its own pointers.
    That pointer from the map to the <em>node</em> — rather than to a position — is the entire reason both operations are constant time, and it is worth stating before anything about durability.</li>
  <li><b>Cache:</b> move node to head — a read mutates state.
    This is the awkward fact the question is built on: in an LRU, reads are writes to the recency order.
    Persisting that faithfully would mean a disk write on every <code>get</code>, which at a 90% read mix means persisting almost every operation.
    So the design decision is made here: recency order is <em>not</em> durable, only contents are.</li>
  <li><b>Cache → Caller:</b> value (response).
    The read path touches no disk at all, which is what preserves in‑memory throughput.
    The cost is that recovered ordering is approximate — and since a cache is allowed to evict anything at any time, that costs a few extra misses and nothing else.</li>
  <li><b>Caller → Cache:</b> put(key, value).
    Insert into the map, push a node at the head, and evict from the tail if over capacity — three O(1) operations.
    The in‑memory structure is updated first so the caller's latency does not depend on the disk.</li>
  <li><b>Cache → WAL:</b> append {seq, PUT, key, value, crc}.
    Append‑only is what keeps persistence O(1)‑ish: a sequential write with no seek, no tree rebalance, no random I/O.
    The sequence number orders recovery and the CRC is what makes a torn tail detectable rather than silently corrupt.
    Only mutations are logged — <code>put</code>, <code>delete</code>, <code>evict</code> — so the log volume follows the write rate, not the much larger total operation rate.</li>
  <li><b>WAL:</b> buffered write; fsync policy decides the guarantee.
    This is the single knob that defines durability, and it has three settings worth naming.
    Fsync per write gives "nothing acknowledged is ever lost" at roughly 1 ms per operation — a thousandfold slowdown. Fsync every N milliseconds gives "at most N ms of writes lost" at close to memory speed. No fsync gives OS‑buffer durability, which survives a process crash but not a machine crash.
    For a cache, group commit every few milliseconds is almost always right — but the guarantee must be written down, not left implied.</li>
  <li><b>Cache → Caller:</b> ack (response).
    Acknowledging after the buffered append, not after the fsync, is what keeps <code>put</code> in the microsecond range.
    The honest statement of the contract is "acknowledged means in the log buffer and durable within the flush interval".</li>
  <li><b>Cache:</b> over capacity → evict tail; append EVICT record.
    Eviction is logged because otherwise recovery would resurrect entries the cache had already dropped, and the recovered set could exceed capacity.
    The tail node is reachable in O(1) from the list, which is why a doubly linked list is used rather than anything ordered.</li>
  <li><b>Compactor → Snapshot:</b> periodically write full contents in LRU order; record seq.
    A snapshot bounds recovery: without one, replay time grows with uptime and eventually takes longer than the cache is worth.
    Writing entries in current LRU order is what lets recovery restore an approximately correct order for free.
    The snapshot is written to a temporary file and atomically renamed, so a crash mid‑snapshot leaves the previous one intact rather than a half‑written file.</li>
  <li><b>Compactor → WAL:</b> truncate records below the snapshot's seq.
    This is what keeps the disk footprint bounded by capacity rather than by uptime — without it, a long‑running cache fills the disk and takes the host with it.
    Truncation happens only after the snapshot is durably renamed, so there is never a window where neither copy is complete.</li>
  <li><b>Crash → Recovery:</b> load the newest valid snapshot.
    Recovery starts from the snapshot rather than from the beginning of time, making startup proportional to capacity instead of to history.
    If the snapshot fails its checksum, fall back to the previous one — and if none is valid, start empty, because a cache that starts cold is correct, just slower.</li>
  <li><b>Recovery → WAL:</b> replay records with seq &gt; snapshot.seq; stop at the first bad CRC.
    The tail of a log after a crash is routinely a partial record, and the CRC is what turns that from silent corruption into a clean truncation point.
    Replay is idempotent — applying a PUT twice is harmless — which is what makes crash‑during‑recovery survivable too.
    Replaying only the tail is what keeps recovery in seconds.</li>
  <li><b>Recovery → Cache:</b> rebuild map and list; order approximate, contents exact.
    Contents are exactly what was durable; ordering is snapshot order refreshed by whatever the replayed tail touched.
    This is the trade made in step three finally paying off: the expensive guarantee was dropped, the cheap and valuable one was kept.
    Stating the resulting guarantee explicitly — contents exact within the flush interval, order approximate — is what separates a good answer from a hand‑wave.</li>
  <li><b>Cache → Origin:</b> misses after recovery repopulate normally.
    Any entry lost within the flush window is simply a miss, and a miss is always correct — which is the property that makes a relaxed guarantee acceptable here at all.
    The point of persistence was never correctness; it was avoiding a cold‑start stampede against the origin, and a warm‑but‑imperfect cache achieves that completely.</li>
</ol>

## How it works, step by step {#lru-flow}

<ol class="order">
  <li>In memory, a hash map points at nodes in a doubly linked list; <code>get</code> moves a node to the head and <code>put</code> inserts at the head and evicts from the tail, all O(1).</li>
  <li>Mutations — put, delete, evict — are appended to a WAL with a sequence number and a CRC; reads write nothing, so recency order is deliberately not durable.</li>
  <li>An fsync policy (per write, group commit every few ms, or none) sets the durability guarantee, which is stated rather than implied.</li>
  <li>A compactor periodically writes a full snapshot in LRU order, renames it atomically, then truncates the WAL below its sequence number.</li>
  <li>Recovery loads the newest valid snapshot and replays the WAL tail, stopping at the first bad CRC.</li>
  <li>Contents come back exact within the flush window; order comes back approximate; anything lost is a miss, and a miss is always correct.</li>
</ol>

## Deep dives {#lru-deep}

<div class="cards">
  <div><h4>Why the classic structure is O(1)</h4><ul>
    <li>The hash map stores a pointer to the <em>node</em>, not to a position, so unlinking and relinking are pointer updates rather than searches.</li>
    <li>A doubly linked list gives O(1) removal from the middle, which a singly linked list does not — that is the whole reason for the extra pointer.</li>
    <li>The tail is the LRU entry by construction, so eviction is O(1) with no scan and no ordering structure.</li>
    <li>Everything about durability has to preserve these properties, which is what rules out any design that sorts, seeks or rebalances on the hot path.</li></ul></div>
  <div><h4>Choosing what to persist</h4><ul>
    <li>Persisting every access makes reads into writes and multiplies disk traffic by ten in a read‑heavy workload.</li>
    <li>Persisting only mutations follows the write rate, which is typically under 10% of operations.</li>
    <li>Order is recoverable "well enough" from snapshot order plus the replayed tail — and a cache may evict anything at any time regardless.</li>
    <li>Cost of being wrong: a few extra misses. That asymmetry is the justification, and it should be stated rather than assumed.</li></ul></div>
  <div><h4>Snapshot plus log, and why both</h4><ul>
    <li>Log alone: recovery time grows without bound with uptime, and the disk fills.</li>
    <li>Snapshot alone: everything since the last snapshot is lost, so the guarantee is only as good as the snapshot interval.</li>
    <li>Together: recovery is bounded by capacity plus a bounded tail, and the loss window is the flush interval.</li>
    <li>Atomic rename plus truncate‑after‑durable is what makes the handoff between them crash‑safe.</li></ul></div>
</div>

## Trade-offs {#lru-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>What is durable</td><td>Contents, not recency order</td><td>Exact eviction order after recovery</td><td>Persisting order means a disk write per <code>get</code>; only worth it if eviction order is itself a correctness requirement, which for a cache it is not</td></tr>
  <tr><td>Fsync policy</td><td>Group commit every few milliseconds</td><td>Up to one flush interval of acknowledged writes</td><td>Fsync per write when the cache is authoritative for something; it costs roughly 1,000× on write latency</td></tr>
  <tr><td>On-disk format</td><td>Append‑only WAL plus periodic snapshot</td><td>A compactor to run and two formats to maintain</td><td>An mmap'd file updated in place avoids both and makes partial writes and torn pages your problem instead</td></tr>
  <tr><td>Recovery bound</td><td>Snapshot plus bounded tail</td><td>Snapshot I/O during steady state</td><td>Log‑only is simpler and makes startup time a function of uptime, which eventually exceeds the value of the cache</td></tr>
  <tr><td>Corruption handling</td><td>CRC per record, truncate at the first bad one</td><td>A few records at the tail</td><td>Never skip and continue past a bad record — the log's order is what makes replay meaningful</td></tr>
  <tr><td>Eviction logging</td><td>Log evictions explicitly</td><td>Extra log volume</td><td>Inferring evictions at recovery from capacity is possible and makes the recovered set depend on replay order</td></tr>
  <tr><td>Durability at all</td><td>Persist, to avoid a cold‑start stampede</td><td>Disk, a compactor, and a real crash‑safety story</td><td>A pure in‑memory cache is far simpler and correct — persist only when the origin cannot absorb a cold start</td></tr>
</tbody></table>

## Safety-first design {#lru-safety}

<div class="cards">
  <div><h4>A crash must never corrupt</h4><ul>
    <li><b>CRC per record.</b> The tail of a log after a crash is routinely a partial write; the checksum turns silent corruption into a clean truncation point.</li>
    <li><b>Atomic snapshot rename.</b> Write to a temporary file and rename, so a crash mid‑snapshot leaves the previous complete one rather than a half‑written file.</li>
    <li><b>Truncate only after durable.</b> The WAL is trimmed only once the new snapshot is safely on disk, so there is never a moment with neither complete copy.</li>
    <li><b>Idempotent replay.</b> Applying a record twice is harmless, which makes a crash during recovery survivable too.</li></ul></div>
  <div><h4>State the guarantee, do not imply it</h4><ul>
    <li><b>Name the loss window.</b> "At most one flush interval of acknowledged writes" is a contract; "it's durable" is not.</li>
    <li><b>Name what is approximate.</b> Recovered ordering is best‑effort, and anyone depending on strict LRU semantics after a crash should know that.</li>
    <li><b>Acknowledge honestly.</b> If the ack happens before the fsync, the contract is buffer durability — saying otherwise is the actual bug.</li>
    <li><b>Misses are always correct.</b> The reason a relaxed guarantee is acceptable, and the sentence that justifies the entire design.</li></ul></div>
  <div><h4>Persistence turns memory into data</h4><ul>
    <li><b>Bound the disk.</b> Compaction triggered by log size, not by time, so a write burst cannot fill the disk and take the host down.</li>
    <li><b>Reserve headroom.</b> Recovery itself needs to write; a disk that is 100% full turns a restart into a permanent outage.</li>
    <li><b>Encrypt at rest.</b> Cached values are often user data, and persisting them creates a durable copy that did not exist before.</li>
    <li><b>Delete means delete on disk.</b> Eviction and deletion must not leave the value readable in the snapshot or the log tail.</li></ul></div>
</div>

## Don't leave the room without saying {#lru-check}

<ul class="checklist">
  <li>Map → node pointers plus a doubly linked list is what makes both operations O(1)</li>
  <li>An LRU mutates on reads, so naive durability turns every <code>get</code> into a disk write</li>
  <li>Persist contents, not recency order — and justify it with "a miss is always correct"</li>
  <li>Append‑only WAL with sequence numbers and a CRC per record</li>
  <li>Fsync policy <em>is</em> the durability guarantee: per write, group commit, or none</li>
  <li>Snapshot plus truncate bounds both recovery time and disk usage</li>
  <li>Atomic rename, truncate‑after‑durable, truncate at the first bad CRC, idempotent replay</li>
  <li>State the guarantee precisely, including the loss window and the approximate ordering</li>
</ul>

## What each level is expected to drive {#lru-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Hash map plus doubly linked list; write the cache to a file periodically</td><td>Why reads are writes, what fsync costs</td></tr>
  <tr><td>Senior</td><td>WAL plus snapshot, sequence numbers and CRCs, fsync policy as the guarantee, bounded recovery, atomic rename</td><td>Eviction logging, compaction triggers, corruption handling</td></tr>
  <tr><td>Staff+</td><td>Explicitly choosing what not to persist and justifying it, a precisely stated durability contract, disk‑full and torn‑write failure modes, and whether persistence is warranted at all</td><td>—</td></tr>
</tbody></table>
