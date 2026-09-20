---
title: "B14 · Streaming token usage cost calculator"
slug: /coding/arcoding/b14-streaming-token-usage-cost-calculator
sidebar_position: 21
sidebar_label: "B14 · Streaming token usage cost calculator"
description: "B14 · Streaming token usage cost calculator"
---

<div class="arcoding">

## B14 · Streaming token usage cost calculator

<p class="covers">Covers: Calculate Streaming Token Usage Costs — Anthropic-flavored: exact billing from streaming API chunks with separate input/output prices.</p>
<div class="adm info"><div class="adm-title">ℹ️ Problem</div>
<p>A streaming response emits usage in chunks — an initial event with input tokens, deltas during generation, a final authoritative total. Different fields may be <em>cumulative</em> or <em>incremental</em>; the final event supersedes. Compute the exact cost given per-million-token prices; support tiered extras (e.g., cache reads billed at a discount). Money must be exact.</p></div>

### The approach

<img src="/diagrams/arcoding/b14.svg" alt="Streaming chunks update cumulative token counters with max so late duplicates cannot regress them, the final chunk overwrites authoritatively, and cost is computed once in Decimal." class="doc-diagram doc-diagram-seq" />

<p>The field semantics have to be <em>declared</em> before any code is written: these counters are cumulative, so a chunk carrying a smaller number is a late or duplicated one and <code>max</code> is the correct merge. The final chunk is authoritative and overwrites outright. Money is computed in <code>Decimal</code> from price <strong>strings</strong>, with exactly one rounding step at the very end — floats would drift, and rounding per-chunk would compound the error.</p>

### What it looks like in memory

<p>The output counter as the six chunks from <em>Run it</em> arrive — including the late one that must not roll it backwards.</p>

<img src="/diagrams/arcoding-state/b14.svg" alt="The output token counter as six streaming chunks arrive, including a late chunk carrying a smaller value." class="doc-diagram doc-diagram-seq" />

<h4>The two traps, named up front</h4>
<ol>
<li><strong>Float money.</strong> <code>0.000003 * 1_234_567</code> in binary floating point accumulates error across billions of requests; billing does not tolerate "approximately". Use <code>Decimal</code>, constructed from <em>strings</em> (constructing from a float imports the float's error).</li>
<li><strong>Cumulative vs incremental confusion.</strong> Summing counters that are already cumulative double-bills; taking the max of counters that are incremental under-bills. Normalize explicitly per field, and let a final authoritative record win.</li>
</ol>

<p class="covers">The complete program — save it as <code>b14_usage_cost.py</code> and run <code>python b14_usage_cost.py</code>.</p>

```python
from decimal import Decimal, ROUND_HALF_UP


class UsageAccumulator:
    """Feed streaming chunks; ask for exact cost at the end.
    Field semantics (declared, not guessed):
      - input_tokens: cumulative (known at prefill; may be restated at end)
      - output_tokens: cumulative running total in deltas
      - cache_read_tokens: cumulative
      - final chunk (is_final=True): authoritative for everything present"""

    CUMULATIVE = ("input_tokens", "output_tokens", "cache_read_tokens")

    def __init__(self):
        self.totals = {k: 0 for k in self.CUMULATIVE}
        self.finalized = False

    def feed(self, chunk: dict):
        """Example.

        Example:
            >>> acc = UsageAccumulator()
            >>> acc.feed({'usage': {'output_tokens': 50}})
            >>> acc.feed({'usage': {'output_tokens': 120}})
            >>> acc.feed({'usage': {'output_tokens': 90}})
            >>> acc.totals['output_tokens']
            120
        """
        usage = chunk.get("usage") or {}
        final = bool(chunk.get("is_final"))
        for k in self.CUMULATIVE:
            if k in usage:
                v = int(usage[k])
                if v < 0:
                    raise ValueError(f"negative token count for {k}")
                if final:
                    self.totals[k] = v            # authoritative overwrite
                else:
                    # cumulative counters are monotone; a smaller value is
                    # a late/duplicated chunk -> keep the max
                    self.totals[k] = max(self.totals[k], v)
        self.finalized = self.finalized or final

    def cost(self, prices: dict[str, str]) -> Decimal:
        """prices: per-MILLION-token price strings, e.g.
        {'input_tokens': '3.00', 'output_tokens': '15.00',
         'cache_read_tokens': '0.30'}

        Example:
            >>> acc = UsageAccumulator()
            >>> acc.feed({'usage': {'input_tokens': 1000, 'output_tokens': 500}, 'is_final': True})
            >>> acc.cost({'input_tokens': '3.00', 'output_tokens': '15.00', 'cache_read_tokens': '0.30'})
            Decimal('0.010500')
        """
        mtok = Decimal(1_000_000)
        total = Decimal(0)
        for field, count in self.totals.items():
            price = Decimal(prices[field])        # str -> exact
            total += Decimal(count) * price / mtok
        # one explicit rounding step, at the END, with a stated rule:
        return total.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)


if __name__ == "__main__":
    PRICES = {"input_tokens": "3.00",        # $ per million
              "output_tokens": "15.00",
              "cache_read_tokens": "0.30"}

    stream = [
        {"usage": {"input_tokens": 1200, "cache_read_tokens": 8000}},
        {"usage": {"output_tokens": 50}},
        {"usage": {"output_tokens": 120}},
        {"usage": {"output_tokens": 90}},      # late duplicate: must not regress
        {"usage": {"output_tokens": 300}},
        {"usage": {"input_tokens": 1200, "output_tokens": 305,
                   "cache_read_tokens": 8000}, "is_final": True},
    ]

    acc = UsageAccumulator()
    for i, chunk in enumerate(stream):
        acc.feed(chunk)
        print(f"chunk {i}: totals={acc.totals}")

    print("\nfinalized:", acc.finalized)
    print("cost     : $", acc.cost(PRICES), sep="")

    # float would drift here; Decimal does not
    print("\nfloat arithmetic drift:", 0.1 + 0.2 == 0.3)

    print("\n--- negative counts are rejected ---")
    try:
        UsageAccumulator().feed({"usage": {"output_tokens": -5}})
    except ValueError as e:
        print("ValueError:", e)
```

<p><strong>Output</strong></p>

```text
chunk 0: totals={'input_tokens': 1200, 'output_tokens': 0, 'cache_read_tokens': 8000}
chunk 1: totals={'input_tokens': 1200, 'output_tokens': 50, 'cache_read_tokens': 8000}
chunk 2: totals={'input_tokens': 1200, 'output_tokens': 120, 'cache_read_tokens': 8000}
chunk 3: totals={'input_tokens': 1200, 'output_tokens': 120, 'cache_read_tokens': 8000}
chunk 4: totals={'input_tokens': 1200, 'output_tokens': 300, 'cache_read_tokens': 8000}
chunk 5: totals={'input_tokens': 1200, 'output_tokens': 305, 'cache_read_tokens': 8000}

finalized: True
cost     : $0.010575

float arithmetic drift: False

--- negative counts are rejected ---
ValueError: negative token count for output_tokens
```

<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>Round once, at the end, with a named rule.</strong> Rounding per-chunk or per-field accumulates bias; <code>ROUND_HALF_UP</code> vs banker's rounding changes revenue at scale — the point is that you <em>chose</em> and can defend it.</li>
<li><strong>Robustness:</strong> chunks may duplicate, arrive with partial usage, or restate earlier counters — the max-for-cumulative rule plus final-overwrite handles all three; negative counts are rejected loudly.</li>
<li><strong>If deltas are truly incremental</strong> (spec variant): sum them but make ingestion idempotent (chunk ids + a seen-set), because at-least-once delivery + summation = double billing. Saying that sentence connects the toy to real metering pipelines.</li>
<li><strong>Property test to offer:</strong> replaying any prefix of chunks never yields a higher cost than the full stream; final-chunk totals always equal the computed totals.</li>
</ul></div>

<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> O(#chunks) with O(1) work per chunk; <code>cost()</code> is O(#fields). <strong>Space:</strong> O(1) — only running totals, no chunk buffering, so it streams over arbitrarily long generations.</p><p><strong>How efficient is it?</strong> Computationally trivial by design — the efficiency story here is <em>correctness at scale</em>: Decimal arithmetic costs a few times more than float per operation (still nanoseconds, irrelevant next to a network chunk), and buys exactness across billions of requests where float error compounds into real money. Single-rounding-at-the-end also minimizes accumulated rounding bias — a policy choice, not a performance one, and worth framing that way.</p></div>

</div>
