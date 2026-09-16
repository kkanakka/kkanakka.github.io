---
title: "Networking 101: Browser to LinkedIn"
slug: /linux/linux-networking
sidebar_position: 4
sidebar_label: "Networking 101: Browser to LinkedIn"
description: "Networking 101: Browser to LinkedIn"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/linux-networking/sequence.svg" alt="How it works — linux-networking" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
[Linux Internals](/docs/linux) [Java Memory](/docs/linux/linux-memory-architecture) [System Design Hub](/docs/foundations)

Every step from keystroke to rendered page, with DNS, BGP, ECMP, GLB, IPVS, ATS, and the application tier.

### 50 Steps · 11 Phases

[ADNS — laptop needs an IP](#phase-a) [BDNS query travels to resolver](#phase-b) [CResolver walks the hierarchy](#phase-c) [DTCP SYN leaves the laptop](#phase-d) [EBGP routes across ASes](#phase-e) [FInside the POP: ECMP → IPVS](#phase-f) [GATS accepts, TLS handshake](#phase-g) [HATS: cache or origin?](#phase-h) [IL7 LB → app → fanout](#phase-i) [JResponse flows back](#phase-j) [KBrowser parses & renders](#phase-k) [LDeep dive: where IS the GLB?](#phase-l) [★Summary & glossary](#summary)

╔══════════════════════════════════════════════════════════════════════════════╗ ║ THE WHOLE JOURNEY IN ONE PICTURE ║ ╚══════════════════════════════════════════════════════════════════════════════╝ \[Laptop\] │ │ 1\. DNS lookup ▼ \[Home Router\] ──► \[ISP\] ──► \[ISP Recursive Resolver 75.75.75.75\] │ │ │ │ walks root → .com → Dynect │ ▼ │ linkedin.com = 13.107.42.14 │ │ ◄────────────────────────────────────┘ │ │ 2\. TCP SYN to 13.107.42.14 ▼ \[Home Router\] ──► \[Comcast AS7922\] ──► \[Level3 AS3356\] ──► \[LinkedIn AS14413 Edge\] │ ────────── each hop: BGP + ARP + Ethernet rewrite ────────── ▼ \[POP Edge Router\] │ │ ECMP hash ┌─────────────────────────────────┤ ▼ ▼ \[GLB/IPVS-1\] \[GLB/IPVS-2\] \[GLB/IPVS-3\] \[GLB/IPVS-4\] (all announce VIP 13.107.42.14 via iBGP) │ │ consistent hash → backend ▼ \[ATS node 7\] ← TLS termination + caching │ │ cache miss → origin ▼ \[Internal L7 LB\] │ ▼ \[App Server: feed-service\] │ (fans out to member-graph, ranking, activity, profile)

<a id="phase-a"></a>

🔍 PHASE A DNS — laptop needs an IP for linkedin.com

Step 1: Browser calls getaddrinfo("linkedin.com") → checks browser cache → MISS → checks OS cache → MISS Step 2: OS reads /etc/nsswitch.conf → "hosts: files dns" → checks /etc/hosts → not found → falls through to DNS Step 3: OS reads /etc/resolv.conf → nameserver = 75.75.75.75 (populated by DHCP when laptop joined the Wi-Fi) Step 4: OS builds DNS query: UDP dst port 53, DNS "linkedin.com A?" IP dst = 75.75.75.75 src = 192.168.1.42 Step 5: Routing table says: 75.75.75.75 not local → use default gateway 192.168.1.1 → ARP cache for 192.168.1.1 → HIT → MAC aa:bb:cc:11:22:33 Step 6: Build Ethernet frame: Eth dst = aa:bb:cc:11:22:33 src = 11:22:33:44:55:66 → hand to NIC → WiFi transmits

▼

<a id="phase-b"></a>

📡 PHASE B DNS query travels to resolver

Step 7: Home router receives frame → strips Eth header, reads IP dst = 75.75.75.75 → performs NAT: src IP 192.168.1.42 → 73.15.92.6 (public) → ARP for ISP gateway 68.85.4.1 → MAC ff:ee:dd:99:88:77 → rewrites Ethernet → forwards out WAN port Step 8: Comcast ISP gateway (AS7922) receives → routes internally (OSPF/IS-IS) toward resolver cluster → multiple internal Ethernet rewrites Step 9: Recursive resolver at 75.75.75.75 receives query → cache MISS → begins iterative lookup

▼

<a id="phase-c"></a>

🌳 PHASE C Recursive resolver walks the DNS hierarchy

Step 10: Resolver → ROOT nameserver (198.41.0.4, a.root-servers.net) Q: "linkedin.com A?" A: "don't know — for .com, ask gTLD servers at 192.5.6.30..." Step 11: Resolver → .com TLD nameserver (192.5.6.30, Verisign) Q: "linkedin.com A?" A: "ask ns1.p43.dynect.net at 208.78.70.43..." Step 12: Resolver → LinkedIn authoritative NS (208.78.70.43, Oracle Dyn) Q: "linkedin.com A?" GeoDNS logic: resolver IP 75.75.75.75 = US East → Ashburn POP A: "linkedin.com. 300 IN A 13.107.42.14" Step 13: Resolver caches answer (TTL 300s) → DNS reply travels back → home router → laptop → Browser now has: linkedin.com = 13.107.42.14

▼

<a id="phase-d"></a>

🤝 PHASE D TCP SYN leaves the laptop toward LinkedIn

Step 14: Laptop builds TCP SYN IP dst = 13.107.42.14 src = 192.168.1.42 TCP dst port 443, src port 51234, flags = SYN Step 15: Routing table: dst not local → default gateway 192.168.1.1 ARP cache HIT → MAC aa:bb:cc:11:22:33 Ethernet frame built → sent over WiFi Step 16: Home router → NAT src to 73.15.92.6 → ARP for ISP gateway → Eth rewritten → forwards

▼

<a id="phase-e"></a>

🗺️ PHASE E BGP routes the packet across ASes to LinkedIn's POP

Step 17: Comcast ISP gateway (AS7922) BGP table: 13.107.42.0/24 → next-hop 4.69.201.1 (Level3) ARP → MAC 00:11:22:aa:bb:cc → Eth rewritten → forwards Step 18: Level3 edge router (AS3356) BGP: 13.107.42.0/24 → next-hop 129.250.2.1 (Level3 core) ARP → MAC 44:55:66:dd:ee:ff → Eth rewritten → forwards Step 19: Level3 core router BGP: learned 13.107.42.0/24 from LinkedIn peering at Equinix next-hop = 52.93.128.1 (LinkedIn edge) ARP → MAC aa:11:bb:22:cc:33 → Eth rewritten → forwards Step 20: Packet arrives at LinkedIn edge router (AS14413, Ashburn POP)

▼

<a id="phase-f"></a>

⚖️ PHASE F Inside the POP: Edge → ECMP → GLB/IPVS → Backend

══════════════════════════════════════════════════════════════════════════ Key concept: the VIP 13.107.42.14 is announced at THREE nested scopes. ══════════════════════════════════════════════════════════════════════════ eBGP (internet-wide) → "AS14413 owns 13.107.42.0/24" iBGP (edge → ToR) → "ToR aggregates /32s from IPVS pool" iBGP (IPVS → ToR) → "I (each IPVS box) have 13.107.42.14/32" Same IP. Different broadcast scope at each layer.

┌────────────────────────────────────────────────────────────────┐ │ LINKEDIN POP (Ashburn) │ └────────────────────────────────────────────────────────────────┘ \[Edge Router AS14413\] │ dst = 13.107.42.14 ▼ \[ToR Router\] │ │ Routing table entry: │ 13.107.42.14/32 → ECMP \[ │ IPVS-1 (10.10.1.1), │ IPVS-2 (10.10.1.2), │ IPVS-3 (10.10.1.3), │ IPVS-4 (10.10.1.4) \] │ │ ECMP hash(5-tuple) → IPVS-3 │ ARP for 10.10.1.3 → MAC dd:ee:ff:11:22:33 │ Rewrite Eth dst MAC (IP unchanged!) ▼ ┌────────────┬──────────────────┬────────────┬────────────┐ │ │ │ │ │ \[IPVS-1\] \[IPVS-2\] \[IPVS-3\] ◄── \[IPVS-4\] 10.10.1.1 10.10.1.2 10.10.1.3 10.10.1.4 lo: VIP lo: VIP lo: VIP ✓ lo: VIP │ │ │ │ └─ BIRD ─────┴─ iBGP session ───┴────────────┘ announcing 13.107.42.14/32 to ToR

Step 21: Edge router forwards to ToR (IP header unchanged: dst still = 13.107.42.14) Step 22: ToR looks up 13.107.42.14/32 → has 4 ECMP paths hash(73.15.92.6, 51234, 13.107.42.14, 443, TCP) mod 4 = 2 → pick IPVS-3 Step 23: ToR ARPs for IPVS-3's real IP 10.10.1.3 → gets MAC dd:ee:ff:11:22:33 → rewrites only the Ethernet destination MAC → IP header stays as dst = 13.107.42.14 → forwards frame to IPVS-3 Step 24: IPVS-3 receives the frame Eth dst = dd:ee:ff:11:22:33 ✓ (that's my MAC, accept) IP dst = 13.107.42.14 ✓ (VIP is on my loopback, accept) → IPVS connection tracking table lookup: new flow? → run scheduler (mh = Maglev consistent hash) → pick backend from pool → cache the mapping known flow? → reuse previously chosen backend → Scheduler chooses 10.0.0.42 (ATS node 7) Step 25: IPVS forwards to backend in DR mode (Direct Routing) → ARP for 10.0.0.42 → MAC 66:77:88:aa:bb:cc → rewrites ONLY Ethernet dst MAC to ATS node 7 → IP header COMPLETELY UNCHANGED (dst = 13.107.42.14) → sends frame over rack network \[IPVS real IP 10.10.1.3 never appears in any packet header — it exists only so ToR can ARP for it\]

▼

<a id="phase-g"></a>

🔐 PHASE G ATS backend accepts, TLS handshake completes

Step 26: ATS node 7 (10.0.0.42) receives frame → Eth dst = my MAC ✓ → IP dst = 13.107.42.14 ✓ (VIP on loopback, accept as local) → TCP SYN arrives at port 443 Step 27: ATS sends SYN-ACK src IP = 13.107.42.14 dst = 73.15.92.6 Reply bypasses IPVS entirely (DSR = Direct Server Return) → goes ToR → edge → Level3 → Comcast → laptop Step 28: Laptop sends ACK → 3-way handshake complete (L4 LB consistent hash ensures same IPVS → same ATS for this flow) Step 29: TLS 1.3 handshake: → ClientHello (SNI: "linkedin.com", plaintext) → ServerHello + certificate (plaintext) → ECDHE key exchange → shared secret → 🔒 symmetric keys derived, encryption begins 🔒 Step 30: Browser sends encrypted HTTP request: GET /feed/ HTTP/2 Host: linkedin.com Cookie: li\_at=AQEDAT...

▼

<a id="phase-h"></a>

🎯 PHASE H ATS handles request: cache or origin?

Step 31: ATS decrypts TLS → plaintext HTTP request visible (inside ATS only) Reads: Host=linkedin.com, path=/feed/, Cookie=user session Step 32: ATS cache lookup for "/feed/": → Cookie present, user-specific → NOT cacheable → Forward to origin application tier Step 33: Internal service discovery: feed-service VIP = 10.5.0.1 (yet another VIP! announced inside DC by internal LBs via iBGP) Step 34: ATS → internal L7 LB at 10.5.0.1 → ToR switch → ARP → Ethernet rewritten → forwarded

▼

<a id="phase-i"></a>

⚙️ PHASE I Internal L7 LB → app server → downstream fanout

Step 35: Internal L7 LB (Envoy / Rest.li router) → inspects HTTP path + headers → picks healthy backend: 10.5.2.8 (feed-service) → ARP → Eth rewrite → forward Step 36: App server 10.5.2.8 (feed-service, Java on JVM) → decodes session cookie → user\_id = 12345 → begins parallel fanout: • member-graph-service → who you follow • feed-ranking-service → ML scoring • activity-service → recent posts • profile-service → avatars, names (each fanout is another internal HTTP call, each traversing internal L7 LB + ToR + ARP) Step 37: Downstream services query storage: Espresso (docs) | Pinot (OLAP) | Venice (KV) | Kafka (streams) → return data Step 38: feed-service aggregates → builds HTML/JSON response HTTP/2 200 OK, Content-Encoding: br, <body>...</body>

▼

<a id="phase-j"></a>

📤 PHASE J Response flows back to laptop

Step 39: Response: app server → internal L7 LB → ATS node 7 (Ethernet rewritten at each DC hop) Step 40: ATS node 7 → may re-encode (brotli), inject headers (X-Li-Pop) → encrypts with TLS session key → sends back via existing TCP connection → IP src = 13.107.42.14 dst = 73.15.92.6 → DSR: reply goes directly to client, bypassing IPVS Step 41: ATS → edge router BGP: best path to 73.15.92.0/24 → via Level3 → Eth rewrite → forward Step 42: Level3 core → Level3 edge → Comcast peering → each hop: BGP lookup + ARP + Eth rewrite Step 43: Comcast backbone → neighborhood head-end → home router's WAN Step 44: Home router → NAT table: 73.15.92.6:51234 ↔ 192.168.1.42:51234 → rewrite dst IP back to laptop → ARP → Eth rewrite → WiFi → laptop Step 45: Laptop NIC receives → kernel TCP reassembly → TLS decrypts payload → HTTP/2 layer reconstructs response → hands HTML body to browser

▼

<a id="phase-k"></a>

🎨 PHASE K Browser parses, renders, fetches assets

Step 46: Browser parses HTML → encounters <link href>, <script src>, <img src> → for each asset URL, starts a new request: • Same origin → reuses existing TCP+TLS connection (HTTP/2 multiplexes many requests over one connection) • Different origin (static.licdn.com) → restart from PHASE A Step 47: Static assets (CSS, JS, images) → almost all cache HIT at ATS edge → returned in <10ms → never reach origin app servers Step 48: Browser executes JS → XHR/fetch calls to /voyager/api/... → each repeats PHASE G-I over the same TCP+TLS connection Step 49: Browser paints pixels on screen Step 50: ✨ User sees LinkedIn feed ✨ Total time: ~200-800ms to first byte, ~1-3s fully interactive

▼

<a id="phase-l"></a>

🌍 PHASE L · DEEP DIVE There IS a GLB — it's just not a box

The confusion is thinking of a **GLB (Global Load Balancer)** as a physical device like IPVS. Modern GLB is a **combination** of BGP anycast, geo-aware DNS, and health monitoring — working together. There is no single server called "the GLB" that all traffic flows through; that would defeat the entire purpose (the point is to *avoid* global traffic funneling through one place).

There are two main techniques, and most large companies use a hybrid of both.

#### Technique 1 — BGP anycast (the VIP lives in many places)

Remember 13.107.42.14? LinkedIn doesn't announce it from *one* POP. They announce it from **every** POP in the world, simultaneously, via eBGP to their peers and transit providers.

LinkedIn Ashburn POP ──> announces 13.107.42.0/24 to US East ISPs LinkedIn San Jose POP ──> announces 13.107.42.0/24 to US West ISPs LinkedIn Dublin POP ──> announces 13.107.42.0/24 to European ISPs LinkedIn Singapore POP ──> announces 13.107.42.0/24 to APAC ISPs LinkedIn Mumbai POP ──> announces 13.107.42.0/24 to Indian ISPs ... more POPs ...

Every POP says *"I own this prefix."* From the internet's perspective, the VIP is reachable from many directions. **BGP's best-path algorithm does the geographic routing for free.**

When a user in Mumbai sends a packet to 13.107.42.14: Their ISP (Reliance Jio AS55836) looks up 13.107.42.0/24 in BGP. Routing table says: shortest AS\_PATH is via direct peer at Mumbai IXP → LinkedIn Mumbai POP. Packet goes to Mumbai. Meanwhile, a user in Texas doing the same query: Their ISP (Comcast AS7922) looks up 13.107.42.0/24. Shortest AS\_PATH is via Level3 → LinkedIn Ashburn POP. Packet goes to Ashburn.

The same IP, hitting different POPs, purely based on BGP topology. That's anycast.

User in Mumbai ─────► nearest hop ─────► LinkedIn Mumbai POP │ ▼ (same VIP locally in that POP) User in Texas ─────► nearest hop ─────► LinkedIn Ashburn POP │ ▼ (same VIP locally in that POP)

The "GLB" here is **BGP itself**. No centralized dispatcher. The protocol that routes your packet to the nearest advertisement *is* the global load balancer.

#### Technique 2 — DNS-based steering (different IPs per region)

Not everyone uses pure anycast. The alternative (what Netflix and many CDNs use) is to return **different IPs to different users via GeoDNS**. Each POP gets its own unique unicast VIP.

User in Mumbai asks: "linkedin.com A?" LinkedIn's DNS sees: resolver IP from India → returns 13.107.55.200 (Mumbai POP VIP) User in Texas asks: "linkedin.com A?" LinkedIn's DNS sees: resolver IP from US → returns 13.107.42.14 (Ashburn POP VIP)

Each POP has its own unique VIP. DNS picks which VIP to return based on the resolver's location, then BGP just has to route the packet to that specific VIP (which is only announced from that one POP).

The "GLB" here is the **authoritative DNS server's geo-logic**. Companies like NS1, AWS Route 53, Dyn, Akamai DNS, and Cloudflare DNS all do this.

#### Technique 3 — Hybrid (most big companies)

Google, AWS, Cloudflare, and Microsoft all use both:

-   **Anycast** for DNS and short-lived connections (UDP queries, QUIC handshakes)
-   **GeoDNS** for long-lived connections (video streams, large downloads)
-   **Inside each POP**, IPVS / Maglev / Katran picks a backend

##### Cloudflare — anycast-heavy

Literally every one of their ~300+ POPs announces the same 1.1.1.1 or the same customer VIPs. Their GLB is pure BGP.

##### Netflix — GeoDNS-heavy

Long video streams don't tolerate BGP reconvergence mid-stream well, so they prefer stable unicast IPs per POP, steered by GeoDNS.

#### So how does India hit the Mumbai POP specifically?

Two possible mechanisms, depending on the company:

▸ If using anycast (Google, Cloudflare):

User (Mumbai, ISP = Jio AS55836) │ │ DNS lookup: linkedin.com → 13.107.42.14 │ (DNS resolver could be anywhere — returns the single anycast IP) │ ▼ User sends packet: dst = 13.107.42.14 │ ▼ Jio router's BGP table for 13.107.42.0/24: - Path A: AS55836 → AS8075 (Microsoft/LinkedIn Mumbai) AS\_PATH = \[8075\] ← shortest! - Path B: AS55836 → AS6453 (Tata) → AS8075 (Ashburn POP) AS\_PATH = \[6453, 8075\] - Path C: AS55836 → AS2914 (NTT) → AS8075 (Singapore POP) AS\_PATH = \[2914, 8075\] Jio picks Path A (direct peering with LinkedIn Mumbai, shortest AS\_PATH) │ ▼ Packet goes to LinkedIn Mumbai POP — never leaves India

The shortest AS\_PATH to the VIP happens to be the POP in Mumbai because LinkedIn peers with Indian ISPs at Mumbai IXPs. **Geographic proximity emerges from BGP topology naturally.**

▸ If using GeoDNS:

User (Mumbai) │ │ DNS lookup: linkedin.com A? │ (query goes to Jio's DNS resolver, say 49.45.1.1) │ ▼ Jio resolver → LinkedIn authoritative DNS (Dynect) │ │ Dynect sees: resolver IP = 49.45.1.1 (Indian ISP) │ Dynect's geo-database: India → Mumbai POP │ Returns: linkedin.com = 13.107.55.200 (Mumbai VIP, unicast) │ ▼ User sends packet to 13.107.55.200 │ │ 13.107.55.200/24 is announced ONLY from Mumbai POP via BGP │ BGP routes to Mumbai naturally │ ▼ Packet arrives at Mumbai POP

Both techniques end up with the same result: the packet lands at Mumbai. They just get there by different means.

#### The "GLB is invisible" realization

So to answer *"why isn't there a GLB anywhere?"* — there is one, but it's woven into the infrastructure rather than being a box:

| What looks like | What it actually is |
| --- | --- |
| A "Global Load Balancer" | BGP anycast + GeoDNS + health monitoring |
| "It decided to send me to Mumbai" | BGP's shortest-AS-path naturally picked Mumbai |
| "The GLB runs somewhere" | Distributed across every POP and every DNS server |

There's no single machine deciding "this user goes to Mumbai, that user goes to Dublin." It **emerges** from four cooperating systems:

-   Every POP **announces the same VIP** (or a region-specific VIP) via BGP.
-   Every BGP router on the internet **independently picks the closest path** based on AS\_PATH length and LOCAL\_PREF.
-   DNS servers have **geo-aware logic** that steers different users to different VIPs.
-   **Health monitoring** at each POP withdraws BGP announcements when the POP is unhealthy — rerouting users to the next-nearest POP automatically.

#### What's running at each POP

Now you can see the full picture: a thin global "fabric" routes you to a POP, and the heavy LB lifting happens locally inside that POP.

┌───────────────────────────────────────────────────────────────┐ │ GLOBAL "GLB" │ │ (BGP anycast + GeoDNS + health monitoring) │ │ │ │ │ routes user to nearest POP │ │ │ │ └───────────────────────────┼───────────────────────────────────┘ │ ┌──────────────────┼──────────────────┐ ▼ ▼ ▼ ┌─────────┐ ┌─────────┐ ┌─────────┐ │ Mumbai │ │ Ashburn │ │ Dublin │ │ POP │ │ POP │ │ POP │ ├─────────┤ ├─────────┤ ├─────────┤ │ Edge rtr│ │ Edge rtr│ │ Edge rtr│ │ │ │ │ │ │ │ │ │ │ ToR │ │ ToR │ │ ToR │ │ │ │ │ │ │ │ │ │ │ IPVS×N │ │ IPVS×N │ │ IPVS×N │ ← local LB │ │ │ │ │ │ │ │ │ │ ATS×M │ │ ATS×M │ │ ATS×M │ ← L7 proxy / cache │ │ │ │ │ │ │ │ │ │ Apps │ │ Apps │ │ Apps │ └─────────┘ └─────────┘ └─────────┘

At the **global level**, there's no single LB — it's BGP + DNS. At the **POP level**, IPVS (or Maglev / Katran / GLB-the-product) handles the work.

<a id="summary"></a>

### 🧠 The five big ideas packed into these 50 steps

**1\. Layered addressing.** IP is end-to-end (survives the whole trip). MAC is per-link (rewritten every hop). Port is per-connection. VIP is a logical IP that many physical boxes can "own."

**2\. BGP is just distributed routing.** Each AS announces what it owns. Each router picks a next hop based on policy (LOCAL\_PREF, AS\_PATH). There is no central map — routes emerge from each router's independent best-path choice.

**3\. The same VIP is announced at nested scopes.** eBGP to the internet, iBGP inside the POP, and (in DR mode) ARP-level on the loopback of every IPVS box and every ATS. "Where does it go?" depends on which layer is routing.

**4\. ECMP + consistent hashing = stateless load balancing.** ToR picks an IPVS box by 5-tuple hash. IPVS picks a backend by 5-tuple hash. Same flow = same IPVS = same backend, without any central coordinator.

**5\. DSR (Direct Server Return) is why this scales.** The LB sees only inbound packets. The reply bypasses it entirely. Since responses (HTML, video) are 10-100× bigger than requests, this multiplies LB capacity by the same factor.

DNS

Name → IP. 4 round-trips when cold, 0 when cached.

ARP

Local IP → MAC. Broadcast, per-link only.

BGP

Policy-based routing between & within ASes.

ECMP

Spread flows across equal-cost paths by hash.

IPVS

Kernel L4 forwarder. DR mode = MAC rewrite only.

ATS

L7 edge proxy: TLS termination + caching.

DSR

Replies bypass the LB → massive scale.

Consistent Hash

Same flow → same backend, without central state.

### 📖 Glossary — every term, in plain English

| Term | What it means |
| --- | --- |
| DHCP | How your laptop learns its IP, gateway, and DNS server when joining a network. |
| /etc/hosts | Static text file mapping hostnames to IPs. Checked before DNS. |
| /etc/resolv.conf | Lists DNS servers. Filled in by the DHCP client. |
| nsswitch.conf | Tells the OS the order to consult name sources (files vs DNS). |
| DNS | Question: "What's the IP of this hostname?" Answers via UDP/53. |
| Recursive resolver | DNS server that walks root → TLD → authoritative on your behalf. |
| Authoritative NS | The DNS server that holds the actual records for a domain. |
| GeoDNS | Authoritative NS that returns different IPs based on the resolver's location. |
| NAT | Router rewrites private IP → public IP on the way out, reverses on the way back. |
| RFC 1918 | Defines private ranges 10.x, 172.16–31.x, 192.168.x — reused on every network. |
| ARP | "What's the MAC of this local IP?" Broadcast, per-link only. |
| MAC address | 48-bit hardware address on your NIC. Used only on the local Ethernet segment. |
| Default gateway | The router you hand any non-local packet to. |
| Routing table | OS map of destination → next hop. Always has at least a default route. |
| AS / ASN | Autonomous System: a network with one administrative owner. Comcast=AS7922. |
| BGP | How ASes tell each other "I can reach these IP prefixes." The internet's glue. |
| eBGP / iBGP | BGP between ASes (eBGP) vs inside one AS (iBGP). |
| Anycast | One IP announced from many locations. Routers pick the closest. |
| POP | Point of Presence — a physical site where a service has servers. |
| ToR switch | Top-of-Rack switch — the first L3 hop above servers in a datacenter rack. |
| VIP | Virtual IP — a logical address many physical boxes can "own" (via iBGP/loopback). |
| 5-tuple | (src\_ip, src\_port, dst\_ip, dst\_port, protocol) — the unique fingerprint of a flow. |
| ECMP | Equal-Cost Multi-Path. Router hashes the 5-tuple to deterministically pick one of N paths. |
| L4 LB | Operates at TCP/UDP. Doesn't terminate TLS. Forwards by 5-tuple. (Katran, IPVS, Maglev.) |
| L7 LB | Terminates TLS, parses HTTP, routes by host/path/headers. (Envoy, NGINX, HAProxy.) |
| IPVS | Linux kernel L4 load balancer. Uses connection tracking + scheduler. |
| DR mode | Direct Routing — IPVS rewrites only the destination MAC, IP header untouched. |
| DSR | Direct Server Return — backend replies straight to client, bypassing the LB. |
| Maglev / mh | Google's consistent-hash scheduler. Same 5-tuple → same backend. |
| Consistent hashing | Adding/removing a backend re-maps only a small fraction of keys. |
| Connection tracking | Kernel table that remembers which backend a flow was assigned to. |
| BIRD | Open-source BGP daemon often used to make a Linux box speak iBGP to a ToR. |
| ATS | Apache Traffic Server — LinkedIn's edge HTTP proxy and cache. |
| SNI | Server Name Indication. TLS extension that sends the hostname in plaintext. |
| ALPN | Application-Layer Protocol Negotiation. TLS picks HTTP/1.1 vs HTTP/2. |
| ECDHE | Elliptic-Curve Diffie-Hellman Ephemeral. Derives a shared secret without sending it. |
| HTTP/2 | Multiplexes many requests over one TCP+TLS connection. |
| Brotli (br) | Compression algorithm Google built; used in \`Content-Encoding: br\`. |
| Espresso | LinkedIn's primary document store (member data). |
| Pinot | LinkedIn's OLAP datastore (analytics). |
| Venice | LinkedIn's KV store (precomputed/derived data). |
| Kafka | LinkedIn's distributed log / streaming platform. |

Networking 101 · part of [Kiran's Tech Hub](https://kkanakka.github.io/)
