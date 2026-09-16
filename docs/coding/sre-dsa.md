---
title: "SRE DS/Algo Drills"
slug: /coding/sre-dsa
sidebar_position: 3
sidebar_label: "SRE DS/Algo Drills"
description: "SRE DS/Algo Drills"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/sre-dsa/sequence.svg" alt="How it works — sre-dsa" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
20 algorithmic problems with SRE reliability lens — invariants, bounded memory, tail latency, and Google infrastructure mappings. Not LeetCode — SRE-native.

Google SRE • 20 Problems • 30 Pages • Python + Go

[Home](/) [Python 38 Problems](/docs/coding/sre-python) [Debugging](/docs/sre/sre-debugging)

### Interview Narration Blueprint (Use Every Time)

```
1. RESTATE the problem + constraints (1-2 lines)
2. NAME the data structure + STATE THE INVARIANT
3. OUTLINE the 3-4 steps
4. CODE the core (≤ 10 lines), preserving invariant after each mutation
5. STATE complexity and WHY space is bounded
6. EDGE CASES (empties, ties, duplicates, degenerate)
7. RELIABILITY NOTE (one sentence tying to production)

SENIOR VOCABULARY: invariant, monotonic, amortized, idempotent,
backpressure, bounded cardinality, cardinality control
```

## 20 Problems — 6 Sections

### Arrays & Strings (1-5)

1.  [Reverse Words In-Place](#p1)
2.  [First Non-Repeating Character](#p2)
3.  [Merge Overlapping Intervals](#p3)
4.  [Substring Search (KMP)](#p4)
5.  [Sliding Window Maximum](#p5)

### Hashmaps & Sets (6-8)

6.  [Top-K Most Frequent Elements](#p6)
7.  [Near-Duplicates Within Distance k](#p7)
8.  [Group Anagrams](#p8)

### Stacks & Queues (9-11)

9.  [Min-Stack O(1) getMin](#p9)
10.  [Evaluate Reverse Polish Notation](#p10)
11.  [Rate Limiter (Sliding Window)](#p11)

### Trees & Graphs (12-15)

12.  [Serialize/Deserialize Binary Tree](#p12)
13.  [Lowest Common Ancestor](#p13)
14.  [BFS Shortest Path](#p14)
15.  [Detect Cycle in Directed Graph](#p15)

### Concurrency & Scheduling (16-18)

16.  [Thread-Safe Counter](#p16)
17.  [Dining Philosophers](#p17)
18.  [Task Scheduler (Least Interval)](#p18)

### Dynamic Programming (19-20)

19.  [Longest Increasing Subsequence](#p19)
20.  [Edit Distance](#p20)

Arrays & Strings (Problems 1-5)

<a id="p1"></a>

### 1\. Reverse Words In-Place

"the sky is blue" → "blue is sky the". In-place, O(1) extra space.

**Framework:** 1. Reverse entire array 2. Reverse each word segment 3. Collapse spaces. Invariant: "words before i are reversed and correctly ordered."

```
s = list("the sky is blue")
s.reverse()
i = 0
for j in range(len(s)+1):
    if j == len(s) or s[j] == " ":
        s[i:j] = reversed(s[i:j])
        i = j + 1
```

**Google SRE Mapping:** In-place suffix manipulation for search index building. Avoids TB-level allocations in log pipelines.

O(n) time, O(1) space. Bounded memory during 500GB file manipulation.

<a id="p2"></a>

### 2\. First Non-Repeating Character

"google" → "l" (first unique char).

**Framework:** Pass 1: count frequencies. Pass 2: return first with freq==1. Invariant: "counts reflect exact multiplicity up to index i."

```python
def firstUnique(s):
    freq = {}
    for c in s: freq[c] = freq.get(c, 0) + 1
    for c in s:
        if freq[c] == 1: return c
    return ' '
```

**Google:** Error-stream anomaly detection. Most error codes repeat; first novel error signals regression. Bounded by alphabet size.

O(n) time, O(Σ) space. Bounded memory on high-volume log streams.

<a id="p3"></a>

### 3\. Merge Overlapping Intervals

\[\[1,3\],\[2,6\],\[8,10\],\[15,18\]\] → \[\[1,6\],\[8,10\],\[15,18\]\]

**Framework:** Sort by start. Scan: if overlap → extend end; else push new. Invariant: "result contains disjoint, maximally merged intervals up to i."

```
intervals.sort()
res = [intervals[0]]
for s, e in intervals[1:]:
    if s <= res[-1][1]:
        res[-1][1] = max(res[-1][1], e)
    else:
        res.append([s, e])
```

**Google:** Deployment window scheduling. Overlapping rollout windows must merge before pushing to 10K machines. Wrong merge → double-deploy or missed blackout.

O(n log n) sort + O(n) scan. Memory ≤ O(n).

<a id="p4"></a>

### 4\. Substring Search (KMP)

Find needle in haystack. O(n+m) vs naive O(n\*m).

**Framework:** Build prefix function (LPS). On mismatch, shift by longest prefix==suffix. Invariant: "never re-scan characters."

```python
def kmp(s, p):
    lps = [0]*len(p); j = 0
    for i in range(1, len(p)):
        while j > 0 and p[i] != p[j]: j = lps[j-1]
        if p[i] == p[j]: j += 1; lps[i] = j
    j = 0
    for i, c in enumerate(s):
        while j > 0 and c != p[j]: j = lps[j-1]
        if c == p[j]: j += 1
        if j == len(p): return i - j + 1
    return -1
```

**Google:** Log scanning for crash signatures in Borgmon/Monarch. Naive O(n\*m) stalls on adversarial patterns. KMP guarantees O(n+m) — critical for SLO-driven monitoring queries.

O(n+m) time (n = text length, m = pattern length). O(m) space for LPS array. Never backtracks on the text — single pass guaranteed.

<a id="p5"></a>

### 5\. Sliding Window Maximum

Given array + window size k, output max of each sliding window.

**Framework:** Monotonic deque of indices (values strictly decreasing). Insert: pop back while smaller. Evict front if out of window. Front = max. Invariant: "deque candidates in descending order."

```python
from collections import deque
def maxSliding(nums, k):
    dq, res = deque(), []
    for i, x in enumerate(nums):
        while dq and nums[dq[-1]] <= x: dq.pop()
        dq.append(i)
        if dq[0] == i - k: dq.popleft()
        if i >= k - 1: res.append(nums[dq[0]])
    return res
```

**Google:** Rolling p99 latency in Bigtable/Borgmon. Monotonic deque gives O(n) time, O(k) space — bounded real-time tail percentile tracking for SLO alerts.

O(n) time, O(k) space. Each element enqueued/dequeued at most once (amortized).

Hashmaps & Sets (Problems 6-8)

<a id="p6"></a>

### 6\. Top-K Most Frequent Elements

nums=\[1,1,1,2,2,3\], k=2 → \[1,2\]

**Framework:** Count frequencies (hashmap). Push (freq,num) into min-heap. If heap > k, pop. Invariant: "heap never exceeds k → space bounded."

```python
import heapq
from collections import Counter
def topK(nums, k):
    freq = Counter(nums)
    return heapq.nlargest(k, freq.keys(), key=freq.get)
```

**Google:** Top-K error codes during incident — bounded-memory frequency summaries on billions of trace IDs. Core SRE survival skill.

O(n log k) time, O(k) space. Memory bounded regardless of stream size.

<a id="p7"></a>

### 7\. Near-Duplicates Within Distance k

Return true if any value appears at two indices ≤ k apart.

```python
def near_dup(nums, k):
    win = set()
    for i, x in enumerate(nums):
        if x in win: return True
        win.add(x)
        if i >= k: win.remove(nums[i-k])
    return False
```

**Google:** Alert de-dup in Alertmanager. Sliding window set ensures bounded memory under millions of alerts/min.

O(n) time, O(k) space. "Evict before grow" prevents heap blowups.

<a id="p8"></a>

### 8\. Group Anagrams

Group words that are anagrams. Canonical key = count-vector.

```python
from collections import defaultdict
def group_anagrams(words):
    g = defaultdict(list)
    for w in words:
        cnt = [0]*26
        for ch in w: cnt[ord(ch)-97] += 1
        g[tuple(cnt)].append(w)
    return list(g.values())
```

**Google:** Crash-signature canonicalization. Stack traces differ by register offsets; canonical multiset key coalesces identical failures.

O(n\*k) time where n = number of words, k = max word length. O(n\*k) space for output. Key size is O(26) = O(1) per word.

Stacks & Queues (Problems 9-11)

<a id="p9"></a>

### 9\. Min-Stack with O(1) getMin

Stack supporting push, pop, top, getMin — all O(1).

**Framework:** Two stacks: S (values) + M (mins). Push x: push to S; if x ≤ M.top, push to M. Pop: if popped == M.top, pop M. getMin = M.top. Invariant: "M.top always equals the minimum of all elements currently in S."

```python
class MinStack:
    def __init__(self):
        self.s = []
        self.m = []
    def push(self, x):
        self.s.append(x)
        if not self.m or x <= self.m[-1]:
            self.m.append(x)
    def pop(self):
        val = self.s.pop()
        if val == self.m[-1]:
            self.m.pop()
    def top(self):
        return self.s[-1]
    def getMin(self):
        return self.m[-1]
```

**Walkthrough:** push(3) → S=\[3\], M=\[3\]. push(1) → S=\[3,1\], M=\[3,1\]. push(2) → S=\[3,1,2\], M=\[3,1\] (2 > 1, skip). getMin()=1. pop() → removes 2, M unchanged. pop() → removes 1, M pops 1. getMin()=3.

**Common mistake:** Using strict < instead of ≤ when pushing to M. If you push two 1s, you must track both — otherwise popping one 1 removes the min entry while another 1 still exists in S.

**Google:** Hierarchical quota enforcement in Borg/cgroups. Min-stack gives O(1) effective resource cap during scheduler descent/ascent.

O(1) push, pop, top, getMin. O(n) space worst case (descending input fills M). Amortized M is much smaller.

<a id="p10"></a>

### 10\. Evaluate Reverse Polish Notation

\["2","1","+","3","\*"\] → 9

```python
def evalRPN(tokens):
    s = []
    for t in tokens:
        if t not in "+-*/": s.append(int(t))
        else:
            b, a = s.pop(), s.pop()
            s.append(int(eval(f"{a}{t}{b}")))
    return s[0]
```

**Google:** Borg config evaluators use postfix-style evaluation for scheduling policies. Bounded stack prevents recursion depth explosions.

<a id="p11"></a>

### 11\. Rate Limiter (Fixed Window + Sliding Log)

Allow at most N requests per T seconds.

```python
# Sliding log: keep timestamps in deque
from collections import deque
import time

class RateLimiter:
    def __init__(self, n, t):
        self.q, self.n, self.t = deque(), n, t
    def allow(self):
        now = time.time()
        while self.q and self.q[0] < now - self.t:
            self.q.popleft()
        if len(self.q) < self.n:
            self.q.append(now)
            return True
        return False
```

**Google:** GFE traffic-shaping. Sliding-window rate limiters enforce per-user caps to protect backend SLOs. Invariant: bounded memory O(N) even under adversarial clients.

Trees & Graphs (Problems 12-15)

<a id="p12"></a>

### 12\. Serialize/Deserialize Binary Tree

Encode tree to string, decode back. Must handle arbitrary binary trees (not just BST).

**Framework:** Preorder DFS with sentinel for null. Serialize: visit node, recurse left, recurse right, write "null" for None. Deserialize: consume tokens left-to-right, reconstruct recursively. Invariant: "preorder traversal + null sentinels uniquely defines tree structure."

```python
class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val, self.left, self.right = val, left, right

def serialize(root):
    res = []
    def dfs(node):
        if not node:
            res.append("null")
            return
        res.append(str(node.val))
        dfs(node.left)
        dfs(node.right)
    dfs(root)
    return ",".join(res)

def deserialize(data):
    vals = iter(data.split(","))
    def dfs():
        v = next(vals)
        if v == "null": return None
        node = TreeNode(int(v))
        node.left = dfs()
        node.right = dfs()
        return node
    return dfs()
```

**Walkthrough:** Tree \[1,2,3,null,null,4,5\] → serialize: "1,2,null,null,3,4,null,null,5,null,null". Deserialize consumes tokens: 1→left(2→left(null)→right(null))→right(3→left(4→...)→right(5→...)). Reconstructs exact original tree.

**Common mistake:** Using BFS level-order but forgetting to encode nulls for children of leaf nodes — makes deserialization ambiguous. Preorder DFS with null sentinels is simpler and unambiguous.

**Google:** Lossless encoding of dependency trees for Borg job DAGs. Must reconstruct exact structure from serialized form. Also: protocol buffer wire format for nested messages.

O(n) time, O(n) space for both serialize and deserialize. Each node visited exactly once.

<a id="p13"></a>

### 13\. Lowest Common Ancestor (Binary Tree)

Find LCA of two nodes p and q in a binary tree. Nodes are guaranteed to exist.

**Framework:** Post-order recursion. Base: if node is None or node is p or q, return node. Recurse left and right. If both return non-null → current node is LCA (p and q are in different subtrees). If one is null → return the other (both targets in same subtree). Invariant: "return value is the LCA of all target nodes found in this subtree."

```python
def lowestCommonAncestor(root, p, q):
    if not root or root == p or root == q:
        return root
    left = lowestCommonAncestor(root.left, p, q)
    right = lowestCommonAncestor(root.right, p, q)
    if left and right:
        return root        # p and q in different subtrees
    return left or right   # both in same subtree
```

**Walkthrough:** Tree: 3→(5,1), 5→(6,2), 1→(0,8). LCA(5,1)=3 (found in different subtrees of root). LCA(5,4)=5 (4 is under 5, so 5 is returned when hit). LCA(6,2)=5 (both under 5's subtrees).

**Common mistake:** Trying to track parent pointers or paths — unnecessary complexity. The post-order "bubble-up" pattern handles everything in a single pass. Also: this only works when both p and q are guaranteed to exist in the tree.

**Google:** Failure propagation in service DAGs — "which shared dependency caused both service A and B to fail?" = LCA in the dependency tree. Also: git merge-base uses LCA to find common ancestor commit.

O(n) time (visit each node once), O(h) space (recursion stack, h = tree height). Worst case O(n) for skewed tree.

<a id="p14"></a>

### 14\. BFS Shortest Path (Unweighted Graph)

Find shortest path in unweighted graph. BFS with queue. Mark visited on ENQUEUE, not dequeue.

```python
from collections import deque
def bfs_shortest(graph, start, end):
    q = deque([(start, [start])])
    visited = {start}
    while q:
        node, path = q.popleft()
        if node == end: return path
        for nb in graph[node]:
            if nb not in visited:
                visited.add(nb)  # mark on ENQUEUE!
                q.append((nb, path + [nb]))
    return None
```

**Google:** Network hop-count between services. "What's the shortest dependency chain from GFE to Spanner?" BFS on service graph with O(V+E).

**Critical mistake:** Marking visited on DEQUEUE instead of ENQUEUE → duplicates in queue → O(V²) blowup. "Mark visited on enqueue to uphold single-enqueue invariant."

<a id="p15"></a>

### 15\. Detect Cycle in Directed Graph (Kahn's / DFS)

Detect cycle in directed graph. Return True if cycle exists.

**Two approaches:**  
**Kahn's (BFS):** Count in-degrees. Queue all with in-degree=0. Process: decrement neighbors' in-degree; if 0, enqueue. If processed count < total nodes → cycle exists. Invariant: "only nodes with all dependencies resolved are processed."  
**DFS colors:** WHITE=unvisited, GRAY=in current path, BLACK=fully processed. Gray→Gray edge = back-edge = cycle. Invariant: "a GRAY node means we're still exploring its descendants."

```python
# Kahn's topological sort (BFS)
from collections import deque
def has_cycle_kahn(graph, n):
    indeg = [0] * n
    for u in range(n):
        for v in graph[u]:
            indeg[v] += 1
    q = deque(i for i in range(n) if indeg[i] == 0)
    processed = 0
    while q:
        u = q.popleft()
        processed += 1
        for v in graph[u]:
            indeg[v] -= 1
            if indeg[v] == 0: q.append(v)
    return processed != n  # True = cycle exists

# DFS with colors
def has_cycle_dfs(graph, n):
    WHITE, GRAY, BLACK = 0, 1, 2
    color = [WHITE] * n
    def dfs(u):
        color[u] = GRAY
        for v in graph[u]:
            if color[v] == GRAY: return True   # back-edge
            if color[v] == WHITE and dfs(v): return True
        color[u] = BLACK
        return False
    return any(color[i] == WHITE and dfs(i) for i in range(n))
```

**Walkthrough (Kahn's):** Graph: 0→1→2→0 (cycle). indeg=\[1,1,1\]. No node has indeg=0 → queue empty → processed=0 ≠ 3 → cycle=True. DAG: 0→1→2. indeg=\[0,1,1\]. Queue=\[0\]→process 0, indeg\[1\]=0→Queue=\[1\]→process 1, indeg\[2\]=0→process 2. processed=3=n → no cycle.

**Common mistake (DFS):** Using a simple "visited" set instead of 3 colors. With 2 states you can't distinguish "currently exploring" (GRAY) from "fully done" (BLACK). A cross-edge to a BLACK node is safe; only GRAY→GRAY is a cycle. Two-state visited causes false positives.

**Google:** Build/deploy dependency DAGs. Circular dependencies cause infinite loops in Borg scheduling. Must detect before job submission. Also: Kubernetes controller dependency ordering and Terraform plan validation.

Both: O(V+E) time, O(V) space. Kahn's also produces topological order as a side effect — useful for execution scheduling.

Concurrency & Scheduling (Problems 16-18)

<a id="p16"></a>

### 16\. Thread-Safe Counter (Locks / Atomics)

Implement a counter safe under concurrent access. Use lock or atomic increment.

```python
import threading
class SafeCounter:
    def __init__(self):
        self.val = 0
        self.lock = threading.Lock()
    def inc(self):
        with self.lock:
            self.val += 1
    def get(self):
        return self.val
```

**Google:** Prometheus-style metric counters. Must be thread-safe under thousands of concurrent goroutines/threads updating the same metric.

<a id="p17"></a>

### 17\. Dining Philosophers (Deadlock-Free)

5 philosophers, 5 forks arranged in a circle. Each needs both adjacent forks to eat. Design a deadlock-free solution.

**Framework:** Deadlock requires all 4 Coffman conditions: mutual exclusion, hold-and-wait, no preemption, circular wait. Break any one to prevent deadlock.  
**Solution 1 — Resource ordering:** Always acquire the lower-numbered fork first. Philosopher 4 picks fork 0 before fork 4, breaking the circular wait.  
**Solution 2 — Limit concurrency:** Allow at most N-1 philosophers to attempt eating simultaneously (via semaphore). Guarantees at least one can always acquire both forks.

```python
import threading

class DiningPhilosophers:
    def __init__(self, n=5):
        self.forks = [threading.Lock() for _ in range(n)]
        self.n = n

    def eat(self, pid):
        left, right = pid, (pid + 1) % self.n
        first, second = min(left, right), max(left, right)
        with self.forks[first]:
            with self.forks[second]:
                print(f"Philosopher {pid} eating")

# Solution 2: semaphore-based
class DiningPhilosophersV2:
    def __init__(self, n=5):
        self.forks = [threading.Lock() for _ in range(n)]
        self.seats = threading.Semaphore(n - 1)  # at most N-1 sit
        self.n = n

    def eat(self, pid):
        self.seats.acquire()
        left, right = pid, (pid + 1) % self.n
        self.forks[left].acquire()
        self.forks[right].acquire()
        print(f"Philosopher {pid} eating")
        self.forks[right].release()
        self.forks[left].release()
        self.seats.release()
```

**Walkthrough (ordering):** Philosophers 0-3 pick fork min(left,right) first → 0,1,2,3. Philosopher 4 picks fork min(4,0)=0 first, then fork 4. No circular chain possible — philosopher 4 waits for fork 0 (held by philosopher 0), but philosopher 0 can finish because its chain doesn't loop back to 4.

**Common mistake:** Having all philosophers pick left fork first → all 5 hold one fork, wait for the other → classic circular deadlock. Resource ordering breaks this by making at least one philosopher's acquisition order asymmetric.

**Google:** Resource allocation in Borg. Multiple tasks competing for shared resources (CPU, memory, disk). Resource ordering prevents deadlock in scheduler lock acquisition. Semaphore approach mirrors admission control — limit concurrent requests to prevent resource exhaustion.

O(1) per eat operation (constant number of lock acquisitions). Space O(n) for n forks + 1 semaphore. Deadlock-free by construction.

<a id="p18"></a>

### 18\. Task Scheduler (Least Interval)

Given tasks=\['A','A','A','B','B','B'\] and cooldown n=2, find minimum intervals to complete all tasks. Same task must have at least n intervals between executions.

**Framework:** Greedy — schedule most frequent task first. Calculate idle slots, then fill them with other tasks. Formula: slots = (maxFreq - 1) \* (n + 1) + countOfMaxFreq. Answer = max(slots, len(tasks)). Invariant: "most frequent task creates the skeleton; others fill gaps."

```python
from collections import Counter
def leastInterval(tasks, n):
    freq = list(Counter(tasks).values())
    max_freq = max(freq)
    max_count = freq.count(max_freq)
    # Frame: (maxFreq-1) groups of (n+1) slots + final group of max_count
    slots = (max_freq - 1) * (n + 1) + max_count
    return max(slots, len(tasks))

# Simulation approach (produces actual schedule):
import heapq
def schedule_tasks(tasks, n):
    freq = Counter(tasks)
    heap = [-f for f in freq.values()]  # max-heap via negation
    heapq.heapify(heap)
    time = 0
    while heap:
        temp = []
        for _ in range(n + 1):          # fill one cooldown window
            if heap:
                cnt = heapq.heappop(heap) + 1  # execute one instance
                if cnt < 0: temp.append(cnt)
            time += 1
            if not heap and not temp: break
        for cnt in temp:
            heapq.heappush(heap, cnt)
    return time
```

**Walkthrough:** tasks=\['A','A','A','B','B','B'\], n=2. maxFreq=3, maxCount=2 (both A and B have freq 3). slots = (3-1)\*(2+1)+2 = 8. Schedule: A B idle A B idle A B → 8 intervals. If tasks=\['A','A','A','B','B','C'\], n=2: slots=(3-1)\*3+1=7, len(tasks)=6 → answer=max(7,6)=7. Schedule: A B C A B idle A.

**Common mistake:** Forgetting the max(slots, len(tasks)) — when cooldown is small and there are many distinct tasks, the formula underestimates because no idle slots are needed. The answer can never be less than the number of tasks.

**Google:** Borg job scheduling with preemption cooldowns. Must minimize total time while respecting anti-affinity constraints. Also: Kubernetes pod disruption budgets — can't drain N pods of the same service within a cooldown window.

Formula: O(n) time, O(1) space. Simulation: O(T \* n) time where T = total intervals, O(26) space (at most 26 task types).

Dynamic Programming (Problems 19-20)

<a id="p19"></a>

### 19\. Longest Increasing Subsequence

Find LIS length. DP: dp\[i\] = longest ending at i. Binary search optimization: O(n log n).

```python
import bisect
def lis(nums):
    tails = []
    for x in nums:
        pos = bisect.bisect_left(tails, x)
        if pos == len(tails): tails.append(x)
        else: tails[pos] = x
    return len(tails)
```

**Google:** Detecting monotonic capacity growth trends in time-series data. LIS on metric values identifies the longest sustained growth period for capacity planning.

O(n log n) time, O(n) space. "Subproblem ordering guarantees dependencies solved first."

<a id="p20"></a>

### 20\. Edit Distance (Levenshtein)

Minimum insertions, deletions, substitutions to transform word1 → word2.

```python
def editDistance(s1, s2):
    m, n = len(s1), len(s2)
    dp = [[0]*(n+1) for _ in range(m+1)]
    for i in range(m+1): dp[i][0] = i
    for j in range(n+1): dp[0][j] = j
    for i in range(1, m+1):
        for j in range(1, n+1):
            if s1[i-1] == s2[j-1]: dp[i][j] = dp[i-1][j-1]
            else: dp[i][j] = 1 + min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
    return dp[m][n]
```

**Google:** Config diff scoring. When a config drifts, edit distance quantifies "how far from golden." Lucene uses Levenshtein automata for fuzzy search (typo tolerance within edit distance 1-2).

O(m\*n) time and space. Can optimize to O(min(m,n)) space with row-only DP.

### 7-Day Practice Plan

```
Day 1-2: Arrays/Strings (1-5) — 25 min each, narrate aloud
Day 3:   Hashmaps/Sets (6-8)
Day 4:   Stacks/Queues (9-11)
Day 5:   Trees/Graphs (12-15)
Day 6:   Concurrency/Scheduling (16-18)
Day 7:   DP/Advanced (19-20) + full review

Each problem: framework → code (≤10 lines) → complexity → SRE note
If you can't state the invariant, DON'T START TYPING.
```
