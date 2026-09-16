---
title: "Google News"
slug: /hello-interview/hi-google-news
sidebar_position: 3
sidebar_label: "Google News"
description: "Google News"
---
[home](/)/ [hello interview](/docs/hello-interview/hi-index)/ **Google News**

hellointerview·2026-05

Design

[Understanding](#problem) [01 Requirements](#req) [02 Entities & API](#entities) [03 Data collection](#collection) [04 Feed delivery](#feed) [05 Infinite scroll](#scroll) [06 Architecture](#highlevel)

Deep Dives

[07 Cursor pagination](#cursor) [08 Low-latency feeds](#latency) [09 Content freshness](#freshness) [10 Media / thumbnails](#media) [11 Traffic spikes](#spikes) [12 Categories](#categories) [13 Personalization](#personalization) [14 Glossary](#glossary)

News Aggregator 100M DAU RSS + Webhooks < 200ms feeds Cursor Pagination CDC + Caching

Design a news aggregation service that collects articles from thousands of publishers worldwide and serves personalized, low-latency feeds to 100M+ daily users with infinite scroll.

**LinkedIn mapping:** Espresso (metadata), Couchbase/Redis (feed cache), Kafka (CDC + events), Samza (stream processing), Ambry (thumbnails), LinkedIn CDN (edge delivery), d2 (service discovery + LB).

## Understanding the problem {#problem}

Google News is a digital service that aggregates and displays news articles from thousands of publishers worldwide. Users see a scrollable feed of articles — they don’t read on Google News itself, they click through to the publisher’s site. The interesting design challenges are: (1) ingesting content from thousands of heterogeneous sources, (2) serving low-latency feeds at massive scale, and (3) handling traffic spikes during breaking news.

## 01 — Requirements {#req}

##### In scope

-   View aggregated feed from thousands of publishers
-   Infinite scroll through the feed
-   Click article → redirect to publisher site

##### Out of scope

-   Customize feed by interests
-   Save articles for later
-   Share articles on social media

Fig 1 Non-functional pillars

<img src="/diagrams/hi-google-news/1.svg" alt="hi-google-news diagram 1" class="doc-diagram" />

CAP trade-off

Users prefer slightly stale news over no news at all. We choose **availability + eventual consistency** (AP). A user in Mumbai seeing an article 2 seconds later than a user in NYC is perfectly acceptable.

## 02 — Core entities & API {#entities}

Fig 2 Core entities — metadata in Espresso, thumbnails in Ambry

<img src="/diagrams/hi-google-news/2.svg" alt="hi-google-news diagram 2" class="doc-diagram" />

Article IDs use ULIDs (monotonically increasing + sortable) — this simplifies cursor pagination later.

#### API endpoints

```
GET /feed?region={r}&limit={n}&cursor={c}    # paginated feed (cursor = last article ULID)
GET /feed?region={r}&category={cat}&cursor={c} # category-filtered feed
POST /webhooks/article-published              # publisher push notification
```

No “read article” endpoint

When users click an article, the browser navigates directly to `source_url` on the publisher’s site. We’re an aggregator, not a host. (In production, you’d add a redirect endpoint for click analytics.)

## 03 — Data collection: ingesting from publishers {#collection}

Two distinct challenges: **collecting content** from thousands of publishers, and **serving it** to millions of users. They have completely different scaling profiles (write-heavy batch vs read-heavy real-time), so we separate them.

Fig 3 Data collection pipeline — RSS polling + thumbnail extraction

<img src="/diagrams/hi-google-news/3.svg" alt="hi-google-news diagram 3" class="doc-diagram" />

RSS is HTTP-based XML — just GET the feed URL. We store our own thumbnails in Ambry for reliability and consistent sizing.

Why store our own thumbnails?

Publisher images can be slow, change URLs, or go down. Downloading to Ambry gives us control over sizing, format, and availability. LinkedIn CDN then serves them at edge speed.

## 04 — Feed delivery: serving articles to users {#feed}

Fig 4 Feed serving flow

<img src="/diagrams/hi-google-news/4.svg" alt="hi-google-news diagram 4" class="doc-diagram" />

## 05 — Infinite scroll {#scroll}

Fig 5 Offset pagination vs cursor pagination

<img src="/diagrams/hi-google-news/5.svg" alt="hi-google-news diagram 5" class="doc-diagram" />

ULID-based cursors: simple, fast, immune to content drift. Used by Twitter, Instagram, LinkedIn.

```
// First page
GET /feed?region=US&limit=20
// Next page: pass last article's ULID as cursor
GET /feed?region=US&limit=20&cursor=01HX9F3K...
```

## 06 — High-level architecture {#highlevel}

Fig 6 Full architecture — LinkedIn stack

<img src="/diagrams/hi-google-news/6.svg" alt="hi-google-news diagram 6" class="doc-diagram" />

Write path (collection) and read path (feed) are fully separated. CDC via Kafka keeps caches fresh without polling.

| Component | LinkedIn equivalent | Role |
| --- | --- | --- |
| Metadata DB | **Espresso** | Articles, publishers, user prefs |
| Feed cache | **Couchbase / Redis** | Pre-computed sorted sets per region |
| Event stream | **Kafka** | CDC events, new-article notifications |
| Stream processor | **Samza** | Consumes CDC, updates feed caches |
| Blob store | **Ambry** | Thumbnails, resized images |
| CDN | **LinkedIn CDN / Akamai** | Edge-cached thumbnails + static assets |
| Service discovery / LB | **d2** | Client-side LB, service routing |

## 07 — Deep dive: cursor pagination with ULIDs {#cursor}

We use **ULIDs** (Universally Unique Lexicographically Sortable Identifiers) as article IDs. ULIDs encode a timestamp in their first 48 bits, so they’re naturally monotonically increasing. This means article ID order = chronological order, and we can use the ID itself as the cursor.

Fig 7 ULID structure — timestamp + randomness = sortable unique IDs

<img src="/diagrams/hi-google-news/7.svg" alt="hi-google-news diagram 7" class="doc-diagram" />

No composite cursors needed. No timestamp collisions. The single ULID is the cursor.

```sql
-- Espresso query (cursor-based)
SELECT * FROM articles
WHERE region = 'US'
  AND id < :cursor_ulid    -- simple index seek
ORDER BY id DESC
LIMIT 20
```

Why not composite timestamp+ID cursors?

With ULIDs, the ID *is* the timestamp (plus randomness). One field does both jobs. No tuple comparisons, no encoding/decoding. Twitter and Discord use similar approaches.

## 08 — Deep dive: low-latency feeds (< 200ms) {#latency}

100M DAU × 5-10 refreshes = 500M–1B feed requests/day. Querying Espresso directly for each request won’t hit < 200ms at scale. We need pre-computed, cached feeds.

Fig 8 CDC-powered real-time feed caching

<img src="/diagrams/hi-google-news/8.svg" alt="hi-google-news diagram 8" class="doc-diagram" />

Write path: collection → Espresso → CDC → Kafka → Samza → cache. Read path: client → Feed Service → cache (< 5ms).

Why CDC instead of TTL-based cache invalidation?

TTL means feeds go stale for the entire TTL window. CDC via Kafka gives us **sub-second cache freshness** — the moment an article is written to Espresso, the cache is updated. Breaking news appears in feeds within seconds, not minutes.

## 09 — Deep dive: content freshness (< 30min) {#freshness}

Polling RSS every 3–6h means breaking news could be hours late. We need faster options.

Fig 9 Hybrid ingestion: webhooks (push) + RSS polling (fallback)

<img src="/diagrams/hi-google-news/9.svg" alt="hi-google-news diagram 9" class="doc-diagram" />

*want* to be on our platform → strong incentive to implement webhooks

Webhooks for premium real-time (< 30s). Adaptive RSS polling for the rest. Both feed into the same CDC pipeline.

## 10 — Deep dive: media / thumbnails {#media}

Fig 10 Thumbnail pipeline: download, resize, serve via CDN

<img src="/diagrams/hi-google-news/10.svg" alt="hi-google-news diagram 10" class="doc-diagram" />

## 11 — Deep dive: traffic spikes (breaking news) {#spikes}

Breaking news can spike 10M concurrent users in minutes. Three layers need to scale:

Fig 11 Regional scaling — each layer independently scalable

<img src="/diagrams/hi-google-news/11.svg" alt="hi-google-news diagram 11" class="doc-diagram" />

News consumption is regional — deploy per-region clusters. Spikes are isolated. Cache is the hero.

Fig 12 Redis/Couchbase read replica scaling

<img src="/diagrams/hi-google-news/12.svg" alt="hi-google-news diagram 12" class="doc-diagram" />

## 12 — Deep dive: category feeds {#categories}

Users want Sports, Politics, Tech, etc. — not just a regional dump. The simplest approach: **store category metadata in the cache, filter in-memory**.

Fig 13 In-memory category filtering (no separate category caches)

<img src="/diagrams/hi-google-news/13.svg" alt="hi-google-news diagram 13" class="doc-diagram" />

Each article in the cache already has its category. Filter application-side. Simple beats clever.

## 13 — Deep dive: personalization {#personalization}

Instead of 100M user-specific caches, we maintain a few hundred **category + region caches** and assemble personalized feeds on-the-fly by mixing them.

Fig 14 Feed assembly from category caches + user preference vector

<img src="/diagrams/hi-google-news/14.svg" alt="hi-google-news diagram 14" class="doc-diagram" />

100x less memory than per-user caches. Preference vectors are kilobytes. Category caches already exist.

Breaking news boost

During major events, the assembly algorithm temporarily increases the `trending` weight for all users, ensuring breaking news surfaces even for users with narrow interest profiles.

## 14 — Glossary {#glossary}

RSS

XML syndication format. Publishers expose article lists via HTTP GET. Lightweight, standardized, widely supported.

Webhook

Publisher POSTs to our endpoint when a new article is published. Real-time push model, HMAC-signed for auth.

ULID

Universally Unique Lexicographically Sortable Identifier. 48-bit timestamp + 80-bit random. Monotonically increasing = natural cursor.

Cursor pagination

“Give me items after this ID.” Immune to insertion drift. O(log n) index seek. Used by Twitter, Instagram, LinkedIn.

CDC

Change Data Capture. Database changes streamed to Kafka in real-time. Drives cache updates without polling.

Sorted set (ZSET)

Redis/Couchbase data structure. Members scored by timestamp. ZADD, ZREVRANGE, ZREMRANGEBYRANK for feed ops.

Espresso

LinkedIn’s NoSQL document store (MySQL + Helix). Articles, publishers, user prefs.

Couchbase / Redis

LinkedIn uses Couchbase for some caching. Redis sorted sets for feed caches. Both support read replicas.

Kafka

LinkedIn’s event streaming platform. CDC events, new-article notifications, click analytics.

Samza

LinkedIn’s stream processor. Consumes Kafka events, updates feed caches, triggers notifications.

Ambry

LinkedIn’s distributed blob store. Thumbnails stored here, served via CDN.

d2

LinkedIn’s service discovery + client-side load balancing framework. Routes requests, auto-scales.

CAP theorem

Pick 2 of 3: Consistency, Availability, Partition tolerance. News feeds are AP — stale > unavailable.

Read replica

Copy of master that serves reads. Scale read throughput linearly by adding replicas. Lag < 200ms.

Adaptive polling

Vary poll frequency per publisher based on how often they actually publish. Active publishers polled more often.

Content-Type negotiation

Serve WebP/AVIF to browsers that support it, JPEG fallback. Smaller images = faster loads.

Offset pagination

OFFSET + LIMIT SQL. Breaks when new rows are inserted (drift). Slow for large offsets (scans rows). Avoid.

Feed assembly

Mix multiple category caches using user preference weights. Cheaper than per-user caches (100x less memory).

On this page

-   [Understanding](#problem)
-   [01 Requirements](#req)
-   [02 Entities](#entities)
-   [03 Data collection](#collection)
-   [04 Feed delivery](#feed)
-   [05 Infinite scroll](#scroll)
-   [06 Architecture](#highlevel)
-   [07 Cursor pagination](#cursor)
-   [08 Low-latency](#latency)
-   [09 Freshness](#freshness)
-   [10 Media](#media)
-   [11 Traffic spikes](#spikes)
-   [12 Categories](#categories)
-   [13 Personalization](#personalization)
-   [14 Glossary](#glossary)
