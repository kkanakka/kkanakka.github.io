---
title: "How CPUs and GPUs work together"
slug: /gpu-llm-kubernetes/ch4
sidebar_position: 4
sidebar_label: "7. How CPUs and GPUs work together"
description: "Chapter 7 · Part A — Silicon"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/ch4/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->
<p class="gm-lead">The GPU never runs a program on its own. A CPU process owns the GPU, builds the work, launches the kernels, and feeds the data. If that CPU process stalls, the GPU stalls — while <code>nvidia-smi</code> may still report it as "busy".</p>
<figure>
<svg viewBox="0 0 820 340" role="img" aria-label="CPU-GPU pipeline">
  <rect x="10" y="10" width="360" height="320" rx="10" fill="#fff" stroke="#1f2328"></rect>
  <text x="26" y="36" class="gm-svgtxt" font-weight="600" font-size="14">Host (CPU side)</text>
  <rect x="26" y="52" width="328" height="44" rx="6" fill="#ddf4ff" stroke="#0969da"></rect><text x="40" y="70" class="gm-svgtxt" font-size="12" font-weight="600">Storage / network → read files</text><text x="40" y="86" class="gm-svgtxt" font-size="11">NVMe, S3, TFRecords, Parquet — page cache</text>
  <rect x="26" y="106" width="328" height="44" rx="6" fill="#ddf4ff" stroke="#0969da"></rect><text x="40" y="124" class="gm-svgtxt" font-size="12" font-weight="600">Decode / augment / tokenize</text><text x="40" y="140" class="gm-svgtxt" font-size="11">JPEG decode, resize, BPE — the classic CPU bottleneck</text>
  <rect x="26" y="160" width="328" height="44" rx="6" fill="#ddf4ff" stroke="#0969da"></rect><text x="40" y="178" class="gm-svgtxt" font-size="12" font-weight="600">Batch + pinned host memory</text><text x="40" y="194" class="gm-svgtxt" font-size="11">page-locked buffers allow async DMA</text>
  <rect x="26" y="214" width="328" height="44" rx="6" fill="#ddf4ff" stroke="#0969da"></rect><text x="40" y="232" class="gm-svgtxt" font-size="12" font-weight="600">Launch kernels (CUDA driver)</text><text x="40" y="248" class="gm-svgtxt" font-size="11">launch overhead ~5–10 µs each; CUDA graphs batch launches</text>
  <rect x="26" y="268" width="328" height="44" rx="6" fill="#ddf4ff" stroke="#0969da"></rect><text x="40" y="286" class="gm-svgtxt" font-size="12" font-weight="600">Post-process, checkpoint, log</text><text x="40" y="302" class="gm-svgtxt" font-size="11">argmax/sampling, write to NVMe, metrics</text>
  <!-- PCIe -->
  <path d="M370 130 L450 130" stroke="#9a6700" stroke-width="6"></path><text x="410" y="120" class="gm-svgtxt" text-anchor="middle" font-size="11">PCIe</text>
  <path d="M450 240 L370 240" stroke="#9a6700" stroke-width="6"></path><text x="410" y="262" class="gm-svgtxt" text-anchor="middle" font-size="11">results</text>
  <rect x="450" y="10" width="360" height="320" rx="10" fill="#fbf9ff" stroke="#8250df"></rect>
  <text x="466" y="36" class="gm-svgtxt" font-weight="600" font-size="14">Device (GPU side)</text>
  <rect x="466" y="52" width="328" height="44" rx="6" fill="#fbefff" stroke="#8250df"></rect><text x="480" y="70" class="gm-svgtxt" font-size="12" font-weight="600">Copy engine: H2D transfer</text><text x="480" y="86" class="gm-svgtxt" font-size="11">overlaps with compute if on a separate stream</text>
  <rect x="466" y="106" width="328" height="98" rx="6" fill="#fbefff" stroke="#8250df"></rect><text x="480" y="124" class="gm-svgtxt" font-size="12" font-weight="600">Compute stream</text><text x="480" y="142" class="gm-svgtxt" font-size="11">forward: matmul → norm → attention → matmul</text><text x="480" y="158" class="gm-svgtxt" font-size="11">backward: gradients (training only)</text><text x="480" y="174" class="gm-svgtxt" font-size="11">all-reduce with other GPUs (NCCL over NVLink/IB)</text><text x="480" y="190" class="gm-svgtxt" font-size="11">optimizer step</text>
  <rect x="466" y="214" width="328" height="44" rx="6" fill="#fbefff" stroke="#8250df"></rect><text x="480" y="232" class="gm-svgtxt" font-size="12" font-weight="600">Copy engine: D2H transfer</text><text x="480" y="248" class="gm-svgtxt" font-size="11">logits, loss, metrics back to host</text>
  <rect x="466" y="268" width="328" height="44" rx="6" fill="#fff" stroke="#8250df" stroke-dasharray="4 3"></rect><text x="480" y="286" class="gm-svgtxt" font-size="12" font-weight="600">Idle gaps = "GPU starvation"</text><text x="480" y="302" class="gm-svgtxt" font-size="11">visible as sawtooth utilization in DCGM</text>
</svg>
<figcaption>The producer/consumer pipeline between host and device. A healthy training loop keeps the copy engines and compute stream overlapped so the GPU never waits on the host. Prefetching, pinned memory, multiple DataLoader workers and CUDA graphs are all ways of widening the left column.</figcaption>
</figure>

## Why the CPU matters so much (from the original guide)

<ul>
<li><strong>Data starvation</strong> — if the input pipeline can't produce batches faster than the GPU consumes them, the GPU idles. Symptom: GPU util oscillates 100% → 0% → 100%.</li>
<li><strong>Memory bandwidth</strong> — host-to-device copies from pageable memory go through a staging buffer; pinned (page-locked) memory allows direct DMA at full PCIe speed.</li>
<li><strong>Context switching / core migration</strong> — when the scheduler moves the feeding process across cores, L1/L2 caches are cold and NUMA locality can be lost. Solved by CPU pinning (Chapter 19).</li>
<li><strong>Kernel launch overhead</strong> — small models issue thousands of tiny kernels per step; the CPU can't launch them fast enough. CUDA graphs capture a whole step and replay it in one launch.</li>
</ul>
<div class="gm-warn"><b>"GPU is 95% busy" can still mean starved</b><code>DCGM_FI_DEV_GPU_UTIL</code> reports the fraction of time <em>any</em> kernel was running, not how much of the chip it used. A tiny kernel running alone shows 100%. Use SM activity (<code>DCGM_FI_PROF_SM_ACTIVE</code>), tensor-core activity (<code>DCGM_FI_PROF_PIPE_TENSOR_ACTIVE</code>) and DRAM activity to see real efficiency.</div>

## Division of labour

<div class="gm-grid2">
<div class="gm-card"><b>CPU owns</b>Data loading and decoding · tokenization · batching · scheduling kernels · networking and RPC · checkpoint I/O · logging and metrics · sampling logic in some servers</div>
<div class="gm-card"><b>GPU owns</b>Matrix multiplies · attention · normalization · activations · gradient computation · all-reduce across GPUs · KV-cache storage during inference</div>
</div>
