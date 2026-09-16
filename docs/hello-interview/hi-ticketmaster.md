---
title: "Ticketmaster"
slug: /hello-interview/hi-ticketmaster
sidebar_position: 4
sidebar_label: "Ticketmaster"
description: "Ticketmaster"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/hi-ticketmaster/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

[home](/)/ [hello interview](/docs/hello-interview/hi-index)/ **Ticketmaster**

hellointerview·2026-05

Design

[01 Requirements](#req) [02 Entities & API](#entities) [03 View events](#view) [04 Search events](#search) [05 Book tickets](#book)

Deep Dives

[06 Contention problem](#contention) [07 Distributed lock](#redislock) [08 Scaling reads](#scale-reads) [09 Virtual waiting room](#waiting-room) [10 Search (Galene)](#search-perf) [11 Real-time seat map](#real-time) [12 Complete flow](#full) [13 Glossary](#glossary)

Ticketing No Double-Booking Search (Galene) Distributed Locks 100:1 read:write 10M concurrent

Design a system where users browse events, search by keyword/date/location, view a live seat map, and book tickets — all while preventing two users from buying the same seat. The interesting parts are **contention** (a seat can only be sold once), **scaling reads** (popular events get hammered), and **graceful overload handling** when 10M people refresh at the same instant.

**LinkedIn mapping:** Espresso (events/tickets/bookings), Couchbase (read cache + distributed locks), Kafka (CDC events), Samza (stream processing), Galene (search), LinkedIn CDN (static assets), d2 (service discovery + LB).

## 01 — Requirements {#req}

##### In scope

-   View events (with seat map)
-   Search events by keyword, date, location, type
-   Book tickets (no double-booking)

##### Out of scope

-   View user’s booked events
-   Admin event creation
-   Dynamic pricing / GDPR

Fig 1 Non-functional targets — different parts have different consistency needs

<img src="/diagrams/hi-ticketmaster/1.svg" alt="hi-ticketmaster diagram 1" class="doc-diagram" />

Read path = AP (stale seat map OK for a few seconds). Booking path = CP (no two users get the same seat).

The single hardest constraint

Two users CANNOT buy the same seat. If we mess this up, someone shows up to a stadium with a ticket only to find someone else in their seat. Everything else bends around this.

## 02 — Core entities & API {#entities}

Fig 2 Six entities — all stored in Espresso. Tickets pre-created per seat when event is created.

<img src="/diagrams/hi-ticketmaster/2.svg" alt="hi-ticketmaster diagram 2" class="doc-diagram" />

#### API endpoints

```
GET  /events/:eventId                              # returns event + venue + performer + tickets[]
GET  /events/search?keyword=&start=&end=&page=     # full-text via Galene
POST /reserve/:eventId  { ticketIds[] }             # acquire lock, create in-progress booking
POST /confirm/:bookingId { paymentToken }           # charge + finalize
```

Why a separate Booking entity?

When a user buys 4 seats in one transaction, you want them grouped under one order with one total price and one payment status. Easier to refund, easier to email a receipt.

## 03 — View events {#view}

Fig 3 View event flow — three hops

<img src="/diagrams/hi-ticketmaster/3.svg" alt="hi-ticketmaster diagram 3" class="doc-diagram" />

1.  **Client requests.** `GET /events/:eventId` fired when user navigates to an event page.
2.  **d2 routes.** Validates auth, applies rate limits, routes to Event Service via d2 client-side LB.
3.  **Event Service queries Espresso.** Joins Events, Venues, Performers + all Tickets for the event.
4.  **Response assembled.** Returns event metadata + seat\_map JSON + ticket statuses. Client renders interactive seat map.

## 04 — Search events {#search}

Fig 4 Naive search — good starting point, doesn’t scale (Section 10 fixes it)

<img src="/diagrams/hi-ticketmaster/4.svg" alt="hi-ticketmaster diagram 4" class="doc-diagram" />

Why this is bad

`LIKE '%Taylor%'` can’t use a B-tree index because of the leading `%`. It’s a full table scan. With millions of events, that’s seconds per query. We’ll replace this with **Galene** (LinkedIn’s search platform, built on Lucene) in Section 10.

## 05 — Book tickets (simple version) {#book}

Fig 5 Simple booking flow — race conditions waiting to happen

<img src="/diagrams/hi-ticketmaster/5.svg" alt="hi-ticketmaster diagram 5" class="doc-diagram" />

Sections 6 + 7 fix this with a reservation lock.

This works for low traffic but has a glaring UX problem: the user enters their card details, but during those 30+ seconds, someone else can buy the seat. User clicks pay and gets “this seat is no longer available.”

## 06 — The contention problem {#contention}

For popular events, 100K users might all see one seat as available at the same moment. Only one can have it.

### Approach 1 — Status column + cron job

Fig 6 Status + cron — works for small scale, brittle in production

<img src="/diagrams/hi-ticketmaster/6.svg" alt="hi-ticketmaster diagram 6" class="doc-diagram" />

### Approach 2 — Couchbase distributed lock (the winner)

Use **Couchbase** (LinkedIn’s distributed cache) to hold a short-lived reservation with automatic expiry. Espresso handles the final “booked” state with row-level locks; Couchbase handles the temporary reservation. Each tool does what it’s best at.

##### Why Couchbase

-   Native key TTL — auto-expire reservations
-   CAS (Compare-And-Swap) is atomic — no race on lock acquisition
-   In-memory → microsecond ops at high concurrency
-   LinkedIn already runs Couchbase at massive scale

##### Tradeoffs

-   Read path needs to merge Couchbase state to show “reserved” seats
-   If Couchbase goes down, fallback to Espresso-only flow with degraded UX
-   One more system to coordinate (but already in LinkedIn’s stack)

## 07 — Distributed lock — full reservation flow {#redislock}

Fig 7 Full reservation + payment flow with Couchbase lock (sequence diagram)

<img src="/diagrams/hi-ticketmaster/7.svg" alt="hi-ticketmaster diagram 7" class="doc-diagram" />

Couchbase CAS (Compare-And-Swap) is atomic. Even if 1M servers try to lock the same ticket simultaneously, exactly one succeeds.

Couchbase CAS = atomic lock acquisition

Couchbase’s INSERT with CAS is equivalent to Redis SET NX. It’s a single atomic operation. Combined with TTL auto-expiry, it gives us distributed locks with zero race conditions and automatic cleanup.

Edge case: lock expires during payment

User starts payment at minute 9:55, 10-minute lock expires at 10:00, payment completes at 10:02. Another user could’ve reserved the seat in those 2 seconds. The Espresso OCC check in step 10 catches this → issue refund via Stripe. Mitigation: set lock TTL generously (15 min), or extend the lock when payment starts.

## 08 — Scaling reads — cache pyramid {#scale-reads}

Fig 8 Cache pyramid — each layer absorbs traffic before it reaches the next

<img src="/diagrams/hi-ticketmaster/8.svg" alt="hi-ticketmaster diagram 8" class="doc-diagram" />

Each layer absorbs traffic. CDN handles the thundering herd. Espresso primary only sees writes.

#### What we DON’T cache aggressively

Seat availability changes constantly. Caching it for 5 minutes means users see stale “available” seats and get errors at checkout. Two options:

-   **Short TTL (5–10 seconds)** on seat availability, accept some staleness.
-   **Real-time push** (Section 11) — client opens an SSE stream and receives seat updates as they happen.

## 09 — Virtual waiting room for hot events {#waiting-room}

Fig 9 Waiting room — throttle at the door instead of crashing inside

<img src="/diagrams/hi-ticketmaster/9.svg" alt="hi-ticketmaster diagram 9" class="doc-diagram" />

Staff-level insight

Sometimes the best engineering is recognizing you can’t fight physics. You can’t process 10M booking transactions per second with strong consistency. The queue gives users a fair, predictable experience and lets us match throughput to actual capacity.

## 10 — Search performance with Galene {#search-perf}

Espresso `LIKE '%query%'` can’t use indexes; full table scan every search. Solution: **Galene**, LinkedIn’s search platform built on Lucene with inverted indexes.

### Inverted index: forward vs inverted

Fig 10 Inverted index makes keyword search O(1) instead of O(N)

<img src="/diagrams/hi-ticketmaster/10.svg" alt="hi-ticketmaster diagram 10" class="doc-diagram" />

### Keeping Galene in sync with Espresso

Fig 11 Espresso stays source of truth; Kafka CDC keeps Galene eventually consistent

<img src="/diagrams/hi-ticketmaster/11.svg" alt="hi-ticketmaster diagram 11" class="doc-diagram" />

#### Caching popular search queries

```
cache_key = hash(keyword + filters + page + sort)
cache_val = JSON of result IDs
TTL       = 60 seconds (Couchbase)

flow:
  1. Search Service computes cache_key
  2. Try Couchbase GET. Hit → return immediately
  3. Miss → query Galene
  4. Store result in Couchbase with TTL
  5. Return to client

// This single optimization offloads 80%+ of search traffic on hot terms
```

## 11 — Real-time seat map updates {#real-time}

Fig 12 Real-time seat updates via Kafka pub/sub + SSE

<img src="/diagrams/hi-ticketmaster/12.svg" alt="hi-ticketmaster diagram 12" class="doc-diagram" />

Users see seats turn unavailable in near-real-time, reducing failed booking attempts.

When NOT to do this

For an event with 20 seats sold over 6 months, real-time updates are overkill. Use short-TTL polling instead. Reserve SSE for high-velocity events where the seat map changes second-by-second.

## 12 — Complete end-to-end architecture {#full}

Fig 13 Full architecture — LinkedIn stack

<img src="/diagrams/hi-ticketmaster/13.svg" alt="hi-ticketmaster diagram 13" class="doc-diagram" />

View, search, and book each take a different route. Booking = CP (Couchbase lock + Espresso OCC). View/Search = AP (CDN + cache + replicas).

| Component | LinkedIn equivalent | Role |
| --- | --- | --- |
| Primary DB | **Espresso** | Events, Tickets, Bookings, Venues, Performers |
| Cache + Locks | **Couchbase** | Distributed locks, read cache, search cache, waiting room queue |
| Search engine | **Galene** | Inverted index, fuzzy matching, geo + date filters |
| Event stream | **Kafka** | CDC events, seat change notifications, audit stream |
| CDC connector | **Brooklin** | Tails Espresso change log, publishes to Kafka |
| Stream processor | **Samza** | Fan-out seat updates to SSE servers, Galene indexing |
| CDN | **LinkedIn CDN / Akamai** | Edge-cached event pages, static assets |
| Service discovery | **d2** | Client-side LB, service routing, auto-scaling |
| Payment | **Stripe (external)** | PCI-compliant payment processing, webhooks |

#### Complete user journey

1.  **Browse homepage.** Static assets from LinkedIn CDN. Featured events cached at edge.
2.  **Search “Taylor Swift.”** API Gateway → Search Service → Galene (Couchbase cache for hot queries) → results.
3.  **Open event page.** Event Service queries Couchbase cache, falls through to Espresso read replicas.
4.  **SSE connection opens.** Client subscribes to seat updates for this event.
5.  **Hot event? Waiting room.** Admin-flagged events route users into Couchbase queue before allowing booking.
6.  **Pick a seat → Reserve.** Booking Service acquires Couchbase lock (CAS + TTL=600s). Creates in-progress booking row in Espresso.
7.  **Seat update broadcast.** Kafka → Samza → SSE servers → every viewer sees the seat go green → yellow.
8.  **Enter card → Confirm.** Stripe.js tokenizes card client-side. Booking Service calls Stripe PaymentIntent.
9.  **Stripe webhook fires.** Espresso transaction: UPDATE ticket status=’booked’ (OCC check), UPDATE booking status=’confirmed’. Idempotent on Stripe event ID.
10.  **Booked event broadcast.** Kafka fan-out → all viewers see seat go yellow → red.
11.  **Lock released.** DEL the Couchbase key or let TTL expire.
12.  **CDC syncs.** Espresso change log → Brooklin → Kafka → Galene index updated.

## 13 — Glossary {#glossary}

Espresso

LinkedIn’s NoSQL document store (MySQL + Helix). Source of truth for events, tickets, bookings.

Couchbase

LinkedIn’s distributed cache. Used here for distributed locks (CAS + TTL), read cache, search cache, and waiting room queues.

Galene

LinkedIn’s search platform built on Lucene. Inverted indexes, tokenization, fuzzy matching, geo queries.

Kafka

LinkedIn’s event streaming platform. CDC events, seat change notifications, audit stream.

Brooklin

LinkedIn’s CDC connector. Tails Espresso change logs, publishes to Kafka. Keeps Galene in sync.

Samza

LinkedIn’s stream processor. Consumes Kafka events, fans out seat updates to SSE servers.

d2

LinkedIn’s service discovery + client-side load balancing. Routes requests, auto-scales services.

CAS (Compare-And-Swap)

Couchbase atomic operation. Insert-if-not-exists with TTL. Equivalent to Redis SET NX EX. Foundation of distributed locks.

Distributed Lock

Lock primitive across multiple servers. Couchbase CAS + TTL implements this with auto-expiry on reservation timeout.

OCC

Optimistic Concurrency Control. Check the row hasn’t changed during transaction (WHERE status=’available’). Detects races at write time.

Inverted Index

Maps “word → list of documents containing the word.” Powers O(1) full-text search instead of O(N) table scans.

Tokenization

Breaking text into searchable units (words, stems). “Taylor’s” → \[“taylor”\]. Done at index time for fast queries.

Fuzzy Matching

Matching words despite typos (Levenshtein edit distance). “Taylr” still finds “Taylor.”

CDC

Change Data Capture. Watching Espresso’s change log and emitting events for every change. Keeps Galene in sync.

Virtual Waiting Room

Queue users enter before being admitted to booking. Throttles traffic to sustainable levels. Fair ordering by timestamp.

SSE

Server-Sent Events. HTTP-based one-way push from server to browser. Used for seat updates and queue position.

Contention

Multiple users trying to modify the same resource. Tickets are the contention point in this system.

Stripe

External payment processor. Tokenizes card data client-side (PCI compliance). Webhooks for async payment confirmation.

Idempotency

Same operation retried safely produces same result. Critical for Stripe webhook handlers (check event ID).

Stale-While-Revalidate

CDN serves stale content immediately while fetching fresh content in background. Hides origin latency.

CAP Theorem

Pick 2 of: Consistency, Availability, Partition tolerance. Booking = CP. View/Search = AP.

Read Replica

Read-only Espresso copy. Asynchronously replicated. Absorbs read load from Event Service.

ACID

Atomicity, Consistency, Isolation, Durability. Espresso provides this for booking transactions.

PaymentIntent

Stripe’s record of an intended payment. Survives retries; idempotent by design.

On this page

-   [01 Requirements](#req)
-   [02 Entities](#entities)
-   [03 View events](#view)
-   [04 Search](#search)
-   [05 Book tickets](#book)
-   [06 Contention](#contention)
-   [07 Dist. lock](#redislock)
-   [08 Scaling reads](#scale-reads)
-   [09 Waiting room](#waiting-room)
-   [10 Search (Galene)](#search-perf)
-   [11 Real-time seats](#real-time)
-   [12 Full architecture](#full)
-   [13 Glossary](#glossary)
