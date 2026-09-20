---
title: "S1 · In-memory key-value store with TTL + backup/restore"
slug: /coding/arcoding/s1-in-memory-key-value-store-with-ttl-backup-restore
sidebar_position: 3
sidebar_label: "S1 · In-memory key-value store with TTL + b…"
description: "S1 · In-memory key-value store with TTL + backup/restore"
---

<div class="arcoding">

## S1 · In-memory key-value store with TTL + backup/restore

<p class="covers">Covers: "Implement an in-memory DB with TTL backup/restore" and is the base pattern for the versioned-DB and cloud-storage progressives.</p>
<div class="adm info"><div class="adm-title">ℹ️ Problem (as leveled in the real assessment)</div>
<ol>
<li><strong>L1:</strong> <code>set / get / delete</code>.</li>
<li><strong>L2:</strong> <code>set_with_ttl(key, value, ttl, now)</code> — expired keys behave as absent. <em>Time is always passed in</em>, never read from the clock (the grader replays deterministic timestamps).</li>
<li><strong>L3:</strong> <code>scan(prefix, now)</code> → live keys with a prefix, sorted.</li>
<li><strong>L4:</strong> <code>backup(now)</code> / <code>restore(now, backup)</code> — restored keys keep their <em>remaining</em> TTL relative to restore time.</li>
<li><strong>Live follow-ups:</strong> thread safety; eager expiry so memory doesn't grow; nested <code>key → field → value</code> variant.</li>
</ol></div>
<h4>Design decisions before typing</h4>
<ul>
<li>Store <strong>absolute expiry timestamps</strong>, never countdowns — every question about "is this alive at time t" becomes one comparison, and backup/restore becomes arithmetic.</li>
<li>Centralize liveness in one <code>_live()</code> helper. The classic failure is re-implementing the expiry check slightly differently in <code>get</code>, <code>scan</code>, and <code>backup</code> — one of them will disagree under a test.</li>
<li>Expire <strong>lazily</strong> first (delete on touch); add a heap for eager expiry only when asked. Lazy is 10 lines and correct; eager is an optimization with an invalidation subtlety (overwritten keys leave stale heap entries).</li>
</ul>
<h4>Full solution (all levels + follow-ups)</h4>

```
import heapq
import threading


class KVStore:
    def __init__(self):
        self._d = {}            # key -> (value, expiry_or_None)
        self._heap = []         # (expiry, key): eager-expiry index (may hold stale entries)
        self._lock = threading.RLock()

    # ---- internal helpers -------------------------------------------------
    def _purge(self, now):
        """Eager expiry: pop everything due. Stale entries (key overwritten
        with a later expiry, or deleted) are detected by re-checking the dict."""
        while self._heap and self._heap[0][0] <= now:
            exp, key = heapq.heappop(self._heap)
            rec = self._d.get(key)
            if rec is not None and rec[1] == exp:   # still the same lease
                del self._d[key]

    def _live(self, key, now):
        """Single source of truth for 'does key exist at time now'."""
        rec = self._d.get(key)
        if rec is None:
            return None
        if rec[1] is not None and now >= rec[1]:
            del self._d[key]                        # lazy expiry on touch
            return None
        return rec

    # ---- Level 1 ----------------------------------------------------------
    def set(self, key, value, now=0):
        with self._lock:
            self._purge(now)
            self._d[key] = (value, None)

    def get(self, key, now=0):
        with self._lock:
            self._purge(now)
            rec = self._live(key, now)
            return rec[0] if rec else None

    def delete(self, key, now=0):
        with self._lock:
            self._purge(now)
            return self._d.pop(key, None) is not None

    # ---- Level 2 ----------------------------------------------------------
    def set_with_ttl(self, key, value, ttl, now):
        if ttl <= 0:
            raise ValueError("ttl must be positive")
        with self._lock:
            self._purge(now)
            expiry = now + ttl
            self._d[key] = (value, expiry)
            heapq.heappush(self._heap, (expiry, key))

    # ---- Level 3 ----------------------------------------------------------
    def scan(self, prefix, now):
        with self._lock:
            self._purge(now)
            # list() because _live may delete while we iterate
            return sorted(k for k in list(self._d)
                          if k.startswith(prefix) and self._live(k, now))

    # ---- Level 4 ----------------------------------------------------------
    def backup(self, now):
        """Snapshot of live records; TTLs stored as REMAINING time."""
        with self._lock:
            self._purge(now)
            out = {}
            for k in list(self._d):
                rec = self._live(k, now)
                if rec:
                    v, exp = rec
                    out[k] = (v, None if exp is None else exp - now)
            return out

    def restore(self, now, backup):
        """Remaining TTLs re-anchored at restore time."""
        with self._lock:
            self._d = {}
            self._heap = []
            for k, (v, remaining) in backup.items():
                if remaining is None:
                    self._d[k] = (v, None)
                else:
                    exp = now + remaining
                    self._d[k] = (v, exp)
                    heapq.heappush(self._heap, (exp, k))
```

<h4>Nested variant (key → field → value)</h4>
<p>Some reports describe the store as two-level: <code>set(key, field, value)</code>, <code>get(key, field)</code>, <code>delete(key, field)</code>, with TTLs per field and <code>scan(key)</code> returning "field(value)" strings sorted by field. Same skeleton — the dict becomes <code>key → {field → (value, expiry)}</code>, <code>_live</code> takes <code>(key, field)</code>, and an outer key is "absent" when its field dict is empty after expiry. If you built L1 with the centralized-liveness pattern, this refactor is 10 minutes; if you scattered expiry checks, it's a rewrite — which is precisely what the level structure is testing.</p>
<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>Complexity:</strong> get/set O(1) amortized; scan O(n log n) for the sort (offer a sorted container or trie if scan must be O(matches)); eager purge amortized O(log n) per expiring key.</li>
<li><strong>The stale-heap-entry trap:</strong> if key X gets a new TTL, the old heap entry must not delete the new record — hence re-checking <code>rec[1] == exp</code> on pop. Say this unprompted.</li>
<li><strong>Backup semantics:</strong> "remaining TTL" vs "absolute expiry" is the whole point of L4 — restate it before coding, in one sentence, and confirm.</li>
<li><strong>Locking:</strong> one <code>RLock</code> around every public method is the right first answer (correct, simple). Sharding the keyspace across N locks is the scaling answer; per-key locks are over-engineering here.</li>
</ul></div>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> <code>get/set/delete</code> O(1) average (dict); <code>set_with_ttl</code> O(log n) for the heap push; <code>scan</code> O(n + m log m) — filter all n keys, sort the m matches; <code>backup/restore</code> O(n log n). Eager purge is <strong>amortized</strong> O(log n) per expiring key: each TTL write is pushed once and popped once, ever. <strong>Space:</strong> O(live keys + pending heap entries) — stale heap entries are bounded by total TTL writes and cleaned on pop.</p><p><strong>How efficient is it?</strong> Optimal for the operations as specified. The only improvable piece is <code>scan</code>: a trie or sorted-key structure makes it O(matches) instead of O(all keys), worth mentioning if scans dominate. Lazy + eager expiry combined means no background timer thread and no unbounded memory — the two failure modes the follow-ups hunt for.</p></div>

</div>
