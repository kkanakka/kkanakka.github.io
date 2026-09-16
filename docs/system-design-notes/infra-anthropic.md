---
title: "Infra problems reported at Anthropic: overview"
slug: /system-design-notes/infra-anthropic
sidebar_position: 11
sidebar_label: "Infra problems reported at Anthropic: ov…"
description: "10 problems · each has its own page below · shared patterns"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/infra-anthropic/sequence.svg" alt="How it works — infra-anthropic" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
<header>
  
  <span class="tag">10 problems · each has its own page below · shared patterns</span>
</header>
<p>Infrastructure‑flavored problems: the "what" is usually one component, and the score comes from naming the right mechanisms and their failure modes. Each of the ten sections that follow is written in the same shape as the product problems: requirements, entities and API, design, step‑by‑step flow, deep dives, checklist, and level expectations.</p>

## What all ten have in common {#ia-common}

<ul class="checklist">
  <li>Name the failure unit (chunk, cell, item, shard, znode) and make it independently verifiable or recoverable</li>
  <li>Atomic claim + lease + reaper wherever work is handed out</li>
  <li>Immutable versions + a single mutable pointer for anything you roll out</li>
  <li>Capacity headroom is a design input because GPUs don't autoscale</li>
  <li>Fail closed on safety, fail to last‑known‑good on config, never fail open to unlimited on limits</li>
  <li>Alerting and safety checks live in their own failure domain and prove themselves with synthetic traffic</li>
  <li>Do the arithmetic: bytes × nodes, points × bytes, MTBF ÷ nodes, quota ÷ gateways</li>
</ul>
