---
title: "Secrets Rotation"
slug: /linkedin/linkedin-secrets-rotation
sidebar_position: 2
sidebar_label: "Secrets Rotation"
description: "Secrets Rotation"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/linkedin-secrets-rotation/sequence.svg" alt="How it works — linkedin-secrets-rotation" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
Production Security Design — Zero-Downtime Credential Management

A security-first secrets rotation service for LinkedIn scale: 60-second propagation, 99.999% availability, dual-key handoff, and automated rollback. Built with Vault, Kafka, Espresso, and LinkedIn infrastructure patterns.

Security First

5-Page Deep Dive

Zero Downtime

[Home](/) [Design Framework](/docs/foundations/sre-design-framework) [SRE Systems](/docs/sre/sre-sysdesign) [Feature Flags](/docs/linkedin/linkedin-feature-flags)

## Table of Contents — 5-Page Security Architecture

1.  [System Overview & Security Philosophy](#overview)
2.  [Core Architecture & LinkedIn Components](#architecture)
3.  [Implementation Details & Dual-Key Rotation](#implementation)
4.  [Security, Failure Scenarios & Cross-Colo](#reliability)
5.  [Operations, Monitoring & Audit](#operations)

<a id="overview"></a>

## Page 1 — System Overview & Security Philosophy

### What This System Is

A **"Production Secrets Rotation Service"** that securely manages and rotates credentials (API keys, TLS certs, DB passwords, OAuth tokens) across LinkedIn's infrastructure. The system must minimize downtime during rotation and prevent configuration drift between services while maintaining zero-trust security principles.

#### Service Level Objectives (SLOs)

| Objective | Target | Measurement |
| --- | --- | --- |
| Secret Propagation Latency | p99 ≤ 60s | From rotation trigger → all consumers updated |
| Control Plane Availability | ≥ 99.999% | API for fetching/updating secrets is available |
| Rotation Success Rate | ≥ 99.9% | Automated rotations complete without manual intervention |
| Audit Log Completeness | 100% | Every authenticated API call is logged within 1s |
| Drift Prevention | < 0.1% | Services using outdated secrets |
| Emergency Rollback Time | ≤ 30s | Revert to previous valid secret version |

### Security Philosophy: Zero-Trust with Graceful Handoff

#### System Architecture — Dual-Key Rotation & Zero-Trust Flow

#### 🔐 Complete Secrets Rotation Architecture

🏦 Secrets Store (HSM-backed)

Vault + Espresso

**HSM Layer**  
AES-256 keys

**Vault**  
Encrypted storage

**Espresso**  
Metadata DB

**Audit Log**  
Hash-chained

⬇️

1\. Store current + previous versions

🔄 Rotation Controller

Policy Engine + Dual-Key Logic

**Scheduler**  
Cron policies

**Generator**  
Create new secrets

**Validator**  
Test connectivity

**Rollback**  
Emergency revert

⬇️

2\. Generate new secret, maintain 15min overlap

📡 Distribution Plane (Kafka)

mTLS + Encryption

**Topic**  
secrets-rotation

**Encryption**  
AES-256-GCM

**Auth**  
mTLS certs

**Replay**  
7-day retention

⬇️

3\. Broadcast encrypted rotation events

🤖 Consumer Agents (Sidecar)

Hot-reload & Local decrypt

**Agent A**  
Profile Service

**Agent B**  
Feed Service

**Agent C**  
Search Service

**Agent N**  
All Services

⬇️

4\. Fetch, decrypt, hot-reload secrets

🚀 Application Services

Zero-downtime operation

**DB Connections**  
Use rotated passwords  
`Connection pooling`

**API Calls**  
Use rotated tokens  
`OAuth refresh`

**TLS Certs**  
Use rotated certificates  
`Cert chain validation`

##### 🕐 Dual-Key Rotation Timeline

**T0:** Old key only

→

**T1:** Generate new key

→

**T2-T17:** Both keys valid (15min)

→

**T18:** New key only

**Security Protocols:**  
• HSM-backed encryption (AES-256)  
• mTLS for Kafka transport  
• SHA-256 HMAC integrity  
• Versioned secret schema

**Key Flows:**  
• Rotation: Controller → Vault → Kafka  
• Distribution: Kafka → Agents → Services  
• Rollback: Emergency revert via Kafka  
• Audit: Every operation logged with hash chain

#### Core Security Principles

-   **Dual-Key Rotation Pattern** — Maintain old\_key + new\_key overlap window (15 min) for zero-downtime handoff
-   **Least Privilege Access** — Services only access secrets they need, with time-limited tokens
-   **Immutable Audit Trail** — Every secret access logged with cryptographic integrity
-   **Fail-Safe Rollback** — Always retain previous valid version for emergency recovery
-   **Encryption at Rest & Transit** — All secrets encrypted with HSM-backed keys
-   **Versioned Secrets Schema** — Consumers specify `secret_id@version` for controlled access

### Five Core Components

1.  **Secrets Store** — Encrypted storage with HSM backing (LinkedIn Vault + Espresso)
2.  **Rotation Controller** — Policy-driven scheduler with automated rotation logic
3.  **Distribution Plane** — Secure propagation via Kafka with TLS + mTLS auth
4.  **Consumer Agent** — Sidecar daemon that fetches, decrypts, and hot-reloads secrets
5.  **Audit Logger** — Immutable compliance log with hash-chaining integrity

### Secret Types & Rotation Policies

#### Credential Categories

| Secret Type | Rotation Period | Complexity | Rollback Window |
| --- | --- | --- | --- |
| API Keys | 90 days | Low | 24 hours |
| Database Passwords | 30 days | High (connection pooling) | 1 hour |
| TLS Certificates | 90 days | High (chain validation) | 7 days |
| OAuth Tokens | 24 hours | Medium | 2 hours |
| SSH Keys | 180 days | Medium | 48 hours |
| Service-to-Service JWTs | 6 hours | Low | 30 minutes |

#### Reliability Stressors (What Can Break)

#### Critical Failure Modes

-   **Partial Rollout:** Some services pick up new secrets; others still use old ones → authentication split-brain
-   **Configuration Drift:** Service instance caches outdated keys → intermittent auth failures
-   **HSM Latency Spikes:** Decrypt operations stall rotation controller → delayed propagation
-   **Network Partitions:** Region A rotates, Region B misses update → cross-region inconsistency
-   **Rotation Policy Error:** Bad policy (e.g., "rotate every 10 seconds") → self-inflicted DDoS
-   **Blast Radius:** Single rotation bug breaks authentication for thousands of services

### Production Design Patterns

#### Advanced Reliability Patterns

-   **Dual-Key Rotation Pattern:** 15-minute overlap window where both old/new keys are valid
-   **Pull + Push Hybrid:** Push via Kafka + periodic pull for self-healing consistency
-   **Versioned Secrets Schema:** `db_password@v1234` for precise version control
-   **Fail-Safe Rollback:** One-click revert to `previous_valid_version`
-   **Dead Letter Queue:** Failed rotation attempts for manual investigation
-   **Multi-Region Replicas:** Secrets Store replicated across 4 LinkedIn datacenters
-   **Automatic Revocation Alert:** If rotation exceeds SLO window, auto-revoke old secrets

<a id="architecture"></a>

## Page 2 — Core Architecture & LinkedIn Components

### System Architecture Overview

<img src="/diagrams/linkedin-secrets-rotation/1.svg" alt="linkedin-secrets-rotation diagram 1" class="doc-diagram" />

### LinkedIn Component Integration

#### LinkedIn Vault Secrets Store

**Technology Stack:** HashiCorp Vault + Espresso backend + HSM integration

-   **Storage Backend** — Espresso database with multi-DC async replication
-   **Encryption** — AES-256-GCM with HSM-managed keys (FIPS 140-2 Level 3)
-   **Access Control** — RBAC with LinkedIn SSO + service identity certificates
-   **Versioning** — Git-like versioning with `secret_name@version` syntax
-   **Audit Integration** — Every read/write logged to immutable audit trail

#### Rotation Controller Implementation

**Policy Engine:** Declarative rotation policies with safety constraints

-   **Dual-Key Logic** — Automated old/new key handoff with configurable overlap
-   **Blast Radius Control** — Maximum concurrent rotations per service tier
-   **Metric Gates** — Integration with LinkedIn monitoring for automated rollback
-   **Dead Letter Queue** — Failed rotations require manual investigation

#### Kafka Distribution Plane

**Security-First Messaging:** Encrypted events with mTLS authentication

-   **Topic Structure** — Per-DC topics: `secrets-ltx1`, `secrets-lva1`, etc.
-   **Encryption** — Event payload encrypted with rotating KEK (Key Encryption Key)
-   **Authentication** — mTLS with service identity certificates
-   **Replay Protection** — 30-day retention for audit and recovery

#### Consumer Agent (Sidecar Pattern)

**Zero-Downtime Secret Injection:** Hot-reload without service restart

### Cross-Datacenter Security Architecture

| Datacenter | Role | Vault Role | Kafka Topic | HSM Location |
| --- | --- | --- | --- | --- |
| LTX1 | Primary | Write Master | secrets-ltx1 | Primary HSM Cluster |
| LVA1 | Hot Standby | Read Replica | secrets-lva1 | Standby HSM |
| EI4 | Staging | Test Environment | secrets-ei4 | Test HSM |
| Grid2 | DR Cold | Disaster Recovery | secrets-grid2 | DR HSM (Offline) |

##### ✅ Architecture Benefits

-   Zero-downtime rotation with dual-key handoff
-   HSM-backed encryption for maximum security
-   Self-healing drift detection and correction
-   Immutable audit trail for compliance
-   Automated rollback on metric violations

##### ⚠️ Architecture Trade-offs

-   15-minute overlap window (higher exposure surface)
-   Complex sidecar deployment pattern
-   HSM dependency for all encryption operations
-   60-second propagation delay (eventual consistency)
-   Higher memory footprint per service instance

<a id="implementation"></a>

## Page 3 — Implementation Details & Dual-Key Rotation

### Dual-Key Rotation Pattern

#### Zero-Downtime Handoff Implementation

The core innovation: maintain both old and new secrets during a 15-minute overlap window

### Secret Versioning & Schema

#### Versioned Secret Schema

### Pull + Push Hybrid Distribution

#### Self-Healing Consistency Pattern

Combine push notifications with periodic pull for drift correction

### Database Password Rotation

#### Complex Credential Handoff

Database passwords require careful connection pool management

### TLS Certificate Rotation

#### Certificate Chain Validation

### Emergency Rollback Implementation

#### One-Click Rollback Mechanism

<a id="reliability"></a>

## Page 4 — Security, Failure Scenarios & Cross-Colo Design

### Security Failure Scenarios & Mitigation

#### Scenario 1: Partial Rotation (Authentication Split-Brain)

**Failure:** 30% of services update to new password, 70% still use old password

**Impact:** Intermittent authentication failures across user requests

**Detection:**

-   Auth success rate drops below 99.5% threshold
-   Consumer agents report version drift in health checks
-   Monitoring alerts on secret version inconsistency >5%

**Mitigation:**

-   \*\*Dual-key overlap window\*\* — Both old/new secrets valid for 15 minutes
-   \*\*Automatic metric gates\*\* — Rollback if auth success drops
-   \*\*Emergency sync\*\* — Force all agents to pull latest version
-   \*\*Blast radius control\*\* — Max 10 concurrent rotations per service tier

**Recovery Time:** 30 seconds (emergency rollback), 5 minutes (emergency sync)

#### Scenario 2: HSM Outage During Rotation

**Failure:** Hardware Security Module becomes unavailable mid-rotation

**Impact:** Cannot decrypt existing secrets or generate new ones

**Mitigation:**

-   \*\*HSM High Availability\*\* — Primary + standby HSM clusters across DCs
-   \*\*Cached DEK (Data Encryption Keys)\*\* — 1-hour cache for emergency decryption
-   \*\*Rotation pause\*\* — Automatically halt new rotations during HSM outage
-   \*\*Cross-DC failover\*\* — LVA1 HSM takes over from LTX1 within 60 seconds

**Recovery Time:** 60 seconds (HSM failover), 0 seconds (cached keys)

#### Scenario 3: Malicious Rotation Policy

**Failure:** Bad actor uploads policy "rotate every 10 seconds"

**Impact:** Self-inflicted DDoS on Vault and consumer services

**Detection:\*\***

**

-   Rate limit exceeded: >50 rotations/hour for single secret
-   Vault CPU/memory alerts due to encryption load
-   Consumer agents unable to keep up with rotation events

**Prevention & Mitigation:**

-   \*\*Policy validation\*\* — Min rotation period 1 hour, max concurrent rotations
-   \*\*Rate limiting\*\* — Per-service rotation quotas enforced by controller
-   \*\*Policy approval\*\* — Rotation policies require security team approval
-   \*\*Circuit breaker\*\* — Halt rotations if system load exceeds threshold

**Recovery Time:** 0 seconds (prevention), 30 seconds (circuit breaker)

**

**

#### Scenario 4: Cross-Region Network Partition

**Failure:** LTX1 completes rotation, LVA1 services miss update

**Impact:** Cross-region API calls fail due to credential mismatch

**Detection:**

-   Cross-region API success rate drops to 0%
-   Consumer agents in LVA1 report drift vs Vault primary
-   Kafka consumer lag spikes in affected regions

**Mitigation:**

-   \*\*Regional Vault replicas\*\* — Each DC has local Vault for reads
-   \*\*Pull-based fallback\*\* — Agents poll local Vault if Kafka fails
-   \*\*Extended overlap window\*\* — 30 minutes during network issues
-   \*\*Manual resync\*\* — Operations team can trigger regional sync

**Recovery Time:** 0 seconds (local reads), 5 minutes (manual sync)

#### Scenario 5: Consumer Agent Bug (Memory Leak)

**Failure:** Agent memory leak causes OOM, stops processing rotations

**Impact:** Affected services stuck with old secrets, eventual auth failure

**Detection:**

-   Agent health check fails (memory >90% of limit)
-   Secret version drift detected by monitoring
-   Service reports old secret version in health endpoint

**Mitigation:**

-   \*\*Memory limits\*\* — Agents run in containers with hard memory limits
-   \*\*Automatic restart\*\* — K8s restarts agent if health check fails
-   \*\*Graceful degradation\*\* — Service falls back to direct Vault calls
-   \*\*Agent redundancy\*\* — Multiple agents per service for HA

**Recovery Time:** 30 seconds (container restart), 0 seconds (direct Vault)

### Cross-Datacenter Security Design

#### Multi-DC Secret Replication Strategy

| Datacenter | Vault Role | HSM Status | Failover Time | Consistency |
| --- | --- | --- | --- | --- |
| **LTX1** | Primary Writer | Active HSM | N/A | Strong |
| **LVA1** | Hot Standby | Standby HSM | 60 seconds | Eventually consistent (30s) |
| **EI4** | Staging | Test HSM | Manual | Test data only |
| **Grid2** | DR Cold | Offline HSM | 15 minutes | Batch sync (hourly) |

##### Cross-DC Secret Propagation:

1.  **Primary Write:** Rotation Controller (LTX1) → Vault (LTX1) → HSM encrypt
2.  **Local Distribution:** Kafka (LTX1) → Consumer Agents (LTX1)
3.  **Cross-DC Replication:** Vault (LTX1) → Async replication → Vault (LVA1, EI4)
4.  **Remote Distribution:** Kafka (LVA1) → Consumer Agents (LVA1)
5.  **DR Sync:** Batch replication → Grid2 (every hour)

#### Cross-DC Failover Implementation

### Security Compliance & Governance

#### Regulatory Compliance Framework

-   **SOX Compliance:** All financial system secrets rotated every 30 days with audit trail
-   **PCI-DSS:** Payment processing secrets encrypted with FIPS 140-2 Level 3 HSM
-   **GDPR:** EU data processing secrets isolated to EU datacenters only
-   **ISO 27001:** Risk-based rotation policies with business impact assessment
-   **FedRAMP:** Government cloud secrets with enhanced monitoring and controls

#### Secret Classification & Governance

### Performance & Security Balance

#### Security vs Performance Trade-offs

| Security Level | Rotation Frequency | Overlap Window | Performance Impact |
| --- | --- | --- | --- |
| Maximum | 24 hours | 5 minutes | High (frequent disruption) |
| High | 30 days | 15 minutes | Medium (monthly impact) |
| Standard | 90 days | 2 hours | Low (quarterly impact) |
| Basic | 180 days | 24 hours | Very Low (semi-annual) |


**

**

<a id="operations"></a>

## Page 5 — Operations, Monitoring & Audit

### Security Monitoring & Alerting

#### Security SLI Dashboard

**Real-time Security Metrics:** Comprehensive monitoring for secret lifecycle

##### 🎯 Core Security SLOs

| SLI | Target | Alert Threshold | Measurement |
| --- | --- | --- | --- |
| Rotation Success Rate | ≥99.9% | <99.5% | Successful rotations / Total rotation attempts |
| Propagation Latency | ≤60s p99 | \>120s | Rotation trigger → consumer acknowledgment |
| Authentication Success | ≥99.99% | <99.9% | Auth success / Total auth attempts |
| Secret Drift Rate | <0.1% | \>0.5% | Services with outdated secrets / Total services |
| Audit Completeness | 100% | <100% | Logged accesses / Total secret accesses |
| Emergency Rollback Time | ≤30s | \>60s | Rollback trigger → completion |

#### Comprehensive Security Monitoring Implementation

### Incident Response Playbooks

#### Runbook: High Authentication Failure Rate

**Alert:** "Auth success rate <99.9% for 2 minutes"

**Investigation Steps:**

1.  Check if rotation is in progress: `kubectl get rotations --field-selector status=in-progress`
2.  Identify affected secret: Review alert tags for secretId
3.  Check consumer agent health: Verify agents are receiving updates
4.  Validate HSM status: Ensure encryption/decryption is working
5.  Review recent deployments: Look for consumer service changes

**Mitigation:**

-   If rotation in progress: Extend overlap window by 15 minutes
-   If consumer drift: Execute emergency sync command
-   If HSM issues: Failover to standby HSM cluster
-   If critical: Execute emergency rollback to previous version

#### Runbook: Secret Drift Above Threshold

**Alert:** "Secret drift >0.5% detected"

**Investigation Steps:**

1.  Identify drifted services: `curl /metrics/secret-drift | grep affected_services`
2.  Check Kafka consumer lag: Look for stuck consumers
3.  Verify network connectivity: Test cross-DC communication
4.  Review consumer agent logs: Look for pull/push failures
5.  Check Vault replication status: Ensure cross-DC sync working

**Mitigation:**

-   Restart stuck consumer agents on affected services
-   Execute manual pull sync: `kubectl exec agent -- sync-secrets --force`
-   Reset Kafka consumer offsets if messages were lost
-   Trigger emergency broadcast if >10% drift

#### Runbook: HSM Tamper Alert

**Alert:** "HSM tamper detection triggered in ltx1"

**Immediate Actions (First 60 seconds):**

1.  \*\*STOP ALL ROTATIONS\*\* — Halt rotation controller immediately
2.  \*\*ISOLATE AFFECTED HSM\*\* — Block network access to compromised HSM
3.  \*\*ENGAGE SECURITY TEAM\*\* — Page CISO and security oncall
4.  \*\*PRESERVE EVIDENCE\*\* — Lock HSM state for forensic analysis

**Recovery Actions:**

-   Failover to standby HSM in LVA1 for urgent operations
-   Audit all secrets accessed in last 24 hours
-   Plan coordinated rotation wave for all potentially exposed secrets
-   Conduct forensic analysis before re-enabling compromised HSM

### Audit Trail & Compliance

#### Hash-Chained Audit Implementation

### Compliance Reporting

#### Automated Compliance Reports

##### Daily Security Reports:

-   **Rotation Compliance:** % of secrets rotated within policy window
-   **Access Anomalies:** Unusual access patterns requiring investigation
-   **Drift Summary:** Services with outdated secrets by datacenter
-   **HSM Health:** Hardware security module status and performance

##### Monthly Audit Reports:

-   **Secret Inventory:** Complete catalog with classification and ownership
-   **Policy Compliance:** Adherence to rotation and governance policies
-   **Incident Summary:** Security incidents and response effectiveness
-   **Risk Assessment:** High-risk secrets requiring attention

### Capacity Planning & Performance

#### Security-Performance Optimization

| Component | Current Capacity | Scale Trigger | Security Impact |
| --- | --- | --- | --- |
| HSM Operations | 1000 ops/sec | CPU >70% | Encryption latency increases |
| Vault Storage | 100K secrets | Storage >80% | No impact on security |
| Consumer Agents | 10K services | Memory >512MB | Delayed secret updates |
| Audit Log | 1M events/day | Kafka lag >1000 | Compliance gap risk |

##### Security-Optimized Scaling:

-   **HSM Scaling** — Add HSM cluster nodes before hitting 70% utilization
-   **Vault Scaling** — Horizontal sharding by secret classification level
-   **Agent Scaling** — K8s HPA based on memory and rotation frequency
-   **Audit Scaling** — Kafka partition scaling with retention management

### Future Security Enhancements

#### Roadmap Items

##### Q2 2024:

-   **Zero-Trust Secrets:** Service mesh integration with automatic mTLS rotation
-   **ML Anomaly Detection:** Machine learning for suspicious access patterns
-   **Quantum-Resistant Crypto:** HSM upgrade for post-quantum algorithms

##### Q3 2024:

-   **Secret-less Architecture:** Short-lived tokens eliminating long-term secrets
-   **Blockchain Audit:** Immutable audit trail using blockchain technology
-   **Cross-Cloud Secrets:** Secure secret sharing across cloud providers

##### Q4 2024:

-   **Confidential Computing:** Intel SGX enclaves for secret processing
-   **Homomorphic Encryption:** Compute on encrypted secrets without decryption
-   **Regulatory Automation:** Auto-compliance with emerging regulations

##### ✅ System Security Benefits

-   Zero-downtime rotation with dual-key handoff
-   HSM-backed encryption with tamper detection
-   Immutable audit trail with hash-chain integrity
-   Automated compliance with regulatory requirements
-   Real-time anomaly detection and alerting
-   30-second emergency rollback capability

##### ⚠️ System Security Limitations

-   15-minute overlap window increases exposure surface
-   HSM dependency creates potential bottleneck
-   Complex sidecar agent increases attack surface
-   Cross-DC replication delay (60s) during failures
-   Manual investigation required for failed rotations
-   High operational complexity for security team


**
