---
title: "B11 · Cluster status tracker (out-of-order updates)"
slug: /coding/arcoding/b11-cluster-status-tracker-out-of-order-updates
sidebar_position: 18
sidebar_label: "B11 · Cluster status tracker (out-of-order …"
description: "B11 · Cluster status tracker (out-of-order updates)"
---

<div class="arcoding">

## B11 · Cluster status tracker (out-of-order updates)

<p class="covers">Covers: Implement cluster status tracker. The most SRE-shaped question in the bank — it is heartbeat/health-state logic verbatim.</p>
<div class="adm info"><div class="adm-title">ℹ️ Problem</div>
<p><code>update(node_id, status, timestamp)</code> where updates may arrive out of order; queries: a node's current status, count of nodes per status, and (extension) a node's status as of an arbitrary past time.</p></div>

### The approach

<img src="/diagrams/arcoding/b11.svg" alt="An update is applied only if its timestamp beats the stored one; when it is, the status counters are adjusted on the write so that count queries stay O(1)." class="doc-diagram doc-diagram-seq" />

<p>Updates arrive out of order, so the rule is <strong>last-writer-wins by timestamp</strong>, not by arrival: compare against the stored timestamp and drop anything staler. The status counts are maintained <em>on write</em> — decrement the old, increment the new — so <code>count()</code> never has to scan the cluster. Ties at equal timestamps need a stated rule (here, first write wins); either choice is defensible, but it must be deterministic and consistent everywhere.</p>

### What it looks like in memory

<p>The three structures after the seven updates in <em>Run it</em> — including the tie the two read paths disagree about.</p>

<img src="/diagrams/arcoding-state/b11.svg" alt="The latest-record dict, the maintained counter, and the sorted per-node history including a timestamp tie." class="doc-diagram doc-diagram-seq" />

```python
import bisect
from collections import Counter


class ClusterTracker:
    def __init__(self, keep_history=False):
        self.latest = {}              # node -> (ts, status)
        self.counts = Counter()       # status -> #nodes currently in it
        self.keep_history = keep_history
        self.history = {}             # node -> sorted [(ts, status)]

    def update(self, node, status, ts) -> bool:
        """Last-writer-wins by timestamp. Returns False for stale updates.
        Tie rule: equal timestamps keep the existing record (first write
        wins) — a deliberate, stated choice; deterministic either way.

        Example:
            >>> t = ClusterTracker()
            >>> t.update('n1', 'up', ts=10)
            True
            >>> t.update('n1', 'down', ts=20)
            True
            >>> t.update('n1', 'up', ts=15)
            False
        """
        if self.keep_history:
            h = self.history.setdefault(node, [])
            bisect.insort(h, (ts, status))          # out-of-order friendly

        cur = self.latest.get(node)
        if cur is not None and cur[0] >= ts:
            return False                            # stale or duplicate
        if cur is not None:
            self.counts[cur[1]] -= 1
            if self.counts[cur[1]] == 0:
                del self.counts[cur[1]]
        self.latest[node] = (ts, status)
        self.counts[status] += 1
        return True

    def status(self, node):
        """The node's latest status, or None if unknown.

        Example:
            >>> t = ClusterTracker()
            >>> t.update('n1', 'down', ts=10)
            True
            >>> t.status('n1')
            'down'
            >>> t.status('n9')   # -> None
        """
        rec = self.latest.get(node)
        return rec[1] if rec else None

    def count(self, status) -> int:
        """How many nodes are currently in this status, in O(1).

        Example:
            >>> t = ClusterTracker()
            >>> t.update('n1', 'down', ts=1); t.update('n2', 'down', ts=1)
            >>> t.count('down')
            2
        """
        return self.counts.get(status, 0)

    def nodes_in(self, status):
        """Sorted list of nodes currently in this status.

        Example:
            >>> t = ClusterTracker()
            >>> t.update('n2', 'down', ts=1); t.update('n1', 'down', ts=1)
            >>> t.nodes_in('down')
            ['n1', 'n2']
        """
        return sorted(n for n, (_, s) in self.latest.items() if s == status)

    def status_at(self, node, ts):
        """Extension: status as of time ts (requires keep_history=True).

        Example:
            >>> t = ClusterTracker(keep_history=True)
            >>> t.update('n1', 'up', ts=10); t.update('n1', 'down', ts=20)
            >>> t.status_at('n1', 15)
            'up'
            >>> t.status_at('n1', 25)
            'down'
        """
        h = self.history.get(node)
        if not h:
            return None
        i = bisect.bisect_right(h, (ts, chr(0x10FFFF)))
        return h[i - 1][1] if i else None
```

<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>Incremental counts:</strong> <code>count(status)</code> must be O(1) — decrement old, increment new on each accepted update. Recounting the fleet per query fails at scale, and the interviewer will state a fleet size to check you noticed.</li>
<li><strong>The tie rule:</strong> equal timestamps from two sources is a real distributed-systems ambiguity — pick a rule, state it, and mention the production fix (a tiebreaker like source id, or hybrid logical clocks).</li>
<li><strong>Connect to the job:</strong> this is a control plane's node-health map; stale-update rejection is exactly why monotonic per-source sequence numbers exist. One sentence of that framing is worth a lot in an SRE loop.</li>
<li><strong>Costs:</strong> update O(1) (O(log n) with history), status O(1), count O(1), nodes_in O(n log n).</li>
</ul></div>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> <code>update</code> O(1) (O(log h) with history via <code>insort</code> — or O(1) append if updates are mostly in order, sorting lazily); <code>status</code> and <code>count</code> O(1); <code>nodes_in</code> O(n log n); <code>status_at</code> O(log h). <strong>Space:</strong> O(nodes) without history, O(total updates) with it.</p><p><strong>How efficient is it?</strong> The design decision that matters is maintaining counts <em>incrementally</em>: at a 100k-node fleet with dashboards polling <code>count()</code> every second, the O(n) recount version does 100k&times; more work per query — this is exactly the kind of read-heavy control-plane workload where you pay O(1) at write time to make reads free.</p></div>

### Run it

<p class="covers">Append this to the code above, save as <code>b11_cluster_tracker.py</code>, then run <code>python b11_cluster_tracker.py</code>.</p>

```python
if __name__ == "__main__":
    t = ClusterTracker(keep_history=True)

    updates = [("n1", "healthy", 10), ("n2", "healthy", 10),
               ("n1", "down",    30),
               ("n1", "degraded", 20),      # arrives late — must be ignored
               ("n2", "down",    30), ("n3", "healthy", 5),
               ("n1", "healthy", 30)]       # tie at ts=30 — first write wins

    for node, status, ts in updates:
        applied = t.update(node, status, ts)
        print(f"{node} -> {status:<8} @{ts:<3} applied={applied}")

    print("\nstatus n1       :", t.status("n1"))
    print("count(down)     :", t.count("down"))
    print("count(healthy)  :", t.count("healthy"))
    print("nodes_in(down)  :", t.nodes_in("down"))
    print("unknown node    :", t.status("n9"))

    print("\n--- historical reads (keep_history=True) ---")
    for ts in (5, 10, 25, 30):
        print(f"n1 at t={ts:<3}:", t.status_at("n1", ts))
```

<p><strong>Output</strong></p>

```text
n1 -> healthy  @10  applied=True
n2 -> healthy  @10  applied=True
n1 -> down     @30  applied=True
n1 -> degraded @20  applied=False
n2 -> down     @30  applied=True
n3 -> healthy  @5   applied=True
n1 -> healthy  @30  applied=False

status n1       : down
count(down)     : 2
count(healthy)  : 1
nodes_in(down)  : ['n1', 'n2']
unknown node    : None

--- historical reads (keep_history=True) ---
n1 at t=5  : None
n1 at t=10 : healthy
n1 at t=25 : degraded
n1 at t=30 : healthy
```

<p>Note the tie at <code>ts=30</code>: <code>update</code> keeps the first write (status <code>down</code>), while <code>status_at</code> returns <code>healthy</code> — <code>bisect</code> lands on the last of two equal-timestamp history entries. If ties are possible in your input, make the two paths agree before you are asked about it.</p>

</div>
