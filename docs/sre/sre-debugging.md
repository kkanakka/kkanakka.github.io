---
title: "SRE Debugging: 21 Scenarios"
slug: /sre/sre-debugging
sidebar_position: 6
sidebar_label: "SRE Debugging: 21 Scenarios"
description: "SRE Debugging: 21 Scenarios"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/sre-debugging/sequence.svg" alt="How it works — sre-debugging" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
21 production scenarios across Network, Database, Application, and OS/Kernel — the exact format Google SRE interviewers use. Symptom → Diagnose → Root Cause → Fix → Senior Signal.

Google SRE Interview • Debugging Handbook • 21 Scenarios

[Home](/) [NALSD & System Design](/docs/sre/sd-google-sre)

## 21 Scenarios — 4 Categories

1.  **Network / Connectivity (1-6)**
    -   [S1: DNS TTL Misconfiguration (Global Outage)](#s1)
    -   [S2: BGP Route Leak (Regional Blackout)](#s2)
    -   [S3: TLS Handshake / Certificate Rotation](#s3)
    -   [S4: 2% Packet Loss Under Congestion](#s4)
    -   [S5: LB Health Check Misconfiguration (Traffic Blackhole)](#s5)
    -   [S6: CDN Cache Invalidation Delay (Broken UX)](#s6)
2.  **Database / Storage (7-11)**
    -   [S7: Database Replica Lag (Stale Reads)](#s7)
    -   [S8: Transaction Deadlocks (Flash Sale)](#s8)
    -   [S9: Dropped Index → 10x Latency](#s9)
    -   [S10: Disk Full → DB Refuses Writes](#s10)
    -   [S11: Cache Stampede on Hot Key](#s11)
3.  **Application / Config (12-16)**
    -   [S12: CrashLoopBackOff (Bad Image Rollout)](#s12)
    -   [S13: Feature Flag Misfire (Broken Checkout)](#s13)
    -   [S14: Thread Leak → Service Freeze](#s14)
    -   [S15: Rate Limit Misapplied (Throttling Legit Users)](#s15)
    -   [S16: Canary Rollback Delay](#s16)
4.  **OS / Kernel / Infra (17-21)**
    -   [S17: Memory Leak → OOM Kills](#s17)
    -   [S18: CPU Throttling (CFS Quotas)](#s18)
    -   [S19: I/O Saturation → Degraded DB Writes](#s19)
    -   [S20: Kernel Panic → Mass Node Churn](#s20)
    -   [S21: File Descriptor Exhaustion](#s21)

Category 1: Network / Connectivity (Scenarios 1-6)

<a id="s1"></a>

### Scenario 1 — DNS TTL Misconfiguration (Global Outage)

#### Symptom

Users across APAC and EMEA report "site not found." Services healthy, pods running, LBs fine. Half the internet can't resolve your domain.

#### First Diagnostic Moves

```
dig yourservice.com @8.8.8.8        # Google's resolver
dig yourservice.com @1.1.1.1        # Cloudflare's resolver
dig yourservice.com @ns1.auth-dns.net  # Your authoritative NS
```

**Reasoning:** Healthy service + failing resolution → DNS problem. Inconsistent across regions → TTL + caching issue. If bad record pushed with TTL=86400 (1 day), resolvers worldwide cache it for 24h.

#### Root Cause

An engineer accidentally updated the DNS CNAME to a staging LB. Before rollback, resolvers worldwide cached the bad record for 24h due to a long TTL.

```bash
dig yourservice.com @ns1.auth-dns.net
# Shows wrong CNAME → staging-lb.example.net
```

#### Mitigation

**Immediate:** Fix the authoritative record. Push corrected CNAME.  
**Long-term:** Use short TTLs (60-300s) for critical records. Implement DNS change reviews. Add monitoring for DNS resolution from multiple global vantage points.

#### Senior SRE Signal (What the interviewer looks for)

✓ Didn't panic-restart pods. ✓ Checked DNS resolution chain first. ✓ Understood recursive vs authoritative DNS. ✓ Raised TTL awareness.

**Pitfalls:** Restarting services when DNS is the issue. Only checking locally. Forgetting cached bad records persist until TTL expiry.

<a id="s2"></a>

### Scenario 2 — BGP Route Leak (Partial Regional Blackout)

#### Symptom

Traffic from South America drops 80%. Dashboards show regional packet loss. Services and servers are fully healthy. Other regions unaffected.

#### First Diagnostic Moves

```
traceroute yourservice.com
mtr -rwzbc100 yourservice.com
whois <impacted-IP>    # Check AS path
```

**Reasoning:** Service healthy in other regions → not app bug. Latency + drops before reaching your edge → network routing issue. BGP routes may have been incorrectly advertised by an ISP.

#### Root Cause

A small ISP in South America accidentally advertised overly broad BGP prefixes covering Google's ranges. Traffic misrouted through their congested routers → packet loss and high latency.

```bash
whois <impacted-IP>
# Shows unexpected AS path through ISP-X instead of direct Tier-1
```

#### Mitigation

**Immediate:** Traffic steering — reroute SA traffic through a healthy provider using BGP community strings.  
**Long-term:** RPKI (Resource Public Key Infrastructure) validation. BGP monitoring (BGPStream). Multi-provider peering.

#### Senior SRE Signal

✓ Recognizes not all outages are inside your systems. ✓ Mentions BGP visibility + AS path monitoring. ✓ Knows SRE must communicate impact even when root cause is external. **Senior move:** "We'd reroute via BGP community strings."

**Pitfalls:** Treating as a backend bug. Ignoring regional scope. Not knowing BGP basics.

<a id="s3"></a>

### Scenario 3 — TLS Certificate Rotation Issue

#### Symptom

At midnight UTC, error rates spike globally. TLS handshake latency spikes. CPU/memory fine. Customers report SSL\_ERROR\_HANDSHAKE\_FAILURE\_ALERT.

#### First Diagnostic Moves

```bash
openssl s_client -connect service.google.com:443 -showcerts
openssl verify -CAfile ca-bundle.pem new-cert.pem
kubectl logs edge-proxy | grep -i "certificate verify failed"
```

**Reasoning:** App layer fine → not code regression. TLS handshake spike → cert-related. Region-wide simultaneity → cert rotation event.

#### Root Cause

New certificate chain pushed, but intermediate CA bundle wasn't distributed to all edge proxies. 20% of global TLS terminations failed.

#### Mitigation

**Immediate:** Roll back to previous cert bundle.  
**Long-term:** Automated cert renewal via ACME. Canary cert rollout. Continuous cert expiry monitoring. Chaos testing for TLS handshake under rotation.

#### Senior SRE Signal

✓ Calmly treats cert rotation as a predictable, automatable class of incidents. ✓ Mentions automated cert monitoring. **Senior move:** Proposes canary cert rollout + chaos testing.

**Pitfalls:** Blaming app performance. Forgetting intermediate certificates. Not emphasizing automation — manual cert renewal = guaranteed future outage.

<a id="s4"></a>

### Scenario 4 — 2% Packet Loss Under Congestion

#### Symptom

Intermittent slow page loads across North America. ~2% packet loss on east-coast traffic. CPU/memory healthy. p99 spikes but median unchanged.

#### First Diagnostic Moves

```
mtr -rwzbc100 service-edge.google.com
netstat -s | grep retrans
ethtool -S eth0 | grep drop
```

**Reasoning:** 2% packet loss may sound small, but for TCP it explodes tail latency (exponential backoff). App code fine; failures at transport layer. Likely: network congestion + no Active Queue Management.

#### Root Cause

East-coast routers near link saturation during peak. Without AQM (RED/CoDel), queue buffers filled → random drops → TCP retransmissions → inflated p95/p99.

#### Mitigation

**Immediate:** Rate-limit non-critical traffic to free bandwidth.  
**Confirmed fix:** Implement FQ-CoDel on congested interfaces.  
**Strategic:** Capacity upgrade + reroute partial load to central POP.

#### Senior SRE Signal

✓ Knows "2% loss ≠ minor issue" — for TCP, tiny drops crush performance. ✓ Talks about AQM, RED/CoDel, bufferbloat. **Senior move:** Ties to SLO: "Our p99 SLI is directly breached, even though CPU looks fine."

**Pitfalls:** Ignoring small loss rates as "noise." Focusing only on servers. Suggesting only "add bandwidth" without smarter queue management.

<a id="s5"></a>

### Scenario 5 — LB Health Check Misconfiguration (Traffic Blackhole)

#### Symptom

25% of traffic to a tier-1 API returns 502 Bad Gateway. Servers healthy (CPU <50%). LB dashboards show all backends as "Unhealthy."

#### First Diagnostic Moves

```bash
curl -v http://backend-ip:8080/healthz
gcloud compute backend-services get-health my-service
kubectl describe pod <pod> | grep readinessProbe
```

**Reasoning:** ALL backends simultaneously "unhealthy" → unlikely true app failure → health check misconfiguration. Common: wrong endpoint (/healthz vs /readyz), HTTP 200 vs 204 mismatch, TLS mismatch, firewall blocking LB probes.

#### Root Cause

Health check switched from `/healthz` (returns 200) to `/readyz` (returns 503 during startup). Service reported 503 on `/readyz` → LB marked all servers "down" → blackholed requests.

#### Mitigation

**Immediate:** Roll back health check config. Manually override LB to serve from all backends.  
**Long-term:** Separate liveness (process alive) from readiness (ready for traffic) probes. Test health checks in staging before prod.

#### Senior SRE Signal

✓ Awareness that misconfigured control-plane logic causes data-plane outage. ✓ Suggests dual-probe strategy. **Senior move:** "Our SLO was violated not because the service was down, but because the LB *thought* it was."

**Pitfalls:** Treating as server crash. Not checking the actual probe endpoint. Failing to distinguish readiness vs liveness.

<a id="s6"></a>

### Scenario 6 — CDN Cache Invalidation Delay (Broken UX)

#### Symptom

Homepage layout "broken" — buttons misaligned, missing icons, JS errors. Origin has correct files, but CDN edges serve old assets.

#### First Diagnostic Moves

```bash
curl -I https://cdn.example.com/static/app.js
curl -I https://origin.example.com/static/app.js
# Compare Cache-Control, ETag, Last-Modified headers
curl -sI https://cdn.example.com/app.js?v=124 | grep Age
# Shows Age: 86399 → file cached almost 24h
```

#### Root Cause

Frontend deployed new `app.js` but forgot to update cache-busting query string (`?v=124` → `?v=125`). CDN served cached old version for 24h per TTL.

#### Mitigation

**Immediate:** Force CDN purge + update URLs with new version.  
**Long-term:** Content hash in filenames (`app.<SHA>.js`) so caches always bust correctly. Automate in build pipeline. Monitor "edge freshness SLI."

#### Senior SRE Signal

✓ Knows stale assets = availability incident (broken UX). **Senior move:** "Availability SLO covers working features, not just HTTP 200s."

Category 2: Database / Storage (Scenarios 7-11)

<a id="s7"></a>

### Scenario 7 — Database Replica Lag (Stale Reads)

#### Symptom

"I just updated my profile, but I still see the old picture." Replication lag spiking from <500ms to 30s. `replica_lag_seconds` breaching SLO (p95 <1s).

#### First Diagnostic Moves

```sql
SELECT client_addr, replay_lag FROM pg_stat_replication;
psql -c "SELECT now()-pg_last_xact_replay_timestamp() AS delay;"
iostat -x 1 5    # Check disk I/O on replicas
```

#### Root Cause

Analytics job ran large transaction on primary, delaying WAL replay. Replicas fell 30s behind. App read pool included replicas → customers saw stale data.

#### Mitigation

**Immediate:** Route critical reads to primary until lag clears. Cancel analytics job.  
**Long-term:** Read-after-write consistency (sticky sessions / version tokens). Remove lagged replicas from read pool. Semi-sync replication for stricter consistency. Monitor `replica_lag_seconds` as SLI.

#### Senior SRE Signal

✓ Recognizes lag ≠ outage but SLO violation. ✓ Shield users from staleness before digging root cause. ✓ Ties to CAP: in global systems, you often sacrifice consistency for availability. **Senior move:** Suggest multi-primary or read-write partitioning.

**Pitfalls:** Treating replica lag as "harmless." Immediately failing over replica→primary (dangerous if primary is fine). Not distinguishing data loss vs lag.

<a id="s8"></a>

### Scenario 8 — Transaction Deadlocks (Flash Sale)

#### Symptom

Flash sale: API errors spike. Logs: `ERROR: deadlock detected`. Retries succeed after ~5s but p95 breaches checkout SLO (≤2s). Users abandon carts.

#### First Diagnostic Moves

```sql
SELECT pid, wait_event_type, wait_event, state, query
FROM pg_stat_activity WHERE wait_event_type = 'Lock';
```

**Reasoning:** Deadlocks = two transactions hold locks the other needs. Common: different services accessing rows in inconsistent order.

#### Root Cause

Service A updated inventory before orders; Service B updated orders before inventory. During peak load, this inconsistent lock ordering created deadlock cycles. Retry storms amplified latency.

#### Mitigation

**Immediate:** Add jitter + backoff to retries. Avoid retry storms.  
**Short-term:** Standardize transaction ordering: always lock inventory → orders.  
**Long-term:** Shard hot tables. Atomic DB constraints. Optimistic concurrency control (OCC). Monitor deadlock rate as SLI.

#### Senior SRE Signal

✓ Recognizes deadlocks as correctness + reliability failure. ✓ Mentions backoff to protect system. **Senior move:** Design idempotent retries + monitor deadlock rate as SLI.

<a id="s9"></a>

### Scenario 9 — Dropped Index → 10x Latency Regression

#### Symptom

Sudden 10x latency for API calls to `users` table. Query traces show sequential scans over millions of rows. Profile search timeouts.

#### First Diagnostic Moves

```
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM users WHERE email='foo@bar.com';
-- Before: Index Scan using idx_users_email (~50 ms)
-- After:  Seq Scan on users (10M rows, 500 ms+)
```

#### Root Cause

Schema migration removed old btree index on `users.email` assuming it was unused. Profile search still relied on it → full table scan of 10M rows.

#### Mitigation

**Immediate:** `CREATE INDEX CONCURRENTLY idx_users_email ON users(email)`. Cache hottest lookups in Redis until rebuilt.  
**Long-term:** Index change reviews with tooling to detect active queries. Automate query plan regression tests in CI/CD. Monitor query latency histograms as SLIs.

#### Senior SRE Signal

✓ Mitigation-first (cache + rebuild index). ✓ Connects regression to SLOs + observability gaps. **Bonus:** Statistics freshness (ANALYZE) is as important as index presence.

<a id="s10"></a>

### Scenario 10 — Disk Full → DB Refuses Writes

#### Symptom

Write errors: `could not extend file … No space left on device`. New signups fail, transactions 500. Reads still work.

#### First Diagnostic Moves

```bash
df -h /var/lib/postgresql
du -sh /var/lib/postgresql/*
ls -lh /var/lib/postgresql/pg_wal | tail -n 5
# Shows thousands of 16MB WAL files unshipped due to replication lag
```

#### Root Cause

Replication to standby failed (network issues). WAL files accumulated on primary. Volume hit 100% → Postgres refused all writes.

#### Mitigation

**Immediate:** Archive/move old WAL files. Re-enable archiving to cloud storage.  
**Long-term:** Monitor WAL growth + disk SLOs (alert at 70%, critical at 85%). Separate WAL, data, logs on different volumes. Auto-vacuum + cleanup jobs.

#### Senior SRE Signal

Juniors stop at "add more disk." Seniors mention WAL accumulation due to replication failure and frame it: "Our write-availability SLO was violated. We need leading indicators."

<a id="s11"></a>

### Scenario 11 — Cache Stampede on Hot Key

#### Symptom

DB CPU at 95%, cache hit ratio plummets from 95% to 40%. Single hot key (`/product/black-friday-deals`) expired. Thousands of clients hammer DB simultaneously.

#### First Diagnostic Moves

```bash
redis-cli monitor | grep "MISS" | head -5
# Massive spike in misses for the hot key
```

#### Root Cause

Hot endpoint cached with 5-min TTL. At 12:00 sharp, entry expired. With no jitter/backfill, 20K req/s hit the DB simultaneously.

#### Mitigation

**Immediate:** Prewarm cache (manual SET).  
**Short-term:** Request coalescing (only 1 request populates; others wait).  
**Long-term:** Randomized TTL jitter. Stale-while-revalidate pattern. Monitor hot-key access + adaptive caching.

#### Senior SRE Signal

Juniors stop at "increase TTL." Seniors: "Our availability SLO was broken because cache invalidation created a predictable herd effect." Mentions coalescing + edge cache offload.

Category 3: Application / Config (Scenarios 12-16)

<a id="s12"></a>

### Scenario 12 — CrashLoopBackOff (Bad Image Rollout)

#### Symptom

40% of pods in CrashLoopBackOff. HTTP 503s. Logs: `Segmentation fault` at startup.

#### First Diagnostic Moves

```bash
kubectl describe pod <name>
kubectl logs <name> --previous | head -10
# Segmentation fault: missing libssl.so
```

#### Root Cause

New build missing shared library (`libssl.so`). Canary skipped due to manual override → 40% pods failed simultaneously.

#### Mitigation

**Immediate:** Rollback to previous image.  
**Long-term:** Enforce canary + automated health gates. CI/CD scans for missing shared libs. Pre-flight readiness validation in staging.

#### Senior SRE Signal

Juniors fix the library. Strong: highlight deployment safety nets. **Senior:** "The system *allowed* an invalid image to roll out — this is a release-engineering reliability failure."

<a id="s13"></a>

### Scenario 13 — Feature Flag Misfire (Broken Checkout)

#### Symptom

Users report "blank checkout page." Error rates climb in one region. No code changes — only a feature flag rollout minutes earlier.

#### Root Cause

Checkout flag rolled out to 100% of users in us-east1, but required backend (`/payments/v2`) not yet deployed in that region. Frontend called non-existent API → blank page.

#### Mitigation

**Immediate:** Roll back flag to 0%.  
**Long-term:** Progressive rollout gates (max 5% until metrics stable). Flag dependency validation (can't enable checkout unless payment v2 flag also on). Monitor flag rollout as SLO-governed event.

#### Senior SRE Signal

Juniors: "turn flag off." Strong: progressive rollout + dependency awareness. **Senior:** "Feature flags are part of the release reliability surface — config changes are code and need SLO-driven safety nets."

<a id="s14"></a>

### Scenario 14 — Thread Leak → Service Freeze

#### Symptom

p95 latency spikes from 200ms to 15s. CPU oddly flat at ~20%. Requests pile up but don't complete. Service alive but frozen. Thread count climbing until system limit.

#### First Diagnostic Moves

```bash
jstack <pid> | grep -c "RUNNABLE"
# Stack trace:
"http-nio-8080-exec-2345" #2345 RUNNABLE
  at com.payments.Client.post(Client.java:42)
  - waiting on socket read (no timeout)
```

#### Root Cause

New payment handler had a blocking call to external API **without timeout**. Each stuck request held a thread. At 10 req/s, leaked 10 threads/sec. Hit 6,000 (system max) in 10 minutes → all new requests stall.

#### Mitigation

**Immediate:** Restart service (frees threads).  
**Long-term:** Timeouts + circuit breakers on ALL network calls. Fixed-size thread pools. Runtime alerts on `threads_live`. Chaos-test with injected API latency.

#### Senior SRE Signal

✓ Recognizes "frozen ≠ crashed" — resource exhaustion, not a crash. **Senior:** "Thread leaks erode error budget gradually until total outage. We need defense-in-depth monitoring."

<a id="s15"></a>

### Scenario 15 — Rate Limit Misapplied (Throttling Legit Users)

#### Symptom

Flood of 429 Too Many Requests. Traffic volume normal (no surge). 40% of requests rejected.

#### Root Cause

Config push set **global** limit of 1,000 RPS at API Gateway instead of **per-user** 1,000 RPS. System receives 10K RPS aggregate → 90% of legit requests throttled.

```
{"rate_limit_scope": "global", "limit_rps": 1000}   // WRONG
{"rate_limit_scope": "per_user", "limit_rps": 1000}  // INTENDED
```

#### Mitigation

**Immediate:** Roll back Gateway config.  
**Long-term:** Config validation (global caps ≥ 10x per-user). Canary for configs. Rate-limit rejection SLI (% traffic dropped).

#### Senior SRE Signal

**Senior:** "Control-plane configs can take down the entire data plane. Configs must be validated, rolled out via canary, and observable."

<a id="s16"></a>

### Scenario 16 — Canary Rollback Delay

#### Symptom

Canary v2.3 of payment API rolled out to 5% traffic. 30% of checkout requests fail with 500. Rollback command issued but takes 20+ minutes. Thousands of failed transactions.

#### Root Cause

Default K8s config `maxUnavailable=1 / maxSurge=1` treated rollback as gradual deployment. Pods terminated one at a time serially instead of draining all canary pods quickly.

```bash
# BAD:
maxUnavailable: 1, maxSurge: 1
# GOOD for canary rollback:
maxUnavailable: 100%, maxSurge: 0
```

#### Mitigation

**Immediate:** `kubectl scale deployment canary --replicas=0`.  
**Long-term:** Auto-scale canary to zero on SLO breach. Enforce rollback SLO (≤2 min). Synthetic canary monitoring.

#### Senior SRE Signal

**Senior:** "Rollback speed itself is an SLO for release reliability." Talks about automated kill-switches for bad canaries.

Category 4: OS / Kernel / Infra (Scenarios 17-21)

<a id="s17"></a>

### Scenario 17 — Memory Leak → OOM Kills

#### Symptom

Search-indexer pods restart every few minutes. Memory climbing steadily to 100%. Linux OOM killer terminates processes.

#### First Diagnostic Moves

```bash
dmesg | grep -i oom
kubectl top pods --namespace=search
go tool pprof http://pod:6060/debug/pprof/heap

# Heap profile:
pprof> top
3.07GB 3.07GB 80% .../search/cache.go:45
```

#### Root Cause

In-memory cache for query results with no TTL/eviction. Under traffic, cache grew unbounded. Hit 4GB limit in 30 min → OOM killed.

#### Mitigation

**Immediate:** Disable cache feature flag. Add HPA to absorb traffic.  
**Long-term:** LRU eviction + TTL. Heap monitoring dashboards. New cache features must pass load-test + leak-test.

#### Senior SRE Signal

Juniors: "Add more memory." Strong: "pprof the leak." **Senior:** "Every OOM is user-visible availability hit. Enforce memory SLIs. New cache features must pass leak-test before rollout."

<a id="s18"></a>

### Scenario 18 — CPU Throttling (CFS Quotas)

#### Symptom

p95 latency doubles from 100ms→200ms. CPU usage looks low (~50%). But pods report `cfs_quota_exceeded` events.

#### First Diagnostic Moves

```bash
cat /sys/fs/cgroup/cpu/cpu.stat
nr_periods 2450
nr_throttled 1200      # 50% of periods throttled!
throttled_time 45234567890
```

#### Root Cause

Pod configured with `cpu.request = 2`, `cpu.limit = 2`. Bursts required ~3.5 cores. No headroom → kernel throttled repeatedly → p95 latency SLO breached.

#### Mitigation

**Immediate:** Raise `cpu.limit` to 4 (keep request at 2 for burst headroom).  
**Long-term:** Profile workload for burstiness. SLO-based autoscaling triggered by p95 latency, not CPU utilization.

#### Senior SRE Signal

Juniors: "Increase CPU limits." Strong: "Recognize throttling ≠ saturation." **Senior:** "Quota settings must align with latency budgets. Limits higher than requests for burst tolerance."

**Pitfalls:** Misinterpreting "50% CPU" as "plenty of headroom" without checking throttling stats. Setting limit = request = no burst tolerance.

<a id="s19"></a>

### Scenario 19 — I/O Saturation → Degraded DB Writes

#### Symptom

INSERT latency spikes 5ms→120ms. Checkout timeouts. CPU/memory normal. Disk: >95% utilization, high queue depth.

#### First Diagnostic Moves

```
iostat -x 1 3
Device:  r/s    w/s    await   %util
nvme0n1  5.2  1200   118.5   99.9    # Fully saturated!
```

#### Root Cause

New audit logging feature doubled write throughput. Storage provisioned at 3K IOPS baseline; burst credits exhausted after 20 min. Disk pegged at 100%.

#### Mitigation

**Immediate:** Redirect audit logs to separate storage.  
**Long-term:** Async audit pipeline (Kafka → BigQuery). Separate OLTP from heavy writes. Monitor disk latency SLIs.

#### Senior SRE Signal

Juniors: "Increase disk IOPS." Strong: "Identify audit logging as root cause." **Senior:** "Frame durability vs performance trade-offs — relaxing fsync for non-critical logs vs strict ACID for payments."

<a id="s20"></a>

### Scenario 20 — Kernel Panic → Mass Node Churn

#### Symptom

30% of nodes in us-east1-b simultaneously rebooted. Pods rescheduled en masse. Availability dips. Latency +300ms.

#### First Diagnostic Moves

```bash
dmesg excerpt:
[12345.6789] BUG: unable to handle kernel NULL pointer dereference
[12345.6789] IP: tcp_v4_conntrack+0x3a2/0x470
[12345.6789] Kernel panic - not syncing: Fatal exception
```

#### Root Cause

Automated security patch upgraded kernel. Bug in networking stack caused panic when handling large conntrack tables at peak traffic. AZ-scoped rollout → all nodes in that zone ran buggy kernel simultaneously.

#### Mitigation

**Immediate:** Drain traffic from failing AZ. Multi-AZ failover.  
**Long-term:** Stagger kernel rollouts by zone (never 100% at once). Canary nodes. Chaos simulation for conntrack saturation before approving patches.

#### Senior SRE Signal

Juniors: "Restart nodes." Strong: "Drain AZ, rollback patch." **Senior:** "Safe automation: staged rollouts, canary nodes, feature flags for infra configs. Cross-zone redundancy absorbs single-AZ churn."

<a id="s21"></a>

### Scenario 21 — File Descriptor Exhaustion

#### Symptom

Sporadic 500 errors. Logs: `accept4: Too many open files`. Connection attempts spike. Error rate >5%.

#### First Diagnostic Moves

```
ulimit -n                        # Max FDs per process
lsof -p <pid> | wc -l           # Shows 102,500 FDs open
ss -s                            # Thousands of ESTABLISHED gRPC connections
```

#### Root Cause

gRPC client library bug: idle connections not closed. Thousands of sockets in ESTABLISHED state. Each server consumed ~100K FDs, hitting cap (102,400). Can't accept new connections.

#### Mitigation

**Immediate:** Increase ulimit + restart to free stuck connections.  
**Long-term:** Monitor `fd_usage / fd_limit` ratio as SLI. Connection pooling with idle timeout. Patch gRPC library. Chaos testing for FD exhaustion.

#### Senior SRE Signal

Juniors: "Just increase ulimit." Strong: "Find the leak, fix library." **Senior:** "Frame FD usage as availability SLI. Infra scaling (FD limits) + app hygiene (timeouts, reuse)."
