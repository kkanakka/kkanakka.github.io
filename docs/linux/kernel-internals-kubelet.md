---
title: "Kernel Internals & the Kubelet"
slug: /linux/kernel-internals-kubelet
sidebar_position: 6
sidebar_label: "Kernel Internals & the Kubelet"
description: "Kernel Internals & the Kubelet"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/kernel-internals-kubelet/sequence.svg" alt="How it works — kernel-internals-kubelet" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
[home](/)/ [linux guide](/docs/linux/linux-systems-guide)/ **kernel internals**

v6.x · Updated 2026-05

Kernel Internals

[Preemption](#preemption) [Namespaces](#namespaces) [Control groups](#cgroups) [Containers](#containers) [Networking](#networking) [Memory](#memory) [Storage](#storage) [Service tuning](#systemd-cookbook) [Troubleshooting](#troubleshooting) [Design scenarios](#design) [CPU primer](#cpu-primer) [K8s deep-dive](#k8s-deep-dive)

Related

[Scheduler classes](#) [RCU](#) [Memory management](#) [Block I/O](#) [Tracing & eBPF](#)

Reference

[syscalls(2)](#) [cgroups(7)](#) [namespaces(7)](#) [sched(7)](#)

A deep tour through three mechanisms in the Linux kernel: the preemption model that bounds your latency, and the namespaces and cgroups that compose every container.

Stable Kernel 6.x ~15 min read Depth 9/10

## Kernel preemption {#preemption}

Every CPU runs exactly one thing at a time. The scheduler decides which thing. **Preemption** is the act of forcibly taking the CPU away from a running task — because something higher-priority woke up, or because the running task burned its time slice.

Preempting userspace has always been free in Linux. The interesting question — the one that defines real-time latency — is whether code running *in kernel mode* can be preempted. The answer ranges from "almost never" to "almost always," and you choose at build time.

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

-   **Returning to user mode:** always checks the flag and calls `schedule()` if set. Has worked this way since forever.
-   **Returning to kernel mode:** only checks if `preempt_count == 0` AND the build allows kernel preemption. This is where the models differ.
-   **Voluntary points:** `cond_resched()` calls in long kernel loops yield if the flag is set.

Figure 1 · preemption decision flow on IRQ exit SVG

<img src="/diagrams/kernel-internals-kubelet/1.svg" alt="kernel-internals-kubelet diagram 1" class="doc-diagram" />

The lower branch is `PREEMPT_NONE`: task B waits until A's syscall returns. The upper branch is `PREEMPT`/`PREEMPT_RT`: B takes the CPU immediately, even though A is mid-syscall.

### Scheduling classes — who actually wins {#sched-classes}

Preemption only fires when something *higher priority* needs to run. So the prior question is: what makes something higher? Linux answers with **scheduling classes** — a strict ladder of policies. Every task belongs to exactly one class, and class order is absolute: a single task in a higher class always beats any number of tasks in a lower one.

| Class | Algorithm | Used for |
| --- | --- | --- |
| SCHED\_DEADLINE | Earliest-Deadline-First, admission-controlled | Industrial control, robotics |
| SCHED\_FIFO | Runs until it blocks or yields — no timeslice | Audio engines, IRQ threads |
| SCHED\_RR | Like FIFO but with a ~100 ms timeslice at equal prio | Several RT tasks sharing one priority |
| SCHED\_NORMAL | Default — CFS/EEVDF, fairness by `nice` weight | Everything you've ever launched |
| SCHED\_BATCH | Like NORMAL but no wake-up boost — treated as CPU-bound | Long compute jobs |
| SCHED\_IDLE | Runs only when nothing else wants the CPU | Lowest-priority background work |

#### Who picks the class?

Almost certainly not the program. The default is **inherited**: `fork()` and `execve()` hand the new task its parent's class and parameters. Your shell runs as `SCHED_NORMAL` with `nice=0`, so every command you launch does too. PID 1 starts `SCHED_NORMAL` and that default cascades down the entire process tree. You never chose it because you never had to — you got `SCHED_NORMAL` by inheritance from your ancestors all the way back to init.

Four ways the class actually changes:

-   **The program asks.** `sched_setscheduler(2)` / `sched_setattr(2)` from libc. PipeWire, JACK, and most RT control software call into the kernel at startup: "put me in SCHED\_FIFO at priority 80."
-   **An external tool.** `chrt -f 50 ./myprogram` launches in `SCHED_FIFO` at priority 50. `chrt -i ./backup.sh` runs as `SCHED_IDLE`. `chrt -p 80 1234` changes an already-running PID. Same syscalls, from outside.
-   **systemd.** Unit directives `CPUSchedulingPolicy=fifo`, `CPUSchedulingPriority=50`, `Nice=-5` applied before exec.
-   **The kernel itself.** For its own threads — `migration/N`, `ksoftirqd/N`, RCU and IRQ threads — via `sched_setscheduler_nocheck()`.

Note · privilege

Moving *up* into a real-time class (DEADLINE, FIFO, RR) requires `CAP_SYS_NICE`. Unprivileged `chrt -f 50 ./prog` fails with `EPERM`. The limits live in `/etc/security/limits.conf` (`rtprio`, `nice`) or via file capabilities on the binary. Moving *down* — to `SCHED_IDLE`, or to a higher nice value — is always allowed.

Figure 2 · priority ranking · class ladder + nice zoom into SCHED\_NORMAL SVG

<img src="/diagrams/kernel-internals-kubelet/2.svg" alt="kernel-internals-kubelet diagram 2" class="doc-diagram" />

Class is the lane; `nice` positions a task within SCHED\_NORMAL only. CFS/EEVDF balances vruntime by these weights. SCHED\_FIFO/RR ignore nice entirely — they use rt\_priority 1–99.

```bash
# Inspect a process's class & priority
chrt -p $(pidof pipewire)
# pid 1234's current scheduling policy: SCHED_FIFO
# pid 1234's current scheduling priority: 81

# Launch a job in a class
chrt -f 50 ./audio_server      # SCHED_FIFO prio 50 — needs CAP_SYS_NICE
chrt -i 0  ./nightly_backup     # SCHED_IDLE — anyone can do this
nice -n 10 ./big_compile        # SCHED_NORMAL with nice=10

# Change from C
struct sched_param p = { .sched_priority = 80 };
sched_setscheduler(0, SCHED_FIFO, &p);   // 0 = self
```

### The preemption gate — same wakeup, two outcomes {#preemption-gate}

Priority decides *who should be running*. A separate question: *when can the switch actually happen?* Under `PREEMPT_NONE`, the answer depends on what mode A was in when B woke up.

Figure 3 · the preemption gate · user mode (open) vs kernel mode (closed) SVG

<img src="/diagrams/kernel-internals-kubelet/3.svg" alt="kernel-internals-kubelet diagram 3" class="doc-diagram" />

Same priority math, same wake-up event. The only difference is where A happened to be executing. The two-card layout is the entire pedagogical point of `PREEMPT_NONE` — the gate metaphor makes "kernel mode is a no-preempt zone" visible.

#### Scenarios under PREEMPT\_NONE

Twenty cases. A is currently on-CPU, B becomes runnable. Rows 1–4 and 9–12 show priority working normally — A is in userspace, the gate is open. Rows 5–8 and 13–15 are the `PREEMPT_NONE`\-specific behaviour: once A enters the kernel, no priority of B can pull A off the CPU until A returns to userspace or voluntarily yields. Row 16 is the one important escape hatch — hardware interrupts always run.

| # | A (running) | B (wakes up) | Result under PREEMPT\_NONE | Lesson |
| --- | --- | --- | --- | --- |
| 1 | nice=0, user | nice=0 | A finishes timeslice; scheduler picks at tick | Equal weight → fair share |
| 2 | nice=0, user | nice=−20 | B preempts A at next tick | Userspace is always preemptible |
| 3 | nice=−20, user | nice=0 | A keeps running | Lower-weight challenger loses |
| 4 | nice=19, user | nice=−20 | B preempts A almost immediately | Big weight gap, user path |
| 5 | nice=0, in syscall | nice=−20 | B waits until syscall returns | **Core PREEMPT\_NONE rule** — kernel code not preemptible |
| 6 | nice=−20, in syscall | nice=−20 | B waits for syscall to finish | Same-prio kernel work still blocks |
| 7 | nice=19, in long syscall | nice=−20 | B blocked for whole syscall | Low-prio task can delay high-prio via kernel mode |
| 8 | in syscall, hits `cond_resched()` | nice=−20 waiting | B runs at that point | Voluntary preemption point — what NONE relies on |
| 9 | SCHED\_FIFO prio=50, user | SCHED\_FIFO prio=80 | B preempts A immediately | RT preemption works fine in userspace |
| 10 | SCHED\_NORMAL nice=−20 | SCHED\_FIFO prio=1 | B preempts A | Any RT beats any SCHED\_NORMAL |
| 11 | SCHED\_FIFO prio=99 | SCHED\_FIFO prio=1 | A keeps running | Higher RT wins; lower can starve forever |
| 12 | SCHED\_DEADLINE task | SCHED\_FIFO prio=99 | A keeps running | Class order: deadline > RT |
| 13 | SCHED\_NORMAL nice=0, in syscall | SCHED\_FIFO prio=99 | B waits until syscall returns | **The PREEMPT\_NONE latency problem** |
| 14 | SCHED\_FIFO prio=50, in syscall | SCHED\_FIFO prio=99 | B waits for kernel code to finish | Even RT can't preempt kernel mode here |
| 15 | nice=0 inside long mm/IO path | SCHED\_FIFO prio=99 | B's latency = duration of that path | Why audio / realtime workloads avoid PREEMPT\_NONE |
| 16 | nice=0, user | Hardware IRQ fires | IRQ handler runs, then A resumes | Interrupts ≠ preemption; always serviced |
| 17 | SCHED\_IDLE task | nice=19 (NORMAL) | B preempts A | SCHED\_IDLE sits below SCHED\_NORMAL |
| 18 | SCHED\_RR prio=50 | SCHED\_RR prio=50 | Round-robin timeslicing between them | RR shares at equal prio (FIFO does not) |
| 19 | nice=0 in cgroup cpu.weight=10 | nice=0 in cgroup cpu.weight=1000 | B's group gets ~100× the share | Cgroup weight applies before per-task fairness |
| 20 | nice=0, in syscall holding a mutex | SCHED\_FIFO prio=99 needs that mutex | B blocks; A can't be paused to release it | Priority inversion, worsened by non-preemptible kernel |

Tip · the through-line

Rows 5, 13, 14, 15 are the same problem repeated: when A holds the CPU in kernel mode, no priority can dislodge it. `PREEMPT` dissolves rows 5 and 13. `PREEMPT_RT` dissolves 14 too. Nothing dissolves row 20 — priority inversion needs priority inheritance, which is a property of the lock implementation (`rt_mutex`), not the kernel build.

### The four preemption models {#models}

A kernel build picks one model via `Kconfig`. Since v6.1, `PREEMPT_DYNAMIC` lets you switch the first three at boot with `preempt=none|voluntary|full`. Each trades throughput for latency.

| Model | Kernel preemptible? | Worst-case latency | Use case |
| --- | --- | --- | --- |
| PREEMPT\_NONE | Only at explicit schedule points | tens of ms | Throughput servers, HPC |
| PREEMPT\_VOLUNTARY | At `cond_resched()` calls | ~few ms | General-purpose distros |
| PREEMPT | Anywhere except spinlocks / IRQ-off | sub-ms (typical) | Low-latency desktop, audio |
| PREEMPT\_RT | Almost everywhere, including spinlocks | μs-scale (bounded) | Industrial control, robotics, telecom |

Figure 4 · worst-case latency by preemption model (log scale) SVG

<img src="/diagrams/kernel-internals-kubelet/4.svg" alt="kernel-internals-kubelet diagram 4" class="doc-diagram" />

Numbers are representative — real values depend on hardware (SMI, cache, NUMA) and drivers. The point is the order-of-magnitude difference, and that only RT gives a bounded ceiling rather than a typical figure.

### PREEMPT\_RT — what actually changes {#preempt-rt}

PREEMPT\_RT (formerly the "RT patches," merged in stages between v5.3 and v6.12) is not just "more preemption." It restructures several long-standing mechanisms so that almost any kernel code path can be preempted:

-   **Spinlocks become sleeping mutexes.** Most `spin_lock()`s are converted to `rt_mutex` — they sleep and support priority inheritance. The few that must remain non-sleeping are renamed `raw_spinlock_t`.
-   **Interrupts run in threads.** Each IRQ line gets a kthread that runs the handler. A high-priority RT task can preempt an interrupt handler.
-   **Softirqs are per-task.** Softirqs run in the context of the task that triggered them, or a dedicated kthread — no longer at random points in unrelated contexts.
-   **Priority inheritance everywhere.** When a low-priority task holds a lock a high-priority task needs, the holder is temporarily boosted (the classic Mars Pathfinder fix).

Note · the real latency culprit

On RT, missed deadlines are usually *not* "the kernel was busy." They are typically **SMIs from firmware** (invisible to Linux, can take milliseconds), CPU frequency transitions, or a stray `raw_spinlock_t` held too long by a pre-RT driver.

### Real-time workloads in practice {#rt-workload}

Real-time means **predictable**, not fast. A workload that must respond within 100 μs every time needs:

-   The PREEMPT\_RT kernel.
-   An RT scheduling class — `SCHED_FIFO` or `SCHED_DEADLINE` — set via `sched_setattr(2)`.
-   Memory pre-faulted with `mlockall(MCL_CURRENT | MCL_FUTURE)`.
-   CPU pinning via `sched_setaffinity()`, ideally onto an `isolcpus=`/`nohz_full=` isolated core.
-   No syscalls in the deadline-critical section that might take a sleeping lock.

```
// minimal SCHED_DEADLINE task
struct sched_attr attr = {
    .size           = sizeof(attr),
    .sched_policy   = SCHED_DEADLINE,
    .sched_runtime  = 100000,   // 100 μs budget
    .sched_deadline = 1000000,  // must finish within 1 ms
    .sched_period   = 1000000,  // every 1 ms
};
sched_setattr(0, &attr, 0);
mlockall(MCL_CURRENT | MCL_FUTURE);

while (running) {
    do_critical_work();
    sched_yield();   // hand back unused budget
}
```

Without PREEMPT\_RT, this task is "real-time" on paper but any other process can syscall into the kernel, take a spinlock, and stall it for milliseconds. The scheduler is honest; the rest of the kernel just isn't preemptible enough to honor it.

## Namespaces {#namespaces}

A **namespace** partitions a kernel resource so that processes inside see one view and processes outside see another. There is no virtualization layer — one kernel, one set of resources, just relabeled per-process. Cost is essentially zero; isolation is real but porous in security-relevant ways.

Every task has a `struct nsproxy` off its `task_struct`. The nsproxy carries pointers to namespace structs. Two tasks share a namespace by sharing a pointer; `setns(2)` is cheap because it's just a pointer swap.

```c
// include/linux/nsproxy.h — abridged
struct nsproxy {
    refcount_t           count;
    struct uts_namespace    *uts_ns;
    struct ipc_namespace    *ipc_ns;
    struct mnt_namespace    *mnt_ns;
    struct pid_namespace    *pid_ns_for_children;
    struct net              *net_ns;
    struct time_namespace   *time_ns;
    struct cgroup_namespace *cgroup_ns;
};
// User namespace lives on task_struct (->cred->user_ns), not nsproxy.
```

### The eight namespace types {#ns-types}

| Namespace | Isolates | Added |
| --- | --- | --- |
| MNT | Mount table — own filesystem tree | 2.4.19 (2002) |
| UTS | Hostname, domainname | 2.6.19 (2006) |
| IPC | SysV IPC, POSIX message queues | 2.6.19 |
| PID | Process IDs — PID 1 inside ≠ PID 1 outside | 2.6.24 (2008) |
| NET | Interfaces, routes, sockets, firewall | 2.6.29 (2009) |
| USER | UID/GID mappings — root in ≠ root out | 3.8 (2013) |
| CGROUP | cgroup root — hides host hierarchy | 4.6 (2016) |
| TIME | CLOCK\_MONOTONIC / CLOCK\_BOOTTIME offsets | 5.6 (2020) |

### The three syscalls {#ns-syscalls}

-   `clone(CLONE_NEW*)` — create a child in fresh namespaces. `CLONE_NEWPID | CLONE_NEWNET | …` can be OR'd. This is how containers are born.
-   `unshare(2)` — same flags, operates on the calling process: "detach me and give me new ones."
-   `setns(2)` — given an fd to `/proc/<pid>/ns/<type>`, join that namespace. How `nsenter` and `docker exec` work.

Figure 5 · task\_struct → nsproxy → namespace structs · pointer sharing SVG

<img src="/diagrams/kernel-internals-kubelet/5.svg" alt="kernel-internals-kubelet diagram 5" class="doc-diagram" />

Tasks A and B share one nsproxy by pointer — same hostname, mounts, network. Task C has its own nsproxy pointing at different structs. The kernel doesn't simulate this; it just dereferences different pointers.

### PID namespaces nest {#pid-ns}

PID namespaces are the most semantically rich because they **nest**. When you create a new PID namespace, the first process inside becomes `PID 1` in that namespace while keeping its larger PID in the parent. PID 1 in a PID namespace has init semantics — it reaps orphans, and if it dies the kernel kills every other process in the namespace.

Figure 6 · PID namespace nesting · one task, multiple PIDs SVG

<img src="/diagrams/kernel-internals-kubelet/6.svg" alt="kernel-internals-kubelet diagram 6" class="doc-diagram" />

Each PID namespace gets its own counter starting at 1. The same `task_struct` holds a PID for every namespace it's nested inside.

Warning · isolation ≠ security

A process in a container talks to the *same kernel* the host runs. A kernel CVE that allows arbitrary memory writes is just as exploitable from inside a container. This is why seccomp filters, capability dropping, and user namespaces matter at least as much as the namespaces themselves.

## Control groups {#cgroups}

Where namespaces answer "what can this process *see*?", cgroups answer "what can it *consume*?". A cgroup is a collection of processes plus a set of **controllers** attached to it — `cpu`, `memory`, `io`, `pids`, `cpuset`. Each accounts for one resource and can enforce limits.

The interface is a virtual filesystem at `/sys/fs/cgroup`. You create a cgroup by `mkdir`'ing a directory, add a process by writing its PID to `cgroup.procs`, and set limits by writing to files like `memory.max`. No special syscalls — just VFS.

### v1 vs v2 {#v1-v2}

cgroup v1 (2007) attached each controller to its own hierarchy — one process could be in different cgroups for memory vs cpu vs io. Flexible on paper, but it made joint resource reasoning impossible (the memory controller didn't know about writeback I/O attributed to the io controller).

cgroup v2 (3.16 / 2014, stabilised in 4.5) made one call: **unified hierarchy**. All controllers hang off the same tree; a process is in exactly one cgroup. PSI (Pressure Stall Information), unified memory+io accounting, and proper writeback attribution all became possible.

Figure 7 · cgroup v2 unified hierarchy · typical systemd host SVG

<img src="/diagrams/kernel-internals-kubelet/7.svg" alt="kernel-internals-kubelet diagram 7" class="doc-diagram" />

systemd manages slices automatically. Container runtimes plant their subtree under `machine.slice`. Limits compose: a process is bounded by its own cap, by `machine.slice`'s cap, and ultimately by the root.

### Worked example · create a cgroup by hand {#worked-example}

```bash
# 1. create a new cgroup
mkdir /sys/fs/cgroup/my_workload

# 2. enable controllers (must be enabled in parent first)
echo "+memory +cpu +io" > /sys/fs/cgroup/cgroup.subtree_control

# 3. set limits — 1 GiB memory, ~2 CPUs
echo 1073741824     > /sys/fs/cgroup/my_workload/memory.max
echo "200000 100000" > /sys/fs/cgroup/my_workload/cpu.max
#                       quota   period (μs)  →  200ms / 100ms = 2 CPUs

# 4. move a process in
echo $$ > /sys/fs/cgroup/my_workload/cgroup.procs

# 5. observe
cat /sys/fs/cgroup/my_workload/memory.current   # bytes in use
cat /sys/fs/cgroup/my_workload/cpu.stat          # usage + throttling
cat /sys/fs/cgroup/my_workload/memory.pressure   # PSI · % stalled
```

Exceed `memory.max` and the kernel either OOM-kills the offender or stalls allocations. Exceed `cpu.max` and the scheduler throttles the cgroup — tasks stay runnable but aren't picked.

#### Controllers, briefly

| Controller | Key files | Enforces |
| --- | --- | --- |
| cpu | cpu.max · cpu.weight · cpu.stat | CFS bandwidth quota or weight-based share |
| memory | memory.max · memory.high · memory.low · memory.swap.max | Hard cap + soft throttling + protection |
| io | io.max · io.weight · io.stat | Per-device bandwidth + IOPS, weight-based fairness |
| pids | pids.max · pids.current | Max number of tasks — defeats fork bombs |
| cpuset | cpuset.cpus · cpuset.mems | Restrict to specific CPUs / NUMA nodes |
| hugetlb | hugetlb.<size>.max | Cap on huge page consumption |

## Putting it together · containers {#containers}

The kernel has no `struct container`. What you call a container is a process tree with **(a)** its own set of namespaces, **(b)** membership in a cgroup with limits, **(c)** a chroot or pivot\_root, **(d)** a seccomp filter, **(e)** a reduced capability set. That's the entire definition.

Figure 8 · anatomy of a container SVG

<img src="/diagrams/kernel-internals-kubelet/8.svg" alt="kernel-internals-kubelet diagram 8" class="doc-diagram" />

The runtime is the recipe; the kernel is the kitchen.

### Container birth sequence {#birth}

Strip away tooling and `docker run alpine sh` looks like this at the kernel:

```
// 1. runtime forks with namespace flags
pid_t child = clone(child_fn, stack_top,
    CLONE_NEWPID | CLONE_NEWNS  | CLONE_NEWNET |
    CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER |
    CLONE_NEWCGROUP | SIGCHLD, args);

// 2. parent writes mappings + cgroup membership
write_file("/proc/{child}/uid_map", "0 100000 65536");
write_file("/proc/{child}/gid_map", "0 100000 65536");
write_file("/sys/fs/cgroup/machine.slice/docker-abc.scope/cgroup.procs", child);

// 3. inside the child
sethostname("abc123", 6);
mount("/var/lib/docker/.../merged", "/newroot", ...);
pivot_root("/newroot", "/newroot/.old");
umount2("/.old", MNT_DETACH);
mount("proc", "/proc", "proc", 0, 0);

prctl(PR_SET_NO_NEW_PRIVS, 1);
seccomp(SECCOMP_SET_MODE_FILTER, 0, &filter);
capset(&hdr, &reduced_caps);

execve("/bin/sh", argv, envp);
```

That sequence *is* the container. Everything else — image layers, registries, orchestration, networking — is machinery built around it.

### Closing the loop with preemption {#closing-loop}

A real-time process inside a container still runs on the same kernel under the same preemption model. But:

-   If the container is under `cpu.max` throttling, even `SCHED_FIFO` can be denied the CPU when the quota is exhausted. Throttling sits *above* the scheduler class. RT workloads usually use `cpu.weight` with no hard cap, or pin via `cpuset`.
-   Memory pressure in a sibling cgroup can stall your allocations via direct reclaim, which on a non-RT kernel takes spinlocks that block your wakeup. PREEMPT\_RT keeps those sleepable.
-   PSI files (`cpu.pressure`, `memory.pressure`, `io.pressure`) report stalled-time percentages per cgroup — the input modern OOM-killers (`oomd`, `systemd-oomd`) actually use.

Tip · the through-line

Preemption decides **when** a task runs. Cgroups decide **how much**. Namespaces decide **what world it runs in**. The kernel composes them orthogonally — and that orthogonality is why Linux is simultaneously a real-time OS, a desktop, and the foundation under every cloud you've used.

## Advanced networking {#networking}

The Linux TCP stack is one of the most-tuned pieces of software on earth. Every packet traverses a sequence of layers — NIC driver, softirq, IP, TCP, socket — and at every layer there are hooks, knobs, and bypasses. Two questions matter most in practice: how does the kernel decide *how fast to send*, and how do you cut latency to the bone for an application that needs microseconds?

### TCP congestion control {#cc}

TCP sends as much data as the smaller of two limits allows: the **receive window** (`rwnd`) advertised by the peer, and the **congestion window** (`cwnd`) maintained by the sender. The first prevents the receiver's buffer from overflowing. The second prevents the network from collapsing under your load. Effective send rate is `min(cwnd, rwnd) / RTT` — and all the interesting algorithm is how `cwnd` moves.

Classic **Reno** (1988) treats packet loss as the only signal of congestion. It inflates `cwnd` until something drops, then halves and tries again — the familiar sawtooth. The Linux default since 2.6.19 is **CUBIC**, which uses a cubic function of time-since-loss instead of linear growth, so it recovers faster on long-fat pipes. **BBR** (Google, 2016) abandons loss as a signal entirely and instead models the path's bottleneck bandwidth and minimum RTT directly.

Figure 9 · cwnd evolution by algorithm SVG

<img src="/diagrams/kernel-internals-kubelet/9.svg" alt="kernel-internals-kubelet diagram 9" class="doc-diagram" />

Sawtooth = loss-based (Reno/CUBIC). Smooth band = BBR steady-state, where the algorithm tracks an estimate of bandwidth-delay product rather than reacting to drops. On a lossy WAN, BBR keeps the pipe full while CUBIC keeps backing off; on a clean fabric, BBR can be unfair to CUBIC peers.

#### The four phases

-   **Slow start.** Connection opens with `cwnd` = 10 MSS (RFC 6928). Each ACK bumps `cwnd` by one MSS, so it doubles every RTT. Continues until `cwnd ≥ ssthresh` or loss.
-   **Congestion avoidance.** Linear growth: `cwnd += 1 MSS` per RTT. (CUBIC replaces this with a cubic-of-time-since-loss function.)
-   **Fast retransmit.** Three duplicate ACKs → assume a single packet lost, retransmit without waiting for the RTO.
-   **Fast recovery.** After fast retransmit, drop `cwnd` by some factor (Reno: ½, CUBIC: 0.7) and re-enter congestion avoidance — don't fall back to slow start.

The sender's algorithm is pluggable: `setsockopt(IPPROTO_TCP, TCP_CONGESTION, "bbr")` per-socket, or `sysctl net.ipv4.tcp_congestion_control=bbr` system-wide. Each algorithm ships as a kernel module under `tcp_*.ko`.

| Algorithm | Signal | Best for | Failure mode |
| --- | --- | --- | --- |
| Reno / NewReno | Loss | Reference; short fat pipes | Slow recovery on high BDP |
| CUBIC (default) | Loss | WAN, datacentre, default | Buffer-bloats with shallow queues |
| BBR / BBRv2 | BW × RTT model | Lossy paths, long RTT, video | Can starve CUBIC at a shared bottleneck |
| DCTCP | ECN marks | Datacentre fabrics | Needs ECN end-to-end |
| Vegas | RTT increase | Research | Loses to loss-based peers |

```bash
# Show available algorithms (loaded modules)
sysctl net.ipv4.tcp_available_congestion_control
# cubic reno bbr

# Switch system-wide
sysctl -w net.ipv4.tcp_congestion_control=bbr

# Per-socket from C
const char *cc = "bbr";
setsockopt(fd, IPPROTO_TCP, TCP_CONGESTION, cc, strlen(cc));

# Live inspection of one socket
ss -tin 'sport = :443'   # cwnd, ssthresh, rtt, retrans, bbr_bw
```

Note · who picks the algorithm

Only the *sender* picks. On an asymmetric flow — a server pushing video to a phone — the server's congestion control governs throughput. Switching the client to BBR does nothing for downloads.

### Low-latency network optimizations {#low-latency-net}

"Low latency" in networking means cutting two costs: the time a packet spends in the kernel, and the time the CPU spends being interrupted to handle it. The Linux network path was originally tuned for throughput — coalesce, batch, schedule — and the low-latency path inverts most of those defaults.

Figure 10 · RX packet path · hook points and bypasses SVG

<img src="/diagrams/kernel-internals-kubelet/10.svg" alt="kernel-internals-kubelet diagram 10" class="doc-diagram" />

Each layer adds latency you may not need. **XDP** runs eBPF in the driver before the skb exists. **AF\_XDP** redirects raw frames to userspace. **DPDK** skips the kernel altogether — userspace polls the NIC over UIO/VFIO.

#### Knobs that actually move the needle

| Layer | Knob | Effect |
| --- | --- | --- |
| NIC | `ethtool -C eth0 rx-usecs 0` | Disable interrupt coalescing — IRQ per packet |
| NIC | `ethtool -K eth0 gro off lro off` | Stop merging segments — hurts throughput, helps latency |
| IRQ | `/proc/irq/N/smp_affinity` | Pin NIC IRQs to specific cores (often near app) |
| Softirq | RSS + RPS/RFS | Spread receive work; RFS lands packets on the consumer's core |
| Socket | `SO_BUSY_POLL` | Spin in the kernel polling the NIC instead of sleeping |
| Socket | `TCP_NODELAY` | Disable Nagle — send every write immediately |
| Socket | `TCP_QUICKACK` | Disable delayed ACK on receive side |
| Sysctl | `net.core.busy_poll` | Default busy-poll budget (μs) for `poll()`/`epoll()` |
| App | AF\_XDP, DPDK, io\_uring | Kernel bypass — userspace handles the NIC |

```bash
# A minimal low-latency profile for a single NIC + app

# 1. Disable IRQ coalescing — every packet wakes the CPU now
ethtool -C eth0 adaptive-rx off adaptive-tx off rx-usecs 0 tx-usecs 0

# 2. Disable segment-merging offloads
ethtool -K eth0 gro off lro off gso off tso off

# 3. Pin all NIC IRQs to cores 2-3 (away from the app on 4-5)
for irq in $(grep eth0 /proc/interrupts | awk -F: '{print $1}'); do
    echo c > /proc/irq/$irq/smp_affinity      # mask = 0b1100
done

# 4. Enable RFS — receive flow steering to app's core
echo 32768 > /proc/sys/net/core/rps_sock_flow_entries
echo 4096  > /sys/class/net/eth0/queues/rx-0/rps_flow_cnt

# 5. Busy-poll for 50 μs on every epoll wait
sysctl -w net.core.busy_poll=50
sysctl -w net.core.busy_read=50

# 6. App-side socket options
int on = 1, us = 50;
setsockopt(fd, IPPROTO_TCP, TCP_NODELAY,   &on, sizeof(on));
setsockopt(fd, IPPROTO_TCP, TCP_QUICKACK,  &on, sizeof(on));
setsockopt(fd, SOL_SOCKET,  SO_BUSY_POLL,  &us, sizeof(us));

# 7. Pin the app, isolate the core, set governor to performance
cpupower frequency-set -g performance
taskset -c 4 ./trading_app    # core 4 must be in isolcpus= at boot
```

Warning · trade-offs

Every "spin instead of sleep" knob trades a CPU core for latency. `SO_BUSY_POLL` + DPDK can pin a core at 100% with zero traffic. Budget your cores or your power bill will. Equally: disabling GSO/TSO can cap your *throughput* at a few Gbps when you used to do 25 — only do it if latency is the actual constraint.

## Memory management {#memory}

Two effects dominate how a modern process experiences memory: **which** RAM it lands on (NUMA), and **how big** a page table entry covers (huge pages). Both are mostly invisible until they aren't — and then they explain ten-times performance swings that nothing else does.

### NUMA · non-uniform memory access {#numa}

A multi-socket server doesn't have *one* memory bus. Each CPU socket has its own memory controller wired to its own DIMMs — that's a **NUMA node**. Reaching memory on another socket means crossing an inter-socket interconnect (Intel UPI, AMD Infinity Fabric), which costs both latency and bandwidth.

Figure 11 · 2-socket NUMA topology · local vs remote access SVG

<img src="/diagrams/kernel-internals-kubelet/11.svg" alt="kernel-internals-kubelet diagram 11" class="doc-diagram" />

Inspect with `numactl -H` or `lscpu`. The *distance* matrix (10 / 21 typical) is the kernel's per-node cost estimate — it drives the allocator's fallback order.

#### How the kernel allocates by default

Linux uses **first-touch** placement. `malloc` doesn't allocate physical memory — it expands the heap. The first time a thread *writes* a page, the page fault handler picks a physical frame on the node where that thread is currently running. If you allocate a buffer on one thread and use it on another, the buffer is on the wrong node.

You can override this with `mbind(2)`, `set_mempolicy(2)`, or the `numactl` wrapper:

| Policy | Behaviour |
| --- | --- |
| MPOL\_DEFAULT | First-touch (the default) |
| MPOL\_BIND | Allocate only on the listed nodes — OOM if those fill |
| MPOL\_PREFERRED | Try a node, fall back to anywhere |
| MPOL\_INTERLEAVE | Round-robin pages across nodes — good for streaming workloads |

```bash
# Inspect topology
numactl -H
# node 0 cpus: 0 1 2 3      size: 128 GB      free: 96 GB
# node 1 cpus: 4 5 6 7      size: 128 GB      free: 110 GB
# distances:  10  21
#             21  10

# Pin process + memory to node 0
numactl --cpunodebind=0 --membind=0 ./db

# Interleave a large analytics buffer across nodes
numactl --interleave=all ./spark-worker

# Per-allocation in C
unsigned long mask = 1UL;  // node 0 only
mbind(buf, len, MPOL_BIND, &mask, 2, MPOL_MF_STRICT | MPOL_MF_MOVE);

# Per-process stats
numastat -p $(pidof postgres)
# numa_hit · numa_miss · numa_foreign · interleave_hit · local_node · other_node
```

Tip · NICs and GPUs are NUMA-attached too

A PCIe NIC connects to one socket. Packets DMA into that socket's RAM. If your app runs on the *other* socket, every received byte makes a UPI round-trip. `cat /sys/class/net/eth0/device/numa_node` tells you which. Pin the app to the matching node — this is often the single biggest networking win on a 2-socket box.

### Transparent Huge Pages {#thp}

The CPU's MMU translates virtual addresses through a multi-level page table. On x86\_64 with 4 KiB pages, that's a **four-level walk** on every TLB miss — four cacheline-bounded loads from memory. The TLB holds maybe 1500 entries, so it covers ~6 MiB of working set. A process with a 10 GiB heap thrashes the TLB constantly.

A **huge page** is one TLB entry covering 2 MiB (or 1 GiB) of contiguous physical RAM. Same translation cost, 512× more memory covered. On big-heap workloads — JVMs, in-memory databases, ML inference — this alone can be a 5-30% throughput win.

Figure 12 · page table walk · 4 KiB vs 2 MiB SVG

<img src="/diagrams/kernel-internals-kubelet/12.svg" alt="kernel-internals-kubelet diagram 12" class="doc-diagram" />

The bottom row reuses the existing L3-L4 tables and just terminates one level earlier (the PS — Page Size — bit). Same MMU, fewer loads, vastly larger coverage per TLB entry.

#### THP modes & when to flip them

THP is a kernel feature (since 2.6.38) that hands out 2 MiB pages opportunistically without the app asking. A background kthread, `khugepaged`, scans existing 4 KiB mappings and tries to *collapse* them into huge pages when 512 contiguous frames are available. Three system-wide modes via `/sys/kernel/mm/transparent_hugepage/enabled`:

| Mode | Behaviour | Good for | Bad for |
| --- | --- | --- | --- |
| always | Every anonymous mapping aspires to be huge | JVM, Redis, analytics | Random small allocations |
| madvise | Only mappings marked `MADV_HUGEPAGE` | Default for many distros | — |
| never | Use 4 KiB everywhere | Latency-critical, KVM hosts with overcommit | Big-heap throughput apps |

Danger · why databases often disable THP

Allocating a 2 MiB page requires 512 contiguous 4 KiB frames. Under fragmentation, the kernel does **compaction** — moves pages around to free up a contiguous block — and the faulting thread *waits*. The pause can be tens of milliseconds. MongoDB, Redis, PostgreSQL and Oracle all recommend setting THP to `never` or `madvise` precisely because the tail-latency surprise is worse than the TLB win. JVM apps with a fixed large heap usually do the opposite — pre-fault at startup with `-XX:+AlwaysPreTouch` and reap the steady-state benefit.

```bash
# Inspect current setting
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never        — brackets show current

# Switch to madvise — apps must opt in
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# Disable entirely (recommended for many databases)
echo never   > /sys/kernel/mm/transparent_hugepage/enabled
echo never   > /sys/kernel/mm/transparent_hugepage/defrag

# Per-process: opt a region in
void *p = mmap(NULL, len, PROT_READ|PROT_WRITE,
                MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);
madvise(p, len, MADV_HUGEPAGE);     // hint to use 2 MiB pages

# Observe
grep -i huge /proc/meminfo
# AnonHugePages: 2097152 kB    — anon mapped via THP
# HugePages_Total:        0    — explicit hugetlbfs pool

cat /proc/$$/status | grep -i huge   # per-process
```

#### THP vs hugetlbfs

Two unrelated huge-page mechanisms coexist. **THP** is opportunistic — the kernel hands out 2 MiB pages from regular memory when convenient. **hugetlbfs** is a reservation: at boot, `vm.nr_hugepages=4096` sets aside 8 GiB of 2 MiB pages that *only* hugetlbfs-aware code can touch. Hugetlbfs gives guaranteed, never-swapped, never-compacted huge pages — at the cost of reserving the memory up-front whether you use it or not. Databases like Oracle and PostgreSQL (`huge_pages=on`) use hugetlbfs precisely because it sidesteps the compaction-stall problem.

## Storage systems {#storage}

Two questions for any storage stack: **which filesystem** sits on the device, and **how does the kernel order I/O** as it hands requests to that device. Both choices have stopped being one-size-fits-all in the last decade — NVMe in particular has rewritten the rules for what the block layer should even do.

### XFS vs ext4 · write-heavy workloads {#fs}

Both filesystems use extents (variable-length contiguous ranges instead of per-block pointers), both support delayed allocation (defer placement decisions until writeback), and both have journals. The differences that matter for write-heavy work are in *concurrency* and *scale*.

**XFS** partitions the filesystem into independent **allocation groups** (AGs), typically 8 of them. Each AG is essentially a mini-filesystem with its own free-space B+tree, inode B+tree, and allocator. Writes to different AGs proceed in parallel with no lock contention. On a 64-core box doing parallel writes, this is dramatic.

**ext4** uses **block groups** too, but the allocator and journal are more centralised. ext4 is excellent for the small-file, single-stream workloads most laptops and many web servers run — lower overhead, slightly faster `fsync`, better behaviour on small files. Where it loses to XFS is many-threaded streaming writes to large files.

Figure 13 · parallel write scaling · concurrent writers SVG

<img src="/diagrams/kernel-internals-kubelet/13.svg" alt="kernel-internals-kubelet diagram 13" class="doc-diagram" />

Shape, not exact numbers — actual figures depend on device, filesystem options, and benchmark. The qualitative pattern is well-replicated: XFS scales linearly with writers up to the device limit; ext4 plateaus and can even regress past a few dozen threads because of journal contention.

| Concern | XFS | ext4 |
| --- | --- | --- |
| Many parallel writers | Excellent — independent AGs | Good single-stream, plateaus |
| Single-thread fsync latency | OK | Slightly lower |
| Huge files (TB-scale) | Designed for it (SGI heritage) | Capable, less battle-tested at PB |
| Lots of small files | Slightly slower inode allocator | Faster, traditional strength |
| Shrink filesystem | Not supported | Supported (offline) |
| Real-time / RT subvolume | Yes (rtdev) | No |
| Default in | RHEL/Rocky 7+, SUSE | Debian, Ubuntu (server) |

```bash
# XFS — format with stripe alignment for RAID, 32 AGs for high parallelism
mkfs.xfs -d agcount=32,su=64k,sw=8 /dev/nvme1n1
mount -o noatime,nodiratime,logbsize=256k,allocsize=16m /dev/nvme1n1 /data

# ext4 — same disk, write-heavy tuning
mkfs.ext4 -E stride=16,stripe-width=128 /dev/nvme1n1
mount -o noatime,data=writeback,journal_async_commit /dev/nvme1n1 /data

# Common: defer atime + bigger writeback windows
sysctl -w vm.dirty_background_ratio=5
sysctl -w vm.dirty_ratio=20
sysctl -w vm.dirty_expire_centisecs=3000
```

Note · rule of thumb

Database write-ahead log, parallel ETL, video ingest, large-file workloads → **XFS**. Web server, mail spool, CI build caches, lots of small files → **ext4** is fine and the slightly lower overhead can show. Both are production-grade; the wrong choice costs single-digit percent, not multiples.

### The I/O scheduler · why CFQ is gone {#io-sched}

The block layer used to have one queue per device and a per-queue scheduler. The classic schedulers — `noop`, `deadline`, `cfq` — were designed for spinning disks where reordering matters because *seeks are expensive*. Two seeks of 40 cm vs two seeks of 4 mm is a 10× latency difference. Scheduling around that was the whole point.

NVMe broke that model. A modern SSD has no seek cost, supports **64 K hardware queues**, and wants thousands of in-flight requests. Linux 5.0 (2019) removed the legacy single-queue block layer entirely. The current schedulers all sit on the new **multi-queue (blk-mq)** framework:

| Scheduler | Strategy | Best for | Avoid for |
| --- | --- | --- | --- |
| none | No reordering — submit FIFO | NVMe, fast SSDs | HDDs |
| mq-deadline | Per-request expiry; reads prioritised over writes | SATA SSD, HDD, general | — |
| bfq | Budget-fair queueing, per-process | Interactive desktop, mixed workload HDD | High-IOPS server |
| kyber | Latency-target based, lightweight | NVMe with mixed read/write tail-latency | — |

**CFQ** (Completely Fair Queueing) was the desktop default for a decade. Its successor in spirit is **BFQ**: same goal (per-process fairness, interactive responsiveness), much smarter heuristics, ported to blk-mq. **Deadline**'s descendant is **mq-deadline**: per-request expiry to prevent starvation, with reads weighted ahead of writes because applications usually wait on reads synchronously and queue writes asynchronously.

Figure 14 · how mq-deadline reorders requests SVG

<img src="/diagrams/kernel-internals-kubelet/14.svg" alt="kernel-internals-kubelet diagram 14" class="doc-diagram" />

Two FIFOs (read & write) plus a sector-sorted view. The dispatcher prefers reads but enforces per-request deadlines so writes can't starve. On NVMe most of this is wasted CPU — use `none`.

```bash
# Check current scheduler — brackets show selected
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber bfq

# Switch at runtime — applies immediately
echo mq-deadline > /sys/block/sda/queue/scheduler

# Persist via udev rule
cat > /etc/udev/rules.d/60-io-sched.rules <<'EOF'
# NVMe — no scheduling, deep hardware queues
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", ATTR{queue/scheduler}="none"
# Rotational disks — deadline
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="mq-deadline"
EOF

# Tune mq-deadline thresholds
echo 250  > /sys/block/sda/queue/iosched/read_expire   # ms
echo 2500 > /sys/block/sda/queue/iosched/write_expire  # ms
echo 1    > /sys/block/sda/queue/iosched/writes_starved # cap

# Observe live
iostat -xz 1
cat /sys/block/sda/queue/iosched/stats         # BFQ-style schedulers expose extras
```

#### Picking a scheduler in 2026

-   **NVMe SSD** — `none`. The device has its own deep queues; the kernel scheduler just adds CPU overhead and can hurt tail latency. Some kernels default to `none` for NVMe; verify with `cat .../queue/scheduler`.
-   **SATA SSD** — `mq-deadline` or `kyber`. The device queue is shallower (32 commands), some ordering wins remain. Kyber is preferred when read tail-latency under mixed load matters.
-   **HDD** — `mq-deadline` for servers and databases, `bfq` for desktops where interactive responsiveness while a background job copies files matters more than aggregate throughput.
-   **Virtual disk (KVM, cloud)** — `none`. The hypervisor or backing store does the real scheduling; you're just stacking schedulers if you add one.

Tip · the meta-point

Filesystems and schedulers stopped being interchangeable defaults around the time per-device IOPS crossed a million. The right pairing for a 7200-RPM disk is the wrong pairing for an NVMe RAID, and vice versa. The good news: you can change both in one terminal session, on a live system, without rebooting.

## Service tuning · the systemd cookbook {#systemd-cookbook}

When the theory of classes, nice values, preemption, and cgroups meets a running production service, systemd unit files are where you encode the policy. This is the compact reference — what each directive does, how they compose, five worked profiles, and what to type to verify it took effect.

### The directives {#systemd-knobs}

Eleven unit-file lines cover almost every scheduling and resource decision. Each maps to a specific kernel syscall systemd makes between `fork()` and `execve()`:

| Directive | Sets | Kernel syscall | Notes |
| --- | --- | --- | --- |
| Nice= | nice value −20…+19 | `setpriority()` | SCHED\_NORMAL/BATCH only · ignored under fifo/rr/deadline |
| CPUSchedulingPolicy= | scheduling class | `sched_setscheduler()` | other · batch · idle · fifo · rr · deadline |
| CPUSchedulingPriority= | rt\_priority 1–99 | `sched_setscheduler()` | Only fifo/rr/deadline · higher beats lower |
| CPUAffinity= | CPU mask | `sched_setaffinity()` | List/range syntax · pair with `isolcpus=` |
| IOSchedulingClass= | I/O class | `ioprio_set()` | realtime · best-effort · idle · only BFQ fully honours |
| IOSchedulingPriority= | I/O priority 0–7 | `ioprio_set()` | 0 = highest · realtime+0 = jumps every queue |
| LimitMEMLOCK= | RLIMIT\_MEMLOCK | `setrlimit()` | Required for `mlockall()` · 'infinity' for RT |
| LimitRTPRIO= · LimitRTTIME= | RT caps | `setrlimit()` | Allow process to self-elevate · don't kill on long bursts |
| OOMScoreAdjust= | OOM kill priority −1000…+1000 | write `oom_score_adj` | Lower = killed later · −500 protects critical services |
| CPUWeight= · CPUQuota= | cgroup v2 CPU controls | write cgroup files | Weight = soft share · Quota = hard ceiling |
| MemoryHigh= · MemoryMax= | cgroup v2 memory controls | write cgroup files | High = throttle · Max = cgroup-OOM |

### How they compose {#systemd-compose}

The directives are not independent. Class overrides nice; cgroup limits sit above all per-task policy; rlimits gate what the process itself can later request.

| If you set... | Then this is the effect |
| --- | --- |
| No scheduling directives | SCHED\_NORMAL · nice=0 · weight 1024 · no affinity · no caps |
| Nice= alone | SCHED\_NORMAL with adjusted weight · proportional CPU share |
| CPUSchedulingPolicy=fifo + Priority=N | SCHED\_FIFO @ N · **Nice= silently ignored** · class beats nice |
| CPUSchedulingPolicy=idle | SCHED\_IDLE · Nice= ignored · runs only on otherwise-idle CPU |
| CPUAffinity=4-7 without `isolcpus=4-7` | App on cores 4-7 — but so is everything else · cache contention remains |
| LimitMEMLOCK=infinity without `mlockall()` | Limit raised but unused · app must actually call the syscall |
| MemoryMax=4G + Nice=-10 | Both apply · CPU favoured + hard 4 GiB cap · over-budget → cgroup-OOM |

### Five production profiles {#systemd-profiles}

#### 1 · Background batch — nightly job, runs when capacity is free

```
[Service]
ExecStart=/opt/etl/nightly_aggregator.py
CPUSchedulingPolicy=idle          # SCHED_IDLE — last in line
IOSchedulingClass=idle            # I/O only when nobody else needs disk
Nice=19                           # belt-and-suspenders if policy resets
```

Effect: cannot starve any foreground workload. Acceptable if "done by morning" is the only requirement.

#### 2 · General service — web app, REST API, app server

```
[Service]
ExecStart=/usr/bin/myapp --port=8080
Nice=-5                           # weight ≈ 3× default → ~3× CPU share under load
IOSchedulingClass=best-effort
IOSchedulingPriority=2            # default within class is 4
Restart=on-failure
```

Effect: ~3× CPU share over default-nice peers under contention. Still fair-scheduled — no preemption surprises, no risk of locking out the system.

#### 3 · Latency-sensitive — database, in-memory cache, payment processor

```
[Service]
ExecStart=/opt/db/server
Nice=-10                          # CFS weight 9548 ≈ 9× default
CPUAffinity=4-15                  # pin to NUMA node that owns NIC + storage
IOSchedulingClass=realtime
IOSchedulingPriority=0
LimitMEMLOCK=infinity             # lock buffer pool to prevent page-out
LimitNOFILE=1048576               # many client connections
OOMScoreAdjust=-500               # last to be OOM-killed
Restart=on-failure
```

Effect: heavily favoured under CPU contention, NUMA-local, can mlock its working set, hard to OOM. Still SCHED\_NORMAL — won't deadlock the system if buggy. **This is the right profile for ~95% of "important service" cases.**

#### 4 · Hard real-time — audio engine, trading hot path, control loop

```
[Service]
ExecStart=/opt/hft/engine
CPUSchedulingPolicy=fifo
CPUSchedulingPriority=50          # mid range — leaves headroom for kernel RT threads
CPUAffinity=4-7                   # must match isolcpus= in kernel cmdline
LimitMEMLOCK=infinity             # app calls mlockall() at startup
LimitRTPRIO=99                    # app may self-elevate
LimitRTTIME=infinity              # don't kill on RLIMIT_RTTIME bursts
IOSchedulingClass=realtime
IOSchedulingPriority=0
OOMScoreAdjust=-1000              # never OOM-killed
Restart=no                        # RT crashes escalate to humans
```

Required boot cmdline (set in `/etc/default/grub`):

```
GRUB_CMDLINE_LINUX_DEFAULT="... preempt=full isolcpus=4-7 nohz_full=4-7
  rcu_nocbs=4-7 intel_pstate=disable processor.max_cstate=1
  hugepagesz=2M hugepages=2048 irqaffinity=0-3"
```

Effect: SCHED\_FIFO @ 50 beats every SCHED\_NORMAL task on the box — including ones at nice=−20. Pinned to cores nothing else runs on (isolcpus). Memory locked. With `preempt=full` or PREEMPT\_RT kernel underneath, preemption latency is bounded in microseconds.

#### 5 · Resource-isolated — tenant workload with strict budget

```
[Service]
ExecStart=/usr/bin/microservice
Slice=workload-tenant-a.slice     # place under a custom parent slice
CPUWeight=200                     # cgroup v2 · default 100 · soft share
CPUQuota=200%                     # hard ceiling: 2 cores
MemoryHigh=3G                     # throttle starts here
MemoryMax=4G                      # cgroup-OOM above here
MemorySwapMax=0                   # never swap
IOWeight=200                      # cgroup-level I/O fairness
TasksMax=512                      # max threads/processes
```

Effect: this service's cgroup is capped at 2 cores and 4 GiB regardless of what it tries. Kernel enforces below the per-task scheduler. PSI signals on the cgroup feed an autoscaler.

### Verifying what's actually applied {#systemd-verify}

```bash
# All effective settings
systemctl show myapp.service | grep -E 'Nice|CPU|IO|Limit|Memory'

# Running-process snapshot — class, rt-prio, nice, current CPU
ps -o pid,comm,policy,rtprio,nice,psr -p $(pidof myapp)
# POLICY: TS=NORMAL  FF=FIFO  RR=RR  IA=IDLE  B=BATCH  DLN=DEADLINE

chrt -p $(pidof myapp)
#   scheduling policy: SCHED_FIFO
#   scheduling priority: 50

taskset -p $(pidof myapp)
#   current affinity mask: f0   (CPUs 4,5,6,7)

ionice -p $(pidof myapp)
#   realtime: prio 0

cat /proc/$(pidof myapp)/limits           # all rlimits
cat /proc/$(pidof myapp)/cgroup            # cgroup placement
cat /proc/$(pidof myapp)/oom_score_adj    # OOM bias

# cgroup-side enforcement values
cat /sys/fs/cgroup/system.slice/myapp.service/cpu.max         # quota period
cat /sys/fs/cgroup/system.slice/myapp.service/memory.max
cat /sys/fs/cgroup/system.slice/myapp.service/cpu.pressure    # PSI live
```

### Common gotchas

-   **Nice= silently ignored.** If `CPUSchedulingPolicy=fifo/rr` is set, Nice= does nothing — systemd does not warn.
-   **LimitMEMLOCK without `mlockall()`.** Raising the limit doesn't lock anything; the app must call the syscall.
-   **CPUAffinity without `isolcpus=`.** You pinned the app to those cores; you did not reserve them. Other tasks still land there.
-   **IOSchedulingClass=realtime on NVMe.** NVMe usually uses scheduler `none` — class is decorative. Only matters under BFQ.
-   **CPUSchedulingPriority=99.** Don't. Kernel RT threads live at 50–99. Out-prioritising them can deadlock the box.
-   **Restart=on-failure with SCHED\_FIFO.** A FIFO bug pegging a core can crash-loop fast enough to lock you out. Pair with `RestartSec=` + `StartLimitBurst=`.
-   **CPUQuota and CFS throttling.** Hard limits enforce on 100 ms periods. A burst over quota stalls the whole cgroup for the rest of the period — tail-latency surprise. Prefer `CPUWeight=` if you don't need a strict ceiling.
-   **RT throttling.** By default RT tasks get capped at 95% of any wall second (`kernel.sched_rt_runtime_us`). Hot-loop RT needs `LimitRTTIME=infinity` and/or `sysctl kernel.sched_rt_runtime_us=-1`.

Tip · the right pattern for "make this service important"

99% of services that "need to be important" do not need real-time scheduling. They need three lines: **`Nice=-10`**, **`LimitMEMLOCK=infinity`**, **`OOMScoreAdjust=-500`**. That gives ~9× CPU share under contention, ability to lock pages in RAM, and resistance to OOM. Reserve `fifo`/`rr` for genuine sub-millisecond cases — and only after installing a `PREEMPT` or `PREEMPT_RT` kernel.

## Troubleshooting playbooks {#troubleshooting}

Four scenarios that test whether someone can diagnose a Linux system under pressure. Each follows the same shape: **characterize the symptom precisely**, walk the stack, prove the cause, fix it — in that order. Jumping to "fix it" without "prove the cause" is how outages drag on for days.

### System freeze · production server, zero logs {#freeze}

"The production server is frozen and isn't producing logs." First step is to refuse the framing — "frozen" is ambiguous. Six distinct things look like a freeze from outside:

1.  **Kernel panic.** Kernel died. Oops/panic in `kmsg` if console reachable; otherwise nothing.
2.  **Hard lockup.** A CPU stuck with interrupts disabled — usually a tight loop in kernel code. NMI watchdog fires after `watchdog_thresh` seconds.
3.  **Soft lockup.** CPU stuck in kernel mode but interrupts still on. Soft-watchdog prints a stack to dmesg.
4.  **Hung task.** One task in uninterruptible sleep > 120 s (`hung_task_timeout_secs`). Detector prints its stack.
5.  **Userspace deadlock.** Kernel fine; critical services hung. SSH may work; the workload doesn't.
6.  **Resource exhaustion.** OOM, fd starvation, swap-death — looks slow rather than sudden.

Distinguishing these decides everything that follows. The diagnostic capability you have depends on how dead the system is — pick the highest-capability path that still works:

Figure 15 · system freeze · diagnostic capability ladder SVG

<img src="/diagrams/kernel-internals-kubelet/15.svg" alt="kernel-internals-kubelet diagram 15" class="doc-diagram" />

Each level removes a capability. Set up `kdump`, persistent `journald`, and BMC/IPMI access *before* a freeze — without them, level 5 is your only option and you'll have nothing to debug from.

#### Magic SysRq · the kernel-resident backdoor

Works when userspace is unreachable because SysRq handlers run in IRQ context. Enable *before* trouble — it's a 5-second setup that pays back catastrophically.

```bash
# enable at boot
echo "kernel.sysrq = 1" > /etc/sysctl.d/99-sysrq.conf

# via /proc on a still-half-alive system; or Alt-SysRq-<key> on physical/BMC console
echo t > /proc/sysrq-trigger    # dump every task's stack to dmesg
echo w > /proc/sysrq-trigger    # only D-state (uninterruptible) tasks — fastest signal
echo l > /proc/sysrq-trigger    # NMI backtrace on every CPU — catches hard lockups
echo m > /proc/sysrq-trigger    # memory state, slab info, free-page counts
echo p > /proc/sysrq-trigger    # CPU registers
echo c > /proc/sysrq-trigger    # intentional panic → triggers kdump
echo s > /proc/sysrq-trigger    # emergency filesystem sync
echo u > /proc/sysrq-trigger    # remount all read-only
echo b > /proc/sysrq-trigger    # immediate reboot — last resort
```

#### kdump · post-mortem of a dead kernel

kdump reserves a chunk of RAM at boot (`crashkernel=512M` on the kernel cmdline) and `kexec`'s a second kernel into it. When the production kernel panics, the reserve kernel takes over, writes `vmcore` to disk, and reboots back. You analyse the dump offline with the `crash(8)` utility — GDB-like access to a snapshot of every CPU, every kernel structure, every stack at the moment of death.

```sql
# Set up (Debian/Ubuntu)
apt install kexec-tools makedumpfile crash linux-image-$(uname -r)-dbg
# /etc/default/grub:  GRUB_CMDLINE_LINUX_DEFAULT="... crashkernel=512M"
update-grub && systemctl enable --now kdump-tools

# Force a capture (test or from a stuck system)
echo c > /proc/sysrq-trigger

# Analyse the resulting vmcore
crash /usr/lib/debug/boot/vmlinux-$(uname -r) /var/crash/202605.../vmcore
crash> bt -a                # backtrace every CPU
crash> ps -m               # task states with ms-resolution sleep time
crash> foreach UN bt       # every D-state task's stack
crash> log                 # kmsg ring buffer
crash> dev -d              # in-flight block I/O
crash> mod -S              # loaded modules with symbols
```

#### Live debugging · when SSH still works

```bash
# What's every CPU doing right now?
perf top -a -g                              # with call graphs

# What is process 1234 stuck on?
cat /proc/1234/stack                        # kernel stack of the task
cat /proc/1234/wchan                        # single function name it's sleeping in
cat /proc/1234/status | grep State           # State: D = uninterruptible
cat /proc/1234/syscall                      # current syscall number + args

# Off-CPU profiling — what's blocking, for how long, where?
offcputime-bpfcc -p 1234 10

# Which kernel function is everyone waiting in?
bpftrace -e 'kprobe:mutex_lock { @[kstack] = count(); } interval:s:10 { exit(); }'

# Slow syscall hunt
bpftrace -e 'tracepoint:syscalls:sys_enter_* { @start[tid] = nsecs; }
                tracepoint:syscalls:sys_exit_* /@start[tid]/ {
                    @lat[probe] = hist(nsecs - @start[tid]); delete(@start[tid]);
                }'
```

### High disk latency in a distributed storage cluster {#disk-latency}

"Latency spikes at peak hours" is a stack problem — the cost could be in the app, VFS, filesystem, block layer, scheduler, driver, or hardware. The discipline is to *measure where* before changing anything. Each layer has its own tool:

Figure 16 · I/O stack · what each tool measures SVG

<img src="/diagrams/kernel-internals-kubelet/16.svg" alt="kernel-internals-kubelet diagram 16" class="doc-diagram" />

`iostat`'s `await` includes everything from block-layer enqueue to device completion; `biolatency` resolves that into a histogram. If `await` is high but `svctm` is low, the queue is the problem, not the device.

```bash
# Snapshot — start here
iostat -xz 1
# r/s w/s rkB/s wkB/s rrqm/s wrqm/s  r_await w_await aqu-sz %util
# high %util + high await = queue depth or device saturation
# low  %util + high await = bursty workload + scheduler delay

# Histogram of block-layer latency, per device
biolatency-bpfcc -D 10

# Per-request trace, who's submitting what
biosnoop-bpfcc            # PID · COMM · size · latency, live stream

# Raw block-layer events with submit/issue/complete timestamps
blktrace -d /dev/nvme0n1 -o trace -w 30
blkparse trace.blktrace.0 | less
btt      -i trace.blktrace                # aggregated Q2C, D2C latencies

# Page cache hit ratio — are we even hitting disk?
cachestat-bpfcc 1

# Filesystem-level — XFS commit latency
bpftrace -e 'kprobe:xfs_log_commit_cil { @[kstack] = count(); }'
```

#### Resolution levers · in order of impact

| Lever | When | How |
| --- | --- | --- |
| I/O scheduler | Wrong scheduler for device class | `echo none > /sys/block/nvme0n1/queue/scheduler` |
| Queue depth | Device idle but await high | `echo 1024 > .../queue/nr_requests` |
| Noisy neighbour | One cgroup dominating IOPS | `io.max` in cgroup v2 · `io.weight` for soft limits |
| Filesystem options | Journal commits stalling reads | `mount -o remount,noatime,commit=60` |
| Dirty ratio | Writeback storms at flush time | Lower `vm.dirty_background_ratio`, raise `dirty_writeback_centisecs` |
| NUMA | Storage attached to one socket | Pin OSDs / consumers to local node with `numactl` |
| Hardware | SMART warnings, NVMe thermal | Replace; check `nvme smart-log`, `temperature` fields |

Note · the typical answer in distributed storage

In Ceph / GlusterFS clusters, "high latency at peak" is most often a noisy-neighbour problem — one tenant or recovery job saturating the device queue. The cgroup v2 `io.max` controller gives per-cgroup IOPS/bandwidth caps that the kernel enforces below the scheduler. Most ops teams underuse it.

### Memory fragmentation · large allocations fail {#mem-frag}

An app calls `mmap(... MAP_HUGETLB)` or the kernel needs a multi-page contiguous buffer (DMA, network jumbo frame, hugepage on demand) and gets `ENOMEM` — even though `free` shows gigabytes available. That's **external fragmentation**: plenty of 4 KiB pages, but no contiguous run of 512 of them to form a 2 MiB block.

The buddy allocator keeps free pages in lists by **order** — order 0 is one 4 KiB page, order 1 is two contiguous pages (8 KiB), order 9 is 2 MiB. `/proc/buddyinfo` shows the count at each order, per zone, per node. A healthy system has counts at every order; a fragmented system has many low-order pages and almost no high-order ones.

Figure 17 · buddy allocator · free counts per order · healthy vs fragmented SVG

<img src="/diagrams/kernel-internals-kubelet/17.svg" alt="kernel-internals-kubelet diagram 17" class="doc-diagram" />

Both states have similar *total* free memory. The difference is order distribution. `cat /proc/buddyinfo` on a healthy host shows non-zero counts across the row; a fragmented host has near-zero values past order 3 or 4.

```bash
# Inspect
cat /proc/buddyinfo
# Node 0, zone   Normal   3142  1820  967  512  281  147  82  41  22  12  5
#                          ^order 0                                   ^order 10

cat /proc/pagetypeinfo            # breakdown by migratetype (Movable/Reclaimable/Unmovable)
cat /proc/zoneinfo                # watermarks (min, low, high) per zone

# Fragmentation score (newer kernels)
cat /sys/kernel/debug/extfrag/extfrag_index
cat /sys/kernel/debug/extfrag/unusable_index

# Compaction statistics
vmstat -s | grep -E 'compact|page'
# compact_stall · compact_fail · compact_success

# Watch in real time during the workload
watch -n 1 'cat /proc/buddyinfo'
```

#### Resolution

```bash
# Force a compaction pass — moves movable pages to make contiguous runs
echo 1 > /proc/sys/vm/compact_memory

# Make the kernel more aggressive about background compaction
sysctl -w vm.compaction_proactiveness=60      # default 20 (range 0–100)

# Reserve more for emergency allocations and trigger reclaim earlier
sysctl -w vm.min_free_kbytes=524288
sysctl -w vm.watermark_scale_factor=200      # default 10; higher = earlier kswapd

# Long-term cure for guaranteed huge pages: reserve at boot
# kernel cmdline:  hugepagesz=2M  hugepages=4096          → 8 GiB locked
# Or runtime, before fragmentation sets in:
echo 4096 > /proc/sys/vm/nr_hugepages

# Drop caches as a diagnostic (NOT a production fix)
echo 3 > /proc/sys/vm/drop_caches
cat /proc/buddyinfo               # did the high orders fill back in?
```

Warning · why compaction sometimes can't help

Compaction moves *movable* pages. Pages pinned by DMA, kernel slab, mlocked userspace, or huge-page guests can't move. A workload that fragments with unmovable pages (lots of kernel memory, many tiny SLUB caches, GPU pinned buffers) cannot be defragmented at runtime — only by rebooting with the right boot-time reservations (`hugepagesz=`, `hugepages=`, `cma=`).

### Packet drops at high throughput {#pkt-drops}

"I'm doing 20 Gbps and seeing drops." Packets can drop at half a dozen places in the stack, each with its own counter. Don't guess — read counters in order, from wire toward application, and stop at the first one moving.

Figure 18 · where packets drop · counter location per layer SVG

<img src="/diagrams/kernel-internals-kubelet/18.svg" alt="kernel-internals-kubelet diagram 18" class="doc-diagram" />

Each layer has a single canonical counter. If it's climbing, that layer is your bottleneck — fix it before looking at higher layers. `nstat -az` dumps everything; `ethtool -S` dumps the hardware-side counters.

```bash
# 1. Hardware-side: is the ring overflowing?
ethtool -S eth0 | grep -iE 'drop|miss|err|discard'
# rx_dropped, rx_missed_errors, rx_fifo_errors

ethtool -g eth0                  # current vs max ring sizes
ethtool -G eth0 rx 4096 tx 4096     # bump rings if at max

# 2. SoftIRQ pressure
cat /proc/net/softnet_stat
# col0=packets col1=dropped col2=time_squeeze col3=cpu_collision col4=received_rps
# A row per CPU; if col2 climbs, raise netdev_budget

sysctl -w net.core.netdev_budget=600          # default 300 packets per softirq pass
sysctl -w net.core.netdev_budget_usecs=8000    # default 2000

# 3. Backlog (only if RPS enabled)
sysctl -w net.core.netdev_max_backlog=32768

# 4. Conntrack overflow (NAT/firewall path)
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max
dmesg | grep -i conntrack       # "nf_conntrack: table full, dropping packet"
sysctl -w net.netfilter.nf_conntrack_max=2000000

# 5. Socket layer
nstat -az | grep -E 'TcpExtPruneCalled|TcpExtRcvPruned|UdpRcvbufErrors'
ss -tnm                          # Recv-Q / rb (recv buffer size) per socket
sysctl -w net.core.rmem_max=134217728
sysctl -w net.ipv4.tcp_rmem="4096 87380 134217728"

# 6. CPU/IRQ topology — spread the load
cat /proc/interrupts | grep eth0
for q in /sys/class/net/eth0/queues/rx-*; do
    echo ffff > $q/rps_cpus           # spread RPS to all CPUs (or specific mask)
done
echo 32768 > /proc/sys/net/core/rps_sock_flow_entries
```

#### Resolution levers

| Layer | Symptom | Fix |
| --- | --- | --- |
| NIC ring | `rx_dropped` climbing | `ethtool -G eth0 rx 4096` · enable RSS · pin IRQs |
| SoftIRQ | `softnet_stat` col 2 climbing | Raise `netdev_budget` · enable RPS to spread CPU |
| Conntrack | "table full" in dmesg | Raise `nf_conntrack_max` · or bypass with `NOTRACK` rules for hot flows |
| Reassembly | `IpReasmFails` rising | Raise `ipfrag_high_thresh` · or fix MTU upstream |
| TCP recv | `TcpExtPruneCalled` rising | App reads too slow · increase `rmem_max` + app `SO_RCVBUF` |
| App | `Recv-Q` persistently large in `ss` | Speed up consumer · more worker threads · profile |
| All | Drops won't budge with tuning | Move to AF\_XDP / DPDK · the kernel is the bottleneck |

## Design scenarios {#design}

Four problem statements where the right answer isn't a one-liner. Each is the kind of open-ended design question that surfaces how someone reasons about trade-offs, failure modes, and the cost of operating something at scale.

### Distributed kernel patches across 10,000 nodes {#patch-rollout}

Push a kernel patch (security CVE, perf fix) to 10,000 production Linux nodes. The bad outcomes are: (a) brick everything at once, (b) silent inconsistency where some nodes get it and you don't know which, (c) inability to roll back when the patch turns out to regress. The good design has the same shape regardless of tooling:

Figure 19 · staged rollout with health gates and automatic rollback SVG

<img src="/diagrams/kernel-internals-kubelet/19.svg" alt="kernel-internals-kubelet diagram 19" class="doc-diagram" />

Exponential waves give you fast roll-out while keeping blast radius bounded. The soak time between waves needs to be long enough to surface the failure mode you fear most — a memory leak takes hours to manifest, an oops takes seconds.

#### Architecture choices that matter

| Choice | Options | Trade-off |
| --- | --- | --- |
| Update mechanism | Package manager · A/B image partitions · livepatch | A/B = atomic rollback but doubles disk; livepatch = no reboot but only function-scope changes |
| Coordination | Central scheduler · gossip · pull-based | Central = simple but SPOF; pull = partition-tolerant but slower convergence |
| Signing | Signed packages · SBOM · TUF | TUF is the gold standard but operationally heavier |
| Health signal | Heartbeat · workload SLO · crash-loop detector | Workload SLO catches real regressions; heartbeat only catches the worst |
| Rollback | Boot previous slot · downgrade package · reflash | Boot previous is fastest if you have A/B; reflashing is hours |
| Partition tolerance | Cache state locally · resume on reconnect | Nodes that lose contact mid-patch must reach a known state |

#### Concrete design

-   **A/B partition layout** (Container Linux / ChromeOS model): two root filesystems, GRUB picks active. New kernel written to inactive slot, boot flag set, reboot. If new kernel fails a health check within N minutes, bootloader auto-falls-back. Rollback is one reboot.
-   **Pull-based agent** on each node polls a central manifest. Reads *"my wave starts at T+2h with kernel version X"*. Survives temporary disconnection — reconnects and resumes.
-   **Health gate** between waves: workload metrics (latency p99, error rate, crash count) compared to a baseline. Fails open: ambiguous data = pause, not promote.
-   **Geographic spread**: each wave touches multiple data centres, not all of one. Catches DC-specific interactions (hardware variant, network).
-   **Drain before reboot**: cordon node from load balancer, drain in-flight requests, reboot, smoke-test, uncordon. Zero-impact in steady state.
-   **Out-of-band recovery**: BMC/IPMI access to every node, so a bricked machine isn't lost — you can netboot a rescue image.

Tip · livepatch is the asymmetric weapon

kpatch / livepatch swaps in fixed kernel functions on a running kernel — no reboot, no downtime. Scope is limited (function bodies only, no struct layout changes), but for the 80% of CVEs that fit, it's the difference between a 10-minute global rollout and a two-week reboot campaign. Reserve full kernel upgrades for changes livepatch can't handle.

### Real-time streaming data processing {#rt-pipeline}

Process market data, sensor telemetry, or video frames with end-to-end latency under, say, 100 μs at p99 — while sustaining tens of Gbps. The system is a stack of choices, each of which can blow the budget if it defaults to the throughput-optimised path.

Figure 20 · real-time pipeline · the hot path bypasses the kernel SVG

<img src="/diagrams/kernel-internals-kubelet/20.svg" alt="kernel-internals-kubelet diagram 20" class="doc-diagram" />

The principle: anything that can preempt, page-fault, allocate, GC, or migrate is a latency bomb. The hot path is a tight loop on a pinned core that never enters the kernel until the workload is done.

#### The stack from top to bottom

| Layer | Choice | Why |
| --- | --- | --- |
| Kernel | PREEMPT\_RT | Sub-ms bounded latency; spinlocks become rt\_mutex with priority inheritance |
| Scheduler class | SCHED\_FIFO or SCHED\_DEADLINE | Bypass CFS · predictable scheduling |
| CPU pinning | `isolcpus=4-7 nohz_full=4-7 rcu_nocbs=4-7` | No tick · no RCU work · no migration on those cores |
| Network | DPDK (or AF\_XDP) | Bypass kernel stack · poll-mode driver in userspace |
| Memory | Hugepages, prefaulted, NUMA-local, mlocked | No page faults · no TLB misses · no swap |
| Storage (if any) | io\_uring, or SPDK for nvme | Batched submission · zero-copy |
| Language | C++, Rust, or JVM with ZGC + pretouch | No unpredictable GC pauses |
| IPC | SPSC lock-free ring · shared memory | Cache-line aligned · no syscall |
| Power | `cpupower frequency-set -g performance` · disable deep C-states | No frequency/voltage transition latency |

```bash
# Boot cmdline for an RT host with cores 4-7 reserved
isolcpus=4-7 nohz_full=4-7 rcu_nocbs=4-7 \
  intel_pstate=disable processor.max_cstate=1 \
  hugepagesz=2M hugepages=4096 default_hugepagesz=2M \
  irqaffinity=0-3 mce=off nosoftlockup

# Pin the workload, set RT scheduling, lock memory
cpupower frequency-set -g performance
chrt -f 80 taskset -c 4 ./hot_path
# inside hot_path: mlockall(MCL_CURRENT | MCL_FUTURE)

# Measure end-to-end latency under load
cyclictest -m -t -p 99 -a 4-7 -i 1000 -l 1000000 --histogram=10000
```

### Scaling a distributed storage cluster · 2× the workload {#ceph-scale}

Take a Ceph (or similar OSD-style) cluster and absorb double the IOPS & throughput without a proportional cost or latency regression. The opening question isn't "what should I tune" — it's "where is the bottleneck *right now*?" Distributed storage has four common ones:

1.  **Per-OSD CPU.** BlueStore + checksums + compression burn cycles. `top -p $(pidof ceph-osd)` at 100% means you scale by adding OSDs / nodes, not by tuning.
2.  **Per-OSD disk.** `iostat` shows `%util` near 100 on the data device but `await` climbing. Move WAL/DB to a faster device (NVMe), then add OSDs.
3.  **Network.** 25/100 Gb NICs maxed during recovery or large writes. Separate public and cluster networks; consider RDMA; check for retransmits with `ss -ti`.
4.  **Placement-group / metadata.** Hot PGs from poor distribution. Run the balancer; check `ceph osd df` for outliers.

#### Linux-side levers that move the needle

| Area | Lever | Why |
| --- | --- | --- |
| I/O scheduler | `none` on NVMe · `mq-deadline` on HDD | BlueStore expects to manage its own queue |
| Filesystem | XFS on data devices · BlueStore directly on raw block | BlueStore is the modern default · skips a filesystem layer |
| WAL/DB placement | On NVMe, separate from data HDDs/SSDs | Synchronous write path lives here · isolate it |
| Network | MTU 9000 (jumbo) · separate cluster network · `tcp_bbr` | Replication and recovery move bulk data · congestion-control matters |
| NUMA | Pin OSD daemons to the node owning the NIC + drives | UPI round-trips destroy small I/O latency |
| Kernel | Newer than 5.15 · BBR · io\_uring-aware tooling | Block-layer perf, TCP scaling, congestion algorithms all improve every release |
| Sysctl | `net.core.rmem_max` · `vm.swappiness=1` · `vm.vfs_cache_pressure=50` | Big socket buffers; almost no swap; keep inode/dentry cache |
| cgroup | OSDs in their own slice with predictable resources | Recovery shouldn't starve client I/O · use `io.weight` |

#### Architectural moves (when tuning hits the wall)

-   **Add OSDs before adding nodes.** Cheaper, faster — if existing nodes have spare CPU and NIC capacity.
-   **Erasure coding for cold data.** 4+2 instead of 3× replication = 1.5× overhead vs 3× — cuts capacity cost and write amplification for archival tiers.
-   **Cache tier or BlueStore compression** for read-heavy hot data — trade CPU for IOPS.
-   **RDMA (RoCEv2)** between OSDs — for east-west replication traffic, removes TCP and most kernel from the path.
-   **Failure-domain awareness:** CRUSH map split by rack/PSU/switch, not just host — doubles capacity also doubles correlated-failure exposure if PG placement is naive.

Note · scaling stories vs scaling reality

"Double the workload" rarely means uniform doubling — usually it's "5× the read IOPS, 2× the write IOPS, but only 1.3× the capacity." Measure each axis (IOPS-r, IOPS-w, MB/s-r, MB/s-w, latency p99 per op size, capacity) and confirm the bottleneck is where you think. Adding spindles to a CPU-bound cluster makes things slower, not faster.

### Dynamic resource allocation in Kubernetes {#k8s-alloc}

Kubernetes presents itself as a scheduler, but every pod resource decision is enforced by Linux primitives we've already covered: cgroups v2 for limits, CFS bandwidth for CPU, memory cgroup for RAM, OOM killer for eviction. The interesting design question is how to pack a node to high utilisation *without* over-provisioning — and PSI is the modern answer.

Figure 21 · pod → cgroup mapping · how K8s enforces requests & limits SVG

<img src="/diagrams/kernel-internals-kubelet/21.svg" alt="kernel-internals-kubelet diagram 21" class="doc-diagram" />

A pod's `resources.requests` drive the scheduler's bin-packing; its `resources.limits` become `cpu.max` / `memory.max` on the pod cgroup. The QoS class (Guaranteed / Burstable / BestEffort) determines the parent slice and the OOM score adjustment.

#### The three QoS classes in cgroup terms

| QoS | Requests vs limits | cgroup effect | Eviction |
| --- | --- | --- | --- |
| Guaranteed | requests == limits, all containers | Hard caps; OOM score very low | Last to be killed |
| Burstable | requests < limits (or partial set) | Soft floor from requests, hard ceiling from limits | Killed by usage-over-request ratio |
| BestEffort | no requests, no limits | No floor, no ceiling | First to be killed |

#### Where over-provisioning comes from — and how PSI fixes it

The classic K8s anti-pattern: every team sets `requests = limits = "what I think peak needs"` with a 2× safety margin. Cluster CPU utilisation sits at 25% and the bill is 4× what it should be. The fix has two halves:

-   **Set requests from actual usage.** The Vertical Pod Autoscaler (VPA) observes a workload over weeks and recommends right-sized requests. Use it in "recommend" mode first, then apply.
-   **Set limits higher than requests (Burstable).** Lets a pod burst into idle capacity. Requests are what gets scheduled-against; limits are the cgroup ceiling. The kernel handles the contention.
-   **Use PSI for the autoscaling decision.** Old HPAs scale on CPU% — which lies under throttling. `cpu.pressure` from `/sys/fs/cgroup/.../cpu.pressure` reports "% of time tasks were runnable but didn't get CPU" — the actual contention signal. Same for memory and I/O.

```bash
# Read PSI for a pod's cgroup
cat /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-pod123.slice/cpu.pressure
# some avg10=12.34 avg60=8.10 avg300=5.20 total=...
# 12% of time in last 10s, tasks wanted CPU but couldn't get it

cat .../memory.pressure
# some avg10=2.10  full avg10=0.40   ← "full" = ALL tasks stalled (worse signal)

# systemd-oomd / oomd uses memory PSI as kill-decision input — modern OOM is psi-driven

# Set up a Burstable pod (in YAML):
#   resources:
#     requests:  cpu: "500m"  memory: "1Gi"     ← scheduling
#     limits:    cpu: "2000m" memory: "4Gi"     ← cgroup ceiling
# Result: kubelet writes cpu.max="200000 100000" and memory.max="4Gi" on the pod cgroup
```

#### Linux primitives K8s relies on

| K8s feature | Linux primitive | Notes |
| --- | --- | --- |
| CPU limits | CFS bandwidth (`cpu.max`) | Throttles per 100 ms period · can cause tail-latency surprises |
| CPU requests | CFS weight (`cpu.weight`) | Soft floor under contention |
| Memory limit | `memory.max` | Hits → OOM-kill in that cgroup |
| Memory request | `memory.low` / `memory.min` | Reclaim protection · used by newer kubelets |
| Eviction | OOM score adjust · kubelet eviction thresholds | Kubelet reads PSI & kernel signals |
| CPU pinning | cpuset · static CPU manager | Guaranteed pods with integer CPU get exclusive cores |
| NUMA awareness | cpuset + memory binding (Topology Manager) | Required for low-latency workloads |
| I/O isolation | `io.weight` / `io.max` | Underused · prevents one pod from drowning the disk |

Tip · CFS throttling is the silent latency killer

A pod with `cpu.max = 200000 100000` (2 cores) that briefly spikes to 4 cores' worth of work gets *throttled* for the rest of the 100 ms period — the whole cgroup stops running. Workloads that don't tolerate that should remove CPU limits and use only requests (rely on weight-based fairness) or use `cpu.uclamp`. Recent kernels (5.14+) added per-cgroup CFS burst credits to soften this.

## Appendix · CPU primer · cores, cache, and Kubernetes {#cpu-primer}

Every abstraction in the doc so far — schedulers, nice values, cgroup weights, Kubernetes pods — eventually cashes out as instructions running on physical silicon. This appendix connects the abstractions to the hardware they drive: what a core actually is, how SMT works, why pinning matters, what "1 CPU" means in five different contexts, and how Kubernetes turns YAML into cgroup files.

### Inside the silicon · sockets, cores, SMT, cache {#cpu-hardware}

The OS sees a flat list of "logical CPUs" via `/proc/cpuinfo`. The hardware reality is a hierarchy:

-   **Socket** — the physical CPU chip plugged into the motherboard. One NUMA node typically.
-   **Physical core** — independent execution unit with its own registers, ALU, FPU, branch predictor.
-   **Logical CPU (LCPU)** — what the kernel scheduler sees. With SMT / Hyper-Threading enabled, *one physical core presents as two LCPUs* that share execution units. Without SMT: 1 core = 1 LCPU.
-   **Cache** — a staircase of progressively bigger, slower SRAM. L1 per LCPU, L2 per physical core, L3 per socket.

Figure 22 · inside one CPU socket · cores · SMT · cache layout SVG

<img src="/diagrams/kernel-internals-kubelet/22.svg" alt="kernel-internals-kubelet diagram 22" class="doc-diagram" />

Inspect topology with `lscpu -e` (per-CPU table), `cat /sys/devices/system/cpu/cpu0/topology/thread_siblings_list` (SMT pairs), `numactl -H` (NUMA layout).

### The memory hierarchy — why pinning matters {#cache-hierarchy}

Each cache level is roughly 4× slower than the one above it. The L1↔DRAM gap is ~80×. That one number justifies CPU pinning for latency-sensitive workloads: keeping a task on the same core preserves its working set in L1 and L2. Migrate the task to a different core and its caches are cold — every load misses, costing an order of magnitude more time.

Figure 23 · memory hierarchy · size grows, latency grows SVG

<img src="/diagrams/kernel-internals-kubelet/23.svg" alt="kernel-internals-kubelet diagram 23" class="doc-diagram" />

Numbers are typical 2026-era server figures — exact values vary by CPU generation. The orders of magnitude are stable: each level is roughly an order of magnitude slower than the one above (L1→L3→DRAM→NVMe).

### PCIe, DMA, and how devices touch memory {#pcie-dma}

The CPU isn't the only thing that reads and writes RAM. Every NIC, NVMe drive, GPU, and accelerator pulls bytes directly out of system memory via **DMA** — reaching past the CPU cores entirely. PCIe is the highway that makes it work. Understanding this path is essential for high-throughput networking, fast storage, and accelerator workloads.

#### PCIe topology — what the "cable" actually is

PCIe is **point-to-point serial**, not a shared bus. Each link is a bundle of *lanes*; each lane is a pair of differential signals (one direction each, full-duplex). Devices attach at the **Root Complex**, which since 2011 lives on the CPU die itself. Modern server CPUs expose 64–128 PCIe lanes per socket.

| Generation | Per-lane | x4 | x8 | x16 |
| --- | --- | --- | --- | --- |
| Gen3 (2010) | 8 GT/s | ~4 GB/s | ~8 GB/s | ~16 GB/s |
| Gen4 (2017) | 16 GT/s | ~8 GB/s | ~16 GB/s | ~32 GB/s |
| Gen5 (2019) | 32 GT/s | ~16 GB/s | ~32 GB/s | ~63 GB/s |
| Gen6 (2022) | 64 GT/s (PAM4) | ~32 GB/s | ~63 GB/s | ~126 GB/s |

Physical form factors — what people sometimes call "PCIe cables":

| Form factor | What it is | Where you find it |
| --- | --- | --- |
| Motherboard slot | x1/x4/x8/x16 edge connector | GPUs, NICs, HBAs |
| M.2 | Tiny on-board connector, x4 | Laptop / server NVMe |
| U.2 / U.3 | Cabled hot-swap bay, x4 | Enterprise NVMe |
| OCuLink | External-style cable, x4 or x8 | NVMe JBOFs, external GPUs |
| Thunderbolt / USB4 | PCIe tunneled over USB-C | eGPUs, external storage |

Figure 24 · server motherboard · memory and PCIe are two highways off the same socket SVG

<img src="/diagrams/kernel-internals-kubelet/24.svg" alt="kernel-internals-kubelet diagram 24" class="doc-diagram" />

Both the memory controller and the PCIe root complex are *inside* the CPU die. There's no "northbridge" chip anymore. PCIe links to devices are physical traces on the motherboard, or cables for hot-swap form factors (U.2/U.3/OCuLink) and external connections (Thunderbolt).

#### The four traffic patterns

Once devices are connected, four kinds of traffic move across the chip. Three are kicked off by the CPU; one (DMA) is kicked off by the device itself.

Figure 25 · four traffic patterns · same chip, four colored paths SVG

<img src="/diagrams/kernel-internals-kubelet/25.svg" alt="kernel-internals-kubelet diagram 25" class="doc-diagram" />

**DMA is the reason a 100 GbE NIC can saturate the wire without melting your cores.** Bytes flow Device → PCIe RC → IOMMU → IMC → DRAM. The CPU only learns about it via the MSI-X interrupt after the bytes are already in memory. This separation is also why DPDK and AF\_XDP exist — they let userspace skip the kernel and read DMA'd data from RAM directly.

#### IOMMU — address translation and isolation

Devices issue DMA using **I/O Virtual Addresses (IOVAs)**, not raw physical addresses. The **IOMMU** (Intel VT-d, AMD-Vi) translates IOVA → physical and enforces per-device page permissions. Two reasons it matters:

-   **Isolation.** A misbehaving device can only write to memory ranges the IOMMU permits. Buggy NIC firmware can't corrupt your kernel's data structures.
-   **VM passthrough.** Assigning a real device to a VM (VFIO) requires an IOMMU — the device gets its own IOVA space matching the guest's view of physical addresses. Without an IOMMU, device passthrough is unsafe at any speed.

```bash
# Boot cmdline
intel_iommu=on iommu=pt          # Intel
amd_iommu=on iommu=pt            # AMD

# Verify enabled
dmesg | grep -iE 'iommu|dmar'

# PCIe tree view
lspci -vt
lspci -vvv -s 01:00.0 | grep -A2 LnkSta

# Actual link speed/width (NOT what the device's spec says — what was negotiated)
cat /sys/bus/pci/devices/0000:01:00.0/current_link_speed    # 16 GT/s
cat /sys/bus/pci/devices/0000:01:00.0/current_link_width    # 16

# IOMMU groups — all devices in a group must passthrough together
ls -la /sys/kernel/iommu_groups/
```

#### Where PCIe becomes the bottleneck

| Layer | Typical bandwidth |
| --- | --- |
| L1 cache | ~1 TB/s per core |
| L3 cache | ~200 GB/s aggregate |
| DRAM (8-channel DDR5) | ~400 GB/s |
| PCIe Gen5 x16 | ~63 GB/s |
| 100 GbE NIC | ~12.5 GB/s |
| NVMe Gen4 x4 | ~7 GB/s |

A 100 GbE NIC needs at least PCIe Gen4 x8 (~16 GB/s) to sustain line rate. Drop it into a Gen3 x4 slot and it silently caps at ~4 GB/s = ~32 Gbps — one third of its rated speed. Always check `current_link_speed × current_link_width` against the datasheet; surprising downgrades happen when slots aren't wired through to the right number of lanes.

### GPU — the parallel-compute partner {#cpu-vs-gpu}

GPUs aren't just for graphics anymore — they're the workhorse of deep learning, scientific computing, video encoding, and crypto. But "GPU workload" always means "GPU *plus* CPU plus their interaction over PCIe." Understanding that triangle is the difference between buying the right hardware and bottlenecking expensive accelerators on cheap host CPUs.

#### The architectural split

CPUs and GPUs solve **different problems with different optimisation targets**. Both have cores, caches, and memory — but the proportions are inverted.

-   **CPU · latency-optimised.** Few powerful cores (8–128). Deep pipelines, sophisticated branch prediction, out-of-order execution. Large caches per core (MB-scale). Goal: finish each single instruction stream as fast as possible.
-   **GPU · throughput-optimised.** Thousands of small cores grouped into Streaming Multiprocessors (SMs). Simple control, no branch prediction worth mentioning. Tiny caches per "core." Goal: keep the memory bandwidth saturated by running thousands of threads in parallel — when one waits for memory, schedule another.

Figure 26 · CPU vs GPU · two design points · the asymmetric pair every ML workload needs SVG

<img src="/diagrams/kernel-internals-kubelet/26.svg" alt="kernel-internals-kubelet diagram 26" class="doc-diagram" />

Each GPU SM contains 128 CUDA cores plus specialised tensor cores (matmul) and RT cores (ray tracing). The architectural inversion vs CPU: CPU has many MB of cache per core but few cores. GPU has KB of cache per "core" but thousands of them — and feeds them with HBM at 3 TB/s.

| Metric | Server CPU (Xeon / EPYC) | GPU (Nvidia H100) |
| --- | --- | --- |
| Compute units | 8–128 cores | 132 SMs × 128 = ~17,000 CUDA cores + tensor cores |
| Clock speed | 3–5 GHz | 1.5–2 GHz |
| Cache per "core" | L1 32 KB + L2 1 MB | L1 / shared 256 KB per SM (across 128 cores) |
| L2 / L3 | L3 32 MB shared | L2 50 MB across SMs |
| Main memory | DRAM 256 GB · ~400 GB/s | **HBM3 80 GB · ~3 TB/s** |
| Branch prediction | Sophisticated | Minimal |
| OOO execution | Yes (extensive) | No (SIMT execution instead) |
| Best for | Branchy serial logic | Massively parallel uniform work |

#### GPU memory hierarchy — parallel to CPU's, but inverted scales

| Level | Size | Bandwidth | Scope |
| --- | --- | --- | --- |
| Registers | ~256 / thread | TB/s | per thread (largest reg file in computing) |
| L1 / shared memory | 64–128 KB | ~10 TB/s | per SM (software-managed scratchpad) |
| L2 cache | 50 MB | ~5 TB/s | across all SMs |
| HBM (device memory) | 80 GB | **3 TB/s** | per GPU |
| Host DRAM (via PCIe) | 256 GB | 32–63 GB/s | via PCIe link |

### CPU + GPU workflow — why both are always needed {#cpu-gpu-workflow}

GPUs cannot run an OS, handle interrupts, talk to the network, or execute syscalls. Everything starts on the CPU. Even a "pure GPU workload" has the CPU doing orchestration. The lifecycle of a typical ML inference request:

1.  Request arrives at NIC → DMA'd to DRAM (host memory)
2.  CPU parses HTTP, extracts the input tensor
3.  CPU calls `cudaMemcpy()` → bytes move DRAM → GPU HBM via PCIe
4.  CPU calls `cuLaunchKernel()` → tells GPU to run a matmul kernel
5.  GPU executes: reads HBM at 3 TB/s, runs tensor-core matmuls, writes back to HBM
6.  `cudaMemcpy()` moves results HBM → DRAM via PCIe
7.  CPU formats response → NIC sends

Figure 27 · GPU workload lifecycle · CPU orchestrates · GPU computes · PCIe in the middle SVG

<img src="/diagrams/kernel-internals-kubelet/27.svg" alt="kernel-internals-kubelet diagram 27" class="doc-diagram" />

Without batching, the GPU spends most of the request lifecycle waiting on PCIe transfers. Batching 32+ requests together amortizes the PCIe cost and keeps the GPU's 3 TB/s HBM bandwidth productive. Async streams and pinned host memory let the next batch's copy overlap with the current batch's compute.

#### GPUDirect — skip the host entirely

For distributed training where input data comes from another node, **GPUDirect RDMA** lets a NIC DMA directly into GPU HBM, bypassing CPU and DRAM. Bytes go wire → GPU HBM without touching host memory. This makes 400 GbE + multi-GPU training viable.

```bash
# Check GPU/NIC topology — look for PIX or PXB between GPU and NIC
nvidia-smi topo -m

# Verify peermem module loaded (kernel-level support)
lsmod | grep nvidia_peermem

# Check actual PCIe link state from inside the GPU
nvidia-smi --query-gpu=pcie.link.gen.current,pcie.link.width.current --format=csv
```

#### When GPUs help — and when they don't

| GPU is the right tool | GPU is the wrong tool |
| --- | --- |
| Massively parallel work (matmul, conv) | Branchy / control-divergent code |
| Same operation on lots of data (SIMT) | Sequential algorithms (compilers, parsers) |
| Workloads that saturate HBM bandwidth | Small data sets (PCIe transfer cost dominates) |
| Batched inference / training | Single-request low-latency work |
| Image / video processing | I/O-bound work (file systems, network) |

Tip · sizing the host for a GPU node

Rule of thumb for AI inference / training boxes: roughly **16 CPU cores per GPU, 256 GB DRAM per GPU, PCIe Gen5 x16 per GPU**. Skimping on host CPU/memory creates the "I bought $40k of GPUs and they sit at 40% utilization" problem — the data pipeline can't keep them fed. Fast NVMe for dataset storage matters too: training reads terabytes, and a stalled GPU is wasted money.

### What "1 CPU" actually means — five contexts {#cpu-meanings}

The same words have wildly different semantics across the stack. Always know which context you're in:

| Context | "1 CPU" means | Range | Type |
| --- | --- | --- | --- |
| Hardware / OS | one logical CPU in `/proc/cpuinfo` | 0 .. N−1 | absolute count |
| nice / CFS | weight 1024 (nice=0 default) | 15 .. 88761 | proportional |
| cgroup v2 `cpu.weight` | weight 100 (default) | 1 .. 10000 | proportional (soft floor) |
| cgroup v2 `cpu.max` | `"100000 100000"` = 100ms quota per 100ms period | μs quota / period | absolute ceiling |
| Kubernetes | `1000m` = 1 LCPU's worth of time per wall second | 0m .. node capacity | requests = floor, limits = ceiling |

The split that matters: **proportional** controls (`nice`, `cpu.weight`, K8s `requests`) only kick in under contention — on idle CPU your weight is irrelevant, you get all of it. **Absolute ceilings** (`cpu.max`, K8s `limits`) cap you regardless of free CPU; idle cycles sit unused if your quota is exhausted.

### Pinning mechanisms — five layers {#cpu-pinning-mechs}

"Pin this task to specific CPUs" can mean different things at different layers:

| Layer | Scope | How to set | Strictness |
| --- | --- | --- | --- |
| `taskset` / `sched_setaffinity()` | one process | `taskset -c 4-7 prog` | Soft — other tasks can still use those CPUs |
| `isolcpus=` boot cmdline | system-wide | GRUB: `isolcpus=6,7` | Hard — CFS scheduler avoids these CPUs |
| `cpuset` cgroup | one cgroup | `echo 4-7 > cpuset.cpus` | Hard within the cgroup |
| systemd `CPUAffinity=` | one service | unit file | Soft (wraps `sched_setaffinity()`) |
| K8s CPU Manager `static` | Pod (Guaranteed + integer CPU) | kubelet config | Hard — exclusive cores carved out |

Figure 28 · how workloads land on 8 LCPUs · three regions SVG

<img src="/diagrams/kernel-internals-kubelet/28.svg" alt="kernel-internals-kubelet diagram 28" class="doc-diagram" />

For ordinary services the default (everyone in the shared pool) is fine. The three-region split pays off only when one pod has a microsecond-level latency SLO that ordinary CFS scheduling can't honour.

### Kubernetes CPU values — millicores, requests, limits {#k8s-cpu-values}

**1 CPU = 1000m (millicores) = one logical-CPU-worth of time per wall second.** So `cpu: 500m` is half a CPU's worth of time (could run on one LCPU 50% of the time, or two LCPUs 25% each). `cpu: 2` is two LCPUs' worth.

A pod spec sets requests (used by the scheduler for bin-packing) and limits (cgroup ceiling enforced by the kernel):

```
resources:
  requests:
    cpu: "500m"      # SOFT FLOOR — scheduler reserves this; becomes cpu.weight
    memory: "1Gi"
  limits:
    cpu: "2000m"     # HARD CEILING — becomes cpu.max
    memory: "4Gi"
```

The kubelet writes this to cgroup files on the node:

```bash
# /sys/fs/cgroup/kubepods.slice/.../mypod.scope/
cpu.weight  = 51              # derived from requests (500m × 100/1000 ≈ 51)
cpu.max     = 200000 100000   # 200ms quota per 100ms period = 2 CPUs hard cap
memory.max  = 4294967296      # 4 GiB
```

#### QoS classes and pinning eligibility

| QoS class | Trigger | CPU Manager static can pin? |
| --- | --- | --- |
| Guaranteed (integer) | requests == limits, all containers, CPU is whole integer | **Yes — exclusive cores** |
| Guaranteed (fractional) | requests == limits, but CPU is fractional (e.g. 500m) | No — shared pool, throttled by cpu.max |
| Burstable | requests < limits, or partial set | No — shared pool, can burst to limit |
| BestEffort | no requests, no limits | No — shared pool, lowest priority |

### Kubelet CPU Manager — the static policy {#cpu-manager}

The kubelet has two CPU manager policies:

-   **`none`** (default) — everyone relies on cgroup CFS shares/quota. No exclusive cores. All pods share all CPUs (minus reserved).
-   **`static`** — Guaranteed pods with integer CPU requests get *exclusive* CPUs. Other pods stay in the shared pool. Reserved CPUs (kubelet, system) are always excluded from the pinned set.

```bash
# /var/lib/kubelet/config.yaml
cpuManagerPolicy: static                    # default is "none"
cpuManagerReconcilePeriod: 10s
reservedSystemCPUs: "0,1"                 # cores reserved for kubelet + system
kubeReserved:
  cpu: "1"
systemReserved:
  cpu: "1"
topologyManagerPolicy: single-numa-node     # NUMA awareness · co-locates CPU + mem + devices
```

Danger · switching policy requires deleting state

The kubelet persists its CPU manager state in `/var/lib/kubelet/cpu_manager_state`. Switching policy (`none` → `static` or vice versa) requires:

```bash
systemctl stop kubelet
rm /var/lib/kubelet/cpu_manager_state    # otherwise new policy is silently ineffective
systemctl start kubelet
```

Forgetting the `rm` is the most common "I set `static` but pinning isn't happening" support ticket.

#### Verifying CPU Manager allocations

```bash
# What pods are pinned to what CPUs?
cat /var/lib/kubelet/cpu_manager_state | jq

# From inside a Guaranteed pod with static pinning
cat /sys/fs/cgroup/cpuset.cpus
# 4-7                                       ← these 4 cores exclusively

taskset -p $(pidof your_workload)
# pid 1234's current affinity mask: f0   (bits for CPUs 4,5,6,7)
```

Tip · when to actually use static pinning

Reach for `cpuManagerPolicy=static` when you have **per-pod latency SLOs in microseconds**, cache-warm matters (NFV, in-memory databases, ML inference), or you need NUMA-locality with the Topology Manager. For typical web services and background work, the default `none` is faster to operate and wastes fewer cores — exclusive pinning means those cores can never be used by anything else, even when the pinned pod is idle.

## Appendix · Kubernetes & cgroup deep-dive {#k8s-deep-dive}

Everything up to this point treated Kubernetes as a black box that ends up writing some cgroup files. This appendix opens the box: the `task_struct` pointers that make a container, the `css_set` dedup trick, the actual three-bucket cgroup tree kubelet maintains, the complete inventory of cgroup v2 files it writes, the kubelet config knobs nobody documents in one place, the TopologyManager's hint-and-merge protocol, and the 13-step pod lifecycle from `kubectl apply` to the container's first instruction.

### The task\_struct — where a process keeps its identity {#task-struct}

When the kernel says "a process," it means an instance of `struct task_struct` — a roughly 10-kilobyte structure holding registers, scheduling state, credentials, open files, and crucially for containers, two pointers: one into the **namespace world** and one into the **cgroup world**. Containers are built almost entirely by manipulating those two pointers. Nothing else in the kernel needs to change.

Figure 29 · task\_struct · two pointers, eight namespaces, one cgroup SVG

<img src="/diagrams/kernel-internals-kubelet/29.svg" alt="kernel-internals-kubelet diagram 29" class="doc-diagram" />

The split exists because *view* and *limit* are independent concerns. A host monitoring agent might need to see every process (host's nsproxy) but be limited to 100 MB (its own cgroup). A container might be in a private worldview but allowed to spike to 8 GB. Threads share both pointers; forked children copy them and bump the refcount on the targets.

Remember · the one-line model

Anywhere in the kernel that something *uses* a resource, the code dereferences `current->nsproxy->...` to know *which instance* to use, and `current->cgroups` to know *which budget* to charge. Every other detail of containers is bookkeeping around those two pointers.

### css\_set · the sharing trick {#css-set-internals}

The `css_set` in the middle exists so that two tasks in the same set of cgroups (across every controller) can share *one* css\_set rather than each carrying its own. On a typical node, thousands of tasks collapse to tens of distinct css\_sets. Each entry in `subsys[]` is a `cgroup_subsys_state` — the per-controller piece of the cgroup. The `memory` controller's css holds counters and high-water marks; the `cpu` controller's css holds bandwidth state and a runqueue.

Figure 30 · many tasks → few css\_sets → many per-controller states SVG

<img src="/diagrams/kernel-internals-kubelet/30.svg" alt="kernel-internals-kubelet diagram 30" class="doc-diagram" />

Three threads of nginx all charge memory to one accounting record. New cgroup combinations create new css\_sets lazily; old ones are GC'd when their last reference drops.

#### How the kernel charges a page fault

When pid 1042 touches a fresh page, the fault handler ends up here, roughly:

```
// simplified from mm/memcontrol.c
int mem_cgroup_charge(struct page *page, struct mm_struct *mm) {
    struct mem_cgroup *memcg = get_mem_cgroup_from_mm(mm);
    //   ↑ walks: mm → owner_task → cgroups → subsys[memory_cgrp_id]

    for (mg = memcg; mg; mg = parent_mem_cgroup(mg)) {
        if (page_counter_try_charge(&mg->memory, nr_pages) == false)
            goto reclaim_or_oom;   // hit memory.max somewhere up the tree
    }
    page->memcg_data = (unsigned long)memcg;  // remember owner
    return 0;
}
```

Two things to notice. First, the charge **walks up the tree** — every ancestor cgroup also has to have room. This is what makes "all containers together get 16 GB" enforceable at the `kubepods.slice` parent level. Second, the page now **remembers its owner**: when it's later evicted or freed, the same memcg gets credited back.

### Kubelet's cgroup tree — three buckets, six knob writes per pod {#kubelet-cgroup-tree-deep}

Kubelet doesn't invent a new isolation mechanism. On startup it carves the node's cgroup tree into three buckets, then drops Pods into the right bucket based on their **QoS class** (computed automatically by comparing each container's requests to its limits, see CPU primer above). What's worth seeing in full is the *structure* kubelet maintains and the exact mapping from Pod spec to cgroup file:

Figure 31 · kubelet's cgroup tree on a node running three pods SVG

<img src="/diagrams/kernel-internals-kubelet/31.svg" alt="kernel-internals-kubelet diagram 31" class="doc-diagram" />

**both must be satisfied** Charges walk up the tree — that's how "all containers together get 16 GB" is enforceable at kubepods.slice

Guaranteed pods are direct children of `kubepods.slice`; Burstable and BestEffort live in their own sub-slices. Each pod-slice contains one cgroup per container (the CRI-level cgroups, where each container's individual `cpu.max` and `memory.max` live).

#### The actual code path

When a Pod arrives, kubelet's `PodManager` hands it to the `ContainerManager`, which calls into `cgroupManager`. That manager's job is to translate the Pod spec into `mkdir`s and file writes:

```go
// pseudo-Go, from kubelet/cm/cgroup_manager_linux.go
func (m *cgroupManagerImpl) Create(cfg *CgroupConfig) error {
    path := m.buildPath(cfg.Name)
    os.Mkdir(path, 0755)

    if cfg.ResourceParameters.CPUShares != nil {
        weight := cpuSharesToCgroupV2Value(*cfg.ResourceParameters.CPUShares)
        writeFile(path+"/cpu.weight", strconv.Itoa(weight))
    }
    if cfg.ResourceParameters.CPUQuota != nil {
        writeFile(path+"/cpu.max",
            fmt.Sprintf("%d %d", *cfg.ResourceParameters.CPUQuota, *cfg.ResourceParameters.CPUPeriod))
    }
    if cfg.ResourceParameters.Memory != nil {
        writeFile(path+"/memory.max", strconv.FormatInt(*cfg.ResourceParameters.Memory, 10))
    }
    return nil
}
```

That's the whole secret: kubelet is a userspace program writing strings into a magic filesystem. The kernel does the enforcement.

### The kubelet config file — full knob inventory {#kubelet-config-full}

Most non-obvious behavior lives in `/var/lib/kubelet/config.yaml`. Many flags can't change at runtime — kubelet reads this on startup. Here's the inventory people search SREs for one at a time, grouped by what they control:

```bash
# === CPU Manager ===
cpuManagerPolicy: static          # "none" (default) or "static"
cpuManagerPolicyOptions:
  full-pcpus-only: "true"         # forbid getting just one hyperthread sibling
  distribute-cpus-across-numa: "true"   # spread when a pod can't fit one NUMA
  align-by-socket: "true"
cpuManagerReconcilePeriod: 10s    # how often it re-applies cpuset writes

# === Memory Manager (beta) ===
memoryManagerPolicy: Static       # or "None" (default)
reservedMemory:
  - numaNode: 0
    limits:
      memory: 1Gi

# === Topology Manager ===
topologyManagerPolicy: single-numa-node   # none | best-effort | restricted | single-numa-node
topologyManagerScope: container           # or "pod" (align all containers together)
topologyManagerPolicyOptions:
  prefer-closest-numa-nodes: "true"

# === System reservations (the slack pool kubelet protects) ===
systemReserved:
  cpu: "500m"
  memory: "1Gi"
  ephemeral-storage: "2Gi"
kubeReserved:
  cpu: "500m"
  memory: "500Mi"
enforceNodeAllocatable: ["pods", "system-reserved", "kube-reserved"]
systemReservedCgroup: /system.slice
kubeReservedCgroup: /kube.slice

# === Eviction ===
evictionHard:
  memory.available: "100Mi"
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"
  imagefs.available: "15%"
  pid.available: "10%"
evictionSoft:
  memory.available: "500Mi"
  nodefs.available: "15%"
evictionSoftGracePeriod:
  memory.available: 1m30s
  nodefs.available: 1m30s
evictionMaxPodGracePeriod: 60
evictionMinimumReclaim:
  memory.available: "200Mi"
  nodefs.available: "1Gi"
evictionPressureTransitionPeriod: 5m

# === The throttling switches ===
cpuCFSQuota: true                 # node-wide; false = ignore cpu.max entirely
cpuCFSQuotaPeriod: 100ms          # 5-10ms often better for latency-sensitive pods

# === Misc that bite ===
podPidsLimit: 4096                # default cap on pids per pod
maxPods: 110
serializeImagePulls: false
imageGCHighThresholdPercent: 85
imageGCLowThresholdPercent: 80

# === Feature gates worth knowing ===
featureGates:
  MemoryQoS: true                  # write memory.high in addition to memory.max
  KubeletInUserNamespace: false
  CPUManagerPolicyOptions: true
  TopologyManagerPolicyOptions: true
```

#### Two non-obvious knobs worth a paragraph each

**`cpuCFSQuota: false`** turns off `cpu.max` enforcement globally on the node. CPU requests still act as weights; CPU limits get silently ignored. Some shops do this for latency-sensitive nodes to eliminate throttling entirely. The cost: a pod with no cooperative limit can monopolize cores. Use only when you trust the workloads.

**`cpuCFSQuotaPeriod: 5ms`** — by default CFS refills the budget every 100ms. If your pod has `limits.cpu: 1` and bursts for 100ms straight, it gets throttled for the next 100ms. Shorten the period to 5ms and the worst-case stall becomes 5ms instead of 100ms. Trade-off: more bookkeeping overhead in the kernel.

### enforceNodeAllocatable — the three-bucket node budget {#enforce-allocatable}

The node's total resources are split into three buckets that nest cleanly:

```
Capacity = SystemReserved + KubeReserved + Allocatable
```

`Allocatable` is what kubelet advertises to the scheduler — "this is how much pods can request." Setting `enforceNodeAllocatable: ["pods"]` (the default) makes kubelet write a `memory.max` and `cpu.max` on `kubepods.slice` itself, capping all pods *together* at Allocatable. Adding `"system-reserved"` and `"kube-reserved"` to that list further caps system and kubelet processes inside their own reservation.

This is what keeps your node SSH-reachable when things go bad

If a runaway pod tries to use everything and `kubepods.slice` has a `memory.max`, the kernel cgroup-OOMs a pod before it can starve sshd or the kubelet itself. Without `enforceNodeAllocatable`, a fork-bomb or memory leak in a pod can take the whole node down.

### Every cgroup v2 file kubelet writes per pod {#cgroup-v2-inventory}

For reference — the complete set kubelet touches when creating a pod cgroup, beyond what we've already covered:

| File | Source | Meaning |
| --- | --- | --- |
| `cpu.weight` | CPU request | Proportional share under contention |
| `cpu.max` | CPU limit | "quota period" in µs — hard ceiling per period |
| `cpuset.cpus` | only static CPU policy | Which LCPUs this cgroup may run on |
| `cpuset.mems` | static memory manager + TopologyManager | Which NUMA nodes for allocations |
| `memory.max` | memory limit | Hard cap — exceeding triggers cgroup-OOM |
| `memory.high` | MemoryQoS feature gate | Soft cap — kernel applies reclaim pressure above this |
| `memory.min` | Burstable + memory request set | Protected from reclaim when parent is squeezed (the "soft floor") |
| `memory.swap.max` | always 0 by default | No swap for containers |
| `memory.oom.group` | set to 1 always | Kill all processes in cgroup atomically on OOM |
| `pids.max` | `podPidsLimit` | Cap on number of processes |
| `io.weight` | not set by default | Block I/O priority (set with IOSchedulingClass via runtime) |
| `hugetlb.<size>.max` | hugepages request | Per-size hugepage budget (2Mi, 1Gi, ...) |

The one that changed recently: **`memory.oom.group = 1`**. Older kernels would kill *one* process in the cgroup on OOM; the cgroup might survive with broken state. With `oom.group` set, the kernel kills *everything* in the cgroup atomically, so the pod restarts cleanly. This eliminates a whole class of "container survived but is in a half-dead state" bugs.

### What cpuset actually is {#cpuset-deep}

`cpuset` is a cgroup controller (one of the originals, going all the way back to 2004) that pins a cgroup to **specific CPU cores** and **specific NUMA memory nodes**. It's different from `cpu.max` and `cpu.weight`, which deal in amounts. **cpuset deals in which physical hardware.**

Two files matter:

```bash
# which cores this cgroup may run on, e.g. "0-3,8"
/sys/fs/cgroup/<path>/cpuset.cpus

# which NUMA memory nodes it may allocate from, e.g. "0"
/sys/fs/cgroup/<path>/cpuset.mems
```

Writing `"0-3"` to `cpuset.cpus` means the scheduler will refuse to place any thread in this cgroup onto cores 4 and above — even if those cores are idle. Writing `"0"` to `cpuset.mems` means every page allocation made by any process in this cgroup must come from NUMA node 0's DRAM. If node 0 fills up, behavior depends on the process's `mempolicy`: by default it falls back to other nodes; with `MPOL_BIND` set, the allocation fails.

#### The exclusive flag — how static CPU Manager reserves cores

There's also `cpuset.cpus.exclusive` (cgroup v2) / `cpuset.cpu_exclusive` (v1), which says *"these cores are only mine — no sibling cgroup may overlap."* This is exactly how the CPU Manager's static policy reserves cores for Guaranteed pods: it writes the exclusive flag so even other Guaranteed pods can't be assigned the same cores.

The CFS scheduler reads `cpuset.cpus` on every scheduling decision; the page allocator reads `cpuset.mems` on every `alloc_pages()` call. Both are essentially free at runtime.

### Per-pod spec — beyond requests and limits {#pod-spec-advanced}

The Pod spec has fields beyond `resources.requests` and `resources.limits` that meaningfully change behavior:

```yaml
apiVersion: v1
kind: Pod
metadata:
  annotations:
    # Some node images respect this even pre-API; helps with cpuset on burstable pods
    cpu-quota.crio.io: "disable"
spec:
  priorityClassName: high-priority         # lower priority → evicted first within QoS tier
  terminationGracePeriodSeconds: 30        # SIGTERM-to-SIGKILL gap during eviction
  overhead:                                # for runtime overhead (e.g. Kata)
    cpu: "250m"
    memory: "120Mi"
  containers:
  - name: app
    resources:
      requests:
        cpu: "2"                           # MUST be integer for static cpuset assignment
        memory: "4Gi"
        hugepages-2Mi: "1Gi"               # hugepages have their own request type
        ephemeral-storage: "1Gi"
      limits:
        cpu: "2"                           # == requests → Guaranteed QoS
        memory: "4Gi"
        hugepages-2Mi: "1Gi"
        ephemeral-storage: "2Gi"
    securityContext:
      capabilities:
        drop: ["ALL"]
```

Danger · "2" and "2000m" are not equivalent

`requests.cpu: 2000m` and `requests.cpu: 2` look identical and act identically *except* for one thing: **only the integer form triggers the static CPU Manager to assign exclusive cores via `cpuset.cpus`.** The fractional form stays in the shared pool, no matter how Guaranteed-looking the QoS class is. This is one of the most surprising gotchas in Kubernetes.

The other non-obvious fields:

-   **Burstable QoS does not get cpuset.** Even if you set `requests.cpu: 4` and `limits.cpu: 8`, the static policy ignores you. Only `requests == limits` *and* integer CPU qualifies.
-   **`overhead`** — used for runtime overhead (Kata Containers, gVisor). Added to the pod's effective request for scheduling but not given to the user's containers. Useful when running VMs as pods.
-   **`priorityClassName`** — lower priority values are evicted first *within the same QoS tier*. System-critical pods (priority ≥ 2 billion) are evicted last. This doesn't affect CFS scheduling order, only eviction order.

### Memory QoS — `memory.high` as a soft cap {#memory-qos-deep}

With the `MemoryQoS` feature gate enabled (beta in 1.27+), kubelet additionally writes `memory.high` based on the memory request. `memory.high` is a *soft* limit: the kernel reclaims pages from the cgroup when it crosses this threshold, but doesn't kill anything. The result: a Burstable pod feels back-pressure as it grows past its request, encouraging it to give back memory before hitting the hard cap. Less binary, fewer surprise OOMs.

It's off by default because the throttling behavior under `memory.high` can be surprising for some workloads — allocations slow down (reclaim is synchronous) rather than fail. Workloads that aren't prepared for that latency hit can appear hung.

### Eviction — thresholds, signals, victim selection {#eviction-deep}

Cgroup limits protect *other pods* from one badly-behaved pod. But what protects the *node itself*? That's eviction — kubelet-driven, proactive, to reclaim resources **before** the kernel OOM-killer fires.

#### Two flavors

| Flavor | Trigger | Action |
| --- | --- | --- |
| Hard eviction | Threshold crossed | Kill **immediately**, no grace. Defaults: `memory.available < 100Mi`, `nodefs.available < 10%` |
| Soft eviction | Threshold crossed for longer than `evictionSoftGracePeriod` | Kill with the Pod's `terminationGracePeriodSeconds` |

#### The signals kubelet polls every 10 seconds

| Signal | Meaning | Default hard threshold |
| --- | --- | --- |
| `memory.available` | Node-level free + reclaimable memory | < 100Mi |
| `nodefs.available` | Free space on kubelet's root fs (logs, emptyDir) | < 10% |
| `nodefs.inodesFree` | Free inodes on root filesystem | < 5% |
| `imagefs.available` | Free space on the image filesystem | < 15% |
| `pid.available` | Available PIDs on the node | < 10% |

Figure 32 · eviction decision loop · signals to victim to recovery SVG

<img src="/diagrams/kernel-internals-kubelet/32.svg" alt="kernel-internals-kubelet diagram 32" class="doc-diagram" />

"Recovered" means the signal improved by at least `evictionMinimumReclaim`, not merely re-crossed the threshold — this prevents flapping where eviction frees just barely enough memory to come back into range, get re-classified as "good," and then immediately cross again.

#### Cgroup-OOM vs node OOM — two distinct mechanisms

People conflate these constantly:

-   **Container OOM (cgroup-OOM):** a container hits its `memory.max`. Kernel kills processes inside *that cgroup only* (atomically with `oom.group=1`). Pod survives if restart policy allows. Other pods don't notice.
-   **Node OOM:** the whole node is low. Kubelet ideally catches it via eviction thresholds and gracefully evicts; if too slow, the kernel global OOM-killer fires and picks a victim from *anywhere*, including system daemons. Node typically goes `NotReady` after.

### OOM and throttling — the five-event decision matrix {#oom-throttle-events}

This is the part people get wrong most often. There are at least five distinct events:

| Event | Trigger | Killer | Who dies |
| --- | --- | --- | --- |
| **CPU throttling** | Container exceeds `cpu.max` quota in a period | None — just delayed | Nobody, but app gets slow |
| **Cgroup OOM** | Container exceeds `memory.max`, reclaim fails | Kernel | All processes in cgroup (with `oom.group`) |
| **Pod cgroup OOM** | Pod-level cap hit (sum of containers + overhead) | Kernel | Same, scoped to pod slice |
| **Kubelet eviction** | Node-level signal crosses `evictionHard` | Kubelet | Whole pods, by QoS tier |
| **Kernel node OOM** | Node out of memory, kubelet didn't react fast enough | Kernel | Any process on node — system daemons, kubelet, anything |

#### Where to look for each

**Throttling is silent** — no event, no log entry by default. You only see it in metrics: `container_cpu_cfs_throttled_periods_total` and `container_cpu_cfs_throttled_seconds_total`. If those climb while CPU usage is below the limit, you're hitting the period-boundary problem and should either remove the limit, raise it, or shorten `cpuCFSQuotaPeriod`.

**Cgroup OOM** emits a kernel log line and bumps `container_oom_events_total`. The pod survives if its restart policy allows, but its container restarts from scratch.

**Kubelet eviction** emits a Kubernetes Event (`kubectl describe pod` shows it) and sets pod status to `Failed` with reason `Evicted`. The pod is gone until the workload controller (Deployment, StatefulSet) re-creates it elsewhere.

**Kernel node OOM** is the worst case and means kubelet's thresholds are tuned too tight or the workload spiked too fast. You'll see kernel messages in `dmesg` picking arbitrary victims, possibly including kubelet itself, after which the node goes `NotReady`.

### TopologyManager — the hint-and-merge protocol {#topology-hints}

The Topology Manager is the piece that coordinates CPU pinning, NUMA-local memory, and device placement (GPU, NIC) so they all land on the same NUMA node. It does this with a *hint-and-merge* protocol: each component reports which NUMA nodes would be acceptable, then the manager takes the intersection.

Figure 33 · TopologyManager admission · hints flow through merge SVG

<img src="/diagrams/kernel-internals-kubelet/33.svg" alt="kernel-internals-kubelet diagram 33" class="doc-diagram" />

Policies: `none` = independent, may straddle NUMA; `best-effort` = try to align, admit anyway; `restricted` = try to align, reject if impossible; `single-numa-node` = strict, all from one NUMA or reject pod admission.

#### When NUMA alignment breaks in practice

1.  **Request too large for one node.** 32 cores requested, each NUMA has 16. With `single-numa-node`, pod is rejected.
2.  **GPU on wrong NUMA.** Free cores on node 0, free GPU on node 1. Common in mixed inventory; fixed by careful scheduling.
3.  **Memory pressure across nodes.** With `MPOL_PREFERRED`, the kernel silently falls back when local is full. `MPOL_BIND` would fail (or OOM-kill).
4.  **Non-Guaranteed pods.** Only Guaranteed-with-integer-CPU gets the static cpuset; others run in the shared pool.
5.  **Hyperthreads.** Without `full-pcpus-only`, sibling thread might run a different pod, polluting L1/L2.

There's no "this cgroup can use 4 cores but reject if it'd cross NUMA"

Instead you *restrict the inputs* with `cpuset.cpus` + `cpuset.mems` and the workload physically cannot cross the boundary. The kernel does no NUMA-aware admission control on its own.

### End-to-end — a Pod from `kubectl apply` to running {#pod-lifecycle}

Tying the kernel and Kubernetes layers together: thirteen steps from the moment `kubectl apply` hits the API server to the moment the container's first instruction executes.

Figure 34 · pod lifecycle · 13 steps across four actors SVG

<img src="/diagrams/kernel-internals-kubelet/34.svg" alt="kernel-internals-kubelet diagram 34" class="doc-diagram" />

Steps ⑥ and ⑦ are where every cgroup file write happens. Step ⑩ is the magic moment: the task is added to `cgroup.procs` and from that instant, all the limits apply.

### The mental model for tuning — three principles {#tuning-principles}

Three principles cover 90% of real-world choices. Everything else is a special case.

Principle 1 · Set memory requests = limits for anything stateful

Memory is hard to reclaim — surprises here cost OOM kills. Making it Guaranteed (by setting `requests.memory == limits.memory`) removes the surprise. The pod is last to be evicted under pressure, and you know the exact ceiling. For databases, caches, message brokers, and anything else that holds state, this is non-negotiable.

Principle 2 · For CPU, set requests honestly and consider not setting limits

CPU is reclaimable instantly — the CFS weight system already prevents one pod from starving others. CPU limits mainly cause throttling tax: throttled cores while the rest of the node is idle. The exceptions: shared / multi-tenant clusters where you don't trust workloads, or capacity-planning constraints that require a ceiling. Otherwise, requests alone do most of the job.

Principle 3 · For latency-sensitive workloads, go Guaranteed with integer CPU + static + TopologyManager

This combination gives you exclusive cores (via `cpuset.cpus.exclusive`), NUMA-local memory, and no cross-pod cache pollution. It's wasteful on small workloads — a pod requesting 1 core *actually owns* 1 core whether it's using it or not — but for databases, packet processors, and real-time pipelines it's the difference between predictable and not.

Beyond these three, the eviction thresholds, `reservedMemory` for the system slice, and `cpuCFSQuotaPeriod` are the levers you reach for when something specific is going wrong. Most clusters never need to touch them.

The one-line takeaway for the whole appendix

**Namespaces hide; cgroups limit; kubelet composes; topology aligns; eviction protects.** Everything else is implementation detail.

On this page

-   [Kernel preemption](#preemption)
-   [The mechanism](#mechanism)
-   [Scheduling classes](#sched-classes)
-   [The preemption gate](#preemption-gate)
-   [The four models](#models)
-   [PREEMPT\_RT](#preempt-rt)
-   [RT workloads](#rt-workload)
-   [Namespaces](#namespaces)
-   [Eight types](#ns-types)
-   [Syscalls](#ns-syscalls)
-   [PID nesting](#pid-ns)
-   [Control groups](#cgroups)
-   [v1 vs v2](#v1-v2)
-   [Worked example](#worked-example)
-   [Containers](#containers)
-   [Birth sequence](#birth)
-   [Preemption loop](#closing-loop)
-   [Networking](#networking)
-   [TCP congestion control](#cc)
-   [Low-latency tuning](#low-latency-net)
-   [Memory management](#memory)
-   [NUMA](#numa)
-   [Huge pages](#thp)
-   [Storage](#storage)
-   [XFS vs ext4](#fs)
-   [I/O schedulers](#io-sched)
-   [Service tuning](#systemd-cookbook)
-   [The directives](#systemd-knobs)
-   [Composition](#systemd-compose)
-   [Production profiles](#systemd-profiles)
-   [Verification](#systemd-verify)
-   [Troubleshooting](#troubleshooting)
-   [System freeze](#freeze)
-   [Disk latency](#disk-latency)
-   [Memory fragmentation](#mem-frag)
-   [Packet drops](#pkt-drops)
-   [Design scenarios](#design)
-   [Patch rollout · 10k nodes](#patch-rollout)
-   [Real-time pipeline](#rt-pipeline)
-   [Scaling storage](#ceph-scale)
-   [K8s resource allocation](#k8s-alloc)
-   [CPU primer](#cpu-primer)
-   [Inside the silicon](#cpu-hardware)
-   [Memory hierarchy](#cache-hierarchy)
-   [PCIe & DMA](#pcie-dma)
-   [GPU architecture](#cpu-vs-gpu)
-   [CPU + GPU workflow](#cpu-gpu-workflow)
-   ["1 CPU" meanings](#cpu-meanings)
-   [Pinning mechanisms](#cpu-pinning-mechs)
-   [K8s CPU values](#k8s-cpu-values)
-   [CPU Manager](#cpu-manager)
-   [K8s deep-dive](#k8s-deep-dive)
-   [task\_struct pointers](#task-struct)
-   [css\_set sharing](#css-set-internals)
-   [Kubelet's cgroup tree](#kubelet-cgroup-tree-deep)
-   [Kubelet config knobs](#kubelet-config-full)
-   [enforceNodeAllocatable](#enforce-allocatable)
-   [cgroup v2 file inventory](#cgroup-v2-inventory)
-   [cpuset deep-dive](#cpuset-deep)
-   [Pod spec advanced](#pod-spec-advanced)
-   [Memory QoS feature](#memory-qos-deep)
-   [Eviction deep-dive](#eviction-deep)
-   [OOM & throttling matrix](#oom-throttle-events)
-   [TopologyManager hints](#topology-hints)
-   [Pod lifecycle](#pod-lifecycle)
-   [Tuning principles](#tuning-principles)
