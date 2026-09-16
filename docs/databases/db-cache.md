---
title: "Caches and key-value stores"
slug: /databases/db-cache
sidebar_position: 5
sidebar_label: "Caches and key-value stores"
description: "Caches and key-value stores"
---

<!-- DIAGRAM:deep-dive:START -->

## The two failure modes

<img src="/diagrams/db-cache/deep-dive.svg" alt="The two failure modes" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<!-- DIAGRAM:architecture:START -->

## Where each cache sits

<img src="/diagrams/db-cache/architecture.svg" alt="Where each cache sits" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->
<p><strong>Redis</strong> executes commands on a single thread (I/O threads assist in 6+), so one slow command (<code>KEYS</code>, a huge <code>SMEMBERS</code>, a big <code>DEL</code>) stalls every client; use <code>SCAN</code>, <code>UNLINK</code>, and <code>SLOWLOG</code>. Persistence is RDB snapshots (a <code>fork()</code> that, under heavy writes, can double memory through copy-on-write) or AOF with an fsync policy. Replication is asynchronous; Sentinel provides failover for a primary/replica pair; Cluster shards across 16,384 hash slots and requires multi-key operations to share a slot (hash tags <code>{user:42}</code>). Eviction policy matters: <code>noeviction</code> returns errors at <code>maxmemory</code>, <code>allkeys-lru</code> evicts silently. Latency spikes come from fork, THP, swap, and big keys; <code>redis-cli --latency</code> and <code>INFO</code> are the first look. <strong>Memcached</strong> is multi-threaded, LRU per slab class, no persistence, sharded by the client with consistent hashing.</p>

## Cache patterns and failure modes

<ul>
<li><strong>Cache-aside</strong> (read, miss, fetch, populate) is the default; <strong>write-through</strong> keeps the cache consistent on writes; <strong>write-behind</strong> batches writes and risks loss.</li>
<li><strong>Stampede</strong>: a hot key expires and thousands of requests recompute it at once. Defend with request coalescing (single-flight), a short lock on recompute, probabilistic early refresh, or serving stale while refreshing.</li>
<li><strong>Synchronized expiry</strong> after a deploy or warm-up: add TTL jitter.</li>
<li><strong>Hot keys</strong> saturate one shard: replicate the key under several names, add a local in-process cache, or split the value.</li>
<li><strong>Cold cache</strong> after a restart or failover sends the full load to the database; warm it, or rate-limit the miss path.</li>
<li>Track hit ratio, eviction rate, and latency as SLIs, and know what the database does if the cache tier disappears entirely; if the answer is "falls over," the cache is a dependency, not an optimization, and needs the same redundancy.</li>
</ul>
