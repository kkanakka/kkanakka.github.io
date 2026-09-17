---
title: "Schedule instructions on a VLIW pipeline"
slug: /system-design-notes/vliw-scheduling
sidebar_position: 37
sidebar_label: "Schedule instructions on a VLIW pipeline"
description: "coding/compilers · list scheduling · dependency DAG · latencies · resource constraints"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/vliw-scheduling/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">coding/compilers · list scheduling · dependency DAG · latencies · resource constraints</span>
</header>
<p>A VLIW machine issues one wide instruction word per cycle containing several operations, one per functional unit (e.g. 2 ALUs, 1 load/store, 1 branch). The compiler must pack independent operations into words while respecting data dependencies, operation latencies, and unit availability, minimizing total cycles. Classic list scheduling; the interviewer wants the DAG, the priority function, and the resource table.</p>

## Requirements {#vliw-scheduling-req}

<div class="board">
  <div><h4>Functional</h4><ol>
      <li>Input: a basic block of operations with sources/destinations, per‑op latency, unit type</li>
      <li>Output: a schedule assigning each op to (cycle, slot) with no violated dependency or unit conflict</li>
      <li>Minimize schedule length (makespan)</li>
      <li class="out">Register allocation, software pipelining across iterations (mention)</li>
  </ol></div>
  <div><h4>Non‑functional</h4><ol>
      <li>Correct for RAW, WAR, WAW dependencies and memory ordering</li>
      <li>Handles latency &gt; 1 (loads, multiplies) and multiple identical units</li>
      <li>Polynomial time; greedy list scheduling with a good priority</li>
      <li>Explainable: why an op landed where it did</li>
  </ol></div>
</div>
<div class="note"><b>Dependencies:</b> RAW (true) requires consumer cycle ≥ producer cycle + latency. WAR and WAW are false dependencies that renaming removes; without renaming they impose ordering with latency 0 or 1. Memory ops that may alias are ordered conservatively.</div>


## Scale, performance and safety targets {#vliw-scheduling-targets}

<p>A compiler pass has budgets too. These are the numbers that decide greedy list scheduling over anything more exact.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>Work per invocation:</b> a basic block of 10–500 operations; a hot loop body is typically under 100. The scheduler runs once per block across a whole program — tens of thousands of blocks per compilation unit.</li>
    <li><b>Data volume:</b> the DAG is O(n²) edges in the worst case but sparse in practice; resource tables are (cycles × unit types), a few thousand entries. Everything fits comfortably in cache, which is why constant factors matter more than asymptotics.</li>
    <li><b>Growth:</b> wider machines (more issue slots) and deeper pipelines (longer latencies) both increase the search space, so the algorithm must stay polynomial as issue width grows.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> scheduling a block must be milliseconds, not seconds — it runs tens of thousands of times per build, and compile time is a developer‑facing latency budget.</li>
    <li><b>Throughput:</b> the metric that actually matters is the <em>output</em>: makespan in cycles, and issue‑slot occupancy. A 4‑issue machine running at 25% occupancy is doing the work of a scalar one, which is the entire reason this pass exists.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Correctness hazards:</b> the "attack surface" here is aliasing. Two memory operations that <em>might</em> touch the same address must stay ordered; assuming independence to gain a cycle produces a miscompilation, which is the worst possible outcome for a compiler.</li>
    <li><b>Bounding the work:</b> cap scheduling effort per block and fall back to a simpler heuristic on pathological inputs, so one generated 10,000‑operation block cannot make the compiler appear to hang.</li>
    <li><b>Register pressure:</b> aggressive reordering lengthens live ranges and can force spills that cost far more than the cycles saved — so the scheduler must be bounded by pressure, not just by dependencies.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> not applicable in the service sense — the equivalent requirement is that the pass never produces an invalid schedule, and degrades to a correct, slower one rather than an incorrect fast one.</li>
    <li><b>Degraded mode:</b> unknown latency for an operation → assume the worst case. Ambiguous alias analysis → order conservatively. Time budget exceeded → emit the in‑order schedule, which is always legal. Every fallback trades cycles for certainty, never the other way round.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Correctness model:</b> RAW is a true dependency and requires consumer ≥ producer + latency. WAR and WAW are false dependencies that register renaming removes; without renaming they still impose ordering, and pretending otherwise silently corrupts values.</li>
    <li><b>Optimality:</b> list scheduling is greedy and not optimal — optimal scheduling with resource constraints is NP‑hard. The critical‑path priority typically lands within a few percent, which is the right trade for a pass that runs constantly.</li>
    <li><b>Explainability:</b> every placement must be attributable to a dependency, a latency or a busy unit. A scheduler nobody can interrogate is one nobody will trust with a performance regression.</li></ul></div>
</div>

## Algorithm and code {#vliw-scheduling-api}

<p>Op (id, unit type, dst, srcs[], latency) · DAG edge (u → v, latency) · Ready list · Resource table (cycle → free slots per unit type) · Priority = critical path length to exit (longest latency‑weighted path).</p>
<pre><code>from collections import defaultdict
import heapq

def schedule(ops, units):            # ops: list of dict(id, unit, dst, srcs, lat); units: {"alu":2,"mem":1,"br":1}
    n = len(ops); succ = defaultdict(list); indeg = [0]*n; last_writer = {}; readers = defaultdict(list)
    for i, op in enumerate(ops):     # build DAG in program order
        for s in op["srcs"]:         # RAW
            if s in last_writer: succ[last_writer[s]].append((i, ops[last_writer[s]]["lat"])); indeg[i] += 1
        d = op["dst"]
        if d is not None:
            for r in readers[d]:     # WAR: writer after reader, latency 0
                if r != i: succ[r].append((i, 0)); indeg[i] += 1
            if d in last_writer:     # WAW: keep write order, latency 1
                succ[last_writer[d]].append((i, 1)); indeg[i] += 1
            last_writer[d] = i; readers[d] = []
        for s in op["srcs"]: readers[s].append(i)
    # priority: longest path to any sink (latency-weighted), computed in reverse topological order
    prio = [ops[i]["lat"] for i in range(n)]
    for i in reversed(range(n)):
        for v, lat in succ[i]: prio[i] = max(prio[i], lat + prio[v])
    earliest = [0]*n; cycle = 0; done = 0; placed = [None]*n
    ready = [(-prio[i], i) for i in range(n) if indeg[i] == 0]; heapq.heapify(ready)
    pending = []                     # ops whose deps are satisfied but earliest cycle not yet reached
    while done &lt; n:
        free = dict(units)           # resource table for this cycle
        deferred = []
        while ready:
            p, i = heapq.heappop(ready)
            if earliest[i] &gt; cycle or free[ops[i]["unit"]] == 0:
                deferred.append((p, i)); continue
            free[ops[i]["unit"]] -= 1; placed[i] = cycle; done += 1
            for v, lat in succ[i]:
                earliest[v] = max(earliest[v], cycle + lat); indeg[v] -= 1
                if indeg[v] == 0: heapq.heappush(ready, (-prio[v], v))
        for d in deferred: heapq.heappush(ready, d)
        cycle += 1
    return placed                    # op i issues at cycle placed[i]; makespan = max(placed)+lat</code></pre>

## Design {#vliw-scheduling-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/vliw-scheduling/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 190" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="List scheduling: build dependency DAG with latencies, compute critical-path priorities, then cycle by cycle fill functional-unit slots from the ready list in priority order">
<defs><marker id="dg1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="dg3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#dg1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#dg3);stroke-dasharray:2 4}.lbl{font-size:10.5px;fill:#1F4E9E}</style>
<rect class="box" x="20" y="60" width="160" height="90"></rect><text class="tb" x="100" y="78" text-anchor="middle">Basic block</text>
<text class="ts" x="100" y="94" text-anchor="middle">ops in program order</text>
<text class="ts" x="100" y="107" text-anchor="middle">unit, dst, srcs, latency</text>
<rect class="box" x="210" y="60" width="170" height="90" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="295" y="78" text-anchor="middle">Dependency DAG</text>
<text class="ts" x="295" y="94" text-anchor="middle">RAW edges w/ latency</text>
<text class="ts" x="295" y="107" text-anchor="middle">WAR/WAW (0/1) unless renamed</text>
<text class="ts" x="295" y="120" text-anchor="middle">memory order edges</text>
<rect class="box" x="410" y="60" width="170" height="90" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="495" y="78" text-anchor="middle">Priorities</text>
<text class="ts" x="495" y="94" text-anchor="middle">critical path to exit</text>
<text class="ts" x="495" y="107" text-anchor="middle">tie-break: more successors,</text>
<text class="ts" x="495" y="120" text-anchor="middle">program order</text>
<rect class="box" x="610" y="40" width="170" height="130" stroke="#B45309"></rect><text class="tb" x="695" y="58" text-anchor="middle">Cycle loop</text>
<text class="ts" x="695" y="74" text-anchor="middle">ready list (heap by prio)</text>
<text class="ts" x="695" y="87" text-anchor="middle">for each unit slot: pick</text>
<text class="ts" x="695" y="100" text-anchor="middle">highest-prio op whose</text>
<text class="ts" x="695" y="113" text-anchor="middle">earliest ≤ cycle</text>
<text class="ts" x="695" y="126" text-anchor="middle">emit word; advance</text>
<rect class="box" x="810" y="60" width="150" height="90"></rect><text class="tb" x="885" y="78" text-anchor="middle">VLIW words</text>
<text class="ts" x="885" y="94" text-anchor="middle">[alu, alu, mem, br]</text>
<text class="ts" x="885" y="107" text-anchor="middle">nops where empty</text>
<text class="ts" x="885" y="120" text-anchor="middle">makespan</text>
<line class="f" x1="180" y1="105" x2="208" y2="105"></line>
<line class="f" x1="380" y1="105" x2="408" y2="105"></line>
<line class="f" x1="580" y1="105" x2="608" y2="105"></line>
<line class="f" x1="780" y1="105" x2="808" y2="105"></line>
<text class="ts" x="20" y="160">Greedy is not optimal (NP-hard in general) but critical-path list scheduling is within a few percent on real code and is what production compilers do for basic blocks.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 440" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Scheduling a small block">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="5" y="14" width="130" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Scheduler</text>
<line class="ln" x1="70" y1="48" x2="70" y2="420"></line>
<rect class="sb" x="173" y="14" width="130" height="34"></rect><text class="st" x="238" y="36" text-anchor="middle">DAG</text>
<line class="ln" x1="238" y1="48" x2="238" y2="420"></line>
<rect class="sb" x="341" y="14" width="130" height="34"></rect><text class="st" x="406" y="36" text-anchor="middle">Priority</text>
<line class="ln" x1="406" y1="48" x2="406" y2="420"></line>
<rect class="sb" x="509" y="14" width="130" height="34"></rect><text class="st" x="574" y="36" text-anchor="middle">Cycle 0</text>
<line class="ln" x1="574" y1="48" x2="574" y2="420"></line>
<rect class="sb" x="677" y="14" width="130" height="34"></rect><text class="st" x="742" y="36" text-anchor="middle">Cycle 1</text>
<line class="ln" x1="742" y1="48" x2="742" y2="420"></line>
<rect class="sb" x="845" y="14" width="130" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Cycle 2</text>
<line class="ln" x1="910" y1="48" x2="910" y2="420"></line>
<line class="a1" x1="78" y1="80" x2="230" y2="80"></line>
<text class="sl" x="154" y="74" text-anchor="middle">ops: L1 load r1 (lat 3); A1 add r2=r1+1; A2 add r3=r0+5; A3 mul r4=r3*r2 (lat 2); S1 store r4</text>
<rect class="nt" x="128" y="101" width="220" height="22"></rect><text class="sl" x="238" y="116" text-anchor="middle">edges: L1→A1(3), A2→A3(0? no: RAW 1), A1→A3(1), A3→S1(2)</text>
<rect class="nt" x="296" y="135" width="220" height="22"></rect><text class="sl" x="406" y="150" text-anchor="middle">prio: L1=3+1+2+1=7, A1=4, A2=4, A3=3, S1=1</text>
<line class="a1" x1="78" y1="182" x2="566" y2="182"></line>
<text class="sl" x="322" y="176" text-anchor="middle">ready: L1(7), A2(4); units alu×2, mem×1</text>
<rect class="nt" x="464" y="203" width="220" height="22"></rect><text class="sl" x="574" y="218" text-anchor="middle">issue L1 on mem, A2 on alu; A1 earliest=3</text>
<line class="a1" x1="78" y1="250" x2="734" y2="250"></line>
<text class="sl" x="406" y="244" text-anchor="middle">ready: A1 (earliest 3) → defer; nothing else</text>
<rect class="nt" x="632" y="271" width="220" height="22"></rect><text class="sl" x="742" y="286" text-anchor="middle">nop word (or fill with independent ops)</text>
<line class="a1" x1="78" y1="318" x2="902" y2="318"></line>
<text class="sl" x="490" y="312" text-anchor="middle">cycle 2: still waiting on load</text>
<rect class="nt" x="800" y="339" width="220" height="22"></rect><text class="sl" x="910" y="354" text-anchor="middle">cycle 3: A1 on alu; cycle 4: A3; cycle 6: S1 → makespan 7</text>
<rect class="nt" x="-40" y="373" width="220" height="22"></rect><text class="sl" x="70" y="388" text-anchor="middle">improve: hoist independent work into the nop cycles</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Scheduler → DAG:</b> ops: L1 load r1 (lat 3); A1 add r2=r1+1; A2 add r3=r0+5; A3 mul r4=r3*r2 (lat 2); S1 store r4.
    Each operation carries three things the scheduler needs: which functional unit it requires, what it reads and writes, and how many cycles before its result is usable.
    Latency is separate from occupancy — a 3‑cycle load occupies the memory unit for one cycle but its destination register is not readable for three.
    Conflating the two is the most common modelling error and produces schedules that are wrong rather than merely slow.</li>
  <li><b>DAG:</b> edges: L1→A1(3), A2→A3(0? no: RAW 1), A1→A3(1), A3→S1(2).
    Edges are built from register dependencies, weighted by the producer's latency — the graph <em>is</em> the correctness constraint, and everything after this is just packing.
    RAW edges are real data flow; WAR and WAW edges are artefacts of reusing register names and vanish under renaming.
    Memory operations that may alias get conservative edges, because a wrong assumption here is a miscompilation rather than a slowdown.</li>
  <li><b>Priority:</b> prio: L1=3+1+2+1=7, A1=4, A2=4, A3=3, S1=1.
    Priority is the longest latency‑weighted path from each node to the exit — its critical‑path length.
    Scheduling the longest remaining chain first is what keeps the critical path moving; delaying it by a cycle delays the whole block by a cycle, while delaying a short chain is usually free.
    This single choice is most of the quality of a list scheduler, which is why the priority function is what an interviewer actually probes.</li>
  <li><b>Scheduler → Cycle 0:</b> ready: L1(7), A2(4); units alu×2, mem×1.
    An operation is ready when every predecessor has issued <em>and</em> enough cycles have passed for its result to be available.
    The ready set is intersected with the resource table, so the scheduler answers two questions at once: what is legal, and what will fit.</li>
  <li><b>Cycle 0:</b> issue L1 on mem, A2 on alu; A1 earliest=3.
    L1 goes first on priority, and A2 fills an otherwise idle ALU slot — filling slots with independent work is exactly what a VLIW machine is built to exploit.
    Issuing the load as early as possible is the highest‑value move available, because its 3‑cycle latency is the longest thing standing between here and the end of the block.</li>
  <li><b>Scheduler → Cycle 1:</b> ready: A1 (earliest 3) → defer; nothing else.
    A1 depends on L1's result, which will not exist until cycle 3, so it is not ready no matter how free the ALUs are.
    This is the difference between a resource stall and a dependency stall, and only the latter can be fixed by finding more work.</li>
  <li><b>Cycle 1:</b> nop word (or fill with independent ops).
    An empty issue slot in a VLIW machine is wasted silicon — there is no out‑of‑order engine to find work for it at runtime, which is the whole bargain of the architecture.
    The compiler is the only thing that can fill these slots, so a nop is a direct admission that the scheduler ran out of visible independent work.</li>
  <li><b>Scheduler → Cycle 2:</b> cycle 2: still waiting on load.
    Two full cycles lost to one load latency, in a block with only five operations — which is why real schedulers reach beyond the basic block for more candidates.</li>
  <li><b>Cycle 2:</b> cycle 3: A1 on alu; cycle 4: A3; cycle 6: S1 → makespan 7.
    The result is legal and greedy: every operation sits at the earliest cycle where its dependencies are satisfied and a unit is free.
    Makespan 7 for five operations on a 4‑issue machine is roughly 18% slot occupancy — correct, but leaving most of the machine idle.
    Being able to state that number, and attribute it to the load latency rather than to the algorithm, is what makes the schedule explainable.</li>
  <li><b>Scheduler:</b> improve: hoist independent work into the nop cycles.
    The fix is more candidates, not a better packer: unroll the loop, software‑pipeline so iteration <em>i+1</em>'s load issues during iteration <em>i</em>'s compute, or trace‑schedule across blocks.
    Software pipelining is the highest‑value technique here precisely because it converts a latency the block cannot hide into work from a different iteration.
    Every one of these costs register pressure, so the gain must be weighed against spills — cycles saved in scheduling and then lost to memory traffic are no gain at all.</li>
</ol>

## Deep dives {#vliw-scheduling-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/vliw-scheduling/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
<div><h4>Building the DAG</h4><ul><li>Walk ops in order; for each source find the last writer (RAW edge with the writer's latency); for each destination add WAR edges from prior readers and a WAW edge from the prior writer.</li><li>Memory: loads/stores to possibly‑aliasing addresses get ordering edges; with alias analysis you can drop them.</li><li>Register renaming (if the target allows or you allocate later) removes WAR/WAW and exposes more parallelism; say it.</li></ul></div>
<div><h4>Priority and the cycle loop</h4><ul><li>Critical path (longest latency‑weighted path to a sink) is the standard priority; ties by number of successors, then original order for determinism.</li><li>Each cycle: iterate slots; pick the highest‑priority ready op whose earliest cycle ≤ now and whose unit is free; ops released by placements become ready with earliest = cycle + latency.</li><li>Complexity O((V+E) log V). Backward list scheduling (from sinks) sometimes packs better for loads; mention as a variant.</li></ul></div>
<div><h4>Beyond a basic block</h4><ul><li>Software pipelining / modulo scheduling for loops: overlap iterations with an initiation interval II bounded by resource and recurrence constraints; the standard follow‑up.</li><li>Register pressure: aggressive hoisting extends live ranges; integrate a pressure heuristic or schedule then allocate then reschedule.</li><li>Delay slots, predication, and bundle encoding limits (e.g. at most one branch per word) are extra resource rows in the table.</li><li>Verification: replay the schedule and assert every dependency and unit constraint; compare makespan to a lower bound (max(critical path, ops per unit / units)).</li></ul></div></div>


## Trade-offs {#vliw-scheduling-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Algorithm</td><td>Greedy list scheduling</td><td>Optimality — the result can be a few percent off the best possible</td><td>Exact methods (ILP, branch and bound) for a handful of extremely hot kernels where compile time does not matter</td></tr>
  <tr><td>Priority function</td><td>Critical‑path length to exit</td><td>Ignores register pressure, so it can lengthen live ranges</td><td>Blend in a pressure term when spills appear; pure critical path can win cycles and lose them again to memory</td></tr>
  <tr><td>False dependencies</td><td>Register renaming to remove WAR and WAW</td><td>More live registers, hence more pressure</td><td>Keep the ordering edges instead when registers are scarce — correct either way, but one costs cycles and the other costs spills</td></tr>
  <tr><td>Memory ordering</td><td>Conservative when aliasing is unproven</td><td>Cycles lost to orderings that were probably unnecessary</td><td>Only relax with real alias analysis or a programmer annotation; guessing here is a miscompilation, not a regression</td></tr>
  <tr><td>Scope</td><td>Basic block at a time</td><td>Latency that simply cannot be hidden inside a short block</td><td>Trace scheduling or software pipelining when blocks are small and latencies long — which is the common case</td></tr>
  <tr><td>Static vs dynamic</td><td>Compile‑time scheduling (the VLIW bargain)</td><td>No runtime adaptation — a cache miss stalls the whole issue word</td><td>Out‑of‑order hardware handles unpredictable latency far better; VLIW wins on power and area when latencies are predictable</td></tr>
  <tr><td>Unknown latency</td><td>Assume the worst case</td><td>A conservatively long schedule</td><td>Never assume the best case: a schedule that is wrong when the guess fails is not a schedule</td></tr>
</tbody></table>

## Safety-first design {#vliw-scheduling-safety}

<div class="cards">
  <div><h4>A wrong schedule is worse than a slow one</h4><ul>
    <li><b>Conservative on aliasing.</b> Memory operations that might touch the same address stay ordered; a cycle gained by guessing is a miscompilation waiting for the wrong input.</li>
    <li><b>Worst‑case latency when unknown.</b> An operation whose timing is not modelled gets the pessimistic assumption, because a schedule that breaks when the guess is wrong is not legal at all.</li>
    <li><b>False dependencies are still dependencies.</b> WAR and WAW must either be removed by renaming or honoured as edges — quietly ignoring them corrupts values in ways that are extremely hard to trace back.</li>
    <li><b>Verify before emitting.</b> A post‑pass check that no edge and no resource constraint is violated is cheap, and catches the whole class of scheduler bugs at the point they are introduced.</li></ul></div>
  <div><h4>Bound the optimisation, not the correctness</h4><ul>
    <li><b>A time budget per block.</b> One pathological generated block must not make the compiler appear to hang; exceed the budget and fall back.</li>
    <li><b>In‑order is always the safe fallback.</b> There is a legal schedule available at every moment, so degradation means slower code rather than a failed compilation.</li>
    <li><b>Stop at register pressure.</b> Reordering that forces spills trades a few cycles for memory traffic — the scheduler must know when it is losing that trade.</li>
    <li><b>Polynomial, always.</b> Optimal scheduling is NP‑hard, so the greedy algorithm is not a compromise but the only thing that can run tens of thousands of times per build.</li></ul></div>
  <div><h4>Explain every placement</h4><ul>
    <li><b>Attribute each cycle.</b> Every operation's position should be traceable to a dependency, a latency or a busy unit — nobody can act on "the scheduler decided this".</li>
    <li><b>Report occupancy, not just makespan.</b> Slot occupancy shows whether the machine is being used; makespan alone hides that most of it was idle.</li>
    <li><b>Distinguish the two stalls.</b> Dependency stalls need more candidate work; resource stalls need different packing — and only one of them is the scheduler's fault.</li>
    <li><b>Make the nops visible.</b> Empty issue slots are the direct measure of missed opportunity on a machine with no out‑of‑order engine to cover for you.</li></ul></div>
</div>

## Don't leave the room without saying {#vliw-scheduling-check}

<ul class="checklist">
  <li>RAW with latency; WAR/WAW as 0/1 edges unless renamed; memory ordering</li>
  <li>Critical‑path priority; deterministic tie‑breaks</li>
  <li>Ready list + resource table per cycle; earliest‑cycle check</li>
  <li>Greedy list scheduling, O((V+E) log V), near‑optimal in practice</li>
  <li>Lower bounds: critical path and resource bound; report makespan vs bound</li>
  <li>Follow‑ups: modulo scheduling for loops, register pressure, renaming</li>
</ul>

## What each level is expected to drive {#vliw-scheduling-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Topological order into words respecting dependencies and unit counts</td><td>Latencies, priority function</td></tr>
  <tr><td>Senior</td><td>Full list scheduler with latency‑aware readiness, critical‑path priority, WAR/WAW handling, memory edges, verification</td><td>Modulo scheduling, register pressure</td></tr>
  <tr><td>Staff+</td><td>Discusses optimality gaps and bounds, renaming and alias analysis interplay, loop pipelining with II derivation, and target encoding constraints</td><td>—</td></tr>
</tbody></table>
