---
title: "B2 · Exclusive time & slowest function from START–END logs"
slug: /coding/arcoding/b2-exclusive-time-slowest-function-from-start-end-logs
sidebar_position: 9
sidebar_label: "B2 · Exclusive time & slowest function from…"
description: "B2 · Exclusive time & slowest function from START–END logs"
---

<div class="arcoding">

## B2 · Exclusive time & slowest function from START–END logs

<p class="covers">Covers 5 variants: Compute Exclusive Time from Stack Events · Simulate stack traces from logs · Compute exclusive times and call stack from logs · Find the Slowest Function from Profiler Events · Parse and Reconstruct Stack Trace.</p>
<div class="adm info"><div class="adm-title">ℹ️ Problem</div>
<p>Single-threaded event log of <code>(name, START|END, t)</code>. Compute (a) exclusive time per function — time with the function on top of the stack, excluding callees; (b) the slowest single <em>call</em> by wall time; (c) the active call stack at any query time T. Handle malformed logs.</p></div>

### The approach

<img src="/diagrams/arcoding/b2.svg" alt="A START pauses the caller by crediting it up to t and resetting its resume marker before pushing the new frame; an END pops, credits the elapsed time since the last resume, and restarts the caller's clock." class="doc-diagram doc-diagram-seq" />

<p>Each stack frame carries three numbers: the name, when it was entered, and <strong>when its own clock last resumed</strong>. A START pauses the caller — credit it up to now, then reset its marker — before pushing the new frame; an END credits the popped frame from its last resume and restarts the caller. That third number is the whole trick: without it you cannot separate a function's own time from time spent inside its callees. Exclusive time comes from the resume marker, wall time from the entry timestamp.</p>

### What it looks like in memory

<p>The stack at the instant <code>load</code> starts, from the four events used in <em>Run it</em> — and the third number in each frame that makes exclusive time possible.</p>

<img src="/diagrams/arcoding-state/b2.svg" alt="The frame stack and the exclusive-time table at the moment load starts." class="doc-diagram doc-diagram-seq" />
<h4>Two clocks per frame</h4>
<p>Each open frame carries <code>entry_t</code> (for wall time → slowest call) and <code>last_resume_t</code> (for exclusive time). START pauses the caller's exclusive clock; END credits the popped frame and resumes the caller's clock. That separation is the entire problem.</p>

```python
from collections import defaultdict


class LogError(ValueError):
    pass


def profile(events, *, end_inclusive=False):
    """events: iterable of (name, 'START'|'END', t), t non-decreasing.
    end_inclusive=True treats an END at t as running through the end of
    time unit t (the LeetCode-636 convention) — ask which one applies!
    Returns (exclusive_times, (slowest_name, slowest_wall), call_log).

    Example:
        >>> evs = [('main','START',0), ('work','START',2), ('work','END',5), ('main','END',6)]
        >>> profile(evs, end_inclusive=True)
        ({'main': 3, 'work': 4}, ('main', 7), [('work', 2, 6, 1), ('main', 0, 7, 0)])
    """
    bump = 1 if end_inclusive else 0
    excl = defaultdict(int)
    stack = []                     # [name, entry_t, last_resume_t]
    slowest = (None, -1)
    call_log = []                  # (name, entry_t, exit_t, depth) for queries
    prev_t = None

    for name, kind, t in events:
        if prev_t is not None and t < prev_t:
            raise LogError(f"time went backwards at {t}")
        prev_t = t
        if kind == "START":
            if stack:
                top = stack[-1]                # caller's exclusive clock pauses:
                excl[top[0]] += t - top[2]     # credit it up to now...
                top[2] = t                     # ...then reset its resume marker
            stack.append([name, t, t])
        elif kind == "END":
            if not stack:
                raise LogError(f"END '{name}' with empty stack at {t}")
            top_name, entry, last = stack.pop()
            if top_name != name:
                raise LogError(f"END '{name}' but '{top_name}' is on top")
            end_t = t + bump
            excl[name] += end_t - last
            wall = end_t - entry
            call_log.append((name, entry, end_t, len(stack)))
            if wall > slowest[1]:
                slowest = (name, wall)
            if stack:
                stack[-1][2] = end_t          # caller's clock resumes
        else:
            raise LogError(f"unknown event kind {kind!r}")

    if stack:
        raise LogError(f"unterminated calls: {[f[0] for f in stack]}")
    return dict(excl), slowest, call_log


def stack_at(call_log, T):
    """Active call stack at time T, outermost first (variant c).

    Example:
        >>> _, _, log = profile([('main','START',0), ('work','START',2), ('work','END',5), ('main','END',6)], end_inclusive=True)
        >>> stack_at(log, 3)
        ['main', 'work']
    """
    frames = [(d, n) for n, s, e, d in call_log if s <= T < e]
    return [n for d, n in sorted(frames)]
```

<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>The timestamp convention</strong> — instantaneous END vs inclusive-last-unit — changes every answer by ±1. Asking before coding is itself graded.</li>
<li><strong>Malformed input:</strong> END on empty stack, name mismatch, time going backwards, unterminated frames at EOF. The reported variants explicitly test these; raising precise errors beats silently "fixing" the log.</li>
<li><strong>Invariant to state:</strong> at every instant exactly one function (the stack top) accrues exclusive time, so Σ exclusive = total elapsed span — offer it as your self-check.</li>
<li><strong>"Slowest" ambiguity:</strong> slowest single <em>call</em> vs largest <em>total</em> (Σ wall per name) vs largest exclusive — three different answers; confirm which.</li>
</ul></div>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> O(#events), single pass — each event does O(1) stack work and O(1) dict updates. <strong>Space:</strong> O(max call depth) for the stack + O(distinct functions) for totals + O(#calls) only if you keep the call log for time-T queries; <code>stack_at</code> as written is O(#calls) per query (an interval tree makes it O(log n + matches) if queried often).</p><p><strong>How efficient is it?</strong> Optimal for the pass itself. The built-in self-check is free: Σ exclusive times must equal the total elapsed span, because exactly one frame (the top) accrues at any instant — offer it as a validation step.</p></div>

### Run it

<p class="covers">Append this to the code above, save as <code>b2_exclusive_time.py</code>, then run <code>python b2_exclusive_time.py</code>.</p>

```python
if __name__ == "__main__":
    # main runs 0-2, calls load (2-5 inclusive), resumes 6
    events = [
        ("main", "START", 0),
        ("load", "START", 2),
        ("load", "END",   5),
        ("main", "END",   6),
    ]

    excl, slowest, call_log = profile(events, end_inclusive=True)
    print("exclusive times :", excl)          # LeetCode-636 convention
    print("slowest by wall :", slowest)
    print("call log        :", call_log)
    print("stack at t=3    :", stack_at(call_log, 3))
    print("stack at t=6    :", stack_at(call_log, 6))

    excl2, _, _ = profile(events)             # end_inclusive=False
    print("\nhalf-open convention:", excl2)

    print("\n--- malformed logs are rejected, not silently averaged ---")
    for bad in ([("a", "END", 1)],
                [("a", "START", 0), ("b", "END", 1)],
                [("a", "START", 0)]):
        try:
            profile(bad)
        except LogError as e:
            print("LogError:", e)
```

<p><strong>Output</strong></p>

```text
exclusive times : {'main': 3, 'load': 4}
slowest by wall : ('main', 7)
call log        : [('load', 2, 6, 1), ('main', 0, 7, 0)]
stack at t=3    : ['main', 'load']
stack at t=6    : ['main']

half-open convention: {'main': 3, 'load': 3}

--- malformed logs are rejected, not silently averaged ---
LogError: END 'a' with empty stack at 1
LogError: END 'b' but 'a' is on top
LogError: unterminated calls: ['a']
```

</div>
