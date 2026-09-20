---
title: "B16 · Grid infection with neighbor threshold"
slug: /coding/arcoding/b16-grid-infection-with-neighbor-threshold
sidebar_position: 23
sidebar_label: "B16 · Grid infection with neighbor threshold"
description: "B16 · Grid infection with neighbor threshold"
---

<div class="arcoding">

## B16 · Grid infection with neighbor threshold

<p class="covers">Covers: Simulate Threshold Infection Efficiently — rotting-oranges generalized: a healthy cell becomes infected in round r+1 once ≥ k of its 4-neighbors are infected. Compute each cell's infection round; −1 if never. "Efficiently" is the actual question.</p>

### The approach

<img src="/diagrams/arcoding/b16.svg" alt="Infection spreads in synchronous rounds: each newly infected cell increments its neighbours' counters, and a cell joins the next round once its count reaches the threshold k." class="doc-diagram doc-diagram-seq" />

<p>This is BFS with a counter instead of a simple visited flag. Each newly infected cell bumps its neighbours' tallies, and a neighbour flips only once its tally reaches <code>k</code> — crucially, <strong>the tally persists across rounds</strong>, so a cell can be tipped over by neighbours that fall at different times. Processing a whole frontier before starting the next one is what makes the round boundaries synchronous, which is what gives every cell the correct infection <em>time</em> rather than just a yes/no.</p>
<h4>Why the naive simulation fails</h4>
<p>Re-scanning the grid every round is O(R·C·rounds) — quadratic-ish on a snake-shaped infection front. The fix: <strong>incremental neighbor counting</strong>. Each cell, when it becomes infected, pushes +1 to each healthy neighbor exactly once; a neighbor crossing the threshold joins the <em>next</em> round's frontier. Total work: every cell contributes ≤ 4 increments ever → O(R·C).</p>

```python
from collections import deque


def infection_times(grid, k):
    """grid: 1 = infected at round 0, 0 = healthy.
    Returns times[r][c] = infection round, or -1 if never infected."""
    R, C = len(grid), len(grid[0])
    times = [[-1] * C for _ in range(R)]
    infected_nbrs = [[0] * C for _ in range(R)]

    frontier = deque()
    for r in range(R):
        for c in range(C):
            if grid[r][c] == 1:
                times[r][c] = 0
                frontier.append((r, c))

    while frontier:
        next_frontier = deque()
        for r, c in frontier:                    # each cell processed ONCE ever
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nr, nc = r + dr, c + dc
                if 0 <= nr < R and 0 <= nc < C and times[nr][nc] == -1:
                    infected_nbrs[nr][nc] += 1
                    if infected_nbrs[nr][nc] >= k:
                        times[nr][nc] = times[r][c] + 1
                        next_frontier.append((nr, nc))
        frontier = next_frontier                 # synchronous round boundary
    return times
```

<h4>Correctness argument (give it, don't just assert)</h4>
<p>Invariant: when the frontier for round t is processed, <code>infected_nbrs[x]</code> for any healthy cell x equals the number of x's neighbors infected in rounds ≤ t — because every infected cell incremented its neighbors exactly once, in the round it was infected. So x crosses the threshold during round t's processing iff its k-th infected neighbor was infected at round t, making <code>times[x] = t+1</code> exactly the synchronous-simulation answer. Frontier separation (building <code>next_frontier</code> rather than appending to the live queue) is what enforces "synchronous": a cell infected in round t+1 must not contribute counts within round t.</p>
<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>k=1 sanity check:</strong> the algorithm degenerates to plain multi-source BFS (rotting oranges) — offer it as your test case, along with k &gt; 4 (nothing ever spreads) and an all-infected grid (all zeros out).</li>
<li><strong>The synchrony bug:</strong> using one queue and appending newly infected cells directly lets round-t+1 cells push counts "during" round t — infects cells a round early on some shapes. This is the hidden test.</li>
<li><strong>Complexity, precisely:</strong> O(R·C) time (each of the ≤ R·C cells enters a frontier at most once, doing O(1) work per neighbor), O(R·C) space. Compare against the naive bound out loud.</li>
<li><strong>Extensions:</strong> 8-neighborhoods (just extend the delta list), weighted thresholds per cell (store per-cell k), "which cells never get infected and why" (answer: <code>times == -1</code> after the loop; structurally, cells whose neighborhood can't accumulate k infections).</li>
</ul></div>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> O(R &times; C) — every cell joins a frontier at most once and does O(1) work per neighbor (≤ 4 increments contributed, ever). The naive re-scan simulation is O(R &times; C &times; rounds), and rounds can be Θ(R + C) on snake-shaped fronts — so the incremental version is up to a linear-factor win, which is the entire point of “Efficiently” in the title. <strong>Space:</strong> O(R &times; C) for times + counters + frontiers.</p><p><strong>How efficient is it?</strong> Optimal — every cell’s answer must be produced, so Ω(R &times; C) is the floor and this meets it. The amortization argument is the thing to articulate: work is charged to <em>infection events</em> (each cell infects once) rather than to rounds, which is why the round count vanishes from the bound.</p></div>
<!-- ============================ SYSTEM DESIGN ============================ -->

### Run it

<p class="covers">Append this to the code above, save as <code>b16_infection.py</code>, then run <code>python b16_infection.py</code>.</p>

```python
def show(times):
    for row in times:
        print(" ".join(f"{v:>2}" for v in row))


if __name__ == "__main__":
    grid = [
        [1, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 1],
        [0, 0, 0, 0],
    ]

    print("k=1 (plain BFS — one infected neighbour is enough)")
    show(infection_times(grid, k=1))

    print("\nk=2 (needs two infected neighbours: corners stay clean)")
    show(infection_times(grid, k=2))

    print("\nk=2, four corners seeded — edges fall at round 1, centre at 2")
    show(infection_times([[1, 0, 1], [0, 0, 0], [1, 0, 1]], k=2))

    print("\nno seeds at all -> every cell is -1")
    show(infection_times([[0, 0], [0, 0]], k=1))
```

<p><strong>Output</strong></p>

```text
k=1 (plain BFS — one infected neighbour is enough)
 0  1  2  2
 1  2  2  1
 2  2  1  0
 3  3  2  1

k=2 (needs two infected neighbours: corners stay clean)
 0 -1 -1 -1
-1 -1 -1 -1
-1 -1 -1  0
-1 -1 -1 -1

k=2, four corners seeded — edges fall at round 1, centre at 2
 0  1  0
 1  2  1
 0  1  0

no seeds at all -> every cell is -1
-1 -1
-1 -1
```

</div>
