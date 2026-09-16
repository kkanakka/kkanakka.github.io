---
title: "Memory hierarchy, PCIe, NVLink and NUMA"
slug: /gpu-llm-kubernetes/ch5
sidebar_position: 5
sidebar_label: "8. Memory hierarchy, PCIe, NVLink and N…"
description: "Chapter 8 · Part A — Silicon"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/ch5/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->
<p class="gm-lead">Data has to travel several hops to reach a tensor core. Each hop is an order of magnitude slower than the one after it, and where the GPU is physically plugged in decides which CPU cores and memory it can reach quickly.</p>
<figure>
<div class="gm-stack-d">
  <div class="gm-layer" style="border-color:#8250df;background:#fbefff"><b>Registers (per SM)</b><span>~20+ TB/s aggregate · latency ~1 cycle · 256 KB per SM</span></div>
  <div class="gm-layer" style="border-color:#8250df;background:#f3e8ff"><b>Shared memory / L1</b><span>~15 TB/s · ~30 cycles · 228 KB per SM, programmer-managed</span></div>
  <div class="gm-layer" style="border-color:#0969da;background:#ddf4ff"><b>L2 cache</b><span>~5–7 TB/s · ~200 cycles · 50 MB (H100)</span></div>
  <div class="gm-layer" style="border-color:#9a6700;background:#fff8c5"><b>HBM (device memory)</b><span>3.35 TB/s · ~500+ cycles · 80 GB (H100) — <em>this bounds LLM decode</em></span></div>
  <div class="gm-layer"><b>NVLink to peer GPUs</b><span>900 GB/s bidirectional (H100 NVSwitch) · used for tensor/pipeline parallel</span></div>
  <div class="gm-layer"><b>PCIe Gen5 x16 to host</b><span>~64 GB/s per direction · ~1–2 µs latency · shared with NICs on the same switch</span></div>
  <div class="gm-layer"><b>Host DRAM (local NUMA node)</b><span>~200–400 GB/s per socket · remote NUMA node adds ~30–50% latency</span></div>
  <div class="gm-layer"><b>InfiniBand / RoCE to other nodes</b><span>400 Gb/s (50 GB/s) per NIC · GPUDirect RDMA skips host memory entirely</span></div>
  <div class="gm-layer"><b>NVMe local storage</b><span>~7 GB/s per drive · RAID0 ×4 ≈ 25 GB/s · 50–100 µs latency</span></div>
  <div class="gm-layer"><b>Network / object storage (S3, GCS)</b><span>Tens of MB/s to GB/s · ms latency · needs caching in front</span></div>
</div>
<figcaption>The memory and interconnect hierarchy, fastest to slowest. Each row is roughly 3–10× slower than the one above. Every optimization in this manual is about keeping data as high on this ladder as possible for as long as possible.</figcaption>
</figure>

## NUMA and GPU affinity

<p>A two-socket server has two NUMA nodes. Each socket has its own memory controller and its own PCIe lanes. A GPU on socket 0's PCIe root complex can reach socket 0's DRAM directly; reaching socket 1's DRAM crosses the inter-socket link (UPI/Infinity Fabric), which is slower and shared.</p>
<figure>
<svg viewBox="0 0 820 260" role="img" aria-label="NUMA topology">
  <rect x="20" y="20" width="370" height="220" rx="10" fill="#fff" stroke="#1f2328"></rect>
  <text x="36" y="46" class="gm-svgtxt" font-weight="600" font-size="14">NUMA node 0 — CPUs 0–31</text>
  <rect x="36" y="60" width="160" height="50" rx="6" fill="#ddf4ff" stroke="#0969da"></rect><text x="50" y="80" class="gm-svgtxt" font-size="12">Socket 0</text><text x="50" y="98" class="gm-svgtxt" font-size="11">32 cores, 512 GB DRAM</text>
  <rect x="36" y="130" width="72" height="40" rx="6" fill="#fbefff" stroke="#8250df"></rect><text x="52" y="155" class="gm-svgtxt" font-size="12">GPU0</text>
  <rect x="120" y="130" width="72" height="40" rx="6" fill="#fbefff" stroke="#8250df"></rect><text x="136" y="155" class="gm-svgtxt" font-size="12">GPU1</text>
  <rect x="204" y="130" width="72" height="40" rx="6" fill="#fbefff" stroke="#8250df"></rect><text x="220" y="155" class="gm-svgtxt" font-size="12">GPU2</text>
  <rect x="288" y="130" width="72" height="40" rx="6" fill="#fbefff" stroke="#8250df"></rect><text x="304" y="155" class="gm-svgtxt" font-size="12">GPU3</text>
  <rect x="36" y="190" width="120" height="34" rx="6" fill="#fff8c5" stroke="#9a6700"></rect><text x="48" y="212" class="gm-svgtxt" font-size="11">NIC mlx5_0 (IB)</text>
  <line x1="116" y1="110" x2="116" y2="130" stroke="#1f2328"></line><line x1="116" y1="120" x2="324" y2="120" stroke="#1f2328"></line><line x1="324" y1="120" x2="324" y2="130" stroke="#1f2328"></line>
  <text x="200" y="230" class="gm-svgtxt" font-size="11" fill="#656d76">local: fast path</text>
  <rect x="430" y="20" width="370" height="220" rx="10" fill="#fff" stroke="#1f2328"></rect>
  <text x="446" y="46" class="gm-svgtxt" font-weight="600" font-size="14">NUMA node 1 — CPUs 32–63</text>
  <rect x="446" y="60" width="160" height="50" rx="6" fill="#ddf4ff" stroke="#0969da"></rect><text x="460" y="80" class="gm-svgtxt" font-size="12">Socket 1</text><text x="460" y="98" class="gm-svgtxt" font-size="11">32 cores, 512 GB DRAM</text>
  <rect x="446" y="130" width="72" height="40" rx="6" fill="#fbefff" stroke="#8250df"></rect><text x="462" y="155" class="gm-svgtxt" font-size="12">GPU4</text>
  <rect x="530" y="130" width="72" height="40" rx="6" fill="#fbefff" stroke="#8250df"></rect><text x="546" y="155" class="gm-svgtxt" font-size="12">GPU5</text>
  <rect x="614" y="130" width="72" height="40" rx="6" fill="#fbefff" stroke="#8250df"></rect><text x="630" y="155" class="gm-svgtxt" font-size="12">GPU6</text>
  <rect x="698" y="130" width="72" height="40" rx="6" fill="#fbefff" stroke="#8250df"></rect><text x="714" y="155" class="gm-svgtxt" font-size="12">GPU7</text>
  <rect x="446" y="190" width="120" height="34" rx="6" fill="#fff8c5" stroke="#9a6700"></rect><text x="458" y="212" class="gm-svgtxt" font-size="11">NIC mlx5_1 (IB)</text>
  <path d="M390 85 L430 85" stroke="#cf222e" stroke-width="5"></path><text x="410" y="75" class="gm-svgtxt" font-size="10" text-anchor="middle" fill="#cf222e">UPI</text>
  <text x="410" y="105" class="gm-svgtxt" font-size="10" text-anchor="middle" fill="#cf222e">slow, shared</text>
</svg>
<figcaption>A typical 8-GPU node. A process pinned to CPUs 40–47 feeding GPU1 crosses the UPI link for every byte. <code>nvidia-smi topo -m</code> prints exactly this map; the Kubernetes Topology Manager (Chapter 19) uses the same information to place pods.</figcaption>
</figure>
<pre><code><span class="gm-c"># Discover the topology on a node</span>
lscpu | grep NUMA
numactl --hardware
nvidia-smi topo -m
<span class="gm-c"># Example output (abridged)</span>
<span class="gm-c">#        GPU0  GPU1  GPU2  GPU3  NIC0  CPU Affinity  NUMA Affinity</span>
<span class="gm-c"># GPU0    X    NV12  NV12  NV12  NODE  0-31          0</span>
<span class="gm-c"># GPU4   SYS   SYS   SYS   SYS   SYS   32-63         1</span>
<span class="gm-c"># NV12 = 12 NVLink lanes · NODE = same NUMA node via PCIe · SYS = crosses UPI</span></code></pre>
