---
title: "Numbers to say out loud — the one-pager"
slug: /aire/numbers
sidebar_position: 3
sidebar_label: "Numbers — the one-pager"
description: "reference · availability · error budgets · latency · bytes · capacity arithmetic you can do in your head"
---

## How to use this page

<header>
  
  <span class="tag">reference · availability · error budgets · latency · bytes · capacity arithmetic you can do in your head</span>
</header>

<p>Every table here is computed, not remembered. The point is not to recite them — it is to be able to <b>do the arithmetic out loud</b>, because the derivation is what gets scored. "500 GB × 5,000 nodes is 2.5 PB; at 10 Gb/s that's 23 days, so peers must serve peers" beats naming a technology every time.</p>

<div class="note"><b>The three you will actually use:</b> <b>86,400 seconds in a day</b> (so 1M/day ≈ 12/s) · <b>1 Gb/s = 125 MB/s</b> · <b>wait time grows as 1/(1−ρ)</b>, which is why you run at 70% and not 95%.</div>

## Availability — nines to downtime {#nb-nines}

<table>
  <tbody><tr><th>Target</th><th>Per year</th><th>Per month</th><th>Per week</th><th>Per day</th></tr>
  <tr><td>99%</td><td>3.65 days</td><td>7.2 hours</td><td>1.68 hours</td><td>14.4 min</td></tr>
  <tr><td>99.5%</td><td>1.82 days</td><td>3.6 hours</td><td>50.4 min</td><td>7.2 min</td></tr>
  <tr><td><b>99.9%</b> (three nines)</td><td><b>8.76 hours</b></td><td><b>43.2 min</b></td><td>10.1 min</td><td>1.4 min</td></tr>
  <tr><td>99.95%</td><td>4.38 hours</td><td>21.6 min</td><td>5.0 min</td><td>43 s</td></tr>
  <tr><td><b>99.99%</b> (four nines)</td><td><b>52.6 min</b></td><td><b>4.3 min</b></td><td>1.0 min</td><td>9 s</td></tr>
  <tr><td>99.999% (five nines)</td><td>5.3 min</td><td>26 s</td><td>6 s</td><td>1 s</td></tr>
</tbody></table>

<p><b>Say it as a sentence:</b> "Four nines is about 52 minutes a year — which is one bad deploy. So the rollout has to be able to roll back in under a minute, or the budget is gone in a single incident."</p>

## Availability composes — and mostly downward {#nb-compose}

<div class="board">
  <div>
    <h4>Serial dependencies multiply</h4>
    <ol>
      <li>1 × 99.9% → 99.900% = 8.8 h/yr</li>
      <li>2 × 99.9% → 99.800% = 17.5 h/yr</li>
      <li>3 × 99.9% → 99.700% = 1.1 days/yr</li>
      <li>5 × 99.9% → 99.501% = 1.8 days/yr</li>
      <li>10 × 99.9% → 99.005% = 3.6 days/yr</li>
    </ol>
  </div>
  <div>
    <h4>Redundancy multiplies the failure</h4>
    <ol>
      <li>1 copy at 99.9% → 8.8 h/yr</li>
      <li>2 independent copies → 32 s/yr</li>
      <li>3 independent copies → effectively zero</li>
      <li class="out">"Independent" is the load-bearing word — same rack, same power, same deploy means not independent</li>
    </ol>
  </div>
</div>

<div class="trap"><b>The line that scores:</b> "I can't promise four nines if I have five serial dependencies at three nines each — that's 99.5% before I've written any code. So either I remove the dependency from the critical path, make it optional with a degraded mode, or I stop promising four nines." <b>Your availability is capped by your dependency chain</b>, and noticing that is the senior move.</div>

## Error budgets and burn rate {#nb-budget}

<p>An SLO of 99.9% over 30 days means a budget of <b>43.2 minutes</b> of badness. Burn rate = how fast you are spending it relative to "evenly across the window".</p>

<table>
  <tbody><tr><th>Burn rate</th><th>Budget gone in</th><th>Typical alert</th><th>Action</th></tr>
  <tr><td>1×</td><td>30 days</td><td>none</td><td>This is the budget working as designed</td></tr>
  <tr><td>6×</td><td>5 days</td><td>6 h / 30 m windows</td><td>Ticket</td></tr>
  <tr><td>14.4×</td><td>~2 days</td><td>1 h / 5 m windows</td><td><b>Page</b></td></tr>
  <tr><td>100×</td><td>7 hours</td><td>fires immediately</td><td><b>Page, and consider rollback</b></td></tr>
</tbody></table>

<ul>
  <li><b>Paired windows</b> are what make this both fast and quiet — the long window proves the burn is real, the short one proves it is <em>still happening</em>.</li>
  <li><b>Fast burn pages, slow burn tickets.</b> A 2% error rate for five minutes and for five hours are different events.</li>
  <li><b>An exhausted budget is a policy trigger</b>, not just a graph: freeze rollouts until it recovers.</li>
</ul>

## Latency — orders of magnitude {#nb-latency}

<table>
  <tbody><tr><th>Operation</th><th>Time</th><th>Relative</th></tr>
  <tr><td>L1 cache reference</td><td>~1 ns</td><td>1</td></tr>
  <tr><td>Branch mispredict</td><td>~3 ns</td><td>3</td></tr>
  <tr><td>L2 cache reference</td><td>~4 ns</td><td>4</td></tr>
  <tr><td>Mutex lock/unlock (uncontended)</td><td>~20 ns</td><td>20</td></tr>
  <tr><td><b>Main memory reference</b></td><td><b>~100 ns</b></td><td>100</td></tr>
  <tr><td>Compress 1 KB</td><td>~1 µs</td><td>1,000</td></tr>
  <tr><td><b>NVMe SSD random read</b></td><td><b>~20 µs</b></td><td>20,000</td></tr>
  <tr><td>SATA SSD random read</td><td>~100 µs</td><td>100,000</td></tr>
  <tr><td><b>Network round trip, same DC</b></td><td><b>~0.5 ms</b></td><td>500,000</td></tr>
  <tr><td>HDD seek</td><td>~10 ms</td><td>10,000,000</td></tr>
  <tr><td><b>Round trip, cross-country</b></td><td><b>~70 ms</b></td><td>70,000,000</td></tr>
  <tr><td><b>Round trip, cross-continent</b></td><td><b>~150 ms</b></td><td>150,000,000</td></tr>
</tbody></table>

<p><b>The one that decides architectures:</b> a cross-continent round trip is ~150 ms. If your p95 budget is 100 ms, <b>no request may cross a region synchronously</b> — which forces local reads, async replication, and an explicit staleness number. That is the whole of <a href="/docs/aire/kv-multiregion">kv-multiregion</a> in one comparison.</p>

## Bytes and throughput {#nb-bytes}

<div class="cards">
  <div><h4>Sizes</h4><ul>
    <li>2<sup>10</sup> = 1,024 ≈ 10<sup>3</sup> — KB</li>
    <li>2<sup>20</sup> ≈ 10<sup>6</sup> — MB</li>
    <li>2<sup>30</sup> ≈ 10<sup>9</sup> — GB</li>
    <li>2<sup>40</sup> ≈ 10<sup>12</sup> — TB</li>
    <li>2<sup>50</sup> ≈ 10<sup>15</sup> — PB</li>
    <li>2<sup>32</sup> ≈ 4.3 billion (IPv4, CRC32 space)</li>
    <li>2<sup>64</sup> ≈ 1.8 × 10<sup>19</sup></li></ul></div>
  <div><h4>Network</h4><ul>
    <li><b>1 Gb/s = 125 MB/s</b></li>
    <li>10 Gb/s = 1.25 GB/s</li>
    <li>25 Gb/s = 3.1 GB/s</li>
    <li>100 Gb/s = 12.5 GB/s</li>
    <li>Divide bits by 8 — the single most common slip</li></ul></div>
  <div><h4>Devices</h4><ul>
    <li>NVMe read ~3–7 GB/s</li>
    <li>SATA SSD ~550 MB/s</li>
    <li>HDD sequential ~200 MB/s</li>
    <li>Memory bandwidth ~100 GB/s</li>
    <li>GPU HBM ~2–3 TB/s</li></ul></div>
</div>

<div class="cards">
  <div><h4>Typical object sizes</h4><ul>
    <li>UUID 16 B · timestamp 8 B</li>
    <li>Metric point (compressed) ~1.4 B</li>
    <li>Chat message ~200 B – 2 KB</li>
    <li>API request/prompt ~10 KB</li>
    <li>Web page ~100 KB</li>
    <li>Photo ~3 MB · video minute ~50 MB</li>
    <li>Embedding, 768-d fp32 = 3 KB</li></ul></div>
  <div><h4>Per-machine rules of thumb</h4><ul>
    <li>~10K QPS for real work</li>
    <li>~50–100K QPS for trivial work</li>
    <li>~100K concurrent sockets</li>
    <li>RAM 256 GB – 2 TB</li>
    <li>Run at <b>~70%</b>, never 95%</li></ul></div>
  <div><h4>Durability</h4><ul>
    <li>11 nines = 99.999999999%</li>
    <li>≈ lose 1 object per 10 million, per 10,000 years</li>
    <li>3 replicas ≈ 6 nines</li>
    <li>Erasure coding gets 11 at ~1.4× overhead vs 3×</li></ul></div>
</div>

## Capacity arithmetic {#nb-capacity}

<table>
  <tbody><tr><th>Daily volume</th><th>Average QPS</th><th>At 3× peak</th></tr>
  <tr><td>1M / day</td><td>12 /s</td><td>35 /s</td></tr>
  <tr><td>10M / day</td><td>116 /s</td><td>347 /s</td></tr>
  <tr><td>100M / day</td><td>1,157 /s</td><td>3,472 /s</td></tr>
  <tr><td>1B / day</td><td>11,574 /s</td><td>34,722 /s</td></tr>
  <tr><td>10B / day</td><td>115,741 /s</td><td>347,222 /s</td></tr>
</tbody></table>

<p><b>The recipe, out loud:</b></p>
<ol class="order">
  <li><b>QPS</b> = DAU × actions per user per day ÷ 86,400 — then ×2–3 for peak.</li>
  <li><b>Storage</b> = items/day × bytes/item × retention days. Add ~30% for derivatives and indexes.</li>
  <li><b>Bandwidth</b> = QPS × bytes/response. Convert to Gb/s by ×8.</li>
  <li><b>Machines</b> = peak QPS ÷ per-machine QPS ÷ 0.7 utilisation.</li>
  <li><b>Then sanity-check</b>: does the working set fit in RAM? Does one machine already do it?</li>
</ol>

<div class="trap"><b>Always do step 5.</b> 10M businesses × 1 KB = 10 GB fits on one box — and saying so is the senior signal in <a href="/docs/system-design-notes/yelp">yelp</a>. Proposing a sharded architecture for 10 GB says you did not do the arithmetic.</div>

## Queueing and tails {#nb-queue}

<div class="board">
  <div>
    <h4>Wait multiplier — 1/(1−ρ)</h4>
    <ol>
      <li>50% utilisation → 2.0×</li>
      <li><b>70% → 3.3×</b> (the sweet spot)</li>
      <li>80% → 5.0×</li>
      <li>90% → 10×</li>
      <li><b>95% → 20×</b></li>
      <li>99% → 100×</li>
    </ol>
  </div>
  <div>
    <h4>Fan-out tail — chance of hitting a slow shard</h4>
    <ol>
      <li>Per-shard p99 = 1% slow</li>
      <li>10 shards → 10% of queries</li>
      <li>50 shards → 39%</li>
      <li><b>100 shards → 63%</b></li>
      <li>200 shards → 87%</li>
      <li class="out">So a per-shard p99 becomes the query's common case</li>
    </ol>
  </div>
</div>

<ul>
  <li><b>Little's law:</b> concurrency = throughput × latency. At 10K req/s and 500 ms, that is <b>5,000 in flight</b> — and it also tells you the worker pool size: 10 req/s at 200 ms needs <b>2</b> workers, not 50.</li>
  <li><b>The 20× explanation:</b> a 20× p95 regression with no code change is almost always saturation, not code. Check utilisation before you profile.</li>
  <li><b>Hedging</b> after the p95 costs a few percent extra load and removes most of the fan-out tail.</li>
</ul>

## Sanity checks worth memorising {#nb-sanity}

<ul class="checklist">
  <li>1 request/second = 86K/day = 2.6M/month = 31.5M/year</li>
  <li>1 MB/s sustained = 86 GB/day = 31 TB/year</li>
  <li>1 TB at 10 Gb/s = ~13 minutes; 1 PB = ~9 days</li>
  <li>A year is ~30M seconds (π × 10<sup>7</sup>, within 0.5%)</li>
  <li>Peak is usually 2–3× average for consumer traffic, 10× for events and flash sales</li>
  <li>90% of reads usually hit ~10% of keys — which is why a modest cache reaches 95%+</li>
  <li>Cluster MTBF = node MTBF ÷ node count — at 1,000 nodes something fails hourly</li>
  <li>Base62<sup>6</sup> ≈ 56 billion; Base62<sup>7</sup> ≈ 3.5 trillion</li>
</ul>

## The sentences to have ready {#nb-sentences}

<div class="cards">
  <div><h4>On availability</h4><ul>
    <li>"Four nines is 52 minutes a year — one bad deploy."</li>
    <li>"Five serial deps at three nines each is 99.5% before I write any code."</li>
    <li>"I'd rather promise three nines and a published degraded mode than four nines I can't hold."</li></ul></div>
  <div><h4>On capacity</h4><ul>
    <li>"1B a day is ~12K/s average, ~35K at peak."</li>
    <li>"That's 10 GB — it fits in RAM on one machine, so I'll keep this simple."</li>
    <li>"I'll run at 70%, because wait time grows as 1/(1−ρ) and the headroom is what buys me the minutes autoscaling takes."</li></ul></div>
  <div><h4>On latency</h4><ul>
    <li>"A cross-continent round trip is 150 ms, so nothing crosses a region synchronously."</li>
    <li>"Query latency is the max of 100 shard latencies, not the average."</li>
    <li>"Memory is 100 ns, SSD is 20 µs, same-DC network is 0.5 ms — three orders of magnitude apart each time."</li></ul></div>
</div>
