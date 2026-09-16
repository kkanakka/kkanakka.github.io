---
title: "Replication, failover, and connection pooling"
slug: /databases/db-repl
sidebar_position: 2
sidebar_label: "Replication, failover, and connection pooling"
description: "Replication, failover, and connection pooling"
---
## Replication modes

<!-- DIAGRAM:modes:START -->

<img src="/diagrams/db-repl/modes.svg" alt="Synchronous versus asynchronous" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:modes:END -->

<p><strong>Asynchronous</strong>: the primary commits without waiting; replicas apply later; RPO is the lag. <strong>Synchronous</strong>: the primary waits for a replica to acknowledge receipt (or apply, with <code>remote_apply</code>) before returning; RPO zero, latency plus one round trip, and if the sync replica dies, writes stall unless you configured a quorum like <code>ANY 1 (r1, r2)</code>. MySQL <strong>semi-sync</strong> waits for receipt, not apply, with a timeout after which it silently degrades to async, which is a trap in postmortems. Group Replication and Galera use a certification-based quorum and refuse writes without a majority.</p>

## Why replicas lag

<!-- DIAGRAM:lag:START -->

<img src="/diagrams/db-repl/lag.svg" alt="Where replication lag comes from" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:lag:END -->

<ul>
<li>Apply is slower than the primary's commit rate: historically single-threaded in MySQL (parallel replication by writeset fixes most of it); giant transactions or bulk updates; DDL that rewrites a table.</li>
<li>Conflicts with reads on the replica: PostgreSQL cancels replica queries that block WAL replay after <code>max_standby_streaming_delay</code>, or, with <code>hot_standby_feedback=on</code>, tells the primary not to vacuum what the replica still needs, trading replica cancellations for primary bloat.</li>
<li>Replica I/O slower than the primary, network, or the replica doing double duty for analytics.</li>
</ul>
<p>Measure it correctly. PostgreSQL: <code>pg_stat_replication</code> on the primary shows <code>write_lag</code>, <code>flush_lag</code>, <code>replay_lag</code>; on the replica <code>now() - pg_last_xact_replay_timestamp()</code> (which reads as "infinite" on an idle primary). MySQL's <code>Seconds_Behind_Master</code> reports zero when the I/O thread has stalled and nothing new is arriving; use a heartbeat table (<code>pt-heartbeat</code>) or GTID-based comparisons. Alert on lag <em>and</em> on replication being broken.</p>

## Failover without split brain

<!-- DIAGRAM:failover:START -->

<img src="/diagrams/db-repl/failover.svg" alt="Failover and the fencing that prevents split brain" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:failover:END -->

<ol>
<li><strong>Detect</strong> with more than one observer and a quorum decision; a single monitor with a flaky network is how you promote a replica while the primary is still fine.</li>
<li><strong>Fence</strong> the old primary before anyone writes elsewhere: revoke its VIP or service-discovery entry, kill its connections, demote it to read-only, or power it off (STONITH). Skipping this is the definition of split brain: two primaries, divergent data, no clean merge.</li>
<li><strong>Promote</strong> the most up-to-date replica; accept that asynchronous replication means the transactions the old primary had not shipped are lost or must be recovered manually.</li>
<li><strong>Repoint</strong> the other replicas (PostgreSQL timelines, MySQL GTID auto-positioning) and <strong>redirect</strong> clients via VIP, proxy, or service discovery; DNS with a high TTL is the slow option.</li>
<li><strong>Expect the aftershock</strong>: every client reconnects at once (a connection storm; add jitter and a pool), and the new primary's cache is cold (warm it, or failover to a replica that already served reads).</li>
</ol>
<p>Tools that encode this: Patroni (PostgreSQL, leader lease in etcd/Consul), repmgr, Orchestrator and MySQL Router/ProxySQL, managed services' multi-AZ failover. <strong>Read-your-writes</strong> after routing reads to replicas: pin a session to the primary briefly after a write, or wait on the replica for the LSN/GTID of that write before reading.</p>

## Connection pooling

<!-- DIAGRAM:pooling:START -->

<img src="/diagrams/db-repl/pooling.svg" alt="Why the pool size matters" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:pooling:END -->

<p>Each PostgreSQL connection is a backend process with its own memory; thousands of idle connections waste RAM and make every snapshot and lock operation slower. MySQL threads are cheaper but still contend. The fix is a pool sized to what the database can run concurrently, roughly a small multiple of core count, with clients queuing in the pool rather than inside the database. <strong>PgBouncer</strong> in <code>transaction</code> mode multiplexes thousands of client connections over a few dozen server connections, at the cost of session state: prepared statements (handled in newer versions), <code>SET</code>, advisory locks, and <code>LISTEN</code> don't survive the boundary. The pool is also your shield in the failover aftershock and your first throttle when the database is overloaded; pool exhaustion with rising wait time is an early SLI for "database is the bottleneck."</p>
