---
title: "Part A terms, each explained"
slug: /gpu-llm-kubernetes/ch6
sidebar_position: 6
sidebar_label: "6. Part A terms, each explained"
description: "Chapter 6 · Part A — Silicon"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/ch6/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->
<p class="gm-lead">Every technical term used in Chapters 1–5, defined in plain language with the reason it matters. Read this once, then use it as a lookup.</p>

## Hardware units

<dl class="gm-kv">
<dt>GPU</dt><dd>Graphics Processing Unit. A processor built for running one operation across huge amounts of data simultaneously. Used for ML because neural networks are mostly matrix math, which is exactly that kind of work.</dd>
<dt>CPU</dt><dd>Central Processing Unit. A few fast, complex cores optimized for running one thread as quickly as possible with branches and unpredictable memory access. Runs the OS, the Python interpreter, the data pipeline, and orchestrates the GPU.</dd>
<dt>Die</dt><dd>The single piece of silicon carrying the transistors. "Two dies in one package" (Blackwell) means two chips wired together to act as one.</dd>
<dt>Transistor</dt><dd>The basic switch. H100 has ~80 billion; more transistors → more SMs, more cache, more tensor cores.</dd>
<dt>SM (Streaming Multiprocessor)</dt><dd>The GPU's core unit of execution, containing schedulers, registers, CUDA cores, tensor cores and shared memory. A GPU with more SMs does more work per clock.</dd>
<dt>CUDA core</dt><dd>One scalar floating-point arithmetic lane inside an SM. 128 per SM on Hopper. Handles everything that isn't matrix multiplication.</dd>
<dt>Tensor core</dt><dd>A unit that multiplies small matrices in a single instruction; delivers most of a GPU's ML throughput. Needs low-precision inputs (FP16/BF16/FP8) to be used.</dd>
<dt>Warp scheduler</dt><dd>Picks which group of 32 threads executes next, every clock cycle. Hides memory latency by switching between groups.</dd>
<dt>Register file</dt><dd>The fastest memory, private to each thread; 256 KB per SM. Using too many registers per thread limits how many threads fit.</dd>
<dt>Shared memory</dt><dd>Small (up to 228 KB per SM), very fast memory that threads in one block share and manage explicitly. The key to reusing data loaded from HBM.</dd>
<dt>L1 cache</dt><dd>Automatic cache per SM for global memory reads; shares hardware with shared memory.</dd>
<dt>L2 cache</dt><dd>A larger cache (50 MB on H100) shared by all SMs; last stop before HBM.</dd>
<dt>HBM (High-Bandwidth Memory)</dt><dd>Stacked DRAM next to the GPU die; the GPU's "RAM". Its bandwidth (TB/s) is what limits LLM token generation speed; its capacity (GB) is what limits model size per GPU.</dd>
<dt>Memory controller</dt><dd>Hardware that reads and writes the HBM stacks, spreads addresses across them, and handles ECC.</dd>
<dt>ECC</dt><dd>Error-correcting code: extra bits that detect and fix single-bit memory errors and detect double-bit ones. Datacenter GPUs have it; uncorrectable (double-bit) errors mean the card must be replaced.</dd>
<dt>Copy engine / DMA</dt><dd>A unit that moves memory between host and device without using SMs, so copies overlap with compute.</dd>
<dt>GigaThread engine</dt><dd>The hardware scheduler that assigns thread blocks to SMs.</dd>
<dt>GPC / TPC</dt><dd>Groupings of SMs on the die (cluster of ~18 SMs / pair of SMs). Matter for MIG boundaries and yield, rarely for programming.</dd>
<dt>SFU (Special Function Unit)</dt><dd>Hardware for exp, log, sqrt and trig, used heavily by softmax and activation functions.</dd>
<dt>LD/ST unit</dt><dd>Load/store unit: turns a warp's memory instructions into cache/memory transactions.</dd>
<dt>TMA</dt><dd>Tensor Memory Accelerator (Hopper+): copies whole tiles into shared memory asynchronously.</dd>
<dt>NVDEC / NVJPG</dt><dd>Fixed-function video/JPEG decoders on the GPU; let data loading skip the CPU.</dd>
<dt>Interposer / CoWoS</dt><dd>Silicon layer that wires the GPU die to its HBM stacks; a manufacturing bottleneck.</dd>
<dt>SXM / PCIe form factor</dt><dd>SXM: high-power module on an 8-GPU board with NVSwitch. PCIe: standard card, lower power, limited GPU-to-GPU links.</dd>
</dl>

## Interconnects

<dl class="gm-kv">
<dt>PCIe (Peripheral Component Interconnect Express)</dt><dd>The bus connecting GPU to CPU, NIC and storage. Gen5 x16 ≈ 64 GB/s per direction. Slow relative to HBM, so data should cross it as rarely as possible.</dd>
<dt>NVLink</dt><dd>NVIDIA's direct GPU-to-GPU link, ~14× faster than PCIe. Enables tensor parallelism and fast all-reduce within a node.</dd>
<dt>NVSwitch</dt><dd>A switch chip that gives all 8 GPUs in a node full-speed NVLink to each other.</dd>
<dt>InfiniBand / RoCE</dt><dd>Low-latency datacenter networking (400 Gb/s per port) between nodes. RoCE is the same idea over Ethernet.</dd>
<dt>RDMA</dt><dd>Remote Direct Memory Access: a NIC writes directly into another machine's memory, bypassing CPU and OS. GPUDirect RDMA does this straight into GPU memory.</dd>
<dt>NIC / HCA</dt><dd>Network interface card; "HCA" (host channel adapter) is the InfiniBand term. Multi-GPU nodes have one per GPU.</dd>
<dt>UPI / Infinity Fabric</dt><dd>The link between the two CPU sockets in a server. Crossing it to reach memory or a GPU on the other socket is slower.</dd>
<dt>NUMA (Non-Uniform Memory Access)</dt><dd>Each CPU socket has its own local memory and PCIe slots. "Local" access is fast; "remote" crosses the socket link. GPU processes should run on the socket their GPU is attached to.</dd>
<dt>NUMA node</dt><dd>One socket plus its local memory and devices, as seen by the OS (<code>numactl --hardware</code>).</dd>
<dt>NVMe</dt><dd>The protocol for SSDs attached directly over PCIe; ~7 GB/s per drive vs ~0.5 GB/s for SATA.</dd>
<dt>RAID0</dt><dd>Striping data across drives for bandwidth; any one drive failing loses everything, so scratch use only.</dd>
</dl>

## Execution concepts

<dl class="gm-kv">
<dt>Kernel</dt><dd>A function that runs on the GPU, executed by many threads at once.</dd>
<dt>Thread</dt><dd>One execution of a kernel. GPUs run thousands per SM.</dd>
<dt>Warp</dt><dd>32 threads executed together in lockstep. The hardware's real unit of scheduling.</dd>
<dt>Thread block</dt><dd>A group of up to 1024 threads that runs on one SM and can share memory and synchronize.</dd>
<dt>Grid</dt><dd>All the blocks of one kernel launch.</dd>
<dt>SIMT (Single Instruction, Multiple Threads)</dt><dd>The GPU execution style: one instruction is issued for a whole warp; each thread applies it to its own data.</dd>
<dt>Warp divergence</dt><dd>When threads in a warp take different branches, the warp executes both paths one after the other, wasting throughput.</dd>
<dt>Occupancy</dt><dd>The fraction of the SM's maximum resident warps actually in use. Higher occupancy → more latency hiding. Limited by registers, shared memory and block size.</dd>
<dt>Latency hiding</dt><dd>Keeping the SM busy with other warps while one waits for memory. GPUs rely on this instead of large caches.</dd>
<dt>Coalescing</dt><dd>When the 32 threads of a warp read adjacent addresses, the hardware fetches them in one or two transactions. Scattered reads cost up to 32 transactions.</dd>
<dt>Bank conflict</dt><dd>Two threads accessing the same shared-memory bank in one instruction, forcing serialization.</dd>
<dt>Stream</dt><dd>An ordered queue of GPU work. Multiple streams let copies, compute and communication overlap.</dd>
<dt>Event</dt><dd>A marker in a stream used for cross-stream dependencies and timing.</dd>
<dt>Synchronization</dt><dd>Waiting for GPU work to finish before the CPU continues. Necessary sometimes; performance-killing when accidental.</dd>
<dt>CUDA Graph</dt><dd>A recorded set of kernel launches replayed as one unit to remove launch overhead.</dd>
<dt>Kernel launch overhead</dt><dd>The ~5–10 µs of CPU and driver work to start a kernel. Dominates when kernels are tiny.</dd>
<dt>Kernel fusion</dt><dd>Combining several operations into one kernel so intermediate results stay in registers/shared memory rather than round-tripping to HBM.</dd>
<dt>Tiling</dt><dd>Breaking a large matrix operation into blocks that fit in shared memory so each loaded value is reused many times.</dd>
<dt>Pinned (page-locked) memory</dt><dd>Host memory the OS promises not to move, so the GPU's copy engine can DMA from it at full speed.</dd>
<dt>Unified memory</dt><dd>A single address space where pages migrate between CPU and GPU on demand. Convenient, but page faults are slow.</dd>
</dl>

## Performance concepts

<dl class="gm-kv">
<dt>FLOPS</dt><dd>Floating-point operations per second. A multiply-add counts as 2. H100 ≈ 1,000 TFLOPS in BF16 with tensor cores.</dd>
<dt>Bandwidth</dt><dd>Bytes per second a memory or link can move. HBM3 ≈ 3.35 TB/s; NVLink 900 GB/s; PCIe 64 GB/s.</dd>
<dt>Latency</dt><dd>Time for a single access to complete. HBM ~500 ns; PCIe ~1–2 µs; network ~2–10 µs.</dd>
<dt>Arithmetic intensity</dt><dd>FLOPs done per byte loaded from memory. Decides whether a kernel is limited by compute or by bandwidth.</dd>
<dt>Roofline model</dt><dd>A chart of achievable FLOPS vs arithmetic intensity: a sloped line (bandwidth limit) meeting a flat line (compute limit). Locate your kernel on it to know what to optimize.</dd>
<dt>Memory-bound</dt><dd>Limited by bytes/second, not math. LLM decode, elementwise ops, normalization. Fix: fewer bytes (quantize, fuse, batch).</dd>
<dt>Compute-bound</dt><dd>Limited by FLOPS. Large matmuls, prefill, training. Fix: tensor cores, lower precision, better kernels.</dd>
<dt>Utilization (GPU_UTIL)</dt><dd>Percentage of time any kernel was running. Says nothing about how much of the chip was used.</dd>
<dt>SM activity / tensor activity</dt><dd>Profiling counters showing what fraction of SMs / tensor cores were actually busy — the honest utilization metrics.</dd>
<dt>Data starvation</dt><dd>The GPU finishing a batch before the CPU has the next one ready; shows as sawtooth utilization.</dd>
<dt>Throttling (GPU)</dt><dd>Clocks reduced by the driver because of power cap or temperature. Check <code>CLOCK_THROTTLE_REASONS</code>.</dd>
<dt>TDP</dt><dd>Thermal design power: the sustained watts the cooling is designed for (700 W H100 SXM).</dd>
<dt>Xid</dt><dd>An NVIDIA driver error code written to the kernel log when the GPU hits a fault; the number identifies the class of problem.</dd>
</dl>

## Precision and number formats

<dl class="gm-kv">
<dt>FP32 (single precision)</dt><dd>32-bit float: 8-bit exponent, 23-bit mantissa. The safe default; slow on tensor cores unless TF32 is enabled.</dd>
<dt>TF32</dt><dd>Tensor-core mode that keeps FP32's range but rounds the mantissa to 10 bits; ~8× faster than true FP32 and accurate enough for training.</dd>
<dt>FP16 (half precision)</dt><dd>16-bit float with a 5-bit exponent: small range, so gradients can underflow → needs loss scaling.</dd>
<dt>BF16 (bfloat16)</dt><dd>16-bit float with FP32's 8-bit exponent and only 7 mantissa bits. Same range as FP32, so no loss scaling; the standard for modern training.</dd>
<dt>FP8</dt><dd>8-bit floats (E4M3 for weights/activations, E5M2 for gradients). Doubles tensor-core throughput on Hopper; needs per-tensor scale factors.</dd>
<dt>INT8 / INT4</dt><dd>Integers with a scale; used to quantize inference weights. Cuts memory and bandwidth 2–4× with small accuracy loss.</dd>
<dt>Mixed precision</dt><dd>Computing in BF16/FP16 while keeping FP32 master weights and accumulators. Best of both.</dd>
<dt>Loss scaling</dt><dd>Multiplying the loss by a large constant so FP16 gradients don't underflow, then dividing back. Unnecessary with BF16.</dd>
<dt>Quantization</dt><dd>Converting weights (and sometimes activations or KV cache) to fewer bits after training (post-training quantization: GPTQ, AWQ, FP8) or during it (quantization-aware training).</dd>
</dl>

## Software and sharing

<dl class="gm-kv">
<dt>CUDA</dt><dd>NVIDIA's platform for programming GPUs: language extensions, compiler, runtime, driver and libraries.</dd>
<dt>Driver (kernel + user mode)</dt><dd>The OS-level software that owns the GPU. Version must be ≥ what the toolkit needs.</dd>
<dt>CUDA Toolkit</dt><dd>nvcc, the runtime library and math libraries; installed in the container image.</dd>
<dt>PTX / SASS</dt><dd>Portable intermediate assembly / the actual machine code for one GPU generation.</dd>
<dt>Compute capability</dt><dd>The hardware feature version (8.0 A100, 9.0 H100) kernels must be compiled for.</dd>
<dt>cuBLAS / cuDNN / NCCL</dt><dd>Libraries for matmul / neural-network ops / multi-GPU communication.</dd>
<dt>Triton / CUTLASS</dt><dd>Kernel-writing tools: Triton is a Python tile DSL; CUTLASS is NVIDIA's C++ template library.</dd>
<dt>NVIDIA Container Toolkit</dt><dd>Makes GPUs visible inside containers by injecting device files and driver libraries.</dd>
<dt>Device plugin</dt><dd>Kubernetes component that advertises <code>nvidia.com/gpu</code> resources on a node.</dd>
<dt>GPU Operator</dt><dd>Kubernetes operator that installs driver, toolkit, device plugin, monitoring and MIG manager with matched versions.</dd>
<dt>MIG (Multi-Instance GPU)</dt><dd>Hardware partitioning of one A100/H100 into up to 7 isolated GPUs.</dd>
<dt>MPS (Multi-Process Service)</dt><dd>Lets multiple processes share one GPU concurrently without memory isolation.</dd>
<dt>Time-slicing</dt><dd>Processes take turns on the GPU; no isolation; dev use only.</dd>
<dt>DCGM</dt><dd>Data Center GPU Manager: NVIDIA's monitoring and diagnostics daemon and the source of Prometheus GPU metrics.</dd>
<dt>Nsight Systems / Nsight Compute</dt><dd>Profilers: Systems shows a timeline of CPU and GPU activity (find gaps); Compute shows per-kernel hardware counters (find why a kernel is slow).</dd>
</dl>
