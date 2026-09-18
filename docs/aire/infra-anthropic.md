---
title: "Infra problems reported at Anthropic: overview"
slug: /aire/infra-anthropic
sidebar_position: 31
sidebar_label: "Infra problems reported at Anthropic: ov…"
description: "10 problems · each has its own page below · shared patterns"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/infra-anthropic/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">10 problems · each has its own page below · shared patterns</span>
</header>
<p>Infrastructure‑flavored problems: the "what" is usually one component, and the score comes from naming the right mechanisms and their failure modes. Each of the ten sections that follow is written in the same shape as the product problems: requirements, entities and API, design, step‑by‑step flow, deep dives, checklist, and level expectations.</p>

## What all ten have in common {#ia-common}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/infra-anthropic/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/infra-anthropic/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<ul class="checklist">
  <li>Name the failure unit (chunk, cell, item, shard, znode) and make it independently verifiable or recoverable</li>
  <li>Atomic claim + lease + reaper wherever work is handed out</li>
  <li>Immutable versions + a single mutable pointer for anything you roll out</li>
  <li>Capacity headroom is a design input because GPUs don't autoscale</li>
  <li>Fail closed on safety, fail to last‑known‑good on config, never fail open to unlimited on limits</li>
  <li>Alerting and safety checks live in their own failure domain and prove themselves with synthetic traffic</li>
  <li>Do the arithmetic: bytes × nodes, points × bytes, MTBF ÷ nodes, quota ÷ gateways</li>
</ul>
