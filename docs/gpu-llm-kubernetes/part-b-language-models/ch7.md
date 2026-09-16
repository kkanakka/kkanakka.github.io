---
title: "How tokens work"
slug: /gpu-llm-kubernetes/ch7
sidebar_position: 1
sidebar_label: "10. How tokens work"
description: "Chapter 10 · Part B — Language models"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/ch7/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->
<p class="gm-lead">A language model never sees letters or words. It sees integers. A tokenizer turns text into a sequence of integers from a fixed vocabulary, and everything downstream — cost, context limits, speed — is measured in those integers.</p>
<figure>
<svg viewBox="0 0 820 300" role="img" aria-label="Tokenization pipeline">
  <rect x="20" y="20" width="780" height="60" rx="8" fill="#fff" stroke="#1f2328"></rect>
  <text x="36" y="45" class="gm-svgtxt" font-size="12" font-weight="600">Text</text>
  <text x="36" y="66" class="gm-svgtxt" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13">"Kubernetes schedules GPU pods."</text>
  <text x="410" y="105" class="gm-svgtxt" font-size="18" text-anchor="middle">↓ byte-pair encoding (BPE) merges</text>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">
    <rect x="20" y="120" width="90" height="36" rx="6" fill="#ddf4ff" stroke="#0969da"></rect><text x="65" y="143" text-anchor="middle" class="gm-svgtxt">K</text>
    <rect x="118" y="120" width="110" height="36" rx="6" fill="#ddf4ff" stroke="#0969da"></rect><text x="173" y="143" text-anchor="middle" class="gm-svgtxt">ubernetes</text>
    <rect x="236" y="120" width="120" height="36" rx="6" fill="#ddf4ff" stroke="#0969da"></rect><text x="296" y="143" text-anchor="middle" class="gm-svgtxt">␣schedules</text>
    <rect x="364" y="120" width="80" height="36" rx="6" fill="#ddf4ff" stroke="#0969da"></rect><text x="404" y="143" text-anchor="middle" class="gm-svgtxt">␣GPU</text>
    <rect x="452" y="120" width="90" height="36" rx="6" fill="#ddf4ff" stroke="#0969da"></rect><text x="497" y="143" text-anchor="middle" class="gm-svgtxt">␣pods</text>
    <rect x="550" y="120" width="50" height="36" rx="6" fill="#ddf4ff" stroke="#0969da"></rect><text x="575" y="143" text-anchor="middle" class="gm-svgtxt">.</text>
  </g>
  <text x="410" y="185" class="gm-svgtxt" font-size="18" text-anchor="middle">↓ vocabulary lookup</text>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">
    <rect x="20" y="200" width="90" height="36" rx="6" fill="#fbefff" stroke="#8250df"></rect><text x="65" y="223" text-anchor="middle" class="gm-svgtxt">42</text>
    <rect x="118" y="200" width="110" height="36" rx="6" fill="#fbefff" stroke="#8250df"></rect><text x="173" y="223" text-anchor="middle" class="gm-svgtxt">18211</text>
    <rect x="236" y="200" width="120" height="36" rx="6" fill="#fbefff" stroke="#8250df"></rect><text x="296" y="223" text-anchor="middle" class="gm-svgtxt">7770</text>
    <rect x="364" y="200" width="80" height="36" rx="6" fill="#fbefff" stroke="#8250df"></rect><text x="404" y="223" text-anchor="middle" class="gm-svgtxt">10516</text>
    <rect x="452" y="200" width="90" height="36" rx="6" fill="#fbefff" stroke="#8250df"></rect><text x="497" y="223" text-anchor="middle" class="gm-svgtxt">36044</text>
    <rect x="550" y="200" width="50" height="36" rx="6" fill="#fbefff" stroke="#8250df"></rect><text x="575" y="223" text-anchor="middle" class="gm-svgtxt">13</text>
  </g>
  <text x="410" y="265" class="gm-svgtxt" font-size="18" text-anchor="middle">↓ embedding table: each ID → a vector of d_model floats (e.g. 8192)</text>
  <text x="410" y="290" class="gm-svgtxt" font-size="12" text-anchor="middle" fill="#656d76">Token IDs shown are illustrative; every model family has its own vocabulary.</text>
</svg>
<figcaption>Text → subword pieces → integer IDs → embedding vectors. Note the leading space is part of the token ("␣GPU" ≠ "GPU"), and rare words split into several pieces. Roughly 1 token ≈ 4 English characters ≈ ¾ of a word; code and non-English text cost more tokens per character.</figcaption>
</figure>

## Byte-pair encoding, step by step

<ol>
<li>Start with a base vocabulary of all 256 byte values (so any input, in any language or binary, is representable).</li>
<li>On a large training corpus, count every adjacent pair of symbols. Merge the most frequent pair into a new symbol and add it to the vocabulary.</li>
<li>Repeat until the vocabulary reaches the target size (32k–200k+). Frequent words become single tokens; rare words stay as several pieces.</li>
<li>At runtime, apply the same merges in the same order to new text (usually after a regex "pre-tokenizer" splits on spaces and punctuation).</li>
</ol>
<div class="gm-grid3">
<div class="gm-card"><b>Why you can't count letters</b>The model sees "strawberry" as maybe 2–3 tokens, not 10 letters. Character-level questions are hard because the characters were never visible.</div>
<div class="gm-card"><b>Why cost is in tokens</b>Compute per forward pass scales with sequence length in tokens. API pricing, context windows, rate limits all count tokens, not characters.</div>
<div class="gm-card"><b>Special tokens</b>Reserved IDs mark structure: begin/end of text, message role boundaries, tool-call delimiters. The chat template inserts these around your messages.</div>
</div>

## Chat templates: what the model actually receives

<p>When you send a conversation to an API, the server flattens it into one token sequence with role markers. The system prompt, every prior turn, tool definitions and tool results are all just tokens in that sequence:</p>
<pre><code>&lt;|system|&gt; You are a helpful assistant. &lt;|end|&gt;
&lt;|user|&gt; How do I pin CPUs in Kubernetes? &lt;|end|&gt;
&lt;|assistant|&gt; Use the static CPU Manager policy with Guaranteed QoS … &lt;|end|&gt;
&lt;|user|&gt; And NUMA? &lt;|end|&gt;
&lt;|assistant|&gt;  ← model generates from here</code></pre>
<p>This is why "memory" in a chat is an illusion: the model is stateless. The conversation is re-sent every turn (Chapter 14 covers how that's stored and cached).</p>

## Counting: context windows and cost

<table>
<tbody><tr><th>Content</th><th>Approximate tokens</th></tr>
<tr><td>One English word</td><td>1.3</td></tr>
<tr><td>One page of prose (500 words)</td><td>650–700</td></tr>
<tr><td>Your Kubernetes GPU guide PDF (~7,000 words + YAML)</td><td>~12,000</td></tr>
<tr><td>A 200-page book</td><td>~130,000</td></tr>
<tr><td>1,000 lines of Python</td><td>~10,000–15,000</td></tr>
<tr><td>One 1024×1024 image (vision models)</td><td>~1,000–1,600</td></tr>
</tbody></table>
