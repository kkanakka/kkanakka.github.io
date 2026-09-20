---
title: "B3 · LRU cache → memo decorator (args/kwargs) → crash-resilient persistence"
slug: /coding/arcoding/b3-lru-cache-memo-decorator-args-kwargs-crash-resilient-pers
sidebar_position: 10
sidebar_label: "B3 · LRU cache → memo decorator (args/kwarg…"
description: "B3 · LRU cache → memo decorator (args/kwargs) → crash-resilient persistence"
---

<div class="arcoding">

## B3 · LRU cache → memo decorator (args/kwargs) → crash-resilient persistence

<p class="covers">Covers 8 variants: LRU Cache · Implement a Least-Recently-Used Cache · crash-resilient LRU · Persistent Memoization LRU · Python LRU with args and persistence · Python LRU with varargs · recency-eviction bounded cache · Build an LRU cache.</p>
<h4>Level 1 — the O(1) structure, hand-rolled</h4>
<p>Lead with <code>OrderedDict</code> for speed, but the interviewer may ask for the underlying structure — hash map + doubly linked list with sentinel nodes (sentinels remove every null-check special case):</p>

```python
class _Node:
    __slots__ = ("key", "val", "prev", "next")
    def __init__(self, key=None, val=None):
        self.key, self.val = key, val
        self.prev = self.next = None


class LRUCache:
    """get/put in O(1). head side = most recent, tail side = least recent."""
    def __init__(self, capacity: int):
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self.cap = capacity
        self.map = {}                       # key -> _Node
        self.head, self.tail = _Node(), _Node()   # sentinels
        self.head.next, self.tail.prev = self.tail, self.head

    def _unlink(self, node):
        node.prev.next, node.next.prev = node.next, node.prev

    def _push_front(self, node):
        node.next, node.prev = self.head.next, self.head
        self.head.next.prev = node
        self.head.next = node

    def get(self, key):
        node = self.map.get(key)
        if node is None:
            return -1
        self._unlink(node)
        self._push_front(node)              # touching = most recent
        return node.val

    def put(self, key, val):
        node = self.map.get(key)
        if node is not None:
            node.val = val
            self._unlink(node)
            self._push_front(node)
            return
        if len(self.map) >= self.cap:
            lru = self.tail.prev            # evict least recent
            self._unlink(lru)
            del self.map[lru.key]
        node = _Node(key, val)
        self.map[key] = node
        self._push_front(node)
```

<h4>Levels 2–3 — memoization decorator with kwargs, thread safety, atomic persistence</h4>

```python
import functools
import json
import os
import tempfile
import threading
from collections import OrderedDict


def lru_memo(maxsize=128, path=None):
    """@lru_memo(256, path='cache.json')
    - deterministic keys: f(a=1, b=2) and f(b=2, a=1) hit the same entry
    - thread-safe
    - crash-resilient persistence: write-temp + atomic rename, so the file
      on disk is always either the old snapshot or the new one, never a
      torn write."""
    def deco(fn):
        store = OrderedDict()
        lock = threading.Lock()

        if path and os.path.exists(path):
            try:
                with open(path) as f:
                    store.update(json.load(f))
            except (OSError, ValueError):
                pass                        # corrupt/partial cache: start clean

        def make_key(args, kwargs):
            # sorted kwargs => order-insensitive; json => survives disk;
            # default=str is the honest fallback for non-JSON types (note
            # aloud: only safe if str() is faithful for the arg types used).
            return json.dumps([args, sorted(kwargs.items())],
                              separators=(",", ":"), default=str)

        def flush_locked():
            if not path:
                return
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".")
            try:
                with os.fdopen(fd, "w") as f:
                    json.dump(list(store.items()), f)
                os.replace(tmp, path)       # atomic on POSIX + Windows
            except OSError:
                try: os.unlink(tmp)
                except OSError: pass

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            k = make_key(args, kwargs)
            with lock:
                if k in store:
                    store.move_to_end(k)
                    wrapper.hits += 1
                    return store[k]
            v = fn(*args, **kwargs)         # compute OUTSIDE the lock
            with lock:
                store[k] = v
                store.move_to_end(k)
                while len(store) > maxsize:
                    store.popitem(last=False)
                wrapper.misses += 1
                flush_locked()
            return v

        wrapper.hits = wrapper.misses = 0
        wrapper.cache_clear = lambda: (store.clear(), flush_locked())
        return wrapper
    return deco
```

<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>Key determinism</strong> is the core of the kwargs level: unsorted kwargs, or keys built with <code>str(args)</code> (collides <code>(1,)</code> vs <code>("1",)</code> — json distinguishes them) fail hidden tests. Also name the unhashable-arg problem: lists/dicts as args need canonicalization, which json gives you.</li>
<li><strong>"Crash-resilient" = atomic rename</strong>, not "call flush a lot." Truncate-then-write leaves an empty file if you die mid-write; temp+<code>os.replace</code> cannot.</li>
<li><strong>Computing outside the lock</strong> trades a thundering-herd risk (two threads compute the same miss) for no lock-held user code. Name the tradeoff; per-key locks or futures-in-cache is the fix if they push (that's what a request-coalescing cache does).</li>
<li><strong>Flush cost:</strong> O(cache) per miss; batch (flush every N mutations / on interval / atexit) is the production answer — offer it.</li>
</ul></div>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> <code>get/put</code> O(1) — the hash map finds the node, the linked list (or OrderedDict) splices in O(1). The memo wrapper adds O(size of args) per call for key serialization. Persistence as written is O(cache size) per <em>miss</em> — the honest inefficiency; batching flushes (every N mutations, on interval, atexit) amortizes it to near-zero.</p><p><strong>How efficient is it?</strong> O(1) per operation is optimal for LRU semantics, and both implementations (DLL and OrderedDict) achieve it — the DLL just proves you know why. Space is O(capacity) entries plus serialized keys; note aloud that JSON keys cost memory proportional to argument size, so huge-argument functions want hashed keys (with the collision caveat).</p></div>

</div>
