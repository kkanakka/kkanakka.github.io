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

### The approach

<img src="/diagrams/arcoding/s1.svg" alt="Every operation is given the current time and purges due leases from an expiry heap, tolerating stale entries by re-checking the dict, with backup storing remaining rather than absolute TTL." class="doc-diagram doc-diagram-seq" />

<p>The dict holds values and expiry times; a heap ordered by expiry makes it cheap to find what is due without scanning. Because you cannot remove an arbitrary entry from a heap, an overwritten key leaves a <strong>stale entry that is simply dropped on pop</strong> after re-checking the dict — lazy deletion, and far cheaper than keeping the heap exact. Backup stores <em>remaining</em> TTL rather than absolute expiry, so a restore at any later time re-anchors every lease correctly.</p>

### What it looks like in memory

<p>The store at <code>now = 109</code> from <em>Run it</em>, and what backup and restore do to the TTLs.</p>

<img src="/diagrams/arcoding-state/s1.svg" alt="The value-and-expiry dict beside the expiry heap, and what backup stores instead of absolute times." class="doc-diagram doc-diagram-seq" />
<h4>Design decisions before typing</h4>
<ul>
<li>Store <strong>absolute expiry timestamps</strong>, never countdowns — every question about "is this alive at time t" becomes one comparison, and backup/restore becomes arithmetic.</li>
<li>Centralize liveness in one <code>_live()</code> helper. The classic failure is re-implementing the expiry check slightly differently in <code>get</code>, <code>scan</code>, and <code>backup</code> — one of them will disagree under a test.</li>
<li>Expire <strong>lazily</strong> first (delete on touch); add a heap for eager expiry only when asked. Lazy is 10 lines and correct; eager is an optimization with an invalidation subtlety (overwritten keys leave stale heap entries).</li>
</ul>
<h4>Full solution (all levels + follow-ups)</h4>

```python
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
        """Store a key with no expiry.

        Example:
            >>> kv = KVStore()
            >>> kv.set('region', 'us-east-1', now=0)
            >>> kv.get('region', now=0)
            'us-east-1'
        """
        with self._lock:
            self._purge(now)
            self._d[key] = (value, None)

    def get(self, key, now=0):
        """Value for key at time now, or None if absent or expired.

        Example:
            >>> kv = KVStore()
            >>> kv.set('k', 'v', now=0)
            >>> kv.get('k', now=0)
            'v'
            >>> kv.get('missing', now=0)   # -> None
        """
        with self._lock:
            self._purge(now)
            rec = self._live(key, now)
            return rec[0] if rec else None

    def delete(self, key, now=0):
        """Remove a key; returns whether it existed.

        Example:
            >>> kv = KVStore()
            >>> kv.set('k', 'v', now=0)
            >>> kv.delete('k', now=0)
            True
            >>> kv.delete('k', now=0)
            False
        """
        with self._lock:
            self._purge(now)
            return self._d.pop(key, None) is not None

    # ---- Level 2 ----------------------------------------------------------
    def set_with_ttl(self, key, value, ttl, now):
        """Store a key that expires ttl after now.

        Example:
            >>> kv = KVStore()
            >>> kv.set_with_ttl('s', 'v', ttl=10, now=100)
            >>> kv.get('s', now=105)
            'v'
            >>> kv.get('s', now=110)   # -> None
        """
        if ttl <= 0:
            raise ValueError("ttl must be positive")
        with self._lock:
            self._purge(now)
            expiry = now + ttl
            self._d[key] = (value, expiry)
            heapq.heappush(self._heap, (expiry, key))

    # ---- Level 3 ----------------------------------------------------------
    def scan(self, prefix, now):
        """Sorted live keys with the given prefix at time now.

        Example:
            >>> kv = KVStore()
            >>> kv.set('a:1', 'x', now=0); kv.set('a:2', 'y', now=0)
            >>> kv.scan('a:', now=0)
            ['a:1', 'a:2']
        """
        with self._lock:
            self._purge(now)
            # list() because _live may delete while we iterate
            return sorted(k for k in list(self._d)
                          if k.startswith(prefix) and self._live(k, now))

    # ---- Level 4 ----------------------------------------------------------
    def backup(self, now):
        """Snapshot of live records; TTLs stored as REMAINING time.

        Example:
            >>> kv = KVStore()
            >>> kv.set_with_ttl('s', 'v', ttl=50, now=100)
            >>> kv.backup(now=120)
            {'s': ('v', 30)}
        """
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
        """Remaining TTLs re-anchored at restore time.

        Example:
            >>> kv = KVStore()
            >>> snap = {'s': ('v', 30)}
            >>> kv.restore(now=1000, backup=snap)
            >>> kv.get('s', now=1029)
            'v'
            >>> kv.get('s', now=1030)   # -> None
        """
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

### Run it

<p class="covers">Append this to the code above, save as <code>s1_kvstore.py</code>, then run <code>python s1_kvstore.py</code>.</p>

```python
if __name__ == "__main__":
    kv = KVStore()

    print("--- Level 1: set / get / delete ---")
    kv.set("region", "us-east-1", now=0)
    print("get region   :", kv.get("region", now=0))
    print("delete region:", kv.delete("region", now=0))
    print("get after del:", kv.get("region", now=0))
    print("delete again :", kv.delete("region", now=0))

    print("\n--- Level 2: TTL (now only ever moves forward) ---")
    kv.set_with_ttl("session:a", "alice", ttl=10, now=100)   # expires at 110
    kv.set_with_ttl("session:b", "bob",   ttl=50, now=100)   # expires at 150
    kv.set("session:c", "carol", now=100)                    # no TTL: immortal

    def snapshot(t):
        print(f"t={t:<4} a={kv.get('session:a', t)!r:<8} "
              f"b={kv.get('session:b', t)!r:<7} c={kv.get('session:c', t)!r}")

    snapshot(100)
    snapshot(109)
    print("scan @109:", kv.scan("session:", 109))

    snapshot(110)                                            # a's lease is up
    print("scan @120:", kv.scan("session:", 120))

    try:
        kv.set_with_ttl("x", "y", ttl=0, now=120)
    except ValueError as e:
        print("ValueError:", e)

    print("\n--- Level 4: backup stores REMAINING ttl, not absolute expiry ---")
    snap = kv.backup(now=120)                                # b has 30 left
    print("snapshot:", snap)

    restored = KVStore()
    restored.restore(now=1000, backup=snap)                  # restored far later
    print("b @1000 :", restored.get("session:b", 1000))      # 30s from restore
    print("b @1029 :", restored.get("session:b", 1029))
    print("b @1030 :", restored.get("session:b", 1030))
    print("c @9999 :", restored.get("session:c", 9999))

    snapshot(150)                                            # original store
```

<p><strong>Output</strong></p>

```text
--- Level 1: set / get / delete ---
get region   : us-east-1
delete region: True
get after del: None
delete again : False

--- Level 2: TTL (now only ever moves forward) ---
t=100  a='alice'  b='bob'   c='carol'
t=109  a='alice'  b='bob'   c='carol'
scan @109: ['session:a', 'session:b', 'session:c']
t=110  a=None     b='bob'   c='carol'
scan @120: ['session:b', 'session:c']
ValueError: ttl must be positive

--- Level 4: backup stores REMAINING ttl, not absolute expiry ---
snapshot: {'session:b': ('bob', 30), 'session:c': ('carol', None)}
b @1000 : bob
b @1029 : bob
b @1030 : None
c @9999 : carol
t=150  a=None     b=None    c='carol'
```

</div>
