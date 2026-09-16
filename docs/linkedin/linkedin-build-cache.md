---
title: "Build Artifact Cache"
slug: /linkedin/linkedin-build-cache
sidebar_position: 4
sidebar_label: "Build Artifact Cache"
description: "Build Artifact Cache"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/linkedin-build-cache/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

CI/CD Reliability Design — Content-Addressable Deduplication

A mission-critical build cache for LinkedIn's distributed CI/CD pipeline: 100ms p95 retrieval, 90% hit rate, content-addressable storage with lease-based eviction and global consistency convergence under 60 seconds.

CI/CD Critical

Content Addressable

Global Consistency

[Home](/) [Design Framework](/docs/foundations/sre-design-framework) [SRE Systems](/docs/sre/sre-sysdesign) [Disaster Recovery](/docs/linkedin/linkedin-disaster-recovery)

## Page 1 — System Overview & CI/CD Reliability Philosophy

### What This System Is

A **"Mission-Critical Build Artifact Cache"** for LinkedIn's distributed CI/CD pipeline that eliminates redundant rebuilds by caching previously compiled artifacts (binaries, Docker images, test results) and making them instantly retrievable across regions. The system ensures cache consistency, intelligent eviction policy, and high reliability under massive parallel builds.

#### Build Cache Service Level Objectives (SLOs)

| Objective | Target | Measurement |
| --- | --- | --- |
| Artifact Retrieval Latency | p95 ≤ 100ms | End-to-end fetch from regional cache |
| Cache Hit Rate | ≥ 90% | Key indicator of reuse efficiency |
| Availability | ≥ 99.99% | Service should never block CI pipelines |
| Stale Artifact Probability | ≤ 0.1% | Build determinism must be preserved |
| Global Consistency Convergence | ≤ 60s | Sync window for new artifacts |
| Corruption Rate | < 0.01% | Silent data corruption detection |

### CI/CD Reliability Philosophy: Cache as Infrastructure

#### Core Build Cache Principles

-   **Content-Addressable Storage (CAS)** — Each artifact identified by SHA-256 hash for integrity
-   **Two-Tier Cache Pattern** — SSD-based L1 hot cache + Object storage L2 cold retrieval
-   **Lease-Based Eviction** — Prevents artifact removal while active builds reference it
-   **Async Replication + Bloom Filters** — Avoids rebuilds during global sync lag
-   **Checksum Validation Pipeline** — CRC + periodic audit to detect bit-rot
-   **Read-Your-Writes Consistency** — Guarantee within region, eventual global consistency

### Six Core Components

1.  **Artifact Ingestion API** — Receives newly built artifacts + metadata hash
2.  **Hash Index Service** — Deduplicates artifacts by content hash (SHA-256)
3.  **Storage Layer** — Regional object stores (Ambry buckets with CAS addressing)
4.  **Cache Layer** — Tier-1 hot SSD nodes, Tier-2 cold archive
5.  **Replication Agent** — Syncs indexes + metadata across regions
6.  **CI Client SDK** — Queries hash before build, fetches if available

### LinkedIn Build Artifact Types

#### Artifact Categories by Size & Frequency

| Artifact Type | Size Range | Build Frequency | Cache Strategy |
| --- | --- | --- | --- |
| **Java JARs** | 50MB - 500MB | Very High | Hot SSD cache, global replication |
| **Docker Images** | 500MB - 2GB | High | Layer-based deduplication + cold storage |
| **Test Results** | 1MB - 100MB | Very High | Hot cache, 7-day retention |
| **Node.js Modules** | 100MB - 1GB | Medium | Package-level deduplication |
| **Native Binaries** | 10MB - 200MB | Low | Cold storage, on-demand retrieval |
| **ML Models** | 100MB - 10GB | Low | Cold archive, checksum validation |

#### Reliability Stressors (What Can Break)

#### Critical Failure Modes

-   **Stale/Wrong Artifacts:** Bad hash computation → non-deterministic builds
-   **Eviction Race Condition:** Artifact evicted mid-use → pipeline failure
-   **Replication Lag:** Artifacts missing in remote region → rebuild storm
-   **Checksum Drift:** Silent corruption in storage tier
-   **Cache Pollution:** Temporary build artifacts flooding storage
-   **Hot Shard Overload:** Popular artifacts causing cache hotspots

## Page 2 — Architecture & LinkedIn Integration

### Detailed LinkedIn Build Cache Architecture — Production Implementation

![LinkedIn Build Cache 5-Phase Process](/images/build-cache-phases.png)

5-Phase Build Process: Code → Git → Hash Check → Build/Upload → CAS Integration

### 🏗️ LinkedIn Build Artifact Cache

Content-Addressable Distributed Caching Architecture

✅ NORMAL BUILD FLOW — Cache Hit Scenario

👨‍💻 DEVELOPER

**Action:** git push  
**Trigger:** Jenkins pipeline  
**Build:** Gradle/Maven/Buck  
**Target:** JAR, Docker, Tests

→

🔍 HASH COMPUTE

**Input Hash:**  
`sha256(src+deps)`  
**Cache Key:**  
`abc123def456`

→

💾 CACHE QUERY

**L1 SSD:** ✅ HIT 45ms  
**Protocol:** HTTP/gRPC  
**Size:** 127MB JAR  
**Verification:** SHA-256

→

⚡ SKIP BUILD

**Result:** Artifact retrieved  
**Time Saved:** 8m 32s  
**Status:** Build SUCCESS  
**Next:** Deploy/Test

**💨 Retrieval Time**  
45ms (P95)

**🎯 Hit Rate**  
92.3%

**💰 Cost Savings**  
87% CPU reduction

**🔒 Integrity**  
0.001% corruption

🔧 CACHE MISS FLOW — Build & Store Scenario

⏱️ Miss Detection & Build Pipeline

**T+0s**  
Hash computed  
`abcd5678ef`

→

**T+50ms**  
L1 + L2 MISS  
`404 Not Found`

→

**T+100ms**  
Acquire build lease  
`lease-id-9912`

→

**T+9m**  
Build completes  
`artifact.jar`

→

**T+9m 30s**  
STORED & INDEXED  
`ready for reuse`

🔒 Lease-Based Build Coordination

**FIRST BUILDER**  
Jenkins-Build-47291  
LEASE HOLDER  
Status: Building JAR  
TTL: 15 minutes

**SECOND BUILDER**  
Jenkins-Build-47292  
WAITING  
Status: Polling for result  
Poll interval: 5s

**THIRD BUILDER**  
Jenkins-Build-47293  
WAITING  
Status: Polling for result  
Poll interval: 5s

💡 RESULT: Only 1 build executes, 2 builders wait and reuse the artifact (deduplication)

🏗️ MULTI-TIER STORAGE ARCHITECTURE — Hot/Warm/Cold

⚡ L1 HOT SSD CACHE

**Capacity:** 2TB NVMe per node  
**Retention:** 7 days LRU + leases  
**Access Time:** 15-50ms P95  
**Hit Rate:** 78% (recent builds)

**Protocol:** gRPC/HTTP  
**Replication:** Local only  
**Consistency:** Read-your-writes

🔥 L2 AMBRY STORE

**Capacity:** 500TB per DC  
**Retention:** 30 days + ref counting  
**Access Time:** 200-800ms P95  
**Hit Rate:** 14% (older builds)

**Protocol:** HTTP REST  
**Replication:** 3x within DC  
**Consistency:** Eventually consistent

❄️ L3 ARCHIVE (HDFS)

**Capacity:** Unlimited (compressed)  
**Retention:** 1 year (compliance)  
**Access Time:** 5-30s (rare)  
**Hit Rate:** 0.1% (forensics)

**Protocol:** HDFS / S3  
**Replication:** 3x cross-DC  
**Consistency:** Strong

📈 Cache Promotion & Eviction Flow

**Build Completes**  
New artifact (127MB)  
`sha256:abc123`

→

**Store in L2**  
Ambry replication  
`3x copies`

→

**Index Update**  
Bloom filter + hash map  
`Global index`

→

**Promote to L1**  
If requested again  
`Access-based`

🌍 GLOBAL CONSISTENCY & REPLICATION

🌟 LTX1 (PRIMARY)

**Role:** Primary build region  
**Cache Size:** 50TB hot + 500TB warm  
**Build Load:** 15,000 builds/day  
**Hit Rate:** 94.2%

**Status:** ACTIVE  
**Replication:** Source for all  
**Consistency:** Read-your-writes

🔥 LVA1 (SECONDARY)

**Role:** Failover + EU builds  
**Cache Size:** 30TB hot + 300TB warm  
**Build Load:** 8,000 builds/day  
**Hit Rate:** 89.1%

**Status:** ACTIVE  
**Replication:** 45s lag from LTX1  
**Consistency:** Eventually consistent

🧪 EI4 (DEV/TEST)

**Role:** Development builds  
**Cache Size:** 10TB hot + 100TB warm  
**Build Load:** 5,000 builds/day  
**Hit Rate:** 82.7%

**Status:** ACTIVE  
**Replication:** Subset of prod  
**Consistency:** Best effort

**🔧 Content Addressing:**  
• Hash algorithm: SHA-256  
• Deduplication: Content-based  
• Integrity: CRC32 + periodic audit  
• Addressing: \`/cache/sha256/ab/cd/abcd1234...\`  
• Metadata: Size, build time, refs, lease TTL  
• Bloom filters: False positive < 0.1%

**📊 Performance Metrics:**  
• L1 cache hit rate: 78%  
• L2 cache hit rate: 14%  
• Overall hit rate: 92%  
• P95 retrieval latency: 95ms  
• Build time reduction: 87%  
• Cost reduction: $2.1M/year

**🛡️ Reliability Features:**  
• Lease-based coordination  
• Multi-tier fallback  
• Cross-region replication  
• Checksum validation  
• Graceful degradation  
• Monitoring & alerting

### Content-Addressable Storage (CAS) Implementation

#### SHA-256 Hash-Based Addressing

**Integrity by Design:** Every artifact addressable by its content hash for deterministic builds and automatic deduplication across the LinkedIn development ecosystem.

### Artifactory Integration & Cache Layer

![LinkedIn Build Cache Artifactory Integration Flow](/images/build-cache-artifactory-flow.png)

Build Artifact Cache Integration with Artifactory — CAS vs Final Artifacts

🏛️ ARTIFACTORY INTEGRATION — Cache Layer on Top

🔨 BUILD TOOLS

**Gradle:** Cache plugin  
**Maven:** Extension  
**Docker:** BuildKit integration  
**Bazel:** Remote cache

⚡ LINKEDIN CACHE

**L1:** SSD hot cache  
**L2:** Ambry warm store  
**Features:** Dedup, leases  
**Latency:** 45ms P95

📦 ARTIFACTORY

**Role:** Source of truth  
**Storage:** All published artifacts  
**Access:** REST API  
**Latency:** 500-2000ms

🌐 EXTERNAL REPOS

**Maven Central:** OSS deps  
**Docker Hub:** Base images  
**NPM Registry:** JS packages  
**Via:** Artifactory proxy

🔍 Cache Miss Flow — Fallback to Artifactory

**Build Tool Query**  
`sha256:abc123`  
LinkedIn Cache API

→

**Cache Miss**  
L1 + L2 = 404  
Fallback triggered

→

**Query Artifactory**  
REST API call  
`/repo/path/artifact`

→

**Populate Cache**  
Store in L1 + L2  
Return to build

→

**Future Hits**  
45ms retrieval  
No Artifactory load

#### Hot SSD + Cold Object Storage Pattern

**Two-Tier Architecture:** LinkedIn Cache operates as a high-performance layer above Artifactory, with L1 SSD for hot artifacts (sub-100ms) and L2 Ambry for comprehensive storage, while Artifactory serves as the authoritative source for published artifacts and proxy to external repositories.

## Page 3 — Reliability Patterns & Operations

![LinkedIn Build Cache Four Key Mechanisms](/images/build-cache-mechanisms.png)

Four Key Cache Mechanisms: Hit/Miss Paths, Two-Tier Promotion, Lease-Based Protection

### Lease-Based Eviction Prevention

#### Active Build Protection

**Lease-Based Coordination:** Prevents artifacts from being evicted while builds are actively using them through a distributed lease system that tracks active references and TTL-based cleanup to avoid eviction races during parallel builds.

### Distributed Lease Management System

🔐 MANDATORY LEASE REGISTRATION — No Artifact Access Without Lease

⚡ Lease Acquisition Flow (Every App Must Follow)

**CI Job Starts**  
Requests artifact  
`sha256:abc123`

→

**❌ BLOCKED**  
No lease = no access  
`LeaseRequired`

→

**Acquire Lease**  
`acquireLease()`  
TTL: 2-4 hours

→

**✅ GRANTED**  
Download allowed  
Safe to use

→

**Auto Release**  
Build completes  
Lease cleanup

📋 LEASE REGISTRY STRUCTURE — Real-Time Usage Tracking

📊 Live Registry Entry Example

**Artifact:** sha256:abc123def456...  
**Active Leases:** 3 consumers  
  
├── LEASE-001: jenkins-build-47291 (CI\_BUILD)  
│ ├── Acquired: 16:30:00 | Expires: 20:30:00  
│ ├── Stage: COMPILATION | Heartbeat: 2s ago  
│  
├── LEASE-002: k8s-prod-api-deployment (DEPLOYMENT)  
│ ├── Acquired: 16:25:00 | Expires: 16:25:00+24h  
│ ├── Stage: RUNTIME | Heartbeat: 5s ago  
│  
└── LEASE-003: integration-test-suite (TESTING)  
├── Acquired: 16:35:00 | Expires: 18:35:00  
├── Stage: TEST\_EXECUTION | Heartbeat: 1s ago  
  
**🛡️ EVICTION\_BLOCKED: true (3 active users)**

**🏗️ CI/CD Builds**  
Jenkins, Tekton  
2-4h TTL

**🚀 Deployments**  
Kubernetes, Docker  
24-48h TTL

**🧪 Testing**  
Integration, E2E  
1-2h TTL

**💻 Development**  
Local builds, staging  
8h TTL

💓 HEARTBEAT & UPDATE SYSTEM — Real-Time Lease Maintenance

🔄 Automatic Heartbeat Updates (Every 30 seconds)

**CI Job Running**  
Build in progress  
Progress: 45%

→

**SDK Heartbeat**  
`renewLease()`  
Every 30s

→

**Registry Update**  
`expires_at += TTL`  
`last_heartbeat = NOW()`

→

**Lease Extended**  
Artifact protected  
No eviction risk

🌍 Cross-Region Lease Synchronization

**LTX1 (PRIMARY)**  
Redis Cluster  
WRITE OPS  
Local leases: 15,847  
Update lag: < 10ms

**KAFKA SYNC**  
Topic: lease-updates  
CROSS-REGION  
Throughput: 2.3K msg/s  
Sync lag: < 60s

**LVA1 (REPLICA)**  
Redis Cluster  
READ + SYNC  
Synced leases: 15,834  
Consistency: 99.92%

🛡️ SAFETY MECHANISMS — Preventing Eviction Disasters

💔 HEARTBEAT FAILURE

**Causes:** Network partition, job crash, node failure  
**Behavior:** Lease expires automatically after TTL  
**Safety:** Conservative 24-48h grace period  
**Recovery:** New job acquires fresh lease

🚨 REGISTRY FAILURE

**Fallback:** Backup Espresso-based store  
**Safety:** Disable ALL evictions  
**Alert:** Page on-call immediately  
**Recovery:** Rebuild from job telemetry

🧠 SPLIT-BRAIN PREVENTION

**Scenario:** Region connectivity lost  
**Behavior:** Each region maintains local leases  
**Safety:** Never evict if ANY region has lease  
**Recovery:** Reconcile when connectivity restored

🎯 CONSERVATIVE POLICY: "Better to cache too long than evict too early" — LinkedIn's #1 Build Cache Rule

### Cross-Region Replication with Bloom Filters

#### Intelligent Replication Strategy

**Cross-Region Async Replication:** Bloom filter optimization prevents unnecessary replication queries while maintaining eventual consistency across LinkedIn's global build infrastructure with automatic conflict resolution and consistency validation.

### Checksum Validation & Corruption Detection

### Checksum Validation & Corruption Detection

#### Data Integrity Protection

**Multi-Layer Validation:** Comprehensive SHA-256 + CRC32 validation pipeline with periodic background integrity audits, corruption detection, and automatic healing to ensure artifact consistency across LinkedIn's distributed build cache infrastructure.

### Cache Hit Rate Optimization

#### Intelligent Cache Management

**Automated Optimization:** Continuous monitoring and adaptive cache sizing based on hit rate analysis, miss pattern detection, and predictive artifact popularity to maintain 90%+ hit rates across LinkedIn's build infrastructure.

##### ✅ System Benefits

-   100ms p95 retrieval with two-tier caching
-   90%+ hit rate with intelligent deduplication
-   Content-addressable integrity guarantees
-   Lease-based eviction prevents build failures
-   Async replication with Bloom filter optimization
-   Comprehensive corruption detection and recovery

##### ⚠️ System Limitations

-   60s global consistency may affect fresh builds
-   Hot SSD cache requires significant storage investment
-   Complex lease management adds operational overhead
-   Large artifacts (>10GB) challenge cache efficiency
-   Cross-region replication bandwidth costs
-   Hash computation overhead for large artifacts
