---
title: "SRE Design Interview Framework"
slug: /foundations/sre-design-framework
sidebar_position: 4
sidebar_label: "SRE Design Interview Framework"
description: "SRE Design Interview Framework"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/sre-design-framework/sequence.svg" alt="How it works — sre-design-framework" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
The systematic Google-style approach for any system design interview — from requirements to trade-offs. Master the reliability-first reasoning that distinguishes senior SRE candidates.

Google SRE • Design Framework • Universal Template

[Home](/) [10 Classic Problems](/docs/sre/sre-sysdesign) [Debugging Guide](/docs/sre/sre-debugging) [NALSD Scenarios](/docs/sre/sre-nalsd)

## Step 0 — Frame the Problem Like an SRE

"What is the service trying to guarantee, and to whom?"

Every architecture exists to honor a **Service Level Objective (SLO)** that expresses user trust in measurable form. Before you draw a single box or arrow, you must translate the problem statement into a reliability-anchored specification.

| Question | Example Output |
| --- | --- |
| "What does failure look like to them?" | "Alert arrives > 30s late" |
| "What risk tolerance do we have?" | "≤ 0.1% missed alerts per quarter" |
| "What metric captures that?" | "p99 alert latency < 30s" |

➡️ Always define SLOs before designing components.

### The SRE Design Flow — Your Systematic Path

Requirements → SLO Contract → Baseline Design → Stressors  
→ Resilient Architecture → Observability & Ops → Trade-offs

## Section 1 — Design Framework: "From Requirements → Metrics → Trade-offs"

This section teaches the repeatable, Google-style reasoning flow used in every successful design interview.

#### 1\. Requirements → SLO Contract

"How reliable, fast, and scalable must this system be?"

**Output:** Availability (99.99%), Latency (p95 ≤ 200ms), Throughput (10K RPS), Consistency guarantees

#### 2\. SLO Contract → Baseline Design

"What minimal set of components meets those guarantees?"

**Output:** Happy path architecture — load balancer → app servers → database. Focus on core data flow.

#### 3\. Baseline Design → Stressors

"What happens when scale ×10 or a dependency fails?"

**Output:** 5 failure modes — DB overload, network partition, memory leak, cascade failure, human error

#### 4\. Stressors → Resilient Architecture

"Which reliability patterns (replication, circuit breaker, queues) mitigate them?"

**Output:** Multi-AZ deployment + Circuit breakers + Retry with backoff + Health checks + Auto-scaling

#### 5\. Resilient Architecture → Observability & Ops

"How will we know it's healthy—and repair it safely?"

**Output:** SLI metrics, dashboards, alerts, runbooks, deployment strategy, rollback plan

#### 6\. Observability & Ops → Trade-offs

"Where do we accept cost or complexity to meet SLOs?"

**Output:** CAP theorem choice, consistency vs latency, cost vs reliability, operational complexity

#### 7\. Articulate Trade-offs & Reasoning

"Why this choice over alternatives? What are the second-order effects?"

**Output:** "We chose eventual consistency over strong consistency because user experience degrades more from 500ms latency than from 1s data staleness. This saves 2 RTTs per request but requires conflict resolution logic."

### Mini-Example Walkthrough — Design a Health-Check Service

**Requirements:** Detect instance failure within 10s; 99.99% detection reliability.

**SLO Contract:** p95 latency ≤ 5s, availability ≥ 99.99%, false positive rate ≤ 0.1%

**Baseline Design:** Scheduler → Ping Target → Report Result → Dashboard

**Stressors:** Network partitions, false positives, checker overload, target flapping, cascading failures

**Resilient Architecture:** Multiple checkers per target + majority vote; exponential backoff; circuit breaker for checker overload

**Observability:** SLI = successful pings / total pings. Alert on checker success rate < 99.99%. Dashboard shows per-target health trends.

**Trade-offs:**  
• More checkers → higher cost but lower miss rate  
• Tighter timeout → faster detection but more false alarms  
• Majority vote → resilience to network issues but delayed detection

### The 7-Step Checklist for Any Design Prompt

1.  Define User Impact → derive SLOs
    
    Start with "What does the user experience when this fails?" Then quantify acceptable failure rates.
    
2.  Draw the Happy Path
    
    Show the minimal viable architecture that meets basic functionality. Don't over-engineer yet.
    
3.  Identify 5 ways it can fail
    
    Hardware faults, software bugs, network issues, overload, human errors. Be specific to your design.
    
4.  Apply reliability patterns to each
    
    Circuit breakers, retries, bulkheads, health checks, graceful degradation, auto-scaling.
    
5.  Decide metrics & dashboards
    
    Define SLIs that directly measure SLOs. Include both user-facing and internal health metrics.
    
6.  Prepare rollout & recovery plan
    
    Canary deployment, feature flags, rollback strategy, incident response, capacity planning.
    
7.  Articulate trade-offs & reasoning
    
    Explain why you chose this approach. What alternatives did you reject and why?
    

### Common Reliability Patterns — Quick Reference

| Failure Mode | Pattern | Example |
| --- | --- | --- |
| Service overload | Circuit Breaker | Stop calling failed service for 30s |
| Transient failures | Retry with Backoff | Retry 3x with exponential delay |
| Dependency failure | Graceful Degradation | Show cached data instead of real-time |
| Traffic spikes | Auto-scaling | Scale out on CPU > 70% for 2 minutes |
| Single point of failure | Replication | Multi-AZ deployment with failover |
| Resource exhaustion | Bulkhead Pattern | Separate thread pools per service |
| Slow dependencies | Timeout + Deadline | Abort requests after 5s |
| Bad deployments | Canary Rollout | Deploy to 5% → 25% → 100% |

### Common SLO Patterns by Service Type

```
🔗 API Service SLOs:
  • Availability: 99.99% (HTTP 2xx responses)
  • Latency: p95 ≤ 200ms, p99 ≤ 500ms
  • Error Rate: ≤ 0.01% (excludes 4xx client errors)

💾 Database SLOs:
  • Availability: 99.95% (successful connections)
  • Query Latency: p95 ≤ 10ms (simple queries)
  • Data Durability: 99.999999999% (11 nines)

📱 Frontend SLOs:
  • Page Load: p95 ≤ 2s (Time to Interactive)
  • Availability: 99.9% (successful page loads)
  • Error Rate: ≤ 0.1% (JS errors, API failures)

🔄 Async Processing SLOs:
  • Processing Latency: p99 ≤ 5 minutes
  • Success Rate: 99.9% (successful job completion)
  • Throughput: ≥ 1000 jobs/minute sustained
```

### What Interviewers Score

✅ Green Flags:

-   Starts with user impact and SLOs before architecture
-   Systematically identifies failure modes and mitigations
-   Defines concrete metrics and observability strategy
-   Articulates trade-offs with clear reasoning
-   Shows understanding of CAP theorem and consistency models
-   Demonstrates production operational thinking

🚩 Red Flags:

-   Designs components before clarifying requirements
-   Ignores failure modes or hand-waves reliability
-   No metrics or observability plan
-   Can't explain why they chose one approach over alternatives
-   Ignores operational complexity or cost implications
-   Uses buzzwords without understanding trade-offs

### Reflection Prompts — Test Your SRE Mindset

1.  When you design a system, do you start with user impact or with components?
2.  How would you express your current project's SLO contract in one sentence?
3.  Which failure mode from your last incident was unmeasured by any SLI?
4.  If your system had 10x more traffic tomorrow, what would break first?
5.  What's one trade-off you made recently where you chose reliability over cost?

### Practice Template — Fill This Out for Any Problem

```
Problem Statement: ________________________________

1. USER IMPACT & SLOs:
   - What does failure look like to users?
   - Availability target: ____%
   - Latency target: p95 ≤ ___ms, p99 ≤ ___ms  
   - Throughput requirement: ___ RPS

2. HAPPY PATH DESIGN:
   [Draw your basic architecture here]

3. FAILURE MODES (list 5):
   - ________________________________
   - ________________________________  
   - ________________________________
   - ________________________________
   - ________________________________

4. RELIABILITY PATTERNS:
   [Map each failure mode to a mitigation]

5. OBSERVABILITY:
   - Key SLI: _________________________
   - Alert conditions: ________________
   - Dashboard metrics: _______________

6. ROLLOUT PLAN:
   - Deployment strategy: _____________
   - Rollback criteria: _______________
   - Capacity planning: _______________

7. TRADE-OFFS:
   - Chose _______ over _______ because _______
   - Cost implication: ________________
   - Operational complexity: __________
```
