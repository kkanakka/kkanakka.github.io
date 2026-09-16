---
title: "Ch 1: Reliable, Scalable & Maintainable"
slug: /ddia/ddia-ch1
sidebar_position: 1
sidebar_label: "Ch 1: Reliable, Scalable & Maintainable"
description: "Ch 1: Reliable, Scalable & Maintainable"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/ddia-ch1/sequence.svg" alt="How it works — ddia-ch1" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
The three pillars every data-intensive system must master — with interview-focused diagrams, real-world case studies from Twitter, Netflix, and Amazon.

Data Intensive Systems • Chapter 1 • Interview Guide

[Home](/) [Ch 2: Data Models](/docs/ddia/ddia-ch2) [Ch 3: Storage & Retrieval](/docs/ddia/ddia-ch3)

<a id="toc"></a>

## Table of Contents

1.  [What Are Data-Intensive Systems?](#sec-1)
    -   [The 5 Building Blocks](#sec-1-building-blocks)
    -   [Composite Data Systems](#sec-1-composite)
2.  [Reliability](#sec-2)
    -   [Fault vs Failure](#sec-2-faults)
    -   [Hardware Faults](#sec-2-hardware)
    -   [Software Faults](#sec-2-software)
    -   [Human Errors](#sec-2-human)
3.  [Scalability](#sec-3)
    -   [Describing Load — Twitter Fan-Out](#sec-3-load)
    -   [Describing Performance — Percentiles](#sec-3-perf)
    -   [Tail Latency Amplification](#sec-3-tail)
    -   [Scaling Up vs Scaling Out](#sec-3-coping)
4.  [Maintainability](#sec-4)
    -   [Operability](#sec-4-ops)
    -   [Simplicity](#sec-4-simple)
    -   [Evolvability](#sec-4-evolve)
5.  [Interview Questions & Talking Points](#sec-5)

<a id="sec-1"></a>

Section 1

## What Are Data-Intensive Systems?

Most applications today are **data-intensive**, not compute-intensive. The bottleneck is the amount of data, its complexity, and the speed at which it changes — not raw CPU power.

**Interview Framing:** When an interviewer says "design X," they're asking you to compose these five building blocks into a system that's reliable, scalable, and maintainable. Start every answer by identifying which blocks you need.

### The 5 Building Blocks {#sec-1-building-blocks}

<img src="/diagrams/ddia-ch1/1.svg" alt="ddia-ch1 diagram 1" class="doc-diagram" />

The five standard building blocks of data-intensive applications, all governed by the three pillars.

### Composite Data Systems {#sec-1-composite}

Modern applications combine multiple tools behind a single API. You become both an application developer *and* a data system designer.

<img src="/diagrams/ddia-ch1/2.svg" alt="ddia-ch1 diagram 2" class="doc-diagram" />

A composite data system: the API hides implementation details. The app code keeps cache, index, and queue in sync with the primary database.

**Interview Tip (Meta/Google/Netflix):** When asked "Design X," always draw this composite pattern first. Show the interviewer you understand that behind every API there are multiple data systems that must stay consistent.

[↑ Back to Contents](#toc)

<a id="sec-2"></a>

Section 2

## Reliability MetaNetflixGoogle

A system is reliable if it continues to work correctly even when things go wrong. "Working correctly" means:

-   Performs the expected function at the expected performance level
-   Tolerates user mistakes and unexpected usage
-   Prevents unauthorized access and abuse

### Fault vs Failure {#sec-2-faults}

<img src="/diagrams/ddia-ch1/3.svg" alt="ddia-ch1 diagram 3" class="doc-diagram" />

A fault is a component-level deviation; a failure is system-level service loss. Good design prevents faults from cascading into failures.

### Hardware Faults {#sec-2-hardware}

10-50 yr

Hard disk MTTF

1/day

Disk failure in a 10K-disk cluster

RAID

Disk redundancy

Rolling

Upgrades with zero downtime

#### Modern Approach: Software Fault Tolerance

Cloud platforms (AWS, GCP) prioritize elasticity over single-machine reliability. VMs can disappear without warning. Systems must tolerate loss of entire machines, enabling rolling upgrades without downtime.

### Software Faults — Systematic Errors {#sec-2-software}

Unlike hardware faults (random, independent), software faults are **correlated** — they can take down many nodes simultaneously.

<img src="/diagrams/ddia-ch1/4.svg" alt="ddia-ch1 diagram 4" class="doc-diagram" />

Three categories of faults: hardware (random), software (systematic), and human (most frequent).

### Mitigating Human Errors {#sec-2-human}

**Interview Answer Framework (Netflix Chaos Engineering):** Netflix pioneered **Chaos Monkey** — deliberately injecting faults to exercise fault-tolerance machinery. If you can't survive a random process kill, you'll definitely fail under real faults. This is a great talking point when asked "How do you ensure reliability?"

| Strategy | Example | Asked At |
| --- | --- | --- |
| Minimize error opportunities | Well-designed APIs, good abstractions | All FAANG |
| Decouple mistake zones from failure zones | Sandbox / staging environments | Meta, Google |
| Thorough testing at every level | Unit → integration → chaos testing | Netflix, Google |
| Quick recovery | Fast rollback, canary deploys, feature flags | Meta, Netflix |
| Detailed monitoring & telemetry | Metrics, error rates, early warning | All FAANG |

[↑ Back to Contents](#toc)

<a id="sec-3"></a>

Section 3

## Scalability MetaNetflixGoogle

Scalability is **not** a one-dimensional label ("X is scalable"). It means asking: *"If the system grows in a particular way, what are our options for coping?"*

### Describing Load — The Twitter Fan-Out Problem {#sec-3-load}

Load is described by **load parameters**: requests/sec, read/write ratio, cache hit rate, fan-out degree. Twitter's scaling challenge wasn't tweet volume — it was **fan-out**.

4.6K/s

Tweet writes (avg)

12K/s

Tweet writes (peak)

300K/s

Timeline reads

~75

Avg followers/user

<img src="/diagrams/ddia-ch1/5.svg" alt="ddia-ch1 diagram 5" class="doc-diagram" />

Twitter's evolution: from query-time joins (v1) to pre-computed fan-out (v2) to a hybrid approach (current). This is a classic interview question at Meta, Google, and Netflix.

**Interview Power Move:** When asked "Design Twitter/Instagram Feed," mention all three approaches and explain *why* the hybrid exists. The key insight: the distribution of followers per user is the critical load parameter — it determines fan-out cost.

### Describing Performance — Percentiles {#sec-3-perf}

Don't use averages. Use **percentiles** (p50, p95, p99, p999).

<img src="/diagrams/ddia-ch1/6.svg" alt="ddia-ch1 diagram 6" class="doc-diagram" />

Response time distribution showing percentile thresholds. The median (p50) is what typical users experience; p99/p999 affect your most valuable customers.

| Percentile | Meaning | Use Case |
| --- | --- | --- |
| **p50 (median)** | Half of requests are faster | Typical user experience |
| **p95** | 95% of requests are faster | SLO target for most services |
| **p99** | 99% of requests are faster | Important for SLAs |
| **p999** | 99.9% of requests are faster | Amazon internal services target |

#### Latency vs Response Time

**Response time** = what the client sees (service time + network + queueing). **Latency** = time a request waits before being handled. They're *not* synonyms.

### Tail Latency Amplification {#sec-3-tail}

When a single user request fans out to multiple backend services in parallel, the overall response time is determined by the **slowest** backend call.

<img src="/diagrams/ddia-ch1/7.svg" alt="ddia-ch1 diagram 7" class="doc-diagram" />

Tail latency amplification: one slow backend call (487ms) determines the entire end-user response time, even when all other calls are fast.

**Google Interview Insight:** With N parallel backend calls, the probability of hitting a slow tail increases dramatically. If each call has a 1% chance of being slow (p99), with 100 parallel calls, **63% of requests** will be slow. This is why Google obsesses over tail latency.

### Scaling Up vs Scaling Out {#sec-3-coping}

<img src="/diagrams/ddia-ch1/8.svg" alt="ddia-ch1 diagram 8" class="doc-diagram" />

In practice, most architectures use a pragmatic mix: scale up for databases (until forced), scale out for stateless services.

#### Elastic Scaling

-   Auto-add resources on load increase
-   Good for unpredictable workloads
-   Netflix, Uber use this heavily

#### Manual Scaling

-   Human analyzes capacity, adds nodes
-   Simpler, fewer operational surprises
-   Better for predictable loads

**Key Interview Statement:** "There is no magic scaling sauce. An architecture for 100K req/s at 1KB each looks very different from 3 req/min at 2GB each — even though they have the same throughput." Always ask about the *shape* of the load first.

[↑ Back to Contents](#toc)

<a id="sec-4"></a>

Section 4

## Maintainability MetaGoogle

The majority of software cost is in **ongoing maintenance**, not initial development. Good design minimizes pain for future engineers.

⚙

#### Operability

Make it easy for ops teams to keep the system running. Good monitoring, automation, documentation, predictable behavior.

◈

#### Simplicity

Remove *accidental* complexity. Use good abstractions. SQL hides disk structures; high-level languages hide machine code.

⇄

#### Evolvability

Make changes easy. Requirements shift constantly — new features, platforms, regulations. Also called extensibility or plasticity.

<img src="/diagrams/ddia-ch1/9.svg" alt="ddia-ch1 diagram 9" class="doc-diagram" />

The three sub-pillars of maintainability. In interviews, show you think beyond "it works today" to "it works in 3 years with 10x the team."

### Operability in Practice {#sec-4-ops}

Good operations means: runtime visibility (metrics, dashboards), automation (CI/CD, auto-scaling), machine independence (rolling upgrades without downtime), clear documentation, and good defaults with escape hatches.

### Simplicity — The Abstraction Weapon {#sec-4-simple}

**Accidental complexity** = complexity that isn't inherent to the problem but arises from the implementation. The best tool against it is **abstraction**. SQL hides on-disk data structures. Programming languages hide machine code. MapReduce hides distributed execution.

### Evolvability {#sec-4-evolve}

The ease of modifying a system is linked to its simplicity and abstractions. Simple systems are easier to change. At data-system scale, this is called **evolvability** (vs "agility" at code level). Think: how would you refactor Twitter's timeline from Approach 1 to Approach 2?

[↑ Back to Contents](#toc)

<a id="sec-5"></a>

Section 5

## Interview Questions & Talking Points

#### Q1: "How would you design a system that's fault-tolerant?" GoogleNetflix

**Answer framework:** Distinguish fault from failure. Apply redundancy at every layer (data replication, service redundancy, multi-AZ). Use chaos engineering to validate. Netflix Chaos Monkey randomly kills processes; Google uses DiRT (Disaster Recovery Testing). Emphasize that you *prefer tolerating faults* over preventing them.

#### Q2: "How do you measure the performance of a service?" MetaGoogle

**Answer framework:** Don't use averages — use percentiles. p50 for typical user, p95/p99 for SLOs, p999 for high-value customers. Mention tail latency amplification in fan-out architectures. Amazon observed 100ms increase = 1% revenue loss. Use histograms (HdrHistogram, t-digest), never average percentiles across machines.

#### Q3: "Design Twitter's home timeline" MetaNetflix

**Answer framework:** Start with Approach 1 (fan-out on read), explain why it fails at scale (300K reads/s needing JOINs). Move to Approach 2 (fan-out on write, pre-computed caches). Discuss celebrity problem (30M followers = 30M cache writes). Present hybrid solution. Key load parameter: follower distribution.

#### Q4: "Scale up or scale out?" GoogleMeta

**Answer framework:** It depends on the workload! Stateless services → scale out easily. Stateful databases → prefer scale up until forced to distribute. Good architectures use a pragmatic mix. Elastic auto-scaling for unpredictable loads; manual for predictable. Mention shared-nothing architecture and its tradeoffs (network partitions, consensus protocols).

#### Q5: "What makes a system maintainable?" MetaGoogle

**Answer framework:** Three sub-pillars: Operability (good monitoring, runbooks, automation), Simplicity (remove accidental complexity via abstractions), Evolvability (TDD, refactoring, loose coupling). The majority of software cost is maintenance, not initial development. Config errors by humans are the #1 cause of outages.

<img src="/diagrams/ddia-ch1/10.svg" alt="ddia-ch1 diagram 10" class="doc-diagram" />

Quick reference: the three pillars of data-intensive systems with key facts for interviews.

[↑ Back to Contents](#toc)
