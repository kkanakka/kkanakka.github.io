---
title: "Key technologies, compact"
slug: /system-design-notes/key-tech
sidebar_position: 2
sidebar_label: "Key technologies, compact"
description: "one paragraph each · what · when · must‑know · names"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/key-tech/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">one paragraph each · what · when · must‑know · names</span>
</header>
<p>Know one tool per box well enough to explain how it works inside. Interviewers care that you have a tool and can reason about it, not which one.</p>
<div class="cards">
  <div><h4>Relational DB (Postgres, MySQL)</h4><ul>
    <li><b>What:</b> tables, rows, SQL, ACID.</li>
    <li><b>When:</b> transactional data, product‑design interviews, invariants (money, inventory).</li>
    <li><b>Know:</b> joins (powerful, expensive), any number of indexes incl. composite/geo/full‑text, transactions = all‑or‑nothing across tables.</li>
    <li><b>Say:</b> "Postgres, because ACID protects the invariant." Never open with SQL‑vs‑NoSQL.</li>
    <li><b>Use:</b> Ticketmaster bookings, Uber trips/payments, Flash Sale reservations, any orders/accounts.</li></ul></div>
  <div><h4>NoSQL (DynamoDB, Cassandra, MongoDB)</h4><ul>
    <li><b>What:</b> key‑value / document / column‑family / graph; schema‑flexible; scale out via sharding + consistent hashing.</li>
    <li><b>When:</b> infra‑design interviews, huge write volume, access patterns known upfront.</li>
    <li><b>Know:</b> partition key + sort key design, consistency knobs (strong vs eventual), no cross‑partition joins/transactions, hot partitions.</li>
    <li><b>Say:</b> DynamoDB default; Cassandra for append‑heavy writes (LSM, tunable consistency).</li>
    <li><b>Use:</b> Instagram posts by user, chat messages (Cassandra), IoT/metrics writes, shopping cart, feature flags.</li></ul></div>
  <div><h4>Blob storage (S3, GCS)</h4><ul>
    <li><b>What:</b> upload bytes, get a URL back. Effectively unlimited, ~11 nines durable, ~$0.02/GB‑mo vs ~$1.25 in DynamoDB.</li>
    <li><b>When:</b> images, video, files. DB stores only the pointer.</li>
    <li><b>Know:</b> presigned URLs (client uploads/downloads directly, time‑limited), multipart/chunked upload for resume + parallelism, completion notification, CDN in front.</li>
    <li><b>Never:</b> media bytes in the database.</li>
    <li><b>Use:</b> YouTube videos, Instagram photos, Dropbox files, resumes/PDFs; DB keeps only the URL.</li></ul></div>
  <div><h4>Search DB (Elasticsearch)</h4><ul>
    <li><b>What:</b> inverted index word → [docs], built on Lucene.</li>
    <li><b>When:</b> full‑text search, fuzzy match, faceting. <code>LIKE '%x%'</code> is a table scan.</li>
    <li><b>Know:</b> tokenization, stemming (running→run), fuzzy = edit distance, shards + replicas, fed from the primary DB via CDC so it's slightly stale.</li>
    <li><b>Alt:</b> Postgres GIN full‑text if small; PostGIS for geo.</li>
    <li><b>Use:</b> Yelp "pizza near me", Ticketmaster event search, Twitter search, product catalog with typos/fuzzy.</li></ul></div>
  <div><h4>API Gateway (AWS API GW, Kong, nginx)</h4><ul>
    <li><b>What:</b> single entry point; routes <code>/users/*</code> → users service.</li>
    <li><b>When:</b> always, as the first box after the client.</li>
    <li><b>Know:</b> auth, rate limiting, logging, TLS termination live here. Interviewers rarely dig in; mention and move on.</li>
    <li><b>Use:</b> First box in every product design: routes /users, /orders to their services; enforces JWT + 429.</li></ul></div>
  <div><h4>Load balancer (ALB/ELB, nginx, HAProxy)</h4><ul>
    <li><b>What:</b> spreads requests over N identical instances.</li>
    <li><b>When:</b> anywhere N&gt;1; draw only at the front, say "horizontally scaled" elsewhere.</li>
    <li><b>Know:</b> L7 routes on HTTP content (default); L4 forwards TCP, faster, required for WebSockets. Sticky sessions only if you must.</li>
    <li><b>Use:</b> In front of any stateless service fleet; L4 for WhatsApp/chat WebSocket servers.</li></ul></div>
  <div><h4>Queue (SQS, Kafka‑as‑queue)</h4><ul>
    <li><b>What:</b> producer sends and forgets; workers consume at their pace.</li>
    <li><b>When:</b> bursty traffic buffer, distributing expensive work (image processing). Not on a path with a tight latency SLA.</li>
    <li><b>Know:</b> FIFO by default, retries + delay, dead‑letter queue for poison messages, partitions with a partition key for scale/order, <b>backpressure</b> (a queue hides missing capacity; reject or slow producers when it fills).</li>
    <li><b>Use:</b> Uber ride‑request bursts, image/video transcoding after upload, email/notification sending, webhook processing.</li></ul></div>
  <div><h4>Stream / event sourcing (Kafka, Kinesis, Flink)</h4><ul>
    <li><b>What:</b> retained, replayable log; many consumer groups read independently.</li>
    <li><b>When:</b> real‑time analytics, event sourcing (rebuild state by replay, audit), pub/sub fan‑out (chat room).</li>
    <li><b>Know:</b> partition key → ordering per partition, consumer groups, replication, windowing (tumbling/sliding aggregates). Flink/Spark for processing.</li>
    <li><b>Use:</b> Ad‑click aggregation, real‑time like/comment counters, bank ledger replay, chat room fan‑out, CDC to Elasticsearch.</li></ul></div>
  <div><h4>Distributed lock (Redis, ZooKeeper/etcd)</h4><ul>
    <li><b>What:</b> key with TTL that only one process can hold; DB transaction locks are too short‑lived for a 10‑minute hold.</li>
    <li><b>When:</b> ticket/cart hold, driver matching, single‑runner cron, auction close.</li>
    <li><b>Know:</b> <code>SET NX PX</code>, TTL so crashes release, Redlock (multi‑node, contested; Kleppmann critique), ZooKeeper for consensus‑grade correctness, granularity, deadlock prevention = fixed lock order + timeouts.</li>
    <li><b>Use:</b> Ticketmaster seat hold 10 min, Uber driver matched to one rider, single runner for a daily cron, auction final bid.</li></ul></div>
  <div><h4>Distributed cache (Redis, Memcached)</h4><ul>
    <li><b>What:</b> in‑memory servers, ~1 ms.</li>
    <li><b>When:</b> precomputed metrics, sessions, expensive query results (feeds).</li>
    <li><b>Know:</b> eviction LRU/LFU/FIFO, invalidation on write, write‑through/around/back, and <b>say the data structure</b> (sorted set for "top events", hash for objects).</li>
    <li><b>Use:</b> Sessions, Twitter home feed, Yelp business page, hourly dashboard metrics, rate‑limit counters, waiting‑room order.</li></ul></div>
  <div><h4>CDN (Cloudflare, Akamai, CloudFront)</h4><ul>
    <li><b>What:</b> geographic cache at edge PoPs; miss → fetch from origin, cache, serve.</li>
    <li><b>When:</b> static media always; also cacheable API/HTML responses that change rarely.</li>
    <li><b>Know:</b> TTL + purge/invalidation, DDoS + WAF come bundled, origin = S3 or your service.</li>
    <li><b>Use:</b> Profile pictures, video segments (HLS chunks), JS/CSS bundles, a blog post updated daily, public GET APIs.</li></ul></div>
</div>

## Blob upload / download flow (draw it once, reuse everywhere) {#kt-blob}

<figure>
<svg viewBox="0 0 980 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Presigned URL upload flow: client asks server for presigned URL, server records in DB, client uploads to S3, S3 notifies server; downloads go via CDN">
  <defs><marker id="a6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="a7" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker></defs>
  <style>.b{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.h{font-size:13px;font-weight:600;fill:#1B2430}.s{font-size:11px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#a6)}.fp{stroke:#6B2D6B;stroke-width:1.6;fill:none;marker-end:url(#a7)}.an{font-size:11px;fill:#1F4E9E}.ap{font-size:11px;fill:#6B2D6B}</style>
  <rect class="b" x="20" y="80" width="100" height="50"></rect><text class="h" x="70" y="109" text-anchor="middle">Client</text>
  <rect class="b" x="260" y="80" width="110" height="50"></rect><text class="h" x="315" y="109" text-anchor="middle">Server</text>
  <rect class="b" x="480" y="80" width="130" height="50"></rect><text class="h" x="545" y="101" text-anchor="middle">DB</text><text class="s" x="545" y="118" text-anchor="middle">entity.s3Url, status</text>
  <rect class="b" x="260" y="10" width="110" height="46" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="h" x="315" y="30" text-anchor="middle">S3</text><text class="s" x="315" y="46" text-anchor="middle">origin</text>
  <rect class="b" x="260" y="150" width="110" height="46" stroke="#0F766E" fill="#DDF3F0"></rect><text class="h" x="315" y="170" text-anchor="middle">CDN</text><text class="s" x="315" y="186" text-anchor="middle">edge cache</text>
  <path class="f" d="M120 95 L258 95"></path><text class="an" x="128" y="88">1 want to upload</text>
  <path class="f" d="M258 112 L122 112"></path><text class="an" x="128" y="128">2 presigned PUT url</text>
  <path class="f" d="M370 105 L478 105"></path><text class="an" x="378" y="98">record pending</text>
  <path class="fp" d="M110 80 C 150 40, 200 33, 258 33"></path><text class="ap" x="120" y="30">3 PUT bytes directly (multipart if large)</text>
  <path class="fp" d="M315 56 L315 78"></path><text class="ap" x="322" y="72">4 upload‑complete event</text>
  <path class="f" d="M370 160 C 300 160, 250 165, 258 165" stroke="none"></path>
  <path class="f" d="M120 120 C 160 150, 200 173, 258 173"></path><text class="an" x="128" y="160">5 GET via presigned url</text>
  <path class="fp" d="M340 150 C 400 110, 400 60, 370 40"></path><text class="ap" x="400" y="150">miss → origin</text>
  <text class="s" x="640" y="95">Server never proxies bytes.</text>
  <text class="s" x="640" y="111">DB holds the pointer + status.</text>
  <text class="s" x="640" y="127">Presigned = time‑limited, scoped auth.</text>
</svg>
</figure>

## Queue vs stream in one picture {#kt-queue}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/key-tech/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<figure>
<svg viewBox="0 0 980 170" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Queue: message removed after ack by one worker. Stream: retained log read by multiple consumer groups at their own offsets">
  <defs><marker id="a8" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker></defs>
  <style>.b{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.h{font-size:13px;font-weight:600;fill:#1B2430}.s{font-size:11px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#a8)}.m{font-size:11px;font-family:"IBM Plex Mono",Menlo,monospace;fill:#1B2430}</style>
  <text class="h" x="20" y="24">Queue (SQS)</text>
  <rect class="b" x="20" y="40" width="80" height="40"></rect><text class="h" x="60" y="65" text-anchor="middle">Producer</text>
  <rect class="b" x="140" y="40" width="150" height="40" stroke="#B45309"></rect><text class="m" x="215" y="65" text-anchor="middle">[m3][m2][m1]</text>
  <rect class="b" x="330" y="40" width="80" height="40"></rect><text class="h" x="370" y="65" text-anchor="middle">Worker</text>
  <path class="f" d="M100 60 L138 60"></path><path class="f" d="M290 60 L328 60"></path>
  <text class="s" x="20" y="110">1 send · 2 store · 3 dispatch · 4 ack · 5 delete</text>
  <text class="s" x="20" y="126">Consumed once. Fail N times → dead‑letter queue.</text>
  <text class="s" x="20" y="142">Full queue → backpressure: 503 / slow the producer.</text>

  <text class="h" x="540" y="24">Stream (Kafka)</text>
  <rect class="b" x="540" y="40" width="80" height="40"></rect><text class="h" x="580" y="65" text-anchor="middle">Producer</text>
  <rect class="b" x="660" y="40" width="170" height="40" stroke="#B45309"></rect><text class="m" x="745" y="65" text-anchor="middle">0 1 2 3 4 5 6 7 …</text>
  <rect class="b" x="870" y="20" width="90" height="34"></rect><text class="s" x="915" y="42" text-anchor="middle">group A @7</text>
  <rect class="b" x="870" y="64" width="90" height="34"></rect><text class="s" x="915" y="86" text-anchor="middle">group B @3</text>
  <path class="f" d="M620 60 L658 60"></path><path class="f" d="M830 52 L868 40"></path><path class="f" d="M830 68 L868 80"></path>
  <text class="s" x="540" y="110">Retained for days; each group keeps its own offset; replay by rewinding.</text>
  <text class="s" x="540" y="126">Ordered within a partition (partition key); scale by adding partitions.</text>
  <text class="s" x="540" y="142">Event sourcing = the log is the truth, state is a projection.</text>
</svg>
</figure>
