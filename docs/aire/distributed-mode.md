---
title: "Exact distributed median and mode without shipping the data"
slug: /aire/distributed-mode
sidebar_position: 23
sidebar_label: "Exact distributed median and mode withou…"
description: "hard · Anthropic · communication complexity · counting vs quantiles · two-pass exactness"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/distributed-mode/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

## How it works

<header>
  
  <span class="tag">hard · Anthropic · communication complexity · counting vs quantiles · two‑pass exactness</span>
</header>
<p>A multiset is partitioned across many workers. Compute the <b>exact</b> mode (most frequent value) and the exact median, without shipping every raw item to one place. The interview is really about communication complexity: sum and count are trivially decomposable, mode and median are not, and the whole answer is finding the structure that makes them nearly so.</p>

## Requirements {#dmo-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Exact global mode across N workers, with a deterministic tie‑break</li>
      <li>Exact global median (the k‑th order statistic, generally)</li>
      <li>Handle skew: one value may dominate a worker or the whole set</li>
      <li>Survive a worker failing mid‑computation</li>
      <li class="out">Streaming/online estimates, approximate answers</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Communication far below O(total items); quantify it</li>
      <li>Bounded memory per worker — no worker holds the global set</li>
      <li>Deterministic result, independent of partitioning</li>
      <li>Wall clock dominated by local scans, not by the network</li>
    </ol>
  </div>
</div>
<div class="note"><b>Why these two are hard:</b> sum, count, min and max are <em>decomposable</em> — a worker's partial answer is the same shape as the global answer, so one number per worker suffices. Mode and median are not: a value that is rare on every worker can be globally most frequent, and a value that is median nowhere can be the global median. Any algorithm that takes local answers and combines them is wrong, and saying that out loud is the first half of the answer.</div>

## Scale, performance and safety targets {#dmo-targets}

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>Work per run:</b> 1 trillion items spread over 1,000 workers — a billion each. Shipping raw data is 1T × 8 bytes = 8 TB and is the baseline the design must beat by orders of magnitude.</li>
    <li><b>Data volume:</b> cardinality is the variable that matters, not item count. A billion distinct values means local frequency tables are gigabytes; a million distinct values means they are megabytes and the problem is nearly trivial.</li>
    <li><b>Growth:</b> items grow faster than distinct values in most real datasets, which is exactly why counting‑based approaches keep working as the data scales.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> dominated by local scans — reading a billion items per worker at a few GB/s is seconds to a minute. Each coordination round adds only milliseconds, which is why an algorithm with 30 rounds can still be fast.</li>
    <li><b>Throughput:</b> the target is communication volume: mode in O(distinct values) rather than O(items), and median in O(rounds × N) counters — kilobytes rather than terabytes.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the hazard is a worker whose local frequency table is unbounded because its partition has near‑unique values — a memory blowup that looks like a hang. Cap local table size and fall back to a two‑pass counting scheme rather than letting a worker die.</li>
    <li><b>Rate limiting:</b> bound the candidate set the coordinator broadcasts and the number of refinement rounds, so a pathological distribution cannot turn a bounded computation into an unbounded one.</li>
    <li><b>Data sensitivity:</b> shipping value/count pairs still ships values. When the multiset is user data, a frequency table is a disclosure — hash or bucket values in transit, and be aware that a mode over a sensitive column reveals the most common value to whoever runs the job.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> batch computation, no availability SLA. The requirement is that a worker failure costs a re‑scan of one partition, not a restart of the whole job.</li>
    <li><b>Degraded mode:</b> a worker that fails mid‑round has its partition reassigned and re‑scanned, since the input is durable and immutable. If exactness must be abandoned for time, say so explicitly and switch to a sketch — but that is a different answer to a different question.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Exactness:</b> the requirement that removes every sketch from consideration. Count‑Min and t‑digest are the right tools when approximation is allowed and are simply disqualified here — naming them and then rejecting them is the expected move.</li>
    <li><b>Determinism:</b> the result must not depend on partitioning or on the order rounds complete in, which means the tie‑break rule is part of the specification rather than an implementation detail.</li>
    <li><b>Communication complexity:</b> state the bound you are achieving and compare it against the naive baseline. That comparison is the answer the interviewer is listening for.</li></ul></div>
</div>

## Entities and API {#dmo-api}

<p>Worker (partition, local scan) · LocalFrequency (value → count, possibly capped) · Candidate (value with an upper bound on its global count) · RangeCounter (range → count, for the median) · Coordinator (broadcast, aggregate, decide) · Round.</p>
<pre><code>Mode:
  round 1: worker -&gt; coordinator   top-m local {value, count} + localTotal
  coordinator: prune by upper bound; broadcast candidate set C
  round 2: worker -&gt; coordinator   exact count of every c in C over its partition
  coordinator: argmax, deterministic tie-break on value

Median (k-th order statistic):
  coordinator broadcasts a pivot or bucket boundaries
  worker -&gt; coordinator            count(&lt; pivot), count(== pivot) per partition
  coordinator: recurse into the side containing k; ~log(range) or ~2 histogram rounds</code></pre>

## Design {#dmo-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/distributed-mode/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

### Flow between components

<ol class="order">
  <li><b>Coordinator → Workers:</b> start; each worker scans its own partition once.
    Data never moves; the computation moves to the data, which is the entire point when the alternative is shipping 8 TB.
    One sequential scan per partition is the floor on wall clock, and every subsequent round is designed to avoid a second full scan where possible.</li>
  <li><b>Workers:</b> build a local frequency table (value → count), capped in size.
    Local counting is exact and cheap, and its size is bounded by distinct values in the partition rather than by item count.
    The cap matters: a partition of near‑unique values would otherwise build a table as large as the partition itself, turning a bounded computation into an out‑of‑memory failure.
    When the cap is hit, the worker falls back to a two‑pass scheme — hash values into buckets, find the heavy buckets, then re‑scan only those.</li>
  <li><b>Workers → Coordinator:</b> top-m local values with counts, plus the partition total.
    Sending only the local heavy hitters is the first reduction, from a billion items to a few hundred pairs per worker.
    The partition total is what makes pruning possible in the next step, and it costs one extra number.</li>
  <li><b>Coordinator:</b> prune — a value's global count cannot exceed (its reported counts) + (the m-th count on every worker that did not report it).
    This bound is the crux of the mode algorithm. A value absent from a worker's top‑m appears there at most as often as that worker's m‑th value.
    So for every candidate the coordinator computes an exact upper bound on its global count, and any candidate whose upper bound is below the best known lower bound is eliminated without ever being counted globally.
    That is what turns "we must count everything everywhere" into "we must count a handful of survivors".</li>
  <li><b>Coordinator → Workers:</b> broadcast the surviving candidate set C.
    C is typically tiny — tens of values — so the broadcast is kilobytes regardless of dataset size.
    Its size is capped, and if pruning leaves too many survivors the coordinator raises m and repeats round one rather than broadcasting an unbounded set.</li>
  <li><b>Workers → Coordinator:</b> exact count of every value in C over the full partition.
    This second pass is what makes the answer exact rather than probable: every candidate is counted everywhere, including on workers where it never appeared in a top‑m.
    Counting |C| values during one scan costs a hash lookup per item, so the pass is bandwidth‑bound rather than compute‑bound.
    A single‑round algorithm cannot be exact — that is precisely the case where a globally frequent value is locally unremarkable everywhere.</li>
  <li><b>Coordinator:</b> sum per candidate; argmax with a deterministic tie-break.
    Summation is trivially decomposable, which is why the whole design works to reduce mode to "count these specific values".
    The tie‑break — smallest value wins, say — is specified rather than left to chance, so the answer does not depend on which worker replied first.</li>
  <li><b>Coordinator → Workers:</b> median: broadcast a pivot (or a set of bucket boundaries).
    The median cannot be combined from local medians, so the approach inverts the problem: instead of asking "what is the median", ask "how many items are below this value", which <em>is</em> decomposable.
    Binary searching on the value domain rather than on the items is what keeps communication proportional to rounds instead of to data.</li>
  <li><b>Workers → Coordinator:</b> count(&lt; pivot), count(== pivot) per partition.
    Two integers per worker per round — 1,000 workers over 30 rounds is 60,000 numbers, versus 8 TB for the naive approach.
    Counting equals separately is what makes duplicates and heavy skew correct rather than approximately correct.</li>
  <li><b>Coordinator:</b> compare cumulative count against k; recurse into the containing side.
    Each round halves the value range, so a 64‑bit domain converges in about 64 rounds and a realistic range in far fewer.
    Sending many bucket boundaries at once instead of a single pivot cuts this to two or three rounds — each round becomes a histogram rather than a comparison, trading a little more data per round for far fewer round trips.
    Because every round asks only for counts, exactness is preserved throughout; there is no estimation anywhere in the loop.</li>
  <li><b>Coordinator:</b> terminate when the range holds one value; equal-counts give the exact k-th item.
    The <code>count(== pivot)</code> figures are what resolve the boundary case where the k‑th item is one of many duplicates.
    For an even‑length multiset the two central order statistics are found by the same procedure with k and k+1, which is worth saying rather than leaving implicit.</li>
  <li><b>Coordinator → Workers:</b> worker failed → reassign its partition and re-scan.
    Input is durable and immutable, so recovery is re‑reading one partition rather than restarting the job.
    Rounds are idempotent — a re‑run of the same round with the same broadcast produces the same counts — which is what makes retry safe and the whole algorithm restartable.</li>
  <li><b>Coordinator → Caller:</b> exact mode, exact median, and the communication actually used.
    Reporting the bytes exchanged is part of the answer: it demonstrates the bound rather than asserting it.
    Typical figures — a few hundred kilobytes against an 8 TB baseline — are the number that makes the design convincing.</li>
</ol>

## How it works, step by step {#dmo-flow}

<ol class="order">
  <li>Each worker scans its partition once and builds a capped local frequency table; overflow falls back to a hash‑bucket two‑pass scheme.</li>
  <li>Workers send their top‑m values with counts plus the partition total — a few hundred numbers each.</li>
  <li>The coordinator computes an exact upper bound on each candidate's global count using the m‑th count of every non‑reporting worker, and prunes anything that cannot win.</li>
  <li>The surviving candidates are broadcast and counted exactly on every partition; summing gives the exact mode with a specified tie‑break.</li>
  <li>For the median, the coordinator binary‑searches the value domain: broadcast a pivot or bucket boundaries, collect count(&lt;) and count(==) per worker, recurse into the side containing k.</li>
  <li>A failed worker's partition is reassigned and re‑scanned; rounds are idempotent, so retry is safe.</li>
</ol>

## Deep dives {#dmo-deep}

<div class="cards">
  <div><h4>Decomposable versus not</h4><ul>
    <li>Sum, count, min, max and any monoid combine from partials — one number per worker and you are done.</li>
    <li>Mode and median do not: a value rare everywhere can be globally most frequent, and a value median nowhere can be the global median.</li>
    <li>The trick in both cases is to reduce to something decomposable — "count these candidates" for mode, "how many are below x" for median.</li>
    <li>Recognising and stating this distinction is the first half of the answer; the algorithms follow from it.</li></ul></div>
  <div><h4>Communication accounting</h4><ul>
    <li>Naive: ship everything — 1T items × 8 B = 8 TB.</li>
    <li>Mode: N workers × m pairs in round one, then N × |C| counts in round two. At N=1,000, m=100, |C|=50 that is ~150K numbers, roughly 1 MB.</li>
    <li>Median: 2 integers per worker per round. With bucketed rounds, ~3 rounds × 1,000 workers × 64 buckets ≈ 200K numbers.</li>
    <li>Both are six to seven orders of magnitude below the baseline, and quoting that ratio is the point of the exercise.</li></ul></div>
  <div><h4>Skew and pathological inputs</h4><ul>
    <li>One dominant value makes mode easy (it wins every top‑m) and makes the median's <code>count(==)</code> handling essential.</li>
    <li>Near‑unique values make local frequency tables explode — cap them and fall back to hash‑bucket counting over two passes.</li>
    <li>Adversarial distributions can keep many candidates alive after pruning; cap |C| and raise m rather than broadcasting an unbounded set.</li>
    <li>If approximation were allowed, Count‑Min sketches and t‑digest solve both in one pass — naming them and explaining why exactness rules them out is the expected move.</li></ul></div>
</div>

## Trade-offs {#dmo-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Exactness</td><td>Two passes and multiple rounds</td><td>A single‑pass answer</td><td>Count‑Min and t‑digest give one‑pass answers with bounded error; they are simply disqualified when "exact" is in the requirements</td></tr>
  <tr><td>Mode strategy</td><td>Top‑m, prune by upper bound, then count survivors exactly</td><td>A second full scan of every partition</td><td>Shipping all distinct values works when cardinality is low, and is far simpler — check the cardinality before designing around it</td></tr>
  <tr><td>Median strategy</td><td>Binary search on the value domain by counting</td><td>Many coordination rounds</td><td>Full sorting or a distributed sample is simpler and either ships the data or gives up exactness</td></tr>
  <tr><td>Rounds versus bytes</td><td>Bucketed histogram rounds (~3) over single pivots (~64)</td><td>More data per round</td><td>Single pivots when the network is fast and latency per round is negligible; buckets when round trips dominate</td></tr>
  <tr><td>Local tables</td><td>Capped, with a hash‑bucket fallback</td><td>A second code path to write and test</td><td>An uncapped table is simpler and fails catastrophically on a high‑cardinality partition</td></tr>
  <tr><td>Fault tolerance</td><td>Re‑scan the failed partition</td><td>Re‑reading a billion items</td><td>Checkpointing partial counts saves the re‑scan and adds durable state to every round for a failure that is usually rare</td></tr>
  <tr><td>Data movement</td><td>Move the computation, not the data</td><td>Every worker must run your code</td><td>Centralizing is fine when the dataset actually fits on one machine — check the arithmetic before assuming it does not</td></tr>
</tbody></table>

## Safety-first design {#dmo-safety}

<div class="cards">
  <div><h4>Bound everything the data controls</h4><ul>
    <li><b>Cap local frequency tables.</b> A high‑cardinality partition would otherwise build a table the size of the partition and die as an out‑of‑memory error that looks like a hang.</li>
    <li><b>Cap the candidate set.</b> If pruning leaves too many survivors, raise m and repeat rather than broadcasting an unbounded list.</li>
    <li><b>Cap the rounds.</b> A bounded value domain converges predictably; a bound on rounds turns a pathological input into a reported failure instead of an endless job.</li>
    <li><b>Bounded memory per worker is a requirement.</b> No worker may ever hold the global multiset, which is the whole premise.</li></ul></div>
  <div><h4>Exact means deterministic</h4><ul>
    <li><b>Specify the tie‑break.</b> Two values with equal counts must resolve the same way every run, independent of which worker replied first.</li>
    <li><b>Count equals separately.</b> The median's boundary case with many duplicates is only correct if <code>count(==)</code> is tracked alongside <code>count(&lt;)</code>.</li>
    <li><b>Partition‑independent results.</b> The answer must not change if the data is split differently — a property worth testing explicitly.</li>
    <li><b>Idempotent rounds.</b> Re‑running a round with the same broadcast gives the same counts, which makes retry safe and the result reproducible.</li></ul></div>
  <div><h4>Frequency tables are data</h4><ul>
    <li><b>Shipping counts still ships values.</b> A top‑m list over a sensitive column is a disclosure of the most common values in it.</li>
    <li><b>Hash or bucket in transit.</b> When the multiset is user data, the coordinator can work with hashed values and resolve the winner only at the end.</li>
    <li><b>The result itself reveals something.</b> "The most common value" is a meaningful disclosure about the population, which is worth naming when the column is sensitive.</li>
    <li><b>Report the communication used.</b> Publishing bytes exchanged proves the bound and makes an unexpectedly chatty run visible rather than merely slow.</li></ul></div>
</div>

## Don't leave the room without saying {#dmo-check}

<ul class="checklist">
  <li>Sum and count are decomposable; mode and median are not — and why local answers cannot be combined</li>
  <li>Mode: top‑m, prune by an exact upper bound using each worker's m‑th count, then count survivors everywhere</li>
  <li>Why one round cannot be exact: a globally frequent value can be locally unremarkable on every worker</li>
  <li>Median: binary search the value domain by counting, not the items — <code>count(&lt;)</code> and <code>count(==)</code></li>
  <li>Bucketed rounds trade bytes for round trips; quote both variants</li>
  <li>Communication arithmetic against the naive 8 TB baseline</li>
  <li>Cap local tables, candidate sets and rounds; deterministic tie‑break; re‑scan on worker failure</li>
</ul>

## What each level is expected to drive {#dmo-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>MapReduce‑style count per value and combine; sort for the median</td><td>Why local top‑k is not enough, communication cost</td></tr>
  <tr><td>Senior</td><td>The decomposability argument, two‑round mode with pruning bounds, counting‑based median search, communication arithmetic</td><td>Bucketed rounds, cardinality fallbacks, tie‑break determinism</td></tr>
  <tr><td>Staff+</td><td>Explicit bounds proven rather than asserted, skew and adversarial input handling, rounds‑versus‑bytes trade‑off argued with numbers, when to abandon exactness and what it buys</td><td>—</td></tr>
</tbody></table>
