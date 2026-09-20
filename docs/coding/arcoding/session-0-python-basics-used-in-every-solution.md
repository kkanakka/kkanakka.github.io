---
title: "Session 0 · Python basics used in every solution"
slug: /coding/arcoding/session-0-python-basics-used-in-every-solution
sidebar_position: 2
sidebar_label: "Session 0 · Python basics used in every sol…"
description: "Session 0 · Python basics used in every solution"
---

<div class="arcoding">

## Session 0 · Python basics used in every solution

<p class="lede">Every construct that appears in the 21 solutions, taught with tiny commented examples. Work through this once before the coding sections; each mini-lesson says exactly which questions use it.</p>
<h3 id="py-dicts">0.1 Dictionaries, <code>defaultdict</code>, <code>Counter</code></h3>
<p class="covers">Used in: almost everything — S1, S4, B2, B5, B7, B11 …</p>
<p>A dict maps keys to values. <code>defaultdict</code> is a dict that auto-creates a starting value the first time you touch a missing key — it removes the "does the key exist yet?" boilerplate. <code>Counter</code> is a dict specialized for counting.</p>

```python
# --- plain dict -----------------------------------------------------
d = {}                      # empty dict
d["alice"] = 100            # add / overwrite a key
d.get("bob")                # -> None      (missing key: no crash)
d.get("bob", 0)             # -> 0         (missing key: your default)
d.pop("alice", None)        # remove a key; None if it wasn't there
"alice" in d                # -> False     (membership test)

for key, value in d.items():        # loop over pairs
    print(key, value)

# --- defaultdict: auto-initializing dict ----------------------------
from collections import defaultdict

spent = defaultdict(int)    # missing keys start at int() == 0
spent["alice"] += 50        # no need to check if "alice" exists first!
spent["alice"] += 25        # -> 75

groups = defaultdict(list)  # missing keys start at list() == []
groups["small"].append("a") # append without creating the list yourself

# --- Counter: a dict made for counting ------------------------------
from collections import Counter

status_count = Counter()
status_count["healthy"] += 1
status_count["healthy"] += 1
status_count["down"] += 1
status_count["healthy"]     # -> 2
status_count.get("gone", 0) # -> 0 (safe read of missing key)
```

<div class="adm tip"><div class="adm-title">💡 In the solutions</div>
<p>B5 uses <code>defaultdict(int)</code> for per-account spend totals; B7 uses <code>defaultdict(list)</code> to group file paths by size/hash; B11 uses <code>Counter</code> for nodes-per-status. The pattern to internalize: <em>grouping things by a key</em> is always <code>defaultdict(list)</code> + <code>append</code>.</p></div>
<div class="card"><h4 style="margin-top:0">🎯 5 things they commonly ask about dicts &amp; Counter</h4>

```python
# Q1) Count word frequencies; return the top 3.
from collections import Counter
words = "the cat and the hat and the bat".split()
Counter(words).most_common(3)        # [('the', 3), ('and', 2), ('cat', 1)]

# Q2) Group words by their first letter.
from collections import defaultdict
groups = defaultdict(list)
for w in ["apple", "ant", "bee"]:
    groups[w[0]].append(w)           # {'a': ['apple','ant'], 'b': ['bee']}

# Q3) Invert a dict (values become keys).
inv = {v: k for k, v in d.items()}   # careful: duplicate values collide

# Q4) Merge two score dicts, summing shared keys.
total = Counter(day1) + Counter(day2)

# Q5) First non-repeating character in a string.
def first_unique(s):
    counts = Counter(s)              # pass 1: count everything
    for ch in s:                     # pass 2: original order
        if counts[ch] == 1:
            return ch
    return None
```

</div>
<h3 id="py-sort">0.2 Tuples, unpacking, and sorting with a key</h3>
<p class="covers">Used in: B1 (samples), B2 (events), B5 (top spenders), B12 (heap entries)</p>
<p>A tuple is a fixed little bundle of values: <code>(timestamp, name)</code>. Two superpowers: they <em>unpack</em> into variables, and they compare element-by-element — which is how you sort by multiple criteria at once.</p>

```python
record = (1200, "deposit", 50)      # a tuple: time, kind, amount
t, kind, amount = record            # UNPACKING: three variables at once

for t, stack in samples:            # unpack right in the for-loop header
    ...                             # (this is all over B1 and B2)

# --- tuples compare left-to-right -----------------------------------
(1, "b") < (2, "a")                 # True: 1 < 2, second item never checked
(1, "b") < (1, "c")                 # True: tie on 1, so "b" vs "c" decides

# --- sorting with a key function ------------------------------------
spend = {"bob": 300, "amy": 300, "cat": 100}

# "sort by amount DESCENDING, ties broken alphabetically":
# build a tuple per item; negate the number to flip its direction.
ranked = sorted(spend.items(),                 # [("bob",300), ...]
                key=lambda kv: (-kv[1], kv[0]))  # (-amount, name)
# -> [("amy", 300), ("bob", 300), ("cat", 100)]

# lambda is just a one-line unnamed function:
# lambda kv: (-kv[1], kv[0])   ==   def f(kv): return (-kv[1], kv[0])
```

<div class="adm tip"><div class="adm-title">💡 In the solutions</div>
<p>B5's <code>top_spenders</code> is exactly the <code>(-amount, name)</code> trick — descending by spend, ascending by name on ties. Heaps (next lessons) rely on tuple comparison too: <code>(due_time, seq, ...)</code> orders by time first, insertion order on ties.</p></div>
<div class="card"><h4 style="margin-top:0">🎯 5 things they commonly ask about sorting</h4>

```python
# Q1) Sort people by age DESC, then name ASC.   p = (name, age)
people.sort(key=lambda p: (-p[1], p[0]))

# Q2) Sort words by length, ties alphabetically.
sorted(words, key=lambda w: (len(w), w))

# Q3) Top 3 accounts by balance.
top3 = sorted(bal.items(), key=lambda kv: -kv[1])[:3]
# huge dict? heapq.nlargest(3, bal.items(), key=lambda kv: kv[1])

# Q4) Sort a list of dicts by a field.
rows.sort(key=lambda r: r["created_at"])

# Q5) Evens first, odds after, ORIGINAL order kept within each group.
nums.sort(key=lambda x: x % 2)       # Python's sort is STABLE:
                                     # equal keys keep their order
```

</div>
<h3 id="py-comp">0.3 Comprehensions, generators, and <code>for/else</code></h3>
<p class="covers">Used in: S1 (scan), B1, B6 (frontier), B9 (tokenizer), B13</p>

```python
nums = [3, 1, 4, 1, 5]

# --- list comprehension: build a list in one line -------------------
doubled = [n * 2 for n in nums]            # [6, 2, 8, 2, 10]
evens   = [n for n in nums if n % 2 == 0]  # [4]  (filter with if)

# reads as: "n*2  FOR each n in nums  IF condition"

# --- from the guide (S1.scan): filter + transform + sort ------------
live_keys = sorted(k for k in d            # generator: no [] needed
                   if k.startswith(prefix))

# --- dict comprehension (S1.backup) ---------------------------------
remaining = {k: expiry - now for k, expiry in leases.items()}

# --- flattening nested lists (B6: merge worker results) -------------
batches = [["a", "b"], ["c"], []]
flat = [url for batch in batches for url in batch]   # ["a","b","c"]
# read left to right: "for each batch..., for each url in that batch"

# --- for/else: 'else' runs ONLY if the loop never hit `break` -------
for length in range(5, 0, -1):     # 5,4,3,2,1  (start, stop, step)
    if is_match(length):
        use(length)
        break                      # found one -> skip the else
else:
    handle_no_match()              # loop finished without break
```

<div class="adm tip"><div class="adm-title">💡 In the solutions</div>
<p><code>for/else</code> is the heart of B9's tokenizer: try every length longest-first; the <code>else</code> branch is "nothing in the vocab matched here." It reads oddly at first — think of <code>else</code> as <em>"no break happened."</em></p></div>
<div class="card"><h4 style="margin-top:0">🎯 5 things they commonly ask about comprehensions</h4>

```python
# Q1) Squares of only the even numbers.
[n * n for n in nums if n % 2 == 0]

# Q2) Flatten one level of nesting.
[x for row in matrix for x in row]

# Q3) Build a dict from two parallel lists.
dict(zip(keys, values))

# Q4) Transpose a matrix (rows become columns).
list(zip(*matrix))                   # * unpacks the rows as arguments

# Q5) FIRST item matching a condition, or a default — no full scan.
first_admin = next((u for u in users if u.is_admin), None)
# next(generator, default) stops at the first hit
```

</div>
<h3 id="py-ordered">0.4 <code>OrderedDict</code> — a dict that remembers order</h3>
<p class="covers">Used in: B3 (the entire LRU family)</p>
<p>Modern dicts keep insertion order, but <code>OrderedDict</code> adds two methods that make an LRU cache almost free: move a key to the end, and pop from either end.</p>

```python
from collections import OrderedDict

cache = OrderedDict()
cache["a"] = 1              # order now: a
cache["b"] = 2              # order now: a, b
cache["c"] = 3              # order now: a, b, c

cache.move_to_end("a")      # "a" was just USED -> most recent
                            # order now: b, c, a

cache.popitem(last=False)   # pop the FRONT = least-recently-used ("b")
cache.popitem(last=True)    # pop the BACK  = most-recent ("a")

# The whole LRU idea in 4 lines:
#   on get(k):  move_to_end(k)              (mark as freshly used)
#   on put(k):  insert, move_to_end(k),
#               if too big: popitem(last=False)   (evict the stalest)
```

<div class="card"><h4 style="margin-top:0">🎯 5 things they commonly ask about OrderedDict / caches</h4>

```python
# Q1) Evict the least-recently-used entry.
cache.popitem(last=False)

# Q2) FIFO cache vs LRU cache — the one-line difference?
# LRU calls move_to_end(key) on every GET; FIFO never reorders.

# Q3) Mark a key as freshly used.
cache.move_to_end(key)

# Q4) Keep only the N most recent items while inserting.
cache[k] = v
if len(cache) > N:
    cache.popitem(last=False)

# Q5) "Would you hand-roll this in production?"  No:
from functools import lru_cache
@lru_cache(maxsize=256)              # built-in memoization —
def fib(n): ...                      # hand-roll only when asked to
```

</div>
<h3 id="py-heapq">0.5 <code>heapq</code> — always know the smallest item</h3>
<p class="covers">Used in: S1 (eager expiry), B5 (scheduled cashback), B12 (expiring grants)</p>
<p>A heap is a list kept arranged so the <em>smallest</em> element is always at index 0. Push and pop cost O(log n). Store tuples and the heap orders by the first element (ties fall to the second — hence the <code>seq</code> counters you see everywhere).</p>

```python
import heapq

h = []                          # a heap is just a list + the heapq functions
heapq.heappush(h, (300, "pay-rent"))    # (priority, data)
heapq.heappush(h, (100, "wake-up"))
heapq.heappush(h, (200, "coffee"))

h[0]                            # (100, "wake-up")  -- peek, no removal
heapq.heappop(h)                # (100, "wake-up")  -- remove smallest
heapq.heappop(h)                # (200, "coffee")

# --- the pattern from B5/B12: "process everything that is due" ------
sched = []                      # entries: (due_time, seq, payload)
seq = 0                         # tie-breaker: same due_time -> FIFO
def schedule(due, payload):
    global seq
    seq += 1
    heapq.heappush(sched, (due, seq, payload))

def settle(now):
    # keep popping while the SMALLEST due time has arrived
    while sched and sched[0][0] <= now:
        due, _, payload = heapq.heappop(sched)
        apply(payload)          # e.g. credit the cashback

# Why the seq? Without it, equal due times make the heap compare the
# payloads — which may not be comparable at all (TypeError).
```

<div class="card"><h4 style="margin-top:0">🎯 5 things they commonly ask about heaps</h4>

```python
# Q1) The 3 smallest / 3 largest.
heapq.nsmallest(3, nums)
heapq.nlargest(3, scores.items(), key=lambda kv: kv[1])

# Q2) Python's heap is MIN-only — how do you get a max-heap?
heapq.heappush(h, -value)            # negate on push...
biggest = -heapq.heappop(h)          # ...and again on pop

# Q3) Merge k already-sorted lists into one sorted stream.
merged = list(heapq.merge(a, b, c))  # O(n log k), lazy

# Q4) Peek at the smallest without removing it.
smallest = h[0]

# Q5) Priority queue with FIFO ties (the guide's scheduling pattern).
seq += 1
heapq.heappush(h, (priority, seq, task))
```

</div>
<h3 id="py-bisect">0.6 <code>bisect</code> — binary search on a sorted list</h3>
<p class="covers">Used in: B4 (versioned reads), B5 (historical balance), B11 (status_at)</p>
<p>Given a sorted list, <code>bisect_right(a, x)</code> returns the index where <code>x</code> would be inserted to keep it sorted, after any equal values. That gives you the guide's most repeated query — <em>"latest entry at or before time t"</em> — in O(log n):</p>

```python
import bisect

timestamps = [10, 20, 30, 40]        # MUST already be sorted
values     = ["a", "b", "c", "d"]    # values[i] written at timestamps[i]

def value_at(t):
    """The value visible at time t = last write with timestamp <= t."""
    i = bisect.bisect_right(timestamps, t)   # count of entries <= t
    if i == 0:
        return None            # t is before the first write: nothing yet
    return values[i - 1]       # the last one at-or-before t

value_at(25)    # -> "b"   (write at 20 is the latest <= 25)
value_at(30)    # -> "c"   (bisect_RIGHT includes an exact hit)
value_at(5)     # -> None

# bisect.insort(a, x) inserts x keeping the list sorted (B11 history)
```

<div class="adm tip"><div class="adm-title">💡 The one detail that matters</div>
<p><code>bisect_right</code> vs <code>bisect_left</code> differ only when <code>t</code> exactly equals a stored timestamp: <code>right</code> means "a write AT time t is visible at time t" — which is what B4/B5 want. Draw the four-element picture above once and this never confuses you again.</p></div>
<div class="card"><h4 style="margin-top:0">🎯 5 things they commonly ask about binary search</h4>

```python
# Q1) Insert into a sorted list, keeping it sorted.
bisect.insort(a, x)                  # O(log n) find + O(n) shift

# Q2) How many elements are strictly < x?
bisect.bisect_left(a, x)

# Q3) How many elements fall inside [lo, hi]?
bisect.bisect_right(a, hi) - bisect.bisect_left(a, lo)

# Q4) Latest snapshot at-or-before time t (the B4/B5 query).
i = bisect.bisect_right(ts, t)
value = vals[i - 1] if i else None

# Q5) Closest value to x in a sorted list.
i = bisect.bisect_left(a, x)
best = min(a[max(0, i - 1):i + 1], key=lambda v: abs(v - x))
```

</div>
<h3 id="py-classes">0.7 Classes, <code>self</code>, dataclasses, <code>__slots__</code></h3>
<p class="covers">Used in: every solution that says <code>class</code> — S1, S2, S3, B3, B5 …</p>

```python
# --- the anatomy every solution shares ------------------------------
class Bank:
    def __init__(self):          # runs when you do Bank()
        self.balances = {}       # `self.x` = data stored ON this object
        self._seq = 0            # leading _ = "internal, don't touch"

    def deposit(self, acct, amt):   # every method takes `self` first
        self.balances[acct] = self.balances.get(acct, 0) + amt
        return self.balances[acct]

b = Bank()                       # calls __init__
b.deposit("alice", 50)           # Python passes b as `self` for you

# --- dataclass: a class that is mostly just fields (S3.Stats) -------
from dataclasses import dataclass, field

@dataclass
class Stats:
    ok: int = 0                  # fields with defaults; __init__ is
    failed: int = 0              # auto-generated for you
    tags: list = field(default_factory=list)   # NEVER `tags: list = []`
    # (a plain [] default would be SHARED by every instance — classic bug)

# --- __slots__: fixed field list, less memory per object (B3._Node) --
class _Node:
    __slots__ = ("key", "val", "prev", "next")   # only these attrs allowed
    # matters when you create millions of tiny objects (cache nodes)
```

<div class="card"><h4 style="margin-top:0">🎯 5 things they commonly ask about classes</h4>

```python
# Q1) Make objects print readably while debugging.
def __repr__(self):
    return f"Node(key={self.key!r}, val={self.val!r})"

# Q2) Make instances heap-able / sortable.
def __lt__(self, other):
    return self.due < other.due      # now heapq can compare them

# Q3) A dataclass that sorts by one field automatically.
@dataclass(order=True)
class Job:
    priority: int
    name: str = field(compare=False)  # excluded from comparisons

# Q4) A computed attribute that looks like a field.
@property
def full_name(self):
    return f"{self.first} {self.last}"

# Q5) An alternate constructor.
@classmethod
def from_json(cls, s):
    return cls(**json.loads(s))
```

</div>
<h3 id="py-except">0.8 Exceptions — <code>try / except / finally / raise</code></h3>
<p class="covers">Used in: S3 (retries), B3 (loading a corrupt cache), B7 (files vanishing), B8 (bad images)</p>

```python
# --- catch and recover ----------------------------------------------
try:
    size = os.path.getsize(path)
except OSError:                  # file vanished / no permission
    continue                     # skip this file, keep the batch going
                                 # (B7: one bad file must not kill the run)

# --- finally: ALWAYS runs, even after an exception ------------------
msg = q.get()
try:
    process(msg)
finally:
    q.task_done()                # S3: the ack must happen no matter what

# --- raise your own errors with a custom type -----------------------
class LogError(ValueError):      # subclassing gives callers something
    pass                         # specific to catch

if kind not in ("START", "END"):
    raise LogError(f"unknown event kind {kind!r}")   # !r shows quotes

# --- the retry loop shape (S3) --------------------------------------
for attempt in range(max_retries + 1):
    try:
        do_the_thing()
        break                    # success: stop retrying
    except Exception:
        if attempt == max_retries:
            dead_letter()        # out of retries: record, don't crash
        else:
            time.sleep(0.1 * 2 ** attempt)   # exponential backoff
```

<div class="adm tip"><div class="adm-title">💡 Interview rule of thumb</div>
<p>Catch the <em>narrowest</em> exception that matches the failure you expect (<code>OSError</code> for files, <code>ValueError</code> for bad data). A bare <code>except Exception</code> is acceptable only at a boundary whose job is "isolate this task's failure" — B8's per-image worker — and say that's why.</p></div>
<div class="card"><h4 style="margin-top:0">🎯 5 things they commonly ask about exceptions</h4>

```python
# Q1) Handle two failure kinds differently.
try:
    v = int(text)
except ValueError:                   # bad data: recover
    v = 0
except TypeError:                    # wrong type: not ours to hide
    raise

# Q2) try/else — run code only if NOTHING failed.
try:
    f = open(path)
except OSError:
    use_default()
else:                                # no exception happened
    with f:
        process(f)

# Q3) A custom exception that carries data.
class QuotaExceeded(Exception):
    def __init__(self, used, limit):
        super().__init__(f"{used}/{limit}")
        self.used, self.limit = used, limit

# Q4) Log and re-raise WITHOUT losing the traceback.
except Exception:
    log.exception("worker failed")
    raise                            # bare raise keeps the traceback

# Q5) Guarantee cleanup even on a crash.
finally:
    conn.close()
```

</div>
<h3 id="py-files">0.9 Files, <code>with</code> blocks, and reading in chunks</h3>
<p class="covers">Used in: B3 (persistence), B7 (hashing huge files)</p>

```python
# --- `with` = open, and GUARANTEE the close, even on errors ---------
with open("data.txt") as f:      # text mode
    text = f.read()              # whole file at once (small files only!)

# --- binary + chunked: constant memory for any file size (B7) -------
import hashlib
h = hashlib.sha256()
with open(path, "rb") as f:      # "rb" = read bytes
    while True:
        block = f.read(1 << 20)  # 1 << 20 = 2**20 = 1 MB at a time
        if not block:            # empty bytes = end of file
            break
        h.update(block)          # feed the hash incrementally
digest = h.hexdigest()

# --- atomic save (B3): temp file + rename, never truncate-in-place --
import os, tempfile, json
fd, tmp = tempfile.mkstemp(dir=".")
with os.fdopen(fd, "w") as f:
    json.dump(data, f)
os.replace(tmp, "cache.json")    # atomic: readers see old OR new,
                                 # never a half-written file
```

<div class="card"><h4 style="margin-top:0">🎯 5 things they commonly ask about files</h4>

```python
# Q1) Count lines without loading the whole file.
with open(path) as f:
    n = sum(1 for _ in f)            # file objects iterate line by line

# Q2) Process a huge file with constant memory.
with open(path) as f:
    for line in f:
        handle(line.rstrip("\n"))

# Q3) Write JSON, human-readable.
with open("out.json", "w") as f:
    json.dump(data, f, indent=2)

# Q4) Walk a directory tree (B7's first step).
for dirpath, dirnames, filenames in os.walk(root):
    for name in filenames:
        full = os.path.join(dirpath, name)

# Q5) Copy a binary file in chunks — no memory blow-up.
with open(src, "rb") as fin, open(dst, "wb") as fout:
    while chunk := fin.read(1 << 20):   # := assigns AND tests
        fout.write(chunk)
```

</div>
<h3 id="py-threads">0.10 Threads — <code>Lock</code>, <code>with lock</code>, <code>Condition</code></h3>
<p class="covers">Used in: S1, S2, B3, B6 (crawler), B15 (blocking queue)</p>
<p>Threads run functions "at the same time." When two threads touch the same data, you need a <code>Lock</code> so their read-modify-write steps don't interleave. Python's GIL means threads don't speed up pure CPU work — but they're great for I/O (network, disk), because waiting threads release the GIL.</p>

```python
import threading

counter = 0
lock = threading.Lock()

def add_many():
    global counter
    for _ in range(100_000):
        with lock:               # acquire ... release, automatically,
            counter += 1         # even if an exception happens inside

# Without the lock, `counter += 1` is three steps (read, add, write) —
# two threads interleave them and updates get LOST.

t1 = threading.Thread(target=add_many)
t2 = threading.Thread(target=add_many)
t1.start(); t2.start()           # run both
t1.join();  t2.join()            # wait for both to finish
print(counter)                   # 200000, every time — because of the lock

# --- Condition: "sleep until a fact becomes true" (B15) -------------
cond = threading.Condition()     # a lock + a waiting room
items = []

def consumer():
    with cond:
        while not items:         # WHILE, never IF: re-check after waking
            cond.wait()          # releases the lock, sleeps, re-acquires
        item = items.pop()

def producer(x):
    with cond:
        items.append(x)
        cond.notify()            # wake one waiting consumer
```

<div class="adm tip"><div class="adm-title">💡 The GIL in one breath (they will ask)</div>
<p>"The GIL lets only one thread execute Python bytecode at a time, so threads don't parallelize CPU-bound Python — use <code>multiprocessing</code> for that (B8). Threads still help for I/O-bound work because blocked I/O releases the GIL (B6's crawler)." Memorize that sentence.</p></div>
<div class="card"><h4 style="margin-top:0">🎯 5 things they commonly ask about threads</h4>

```python
# Q1) "Why does the unlocked counter print less than 200000?"
# counter += 1 is THREE steps (read, add, write); two threads
# interleave the steps and updates are lost. The lock makes the
# three steps one atomic unit.

# Q2) Run 20 downloads in parallel, results in input order.
from concurrent.futures import ThreadPoolExecutor
with ThreadPoolExecutor(max_workers=8) as ex:
    results = list(ex.map(download, urls))

# Q3) Producer–consumer without writing your own queue.
import queue
q = queue.Queue(maxsize=100)         # thread-safe + blocking + bounded

# Q4) Signal shutdown to workers cleanly.
stop = threading.Event()
while not stop.is_set():
    work()
# ...from the main thread:  stop.set()

# Q5) Threads vs processes vs asyncio — the one-liner:
# I/O-bound, moderate scale: threads. I/O-bound, huge scale: asyncio.
# CPU-bound: processes (the GIL blocks threads).
```

</div>
<h3 id="py-async">0.11 <code>async</code> / <code>await</code> — many waits, one thread</h3>
<p class="covers">Used in: S3 (ingestor), S4 (async fetcher), B6 (async crawler)</p>
<p>asyncio gets concurrency <em>without threads</em>: one event loop runs many coroutines, and every <code>await</code> is a spot where the current task pauses so others can run. Perfect for "thousands of slow network calls at once."</p>

```python
import asyncio

# --- coroutine basics ----------------------------------------------
async def fetch(url):            # `async def` makes a COROUTINE
    await asyncio.sleep(1)       # `await` = "pause me here; loop, go
    return f"data from {url}"    #  run someone else meanwhile"

async def main():
    # sequential: ~3 seconds (await one, THEN the next)
    a = await fetch("u1")
    b = await fetch("u2")
    c = await fetch("u3")

    # concurrent: ~1 second (start all three, wait for all)
    a, b, c = await asyncio.gather(fetch("u1"), fetch("u2"), fetch("u3"))

asyncio.run(main())              # starts the event loop

# --- the four tools every solution uses -----------------------------
# 1) timeout: don't wait forever (S3 wraps every handler call)
result = await asyncio.wait_for(fetch("u1"), timeout=5.0)

# 2) semaphore: at most N awaits inside at once (S4: max 100 in flight)
sem = asyncio.Semaphore(100)
async def polite_fetch(url):
    async with sem:              # waits here if 100 are already inside
        return await fetch(url)

# 3) queue: hand work between coroutines, bounded = backpressure (S3)
q = asyncio.Queue(maxsize=1000)
await q.put(item)                # BLOCKS when full -> producer slows down
item = await q.get()
q.task_done()                    # ack; q.join() waits for all acks

# 4) tasks: run a coroutine "in the background"
worker = asyncio.create_task(consume(q))   # starts now
worker.cancel()                            # ... stop it later
```

<div class="adm tip"><div class="adm-title">💡 The one rule that prevents disasters</div>
<p>Never call slow <em>blocking</em> functions (<code>time.sleep</code>, <code>requests.get</code>, big file reads) inside <code>async def</code> — they freeze the whole event loop and every task in it. That exact mistake is hypothesis #1 in S5's p99-spike debugging question — the guide comes full circle here.</p></div>
<div class="card"><h4 style="margin-top:0">🎯 5 things they commonly ask about async / await</h4>

```python
# Q1) Run many coroutines; one failure must not kill the rest.
results = await asyncio.gather(*tasks, return_exceptions=True)
errors = [r for r in results if isinstance(r, Exception)]

# Q2) Cap concurrency at 10.
sem = asyncio.Semaphore(10)
async def bounded(coro):
    async with sem:
        return await coro

# Q3) Give up after 5 seconds.
try:
    data = await asyncio.wait_for(fetch(url), timeout=5)
except asyncio.TimeoutError:
    data = None

# Q4) Call a BLOCKING function without freezing the event loop.
data = await asyncio.to_thread(requests.get, url)

# Q5) Start background work now, collect it later.
task = asyncio.create_task(refresh_cache())
...                                  # do other things
await task                           # or: task.cancel()
```

</div>
<h3 id="py-time">0.12 Time, and why the solutions pass <code>now</code> in</h3>
<p class="covers">Used in: S1, S2, B5, B12 — every TTL/timestamp problem</p>

```python
import time

time.time()          # wall-clock seconds since 1970 (can jump: NTP!)
time.monotonic()     # only moves forward -> ALWAYS use for durations

t0 = time.monotonic()
do_work()
elapsed = time.monotonic() - t0

# --- why every S1/B5 method takes `now` as a PARAMETER --------------
def get(self, key, now):         # caller supplies the clock
    ...
# 1) The grader replays fixed timestamps -> deterministic tests.
# 2) You can unit-test expiry without sleeping:
store.set_with_ttl("k", "v", ttl=10, now=100)
assert store.get("k", now=109) == "v"     # still alive at 109
assert store.get("k", now=110) is None    # dead exactly at 100+10
# "Inject the clock" is a habit interviewers actively look for.
```

<div class="card"><h4 style="margin-top:0">🎯 5 things they commonly ask about time</h4>

```python
# Q1) Time a block correctly (monotonic, never time.time).
t0 = time.monotonic()
work()
elapsed = time.monotonic() - t0

# Q2) A timing decorator.
def timed(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        t0 = time.monotonic()
        try:
            return fn(*args, **kwargs)
        finally:
            print(fn.__name__, time.monotonic() - t0)
    return wrapper

# Q3) Allow at most one call per second.
last = 0.0
def maybe_call():
    global last
    now = time.monotonic()
    if now - last >= 1.0:
        last = now
        call()

# Q4) Milliseconds since epoch (API-style timestamps, B5).
ms = int(time.time() * 1000)

# Q5) Test TTL logic without sleeping (clock injection).
store.set_with_ttl("k", "v", ttl=10, now=100)
assert store.get("k", now=109) == "v"
assert store.get("k", now=110) is None
```

</div>
<div class="adm info"><div class="adm-title">ℹ️ How to study this section</div>
<p>Don't read it twice — <em>type</em> it once. Open a bare Replit, and for each mini-lesson reproduce the example from memory, then break it on purpose (remove the lock, swap <code>bisect_right</code> for <code>left</code>, use <code>if</code> instead of <code>while</code> around <code>wait()</code>) and predict what changes. That's ~2 hours and it makes every solution below readable at interview speed. Then start S1.</p></div>
<!-- ============================ CORE FIVE ============================ -->

</div>
