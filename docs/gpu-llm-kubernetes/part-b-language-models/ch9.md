---
title: "How models are trained"
slug: /gpu-llm-kubernetes/ch9
sidebar_position: 3
sidebar_label: "12. How models are trained"
description: "Chapter 12 · Part B — Language models"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/ch9/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->
<p class="gm-lead">Training is the same forward pass as inference, plus a backward pass that computes how every weight should change to make the observed next token more likely, repeated over trillions of tokens on thousands of GPUs for months.</p>
<figure>
<div class="gm-flow">
  <div class="gm-box gm-t"><b>1. Pretraining</b><small>Predict the next token on web-scale text + code. 90%+ of compute. Produces a "base model" that completes text but doesn't follow instructions.</small></div><div class="gm-arrow"></div>
  <div class="gm-box gm-t"><b>2. Supervised fine-tuning</b><small>Train on curated (prompt → ideal response) pairs so it behaves as an assistant.</small></div><div class="gm-arrow"></div>
  <div class="gm-box gm-t"><b>3. Preference optimization</b><small>RLHF / DPO / Constitutional AI: learn from comparisons of responses, or from AI feedback guided by written principles.</small></div><div class="gm-arrow"></div>
  <div class="gm-box gm-t"><b>4. RL on tasks</b><small>Reinforcement learning with verifiable rewards (math, code tests, tool use) to build reasoning and agentic skill.</small></div><div class="gm-arrow"></div>
  <div class="gm-box gm-g"><b>5. Evaluate, red-team, ship</b><small>Benchmarks, safety evals, distillation into smaller variants.</small></div>
</div>
<figcaption>The modern training pipeline. Anthropic's published approach adds Constitutional AI at stage 3: the model critiques and revises its own outputs against a written set of principles, and a preference model trained on those AI-generated comparisons steers RL — reducing the amount of human labeling of harmful content.</figcaption>
</figure>

## One training step on one GPU

<ol>
<li><strong>Load a batch</strong> of token sequences (CPU → pinned memory → GPU).</li>
<li><strong>Forward pass</strong>: compute logits for every position; loss = cross-entropy against the actual next token.</li>
<li><strong>Backward pass</strong>: autograd computes gradients layer by layer, reverse order. Roughly 2× the forward cost.</li>
<li><strong>Gradient sync</strong>: all-reduce gradients across data-parallel GPUs (NCCL over NVLink / InfiniBand).</li>
<li><strong>Optimizer step</strong>: AdamW updates weights using gradient + two moment buffers (this is why training needs ~16 bytes per parameter vs 2 for inference).</li>
<li><strong>Log, occasionally checkpoint</strong> (a 70B model checkpoint with optimizer state is ~1 TB — hence NVMe, Chapter 20).</li>
</ol>

## Parallelism: fitting a model that doesn't fit

<table>
<tbody><tr><th>Strategy</th><th>What is split</th><th>Communication</th><th>When</th></tr>
<tr><td>Data parallel (DP / DDP)</td><td>Batch across GPUs; every GPU has full weights</td><td>All-reduce gradients each step</td><td>Model fits on one GPU</td></tr>
<tr><td>FSDP / ZeRO-3</td><td>Weights, grads, optimizer state sharded; gathered just-in-time per layer</td><td>All-gather + reduce-scatter per layer</td><td>Default for 7B–70B training</td></tr>
<tr><td>Tensor parallel (TP)</td><td>Each matmul split across GPUs within a node</td><td>All-reduce after every layer — needs NVLink</td><td>Very large layers; also used in inference</td></tr>
<tr><td>Pipeline parallel (PP)</td><td>Layers 0–19 on GPU A, 20–39 on GPU B …</td><td>Point-to-point activations between stages</td><td>Across nodes; introduces "bubbles"</td></tr>
<tr><td>Expert parallel (EP)</td><td>MoE experts spread across GPUs</td><td>All-to-all routing tokens to experts</td><td>MoE models</td></tr>
</tbody></table>
<p>Frontier training runs combine all of these ("3D/4D parallelism") across tens of thousands of GPUs. The job is only as fast as its slowest GPU, so a single throttling or NUMA-misplaced worker slows the entire cluster — which is why Part D obsesses over placement.</p>

## Memory budget for training (per parameter, mixed precision)

<dl class="gm-kv">
<dt>2 B</dt><dd>BF16 weights</dd>
<dt>2 B</dt><dd>BF16 gradients</dd>
<dt>4 B</dt><dd>FP32 master weights</dd>
<dt>8 B</dt><dd>Adam first + second moments (FP32)</dd>
<dt>≈16 B</dt><dd>Total per parameter, before activations. 70B × 16 B = 1.1 TB → must be sharded across ≥14 80-GB GPUs before any activations. Activation checkpointing trades recompute for memory.</dd>
</dl>
