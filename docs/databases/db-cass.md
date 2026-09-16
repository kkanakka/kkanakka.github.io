---
title: "Cassandra"
slug: /databases/db-cass
sidebar_position: 3
sidebar_label: "Cassandra"
description: "Cassandra"
---
<p>Apple runs one of the largest Cassandra fleets in the world, and CloudKit's history is tied to it. Expect questions here to be practical.</p>

## Topology and data placement

<!-- DIAGRAM:ring:START -->

<img src="/diagrams/db-cass/ring.svg" alt="Ring, tokens and replica placement" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:ring:END -->

<p>Cassandra is masterless: every node is a peer, membership and state spread by <strong>gossip</strong>, topology learned from a <strong>snitch</strong>. The partition key is hashed (Murmur3) to a token on a ring; each node owns many small ranges (<strong>vnodes</strong>), and <code>NetworkTopologyStrategy</code> places <strong>RF</strong> replicas per data center on distinct racks where possible. Any node can coordinate a request: it forwards to the replicas and waits for the number required by the consistency level.</p>

## Data model rules

<p>Queries must specify the partition key; clustering columns define order within the partition and allow ranges on them; there are no joins, so you denormalize into one table per query pattern. A partition lives on RF nodes in full, so a partition that grows without bound (all events for a tenant, all rows for a date) becomes a <strong>wide partition</strong> that is slow to read, slow to compact, and hot on three nodes; bucket it (tenant + day). A key with low cardinality or time-ordered values creates <strong>hotspots</strong>. Secondary indexes are local to each node and scatter reads; use them rarely. Lightweight transactions (<code>IF NOT EXISTS</code>) run Paxos with four round trips; use them for uniqueness, not for throughput paths.</p>

## Write and read paths

<!-- DIAGRAM:paths:START -->

<img src="/diagrams/db-cass/paths.svg" alt="Write path and read path" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:paths:END -->

<p>A write appends to the <strong>commitlog</strong> (fsynced periodically, 10 s by default, or per batch) and updates an in-memory <strong>memtable</strong>; memtables flush to immutable <strong>SSTables</strong>; <strong>compaction</strong> merges SSTables and discards overwritten or expired data. Reads merge the memtable with every SSTable that might hold the partition, pruned by bloom filters and the partition index. Read latency therefore tracks SSTable count per read, which is what compaction strategy controls: <strong>STCS</strong> (size-tiered) suits write-heavy tables but needs up to 50% free disk for a major compaction; <strong>LCS</strong> (leveled) bounds SSTables per read for read-heavy workloads at the cost of more compaction I/O; <strong>TWCS</strong> (time-window) is for time-series with TTL, so whole windows expire by dropping files.</p>

## Consistency, repair, tombstones

<!-- DIAGRAM:tombstones:START -->

<img src="/diagrams/db-cass/tombstones.svg" alt="Tombstones and why deletes hurt reads" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:tombstones:END -->

<p>Consistency is chosen per query: <code>ONE</code>, <code>LOCAL_ONE</code>, <code>QUORUM</code> (⌊RF/2⌋+1 across all DCs), <code>LOCAL_QUORUM</code> (in the coordinator's DC), <code>EACH_QUORUM</code>, <code>ALL</code>. Reads are strongly consistent when <strong>R + W &gt; RF</strong>; the standard production choice is RF=3 per DC with <code>LOCAL_QUORUM</code> for both, which tolerates one replica down per DC without losing consistency or availability. Three mechanisms reconcile replicas: <strong>hinted handoff</strong> (the coordinator stores a hint for a down replica and replays it when the node returns, within <code>max_hint_window</code>, 3 hours by default), <strong>read repair</strong> (fix mismatches noticed during reads), and <strong>anti-entropy repair</strong> (<code>nodetool repair</code>, Merkle-tree comparison of full ranges), which you must run on every node within <strong><code>gc_grace_seconds</code></strong> (10 days by default). The reason is <strong>tombstones</strong>: a delete is a write of a marker that must reach every replica before compaction is allowed to purge it; purge it early on one replica and a node that missed the delete will "resurrect" the data on the next read repair. Tombstones also make reads slow: a partition with a million deleted rows is scanned through them, warnings appear at <code>tombstone_warn_threshold</code> and reads fail at <code>tombstone_failure_threshold</code> (100,000). Using Cassandra as a queue (insert, read, delete) is the canonical anti-pattern.</p>

## Operating it

<pre><code>nodetool status            <span class="ic-c"># UN/DN per node, load, token ownership; a DN is a replica you're not writing to</span>
nodetool tpstats           <span class="ic-c"># thread pools: pending and DROPPED mutations/reads = overload</span>
nodetool tablestats ks.t   <span class="ic-c"># SSTable count, partition size max/mean, tombstones per read, latency</span>
nodetool compactionstats   <span class="ic-c"># backlog; pending compactions growing = falling behind</span>
nodetool netstats          <span class="ic-c"># streaming during bootstrap/repair/decommission</span>
nodetool repair -pr        <span class="ic-c"># primary range repair, scheduled (Reaper); never let it lapse past gc_grace</span>
nodetool cleanup           <span class="ic-c"># after adding nodes, drop data no longer owned</span>
nodetool decommission | removenode &lt;id&gt;     <span class="ic-c"># graceful leave vs dead node removal</span>
nodetool snapshot          <span class="ic-c"># hard-linked SSTable backup</span></code></pre>
<p>Failure signatures: dropped mutations mean the node can't keep up (GC pauses, disk latency, too-large batches); a coordinator timeout (<code>read_request_timeout</code> 5 s, write 2 s) with healthy nodes often points to a wide partition or tombstones; long JVM stop-the-world pauses show as nodes flapping DN/UN in gossip; compaction backlog plus disk above 50% means a major compaction may not fit; a node down longer than <code>max_hint_window</code> needs a repair when it returns; clock skew between nodes corrupts last-write-wins resolution, so NTP is not optional.</p>
