---
title: "Global Multi-Tenant DNS"
slug: /nalsd/nalsd-global-multi-tenant-dns
sidebar_position: 12
sidebar_label: "Global Multi-Tenant DNS"
description: "Global Multi-Tenant DNS"
---
[Home](/) › [NALSD](/docs/nalsd/nalsd-index) › Global Multi-Tenant DNS

Complete study guide — original interview module + full Q&A walkthrough (request lifecycle, anycast, resolver chain, layers 1–4, replication, tenant model, write path) + 10 failure scenarios with block/sequence diagrams.

**Contents**

-   [0 · Scenario & SRE Framing](#scenario)
-   [1 · The 7-Step Checklist](#checklist)
-   [2 · The Three Core Trade-offs](#tradeoffs)
-   [3 · High-Level Architecture (4 Layers)](#arch)
-   [4 · Full Request Lifecycle (walkthrough)](#lifecycle)
-   [5 · Anycast — What & How](#anycast)
-   [6 · The Resolver Chain](#resolvers)
-   [7 · Layer 1 — Anycast Edge](#layer1)
-   [8 · Layer 2 — Authoritative DNS](#layer2)
-   [9 · GeoIP vs Anycast (Branch A/B)](#geoip)
-   [10 · Failover with Unicast IPs & Route 53](#failover)
-   [11 · AXFR / IXFR Replication](#replication)
-   [12 · Tenant vs Subdomain Model](#tenancy)
-   [13 · Layers 3 & 4 — Internal & Data Store](#layer34)
-   [14 · The Write Path (cross-colo)](#writepath)
-   [15 · Internal Authoritative Tier (the gap)](#internalgap)
-   [16 · DNS Security & Cache Poisoning / DNSSEC](#security)
-   [17 · Scaling to Millions QPS](#scale)
-   [18 · Edge Cases & Rollout](#edge)
-   [19 · Component / Technology Reference](#components)
-   [20 · Database Selection](#dbsel)
-   [21 · KPIs & Interviewer Lens](#kpi)
-   [22 · Real dig +trace Annotated](#dig)
-   — Failure Scenarios —
-   [23 · Volumetric DDoS on the edge](#f1)
-   [24 · Cache poisoning / spoofed response](#f2)
-   [25 · BGP hijack of the anycast prefix](#f3)
-   [26 · Zone-store quorum loss (partition)](#f4)
-   [27 · Bad zone push](#f5)
-   [28 · Authoritative down — stale-if-error](#f6)
-   [29 · PoP / regional DC outage](#f7)
-   [30 · Noisy-neighbor tenant](#f8)
-   [31 · DNSSEC misconfiguration](#f9)
-   [32 · Negative-cache & thundering herd](#f10)
-   [33 · Failure mode cheat sheet](#summary)

## 0 · Scenario & SRE Framing {#scenario}

Scenario

“Design a global, multi-tenant DNS service supporting internal and external resolution, strict tenant isolation, zero-downtime updates, operating across on-prem and cloud, withstanding large-scale DDoS attacks.”

**Why DNS is special:** DNS is the most critical *shared dependency* in any infrastructure. Its failure isn’t one outage — it’s *every* outage at once, and it blocks the recovery tooling too (health checks, retries, and remediation scripts all need DNS). A 30-second DNS outage can cascade into total service unavailability.

#### From Requirements → Metrics → Trade-offs

| Perspective | Question to Ask | Answer for Global DNS |
| --- | --- | --- |
| **Users** | “What does failure look like to them?” | Service name won’t resolve → connection timeout → user-facing 5xx errors |
| **Business** | “What risk tolerance do we have?” | ≤5 minutes downtime per year (99.999% availability) |
| **Engineering** | “What metric captures that?” | P99 query latency <10ms, zone update propagation <60s, 99.999% uptime |

**SLI to name:** successful resolution % — *not* latency. A slow answer still works; *no* answer is the disaster. That’s why the SLO is defined *before* picking components.

SRE design flow — requirements → SLO → design → stressors → resilient architecture

<img src="/diagrams/nalsd-global-multi-tenant-dns/1.svg" alt="nalsd-global-multi-tenant-dns diagram 1" class="doc-diagram" />

## 1 · The 7-Step Checklist apply before drawing architecture {#checklist}

1.  **Define User Impact** → DNS failure = total service blackout, cascading across all apps
2.  **Draw the Happy Path** → client query → DCL cache → CoreDNS → authoritative → response
3.  **Identify 5 ways it can fail** → DDoS, cache poisoning, zone DB corruption, BGP hijack, stale cache
4.  **Apply reliability patterns** → anycast, RRL, DNSSEC, stale-if-error, multi-region Raft
5.  **Decide metrics & dashboards** → query latency, NXDOMAIN rate, propagation delay, per-tenant QPS
6.  **Rollout & recovery plan** → canary zone changes, blue/green resolver swap, TTL override emergency
7.  **Articulate trade-offs** → cost per PoP vs latency, TTL vs freshness, strong vs eventual consistency

Interviewer Lens

**What they score:** SLO definition before component choice, understanding that DNS is the most critical shared dependency, DDoS defense strategy, tenant isolation guarantees.

**Red flags:** designing DNS without defining availability target, no DDoS strategy, ignoring cache consistency, no tenant isolation model.

## 2 · The Three Core Trade-offs checklist step 7 {#tradeoffs}

```
KNOB                  ↑ gives you           ↑ costs you
——————————————————————————————
More edge PoPs    →   lower latency     →   higher infra $
Lower TTLs        →   faster propagation →  higher upstream load
Stale-if-error    →   availability      →   stale answers
```

| Knob | The mechanism | The pain |
| --- | --- | --- |
| **Edge PoPs** | Anycast routes user to nearest PoP → fewer RTT ms | Each PoP = real estate, servers, peering, ops. 200 PoPs ≠ 2× better than 100 |
| **TTL** | TTL = how long resolvers cache your answer. Low TTL → changes seen fast | Every expiry = a new query hits *your* authoritative servers. TTL 30s vs 3600s ≈ 120× the QPS |
| **Stale-if-error** | If upstream fails, serve the expired cached record anyway | User may reach a dead/moved IP. Availability ≠ correctness |

The interview-winning move

Name *which you’d pick and when*: “Low TTL only on records likely to fail over (load-balancer VIPs); high TTL on stable infra (NS records). Stale-if-error ON, but capped — serve stale for max 60s, not forever.”

Q&A — trade-off check

Q: A tenant runs a DB with frequent failovers. What TTL strategy?

A: **Low TTL on that record.** Failover means the IP changes; you want resolvers to drop the stale answer fast. Keep it surgical — low TTL on the failover-prone record only, not the whole zone.

Q: Your authoritative servers are getting crushed by QPS. Most likely cause?

A: **TTLs set too low.** Every TTL expiry = a fresh query to authoritative. PoPs and stale-if-error both *reduce* upstream load, not increase it.

## 3 · High-Level Architecture — The 4 Layers {#arch}

Global Multi-Tenant DNS Architecture — the four layers

<img src="/diagrams/nalsd-global-multi-tenant-dns/2.svg" alt="nalsd-global-multi-tenant-dns diagram 2" class="doc-diagram" />

The reachability boundary

```
PUBLIC INTERNET CAN REACH        INTERNAL ONLY
  Layer 1: Anycast Edge            Layer 3: Recursive / Caching
  Layer 2: Authoritative DNS       Layer 4: Zone Data Store
  ———— trust boundary ————
```

Layers 1–2 are the **public attack surface** — the anycast edge and authoritative DNS *must* be internet-reachable to do their job (plus a locked-down management API for tenant writes). Layers 3–4 never face the internet.

## 4 · Full Request Lifecycle — End to End {#lifecycle}

One LinkedIn page load involves **two separate flows**. They don’t mix — different VIPs, different ports, different stacks.

#### The two IPs — don’t merge them

```
IP #1  Anycast VIP   → the PATH: destination of every query packet (Tokyo, Paris, all of it)
                       constant everywhere. client→BGP→PoP→IPVS→DNS node.
IP #2  A record      → the PAYLOAD: content of the reply (“linkedin.com = 150.171.22.12”).
                       NOT on the path. client uses it AFTER, for the HTTP request.
```

The same `BGP → PoP → IPVS` **pattern** fronts both — that pattern is generic L4 plumbing, reused everywhere. But the **VIP is different** and the box behind IPVS is different: a DNS server for Flow A, ATS for Flow B.

Common confusions cleared up

-   **“DNS query goes BGP → IPVS → ATS”** — No. ATS (Apache Traffic Server) is an *HTTP/CDN cache* — wrong protocol. DNS is UDP/53 + TCP/53, not HTTP.
-   **“You can skip the DNS lookup”** — No. Flow B can’t even start until Flow A finishes; the browser has no IP to connect to until DNS answers.
-   **“.com gives you the A record”** — No. `.com` returns a *referral*: “linkedin.com’s nameserver is at <Anycast VIP>” (an NS record + glue IP). The actual A record comes one hop later, from LinkedIn’s authoritative server.

Q&A — lifecycle check

Q: A client in Tokyo and a client in Paris both query LinkedIn’s DNS. What destination IP is on both their query packets?

A: **The Anycast VIP.** Both packets carry the same destination IP — that’s the entire point of anycast.

Q: …yet they hit different PoPs. How?

A: **BGP picks a different PoP per client; VIP unchanged.** Each client’s local network sees BGP routes to that VIP from many PoPs and picks the topologically nearest.

Q: Next user queries linkedin.com 10s later, gets an instant answer. Why didn’t LinkedIn’s edge see that query?

A: **8.8.8.8 had it cached** from the first user’s miss. For the next TTL seconds, every user pointed at 8.8.8.8 is served from that cache.

## 5 · Anycast — What It Is & How It’s Implemented {#anycast}

**Anycast = one IP address, announced from many physical locations. The network delivers your packet to whichever location is “closest.”** “Closest” = fewest BGP hops / lowest routing cost, not literal geography (though they usually correlate).

#### How it’s implemented — it’s not a protocol, it’s a deployment trick using plain BGP

1.  **Same IP block configured at every PoP** — each PoP has servers bound to the identical VIP.
2.  **Every PoP’s router announces that prefix into BGP** — now every router on the internet has multiple paths to that VIP.
3.  **BGP’s best-path selection does the routing — for free** — each router picks the shortest path from where it sits.

The catch interviewers probe — it’s stateless / per-packet

```
UDP DNS:   1 query, 1 response, no state  →  anycast is PERFECT
TCP/HTTP:  long-lived connection           →  route flap = connection RESET
```

BGP routes *packets* and has no concept of “sessions.” A route change mid-connection can send packets to a different PoP that has no TCP state → reset.

#### Why it’s used — the payoffs

| Benefit | Mechanism |
| --- | --- |
| **Low latency** | Client hits nearest PoP automatically |
| **DDoS dilution** | Attack traffic spreads across all PoPs instead of concentrating on one |
| **Failover for free** | PoP dies → it stops announcing the route → BGP reconverges → traffic flows to next-nearest PoP |
| **No client logic** | Client just uses one IP; all intelligence is in routing |

Anycast = same IP everywhere + let BGP sort out who’s nearest. Free latency, free DDoS spreading, free failover — at the cost of being per-packet, so it loves UDP and merely tolerates TCP.

## 6 · The Resolver Chain — Who Does What {#resolvers}

| Resolver | Role | Does it walk root→TLD→auth? |
| --- | --- | --- |
| **Browser stub** | Originates the question, then blocks waiting. Tiny cache. | No — delegates everything |
| **OS stub** | Same — forwards to the configured nameserver. Tiny cache. | No |
| **Recursive resolver** (8.8.8.8, 1.1.1.1, ISP) | Does the *actual* recursion. Walks the tree, fires the query at LinkedIn’s anycast VIP. Big cache — the main QPS shield. | **Yes — this is the actor in every BGP→PoP→IPVS diagram** |
| **Authoritative** (LinkedIn’s NS) | Holds the truth for its zones. Purely passive on the query path. | No — just answers |

Stub resolvers (browser, OS) ask. The recursive resolver answers — by doing the work. Authoritative servers hold the truth.

## 7 · Layer 1 — Anycast Edge (DDoS Shield) {#layer1}

**Purpose:** front door for all DNS queries. Absorb attacks, route to nearest PoP, hand clean traffic to authoritative DNS.

#### The 6 functions

| Box | What it does | Why / threat it kills |
| --- | --- | --- |
| **BGP Anycast VIPs** | One IP announced from every PoP; BGP steers each client to nearest PoP | Low latency + DDoS dilution + free failover |
| **DDoS Scrubbing** | Drops garbage *before* it costs CPU: spoofed IPs, malformed packets, volumetric floods | Volumetric / L3-L4 DDoS |
| **Rate Limiting** | Per-source-IP / per-subnet *query* caps (token/leaky bucket) | Throttles one abusive client hammering you |
| **GeoIP Routing** | DNS node reads client IP → returns region-appropriate answer | *Not security* — it’s geo load balancing. The odd one out |
| **Response Rate Limit (RRL)** | Caps *identical responses* to the same subnet | DNS **amplification / reflection** attacks |
| **DNSSEC Validation** | Cryptographically signs responses; resolvers verify integrity | Cache poisoning / response tampering |

3 interview traps

-   **Rate Limiting vs RRL** — RL stops a client flooding *you*; RRL stops attackers reflecting off you at a *victim*. Different direction, different victim.
-   **Scrubbing vs Rate Limiting** — layered, not redundant: scrub first (drop obvious garbage), then rate-limit (shape excessive-but-legit-looking traffic).
-   **GeoIP is the odd one out** — five of the six are security/availability controls; GeoIP is routing/performance.

## 8 · Layer 2 — Authoritative DNS (Multi-Tenant) {#layer2}

**Purpose:** the source of truth. Holds the actual records, answers “what is linkedin.com?” — and does it for *many tenants* on shared infrastructure without letting them interfere.

| Box | What it is | Role |
| --- | --- | --- |
| **Zone per Tenant** | Each tenant gets its own isolated zone file | Isolates the DATA |
| **RBAC per Zone** | Access control scoped per zone | Isolates the ACCESS |
| **API for CRUD** | Programmatic create/read/update/delete | Makes changes CONTROLLED |
| **AXFR/IXFR Replication** | Zone transfer to secondary authoritative servers | AVAILABILITY (the odd one out) |
| **Audit Logging** | Immutable “who changed what, when, which zone” | Makes changes TRACEABLE |

### Tenant Isolation & Delegated Management

##### Zone-Level Isolation

-   Each tenant owns a DNS zone (delegated subdomain)
-   RBAC: tenant admins can only modify their zone
-   Resource quotas: max records, QPS per tenant
-   No cross-tenant zone visibility

##### Query Isolation

-   Separate resolver pools per tier (premium/standard)
-   Per-tenant rate limiting at edge
-   Noisy-neighbor detection and throttling
-   Tenant-tagged metrics for chargeback

##### Delegated Management

-   Self-service API for CRUD operations
-   GitOps: zone files in tenant Git repo
-   Approval workflow for wildcard/SRV changes
-   Automated validation before propagation

## 9 · GeoIP vs Anycast — “Do We Even Need GeoIP?” {#geoip}

```
BGP Anycast    →  routes the QUERY PACKET   →  “which PoP answers you”
GeoIP Routing  →  shapes the ANSWER CONTENT →  “which IP we put IN the answer”
```

| Reason Branch B (unicast + GeoIP) is chosen | Why anycast can’t do it |
| --- | --- |
| **Data residency / GDPR** | Anycast doesn’t let you *control* which DC. GeoIP returning a hard EU-only IP *guarantees* it. |
| **Stateful backends** | Session/cart/user state needs stickiness to one region. Anycast (per-packet) actively fights that. |
| **Granular control** | GeoIP can do weighted/percentage steering, per-city, A/B. Anycast proximity is coarse. |
| **Failover semantics** | “Tokyo down → send Tokyo users to Frankfurt” is one GeoIP config change. |

Anycast gives you proximity as a *tendency*; GeoIP gives you region as a *guarantee*. Performance is happy with a tendency. Compliance and stateful backends need a guarantee.

## 10 · Failover With Unicast IPs & How Route 53 Works {#failover}

#### The three mechanisms

| Mechanism | How it works |
| --- | --- |
| **1\. Health checks → drop dead IPs** | The GSLB constantly health-checks every regional endpoint. Tokyo fails → marked DOWN → removed from the answer pool. |
| **2\. Low TTL → reroute propagates fast** | TTL 30–60s → resolvers re-query within a minute → get Frankfurt. |
| **3\. Stale-if-error** | If the GSLB itself is unreachable, the resolver serves the last-known-good record rather than failing. |

#### The full reroute timeline

```
t+0s     Tokyo DC fails
t+5s     GSLB health check fails → Tokyo endpoint marked DOWN
t+5s     GSLB stops returning Tokyo IP; new queries get Frankfurt IP
t+5-65s  resolvers' cached Tokyo IP expires (TTL ~60s) → re-query → get Frankfurt
t+65s    ~all Tokyo users now on Frankfurt

Reroute window ≈ health-check interval + TTL.  That's your effective RTO.
```

## 11 · AXFR / IXFR — Zone Replication {#replication}

|  | AXFR (full) | IXFR (incremental) |
| --- | --- | --- |
| Ships | The entire zone, every record | Only what changed (the delta) |
| Cost | Heavy — bad for big zones / frequent edits | Light — scales with change rate, not zone size |
| When used | First sync, secondary too far behind, corruption | Normal day-to-day updates |
| Role | **Safety net / bootstrap** | **Steady-state efficiency** |

#### How a secondary knows it’s stale — the SOA serial

```
Every zone has a SOA record with a serial number. Bump a record → serial increments.
Secondary asks primary: “what's your SOA serial?”
   primary serial = 1055,  my serial = 1054  → I'm behind. Request transfer.
        └ serial gap small + I have history → IXFR (send 1054→1055 delta)
        └ serial gap huge / corrupt / no history → fall back to AXFR (resend everything)
```

AXFR/IXFR replicate a zone from the primary to all secondary authoritative servers so they answer identically. AXFR ships the whole zone (bootstrap/fallback); IXFR ships only the delta (efficient steady state); the SOA serial tells a secondary it’s stale and which to use.

## 12 · Tenant vs Subdomain — Don’t Confuse Them {#tenancy}

jobs.linkedin.com is NOT a tenant — it’s a subdomain within one zone

```
ZONE: linkedin.com   ← one zone, one tenant (LinkedIn)
  └ linkedin.com           A    150.171.22.12
  └ www.linkedin.com       A    ...
  └ jobs.linkedin.com      A    ...      ← just a record IN the zone
  └ api.linkedin.com       A    ...      ← still the same zone
  └ mail.linkedin.com      MX   ...
```

```
DNS PLATFORM (the multi-tenant system)
  └ Tenant A: LinkedIn      → zone: linkedin.com
  └ Tenant B: Microsoft     → zone: microsoft.com
  └ Tenant C: GitHub        → zone: github.com
  └ Tenant D: some startup  → zone: startup.io
```

Subdomain = a record inside a zone; tenant = a separate customer who owns zones. `jobs.linkedin.com` is the former; “LinkedIn” is the latter.

## 13 · Layers 3 & 4 — Internal Recursive & Data Store {#layer34}

### Layer 3 — Recursive / Caching (Internal)

| Component | What it is |
| --- | --- |
| **DCL (node-local cache)** | Datacenter-Local cache on every node. Eliminates a network hop for 90%+ of queries. |
| **CoreDNS (K8s svc)** | Cluster DNS resolving K8s service names (`svc.cluster.local`), forwarding external queries upstream. |
| **Negative Caching** | Caches NXDOMAIN responses to avoid repeatedly querying upstream for names that don’t exist. |
| **Prefetch (hot domains)** | Pre-resolves frequently-queried names before their cache entry expires. |
| **Stale-if-error** | Serves expired cache entries when upstream is unreachable. Configurable grace period (e.g. 86400s = 24h). |

### Layer 4 — Zone Data Store (Strongly Consistent)

Replicated DB (Espresso / etcd / CockroachDB), multi-region Raft, versioned zone files. Strong consistency is **non-negotiable**: a half-applied zone where US-West sees the new record but EU doesn’t is unacceptable.

## 14 · The Write Path — How a Record Change Goes Cross-Colo {#writepath}

**“How does it get cross-colo?” — the data store IS cross-colo.** You don’t write to one colo and then scramble to copy it. You write once to a globally-distributed, strongly-consistent store, and Raft guarantees every region’s replica agrees before the write is even considered done.

#### Full propagation timeline

```
t+0      tenant submits change via API
t+0.x    API auth + RBAC + validate + audit-log
t+1s     Raft commit — majority of colos agree → durable, consistent
t+1-5s   Layer 2 auth servers in every colo have the new record
t+5-65s  Layer 1 edge caches + external resolvers expire old TTL → re-fetch
t+~60s   ~everyone sees the new record   ← matches the <60s KPI

Bottleneck is NEVER the store — it's TTL on the caches above it.
```

Why strong consistency (Raft), not eventual

If eventually consistent: tenant updates a record → reads back “did it save?” → hits a lagging replica → sees OLD value. Worse: US auth server returns NEW IP, EU auth server returns OLD IP simultaneously → split-brain DNS. Raft trades a little write latency for the guarantee that every colo agrees.

## 15 · The Internal Authoritative Tier — A Gap in the Diagram {#internalgap}

The correction on the mental model

```
Layer 2 = AUTHORITATIVE   → “I own the truth for these zones”
Layer 3 = RECURSIVE/CACHE → “I don't own anything, I look things up and cache”
```

Layer 3 (CoreDNS) is a *resolver*, not authoritative — it doesn’t “get the zone data,” it forwards queries upstream and caches answers. So the real question is: *upstream of CoreDNS, who is authoritative for internal zones?*

#### Two common designs for the internal authoritative source

```
DESIGN A — separate internal authoritative tier
  Layer 4 store → INTERNAL authoritative servers → Layer 3 CoreDNS (recursive) → pods

DESIGN B — one authoritative tier, split-horizon / views
  Layer 4 store → Layer 2 authoritative (with SPLIT-HORIZON) → both audiences
    └ external view: public zones, public internet
    └ internal view: internal zones, only RFC1918 clients
```

## 16 · DNS Security — Cache Poisoning & DNSSEC {#security}

### The attack: cache poisoning

```
Attacker injects a FAKE record into a recursive resolver's cache.
  resolver asks “linkedin.com = ?”
  attacker races a forged reply: “linkedin.com = 6.6.6.6”  (attacker's server)
  resolver caches the lie → every user gets 6.6.6.6 for the whole TTL
```

### The defense: DNSSEC

```
DNSSEC = cryptographic signatures on DNS records.
  Authoritative server SIGNS each record (RRSIG) with its private key.
  Resolver VERIFIES the signature with the published public key (DNSKEY).
  Forged record has no valid signature → resolver REJECTS it.

Chain of trust — each level vouches for the one below:
  Root  —signs—▸  .com  —signs—▸  linkedin.com
```

| DNSSEC provides | DNSSEC does NOT provide |
| --- | --- |
| **Integrity** — answer wasn’t altered | **Confidentiality** — answers are still plaintext (that’s DoH/DoT’s job) |
| **Authenticity** — answer came from the real zone owner | Protection if the zone owner’s key itself is stolen |
| **Authenticated denial** — “this name truly doesn’t exist” (NSEC/NSEC3) | Anything about the *content* being malicious |

### DNS Security — full picture

##### DNSSEC

-   Sign all authoritative zones (RRSIG, DNSKEY)
-   Automated KSK/ZSK rotation
-   DS record management at parent
-   NSEC3 to prevent zone enumeration

##### DDoS Protection

-   Anycast absorbs volumetric attacks
-   Response Rate Limiting (RRL)
-   TCP fallback for amplification
-   Auto-scaling resolver pool

##### Insider Threat

-   Multi-party approval for zone changes
-   Immutable audit log (append-only)
-   Signed zone transfers (TSIG)
-   Separate admin vs operator roles

##### Cache Poisoning

-   Source port randomization
-   0x20-bit encoding (case randomization)
-   DNSSEC validation at resolver
-   TTL floor to prevent rapid cache flush

## 17 · Scaling to Millions QPS With Low Latency {#scale}

| Technique | Impact | Trade-off |
| --- | --- | --- |
| **Anycast + edge caching** | Latency <5ms for cached queries | Cache coherency delay (TTL-bounded) |
| **Node-local cache (DCL)** | Eliminates network hop for 90%+ queries | Memory per node (~64K entries) |
| **Prefetch hot domains** | Zero cache-miss latency for popular names | Extra background queries |
| **Stale-if-error** | Serves stale records if upstream fails (86400s) | Potentially outdated records during outage |
| **Negative caching** | Reduces NXDOMAIN upstream load | Delays propagation of new records |
| **UDP + EDNS0** | Avoids TCP overhead for most queries | MTU fragmentation for large responses |

## 18 · Edge Cases & Rollout {#edge}

Edge Case: Global DNS Outage (BGP Hijack / Massive DDoS)

-   **BGP hijack:** RPKI + ROA to validate BGP announcements. Real-time BGP monitoring alerts on route anomalies.
-   **Massive DDoS:** Anycast naturally distributes attack. Auto-blackhole at edge for known-bad sources. Graceful degradation: serve stale cache for up to 24h.
-   **Recovery:** Pre-staged secondary anycast cloud (failover to cloud DNS within 60s via BGP withdrawal).

Blue/Green & Canary for DNS Changes

-   **Blue/Green:** Maintain two zone versions. New version deployed to secondary resolvers. Traffic shifted via weighted anycast.
-   **Canary:** Deploy zone change to 5% of resolvers (single edge PoP). Monitor error rate, latency, NXDOMAIN spike. Promote to 25% → 50% → 100% over 1h.
-   **Real-time updates:** NOTIFY + IXFR for incremental zone transfer. Sub-second propagation for critical changes.

## 19 · Component / Technology Reference {#components}

| Component | What It Is | Technology Options |
| --- | --- | --- |
| **BGP Anycast VIPs** | Same virtual IP advertised via BGP from multiple PoPs globally. | BIRD, FRRouting, Quagga, ExaBGP, cloud provider anycast |
| **Rate Limiting** | Per-source-IP QPS caps using token/leaky bucket. | iptables hashlimit, dnsdist, PowerDNS rrl, custom eBPF |
| **DDoS Scrubbing** | Filters volumetric attack traffic while passing clean queries. | Cloudflare Magic Transit, Akamai Prolexic, AWS Shield, custom XDP/eBPF |
| **GeoIP Routing** | Routes queries based on client IP geolocation. | MaxMind GeoIP, PowerDNS GeoIP backend, Route53 geolocation |
| **Response Rate Limiting** | Limits identical responses per second to prevent amplification. | BIND RRL, Knot DNS RRL, PowerDNS rrl, NSD RRL |
| **DNSSEC Validation** | Verifies RRSIG signatures. Rejects forged or tampered responses. | Unbound, BIND with DNSSEC, Knot Resolver |
| **Zone per Tenant** | Each tenant gets a delegated DNS subdomain (zone). | BIND views, PowerDNS, CoreDNS multi-zone, Route53 hosted zones |
| **RBAC per Zone** | Role-based access control scoped to zones. | PowerDNS API + custom RBAC, OPA/Gatekeeper |
| **API for CRUD** | RESTful / gRPC API for zone & record management. | PowerDNS REST API, CoreDNS with etcd backend, Route53 API |
| **AXFR/IXFR Replication** | Full or incremental zone transfer between authoritative servers. | BIND zone transfer, NSD/Knot native, PowerDNS supermaster |
| **Audit Logging** | Every record change logged immutably. | Kafka audit stream, append-only DB, S3 audit logs |
| **DCL (node-local cache)** | Datacenter-Local cache on every node (~64K entries). | dnsmasq, systemd-resolved, Node Local DNS Cache (K8s) |
| **CoreDNS (K8s svc)** | Cluster DNS resolving K8s service names. | CoreDNS (default), kube-dns |
| **Zone Data Store** | Strongly consistent DB storing authoritative zone data. | Espresso, etcd, CockroachDB, TiDB, PostgreSQL + Patroni |

## 20 · Database Selection — What Store for What {#dbsel}

| Data Type | Best Store | Why |
| --- | --- | --- |
| **Zone records** | **Espresso or etcd** | Strong consistency via Raft. Zone changes must be atomic. Multi-region Raft gives cross-DC replication with quorum writes. |
| **DNS cache layer** | **In-memory (DCL/CoreDNS)** | Cache is ephemeral, TTL-driven. No persistent store needed. ~64K entries/node, ~100MB RAM. |
| **Audit log** | **Kafka → HDFS/Parquet** | Append-only, immutable, partitioned by timestamp. Low write volume. |
| **Query metrics** | **InGraphs / Prometheus** | High-cardinality time-series: QPS by tenant, record type, region, response code. |
| **Tenant config** | **Espresso** | Relational: tenant → zones → permissions → quotas. ACID for quota enforcement. |

## 21 · KPIs & Interviewer Lens {#kpi}

| KPI | Target | Cost vs. Reliability Trade-off |
| --- | --- | --- |
| Query latency P99 | <10ms | More edge PoPs = lower latency but higher infra cost |
| Update propagation | <60s | Lower TTLs = faster updates but higher upstream load |
| Availability | 99.999% | Active-active global = high cost; active-passive = higher RTO |

Interviewer Lens — what they score / red flags

**Score:** SLO definition before component choice; understanding DNS is the most critical shared dependency; DDoS defense strategy; tenant isolation guarantees; cost-vs-reliability reasoning with numbers.

**Red flags:** designing DNS without an availability target; no DDoS strategy; ignoring cache consistency; no tenant isolation model.

## 22 · Real `dig +trace linkedin.com` — Annotated {#dig}

| What the trace proves | How |
| --- | --- |
| `.com` returns a *referral*, not the A record | Hop 3 gave `linkedin.com IN NS dns1.p09.nsone.net` — nameservers, not an IP for the website. |
| The A record comes from the authoritative hop | The packet to LinkedIn’s authoritative anycast VIP; that’s an anycast address. |
| LinkedIn uses TWO independent providers | `dns1-4.p09.nsone.net` → NS1; `ns1-42.azure-dns.com` → Azure. |
| Low TTL on failover-prone records | The A record has TTL `300` (5 min). The NS records have TTL `172800` (2 days). |

## Failure Scenarios & Recovery 10 modes

How to use this in an interview

For every failure: name the **detection signal**, the **blast radius**, the **immediate mitigation**, and the **structural fix**. Interviewers score “graceful degradation over hard failure” — every scenario below degrades, it never just dies.

normal component focus / source of truth failed / under attack mitigation / recovery

<a id="f1"></a>

### 23 · Volumetric DDoS on the Anycast Edge Critical

**Detection**QPS spike 10–100×, packet drop rate, edge CPU saturation

**Blast radius**All tenants on the attacked PoP(s) — but anycast contains it

**Immediate**Scrubbing + RRL + auto-blackhole bad sources

**Structural**More PoPs, upstream scrubbing contract, capacity headroom

Anycast contains it, scrubbing cleans it, RRL stops you being a weapon — authoritative never sees the flood.

<a id="f2"></a>

### 24 · Cache Poisoning / Spoofed Response Critical

**Detection**Answer mismatch vs authoritative, DNSSEC validation failures

**Blast radius**Every client of the poisoned resolver, for one TTL

**Immediate**Flush cache, DNSSEC reject, raise TTL floor

**Structural**DNSSEC everywhere, 0x20 encoding, port randomization

The fix isn’t “win the race” — it’s “make the race irrelevant.” A signed answer is verifiable; a forged one isn’t.

<a id="f3"></a>

### 25 · BGP Hijack of the Anycast Prefix Critical

**Detection**BGP monitoring route-origin alerts, sudden geo traffic shift

**Blast radius**Whole regions — queries vanish or get attacker-controlled answers

**Immediate**Announce more-specifics, contact upstreams, RPKI ROA

**Structural**RPKI ROAs published, BGP monitoring, multi-provider path diversity

RPKI makes the hijack route invalid-by-default; monitoring catches what slips through; DNSSEC ensures a hijacker can deny but not deceive.

<a id="f4"></a>

### 26 · Zone Data Store Quorum Loss (Partition) High

**Detection**Raft leader-election storms, write-latency spike/timeout

**Blast radius**Write path frozen globally; reads continue (serve last-committed)

**Immediate**Reads from local replica, writes queue/fail-fast

**Structural**Odd region count, separate read path, witness/tiebreaker region

Partition = writes pause, reads continue. DNS keeps resolving globally; only the ability to *change* records is frozen — and that’s the right trade.

<a id="f5"></a>

### 27 · Bad Zone Push High

**Detection**Post-deploy NXDOMAIN spike, error-rate alert, canary PoP divergence

**Blast radius**One tenant’s zone (isolation holds) — but total for that tenant

**Immediate**Canary catches it; if not, version rollback

**Structural**CI validation, canary rollout, versioned zones, approval gates

The write path is a gauntlet: validate → canary → promote → (versioned rollback if anything looks wrong). A bad push gets caught at 5%, not 100%.

<a id="f6"></a>

### 28 · Authoritative Tier Down — Stale-If-Error High

**Detection**Upstream timeout rate, SERVFAIL rate

**Blast radius**Bounded — only names whose TTL expired during the outage

**Immediate**Serve stale (last-known-good) within a grace window

**Structural**Multi-provider authoritative, longer stale grace, prefetch

Stale-if-error is graceful degradation in one config flag: serve the last-known-good answer within a capped window instead of returning SERVFAIL.

<a id="f7"></a>

### 29 · PoP Failure / Regional DC Outage Medium

**Detection**Health-check failures, BGP session drops, traffic-to-zero

**Blast radius**Near-zero if anycast — traffic auto-shifts

**Immediate**BGP withdrawal → reconverge to next-nearest PoP

**Structural**N+1 PoP capacity, no region is a SPOF, pre-staged failover cloud

A PoP outage is a non-event by design: BGP withdraws the route, traffic reconverges in seconds, surviving PoPs absorb the load.

<a id="f8"></a>

### 30 · Noisy-Neighbor Tenant Medium

**Detection**Per-tenant QPS metric spikes, one tenant dominating cache evictions

**Blast radius**Could be all tenants — unless per-tenant isolation is enforced

**Immediate**Per-tenant rate limit / throttle the offender

**Structural**Per-tenant quotas, tiered resolver pools, fair-share scheduling

Per-tenant rate limits + quotas + tiered pools turn “one tenant takes everyone down” into “one tenant hits their own ceiling.”

<a id="f9"></a>

### 31 · DNSSEC Misconfiguration High

**Detection**DNSSEC-bogus rate spike, “broken for some users” asymmetry

**Blast radius**Total for the zone, but only for validating resolvers

**Immediate**Re-sign / fix DS, or emergency-unsign as last resort

**Structural**Automated rotation w/ monitoring, signature-expiry alerts

DNSSEC done wrong is a self-inflicted outage. The tell is the asymmetry — validating resolvers blackout while others don’t. Monitor the rotation job, not just the zone.

<a id="f10"></a>

### 32 · Negative-Cache Poisoning & Thundering Herd Medium

**Detection**NXDOMAIN rate spike for known-good names, synchronized upstream QPS spikes

**Blast radius**Per-resolver; bounded by negative-TTL / by the herd window

**Immediate**Flush negative entry; request coalescing for the herd

**Structural**Short negative-TTL, prefetch, single-flight coalescing, TTL jitter

Caches fail in two directions: caching “no” too long (negative-cache poisoning) and all missing at once (thundering herd). Short negative-TTL fixes the first; coalescing + prefetch + jitter fix the second.

* * *

## 33 · Summary — Failure Mode Cheat Sheet {#summary}

| # | Failure | Detection signal | Immediate mitigation | Structural fix |
| --- | --- | --- | --- | --- |
| 1 | Volumetric DDoS | QPS 10–100×, packet drops | Scrub + RRL + auto-blackhole | More PoPs, capacity headroom |
| 2 | Cache poisoning | Answer mismatch, DNSSEC-bogus | DNSSEC reject, flush cache | DNSSEC everywhere, 0x20 |
| 3 | BGP hijack | Route-origin alert, geo shift | Announce more-specifics | RPKI ROAs, BGP monitoring |
| 4 | Zone-store quorum loss | Election storms, write timeouts | Reads continue; writes fail-fast | Odd region count, witness node |
| 5 | Bad zone push | NXDOMAIN spike, canary divergence | Canary catches; versioned rollback | CI validation, canary rollout |
| 6 | Authoritative down | Upstream timeouts, SERVFAIL | Serve stale within grace window | Multi-provider authoritative |
| 7 | PoP / region outage | Health-check fail, BGP drop | BGP withdrawal → reconverge | N+1 capacity, failover cloud |
| 8 | Noisy-neighbor tenant | Per-tenant QPS spike | Per-tenant rate limit | Per-tenant quotas, tiered pools |
| 9 | DNSSEC misconfig | DNSSEC-bogus rate | Re-sign / fix DS | Automated rotation w/ monitoring |
| 10 | Negative-cache / herd | NXDOMAIN for good names | Flush negative entry; coalescing | Short negative-TTL, prefetch |

The pattern across all ten

Every scenario follows the same shape: **(1)** a named detection signal; **(2)** a bounded blast radius — isolation means failures stay local; **(3)** graceful degradation — serve stale, serve from majority, reconverge — never a hard SERVFAIL when a softer answer exists; **(4)** a structural fix so it can’t recur. “It degrades, it doesn’t die” is the whole game.

* * *

Study guide compiled from the Advanced System Design Interview module (Module 2: Global, Multi-Tenant DNS) covering the request lifecycle, anycast internals, the resolver chain, GeoIP vs anycast, unicast failover & Route 53, AXFR/IXFR, the tenant model, the write path, and the internal authoritative tier, followed by 10 failure scenarios (sections 23–33).
