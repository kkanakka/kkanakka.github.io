---
title: "Design and code a Python solution in Colab"
slug: /aire/colab-python
sidebar_position: 14
sidebar_label: "Design and code a Python solution in Colab"
description: "coding · structure · tests · maintainability · what \"senior code\" looks like in a notebook"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/colab-python/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

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


## Scale, performance and safety targets {#colab-python-targets}

<p>Even a notebook exercise has budgets, and stating them is itself part of what is being assessed — the interviewer is watching whether you size the problem before coding it.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>Input size:</b> ask before writing anything. A thousand rows and a hundred million rows are different programs — one can hold everything in a dict, the other must stream.</li>
    <li><b>Data volume:</b> if the data does not fit comfortably in memory, say so and stream: generators, chunked reads, and aggregation as you go rather than building a list first.</li>
    <li><b>Growth:</b> "what if this is 100× bigger?" is the standard follow‑up, so structure the code so the answer is swapping one function rather than rewriting the solution.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Complexity:</b> state it out loud — O(n) with a dict rather than O(n²) with nested loops, and name the memory cost alongside the time cost. Being able to say the complexity matters more than shaving constants.</li>
    <li><b>Throughput:</b> vectorise with pandas or numpy when the data is numeric and large, stream when it is not, and measure before optimising. A profiler beats intuition even at this scale.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Input validation:</b> the "adversary" is malformed data — empty files, missing columns, duplicate keys, wrong encodings, unexpected nulls. Validate at the boundary and fail with a clear error rather than producing a confidently wrong number.</li>
    <li><b>Bounded work:</b> guard against pathological inputs: cap what a single record can consume, avoid unbounded recursion, and never build an in‑memory structure proportional to something the input controls without saying so.</li>
    <li><b>Data sensitivity:</b> if the dataset looks like real user data, do not print it wholesale into cell output — notebook outputs are saved with the file and shared. Print shapes, counts and samples rather than everything.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Reproducibility:</b> the equivalent requirement here is that <b>restart‑and‑run‑all works</b>. Code that only runs because a cell above happened to execute earlier is broken, whatever the output currently shows.</li>
    <li><b>Degraded mode:</b> malformed rows are skipped and counted rather than crashing the run; the count is reported at the end. Silent skipping is worse than crashing, because it produces a plausible wrong answer nobody questions.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Determinism:</b> seed anything random, avoid relying on dict or set iteration order for output, and pin behaviour that varies by platform — an interviewer re‑running your notebook should get your numbers.</li>
    <li><b>Correctness evidence:</b> tests are the deliverable, not decoration. A few asserts covering happy path, empty input, and one nasty edge case demonstrate more than any amount of explanation.</li>
    <li><b>Production delta:</b> be ready to name what changes outside a notebook — packaging, logging, error handling, configuration, CI — because "what would you change for production?" is always asked.</li></ul></div>
</div>

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

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/colab-python/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

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
  <li><b>You → Interviewer:</b> restate task, inputs, outputs, scale, edge cases.
    Restating the problem in your own words catches a misunderstanding in thirty seconds rather than twenty minutes, and it is the cheapest possible insurance.
    Asking for scale up front is not pedantry: it determines whether the solution holds data in memory or streams it, and that decision is hard to reverse later.
    Naming the edge cases you intend to handle sets the contract for what "done" means.</li>
  <li><b>Interviewer → You:</b> clarifications (response).
    The answers are constraints, so write them down in a markdown cell — it makes assumptions visible and gives you something to check against at the end.
    Anything left ambiguous should be stated as an explicit assumption rather than silently chosen.</li>
  <li><b>You → Notebook:</b> skeleton cells with function signatures + TODOs.
    Laying out the decomposition before writing any body is the single strongest signal of seniority in this exercise — it shows the shape of the solution immediately.
    It also lets the interviewer redirect you before you have invested in the wrong structure.
    Typed signatures and one‑line docstrings here cost seconds and make everything afterwards read as deliberate rather than improvised.</li>
  <li><b>You → Notebook:</b> happy-path core function.
    Solve the central case first and get something running end to end; a working simple version beats a half‑finished sophisticated one every time.
    Keep logic in functions with explicit parameters rather than reaching for globals — notebook globals are the main source of code that works only by accident.</li>
  <li><b>You → Notebook:</b> 2–3 asserts, run.
    Tests come early, not at the end, because they are what let you refactor confidently for the rest of the session.
    Plain asserts are enough in a notebook; the point is demonstrable correctness, not a framework.</li>
  <li><b>You → Notebook:</b> edge cases: empty, malformed, duplicates, huge.
    These four cover most of what interviewers actually probe, and handling them explicitly is usually where the difference between candidates shows.
    Each should have a stated behaviour — skip and count, raise with a clear message, or deduplicate by a named rule — rather than whatever the code happens to do.
    Silently producing a wrong answer for malformed input is worse than crashing, and saying that out loud is worth points on its own.</li>
  <li><b>You → Notebook:</b> I/O wrapper + main; restart &amp; run all.
    Separating pure logic from I/O makes the core testable without files and swappable when the input format changes.
    Restart‑and‑run‑all is non‑negotiable: it is the only proof that the notebook works for anyone other than you, in the state you are leaving it.</li>
  <li><b>You → Interviewer:</b> walk through: complexity, limits, prod changes.
    Say the complexity in time and memory, name the input size at which the approach breaks, and name what you would change outside a notebook.
    Volunteering the limitations is far stronger than having them extracted — it shows you know where the edges are rather than hoping nobody looks.</li>
  <li><b>Interviewer → You:</b> follow-ups: scale ×100? new field? (response).
    Both questions are really one question: is the structure you chose extensible, or did it only fit the example?
    The answer should be a specific change — swap the loader for a streaming one, add a field to one dataclass — not a rewrite.</li>
  <li><b>You → Notebook:</b> small change shows the structure holds.
    Actually making the change, in a minute, demonstrates the decomposition rather than asserting it.
    This is the payoff for the skeleton you wrote in step three, and it is why that step is worth the time it costs.
    Finish by re‑running the tests, so the change is shown to be correct and not merely typed.</li>
</ol>

## Deep dives {#colab-python-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/colab-python/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
<div><h4>Structure</h4><ul><li>Separate pure logic from I/O; test the pure part with in‑memory data.</li><li>Small functions with one job; names that say what, docstrings that say why or the invariant.</li><li>Types on public functions; dataclasses for records instead of dict soup.</li><li>Constants and config at the top; no magic numbers in the middle of loops.</li></ul></div>
<div><h4>Correctness and tests</h4><ul><li>Write the first test before the second feature; asserts in a cell count.</li><li>Edge cases named aloud: empty input, one element, duplicates, malformed rows, unicode, huge values, ties in top‑k.</li><li>Deterministic: fixed seeds, sorted outputs where order matters.</li><li>Errors: validate at the edge, fail loudly with context, log skipped records with counts.</li></ul></div>
<div><h4>Performance and maintainability</h4><ul><li>State complexity; use generators/streaming for large files; pandas/numpy for columnar work with a note on memory.</li><li>Avoid notebook global state; functions take parameters; restart‑and‑run‑all is the acceptance test.</li><li>Say what you'd do for production: package, CLI/argparse, pytest, type checking, CI, observability.</li><li>Leave a final cell with assumptions, limits, and next steps.</li></ul></div></div>


## Trade-offs {#colab-python-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Order of work</td><td>Skeleton and signatures before any implementation</td><td>A few minutes before anything runs</td><td>Diving straight into code feels faster and makes the structure impossible to change once you are invested in it</td></tr>
  <tr><td>Tests</td><td>A few asserts, written early</td><td>Time that could have gone into features</td><td>Testing at the end means refactoring without a safety net for the whole session, which is when mistakes happen</td></tr>
  <tr><td>Data handling</td><td>Stream when large, load when small — after asking</td><td>Streaming code is slightly more complex</td><td>Loading everything is simpler and correct at small scale; the point is to have asked rather than to have assumed</td></tr>
  <tr><td>State</td><td>Functions with explicit parameters, no cell globals</td><td>Slightly more typing than using a variable from above</td><td>Never rely on cell order — a function that works only because an earlier cell ran is a bug that survives until someone else opens the notebook</td></tr>
  <tr><td>Error handling</td><td>Skip malformed rows and report the count</td><td>The run does not stop at the first bad record</td><td>Raising immediately is right when any bad record invalidates the result; silent skipping is never right</td></tr>
  <tr><td>Optimisation</td><td>Correct first, profile, then optimise</td><td>The obvious fast version is not written first</td><td>Optimise up front only when the complexity class is clearly wrong — an O(n²) loop on a large input does not need a profiler</td></tr>
  <tr><td>Types and docstrings</td><td>Where they add meaning</td><td>A little time, and some visual noise</td><td>Skipping them entirely is faster and makes the code read as a draft rather than as something someone else could maintain</td></tr>
</tbody></table>

## Safety-first design {#colab-python-safety}

<div class="cards">
  <div><h4>Notebooks lie about what works</h4><ul>
    <li><b>Restart and run all before saying done.</b> Output in a cell proves only that it worked once, in an order you may not be able to reproduce.</li>
    <li><b>No hidden state.</b> Logic lives in functions with explicit parameters; a function depending on a global set three cells up is a bug waiting to be discovered by someone else.</li>
    <li><b>Deterministic by default.</b> Seed randomness, do not depend on set ordering, and pin anything platform‑dependent, so the interviewer's re‑run matches yours.</li>
    <li><b>One entry point.</b> A clear <code>main</code> makes it obvious how the thing is meant to be run, rather than requiring a tour of the notebook.</li></ul></div>
  <div><h4>Never produce a confident wrong answer</h4><ul>
    <li><b>Validate at the boundary.</b> Check structure and types once, on input, rather than defending against bad data in every function downstream.</li>
    <li><b>Count what you skip.</b> Dropping malformed records is fine; dropping them silently turns a data problem into a wrong number nobody questions.</li>
    <li><b>Fail with a useful message.</b> "Missing column 'user_id' in row 402" is actionable; a <code>KeyError</code> from deep inside a helper is not.</li>
    <li><b>State the complexity and the limit.</b> Knowing where the approach breaks is part of the answer, and volunteering it is stronger than being asked.</li></ul></div>
  <div><h4>Leave it usable by someone else</h4><ul>
    <li><b>Small functions, honest names.</b> The person reading this next has none of your context, and the notebook is the only explanation they get.</li>
    <li><b>Separate logic from I/O.</b> Pure functions are testable without files and survive a change of input format.</li>
    <li><b>Do not dump data into outputs.</b> Notebook output is saved and shared; print shapes and samples, not the whole dataset, especially if it looks like real user data.</li>
    <li><b>Say what production would change.</b> Packaging, logging, configuration, error handling and CI — naming them shows you know a notebook is not the destination.</li></ul></div>
</div>

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
