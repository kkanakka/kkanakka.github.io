---
title: "Relational fundamentals"
slug: /databases/db-rel
sidebar_position: 1
sidebar_label: "Relational fundamentals"
description: "An SRE is asked about databases as an operator, not a DBA: why replication lags, how failover avoids split brain, why the pool size matters, what a tombstone does to a read, and wh"
---
## Transactions, isolation, MVCC

<!-- DIAGRAM:isolation:START -->

<img src="/diagrams/db-rel/isolation.svg" alt="Isolation levels and what each prevents" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:isolation:END -->

<p>ACID is the vocabulary; isolation is where the questions are. <strong>Read Committed</strong> (PostgreSQL's default) sees each statement's snapshot, so a row can change between two reads in one transaction. <strong>Repeatable Read</strong> (InnoDB's default; PostgreSQL's is true snapshot isolation) fixes the snapshot at the first read, preventing non-repeatable reads and in practice phantoms, but allows <strong>write skew</strong> (two transactions each read a constraint, both write, and the combination violates it). <strong>Serializable</strong> removes that at the cost of aborts you must retry. Both engines implement this with <strong>MVCC</strong>: readers see a version, writers create a new one, and nobody blocks on reads. The operational consequence differs: PostgreSQL keeps old row versions in the table itself, so they must be reclaimed by <strong>VACUUM</strong>, and a long-running transaction (or an "idle in transaction" session) prevents reclaim and causes bloat; InnoDB keeps them in undo logs, and the same long transaction grows the history list and slows every read that has to walk it.</p>

## The write path and durability

<!-- DIAGRAM:writepath:START -->

<img src="/diagrams/db-rel/writepath.svg" alt="The write path" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:writepath:END -->

<p>A commit is durable when the <strong>write-ahead log</strong> record is fsynced, not when the data page is written; data pages are flushed later at <strong>checkpoints</strong>. That is why commit latency equals fsync latency (see the LNX chapter on write caches), why <code>synchronous_commit=off</code> or <code>innodb_flush_log_at_trx_commit=2</code> speeds writes by risking the last second of commits, and why a checkpoint that flushes gigabytes of dirty pages at once shows up as a periodic latency spike (tune <code>checkpoint_completion_target</code>, <code>max_wal_size</code>; InnoDB's adaptive flushing). MySQL also writes the <strong>binlog</strong> for replication; <code>sync_binlog=1</code> with <code>innodb_flush_log_at_trx_commit=1</code> is the durable pair.</p>

## Indexes

<ul>
<li>B-tree is the default and handles equality and range. A composite index on <code>(a, b, c)</code> serves <code>a</code>, <code>a,b</code>, <code>a,b,c</code> (leftmost prefix) but not <code>b</code> alone. Put equality columns first, the range column last.</li>
<li>A <strong>covering</strong> index contains every column the query needs, enabling an index-only scan (PostgreSQL still consults the visibility map, so recently updated tables fall back to heap fetches). <strong>Partial</strong> indexes (<code>WHERE status='pending'</code>) are small and fast for skewed predicates; <strong>expression</strong> indexes serve <code>lower(email)</code>.</li>
<li>Every index costs writes and space; "add an index" is not free on a table written 10k times a second.</li>
<li>Selectivity matters: an index on a boolean with 50/50 distribution is useless; the planner will sequential-scan, correctly.</li>
</ul>

## Reading a plan

<pre><code>EXPLAIN (ANALYZE, BUFFERS) SELECT ... ;
Nested Loop  (cost=0.86..1402.31 rows=12 width=64) (actual time=0.050..188.213 rows=48210 loops=1)
  -&gt;  Index Scan using orders_user_idx on orders ... (actual rows=48210)
  -&gt;  Index Scan using items_pkey on items ... (actual ... loops=48210)
  Buffers: shared hit=3912 read=14560
Planning Time: 0.4 ms   Execution Time: 190.1 ms</code></pre>
<p>Look for: estimated <code>rows</code> far from <code>actual</code> (stale statistics; run <code>ANALYZE</code>, or the planner chose a nested loop for what is really a big join); <code>Seq Scan</code> on a large table with a selective filter (missing index); <code>Sort Method: external merge Disk</code> (raise <code>work_mem</code> or add an index matching the order); <code>read</code> buffers high (cold cache or the working set exceeds RAM); <code>loops=48210</code> on an inner index scan (an N+1 inside the database). In MySQL <code>EXPLAIN</code>, <code>type: ALL</code> is a full scan, <code>rows</code> is the estimate, and <code>Extra: Using filesort</code> / <code>Using temporary</code> are the sort and temp-table warnings.</p>

## Locks and the slow-query investigation

<!-- DIAGRAM:slowquery:START -->

<img src="/diagrams/db-rel/slowquery.svg" alt="Chasing a slow query" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:slowquery:END -->

<pre><code>-- PostgreSQL: who is waiting on whom
SELECT pid, state, wait_event_type, wait_event, now()-xact_start AS xact_age, left(query,80)
FROM pg_stat_activity WHERE state &lt;&gt; 'idle' ORDER BY xact_start;
SELECT * FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;
SELECT relname, n_dead_tup, last_autovacuum FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 10;
-- MySQL
SHOW ENGINE INNODB STATUS\G        -- deadlocks, history list length, pending fsyncs
SELECT * FROM information_schema.innodb_trx ORDER BY trx_started;
SELECT * FROM sys.statements_with_runtimes_in_95th_percentile;</code></pre>
<p>"A query got slow and nobody changed code" has a short list of causes: the plan flipped because statistics crossed a threshold or the table grew past the point where the old plan was good; a lock wait behind a long transaction or a migration; bloat (PostgreSQL) or a long history list (InnoDB); the working set outgrew the buffer cache; autovacuum fell behind; disk latency; a parameter value with very different cardinality (parameter sniffing); or a new index that the planner now prefers wrongly. Defenses: <code>statement_timeout</code>, <code>lock_timeout</code>, <code>idle_in_transaction_session_timeout</code>, and retry-on-deadlock in the application, since the database resolves deadlocks by killing one side.</p>

## Backups

<p>Logical (<code>pg_dump</code>, <code>mysqldump</code>) is portable and slow to restore; physical (<code>pg_basebackup</code>, Percona XtraBackup, crash-consistent volume snapshots) restores at disk speed. <strong>PITR</strong> is a base backup plus continuous WAL/binlog archiving, which is what lets you undo a bad <code>DELETE</code> to the second before it ran. Define <strong>RPO</strong> (how much data you can lose) and <strong>RTO</strong> (how long restore takes) per database, and measure them by restoring regularly into a scratch environment and running checks; a backup that has never been restored is a hypothesis. Take backups from a replica, encrypt them, keep them in another region and another account, and keep retention long enough to catch corruption that went unnoticed for weeks.</p>
