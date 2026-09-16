---
title: "Inside the GPU: every component and what it does"
slug: /gpu-llm-kubernetes/ch2
sidebar_position: 2
sidebar_label: "2. Inside the GPU: every component and …"
description: "Chapter 2 · Part A — Silicon"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/ch2/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->
<p class="gm-lead">Chapter 1 showed the GPU from 10,000 feet. This chapter opens the package and walks through each part, from the largest structure (the die and its memory stacks) down to the smallest (a single tensor core), and says what each one contributes when you run a model.</p>

## The package: what you actually plug in

<figure>
<svg viewBox="0 0 820 300" role="img" aria-label="GPU package cross-section">
  <rect x="20" y="230" width="780" height="40" rx="4" fill="#f6f8fa" stroke="#1f2328"></rect><text x="410" y="255" text-anchor="middle" class="gm-svgtxt" font-size="12">Printed circuit board (SXM module or PCIe card) — power delivery (VRMs), PCIe/NVLink connectors</text>
  <rect x="120" y="180" width="580" height="46" rx="4" fill="#fff8c5" stroke="#9a6700"></rect><text x="410" y="207" text-anchor="middle" class="gm-svgtxt" font-size="12">Silicon interposer (CoWoS) — thousands of micro-wires joining die to memory; this is the packaging bottleneck in GPU supply</text>
  <rect x="150" y="90" width="80" height="86" rx="3" fill="#ffebe9" stroke="#cf222e"></rect><text x="190" y="120" text-anchor="middle" class="gm-svgtxt" font-size="11">HBM</text><text x="190" y="136" text-anchor="middle" class="gm-svgtxt" font-size="10">stack</text><text x="190" y="152" text-anchor="middle" class="gm-svgtxt" font-size="10">8–12 dies</text>
  <rect x="240" y="90" width="80" height="86" rx="3" fill="#ffebe9" stroke="#cf222e"></rect><text x="280" y="120" text-anchor="middle" class="gm-svgtxt" font-size="11">HBM</text><text x="280" y="136" text-anchor="middle" class="gm-svgtxt" font-size="10">stack</text>
  <rect x="330" y="60" width="160" height="116" rx="4" fill="#fbefff" stroke="#8250df" stroke-width="2"></rect><text x="410" y="100" text-anchor="middle" class="gm-svgtxt" font-size="12" font-weight="600">GPU die</text><text x="410" y="120" text-anchor="middle" class="gm-svgtxt" font-size="10">~814 mm², 80 billion</text><text x="410" y="134" text-anchor="middle" class="gm-svgtxt" font-size="10">transistors (H100)</text><text x="410" y="154" text-anchor="middle" class="gm-svgtxt" font-size="10">all the compute</text>
  <rect x="500" y="90" width="80" height="86" rx="3" fill="#ffebe9" stroke="#cf222e"></rect><text x="540" y="120" text-anchor="middle" class="gm-svgtxt" font-size="11">HBM</text><text x="540" y="136" text-anchor="middle" class="gm-svgtxt" font-size="10">stack</text>
  <rect x="590" y="90" width="80" height="86" rx="3" fill="#ffebe9" stroke="#cf222e"></rect><text x="630" y="120" text-anchor="middle" class="gm-svgtxt" font-size="11">HBM</text><text x="630" y="136" text-anchor="middle" class="gm-svgtxt" font-size="10">stack</text><text x="630" y="152" text-anchor="middle" class="gm-svgtxt" font-size="10">×5–6 total</text>
  <text x="410" y="40" text-anchor="middle" class="gm-svgtxt" font-size="12" fill="#656d76">Heat spreader + cold plate or heatsink above (700 W on SXM; 350 W on PCIe cards)</text>
  <text x="410" y="290" text-anchor="middle" class="gm-svgtxt" font-size="11" fill="#656d76">Side view, not to scale. The die and the memory sit side by side on an interposer, which is why "GPU memory" is so much faster than DRAM on the motherboard.</text>
</svg>
<figcaption>What a datacenter GPU package looks like in cross-section. The compute die and its HBM stacks share one interposer; every byte of model weights lives in those stacks, a few millimetres from the SMs.</figcaption>
</figure>
<dl class="gm-kv">
<dt>SXM vs PCIe</dt><dd>SXM is a mezzanine module that bolts onto an 8-GPU baseboard with NVSwitch; it gets the highest power (700 W) and full NVLink. PCIe cards fit ordinary servers, cap at ~350 W, and pair over NVLink bridges only in twos. Same chip, different performance and price.</dd>
<dt>HBM stack</dt><dd>High-Bandwidth Memory: 8–12 DRAM dies stacked vertically and connected with through-silicon vias, sitting on the interposer next to the GPU die. Each stack has a 1024-bit bus — vs 64 bits for a DDR5 DIMM — which is where the terabytes-per-second come from.</dd>
<dt>Interposer / CoWoS</dt><dd>A slab of silicon that carries the very dense wiring between the die and HBM. "Chip on Wafer on Substrate" is TSMC's name for the process; its capacity limits how many H100/B200s can be built per month.</dd>
<dt>NVSwitch baseboard</dt><dd>On an HGX 8-GPU system, four NVSwitch chips connect every GPU to every other at full NVLink bandwidth, so an 8-GPU tensor-parallel group behaves like one big GPU with 640 GB of HBM.</dd>
</dl>

## The die: top-level blocks

<figure>
<svg viewBox="0 0 820 480" role="img" aria-label="GPU die top level">
  <rect x="10" y="10" width="800" height="460" rx="8" fill="#fbf9ff" stroke="#8250df" stroke-width="2"></rect>
  <rect x="24" y="24" width="772" height="34" rx="4" fill="#fff" stroke="#1f2328"></rect><text x="410" y="46" text-anchor="middle" class="gm-svgtxt" font-size="12">PCIe Gen5 host interface · GigaThread Engine (global work distributor) · command processor</text>
  <g id="gpc"><rect width="180" height="150" rx="6" fill="#fbefff" stroke="#8250df"></rect></g>
  <g transform="translate(24,70)"><use href="#gpc"></use><text x="90" y="20" text-anchor="middle" class="gm-svgtxt" font-size="11" font-weight="600">GPC 0</text>
    <rect x="12" y="30" width="72" height="48" rx="3" fill="#fff" stroke="#8250df"></rect><text x="48" y="50" text-anchor="middle" class="gm-svgtxt" font-size="9">TPC</text><text x="48" y="64" text-anchor="middle" class="gm-svgtxt" font-size="9">SM · SM</text>
    <rect x="96" y="30" width="72" height="48" rx="3" fill="#fff" stroke="#8250df"></rect><text x="132" y="50" text-anchor="middle" class="gm-svgtxt" font-size="9">TPC</text><text x="132" y="64" text-anchor="middle" class="gm-svgtxt" font-size="9">SM · SM</text>
    <rect x="12" y="86" width="72" height="48" rx="3" fill="#fff" stroke="#8250df"></rect><text x="48" y="106" text-anchor="middle" class="gm-svgtxt" font-size="9">TPC</text><text x="48" y="120" text-anchor="middle" class="gm-svgtxt" font-size="9">SM · SM</text>
    <rect x="96" y="86" width="72" height="48" rx="3" fill="#fff" stroke="#8250df"></rect><text x="132" y="106" text-anchor="middle" class="gm-svgtxt" font-size="9">… 9 TPCs</text><text x="132" y="120" text-anchor="middle" class="gm-svgtxt" font-size="9">= 18 SMs</text>
  </g>
  <g transform="translate(220,70)"><use href="#gpc"></use><text x="90" y="20" text-anchor="middle" class="gm-svgtxt" font-size="11" font-weight="600">GPC 1</text><text x="90" y="90" text-anchor="middle" class="gm-svgtxt" font-size="11">18 SMs + raster engine</text></g>
  <g transform="translate(416,70)"><use href="#gpc"></use><text x="90" y="20" text-anchor="middle" class="gm-svgtxt" font-size="11" font-weight="600">GPC 2</text><text x="90" y="90" text-anchor="middle" class="gm-svgtxt" font-size="11">18 SMs</text></g>
  <g transform="translate(612,70)"><use href="#gpc"></use><text x="90" y="20" text-anchor="middle" class="gm-svgtxt" font-size="11" font-weight="600">GPC 3</text><text x="90" y="90" text-anchor="middle" class="gm-svgtxt" font-size="11">18 SMs</text></g>
  <rect x="24" y="232" width="772" height="40" rx="4" fill="#ddf4ff" stroke="#0969da"></rect><text x="410" y="250" text-anchor="middle" class="gm-svgtxt" font-size="12" font-weight="600">L2 cache — 50 MB, split in two partitions, connected by a crossbar to all GPCs and all memory controllers</text><text x="410" y="265" text-anchor="middle" class="gm-svgtxt" font-size="10">also hosts atomics, and (on Hopper) the distributed shared memory network between SMs in a cluster</text>
  <g transform="translate(24,284)"><use href="#gpc"></use><text x="90" y="20" text-anchor="middle" class="gm-svgtxt" font-size="11" font-weight="600">GPC 4</text><text x="90" y="90" text-anchor="middle" class="gm-svgtxt" font-size="11">18 SMs</text></g>
  <g transform="translate(220,284)"><use href="#gpc"></use><text x="90" y="20" text-anchor="middle" class="gm-svgtxt" font-size="11" font-weight="600">GPC 5</text><text x="90" y="90" text-anchor="middle" class="gm-svgtxt" font-size="11">18 SMs</text></g>
  <g transform="translate(416,284)"><use href="#gpc"></use><text x="90" y="20" text-anchor="middle" class="gm-svgtxt" font-size="11" font-weight="600">GPC 6</text><text x="90" y="90" text-anchor="middle" class="gm-svgtxt" font-size="11">18 SMs</text></g>
  <g transform="translate(612,284)"><use href="#gpc"></use><text x="90" y="20" text-anchor="middle" class="gm-svgtxt" font-size="11" font-weight="600">GPC 7</text><text x="90" y="90" text-anchor="middle" class="gm-svgtxt" font-size="11">18 SMs (144 on the full die; 132 enabled on H100 SXM)</text></g>
  <rect x="24" y="446" width="240" height="18" rx="3" fill="#ffebe9" stroke="#cf222e"></rect><text x="144" y="459" text-anchor="middle" class="gm-svgtxt" font-size="10">HBM3 controllers ×5 (left)</text>
  <rect x="290" y="446" width="240" height="18" rx="3" fill="#fff" stroke="#1f2328"></rect><text x="410" y="459" text-anchor="middle" class="gm-svgtxt" font-size="10">NVLink 4 ×18 links · copy engines ×7 · NVDEC/NVJPG</text>
  <rect x="556" y="446" width="240" height="18" rx="3" fill="#ffebe9" stroke="#cf222e"></rect><text x="676" y="459" text-anchor="middle" class="gm-svgtxt" font-size="10">HBM3 controllers ×5 (right)</text>
</svg>
<figcaption>Floor plan of an H100-class die. Compute is organized hierarchically — GPC → TPC → SM — so that yield can be managed by disabling faulty SMs. Everything talks to memory through the L2 and its crossbar.</figcaption>
</figure>
<dl class="gm-kv">
<dt>GPC (Graphics Processing Cluster)</dt><dd>The largest compute block: a group of TPCs with its own raster engine (unused for ML) and its own slice of the work distributor. H100 has 8; MIG partitions the chip along GPC boundaries, which is why MIG slices come in sizes like 1/7 of the GPU.</dd>
<dt>TPC (Texture Processing Cluster)</dt><dd>A pair of SMs sharing a texture unit and some front-end logic. Mostly a historical grouping from graphics; you rarely need to think about it.</dd>
<dt>SM (Streaming Multiprocessor)</dt><dd>The unit that actually executes your code. Detailed below.</dd>
<dt>GigaThread engine</dt><dd>The hardware work distributor. When a kernel is launched, it hands thread blocks to SMs that have free resources, round-robin across GPCs. It is why you never assign blocks to SMs yourself.</dd>
<dt>L2 cache</dt><dd>The last cache before HBM, shared by the whole chip. Also where atomic operations are resolved, and the place where data passes between SMs. 50 MB on H100, 40 MB on A100. A matmul tile that fits in L2 avoids HBM entirely.</dd>
<dt>Crossbar</dt><dd>The on-die network connecting every SM to every L2 slice and memory controller. Bandwidth ~2× HBM so it is rarely the bottleneck.</dd>
<dt>Memory controllers</dt><dd>One per HBM stack (or half-stack); they schedule DRAM reads/writes, handle ECC, and do address interleaving so consecutive addresses spread across all stacks (which is why coalesced, contiguous access matters).</dd>
<dt>Copy engines (DMA engines)</dt><dd>Small independent units that move data host↔device and device↔device without using any SM. Because they are separate, a well-written program overlaps the next batch's copy with the current batch's compute. H100 has 7.</dd>
<dt>NVLink ports</dt><dd>18 links × 50 GB/s = 900 GB/s bidirectional on H100. Carry NCCL traffic for tensor parallelism and all-reduce; also let one GPU read another's memory directly (peer-to-peer).</dd>
<dt>PCIe interface</dt><dd>The only path to the CPU, NIC and storage. Gen5 x16 = ~64 GB/s per direction — about 2% of HBM bandwidth, which is why keeping data on the GPU matters.</dd>
<dt>NVDEC / NVJPG / NVENC</dt><dd>Fixed-function video and JPEG decoders/encoders. Used by DALI to decode training images on-GPU instead of on the CPU — a direct fix for the data-starvation problem in Chapter 4.</dd>
<dt>RT cores</dt><dd>Ray-tracing units, present on consumer/workstation parts, absent on H100. Irrelevant for ML.</dd>
</dl>

## Inside one SM

<figure>
<svg viewBox="0 0 820 540" role="img" aria-label="Streaming multiprocessor internals">
  <rect x="10" y="10" width="800" height="520" rx="8" fill="#fbf9ff" stroke="#8250df" stroke-width="2"></rect>
  <text x="26" y="34" class="gm-svgtxt" font-size="14" font-weight="600">One SM (Hopper) — 4 processing partitions + shared resources</text>
  <rect x="26" y="46" width="768" height="30" rx="4" fill="#fff" stroke="#1f2328"></rect><text x="410" y="66" text-anchor="middle" class="gm-svgtxt" font-size="11">L1 instruction cache · block scheduler interface (receives thread blocks from GigaThread engine)</text>
  <g id="part"><rect width="184" height="290" rx="6" fill="#fff" stroke="#8250df"></rect></g>
  <g transform="translate(26,88)"><use href="#part"></use>
    <text x="92" y="18" text-anchor="middle" class="gm-svgtxt" font-size="11" font-weight="600">Partition 0</text>
    <rect x="10" y="28" width="164" height="30" rx="3" fill="#ddf4ff" stroke="#0969da"></rect><text x="92" y="42" text-anchor="middle" class="gm-svgtxt" font-size="9">Warp scheduler + dispatch</text><text x="92" y="53" text-anchor="middle" class="gm-svgtxt" font-size="9">picks 1 ready warp per cycle</text>
    <rect x="10" y="64" width="164" height="30" rx="3" fill="#fff8c5" stroke="#9a6700"></rect><text x="92" y="78" text-anchor="middle" class="gm-svgtxt" font-size="9">Register file 64 KB</text><text x="92" y="89" text-anchor="middle" class="gm-svgtxt" font-size="9">16K × 32-bit</text>
    <rect x="10" y="100" width="164" height="44" rx="3" fill="#fbefff" stroke="#8250df"></rect><text x="92" y="116" text-anchor="middle" class="gm-svgtxt" font-size="9">32 FP32 "CUDA cores"</text><text x="92" y="128" text-anchor="middle" class="gm-svgtxt" font-size="9">16 INT32 · 16 FP64</text><text x="92" y="139" text-anchor="middle" class="gm-svgtxt" font-size="9">(scalar ALUs)</text>
    <rect x="10" y="150" width="164" height="44" rx="3" fill="#fbefff" stroke="#8250df" stroke-width="2"></rect><text x="92" y="168" text-anchor="middle" class="gm-svgtxt" font-size="9" font-weight="600">1 Tensor core (4th gen)</text><text x="92" y="181" text-anchor="middle" class="gm-svgtxt" font-size="9">dense matmul FP16/BF16/</text><text x="92" y="191" text-anchor="middle" class="gm-svgtxt" font-size="9">TF32/FP8/INT8</text>
    <rect x="10" y="200" width="78" height="36" rx="3" fill="#fff" stroke="#656d76"></rect><text x="49" y="215" text-anchor="middle" class="gm-svgtxt" font-size="9">8 LD/ST</text><text x="49" y="227" text-anchor="middle" class="gm-svgtxt" font-size="9">units</text>
    <rect x="96" y="200" width="78" height="36" rx="3" fill="#fff" stroke="#656d76"></rect><text x="135" y="215" text-anchor="middle" class="gm-svgtxt" font-size="9">4 SFU</text><text x="135" y="227" text-anchor="middle" class="gm-svgtxt" font-size="9">exp, rsqrt, sin</text>
    <rect x="10" y="242" width="164" height="36" rx="3" fill="#fff" stroke="#656d76"></rect><text x="92" y="257" text-anchor="middle" class="gm-svgtxt" font-size="9">L0 instruction cache</text><text x="92" y="269" text-anchor="middle" class="gm-svgtxt" font-size="9">branch unit · predication</text>
  </g>
  <g transform="translate(222,88)"><use href="#part"></use><text x="92" y="18" text-anchor="middle" class="gm-svgtxt" font-size="11" font-weight="600">Partition 1</text><text x="92" y="150" text-anchor="middle" class="gm-svgtxt" font-size="10">same</text></g>
  <g transform="translate(418,88)"><use href="#part"></use><text x="92" y="18" text-anchor="middle" class="gm-svgtxt" font-size="11" font-weight="600">Partition 2</text><text x="92" y="150" text-anchor="middle" class="gm-svgtxt" font-size="10">same</text></g>
  <g transform="translate(614,88)"><use href="#part"></use><text x="92" y="18" text-anchor="middle" class="gm-svgtxt" font-size="11" font-weight="600">Partition 3</text><text x="92" y="150" text-anchor="middle" class="gm-svgtxt" font-size="10">same</text></g>
  <rect x="26" y="392" width="768" height="52" rx="4" fill="#fff8c5" stroke="#9a6700"></rect><text x="410" y="412" text-anchor="middle" class="gm-svgtxt" font-size="11" font-weight="600">Unified L1 data cache / shared memory — 256 KB, split at runtime (e.g. 228 KB shared + 28 KB L1)</text><text x="410" y="432" text-anchor="middle" class="gm-svgtxt" font-size="10">shared memory is explicitly managed by the kernel (the "scratchpad" FlashAttention tiles live in); L1 caches global loads automatically</text>
  <rect x="26" y="454" width="376" height="30" rx="4" fill="#fff" stroke="#1f2328"></rect><text x="214" y="473" text-anchor="middle" class="gm-svgtxt" font-size="10">Tensor Memory Accelerator (TMA) — async bulk copies HBM→shared, Hopper+</text>
  <rect x="418" y="454" width="376" height="30" rx="4" fill="#fff" stroke="#1f2328"></rect><text x="606" y="473" text-anchor="middle" class="gm-svgtxt" font-size="10">4 texture units · warp-level barrier hardware · 64 K registers total</text>
  <text x="410" y="510" text-anchor="middle" class="gm-svgtxt" font-size="11" fill="#656d76">Capacity: up to 64 resident warps (2048 threads), 32 thread blocks, 64 K 32-bit registers, 228 KB shared memory per SM. Exceed any one and fewer warps fit → lower occupancy.</text>
</svg>
<figcaption>The Streaming Multiprocessor. Each of the four partitions is an independent mini-processor with its own scheduler, registers and execution units; they share the L1/shared memory. "128 CUDA cores per SM" means 4 partitions × 32 FP32 lanes.</figcaption>
</figure>

### Every SM component, explained

<dl class="gm-kv">
<dt>Warp scheduler</dt><dd>Each cycle, looks at the warps assigned to its partition, finds one whose next instruction has its operands ready (not waiting on memory), and issues it. Because it can switch warps every cycle at zero cost, a memory stall in one warp is hidden by running another. This is the whole trick of GPU latency hiding.</dd>
<dt>Dispatch unit</dt><dd>Sends the issued instruction to the right execution unit: FP32 lane, tensor core, LD/ST, SFU.</dd>
<dt>Register file</dt><dd>The fastest storage on the chip: 64 KB per partition, 256 KB per SM. Every thread's local variables live here. A kernel that uses 128 registers per thread can only keep 512 threads resident (64K ÷ 128) instead of 2048 — "register pressure" directly lowers occupancy.</dd>
<dt>CUDA cores (FP32 / INT32 / FP64 units)</dt><dd>Scalar arithmetic lanes. "CUDA core" is marketing for one FP32 fused-multiply-add lane. They handle everything that is not a matmul: elementwise ops, softmax arithmetic, index math, normalization. 32 per partition means one warp's 32 threads execute an FP32 instruction in a single cycle.</dd>
<dt>Tensor core</dt><dd>A matrix-multiply-accumulate unit. In one instruction it computes D = A×B + C on small tiles (e.g. 16×8×16 for FP16) — hundreds of multiply-adds per cycle vs 32 for the scalar lanes. Linear layers, attention scores and convolutions all compile to tensor-core instructions (<code>mma</code>/<code>wgmma</code>). Supports FP16, BF16, TF32, FP8, INT8, and on Blackwell FP4. If your model runs in FP32 without TF32, the tensor cores sit idle.</dd>
<dt>LD/ST units</dt><dd>Load/store units that compute addresses and issue memory requests to L1/shared/L2. 32 threads' loads are "coalesced" into as few cache-line transactions as possible; scattered addresses waste bandwidth.</dd>
<dt>SFU (Special Function Unit)</dt><dd>Hardware for transcendental functions — exp, log, reciprocal, rsqrt, sin/cos — at reduced precision. Softmax and GELU/SiLU activations lean on these; only 4 per partition, so activation-heavy kernels can be SFU-bound.</dd>
<dt>L0 instruction cache</dt><dd>Per-partition cache of the instructions the resident warps are executing.</dd>
<dt>Shared memory</dt><dd>Programmer-controlled on-chip memory (up to 228 KB per SM) visible to all threads in a block. Used to stage tiles of matrices so each value loaded from HBM is reused many times. Organized in 32 banks; threads hitting the same bank serialize ("bank conflicts").</dd>
<dt>L1 data cache</dt><dd>Shares the same physical SRAM as shared memory; caches global memory reads automatically. The split between L1 and shared is chosen per kernel.</dd>
<dt>TMA (Tensor Memory Accelerator)</dt><dd>Hopper addition: a unit that copies multi-dimensional tiles from global to shared memory asynchronously with one instruction, freeing the threads from address arithmetic. FlashAttention-3 and modern GEMMs depend on it.</dd>
<dt>Texture units</dt><dd>Graphics-era units that do filtered, cached 2D/3D reads. Occasionally used for lookups in ML; mostly dormant.</dd>
<dt>Barrier / sync hardware</dt><dd>Implements <code>__syncthreads()</code> (all threads in a block wait) and warp-level shuffles that exchange registers between threads without memory.</dd>
</dl>

## Generational changes that matter for ML

<table>
<tbody><tr><th>Architecture</th><th>Datacenter part</th><th>Key ML additions</th></tr>
<tr><td>Volta (2017)</td><td>V100, 16/32 GB HBM2</td><td>First tensor cores (FP16); NVLink 2</td></tr>
<tr><td>Ampere (2020)</td><td>A100, 40/80 GB HBM2e</td><td>TF32 and BF16 tensor cores; sparsity; MIG; 40 MB L2; async copy to shared memory</td></tr>
<tr><td>Hopper (2022)</td><td>H100/H200, 80/141 GB HBM3/3e</td><td>FP8 tensor cores; Transformer Engine (auto FP8 scaling); TMA; thread-block clusters + distributed shared memory; NVLink 4 at 900 GB/s</td></tr>
<tr><td>Blackwell (2024–25)</td><td>B200/GB200, 192 GB HBM3e</td><td>Two dies in one package; FP4/FP6; 2nd-gen Transformer Engine; NVLink 5 at 1.8 TB/s; decompression engine</td></tr>
</tbody></table>
<p>The pattern: each generation adds a lower-precision tensor-core format (FP16 → TF32/BF16 → FP8 → FP4), more HBM, and faster NVLink. Compute per dollar grows fastest by using the newest low-precision format, which is why inference engines race to support each one.</p>
