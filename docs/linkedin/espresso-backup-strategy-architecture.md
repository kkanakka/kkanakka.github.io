---
title: "Espresso: Backup & Recovery"
slug: /linkedin/espresso-backup-strategy-architecture
sidebar_position: 11
sidebar_label: "Espresso: Backup & Recovery"
description: "Espresso: Backup & Recovery"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/espresso-backup-strategy-architecture/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

Helix-partitioned MySQL, Kafka/Xinfra replication, GPFS/XtraBackup pipelines, snapshot service, and recovery tradeoffs — styled like the Venice architecture deep-dive, grounded in `espresso-storage-node` `BackupTask`, infra specs, and production incidents.

WIP · Internal engineering reference

[Venice architecture page →](/docs/linkedin) [Nimbus oncall helper (repo)](https://github.com/linkedin-multiproduct/nimbus-oncall-helper/blob/master/docs/architecture.md)

Overview Design Write path Read path Kafka & topics Backup & restore RPO / RTO Incidents Tombstones & deletes

Overview

## What Espresso is

Espresso is LinkedIn’s distributed document store: **Database → Table → Document**, Avro payloads in MySQL/InnoDB, Apache Helix for partition placement and leader election, D2 for routing, and asynchronous replication within and across fabrics via binlog-derived events published to Kafka or Xinfra.

**Primary reliability story** Multi-replica quorum-style operations plus continuous replication—not nightly backup alone. Scheduled **XtraBackup** streams to **GPFS** (with an **Ambry**\-backed direction in design docs) feed bootstrap, rebalance, snapshot service, LDR/splitter workflows, and disaster recovery runbooks.

### Diagram — logical components

flowchart LR subgraph clients\["Clients"\] API\["Services / Euler / clients"\] end subgraph edge\["Routing"\] R\["espresso-router"\] end subgraph sn\["Storage"\] L\["Leader SN"\] F\["Follower SNs"\] end subgraph mysql\["Engine"\] M\[("MySQL InnoDB")\] end subgraph pipe\["Change pipeline"\] BT\["Binlog translator"\] K\[("Kafka / Xinfra")\] DR\["espresso-data-replicator"\] end subgraph bk\["Backup tier"\] GPFS\[("GPFS / Ambry design")\] SS\["snapshot-service"\] end API --> R --> L L --> M L --> F M --> BT --> K K --> F K --> DR L --> GPFS GPFS --> SS

Design

## Architecture anchors

-   **Partitioning:** Each DB is a Helix resource; partitions map to storage nodes; leader serves strongly consistent writes and can serve leader reads.
-   **Consistency:** Strong on leader reads within a partition; followers and remote fabrics are eventually consistent with typical cross-colo lag 50–500ms (specs).
-   **Checksums / CCDV:** Periodic checksums and cross-colo validation detect divergence; SCN identifies change positions.
-   **Snapshot SLA:** Snapshot service targets fresh DBImage/checksum/Lumos artifacts; normal snapshot cycle SLA is **7 days** (operations docs).

### Code anchor — Helix backup task

The storage node implements `com.linkedin.espresso.storagenode.backuprestore.backup.BackupTask` as a **Helix task** that drives Percona XtraBackup via pluggable `BackupRestorable`, streams through `StreamingHelper`/`BackupArchiverV2`, and resolves destinations with `BackupFileURIHandlerV2` (GPFS today; Ambry URIs in migration design).

Write path

## End-to-end write

1.  Client issues PUT/POST; **router** maps key → partition → leader storage node (via Helix view).
2.  Leader executes SQL; InnoDB commits; response to client after local commit (followers are async).
3.  **Binlog** record is produced; `EspressoEventBinlogTranslator` builds events; `EspressoEventKafkaProducer` / Xinfra producer publishes.
4.  Followers and remote consumers apply via replication applier components—catch-up is bounded by broker retention and consumer health.

sequenceDiagram participant C as Client participant R as Router participant L as Leader SN participant My as MySQL participant K as Kafka/Xinfra participant F as Follower SN C->>R: Write(key, doc) R->>L: Routed write L->>My: INSERT/UPDATE commit My-->>L: OK L-->>C: 200 OK My-->>K: binlog → event K->>F: consume & apply

Read path

## Reads & routing

-   **Leader read:** Lowest staleness; use when the product requires read-your-writes or linearizable partition semantics.
-   **Follower read:** Lower load on leader; may lag replication; good for tolerate-stale use cases.
-   **Router + D2:** Misconfiguration (e.g., stale Couchbase disco after migrations) can blackhole a fabric—see incident-5398 class failures.
-   **Index / search paths:** Lucene secondary paths add latency; not covered in depth here.

Kafka & topics

## Topics & retention

Per-partition events are published to Kafka/Xinfra topics (naming typically includes database/partition context). **Typical config from specs:** `binlogRetentionDays=7`, `kafkaRetentionWindow=7` days.

**Retention gap risk** If you must replay farther back than retained logs, you cannot reconstruct incremental state from Kafka alone—you need a **backup baseline** plus bounded replay, or a **source-of-truth** rebuild (offline pipelines). Incident narratives referencing “10-day Kafka retention” alongside stale backups highlight this coupling.

**Cross-fabric:** `espresso-data-replicator` mirrors topics between fabrics; ordering, schema compatibility (USR), and Brooklin consumers must stay aligned—several incidents involved schema registration and backward compatibility.

Backup & recovery

## Backup options (current)

| Layer | Mechanism | Purpose |
| --- | --- | --- |
| Replication | Kafka/Xinfra + appliers | HA, DR, catch-up after restore |
| Partition backup | Helix `BackupTask`, XtraBackup stream | Point-in-time-ish baseline per partition on GPFS (Ambry in migration) |
| Metadata | ZK SCN / backup bookkeeping | Restore positioning, verification |
| Undo | Limited undo binlog (config) | Small SCN windows—not general PITR |
| Snapshot service | Workers restore backup → Avro artifacts | ETL, Brooklin bootstrap, Grid, checksum/Lumos |
| Cross-fabric DR | DisasterRestorer / rsync runbooks | Copy known-good backups between fabrics |

### Restore flow (simplified)

1.  Fetch backup blob from GPFS/Ambry (throttled).
2.  Decompress/import into MySQL on target.
3.  Start replication consumer from recorded SCN / generation.
4.  Bring partition ONLINE in Helix once caught up.

Ops entry points: `esretool backup list`, `esretool backup take`, `esretool snapshots coordinator_status`; stale backups > ~7 days break expectations for offline→slave transitions and snapshot SLAs (internal ITR docs).

RPO / RTO

## Scenarios (order-of-magnitude)

Numbers are **indicative**; each database has customer SLOs—use Espresso SRE runbooks for authoritative targets.

| Scenario | RPO | RTO | Notes |
| --- | --- | --- | --- |
| Replication healthy / router failover | Seconds–minutes lag | Minutes | Spec-style DR: <1 min RPO, <5 min RTO for route-level failover—not universal for all paths |
| Replica bootstrap from peer + log catch-up | Since peer snapshot | Minutes–hours | Depends on drift and load |
| GPFS backup restore + Kafka catch-up | Backup timestamp | Hours+ | Throttle + partition size |
| Snapshot SLA miss only | Stale ETL | Hours–days | Until backups + workers recover |
| Logical mass delete (bug, tool) | Data lost to delete window | Days+ | Snapshot restore + Flink/Kafka replay; product coordination |
| Retention exceeded / binlog gap | Unbounded | Days–weeks | Rebuild from external SOT or cold artifacts |

### Is the existing backup process “good enough”?

For **routine** replica loss, yes—the combination of peers + logs + GPFS baselines is industry-standard. For **infrastructure** faults that stall GPFS, snapshot workers, HDFS, or tokens, incident history shows **multi-day** recovery times until infra mitigations land—so the weakness is operational coupling to GPFS/HDFS health and automation gaps (KSudo, IPv6 registration, TC), not a missing single code flag.

### Venice-style P2P here?

Venice’s P2P is optimized **RocksDB file** transfer between servers. Espresso’s analog is **Helix-managed partition recovery** and **catch-up from Kafka**, not the same blob protocol. Shipping a “turn on P2P” feature would be a **major product effort** (peer seeding at scale, security, fairness)—feasible in principle but not equivalent to Venice’s mechanism.

Incidents

## Past incidents — cause & duration (summary)

Ten-line style summaries you provided, consolidated into a scannable table. Severity and times come from your notes; treat as narrative aids, not an official Observe export.

| ID | Theme | Duration (approx) |
| --- | --- | --- |
| 10819 | GDPR purger bug — mass delete; snapshot + replay | Ongoing |
| 8108 | GPFS snapshot perf regression | ~2.5d |
| 7594 | Traffic Control bottleneck | ~2.9d |
| 7212 | Hung GPFS mounts / rebuild storms | ~2.9d |
| 3694 | WAGED scan / quotas | ~2.2d |
| 4791 | Brooklin OOM | ~28h |
| 8012 | Helix maintenance uneven load | ~4.6h |
| 8984 | Manual recovery side effects | ~5d |
| 9209 | Helix swap stuck — deploy block | ~31d |
| 5398 | Stale Couchbase disco | ~1.3h |
| 8054 | GDPR bulkload WCU / 429s | ~12.6h |
| 10180 | IPv6 DataNode registration / snapshot age | ~5.4d |
| 8058 | Helix UNKNOWN host swap | ~6d |
| 7683 | Nuage/Kafka schema promotion | ~91d |
| 7105 | KSudo SHDFS token | ~3.1d |
| 4148 | GPFS hung / stale backups | ~4.9d |
| 9080 | LCD/Nuage automated schema | ~24.5d |
| 7183 | Liminal quota / N+1 risk | ~4.6h |
| 6985 | SN HW failure handling | ~1.6h |
| 10320 | DST CDC false alarm | ~3.3h |
| 7393 | Dual-mount PV race | ~8.2d |
| 5330 | NSS / kubelet | ~28.7h |
| 3003 | Load test + viral traffic | ~6.1d |
| 3139 | Malformed ACLs | ~20.6d |
| 5735 | Flannel queue limit | ~9.7h |
| 8341 | Backward-incompatible schema / USR | ~53d |
| 3617 | 429s unknown | ~2.75h |
| 3580 | ZK DAG / format | ~17m |
| 5798 | KSAP underscore / webhook | ~4.2d |

**Why with “current code”?** Most mass-outage themes are **infra + ops + platform coupling** (GPFS, Helix workflows, network stacks, K8s, schema pipelines)—application code paths (e.g., BackupTask) assume durable mounts and healthy Helix; when those fail together, symptoms surface as stale backups and snapshot SLA misses rather than a single bug in the backup routine.

Deletes

## Tombstones & accidental deletion

-   **Tombstones:** Snapshot service docs describe counts of tombstone rows—logical deletes not yet physically purged—alongside expired and invalid rows.
-   **TTL / purge policies:** Helix-driven expiry jobs remove eligible documents; backups still reflect “delete events” as mutations.
-   **Accidental deletion:** Recovery is **not** automatic: select a backup generation predating the delete, restore, then replay forward cautiously; coordinate Brooklin/Opal/Grid consumers to avoid amplifying bad state.
-   **Compliance deletes:** Must remain irreversible in the product sense—engineering guardrails belong in purge tools (typing, dry-run, rate limits) to prevent incident-10819 recurrence.
