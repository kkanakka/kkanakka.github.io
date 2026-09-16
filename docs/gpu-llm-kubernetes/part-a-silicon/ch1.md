---
title: "How a GPU works"
slug: /gpu-llm-kubernetes/ch1
sidebar_position: 1
sidebar_label: "1. How a GPU works"
description: "Chapter 1 · Part A — Silicon"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/ch1/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->
<p class="gm-lead">A CPU is a few very smart workers. A GPU is tens of thousands of simple workers who all do the same thing at the same time. Machine learning is almost entirely "do the same multiply-add on millions of numbers," which is why the GPU wins.</p>

## The anatomy of a datacenter GPU

<figure>
<svg viewBox="0 0 820 400" role="img" aria-label="GPU block diagram">
  <rect x="10" y="10" width="800" height="380" rx="12" fill="#fbf9ff" stroke="#8250df" stroke-width="2"></rect>
  <text x="26" y="36" class="gm-svgtxt" font-weight="600" font-size="14">GPU die (e.g. H100 / A100 class)</text>
  <!-- SMs -->
  <g id="sm">
    <rect width="86" height="60" rx="6" fill="#fbefff" stroke="#8250df"></rect>
  </g>
  <g transform="translate(26,52)">
    <use href="#sm"></use><text x="8" y="18" class="gm-svgtxt" font-size="11">SM</text><text x="8" y="34" class="gm-svgtxt" font-size="10">128 CUDA cores</text><text x="8" y="48" class="gm-svgtxt" font-size="10">4 Tensor cores</text>
  </g>
  <g transform="translate(120,52)"><use href="#sm"></use><text x="8" y="18" class="gm-svgtxt" font-size="11">SM</text><text x="8" y="34" class="gm-svgtxt" font-size="10">L1 / shared mem</text><text x="8" y="48" class="gm-svgtxt" font-size="10">256 KB</text></g>
  <g transform="translate(214,52)"><use href="#sm"></use><text x="8" y="18" class="gm-svgtxt" font-size="11">SM</text><text x="8" y="34" class="gm-svgtxt" font-size="10">warp schedulers</text><text x="8" y="48" class="gm-svgtxt" font-size="10">4 per SM</text></g>
  <g transform="translate(308,52)"><use href="#sm"></use><text x="8" y="18" class="gm-svgtxt" font-size="11">SM</text><text x="8" y="34" class="gm-svgtxt" font-size="10">registers</text><text x="8" y="48" class="gm-svgtxt" font-size="10">64K × 32-bit</text></g>
  <g transform="translate(402,52)"><use href="#sm"></use><text x="30" y="36" class="gm-svgtxt" font-size="18">…</text></g>
  <g transform="translate(496,52)"><use href="#sm"></use><text x="8" y="18" class="gm-svgtxt" font-size="11">SM</text><text x="8" y="34" class="gm-svgtxt" font-size="10">×132 on H100</text><text x="8" y="48" class="gm-svgtxt" font-size="10">×108 on A100</text></g>
  <text x="26" y="132" class="gm-svgtxt" font-size="11" fill="#656d76">Streaming Multiprocessors: independent, each runs many threads in lockstep groups of 32 ("warps")</text>
  <!-- L2 -->
  <rect x="26" y="150" width="556" height="40" rx="6" fill="#ddf4ff" stroke="#0969da"></rect>
  <text x="40" y="175" class="gm-svgtxt" font-size="12">L2 cache — 50 MB (H100), shared by all SMs, ~5–7 TB/s</text>
  <!-- HBM -->
  <rect x="26" y="208" width="556" height="46" rx="6" fill="#fff8c5" stroke="#9a6700"></rect>
  <text x="40" y="228" class="gm-svgtxt" font-size="12">HBM3 memory — 80 GB, ~3.35 TB/s (H100)   |   HBM2e — 40/80 GB, ~1.5–2 TB/s (A100)</text>
  <text x="40" y="246" class="gm-svgtxt" font-size="11" fill="#656d76">This is the number that decides LLM decode speed. Weights must stream from here for every generated token.</text>
  <!-- right column -->
  <rect x="610" y="52" width="180" height="60" rx="6" fill="#fff" stroke="#1f2328"></rect>
  <text x="622" y="74" class="gm-svgtxt" font-size="12" font-weight="600">NVLink / NVSwitch</text>
  <text x="622" y="92" class="gm-svgtxt" font-size="11">900 GB/s GPU↔GPU (H100)</text>
  <text x="622" y="106" class="gm-svgtxt" font-size="11">used for tensor parallelism</text>
  <rect x="610" y="126" width="180" height="60" rx="6" fill="#fff" stroke="#1f2328"></rect>
  <text x="622" y="148" class="gm-svgtxt" font-size="12" font-weight="600">PCIe Gen5 x16</text>
  <text x="622" y="166" class="gm-svgtxt" font-size="11">~64 GB/s each way to host</text>
  <text x="622" y="180" class="gm-svgtxt" font-size="11">bottleneck for data feeding</text>
  <rect x="610" y="200" width="180" height="54" rx="6" fill="#fff" stroke="#1f2328"></rect>
  <text x="622" y="222" class="gm-svgtxt" font-size="12" font-weight="600">Copy engines / DMA</text>
  <text x="622" y="240" class="gm-svgtxt" font-size="11">move data while SMs compute</text>
  <!-- bottom -->
  <rect x="26" y="272" width="764" height="100" rx="6" fill="#fff" stroke="#d0d7de"></rect>
  <text x="40" y="294" class="gm-svgtxt" font-size="12" font-weight="600">Peak compute, H100 SXM (dense)</text>
  <text x="40" y="316" class="gm-svgtxt" font-size="11">FP64: 34 TFLOPS   ·   FP32: 67 TFLOPS   ·   TF32 tensor: 495 TFLOPS   ·   FP16/BF16 tensor: 990 TFLOPS   ·   FP8 tensor: 1979 TFLOPS</text>
  <text x="40" y="340" class="gm-svgtxt" font-size="11" fill="#656d76">Tensor cores are matrix-multiply units. They only help if your kernel is a matmul in a low-precision dtype — which is what a transformer mostly is.</text>
  <text x="40" y="360" class="gm-svgtxt" font-size="11" fill="#656d76">Figures are vendor peaks; real kernels hit 40–75% of them.</text>
</svg>
<figcaption>Block diagram of a datacenter GPU. Compute (SMs) is on top, the memory hierarchy is in the middle, and the interconnects that feed it are on the right. Every performance problem in this manual is one of these three things being starved.</figcaption>
</figure>

## The execution model: threads, warps, blocks, grids

<p>When you launch a CUDA kernel you don't run one function once — you run it once per <em>thread</em>, and you can launch millions of threads. The hardware groups them:</p>
<dl class="gm-kv">
<dt>thread</dt><dd>One instance of the kernel. Has its own registers and program counter (logically).</dd>
<dt>warp</dt><dd>32 threads that execute the same instruction at the same moment (SIMT). If threads in a warp take different <code>if</code> branches, the warp runs both paths serially — "warp divergence" — and throughput halves.</dd>
<dt>block</dt><dd>Up to 1024 threads that share fast on-chip <em>shared memory</em> and can synchronize. A block lives on exactly one SM.</dd>
<dt>grid</dt><dd>All blocks of one kernel launch. The GPU's scheduler hands blocks to SMs as they free up.</dd>
</dl>
<figure>
<div class="gm-flow">
  <div class="gm-box gm-v"><b>Kernel launch</b><small>grid of blocks</small></div><div class="gm-arrow"></div>
  <div class="gm-box gm-v"><b>Block → SM</b><small>scheduler places block on a free SM</small></div><div class="gm-arrow"></div>
  <div class="gm-box gm-v"><b>Warps</b><small>block split into 32-thread warps</small></div><div class="gm-arrow"></div>
  <div class="gm-box gm-v"><b>Warp scheduler</b><small>issues 1 instruction/cycle per warp; hides memory latency by switching warps</small></div><div class="gm-arrow"></div>
  <div class="gm-box"><b>Result to HBM</b><small>then copied to host or fed to next kernel</small></div>
</div>
<figcaption>The GPU hides memory latency not with big caches (like a CPU) but by having far more warps resident than it can execute, and switching between them every cycle. That is why "occupancy" matters: too few warps and the SM idles waiting on memory.</figcaption>
</figure>

## Why LLMs are memory-bound, not compute-bound

<p>The single most useful concept for reasoning about GPU performance is <strong>arithmetic intensity</strong>: FLOPs performed per byte moved from HBM. The "roofline" says your kernel is limited by whichever is smaller — the compute peak or (bandwidth × intensity).</p>
<figure>
<svg viewBox="0 0 700 300" role="img" aria-label="Roofline model">
  <line x1="60" y1="250" x2="660" y2="250" stroke="#1f2328" stroke-width="1.5"></line>
  <line x1="60" y1="250" x2="60" y2="30" stroke="#1f2328" stroke-width="1.5"></line>
  <text x="330" y="285" class="gm-svgtxt" text-anchor="middle">Arithmetic intensity (FLOPs per byte from HBM) — log scale</text>
  <text x="20" y="140" class="gm-svgtxt" transform="rotate(-90 20 140)" text-anchor="middle">Attainable TFLOPS — log scale</text>
  <!-- roofline -->
  <polyline points="60,240 330,70 660,70" fill="none" stroke="#8250df" stroke-width="3"></polyline>
  <text x="130" y="170" class="gm-svgtxt" fill="#8250df" transform="rotate(-32 130 170)">memory-bound: slope = HBM bandwidth</text>
  <text x="470" y="60" class="gm-svgtxt" fill="#8250df">compute-bound: flat = tensor-core peak</text>
  <line x1="330" y1="70" x2="330" y2="250" stroke="#d0d7de" stroke-dasharray="4 4"></line>
  <text x="330" y="265" class="gm-svgtxt" text-anchor="middle" font-size="11">ridge point ≈ 300 FLOP/B on H100 (FP16)</text>
  <!-- points -->
  <circle cx="120" cy="203" r="7" fill="#9a6700"></circle><text x="132" y="200" class="gm-svgtxt" font-size="11">LLM decode, batch 1 (≈1–2 FLOP/B)</text>
  <circle cx="230" cy="133" r="7" fill="#9a6700"></circle><text x="242" y="130" class="gm-svgtxt" font-size="11">decode, batch 64</text>
  <circle cx="450" cy="70" r="7" fill="#0969da"></circle><text x="462" y="90" class="gm-svgtxt" font-size="11">prefill / training matmuls</text>
</svg>
<figcaption>Roofline. Generating one token for one user reads every weight of the model once (70B params × 2 bytes = 140 GB) to do about 2 FLOPs per parameter. That is far left on the chart: pure bandwidth-bound. Batching many users together reuses each weight read across requests, sliding the point right toward the compute roof. This is the entire economic logic of LLM serving.</figcaption>
</figure>
<div class="gm-note"><b>Rule of thumb</b>Decode tokens/sec for a single request ≈ HBM bandwidth ÷ model bytes. A 70B model in FP16 on one H100 (3.35 TB/s ÷ 140 GB) tops out near 24 tokens/s no matter how fast the tensor cores are. Quantizing to INT4 (35 GB) roughly quadruples it.</div>

## Precision formats

<table>
<tbody><tr><th>Format</th><th>Bits</th><th>Used for</th><th>Notes</th></tr>
<tr><td>FP32</td><td>32</td><td>Master weights, optimizer state, loss scaling</td><td>Safe default, slow, memory-hungry</td></tr>
<tr><td>TF32</td><td>19 (stored as 32)</td><td>Training matmuls on Ampere+</td><td>Automatic on tensor cores, ~8× FP32 speed</td></tr>
<tr><td>FP16</td><td>16</td><td>Mixed-precision training, inference</td><td>Small exponent range → needs loss scaling</td></tr>
<tr><td>BF16</td><td>16</td><td>Modern training and inference</td><td>FP32's range, FP16's size; no loss scaling</td></tr>
<tr><td>FP8 (E4M3/E5M2)</td><td>8</td><td>Hopper inference and training</td><td>Needs per-tensor scaling</td></tr>
<tr><td>INT8 / INT4</td><td>8 / 4</td><td>Inference weight quantization (GPTQ, AWQ)</td><td>Halves/quarters memory and bandwidth; small accuracy cost</td></tr>
</tbody></table>

## MIG, MPS and time-slicing: sharing one GPU

<ul>
<li><strong>MIG (Multi-Instance GPU)</strong> — A100/H100 can be hardware-partitioned into up to 7 isolated slices with their own SMs and memory. Kubernetes exposes them as <code>nvidia.com/mig-1g.10gb</code> etc. True isolation; best for inference fleets.</li>
<li><strong>MPS (Multi-Process Service)</strong> — multiple processes share one CUDA context and run kernels concurrently. No memory isolation; one process can OOM the others.</li>
<li><strong>Time-slicing</strong> — the device plugin advertises one physical GPU as N logical ones; processes take turns. Zero isolation, useful for dev clusters only.</li>
</ul>
