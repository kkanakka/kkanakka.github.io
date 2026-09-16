---
title: "How an LLM works"
slug: /gpu-llm-kubernetes/ch8
sidebar_position: 2
sidebar_label: "11. How an LLM works"
description: "Chapter 11 · Part B — Language models"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/ch8/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->
<p class="gm-lead">An LLM is a function: given a sequence of tokens, output a probability for every token in the vocabulary being next. Generation is calling that function repeatedly, appending one sampled token at a time. The function is a transformer — a stack of identical blocks whose only job is to let every token look at every earlier token.</p>
<figure>
<svg viewBox="0 0 820 520" role="img" aria-label="Transformer decoder architecture">
  <defs><marker id="ah" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#1f2328"></path></marker></defs>
  <!-- left: overall -->
  <rect x="20" y="20" width="280" height="480" rx="10" fill="#fff" stroke="#1f2328"></rect>
  <text x="36" y="46" class="gm-svgtxt" font-weight="600" font-size="14">Whole model</text>
  <rect x="40" y="60" width="240" height="40" rx="6" fill="#ddf4ff" stroke="#0969da"></rect><text x="160" y="85" text-anchor="middle" class="gm-svgtxt" font-size="12">Token IDs [t₁ … tₙ]</text>
  <line x1="160" y1="100" x2="160" y2="118" stroke="#1f2328" marker-end="url(#ah)"></line>
  <rect x="40" y="120" width="240" height="40" rx="6" fill="#ddf4ff" stroke="#0969da"></rect><text x="160" y="145" text-anchor="middle" class="gm-svgtxt" font-size="12">Embedding + positional info (RoPE)</text>
  <line x1="160" y1="160" x2="160" y2="178" stroke="#1f2328" marker-end="url(#ah)"></line>
  <rect x="40" y="180" width="240" height="180" rx="6" fill="#fbefff" stroke="#8250df" stroke-width="2"></rect>
  <text x="160" y="205" text-anchor="middle" class="gm-svgtxt" font-size="12" font-weight="600">Transformer block × L</text>
  <text x="160" y="225" text-anchor="middle" class="gm-svgtxt" font-size="11">(L = 32 … 120+ layers)</text>
  <rect x="60" y="240" width="200" height="40" rx="6" fill="#fff" stroke="#8250df"></rect><text x="160" y="265" text-anchor="middle" class="gm-svgtxt" font-size="12">Self-attention</text>
  <rect x="60" y="300" width="200" height="40" rx="6" fill="#fff" stroke="#8250df"></rect><text x="160" y="325" text-anchor="middle" class="gm-svgtxt" font-size="12">Feed-forward (MLP) / MoE</text>
  <line x1="160" y1="360" x2="160" y2="378" stroke="#1f2328" marker-end="url(#ah)"></line>
  <rect x="40" y="380" width="240" height="40" rx="6" fill="#ddf4ff" stroke="#0969da"></rect><text x="160" y="405" text-anchor="middle" class="gm-svgtxt" font-size="12">Final norm → LM head (d_model → vocab)</text>
  <line x1="160" y1="420" x2="160" y2="438" stroke="#1f2328" marker-end="url(#ah)"></line>
  <rect x="40" y="440" width="240" height="40" rx="6" fill="#fff8c5" stroke="#9a6700"></rect><text x="160" y="465" text-anchor="middle" class="gm-svgtxt" font-size="12">Logits → softmax → sample next token</text>
  <!-- right: inside a block -->
  <rect x="330" y="20" width="470" height="480" rx="10" fill="#fbf9ff" stroke="#8250df"></rect>
  <text x="346" y="46" class="gm-svgtxt" font-weight="600" font-size="14">Inside one block (pre-norm)</text>
  <rect x="350" y="60" width="430" height="34" rx="6" fill="#fff" stroke="#1f2328"></rect><text x="565" y="82" text-anchor="middle" class="gm-svgtxt" font-size="12">x  (n tokens × d_model)</text>
  <rect x="350" y="106" width="430" height="34" rx="6" fill="#fff" stroke="#1f2328"></rect><text x="565" y="128" text-anchor="middle" class="gm-svgtxt" font-size="12">RMSNorm(x)</text>
  <rect x="350" y="152" width="430" height="150" rx="6" fill="#fff" stroke="#8250df" stroke-width="2"></rect>
  <text x="365" y="174" class="gm-svgtxt" font-size="12" font-weight="600">Multi-head self-attention</text>
  <text x="365" y="194" class="gm-svgtxt" font-size="11">Q = xW_q   K = xW_k   V = xW_v   (K and V are cached — see Ch. 10)</text>
  <text x="365" y="214" class="gm-svgtxt" font-size="11">scores = softmax( Q·Kᵀ / √d_head + causal mask )   — each token only sees earlier tokens</text>
  <text x="365" y="234" class="gm-svgtxt" font-size="11">out = scores · V, then concat heads, then W_o</text>
  <text x="365" y="258" class="gm-svgtxt" font-size="11" fill="#656d76">Cost: O(n²) in sequence length for the scores. FlashAttention computes this tile-by-tile in</text>
  <text x="365" y="274" class="gm-svgtxt" font-size="11" fill="#656d76">SM shared memory so the n×n matrix is never written to HBM.</text>
  <text x="365" y="292" class="gm-svgtxt" font-size="11" fill="#656d76">GQA / MQA: several query heads share one K/V head → smaller KV cache.</text>
  <rect x="350" y="314" width="430" height="34" rx="6" fill="#fff" stroke="#1f2328"></rect><text x="565" y="336" text-anchor="middle" class="gm-svgtxt" font-size="12">x = x + attention_out     (residual connection)</text>
  <rect x="350" y="360" width="430" height="34" rx="6" fill="#fff" stroke="#1f2328"></rect><text x="565" y="382" text-anchor="middle" class="gm-svgtxt" font-size="12">RMSNorm(x)</text>
  <rect x="350" y="406" width="430" height="54" rx="6" fill="#fff" stroke="#8250df" stroke-width="2"></rect>
  <text x="365" y="428" class="gm-svgtxt" font-size="12" font-weight="600">Feed-forward: W₂ · SiLU(W₁x) ⊙ (W₃x)</text>
  <text x="365" y="448" class="gm-svgtxt" font-size="11">Holds most parameters. In Mixture-of-Experts models, a router picks 1–2 of many FFNs per token.</text>
  <rect x="350" y="472" width="430" height="22" rx="6" fill="#fff" stroke="#1f2328"></rect><text x="565" y="488" text-anchor="middle" class="gm-svgtxt" font-size="12">x = x + ffn_out</text>
</svg>
<figcaption>A decoder-only transformer. The left column is the full model; the right column zooms into one of its L identical blocks. Attention is where tokens exchange information; the feed-forward network is where most "knowledge" is stored. Everything is matrix multiplication, which is why GPUs fit.</figcaption>
</figure>

## Attention in one paragraph

<p>Each token produces a <em>query</em> ("what am I looking for?"), a <em>key</em> ("what do I contain?") and a <em>value</em> ("what do I contribute?"). The dot product of a token's query with every earlier token's key gives a relevance score; softmax turns scores into weights; the output is the weighted sum of values. Multiple "heads" do this in parallel with different learned projections so one head can track syntax while another tracks names. The causal mask stops tokens from seeing the future, which is what makes the model usable for left-to-right generation.</p>

## Where the parameters live

<table>
<tbody><tr><th>Component</th><th>Shape</th><th>Share of a ~70B dense model</th></tr>
<tr><td>Embedding table</td><td>vocab × d_model (e.g. 128k × 8192)</td><td>~1.5%</td></tr>
<tr><td>Attention projections (per layer)</td><td>4 × d_model × d_model (fewer with GQA)</td><td>~25%</td></tr>
<tr><td>Feed-forward (per layer)</td><td>3 × d_model × d_ff (d_ff ≈ 3.5 × d_model)</td><td>~72%</td></tr>
<tr><td>Norms, biases</td><td>tiny</td><td>&lt;0.1%</td></tr>
</tbody></table>

## Sampling: turning probabilities into a token

<dl class="gm-kv">
<dt>temperature</dt><dd>Divides logits before softmax. 0 → always pick the top token (greedy, deterministic-ish). 1 → sample from the model's own distribution. &gt;1 → flatter, more random.</dd>
<dt>top-p (nucleus)</dt><dd>Keep the smallest set of tokens whose cumulative probability ≥ p, sample among them. Cuts off the long tail of nonsense.</dd>
<dt>top-k</dt><dd>Keep only the k most likely tokens.</dd>
<dt>stop sequences</dt><dd>Strings that end generation, e.g. the end-of-turn special token, or a user-defined string.</dd>
<dt>logit bias</dt><dd>Add a constant to specific token logits to force or forbid them. Used for constrained/JSON output alongside grammar-based decoding.</dd>
</dl>

## Scaling laws and why models are the size they are

<p>Loss falls smoothly and predictably as a power law in parameters, data and compute. The "Chinchilla" result (2022) showed the compute-optimal recipe is roughly 20 tokens of training data per parameter — so a 70B model wants ~1.4T tokens. Modern models are trained far past that (10T–20T+ tokens) because inference cost dominates over their lifetime, and a smaller model trained longer is cheaper to serve. Mixture-of-Experts decouples parameter count from per-token compute: a model can hold 400B+ parameters while only activating ~40B per token.</p>
