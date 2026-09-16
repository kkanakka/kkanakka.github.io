---
title: "Incident Replay Simulator"
slug: /linkedin/linkedin-incident-simulator
sidebar_position: 9
sidebar_label: "Incident Replay Simulator"
description: "Incident Replay Simulator"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/linkedin-incident-simulator/sequence.svg" alt="How it works — linkedin-incident-simulator" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
Reliability Learning Platform — Chaos Engineering & Training at Scale

A sophisticated incident simulation system that transforms past outages into realistic training scenarios: 95% replay fidelity, 10-minute setup, isolated sandbox environments, and automated scoring engine for LinkedIn's reliability learning culture with thousands of archived incidents.

Incident Replay

Chaos Training

SRE Learning

[Home](/) [Design Framework](/docs/foundations/sre-design-framework) [SRE Systems](/docs/sre/sre-sysdesign) [Capacity Planner](/docs/linkedin/linkedin-capacity-planner)

## Page 1 — System Overview & Reliability Learning Philosophy

### What This System Is

A **"Mission-Critical Reliability Learning Platform"** that transforms LinkedIn's production incidents into realistic training simulations. The system archives incident logs, metrics, and timelines, then allows engineers to "replay" them as hands-on learning experiences or stress-test new reliability strategies in isolated sandbox environments without impacting live systems.

#### Incident Replay Simulator Service Level Objectives (SLOs)

| Objective | Target | Measurement |
| --- | --- | --- |
| Replay Fidelity | ≥ 95% | Percentage of real incident signals reproduced accurately |
| Replay Isolation | 100% | Zero impact on production systems during simulations |
| Setup Latency | < 10 min | From incident selection to replay session ready |
| Simulator Availability | ≥ 99.9% | Platform usable during training and chaos experiments |
| Incident Coverage | ≥ 90% | Historical incidents with logs/metrics are replayable |
| Training Effectiveness | ≥ 80% pass rate | Participants meet scoring rubric benchmarks |

### Reliability Learning Philosophy: Transform Failure into Knowledge

#### Core Incident Replay Principles

-   **Time-Warped Playback** — Incidents replay at 1×, 2×, or paused with drill commentary
-   **Data Sanitization Layer** — Removes PII and sensitive payloads while preserving patterns
-   **Sandbox Isolation** — Always runs in ephemeral clusters with zero production access
-   **Incident Templates** — Generalized "incident classes" for reusability across scenarios
-   **Scoring Rubric Integration** — Tracks MTTD (Mean Time to Detect) and MTTR performance
-   **Chaos Extensions** — Allows injecting variant stressors beyond original incident

### Seven Core Components

1.  **Incident Archive** — Stores logs, metrics, config snapshots, and incident timelines
2.  **Replay Engine** — Replays telemetry streams (logs, metrics, alerts) at original cadence
3.  **Synthetic Injectors** — Inject failures into sandboxed systems (K8s clusters, VMs)
4.  **Scenario Orchestrator** — Configures sessions (incident X, replay speed, injected errors)
5.  **Sandbox Environment** — Isolated clusters mimicking production topology
6.  **Trainer Dashboard** — Shows metrics, alert storms, log floods as in original outage
7.  **Scoring Engine** — Evaluates participant responses and learning effectiveness

### LinkedIn Incident Categories & Learning Value

#### Incident Types by Training Complexity

| Incident Category | Frequency | Learning Value | Simulation Complexity |
| --- | --- | --- | --- |
| **Database Latency Spikes** | High (weekly) | Query optimization, connection pooling | Medium - Synthetic load generation |
| **Kubernetes CrashLoops** | High (daily) | Container debugging, resource limits | Low - Pod lifecycle simulation |
| **Network Partitions** | Medium (monthly) | Split-brain handling, consensus algorithms | High - Multi-region coordination |
| **Config Rollback Failures** | Medium (bi-weekly) | Deployment safety, rollback procedures | Medium - Config state management |
| **Load Balancer Cascades** | Low (quarterly) | Traffic management, circuit breakers | High - Multi-service coordination |
| **Storage Exhaustion** | Medium (monthly) | Capacity planning, graceful degradation | Low - Disk space simulation |

#### Reliability Stressors (What Can Break)

#### Critical Simulator Failure Modes

-   **Replay Drift:** Logs not synchronized with metrics → unrealistic experience
-   **Sandbox Bleed:** Test traffic accidentally leaks into real production systems
-   **Resource Explosion:** Large incident replays saturate sandbox cluster capacity
-   **Overfitting Training:** Teams memorize scenarios instead of learning SRE frameworks
-   **Cross-Team Collisions:** Multiple replays cause noisy tenant interference
-   **Data Corruption:** Sanitization removes critical debugging context

## Page 2 — Architecture & Replay Engine Implementation

### System Architecture Overview

<img src="/diagrams/linkedin-incident-simulator/1.svg" alt="linkedin-incident-simulator diagram 1" class="doc-diagram" />

### Time-Warped Playback System

#### Temporal Synchronization Engine

**Replay Control:** Accurately recreate incident timelines with tempo control

##### Playback Speed Options

-   **Real-time (1× speed):** Full incident duration, realistic pacing for hands-on learning
-   **Fast-forward (2× to 5× speed):** Accelerated replay for pattern recognition training
-   **Slow-motion (0.5× speed):** Detailed analysis of rapid failure cascades
-   **Pause/Step:** Freeze at critical decision points for group discussion
-   **Jump-to-moment:** Skip to specific incident phases (detection, escalation, resolution)

##### Timeline Synchronization Challenges

-   **Clock Skew Correction:** Align logs from different systems with NTP corrections
-   **Metric Alignment:** Synchronize time-series data with discrete log events
-   **Alert Timing:** Reproduce original alerting delays and escalation timing
-   **Human Action Timing:** Model realistic response times for commands and decisions

### Data Sanitization & Privacy Protection

#### PII-Safe Incident Replay

**Context-Preserving Sanitization:** Remove sensitive data while maintaining debugging patterns

##### Sanitization Strategies

-   **User ID Hashing:** Replace real user IDs with consistent hashes (same user = same hash)
-   **IP Address Anonymization:** Replace with synthetic IPs that preserve network topology
-   **URL Path Generalization:** Replace specific paths with pattern templates
-   **Database Query Abstraction:** Sanitize table/column names while preserving query structure
-   **Error Message Templates:** Replace specific values with placeholders in error strings
-   **Hostname Mapping:** Consistent fake hostnames that preserve service relationships

##### Pattern Preservation Techniques

-   **Statistical Properties:** Maintain distribution shapes for latency, throughput, error rates
-   **Correlation Structure:** Preserve cross-service dependencies and failure propagation
-   **Seasonal Patterns:** Keep time-of-day and day-of-week traffic patterns intact
-   **Error Signatures:** Maintain unique error patterns for accurate diagnosis training

### Synthetic Failure Injection System

#### Chaos Engineering Integration

**Controlled Failure Simulation:** Inject realistic failures into sandbox environments

##### Failure Injection Categories

-   **Network Failures:** Packet loss, latency spikes, connection drops, DNS failures
-   **Resource Exhaustion:** CPU throttling, memory pressure, disk space, file descriptor limits
-   **Service Failures:** Process crashes, dependency timeouts, database locks
-   **Configuration Errors:** Bad config pushes, version mismatches, permission changes
-   **Infrastructure Failures:** Node failures, zone outages, load balancer issues
-   **Cascading Failures:** Multi-service failure chains, circuit breaker trips

##### Injection Timing & Realism

-   **Gradual Degradation:** Slowly increase failure rate to simulate real-world degradation
-   **Burst Failures:** Sudden spikes that mirror production failure patterns
-   **Correlated Failures:** Related components failing together (shared dependencies)
-   **Recovery Simulation:** Automatic recovery after intervention to test fix effectiveness

## Page 3 — Scoring Engine & Learning Effectiveness

### Automated Scoring & Assessment

#### SRE Performance Metrics

**Objective Assessment:** Measure incident response skills with quantitative metrics

##### Core Performance Indicators

-   **MTTD (Mean Time to Detect):** How quickly participants identify the root issue
-   **MTTR (Mean Time to Recover):** Time from detection to service restoration
-   **Diagnostic Accuracy:** Percentage of correct root cause identification
-   **Action Effectiveness:** Which mitigation steps actually improved the situation
-   **Escalation Timing:** Appropriate use of escalation procedures and expert consultation
-   **Communication Quality:** Incident updates, stakeholder notifications, documentation

##### Rubric-Based Assessment

-   **Novice (0-40%):** Requires significant guidance, misses key signals
-   **Developing (41-65%):** Basic incident response, some key insights missing
-   **Proficient (66-85%):** Solid SRE skills, effective incident response
-   **Expert (86-100%):** Exceptional performance, teaches others, process improvements

### Anti-Memorization & Scenario Variation

#### Dynamic Incident Generation

**Learning Framework Focus:** Teach SRE principles, not specific scenario memorization

##### Scenario Randomization Techniques

-   **Parameter Variation:** Same root cause, different symptoms (CPU vs memory pressure)
-   **Timeline Shifts:** Change when failures occur (peak vs off-hours traffic)
-   **Service Name Randomization:** Same architecture, different service labels
-   **Failure Magnitude Scaling:** Vary severity (partial vs complete service degradation)
-   **Red Herring Injection:** Add misleading signals to test diagnostic skills
-   **Multi-Path Resolution:** Multiple valid solutions with different trade-offs

##### Incident Template System

-   **Template Categories:** Database performance, network issues, resource exhaustion
-   **Parameterized Scenarios:** Fill-in-the-blank templates with variable components
-   **Difficulty Progression:** Simple single-service → complex multi-service cascades
-   **Cross-Pollination:** Combine elements from different real incidents

### Sandbox Isolation & Resource Management

#### Multi-Tenant Training Environment

**Safe Experimentation:** Isolated environments prevent cross-contamination

##### Isolation Mechanisms

-   **Network Isolation:** Separate VPCs, no production network access
-   **Kubernetes Namespaces:** Per-team namespace isolation with RBAC
-   **Resource Quotas:** CPU/memory/storage limits per training session
-   **DNS Isolation:** Separate DNS zones, no real service discovery
-   **Secret Management:** Synthetic secrets, no access to real credentials
-   **Data Isolation:** Synthetic datasets, no real user/business data

##### Resource Scaling Strategy

-   **On-Demand Provisioning:** Spin up sandbox environments when sessions start
-   **Pre-Warmed Pools:** Keep small pool of ready environments for instant access
-   **Auto-Cleanup:** Tear down environments after session completion
-   **Cost Management:** Track resource usage per team/session for chargeback

### Synthetic Injector Malfunction Response

#### Scenario Fidelity Protection

**Problem:** Injector floods sandbox with 10× expected logs → replay fidelity collapses

##### Automatic Fidelity Monitoring

1.  **Drift Detection (30s):** Compare current metrics vs original incident baseline
2.  **Fidelity Threshold:** Pause session when reproduction accuracy < 90%
3.  **Backup Injector Activation:** Orchestrator spawns backup injector, resumes from checkpoint
4.  **Session Marking:** Flag as "variant replay" in training records
5.  **Post-Session Analysis:** Tune injector safety limits, add fidelity guardrails

##### Preventive Measures

-   **Rate Limiting:** Maximum event injection rates per injector type
-   **Sanity Checks:** Validate injected data against expected patterns
-   **Circuit Breakers:** Shut down misbehaving injectors automatically
-   **Health Monitoring:** Real-time injector performance tracking

### Learning Analytics & Team Development

#### Training Effectiveness Measurement

**Data-Driven Learning:** Track individual and team skill progression over time

##### Individual Progress Tracking

-   **Skill Competency Maps:** Track proficiency in different incident types
-   **Learning Velocity:** Rate of improvement in MTTD/MTTR over time
-   **Knowledge Retention:** Performance on repeated scenarios weeks/months later
-   **Weak Spot Identification:** Which incident types need more practice

##### Team Performance Analytics

-   **Team Readiness Score:** Overall incident response capability assessment
-   **Knowledge Distribution:** Identify single points of failure (only one expert)
-   **Collaboration Patterns:** How effectively team members work together
-   **Training ROI:** Correlation between simulation training and real incident performance

##### Adaptive Training Recommendations

-   **Personalized Scenarios:** Recommend incidents based on individual skill gaps
-   **Difficulty Progression:** Gradually increase scenario complexity as skills improve
-   **Spaced Repetition:** Re-surface similar incidents at optimal intervals
-   **Cross-Training:** Expose engineers to incidents outside their primary domain

##### ✅ System Benefits

-   95% replay fidelity with time-synchronized playback
-   10-minute setup with ephemeral sandbox environments
-   100% production isolation through network/resource boundaries
-   Objective scoring eliminates memorization through randomization
-   Chaos engineering integration extends learning scenarios
-   Analytics-driven personalized learning paths

##### ⚠️ System Limitations

-   Data sanitization may remove critical debugging context
-   Synthetic environments can't capture all production complexity
-   Large incident replays require significant compute resources
-   Cross-team collision avoidance limits concurrent sessions
-   Scenario randomization may create unrealistic combinations
-   Learning transfer to real incidents requires validation
