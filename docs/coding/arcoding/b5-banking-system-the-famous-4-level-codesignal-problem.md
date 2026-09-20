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

### The approach

<img src="/diagrams/arcoding/b5.svg" alt="Every operation first drains the due cashback heap, then resolves merge aliases, then applies and records a balance point that later historical queries binary-search." class="doc-diagram doc-diagram-seq" />

<p>Three mechanisms stack, and the order matters. <strong>Every single operation starts by settling</strong> the cashback heap up to the current time — skip that in one method and the balances silently diverge. Merged accounts are handled by an alias chain rather than by rewriting history, so an old account still resolves to its survivor. And each mutation appends a <code>(time, balance)</code> point, which turns the historical query into a <code>bisect</code> over a list you were already building.</p>

### What it looks like in memory

<p>The bank's structures after the Level 1–3 operations in <em>Run it</em>, just before the merge.</p>

<img src="/diagrams/arcoding-state/b5.svg" alt="The balances, outgoing totals, cashback heap and per-account history after several operations." class="doc-diagram doc-diagram-seq" />

<h4>The architecture that survives all four levels</h4>
<ul>
<li><strong>Settle-then-act:</strong> a single <code>_settle(now)</code> that applies all scheduled effects due ≤ now, called first by every public method. Without it, L3 leaks cashback into some code paths and not others.</li>
<li><strong>Record-on-change:</strong> append <code>(t, new_balance)</code> to per-account history on every mutation. L4's historical query becomes one binary search instead of a rewrite.</li>
<li><strong>Alias map for merges:</strong> resolve <code>acct → canonical</code> at the top of every method; merged accounts never physically move their history.</li>
</ul>

<p class="covers">The complete program — save it as <code>b5_bank.py</code> and run <code>python b5_bank.py</code>.</p>

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
        """Open an account; False if it already exists.

        Example:
            >>> b = Bank()
            >>> b.create('a', 1)
            True
            >>> b.create('a', 1)
            False
        """
        self._settle(t)
        if self._canon(acct) in self.bal or acct in self.alias:
            return False
        self.bal[acct] = 0
        self._record(acct, t)
        return True

    def deposit(self, acct, amount, t):
        """Add to a balance and return it; None if the account is unknown.

        Example:
            >>> b = Bank()
            >>> b.create('a', 1)
            True
            >>> b.deposit('a', 500, 2)
            500
            >>> b.deposit('x', 5, 3)   # -> None
        """
        self._settle(t)
        a = self._canon(acct)
        if a not in self.bal:
            return None
        self.bal[a] += amount
        self._record(a, t)
        return self.bal[a]

    def transfer(self, src, dst, amount, t):
        """Move funds between accounts; None on unknown account or insufficient funds.

        Example:
            >>> b = Bank()
            >>> b.create('a', 1); b.create('b', 1)
            >>> b.deposit('a', 500, 2)
            500
            >>> b.transfer('a', 'b', 200, 3)
            300
            >>> b.transfer('a', 'b', 9999, 4)   # -> None
        """
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
        """The n accounts with the highest outgoing totals, ties broken by name.

        Example:
            >>> b = Bank()
            >>> b.create('a', 1); b.create('b', 1)
            >>> b.deposit('a', 500, 2); b.deposit('b', 500, 2)
            >>> b.transfer('a', 'b', 300, 3); b.transfer('b', 'a', 100, 4)
            >>> b.top_spenders(2, 5)
            ['a(300)', 'b(100)']
        """
        self._settle(t)
        ranked = sorted(self.out.items(), key=lambda kv: (-kv[1], kv[0]))
        return [f"{a}({v})" for a, v in ranked[:n]]

    # ---- Level 3 -----------------------------------------------------------
    def pay(self, acct, amount, t):
        """Spend from an account; schedules 2% cashback 24h later. Returns the new balance.

        Example:
            >>> b = Bank()
            >>> b.create('a', 1)
            True
            >>> b.deposit('a', 1000, 2)
            1000
            >>> b.pay('a', 1000, 3)
            0
        """
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
        """Fold a2 into a1; a2's later operations resolve to a1. False on bad input.

        Example:
            >>> b = Bank()
            >>> b.create('a', 1); b.create('b', 1)
            >>> b.deposit('a', 100, 2); b.deposit('b', 50, 2)
            >>> b.merge('a', 'b', 3)
            True
            >>> b.deposit('a', 0, 4)
            150
        """
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
        """Balance of `acct` as of time_at (query issued at `now`).

        Example:
            >>> b = Bank()
            >>> b.create('a', 1)
            True
            >>> b.deposit('a', 500, 5)
            500
            >>> b.deposit('a', 200, 10)
            700
            >>> b.balance_at('a', 7, now=20)
            500
            >>> b.balance_at('a', 12, now=20)
            700
        """
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


if __name__ == "__main__":
    bank = Bank()
    T0 = 1

    print("create acc1     :", bank.create("acc1", T0))
    print("create acc2     :", bank.create("acc2", T0))
    print("create acc1 again:", bank.create("acc1", T0))       # duplicate

    print("\n--- Level 1: deposit / transfer ---")
    print("deposit  acc1 2000:", bank.deposit("acc1", 2000, T0 + 1))
    print("deposit  acc2  500:", bank.deposit("acc2", 500,  T0 + 2))
    print("transfer 1200 ->  :", bank.transfer("acc1", "acc2", 1200, T0 + 3))
    print("transfer too much :", bank.transfer("acc1", "acc2", 99999, T0 + 4))
    print("transfer to self  :", bank.transfer("acc1", "acc1", 10, T0 + 5))

    print("\n--- Level 2: top spenders (ties broken by name) ---")
    print(bank.top_spenders(3, T0 + 6))

    print("\n--- Level 3: pay() with 2% cashback 24h later ---")
    print("pay acc2 1000     :", bank.pay("acc2", 1000, T0 + 10))
    print("balance before due:", bank.deposit("acc2", 0, T0 + 11))
    due = T0 + 10 + MS_DAY
    print("balance after due :", bank.deposit("acc2", 0, due))   # +20 cashback

    print("\n--- Level 4: merge + historical balance ---")
    print("merge acc2 into acc1:", bank.merge("acc1", "acc2", due + 1))
    print("acc1 balance now    :", bank.deposit("acc1", 0, due + 2))
    print("deposit via acc2    :", bank.deposit("acc2", 0, due + 3))  # routed to acc1
    print("acc1 as of T0+2     :", bank.balance_at("acc1", T0 + 2, due + 4))
    print("acc2 pre-merge      :", bank.balance_at("acc2", T0 + 3, due + 4))
    print("acc2 post-merge     :", bank.balance_at("acc2", due + 2, due + 4))
    print("unknown account     :", bank.balance_at("nope", 0, due + 4))
```

<p><strong>Output</strong></p>

```text
create acc1     : True
create acc2     : True
create acc1 again: False

--- Level 1: deposit / transfer ---
deposit  acc1 2000: 2000
deposit  acc2  500: 500
transfer 1200 ->  : 800
transfer too much : None
transfer to self  : None

--- Level 2: top spenders (ties broken by name) ---
['acc1(1200)']

--- Level 3: pay() with 2% cashback 24h later ---
pay acc2 1000     : 700
balance before due: 700
balance after due : 720

--- Level 4: merge + historical balance ---
merge acc2 into acc1: True
acc1 balance now    : 1520
deposit via acc2    : 1520
acc1 as of T0+2     : 2000
acc2 pre-merge      : 1700
acc2 post-merge     : 1520
unknown account     : None
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
