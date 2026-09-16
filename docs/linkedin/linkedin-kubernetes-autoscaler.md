---
title: "Kubernetes Autoscaler"
slug: /linkedin/linkedin-kubernetes-autoscaler
sidebar_position: 7
sidebar_label: "Kubernetes Autoscaler"
description: "Kubernetes Autoscaler"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/linkedin-kubernetes-autoscaler/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

SLO-Aware Feedback Control — Cost vs Latency Optimization

A sophisticated autoscaling system that coordinates HPA, VPA, and Cluster Autoscaler across LinkedIn's multi-region fleet: sub-120ms p95 latency SLO, 30-second scale-out, graceful scale-in with PDB safety, and 75% cost efficiency through intelligent feedback loops.

SLO-Driven Control

Feedback Stability

Cost Optimization

[Home](/) [Design Framework](/docs/foundations/sre-design-framework) [SRE Systems](/docs/sre/sre-sysdesign) [Metrics Aggregator](/docs/linkedin/linkedin-metrics-aggregator)

## Page 1 — System Overview & SLO-Aware Autoscaling Philosophy

### What This System Is

A **"Mission-Critical SLO-Aware Autoscaling Platform"** that keeps LinkedIn service latency within SLO while minimizing cost. The system coordinates HPA (Horizontal Pod Autoscaler), VPA (Vertical Pod Autoscaler), and Cluster Autoscaler across multi-region fleets, handles bursty traffic patterns, and prevents oscillations through sophisticated feedback-loop control theory.

#### Kubernetes Autoscaling Service Level Objectives (SLOs)

| Objective | Target | Measurement |
| --- | --- | --- |
| P95 Request Latency | ≤ 120ms | Primary SLO to guard user experience |
| Scale-out Reaction Time | ≤ 30s | From demand spike detection to first pod scheduled |
| Scale-in Safety | 0 dropped requests | Drains respect connection TTLs and in-flight work |
| Pod OOM Rate | < 0.1% per day | VPA recommendation accuracy and memory allocation |
| Cost Efficiency | ≥ 75% average node utilization | Balance headroom without waste |
| Control Loop Stability | < 5% oscillation rate | Prevent scaling thrash and feedback instability |

### SLO-Aware Autoscaling Philosophy: Control Theory at Scale

#### Core Autoscaling Control Principles

-   **SLO-Driven Control Law** — desired\_pods = f(RPS, target\_latency, pod\_capacity) with derivative dampening
-   **Two-Loop Design (Fast/Slow)** — Fast HPA (10s) for queue depth, Slow VPA (15m) for resource tuning
-   **Predictive Burst Buffer** — EWMA forecaster adds warm pods for traffic ramps
-   **Graceful Drain with PDB** — Scale-in respects Pod Disruption Budgets and in-flight work
-   **Topology-Aware Scheduling** — Anti-affinity with buffer nodes per availability zone
-   **Bin-Packing Optimization** — Memory-first packing to reduce OOMs and fragmentation

### Six Core Components

1.  **SLO Signal Adapter** — Converts SLIs (latency, queue depth, error rate) → desired capacity
2.  **HPA Controller (Custom)** — Uses composite metrics (RPS per pod, queue length, p95 latency)
3.  **VPA Recommender** — Tunes CPU/Memory requests/limits from usage histograms
4.  **Cluster Autoscaler** — Adds/removes nodes to fit pending pods with topology awareness
5.  **Rate Limiter & Cooldowns** — Prevents flapping (scale-out fast, scale-in slow with guards)
6.  **Admission/Policy Webhook** — Applies per-service scaling policies and cost guardrails

### LinkedIn Workload Types & Scaling Patterns

#### Service Categories by Scaling Behavior

| Service Type | Traffic Pattern | Scaling Strategy | Key Metrics |
| --- | --- | --- | --- |
| **Feed Generation** | Diurnal with bursts | Predictive + reactive HPA | Queue depth, processing latency |
| **API Gateway** | Steady with spikes | Fast HPA + buffer nodes | RPS per pod, p95 latency |
| **Search Services** | Bursty & unpredictable | Aggressive burst buffer | Search latency, cache hit rate |
| **ML Inference** | GPU-bound batch | VPA-heavy + node affinity | GPU utilization, batch queue |
| **Message Processing** | Kafka lag-driven | Queue-depth HPA | Consumer lag, processing rate |
| **Batch Analytics** | Scheduled + ad-hoc | Cluster autoscaler focus | Node utilization, job completion |

#### Reliability Stressors (What Can Break)

#### Critical Autoscaling Failure Modes

-   **Metric Delay** → Late scaling decisions → SLO breaches during traffic spikes
-   **Feedback Oscillation** → Overreaction causes scaling thrash and instability
-   **Bin-packing Fragmentation** → Pods unschedulable despite spare CPU cores
-   **Mixed Workloads (Noisy Neighbors)** → Latency spikes from resource contention
-   **Cold-start Costs** → JIT compilation + cache warmup → false capacity readings
-   **Cross-Controller Conflicts** → HPA, VPA, CA fighting each other simultaneously

## Page 2 — Architecture & Feedback Control Implementation

### System Architecture Overview

<img src="/diagrams/linkedin-kubernetes-autoscaler/1.svg" alt="linkedin-kubernetes-autoscaler diagram 1" class="doc-diagram" />

### SLO-Driven Control Law Implementation

#### Mathematical Control Model

**Composite SLO Signal:** Transform multiple SLIs into unified scaling decisions

##### Core Control Law Formula

desired\_pods = current\_pods \* (target\_latency / current\_p95\_latency) + queue\_depth\_factor + derivative\_dampening + burst\_buffer\_pods

##### Implementation Details

-   **Latency Signal Weight:** Primary (60%) - directly maps to user experience SLO
-   **Queue Depth Weight:** Secondary (30%) - leading indicator for upcoming latency issues
-   **Error Rate Weight:** Circuit breaker (10%) - prevents scaling during service degradation
-   **Derivative Dampening:** Prevents oscillation by smoothing rapid changes
-   **Burst Buffer:** EWMA-based prediction adds 10-20% headroom pods

### Two-Loop Control Design

#### Fast Loop (HPA) - 10 Second Cycle

**Reactive Scaling:** Responds to immediate SLO threats

##### Fast Loop Decision Logic

-   **P95 Latency > 100ms:** Immediate scale-out by 25% with no cooldown
-   **Queue Depth > 5:** Scale-out by queue\_depth/2 pods (burst protection)
-   **Error Rate > 1%:** Pause scaling, investigate service health first
-   **Traffic Ramp Detected:** Activate predictive burst buffer (warm pods)

##### Scale-Out Speed vs Scale-In Caution

-   **Scale-Out:** Immediate reaction, no cooldown period needed
-   **Scale-In:** 10-minute stability guard, requires sustained low utilization
-   **Emergency Brake:** Never scale-in if P95 latency > 80ms in last 15 minutes

#### Slow Loop (VPA) - 15 Minute Cycle

**Resource Optimization:** Right-sizes containers to prevent waste and OOMs

##### VPA Recommendation Strategy

-   **Memory Sizing:** P99 memory usage + 20% safety buffer to prevent OOMs
-   **CPU Requests:** P95 CPU usage, allows bursting to node capacity
-   **Update Strategy:** Rolling update during low-traffic windows only
-   **Conflict Resolution:** VPA changes blocked during active HPA scaling

##### OOM Prevention Logic

-   **Memory Pressure Detection:** Alert when memory usage > 85% of limits
-   **Proactive Scaling:** Increase memory limits before reaching 90%
-   **JIT Warmup Buffer:** Extra 30% memory during cold-start phase

### Predictive Burst Buffer System

#### Traffic Forecasting & Warm Pod Management

**EWMA-Based Prediction:** Anticipate traffic ramps and pre-allocate capacity

##### Burst Buffer Algorithm

-   **Traffic Trend Detection:** EWMA with α=0.3 for RPS trend analysis
-   **Ramp Threshold:** >15% traffic increase over 2-minute window triggers buffer
-   **Warm Pod Allocation:** Pre-scale by predicted demand + 20% safety margin
-   **Buffer Timeout:** Unused warm pods released after 10 minutes
-   **Cost Control:** Buffer limited to 50% of current replica count

##### LinkedIn Event Calendar Integration

-   **Scheduled Events:** Product launches, marketing campaigns, newsletters
-   **Pre-scaling:** Automatic capacity increase 15 minutes before events
-   **Post-event Graceful Scale-in:** Slower than normal scale-in after events
-   **Historical Learning:** Event impact analysis improves future predictions

## Page 3 — Graceful Scaling & Operational Excellence

### Pod Disruption Budget & Graceful Drains

#### Zero-Downtime Scale-In Operations

**Connection-Aware Draining:** Respects in-flight requests and connection TTLs

##### Graceful Drain Sequence

1.  **Pre-drain Health Check:** Ensure pod is ready and not receiving new traffic
2.  **Traffic Steering:** Remove pod from load balancer rotation (30s graceful period)
3.  **Connection Completion:** Wait for active connections to complete (max 2 minutes)
4.  **SIGTERM Signal:** Send termination signal to application
5.  **Graceful Shutdown:** Application cleanup period (30s default)
6.  **SIGKILL Force:** Force termination if graceful timeout exceeded

##### Pod Disruption Budget Configuration

-   **Critical Services:** maxUnavailable: 10% (minimum 1 pod always available)
-   **Standard Services:** maxUnavailable: 25% (balance availability vs efficiency)
-   **Batch Workloads:** maxUnavailable: 50% (higher disruption tolerance)
-   **Singleton Services:** maxUnavailable: 0 (prevent all disruption)

### Topology-Aware Scheduling & Anti-Affinity

#### Multi-AZ High Availability

**Failure Domain Distribution:** Spread replicas across availability zones

##### Anti-Affinity Rules

-   **Zone-level Anti-Affinity:** No two replicas of same service on same AZ
-   **Node-level Anti-Affinity:** Distribute replicas across different nodes
-   **Rack-level Awareness:** Consider physical rack placement for critical services
-   **Buffer Nodes:** 15% pre-warmed capacity in each AZ for burst scaling

##### Bin-Packing Optimization Strategy

-   **Memory-First Packing:** Prioritize memory allocation to prevent OOMs
-   **CPU Over-subscription:** Allow 2:1 CPU over-subscription with burst capabilities
-   **Fragmentation Avoidance:** Reserve large-pod capacity on dedicated nodes
-   **Mixed Workload Isolation:** Separate batch and latency-sensitive workloads

### Oscillation Prevention & Stability Analysis

#### Control Loop Stability Monitoring

**Thrash Detection:** Monitor scaling decisions for feedback instability

##### Oscillation Detection Metrics

-   **Scaling Frequency:** Alert if >5 scaling events in 10-minute window
-   **Direction Changes:** Flag alternating scale-out/scale-in patterns
-   **Amplitude Analysis:** Measure scaling decision magnitude over time
-   **Convergence Time:** Track time to reach steady state after disturbance

##### Anti-Oscillation Mechanisms

-   **Exponential Backoff:** Increase cooldown period after repeated scaling
-   **Derivative Dampening:** Smooth rapid changes in control signal
-   **Deadband Control:** Ignore small deviations within ±5% of target
-   **Rate Limiting:** Maximum 1 scale-out per minute, 1 scale-in per 10 minutes

### Cost Efficiency & Budget Guardrails

#### Cost-Aware Scaling Decisions

**Budget SLO Integration:** Balance performance and cost optimization

##### Cost Guardrail Implementation

-   **Monthly Budget Limits:** Cap total compute spend per service
-   **Cost Per Request Target:** $0.001 per request for standard services
-   **Utilization Floors:** Minimum 50% node utilization required
-   **Waste Detection:** Alert on sustained <60% utilization for >24 hours

##### Tiered Scaling Policies

-   **Tier 0 (Critical):** No cost limits, SLO-first scaling
-   **Tier 1 (Important):** Cost cap at 120% of monthly budget
-   **Tier 2 (Standard):** Cost cap at 100% of monthly budget
-   **Tier 3 (Best Effort):** Cost cap at 80% of monthly budget

### Black Friday Simulation Scenario

#### Traffic Surge Response Plan

**Scenario:** RPS increases 4× in 90 seconds, p95 latency breaches 300ms, pending pods rise, OOMs during warmup

##### Automated Response Sequence

1.  **Fast Loop Detection (10s):** Burst buffer activates, adds warm pods immediately
2.  **Cluster Autoscaler (30s):** Provisions nodes in two AZs, prefers memory-heavy instances
3.  **VPA Emergency Mode:** Temporarily relax memory limits via "confidence floor" to reduce OOM
4.  **Scale-in Guard (10m):** After ramp, enforce stability period before scale-in
5.  **Graceful Drain:** PDB-respecting drain with connection completion

##### Post-Incident Optimization

-   **Warm-Pod Tuning:** Adjust buffer count based on actual ramp profile
-   **Memory-First Packing:** Optimize bin-packing for burst scenarios
-   **Prediction Model:** Update EWMA parameters with surge characteristics
-   **Cost Analysis:** Measure efficiency of emergency scaling decisions

##### ✅ System Benefits

-   Sub-120ms p95 latency through SLO-aware control
-   30-second scale-out with predictive burst buffer
-   Zero request drops via PDB and graceful drains
-   75% cost efficiency through intelligent bin-packing
-   Oscillation prevention with derivative dampening
-   Multi-AZ topology awareness for resilience

##### ⚠️ System Limitations

-   10-minute scale-in guard may waste resources temporarily
-   VPA updates can cause pod restarts during peak load
-   Memory-first packing may under-utilize CPU resources
-   Complex control logic requires extensive tuning
-   Burst buffer overhead increases steady-state costs
-   Cross-controller coordination can introduce delays
