---
title: "Schedule instructions on a VLIW pipeline"
slug: /system-design-notes/vliw-scheduling
sidebar_position: 37
sidebar_label: "Schedule instructions on a VLIW pipeline"
description: "coding/compilers · list scheduling · dependency DAG · latencies · resource constraints"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/vliw-scheduling/sequence.svg" alt="How it works — vliw-scheduling" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
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
  <li><b>Scheduler → DAG:</b> ops: L1 load r1 (lat 3); A1 add r2=r1+1; A2 add r3=r0+5; A3 mul r4=r3*r2 (lat 2); S1 store r4</li>
  <li><b>DAG:</b> edges: L1→A1(3), A2→A3(0? no: RAW 1), A1→A3(1), A3→S1(2)</li>
  <li><b>Priority:</b> prio: L1=3+1+2+1=7, A1=4, A2=4, A3=3, S1=1</li>
  <li><b>Scheduler → Cycle 0:</b> ready: L1(7), A2(4); units alu×2, mem×1</li>
  <li><b>Cycle 0:</b> issue L1 on mem, A2 on alu; A1 earliest=3</li>
  <li><b>Scheduler → Cycle 1:</b> ready: A1 (earliest 3) → defer; nothing else</li>
  <li><b>Cycle 1:</b> nop word (or fill with independent ops)</li>
  <li><b>Scheduler → Cycle 2:</b> cycle 2: still waiting on load</li>
  <li><b>Cycle 2:</b> cycle 3: A1 on alu; cycle 4: A3; cycle 6: S1 → makespan 7</li>
  <li><b>Scheduler:</b> improve: hoist independent work into the nop cycles</li>
</ol>

## Deep dives {#vliw-scheduling-deep}

<div class="cards">
<div><h4>Building the DAG</h4><ul><li>Walk ops in order; for each source find the last writer (RAW edge with the writer's latency); for each destination add WAR edges from prior readers and a WAW edge from the prior writer.</li><li>Memory: loads/stores to possibly‑aliasing addresses get ordering edges; with alias analysis you can drop them.</li><li>Register renaming (if the target allows or you allocate later) removes WAR/WAW and exposes more parallelism; say it.</li></ul></div>
<div><h4>Priority and the cycle loop</h4><ul><li>Critical path (longest latency‑weighted path to a sink) is the standard priority; ties by number of successors, then original order for determinism.</li><li>Each cycle: iterate slots; pick the highest‑priority ready op whose earliest cycle ≤ now and whose unit is free; ops released by placements become ready with earliest = cycle + latency.</li><li>Complexity O((V+E) log V). Backward list scheduling (from sinks) sometimes packs better for loads; mention as a variant.</li></ul></div>
<div><h4>Beyond a basic block</h4><ul><li>Software pipelining / modulo scheduling for loops: overlap iterations with an initiation interval II bounded by resource and recurrence constraints; the standard follow‑up.</li><li>Register pressure: aggressive hoisting extends live ranges; integrate a pressure heuristic or schedule then allocate then reschedule.</li><li>Delay slots, predication, and bundle encoding limits (e.g. at most one branch per word) are extra resource rows in the table.</li><li>Verification: replay the schedule and assert every dependency and unit constraint; compare makespan to a lower bound (max(critical path, ops per unit / units)).</li></ul></div></div>

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
