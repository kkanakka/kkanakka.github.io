---
title: "B1 · Stack samples → trace events"
slug: /coding/arcoding/b1-stack-samples-trace-events
sidebar_position: 8
sidebar_label: "B1 · Stack samples → trace events"
description: "B1 · Stack samples → trace events"
---

<div class="arcoding">

## B1 · Stack samples → trace events

<p class="covers">Covers 6 listed variants: Convert Streaming Call-Stack Samples · Convert Stack Samples into Trace Events · Generate Function Profiling Events · Convert stack samples to execution trace · Convert Samples into Event Intervals · Convert State Stream to Events. <strong>The most-reported Anthropic question family</strong> (1,000+ recorded solves across variants).</p>
<div class="adm info"><div class="adm-title">ℹ️ Problem</div>
<p>A sampling profiler emits <code>(timestamp, stack)</code> in increasing time order, stack listed root→leaf. Reconstruct minimal ordered start/end events. A frame continues between consecutive samples only if the same function name appears at the same depth with identical ancestors. Recursive frames (<code>[a, b, a]</code>) are distinct occurrences. Emit end events before start events at a shared timestamp; close all open frames after the last sample.</p></div>

### The approach

<img src="/diagrams/arcoding/b1.svg" alt="Two adjacent stack samples are compared by longest common prefix; frames below it in the old stack end deepest-first, frames below it in the new stack start root-first." class="doc-diagram doc-diagram-seq" />

<p>Two adjacent samples can only differ at their tail, so the <strong>longest common prefix is exactly the set of frames that survived</strong> between them. Everything below the prefix in the old stack has ended; everything below it in the new stack has begun. Emitting the ends deepest-first and the starts root-first is what keeps the trace well-nested — a callee has to close before its caller, and a caller has to open before its callee. The only state you carry between samples is the previous stack.</p>

### What it looks like in memory

<p>The state mid-run, using the samples from <em>Run it</em> below — the one list carried between samples, and what the arrival of the fourth one emits.</p>

<img src="/diagrams/arcoding-state/b1.svg" alt="The previous stack, and the events the fourth sample causes." class="doc-diagram doc-diagram-seq" />
<h4>The one idea: longest common prefix</h4>
<p>Between consecutive samples, the LCP of the two stacks is exactly the set of frames that survived. Everything in the old stack below the LCP ended (close leaf-first); everything in the new stack below the LCP started (open root-first). Positional comparison is what makes recursion correct for free: <code>[a,b,a]</code> → <code>[a,b]</code> has LCP length 2, so only the inner <code>a</code> closes.</p>

```python
def samples_to_trace(samples):
    """samples: iterable of (timestamp, [root, ..., leaf]), timestamps increasing.
    Returns [(timestamp, 'start'|'end', function_name)].

    Example:
        >>> s = [(0, ['main']), (1, ['main', 'work']), (4, ['main'])]
        >>> samples_to_trace(s)
        [(0, 'start', 'main'), (1, 'start', 'work'), (4, 'end', 'work'), (4, 'end', 'main')]
    """
    events = []          # the output we are building
    prev = []            # the PREVIOUS sample's stack (empty before the first)
    prev_t = None        # the previous sample's timestamp

    for t, stack in samples:                  # unpack (timestamp, stack)
        # sanity: the input promises increasing timestamps — enforce it
        if prev_t is not None and t <= prev_t:
            raise ValueError("timestamps must be strictly increasing")

        # 1) find the Longest Common Prefix of old stack vs new stack:
        #    these are the frames that SURVIVED between the two samples
        lcp = 0
        while (lcp < len(prev) and lcp < len(stack)
               and prev[lcp] == stack[lcp]):  # same name at same depth
            lcp += 1

        # 2) every old frame BELOW the common prefix has ended.
        #    reversed() = close the deepest (leaf) frame first,
        #    because a callee must end before its caller
        for name in reversed(prev[lcp:]):
            events.append((t, "end", name))

        # 3) every new frame below the prefix has just started.
        #    root first: a caller starts before its callee
        for name in stack[lcp:]:
            events.append((t, "start", name))

        prev, prev_t = list(stack), t         # remember for the next round
        # (list(stack) copies it, in case the caller reuses their list)

    # 4) after the last sample, whatever is still open must be closed
    for name in reversed(prev):
        events.append((prev_t, "end", name))
    return events
```

<h4>Variant A — interval output ("Convert Samples into Event Intervals")</h4>
<p>Same LCP core, but pair each start with its end and emit <code>(name, start_t, end_t, depth)</code>:</p>

```python
def samples_to_intervals(samples):
    """Same input, but emit (name, start, end, depth) intervals instead of events.

    Example:
        >>> s = [(0, ['main']), (1, ['main', 'work']), (4, ['main'])]
        >>> samples_to_intervals(s)
        [('work', 1, 4, 1), ('main', 0, 4, 0)]
    """
    intervals, open_frames, prev, prev_t = [], [], [], None
    for t, stack in samples:
        lcp = 0
        while lcp < len(prev) and lcp < len(stack) and prev[lcp] == stack[lcp]:
            lcp += 1
        while len(open_frames) > lcp:                  # close, leaf-first
            name, start = open_frames.pop()
            intervals.append((name, start, t, len(open_frames)))
        for name in stack[lcp:]:                       # open, root-first
            open_frames.append((name, t))
        prev, prev_t = list(stack), t
    while open_frames:
        name, start = open_frames.pop()
        intervals.append((name, start, prev_t, len(open_frames)))
    return intervals
```

<h4>Variant B — state stream RLE ("Convert State Stream to Events")</h4>
<p>The depth-1 special case: a sequence of <code>(t, state)</code> becomes intervals wherever the state changes — pure run-length encoding. If you see the general solution, this one is three lines of the same loop; recognizing the family relationship out loud is the win.</p>
<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>Ordering at a shared timestamp:</strong> ends before starts — otherwise a consumer sees two frames "open" at the same depth. Tested every time.</li>
<li><strong>Streaming version</strong> ("Convert <em>Streaming</em> Call-Stack Samples"): the algorithm is already online — it holds only the previous stack, O(depth) state. Package it as a generator/class with <code>feed(sample)</code> and <code>finish()</code> and say the memory bound.</li>
<li><strong>Semantics of the last sample:</strong> does the final sample's stack end <em>at</em> its timestamp or extend one sampling interval? Ask; both conventions appear in variants.</li>
<li><strong>Complexity:</strong> O(total stack frames) time, O(max depth) space — optimal, since every frame must be touched once.</li>
</ul></div>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> O(total stack frames across all samples). Each frame is compared once in an LCP, opened once, and closed once. <strong>Space:</strong> O(max stack depth) beyond the output — the algorithm is naturally streaming/online.</p><p><strong>How efficient is it?</strong> Provably optimal: every input frame must be examined at least once, and every emitted event corresponds to a real frame change, so output size is Θ(changes). There is no asymptotically better algorithm — say that, then spend saved time on edge cases (shared-timestamp ordering, recursion, the final flush).</p></div>

### Run it

<p class="covers">Append this to the code above, save as <code>b1_stack_samples.py</code>, then run <code>python b1_stack_samples.py</code>.</p>

```python
if __name__ == "__main__":
    samples = [
        (0, ["main"]),
        (1, ["main", "load_config"]),
        (2, ["main", "load_config", "parse"]),
        (5, ["main", "render"]),
    ]

    print("--- trace events ---")
    for t, kind, name in samples_to_trace(samples):
        print(f"{t:>3}  {kind:<5} {name}")

    print("\n--- intervals (name, start, end, depth) ---")
    for row in samples_to_intervals(samples):
        print(row)

    print("\n--- non-increasing timestamps are rejected ---")
    try:
        samples_to_trace([(1, ["a"]), (1, ["b"])])
    except ValueError as e:
        print("ValueError:", e)
```

<p><strong>Output</strong></p>

```text
--- trace events ---
  0  start main
  1  start load_config
  2  start parse
  5  end   parse
  5  end   load_config
  5  start render
  5  end   render
  5  end   main

--- intervals (name, start, end, depth) ---
('parse', 2, 5, 2)
('load_config', 1, 5, 1)
('render', 5, 5, 1)
('main', 0, 5, 0)

--- non-increasing timestamps are rejected ---
ValueError: timestamps must be strictly increasing
```

</div>
