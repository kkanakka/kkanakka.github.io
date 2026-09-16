---
title: "FoundationDB"
slug: /databases/db-fdb
sidebar_position: 4
sidebar_label: "FoundationDB"
description: "FoundationDB"
---

<!-- DIAGRAM:sequence:START -->

## A transaction, end to end

<img src="/diagrams/db-fdb/sequence.svg" alt="A transaction, end to end" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<!-- DIAGRAM:architecture:START -->

## Architecture

<img src="/diagrams/db-fdb/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->
<p>Apple acquired FoundationDB in 2015 and open-sourced it in 2018; CloudKit is built on it through the <strong>Record Layer</strong>. FoundationDB is an ordered key-value store with full ACID transactions that are strictly serializable across any set of keys, using optimistic concurrency: a transaction reads at a snapshot version, buffers writes, and at commit the <strong>resolvers</strong> check whether any key it read was written by a transaction that committed after its read version; if so it fails with <code>not_committed</code> and the client retries. The limits shape everything built on it: a transaction may run at most <strong>5 seconds</strong> (beyond which <code>transaction_too_old</code>), write at most <strong>10 MB</strong>, keys up to 10 KB, values up to 100 KB. Everything with a richer data model (records, indexes, documents) is a <strong>layer</strong> implemented by clients on top of the key space; the Record Layer adds Protobuf-defined records, secondary indexes maintained transactionally, and schema evolution, all of which is why CloudKit can offer multi-tenant, per-user databases at scale.</p>

## Roles inside a cluster

<ul>
<li><strong>Coordinators</strong>: a small Paxos group holding cluster configuration and electing the cluster controller; you need a majority of them.</li>
<li><strong>Cluster controller</strong>: recruits every other role and monitors processes.</li>
<li><strong>Sequencer</strong> (master): hands out monotonically increasing commit versions.</li>
<li><strong>GRV proxies</strong> and <strong>commit proxies</strong>: give clients read versions and take commits, batching them.</li>
<li><strong>Resolvers</strong>: conflict detection over key ranges.</li>
<li><strong>Transaction logs (tlogs)</strong>: make committed mutations durable on disk, replicated (triple by default); the durability point of the system.</li>
<li><strong>Storage servers</strong>: hold the data, serve reads, and pull mutations from the tlogs, applying them with a ~5-second MVCC window (the origin of the transaction time limit).</li>
<li><strong>Data distributor</strong>: splits and moves shards to balance load and repair replication. <strong>Ratekeeper</strong>: measures storage and tlog queues and throttles the rate at which read versions are handed out when the cluster falls behind.</li>
</ul>
<p>When a tlog, proxy, or sequencer fails, the cluster performs a <strong>recovery</strong>: a new generation of transaction subsystem is recruited in a few seconds, during which commits pause; storage server failures don't cause recovery, they trigger data movement to restore replication. The system is famous for deterministic <strong>simulation testing</strong>, in which the whole cluster runs in one process with injected failures.</p>

## Operating it

<pre><code>fdbcli --exec 'status'            <span class="ic-c"># healthy / healing, replication factor, process counts, performance limit</span>
fdbcli --exec 'status details'    <span class="ic-c"># per-process cpu, disk, role, storage/durability lag, queue sizes</span>
fdbcli --exec 'status json'       <span class="ic-c"># for monitoring pipelines
Performance limited by process: Storage server performance (storage queue).
  Most limiting process: 10.0.3.14:4501
Data: Moving data - 2.3 GB, Sum of key-value sizes - 1.2 TB
Operating space - 412 GB free on most full storage server</span></code></pre>
<p>The line to know is <code>Performance limited by</code>: ratekeeper throttles the <em>whole cluster</em> to the pace of the slowest storage server or tlog, so one process with a degraded disk or a hot shard drops cluster throughput. Typical incidents: a storage server's queue or durability lag grows (slow disk, hot key range that data distribution hasn't split yet, a process starved of CPU); disk space low on the fullest server (ratekeeper limits at a threshold; add capacity or exclude and move); coordinator majority lost (cluster file out of date or processes gone); clients seeing bursts of <code>not_committed</code> (contention on a hot key, fix the access pattern), <code>transaction_too_old</code> (long-running reads; split the work, or use a layer-provided continuation), or <code>commit_unknown_result</code> (the commit may or may not have happened; design idempotent writes). Backups are continuous (<code>fdbbackup</code> to blob storage) and restores are tested like any other; multi-region configurations add satellite tlogs so a region loss doesn't lose committed data.</p>
