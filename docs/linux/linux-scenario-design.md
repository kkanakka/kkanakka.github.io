---
title: "Linux Scenario Design"
slug: /linux/linux-scenario-design
sidebar_position: 5
sidebar_label: "Linux Scenario Design"
description: "Linux Scenario Design"
---
On this page

-   [0.Overview](#overview)
-   [1.Distributed kernel patch mgmt](#patch-mgmt)
-   [Pipeline architecture](#patch-pipeline)
-   [Per-node agent](#patch-agent)
-   [Rollback & partition](#patch-rollback)
-   [2.Real-time data processing](#realtime)
-   [Tuning stack](#rt-stack)
-   [DPDK vs XDP](#rt-dpdk-xdp)
-   [Latency budget](#rt-budget)
-   [3.Ceph cluster scaling](#ceph)
-   [Optimization axes](#ceph-axes)
-   [Rebalancing strategy](#ceph-rebalance)
-   [4.K8s dynamic resources](#k8s-resources)
-   [Spec → cgroup → kernel](#k8s-flow)
-   [Closed-loop autoscaling](#k8s-loop)
-   [5.eBPF — how it works](#ebpf)
-   [Program anatomy](#ebpf-anatomy)
-   [Verifier & JIT](#ebpf-verifier)
-   [Production uses](#ebpf-uses)
-   [6.Common patterns](#patterns)
-   [7.Glossary](#glossary)

[Linux Systems Guide](/docs/linux/linux-systems-guide) / [Scenario design](#)

Detailed walkthroughs of four canonical Linux/SRE design scenarios, plus how eBPF underpins modern Linux observability and networking. Each section explains why every design choice exists.

Updated May 2026 Reading time ~45 min Audience: senior engineers, SREs preparing for system design

## Overview [#](#overview) {#overview}

System-design interview scenarios test whether you can layer optimizations across hardware, kernel, runtime, and orchestration without losing track of trade-offs. The four scenarios in this doc cover the canonical shape of those questions:

1.  **Distributed kernel patch management** — fault-tolerant rollout across thousands of nodes.
2.  **Real-time data processing** — sub-millisecond p99 with kernel and userspace tuning.
3.  **Distributed storage scaling** — Ceph 2× workload increase across four optimization axes.
4.  **Dynamic K8s resource allocation** — pod spec to cgroup to kernel enforcement, closed-loop.

Each scenario follows the same pattern: *declare* intent, *translate* to kernel primitives, *enforce* at runtime, *observe* via metrics, *adjust* through automation. The diagrams below show that pattern explicitly. Section 5 covers eBPF because it underpins observability and tooling for all four scenarios.

> Every design choice in this doc has a "why this exists" explanation. If a knob doesn't earn its place by removing a specific failure mode or unblocking a specific signal, it shouldn't be in the design.

## 1\. Distributed kernel patch management [#](#patch-mgmt) {#patch-mgmt}

**Problem statement.** Roll out a kernel patch to 10,000 production nodes safely. Constraints: zero or near-zero workload downtime, survive network partitions during rollout, detect bad patches early, instant rollback, full audit trail.

The naïve answer is "Ansible-push to everyone." That fails because (a) push doesn't survive partitions, (b) there's no progressive blast-radius control, and (c) one bad patch kills the fleet before you notice. The senior answer is a *pull-based, idempotent agent network* behind a progressive rollout pipeline.

### Pipeline architecture [#](#patch-pipeline) {#patch-pipeline}

Figure 1 kernel-patch-rollout-pipeline.svg

<img src="/diagrams/linux-scenario-design/1.svg" alt="linux-scenario-design diagram 1" class="doc-diagram" />

Figure 1 — End-to-end pipeline. Build once, deploy progressively, validate continuously, roll back instantly.

#### Why each piece exists

-   **Sigstore/cosign signing** — kernel packages are high-value attack targets. An unsigned package on the repo could compromise every node. Every agent verifies the signature against a hardware-backed key before `rpm`/`dpkg` runs. No signature → install rejected, alert generated.
-   **Pre-canary (5 nodes, your team's own)** — this catches the "didn't even boot" class of bugs without affecting any tenants. 4 h is enough to confirm the new kernel loads, drivers initialize, and the agent comes back online.
-   **Canary 24 h soak** — captures one full diurnal cycle: peak hours, batch jobs at midnight, backups at 03:00, cron storms on the hour. A 4-hour canary will miss every cron-driven workload pattern.
-   **Stage 48 h soak with 1,000 nodes** — large enough sample to surface rare bugs (1-in-200 hardware variants), small enough that a bad patch can be rolled back before user impact.
-   **Rack-aware production rolling** — a typical rack has shared power and switches. Patching two nodes in the same rack simultaneously means a coincident failure looks like a patch bug; isolating to one node per rack rules that out.
-   **Drain before patch** — the kernel reboot or kexec briefly takes the node offline. Tenant workloads must move first. For databases this means leader-step-down + snapshot before patching.

### Per-node agent [#](#patch-agent) {#patch-agent}

The agent on each node is what makes this resilient. It's a state machine that *polls* the orchestrator for desired state, reconciles locally, and survives orchestrator-unreachable conditions.

Figure 2 patch-agent-state-machine.svg

<img src="/diagrams/linux-scenario-design/2.svg" alt="linux-scenario-design diagram 2" class="doc-diagram" />

Figure 2 — The agent's state machine. Pull-based polling means partitions are tolerated naturally.

#### Why each transition exists

-   **Pull-based polling, not push.** A push-based system loses commands on partition. Pull-based: the agent retries the orchestrator forever — when the partition heals, it picks up where it left off. No commands are ever "lost in transit."
-   **Cached desired state for 24 h.** When the orchestrator is unreachable, the agent doesn't panic — it continues with what it last knew was approved. After 24 h of silence, it pages on-call (the orchestrator might be permanently dead).
-   **Idempotent reconcile.** Re-running the patch tool on an already-patched node is a no-op. This means agents can crash and restart without breaking anything; the state machine self-recovers.
-   **Verify-signature-first.** Even if a malicious actor compromised the orchestrator and pushed a fake desired-state, agents reject any package without a valid cosign signature.
-   **Post-checks before declaring success.** A patch that "applied successfully" might still produce a node that boots but misbehaves (driver bug, slow networking, kernel oops). OBHC (Out-of-Band Health Checks) compare metrics against a control group of unpatched siblings.

### Rollback & partition handling [#](#patch-rollback) {#patch-rollback}

Three rollback tiers exist because failures vary in severity:

| Tier | Mechanism | Time | When |
| --- | --- | --- | --- |
| 1 | `kexec --load /boot/vmlinuz-PREV && kexec --exec` | ~1 s | New kernel boots but misbehaves at runtime. Avoids reboot — just loads previous kernel image and jumps to it. |
| 2 | `grub-set-default 1 && reboot` | ~60 s | New kernel panics or hangs. Full reboot through previous grub entry — works because grub keeps the previous entry intact. |
| 3 | IPMI/iDRAC PXE re-image | ~10 min | Filesystem corruption or bootloader damage. Orchestrator triggers PXE boot, re-provisions from scratch. |

Quorum-aware sequencing for stateful services

Stateless web servers can drain → patch → undrain freely. Stateful services need quorum awareness:

-   **etcd/Consul (3 replicas):** never patch more than 1 at a time.
-   **etcd/Consul (5 replicas):** never patch more than 2 at a time.
-   **Kafka (RF=3):** never patch more than 1 broker per topic-partition leader at a time.
-   **MySQL/Postgres primary-replica:** patch replicas first; failover before patching primary.

Violating quorum during patch = data loss or split brain.

## 2\. Real-time data processing [#](#realtime) {#realtime}

**Problem statement.** Process streaming data with hard p99 latency requirement under 1 ms. Examples: market data feeds, telemetry ingestion, ML inference for ad bidding. The naïve answer ("optimize the application") fails because the kernel and hardware will introduce latency you can't fix in user code.

The senior answer: real-time isn't a single optimization. It's a *stack of mutually-reinforcing tunings* from hardware up through application. Skip any layer and the latency tail comes back.

### Tuning stack [#](#rt-stack) {#rt-stack}

Figure 3 realtime-tuning-stack.svg

<img src="/diagrams/linux-scenario-design/3.svg" alt="linux-scenario-design diagram 3" class="doc-diagram" />

Figure 3 — Five layers of optimization. Each removes a class of latency source. Skipping a layer leaves a long tail.

#### Why each layer exists

Hardware: disable C-states

CPU sleep states (C1, C2, C6) save power by halting cores. Wake-up latency is 30–100+ μs. For a sub-millisecond budget, one wake-up blows the SLO. Pin `processor.max_cstate=1` in boot params.

Hardware: pin CPU frequency

Frequency scaling adds variable latency as the CPU ramps up. Set governor to `performance` and disable Intel SpeedStep/AMD Cool'n'Quiet in BIOS.

Hardware: disable hyper-threading on isolated cores

SMT lets two threads share one physical core. Sharing means contention — your latency-critical thread suddenly stalls because a sibling thread on the same core is using the FPU. Disable SMT for predictability.

Kernel: PREEMPT\_RT

Lets the kernel preempt itself nearly anywhere. Without it, kernel work (filesystem walks, memory reclaim) can hold the CPU for several ms while your real-time task waits.

Kernel: isolcpus=2-15

Removes cores 2–15 from the scheduler's general pool. The scheduler will not place arbitrary tasks on these cores; only explicit pinning lands jobs there.

Kernel: nohz\_full=2-15

Disables the periodic scheduler tick (1000 Hz default) on these cores. Without it, every millisecond a timer interrupt fires and pollutes your cache. With nohz\_full, the tick is silent when only one runnable task exists.

Runtime: mlockall

Pins the process's memory in RAM so it can never be paged out or evicted. A single page fault during processing takes hundreds of microseconds — fatal for sub-ms budgets.

Runtime: huge pages

2 MB or 1 GB pages instead of 4 KB. A 1 GB working set fits in 512 TLB entries instead of 262,144 — TLB hit rate stays high, address translation stays fast.

### DPDK vs XDP — when to choose which [#](#rt-dpdk-xdp) {#rt-dpdk-xdp}

| Concern | DPDK | XDP |
| --- | --- | --- |
| Latency floor | ~5 μs | ~20 μs |
| CPU cost | One core 100% busy polling | Lower — runs on packet arrival |
| NIC sharing | NIC owned by app exclusively | NIC shared with kernel stack |
| TCP/UDP stack | Bring your own (mTCP, F-Stack) | Kernel stack still works for non-fast-path |
| Programmability | Plain C in userspace | eBPF programs (verified, sandboxed) |
| Use cases | HFT, telco UPF, ultra-low-latency | DDoS scrubbing, load balancing, observability |

### Latency budget breakdown [#](#rt-budget) {#rt-budget}

```
Component                          Latency        Notes
─────────────────────────────────────────────────────────────
NIC DMA → DPDK poll loop           5–10 μs        kernel bypass
Userspace deserialization          5–20 μs        avoid alloc
Business logic                    50–500 μs       your code
Userspace serialization            5–20 μs        pre-allocated buf
DPDK send → NIC DMA                5–10 μs        TX poll
─────────────────────────────────────────────────────────────
Total p99 (typical)              ~70–560 μs       under 1 ms ✓
```

Verify the floor with `cyclictest`:

```
$ cyclictest -p 80 -t 14 -a 2-15 -n -m -D 1h
T: 0 (   PID) P:80 I:1000 C: 3600000 Min: 2 Avg: 4 Max: 18

# Max: 18 μs is the worst-case wake-up latency over 1 hour.
# Below 50 μs sustained = real-time territory.
```

## 3\. Ceph cluster scaling (2× workload) [#](#ceph) {#ceph}

**Problem statement.** A Ceph cluster handling N IOPS / N MB/s needs to handle 2N. Bottleneck could be in disk I/O, network, CPU, memory, or Ceph internals. The interview tests whether you know how to *find* which one before tuning anything.

### Optimization axes [#](#ceph-axes) {#ceph-axes}

Figure 4 ceph-optimization-axes.svg

<img src="/diagrams/linux-scenario-design/4.svg" alt="linux-scenario-design diagram 4" class="doc-diagram" />

none for NVMe scheduler: mq-deadline for HDD readahead = 0 for random I/O deeper nr\_requests for NVMe WAL/DB on NVMe partition data on HDD (hybrid) noatime,nodiratime,discard mount NETWORK separate public + cluster networks 25G bonded NICs per network jumbo frames MTU 9000 rmem\_max / wmem\_max = 128 MB tcp\_congestion\_control = bbr netdev\_max\_backlog = 300000 RSS · NIC IRQ pinning per CPU MEMORY & CPU osd\_memory\_target = 8 GB per OSD NUMA-local OSD placement cgroup per OSD daemon disable THP (random I/O patterns) huge pages for buffer pools pin OSD threads to specific cores avoid cross-socket traffic OSD & CEPH INTERNALS PG count: 100 per OSD PG autoscaler enabled osd\_max\_backfills throttled recovery\_op\_priority < client CRUSH failure domain = rack mClock scheduler for QoS scrub windows in off-peak hours Result: 2× workload, stable p99 latency

Figure 4 — Four optimization axes. Always start with diagnosis; never tune blind.

#### Why each tuning matters

scheduler = none for NVMe

NVMe drives have hardware queues that schedule better than the OS can. The kernel I/O scheduler just adds latency for nothing. `none` = pass-through.

scheduler = mq-deadline for HDD

HDDs have seek latency. `mq-deadline` reorders requests to minimize seeking and respects deadline-based ordering for fairness.

readahead = 0

OSDs do random I/O. Readahead is wasted work — kernel reads pages you don't need. Disable for OSD volumes; enable for sequential workloads (backup volumes).

WAL/DB on NVMe

BlueStore (Ceph's storage engine) writes a Write-Ahead Log and metadata DB on every operation. Putting these on NVMe while keeping data on HDD gives you NVMe metadata speed with HDD capacity. Single biggest hybrid-cluster optimization.

Separate public + cluster networks

Public network = clients ↔ MON/MGR/primary-OSD. Cluster network = OSD ↔ OSD (replication, recovery). Separating them doubles available bandwidth and prevents recovery storms from impacting client I/O.

Jumbo frames (MTU 9000)

Standard MTU is 1500 bytes. Each Ceph object replication writes at least 4 MB — that's ~3000 packets at MTU 1500 vs 500 packets at MTU 9000. Less per-packet overhead, less CPU per byte.

BBR congestion control

Default `cubic` is loss-based — it slows down when packets drop, even if there's bandwidth left. BBR is bandwidth-based — measures actual bottleneck capacity. Better for long-haul, high-bandwidth replication.

osd\_memory\_target = 8 GB

Default 4 GB is too small for serious workloads. BlueStore uses RAM aggressively for caching — onode cache, deferred writes, RocksDB block cache. Doubling memory often doubles throughput.

NUMA-local OSD placement

Pin each OSD to a NUMA node and constrain its memory there. Cross-NUMA memory access is 1.75× slower. With 24+ OSDs per node, this matters.

Disable THP

Transparent Huge Pages compaction stalls processes for milliseconds at random. Ceph's random-access pattern means you never benefit from THP coalescing. `transparent_hugepage=never` in /sys.

PG count: 100 per OSD

Placement Groups are Ceph's unit of distribution. Too few = uneven load. Too many = metadata overhead. The community-recommended sweet spot is 100 PGs per OSD on average. Use `ceph osd pool autoscale-status` to verify.

recovery\_op\_priority < client

When backfilling after adding OSDs, recovery competes with client I/O. Set client priority to 63 (max) and recovery to 1 — clients always win, recovery uses spare capacity only.

CRUSH failure domain = rack

CRUSH map controls replica placement. Setting failure domain to rack ensures the 3 replicas of any object live in 3 different racks — surviving rack-level failures (power, switch, cooling).

### Rebalancing strategy when adding OSDs [#](#ceph-rebalance) {#ceph-rebalance}

Adding capacity to scale 2× triggers backfilling — terabytes of data move across the cluster network for hours or days. This is where production clusters get hurt during scaling.

```
# Throttle aggressively during business hours
ceph config set osd osd_max_backfills 1
ceph config set osd osd_recovery_max_active 1
ceph config set osd osd_recovery_sleep 0.1     # 100ms pause between recovery ops

# Or: pause rebalancing entirely during peak
ceph osd set norebalance
ceph osd set nobackfill
# ... resume off-peak
ceph osd unset norebalance
ceph osd unset nobackfill

# Or: spread incrementally with upmap balancer
ceph balancer mode upmap
ceph balancer on
# Moves ~5% of PGs at a time, automatically
```

## 4\. Dynamic K8s resource allocation [#](#k8s-resources) {#k8s-resources}

**Problem statement.** Pods need CPU and memory. Static allocation wastes capacity (over-provision for safety). Pure dynamic allocation creates instability (resize storms, eviction flapping). The goal is automatic right-sizing while maintaining stability.

### Spec → cgroup → kernel [#](#k8s-flow) {#k8s-flow}

Figure 5 k8s-resource-allocation-flow.svg

<img src="/diagrams/linux-scenario-design/5.svg" alt="linux-scenario-design diagram 5" class="doc-diagram" />

Figure 5 — End-to-end flow with the closed feedback loop on the left. This isn't one-shot configuration — it's continuous control.

#### QoS class behavior at the kernel level

| Class | Conditions | oom\_score\_adj | cgroup files set |
| --- | --- | --- | --- |
| **Guaranteed** | requests == limits, both set | −997 (last to die) | cpu.max + memory.max + (optional) cpuset.cpus |
| **Burstable** | requests < limits, or only one set | 2 to 999 (scaled by request) | cpu.weight + cpu.max + memory.max + memory.high |
| **BestEffort** | no requests, no limits | 1000 (first to die) | (no limits) |

### Closed-loop autoscaling [#](#k8s-loop) {#k8s-loop}

Three autoscaling mechanisms cooperate:

HPA (Horizontal Pod Autoscaler)

Scales replica count based on average utilization or PSI. Best for stateless workloads. Doesn't change per-pod resources.

VPA (Vertical Pod Autoscaler)

Observes actual usage over time, computes p95 + buffer, updates pod's requests/limits. Until 1.27 required pod restart for cgroup changes.

In-place pod resize (1.27+, beta in 1.32)

Kubelet writes new values directly to existing cgroup files. CPU resizes are always live; memory shrinks still need restart (you can't reclaim memory the process is actively using).

Production sweet spot

Set requests = p95 of measured usage + 10–15% buffer for CPU; p95 + 25% buffer for memory. Memory pressure is fatal (OOM); CPU pressure is just slow (throttling). Bias buffers accordingly.

## 5\. eBPF — how it works [#](#ebpf) {#ebpf}

eBPF (extended Berkeley Packet Filter) is the kernel's *safe extensibility mechanism*. It lets you load small programs that run inside the kernel — at IRQ context, syscall entry/exit, scheduler events, network receive — without modifying the kernel or loading kernel modules.

It underpins modern Linux observability and networking: Cilium (CNI), Pixie (auto-instrumentation), bcc/bpftrace (debugging), Falco (runtime security), Katran (Facebook's L4 LB), Hubble (network observability). When you hear "we use eBPF for X," the X is almost always one of: tracing, profiling, network filtering, security policy enforcement, or load balancing.

### Program anatomy [#](#ebpf-anatomy) {#ebpf-anatomy}

Figure 6 ebpf-program-lifecycle.svg

<img src="/diagrams/linux-scenario-design/6.svg" alt="linux-scenario-design diagram 6" class="doc-diagram" />

Figure 6 — eBPF program lifecycle. Compile → verify → JIT → attach. Maps allow shared state with userspace.

### What can hook into eBPF?

| Hook type | Fires when | Use case |
| --- | --- | --- |
| `kprobe` | Any kernel function entry | Trace function call rates, args |
| `kretprobe` | Any kernel function return | Measure latency of kernel functions |
| `uprobe` / `uretprobe` | Userspace function entry/return | Trace application functions without recompiling |
| `tracepoint` | Predefined kernel event (sched, syscall, etc.) | Stable interface for monitoring |
| `XDP` | NIC driver receive (before kernel stack) | DDoS scrubbing, fast load balancing |
| `TC` (traffic control) | Network egress/ingress queue | Container networking, bandwidth shaping |
| `cgroup` | Socket operations within cgroup | Per-container network policy |
| `LSM` | Security hook points | Runtime security policy (Falco, Tetragon) |

### The verifier and JIT — why eBPF is safe [#](#ebpf-verifier) {#ebpf-verifier}

The verifier is the most important kernel component you've never heard of. It's why eBPF is safe to use in production at scale.

Before any eBPF program runs, the verifier does a static analysis:

-   **Walks all execution paths.** Every branch is explored. The verifier knows the type of every register at every point.
-   **Proves termination.** Loops must have a constant upper bound (or use bounded helpers like `bpf_loop()`). No unbounded recursion.
-   **Bounds-checks every memory access.** If your program reads `pkt[10]`, you must have proven (via earlier checks) that the packet is at least 11 bytes. The verifier propagates this constraint through the type system.
-   **Validates helper calls.** eBPF programs can only call kernel-provided helpers — explicit, audited functions like `bpf_map_lookup_elem`. No arbitrary kernel symbol calls.
-   **Stack limit.** eBPF programs use a fixed 8 KB stack. No recursion, no stack overflow.
-   **Instruction limit.** ~1 million instructions per program (raised over time). Forces small, focused programs.

If verification fails, the program is rejected and never executes. **This is what makes eBPF different from kernel modules.** A buggy kernel module crashes the kernel. A buggy eBPF program is rejected at load time.

### Production uses [#](#ebpf-uses) {#ebpf-uses}

Network observability — Cilium / Hubble

Replaces `iptables`\-based CNI with eBPF programs at TC and socket layers. Sees every connection, applies policy in microseconds, exports flow data without packet capture overhead.

Profiling — Pyroscope, Parca, perf

Continuous CPU/memory profiling using eBPF perf events. Stack traces sampled at hardware rate, no instrumentation needed.

Security — Falco, Tetragon

LSM hooks observe every syscall, process exec, file open, network connect. Detect attacks (privilege escalation, container escape) by behavior signature.

Tracing — bcc, bpftrace

Ad-hoc kernel introspection. `bpftrace -e 'kprobe:vfs_read { @ = count(); }'` counts every read syscall. No reboot, no kernel module.

Load balancing — Katran, Cilium L7

XDP-based L4 LB at line rate (10s of millions of pps per core). Replaces dedicated LB hardware in some Facebook/Cloudflare deployments.

### Worked example — counting syscalls

The "hello world" of eBPF is counting how often a syscall fires. Here's it in `bpftrace`:

```
# Count every read() syscall, broken down by process
$ sudo bpftrace -e 'tracepoint:syscalls:sys_enter_read { @[comm] = count(); }'
^C
@[bash]: 12
@[firefox]: 3421
@[node]: 89234

# Measure read() latency distribution
$ sudo bpftrace -e '
  tracepoint:syscalls:sys_enter_read { @start[tid] = nsecs; }
  tracepoint:syscalls:sys_exit_read /@start[tid]/ {
    @lat = hist(nsecs - @start[tid]);
    delete(@start[tid]);
  }'
^C
@lat:
[1K, 2K)               89 |@                                                   |
[2K, 4K)             1245 |@@@@@@@@@@@@@@@@@@@@@                                |
[4K, 8K)             3012 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@|
[8K, 16K)             781 |@@@@@@@@@@@@@                                       |
```

Behind the scenes: bpftrace generated a tiny eBPF program, the verifier accepted it, the JIT compiled it, and it now runs every time the `sys_enter_read` tracepoint fires (millions of times per second on a busy system). Removing it is a Ctrl+C — no reboot, no leak.

## 6\. Common patterns across all scenarios [#](#patterns) {#patterns}

Six patterns recur in every scenario. The interviewer is testing whether you recognize them as universal tools, not scenario-specific tricks.

1.  **Layered design.** No single optimization solves a real problem. Real systems are stacks of mutually-reinforcing primitives. Always sketch the full stack before tuning anything.
2.  **Pull-based, idempotent, stateful agents.** From patch management to cgroup reconciliation, the same pattern: agents that converge to declared state, survive partitions, and can be re-run safely.
3.  **Blast radius management.** Canary → stage → prod is the same shape as gradual VPA recommendations or staged Ceph rebalancing. Limit how much you can break at once.
4.  **Trade-off articulation.** Every choice has a cost. The senior signal is naming the cost upfront, not pretending it doesn't exist.
5.  **Measure first.** "Tune X" is junior. "Identify the bottleneck via Y, then tune the responsible knob" is senior.
6.  **Failure modes designed-in, not bolted on.** Rollback at every stage. Health checks before, during, after. Quorum awareness for stateful systems.

## 7\. Glossary [#](#glossary) {#glossary}

BBR

Bottleneck Bandwidth and Round-trip — Google's TCP congestion control algorithm. Bandwidth-based instead of loss-based; performs better on high-bandwidth long-haul links.

BlueStore

Ceph's storage backend. Stores objects directly on raw block devices (no filesystem in between), uses RocksDB for metadata, supports separate WAL/DB devices.

BPF / eBPF

Berkeley Packet Filter (extended). Lets you run verified, sandboxed programs inside the kernel at hooks. Used for tracing, networking, security.

cAdvisor

Container Advisor — daemon that exposes per-container resource metrics (CPU, memory, network, I/O). Embedded in kubelet.

CFS

Completely Fair Scheduler — Linux's default process scheduler. Allocates CPU time proportionally based on nice/weight values. Doesn't starve.

cgroup

Control group — kernel feature to limit and account resource usage (CPU, memory, I/O, PIDs) for a group of processes. v1 had separate hierarchies per controller; v2 has unified hierarchy.

cosign / Sigstore

Container/artifact signing tool. Generates cryptographic signatures verifiable without a private CA. Standard for supply-chain security.

CRUSH

Controlled Replication Under Scalable Hashing — Ceph's algorithm for deciding where to place data replicas. Avoids central coordination.

DPDK

Data Plane Development Kit — userspace networking framework that bypasses the kernel. Polls the NIC instead of using interrupts.

HPA

Horizontal Pod Autoscaler — Kubernetes controller that scales replica count based on metrics.

IRQ

Interrupt Request — hardware signal to the CPU that needs immediate attention. Threaded IRQs (PREEMPT\_RT) move handling into kernel threads for schedulability.

isolcpus

Boot parameter that excludes specified CPU cores from the scheduler's general pool. Combined with CPU pinning to dedicate cores.

kexec

Linux mechanism to load and run a new kernel from a running kernel without going through bootloader. ~1 second vs ~60 seconds for full reboot.

kprobe / uprobe

Kernel/user probes — eBPF hook types that attach to kernel/userspace functions to fire on entry or return.

mlockall

Syscall to lock all of a process's memory in RAM, preventing swap or paging. Critical for low-latency workloads.

mq-deadline

Multi-queue deadline scheduler — I/O scheduler that prioritizes by deadline. Default for HDDs in modern kernels.

nohz\_full

Boot parameter that disables the periodic scheduler tick on specified cores when only one task is runnable. Reduces interrupt overhead on isolated cores.

NUMA

Non-Uniform Memory Access — multi-socket systems where each CPU has local memory and slower remote memory. Cross-NUMA access is ~1.75× slower.

OOM killer

Out-of-Memory killer — kernel mechanism that terminates processes when memory is exhausted. Picks victim by oom\_score.

OSD

Object Storage Daemon — Ceph process that manages one storage device. Handles replication, recovery, scrubbing.

OBHC

Out-of-Band Health Check — health validation done by an independent system (not the patch agent itself). Compares against control group of unpatched siblings.

PG (Placement Group)

Ceph's unit of replication and distribution. Each object hashes to a PG; each PG maps to a set of OSDs.

PREEMPT\_RT

Linux kernel patch (now mainline since 6.12) that makes nearly all kernel code preemptible. Reduces worst-case latency from ~10 ms to <100 μs.

PSI

Pressure Stall Information — kernel feature exposing how much time tasks spent stalled waiting for CPU/memory/I/O. v2-only.

PXE

Preboot Execution Environment — network boot protocol. Used for bare-metal re-provisioning.

RCU

Read-Copy-Update — kernel synchronization primitive. Allows lockless reads with deferred reclamation. `rcu_nocbs` offloads callbacks off isolated cores.

SR-IOV

Single Root I/O Virtualization — splits a physical NIC into virtual functions, each assignable to a VM/container with near-native performance.

TC (traffic control)

Linux network QoS subsystem. eBPF programs can attach as TC classifiers or actions for fast packet processing.

THP

Transparent Huge Pages — kernel feature that automatically promotes 4 KB pages to 2 MB pages. Compaction stalls cause latency spikes; disable for low-latency or random-I/O workloads.

TLB

Translation Lookaside Buffer — CPU cache for virtual-to-physical address translations. Cold TLB after migration causes 80× latency penalty per memory access.

upmap

Ceph balancer mode that incrementally moves PGs to even out OSD utilization without full rebalancing.

VPA

Vertical Pod Autoscaler — Kubernetes controller that recommends or applies resource changes based on observed usage.

WAL

Write-Ahead Log — durability mechanism. Writes go to WAL first, applied to main data later. BlueStore puts WAL on NVMe for hybrid HDD setups.

XDP

eXpress Data Path — eBPF programs running at the NIC driver layer, before the kernel network stack. Used for DDoS mitigation, fast load balancing.

* * *

**Last updated:** May 2026 · **Reading time:** ~45 min ·
