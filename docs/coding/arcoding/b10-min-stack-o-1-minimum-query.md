---
title: "B10 · Min stack — O(1) minimum query"
slug: /coding/arcoding/b10-min-stack-o-1-minimum-query
sidebar_position: 17
sidebar_label: "B10 · Min stack — O(1) minimum query"
description: "B10 · Min stack — O(1) minimum query"
---

<div class="arcoding">

## B10 · Min stack — O(1) minimum query

<p class="covers">Covers: Design stack with O(1) minimum query — the listing explicitly calls out empty-stack edge cases.</p>

### The approach

<img src="/diagrams/arcoding/b10.svg" alt="Each stack cell stores a value together with the minimum at the time it was pushed, so popping automatically restores the previous minimum." class="doc-diagram doc-diagram-seq" />

<p>Store a <em>pair</em> per cell: the value, and the minimum of the stack at the moment it was pushed. Popping then needs no recomputation at all — <strong>the new top already carries the previous minimum</strong>. A single running-minimum variable cannot work, because popping the current minimum leaves you with no way to recover the next-smallest without scanning. The paired storage is that history, computed once at push time.</p>

### What it looks like in memory

<p>The stack after the four pushes in <em>Run it</em>, with the minimum each cell carries alongside its value.</p>

<img src="/diagrams/arcoding-state/b10.svg" alt="A four-cell stack where each cell stores a value and the minimum at the time it was pushed." class="doc-diagram doc-diagram-seq" />

```python
class MinStack:
    """Every element is stored with the minimum of the stack AT THE TIME it
    was pushed — so pop restores the previous minimum with zero recompute."""

    def __init__(self):
        self._s = []                        # (value, min_including_this)

    def push(self, x):
        """Push x, storing the running minimum alongside it.

        Example:
            >>> s = MinStack()
            >>> s.push(5); s.push(3)
            >>> s.get_min()
            3
        """
        m = x if not self._s else min(x, self._s[-1][1])
        self._s.append((x, m))

    def pop(self):
        """Remove and return the top value (None if empty); the minimum self-restores.

        Example:
            >>> s = MinStack()
            >>> s.push(5); s.push(3)
            >>> s.pop()
            3
            >>> s.get_min()
            5
        """
        if not self._s:
            return None                     # spec-driven: sentinel, not raise
        return self._s.pop()[0]

    def top(self):
        """Return the top value without removing it (None if empty).

        Example:
            >>> s = MinStack()
            >>> s.push(5); s.push(3)
            >>> s.top()
            3
        """
        return self._s[-1][0] if self._s else None

    def get_min(self):
        """Return the current minimum in O(1) (None if empty).

        Example:
            >>> s = MinStack()
            >>> s.push(5); s.push(3); s.push(7)
            >>> s.get_min()
            3
        """
        return self._s[-1][1] if self._s else None
```

<p><strong>Space-optimized variant</strong> (the follow-up): keep a second stack that only records <em>new</em> minima; pop from it when the popped value equals its top (push duplicates of equal minima, or store counts). Amortized O(1), and space drops to O(#distinct-minima) for mostly-increasing input. The exotic O(1)-extra-space encoding trick (storing <code>2x − min</code>) exists — mention it only as trivia; it breaks on unbounded ints in theory-pure terms and hurts readability.</p>
<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>Empty-stack behavior</strong> is the named test: agree the contract (None vs raise) before coding, then implement it consistently across all three query methods.</li>
<li><strong>Why not track min in one variable:</strong> pop can remove the current minimum, and recovering the next-smallest without history is O(n) — the paired storage <em>is</em> the history.</li>
<li><strong>Extensions:</strong> <code>get_max</code> too (store a triple), and O(1) <code>pop_min</code> (needs a different structure — a stack cannot; saying "no, and here's why" is correct).</li>
</ul></div>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> push, pop, top, get_min all O(1) — hard, worst-case, not amortized. <strong>Space:</strong> O(n) storing a pair per element; the auxiliary-stack variant shrinks that to O(#times a new minimum appears), which for random or increasing input is far smaller.</p><p><strong>How efficient is it?</strong> Optimal — O(1) everything is the floor, and the trade between the two variants is pure space-vs-simplicity. The key argument to make: a single min variable cannot work because popping the current minimum requires knowing the <em>previous</em> minimum, i.e., history — the paired storage is that history, precomputed at push time.</p></div>

### Run it

<p class="covers">Append this to the code above, save as <code>b10_min_stack.py</code>, then run <code>python b10_min_stack.py</code>.</p>

```python
if __name__ == "__main__":
    s = MinStack()
    print("empty -> top/pop/get_min:", s.top(), s.pop(), s.get_min())

    for x in (5, 3, 7, 3):
        s.push(x)
        print(f"push {x} -> min={s.get_min()} top={s.top()}")

    while (v := s.pop()) is not None:
        print(f"pop  {v} -> min={s.get_min()} top={s.top()}")
```

<p><strong>Output</strong></p>

```text
empty -> top/pop/get_min: None None None
push 5 -> min=5 top=5
push 3 -> min=3 top=3
push 7 -> min=3 top=7
push 3 -> min=3 top=3
pop  3 -> min=3 top=7
pop  7 -> min=3 top=3
pop  3 -> min=5 top=5
pop  5 -> min=None top=None
empty -> top/pop/get_min: None None None
push 5 -> min=5 top=5
push 3 -> min=3 top=3
push 7 -> min=3 top=7
push 3 -> min=3 top=3
pop  3 -> min=3 top=7
pop  7 -> min=3 top=3
pop  3 -> min=5 top=5
pop  5 -> min=None top=None
```

</div>
