---
title: "NALSD War-Room Scenarios"
slug: /sre/sre-nalsd
sidebar_position: 5
sidebar_label: "NALSD War-Room Scenarios"
description: "NALSD War-Room Scenarios"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/sre-nalsd/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

18 Non-Abstract Large Systems Design scenarios — the exact format Google SRE uses. Diagnose running global infrastructure, not abstract whiteboard designs.

Google SRE • NALSD Practice • 18 Scenarios • Full Playbook

[Home](/) [NALSD System Design](/docs/sre/sd-google-sre) [Debugging Handbook](/docs/sre/sre-debugging)

Section 1: NALSD Overview — How It Works & Why Google Tests It

## What is NALSD?

The **Non-Abstract Large Systems Design (NALSD)** round is a signature Google SRE interview. It is not about designing shiny new architectures, and not about single-node debugging.

**NALSD = diagnosing, reasoning, and improving a real-world, Internet-scale system that is already in production.**

Think of it as a *war-room simulation*: a system works fine in general, but something is off — latency spike, partial outage, stale cache, cert failures. You're dropped into the middle of it, and the interviewer watches how you investigate, explain, and stabilize.

| Round | System Design | Troubleshooting | NALSD |
| --- | --- | --- | --- |
| **Mindset** | Architect from scratch | Debug single machine/service | Diagnose running global infra |
| **Example Prompt** | "Design a global metrics pipeline." | "Why is this server's CPU pegged at 90%?" | "Metrics pipeline works, but South America is 500ms slower — why?" |
| **Primary Skills** | Abstraction, scalability, feature tradeoffs | Debugging depth, root cause finding | Layered reasoning, reliability mindset, prioritization |

*The NALSD distinction: you don't "invent" a system, you autopsy and stabilize a real one.*

### Why Google Tests NALSD

1.  **SRE ≠ pure SWE:** SREs are operators of massive distributed systems. Google needs proof you can reason about failures at every layer.
2.  **Systems thinking:** Can you navigate the stack (browser → DNS → CDN → LB → service → DB) without panicking?
3.  **Judgment under partial data:** In real outages, logs and graphs are incomplete. Do you form hypotheses, not guesses?
4.  **Reliability vs. speed tradeoffs:** Do you stabilize the system first, then chase root cause?
5.  **Communication:** Can you explain your reasoning clearly, so others could follow in a war-room?

### Anatomy of a NALSD Scenario

A typical NALSD question looks like: *"Our global photo-sharing service is healthy in most regions, but uploads from South America are suddenly 500ms slower. The rest of the world is fine. What do you do?"*

<img src="/diagrams/sre-nalsd/1.svg" alt="sre-nalsd diagram 1" class="doc-diagram" />

Fig 1: The 6-step NALSD reasoning flow

### Scoring Lens (What Google Looks For)

-   **Clarity:** Asks the right clarifying questions before diving in.
-   **Layered depth:** Can "zoom in" and "zoom out" across networking, systems, app.
-   **Reliability mindset:** First priority = restore service, then analyze root cause.
-   **Tradeoff reasoning:** Weighs cost, performance, and reliability, not just "fixes."
-   **Communication:** Explains thinking calmly, step by step.

### Common Pitfalls in NALSD

-   Jumping to root cause without ruling out simpler explanations.
-   Treating it like a coding round (it's not about implementing algorithms).
-   Ignoring the stack (focusing only on app/db, forgetting DNS/CDN/network).
-   Neglecting stabilization (great diagnosis but no plan to keep service alive).
-   Over-engineering (proposing new architectures instead of pragmatic fixes).

<a id="toc"></a>

## 18 Scenarios + Rubric

1.  [S1: Regional Latency Spike (SA 500ms Slower)](#s1)
2.  [S2: Load Balancer Connection Storm](#s2)
3.  [S3: TLS Handshake & Certificate Rotation Failure](#s3)
4.  [S4: DNS Resolution Degradation (30% NXDOMAIN)](#s4)
5.  [S5: CDN Cache Invalidation Delay](#s5)
6.  [S6: Database Replica Lag in Multi-Region](#s6)
7.  [S7: Memory Leak in Go Service (Heap Bloat)](#s7)
8.  [S8: Packet Drops Under Kernel Resource Contention](#s8)
9.  [S9: Cross-Region Data Transfer Bottleneck (BDP)](#s9)
10.  [S10: Control-Plane Failure vs Data-Plane Resilience](#s10)
11.  [S11: Time Skew & NTP Failure](#s11)
12.  [S12: Disk I/O Saturation (IOPS vs Throughput)](#s12)
13.  [S13: Service Discovery Failure](#s13)
14.  [S14: Rate-Limiter Gone Rogue](#s14)
15.  [S15: Queue Backpressure Cascade](#s15)
16.  [S16: Log Pipeline Collapse (Observability Outage)](#s16)
17.  [S17: Cloud Resource Quota Exhaustion](#s17)
18.  [S18: API Gateway Token Bucket Bug](#s18)
19.  [NALSD Evaluation Rubric](#rubric)
20.  [Self-Practice Templates](#template)

Scenarios 1–5: Network, CDN, DNS

<a id="s1"></a>

### S1 — Regional Latency Spike (South America 500ms Slower)

#### Symptom

Global photo-sharing platform. Users in South America: uploads consistently 500ms slower than other regions. Rest of world: normal latency. No obvious errors, just slowness.

#### Step 1: Clarify Requirements

-   Is it all users in South America or specific ISPs/carriers?
-   Is the latency constant (always +500ms) or spiky (some requests)?
-   When did this start — after a rollout, or gradual?
-   Is it only uploads or also downloads?
-   Is the latency in DNS resolution, TLS handshake, request latency, or DB writes?

*Interviewer Lens: They want to see if you narrow scope before diving in.*

#### Step 2: Layered Diagnostic Path

<img src="/diagrams/sre-nalsd/2.svg" alt="sre-nalsd diagram 2" class="doc-diagram" />

Fig 2: Request path layers — CDN edge is the likely failure point

1.  **Client → DNS:** Are users resolving to the correct regional CDN edge? Misconfigured DNS TTLs causing cross-region resolution?
2.  **DNS → CDN:** Which CDN PoP are they hitting? São Paulo edge? Or routed to Miami by mistake?
3.  **CDN → LB:** Requests balanced to correct regional LBs? Routing asymmetry (BGP leak, congested transit)?
4.  **LB → App:** SA app cluster healthy? CPU/memory saturation? Connection queues?
5.  **App → DB:** Multi-region DB replication delay? Writes routed cross-continent?

**Key question:** Is 500ms constant (misrouting) or intermittent (congested ISP link)?

#### Step 3: Hypothesis Formation

-   **H1:** If 500ms constant → network round-trip misrouting (probably cross-region).
-   **H2:** If intermittent → CDN cache miss or congested ISP link.
-   **H3:** If upload-only → writes routed to US-East DB instead of Brazil replica.

#### Step 4: Root Cause Walkthrough

Trace metrics: SA users resolve DNS correctly (São Paulo CDN). CDN logs show 40% of requests proxied back to US-East instead of served locally. A recent CDN config change invalidated São Paulo's upload caching tier → defaulted to upstream US-East. Result: +500ms RTT due to cross-continent upload path.

#### Step 5: Mitigation vs. Fix

**Mitigation (now):** Route traffic temporarily to nearest working CDN edges (Miami + São Paulo). Roll back faulty config, force re-propagation to CDN edge.

**Fix (long-term):**

-   Synthetic monitoring: per-region latency checks (upload + download).
-   Automate alerts on CDN config drift.
-   Shorten DNS TTLs to allow quicker correction.
-   Add "fail-safe" fallback so CDN never silently reverts to US-East for uploads.

**Common Pitfalls:** Blaming the app/DB immediately. Not asking scope questions. Treating "South America slow" as identical to "global outage." Only proposing fixes, not mitigations — interviewers want restore first.

#### Interviewer Scoring Signals

**Strong:** Diagnoses CDN misconfig + proposes rollback.

**Exceptional:** Adds monitoring, explains DNS TTL tradeoffs, proposes automation. Narrates calmly like leading an incident bridge.

**Reflection:** If instead of uploads, it was TLS handshakes slower in SA, how would your reasoning path differ? What metrics & logs would you request first? How would you prevent this from silently impacting users again?

**Why this works:** Realistic (CDN misconfigs cause actual region-specific slowdowns). Layered (forces DNS/CDN/network/app/DB checks). Google-style war-room autopsy.

[↑ Back to top](#toc)

<a id="s2"></a>

### S2 — Load Balancer Connection Storm (SYN Flood / Flash Crowd)

#### Symptom

LB connection queues spiking to max capacity. Sudden increase in half-open TCP connections (SYN\_RECV state). Users see intermittent timeouts / dropped requests. App servers underutilized (CPU fine, memory fine).

#### Step 1: Clarify

-   Is this a DDoS attack (external) or a flash crowd (legit traffic surge)?
-   Which regions / LBs are affected — just one PoP or global?
-   Is it all protocols or only TCP/HTTP?
-   What's the scale: 2x, 10x, 100x connections above baseline?
-   Any recent config changes to LB / kernel parameters / firewall rules?

#### Step 2: Layered Diagnostic Path

```bash
netstat -s | grep SYN              # SYN backlog
cat /proc/net/nf_conntrack | wc -l # conntrack table
ethtool -S eth0 | grep drop        # NIC drops
```

1.  **Network Layer (TCP):** SYN backlog, `net.ipv4.tcp_max_syn_backlog` exhausted? Abnormal handshake completion ratio?
2.  **LB OS / Kernel:** Conntrack table usage, LB CPU (I/O-bound, IRQ-bound, or packet-drop bound).
3.  **LB Software / Config:** Timeouts too high (connections linger)? Health checks overwhelming backend?
4.  **Application Servers:** Rejecting connections → LBs retry endlessly?
5.  **External / Attack Vector:** Sudden flood from small IP set? Concentrated botnet or organic surge?

#### Step 3: Hypotheses

-   **H1:** SYN Flood Attack — half-open TCP connections overwhelming LBs.
-   **H2:** Flash Crowd Event — legit surge (product launch, viral traffic).
-   **H3:** Misconfigured LB Timeout — connections stuck too long → backlog fills.
-   **H4:** Kernel Resource Limits — conntrack table or SYN backlog too small.

#### Step 4: Root Cause

SYN backlog filled to 100%. 80% of connections never complete handshake (SYN\_RECV stuck). Source IPs randomized, no valid ACKs. LB CPU fine, app servers fine. **Conclusion: SYN flood attack saturating LB TCP backlog.**

#### Step 5: Mitigation vs. Fix

**Mitigation (now):**

-   Enable SYN cookies (`net.ipv4.tcp_syncookies=1`).
-   Rate-limit suspicious IPs at edge firewall. Geo-block abusive regions if possible.
-   Autoscale additional LBs to absorb load.

**Fix (long-term):**

-   Deploy DDoS mitigation at network edge (Cloud Armor, Akamai, etc.).
-   Tune kernel: increase `tcp_max_syn_backlog`, reduce `tcp_synack_retries`.
-   Add scrubbing layer before LBs. Synthetic monitoring for SYN backlog saturation.

**Pitfalls:** Jumping straight to scaling apps (apps aren't the bottleneck). Assuming all traffic is legit without checking handshake ratios. Ignoring kernel parameters.

#### Scoring

**Strong:** Quickly identifies LB/kernel-level, not app. Talks SYN backlog, conntrack. **Exceptional:** Explains how SYN flood differs from legit flash crowd. Layered defense: kernel tuning, scrubbing, monitoring.

**Reflection:** If it was a legit traffic surge (viral event), how would your mitigation differ? Which Linux kernel params would you tune?

[↑ Back to top](#toc)

<a id="s3"></a>

### S3 — TLS Handshake Latency & Certificate Rotation Failure

#### Symptom

Latency spike during TLS handshakes (clients see ~2s extra delay). Some regions: complete failures (TLS handshake timeout). Error logs: "certificate expired." Service itself healthy.

#### Step 1: Clarify

-   All clients or specific regions/browsers/devices?
-   Did this begin after a cert rotation event?
-   Which TLS versions in play (1.2 vs 1.3)? Internal or external CA?
-   Is the problem latency (handshake slow) or availability (cert expired)?

#### Step 2: Diagnostic Path

1.  **Client Layer:** All browsers/devices fail equally? Specific OS/browser rejecting cert chain?
2.  **TLS Handshake:** Measure handshake latency (Wireshark/tcpdump). Defaulting to slow cipher suite?
3.  **Certificate & CA Chain:** Intermediate or root CA expired? Wrong intermediate cert in chain?
4.  **LB / Proxy Layer:** Did LB get the updated cert? Cert propagation complete across all regions?
5.  **Automation:** Was rotation automated? Any failures logged?

#### Root Cause

Cert rotation job ran but failed on ~20% of global LBs. Those LBs still present the expired cert. In regions with the updated cert, cipher preference list changed, causing negotiation retries → latency spike.

#### Mitigation vs. Fix

**Now:** Force cert rollout to all LBs. Revert cipher config. Redirect users to healthy PoPs.

**Long-term:** Fully automate cert rotation (ACME). Synthetic TLS handshake tests per region/browser. Pre-rotation overlap (new cert deployed days before old one expires). Auto-rollback on latency spike post-rotation.

#### Scoring

**Exceptional:** Shows layered debugging. Explains security vs reliability trade-off. Proposes cert lifecycle automation. Asks "What prevents the next cert expiry fire drill?"

**Reflection:** How would you design zero-downtime cert rotation at global scale? What metrics would you monitor during TLS rotation?

[↑ Back to top](#toc)

<a id="s4"></a>

### S4 — DNS Resolution Degradation (30% NXDOMAIN)

#### Symptom

~30% of global users: "site not reachable." Others fine. Pattern: NXDOMAIN or SERVFAIL. Not uniform across ISPs. Service itself healthy.

#### Step 1: Clarify

-   Which DNS resolvers impacted? (ISP-specific or global like Google DNS / Cloudflare?)
-   All services under domain or just one subdomain?
-   Did this start after a zone file update or config change?
-   Are failures NXDOMAIN (record missing) vs SERVFAIL (authoritative failure)?

#### Step 2: Diagnostic Path

1.  **Client → Recursive Resolver:** Can clients resolve via different resolvers? Caching stale/broken data?
2.  **Recursive → Authoritative DNS:** Auth servers responding correctly? Packet loss, timeouts, inconsistent answers?
3.  **Auth DNS → Zone Data:** Zone file misconfigured? Split-horizon misconfig?
4.  **TTL & Caching:** Resolvers holding stale records due to high TTL?

#### Hypotheses

-   **H1:** Misconfigured DNS zone file — wrong record pushed.
-   **H2:** Partial propagation failure — only some auth servers updated.
-   **H3:** Expired/removed glue records at parent zone.
-   **H4:** Recursive resolver caching bad data due to long TTL.

#### Root Cause

Authoritative DNS cluster has 4 servers. Zone propagation automation bug → 2 servers correctly updated, 2 still serve old data. Recursive resolvers hit "good" or "stale" servers randomly.

#### Mitigation vs. Fix

**Now:** Force zone reload on all auth servers. Lower TTL temporarily (1h → 5m).

**Long-term:** Validate all auth servers before completing push. Synthetic tests from multiple resolvers. Dual-push with pre-validation. Alert on zone drift.

#### Scoring

**Exceptional:** Explains why some users fail while others succeed (cache + server inconsistency). Mentions propagation validation, drift detection, toil reduction.

[↑ Back to top](#toc)

<a id="s5"></a>

### S5 — CDN Cache Invalidation Delay

#### Symptom

New frontend release: blank screens, misaligned buttons. 404s for versioned assets. Some users see old assets, others new. Backend healthy.

#### Diagnostic Path

1.  **Client:** Browser dev tools show requests hitting correct URLs? Old versions of assets?
2.  **CDN Edges:** Still serving stale JS/CSS? Was cache purge triggered across all PoPs?
3.  **Origin:** New static assets present at origin?
4.  **Pipeline:** Cache invalidation scripted or manual? Completed across all CDN nodes?
5.  **Headers:** Correct cache headers (max-age, ETag, Last-Modified)?

#### Root Cause

Cache invalidation triggered, but API timeout → ~15% of PoPs never got purge command. Those PoPs serve old JS → broken UX.

#### Mitigation vs. Fix

**Now:** Manual global purge. Cache-busting query params (`app.js?v=20251024`). Lower cache TTL temporarily.

**Long-term:** Content-hash versioning (`app.<sha>.js`). Post-deploy synthetic PoP checks. Retry purge failures. Staged PoP rollout.

#### Scoring

**Exceptional:** Explains CDN internals: distributed PoPs, purge API failures, TTL tradeoffs. Proposes validation + automation.

[↑ Back to top](#toc)

Scenarios 6–9: Database, Memory, Network Internals

<a id="s6"></a>

### S6 — Database Replica Lag in Multi-Region Service

#### Symptom

Users in EU + SA see stale data after posting. Replication lag 30–60s behind primary (US-East). App metrics healthy. No backend failures.

#### Step 1: Clarify

-   Replication model: async, semi-sync, multi-master?
-   All replicas lagging or specific regions?
-   Lag constant or growing over time?
-   Read/write routing: reads local, writes centralized?

#### Diagnostic Path

1.  **Replication Mode:** Async → lag expected under load. Semi-sync → ack misconfigured?
2.  **Primary → Replica Link:** Network bandwidth, packet loss?
3.  **Replica Performance:** WAL/binlog replay slower than expected? Disk I/O saturation?
4.  **Traffic Patterns:** Write volume recently spiked?
5.  **Failover/Consistency:** App reading stale replicas even when lag > threshold?

#### Root Cause

Write traffic spiked 3x due to new feature. Replicas on slower disks → WAL replay can't keep up. App config still routing reads to local replicas even when lag > 10s.

#### Mitigation vs. Fix

**Now:** Route all fresh reads to US-East primary. Degrade gracefully for non-critical features.

**Long-term:** Upgrade replica I/O (SSDs). Lag-aware read-routing (if lag > 5s → failover to primary). Semi-sync replication. Regional primaries for global low-latency writes.

#### Scoring

**Exceptional:** Walks through binlog/WAL replay mechanics. Proposes lag-threshold routing. Balances consistency vs performance tradeoffs.

[↑ Back to top](#toc)

<a id="s7"></a>

### S7 — Memory Leak in Go Service (Heap Bloat)

#### Symptom

Go API service: rising memory over days, hits OOM → restart every ~48h. GC spikes before crash. CPU normal. Latency climbs before OOM.

#### Diagnostic

```
go tool pprof http://pod:6060/debug/pprof/heap
pprof> top
3.07GB 80% .../search/cache.go:45
```

1.  **Runtime (Go):** Collect heap profiles (pprof). Goroutines/objects that never free?
2.  **GC Behavior:** GC running more frequently but unable to reclaim?
3.  **Application Logic:** Objects retained in global maps/caches? Long-lived connections?
4.  **Infra:** Container memory limit too low? Host overcommitting?
5.  **Release History:** Leak appear after a particular deployment?

#### Root Cause

Request logging buffer never cleared after last release. Memory accumulates until OOM kills the service.

#### Mitigation vs. Fix

**Now:** Restart service instances more aggressively (every 12h). Flush buffers. Increase container memory limit temporarily.

**Long-term:** Fix buffer rotation code. Unit tests for memory under load. Heap monitoring (pprof, Prometheus). SLO alert on memory growth rate.

#### Scoring

**Juniors:** "Add more memory." **Strong:** "pprof the leak." **Senior:** "Every OOM is user-visible availability hit. New cache features must pass leak-test before rollout."

[↑ Back to top](#toc)

<a id="s8"></a>

### S8 — Packet Drops Under Kernel Resource Contention

#### Symptom

Front-end proxies: sporadic 5xx during traffic spikes. CPU 40–55% but network RX drops climbing. SYN\_RECV and retransmits jump. No clear DDoS signal; traffic mostly legit.

#### Diagnostic

```bash
ethtool -S ens5            # rx_no_buffer, rx_dropped
cat /proc/net/softnet_stat # dropped, squeezed per CPU
cat /proc/interrupts       # All NIC IRQs on CPU0!
ethtool -g ens5            # RX ring size (too small?)
```

<img src="/diagrams/sre-nalsd/3.svg" alt="sre-nalsd diagram 3" class="doc-diagram" />

Fig 3: Linux packet receive path — softirq saturated on CPU0 is the choke point

#### Root Cause

`irqbalance` disabled after kernel upgrade → all NIC IRQs land on CPU0 → single-core choke. RX ring at conservative default. Softirq saturated on CPU0.

#### Mitigation vs. Fix

**Now:** Spread IRQ affinity. Enable RSS/RPS/XPS. Increase RX ring + `netdev_max_backlog`. Scale out LB instances.

**Long-term:** NUMA locality enforcement. `fq_codel` qdisc. eBPF observability. Golden image validation for RSS/IRQ post-upgrade.

#### Scoring

**Exceptional:** Explains full packet path NIC→ring→NAPI→softirq→qdisc→socket. Brings in NUMA, fq\_codel, eBPF. Proposes golden image CI.

[↑ Back to top](#toc)

<a id="s9"></a>

### S9 — Cross-Region Data Transfer Bottleneck (BDP)

#### Symptom

Single TCP flows cap ~120–200 Mbps on 1–10 Gbps links. RTT 120–220ms. Low loss (0.05–0.2%). Intra-region transfers fine.

#### Diagnostic — The BDP Math

```
BDP = bandwidth × RTT
1 Gbps × 200ms = 25 MB in-flight required
If rwin/cwnd < 25 MB → never hit line rate

sysctl net.ipv4.tcp_rmem   # Check max receive buffer
sysctl net.ipv4.tcp_congestion_control  # CUBIC? BBR?
```

<img src="/diagrams/sre-nalsd/4.svg" alt="sre-nalsd diagram 4" class="doc-diagram" />

Fig 4: BDP analysis — undersized TCP windows = throughput cap

#### Root Cause

`tcp_rmem` max = 4MB (far below BDP of 25MB). CUBIC + tiny losses depress cwnd further. Per-flow policer at ~200 Mbps. Single stream = capped.

#### Mitigation vs. Fix

**Now:** Parallelize streams (8–16 TCP). Increase rmem/wmem to 32MB. Switch to BBR. Enable jumbo MTU.

**Long-term:** Negotiate per-flow policer raise. Build self-tuning transfer service. Goodput-centric SLOs.

#### Scoring

**Exceptional:** Does BDP math. Calls out per-flow shaping. Proposes auto-tuning transfer service with SLOs for goodput (not link rate).

[↑ Back to top](#toc)

Scenarios 10–13: Control Plane, Time, Storage, Discovery

<a id="s10"></a>

### S10 — Control-Plane Failure Bleeding into Data Plane

#### Symptom

Config/feature-flag service degraded (quorum lost). Healthy pods deny requests: "policy fetch failed." New pods fail to start (init waiting on config). Backends + DBs healthy.

#### Diagnostic Path

<img src="/diagrams/sre-nalsd/5.svg" alt="sre-nalsd diagram 5" class="doc-diagram" />

Fig 5: Control-plane failure bleeding into data plane serving

1.  Which products/regions break? Only deploying/scaling or steady state too?
2.  Client libraries: fail-open or fail-closed? Local cache enabled? TTL?
3.  Config delivery: pull vs push; regional mirrors? Write path blocks reads?
4.  Timeouts & retries: thundering herd on recovery?

#### Root Cause

Client-lib update changed config fetch from background refresh to on-demand per-request validation for "high-risk flags." Fail-closed policy. TTL=30s with hard revalidation. Control-plane hiccup → cascaded into data plane.

#### Mitigation vs. Fix

**Now:** Force fail-open. Raise cache TTLs. Enable serve-stale. Un-gate init. Circuit break + backoff CP clients.

**Long-term:** Decouple data plane from control plane by design. Out-of-band background refresh with sticky last-known-good (LKG). Signed snapshots via CDN. Game days: disable CP and prove DP meets SLOs.

#### Scoring

**Exceptional:** Principled resilience model (LKG + signed snapshots + strict retry budgets). Differentiates security-critical vs non-critical. Adds SLOs for degraded mode.

[↑ Back to top](#toc)

<a id="s11"></a>

### S11 — Time Skew & NTP Failure

#### Symptom

Auth failures (tokens "expired"/"not yet valid"). TLS handshakes fail. Crons run twice or skip. Logs out of order. Negative latencies on dashboards. Infra otherwise healthy.

#### Diagnostic

1.  **System logs:** `dmesg | grep -i time`, `ntpq -p` / `chronyc tracking` → sync status, offsets.
2.  **Compare against reference:** Cross-check against GPS stratum-1, trusted external NTP pool.
3.  **Auth systems:** Token issuance vs validation timestamps. Cert validity intervals.
4.  **Schedulers/Jobs:** Crons firing early/late, jobs missed due to backwards jump.
5.  **Distributed logs:** Event ordering broken. Negative latencies in tracing.

#### Root Cause

EU NTP cluster lost GPS refclock (hardware fault). Drifted +4 minutes over 24h. Auth services rejected tokens from US ("not valid yet"). TLS certs looked expired.

#### Mitigation vs. Fix

**Now:** Force resync against healthy external NTP. Widen time tolerance for auth/TLS. Gradual slew (not step).

**Long-term:** Redundant NTP (GPS + multiple upstreams). Chrony/TrueTime-style. Use `CLOCK_MONOTONIC` for durations. Bounded skew for token validation. Game days: simulate NTP loss.

#### Scoring

**Exceptional:** Discusses monotonic vs wall clocks. Mentions TrueTime. Frames time as a distributed systems dependency.

[↑ Back to top](#toc)

<a id="s12"></a>

### S12 — Disk I/O Saturation (IOPS vs Throughput)

#### Symptom

Latency spikes on reads/writes. IOPS pegged but throughput well below capacity (150 MB/s on 500 MB/s disks). Errors only under spiky workloads.

#### The Math

```
Disks: 10K IOPS quota, 500 MB/s throughput
Workload: 4 KB random writes
Max throughput = 10K IOPS × 4 KB = 40 MB/s
(NOT 500 MB/s — IOPS is the bottleneck, not throughput!)
```

#### Root Cause

Small 4KB random writes from DB logs. Hit per-volume IOPS cap. Queue depth grows → await latency spikes → replicas marked "unhealthy."

#### Mitigation vs. Fix

**Now:** Stripe across volumes. Cache hot reads. Throttle background jobs.

**Long-term:** NVMe/provisioned IOPS. Redesign for sequential batching. Tiered storage. I/O admission control.

#### Scoring

**Exceptional:** Shows math (10K IOPS × 4KB = 40 MB/s). Talks retry storms and admission control. Proposes tiered storage + log-structured designs.

[↑ Back to top](#toc)

<a id="s13"></a>

### S13 — Service Discovery Failure (CoreDNS/etcd/Mesh Crash)

#### Symptom

Hundreds of services return 503. Logs: "host not found" or "no healthy backends." Backends themselves healthy. Services can't locate each other.

#### Diagnostic Path

1.  **Clients:** DNS resolution errors (NXDOMAIN/SERVFAIL)? Or "no healthy backends" from service mesh?
2.  **Local Agent:** Check sidecars, kube-dns/CoreDNS agents — are they up?
3.  **Discovery Control Plane:** etcd/Consul health? K8s API health? Updates propagating to endpoints?
4.  **Cached State:** Do Envoy sidecars still have last-known config? TTL on DNS records?
5.  **Dependencies:** Discovery infra on same cluster as user traffic? Circular dependency?

#### Root Cause

K8s upgrade deployed new CoreDNS config with bug → crashloop on invalid zone file. All DNS lookups for `svc.cluster.local` fail. Services with cached IPs worked until TTL expired (~30s).

#### Mitigation vs. Fix

**Now:** Rollback CoreDNS config. Extend DNS TTL. Inject static DNS for critical services.

**Long-term:** Decouple discovery from main cluster. Redundant layers (DNS fallback, LKG in sidecars). Canary CoreDNS changes. Game days: simulate discovery outage.

#### Scoring

**Exceptional:** Maps control plane vs data plane. Proposes resilient designs: regionalized discovery, signed snapshots, circuit breakers.

[↑ Back to top](#toc)

Scenarios 14–18: Rate Limiting, Queues, Observability, Quotas

<a id="s14"></a>

### S14 — Rate-Limiter Gone Rogue

#### Symptom

Surge of 429s. Traffic dropped 40%. Backends healthy. Rate-limiter update rolled out earlier.

#### Diagnostic Path

1.  **Client:** All clients failing or specific tenants/users?
2.  **Rate-Limiter:** Rejection % by region/tenant. Current configured limit vs baseline?
3.  **Rollout History:** Config push lower quotas? Unit mismatch (per-second vs per-minute)?
4.  **Data Plane vs CP:** Gateways rejecting due to stale/bad quota sync?
5.  **Fail-Safe:** Fail-open or closed if backend state unavailable?

#### Root Cause

Config parsed "1000 req/s per tenant" as "1000 req/minute" (off by 60x). All tenants exceeded quota instantly → majority of requests rejected.

#### Mitigation vs. Fix

**Now:** Roll back config. Temporarily fail-open if rollback blocked. Manual overrides for critical tenants.

**Long-term:** Config validation with unit checks. Canary with synthetic traffic. Fail-open for limiter backend outages. Per-tenant fairness. Alerts: if rejection >5% globally, block rollout.

#### Scoring

**Exceptional:** Explains limiter algorithms (token/leaky bucket). Proposes synthetic pre-flight validation. SLOs for rate-limiter (<1% unexpected 429s). Security vs availability trade-off.

[↑ Back to top](#toc)

<a id="s15"></a>

### S15 — Queue Backpressure Cascade

#### Symptom

Multi-tier: API → Orchestrator → Worker → DB. p95/p99 explodes. Retry rates climb. Queue depths rise. OOMs in workers. System self-amplifying.

#### Diagnostic Path

<img src="/diagrams/sre-nalsd/6.svg" alt="sre-nalsd diagram 6" class="doc-diagram" />

Fig 6: Queue backpressure cascade — retry storms amplify the original slowdown

#### Root Cause

New feature doubled writes to hot DB partition → worker throughput drops 50% → Kafka lag grows → API retries 3x with no jitter (synchronized storm) → producers buffer in RAM → OOM → replayed messages → amplifying loop.

#### Mitigation vs. Fix

**Now:** Trip circuit breakers. Reduce retry count, enforce backoff+jitter. Per-tenant rate limits. Pause feature causing hot-spot. Cap producer buffers.

**Long-term:** Idempotent handlers + dedup keys. Hedged requests with budgets. Shard hot keys. Queue SLOs for lag. Auto-circuit on threshold. Game days.

#### Scoring

**Exceptional:** Systemic blueprint — idempotency, hedged requests, budgeted concurrency, priority queues. Control-theory: negative feedback loops to dampen oscillations.

[↑ Back to top](#toc)

<a id="s16"></a>

### S16 — Log Pipeline Collapse (Observability Outage)

#### Symptom

Service serves normally — no user impact. But: central log pipeline hours behind. Dashboards show flatline/old data. Alerts: "no data received." On-call engineers blind.

#### Diagnostic Path

1.  **Agent Layer:** CPU/memory on log shippers (Fluentd, Vector). Backlogged or crashing?
2.  **Transport:** Kafka/Queue lag, partition skew, replication health.
3.  **Processing:** Parsing errors (schema change?). Resource bottlenecks (heap, GC, disk).
4.  **Storage:** Elasticsearch/BigQuery ingestion failures. Shard imbalance.
5.  **Alerting:** Alert rules break because they rely on fresh logs?

#### Root Cause

New release added large debug field → log size 5x → Kafka partition disk I/O limit → consumer lag grew from minutes to hours. Metrics pipeline also slowed (shared brokers).

#### Mitigation vs. Fix

**Now:** Drop non-critical log fields. Throttle debug logging. Increase Kafka partitions. Create side-channel lightweight synthetic metrics.

**Long-term:** Log budgets per service. Separate serving metrics from debug logs. Canary log schema changes. SLOs for observability ("95% logs ingested <5m"). Graceful shedding (drop debug first).

#### Scoring

**Exceptional:** Treats observability as production-critical system with its own SLOs. Prioritized: serving metrics > logs > debug. Side-channel synthetic probes when blind.

[↑ Back to top](#toc)

<a id="s17"></a>

### S17 — Cloud Resource Quota Exhaustion

#### Symptom

Traffic surge → autoscaler kicks in → new VMs/pods fail: "Quota exceeded." API Gateway 503s. Some regions scale fine, others flatline. Existing instances healthy but overloaded.

#### Diagnostic Path

1.  **Autoscaler logs:** "Insufficient quota" or "resource exhausted"?
2.  **Quota dashboard:** Per-region usage. API call failures?
3.  **Distribution:** Failures localized to region/AZ or global? Skew?
4.  **Service impact:** Critical tiers starved first?
5.  **Workarounds:** Spare quota in other regions/projects?

#### Root Cause

GCP CPU quota per project per region = 2,000. Current usage = 2,000. Autoscaler requested 200 more → API error. No quota alerts set up.

#### Mitigation vs. Fix

**Now:** Reroute traffic to other regions. Emergency quota raise. Throttle traffic. Scale down batch jobs.

**Long-term:** Quota-aware autoscaler. Pre-provisioned 20% headroom. Quota monitoring + alerting. Multi-project pooling. Synthetic drills.

#### Scoring

**Exceptional:** Mentions quota-aware autoscaling. Proposes multi-project, multi-region, pooled scaling. Discusses headroom policies and synthetic failure drills.

[↑ Back to top](#toc)

<a id="s18"></a>

### S18 — API Gateway Token Bucket Bug

#### Symptom

Surge of 503s and 429s. Even low-traffic clients rejected. Backends healthy. New Gateway release rolled out.

#### Diagnostic Path

1.  **Client view:** 429 distribution by tenant — even single-test clients hit?
2.  **Gateway:** Token bucket refill rate vs consumption rate. Counters resetting correctly?
3.  **Limiter backend:** Redis/etcd degraded? Retries/timeouts causing "reject" default?
4.  **Deployment:** Config/unit changed (per-second vs per-minute)? Precision errors?
5.  **Fail-safe:** Gateways fail-open or closed? Clock skew between distributed limiters?

#### Root Cause

Gateway config parser: refill rate "1000 tokens per second" interpreted as "1000 per minute." All clients exhausted quota instantly → 70% of traffic rejected.

#### Mitigation vs. Fix

**Now:** Roll back release. Fail-open if rollback blocked. Manual whitelist for critical clients.

**Long-term:** Config schema validation with explicit units. Canary with synthetic load. Per-tenant token buckets (not global). Fail-open for availability-critical, fail-closed only for security. Chaos drills for quota backend outage.

#### Scoring

**Exceptional:** Explains limiter algorithms (token vs leaky bucket vs sliding window). Proposes tenant-aware quotas and fail-safe design. Frames as availability vs abuse-prevention trade-off.

[↑ Back to top](#toc)

<a id="rubric"></a>

Section 3: NALSD Evaluation Rubric

Google interviewers don't just score "correct" vs "wrong." They measure **how you think under uncertainty**.

| Dimension | Strong Candidate | Exceptional Candidate |
| --- | --- | --- |
| **Depth Across Stack** | Identifies likely failing layer, checks 2–3 layers deep | Walks full request path (Client→Network→LB→Service→DB→Infra), pivots when evidence contradicts |
| **Prioritization** | Reasonable first checks. May chase rabbit holes. | Frames by user impact + probability. Articulates why one check comes before another. |
| **Calm + Communication** | Explains clearly, asks clarifying questions | Guides like leading an incident bridge: summarizes, proposes hypotheses, states next steps, explains trade-offs |
| **Long-Term Thinking** | Mitigation + some design fixes ("add monitoring") | Short-term stabilization + systemic prevention: SLOs, automation, canaries, chaos drills. Thinks like writing a postmortem. |

**Strong answer:** "Looks like DNS TTL issue. I'd flush caches, lower TTLs, monitor."  
**Exceptional answer:** "Users in SA slow → path diverges at DNS/CDN. First, check authoritative vs recursive resolution. Mitigation: cache purge + lower TTL. Long-term: synthetic probes per region, automated TTL validation, route health checks to fail over bad edges."  
  
*Strong is technically competent. Exceptional shows systemic ownership.*

<a id="template"></a>

Section 4: Self-Practice Templates

### Blank NALSD Template (10–12 min per scenario)

```
Symptom:         (Write the user-facing symptom)
Layers to Check: Client → Network → Infra → Service → Data → OS/Kernel
Hypotheses:      H1: ... H2: ... H3: ...
Stabilization:   (What you'd do right now as on-call)
Prevention:      (Design change, automation, monitoring, chaos test)
Reflection:      What did you prioritize first, and why?
                 What trade-offs did you face?
                 Did you propose both now-fix AND long-term prevention?
```

### Mini Drill (One-Liner)

```
Symptom → Hypotheses → First Check → Mitigation → Long-term Fix

Example:
  Symptom: Some users see stale CSS after deploy.
  Hypotheses: CDN invalidation delay, wrong cache headers.
  First Check: Inspect CDN edge vs origin headers.
  Mitigation: Force purge, serve cache-busted URLs.
  Long-term: Content-hash filenames, canary purge test.
```

### How to Use

1.  **Pick a Symptom:** Flip through war stories (e.g., "TLS expired," "NTP drift," "Disk IOPS capped").
2.  **Walk the Layers:** Don't jump to the answer — map the full stack.
3.  **Timebox Yourself:** 10–12 minutes per scenario, like in the real interview.
4.  **Score Yourself:** Use the NALSD Rubric — did your answer show Depth, Prioritization, Calm, and Long-Term Thinking?
5.  **Iterate:** Create your own scenarios or swap with peers.
