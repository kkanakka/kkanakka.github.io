---
title: "System Design Basics"
slug: /foundations/system-design-basics
sidebar_position: 1
sidebar_label: "System Design Basics"
description: "System Design Basics"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/system-design-basics/sequence.svg" alt="How it works — system-design-basics" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
[Networking 101 (deep dive)](/docs/linux/linux-networking) [System Design Hub](/docs/foundations)

Visual cheatsheet for interviews. Diagrams first, prose second. Each block ends with a "where to use" callout.

### 12 Topics · diagrams + use-cases

[01Three layers we care about](#layers) [02HTTP request lifecycle](#req-life) [03TCP vs UDP vs QUIC](#l4) [04HTTP / HTTPS anatomy](#http) [05REST APIs](#rest) [06GraphQL](#graphql) [07gRPC](#grpc) [08Server-Sent Events (SSE)](#sse) [09WebSockets](#ws) [10WebRTC](#webrtc) [11Load balancing landscape](#lb) [12Retries, idempotency, breakers](#reliab)

<a id="layers"></a>

🥞01The three layers we care about

OSI has 7 layers. For interviews, the three that matter are L3 (IP), L4 (TCP/UDP/QUIC), and L7 (HTTP, gRPC, WS).

<img src="/diagrams/system-design-basics/1.svg" alt="system-design-basics diagram 1" class="doc-diagram" />

#### Where to use this

-   **Identify the layer** when proposing a protocol ("WebSocket — L7 over a long-lived TCP connection at L4").
-   **L4 vs L7 LB** is the most common networking question — covered in topic 11.

<a id="req-life"></a>

📨02HTTP request lifecycle (DNS → TCP → request → teardown)

The classic "what happens when you type a URL" sequence diagram.

<img src="/diagrams/system-design-basics/2.svg" alt="system-design-basics diagram 2" class="doc-diagram" />

#### What to remember

-   **Connection setup is expensive** (≥ 1 RTT for TCP, +1–2 for TLS). HTTP/2 keep-alive amortizes it across many requests.
-   **State on both ends.** Each open TCP connection costs memory on client + server — relevant once you scale to millions of connections (chat, push, gaming).

<a id="l4"></a>

🚦03TCP vs UDP vs QUIC

##### TCP — workhorse

Reliable, ordered, error-checked. 3-way handshake. Flow + congestion control. Default for "everything else."

##### UDP — fire & forget

Connectionless. No delivery / order / dedup guarantees. Just src/dst IP+port + payload. Lower latency, less overhead.

##### QUIC — modern TCP

Runs over UDP. Built-in TLS 1.3, 0-RTT resumption, no head-of-line blocking. Powers HTTP/3.

| Feature | UDP | TCP | QUIC |
| --- | --- | --- | --- |
| Connection | Connectionless | Connection-oriented | Connection-oriented (over UDP) |
| Reliability | Best effort | Guaranteed | Guaranteed |
| Ordering | None | Yes (per stream) | Yes (per-stream, no HoL block) |
| Flow / congestion | None | Yes | Yes |
| Encryption | App-defined (DTLS opt.) | +TLS layer | Built in (TLS 1.3) |
| Header size | 8 B | 20–60 B | ~26 B |
| Speed | Fastest | Slowest of the three | Fast (0/1-RTT setup) |
| Browser support | WebRTC only | Universal | HTTP/3 (growing) |

#### How to choose

-   **Default → TCP.** Interviewers assume it. You don't need to mention it explicitly.
-   **Reach for UDP** when low latency > reliability: live video, VoIP, gaming, DNS, telemetry where loss is OK.
-   **Mention QUIC / HTTP/3** for performance-focused interviews, but don't optimize on it before fixing real bottlenecks.
-   **Hybrid is common** — e.g. video conferencing: TCP/HTTP for signaling, UDP/WebRTC for media.

<a id="http"></a>

📦04HTTP / HTTPS anatomy

Stateless request/response. Method + path + headers + (optional) body. Standardized status codes.

REQUEST RESPONSE ──────────────────────────────────── ──────────────────────────────────── GET /users/42 HTTP/2 HTTP/2 200 OK Host: api.example.com Content-Type: application/json Authorization: Bearer eyJ… Content-Encoding: br Accept: application/json Cache-Control: no-store Accept-Encoding: gzip, br ETag: "v17-9f3a" (no body for GET) {"id":42,"name":"Ada Lovelace"}

##### 2xx Success

**200** OK · **201** Created · **204** No Content

##### 3xx Redirect

**301** Moved (perm) · **302** Found · **304** Not Modified

##### 4xx Client

**400** Bad · **401** Auth · **403** Forbidden · **404** Not Found · **409** Conflict · **429** Rate-limit

##### 5xx Server

**500** Error · **502** Bad Gateway · **503** Unavailable · **504** Timeout

##### Methods

**GET** read · **POST** create · **PUT** replace · **PATCH** partial update · **DELETE**

##### HTTPS = HTTP + TLS

Encrypts payload & integrity-checks. **Doesn't** validate the request body — always validate user IDs server-side.

#### Where to use this

-   **Default for client ↔ server** traffic. Stateless, cacheable, well-understood.
-   **Status codes matter** for retry logic: `5xx` + `408`/`429` are retryable, `4xx` generally not.
-   **Headers are flexible.** Use them for content negotiation (`Accept-Encoding`), tracing (`X-Request-Id`), and idempotency keys.

<a id="rest"></a>

🔁05REST — resource-oriented APIs

Model your domain as *resources* (nouns), not operations (verbs). HTTP method + path expresses intent.

RESOURCE VERB PATH RESULT ───────────────────────────────────────────────────────────────── User GET /users → list users User GET /users/{id} → one user User POST /users → create (server assigns id) User PUT /users/{id} → replace User PATCH /users/{id} → partial update User DELETE /users/{id} → remove Posts of a user GET /users/{id}/posts → nested resource

##### ❌ Operation-shaped (anti-pattern)

`POST /updateUser`  
`POST /startGame`

##### ✅ Resource-shaped

`PUT /users/{id}`  
`PATCH /games/{id} { "status": "started" }`

#### Where to use this

-   **Default API style** for public + most internal HTTP services. Easy to cache, easy to teach, easy to reason about.
-   **Reach for something else** only if you have specific needs: real-time push (SSE/WS), high throughput internal RPC (gRPC), flexible client queries (GraphQL).

<a id="graphql"></a>

🎯06GraphQL — client picks the shape

Solves over-fetching (REST returns too much) and under-fetching (REST needs N round-trips for one screen).

<img src="/diagrams/system-design-basics/3.svg" alt="system-design-basics diagram 3" class="doc-diagram" />

#### Where to use this

-   **Mobile + web frontends** with rapidly changing screens — clients pick fields without backend redeploys.
-   **Multiple teams** querying overlapping data on a shared graph (Facebook-scale problem).
-   **Skip in interviews** with fixed requirements; mention only if interviewer signals "rapid iteration / unknown future queries."
-   **Watch out:** resolver fan-out can N+1 your DB. Need DataLoader / batching.

<a id="grpc"></a>

⚡07gRPC — binary RPC over HTTP/2

Schema-first (Protocol Buffers) → smaller, faster, type-safe. Built for service-to-service.

##### JSON over HTTP/1.1 — 40 bytes

{ "id": "123", "name": "John Doe" }

##### Protobuf over HTTP/2 — 15 bytes

0A 03 31 32 33 12 08 6A 6F 68 6E 20 64 6F 65 ← <3x smaller

.proto schema (single source of truth) message User { string id = 1; string name = 2; } message GetUserRequest { string id = 1; } message GetUserResponse { User user = 1; } service UserService { rpc GetUser (GetUserRequest) returns (GetUserResponse); rpc StreamPosts (StreamReq) returns (stream Post); // server streaming } ──────────────────────────────── protoc generates client + server stubs in Go, Java, Python, Rust, ...

#### Where to use this

-   **Internal service-to-service** in microservices. Strong typing catches errors at compile time.
-   **Performance-critical paths** — some benchmarks show 10× throughput vs JSON/HTTP.
-   **Avoid for public APIs / browsers.** Tooling is heavier, no native browser support.
-   **Common pattern:** gRPC inside the DC, REST at the edge.

<a id="sse"></a>

📺08Server-Sent Events (SSE) — server pushes, one direction

A "long" HTTP response that the server keeps writing chunks into. Browser-native via `EventSource`, auto-reconnect with last-id replay.

<img src="/diagrams/system-design-basics/4.svg" alt="system-design-basics diagram 4" class="doc-diagram" />

#### Where to use this

-   **Server-to-client only** push: live prices, auction bids, deployment logs, AI token streaming.
-   **Pros:** trivial setup, runs over plain HTTP, browser-native, plays nice with proxies and load balancers.
-   **Watch out:** some middleboxes buffer the response (defeating the streaming). Connections eventually drop — design for reconnect with `Last-Event-Id` replay.

<a id="ws"></a>

🔄09WebSockets — bidirectional, persistent

HTTP "Upgrade" handshake → the same TCP connection becomes a full-duplex binary channel. Both sides can push at any time.

<img src="/diagrams/system-design-basics/5.svg" alt="system-design-basics diagram 5" class="doc-diagram" />

#### Where to use this

-   **True bidirectional realtime:** chat, multiplayer games, collaborative cursors, trading desks.
-   **Use an L4 load balancer** in front (or an L7 LB that explicitly understands WS upgrade). The flow stays pinned to one server.
-   **Stateful = expensive.** Plan for connection storms, sticky routing, and per-server connection limits.
-   **Don't WS by default.** If client only needs server pushes, prefer SSE. If only request/response, prefer HTTP.

<a id="webrtc"></a>

🔗10WebRTC — peer-to-peer with NAT traversal

The only browser-accessible UDP. Peers connect *directly* after a brief signaling dance, with STUN/TURN to punch through NATs.

<img src="/diagrams/system-design-basics/6.svg" alt="system-design-basics diagram 6" class="doc-diagram" />

#### Where to use this

-   **Audio/video calling & conferencing** — the canonical use case. Browser-native.
-   **Niche P2P data** (CRDT-based collab, file transfer between users). Works, but rarely worth the operational complexity.
-   **Don't reach for it** just because "peer-to-peer sounds cool." Most "real-time" problems are better served by SSE or WebSockets.

<a id="lb"></a>

⚖️11Load balancing landscape

Two axes to choose on: **where** the LB lives (client vs dedicated) and **which layer** it inspects (L4 vs L7).

#### A. Vertical vs horizontal scaling

<img src="/diagrams/system-design-basics/7.svg" alt="system-design-basics diagram 7" class="doc-diagram" />

#### B. Client-side vs dedicated

##### Client-side LB

Client knows the server list (registry, gossip, DNS) and picks one itself. **Zero extra hops.**

**Examples:** gRPC client-side LB, Redis Cluster, DNS round-robin.

**Use when:** few controlled clients, OR many clients but slow updates are OK (DNS).

##### Dedicated LB

A box (HAProxy, NGINX, Envoy, AWS ALB/NLB, F5) sits between client and servers. Adds one hop, but instant updates.

**Use when:** public clients you don't control, or you want fine-grained routing.

#### C. L4 vs L7

<img src="/diagrams/system-design-basics/8.svg" alt="system-design-basics diagram 8" class="doc-diagram" />

#### D. Algorithms & health checks

| Algorithm | How it picks | Use when |
| --- | --- | --- |
| Round-robin | Sequentially across servers | Stateless, equal-cost servers — default |
| Random | Uniform random | Simple, similar to round-robin at scale |
| Least connections | Server with fewest active conns | Long-lived connections (WS, SSE) |
| Least response time | Server with lowest p50 latency | Heterogeneous backends |
| IP hash / consistent hash | hash(client IP) → server | Session stickiness, sharded caches |

**Health checks:** LB pings each backend on an interval (TCP open, or L7 GET /health expecting 200). Unhealthy backends are removed from the pool until they recover. This is what makes LBs the cornerstone of high availability.

#### Quick decision tree for interviews

-   **WebSocket / streaming?** → L4 LB + Least Connections.
-   **HTTP REST/GraphQL?** → L7 LB + round-robin.
-   **Internal microservices?** → Client-side LB (gRPC has it built in).
-   **Avoid single point of failure?** → Two LBs in different AZs, DNS rotates between them.

<a id="reliab"></a>

🛡️12Retries with backoff · Idempotency · Circuit breakers

"The network is reliable" is a lie. Build for failures.

#### A. Exponential backoff with jitter

<img src="/diagrams/system-design-basics/9.svg" alt="system-design-basics diagram 9" class="doc-diagram" />

#### B. Idempotency keys (so retries are safe)

Without idempotency: Client → POST /charge {amount: 10} FAIL (timeout) … but server processed it! Client → POST /charge {amount: 10} retry user charged twice 💥 With idempotency: Client → POST /charge Idempotency-Key: 7f3a-... {amount: 10} Server stores key + result. Same key → same response, executed once.

#### C. Circuit breaker state machine

<img src="/diagrams/system-design-basics/10.svg" alt="system-design-basics diagram 10" class="doc-diagram" />

#### Where to apply each pattern

-   **Retry with exponential backoff + jitter** on every external call. The exact phrase interviewers want to hear.
-   **Idempotency keys** on any non-GET that mutates state — payments, orders, user creation.
-   **Circuit breakers** around any dependency that could cascade-fail: third-party APIs, DB pools, downstream services. Keeps the herd from trampling a recovering service.
-   **Bonus phrase:** "thundering herd" — what jitter and circuit breakers prevent.

System Design Basics — Networking · part of [Kiran's Tech Hub](/)
