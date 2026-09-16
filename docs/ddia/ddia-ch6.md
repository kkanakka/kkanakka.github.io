---
title: "Ch 6: Caching Strategies"
slug: /ddia/ddia-ch6
sidebar_position: 6
sidebar_label: "Ch 6: Caching Strategies"
description: "Ch 6: Caching Strategies"
---
Cache-aside, write-through, write-behind. How Memcached, Redis, and Couchbase work. Cache miss flows, eviction, persistence, and where each fits in production architectures.

Data Intensive Systems • Chapter 6 • Interview Guide

[Home](/) [Ch 5: How Companies Handle Data](/docs/ddia/ddia-ch5) [Ch 4: TiDB & Raft](/docs/ddia/ddia-ch4)

<a id="toc"></a>

## Table of Contents

1.  [Why Cache? The Latency Pyramid](#sec-1)
2.  [Caching Patterns: Read Path](#sec-2)
3.  [Caching Patterns: Write Path](#sec-3)
4.  [Memcached Deep Dive](#sec-4)
5.  [Redis Deep Dive](#sec-5)
6.  [Couchbase Deep Dive](#sec-6)
7.  [Cache Invalidation — The Hard Problem](#sec-7)
8.  [When to Use What — Decision Guide](#sec-8)
9.  [Interview Questions](#sec-9)

<a id="sec-1"></a>

Section 1

## Why Cache? The Latency Pyramid

<img src="/diagrams/ddia-ch6/1.svg" alt="ddia-ch6 diagram 1" class="doc-diagram" />

An in-memory cache (Redis/Memcached) is 100-1000x faster than a database query. For hot data read thousands of times/second, caching transforms economics: one DB read fills cache, then thousands of reads are served from RAM.

[↑ Back to Contents](#toc)

<a id="sec-2"></a>

Section 2

## Caching Patterns: Read Path MetaGoogle

<img src="/diagrams/ddia-ch6/2.svg" alt="ddia-ch6 diagram 2" class="doc-diagram" />

Cache-Aside (Lazy Loading): App checks cache first. On miss, queries DB, then populates cache with TTL. This is the most common caching pattern — used by LinkedIn (Espresso + Couchbase), Facebook (MySQL + Memcache), Netflix (Cassandra + EVCache).

#### Read-Through vs Cache-Aside

```
CACHE-ASIDE (most common — app manages cache):
  App → cache? miss → App → DB → App → populate cache → return
  App is responsible for both reading and populating the cache.
  Used by: most custom apps, LinkedIn, Facebook

READ-THROUGH (cache manages DB access):
  App → cache? miss → Cache → DB → Cache stores → return
  The CACHE itself fetches from DB on miss. App only talks to cache.
  Used by: Couchbase (with XDCR), some CDN configurations

Difference: who owns the "go fetch from DB" logic.
  Cache-Aside: the application code
  Read-Through: the cache infrastructure
```

[↑ Back to Contents](#toc)

<a id="sec-3"></a>

Section 3

## Caching Patterns: Write Path MetaGoogle

<img src="/diagrams/ddia-ch6/3.svg" alt="ddia-ch6 diagram 3" class="doc-diagram" />

Three write strategies: Write-Through (consistent but slow), Write-Behind (fast but data-loss risk), Write-Around + Invalidate (simplest, most common at LinkedIn and Facebook).

[↑ Back to Contents](#toc)

<a id="sec-4"></a>

Section 4

## Memcached Deep Dive Meta

```
MEMCACHED ARCHITECTURE:

┌────────────────────────────────────────────────────────────┐
│  Memcached = distributed in-memory hash table              │
│                                                            │
│  ✓ Simple: GET / SET / DELETE / INCREMENT                  │
│  ✓ Multi-threaded (scales on multi-core)                   │
│  ✓ No data structures (just strings)                       │
│  ✓ No persistence (RAM only — crash = lose everything)     │
│  ✓ No replication (each key on exactly ONE server)         │
│  ✓ Consistent hashing for key distribution                 │
│  ✓ LRU eviction when memory full                          │
│                                                            │
│  Client hashes key → picks server → talks directly.        │
│  Servers don't talk to each other. No cluster protocol.    │
│                                                            │
│  Slab allocator: memory divided into classes (64B, 128B,   │
│  256B...). Reduces fragmentation. Items stored in slabs.   │
└────────────────────────────────────────────────────────────┘

WHEN TO USE MEMCACHED:
  ✓ Simple key-value caching (sessions, rendered HTML, API responses)
  ✓ Multi-threaded workloads (Memcached scales better per-node than Redis)
  ✓ You don't need data structures (lists, sets, sorted sets)
  ✓ You don't need persistence (cache is disposable)

Facebook runs the world's largest Memcached deployment:
  - Hundreds of thousands of Memcached instances
  - Regional pools (each region has full cache)
  - mcrouter (proxy) for consistent hashing + replication
  - The "lease" mechanism prevents thundering herd on cache miss
```

#### Facebook's Thundering Herd Solution

```
PROBLEM: 10,000 requests hit the same cache miss simultaneously.
All 10,000 queries the database. Database dies.

FACEBOOK'S FIX: Memcache Leases
  1. First client gets a cache miss → Memcached gives it a LEASE TOKEN
  2. Other clients hitting the same key see "someone has a lease" → WAIT
  3. First client queries DB, gets data, SETs cache with lease token
  4. All waiting clients get the cached value
  Result: only 1 DB query instead of 10,000.

Also: "stale" flag — on delete, mark as stale instead of removing.
  Readers can optionally use stale data while fresh data is being fetched.
```

[↑ Back to Contents](#toc)

<a id="sec-5"></a>

Section 5

## Redis Deep Dive MetaNetflix

```
REDIS ARCHITECTURE:

┌────────────────────────────────────────────────────────────┐
│  Redis = in-memory data structure store                    │
│                                                            │
│  ✓ Rich data structures:                                   │
│    String, List, Set, Sorted Set, Hash, HyperLogLog,       │
│    Stream, Bitmap, Geospatial index                        │
│  ✓ Single-threaded event loop (no lock contention)         │
│  ✓ Persistence options: RDB snapshots + AOF append log     │
│  ✓ Replication: leader-follower async                      │
│  ✓ Redis Cluster: hash slots (16384 slots) for sharding    │
│  ✓ Pub/Sub, Lua scripting, transactions (MULTI/EXEC)       │
│  ✓ Redis Sentinel: automatic failover                      │
└────────────────────────────────────────────────────────────┘

PERSISTENCE OPTIONS:
  RDB (snapshots):
    BGSAVE → fork child → child writes all data to .rdb file
    Point-in-time snapshot. Fast recovery. Data loss = since last snapshot.

  AOF (Append-Only File):
    Every write command appended to a log file.
    fsync options: always (safest, slowest), everysec (default), never (fastest)
    AOF rewrite: compact the log periodically (like LSM compaction)

  RDB + AOF combined: AOF for durability, RDB for fast restart.
```

#### Redis Use Cases by Company

```
TWITTER:
  Home timelines stored in Redis Sorted Sets.
  Key: timeline:{userId}, Value: sorted set of tweetIds by timestamp.
  ZRANGEBYSCORE timeline:12345 -inf +inf LIMIT 0 50 → latest 50 tweets.
  Fan-out on write: ZADD to each follower's timeline.

NETFLIX:
  EVCache (Netflix's Memcached fork, not Redis, but same concept).
  Session storage, personalization, recommendation scores.

UBER:
  Geospatial: GEOADD drivers:{city} lon lat driverId
  GEORADIUS drivers:sf 37.77 -122.41 5 km → all drivers within 5km.

INSTAGRAM:
  Redis for "like" counts, follower counts, media IDs.
  HyperLogLog for unique visitor counting (12KB per counter!).

WHEN TO USE REDIS (vs Memcached):
  ✓ You need data structures (sorted sets for leaderboards, lists for queues)
  ✓ You need persistence (RDB/AOF)
  ✓ You need pub/sub or streams
  ✓ You need Lua scripting for atomic operations
  ✗ NOT for multi-threaded scale-up (Redis is single-threaded per shard)
```

[↑ Back to Contents](#toc)

<a id="sec-6"></a>

Section 6

## Couchbase Deep Dive LinkedIn

```
COUCHBASE AT LINKEDIN (Espresso L2 Cache):

┌─────────────────────────────────────────────────────────────┐
│  Couchbase = distributed document store + cache             │
│                                                             │
│  Unlike Memcached/Redis (pure in-memory):                   │
│  ✓ Memory-first with async disk persistence                 │
│  ✓ Built-in clustering (auto-sharding via vBuckets)         │
│  ✓ Cross-datacenter replication (XDCR)                      │
│  ✓ N1QL query language (SQL-like for JSON docs)             │
│  ✓ Sub-document operations (update one field, not whole doc) │
│  ✓ TTL-based expiration                                     │
│  ✓ Survives node restart (data persisted to disk async)     │
│                                                             │
│  LinkedIn uses Couchbase as Espresso's L2 cache:            │
│    L1: OHC (Off-Heap Cache) — per-router, ~100MB, nanosecs  │
│    L2: Couchbase — shared pool, ~100GB, microsecs            │
│                                                             │
│  Cache key: hash(database + table + primary_key + schemaVer)│
│  Schema version in key → auto-invalidation on schema change │
└─────────────────────────────────────────────────────────────┘

HOW COUCHBASE STORES DATA:
  1. Write arrives → stored in RAM (managed cache)
  2. Async: flushed to disk (append-only, like LSM)
  3. Replication: async to other nodes in cluster

  Memory quota per bucket (e.g., 10GB per node)
  When quota full → LRU eviction (eject least-recently-used items from RAM)
  But data stays on disk! Re-accessed items loaded from disk ("warm-up")

VS MEMCACHED:
  Memcached: crash = all data lost. No disk. No replication.
  Couchbase: crash = reload from disk. Data persisted. XDCR replication.
  Couchbase is "Memcached that doesn't lose your data."

VS REDIS:
  Redis: rich data structures (sorted sets, streams). Single-threaded.
  Couchbase: JSON documents with sub-doc ops. Multi-threaded. Built-in SQL.
  Couchbase better for document caching. Redis better for data structure ops.
```

[↑ Back to Contents](#toc)

<a id="sec-7"></a>

Section 7

## Cache Invalidation — The Hard Problem MetaGoogle

```
"There are only two hard things in Computer Science:
 cache invalidation and naming things." — Phil Karlton

THE PROBLEM: Cache has stale data. DB has new data. User sees old data.

STRATEGIES:

1. TTL-based expiration (simplest):
   SET key value EX 3600  → cache auto-expires after 1 hour
   ✓ Simple, always eventually consistent
   ✗ Stale for up to TTL duration. Short TTL = more DB load.

2. Event-driven invalidation (most precise):
   DB write → Kafka CDC event → cache invalidation consumer → DELETE key
   ✓ Invalidates within seconds of DB write
   ✗ Requires CDC infrastructure (Kafka, consumers)
   Used by: LinkedIn (Espresso binlog → Kafka → invalidate Couchbase)

3. Write-through invalidation (synchronous):
   App writes to DB → App DELETEs from cache → done
   ✓ Immediate invalidation
   ✗ Race condition: between DELETE and next SET, concurrent read
      can populate cache with stale data (the "dogpile" problem)

4. Version-based cache keys:
   Cache key = hash(table + key + schema_version)
   Schema change → new key → old entries naturally ignored
   ✓ Zero-cost invalidation on schema changes
   Used by: LinkedIn Espresso (schema_version in cache key)

LINKEDIN ESPRESSO CACHE INVALIDATION:
  Write → Leader commits to MySQL
       → Router invalidates L1 (OHC) entry
       → Router invalidates L2 (Couchbase) entry
       → Next read = cache miss → fresh data fetched → cache repopulated
  This is "Write-Around + Invalidate" — the simplest correct approach.
```

[↑ Back to Contents](#toc)

<a id="sec-8"></a>

Section 8

## When to Use What — Decision Guide

### The Four Ways to Write to Cache

![Cache-Aside, Read-Through, Write-Through, Write-Behind patterns](/images/cache-write-patterns.png)

### Real-World Feature → Cache Pattern Quick Reference

When designing a feature, pick the caching pattern based on **read/write ratio**, **consistency needs**, and **latency budget**:

| Feature | Pattern | Cache | How It Works |
| --- | --- | --- | --- |
| **User profile views** | Cache-Aside | Memcached / OHC + Couchbase | Read-heavy (1000:1 read/write). App checks cache on profile view → miss = query Espresso → populate cache with TTL. Write to DB on profile edit → DELETE from cache. LinkedIn: L1 OHC (nanosec) → L2 Couchbase (microsec) → L3 Espresso. |
| **Like / reaction counts** | Write-Behind | Redis | High-frequency writes (thousands of likes/sec on viral posts). `INCR post:123:likes` in Redis immediately → async batch flush to DB every N seconds. User sees instant count. Slight inconsistency OK. If Redis crashes, recount from DB. |
| **News feed / timeline** | Write-Through (fan-out on write) | Redis Sorted Sets | When user posts → `ZADD timeline:{followerId} timestamp postId` for each follower. Read = `ZREVRANGE` top 50. Cache always pre-built. Twitter: fan-out on write for users with <10K followers. Celebrity timelines: fan-out on read (cache-aside). |
| **Session management** | Write-Through + TTL | Redis (Hash + AOF) | Every login/action → `HSET session:abc user_id 123 role admin` + `EXPIRE session:abc 1800`. Redis is source of truth for active sessions. AOF `everysec` for crash recovery. No DB in the hot path. Session timeout = Redis TTL. |
| **Rate limiting / API throttle** | Write-Through (cache-only) | Redis | Redis IS the system, not a cache. Sliding window: Lua script atomically checks + increments counter. `INCR api:user:123:min` + `EXPIRE 60`. No DB needed. If Redis dies: fail-open (allow all) or fail-closed (block all) per policy. |
| **Product catalog / search results** | Read-Through | Couchbase / CDN | Cache automatically fetches from DB on miss — app only talks to cache. Catalog rarely changes (write-light). Couchbase sub-doc ops update individual fields. CDN caches rendered pages at edge. TTL = 5-15 min for freshness. Invalidate on product update via CDC. |
| **Leaderboard / top-K ranking** | Write-Through | Redis Sorted Sets | Every score change → `ZADD leaderboard score userId` (writes to Redis AND DB). `ZREVRANGE leaderboard 0 9` = top 10. O(log N) insert + O(K) read. Always consistent. Gaming, LinkedIn skill endorsements, Stack Overflow reputation. |
| **Nearby drivers / stores (geospatial)** | Write-Through | Redis Geo | GPS ping every 3-5s → `GEOADD drivers:sf lon lat driver42`. Rider request → `GEORADIUS drivers:sf lon lat 5 km COUNT 10`. Positions overwritten in-place. No DB in hot path for location queries. Historical data → DB async. |
| **Shopping cart** | Write-Through + persistence | Redis Hash + AOF | `HSET cart:user123 item456 qty:2`. Every add/remove writes to Redis + async to DB. Redis AOF ensures durability. `HGETALL cart:user123` for checkout. TTL = 7 days for abandoned carts. Merge on login (anonymous → authenticated). |
| **DNS / config lookups** | Cache-Aside + short TTL | In-process (Caffeine) + Memcached | DNS/config changes infrequently but must propagate. Local cache with 30-60s TTL. Miss → query config service → cache. Short TTL ensures eventual consistency. No write-through needed — config service is the single source of truth. |
| **ML recommendations / personalization** | Cache-Aside (pre-computed) | EVCache / Redis | ML pipeline pre-computes recommendations offline → bulk-loads into cache. App reads from cache directly. TTL = hours (refresh when pipeline re-runs). Netflix: EVCache with zone-aware replication. No DB in the read path. |
| **Notifications / activity feed** | Write-Behind | Redis Lists/Streams | Event occurs → `LPUSH notif:user123 payload` immediately → async consumer writes to DB for persistence. User polls with `LRANGE notif:user123 0 19` = latest 20. Fast writes, eventual DB consistency. `LTRIM` keeps list bounded. |

### Complete Decision Guide

| Scenario | Best Cache | Caching Pattern | Why |
| --- | --- | --- | --- |
| Simple key-value caching, disposable | **Memcached** | **Cache-Aside** (Lazy Loading)  
*App checks cache → miss → query DB → populate cache.* No persistence needed. TTL-based expiration. Facebook uses leases to prevent thundering herd. | Multi-threaded, no overhead of persistence. Pure speed. |
| Leaderboards, ranked feeds | **Redis** (Sorted Sets) | **Write-Through**  
*Every score update writes to Redis AND DB synchronously.* Sorted Set always current. Reads never miss for active leaderboards. `ZADD` on every write keeps rankings real-time. | `ZADD` + `ZRANGE` gives O(log N) ranked operations natively. |
| Rate limiting | **Redis** | **Write-Through** (cache-only for counters)  
*`INCR` + `EXPIRE` directly on Redis.* No DB in the hot path. Redis IS the source of truth for rate counters. Lua scripts for atomic sliding window. If Redis dies, fail-open or fail-closed per policy. | `INCR` + `EXPIRE` = atomic counter with TTL. Lua for sliding window. |
| Session storage | **Redis** (with AOF) | **Write-Through** + AOF persistence  
*App writes session to Redis on every update. AOF ensures durability.* Redis Hash per session (`HSET session:abc field val`). `EXPIRE` for session timeout. AOF `everysec` fsync = max 1s data loss on crash. | Persistence survives restart. Hash type for session fields. |
| Message queues (lightweight) | **Redis** (Streams/Lists) | **Write-Behind** (async consumption)  
*Producers `XADD` to stream. Consumers `XREADGROUP` asynchronously.* Consumer groups track offsets. Acknowledged messages trimmed. Not a replacement for Kafka at scale, but ideal for lightweight pub/sub. | `XADD`/`XREAD` for pub/sub with persistence. Not for Kafka-scale. |
| Geospatial queries (nearby drivers) | **Redis** (Geo) | **Write-Through** (real-time location updates)  
*Driver location → `GEOADD` to Redis on every GPS ping.* Reads via `GEORADIUS` always get latest positions. High-frequency writes (every 3-5s per driver). Old positions overwritten in-place. | `GEOADD` + `GEORADIUS` for proximity search. Uber uses this. |
| Document cache for Espresso | **Couchbase** | **Write-Around + Invalidate**  
*Write goes to Espresso (MySQL) → invalidate L1 OHC → invalidate L2 Couchbase → next read repopulates cache.* Schema version in cache key auto-invalidates on schema change. CDC via binlog → Kafka for async invalidation. | Shared L2 cache, survives restart, sub-doc updates, XDCR. |
| Huge cache pool (100GB+ shared) | **Couchbase** | **Read-Through** + LRU eviction  
*Cache manages DB fetches on miss. LRU ejects cold items from RAM, but data stays on disk.* Re-access warm items loaded from disk (not DB). Memory quota per bucket. Disk-backed = survives restarts without cold-start penalty. | Memory + disk tiering. LRU ejects from RAM, reloads on access. |
| Facebook-scale object cache | **Memcached** (+ mcrouter) | **Cache-Aside** + Lease tokens  
*App checks cache → miss → lease token prevents thundering herd → one DB query → populate cache.* Regional pools via mcrouter. `DELETE` on write (write-around). Stale flag allows serving stale while refresh in progress. | Simplest, multi-threaded, battle-tested at billions of req/s. |
| Netflix personalization | **EVCache** (Memcached fork) | **Cache-Aside** + zone-aware replication  
*App populates cache from ML pipeline. Reads from nearest AZ replica.* Write to primary EVCache → async replicate to other AZs. Warm-up on deploy via bulk preload. TTL-based expiration for recommendation freshness. | AWS-optimized, zone-aware replication, tuned for Netflix scale. |
| CDN / edge caching | **Varnish / Nginx** | **Read-Through** (reverse proxy)  
*CDN intercepts request → cache hit = serve from edge → miss = fetch from origin, cache, serve.* HTTP `Cache-Control` headers drive TTL. Purge API for invalidation. Typically cache full HTTP responses (HTML, JS, images). | HTTP cache at edge. Not a database cache — caches entire responses. |
| Per-process local cache | **OHC / Caffeine / Guava** | **Cache-Aside** (in-process, no network)  
*Thread checks local cache → miss → fetch from L2/DB → populate local cache.* Caffeine: `LoadingCache` with `refreshAfterWrite`. OHC: off-heap = no GC pressure. Size-bounded + time-bounded eviction. No serialization cost. | In-process, nanosecond access, no network. LinkedIn L1 uses OHC. |

#### The Multi-Tier Cache Architecture (LinkedIn)

```
Request arrives at Espresso Router:

┌─ L0: Application-level cache (in-process, Caffeine/Guava)
│  Hit? → return in nanoseconds
│  Miss ↓
├─ L1: OHC (Off-Heap Cache, per-router, ~100MB)
│  Hit? → return in microseconds (no GC pressure, off-heap)
│  Miss ↓
├─ L2: Couchbase (shared across routers, ~100GB)
│  Hit? → return in ~0.5ms (network + RAM lookup)
│  Miss ↓
├─ L3: Database (Espresso Storage Node → MySQL/InnoDB)
│  B-tree lookup → return in ~2-5ms
│  Populate L2 → Populate L1 on the way back up
└─ Response to client

Combined hit rate: 95-99% for hot data.
Celebrity profiles (Satya, Bill Gates): always in L1.
Regular profiles: usually in L2.
Inactive profiles: L2 miss → L3 (database), then cached.
```

[↑ Back to Contents](#toc)

<a id="sec-9"></a>

Section 9

## Interview Questions

#### Q1: "What happens on a cache miss?" MetaGoogle

**Answer:** In cache-aside (most common): App checks cache → MISS → App queries database → DB returns data → App writes data to cache with TTL → returns to client. Next identical request = cache hit. Key concern: thundering herd (1000 simultaneous misses for same key → 1000 DB queries). Fix: leases (Facebook) or lock-and-load (only first miss queries DB, others wait).

#### Q2: "Redis vs Memcached — when to use which?" MetaNetflix

**Answer:** Memcached for simple key-value at massive scale (multi-threaded, no persistence overhead — Facebook). Redis when you need data structures (sorted sets for leaderboards, geospatial for Uber, streams for queues), persistence (AOF/RDB), or pub/sub. Redis is single-threaded per shard; Memcached scales better per-node for simple GET/SET.

#### Q3: "How do you keep cache consistent with the database?" MetaGoogle

**Answer:** Write-around + invalidate is simplest and most common: write to DB, then DELETE from cache. Next read = cache miss → fresh data. For stronger guarantees: event-driven invalidation via CDC (LinkedIn: Espresso binlog → Kafka → invalidate Couchbase). Version-based keys for schema changes. TTL as a safety net — even if invalidation fails, cache expires eventually.

#### Q4: "Design a multi-tier cache" LinkedInGoogle

**Answer:** L0: in-process (Caffeine, nanoseconds, tiny). L1: per-instance off-heap (OHC, microseconds, 100MB). L2: distributed shared cache (Couchbase/Redis, 0.5ms, 100GB). L3: database (2-5ms). Each tier is 10-100x slower but 10-100x larger. Hit rates compound: if L1=80% and L2=90% of L1 misses, effective hit rate = 80% + (20% × 90%) = 98%. Only 2% reaches the database.

[↑ Back to Contents](#toc)
