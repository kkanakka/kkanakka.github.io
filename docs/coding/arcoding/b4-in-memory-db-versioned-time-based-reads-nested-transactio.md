---
title: "B4 · In-memory DB: versioned/time-based reads + nested transactions"
slug: /coding/arcoding/b4-in-memory-db-versioned-time-based-reads-nested-transactio
sidebar_position: 11
sidebar_label: "B4 · In-memory DB: versioned/time-based rea…"
description: "B4 · In-memory DB: versioned/time-based reads + nested transactions"
---

<div class="arcoding">

## B4 · In-memory DB: versioned/time-based reads + nested transactions

<p class="covers">Covers: Build a Versioned In-Memory Database · Time-Based Key-Value Store · In-Memory KV Database with Nested Transactions. (TTL/backup family → see <a href="/docs/coding/arcoding/s1-in-memory-key-value-store-with-ttl-backup-restore">S1</a>.)</p>
<h4>Part 1 — time-based/versioned store with TTL, tombstones, historical reads</h4>
<p>The "versioned DB" variant merges three ideas: append-only version lists per key, deletes as <em>tombstone versions</em> (so history is preserved), and TTL applied per write. Every read is then one binary search.</p>

```
import bisect

_TOMBSTONE = object()


class VersionedKV:
    """set(key, value, t [, ttl])   — t strictly increasing per key
    delete(key, t)                  — writes a tombstone version
    get(key, t)                     — value visible AT time t (historical read)
    scan(prefix, t)                 — live keys at time t, sorted"""

    def __init__(self):
        # key -> ([write_ts], [(value, expiry_or_None)])
        self._d = {}

    def _versions(self, key):
        return self._d.setdefault(key, ([], []))

    def set(self, key, value, t, ttl=None):
        ts, vs = self._versions(key)
        if ts and t <= ts[-1]:
            raise ValueError("writes must have increasing timestamps")
        ts.append(t)
        vs.append((value, None if ttl is None else t + ttl))

    def delete(self, key, t):
        ts, vs = self._versions(key)
        ts.append(t)
        vs.append((_TOMBSTONE, None))

    def get(self, key, t):
        rec = self._d.get(key)
        if not rec:
            return None
        ts, vs = rec
        i = bisect.bisect_right(ts, t)      # latest version written <= t
        if i == 0:
            return None                     # key didn't exist yet at t
        value, expiry = vs[i - 1]
        if value is _TOMBSTONE:
            return None
        if expiry is not None and t >= expiry:
            return None                     # that version had expired by t
        return value

    def scan(self, prefix, t):
        return sorted(k for k in self._d
                      if k.startswith(prefix) and self.get(k, t) is not None)
```

<p>The elegant consequence to point out: <strong>expiry never mutates history</strong>. A version simply stops being visible for reads at <code>t ≥ expiry</code>, but a historical read at an earlier t still sees it — deletion-by-non-visibility, the same trick MVCC databases use.</p>
<h4>Part 2 — nested transactions over a committed base</h4>

```
class TxKV:
    """begin/commit/rollback nest arbitrarily. Reads see the newest layer;
    commit merges ONE level down (into the parent tx, not the base)."""

    def __init__(self):
        self.base = {}
        self.layers = []                    # stack of pending overlay dicts

    def _top(self):
        return self.layers[-1] if self.layers else self.base

    def set(self, k, v):
        self._top()[k] = v

    def delete(self, k):
        # A tombstone, NOT `del`: must shadow values in lower layers.
        self._top()[k] = _TOMBSTONE

    def get(self, k, default=None):
        for layer in reversed(self.layers):
            if k in layer:
                v = layer[k]
                return default if v is _TOMBSTONE else v
        v = self.base.get(k, _TOMBSTONE)
        return default if v is _TOMBSTONE else v

    def begin(self):
        self.layers.append({})

    def rollback(self) -> bool:
        if not self.layers:
            return False
        self.layers.pop()                   # O(1): discard the overlay
        return True

    def commit(self) -> bool:
        if not self.layers:
            return False
        top = self.layers.pop()
        parent = self.layers[-1] if self.layers else self.base
        parent.update(top)                  # tombstones merge down too
        return True
```

<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>The tombstone question is the whole transaction exercise.</strong> Walk the failing case: base has <code>x=1</code>; <code>begin; delete(x)</code> — with <code>del</code> the read falls through to base and resurrects <code>x</code>. Then: after <code>commit</code>, tombstones must keep shadowing in the parent (only compact them when merging into base, if at all).</li>
<li><strong>Costs:</strong> get O(depth), set/rollback O(1), commit O(size of top layer). The overlay design makes <em>rollback</em> free — which is the common case worth optimizing, and worth saying.</li>
<li><strong>Version-list appends must be monotonic</strong> per key — validate and raise; the "deterministic behavior" phrasing in the listing means they test out-of-order writes.</li>
<li><strong>Bridge to the job:</strong> layered reads = memtable-over-SSTable; tombstones + compaction = LSM trees; historical reads = MVCC. One sentence connecting these lands well.</li>
</ul></div>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time (versioned store):</strong> <code>set/delete</code> O(1) amortized append; <code>get</code> O(log v) binary search over that key’s v versions; <code>scan</code> O(keys &times; log v). <strong>Time (transactions):</strong> <code>set/delete</code> O(1), <code>get</code> O(tx depth), <code>rollback</code> O(1), <code>commit</code> O(size of top layer). <strong>Space:</strong> full history is retained by design — O(total writes).</p><p><strong>How efficient is it?</strong> The append-only + bisect layout makes historical reads as cheap as current reads — the MVCC trade: pay memory for history, get O(log v) time travel. Rollback being O(1) is the right optimization target (aborts are common; commits of huge transactions are rare), and worth stating as a deliberate choice.</p></div>

</div>
