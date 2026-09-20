---
title: "B5 · Banking system — the famous 4-level CodeSignal problem"
slug: /coding/arcoding/b5-banking-system-the-famous-4-level-codesignal-problem
sidebar_position: 12
sidebar_label: "B5 · Banking system — the famous 4-level Co…"
description: "B5 · Banking system — the famous 4-level CodeSignal problem"
---

<div class="arcoding">

## B5 · Banking system — the famous 4-level CodeSignal problem

<p class="covers">Covers 4 variants: Banking System Simulation · Implement a Banking System · Design an in-memory banking service · Build a Progressive Banking Ledger. This exact problem is widely circulated — interviewers know, so over-rehearsed pattern-matching without understanding gets probed hard.</p>
<div class="adm info"><div class="adm-title">ℹ️ Typical level structure</div>
<ol>
<li><strong>L1:</strong> create / deposit / transfer with timestamped ops (non-decreasing), string account ids, integer money.</li>
<li><strong>L2:</strong> <code>top_spenders(n, t)</code> — rank by total <em>outgoing</em>, ties alphabetically.</li>
<li><strong>L3:</strong> <code>pay(acct, amt, t)</code> with 2% cashback credited exactly 24 h later; scheduled effects must apply before any later operation reads state.</li>
<li><strong>L4:</strong> <code>merge(a1, a2, t)</code> (a2 folds into a1) and <code>balance_at(acct, time_at)</code> — historical balance, where a merged account's pre-merge history stays queryable.</li>
</ol></div>
<h4>The architecture that survives all four levels</h4>
<ul>
<li><strong>Settle-then-act:</strong> a single <code>_settle(now)</code> that applies all scheduled effects due ≤ now, called first by every public method. Without it, L3 leaks cashback into some code paths and not others.</li>
<li><strong>Record-on-change:</strong> append <code>(t, new_balance)</code> to per-account history on every mutation. L4's historical query becomes one binary search instead of a rewrite.</li>
<li><strong>Alias map for merges:</strong> resolve <code>acct → canonical</code> at the top of every method; merged accounts never physically move their history.</li>
</ul>

```python
import bisect
import heapq
from collections import defaultdict

MS_DAY = 86_400_000


class Bank:
    CASHBACK_BPS = 200                       # 2% in basis points (integer math)

    def __init__(self):
        self.bal = {}                        # canonical acct -> balance
        self.out = defaultdict(int)          # canonical acct -> total outgoing
        self.hist = defaultdict(list)        # acct -> [(t, balance_after)]
        self.sched = []                      # heap: (due_t, seq, acct, amount)
        self.alias = {}                      # merged acct -> parent
        self.merged_at = {}                  # merged acct -> merge time
        self.seq = 0

    # ---- helpers -----------------------------------------------------------
    def _canon(self, a):
        while a in self.alias:
            a = self.alias[a]
        return a

    def _record(self, a, t):
        self.hist[a].append((t, self.bal[a]))

    def _settle(self, now):
        """Apply cashbacks due <= now. MUST run before every operation."""
        while self.sched and self.sched[0][0] <= now:
            due, _, acct, amount = heapq.heappop(self.sched)
            acct = self._canon(acct)         # survives merges after scheduling
            if acct in self.bal:
                self.bal[acct] += amount
                self._record(acct, due)      # recorded at DUE time, not now

    # ---- Level 1 -----------------------------------------------------------
    def create(self, acct, t):
        self._settle(t)
        if self._canon(acct) in self.bal or acct in self.alias:
            return False
        self.bal[acct] = 0
        self._record(acct, t)
        return True

    def deposit(self, acct, amount, t):
        self._settle(t)
        a = self._canon(acct)
        if a not in self.bal:
            return None
        self.bal[a] += amount
        self._record(a, t)
        return self.bal[a]

    def transfer(self, src, dst, amount, t):
        self._settle(t)
        s, d = self._canon(src), self._canon(dst)
        if s == d or s not in self.bal or d not in self.bal:
            return None
        if self.bal[s] < amount:
            return None
        self.bal[s] -= amount
        self.bal[d] += amount
        self.out[s] += amount
        self._record(s, t)
        self._record(d, t)
        return self.bal[s]

    # ---- Level 2 -----------------------------------------------------------
    def top_spenders(self, n, t):
        self._settle(t)
        ranked = sorted(self.out.items(), key=lambda kv: (-kv[1], kv[0]))
        return [f"{a}({v})" for a, v in ranked[:n]]

    # ---- Level 3 -----------------------------------------------------------
    def pay(self, acct, amount, t):
        self._settle(t)
        a = self._canon(acct)
        if a not in self.bal or self.bal[a] < amount:
            return None
        self.bal[a] -= amount
        self.out[a] += amount
        self._record(a, t)
        cashback = amount * self.CASHBACK_BPS // 10_000   # floor, integer
        self.seq += 1
        heapq.heappush(self.sched, (t + MS_DAY, self.seq, a, cashback))
        return self.bal[a]

    # ---- Level 4 -----------------------------------------------------------
    def merge(self, a1, a2, t):
        self._settle(t)
        a1, a2 = self._canon(a1), self._canon(a2)
        if a1 == a2 or a1 not in self.bal or a2 not in self.bal:
            return False
        self.bal[a1] += self.bal[a2]
        self.out[a1] += self.out[a2]
        self._record(a1, t)
        del self.bal[a2]
        self.out.pop(a2, None)
        self.alias[a2] = a1
        self.merged_at[a2] = t               # a2's own history freezes here
        return True

    def balance_at(self, acct, time_at, now):
        """Balance of `acct` as of time_at (query issued at `now`)."""
        self._settle(now)
        # If acct was merged and the query is AFTER the merge, the account
        # lives on inside its parent; before the merge, use its own history.
        a = acct
        while a in self.merged_at and time_at >= self.merged_at[a]:
            a = self.alias[a]
        h = self.hist.get(a)
        if not h:
            return None
        i = bisect.bisect_right(h, (time_at, float("inf")))
        return h[i - 1][1] if i else None
```

<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>Cashback recorded at due time:</strong> a <code>balance_at</code> between payment and payout must NOT include the cashback — that's why <code>_settle</code> records at <code>due</code>, and why settling lazily (on next operation) still yields correct history. This interaction between L3 and L4 is where candidates lose the level.</li>
<li><strong>Integer money:</strong> basis points + floor division; never floats. State the rounding rule.</li>
<li><strong>Tie rules are always tested:</strong> heap seq for same-due-time ordering; alphabetical for equal spend. Read the spec's exact rule; don't assume.</li>
<li><strong>Scheduled payments variant:</strong> some versions add <code>schedule_payment / cancel_payment</code> — same heap plus a cancelled-id set checked on pop (lazy deletion), and skip-if-insufficient-at-due-time semantics.</li>
</ul></div>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> every operation is O(log s) amortized for settling (each scheduled cashback pushed once, popped once) plus O(1) for the op itself; <code>top_spenders</code> O(a log a) over a accounts; <code>balance_at</code> O(log h) bisect over that account’s history; <code>merge</code> O(1) via aliasing (history is never copied). <strong>Space:</strong> O(total mutations) for histories — the price of L4’s time-travel queries.</p><p><strong>How efficient is it?</strong> The two deliberate trades to narrate: histories cost memory but turn historical balance into a binary search instead of a replay; and alias-based merge is O(1) at merge time but adds an O(chain) canonicalization per op (path-compress the alias map if chains get long — the union-find trick). If <code>top_spenders</code> is hot, maintain a running top-k heap for O(log k) updates instead of re-sorting.</p></div>

</div>
