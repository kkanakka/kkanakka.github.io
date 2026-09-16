---
title: "Linux Scheduling & Containers"
slug: /linux/linux-scheduling-containers
sidebar_position: 7
sidebar_label: "Linux Scheduling & Containers"
description: "Linux Scheduling & Containers"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/linux-scheduling-containers/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

docs/ kernel/ **internals**

v6.x · Updated 2026-05

Kernel Internals

[Preemption](#preemption) [Namespaces](#namespaces) [Control groups](#cgroups) [Containers](#containers) [Networking](#networking) [Memory](#memory) [Storage](#storage) [Service tuning](#systemd-cookbook) [Troubleshooting](#troubleshooting) [Design scenarios](#design) [CPU primer](#cpu-primer)

Related

[Scheduler classes](#) [RCU](#) [Memory management](#) [Block I/O](#) [Tracing & eBPF](#)

Reference

[syscalls(2)](#) [cgroups(7)](#) [namespaces(7)](#) [sched(7)](#)

A deep tour through three mechanisms in the Linux kernel: the preemption model that bounds your latency, and the namespaces and cgroups that compose every container.

Stable Kernel 6.x ~15 min read Depth 9/10

## Kernel preemption {#preemption}

Every CPU runs exactly one thing at a time. The scheduler decides which thing. **Preemption** is the act of forcibly taking the CPU away from a running task — because something higher-priority woke up, or because the running task burned its time slice.

Preempting userspace has always been free in Linux. The interesting question — the one that defines real-time latency — is whether code running *in kernel mode* can be preempted. The answer ranges from "almost never" to "almost always," and you choose at build time.

### The four models at a glance {#four-models-tldr}

Linux offers four preemption models, chosen at kernel build time (or at boot with `PREEMPT_DYNAMIC` since v6.1). Each trades throughput for latency:

Figure 0 · four preemption models · what can interrupt kernel code SVG

<img src="/diagrams/linux-scheduling-containers/1.svg" alt="linux-scheduling-containers diagram 1" class="doc-diagram" />

Each model is a different answer to "when can the scheduler take the CPU from kernel code?" — from "basically never" (NONE) to "basically always" (RT). Userspace is always preemptible regardless of model.

### The mechanism {#mechanism}

Every task carries a per-CPU `preempt_count`. It's a bitfield, not a counter — different sub-ranges track different reasons preemption is currently disabled:

```
// include/linux/preempt.h — conceptual layout
//   bits  0..7   PREEMPT_MASK  — explicit preempt_disable() nesting
//   bits  8..15  SOFTIRQ_MASK  — inside a softirq
//   bits 16..19  HARDIRQ_MASK  — inside a hardirq
//   bit  20      NMI_MASK      — inside an NMI
//   bit  31      PREEMPT_NEED_RESCHED  (inverted flag)

static inline bool preemptible(void) {
    return preempt_count() == 0 && !irqs_disabled();
}
```

Separately, the scheduler sets `TIF_NEED_RESCHED` on a task when it decides that task should yield — e.g. when `try_to_wake_up()` just queued a higher-priority task. The interaction:

-   **Returning to user mode:** always checks the flag and calls `schedule()` if set.
-   **Returning to kernel mode:** only checks if `preempt_count == 0` AND the build allows kernel preemption.
-   **Voluntary points:** `cond_resched()` calls in long kernel loops yield if the flag is set.

Figure 1 · preemption decision flow on IRQ exitSVG

<img src="/diagrams/linux-scheduling-containers/2.svg" alt="linux-scheduling-containers diagram 2" class="doc-diagram" />

The lower branch is `PREEMPT_NONE`: task B waits until A's syscall returns. The upper branch is `PREEMPT`/`PREEMPT_RT`: B takes the CPU immediately.

### Scheduling classes and priority {#sched-classes}

The Completely Fair Scheduler (CFS) governs most threads (`SCHED_OTHER` / NORMAL). Higher urgency work uses realtime classes or `SCHED_DEADLINE`; `nice` weights scale CFS vruntime, compressing latency for interactive tasks without changing POSIX priority numbers on the syscall API.

| Class | POSIX | Semantics (sketch) |
| --- | --- | --- |
| `SCHED_DEADLINE` | — | EDF on runtime/deadline/period triple; strictest feasibility checks. |
| `SCHED_FIFO` | 1–99 (rt) | Runnable RT tasks preempt lower classes; FIFO within priority. |
| `SCHED_RR` | 1–99 (rt) | Like FIFO but time-quantized for equal-priority RT peers. |
| `SCHED_NORMAL` | 0 (nice) | CFS fair share; dominates typical server/workload throughput. |
| `SCHED_BATCH` | 0 (nice) | Favors throughput over latency; wakes less aggressively. |
| `SCHED_IDLE` | — | Runs only when no other runnable task on CPU (idle scavenger). |

Figure 2 · priority ladder and CFS nice weightsSVG

<img src="/diagrams/linux-scheduling-containers/3.svg" alt="linux-scheduling-containers diagram 3" class="doc-diagram" />

Realtime classes preempt CFS outright; inside CFS, `nice` scales weight (conceptual).

Figure 3 · preemption gate: user vs PREEMPT\_NONE kernelSVG

<img src="/diagrams/linux-scheduling-containers/4.svg" alt="linux-scheduling-containers diagram 4" class="doc-diagram" />

User/kernel boundary is the usual latency hinge when `CONFIG_PREEMPT_NONE=y`.

### Latency shapes by preempt model

```
// Kernel config excerpts (conceptual)
//# CONFIG_PREEMPT_NONE is not set
CONFIG_PREEMPT_VOLUNTARY=y
// or
CONFIG_PREEMPT=y
// or PREEMPT_RT for threaded IRQs etc.
```

Figure 4 · worst-case kernel preemption latency (illustrative)SVG

<img src="/diagrams/linux-scheduling-containers/5.svg" alt="linux-scheduling-containers diagram 5" class="doc-diagram" />

Orders of magnitude vary by workload drivers; plotted lengths are explanatory, not measured SLAs.

### Twenty places PREEMPT\_NONE still blocks you

Non-preempt kernels still honor `cond_resched()`, explicit sleeps, blocking locks, IRQ boundaries, and kernel→user exits. The table catalogs common stretches where interrupts may nest but reschedule stays deferred.

| # | Situation | Why reschedule waits |
| --- | --- | --- |
| 1 | Spinning on `spin_lock()` | Preemption forbidden to bound lock hold latency. |
| 2 | Nested `preempt_disable()` | Explicit critical section nesting. |
| 3 | In hardirq (`HARDIRQ_OFFSET`) | IRQ stack must unwind before reschedule. |
| 4 | In softirq / tasklet tail | Counted via `SOFTIRQ_OFFSET` until exit. |
| 5 | During RCU read-side (some configs) | Keeps deferral epochs safe. |
| 6 | Inside NMI notifier | Cannot schedule; no regular kernel preemption path. |
| 7 | kmem fastpath with IRQs off | Allocator spin paths mask preemption briefly. |
| 8 | Memory hotplug teardown | Serialization with stop\_machine-style sequences. |
| 9 | CPU hot unplug sequence | Relocation of runqueues while offline. |
| 10 | Architecture errata mitigation microcode stalls | Firmware timing not under scheduler control. |
| 11 | IPI broadcast for TLB shootdown | Receiving CPU busy in masked section. |
| 12 | Tracepoint / ftrace atomic section | Ring buffer writers pin preemption state. |
| 13 | Scheduler runqueue double-lock | Cross-CPU balancing windows. |
| 14 | Realtime migration throttle | PI chain updates while pinning. |
| 15 | Livepatch consistency stall | Integrity of instruction patching semantics. |
| 16 | BPF atomic helper misuse | Incorrect context flags block scheduling. |
| 17 | Huge Transparent Page collapse | Khugepaged collapser excludes preemption bursts. |
| 18 | IOMMU teardown | Hardware quiesce stalls. |
| 19 | Holding rwsem write lock (fast path) | Select paths delay preemption deliberately. |
| 20 | Widespread printk under logbuf lock | Spammy logging serializes reschedule. |

| Build option | Kernel preemption in syscall path | Latency posture |
| --- | --- | --- |
| `PREEMPT_NONE` | Generally off (except exits / sleeps) | Throughput server default; coarse latency. |
| `PREEMPT_VOLUNTARY` | At well-marked yields | Balanced desktops / mixed workloads. |
| `PREEMPT` | Most atomic sections short | Interactive / low jitter. |
| `PREEMPT_RT` | Threaded IRQs, PI mutexes… | Formal bounded preemptibility. |

### Multi-core reality — preemption is per-CPU {#multicore-preemption}

Preemption models are a **per-CPU concept** — they govern whether the task currently running on *this core* can be kicked off *this core*. They say nothing about what other cores can do.

So the scenario plays out fine on any preemption model, even `PREEMPT_NONE`. Core 0 is grinding through a non-preemptible kernel path on behalf of process A. Process B wakes up with a `SCHED_DEADLINE` reservation. The scheduler sees core 1 is idle (or running something lower priority) and dispatches B there immediately. No preemption of A was ever needed — A keeps its core, B gets a different one, both run in parallel. The wake-up path (`try_to_wake_up` → `select_task_rq` → IPI to the target CPU) doesn't care that A is uninterruptible; it's looking at where B should land.

Figure 4b · multi-core dispatch · preemption never needed SVG

<img src="/diagrams/linux-scheduling-containers/6.svg" alt="linux-scheduling-containers diagram 6" class="doc-diagram" />

Preemption only becomes the binding constraint when *all* cores are busy and the scheduler has decided that *this specific CPU* must give up its task. That's the latency `PREEMPT_RT` bounds.

The preemption model only starts to matter when you can't sidestep with a free core — i.e. all cores are busy and the scheduler has decided that this specific CPU is the one that has to give up its task for the new one. That's when "is the current task in a preemptible state?" becomes the binding constraint, and that's the latency `PREEMPT_RT` is trying to bound.

Note · cross-core lock contention

The stuck syscall isn't completely free of cross-core impact. If A is holding a `spinlock`, `mutex`, or `rw_semaphore` that B needs, B will block on that lock regardless of which core it's on. `PREEMPT_RT` helps here too because it converts most spinlocks into sleeping, priority-inheriting locks — so a low-priority lock holder gets boosted rather than making the deadline task wait indefinitely.

Tip · SCHED\_DEADLINE's SMP awareness

`SCHED_DEADLINE` specifically has admission control plus its own SMP-aware pushing/pulling logic (the `dl_rq` push/pull machinery), so it actively migrates deadline tasks to find a CPU where they can meet their deadline rather than just queuing behind whatever's running.

## Namespaces {#namespaces}

Namespaces carve kernel-global resources into disjoint views bound to processes. Containers combine multiple namespaces with cgroups — here we focus on the object graph (task → `nsproxy` → per-domain structs).

| Namespace | What it isolates |
| --- | --- |
| MNT | Mount table / root traversal |
| UTS | Hostname / domainname |
| IPC | SysV IPC & POSIX message queues |
| PID | Process IDs and hierarchy |
| NET | Network devices, routes, iptables |
| USER | UID/GID mappings & capabilities |
| CGROUP | Virtual cgroup filesystem root view |
| TIME | Offsets for boot/monotonic clocks (newer domains) |

```
// clone(2) / unshare(2) / setns(2) — illustrative flags
clone(child_stack, SIGCHLD | CLONE_NEWIPC | CLONE_NEWNET);
setns(fd_pid, CLONE_NEWPID);
```

Figure 5 · `task_struct`, `nsproxy`, and namespace structsSVG

<img src="/diagrams/linux-scheduling-containers/7.svg" alt="linux-scheduling-containers diagram 7" class="doc-diagram" />

Host processes share one `nsproxy` graph; pivoting namespaces builds a disjoint graph for containerized tasks.

Figure 6 · PID namespace nesting across host and workloadsSVG

<img src="/diagrams/linux-scheduling-containers/8.svg" alt="linux-scheduling-containers diagram 8" class="doc-diagram" />

Each PID layer remaps numbering; ancestry is visible upward through `/proc` and children lists.

## Control groups {#cgroups}

Control groups version 2 present a unified hierarchy: every process belongs to exactly one subtree per mounted controller-enabled tree. Systemd organizes slices beneath the cgroup root (`/sys/fs/cgroup`), while containers often land scopes under `machine.slice`.

```
// Typical mount & delegation (concept)
mount -t cgroup2 none /sys/fs/cgroup
```

| Controller | Bounded resource examples |
| --- | --- |
| **memory** | `memory.max`, `swap.max`, pressure stall info |
| **cpu** | `cpu.max`, weight, burst (where enabled) |
| **io** | Per-device R/W bandwidth & IOPS |
| **pids** | Maximum processes in subtree |
| **cpuset** | CPU & memory node pinning |
| **devices / freezer / rdma\*** | Device access bpf, thaw/freeze cohorts (\*optional) |

Figure 7 · cgroup v2 unified hierarchy (illustrative layout)SVG

<img src="/diagrams/linux-scheduling-containers/9.svg" alt="linux-scheduling-containers diagram 9" class="doc-diagram" />

Leaf cgroups own process membership; controllers read effective settings while walking toward the root.

## Linux containers: what actually happens in the kernel {#containers}

A container is not a thing the Linux kernel understands directly. There is no `struct container`. The kernel only knows about **processes**, **namespaces**, **cgroups**, **VFS / mount tables**, **overlayfs**, **schedulers**, **memory accounting**, and **capability & security models**. "Containers" are just orchestration around those primitives.

Figure 8a — eight kernel primitives that compose a container

<img src="/diagrams/linux-scheduling-containers/10.svg" alt="eight kernel primitives that compose a container" class="doc-diagram" />

The kernel has no container abstraction. What you call a container is a process whose view of the world has been narrowed (namespaces), whose consumption has been capped (cgroups), and whose filesystem is a layered union mount (overlayfs).

### One task\_struct, multiple PIDs {#pid-internals}

In the kernel, a runnable thread is represented by `struct task_struct`. The PID you see in userspace is not stored as a simple integer inside the task alone: **`task_struct.thread_pid`** points at a heap-allocated `struct pid`, which aggregates *one numeric identity per PID namespace level*. Different namespaces therefore see different integers for the same live task—the mapping lives in `pid->numbers[]`, keyed by nesting depth—not in a lone `int pid` field on the task.

```c
struct task_struct {
    ...
    struct pid *thread_pid;
    ...
};

struct pid {
    refcount_t count;
    unsigned int level;
    struct upid numbers[];
};

struct upid {
    int nr;
    struct pid_namespace *ns;
};
```

**One process, three identities**

| Namespace View | PID | Level |
| --- | --- | --- |
| Host | 5234 | 0 |
| Container A | 1 | 1 |
| Nested Container | 27 | 2 |

Figure 8b — PID namespace lookup flow

<img src="/diagrams/linux-scheduling-containers/11.svg" alt="PID namespace lookup flow" class="doc-diagram" />

Same kernel. Same task\_struct. Different namespace-relative identities. The numbers\[\] array on struct pid holds one entry per nesting level.

Figure 8c — PID namespace nesting

<img src="/diagrams/linux-scheduling-containers/12.svg" alt="PID namespace nesting" class="doc-diagram" />

Same kernel. Same task\_struct. Different namespace-relative identities. The numbers\[\] array on struct pid holds one entry per nesting level.

`struct nsproxy` is not PID-specific: it holds pointers to **all** active namespace types for a task (mount, UTS, IPC, PID, network, user, cgroup, time). Unsharing or joining a new namespace updates the corresponding pointer in the nsproxy (subject to reference counting and clone flags)—so isolation of hostname, mounts, IPC IDs, and network stack is orchestrated alongside PID views from one shared structure.

Figure 8d — full namespace architecture · task\_struct → nsproxy → 8 namespace types

<img src="/diagrams/linux-scheduling-containers/13.svg" alt="full namespace architecture task_struct nsproxy eight namespace types" class="doc-diagram" />

Two tasks that share the same `nsproxy` (or equivalent namespace bindings) observe the same mount table, hostname, IPC IDs, PIDs in each level, NICs, UID maps, cgroup roots, and time bases. A typical container task gets its own nsproxy wiring so each pointer targets an isolated namespace object.

**Warning.** Namespaces isolate views, not the kernel itself. A kernel CVE is exploitable from inside a container. seccomp filters, capability dropping, and user namespace mappings are the actual security boundary.

### cgroups resource governance {#cgroup-internals}

Namespaces hide things. cgroups limit things.

#### cgroup v2 hierarchy

```
/sys/fs/cgroup/
└── kubepods.slice/
    └── kubepods-burstable.slice/
        └── kubepods-burstable-pod123.slice/
            └── cri-containerd-abcd.scope/
                ├── memory.max
                ├── cpu.max
                ├── cpu.weight
                ├── io.max
                ├── pids.max
                └── cgroup.procs
```

#### Kubernetes → kernel flow

Figure 8e — from pod YAML to kernel syscalls

<img src="/diagrams/linux-scheduling-containers/14.svg" alt="linux-scheduling-containers diagram 14" class="doc-diagram" />

The process is permanently associated with that cgroup unless explicitly moved. There is no 'container start' syscall — just ordinary clone, mount, cgroup writes, and exec.

#### Memory controller internals

Memory cgroup (mem\_cgroup) charging ties every page allocation to the cgroup of the task that triggered it: the kernel walks from the allocating context to the current task and attributes the charge to that task's cgroup, so RSS and cache pressure accrue in the leaf cgroup you configured in the hierarchy.

```
page fault → alloc_pages() → memcg_charge() → current task's cgroup
```

Figure 8f — scoped OOM · cgroup-local, not system-wide

<img src="/diagrams/linux-scheduling-containers/15.svg" alt="linux-scheduling-containers diagram 15" class="doc-diagram" />

When a cgroup exceeds memory.max, the kernel's cgroup-scoped OOM killer picks a victim within that cgroup only.

#### CPU scheduling via cgroups

The `cpu.max` file uses a **quota** and **period** in microseconds. For example, `50000 100000` means 50 ms of CPU time per 100 ms wall-clock period — a hard cap of 0.5 CPU for that cgroup. The scheduler refills the quota each period and throttles the whole cgroup when the allowance is exhausted.

Figure 8g — CFS throttling + weight-based fairness

<img src="/diagrams/linux-scheduling-containers/16.svg" alt="linux-scheduling-containers diagram 16" class="doc-diagram" />

cpu.max is a hard ceiling enforced per 100ms period. cpu.weight only matters under contention — it's a proportional share, not a cap.

### Mount namespaces + VFS {#vfs-mounts}

Processes never talk directly to ext4 or xfs. They talk to the VFS — the virtual filesystem switch — which dispatches to the actual filesystem.

Figure 8h — VFS architecture · single API, multiple backends

<img src="/diagrams/linux-scheduling-containers/17.svg" alt="linux-scheduling-containers diagram 17" class="doc-diagram" />

Each process observes its own mount table: the kernel stores a pointer in task\_struct through nsproxy → mnt\_namespace. Path resolution walks dentry/inode caches in that namespace, so two tasks can legitimately disagree on what `/` means while sharing one kernel.

| Mount namespace | Examples |
| --- | --- |
| **Host** | `/` → ext4, `/var` → xfs |
| **Container** | `/` → overlayfs, `/proc` → procfs, `/dev` → tmpfs |

Same kernel. Different mount table lookup.

### overlayfs internals {#overlayfs}

OverlayFS stacks a writable layer on top of one or more read-only lower directories. Containers see a unified tree; reads merge upper and lowers; writes land in the upperdir so immutable image layers ship once and many containers fork only their deltas.

Figure 8i — overlayfs layer stack + copy-up on write

<img src="/diagrams/linux-scheduling-containers/18.svg" alt="linux-scheduling-containers diagram 18" class="doc-diagram" />

overlayfs composes read-only image layers with a per-container writable layer. Reads fall through layers top-down; writes trigger a full-file copy-up to the upperdir.

100 containers sharing same readonly lower pages → Linux page cache deduplicates automatically → huge RAM savings

**Tip** This is why containers are memory-efficient: 100 containers from the same image share the same read-only page-cache pages. Only the upperdir (container-specific writes) costs unique memory.

### Full container read path {#container-read-path}

Combine everything. When a containerized process reads a file, every kernel subsystem we've covered participates in a single syscall.

Figure 8j — container file read · end-to-end kernel path

<img src="/diagrams/linux-scheduling-containers/19.svg" alt="linux-scheduling-containers diagram 19" class="doc-diagram" />

A single `read()` traverses process context, namespace resolution, filesystem layering, page cache, cgroup I/O accounting, and finally the block device. Every layer is a composable kernel primitive.

### Unified container stack {#container-stack}

Here is the complete picture — how all eight kernel primitives compose into what we call a container.

Figure 8k — unified container stack · all primitives composed

<img src="/diagrams/linux-scheduling-containers/20.svg" alt="linux-scheduling-containers diagram 20" class="doc-diagram" />

No hypervisor. No guest kernel. Just: process isolation through selective kernel indirection.

### The deep truth {#container-truth}

**A container is fundamentally:** a normal Linux process + namespace-scoped views + cgroup resource accounting + filesystem layering. No hypervisor required. No guest kernel required. Just process isolation through selective kernel indirection.

**The elegant part**

None of these subsystems were originally invented "for containers." VFS predates Docker by decades. cgroups came from Google process accounting. Namespaces started as isolation primitives. overlayfs solved filesystem layering. Containers emerged because these kernel mechanisms composed perfectly together.

**Tip — debugging containers**

When a container misbehaves, traverse in order: cgroup pressure (OOM, throttling) → namespace surprise (wrong /proc view, hidden PIDs) → host preemption model (latency tail if the node runs PREEMPT\_NONE). This sequence mirrors how the kernel resolves resources before policy.

## 5\. NETWORKING {#networking}

The Linux TCP stack spans the NIC driver boundary through the socket API: packets are staged in RX rings, processed by softirq-driven paths (often under NAPI), demultiplexed after IP/TCP parsing, and delivered to per-socket backlog queues consumed by sleeping or busy-polling tasks. Throughput and latency jointly depend on congestion dynamics (cwnd versus peer receive window rwnd), bufferbloat avoidance, offload features, and how aggressively the kernel batches work versus yields CPU to applications.

### TCP congestion control {#cc}

The **congestion window (cwnd)** bounds how much unacknowledged data the sender may have in flight; it grows when the path looks idle and shrinks when loss or explicit congestion signals imply overload. The **receive window (rwnd)** is advertised by the receiver and caps end-to-end flight independent of congestion. Effective throughput ≈ min(cwnd, rwnd) ÷ RTT when not application-limited. **Reno** uses AIMD with multiplicative decrease on loss (classic sawtooth). **CUBIC** replaces linear additive increase with a cubic function in congestion avoidance, offering better fairness on high-BDP paths. **BBR** models bottleneck bandwidth and RTT explicitly, probing for higher BDP rather than assuming loss implies congestion.

<img src="/diagrams/linux-scheduling-containers/21.svg" alt="Figure 9: Congestion window evolution by algorithm" class="doc-diagram" />

Figure 9. Idealized congestion window trajectories (not to scale); all algorithms share an initial exponential slow start before diverging.

**Four classic TCP phases** (Reno family and many derivatives):

-   **Slow start:** cwnd grows exponentially per ACK until ssthresh or loss.
-   **Congestion avoidance:** linear (or non-linear in CUBIC) increase when cwnd ≥ ssthresh.
-   **Fast retransmit:** on three duplicate ACKs, retransmit the missing segment without waiting for RTO.
-   **Fast recovery:** inflate cwnd for duplicate ACKs, then deflate and enter CA after new data ACK.

| Algorithm | Signal | Best for | Failure mode |
| --- | --- | --- | --- |
| Reno | Packet loss (implicit) | General legacy compatibility | Bufferbloated paths inflate RTT without loss cues |
| CUBIC | Loss / delay hybrid via cubic function | High-BDP WAN; default on many distributions | Latency-sensitive flows behind large shallow buffers |
| BBR | Modeled BW & RTT; periodic probing | Throughput on shallow buffers; stable RTT environments | Fairness with loss-based CC coexistence needs tuning |
| DCTCP | ECN marks (fraction of CE) | Datacenter fabrics with RED/ECN | Misconfigured ECN ignores or starving non-ECN peers |
| Vegas | RTT inflation vs baseline | Stable RTT LANs avoiding loss | Starvation competing with aggressive loss-based senders |

```
# sysctl knobs (persist in /etc/sysctl.d/*.conf)
sysctl -w net.ipv4.tcp_congestion_control=cubic
sysctl -w net.ipv4.tcp_available_congestion_control

# Per-socket (requires CAP_NET_ADMIN / appropriate capability)
setsockopt(sock, IPPROTO_TCP, TCP_CONGESTION, "bbr", strlen("bbr")+1);

# Inspect cwnd/rwnd and CC name on Linux
ss -ti
```

Note

The sender’s stack picks the outbound congestion-control module; tuning `net.ipv4.tcp_congestion_control` affects new connections unless overridden per-socket or by namespace defaults. Receiver settings and middleboxes can still constrain the session independent of CC choice.

### Low-latency optimizations {#low-latency-net}

Cutting tail latency usually means shortening the number of hops through software, reducing interrupts per packet, and avoiding sleeps on the recv path—without sacrificing correctness. Modern paths combine hardware queues, NAPI batching, XDP drop/redirect primitives, GRO aggregation, and optional bypass mechanisms for fixed-function dataplanes.

<img src="/diagrams/linux-scheduling-containers/22.svg" alt="Figure 10: Linux RX packet path and bypass routes" class="doc-diagram" />

Figure 10. Canonical RX path with XDP/GRO choke points and two illustrative bypass geometries.

| Layer | Example knobs / APIs | Intent |
| --- | --- | --- |
| NIC / driver | `ethtool -G` ring sizes, RSS/LRO/GRO toggles, interrupt coalescing | Batching vs interrupt rate; queue spread |
| IRQ / affinity | `/proc/irq/*/smp_affinity`, `irqbalance` off + tuned masks | Keep RX and application on shared L3 where safe |
| Softirq / RPS | `rps_cpus`, `rps_flow_cnt`, `netdev_budget` | Steer work away from single CPU hot spots |
| Socket / TCP | `SO_BUSY_POLL`, `TCP_NODELAY`, `SO_REUSEPORT`, large skbuff pools | Cut wakeups; avoid Nagle; spread accept load |

```
# NIC / IRQ
ethtool -g eth0
ethtool -c eth0
echo f > /proc/irq/24/smp_affinity  # example: pin IRQ to CPU3

# RFS (requires kernel + driver support)
sysctl -w net.core.rps_sock_flow_entries=32768
# per-queue: /sys/class/net/eth0/queues/rx-0/rps_flow_cnt

# Busy polling (power trade-off)
sysctl -w net.core.busy_read=50
sysctl -w net.core.busy_poll=50

# App socket options (pseudo-C)
setsockopt(fd, SOL_SOCKET, SO_BUSY_POLL, &usec, sizeof(usec));
setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &(int){1}, sizeof(int));

# Pin critical thread
taskset -c 2-3 ./daemon
```

Warning

Low-latency profiles often increase CPU usage (busy poll), reduce power headroom, and can worsen tail latency if IRQ affinity fights with the JVM/DB thread placement. Validate with production-like load and power caps.

## 6\. MEMORY {#memory}

Linux memory performance is dominated by placement (NUMA locality), TLB pressure (page size and fragmentation), and reclaim behavior. Applications that ignore topology pay remote-memory penalties; transparent huge pages can collapse TLB misses but introduce latency variance for latency-sensitive allocators.

### NUMA {#numa}

Non-uniform memory access exposes multiple memory nodes with different bandwidth and latency from each CPU. The kernel’s default **first-touch** policy faults physical pages on the NUMA node of the CPU that first writes the page, which is ideal for single-threaded producers but can strand data if threads migrate.

<img src="/diagrams/linux-scheduling-containers/23.svg" alt="Figure 11: Two-socket NUMA topology" class="doc-diagram" />

Figure 11. Dual-socket NUMA with local vs remote DRAM access caricature.

| Policy | Semantics | Typical use |
| --- | --- | --- |
| `MPOL_DEFAULT` | Follow per-process default / system default | Baseline behavior |
| `MPOL_BIND` | Restrict allocations to explicit node bitmask | Hardware-scoped arenas (e.g., NIC-local) |
| `MPOL_PREFERRED` | Prefer node, fallback permitted | Soft affinity when remote OK under pressure |
| `MPOL_INTERLEAVE` | Round-robin across nodes | Bandwidth striping for large arrays (careful with TLB) |

```
# Launch on node 0 CPUs, prefer node0 memory
numactl --cpunodebind=0 --membind=0 ./app

# Programmatic pinning (mmap + mbind)
mbind(addr, length, MPOL_BIND, nodemask, maxnode, MPOL_MF_MOVE);
```

Tip

NIC MSI-X vectors and GPU BAR traffic are NUMA-affinite: bind IRQs and device peers to the same node as consuming threads to dodge link hops.

### Transparent Huge Pages {#thp}

THP lets the kernel promote contiguous 4 KiB pages into 2 MiB (or optionally 1 GiB) mappings, collapsing page-table depth and widening TLB coverage for linear regions.

<img src="/diagrams/linux-scheduling-containers/24.svg" alt="Figure 12: Page table walk depth vs page size" class="doc-diagram" />

Figure 12. x86\_64-ish four-level PT for 4 KiB vs collapsed huge entry (conceptual).

| sysfs `/sys/kernel/mm/transparent_hugepage/enabled` | Behavior |
| --- | --- |
| `always` | Kernel aggressively promotes; higher odds of compaction stalls |
| `madvise` | Only `madvise(MADV_HUGEPAGE)` regions prefer THP |
| `never` | Disable promotions (applications may still use hugetlbfs explicitly) |

Danger

Latency-sensitive databases often disable THP because background khugepaged/compaction work and hugepage split/merge jitter can collide with Strict SLAs and deterministic page faults.

```
grep -H . /sys/kernel/mm/transparent_hugepage/*
cat /proc/meminfo | egrep 'AnonHugePages|ShmemHugePages'

# Fragmentation diagnostics
watch -n1 'grep -i huge /proc/buddyinfo'
```

**THP vs `hugetlbfs`:** THP is transparent and pooled from the general buddy allocator, whereas `hugetlbfs` reserves fixed hugepages at boot or via `/sys/kernel/mm/hugepages/`—predictable but requires capacity planning and can fail mmap if pools are depleted.

## 7\. STORAGE {#storage}

### XFS versus ext4 {#fs}

Both are journaling extent-friendly filesystems, but XFS’s allocation groups and buffered I/O pipelines historically scale more gracefully on arrays with ample parallelism.

<img src="/diagrams/linux-scheduling-containers/25.svg" alt="Figure 13: Parallel write throughput vs concurrency" class="doc-diagram" />

Figure 13. Stylized benchmark curve for teaching; validate on your storage engine and media.

| Topic | XFS | ext4 |
| --- | --- | --- |
| Parallel writers | Typically strong AG parallelism | Historical bottlenecks; improved but workload-dependent |
| fsync-heavy | \_journal sizing & log bandwidth matter | Flexible journal modes (`data=ordered` default nuances) |
| Huge files | Mature extents; sparse friendly | Extent maps OK; tooling differ |
| Small files | Watch fragmentation + AG balance | Often pragmatic default for misc roots |
| Shrink / grow | Grow online; shrink limited | Online grow; shrink not traditional |
| Real-time volumes | Dedicated RT subvolumes legacy feature | N/A analogue |
| Default in … | Many EL large data partitions | Typical distro root installs |

```
mkfs.xfs -l size=512m,lazy-count=1 /dev/sdXN
mount -o noatime,nodiscard /dev/sdXN /mnt/xfs

mkfs.ext4 -O has_journal /dev/sdYN
mount -o noatime /dev/sdYN /mnt/ext4
```

Note

Rule of thumb: parallel streaming + large files → prefer XFS; general-purpose volumes with conservative defaults → ext4 remains solid. Benchmark with `fio` mirroring your IO pattern instead of extrapolating marketing curves.

### I/O scheduler {#io-sched}

| Scheduler | Brief | Use when |
| --- | --- | --- |
| `none` | Passes through to device queue | NVMe/multiqueue stacks with fast firmware |
| `mq-deadline` | Dual FIFO with latency deadlines | Often default MQ balance of latency + throughput |
| `bfq` | Weighted fair BFQ proportional share | Interactive desktops / mixed interactive + bulk |
| `kyber` | Fine-grained MQ latency targets | Latency-prioritized low-depth devices |

<img src="/diagrams/linux-scheduling-containers/26.svg" alt="Figure 14: mq-deadline reordering illustration" class="doc-diagram" />

Figure 14. mq-deadline prioritizes expiring reads, then drained writes beneath longer deadlines.

```
# Current scheduler for sda (example paths)
cat /sys/block/sda/queue/scheduler

# Temporary switch for NVMe nvme0n1
echo none | sudo tee /sys/block/nvme0n1/queue/scheduler

# Persist via udev (illustrative)
cat <<'EOF' | sudo tee /etc/udev/rules.d/60-iosched.rules
ACTION=="add|change", KERNEL=="nvme[0-9]n*", ATTR{queue/scheduler}="none"
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/scheduler}="mq-deadline"
EOF
udevadm control --reload-rules && udevadm trigger
```

-   **Pick in 2026:** start with distro defaults—they’re usually mq-aware.
-   For NVMe with deep queues and deterministic firmware, measure `none` vs `mq-deadline`; many DBs prefer `none` + drive FTL.
-   Keep `bfq` for workstations; rarely wins on hyperscale OLTP SSDs.
-   Validate with `fio --latency_percentiles=1 --group_reporting` matching queue depth distribution.
-   Revisit post-kernel bumps: scheduler defaults evolve faster than folklore.

Tip

Meta-point: the scheduler rearranges block-layer requests—not page cache writeback cadence (`dirty_ratio`), not filesystem journaling strategy, not NVMe multipath failover. Optimize the actual bottleneck tier.

## 8\. SYSTEMD COOKBOOK {#systemd-cookbook}

### Directive reference {#systemd-knobs}

| Directive | Role | Examples / notes |
| --- | --- | --- |
| `Nice=` | Static POSIX nice bias | `Nice=-5` elevates versus default 0 within fair class |
| `CPUSchedulingPolicy=` | SCHED\_OTHER/FIFO/RR/BATCH/IDLE/DEADLINE | FIFO/RR require caps & policy privilege |
| `CPUSchedulingPriority=` | RT priority within FIFO/RR | 1–99; coordinate with isolcpus/preempt configs |
| `CPUAffinity=` | Hex or list CPU mask | Pins main threads to NUMA-local cores |
| `IOSchedulingClass=` | ionice class (realtime/best-effort/idle) | Maps to CFQ legacy semantics in blkcg era |
| `IOSchedulingPriority=` | Priority within best-effort | 0–7 ladder |
| `LimitMEMLOCK=` | RLIMIT\_MEMLOCK | Needed for DPDK/hugepage locks |
| `LimitRTPRIO=` / `LimitRTTIME=` | RT budget caps | Prevents runaway FIFO from wedging system |
| `OOMScoreAdjust=` | /proc/pid/oom\_score\_adj bias | Negative protects; positive sacrifices |
| `CPUWeight=` / `CPUQuota=` | Cgroup v2 CPU control | Weights vs hard ceiling (percent of CPU) |
| `MemoryHigh=` / `MemoryMax=` | Soft/hard memory limits | Throttling vs SIGKILL behavior |

### Composition behaviors {#systemd-compose}

| Pairing | Interaction |
| --- | --- |
| `CPUAffinity` + `CPUQuota` | Quota applies within allowed CPUs only; verify slice placement |
| `Nice` vs `CPUWeight` | Nice adjusts per-process scheduler weighting; cgroup weights carve slice shares |
| `SchedulingPolicy=FIFO` + default RT limits | Often fails start if `LimitRTPRIO` too low vs priority |
| `MemoryHigh` + swap | Soft pressure pushes reclaim; swapping may distort latency budgets |
| `OOMScoreAdjust` vs `MemoryMax` | Hard max kills deterministically before global OOM in many cases |
| `IOSchedulingClass` + mq schedulers | Less visible on NVMe-none; blkcg dominates aggregate fairness |
| Drop-in dirs vs unit file | Later lexicographic drop-ins override fragment keys—watch ordering |

### Production-grade profiles {#systemd-profiles}

**1\. Background batch (idle class)**

```
# /etc/systemd/system/foo-batch.service.d/idle.conf
[Service]
CPUSchedulingPolicy=idle
Nice=15
IOSchedulingClass=idle
```

**2\. General elevated service**

```
# /etc/systemd/system/foo.service.d/priority.conf
[Service]
Nice=-5
```

**3\. Latency-sensitive**

```
# /etc/systemd/system/foo-rt-ish.service.d/latency.conf
[Service]
Nice=-10
CPUAffinity=2-7
IOSchedulingClass=realtime
IOSchedulingPriority=4
OOMScoreAdjust=-500
```

**4\. Hard real-time FIFO + pinned cores**

```
# /etc/systemd/system/foo-fifo.service.d/rt.conf
[Service]
CPUSchedulingPolicy=fifo
CPUSchedulingPriority=80
CPUAffinity=8-9
LimitMEMLOCK=infinity
LimitRTPRIO=95
LimitRTTIME=infinity
```

```
# GRUB_CMDLINE_LINUX fragment (VERIFY WITH YOUR HARDWARE TEAM)
isolcpus=nohz,managed_irq,8-9 rcu_nocbs=8-9 systemd.unified_cgroup_hierarchy=1
```

```
# Optional mlock coverage (daemon code must lock as well!)
[Service]
LimitMEMLOCK=infinity
```

**5\. Resource-isolated tenancy**

```
# /etc/systemd/system/foo-partition.slice
[Slice]
CPUWeight=200
CPUQuota=400%
MemoryHigh=48G
MemoryMax=52G
```

### Verification workflow {#systemd-verify}

```
# Effective unit properties
systemctl show foo.service -p ExecMainPID -p Nice -p CPUSchedulingPolicy \
  -p CPUSchedulingPriority -p CPUAffinity -p MemoryHigh -p MemoryCurrent

PID=$(systemctl show -p MainPID --value foo.service)

# cgroup v2 knobs
grep -R . "/sys/fs/cgroup/system.slice/$(systemctl show -p FragmentPath --value foo.service | md5sum 2>/dev/null)" \
  || cat /proc/$PID/cgroup

# Threads
ps -Lo pid,tid,policy,psr,sgi_p,comm -p $PID
chrt -p $PID
taskset -cp $PID
ionice -p $PID
cat "/proc/$PID/limits"
```

### Gotchas

1.  `Type=simple` services report success before Exec ready—use `notify` or health gates.
2.  OOM scores need CAP\_SYS\_RESOURCE or matching user namespaces to set aggressively low.
3.  `CPUQuota` interacts with timer slack and kernel HZ; sub-5% quotas can starve.
4.  `JoinsNamespaceOf=` / private tmp mount orders can break relative paths between units.
5.  Transient units (`systemd-run`) ignore some drop-ins unless explicitly loaded.
6.  `Environment=` vs `EnvironmentFile=`: latter often overridden by image updates—document precedence.
7.  Slice limits don’t retroactively clamp already-mapped pages under pressure—plan boot order.
8.  `AllowedCPUs=` vs `CPUAffinity=`: cgroup v2 placement vs per-task mask differ subtly on fork trees.

Tip

To make a service “important,” combine a modest negative `Nice`, a protected `OOMScoreAdjust`, tight `CPUAffinity` aligned with NUMA peers, and—if latency demands it—documented RT policy with budget caps. Always pair priority with observability (metrics on queue depth, RT throttling events).

## 9 · Troubleshooting {#troubleshooting}

Kernel and host problems usually fall into one of four observable scenarios: interactive access still works (**SSH**), limited access (**console**/**BMC**), partial responsiveness with watchdog clues (**lockups**), or fully dead hardware until reset (**no live introspection**). The sections below translate symptoms into tooling and corrective levers—always pair symptoms with timelines, regressions around kernel updates, and storage/network dependency graphs.

### 9.1 System freeze {#freeze}

For freezes, taxonomy matters: distinct failure modes imply different tooling and escalation paths.

1.  **Kernel panic** — fatal BUG/OOPS; often a traceback on console and `dmesg` truncation at failure.
2.  **Hard lockup** — CPU stuck in IRQ-disabled or deadlock with NMI watchdog firing (watchdog-`bite` traces).
3.  **Soft lockup** — CPU monopolizes without scheduling progress; BUG: soft lockup logged with stack.
4.  **Hung task** — uninterruptible sleep (`D` state) exceeding `hung_task_timeout_secs`.
5.  **Userspace deadlock** — futex/mutex starvation; PID still exists but threads block (often visible in userspace).
6.  **Resource exhaustion** — threads blocked on allocations, OOM reclaim thrash, inode/disk/full pipes—may look like silence until pressure breaks.

<img src="/diagrams/linux-scheduling-containers/27.svg" alt="Figure 15: Diagnostic capability ladder during freeze incidents" class="doc-diagram" />

Figure 15: Capability ladder—severity increases downward; arrows trace the typical escalation path.

**Note:** When kdump is not configured—or `/var/crash` lands on flaky storage—you may have no artifact after a stall; escalation often degrades to a hardware-assisted reset with only SEL/BMC breadcrumbs. Provision kdump destinations before crises.

```
# Magic SysRq — letters t / w / l / m / p / c / s / u / b (kernel.sysrq permitting)
echo t > /proc/sysrq-trigger   # task dump · thread states / stacks snapshot
echo w > /proc/sysrq-trigger   # blocked tasks
echo l > /proc/sysrq-trigger   # backtrace CPUs
echo m > /proc/sysrq-trigger   # memory summary
echo p > /proc/sysrq-trigger   # show registers per CPU/task
echo c > /proc/sysrq-trigger   # deliberate panic → kdump
echo s > /proc/sysrq-trigger   # sync
echo u > /proc/sysrq-trigger   # remount ro (after sync)
echo b > /proc/sysrq-trigger   # immediate reboot (last resort)
```

**kdump**: enable capture of a compressed vmcore early in boot (`kexec` load), persist to durable storage, validate initramfs regeneration after kernel bumps. Inspect with crash:

```
# /etc/default/grub crashkernel= auto (example) → update-grub2 + reboot checklist
sudo kdumpctl restart   # distro-specific wrappers

crash /usr/lib/debug/lib/modules/$(uname -r)/vmlinux /var/crash/127.0.0.1-XXXX/vmcore

crash> bt
crash> foreach bt
crash> vm 0xffff...
crash> struct task_struct comm,pid,mm
```

**Live debugging** (when responsiveness holds):

```
perf top -g
grep . /proc/<PID>/stack
/usr/share/bpftrace/tools/offcputime.bt           # distro path may vary — off-CPU stack aggregation
bpftrace -e 'kprobe:vfs_read { @Reads[pid, comm] = count(); }'   # illustrative one-liner probes
```

### 9.2 High disk latency {#disk-latency}

<img src="/diagrams/linux-scheduling-containers/28.svg" alt="Figure 16: Block I/O stack with observability tooling" class="doc-diagram" />

Figure 16: Vertical I/O path with right-rail tooling—start where symptoms localize (queue vs media).

```
iostat -xz 1
bpftrace /usr/share/bpftrace/tools/biolatency.bt
blktrace -d /dev/nvme0n1 -o - | blkparse -i -
bcc-cachestat 1    # or bpftrace cachestat variants

# Example trace window
blktrace -w 10 -d /dev/sdX
```

| Lever | When to use | Risk / tradeoff |
| --- | --- | --- |
| Scheduler / wbt | Queue latency without media errors | Throughput vs latency tradeoff |
| `nr_requests` / queue depth | Saturated single-LUN paths | Can starve co-tenants |
| Filesystem mount options | Metadata storms (relatime, log sizing) | Durability semantics |
| Write-back tuning | Page cache pressure / flusher stalls | Data loss window on crash |
| Device firmware / multipath | SMART / controller errors | Maintenance windows |
| Kernel upgrade / driver | Known regression in stable tree | Validation cost |
| Sharding / RDMA / cache tier | Distributed storage hot spots | Architecture change |

**Note.** A common “silver bullet” oversimplification—“just add OSDs”—often masks Linux-side tuning (dirty ratios, xfs log sizing, cgroup throttling). Pair storage expansion with empirical queue-depth and reclaim evidence.

### 9.3 Memory fragmentation {#mem-frag}

<img src="/diagrams/linux-scheduling-containers/29.svg" alt="Figure 17: Buddy allocator free-list health vs fragmentation" class="doc-diagram" />

Figure 17: Synthetic illustration of buddy distributions—inspect live via `/proc/buddyinfo`.

```
cat /proc/buddyinfo
cat /proc/pagetypeinfo | head -n 40
grep -i zone /proc/zoneinfo | head
```

```
# sysfs / sysctl examples (timing + risk vary)
echo 1 > /proc/sys/vm/compact_memory
sysctl vm.compaction_proactiveness=...
sysctl vm.min_free_kbytes=...
echo X > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages
```

**Compaction limits.** On-line compaction cannot always defragment movable pages fenced by long-lived unmovable allocations; persistent hugepage pools and kernel module load order can stall reclamation—pair sysfs moves with `pagetypeinfo` deltas, not only single-shot `compact_memory`.

### 9.4 Packet drops at high throughput {#pkt-drops}

<img src="/diagrams/linux-scheduling-containers/30.svg" alt="Figure 18: Packet drop counter map along Linux receive path" class="doc-diagram" />

Figure 18: Correlate counters to layer before buying hardware—often software queueing first.

```
ethtool -S eth0 | egrep -i 'drop|miss|fifo|error'
cat /proc/net/softnet_stat
conntrack -S
nstat | egrep -i 'drop|overflow|reject|listen'
ss -tinm state listening
```

| Lever | Target symptom | Caveat |
| --- | --- | --- |
| Ring / channel / RSS layout | NIC-level drops | NIC firmware interactions |
| GRO/GSO/TSO/LRO offload | CPU saturation in softirq | Path-dependent bugs |
| RPS/RFS/XDP | uneven CPU load | Cache locality tradeoffs |
| `netdev_max_backlog` | `softnet_stat` drops | Latency under burst |
| Conntrack sizing / gc | nf\_conntrack table full | Security policy constraints |
| TCP window / app batching | ListenDrops / pruned | App change often required |
| BPF/XDP drop hooks | Policy drops | Visibility via tracepoints |

## 10 · Design scenarios {#design}

### 10.1 Distributed kernel patches across 10k nodes {#patch-rollout}

<img src="/diagrams/linux-scheduling-containers/31.svg" alt="Figure 19: Staged kernel rollout with health gates" class="doc-diagram" />

Figure 19: Waves grow super-linearly once automated safety signals hold.

| Concern | Representative choices | Operational note |
| --- | --- | --- |
| Update mechanism | Image-based A/B · package + reboot · livepatch adjunct | Immutable images shorten drift |
| Coordination | Pull agent + CRL · message bus fanout | Avoid thundering herds with jitter |
| Signing | Sigstore / in-house codesign · measured boot | Supply-chain audit focus |
| Health signal | Node SLO + workload canaries + MDM guardrails | Composite scoring beats single probe |
| Rollback | Previous slot kexec · package pin · snap revert | Test rollback monthly |
| Partition tolerance | Stale agent continues last-good · CRDT-style desired state | Cap unsynchronized waves |

-   **A/B partitions** — atomic switch with explicit health gate before promoting default boot entry.
-   **Pull-based agent** — scales control-plane; rate-limit object storage fetches.
-   **Health gate** — mix kernel taint, panic counters, NMI stats, and workload-level SLO burn.
-   **Geographic spread** — interleave waves across failure domains to catch firmware-specific bugs.
-   **Drain before reboot** — honor PDBs / maintenance windows for stateful tiers.
-   **Out-of-band recovery** — IPMI / serial recovery image for bricked networking paths.

**Tip.** Where reboot cost dominates, pair quick livepatch for targeted CVE hotfixes with scheduled full-kernel waves for structural changes—never treat livepatch as a total substitute for tested monolithic upgrades.

### 10.2 Real-time streaming data processing {#rt-pipeline}

<img src="/diagrams/linux-scheduling-containers/32.svg" alt="Figure 20: Userspace real-time hot path vs out-of-band costs" class="doc-diagram" />

Figure 20: Green chain = intentional fast path; red ✗ markers are classes of latency you design away.

| Layer | Choices / knobs | Evidence |
| --- | --- | --- |
| Kernel | PREEMPT\_RT vs tuned CFS isolcpus | cyclictest hist |
| Scheduler | SCHED\_FIFO priority bands · housekeeping CPUs | `/proc/sched_debug` |
| CPU pinning | isolcpus,nohz\_full,rcu\_nocbs | IRQ affinity map |
| Network | DPDK / XDP / busy poll | PMD loop cycles |
| Memory | Hugepages · mlock · numactl bind | fault counters |
| Storage | avoid NVMe jitter path on hot tier | latency hist |
| Language | C++/Rust / tuned JVM Shenandoah | pause metrics |
| IPC | SPSC ring vs kernel pipes | wakeups/sec |
| Power | intel\_pstate performance / disable C-states selectively | RDTSC deltas |

```
# Example boot cmdline fragments (platform-specific)
isolcpus=nohz,managed_domain,cpu_list nohz_full=cpu_list rcu_nocbs=cpu_list skew_tick=1

cyclictest -m -Sp99 -p 80 -i 250 -l 1000000
```

### 10.3 Scaling distributed storage clusters {#ceph-scale}

1.  **Metadata / monitor quorum** — control-plane latency caps growth velocity.
2.  **Replica / parity fanout** — synchronous paths multiply tail latency.
3.  **Recovery & backfill** — competes with foreground I/O without rate governors.
4.  **Client protocol limits** — per-session windows, kernel client vs userspace gateway tradeoffs.

| Linux-side lever | Intent | Watch-out |
| --- | --- | --- |
| TCP buffer autotuning | wide-area throughput | RAM footprint |
| CPU freq governor | stable latency | power envelope |
| Block readahead | sequential scans | cache pollution |
| XFS / ext4 log sizing | metadata bursts | mkfs-time choices |
| cgroup CPU weighting | protect foreground | starve compaction |
| IRQ / RPS layout | network RSS balance | LLC misses |
| Transparent huge pages policy | reduce TLB pressure | latency spikes on defrag |
| `vm.dirty_*` ratios | smooth write spikes | checkpoint latency |

-   Shard placement groups / pools across failure domains intentionally—avoid “hot mon” placement.
-   Introduce dedicated network planes (front / back / cluster) with ECN-capable switches.
-   Automate reweight / crush map evolution with guardrails + simulation before apply.
-   Prefer protocol-level batching (append logs) over blind Linux sysctl inflation.

**Reality check.** Vendor scaling stories often assume greenfield hardware—validate with your firmware queue depths, switch buffer models, and actual failure domains; Linux visibility still catches the majority of tail regressions.

### 10.4 Dynamic resource allocation in Kubernetes {#k8s-alloc}

<img src="/diagrams/linux-scheduling-containers/33.svg" alt="Figure 21: cgroup v2 tree for Kubernetes QoS" class="doc-diagram" />

Figure 21: Logical mapping—actual paths vary by runtime (containerd/cri-o) and cgroup driver.

| QoS | OOM score behavior (conceptual) | Motivation |
| --- | --- | --- |
| Guaranteed | Prefer last victim class | latency-sensitive tiers |
| Burstable | Mixed—limits cap burst | general workloads |
| BestEffort | First pressured under memory | best-effort batch |

-   Normalize requests downward only when SLA evidence supports it.
-   Add vertical slack using VPA caution + limits that reflect saturation testing.
-   Split noisy neighbors via dedicated pools / taints when PSI shows chronic stalls.
-   Prefer pod-level PDBs aligned with quorum constraints instead of naive maxUnavailable=100%.

```
# PSI readout (aggregate + per-cgroup PSI files on modern kernels)
cat /proc/pressure/cpu
cat /proc/pressure/memory
cat /proc/pressure/io

grep . /sys/fs/cgroup/kubepods.slice/**/pressure/*  # example glob — shell dependent
```

| Primitive | Concern | Relationship |
| --- | --- | --- |
| `requests` / `limits` | scheduling + cgroup ceiling | defines QoS tier |
| CPU shares / max (cgroup v2) | proportional vs hard cap | drives throttle metrics |
| Memory limit | OOMKill boundary | paired with eviction |
| Init containers | lifecycle CPU/memory spikes | consume Headroom transiently |
| RuntimeClass | kata/gvisor isolation tax | offsets raw millicores |
| Quota period | burst granularity | tunable via kubeReserved |
| Topology Manager | device + CPU locality | interaction with pinning |
| PodOverhead | sandbox cgroup tax | explicit accounting |

**Tip.** Watch CFS `throttled_periods_total` — chronic throttling implies requests set below actual steady CPU; raising requests often beats fiddling quotas when latency matters.

## 11 · CPU primer appendix {#cpu-primer}

### 11.1 Inside the silicon {#cpu-hardware}

<img src="/diagrams/linux-scheduling-containers/34.svg" alt="Figure 22: Stylized processor socket internals" class="doc-diagram" />

Figure 22: Conceptual—not to scale—highlights threading vs LLC boundaries.

### 11.2 Memory hierarchy {#cache-hierarchy}

<img src="/diagrams/linux-scheduling-containers/35.svg" alt="Figure 23: Latency-aware memory pyramid (order-of-magnitude)" class="doc-diagram" />

Figure 23: Illustrative—measure on your SKU with micro-benchmarks; absolute ns drift with frequency.

### 11.3 What “one CPU” can mean {#cpu-meanings}

| Context | Interpretation | Mental model |
| --- | --- | --- |
| Hardware thread | One logical CPU (`nproc` row) | may share exec units via SMT |
| `nice` / priority | dynamic weighting vs same cgroup peers | does not violate hard caps |
| cgroup cpu.weight | proportional share under contention | burst allowed until max |
| cgroup cpu.max | hard quota / ceiling | µs throttled windows accumulate |
| Kubernetes millicores | 1 vCPU idea = `/sys/fs/cgroup/...cpu.max` math | paired with QoS semantics |

### 11.4 Pinning mechanisms compared {#cpu-pinning-mechs}

| Mechanism | Scope | Primary interface | Interactions |
| --- | --- | --- | --- |
| `taskset` / `sched_setaffinity` | process/thread masks | syscall / util | cpusets override subtlety |
| cgroups cpuset subsystem | whole subtree | `cpuset.cpus` | Kubernetes Guaranteed pods |
| isolcpus kernel params | broadcast domain for housekeeping | boot cmdline | kthread migration caveats |
| IRQ smp\_affinity | device interrupts | `/proc/irq/.../smp_affinity_list` | must align with dataplane cpus |
| NUMA binding | memory locality | `numactl --membind` | page migration costs |

<img src="/diagrams/linux-scheduling-containers/36.svg" alt="Figure 24: Partitioning eight logical CPUs" class="doc-diagram" />

Figure 24: Example only—real clusters may split NUMA nodes per socket.

### 11.5 Kubernetes CPU millicores in practice {#k8s-cpu-values}

Millicores express `requests`/`limits` that kubelet materializes into cgroup v2 files such as `cpu.max` and `cpu.weight` (exact mapping depends on version, QoS, and whether CPU Manager is enabled).

```
apiVersion: v1
kind: Pod
metadata:
  name: demo
spec:
  containers:
  - name: app
    image: busybox
    resources:
      requests:
        cpu: "250m"
      limits:
        cpu: "500m"
```

```
# Illustrative — paths vary (cgroupfs vs systemd driver, QoS pod path)
cat /sys/fs/cgroup/kubepods.slice/.../cpu.max
cat /sys/fs/cgroup/kubepods.slice/.../cpu.weight
```

| Scenario | Pinning eligible? | Primary signal | Notes |
| --- | --- | --- | --- |
| Guaranteed + integer CPU | Yes (static policy) | Exclusive cores | NUMA alignment via Topology Manager |
| Guaranteed + fractional | No exclusive cores | Still high QoS | shares/ceil math only |
| Burstable | Generally no static exclusives | throttle metrics | watch cfs\_quota |
| BestEffort | No | first eviction class | avoid for latency |

### 11.6 Kubelet CPU Manager {#cpu-manager}

```
# /var/lib/kubelet/config.yaml (excerpt)
cpuManagerPolicy: static
cpuManagerPolicyOptions:
  full-pcpus-only: "true"   # optional guardrails
reservedSystemCPUs: 0-1
topologyManagerPolicy: single-numa-node
```

**Danger.** Switching CPU Manager policy is not always rolling-safe: stale state files under `/var/lib/kubelet/cpu_manager_state` can pin unexpected cores—drain node, clear state per documented procedure, then re-enable under supervision.

```
systemctl status kubelet
sudo cat /var/lib/kubelet/cpu_manager_state | jq .
kubectl describe node <node> | sed -n '/Allocatable/,/System/p'
```

**Tip.** Use static pinning when kernel bypass / device IRQ co-location demonstrably cuts tail latency; otherwise default CFS + accurate requests typically yields better fleet utilization.

[Kernel preemption](#preemption)

-   [four models at a glance](#four-models-tldr)
-   [mechanism](#mechanism)
-   [sched-classes](#sched-classes)
-   [preemption-gate](#preemption-gate)
-   [models](#models)
-   [preempt-rt](#preempt-rt)
-   [rt-workload](#rt-workload)
-   [multi-core reality](#multicore-preemption)

[Namespaces](#namespaces)

-   [ns-types](#ns-types)
-   [ns-syscalls](#ns-syscalls)
-   [pid-ns](#pid-ns)

[Control groups](#cgroups)

-   [v1-v2](#v1-v2)
-   [worked-example](#worked-example)

[Containers](#containers)

-   [pid-internals](#pid-internals)
-   [cgroup-internals](#cgroup-internals)
-   [vfs-mounts](#vfs-mounts)
-   [overlayfs](#overlayfs)
-   [container-read-path](#container-read-path)
-   [container-stack](#container-stack)
-   [container-truth](#container-truth)

[Networking](#networking)

-   [cc](#cc)
-   [low-latency-net](#low-latency-net)

[Memory](#memory)

-   [numa](#numa)
-   [thp](#thp)

[Storage](#storage)

-   [fs](#fs)
-   [io-sched](#io-sched)

[Service tuning](#systemd-cookbook)

-   [systemd-knobs](#systemd-knobs)
-   [systemd-compose](#systemd-compose)
-   [systemd-profiles](#systemd-profiles)
-   [systemd-verify](#systemd-verify)

[Troubleshooting](#troubleshooting)

-   [freeze](#freeze)
-   [disk-latency](#disk-latency)
-   [mem-frag](#mem-frag)
-   [pkt-drops](#pkt-drops)

[Design scenarios](#design)

-   [patch-rollout](#patch-rollout)
-   [rt-pipeline](#rt-pipeline)
-   [ceph-scale](#ceph-scale)
-   [k8s-alloc](#k8s-alloc)

[CPU primer](#cpu-primer)

-   [cpu-hardware](#cpu-hardware)
-   [cache-hierarchy](#cache-hierarchy)
-   [cpu-meanings](#cpu-meanings)
-   [cpu-pinning-mechs](#cpu-pinning-mechs)
-   [k8s-cpu-values](#k8s-cpu-values)
-   [cpu-manager](#cpu-manager)
