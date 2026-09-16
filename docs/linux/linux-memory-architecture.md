---
title: "Java Memory Architecture"
slug: /linux/linux-memory-architecture
sidebar_position: 3
sidebar_label: "Java Memory Architecture"
description: "Java Memory Architecture"
---
[Chapter 2: Fundamentals](/docs/ddia/ddia-ch2)

Mapping JVM Internals to Linux Process Memory

This guide maps **every Java component** to its exact location in the Linux process memory layout: the TEXT segment where `libjvm.so` and JIT-compiled code live, the DATA and BSS regions for class-level state, the HEAP split between the managed Java heap and native arenas (Metaspace, direct buffers, CodeCache), per-thread STACK frames for method execution, and how the kernel accounts for sockets, page cache, and scheduling around your process.

## 1\. Java Process Memory Layout

Every Java application is a normal Linux process. The virtual address space still follows the classic ELF layout: executable and shared-library **TEXT** (read-only code), **DATA** (initialized static storage), **BSS** (zeroed uninitialized statics), a **heap** that grows toward higher addresses, memory-mapped files and anonymous mappings, and a **stack** anchored near the top of user space that grows down. The JVM layers `libjvm.so`, interpreters, JIT output, class metadata, and GC-managed object storage onto these primitives.

### The TEXT Segment

The TEXT segment holds machine instructions: the JVM executable, `libjvm.so`, other JNI libraries, and the **JIT CodeCache** where hotspots are emitted as native code. The interpreter dispatch loop and stubs also reside here. This region is typically mapped read-execute (`r-x`); writable JIT buffers are separate anonymous mappings coordinated by the runtime.

### The DATA and BSS Segments

**DATA** contains initialized globals from the JVM and native libraries: static finals backed by loads from the constant pool (often pointing into Metaspace), internal tables, JNI handles, and static C/C++ symbols linked into the JVM. **BSS** holds uninitialized static variables—zeroed by the loader—including null reference fields fixed up before bytecode runs. Understanding DATA/BSS separates “process-wide native statics” from per-instance heap objects.

### The Heap (Managed + Native)

The **Java heap** is where object instances (`new`) and arrays live across **Eden**, **Survivor** spaces (often S0/S1), and the **Old** (tenured) generation. A concurrent collector may add regions or humongous-object areas, but the generational mental model stays the same. Alongside—still “heap” colloquially in process terms—sit **Metaspace** for class metadata, **direct `ByteBuffer`** and `mmap` arenas, malloc zones for JNI/native code, and the CodeCache for JIT output. Monitoring must separate RSS attributed to GC heap versus native arenas.

### The Stack

Each OS thread mapped by the JVM consumes a contiguous stack chunk sized by `-Xss` (commonly on the order of 1 MiB). Frames store primitives, operands, partial evaluation state, and **references** to heap objects—not the objects themselves (except inlined scalarization optimizations). Thousands of threads linearly multiply reserved virtual stack space; always correlate thread count with `ulimit`, container memory limits, and NMT reports.

### Memory-Mapped Regions

JAR/class data (often mapped read-only), `mmap`’d files, CDS archives, compressed class space, anonymous huge pages, and `/dev/zero`\-backed regions appear between classical heap bookkeeping and stacks. GC may use `mmap` for heap reservation even before pages are touched.

### The Kernel’s View

Although not part of user virtual memory the same way, kernel structures back your process: page tables, file descriptor tables, epoll interest lists, socket send/receive buffers, and page cache pages tied to your I/O. Syscalls move data between user buffers (heap or direct) and these kernel-side resources—important when diagnosing “memory” that is not in the Java heap but still charged to the host.

Figure 1 — Java process memory layout inside Linux (virtual addresses increase upward)

<img src="/diagrams/linux-memory-architecture/1.svg" alt="linux-memory-architecture diagram 1" class="doc-diagram" />

Classic segments still apply; the JVM allocates many subregions inside heap and mmap space. Actual maps are visible in /proc/\[pid\]/maps.

RSS ≈ Σ(touched Java heap regions) + Metaspace + CodeCache + thread stacks (committed) + direct/native buffers + glibc arenas + page cache pinning effects

**Tip:** correlate `jcmd <pid> VM.native_memory summary` with `pmap -x` or container cgroup `memory.stat` to see heap vs native vs stack. Eden promotions and direct buffer spikes show up as different ledger lines—not a single “heap used” slider.

## 2\. Stack vs Heap

The **Java stack** is an array of *activation records*: each method call pushes a frame with local variable slots (including parameter slots), operand stack depth accounted for by the verifier, and a reference to runtime metadata for exception tables. Frames are ephemeral—when `serialize()` returns, its frame is popped and its primitive slots cease to exist. The **heap** holds object graphs that outlive any single invocation unless they become unreachable and are reclaimed.

#### Stack frames hold references, not instances

For `Object o = new Thing()`, the instance lives in the heap; `o` is a compressed or raw reference slot on the operand stack/locals. Bytecode uses `aload`/`astore`; the interpreter or JIT lays out spills and registers obeying `-Xss`. Deep recursion blows stack depth regardless of heap size.

#### Primitives vs references on stack

Primitives (`int`, `boolean`, `long`) sit directly in frame slots sized by JVM rules (e.g., `long` occupies two operand stack entries). Only references point outward; `struct`\-like bundling is done with objects on the heap (value types in newer JVMs change some cases but preserve the rule: identity vs inline layout is explicit).

#### Heap generations and lifetimes

Short-lived allocations fill Eden and copy survivors; long-lived trees, caches, and session objects climb to Old. When diagnosing retention, look for dominator paths from GC roots (static fields, JNI globals, thread stacks, monitors) into the old gen—not just “big old gen,” but *who holds the edges*.

| Aspect | Stack | Heap |
| --- | --- | --- |
| Scope | Per-thread, per-method activation | Process-wide object graph |
| Lifetime | Ends when the method returns (frame popped) | Ends when unreachable (GC, no ordering guarantee) |
| Contents | Primitives, return addresses, reference slots, operand stack cells | Objects, arrays, headers, alignment padding |
| Sizing | `-Xss` per thread; linear in thread count | `-Xmx`, region sizing, Metaspace caps |
| Failure mode | `StackOverflowError` | `OutOfMemoryError: Java heap space` / GC thrash |

Figure 2 — Stack vs heap: what goes where

<img src="/diagrams/linux-memory-architecture/2.svg" alt="linux-memory-architecture diagram 2" class="doc-diagram" />

The operand stack and locals are machine-like; the object graph is managed and may move (compacting GC) while references are updated.

**Remember:** storing large arrays or collections in local variables still keeps the *reference* on the stack—the bulk storage is always in the heap (unless explicitly off-heap or inlined by escape analysis).

## 3\. Text, Data, BSS, Heap, Stack — Java Edition

The C mental model maps cleanly once you know what the JVM substitutes: `malloc`/`free` becomes allocation + GC (for Java objects) or native allocators (for Metaspace growth, direct memory, JNI). Global state splits between true native statics (DATA/BSS in `libjvm.so`) and Java `static` fields whose object payloads live in the heap while their reference cells are described by class metadata.

### C → Java mapping

| C / Linux segment | Typical C content | Java / JVM counterpart |
| --- | --- | --- |
| TEXT | Your program’s `main`, libc, shared libs | `java` binary, `libjvm.so`, JIT CodeCache, interpreter templates |
| DATA | Initialized global variables | HotSpot globals, some static JNI tables; class file constant pool → resolved entries in Metaspace |
| BSS | Uninitialized globals (zero) | Native BSS for VM; Java `static Object x;` starts null—payload not in BSS |
| Heap | `malloc` / `free` arena | Java heap (generational), Metaspace, malloc for native + direct buffers, CodeCache |
| Stack | Automatic locals, return addresses | Per-thread Java stack frames sized by `-Xss`, native frames for JNI calls |

### JIT and TEXT

Baseline bytecode starts in the interpreter (TEXT). As methods heat up, the JIT emits optimized machine code into the **CodeCache**—still mapped under the hood like additional TEXT-like regions with special permissions. Deoptimization bridges back to interpreter state. So “where is my code?” spans multiple mappings: shared library TEXT, per-process JIT buffers, and VM stubs.

### Indirection the JVM adds

C stacks often reference heap directly through raw pointers. Java adds **verified memory safety** (no arbitrary pointer arithmetic on references), **compressed oops**, **barriers** for concurrent GC, and **class pointers** in object headers pointing to Metaspace metadata. A field load may compile to a few instructions, but semantically it passes through these layers—visible in crash logs as checks and generated runtime routines.

Figure 3 — C memory model vs JVM memory model (side by side)

<img src="/diagrams/linux-memory-architecture/3.svg" alt="linux-memory-architecture diagram 3" class="doc-diagram" />

Correspondence is conceptual: exact addresses differ by JVM build, GC, and container; use maps and NMT for ground truth.

**Watch out:** treating “heap” as synonymous with “Java heap” ignores Metaspace leaks, direct buffer accounting, and CodeCache pressure—each can OOM the process without filling Old Gen.

## 4\. `fork()` in Java — the dangerous copy

On Linux, `fork()` creates a child process that is a near-duplicate of the parent. Modern kernels use **copy-on-write (COW)**: physical pages are shared until either process writes, at which point each side gets its own page. That sounds cheap, but it is not cheap for a JVM.

When a Java thread invokes `Runtime.exec()` (or similar), the runtime typically uses `fork()` followed by `exec()` in the child. The child must see a consistent snapshot of memory the parent had at `fork()` time. The parent’s entire address space—including a multi-gigabyte heap, metaspace, code cache, native libraries, and mmap’d regions—is logically duplicated. COW defers physical copying, but the kernel still accounts for and tracks these mappings. Under memory pressure, touching pages in parent or child forces real copies and spikes RSS.

**Only one thread survives in the child.** The kernel copies the calling thread’s registers and stack into the child; every other thread disappears from the child’s view. Threads that held POSIX mutexes or JVM monitors in the parent do not exist in the child—those locks are effectively abandoned from the child’s perspective while still “held” in maps inherited from COW, which is a classic source of **deadlock or undefined behavior** if any forked child runs non-`exec()` code paths that touch them.

**OOM risk:** Briefly after `fork()`, both parent and child appear to “own” the full virtual footprint. The kernel’s memory controller (cgroup v2 `memory.max`) counts charged pages toward the limit. A large heap plus COW bookkeeping can push `memory.current` near or over the limit even before the child `exec()`’s a tiny binary—triggering reclaim or **OOM kill** of the container or one of the processes.

Best practice: avoid `fork()`\-without-immediate-`exec()` from a multi-threaded JVM; prefer `ProcessBuilder` patterns that minimize extra native work, and size containers with `fork`/exec overhead in mind. JNI code that calls `fork()` directly is especially hazardous.

Figure 4. `fork()` in Java — the dangerous copy

<img src="/diagrams/linux-memory-architecture/4.svg" alt="fork in Java dangerous copy" class="doc-diagram" />

After `fork()`, the child is a new process with one thread; after `exec()`, all prior mappings are replaced by the new program.

**OOM kill risk.** Under cgroup `memory.max`, the combined charge from COW sharing, page tables, and duplication pressure can exhaust the limit during `fork()`/`exec()` bursts—especially alongside large heaps and many mapped files. Monitor `memory.current`, `memory.events` (oom\_kill), and spikes during child process creation.

```
# cgroup v2 — watch memory pressure during ProcessBuilder / fork storms
cat /sys/fs/cgroup/memory.current
cat /sys/fs/cgroup/memory.max
cat /sys/fs/cgroup/memory.events
# look for oom_kill increments
```

## 5\. Java thread = Linux pthread = kernel task

HotSpot on Linux uses a **1:1 thread model**: each `java.lang.Thread` maps to one native `pthread`, and each pthread corresponds to one kernel schedulable entity (a `task_struct` with its own TID inside the process’s thread group). They are not green threads: the kernel sees and schedules them independently.

`Thread.start()` eventually calls into the VM, which creates a pthread via `pthread_create()`. At the kernel level, new threads are created with `clone()` sharing the parent’s address space and file descriptor table (flags such as `CLONE_VM | CLONE_FILES | CLONE_FS | CLONE_SIGHAND | CLONE_THREAD`), which is why they all belong to the same process ID (thread group leader) but expose distinct TIDs.

| Aspect | Shared by all threads | Owned per thread |
| --- | --- | --- |
| Address space / Java heap | Single `mm_struct`; one generational heap | Thread-local allocation buffers (TLAB) carveouts only |
| Open files / sockets | `files_struct` | Per-thread interrupt mask, some JNI handles |
| CPU scheduling | cgroup/cpu limits for the whole cgroup | Niceness, per-thread scheduling policy hints, own run queue state |
| Stacks | — | Separate native stacks; HotSpot stack + interpreter frames |
| Registers / PC | — | Each TID has its own saved context on preemption |

Figure 5. Thread mapping: Java → pthread → kernel

<img src="/diagrams/linux-memory-architecture/5.svg" alt="thread mapping Java pthread kernel" class="doc-diagram" />

PID identifies the thread group; each runnable Java thread has a unique TID visible in `ps -eLf` and `/proc/[pid]/task/`.

## 6\. CPU cores, NUMA, and cgroups

### 6.1 NUMA (non-uniform memory access)

On multi-socket servers, RAM is physically attached per socket (“NUMA node”). A thread accessing memory allocated on its *home* node incurs lower latency; accessing remote memory traverses CPU interconnect (QPI/UPI) and adds latency—often materially higher for churny heap workloads. The JVM can use NUMA-aware allocation (`-XX:+UseNUMA` for G1 in some configurations) to keep young objects local, but if threads migrate across sockets or if humongous regions span nodes, you still pay remote bandwidth.

### 6.2 cgroups: CPU and memory walls

Linux cgroups v2 wrap each container (and each pod on Kubernetes) in a hierarchy. `cpuset.cpus` pins eligible CPUs; `cpu.max` applies CFS bandwidth throttling (`BURST QUOTA PERIOD` style string `200000 100000` ≡ 2 CPUs quota per 100ms slice); `memory.max` caps byte accounting including anonymous and mapped file caches inside the cgroup. The JVM sees “available processors” capped by cgroup CPU controllers; mismatches versus host core count explain surprising GC thread counts unless overridden with `-XX:ActiveProcessorCount`.

| cgroup knob | Effect on JVM process |
| --- | --- |
| `cpuset.cpus` | Hard pin to specific hardware threads; affects scheduler placement vs other pods |
| `cpu.max` | Throttles aggregate CPU time for all threads in the cgroup (STW GC pauses count) |
| `memory.max` | Hard cap on memory accounting; reclaim + OOM kill when exceeded persistently |
| `memory.high` | Soft throttle: kernel reclaims harder before hitting `memory.max` |

```
# Inspect effective limits inside a Kubernetes pod cgroup
cat /sys/fs/cgroup/cpuset.cpus.effective 2>/dev/null || cat /sys/fs/cgroup/cpuset.cpus
cat /sys/fs/cgroup/cpu.max
cat /sys/fs/cgroup/memory.max
```

Figure 6. NUMA topology + cgroup CPU boundaries

<img src="/diagrams/linux-memory-architecture/6.svg" alt="NUMA and cgroup boundaries" class="doc-diagram" />

Pinning with `cpuset` trades scheduling flexibility for predictable cache/NUMA locality; combined with `memory.max`, it defines the pod’s hard resource box.

## 7\. cgroups + page cache — the hidden memory trap

Operators often assume `memory.max` only tracks the Java heap. In cgroup v2, **file-backed cache pages** (page cache for jar files, memory-mapped I/O, and read-mostly datasets) commonly count toward the same memory limit unless explicitly tuned with memory controller attributes. Anonymous heap, thread stacks, metaspace, JNI mappings, kernel slab attributable to the cgroup, and retained page cache therefore compete for one budget.

**Practical cgroup memory inequality**  
`memory.current` ≈ anon RSS + file LRU pages + kmem/l slab + mapped file pages − (recent reclaim)  
Exact accounting uses kernel internals; use `memory.stat` fields (`anon`, `file`, `kernel_stack`, `slab`, `sock`) for breakdowns—not only JVM heap gauges.

When `memory.current` approaches `memory.max`, the kernel first tries to shrink reclaimable file cache; that shows up as slower class loading, jar reads, and I/O without an obvious Java OOM. If anonymous memory is still too high, the OOM killer selects a process in the cgroup—often pid 1 or the JVM—leading to pod restart loops that *look* like heap issues but were actually aggregate RSS + cache pressure.

| Container sizing blind spot | Why it bites | Mitigation |
| --- | --- | --- |
| Heap = 70% of `limits.memory` | Leaves almost no room for Metaspace, thread stacks, direct buffers, and page cache | Budget 20–35% headroom or set `-Xmx` conservatively vs limit |
| Large fat JAR layers on slow storage | Cold starts populate page cache inside cgroup; competes with heap growth | Layer optimization, CDS archives, adequate `memory.max` |
| Many memory-mapped files / sendfile | File mappings accrue cached pages attributed to cgroup | Watch `memory.stat file`, reduce mmap churn |
| Bursty Netty/directByteBuffer | Off-heap anon memory invisible to heap MXBean | Track native metrics; cap pools; align limit with reality |

Figure 7. What counts against `memory.max`

<img src="/diagrams/linux-memory-architecture/7.svg" alt="memory max breakdown stacked bar" class="doc-diagram" />

Correlate `kubectl describe pod` OOMKilled events with `/sys/fs/cgroup/memory.stat`—not only `Usage` from container runtime summaries.

**Hidden page cache traps.** A JVM reporting “healthy” heap can still breach `memory.max` via anonymous direct memory plus file-backed pages. Symptoms: unexplained retries, jittery latency right after deployments, cgroup OOM kills with low old-gen utilization. Inspect `memory.current`, `memory.peak`, and per-field `memory.stat` before blaming GC tuning alone.

```
# Detailed cgroup v2 memory breakdown (inside container mount namespace)
grep -E '^(anon|file|kernel_stack|slab|sock) ' /sys/fs/cgroup/memory.stat
```

```
# Example output interpretation
# anon      → JVM heap slices, stacks, JNI malloc
# file      → page cache (jars, data files)
# slab      → dentry/inode kmem caches attributable to cgroup
# Raise memory.max OR reduce -Xmx/off-heap OR shrink cold page cache churn
```

## 8\. Netty I/O — Two Worlds of Memory

Network I/O in Java typically crosses three boundaries: the JVM heap (managed by the GC), *native* memory (outside the heap—direct buffers, JNI, arenas), and the kernel’s socket / page-cache path. Choosing between **heap `byte[]`**, **direct `ByteBuffer`**, and **zero-copy transfers** (for example OS `sendfile`\-style paths surfaced by frameworks) decides how many copies occur and whether the kernel receives a stable, unpinned pointer.

**Heap buffers** live in Eden / survivor / old generations. To reach the NIC, bytes are usually copied into a temporary native buffer then into kernel `sk_buff` chains.

**Direct buffers** allocate off-heap; the JVM pins a stable native address so the kernel and DMA engines can safely read/write without chasing a moving GC object.

Frameworks like Netty pool direct memory (often via allocator arenas) and integrate with JNI / epoll paths to reduce jitter. Zero-copy skips user-space copies entirely when semantics allow—kernel page cache ↔ NIC instead of bouncing through JVM buffers.

**Side note:** GC can relocate heap objects; the kernel expects a stable physical/virtual mapping for scatter-gather DMA. Direct buffers satisfy that constraint; heap arrays do not without an extra native copy.

Figure 8 — Netty I/O paths — heap vs direct vs zero-copy

<img src="/diagrams/linux-memory-architecture/8.svg" alt="Netty I/O paths — heap vs direct vs zero-copy" class="doc-diagram" />

Heap paths pay an extra JNI / memcpy hop; direct buffers align with stable native addresses; page-cache pipelines avoid user-space duplication when semantics permit.

## 9\. ZooKeeper Write Request — Complete Trace

A synchronous write traverses kernel networking, Netty’s event loop, deserialization on-heap, request processors that touch both stack and heap, durable logging through off-heap / page cache, and finally mutates the in-memory data tree (typically old-generation pressure for long-lived structures).

### Step-by-step trace

| Step | Phase | Primary memory | What happens |
| --- | --- | --- | --- |
| 1 | NIC → kernel | KERNEL | TCP segment lands; socket fd + `sk_buff` plumbing |
| 2 | Selector wake | STACK + HEAP | Netty EventLoop (`epoll_wait`) — stack frames, channel/task objects |
| 3 | Read path | OFF-HEAP | Bytes into pooled `DirectByteBuffer` |
| 4 | Decode | HEAP Eden | Wire format → ephemeral request graphs |
| 5 | PrepRequestProcessor | STACK + HEAP | ACL / session validation, queue handoffs |
| 6 | SyncRequestProcessor | OFF-HEAP → page cache | Serialize txn; durable log via kernel page cache → disk |
| 7 | FinalRequestProcessor | HEAP Old Gen | Apply to data tree (`DataTree`) |
| 8 | Response | OFF-HEAP → KERNEL | Encode; write to socket; DMA to wire |

### Component map

-   **Netty layer:** event loop threads, pooled direct buffers, channel metadata (heap + off-heap mix).
-   **Request pipeline:** single-producer / multi-consumer queues; processor objects in old gen; temporary validation state on stack.
-   **Durability:** transaction log via `FileChannel` — user buffers may be direct; kernel owns page cache.
-   **Data tree:** long-lived znodes and watches → steady old-gen footprint + occasional promotion spikes.

Figure 9 — ZooKeeper write request — end-to-end memory trace

<img src="/diagrams/linux-memory-architecture/9.svg" alt="ZooKeeper write request — end-to-end memory trace" class="doc-diagram" />

Colored badges mirror segment classes: gray kernel, purple heap hot/cold pools, yellow stack interaction, red direct memory for I/O slabs.

## 10\. Espresso Architecture — Memory Locations

**Espresso** is LinkedIn’s distributed NoSQL store built on MySQL plus a Java routing layer. Requests fan in through JVM-owned structures, traverse managed connection pools and caches, then land in InnoDB’s buffer pool mapped from the filesystem—so footprint spans heap, direct memory, mmap, and kernel caches simultaneously.

| Component | Memory Location | Details |
| --- | --- | --- |
| Router (Java) | HEAP + OFF-HEAP | Netty for network, heap for routing tables |
| MySQL storage engine | KERNEL + MMAP | InnoDB buffer pool uses mmap’d files |
| Replication stream | OFF-HEAP | Netty `DirectByteBuffer` for binlog reading |
| Cache layer | HEAP Old Gen | Long-lived cached query results |
| Connection pool | KERNEL + HEAP | File descriptors (kernel) + connection objects (heap) |

Figure 10 — Espresso memory architecture

<img src="/diagrams/linux-memory-architecture/10.svg" alt="Espresso memory architecture" class="doc-diagram" />

The router’s JVM view is only part of RSS; InnoDB leverages mmap and OS cache, so RSS + page cache captures true working set pressure.

## 11\. Linux Commands for JVM Memory Investigation

Correlate RSS ≠ Java heap by walking from process summary down to VMAs (`smaps`), then Java natives (`jcmd VM.native_memory`), cgroup accounting, and kernel-wide pressure (`vmstat`, buddy).

### Diagnostic commands

```
# Process overview — threads, VSZ/RSS basics
ps -o pid,user,psr,pcpu,rss,vsz,cmd -p $PID --sort=-rss | head -n 20

# Live view (shift columns to RSS / swap)
top -p $PID

# cgroup-scoped totals (modern systems)
grep -E '^(MemTotal|MemAvailable)' /proc/meminfo
echo "current:"; cat /sys/fs/cgroup/$CGROUP/memory.current

# VMA map & per-mapping RSS / dirty / swap splits
grep -q "^0040" <<<"" 2>/dev/null; cat /proc/$PID/maps
smem -t -p -P java  # optional SUMMARYRSS style rollups where available

# Heavyweight detail — per-mapping PSS/USS/private-huge anon
grep -v "^#" /proc/$PID/smaps | grep -E "^(004|Size|KernelPageSize|Shared|Private|PSS|USS|Swap)" -

# Allocator-style dump (native detail)
sudo pmap -XX $PID | head -n 120

# Java-specific
jcmd $PID VM.native_memory summary scale=MB
jcmd $PID VM.native_memory detail
jmap -heap $PID
jstat -gcutil $PID 1000 5

# cgroup v2 counters (path varies by runtime)
cat /sys/fs/cgroup/system.slice/**/memory.stat 2>/dev/null | head
cat /sys/fs/cgroup/system.slice/**/memory.events 2>/dev/null

# Kernel pressure & fragmentation
cat /proc/meminfo
cat /proc/buddyinfo
vmstat 1 10
```

Prefer `jcmd … detail` after reproducing load; `smaps_rollup` (where available) gives a fast PSS snapshot without parsing every VMA line.

Figure 11 — JVM memory investigation toolkit

<img src="/diagrams/linux-memory-architecture/11.svg" alt="JVM memory investigation toolkit" class="doc-diagram" />

Start wide (process cgroup), drill into maps, then bifurcate JVM vs kernel with `jcmd` + buddy/vmstat corroboration.

## 12\. Master Reference — Where Everything Lives

Use this cheat sheet while reading profiles: every Java subsystem pins to one or more of DATA / TEXT / HEAP / STACK / OFF-HEAP / KERNEL.

| Java component | Primary segment | Secondary / notes |
| --- | --- | --- |
| `libjvm.so`, JIT code cache | TEXT + OFF-HEAP Code | RX mappings; JIT grows outside Java heap |
| Interpreter / adapters | TEXT | VM stubs in read-only mappings |
| Static finals, string intern tables | DATA / Metaspace | Class metadata vs compressed class space |
| Object graphs, collections | HEAP Young / Old | Promotion governs old-gen spikes |
| Thread stacks, JNI frames | STACK | \-Xss \* thread count contributes to RSS |
| Direct buffers, mapped files, arenas | OFF-HEAP | MaxDirectMemorySize, Netty pools |
| Sockets, Files, Epoll buffers | KERNEL | FD table + sk\_buff / page cache external to JVM book-keeping |
| GC roots, monitors | STACK → HEAP | JNI global refs bridge native side |
| Unsafe / Panama off-heap APIs | OFF-HEAP | Manual lifecycle—leaks show as anon RSS growth |

Figure 12 — Master reference — everything mapped

<img src="/diagrams/linux-memory-architecture/12.svg" alt="Master reference — everything mapped" class="doc-diagram" />

Arrows emphasize hot data flow: bytecode text feeds heap allocation, stacks hold transient references, direct regions feed kernel DMA paths.
