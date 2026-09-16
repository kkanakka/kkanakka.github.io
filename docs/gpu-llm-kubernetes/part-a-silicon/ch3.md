---
title: "How CUDA works: from PyTorch call to running kernel"
slug: /gpu-llm-kubernetes/ch3
sidebar_position: 3
sidebar_label: "3. How CUDA works: from PyTorch call to…"
description: "Chapter 3 · Part A — Silicon"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/ch3/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->
<p class="gm-lead">CUDA is the software that makes the hardware in Chapter 2 usable: a programming model (write one function, run it on thousands of threads), a compiler, a driver, and a stack of libraries that PyTorch and TensorFlow call. When <code>y = x @ w</code> runs on a GPU, roughly ten layers of software sit between that line and a tensor core.</p>

## The software stack

<figure>
<div class="gm-stack-d">
  <div class="gm-layer" style="border-color:#0969da;background:#ddf4ff"><b>Your code</b><span><code>torch.matmul(x, w)</code> / <code>tf.matmul</code> / JAX <code>jnp.dot</code> — framework tensors on device "cuda:0"</span></div>
  <div class="gm-layer" style="border-color:#0969da;background:#ddf4ff"><b>Framework dispatcher</b><span>PyTorch's ATen picks the CUDA implementation for the op, checks dtypes/shapes, decides whether to fuse (torch.compile / Triton) or call a library</span></div>
  <div class="gm-layer" style="border-color:#8250df;background:#fbefff"><b>CUDA libraries</b><span>cuBLAS / cuBLASLt (matmul), cuDNN (conv, attention, norms), NCCL (multi-GPU collectives), cuFFT, cuSPARSE, CUTLASS (templates the libraries are built from), TensorRT (inference graph compiler)</span></div>
  <div class="gm-layer" style="border-color:#8250df;background:#fbefff"><b>CUDA Runtime API</b><span><code>libcudart</code>: <code>cudaMalloc</code>, <code>cudaMemcpyAsync</code>, kernel launch <code>&lt;&lt;&lt;grid, block&gt;&gt;&gt;</code>, streams, events, graphs. Versioned with the toolkit (12.x).</span></div>
  <div class="gm-layer" style="border-color:#8250df;background:#fbefff"><b>CUDA Driver API + user-mode driver</b><span><code>libcuda.so</code>: contexts, modules, memory mapping, JIT-compiles PTX to SASS for the installed GPU. Ships with the NVIDIA driver, not the toolkit.</span></div>
  <div class="gm-layer" style="border-color:#9a6700;background:#fff8c5"><b>Kernel-mode driver</b><span><code>nvidia.ko</code>, <code>nvidia-uvm.ko</code>: talks to the PCIe device, manages GPU memory pages, unified memory faults, MIG, error reporting (Xid)</span></div>
  <div class="gm-layer" style="border-color:#9a6700;background:#fff8c5"><b>Container layer (Kubernetes)</b><span>NVIDIA Container Toolkit injects <code>/dev/nvidia*</code> and <code>libcuda.so</code> into the container; the device plugin advertises <code>nvidia.com/gpu</code> to the kubelet</span></div>
  <div class="gm-layer" style="border-color:#cf222e;background:#ffebe9"><b>Hardware</b><span>Command processor → GigaThread engine → SMs (Chapter 2)</span></div>
</div>
<figcaption>The CUDA stack. The two most common Kubernetes failures live at the boundaries: a container's toolkit version newer than the node's driver ("CUDA driver version is insufficient"), and a container that can't see <code>/dev/nvidia*</code> because the runtime class or device plugin isn't set.</figcaption>
</figure>
<div class="gm-warn"><b>Driver vs toolkit — the version rule</b>The <em>driver</em> (installed on the node, e.g. 550.x) must be at least as new as what the <em>toolkit</em> inside the container (e.g. CUDA 12.4) requires. Newer drivers run older toolkits. <code>nvidia-smi</code> shows the driver's maximum supported CUDA version, not what your container has; <code>nvcc --version</code> or <code>torch.version.cuda</code> shows the container's toolkit.</div>

## The programming model

<p>A CUDA program is ordinary C++ with three additions: functions marked <code>__global__</code> that run on the GPU (kernels), a launch syntax that says how many threads to run, and built-in variables so each thread can find out which one it is.</p>
<pre><code><span class="gm-c">// Kernel: every thread computes one element of c = a + b</span>
__global__ <span class="gm-k">void</span> vector_add(<span class="gm-k">const float</span>* a, <span class="gm-k">const float</span>* b, <span class="gm-k">float</span>* c, <span class="gm-k">int</span> n) {
    <span class="gm-k">int</span> i = blockIdx.x * blockDim.x + threadIdx.x;   <span class="gm-c">// my global index</span>
    <span class="gm-k">if</span> (i &lt; n) c[i] = a[i] + b[i];
}

<span class="gm-k">int</span> main() {
    <span class="gm-k">float</span> *d_a, *d_b, *d_c;
    cudaMalloc(&amp;d_a, n * <span class="gm-k">sizeof</span>(<span class="gm-k">float</span>));           <span class="gm-c">// allocate in HBM</span>
    cudaMemcpy(d_a, h_a, bytes, cudaMemcpyHostToDevice);   <span class="gm-c">// PCIe copy via copy engine</span>
    <span class="gm-k">int</span> threads = 256, blocks = (n + threads - 1) / threads;
    vector_add&lt;&lt;&lt;blocks, threads&gt;&gt;&gt;(d_a, d_b, d_c, n);    <span class="gm-c">// launch: asynchronous, returns immediately</span>
    cudaMemcpy(h_c, d_c, bytes, cudaMemcpyDeviceToHost);   <span class="gm-c">// blocks until the kernel finishes</span>
}</code></pre>
<figure>
<svg viewBox="0 0 820 300" role="img" aria-label="Grid block thread hierarchy">
  <rect x="20" y="20" width="780" height="200" rx="8" fill="#fbf9ff" stroke="#8250df" stroke-width="2"></rect><text x="36" y="42" class="gm-svgtxt" font-size="12" font-weight="600">Grid — one kernel launch (e.g. 4096 blocks)</text>
  <g id="blk"><rect width="176" height="140" rx="6" fill="#fff" stroke="#8250df"></rect></g>
  <g transform="translate(36,56)"><use href="#blk"></use><text x="88" y="18" text-anchor="middle" class="gm-svgtxt" font-size="11" font-weight="600">Block (0)</text><text x="88" y="34" text-anchor="middle" class="gm-svgtxt" font-size="9">256 threads → 8 warps</text>
    <g font-size="8"><rect x="10" y="44" width="156" height="14" fill="#ddf4ff" stroke="#0969da"></rect><text x="88" y="54" text-anchor="middle" class="gm-svgtxt">warp 0: threads 0–31</text>
    <rect x="10" y="62" width="156" height="14" fill="#ddf4ff" stroke="#0969da"></rect><text x="88" y="72" text-anchor="middle" class="gm-svgtxt">warp 1: threads 32–63</text>
    <rect x="10" y="80" width="156" height="14" fill="#ddf4ff" stroke="#0969da"></rect><text x="88" y="90" text-anchor="middle" class="gm-svgtxt">…</text>
    <rect x="10" y="98" width="156" height="14" fill="#ddf4ff" stroke="#0969da"></rect><text x="88" y="108" text-anchor="middle" class="gm-svgtxt">warp 7: threads 224–255</text></g>
    <text x="88" y="130" text-anchor="middle" class="gm-svgtxt" font-size="8">shares 48 KB shared memory</text>
  </g>
  <g transform="translate(228,56)"><use href="#blk"></use><text x="88" y="18" text-anchor="middle" class="gm-svgtxt" font-size="11" font-weight="600">Block (1)</text><text x="88" y="80" text-anchor="middle" class="gm-svgtxt" font-size="10">→ scheduled on SM 17</text></g>
  <g transform="translate(420,56)"><use href="#blk"></use><text x="88" y="18" text-anchor="middle" class="gm-svgtxt" font-size="11" font-weight="600">Block (2)</text><text x="88" y="80" text-anchor="middle" class="gm-svgtxt" font-size="10">→ SM 3</text></g>
  <g transform="translate(612,56)"><use href="#blk"></use><text x="88" y="18" text-anchor="middle" class="gm-svgtxt" font-size="11" font-weight="600">Block (4095)</text><text x="88" y="80" text-anchor="middle" class="gm-svgtxt" font-size="10">→ whichever SM frees first</text></g>
  <text x="410" y="250" text-anchor="middle" class="gm-svgtxt" font-size="12">Blocks are independent and run in any order → the same kernel scales from 1 SM to 132 SMs without changes.</text>
  <text x="410" y="272" text-anchor="middle" class="gm-svgtxt" font-size="12">Threads within a block can cooperate (shared memory, <tspan font-family="monospace">__syncthreads()</tspan>); threads in different blocks cannot, except through global memory.</text>
</svg>
<figcaption>The three-level hierarchy. You choose block size (typically 128–1024 threads) and grid size; hardware maps blocks to SMs and splits blocks into warps of 32.</figcaption>
</figure>

## Memory spaces a kernel can use

<table>
<tbody><tr><th>Space</th><th>Declared how</th><th>Scope</th><th>Where it lives</th><th>Use</th></tr>
<tr><td>Registers</td><td>ordinary local variables</td><td>thread</td><td>register file</td><td>everything hot; spills to local memory if too many</td></tr>
<tr><td>Local memory</td><td>arrays indexed dynamically, register spills</td><td>thread</td><td>HBM (cached in L1/L2)</td><td>avoid; a sign of register pressure</td></tr>
<tr><td>Shared memory</td><td><code>__shared__ float tile[64][64];</code></td><td>block</td><td>SM SRAM</td><td>tiling matmuls, attention, reductions</td></tr>
<tr><td>Global memory</td><td><code>cudaMalloc</code></td><td>whole GPU, all kernels</td><td>HBM</td><td>tensors, weights, KV cache</td></tr>
<tr><td>Constant memory</td><td><code>__constant__</code></td><td>read-only, all threads</td><td>HBM + dedicated cache</td><td>small parameters broadcast to every thread</td></tr>
<tr><td>Texture memory</td><td>texture objects</td><td>read-only</td><td>HBM + texture cache</td><td>2D locality reads; rare in ML</td></tr>
<tr><td>Pinned host memory</td><td><code>cudaMallocHost</code> / <code>pin_memory=True</code></td><td>host</td><td>page-locked DRAM</td><td>staging for fast async H2D copies</td></tr>
<tr><td>Unified / managed memory</td><td><code>cudaMallocManaged</code></td><td>host + device</td><td>migrates on page fault</td><td>convenience; slow if access pattern ping-pongs</td></tr>
</tbody></table>

## Streams, events and asynchrony

<p>Almost every CUDA call is asynchronous: the CPU enqueues work and moves on. A <strong>stream</strong> is an in-order queue of GPU work; operations in different streams may overlap. This is how copy engines and SMs run concurrently:</p>
<figure>
<svg viewBox="0 0 820 200" role="img" aria-label="Stream overlap timeline">
  <text x="20" y="30" class="gm-svgtxt" font-size="12" font-weight="600">Time →</text>
  <text x="20" y="70" class="gm-svgtxt" font-size="11">Stream 0 (copy H2D)</text>
  <rect x="170" y="52" width="120" height="26" rx="3" fill="#ddf4ff" stroke="#0969da"></rect><text x="230" y="69" text-anchor="middle" class="gm-svgtxt" font-size="10">batch 1 copy</text>
  <rect x="300" y="52" width="120" height="26" rx="3" fill="#ddf4ff" stroke="#0969da"></rect><text x="360" y="69" text-anchor="middle" class="gm-svgtxt" font-size="10">batch 2 copy</text>
  <rect x="430" y="52" width="120" height="26" rx="3" fill="#ddf4ff" stroke="#0969da"></rect><text x="490" y="69" text-anchor="middle" class="gm-svgtxt" font-size="10">batch 3 copy</text>
  <text x="20" y="115" class="gm-svgtxt" font-size="11">Stream 1 (compute)</text>
  <rect x="300" y="97" width="120" height="26" rx="3" fill="#fbefff" stroke="#8250df"></rect><text x="360" y="114" text-anchor="middle" class="gm-svgtxt" font-size="10">batch 1 fwd/bwd</text>
  <rect x="430" y="97" width="120" height="26" rx="3" fill="#fbefff" stroke="#8250df"></rect><text x="490" y="114" text-anchor="middle" class="gm-svgtxt" font-size="10">batch 2 fwd/bwd</text>
  <rect x="560" y="97" width="120" height="26" rx="3" fill="#fbefff" stroke="#8250df"></rect><text x="620" y="114" text-anchor="middle" class="gm-svgtxt" font-size="10">batch 3 fwd/bwd</text>
  <text x="20" y="160" class="gm-svgtxt" font-size="11">Stream 2 (NCCL)</text>
  <rect x="430" y="142" width="100" height="26" rx="3" fill="#fff8c5" stroke="#9a6700"></rect><text x="480" y="159" text-anchor="middle" class="gm-svgtxt" font-size="10">all-reduce grads 1</text>
  <rect x="560" y="142" width="100" height="26" rx="3" fill="#fff8c5" stroke="#9a6700"></rect><text x="610" y="159" text-anchor="middle" class="gm-svgtxt" font-size="10">all-reduce grads 2</text>
  <line x1="290" y1="78" x2="300" y2="97" stroke="#656d76" stroke-dasharray="3 2"></line><text x="700" y="69" class="gm-svgtxt" font-size="10" fill="#656d76">events enforce "copy N done before compute N"</text>
</svg>
<figcaption>Three streams overlapping. With one stream everything serializes and the GPU is idle during every copy. PyTorch's DataLoader with <code>pin_memory=True</code> plus <code>non_blocking=True</code> copies, and DDP's gradient-bucket all-reduce, are this picture.</figcaption>
</figure>
<dl class="gm-kv">
<dt>cudaStreamSynchronize / torch.cuda.synchronize</dt><dd>Block the CPU until a stream is empty. Necessary before reading results; expensive if done every step (kills overlap). A common performance bug is an accidental sync, e.g. <code>.item()</code> or printing a tensor inside the training loop.</dd>
<dt>Events</dt><dd>Markers in a stream that another stream can wait on, or that you can time between. The right way to measure kernel time.</dd>
<dt>CUDA Graphs</dt><dd>Record a sequence of launches once, then replay the whole DAG with one call. Removes ~5–10 µs CPU cost per kernel; matters when a step has thousands of small kernels (LLM decode with batch 1). vLLM and TensorRT-LLM capture the decode step as a graph.</dd>
</dl>

## Compilation: nvcc, PTX, SASS

<figure>
<div class="gm-flow">
  <div class="gm-box"><b>.cu source</b><small>C++ + CUDA extensions</small></div><div class="gm-arrow"></div>
  <div class="gm-box gm-t"><b>nvcc</b><small>splits host and device code; host part → gcc/clang</small></div><div class="gm-arrow"></div>
  <div class="gm-box gm-v"><b>PTX</b><small>virtual ISA, forward-compatible "assembly"</small></div><div class="gm-arrow"></div>
  <div class="gm-box gm-v"><b>SASS</b><small>real machine code for one architecture (sm_80, sm_90) via ptxas, ahead-of-time or JIT by the driver</small></div><div class="gm-arrow"></div>
  <div class="gm-box"><b>fatbinary</b><small>embedded in your .so with PTX + several SASS versions</small></div>
</div>
<figcaption>Compilation pipeline. "sm_90" is Hopper's compute capability; a binary built only for sm_80 still runs on H100 via PTX JIT, but slower and after a JIT delay on first launch (often blamed on "slow startup").</figcaption>
</figure>
<dl class="gm-kv">
<dt>Compute capability</dt><dd>A version number for the hardware feature set: 7.0 Volta, 8.0 A100, 8.6 A10/RTX 30, 8.9 L4/RTX 40, 9.0 H100, 10.0 B200. Libraries ship kernels per capability; a wheel that lacks yours falls back to PTX JIT or fails.</dd>
<dt>Triton</dt><dd>A Python DSL (from OpenAI) for writing GPU kernels at the tile level rather than the thread level; compiles to PTX via LLVM. <code>torch.compile</code> generates Triton for fused elementwise/reduction ops and calls cuBLAS for matmuls.</dd>
<dt>CUTLASS</dt><dd>NVIDIA's C++ template library of matmul and attention building blocks; the source of most high-performance kernels in cuBLAS, FlashAttention and TensorRT-LLM.</dd>
</dl>

## What happens on y = x @ w, in order

<div class="gm-timeline">
<div><b>1</b>Python calls <code>torch.matmul</code>; the dispatcher sees both tensors are on <code>cuda:0</code>, BF16, contiguous.</div>
<div><b>2</b>ATen calls <code>cublasLtMatmul</code> with the shapes, dtypes and a workspace buffer from PyTorch's caching allocator (which reuses freed HBM blocks so <code>cudaMalloc</code> — slow, synchronizing — is rarely called).</div>
<div><b>3</b>cuBLASLt picks a kernel from its database for this shape and GPU (tile sizes, whether to use TMA, split-K) — this heuristic is why odd shapes can be slow, and why <code>torch.backends.cudnn.benchmark=True</code> exists for convs.</div>
<div><b>4</b>The runtime enqueues the kernel launch on the current stream: grid/block dims, pointers, and the SASS to run go into a command buffer in pinned memory.</div>
<div><b>5</b>The GPU's command processor reads the buffer over PCIe (doorbell write), the GigaThread engine distributes blocks to SMs.</div>
<div><b>6</b>Each block's warps use TMA to pull tiles of x and w into shared memory, run <code>wgmma</code> tensor-core instructions accumulating in registers, and write the output tile to HBM.</div>
<div><b>7</b>Python has long since returned; the result tensor exists but is "in flight". The next op is enqueued behind it. Only a <code>.cpu()</code>, <code>.item()</code>, or explicit sync waits.</div>
</div>

## Key CUDA libraries and what they do for ML

<table>
<tbody><tr><th>Library</th><th>Role</th><th>Seen in</th></tr>
<tr><td>cuBLAS / cuBLASLt</td><td>Dense linear algebra; GEMM with epilogue fusion (bias, GELU)</td><td>every linear layer</td></tr>
<tr><td>cuDNN</td><td>Convolutions, pooling, normalization, fused attention (SDPA)</td><td>CNNs, <code>scaled_dot_product_attention</code></td></tr>
<tr><td>NCCL</td><td>All-reduce, all-gather, reduce-scatter, broadcast across GPUs/nodes over NVLink and IB</td><td>DDP, FSDP, tensor parallel</td></tr>
<tr><td>Transformer Engine</td><td>FP8 layers with automatic scaling on Hopper+</td><td>Megatron, NeMo, some HF models</td></tr>
<tr><td>TensorRT / TensorRT-LLM</td><td>Graph compiler and inference runtime; fused kernels, quantization, paged KV</td><td>production inference</td></tr>
<tr><td>DALI</td><td>GPU-side data loading and augmentation (uses NVJPG/NVDEC)</td><td>image/video training pipelines</td></tr>
<tr><td>CUDA-X / cuPy / RAPIDS</td><td>NumPy/pandas-like GPU arrays and dataframes</td><td>preprocessing, feature engineering</td></tr>
<tr><td>CUPTI / Nsight Systems / Nsight Compute</td><td>Profiling hooks; timeline and per-kernel counters</td><td>finding CPU gaps and memory-bound kernels</td></tr>
</tbody></table>

## Common CUDA errors decoded

<table>
<tbody><tr><th>Message</th><th>Meaning</th><th>Fix</th></tr>
<tr><td><code>CUDA out of memory</code></td><td>HBM exhausted (includes PyTorch's cached but free blocks)</td><td>smaller batch, activation checkpointing, <code>expandable_segments</code>, check for leaked references</td></tr>
<tr><td><code>CUDA driver version is insufficient for CUDA runtime version</code></td><td>Container toolkit newer than node driver</td><td>Upgrade node driver via GPU Operator, or use an older CUDA base image</td></tr>
<tr><td><code>no kernel image is available for execution on the device</code></td><td>Binary lacks SASS/PTX for this compute capability</td><td>Reinstall wheel built for your GPU (e.g. cu124 with sm_90)</td></tr>
<tr><td><code>illegal memory access</code> / Xid 31, 43</td><td>Kernel bug (out-of-bounds) — or a flaky GPU</td><td>Run with <code>CUDA_LAUNCH_BLOCKING=1</code> to localize; compute-sanitizer; if random, test the card</td></tr>
<tr><td><code>NCCL error: unhandled system error</code></td><td>Usually networking: IB not visible, firewall, mismatched NCCL versions</td><td><code>NCCL_DEBUG=INFO</code>, check <code>/dev/infiniband</code> in pod, <code>NCCL_SOCKET_IFNAME</code></td></tr>
<tr><td><code>ECC error</code> / Xid 48, 63, 64</td><td>Uncorrectable memory error</td><td>Cordon node; check row remapper; RMA</td></tr>
</tbody></table>
