---
title: "Kafka and analytics pipelines"
slug: /databases/db-analytics
sidebar_position: 6
sidebar_label: "Kafka and analytics pipelines"
description: "Kafka and analytics pipelines"
---
## Kafka

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/db-analytics/architecture.svg" alt="Kafka's shape" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<p>A topic is split into <strong>partitions</strong>; a record with a key lands in the partition chosen by hashing the key, and order is guaranteed only within a partition. Each partition has a leader broker and followers; the <strong>ISR</strong> is the set of replicas caught up with the leader. Producer <code>acks=all</code> together with <code>min.insync.replicas=2</code> on a replication factor of 3 means a commit is acknowledged only when two replicas have it, so one broker can die without losing acknowledged data; <code>acks=1</code> trades that for latency. <strong>Unclean leader election</strong> lets an out-of-sync replica become leader when the ISR is empty: availability at the price of losing the tail of the log; most production clusters disable it. Retention is by time or size; <strong>compaction</strong> keeps the latest record per key instead, which is what changelog topics use.</p>
<p>Consumers join a <strong>consumer group</strong>; each partition is assigned to exactly one consumer in the group, so the partition count caps parallelism, and adding partitions later changes the key-to-partition mapping. Offsets are committed to <code>__consumer_offsets</code>; commit after processing gives at-least-once (so consumers must be idempotent), commit before gives at-most-once; exactly-once exists inside Kafka via idempotent producers and transactions, and ends at the boundary of any external system, where you need idempotent or transactional sinks. A <strong>rebalance</strong> pauses the group; a consumer that takes longer than <code>max.poll.interval.ms</code> to process a batch is kicked out, triggers a rebalance, rejoins, and triggers another: the rebalance storm, fixed by smaller batches or a higher interval and cooperative-sticky assignment.</p>
<p><strong>Consumer lag</strong> is the SLI. Lag growing with stable input means consumers are slower than producers (scale consumers up to the partition count, or make processing faster); lag growing with one partition far behind means a hot key; lag that suddenly resets to zero means consumers skipped ahead because data aged out of retention, which is data loss. Broker-side: under-replicated partitions, ISR shrink/expand churn, request queue time, disk full (a broker with a full disk drops out of ISR), page cache pressure (Kafka relies on it for consumers reading recent data), and controller stability. ZooKeeper is being replaced by KRaft; know which your cluster uses. Schemas evolve through a registry with backward/forward compatibility rules, so a producer change doesn't break consumers.</p>

## Streams and batch

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/db-analytics/deep-dive.svg" alt="Delivery guarantees" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<p>Stream processors (Flink, Kafka Streams, Spark Structured Streaming) keep state and checkpoint it; <strong>watermarks</strong> decide when a window closes and what to do with late data; a checkpoint that takes longer than its interval means the job is falling behind and backpressure propagates to the source. Batch jobs (Spark) fail for predictable reasons: <strong>skew</strong> (one key's partition takes hours while the rest finish), driver OOM from <code>collect()</code>, too many small files, and shuffles that spill to disk; fixes are salting keys, repartitioning, and right-sizing executors. Data lands in columnar formats (Parquet, ORC) partitioned by date in object storage, queried by a warehouse or engine (BigQuery, Snowflake, Trino, Spark). OLTP stores rows for point lookups and transactions; OLAP stores columns for scans and aggregations; moving data between them is the pipeline. Orchestrators (Airflow) run DAGs with retries, SLAs, and backfills; tasks must be idempotent because reruns are routine.</p>
<p>SRE concerns for a pipeline are the same four as for a service, translated: <strong>freshness</strong> (data for day D available by 06:00 UTC is an SLO), <strong>completeness</strong> (row counts versus source, schema checks), <strong>correctness</strong> (reconciliation against a trusted aggregate), and <strong>cost</strong>. Operational patterns: dead-letter queues for poison messages, backpressure rather than unbounded buffering, reprocessing that is safe to run twice, alerts on lag and on the absence of data (a pipeline that silently stops is the common failure), and capacity for a backfill after an outage, which can be many times normal load.</p>
