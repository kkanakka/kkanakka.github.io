---
title: "Glossary"
slug: /gpu-llm-kubernetes/glossary
sidebar_position: 1
sidebar_label: "Glossary"
description: "Appendix A"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/glossary/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->
<dl class="gm-kv">
<dt>all-reduce</dt><dd>Collective operation that sums a tensor across all GPUs and gives every GPU the result. The core of data-parallel training.</dd>
<dt>arithmetic intensity</dt><dd>FLOPs per byte of memory traffic; decides whether a kernel is compute- or bandwidth-bound.</dd>
<dt>artifact</dt><dd>A standalone piece of content (document, code, interactive HTML) a chat product renders outside the message stream.</dd>
<dt>BPE</dt><dd>Byte-pair encoding: the subword tokenization algorithm most LLMs use.</dd>
<dt>cgroup</dt><dd>Linux kernel mechanism Kubernetes uses to enforce CPU/memory limits; v2 is the modern unified hierarchy.</dd>
<dt>CFS quota</dt><dd>Completely Fair Scheduler bandwidth control; how CPU <em>limits</em> are enforced (throttling), as opposed to cpusets (pinning).</dd>
<dt>Constitutional AI</dt><dd>Anthropic's training method where the model critiques/revises outputs against written principles and AI feedback replaces most human labels.</dd>
<dt>context window</dt><dd>Maximum tokens (prompt + generation) a model can attend over in one request.</dd>
<dt>continuous batching</dt><dd>Scheduling new inference requests into a running batch at every decode step.</dd>
<dt>CUDA graph</dt><dd>Recorded sequence of GPU operations replayed with one launch to eliminate per-kernel CPU overhead.</dd>
<dt>DCGM</dt><dd>NVIDIA Data Center GPU Manager; source of GPU metrics and diagnostics.</dd>
<dt>decode</dt><dd>The token-by-token generation phase of inference; bandwidth-bound.</dd>
<dt>DP / TP / PP / EP</dt><dd>Data, tensor, pipeline, expert parallelism.</dd>
<dt>embedding</dt><dd>Dense vector representing a token (inside the model) or a text chunk (for retrieval).</dd>
<dt>FlashAttention</dt><dd>Attention kernel that tiles computation in SM shared memory to avoid materializing the n×n score matrix.</dd>
<dt>FSDP / ZeRO</dt><dd>Sharding of weights, gradients and optimizer state across data-parallel GPUs.</dd>
<dt>GQA</dt><dd>Grouped-query attention: several query heads share a K/V head; shrinks the KV cache.</dd>
<dt>Guaranteed QoS</dt><dd>Kubernetes pod class where requests == limits; prerequisite for CPU pinning.</dd>
<dt>HBM</dt><dd>High-bandwidth memory stacked next to the GPU die.</dd>
<dt>ITL / TPOT</dt><dd>Inter-token latency / time per output token.</dd>
<dt>KV cache</dt><dd>Stored keys and values for every processed token so decode doesn't recompute them.</dd>
<dt>logits</dt><dd>Raw per-token scores before softmax.</dd>
<dt>MCP</dt><dd>Model Context Protocol: open standard for connecting AI apps to tools and data.</dd>
<dt>MIG</dt><dd>Multi-Instance GPU hardware partitioning.</dd>
<dt>MoE</dt><dd>Mixture of Experts: a router activates a subset of feed-forward experts per token.</dd>
<dt>NCCL</dt><dd>NVIDIA Collective Communications Library; implements all-reduce etc. over NVLink/IB.</dd>
<dt>NUMA</dt><dd>Non-uniform memory access: memory and PCIe devices are local to one CPU socket.</dd>
<dt>PagedAttention</dt><dd>Block-allocated KV cache (vLLM) eliminating fragmentation.</dd>
<dt>prefill</dt><dd>The prompt-processing phase of inference; compute-bound.</dd>
<dt>prefix cache</dt><dd>Reuse of KV cache across requests sharing an identical token prefix.</dd>
<dt>RAG</dt><dd>Retrieval-augmented generation.</dd>
<dt>RDMA</dt><dd>Remote direct memory access; NIC writes straight into (GPU) memory without CPU involvement.</dd>
<dt>RLHF / RLAIF</dt><dd>Reinforcement learning from human / AI feedback.</dd>
<dt>RoPE</dt><dd>Rotary position embedding; how modern transformers encode token positions.</dd>
<dt>SM</dt><dd>Streaming multiprocessor; the GPU's unit of parallel execution.</dd>
<dt>speculative decoding</dt><dd>Draft-then-verify technique that emits several tokens per big-model pass.</dd>
<dt>SSE</dt><dd>Server-Sent Events; the streaming protocol chat APIs use.</dd>
<dt>Topology Manager</dt><dd>Kubelet component aligning CPU, memory and device allocation to NUMA nodes.</dd>
<dt>TTFT</dt><dd>Time to first token.</dd>
<dt>warp</dt><dd>32 GPU threads executing in lockstep.</dd>
<dt>Xid</dt><dd>NVIDIA driver error code logged to dmesg.</dd>
</dl>
