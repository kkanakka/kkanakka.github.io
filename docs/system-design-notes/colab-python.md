---
title: "Design and code a Python solution in Colab"
slug: /system-design-notes/colab-python
sidebar_position: 32
sidebar_label: "Design and code a Python solution in Colab"
description: "coding · structure · tests · maintainability · what \"senior code\" looks like in a notebook"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/colab-python/sequence.svg" alt="How it works — colab-python" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
<header>
  
  <span class="tag">coding · structure · tests · maintainability · what "senior code" looks like in a notebook</span>
</header>
<p>You get a notebook and a mid‑sized task (parse a dataset, build a small service or pipeline, implement an algorithm with edge cases). The evaluation is engineering quality under time pressure: how you decompose, name, test, and leave the code runnable by someone else.</p>

## Requirements {#colab-python-req}

<div class="board">
  <div><h4>Functional</h4><ol>
      <li>Solve the stated task correctly on the given data plus edge cases</li>
      <li>Code runnable top‑to‑bottom in a fresh runtime</li>
      <li>Tests that demonstrate correctness; clear entry point</li>
      <li>Explain trade‑offs and what you'd change for production</li>
      <li class="out">Full packaging, CI</li>
  </ol></div>
  <div><h4>Non‑functional</h4><ol>
      <li>Readable: small functions, types, docstrings where they add meaning</li>
      <li>Deterministic: seeds, pinned behavior, no hidden state across cells</li>
      <li>Efficient enough: state the complexity; vectorize or stream when data is large</li>
      <li>Robust: input validation, clear errors, no silent failures</li>
  </ol></div>
</div>
<div class="note"><b>Notebook traps:</b> cells run out of order leave stale globals; a function that works only because a cell above defined a variable is a bug. Keep logic in functions with explicit parameters, and restart‑and‑run‑all before you say "done".</div>

## Structure to lay out in the first five minutes {#colab-python-api}

<p>Cell 1 imports + config · Cell 2 data model (dataclasses / typed dicts) · Cell 3 pure functions (parse, transform, compute) · Cell 4 I/O wrappers · Cell 5 tests (pytest‑style or asserts) · Cell 6 main() run on the real input · Final cell: notes on complexity, limits, next steps.</p>
<pre><code>from dataclasses import dataclass
from typing import Iterable, Iterator
import csv, io, logging

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

@dataclass(frozen=True)
class Event:
    user_id: str
    ts: int
    amount: float

def parse_events(lines: Iterable[str]) -&gt; Iterator[Event]:
    """Stream rows; skip malformed with a logged count, never silently."""
    bad = 0
    for i, row in enumerate(csv.DictReader(lines)):
        try:
            yield Event(row["user_id"], int(row["ts"]), float(row["amount"]))
        except (KeyError, ValueError) as e:
            bad += 1
            log.warning("row %d skipped: %s", i, e)
    if bad:
        log.info("skipped %d malformed rows", bad)

def top_users(events: Iterable[Event], k: int) -&gt; list[tuple[str, float]]:
    """O(n log k): one pass to aggregate, heap for top-k."""
    import heapq
    from collections import defaultdict
    totals: dict[str, float] = defaultdict(float)
    for e in events:
        totals[e.user_id] += e.amount
    return heapq.nlargest(k, totals.items(), key=lambda kv: kv[1])

# --- tests (run in-notebook) ---
def test_top_users_basic():
    ev = [Event("a",1,5.0), Event("b",2,7.0), Event("a",3,4.0)]
    assert top_users(ev, 1) == [("a", 9.0)]
def test_parse_skips_bad_rows():
    src = io.StringIO("user_id,ts,amount\na,1,2.5\nbad,x,y\n")
    assert [e.user_id for e in parse_events(src)] == ["a"]
test_top_users_basic(); test_parse_skips_bad_rows(); print("tests ok")

# --- entry point ---
def main(path: str, k: int = 10):
    with open(path) as f:
        for user, total in top_users(parse_events(f), k):
            print(f"{user}\t{total:.2f}")</code></pre>

## Design {#colab-python-design}

<figure>
<svg viewBox="0 0 980 170" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Notebook layout: config, model, pure core, I/O edge, tests, main, notes">
<defs><marker id="dg1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="dg3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#dg1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#dg3);stroke-dasharray:2 4}.lbl{font-size:10.5px;fill:#1F4E9E}</style>
<rect class="box" x="20" y="60" width="130" height="70"></rect><text class="tb" x="85" y="78" text-anchor="middle">Config + imports</text>
<text class="ts" x="85" y="94" text-anchor="middle">seeds, paths</text>
<text class="ts" x="85" y="107" text-anchor="middle">logging</text>
<rect class="box" x="180" y="60" width="130" height="70"></rect><text class="tb" x="245" y="78" text-anchor="middle">Data model</text>
<text class="ts" x="245" y="94" text-anchor="middle">dataclasses</text>
<text class="ts" x="245" y="107" text-anchor="middle">types</text>
<rect class="box" x="340" y="60" width="150" height="70" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="415" y="78" text-anchor="middle">Pure core</text>
<text class="ts" x="415" y="94" text-anchor="middle">parse / transform / compute</text>
<text class="ts" x="415" y="107" text-anchor="middle">no I/O, easy to test</text>
<rect class="box" x="520" y="60" width="130" height="70"></rect><text class="tb" x="585" y="78" text-anchor="middle">I/O edge</text>
<text class="ts" x="585" y="94" text-anchor="middle">files, APIs</text>
<text class="ts" x="585" y="107" text-anchor="middle">thin wrappers</text>
<rect class="box" x="680" y="60" width="130" height="70" stroke="#B45309"></rect><text class="tb" x="745" y="78" text-anchor="middle">Tests</text>
<text class="ts" x="745" y="94" text-anchor="middle">edge cases</text>
<text class="ts" x="745" y="107" text-anchor="middle">run in-notebook</text>
<rect class="box" x="840" y="60" width="120" height="70"></rect><text class="tb" x="900" y="78" text-anchor="middle">main()</text>
<text class="ts" x="900" y="94" text-anchor="middle">restart &amp; run all</text>
<line class="f" x1="150" y1="95" x2="178" y2="95"></line>
<line class="f" x1="310" y1="95" x2="338" y2="95"></line>
<line class="f" x1="490" y1="95" x2="518" y2="95"></line>
<line class="f" x1="650" y1="95" x2="678" y2="95"></line>
<line class="f" x1="810" y1="95" x2="838" y2="95"></line>
<text class="ts" x="20" y="140">Dependencies point inward: I/O and main depend on the core; the core depends on nothing but the model.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 440" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="How to spend the hour">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="5" y="14" width="130" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">You</text>
<line class="ln" x1="70" y1="48" x2="70" y2="420"></line>
<rect class="sb" x="425" y="14" width="130" height="34"></rect><text class="st" x="490" y="36" text-anchor="middle">Interviewer</text>
<line class="ln" x1="490" y1="48" x2="490" y2="420"></line>
<rect class="sb" x="845" y="14" width="130" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Notebook</text>
<line class="ln" x1="910" y1="48" x2="910" y2="420"></line>
<line class="a1" x1="78" y1="80" x2="482" y2="80"></line>
<text class="sl" x="280" y="74" text-anchor="middle">restate task, inputs, outputs, scale, edge cases</text>
<line class="a2" x1="482" y1="114" x2="78" y2="114"></line>
<text class="sl" x="280" y="108" text-anchor="middle">clarifications</text>
<line class="a1" x1="78" y1="148" x2="902" y2="148"></line>
<text class="sl" x="490" y="142" text-anchor="middle">skeleton cells with function signatures + TODOs</text>
<line class="a1" x1="78" y1="182" x2="902" y2="182"></line>
<text class="sl" x="490" y="176" text-anchor="middle">happy-path core function</text>
<line class="a1" x1="78" y1="216" x2="902" y2="216"></line>
<text class="sl" x="490" y="210" text-anchor="middle">2–3 asserts, run</text>
<line class="a1" x1="78" y1="250" x2="902" y2="250"></line>
<text class="sl" x="490" y="244" text-anchor="middle">edge cases: empty, malformed, duplicates, huge</text>
<line class="a1" x1="78" y1="284" x2="902" y2="284"></line>
<text class="sl" x="490" y="278" text-anchor="middle">I/O wrapper + main; restart &amp; run all</text>
<line class="a1" x1="78" y1="318" x2="482" y2="318"></line>
<text class="sl" x="280" y="312" text-anchor="middle">walk through: complexity, limits, prod changes</text>
<line class="a2" x1="482" y1="352" x2="78" y2="352"></line>
<text class="sl" x="280" y="346" text-anchor="middle">follow-ups: scale ×100? new field?</text>
<line class="a1" x1="78" y1="386" x2="902" y2="386"></line>
<text class="sl" x="490" y="380" text-anchor="middle">small change shows the structure holds</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>You → Interviewer:</b> restate task, inputs, outputs, scale, edge cases</li>
  <li><b>Interviewer → You:</b> clarifications (response)</li>
  <li><b>You → Notebook:</b> skeleton cells with function signatures + TODOs</li>
  <li><b>You → Notebook:</b> happy-path core function</li>
  <li><b>You → Notebook:</b> 2–3 asserts, run</li>
  <li><b>You → Notebook:</b> edge cases: empty, malformed, duplicates, huge</li>
  <li><b>You → Notebook:</b> I/O wrapper + main; restart &amp; run all</li>
  <li><b>You → Interviewer:</b> walk through: complexity, limits, prod changes</li>
  <li><b>Interviewer → You:</b> follow-ups: scale ×100? new field? (response)</li>
  <li><b>You → Notebook:</b> small change shows the structure holds</li>
</ol>

## Deep dives {#colab-python-deep}

<div class="cards">
<div><h4>Structure</h4><ul><li>Separate pure logic from I/O; test the pure part with in‑memory data.</li><li>Small functions with one job; names that say what, docstrings that say why or the invariant.</li><li>Types on public functions; dataclasses for records instead of dict soup.</li><li>Constants and config at the top; no magic numbers in the middle of loops.</li></ul></div>
<div><h4>Correctness and tests</h4><ul><li>Write the first test before the second feature; asserts in a cell count.</li><li>Edge cases named aloud: empty input, one element, duplicates, malformed rows, unicode, huge values, ties in top‑k.</li><li>Deterministic: fixed seeds, sorted outputs where order matters.</li><li>Errors: validate at the edge, fail loudly with context, log skipped records with counts.</li></ul></div>
<div><h4>Performance and maintainability</h4><ul><li>State complexity; use generators/streaming for large files; pandas/numpy for columnar work with a note on memory.</li><li>Avoid notebook global state; functions take parameters; restart‑and‑run‑all is the acceptance test.</li><li>Say what you'd do for production: package, CLI/argparse, pytest, type checking, CI, observability.</li><li>Leave a final cell with assumptions, limits, and next steps.</li></ul></div></div>

## Don't leave the room without saying {#colab-python-check}

<ul class="checklist">
  <li>Restate the problem and edge cases before typing</li>
  <li>Skeleton first: model, pure core, I/O, tests, main</li>
  <li>Tests in the notebook that actually run</li>
  <li>Types, dataclasses, logging, explicit errors</li>
  <li>Complexity stated; streaming for big inputs</li>
  <li>Restart &amp; run all before "done"; production notes at the end</li>
</ul>

## What each level is expected to drive {#colab-python-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Working solution, some structure, a couple of asserts</td><td>Edge cases, separation of I/O</td></tr>
  <tr><td>Senior</td><td>Clean decomposition, typed core, tests for edge cases, complexity reasoning, deterministic runs</td><td>Production hardening plan</td></tr>
  <tr><td>Staff+</td><td>Code that reads like a small library, tests as specification, explicit trade‑offs, handles follow‑up changes without restructuring</td><td>—</td></tr>
</tbody></table>
