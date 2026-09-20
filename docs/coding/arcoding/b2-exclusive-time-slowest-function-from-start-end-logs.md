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
<h4>Two clocks per frame</h4>
<p>Each open frame carries <code>entry_t</code> (for wall time → slowest call) and <code>last_resume_t</code> (for exclusive time). START pauses the caller's exclusive clock; END credits the popped frame and resumes the caller's clock. That separation is the entire problem.</p>

```
from collections import defaultdict


class LogError(ValueError):
    pass


def profile(events, *, end_inclusive=False):
    """events: iterable of (name, 'START'|'END', t), t non-decreasing.
    end_inclusive=True treats an END at t as running through the end of
    time unit t (the LeetCode-636 convention) — ask which one applies!
    Returns (exclusive_times, (slowest_name, slowest_wall), call_log)."""
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
                stack[-1][2] = t   # caller's exclusive clock pauses here...
                excl[stack[-1][0]] += t - stack[-1][2] if False else 0
            # (pause = credit up to t, then reset resume marker)
            if stack:
                top = stack[-1]
                excl[top[0]] += t - top[2]
                top[2] = t
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
    """Active call stack at time T, outermost first (variant c)."""
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

</div>
