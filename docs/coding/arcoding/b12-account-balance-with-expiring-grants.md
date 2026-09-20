---
title: "B12 · Account balance with expiring grants"
slug: /coding/arcoding/b12-account-balance-with-expiring-grants
sidebar_position: 19
sidebar_label: "B12 · Account balance with expiring grants"
description: "B12 · Account balance with expiring grants"
---

<div class="arcoding">

## B12 · Account balance with expiring grants

<p class="covers">Covers: Account Balance with Expiring Grants — isomorphic to API credit systems, promo balances, and quota leases.</p>
<div class="adm info"><div class="adm-title">ℹ️ Problem</div>
<p><code>grant(amount, expiry)</code> adds credit valid until <code>expiry</code>; <code>spend(amount, now)</code> consumes credit (all-or-nothing), drawing from grants in expiration order; <code>balance(now)</code> returns live credit. Expired remainder is simply gone.</p></div>
<h4>Why soonest-expiring-first is not just convention</h4>
<p>It's the greedy that <em>maximizes future spendable balance</em>: any other order preserves credit that dies sooner at the expense of credit that lives longer — strictly dominated. An exchange argument proves it in one sentence; give that sentence.</p>

```python
import heapq


class CreditAccount:
    def __init__(self):
        self._h = []                # min-heap: (expiry, seq, [remaining])
        self._seq = 0               # tiebreak: same-expiry grants in grant order
        self._total = 0             # running live balance -> O(1) reads

    def _prune(self, now):
        """Drop grants expired as of `now` (expiry <= now is dead)."""
        while self._h and self._h[0][0] <= now:
            self._total -= heapq.heappop(self._h)[2][0]

    def grant(self, amount, expiry):
        if amount <= 0:
            raise ValueError("amount must be positive")
        self._seq += 1
        heapq.heappush(self._h, (expiry, self._seq, [amount]))
        self._total += amount

    def balance(self, now) -> int:
        self._prune(now)
        return self._total

    def spend(self, amount, now) -> bool:
        """All-or-nothing. Consumes from the soonest-expiring grant first."""
        self._prune(now)
        if amount <= 0 or amount > self._total:
            return False
        self._total -= amount
        while amount > 0:
            expiry, seq, cell = self._h[0]
            take = min(cell[0], amount)
            cell[0] -= take                 # mutate in place: no re-push
            amount -= take
            if cell[0] == 0:
                heapq.heappop(self._h)
        return True
```

<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>Amortized costs:</strong> every grant is pushed once and popped once, so spend/prune are amortized O(log n); <code>balance</code> is O(expired backlog), O(1) steady-state thanks to the running total. Say "amortized" and why.</li>
<li><strong>Boundary semantics:</strong> is a grant usable <em>at</em> its expiry instant? (Code above: no — <code>expiry &lt;= now</code> is dead.) Confirm before coding; it's a guaranteed hidden test.</li>
<li><strong>The mutable-cell trick</strong> (one-element list inside the heap tuple) lets partial consumption avoid pop-modify-push; if it feels too clever, a small dataclass with <code>&lt;</code> defined is the tidier equivalent.</li>
<li><strong>Extensions:</strong> partial spend (spend what's available, return amount spent), <code>refund</code> (needs per-spend provenance — a log of (grant_seq, amount) per spend), and per-source grant reporting.</li>
</ul></div>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> <code>grant</code> O(log n); <code>spend</code> amortized O(log n) per grant it touches — each grant is pushed once and popped once over its lifetime, so total work across all operations is O(G log G) for G grants regardless of how spends are sized; <code>balance</code> O(1) steady-state thanks to the running total (O(expired backlog) worst case after idle periods). <strong>Space:</strong> O(live grants).</p><p><strong>How efficient is it?</strong> Optimal for expiry-ordered consumption: some ordered structure over expiries is required, and a heap is the cheapest one that only ever needs the minimum. The running-total trick is the efficiency lesson to say out loud — it converts the obvious O(n) balance scan into O(1) by maintaining the invariant at write time.</p></div>

### Run it

<p class="covers">Append this to the code above, save as <code>b12_credit_account.py</code>, then run <code>python b12_credit_account.py</code>.</p>

```python
if __name__ == "__main__":
    acct = CreditAccount()
    acct.grant(100, expiry=10)          # expires first
    acct.grant(50,  expiry=20)

    print("balance @0 :", acct.balance(0))
    print("spend 120 @0:", acct.spend(120, now=0))   # takes 100 then 20
    print("balance @0 :", acct.balance(0))
    print("balance @10:", acct.balance(10))          # nothing left to expire

    acct2 = CreditAccount()
    acct2.grant(100, expiry=10)
    acct2.grant(50,  expiry=20)
    print("\nno spend, balance @10:", acct2.balance(10))   # 100 expired
    print("overspend @10        :", acct2.spend(80, now=10))
    print("balance unchanged    :", acct2.balance(10))

    print("\n--- guards ---")
    try:
        acct2.grant(0, expiry=99)
    except ValueError as e:
        print("ValueError:", e)
```

<p><strong>Output</strong></p>

```text
balance @0 : 150
spend 120 @0: True
balance @0 : 30
balance @10: 30

no spend, balance @10: 50
overspend @10        : False
balance unchanged    : 50

--- guards ---
ValueError: amount must be positive
```

</div>
