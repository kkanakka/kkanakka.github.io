---
title: "Scheduling, cgroups & Container Isolation"
slug: /linux/scheduling-cgroups-containers
sidebar_position: 10
sidebar_label: "Scheduling, cgroups & Container Isolation"
description: "Scheduling, cgroups & Container Isolation"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/scheduling-cgroups-containers/sequence.svg" alt="How it works — scheduling-cgroups-containers" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
On this page

-   [1.Overview](#overview)
-   [2.Layer 1 — PREEMPT model](#layer-1)
-   [3.Layer 2 — Scheduling class](#layer-2)
-   [4.Layer 3 — Priority & nice](#layer-3)
-   [5.How they work together](#how-they-work-together)
-   [6.Commands](#commands)
-   [7.Common scenarios](#scenarios)
-   [8.Cgroups v1 vs v2](#cgroups-v1-vs-v2)
-   [9.Container process tree](#process-tree)
-   [10.How limits are enforced](#kernel-enforcement)
-   [11.Namespace internals](#namespace-internals)
-   [12.CPU pinning & NUMA](#cpu-static-numa)
-   [13.TLB & cache effects](#tlb-cache)
-   [14.Key takeaways](#takeaways)

Related

-   
-   [→Processes & Memory](/docs/linux)
-   [→Networking Guide](/docs/linux/linux-networking)

[Linux Systems Guide](/docs/linux) / [Scheduling & Containers](#)

A working reference for understanding how preemption, scheduling classes, priority, cgroups, namespaces, CPU pinning and NUMA cooperate to run containers on Kubernetes.

Updated May 2026 Reading time ~30 min Audience: backend engineers, SREs

## Overview [#](#overview) {#overview}

When a process becomes runnable, three independent layers cooperate to decide if and when it gets the CPU. Each layer answers a different question. Most explanations of Linux scheduling collapse into a single confused blob because these three orthogonal mechanisms get conflated.

-   **Layer 1 — PREEMPT model.** Set once when the kernel is built. Controls how fast the kernel can be interrupted while running its own code.
-   **Layer 2 — Scheduling class.** Set per process. Picks the algorithm that runs the task (real-time vs normal).
-   **Layer 3 — Priority / nice.** Set per process. Ranks peers within the same class.

Figure 1 three-layer-overview.svg

<img src="/diagrams/scheduling-cgroups-containers/1.svg" alt="scheduling-cgroups-containers diagram 1" class="doc-diagram" />

Three independent layers, evaluated together every time the scheduler picks a task.

> PREEMPT model is the kernel's rulebook. Scheduling class is the league you play in. Priority is your rank inside that league.

## Layer 1 — PREEMPT model [#](#layer-1) {#layer-1}

Set once when the kernel is compiled. Controls how quickly the kernel can be interrupted while running its own code on behalf of a syscall. When your application calls `read()` or `write()`, control jumps into the kernel — the preemption model decides whether that kernel code can be paused mid-flight if a higher-priority task suddenly needs the CPU.

| Model | Worst-case latency | Trade-off | Typical user |
| --- | --- | --- | --- |
| `PREEMPT_NONE` | ~10 ms | Best throughput, worst latency | Batch / HPC servers |
| `PREEMPT_VOLUNTARY` | ~1–5 ms | Balanced | Most production servers, K8s |
| `PREEMPT` (full) | < 1 ms | Lower latency, modest throughput cost | Low-latency desktop |
| `PREEMPT_RT` | < 100 μs | Strong guarantees, ~5–15% throughput cost | Audio, trading, industrial control |

Note

Linux 5.12+ ships with `PREEMPT_DYNAMIC`, which lets you switch models at boot via `preempt=none|voluntary|full` on the kernel command line — no recompile needed. `PREEMPT_RT` was merged into mainline in Linux 6.12.

## Layer 2 — Scheduling class [#](#layer-2) {#layer-2}

Each process belongs to exactly one scheduling class. The class determines the algorithm. Classes are organized into two strictly-ordered realms.

### What each class is for

| Class | Behavior | Used for |
| --- | --- | --- |
| `SCHED_DEADLINE` | Explicit timing budget (runtime within period). Admission-controlled. | Industrial control, robotics |
| `SCHED_FIFO` | Runs until it voluntarily blocks or yields. No timeslice. | Audio engines, IRQ threads |
| `SCHED_RR` | Like FIFO but with timeslice (default 100 ms). | Several RT tasks needing fair sharing |
| `SCHED_OTHER` | Default. Handled by CFS. Nice value is the knob. | Everything you've ever launched |
| `SCHED_BATCH` | Like OTHER but treated as CPU-bound — no wake-up boost. | Long compute jobs |
| `SCHED_IDLE` | Only runs when system has nothing else to do. | Lowest-priority background work |

Warning

A buggy `SCHED_FIFO` task in an infinite loop can pin a CPU core and make the system effectively unresponsive. The kernel reserves about 5% of CPU per period (`/proc/sys/kernel/sched_rt_runtime_us`) as a safety net, but treat `chrt -f` as a loaded weapon.

## Layer 3 — Priority & nice [#](#layer-3) {#layer-3}

Once a class is picked, the priority number ranks the task among other members of that same class. The two realms use different scales — **and they go in opposite directions**.

| Scale | Range | Direction | Mnemonic |
| --- | --- | --- | --- |
| RT priority — `chrt` | 1 to 99 | Higher = more urgent | Military rank — bigger number, bigger boss |
| Nice — `nice` / `renice` | −20 to +19 | Lower = more urgent | "Less nice = more selfish" |

### Nice is not a quieter version of RT

A common misconception: assuming `nice -20` makes other processes wait. **It doesn't.** CFS guarantees fairness — every runnable task gets time, just weighted by nice. A `nice -20` task gets ~88% of the CPU when competing against `nice 0`; the `nice 0` task still gets the remaining 12%. Nobody starves.

`SCHED_FIFO` by contrast can take 100% and starve everything else. That's the actual difference, and the actual reason RT exists.

## Commands [#](#commands) {#commands}

### Layer 1 — preemption model

```
# What model is the kernel built with?
uname -v
grep PREEMPT /boot/config-$(uname -r)

# Modern kernels: switch model at boot via GRUB
# add to GRUB_CMDLINE_LINUX in /etc/default/grub:
preempt=none|voluntary|full
```

### Layer 2 — scheduling class

```
# Inspect class & priority of PID 1234
chrt -p 1234

# Set a real-time class
sudo chrt -f 50 ./app           # SCHED_FIFO,  priority 50
sudo chrt -r 50 ./app           # SCHED_RR,    priority 50

# Back to normal
sudo chrt -o -p 0 1234          # SCHED_OTHER
```

### Layer 3 — nice (CFS only)

```
# Launch with a nice value
nice -n -10 ./game              # needs sudo for negatives
nice -n  19 ./backup

# Change a running process
renice -n  10 -p 1234
sudo renice -n -5  -p 1234
```

## How they work together [#](#how-they-work-together) {#how-they-work-together}

The scheduler evaluates them in order:

1.  **Class first.** Real-time classes always win over normal classes.
2.  **Priority within class.** Among peers in the same class, priority/nice is the tiebreaker.
3.  **Preemption model limits how fast this happens.** Even if a high-priority task becomes runnable, it might have to wait for the current kernel operation to reach a preemption point.

Figure 2 scheduler-runqueues.svg

<img src="/diagrams/scheduling-cgroups-containers/2.svg" alt="scheduling-cgroups-containers diagram 2" class="doc-diagram" />

Each CPU has runqueues for each scheduling class. RT beats CFS. Within each queue, priority rules.

## Common scenarios [#](#scenarios) {#scenarios}

### 1\. Audio dropouts on a music workstation

**Problem:** Your audio recording software is getting hiccups and dropouts.

**Solution:** Run the audio engine with real-time priority:

```
sudo chrt -f 80 /usr/bin/jackd -R -dalsa
```

This puts the audio daemon in `SCHED_FIFO` with RT priority 80, so it can preempt almost anything to meet deadlines.

### 2\. Batch job hogging the desktop

**Problem:** A data processing script is making your desktop sluggish.

**Solution:** Run it with `SCHED_BATCH` and a high nice value:

```
chrt -b 0 nice -n 15 ./data_processor.py
```

The batch class prevents it from getting wakeup boosts, and `nice 15` lowers its priority among normal tasks.

### 3\. Kubernetes node running general workloads

**Problem:** You want predictable performance without risking system lockups.

**Solution:** Most distributions use `PREEMPT_VOLUNTARY` by default — this gives ~1–5ms latency with good throughput. Pods run as `SCHED_OTHER` unless they request specific priority classes.

Kubernetes `PriorityClass` maps to Linux nice values via the kubelet's `--system-reserved-cgroup`.

### 4\. Container escape attempt detection

**Problem:** A container is trying to monopolize CPU and starve the system.

**Solution:** The kernel's RT throttling mechanism (`/proc/sys/kernel/sched_rt_runtime_us`) reserves CPU for non-RT tasks. Even a malicious `SCHED_FIFO` process can't completely starve the system — but it can still cause severe disruption. Use cgroups for robust limits.

## Cgroups v1 vs v2 [#](#cgroups-v1-vs-v2) {#cgroups-v1-vs-v2}

Control groups (cgroups) provide resource limiting and accounting. Two versions exist with different philosophies:

| Aspect | Cgroups v1 | Cgroups v2 |
| --- | --- | --- |
| **Hierarchy** | Multiple hierarchies, one per controller | Single unified hierarchy |
| **Process placement** | Process can be in different cgroups for different controllers | Process belongs to exactly one cgroup |
| **Controller organization** | Independent: `/sys/fs/cgroup/memory`, `/sys/fs/cgroup/cpu` | Unified: `/sys/fs/cgroup` |
| **Memory+CPU accounting** | Separate, can be inconsistent | Coordinated, consistent view |
| **Thread vs process** | Individual threads can be in different cgroups | All threads of a process must be in same cgroup |
| **Complex configurations** | Flexible but can create conflicts | Simpler, more predictable |
| **Current status** | Legacy but widely used | Preferred for new deployments |

Tip

You can check which version is active: `mount | grep cgroup`. If you see multiple mounts like `cgroup on /sys/fs/cgroup/memory`, it's v1. If you see `cgroup2 on /sys/fs/cgroup`, it's v2.

### Key controllers and their purpose

| Controller | Controls | Key files |
| --- | --- | --- |
| `memory` | RAM usage, OOM behavior | `memory.limit_in_bytes`, `memory.usage_in_bytes` |
| `cpu` | CPU time shares, throttling | `cpu.shares`, `cpu.cfs_period_us`, `cpu.cfs_quota_us` |
| `cpuset` | CPU and memory node placement | `cpuset.cpus`, `cpuset.mems` |
| `blkio` | Block I/O bandwidth | `blkio.throttle.read_bps_device` |
| `pids` | Number of processes/threads | `pids.max`, `pids.current` |
| `devices` | Device access permissions | `devices.allow`, `devices.deny` |

## Container process tree [#](#process-tree) {#process-tree}

When you run `docker run ubuntu bash`, several layers of process isolation are involved. Here's what the process tree looks like:

Figure 3 container-process-tree.svg

<img src="/diagrams/scheduling-cgroups-containers/3.svg" alt="scheduling-cgroups-containers diagram 3" class="doc-diagram" />

The same processes appear with different PIDs in different namespaces. Cgroups provide the resource limits regardless of namespace view.

## How limits are enforced [#](#kernel-enforcement) {#kernel-enforcement}

### CPU limits — Throttling

The CFS (Completely Fair Scheduler) implements CPU limits via time-based throttling:

-   `cpu.cfs_period_us` — Time period (default: 100,000μs = 100ms)
-   `cpu.cfs_quota_us` — CPU time allowed in each period

If a cgroup is configured with `period=100ms` and `quota=50ms`, it gets 50% CPU. Once it uses its 50ms in any 100ms window, all processes in that cgroup get throttled until the next period begins.

```
# See throttling stats
cat /sys/fs/cgroup/cpu/docker/<container-id>/cpu.stat

nr_periods 12345
nr_throttled 678
throttled_time 98765432100  # nanoseconds spent throttled
```

### Memory limits — OOM killing

When a cgroup hits its memory limit:

1.  **Reclaim:** Try to free up memory (flush page cache, swap out pages)
2.  **OOM kill:** If reclaim fails, pick a process in the cgroup to kill
3.  **OOM score:** Process with highest `oom_score` gets killed first

The OOM killer picks victims using several factors:

-   Memory usage (higher = more likely to be killed)
-   `oom_score_adj` value (you can set this per-process)
-   Runtime (longer-running processes are slightly protected)

```
# Check a process's OOM score
cat /proc/1234/oom_score
cat /proc/1234/oom_score_adj

# Make a process less likely to be OOM killed
echo -500 > /proc/1234/oom_score_adj

# See cgroup memory usage
cat /sys/fs/cgroup/memory/docker/<container-id>/memory.usage_in_bytes
cat /sys/fs/cgroup/memory/docker/<container-id>/memory.limit_in_bytes
```

Warning

Setting `oom_score_adj` to -1000 makes a process "OOM-immune" — it will never be killed even if the system runs out of memory. Only use this for critical system processes like init or kernel threads.

## Namespace internals [#](#namespace-internals) {#namespace-internals}

Namespaces provide isolation by giving processes different views of global resources:

| Namespace | Isolates | Example |
| --- | --- | --- |
| `PID` | Process IDs | Container sees its own PID 1 |
| `NET` | Network stack | Container has its own interfaces, routing table |
| `MNT` | Filesystem mounts | Container sees different root filesystem |
| `UTS` | Hostname and domain | Container can have different hostname |
| `IPC` | Inter-process communication | Separate shared memory, semaphores, message queues |
| `USER` | User and group IDs | Root inside container ≠ root on host |
| `CGROUP` | Cgroup filesystem view | Container sees different cgroup hierarchy |

### PID namespace deeper dive

PID namespaces are hierarchical. A process can see PIDs in its own namespace and all descendant namespaces, but not parent or sibling namespaces.

Figure 4 pid-namespace-hierarchy.svg

<img src="/diagrams/scheduling-cgroups-containers/4.svg" alt="scheduling-cgroups-containers diagram 4" class="doc-diagram" />

PID namespace hierarchy. Processes can see their own namespace and all child namespaces, but not siblings.

## CPU pinning & NUMA [#](#cpu-static-numa) {#cpu-static-numa}

On NUMA (Non-Uniform Memory Access) systems, CPU cores are grouped into nodes. Memory access is fastest to "local" memory on the same node, slower to remote nodes.

Figure 5 numa-topology.svg

<img src="/diagrams/scheduling-cgroups-containers/5.svg" alt="scheduling-cgroups-containers diagram 5" class="doc-diagram" />

NUMA topology with two nodes. Memory access is faster within the same node than across the interconnect.

### CPU affinity and isolation

You can control which CPUs a process is allowed to run on:

```
# Check current CPU affinity of PID 1234
taskset -p 1234
taskset -cp 1234                # CPU list format

# Set affinity to CPUs 0-3 (NUMA node 0)
taskset -cp 0-3 1234

# Launch a process pinned to specific CPUs
taskset -c 2,3 ./compute_intensive_app

# Using cgroups cpuset controller
echo "0-3" > /sys/fs/cgroup/cpuset/my_group/cpuset.cpus
echo "0"   > /sys/fs/cgroup/cpuset/my_group/cpuset.mems  # NUMA node 0 memory
echo 1234  > /sys/fs/cgroup/cpuset/my_group/cgroup.procs
```

### CPU isolation techniques

| Method | Purpose | Implementation |
| --- | --- | --- |
| `isolcpus` | Remove CPUs from general scheduling | Kernel boot param: `isolcpus=2-7` |
| `nohz_full` | Disable timer interrupts on dedicated CPUs | Boot param: `nohz_full=2-7` |
| `rcu_nocbs` | Move RCU callbacks off isolated CPUs | Boot param: `rcu_nocbs=2-7` |
| `cpuset` | Runtime CPU assignment via cgroups | Echo CPU list to cpuset.cpus |

Note

For true CPU isolation (e.g., for low-latency trading or real-time control), you typically need all three boot parameters together plus careful application design to avoid syscalls and page faults.

## TLB & cache effects [#](#tlb-cache) {#tlb-cache}

When a process migrates between CPU cores, it loses several important caches:

Figure 6 cpu-cache-hierarchy.svg

<img src="/diagrams/scheduling-cgroups-containers/6.svg" alt="scheduling-cgroups-containers diagram 6" class="doc-diagram" />

When a process migrates to a different CPU core, L1/L2 caches and TLB are cold. Only L3 cache (if shared) has warm data.

### What gets lost during migration

| Cache/Buffer | Size | Miss penalty | Impact |
| --- | --- | --- | --- |
| L1 instruction cache | 32KB | ~3-12 cycles | Code execution slowdown |
| L1 data cache | 32KB | ~3-12 cycles | Data access slowdown |
| L2 cache | 256KB-1MB | ~12-35 cycles | Moderate performance hit |
| TLB | 1500+ entries | ~100-300 cycles | Virtual memory translation slowdown |
| Branch predictor | ~64KB | ~10-20 cycles | Control flow misprediction |

### TLB (Translation Lookaside Buffer)

The TLB caches virtual-to-physical address translations. When a process moves to a new core, the TLB is cold and every memory access initially requires a expensive page table walk.

```
# Check TLB miss rate
perf stat -e dTLB-misses,iTLB-misses,page-faults ./your_app

# Monitor process migrations
perf stat -e migrations,cs ./your_app

# See huge page usage (reduces TLB pressure)
cat /proc/meminfo | grep -i huge
grep -E "AnonHugePages|HugePages" /proc/*/smaps
```

Tip

Huge pages (2MB or 1GB instead of 4KB) dramatically reduce TLB pressure. A 2MB huge page covers 512× more address space than a regular page, meaning far fewer TLB entries needed for large memory applications.

## Key takeaways [#](#takeaways) {#takeaways}

### For application developers

-   **Don't set real-time priorities unless you understand the risks.** `SCHED_FIFO` can hang your system.
-   **Use nice values judiciously.** Nice only affects `SCHED_OTHER` tasks competing against each other.
-   **Memory limits trigger OOM kills, CPU limits trigger throttling.** Design your applications to handle both gracefully.
-   **CPU pinning helps latency-sensitive workloads** but reduces overall system flexibility.

### For SREs and platform teams

-   **Monitor throttling and OOM events.** They're often early signals of resource contention.
-   **Understand your PREEMPT model.** `PREEMPT_VOLUNTARY` is the sweet spot for most server workloads.
-   **Use cgroups v2 for new deployments.** The unified hierarchy is simpler and more predictable.
-   **NUMA awareness matters for large applications.** Memory locality can impact performance significantly.
-   **Container limits don't replace proper application design.** They're a safety net, not a performance optimization.

### For Kubernetes users

-   **Resource requests and limits map to cgroups.** Requests affect scheduling, limits trigger enforcement.
-   **QoS classes control OOM kill order.** Guaranteed pods are protected from BestEffort pod OOM kills.
-   **Node pressure eviction is separate from cgroup limits.** Both can trigger pod restarts.
-   **CPU pinning requires static CPU manager policy** and integer CPU requests.
