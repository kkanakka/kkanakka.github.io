---
title: "Linux OS Deep Dive"
slug: /linux/nvidia-linux-os
sidebar_position: 8
sidebar_label: "Linux OS Deep Dive"
description: "Linux OS Deep Dive"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/nvidia-linux-os/sequence.svg" alt="How it works — nvidia-linux-os" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
[Home](#) / Linux OS Deep Dive

60 minutes • Kernel Internals, Advanced Networking, Memory, Storage, Troubleshooting, System Design

#### On This Page

-   [Sec 1: Knowledge Check](#s1)
-   [Kernel Preemption](#kernel)
-   [Kernel Architecture Diagram](#kernel)
-   [Scheduling: Three Layers](#sched-layers)
-   [cgroups & Namespaces](#cgroups)
-   [cgroups v1 vs v2](#cgv1v2)
-   [Container Process Tree](#container-tree)
-   [Kernel Limit Enforcement](#kernel-enforce)
-   [Namespace Internals](#ns-internals)
-   [CPU Pinning & NUMA](#cpu-pin-numa)
-   [TLB & Cache Effects](#tlb-cache)
-   [TCP Stack & Congestion](#tcp)
-   [Low-Latency Tuning](#lowlat)
-   [NUMA & Memory](#numa)
-   [Huge Pages](#thp)
-   [Filesystems](#fs)
-   [I/O Schedulers](#iosched)
-   [Sec 2: Problem Solving](#s2)
-   [System Freeze](#freeze)
-   [Disk Latency](#disklatency)
-   [Memory Fragmentation](#memfrag)
-   [Packet Drops](#pktdrop)
-   [Sec 3: Design](#s3)
-   [Patch Management](#patchmgmt)
-   [Real-Time Processing](#realtime)
-   [Scaling Ceph](#ceph)
-   [K8s Resources](#k8sresource)

## Section 1: Advanced Knowledge Check (10 min) {#s1}

Kernel internals, networking, memory, storage

### 1.1 Kernel Preemption & Real-Time Workloads {#kernel}

Question

Explain the role of kernel preemption and its impact on real-time workloads.

Linux Kernel Preemption Models

<img src="/diagrams/nvidia-linux-os/1.svg" alt="nvidia-linux-os diagram 1" class="doc-diagram" />

-   **Preemption** = ability for the scheduler to interrupt running kernel code to run a higher-priority task
-   **Impact on real-time:** Without preemption, a high-priority task can be blocked for milliseconds waiting for kernel code to finish. With PREEMPT\_RT, worst-case latency drops to <100μs
-   **Trade-off:** More preemption = better latency but reduced throughput (more context switches, cache thrashing)
-   **K8s relevance:** etcd benefits from low-latency I/O. API server latency spikes often trace back to kernel scheduling. Production servers typically use PREEMPT\_VOLUNTARY.

#### How the Linux Kernel Works — Architecture Deep Dive

Before understanding preemption, you need to understand the kernel's layered architecture. Everything a container does — every CPU cycle, memory allocation, network packet, disk write — goes through the kernel via **system calls**.

Linux Kernel Architecture: User Space ↔ Kernel Space

<img src="/diagrams/nvidia-linux-os/2.svg" alt="nvidia-linux-os diagram 2" class="doc-diagram" />

#### Why Preemption Matters — What Happens During a Context Switch

When the kernel preempts a running task to schedule a higher-priority one, here's what happens at the hardware level:

1.  **Timer interrupt fires** (every 1-4ms, configured by `CONFIG_HZ` = 250 or 1000). The CPU jumps to the interrupt handler.
2.  **Scheduler checks**: is there a higher-priority task waiting? If PREEMPT\_NONE, the answer is always "wait until syscall return." If PREEMPT\_RT, the answer is "preempt now."
3.  **Save CPU state**: all registers (general purpose, FPU/SSE/AVX, segment registers) are saved to the current task's `thread_struct` in the kernel's `task_struct`.
4.  **Switch page tables**: load the new task's `mm_struct` → write to `CR3` register → TLB flush (partial, thanks to PCID/ASID).
5.  **Restore CPU state**: load new task's registers from its `thread_struct`.
6.  **Return to new task**: CPU resumes execution in the new process's context.

**Cost:** ~2-5μs per context switch (dominated by TLB flush + cache pollution). With PREEMPT\_RT, this happens more often → more overhead, but guaranteed low latency.

**Key kernel data structures (from *The Linux Programming Interface*):**

| Structure | What It Holds | Where |
| --- | --- | --- |
| `task_struct` | Everything about a process/thread: PID, state (RUNNING/SLEEPING/ZOMBIE), priority, scheduling class, cgroup pointers, namespace pointers, memory descriptor, file descriptor table, signal handlers, credentials. ~6 KB per task. | Kernel slab cache |
| `mm_struct` | Process address space: page table root (pgd), VMA list (text, data, heap, stack, mmap regions), RSS counters, OOM score. Shared between threads of same process. | Pointed to by task\_struct |
| `thread_struct` | CPU register state saved during context switch: general regs, FPU/SSE/AVX state, segment registers, debug registers. Architecture-specific. | Inside task\_struct |
| `cgroup` | Resource controller state: CPU bandwidth (quota/period), memory limit, I/O limits, PID limit. Hierarchical — child cgroups inherit parent limits. | `/sys/fs/cgroup/` |
| `nsproxy` | Namespace references for a task: pointers to pid\_namespace, net\_namespace, mnt\_namespace, uts\_namespace, ipc\_namespace, user\_namespace, cgroup\_namespace. | Inside task\_struct |

**Commands to check and change preemption:**

```
# Check current kernel preemption model
uname -v                                    # shows PREEMPT in version string if enabled
cat /boot/config-$(uname -r) | grep PREEMPT # exact config
# CONFIG_PREEMPT_NONE=y      → server (throughput)
# CONFIG_PREEMPT_VOLUNTARY=y → desktop (balanced)  ← most production K8s
# CONFIG_PREEMPT=y           → low-latency desktop
# CONFIG_PREEMPT_RT=y        → real-time (PREEMPT_RT patch)

# Check scheduler stats for a process
cat /proc/<pid>/sched                       # nr_switches, wait_sum, exec_runtime
cat /proc/<pid>/status | grep voluntary     # voluntary vs involuntary context switches
# voluntary_ctxt_switches: process yielded (I/O wait, sleep)
# nonvoluntary_ctxt_switches: kernel preempted the process (timeslice expired)

# Check scheduling policy of a process
chrt -p <pid>                               # shows policy (SCHED_OTHER, SCHED_FIFO, SCHED_RR)
chrt -f -p 50 <pid>                         # set FIFO priority 50 (needs CAP_SYS_NICE)

# Check CFS scheduler parameters
cat /proc/sys/kernel/sched_latency_ns        # target latency for CFS (default 6ms)
cat /proc/sys/kernel/sched_min_granularity_ns # min timeslice (default 0.75ms)
cat /proc/sys/kernel/sched_nr_migrate        # max tasks to migrate per balance (default 32)
```

### 1.1b Linux Scheduling: The Three Layers {#sched-layers}

Core Concept

When a process becomes runnable, three independent layers cooperate to decide if and when it gets the CPU. Most explanations collapse these into a single confused blob.

-   **Layer 1 — PREEMPT model.** Set once when the kernel is built. Controls how fast the kernel can be interrupted while running its own code.
-   **Layer 2 — Scheduling class.** Set per process. Picks the algorithm that runs the task (real-time vs normal).
-   **Layer 3 — Priority / nice.** Set per process. Ranks peers within the same class.

Analogy

PREEMPT model is the kernel's rulebook. Scheduling class is the league you play in. Priority is your rank inside that league.

Three-Layer Overview

<img src="/diagrams/nvidia-linux-os/3.svg" alt="nvidia-linux-os diagram 3" class="doc-diagram" />

#### Layer 1 — PREEMPT Model (Deep Dive)

Set once when the kernel is compiled. Controls how quickly the kernel can be interrupted while running its own code on behalf of a syscall. When your application calls `read()` or `write()`, control jumps into the kernel — the preemption model decides whether that kernel code can be paused mid-flight if a higher-priority task suddenly needs the CPU.

Preemption Models Reacting to High-Priority Task Arrival

<img src="/diagrams/nvidia-linux-os/4.svg" alt="nvidia-linux-os diagram 4" class="doc-diagram" />

| Model | Worst-case latency | Trade-off | Typical user |
| --- | --- | --- | --- |
| `PREEMPT_NONE` | ~10 ms | Best throughput, worst latency | Batch / HPC servers |
| `PREEMPT_VOLUNTARY` | ~1–5 ms | Balanced | Most production servers, K8s |
| `PREEMPT` (full) | < 1 ms | Lower latency, modest throughput cost | Low-latency desktop |
| `PREEMPT_RT` | < 100 μs | Strong guarantees, ~5–15% throughput cost | Audio, trading, industrial control |

PREEMPT\_DYNAMIC (5.12+)

Linux 5.12+ ships with `PREEMPT_DYNAMIC`, which lets you switch models at boot via `preempt=none|voluntary|full` on the kernel command line — no recompile needed. `PREEMPT_RT` was merged into mainline in Linux 6.12.

#### About `cond_resched()`

Kernel developers sprinkle calls to `cond_resched()` and `might_sleep()` inside long kernel paths (filesystem walks, large memory operations). Under `PREEMPT_VOLUNTARY`, these become “if a higher-priority task is waiting, yield now.” This is **kernel-side code, not application code** — you only encounter these calls if you write a kernel module or driver.

#### Layer 2 — Scheduling Class

Each process belongs to exactly one scheduling class. The class determines the algorithm. Classes are organized into two strictly-ordered realms:

Scheduling Classes: Two Realms

<img src="/diagrams/nvidia-linux-os/5.svg" alt="nvidia-linux-os diagram 5" class="doc-diagram" />

| Class | Behavior | Used for |
| --- | --- | --- |
| `SCHED_DEADLINE` | Explicit timing budget (runtime within period). Admission-controlled. | Industrial control, robotics |
| `SCHED_FIFO` | Runs until it voluntarily blocks or yields. No timeslice. | Audio engines, IRQ threads |
| `SCHED_RR` | Like FIFO but with timeslice (default 100 ms). | Several RT tasks needing fair sharing |
| `SCHED_OTHER` | Default. Handled by CFS. Nice value is the knob. | Everything you've ever launched |
| `SCHED_BATCH` | Like OTHER but treated as CPU-bound — no wake-up boost. | Long compute jobs |
| `SCHED_IDLE` | Only runs when system has nothing else to do. | Lowest-priority background work |

Warning: SCHED\_FIFO is a loaded weapon

A buggy `SCHED_FIFO` task in an infinite loop can pin a CPU core and make the system unresponsive. The kernel reserves ~5% of CPU per period (`/proc/sys/kernel/sched_rt_runtime_us`) as a safety net, but treat `chrt -f` with extreme care.

#### Layer 3 — Priority & Nice

Once a class is picked, the priority number ranks the task among other members of that same class. The two realms use different scales — **and they go in opposite directions**.

Priority Scales: Opposite Numbering, Same Concept

<img src="/diagrams/nvidia-linux-os/6.svg" alt="nvidia-linux-os diagram 6" class="doc-diagram" />

| Scale | Range | Direction | Mnemonic |
| --- | --- | --- | --- |
| RT priority — `chrt` | 1 to 99 | Higher = more urgent | Military rank — bigger number, bigger boss |
| Nice — `nice` / `renice` | −20 to +19 | Lower = more urgent | “Less nice = more selfish” |

#### Nice is NOT a quieter version of RT

Common misconception: assuming `nice -20` makes other processes wait. **It doesn’t.** CFS guarantees fairness — every runnable task gets time, just weighted by nice. A `nice -20` task gets ~88% of the CPU when competing against `nice 0`; the `nice 0` task still gets the remaining 12%. Nobody starves.

`SCHED_FIFO` by contrast can take 100% and starve everything else. That’s the actual difference, and the actual reason RT exists.

| Behavior | nice −20 (SCHED\_OTHER) | SCHED\_FIFO 50 |
| --- | --- | --- |
| Will I get CPU? | Yes, eventually | Yes, immediately |
| How much? | Big share, never all | Up to 100% |
| Do others run too? | Yes — smaller slices | No, until I block |
| Worst-case wait | Could be ms (no bound) | Microseconds (bounded) |
| Predictable? | No | Yes |

#### How the Three Layers Work Together

When the kernel needs to pick the next task to run, it walks through the layers in this order:

Scheduler Decision Flow

<img src="/diagrams/nvidia-linux-os/7.svg" alt="nvidia-linux-os diagram 7" class="doc-diagram" />

Summary

Layer 2 decides who should run. Layer 3 ranks peers within a class. Layer 1 controls how fast the kernel can act on the decision.

#### Scheduling Commands Reference

**Layer 1 — Preemption model:**

```
# What model is the kernel built with?
uname -v
grep PREEMPT /boot/config-$(uname -r)

# Modern kernels: switch model at boot via GRUB
# add to GRUB_CMDLINE_LINUX in /etc/default/grub:
preempt=none|voluntary|full

# Install a low-latency or RT kernel
sudo apt install linux-image-lowlatency
sudo apt install linux-image-rt-amd64
```

**Layer 2 — Scheduling class:**

```
# Inspect class & priority of PID 1234
chrt -p 1234

# Set a real-time class
sudo chrt -f 50 ./app           # SCHED_FIFO,  priority 50
sudo chrt -r 50 ./app           # SCHED_RR,    priority 50
sudo chrt -d --sched-runtime 5000000 \
              --sched-deadline 20000000 \
              --sched-period   20000000 0 ./app   # DEADLINE

# Back to normal
sudo chrt -o -p 0 1234          # SCHED_OTHER

# Show valid priority ranges per policy
chrt -m
```

**Layer 3 — Nice (CFS only):**

```
# Launch with a nice value
nice -n -10 ./game              # needs sudo for negatives
nice -n  19 ./backup

# Change a running process
renice -n  10 -p 1234
sudo renice -n -5  -p 1234

# See class + priority + nice for everything
ps -eo pid,cls,pri,ni,cmd --sort=-pri | head -20
# CLS: TS=OTHER, FF=FIFO, RR=RoundRobin, B=BATCH, IDL=IDLE
```

**systemd unit file:**

```
[Service]
ExecStart=/usr/bin/my-app
Nice=-5
CPUSchedulingPolicy=fifo        # other, batch, idle, fifo, rr
CPUSchedulingPriority=50
IOSchedulingClass=best-effort
IOSchedulingPriority=2
CPUAffinity=2 3
```

#### Common Scheduling Scenarios

**Trading bot vs nightly backup on the same host:**

```
sudo chrt -f 80 ./trading-bot          # RT, beats everything normal
nice  -n  19 ionice -c 3 ./backup.sh   # maximally polite
```

The kernel walks classes in order, finds the bot in `SCHED_FIFO`, runs it. The backup only progresses when the bot is blocked. With `PREEMPT_VOLUNTARY` you get ~1 ms reaction; with `PREEMPT_RT` you get sub-100 μs.

**Audio engine that must never glitch:**

```
sudo chrt -f 80 ./audio-engine         # RT FIFO, top priority
sudo chrt -f 60 ./plugin-thread        # RT FIFO, lower
nice  -n -5 ./gui-thread               # normal but aggressive
```

**Production K8s node — the boring answer:**

```
# Most K8s nodes: PREEMPT_VOLUNTARY kernel, no chrt anywhere.
# Use nice values for sensitive components like etcd:
[Service]
Nice=-10
IOSchedulingClass=best-effort
IOSchedulingPriority=2
```

Avoid SCHED\_FIFO on shared K8s nodes

A buggy `SCHED_FIFO` task can starve `kubelet`, `containerd`, and kube-proxy. The whole node falls over and gets marked `NotReady`. Use nice values for sensitive workloads instead.

**Long-running batch compute:**

```
sudo chrt -b 0 ./big-build             # SCHED_BATCH
nice  -n  10 ./big-build               # or just be polite
```

`BATCH` tells CFS “I’m CPU-bound, don’t bother giving me wake-up boosts.” Better cache behavior for compute-heavy work.

#### The Restaurant Analogy

Imagine a busy restaurant. One head waiter, many tables. This is your CPU.

The Restaurant = Your CPU

<img src="/diagrams/nvidia-linux-os/8.svg" alt="nvidia-linux-os diagram 8" class="doc-diagram" />

#### The Friday Night Story

Three guests arrive Friday night:

-   **Alice** (`SCHED_FIFO 80`, VIP) walks in. Host puts her in the VIP room.
-   **Bob** (`nice -10`, main hall) is loud and waves often.
-   **Carol** (`nice +10`, main hall) reads quietly.

The waiter is currently in the kitchen, deep in a soufflé (= kernel syscall). Alice snaps her fingers. What happens?

| Kitchen Rule | What Happens | Alice waits… |
| --- | --- | --- |
| `PREEMPT_NONE` | Waiter finishes the soufflé first. Alice fumes, but she’s still next — ahead of Bob and Carol. | ~10 minutes |
| `PREEMPT_VOLUNTARY` | Waiter checks between steps, abandons soufflé in ~1 minute, serves Alice. | ~1 minute |
| `PREEMPT_RT` | Waiter drops the whisk. Alice is served in seconds. | Seconds |

In **all three cases**, Alice is served before Bob and Carol — that’s **SCHED**.  
Bob and Carol’s order amongst themselves is decided by their loudness — that’s **nice**.  
How fast Alice gets her drink — that’s **PREEMPT**.

#### Where You’d Use Each in Production

| Problem | Which Knob | Command |
| --- | --- | --- |
| My batch job is hogging the server | **NICE** — politely yield to other normal tasks | `nice -n 19 ./backup.sh` |
| My audio software glitches occasionally | **SCHED** — move into VIP room, beat all normal tasks | `sudo chrt -f 80 ./audio` |
| My audio still glitches under heavy disk I/O | **PREEMPT** — make the waiter drop the spoon faster | `sudo apt install linux-image-rt-amd64` |
| My web server should respond consistently fast | **NICE only** — don’t go RT, risk of starving the system | `Nice=-5` in systemd unit |
| My robot arm controller MUST hit a 1 ms deadline | **ALL THREE** — RT kernel + DEADLINE policy + budget | PREEMPT\_RT kernel + `chrt -d` with runtime/period |

The One-Line Memory Hook

**SCHED puts you in a room. NICE makes you louder in your room. PREEMPT decides how fast the waiter abandons the kitchen for you.**

#### Key Takeaways

1.  **Three layers, three questions.** PREEMPT model = how fast can the kernel be interrupted. Scheduling class = which algorithm. Priority = rank inside the algorithm.
2.  **RT realm always beats normal realm.** Even `SCHED_FIFO` priority 1 outranks nice −20. The realms stack; they don’t compete on a shared scale.
3.  **Nice and RT priority go in opposite directions.** RT: bigger number wins. Nice: smaller number wins.
4.  **Nice cannot starve.** CFS guarantees every runnable task gets time. If you need run-to-completion semantics, you need RT.
5.  **RT can starve.** A buggy `SCHED_FIFO` task can pin a CPU. Use `chrt -f` deliberately.
6.  **`cond_resched()` is kernel code, not application code.** As an app developer you only set policy and priority.
7.  **Most production servers run `PREEMPT_VOLUNTARY` + `SCHED_OTHER`.** Reach for RT only when latency is genuinely unbounded otherwise.
8.  **Cgroups v2 is one tree, all controllers.** v1 had separate hierarchies per controller. K8s 1.25+ defaults to v2 with the systemd cgroup driver.
9.  **CPU limits throttle, memory limits kill.** CPU is compressible (you can get less). Memory is incompressible (once allocated, you must release it). That asymmetry shapes container behavior.
10.  **Containers are processes, not objects.** The kernel has no “container” concept. A container is a process with custom namespaces + cgroup + capabilities + seccomp + pivoted root.
11.  **Namespaces virtualize lookups, not enforce boundaries.** Container’s `ps` doesn’t fail to see host PIDs — it never sees them because `/proc` is filtered by PID namespace.
12.  **The shim is host-side; the container is guest-side.** `containerd-shim-runc-v2` runs in host namespaces. The container process is its child, in isolated namespaces.
13.  **CPU Manager static + Topology Manager align to one NUMA node.** Required for ML, telco, and HFT — cross-NUMA access doubles memory latency.
14.  **Pinning isn’t just about CPU sharing — it’s about cache and TLB warmth.** A migrated process pays for cold L1/L2/L3 and TLB misses. Combine pinning with huge pages for stable p99.

### 1.2 cgroups & Namespaces for Container Isolation {#cgroups}

Container Isolation: cgroups + Namespaces

<img src="/diagrams/nvidia-linux-os/9.svg" alt="nvidia-linux-os diagram 9" class="doc-diagram" />

#### How the Kernel Enforces cgroups — The Full Chain

An interviewer will ask: "When kubelet sets `cpu.max` to `200000 100000`, what actually enforces that limit inside the kernel?" Here's the complete chain:

K8s Pod → kubelet → cgroups → Kernel Enforcement

<img src="/diagrams/nvidia-linux-os/10.svg" alt="nvidia-linux-os diagram 10" class="doc-diagram" />

**Commands to inspect cgroup enforcement:**

```
# Find a container's cgroup
crictl inspect <container-id> | grep cgroupsPath
# → kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod<uid>.slice/cri-containerd-<id>.scope

# Check CPU throttling
cat /sys/fs/cgroup/kubepods.slice/.../cpu.stat
# usage_usec 123456789     ← total CPU time used
# nr_periods 50000         ← number of 100ms periods
# nr_throttled 1200        ← times cgroup was throttled (hit cpu.max)
# throttled_usec 600000000 ← total time spent throttled

# Check memory usage and OOM events
cat /sys/fs/cgroup/kubepods.slice/.../memory.current   # current usage in bytes
cat /sys/fs/cgroup/kubepods.slice/.../memory.max       # limit
cat /sys/fs/cgroup/kubepods.slice/.../memory.events
# low 0    high 0    max 45    oom 3    oom_kill 3    oom_group_kill 0

# See which cgroup a process belongs to
cat /proc/<pid>/cgroup    # shows cgroup path
# 0::/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod<uid>.slice/...
```

#### Namespaces Deep Dive: User Space vs Kernel Namespaces

**"User namespace" ≠ "user space."** This is a common interview confusion. Let me clarify:

| Concept | What It Is | Example |
| --- | --- | --- |
| **User space** | CPU Ring 3. Where all applications run. Cannot access hardware directly. Must use syscalls to ask the kernel for anything. Opposite of "kernel space" (Ring 0). | `nginx`, `kubelet`, `bash` — all run in user space |
| **Kernel space** | CPU Ring 0. Where the kernel runs. Full hardware access. Manages memory, scheduling, devices, networking. Code here can crash the entire machine. | Page fault handler, TCP stack, NVMe driver |
| **Kernel namespace** | A kernel feature (since Linux 2.6.24+) that gives a process an *isolated view* of a system resource. Each namespace type isolates one resource. 8 types exist. | `pid ns` makes PID 1 inside container; `net ns` gives container its own IP |
| **User namespace** | One specific type of kernel namespace. Maps UID/GID inside container to different UID/GID on host. Enables **rootless containers**: root (UID 0) inside container = unprivileged user (UID 100000) on host. | `unshare -U` creates a new user namespace |

**Commands to inspect and create namespaces:**

```
# See all namespaces for a process
ls -la /proc/<pid>/ns/
# cgroup → cgroup:[4026531835]
# ipc    → ipc:[4026532589]
# mnt    → mnt:[4026532587]
# net    → net:[4026532592]
# pid    → pid:[4026532590]
# user   → user:[4026531837]
# uts    → uts:[4026532588]

# Compare namespaces: same inode = same namespace
readlink /proc/1/ns/net       # host network namespace
readlink /proc/<pid>/ns/net   # container's network namespace (different inode)

# Enter a container's network namespace
nsenter -t <pid> -n ip addr   # see container's network interfaces

# Create a new namespace manually
unshare --pid --mount --fork bash   # new PID + mount namespace
unshare -U -r id                    # new user namespace (UID 0 inside, unprivileged outside)

# How runc creates a container (simplified)
# 1. clone(CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWUTS | CLONE_NEWIPC)
# 2. Set cgroup limits (write to /sys/fs/cgroup/...)
# 3. pivot_root to container's rootfs (overlayfs)
# 4. Drop capabilities, apply seccomp filter
# 5. exec() the container entrypoint
```

### 1.2b Cgroups v1 vs v2 {#cgv1v2}

Core Concept

Cgroups are the kernel's resource accounting and limiting mechanism. Namespaces hide things; cgroups limit consumption. Two generations exist: v1 (legacy, multi-hierarchy) and v2 (unified, default since K8s 1.25+).

#### v1: separate hierarchy per controller

```
/sys/fs/cgroup/
├── cpu/                          # one tree per controller
│   ├── tasks
│   ├── cpu.cfs_quota_us
│   ├── cpu.cfs_period_us
│   └── cpu.shares
├── memory/                       # completely separate tree
│   ├── memory.limit_in_bytes
│   └── memory.usage_in_bytes
├── cpuset/
├── blkio/
└── pids/                         # 12+ separate hierarchies
```

#### v2: unified hierarchy

```
/sys/fs/cgroup/
├── cgroup.controllers            # available controllers
├── cgroup.subtree_control        # enabled for children
├── cgroup.procs                  # PIDs in root
└── kubepods.slice/
    ├── kubepods-guaranteed.slice/
    │   └── kubepods-pod_abc.slice/
    │       ├── cgroup.procs      # container PIDs
    │       ├── cpu.max           # "200000 100000" = 2 cores
    │       ├── cpu.weight        # CFS share weight
    │       ├── cpu.stat          # usage, throttling stats
    │       ├── memory.max        # hard limit
    │       ├── memory.current    # current RSS
    │       ├── memory.events     # OOM events counter
    │       ├── io.max            # I/O bandwidth limit
    │       ├── pids.max          # max processes
    │       └── cpuset.cpus       # pinned CPU cores
    ├── kubepods-burstable.slice/
    └── kubepods-besteffort.slice/
```

#### File mapping between v1 and v2

| Purpose | cgroup v1 | cgroup v2 |
| --- | --- | --- |
| CPU hard limit | `cpu.cfs_quota_us` + `cpu.cfs_period_us` | `cpu.max` (combined) |
| CPU share/weight | `cpu.shares` (2–262144) | `cpu.weight` (1–10000) |
| CPU usage stats | `cpuacct.usage` | `cpu.stat` |
| Memory limit | `memory.limit_in_bytes` | `memory.max` |
| Memory usage | `memory.usage_in_bytes` | `memory.current` |
| OOM events | `memory.oom_control` | `memory.events` |
| Process list | `tasks` or `cgroup.procs` | `cgroup.procs` only |
| I/O limit | `blkio.throttle.*` | `io.max` |

Detect which version

Run `mount | grep cgroup`. If you see `cgroup2 on /sys/fs/cgroup type cgroup2` you're on v2. If you see multiple `cgroup on /sys/fs/cgroup/<controller>` entries, you're on v1.

#### Why v2 — production-blocking gaps in v1

| Problem | v1 behavior | v2 fix |
| --- | --- | --- |
| **Atomic OOM at container boundary** | Kernel picks one process by `oom_score` and kills it. Container left half-broken — workers gone, parent alive, kubelet doesn’t restart. | `memory.oom.group=1` kills every process in the cgroup atomically. Container exits cleanly. |
| **Soft memory limits (Memory QoS)** | Only hard limit. Either you fit or you OOM. | `memory.high` applies reclaim pressure before `memory.max`. K8s Memory QoS uses this. |
| **PSI for noisy-neighbor detection** | No way to measure stall time waiting for CPU/memory/I/O. | `cpu.pressure`, `memory.pressure`, `io.pressure` per cgroup. Drives node pressure eviction. |
| **I/O accounting** | Page-cache writeback runs in `kworker` — charges to wrong cgroup. | Pages tagged with dirtying cgroup; writeback charges correctly. |
| **memory.stat lock contention** | `smaps_rollup` walks VMAs under lock. Multi-GB JVM heaps cause latency spikes. | `memory.stat` per cgroup, no per-process VMA traversal. |
| **systemd device permissions** | Reloads corrupt device permissions in v1’s separate hierarchy. Pods lose device access. | Unified hierarchy eliminates the conflict. |
| **Inconsistent membership** | Process in `cpu/group-A` but `memory/group-B` — different cgroups per controller. | One tree, one membership. All controllers at the process’s single cgroup. |
| **Thread-level confusion** | Threads of one process in different cgroups, breaking memory accounting. | Process granularity by default. Threaded subtrees require explicit opt-in. |

#### memory.oom.group — the killer feature

On v1, when a container hits its memory limit, the OOM killer picks **one process** (highest `oom_score`) and SIGKILLs it. Other processes keep running. Container looks “alive” to kubelet (PID 1 still up) — silent partial failure.

```
# v1 OOM behavior
container hits memory.max
  → OOM killer picks ONE process (e.g., a worker thread)
  → that process dies, parent + siblings keep running
  → container looks "alive" to kubelet (PID 1 still up)
  → silent partial failure: half-broken state

# v2 with memory.oom.group=1
container hits memory.max
  → kernel kills EVERY process in the cgroup atomically
  → container fully terminates with clean exit
  → kubelet restarts the pod cleanly
```

For databases (TiDB, Postgres), query engines (Trino, Spark executors), or any multi-process container, the v1 behavior produces operational nightmares — pods stuck in degraded state that monitoring can’t detect.

#### Memory QoS — graceful pressure instead of cliff-edge OOM

| File | Behavior |
| --- | --- |
| `memory.low` | Best-effort protection — kernel avoids reclaiming from this cgroup if pressure is low elsewhere. |
| `memory.high` | Soft limit — kernel applies reclaim pressure (slowing the cgroup) but does NOT kill. |
| `memory.max` | Hard limit — OOM kill if exceeded. |

K8s Memory QoS (KEP-2570, beta 1.27+) sets `memory.high` at the pod’s memory request and `memory.max` at its limit. Usage between request and limit → reclaim pressure → pod slows naturally. Crosses limit → OOM kill with atomic `memory.oom.group`. None of this is possible on v1.

### 1.2c Container Process Tree {#container-tree}

What does the process tree look like for a K8s pod? Tracing a Guaranteed nginx pod with `cpu: 2, memory: 2Gi`:

Host Process Tree vs Container View

<img src="/diagrams/nvidia-linux-os/11.svg" alt="nvidia-linux-os diagram 11" class="doc-diagram" />

**The role of the shim:** `containerd-shim-runc-v2` bridges containerd and the container process. It stays alive even if containerd restarts, owns the container’s stdio/TTY, reaps zombie children, and reports exit codes. The shim runs in **host namespaces**; the container runs in **its own set**.

### 1.2d How the Kernel Enforces Limits {#kernel-enforce}

Two completely different mechanisms enforce CPU vs memory limits. Understanding them explains why CPU limits cause throttling but memory limits cause kills.

#### CPU limits: throttling via CFS bandwidth

The kernel tracks a “runtime budget” per cgroup that refills every period. When budget runs out, all tasks are marked unrunnable until the next period.

```
# Simplified kernel logic (kernel/sched/fair.c):
# On every scheduler tick (~1 ms with HZ=1000):
update_curr()                  # update vruntime
account_cfs_rq_runtime(rq, delta_exec)
                               # subtract from cfs_b->runtime
if (cfs_b->runtime <= 0)
    throttle_cfs_rq(cfs_rq)    # freeze all tasks in this cgroup

# At end of period, hrtimer fires:
distribute_cfs_runtime()       # refill quota
unthrottle_cfs_rq()            # tasks runnable again
```

```
$ cat /sys/fs/cgroup/.../pod-abc/cpu.stat
usage_usec        1234567890
nr_periods        4321
nr_throttled      42        # times the cgroup ran out of quota
throttled_usec    1500000   # total time throttled (1.5 sec)
```

If `nr_throttled` climbs steadily, your CPU limit is too tight. **Nothing is killed.**

#### Memory limits: charging and OOM

Every page allocation runs through the memory cgroup charging path:

```
# Simplified kernel logic (mm/memcontrol.c):
mem_cgroup_charge(page, mm, gfp_mask)
  → try_charge(memcg, gfp_mask, nr_pages)
  → Walk up the cgroup tree, increment counters at each level
    for each level:
      if (page_counter_try_charge(&mc->memory, nr_pages, &counter))
          continue;
      # Hit memory.max — try to reclaim
      reclaimed = try_to_free_mem_cgroup_pages(mc, nr_pages);
      if (!reclaimed) → OOM kill (mem_cgroup_out_of_memory)
```

```
$ cat /sys/fs/cgroup/.../pod-abc/memory.current
1879048192                      # 1.75 GiB currently used

$ cat /sys/fs/cgroup/.../pod-abc/memory.max
2147483648                      # 2 GiB hard limit

$ cat /sys/fs/cgroup/.../pod-abc/memory.events
low      0
high     0
max      5                      # hit limit 5 times
oom      1                      # OOM triggered once
oom_kill 1                      # killed 1 process
```

Throttling vs killing — the asymmetry

CPU is *compressible* — you can use less without breaking. So the kernel pauses you. Memory is *incompressible* — once allocated, you can’t use less without releasing it. So the kernel kills you. This is why apps under CPU pressure look slow but apps under memory pressure die.

### 1.2e Namespace Internals {#ns-internals}

How does a process inside a PID namespace fail to see processes outside it? There’s no “boundary check.” The kernel virtualizes lookups based on the caller’s `nsproxy`.

#### The task\_struct → nsproxy chain

```
# Every process has a namespace bundle (include/linux/sched.h):
struct task_struct {
    pid_t           pid;
    struct nsproxy *nsproxy;       # pointer to namespace bundle
    struct mm_struct *mm;
    struct cgroup_subsys_state *cgroups[...];
};

# The bundle (include/linux/nsproxy.h):
struct nsproxy {
    struct uts_namespace    *uts_ns;
    struct ipc_namespace    *ipc_ns;
    struct mnt_namespace    *mnt_ns;
    struct pid_namespace    *pid_ns_for_children;
    struct net              *net_ns;
    struct time_namespace   *time_ns;
    struct cgroup_namespace *cgroup_ns;
};
```

#### How /proc is virtualized

`/proc` is a virtual filesystem. When a container reads `/proc`, the kernel filters by the reader’s PID namespace:

```
# fs/proc/base.c — proc_pid_readdir() filters PIDs
for_each_process(task) {
    pid_t pid = pid_nr_ns(task_pid(task), reader_pid_ns);
    if (pid == 0) continue;        # not visible in this ns
    emit_dirent(pid, task);
}
```

Container’s `ps` only sees PIDs that exist in *its* PID namespace. Host PIDs aren’t hidden behind a check — the data just isn’t there to read.

#### Inspecting namespaces from the host

```
# What namespaces does PID 9420 belong to?
$ ls -la /proc/9420/ns/
lrwxrwxrwx ... cgroup -> 'cgroup:[4026531835]'
lrwxrwxrwx ... ipc    -> 'ipc:[4026532197]'
lrwxrwxrwx ... mnt    -> 'mnt:[4026532195]'
lrwxrwxrwx ... net    -> 'net:[4026532199]'
lrwxrwxrwx ... pid    -> 'pid:[4026532198]'
lrwxrwxrwx ... uts    -> 'uts:[4026532196]'

# Same inode = same namespace. Different inode = isolated.
$ ls -la /proc/1/ns/net    # host init's net
... net -> 'net:[4026531992]'    # different inode!

# Enter a container's namespace from the host:
$ sudo nsenter -t 9420 -n -p -m ip a
# now you see the container's network interfaces
```

### 1.2f CPU Pinning & NUMA {#cpu-pin-numa}

Modern servers have multiple NUMA nodes — clusters of CPU cores with their own attached memory. Cross-NUMA access is ~1.75× slower. CPU Manager static policy in K8s pins Guaranteed pods to specific cores to keep memory access local.

NUMA Topology: Dual-Socket Server, CPU Manager Static

<img src="/diagrams/nvidia-linux-os/12.svg" alt="nvidia-linux-os diagram 12" class="doc-diagram" />

```
# Inspect what got pinned
$ cat /sys/fs/cgroup/.../guaranteed-pod-A/cpuset.cpus
4-7

$ cat /sys/fs/cgroup/.../guaranteed-pod-A/cpuset.mems
0                              # NUMA node 0 only

$ cat /sys/fs/cgroup/.../burstable-pod-X/cpuset.cpus
2-3,8-15                       # shared pool — what's left
```

### 1.2g TLB & Cache Effects {#tlb-cache}

Why does pinning matter so much? Because every time a process moves between cores or NUMA nodes, it loses cached state and pays for re-fetching it.

| Tier | Latency | Size | Scope | Lost on… |
| --- | --- | --- | --- | --- |
| L1 cache | ~1 ns | 32 KB | Per core | Core migration |
| L2 cache | ~3 ns | 256 KB – 1 MB | Per core | Core migration |
| L3 cache | ~10 ns | 32–64 MB | Per NUMA node | NUMA migration |
| Local RAM | ~80 ns | 32–256 GB | Same NUMA node | — |
| Remote RAM | ~140 ns | another node | Cross-NUMA via UPI | **1.75× penalty** |

#### The TLB problem

Modern x86-64 uses 4-level page tables. Translating a virtual address takes up to 4 memory accesses if not cached. The **TLB** caches recent translations — but it’s small (~64 L1 dTLB entries = ~256 KB coverage with 4 KB pages).

| Scenario | Translation cost | Why |
| --- | --- | --- |
| **Warm TLB** (pinned process) | ~1 ns | TLB hit → instant lookup |
| **Cold TLB** (just migrated) | ~80 ns | TLB miss → 4 page-table walks × ~20 ns each |

A 1 GB working set with 4 KB pages needs 262144 TLB entries — far more than fit. After migration, every memory access pays ~80 ns translation overhead until the TLB warms up. That’s **80× slower**.

#### What pinning + huge pages buy you

-   Process stays on same cores → L1/L2 cache stays warm
-   Process stays on same NUMA → L3 stays warm, RAM access stays local (~80 ns, not ~140 ns)
-   2 MB pages mean 1 GB working set fits in **512 TLB entries** instead of 262144 → TLB hit rate stays high
-   p99 latency drops dramatically — same workload, less time stalled on memory translation

```
# Enable huge pages on the node
echo 1024 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages

# Pod requests them
resources:
  limits:
    hugepages-2Mi: "2Gi"       # 1024 × 2 MB pages
```

#### Cache pollution from neighbors

Even with CPU pinning, L3 is shared across the NUMA node. A noisy neighbor on another core can evict your hot data. Mitigations:

-   **Intel CAT** — partition L3 between cgroups via `resctrl` filesystem (Linux 4.10+)
-   **Isolated cores** — boot with `isolcpus=4-7` so scheduler never places tasks there by default
-   **nohz\_full** — disable scheduler tick on isolated cores, no periodic interrupts to pollute caches

```
# Boot parameters for low-latency nodes
isolcpus=4-15
nohz_full=4-15
rcu_nocbs=4-15
intel_pstate=disable
processor.max_cstate=1
```

This combination — PREEMPT\_RT kernel + isolcpus + CPU Manager static + huge pages + IRQ pinning — is what telco operators and HFT firms use to hit microsecond-scale p99 SLOs.

### 1.3 TCP Congestion Control {#tcp}

Question

How does the Linux TCP stack handle congestion control?

TCP Congestion Control: Phases & Algorithms

<img src="/diagrams/nvidia-linux-os/13.svg" alt="nvidia-linux-os diagram 13" class="doc-diagram" />

| Algorithm | Type | Best For | Key Mechanism |
| --- | --- | --- | --- |
| **Cubic** | Loss-based | General internet (default) | Cubic function for cwnd growth; aggressive after loss recovery |
| **BBR** | Model-based | High-BDP links, lossy networks | Estimates bottleneck bandwidth & RTT; doesn't react to loss |
| **DCTCP** | ECN-based | Datacenter (low-latency) | Uses ECN marks proportionally; maintains shallow queues |

```
# Check current algorithm:   sysctl net.ipv4.tcp_congestion_control
# Change to BBR:             sysctl -w net.ipv4.tcp_congestion_control=bbr
# List available:            sysctl net.ipv4.tcp_available_congestion_control
```

### 1.4 Low-Latency Network Tuning {#lowlat}

OS-Level Low-Latency Network Optimizations

<img src="/diagrams/nvidia-linux-os/14.svg" alt="nvidia-linux-os diagram 14" class="doc-diagram" />

### 1.5 NUMA Architecture & Memory {#numa}

NUMA (Non-Uniform Memory Access) Architecture

<img src="/diagrams/nvidia-linux-os/15.svg" alt="nvidia-linux-os diagram 15" class="doc-diagram" />

Remote memory access is ~2x slower. Process on CPU 0 accessing Node 1 memory pays the QPI/UPI penalty.

```
# Show NUMA topology:    numactl --hardware
# Run process on node:   numactl --cpunodebind=0 --membind=0 ./app
# Check NUMA stats:      numastat -p <pid>
# K8s: Topology Manager  kubelet --topology-manager-policy=single-numa-node
```

### 1.6 Transparent Huge Pages (THP) vs Explicit Huge Pages {#thp}

| Aspect | Regular Pages (4 KB) | THP (2 MB auto) | Explicit Huge Pages (2 MB/1 GB) |
| --- | --- | --- | --- |
| **TLB entries needed** | 1M entries for 4 GB | 2K entries for 4 GB | 2K entries for 4 GB |
| **Allocation** | On demand | Kernel merges automatically | Reserved at boot |
| **Fragmentation risk** | Low | khugepaged compaction stalls | Pre-allocated, no stalls |
| **Best for** | General workloads | Large heap apps (JVM) | DPDK, databases, VMs |
| **Disable when** | — | Redis, MongoDB, latency-sensitive | — |

Why Disable THP for Redis/MongoDB?

THP causes **khugepaged** compaction stalls (10-100ms latency spikes) and **memory bloat** (copy-on-write copies entire 2MB page instead of 4KB). For latency-sensitive workloads, explicit huge pages or regular pages are better.

```
# Disable THP:  echo never > /sys/kernel/mm/transparent_hugepage/enabled
# Check status:  cat /sys/kernel/mm/transparent_hugepage/enabled
# Reserve explicit:  echo 1024 > /proc/sys/vm/nr_hugepages  (1024 x 2MB = 2GB)
```

### 1.7 XFS vs ext4 for Write-Heavy Workloads {#fs}

| Feature | XFS | ext4 |
| --- | --- | --- |
| **Max file size** | 8 EB | 16 TB |
| **Max volume** | 8 EB | 1 EB |
| **Allocation** | Extent-based, B+ tree | Extent-based, HTree |
| **Parallel writes** | Allocation groups (AG) = per-AG locking | Single inode lock for writes |
| **Write-heavy perf** | Better for large files, parallel I/O | Better for small files, metadata-heavy |
| **Online grow** | Yes | Yes |
| **Online shrink** | No | Yes |
| **Best for** | etcd data, databases, large files | General purpose, /var, containers |

### 1.8 I/O Schedulers {#iosched}

Linux I/O Scheduler Comparison

<img src="/diagrams/nvidia-linux-os/16.svg" alt="nvidia-linux-os diagram 16" class="doc-diagram" />

```
# Check current:     cat /sys/block/sda/queue/scheduler
# Change to none:    echo none > /sys/block/nvme0n1/queue/scheduler
# For NVMe SSD:      none (always). Device has internal FTL scheduler.
```

## Section 2: Practical Problem Solving (25 min) {#s2}

Deep troubleshooting with Linux tools

### 2.1 System Freeze Debugging {#freeze}

Problem

A critical production server has frozen but is not generating any logs. How would you investigate?

System Freeze Investigation Flow

<img src="/diagrams/nvidia-linux-os/17.svg" alt="nvidia-linux-os diagram 17" class="doc-diagram" />

```
# Enable SysRq:      echo 1 > /proc/sys/kernel/sysrq
# Enable kdump:      systemctl enable kdump
# Crash analysis:    crash /var/crash/vmcore /usr/lib/debug/vmlinux
# crash> bt          (backtrace of panicking task)
# crash> log         (kernel log buffer)
# crash> ps          (process list at time of crash)
```

### 2.2 High Disk Latency Investigation {#disklatency}

Problem

A distributed storage cluster shows high disk latency during peak usage. Identify bottlenecks and resolve.

Disk Latency Investigation Workflow

iostat -xz 1await, %util, avgqu-sz

➜

blktrace + blkparseper-request latency

➜

bcc/biolatencylatency histogram

➜

Identify layerapp / FS / block / HW

➜

Tune & fixscheduler / cache / HW

```
# Step 1: Overall I/O stats
iostat -xz 1
# Key columns: await (ms), r_await, w_await, %util, avgqu-sz

# Step 2: Per-request tracing
blktrace -d /dev/nvme0n1 -o - | blkparse -i -
# Shows: Q (queue) → G (get request) → D (dispatch) → C (complete)

# Step 3: eBPF latency histogram
biolatency -D   # per-disk latency distribution
biosnoop         # every I/O with latency

# Step 4: Check I/O scheduler, queue depth
cat /sys/block/nvme0n1/queue/scheduler
cat /sys/block/nvme0n1/queue/nr_requests

# Fixes:
# - Increase nr_requests for high IOPS
# - Switch scheduler to none for NVMe
# - vm.dirty_ratio / vm.dirty_background_ratio tuning
# - Enable write-back cache (if battery-backed)
```

### 2.3 Memory Fragmentation {#memfrag}

Problem

An application is failing to allocate large contiguous blocks of memory. Identify and fix.

Linux Buddy Allocator & Fragmentation

<img src="/diagrams/nvidia-linux-os/18.svg" alt="nvidia-linux-os diagram 18" class="doc-diagram" />

```
# Diagnosis:
cat /proc/buddyinfo        # free pages per order
cat /proc/pagetypeinfo     # movable vs unmovable
vmstat -s | grep compact   # compaction stats

# Fixes:
echo 1 > /proc/sys/vm/compact_memory   # trigger compaction now
sysctl vm.compaction_proactiveness=20   # proactive compaction
# Reserve huge pages early:
echo 'vm.nr_hugepages=1024' >> /etc/sysctl.conf  # at boot
```

### 2.4 Network Packet Drops Investigation {#pktdrop}

Problem

High-throughput application experiencing packet drops on the network interface.

Packet Drop Investigation: Where Drops Happen

<img src="/diagrams/nvidia-linux-os/19.svg" alt="nvidia-linux-os diagram 19" class="doc-diagram" />

## Section 3: Scenario-Based Design (25 min) {#s3}

Complex design challenges in Linux-based systems

### 3.1 Distributed Kernel Patch Management (10,000 Nodes) {#patchmgmt}

Scenario

Design a secure, fault-tolerant system to push kernel patches across 10,000 Linux nodes.

Kernel Patch Pipeline Architecture

Git Commitpatch + changelog

➜

CI BuildRPM/DEB, sign

➜

Canary (1%)50 nodes, 24h soak

➜

Stage (10%)1000 nodes, 48h

➜

Prod (100%)rack-aware rolling

➜

ValidateOBHC all-green

Rollback: kexec to previous kernel (no reboot) or grub default-entry revert. Max 1% failure rate triggers auto-halt.

-   **Idempotent:** Re-running the patch tool on an already-patched node is a no-op
-   **Network partition safe:** Agent pulls from local repo mirror. Central orchestrator tolerates agent disconnect for 24h before alerting
-   **Rollback:** kexec (instant kernel switch) or reboot to previous grub entry. Pre-patch etcd/DB snapshots for stateful services
-   **Consistency:** UCM + Puppet hieradata ensures desired state. Drift detection agent runs every 60s

### 3.2 Real-Time Data Processing System {#realtime}

Scenario

Design a Linux-based system to process streaming data in real-time with stringent latency requirements (<1ms P99).

Real-Time Linux Tuning Stack

<img src="/diagrams/nvidia-linux-os/20.svg" alt="nvidia-linux-os diagram 20" class="doc-diagram" />

### 3.3 Scaling a Distributed Ceph Cluster {#ceph}

Scenario

Scale a distributed Ceph cluster to handle double the current workload. Discuss Linux-level optimizations.

##### Disk I/O Tuning

-   Scheduler: none for NVMe, mq-deadline for HDD
-   readahead: 0 for random I/O (OSD), 2MB for sequential
-   nr\_requests: increase for NVMe
-   Dedicated WAL/DB on NVMe, data on HDD

##### Network Tuning

-   Separate public & cluster networks (bonded 25G)
-   Jumbo frames (MTU 9000)
-   TCP buffer: rmem\_max/wmem\_max = 16MB
-   BBR congestion control

##### Memory & CPU

-   OSD memory target: 4GB per OSD
-   NUMA-local OSD placement
-   cgroup per OSD for resource isolation
-   Disable THP (random I/O pattern)

##### OSD Balancing

-   Automatic rebalancing with PG autoscaler
-   osd\_max\_backfills: limit concurrent rebalance
-   Recovery priority < client I/O priority
-   CRUSH map: failure domain = rack

### 3.4 Dynamic K8s Resource Allocation {#k8sresource}

Scenario

Design a mechanism to dynamically allocate CPU and memory for pods. Ensure optimal utilization without over-provisioning.

K8s Resource Allocation: Kernel → cgroups → Scheduler

<img src="/diagrams/nvidia-linux-os/21.svg" alt="nvidia-linux-os diagram 21" class="doc-diagram" />

QoS Classes & Kernel Behavior

-   **Guaranteed** (requests == limits): cpu.max set, memory.max set, oom\_score\_adj = -997. Last to be OOM-killed.
-   **Burstable** (requests < limits): cpu.weight for sharing, cpu.max for cap. OOM-killed after BestEffort.
-   **BestEffort** (no requests/limits): No cgroup limits. oom\_score\_adj = 1000. First to be OOM-killed.
-   **VPA (Vertical Pod Autoscaler):** Watches actual usage, adjusts requests/limits. Requires pod restart for cgroup changes.
-   **In-place resize (K8s 1.27+):** Update cgroup limits without pod restart. Modify cpu.max and memory.max live.
