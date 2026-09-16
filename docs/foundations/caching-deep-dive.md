---
title: "Caching Systems Deep Dive"
slug: /foundations/caching-deep-dive
sidebar_position: 3
sidebar_label: "Caching Systems Deep Dive"
description: "Caching Systems Deep Dive"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/caching-deep-dive/sequence.svg" alt="How it works — caching-deep-dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
A deep dive into cache patterns, strategies, and systems — from bootstrap problems to LinkedIn's 4.8M reads/sec architecture

## 1\. Why Two Caches? The Bootstrap Problem

Many systems use two caching layers: a local in-process cache (populated via Kafka deltas) and a shared Memcache/Redis cluster. The question is **why both are needed**.

#### ❌ Without Memcache

**Step 1:** New service starts

**Step 2:** Empty local cache — nothing to serve

**Step 3:** Wait for Kafka stream to deliver flags

**Step 4:** Gradually receive flags (minutes)

**Result:** Cold start. Minutes of degraded service.

#### ✅ With Memcache

**Step 1:** New service starts

**Step 2:** Load full snapshot from Memcache (~100ms)

**Step 3:** Already fully warm — start serving

**Step 4:** Tail Kafka for real-time deltas only

**Result:** Instant warm start. No cold window.

| Cache Type | Update Frequency | Update Method | Access Pattern |
| --- | --- | --- | --- |
| **Local cache** | Real-time | Kafka deltas | Every request (millions/sec) |
| **Memcache / Redis** | Every 30s | Control Plane batch write | Only at startup / warm-up |

**Key insight:** These two caches are not redundant — they serve completely different jobs. The local cache handles millions of requests per second. Memcache exists only to eliminate the cold-start window when a new instance boots.

## 2\. The Four Ways to Write to Cache

How data gets into cache depends on who you want to be responsible. Different patterns offer different trade-offs between control, latency, and consistency.

![Four Cache Patterns - Cache-aside, Read-through, Write-through, and Write-behind](/images/cache-four-patterns.png)

### 💰 Real-World Trade-offs: When Stale Data Costs Money

#### ❌ Cache-aside Risk: Amazon Price Update

When a seller updates a price on Amazon, the write goes to DB only. The cache still has the old price. If another user loads that product page in the next few seconds, they read from cache and see the old price — potentially at checkout. **That's a real-world dispute.**

1\. Seller updates price → DB → 2\. Cache still has old price → 3\. Next buyer sees stale price → **💸 Financial dispute**

#### ✅ Write-through Protection

Write-through says: **before we ack the seller's save, we update both DB and cache atomically.** The seller waits maybe 5–10ms more. But every reader from that moment on is guaranteed to see the new price.

1\. Seller updates price → 2\. Write to DB + Cache → 3\. Both confirm → **✅ Consistent reads**

The Rule of Thumb:

**Write-through:** When stale reads have real consequences — financial data, stock levels, surge fares, account balances. You accept the write cost because **being wrong is more expensive than being slow.**

**Cache-aside/Write-behind:** When approximate data is acceptable — view counts, likes, recommendations. Speed matters more than perfect accuracy.

![Real-world cache patterns - YouTube, Spotify, Netflix, Amazon examples showing when to use each pattern](/images/cache-real-world-patterns.png)

### 🎯 Pattern Selection by Real-World Impact

#### 💸 Write-Through: Money & Trust

Use when stale data causes real harm

-   **Amazon/Shopify:** Product prices, stock levels
-   **Uber/Grab:** Surge pricing, fare calculations
-   **Discord:** User presence, status updates
-   **Financial:** Account balances, trading prices

**Trade-off:** Slower writes (5-10ms penalty) for guaranteed consistency

#### ⚡ Write-Behind: High Volume Counts

Use when speed > perfect accuracy

-   **YouTube:** View counts, like buttons
-   **Instagram/X:** Likes, follower counts
-   **Spotify:** Play counts, stream stats
-   **Gaming:** Score counters, activity feeds

**Trade-off:** Risk of data loss vs. handling millions of writes/sec

#### 📖 Cache-Aside: Metadata & Catalogs

Default pattern for most read-heavy data

-   **YouTube:** Video metadata, thumbnails
-   **Spotify:** Song metadata, album art
-   **Netflix:** ML recommendations, catalog
-   **General:** User profiles, configuration

**Trade-off:** Manual cache management for full control over DB protocols

#### 🔍 Read-Through: Proxy Layer

Framework/proxy handles cache transparently

-   **Google/Spotify:** Search autocomplete
-   **Spring @Cacheable:** Method result caching
-   **Envoy sidecar:** API response caching
-   **CDN:** Static asset caching

**Trade-off:** Less control but cleaner app code

#### 🧠 Decision Framework

Ask: "What happens if data is stale?"

-   **Financial loss:** Write-through
-   **Nobody cares:** Write-behind
-   **Slightly annoying:** Cache-aside

Ask: "What's the write volume?"

-   **\>10K writes/sec:** Write-behind only
-   **1K-10K writes/sec:** Write-through maybe
-   **<1K writes/sec:** Any pattern works

### 🔔 Deep Dive: Notification Systems Architecture

Why different parts of a notification system need different caching strategies

#### 🔴 Notification Count (Red Badge)

**Pattern:** Write-behind (Redis as primary store)

Every new notification fires `REDIS INCR user:456:unread_count`. The count lives in Redis as the primary store, not as a cache of anything. DB gets synced async.

**Why not cache-aside?** Too many writes would constantly invalidate the cache

#### 📋 Notification List (Dropdown)

**Pattern:** Cache-aside with short TTL (30-60s) OR fanout-on-write

Cache-aside can work but with very short TTL. **Instagram/Facebook skip caching entirely** — when someone likes your photo, a job immediately writes to your personal feed store (Cassandra/Redis).

**Problem with cache-aside:** Every new notification makes cached list stale immediately

#### ⚙️ Notification Preferences

**Pattern:** Cache-aside with long TTL

Do you want email? Push? SMS? This data changes maybe once a month. Cache it with a long TTL, fetch from DB on miss.

**Perfect fit:** Low write frequency, high read volume, eventual consistency is fine

#### ✓ Mark as Read

**Pattern:** Write-through

If you mark something read then refresh and it shows unread again, that's a trust-breaking UX bug. Consistency matters here — cache and DB update together synchronously.

**Why write-through?** UX consistency is more important than write speed here

#### 💡 Key Insight: One Feature, Four Patterns

A single "notification system" actually needs **four different caching strategies** because each component has different characteristics:

-   **Count:** Write-behind (high write volume, approximate OK)
-   **List:** Cache-aside + short TTL OR fanout-on-write (frequent invalidation)
-   **Preferences:** Cache-aside + long TTL (rare updates, eventual consistency fine)
-   **Read status:** Write-through (UX consistency critical)

This is why cache architecture is complex — you can't pick one pattern for your entire app!

## 3\. Cache Miss — What Actually Happens

Cache miss is always the same three steps — detect miss, go to DB, populate cache — but the **cause** differs.

![Cache Miss Types - Cold, Capacity/Eviction, and Invalidation misses](/images/cache-miss-types.png)

**Cache stampede (thundering herd)**  
When many requests miss at the same time — e.g. after a restart or a mass expiry — they all hit the DB simultaneously, potentially overwhelming it. Three common fixes:

### Cache Stampede Solutions

#### 🔒 Mutex Lock

Only one request fetches from DB; the rest wait and then read the now-warm key.

#### ⏰ Probabilistic Early Expiry (PER)

Re-compute a cache entry slightly before it expires, rather than waiting for a hard miss.

#### 🔄 Request Coalescing

Deduplicate in-flight requests for the same key so only one goes to the DB.

## 4\. Cache Rebuild Strategies

Rebuilding cache after a restart is the problem Memcache was solving. Different strategies offer different trade-offs between complexity and performance.

![Cache Rebuild Strategies - Lazy rebuild, Eager pre-warm, and Event-driven CDC](/images/cache-rebuild-strategies.png)

| Strategy | How it works | Stale window | Complexity |
| --- | --- | --- | --- |
| **Delete on write** | When DB is updated, delete the cache key. Next read refills it. | Zero — next read always fresh | Low |
| **TTL expiry** | Set a time-to-live on each key. Serve stale until it expires. | Up to TTL duration | Very low |
| **Write-through** | Write to cache and DB simultaneously on every mutation. | Zero | Medium |
| **CDC invalidation** | Watch binlog; delete/update cache key on every DB change. | Near-zero (stream lag) | High |

## 5\. Persistence Options — Redis vs Memcached

The fundamental difference: Memcached has no persistence, Redis offers two options. In production, you typically run both together.

![Cache Persistence Options - Memcached no disk, Redis RDB snapshot, and Redis AOF log](/images/cache-persistence-options.png)

**Production Standard: RDB + AOF Together**  
  
RDB for fast restart, AOF for durability. Use both together:  
• **0-1s data loss** (AOF fsync frequency)  
• **Full data restored** (RDB snapshot + AOF replay)  
• **Reasonable restart time** (RDB loads fast, AOF fills gaps)

| When to Use Which | Persistence | Data Loss | Restart Speed | Best For |
| --- | --- | --- | --- | --- |
| **Memcached** | None | 100% on restart | Instant (empty) | Pure cache, simple data, no persistence needed |
| **Redis RDB** | Snapshots | Snapshot interval | Fast | Analytics cache, can tolerate some data loss |
| **Redis AOF** | Write log | 0-1s | Slower (replay) | Session store, queues, counters, feature flags |
| **Redis RDB+AOF** | Both | 0-1s | Good | **Production standard** - best of both |

## 6\. Memcached vs Redis vs Couchbase — Complete Decision Matrix

Does the cache know about your DB? The answer determines your architecture and trade-offs.

![Memcached vs Redis vs Couchbase comparison](/images/cache-memcached-redis-couchbase.png)

![Cache loader patterns - how cache knows to pull from DB](/images/cache-loader-patterns.png)

### Quick Decision Guide

| Question | Memcached | Redis | Couchbase |
| --- | --- | --- | --- |
| **Need persistence across restarts?** | ❌ No | ✅ Yes (opt-in) | ✅ Always |
| **Need rich data structures (sorted sets, streams)?** | ❌ No | ✅ Yes — best in class | ⚠️ Limited |
| **Need a primary DB (no separate DB)?** | ❌ No | ⚠️ With RDB+AOF, maybe | ✅ Yes — designed for this |
| **Need to query by field value?** | ❌ No | ❌ No | ✅ Yes — N1QL |
| **Need cross-datacenter active-active?** | ❌ No | ❌ No (active-passive) | ✅ Yes — XDCR |
| **Ecosystem / libraries?** | Good | Largest — de facto standard | Smaller |
| **Raw throughput as pure cache?** | ✅ Fastest | Excellent | Good |

**Key Insight:** Memcached and Redis are caches — they have no idea where your data originally came from.  
Couchbase is a primary database that happens to keep everything in memory first.  
  
**Choose based on:** Do you need the cache to survive restarts? Do you need rich data types? Is this your only datastore?

## 7\. How Cache Knows to Pull from DB

**Spoiler: it doesn't** — the app does. The cache is a passive key-value store.

#### ❌ The Myth

"Cache somehow detects a miss and automatically queries MySQL."

App

→

🏪 Cache

→

DB

#### ✅ The Reality

Cache returns NIL. Your app code (or your framework's cache library) detects the miss, runs a loader function you wrote, fetches from DB, then calls redis.SET to populate the cache.

| Approach | Who writes the loader | How it looks |
| --- | --- | --- |
| **Manual (cache-aside)** | You — in application code | 
val = redis.get(key)  
if val is None:  
  val = db.query("SELECT ...")  
  redis.setex(key, ttl, val)  
return val

 |
| **Framework (@Cacheable)** | The framework — intercepts method calls | 

@Cacheable("users")  
User getUser(Long id) {  
  // runs ONLY on cache miss  
  return db.findById(id);  
}

 |
| **Proxy / sidecar** | The proxy — sits between app and DB | App sends SQL to proxy. Proxy checks cache → miss → queries DB → populates cache → returns result. App sees nothing special. |

### 8\. Protocols Used on Cache Miss

The loader function in your app code uses whatever protocol the target database speaks. The cache is not involved — it only ever sees GET and SET on its own protocol.

![Protocols used on cache miss - what wire format does the loader use to talk to the DB](/images/cache-protocols-on-miss.png)

**After the loader returns:** regardless of which DB and protocol was used, your code always calls the same cache command:

redis.set(key, serialized\_value, ex=TTL\_SECONDS)  
\# or: memcache.set(key, value, time=TTL\_SECONDS)

The cache only speaks its own protocol (RESP for Redis on TCP 6379, Memcached binary/text on TCP 11211). Everything else is your app's concern.

## 9\. LinkedIn: Espresso + Couchbase

A real-world case study in why you need both — LinkedIn reaches over **4.8 million profile reads per second**

![LinkedIn Espresso + Couchbase architecture and comparison](/images/linkedin-espresso-couchbase.png)

![LinkedIn complete caching architecture with SCN events and Kafka change streams](/images/linkedin-caching-architecture.png)

**Key takeaway:** Couchbase didn't replace Espresso — it became a tenant of the Espresso ecosystem, fed by the same Kafka change stream it could never have produced itself. The right question is never 'which cache system?' but **'what role does each layer play, and what are the tradeoffs?'**
