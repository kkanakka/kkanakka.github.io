---
title: "GPUs in Kubernetes"
slug: /linux/gpus-in-kubernetes
sidebar_position: 9
sidebar_label: "GPUs in Kubernetes"
description: "GPUs in Kubernetes"
---
[home](/)/ [linux guide](/docs/linux/linux-systems-guide)/ **GPUs in Kubernetes**

v1 · Updated 2026-05

Part I — Allocation

[Kubelet’s role](#kubelet) [cgroups & isolation](#cgroups) [No GPU namespace](#namespaces) [Slicing models](#slicing) [MIG explained](#mig) [MPS explained](#mps) [Time-slicing](#timeslicing) [DRA — the future](#dra)

Part II — Networking

[What is RDMA?](#rdma) [RoCE vs InfiniBand](#roce) [GPUDirect](#gpudirect) [CNI & Multus](#cni) [SR-IOV](#sriov) [NCCL](#nccl)

Part III — Workloads

[Why GPUs for ML](#why-gpu) [Inference optimizations](#inference-tricks) [KV cache](#kv-cache) [Parallelism strategies](#parallelism)

Part IV — Operations

[GPU Operator](#operator) [Scheduling concerns](#scheduling) [Topology awareness](#topology) [Monitoring](#monitoring) [Common gotchas](#gotchas)

From kubelet’s bouncer-not-surgeon view of the device, through the kernel’s surprising lack of a GPU namespace, into RDMA fabrics where one GPU reads another’s memory across the network — and finally to the workloads that justify the whole stack.

Infrastructure Practitioner depth Reference

## Part I — Allocation {#part-1}

The first thing to understand about GPUs in Kubernetes is that Kubernetes itself doesn’t understand GPUs. It allocates them, gates access to them, and lets vendor software do the real work. Everything starts there.

## § 01.01 — Kubelet’s role: the coordinator {#kubelet}

Kubelet is the node-level agent that turns scheduled pods into running containers. With GPUs, its job is narrower than people assume: it doesn’t understand streaming multiprocessors, HBM, CUDA contexts, or MIG slices. It only knows that *something* on the node has advertised a resource called `nvidia.com/gpu`, and that a pod has requested one.

The actual flow:

```bash
# 1. Pod requests GPU
resources:
  limits:
    nvidia.com/gpu: 1

# 2. Scheduler picks a node that advertises the resource
# 3. Kubelet calls the NVIDIA device plugin's Allocate() RPC
# 4. Plugin returns: device IDs, env vars, mounts, /dev nodes
# 5. Kubelet passes this to containerd / CRI-O
# 6. Runtime starts the container with GPU access
```

The crucial line: **kubelet asks the plugin and obeys**. It doesn’t inspect the GPU, doesn’t decide which physical GPU to use, and doesn’t enforce memory or compute limits. The plugin tells kubelet what to inject; kubelet injects it.

Fig 1.1 Kubelet GPU allocation hierarchy

<img src="/diagrams/gpus-in-kubernetes/1.svg" alt="gpus-in-kubernetes diagram 1" class="doc-diagram" />

The allocation hierarchy. Kubelet sits between the pod’s declarative request and the vendor stack that actually slices silicon.

## § 01.02 — cgroups: what they do and don’t do {#cgroups}

Linux cgroups (control groups) are the kernel’s mechanism for limiting resource use. For CPU, cgroups enforce hard quotas via `cpu.max`. For memory, `memory.max` sets a ceiling. For GPUs, the story is far thinner.

The **devices cgroup controller** can allow or deny access to character device files. For an NVIDIA GPU, the relevant files are:

```
/dev/nvidia0          # the GPU itself
/dev/nvidiactl        # control interface
/dev/nvidia-uvm       # unified memory driver
/dev/nvidia-uvm-tools # UVM tooling
/dev/nvidia-caps/*    # capability files (for MIG)
```

The container runtime places the container in a cgroup that allows access to a specific subset of these files. That is *the entire kernel-level isolation story* for GPUs.

#### What cgroups can do

-   Allow this container to open `/dev/nvidia0` but not `/dev/nvidia1`
-   Deny GPU access entirely to a container that didn’t request one

#### What cgroups cannot do

-   Limit how much GPU memory the container allocates
-   Limit how many SMs the container’s kernels run on
-   Set a fair-share scheduler weight for CUDA kernels
-   Prevent one container’s bug from crashing the whole GPU context
-   Account for or rate-limit memory bandwidth

The asymmetry that catches people

You can run two containers on the same node, both with `nvidia.com/gpu: 1`, and they’ll get different GPUs. But if you configure time-slicing and put them on the *same* GPU, one container allocating 39 GB of memory on a 40 GB card will OOM the other. cgroups won’t save you. The driver will.

## § 01.03 — There is no GPU namespace {#namespaces}

Linux namespaces virtualize kernel resources so containers see their own view of the world. The full set:

| Namespace | What it isolates |
| --- | --- |
| `pid` | Process IDs — each container sees its own PID 1 |
| `net` | Network interfaces, routing tables, iptables rules |
| `mnt` | Filesystem mount points |
| `user` | UID/GID mappings |
| `ipc` | SysV IPC, POSIX message queues |
| `uts` | Hostname, domain name |
| `cgroup` | The container’s view of cgroup hierarchy |
| `time` | System clock offsets |

Notably absent: **a GPU namespace**. There is no kernel primitive that says “this container sees only its own slice of GPU memory” or “this container’s view of GPU device IDs is virtualized.” When a container opens `/dev/nvidia0`, it talks to the real driver, which talks to the real GPU.

This is why GPU isolation is structurally weaker than CPU or memory isolation:

##### CPU isolation

-   cgroups `cpu.max` = hard quota
-   PID namespace virtualizes processes
-   Kernel scheduler enforces fairness
-   Strong, well-tested, decades old

##### GPU isolation

-   Devices cgroup = binary access only
-   No namespace virtualization
-   Driver decides scheduling internally
-   Real isolation needs vendor hardware (MIG)

## § 01.04 — Slicing models: how one GPU becomes many {#slicing}

Because the kernel can’t isolate GPUs, NVIDIA provides three mechanisms above the kernel. They differ wildly in isolation strength, performance overhead, and hardware requirements.

| Model | Mechanism | Memory isolation | Fault isolation | Best for |
| --- | --- | --- | --- | --- |
| **Exclusive** | 1 pod = 1 GPU | Total | Total | Training, large inference |
| **MIG** | Hardware partition | Strong | Strong | Multi-tenant prod |
| **MPS** | Process multiplexing | Soft limits | Weak | Trusted CUDA workloads |
| **Time-sliced** | Round-robin scheduling | None | None | Dev, notebooks, low-util |

### § MIG — Multi-Instance GPU {#mig}

MIG is the only model that does *real* hardware partitioning. On supported GPUs (A100, H100, H200, B200), the silicon itself can be carved into up to 7 independent **GPU instances**, each with its own slice of SMs, its own slice of HBM, its own L2 cache region, and its own memory controllers. They share no fault domains. One instance crashing does not affect the others.

MIG profiles are named by their SM and memory slice counts. On an A100 80GB:

```
1g.10gb   # 1 compute slice, 10 GB
2g.20gb   # 2 compute slices, 20 GB
3g.40gb   # 3 compute slices, 40 GB
4g.40gb   # 4 compute slices, 40 GB
7g.80gb   # the whole GPU as one MIG instance
```

The device plugin advertises each MIG geometry as its own Kubernetes resource:

```
resources:
  limits:
    nvidia.com/mig-1g.10gb: 1
```

Two MIG strategies

The NVIDIA GPU Operator supports two strategies for surfacing MIG to Kubernetes: `single` (the node exposes one uniform MIG profile, e.g. all 1g.10gb slices) and `mixed` (the node exposes multiple profiles simultaneously). Mixed is more flexible but the scheduler has to be smarter about fitting pods.

### § MPS — Multi-Process Service {#mps}

MPS is a userspace daemon that multiplexes CUDA contexts from multiple processes onto a single GPU. Without MPS, the GPU time-slices between contexts; with MPS, contexts run *concurrently* via a shared scheduler. The daemon can be configured to enforce per-client memory limits and compute percentages.

MPS is stronger than naive time-slicing but weaker than MIG. Its limitations:

-   **No fault isolation.** A fatal CUDA error in one client can take down all clients sharing the MPS daemon.
-   **Limited tenant count.** Default is 48 clients per GPU; Volta+ supports more.
-   **Memory limits are advisory.** The driver enforces them but a misbehaving process can still cause issues.

MPS shines for trusted workloads — multiple inference replicas of the same model owned by the same team, where you want to pack a GPU more densely than exclusive allocation allows but you don’t need cross-tenant security.

### § Time-slicing {#timeslicing}

The simplest and weakest sharing model. The device plugin is configured to advertise *N* “replicas” of each physical GPU. Multiple pods can be scheduled to the same underlying GPU, and the GPU’s command scheduler interleaves their work.

```
version: v1
sharing:
  timeSlicing:
    resources:
      - name: nvidia.com/gpu
        replicas: 4   # oversubscribe each GPU 4x
```

This is oversubscription, not isolation. From a pod’s perspective, it has a whole GPU; in reality, it shares one with three others. There is no memory limit, no compute guarantee, and no fault containment. A pod that allocates all available HBM will starve everyone else. A CUDA crash will affect every pod on that GPU.

When time-slicing is appropriate

Jupyter notebooks for ML researchers. Dev environments where developers occasionally run small models. Inference for tiny models where you genuinely don’t care about jitter. Anywhere the workload is bursty, the tenants trust each other, and the failure mode is acceptable.

### § DRA — Dynamic Resource Allocation {#dra}

The device plugin API was designed for fungible resources: every `nvidia.com/gpu` looks identical to the scheduler. That assumption broke down years ago. A modern GPU node might have GPUs with different memory sizes, different MIG configurations, different NVLink topologies, and different sharing modes.

**Dynamic Resource Allocation** (DRA), generally available in Kubernetes 1.32, replaces the flat resource counter with a richer model. Workloads describe what they need via a `ResourceClaim`; a DRA driver (NVIDIA ships one) decides how to satisfy it. The pod can specify:

-   A specific MIG profile
-   Minimum GPU memory
-   A sharing mode (exclusive, MPS, time-slice)
-   Topology constraints (must be NVLink-connected to another claim)
-   Driver-specific tunables (compute mode, persistence mode)

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaim
metadata:
  name: training-gpu
spec:
  devices:
    requests:
    - name: gpu
      deviceClassName: gpu.nvidia.com
      selectors:
      - cel:
          expression: "device.attributes['gpu.nvidia.com'].productName == 'NVIDIA H100'"
```

DRA is where Kubernetes GPU support is heading. The old `nvidia.com/gpu: 1` still works and will for years, but DRA is what makes things like topology-aware NVLink scheduling and dynamic MIG reconfiguration tractable.

## Part II — Networking {#part-2}

Once you have multiple GPUs across multiple nodes, the question isn’t how to allocate them but how to make them *talk*. A 405 billion-parameter model doesn’t fit on one GPU. Distributed inference doesn’t work if every all-reduce round-trips through the kernel.

## § 02.01 — RDMA: Remote Direct Memory Access {#rdma}

RDMA

A network protocol that lets one machine read from or write to another machine’s memory *without involving the CPU or operating system on either side*. The application registers a memory region with the NIC; the remote side, knowing the address and a key, transfers data directly. Latency drops from milliseconds to single-digit microseconds. CPU usage during transfer is essentially zero.

To understand why RDMA matters, contrast it with a normal TCP send. When a program calls `send()`:

1.  Data is copied from userspace into a kernel socket buffer.
2.  The TCP/IP stack adds headers, computes checksums, manages retransmission state.
3.  The NIC driver DMA-copies the buffer to the NIC.
4.  The NIC puts it on the wire.
5.  On the receiving side: the inverse, plus an interrupt that wakes the receiving process.

Every step costs CPU cycles and memory bandwidth. For a 10 KB message, the overhead is acceptable. For an 80 GB tensor moved every layer of every step of a training run, it’s catastrophic. The CPU becomes the bottleneck of a workload that should be limited by the GPU.

RDMA collapses this. The application’s buffer *is* the network buffer. The NIC reads it directly. The kernel is bypassed entirely after setup. The remote NIC writes directly into the destination buffer. The receiving CPU is never interrupted unless the application asks to be notified.

#### What RDMA requires

-   **RDMA-capable NICs** on both ends — NVIDIA ConnectX series, Broadcom Thor, AWS EFA.
-   **A lossless or near-lossless fabric.** RDMA is designed assuming the network doesn’t drop packets — there’s no fast retransmit. On Ethernet this means PFC (Priority Flow Control) and ECN (Explicit Congestion Notification).
-   **Memory registration.** The application pins memory pages and registers them with the NIC, getting a key (`rkey`) that the remote side uses to address them.
-   **Queue pairs.** Each connection is a pair of work queues (send + receive) into which the application posts work requests.

### § RoCE vs InfiniBand {#roce}

RDMA was originally an InfiniBand thing. InfiniBand is a separate physical network — different cables, different switches, different addressing. It’s expensive, fast, and used in HPC and the largest AI training clusters.

**RoCE** (RDMA over Converged Ethernet, pronounced “rocky”) brings RDMA semantics to Ethernet. RoCEv2, the version in production today, encapsulates RDMA packets in UDP/IP, so they route across any IP network. You get most of RDMA’s performance benefit on standard Ethernet hardware.

|  | InfiniBand | RoCEv2 |
| --- | --- | --- |
| Physical layer | Dedicated IB fabric | Standard Ethernet (100/200/400/800 GbE) |
| Latency floor | ~600 ns | ~1–2 μs |
| Routing | InfiniBand subnet | Standard IP routing |
| Lossless via | Built-in credit-based flow control | PFC + ECN (DCQCN) |
| Typical use | Top-tier HPC, largest AI training | Most AI clusters, cloud GPU instances |

### § GPUDirect RDMA {#gpudirect}

RDMA bypasses the kernel. **GPUDirect RDMA** goes further: it bypasses host memory entirely. The NIC reads directly from GPU memory across PCIe and sends it on the wire; the receiving NIC writes directly into the destination GPU’s memory.

Without GPUDirect, a GPU-to-GPU transfer across nodes looks like:

```
GPU A memory → host A memory → NIC A → wire → NIC B → host B memory → GPU B memory
              ↑ copy             ↑ DMA             ↑ DMA           ↑ copy
```

With GPUDirect RDMA:

```
GPU A memory → NIC A → wire → NIC B → GPU B memory
              ↑ DMA           ↑ DMA
```

Two memory copies eliminated. Host memory bandwidth freed for other work. End-to-end latency cut by 40–60% for typical message sizes.

PCIe topology matters

GPUDirect RDMA works best when the GPU and NIC share a PCIe root complex, ideally under the same PCIe switch. If the path has to traverse the CPU’s PCIe controller, performance degrades — sometimes dramatically. This is why AI server designs pair GPUs with NICs in fixed ratios and document the topology (e.g., NVIDIA’s HGX reference design pairs each GPU with a dedicated 400G ConnectX-7).

## § 02.02 — CNI and Multus: getting RDMA into a pod {#cni}

Standard Kubernetes networking goes through a CNI (Container Network Interface) plugin. Calico, Cilium, Flannel, AWS VPC CNI — they all install a single network interface in the pod, typically `eth0`, on a virtual overlay or routed network. This works beautifully for HTTP services and falls over for GPU workloads, because the standard CNI path is the standard kernel path: every packet traverses iptables, conntrack, the TCP/IP stack, and incurs copies.

The solution is **Multus** — a “meta-CNI” that lets a pod have multiple network interfaces. `eth0` stays on the default CNI for control-plane traffic (service discovery, kubectl logs, Prometheus scraping). A second interface, often called `net1`, is attached by a high-performance CNI bound to an RDMA-capable device.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: training-worker
  annotations:
    k8s.v1.cni.cncf.io/networks: rdma-net
spec:
  containers:
  - name: worker
    resources:
      limits:
        nvidia.com/gpu: 1
        rdma/hca_shared_devices_a: 1
```

Fig 2.1 Standard CNI vs GPU-aware CNI networking

<img src="/diagrams/gpus-in-kubernetes/2.svg" alt="gpus-in-kubernetes diagram 2" class="doc-diagram" />

The two networking paths a GPU pod can take. The fast path requires Multus, SR-IOV or RDMA CNI, and matching hardware.

### § SR-IOV — slicing the NIC {#sriov}

You can’t run an RDMA workload through a virtual ethernet pair. The pod needs direct access to a real hardware queue on the NIC. **SR-IOV** (Single-Root I/O Virtualization) is the PCIe feature that makes this possible: a single physical NIC presents itself as one *physical function* (PF) and many *virtual functions* (VFs). Each VF is a real PCIe device with its own queues, MAC address, and DMA paths.

The **SR-IOV network device plugin** enumerates VFs on each node and advertises them to Kubernetes as a custom resource. A pod requesting `rdma/hca_shared_devices_a: 1` gets a VF attached directly. The pod sees a real NIC; the host sees one of dozens of VFs carved from the same physical card.

This is the GPU device plugin pattern applied to networking. Same idea — advertise hardware as a Kubernetes resource, let the scheduler match supply with demand, let the kubelet inject the device into the container.

## § 02.03 — NCCL: what actually uses the fabric {#nccl}

Once you have GPUDirect RDMA over RoCE on SR-IOV VFs attached by Multus, what software actually *uses* all that machinery? For NVIDIA GPUs, the answer is **NCCL** (NVIDIA Collective Communications Library, pronounced “nickel”).

NCCL implements the collective operations that distributed deep learning needs:

| Operation | What it does | Where it’s used |
| --- | --- | --- |
| `AllReduce` | Sum tensors across all GPUs, every GPU gets the result | Gradient sync in data-parallel training |
| `AllGather` | Concatenate per-GPU tensors, every GPU gets the full concat | Tensor parallel forward pass |
| `ReduceScatter` | Sum then split — each GPU gets one shard of the sum | Tensor parallel backward pass |
| `Broadcast` | One GPU’s tensor copied to all others | Parameter initialization |
| `Send/Recv` | Point-to-point GPU-to-GPU | Pipeline parallelism between stages |

NCCL picks transports automatically. Within a node, it uses NVLink between GPUs that have it, or PCIe peer-to-peer otherwise. Between nodes, it uses InfiniBand verbs if available, RoCE if the NICs support it, or falls back to TCP sockets (which is what you want to *avoid*). The right setup means NCCL transparently uses the fast path; the wrong setup means it silently falls back to TCP and your training run is 10× slower than it should be.

How to confirm NCCL is using RDMA

Set `NCCL_DEBUG=INFO` and look at the startup log. You want to see lines like `NCCL INFO NET/IB : Using [0]mlx5_0:1/RoCE`. If you see `NET/Socket`, NCCL is falling back to TCP and you’ve misconfigured something — usually a missing device plugin allocation, wrong `NCCL_IB_HCA`, or a Multus annotation that didn’t take.

## Part III — Workloads {#part-3}

All this infrastructure exists for one reason — the workloads that run on top need it. Understanding why ML inference is so well-matched to GPUs explains why the rest of the stack is shaped the way it is.

## § 03.01 — Why GPUs for ML inference {#why-gpu}

A modern CPU has dozens of cores. Each is fast, branch-predicting, out-of-order, with megabytes of cache. It’s optimized to make a single sequential thread run as fast as possible. A GPU has thousands of cores. Each is slow, in-order, with kilobytes of cache. It’s optimized to do the *same operation* on enormous amounts of data simultaneously.

Neural network inference is mostly one operation: matrix multiplication. A transformer layer’s forward pass is, almost entirely, a sequence of giant matmuls — multiplying activations by weight matrices, multiplying queries by keys, multiplying attention outputs by value matrices. Each element of the output is independent of every other element. This is the literal definition of *embarrassingly parallel*.

~64

CPU cores — typical server

16K+

CUDA cores — H100

3.35TB/s

HBM bandwidth — H100 SXM

The bandwidth number matters as much as the core count. Inference for a large language model is often *memory-bound*: the bottleneck isn’t doing the math, it’s getting the weights from HBM into the compute units. CPUs sit at ~100 GB/s of memory bandwidth. An H100 sits at 3.35 TB/s — over 30× more. For models where weights are large and reused only briefly, this gap dominates everything.

GPUs also have **tensor cores**, dedicated units that execute matmul-and-accumulate operations at lower precision (FP16, BF16, FP8, INT8) at multiples of the throughput of regular floating-point. For inference, where lower precision is usually fine, tensor cores deliver another 2–4× speedup over what raw FLOPS numbers would suggest.

## § 03.02 — What inference servers do on top of GPUs {#inference-tricks}

Raw GPU compute isn’t enough. Production inference servers — vLLM, TensorRT-LLM, Triton, Text Generation Inference (TGI) — layer several optimizations on top.

### Continuous batching

Naïve inference processes one request at a time. The GPU then spends most of its time loading weights for a single tiny computation. **Static batching** waits until *N* requests arrive, then processes them together, sharing the weight-loading cost. But static batching adds latency (requests wait in queue) and stalls if any one request finishes early (the whole batch is held until the slowest).

**Continuous batching** (sometimes called *iteration-level scheduling*) merges requests at each decode step, not at the request level. When request A finishes early, request F joins the batch immediately. The batch is fluid. GPU utilization stays high and per-request latency stays low.

### § KV cache {#kv-cache}

An autoregressive language model generates one token at a time. To generate token *n*, it needs the attention representation for tokens 1 through *n−1*. Naïvely, that means recomputing every previous token’s attention every step. That would be quadratic in sequence length and make long contexts impossibly slow.

The **KV cache** stores the Key and Value tensors from each attention layer for every token already generated. Generating token *n* only requires computing K and V for token *n* itself, then attending over the cached K/V for tokens 1 through *n*. The compute per step is now O(*n*) instead of O(*n*²), and dominated by memory reads rather than matmul throughput.

This is why decode is *memory-bound*: the per-step work is small but the cache reads are huge. It’s also why KV cache management is the central problem of LLM serving — vLLM’s PagedAttention manages the KV cache like an OS manages virtual memory, breaking it into fixed-size pages, sharing pages across requests with common prefixes, and evicting cold pages when memory pressure rises.

### Speculative decoding

A small “draft” model generates several tokens cheaply. The large “target” model verifies them in parallel — one forward pass on the whole speculated sequence. Tokens that match what the target would have generated are accepted. Tokens that don’t are rejected and the target’s choice is used.

When the draft model agrees with the target most of the time (common for easy continuations), you get multiple tokens per forward pass at the cost of one. Throughput per GPU goes up substantially.

### Quantization

Weights stored at lower precision take less memory and load faster. FP16 is the default; INT8 and FP8 are common; INT4 is aggressive but usable for many models. A 70B-parameter model at FP16 needs 140 GB of HBM; at INT4 it fits in 35 GB. That’s the difference between needing 4 H100s and needing 1.

## § 03.03 — Parallelism strategies {#parallelism}

When a model is too big for one GPU, you split it. There are three main strategies, often combined.

| Strategy | What’s split | Comm pattern | Network demand |
| --- | --- | --- | --- |
| **Data parallel** | The batch is split; every GPU has the full model | AllReduce of gradients per step (training only) | Moderate — once per step |
| **Tensor parallel** | Each matmul is split across GPUs | AllReduce / AllGather every layer | Heavy — once per layer |
| **Pipeline parallel** | Different layers on different GPUs | Send/Recv between stages | Light — once per stage boundary |
| **Expert parallel** | MoE experts on different GPUs | AllToAll for token routing | Heavy — once per MoE layer |

Tensor parallelism is the demanding one. Splitting a matmul across 8 GPUs means an AllReduce on every layer — for a 80-layer model, that’s 80 AllReduces per forward pass. If each AllReduce takes 100 μs over RoCE, that’s 8 ms of pure communication. Over TCP, it might be 100 ms — and your “fast” inference is now anything but.

This is the connection that makes the whole stack make sense. **Tensor parallelism is why you need RDMA. RDMA is why you need Multus and SR-IOV. Multus and SR-IOV are why the device plugin pattern extends beyond GPUs.** The model architecture creates a communication pattern that creates a hardware requirement that creates a Kubernetes configuration. Each layer is downstream of the one below.

## Part IV — Operations {#part-4}

Knowing how it works is half the job. Running it in production — installing drivers, monitoring health, handling failures, paying for it — is the other half.

## § 04.01 — The NVIDIA GPU Operator {#operator}

A GPU node needs a lot of software stacked correctly: the NVIDIA kernel driver, the container toolkit, the device plugin, optionally MIG configuration, optionally DCGM-Exporter for metrics, optionally the Node Feature Discovery agent, optionally the network operator if you’re doing RDMA. Installing this by hand is tedious; getting versions to match across a fleet is painful.

The **NVIDIA GPU Operator** packages all of it as a single Helm-installable operator that runs as a DaemonSet across GPU nodes. It handles driver installation (via a privileged container, or it uses pre-installed host drivers), deploys the container toolkit, runs the device plugin, configures MIG if requested, sets up DCGM-Exporter, and keeps everything version-aligned.

```
helm install gpu-operator nvidia/gpu-operator \
  --namespace gpu-operator \
  --create-namespace \
  --set driver.enabled=true \
  --set mig.strategy=mixed \
  --set toolkit.enabled=true
```

The Operator’s MIG manager can switch MIG configurations on the fly without rebooting nodes (though running pods on a GPU need to drain first). This makes MIG actually operable at scale; doing it by hand with `nvidia-smi` across a fleet is unworkable.

There’s a parallel **Network Operator** for the RDMA side — it deploys the Mellanox OFED driver, the SR-IOV device plugin, the RDMA shared device plugin, Multus, and the Whereabouts IPAM plugin. Combined, the GPU Operator and Network Operator give you a working RDMA-enabled GPU cluster from a clean Kubernetes install.

## § 04.02 — Scheduling: what the default scheduler doesn’t do {#scheduling}

The default Kubernetes scheduler treats `nvidia.com/gpu` as an opaque counter. It will pack pods onto nodes that have spare GPUs without knowing anything about which GPU on the node, whether GPUs are NVLink-connected, or whether the chosen GPU is on the same PCIe root complex as the SR-IOV NIC the pod also requested.

For a 2-GPU tensor-parallel pod, this matters a lot. Two GPUs on the same node connected by NVLink communicate at 900 GB/s. Two GPUs on the same node not connected by NVLink communicate at 64 GB/s over PCIe. Two GPUs on different nodes over 400 GbE RoCE communicate at 50 GB/s. The scheduler doesn’t know.

#### Tools that help

-   **Topology Manager** — a kubelet feature that aligns CPU, memory, and device allocations on the same NUMA node. Doesn’t understand NVLink but does avoid cross-socket disasters.
-   **Volcano** — a batch scheduler with gang scheduling (all-or-nothing pod groups) for training jobs that need *N* pods to start simultaneously or not at all.
-   **Kueue** — Kubernetes-native job queueing with quotas, fair sharing, and preemption.
-   **NVIDIA DRA driver** — exposes NVLink topology as a constraint expressible in ResourceClaims.
-   **scheduler plugins** (kube-scheduler-plugins repo) — out-of-tree plugins for topology-aware scheduling, network-aware scheduling, etc.

## § 04.03 — Topology awareness {#topology}

A modern 8-GPU node is not a flat resource. It has internal structure:

-   **NVLink islands.** H100 nodes use NVSwitch to connect all 8 GPUs in a full mesh at 900 GB/s. Older A100 nodes connect GPUs in pairs at 600 GB/s, with non-paired GPUs falling back to PCIe.
-   **PCIe topology.** GPUs are typically grouped under PCIe switches, with each group sharing a NIC. Pairing the right GPU with the right NIC is essential for GPUDirect performance.
-   **NUMA.** The host has multiple CPU sockets, each with its own memory. A GPU is physically connected to one socket; pinning the pod’s CPU work to that socket avoids cross-socket memory traffic.

Topology awareness becomes critical when you scale past a single node. The intra-node communication pattern (NVLink) is very different from inter-node (RoCE), and the right placement strategy (all 8 GPUs of a job on one node vs 1 GPU each on 8 nodes) depends on what the job is doing. A tensor-parallel job wants tight intra-node placement. A data-parallel job is more flexible.

## § 04.04 — Monitoring {#monitoring}

The standard tool is **DCGM-Exporter** (Data Center GPU Manager), which exposes GPU metrics in Prometheus format. The metrics that matter:

| Metric | What it tells you |
| --- | --- |
| `DCGM_FI_DEV_GPU_UTIL` | % of time the GPU was doing *anything*. Misleading — a GPU at 100% might be doing a small kernel inefficiently. |
| `DCGM_FI_PROF_SM_ACTIVE` | % of SMs that had at least one active warp. Better signal than GPU\_UTIL. |
| `DCGM_FI_PROF_SM_OCCUPANCY` | Average warps per SM as a fraction of max. The “are we actually saturating compute?” metric. |
| `DCGM_FI_PROF_DRAM_ACTIVE` | % of cycles the memory subsystem was busy. High during memory-bound work (LLM decode). |
| `DCGM_FI_PROF_PIPE_TENSOR_ACTIVE` | % of cycles tensor cores were busy. The number you actually want high for ML. |
| `DCGM_FI_DEV_FB_USED` | HBM in use. Watch for OOMs. |
| `DCGM_FI_DEV_GPU_TEMP` | Temperature. Thermal throttling starts around 84°C on H100. |
| `DCGM_FI_DEV_POWER_USAGE` | Power draw. H100 SXM caps at 700W; sustained near the cap means you’re getting your money’s worth. |

For RDMA, separate tooling: `ibstat`, `perfquery`, the Mellanox `mlnx_perf` tool. The metrics you want are link utilization, packet loss (should be zero on a properly-tuned RoCE fabric), and PFC pause frames (should be infrequent — frequent pauses mean the network is congested).

## § 04.05 — Common gotchas {#gotchas}

#### Driver version mismatches

The NVIDIA kernel driver, the userspace libraries inside the container, and the CUDA version compiled into the application all have to be compatible. The container’s CUDA version must be ≤ the host driver’s supported CUDA version. The GPU Operator handles this automatically; manual installs frequently get it wrong.

#### cgroup v2 incompatibility

Older NVIDIA container toolkit versions didn’t support cgroup v2, which is the default on modern distros. If you see “Failed to initialize NVML” errors, check whether cgroup v2 is in play and whether your toolkit version is recent enough.

#### MIG mode enabled but no instances created

Enabling MIG mode on a GPU is one operation; creating MIG instances is another. A GPU with MIG mode on but no instances configured will report zero allocatable resources to Kubernetes. The Operator’s MIG manager handles this if configured; manual `nvidia-smi mig` commands are easy to forget.

#### Multus annotation silently ignored

If the `k8s.v1.cni.cncf.io/networks` annotation references a NetworkAttachmentDefinition that doesn’t exist in the pod’s namespace, Multus will log a warning but the pod will start anyway — with only `eth0`. The application sees no error. NCCL falls back to TCP. Performance collapses. Always verify the secondary interface is actually present inside the pod (`ip link`).

#### GPUDirect not actually active

GPUDirect RDMA requires the `nvidia_peermem` kernel module to be loaded. If it isn’t, transfers fall back to bouncing through host memory — silently, with no error. Check with `lsmod | grep nvidia_peermem` on the host.

#### NUMA imbalance

If your inference workers run on the “wrong” NUMA node relative to the GPU, you can lose 10–20% throughput to cross-socket memory traffic. Use the Topology Manager with policy `single-numa-node` for latency-sensitive workloads.

#### Cost of mistakes

An H100 costs ~$30k to buy and ~$2–4/hour to rent on major clouds. A misconfigured cluster running at 30% of theoretical performance is burning real money. The configuration work is worth doing carefully.

On this page

-   [Part I — Allocation](#part-1)
-   [Kubelet’s role](#kubelet)
-   [cgroups & isolation](#cgroups)
-   [No GPU namespace](#namespaces)
-   [Slicing models](#slicing)
-   [MIG](#mig)
-   [MPS](#mps)
-   [Time-slicing](#timeslicing)
-   [DRA](#dra)
-   [Part II — Networking](#part-2)
-   [RDMA](#rdma)
-   [RoCE vs IB](#roce)
-   [GPUDirect](#gpudirect)
-   [CNI & Multus](#cni)
-   [SR-IOV](#sriov)
-   [NCCL](#nccl)
-   [Part III — Workloads](#part-3)
-   [Why GPUs](#why-gpu)
-   [Inference optimizations](#inference-tricks)
-   [KV cache](#kv-cache)
-   [Parallelism](#parallelism)
-   [Part IV — Operations](#part-4)
-   [GPU Operator](#operator)
-   [Scheduling](#scheduling)
-   [Topology](#topology)
-   [Monitoring](#monitoring)
-   [Gotchas](#gotchas)
