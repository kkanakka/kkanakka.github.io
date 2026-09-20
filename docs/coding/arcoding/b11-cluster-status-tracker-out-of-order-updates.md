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

```
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
        wins) — a deliberate, stated choice; deterministic either way."""
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
        rec = self.latest.get(node)
        return rec[1] if rec else None

    def count(self, status) -> int:
        return self.counts.get(status, 0)

    def nodes_in(self, status):
        return sorted(n for n, (_, s) in self.latest.items() if s == status)

    def status_at(self, node, ts):
        """Extension: status as of time ts (requires keep_history=True)."""
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

</div>
