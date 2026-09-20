#!/usr/bin/env python3
"""
Generate the "What it looks like in memory" diagrams for the ARCODING pages.

These are deliberately plain: black-and-white, padded boxes that show the
actual stored values, with a short "what we're doing" caption underneath.
Hand-drawn SVG (not Mermaid) because Mermaid cannot lay out clean memory
cells / arrays / grids.

Source of truth for static/diagrams/arcoding-state/<id>.svg
Run:  python3 scripts/gen_state_diagrams.py
"""
import html
import pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "static/diagrams/arcoding-state"

# ---- palette (grayscale only) -------------------------------------------
INK  = "#1a1f24"     # boxes, primary text
MUTE = "#5b6570"     # secondary labels
DIM  = "#98a0aa"     # de-emphasised (expired / dropped) cells
BG   = "#ffffff"
SANS = "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

# ---- geometry -----------------------------------------------------------
PAD        = 26
TITLE_SZ   = 17
CAPS_SZ    = 11
HEAD_SZ    = 14
CELL_SZ    = 13.5
SUB_SZ     = 12
NOTE_SZ    = 13.5
LINEH      = 19          # line height inside a cell
CPADX      = 14
CPADY      = 10
GAP        = 14          # gap between cells in a row
NOTE_LH    = 21


def _w(s, size, mono=False, bold=False):
    if mono:
        per = size * 0.605
    else:
        per = size * (0.545 if bold else 0.522)
    return len(s) * per


def esc(s):
    return html.escape(str(s), quote=True)


class Canvas:
    def __init__(self):
        self.parts = []
        self.maxx = 0

    def rect(self, x, y, w, h, strong=False, dim=False):
        sw = 2.4 if strong else 1.4
        stroke = DIM if dim else INK
        dash = ' stroke-dasharray="5 4"' if dim else ""
        self.parts.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" '
            f'rx="7" fill="{BG}" stroke="{stroke}" stroke-width="{sw}"{dash}/>')
        self.maxx = max(self.maxx, x + w)

    def text(self, x, y, s, size, *, mono=False, bold=False, color=INK,
             anchor="start", spacing=None, italic=False):
        fam = MONO if mono else SANS
        extra = f' letter-spacing="{spacing}"' if spacing else ""
        it = ' font-style="italic"' if italic else ""
        wt = ' font-weight="600"' if bold else ""
        self.parts.append(
            f'<text x="{x:.1f}" y="{y:.1f}" font-family="{fam}" '
            f'font-size="{size}" fill="{color}" text-anchor="{anchor}"{wt}{it}'
            f'{extra}>{esc(s)}</text>')
        w = _w(s, size, mono, bold)
        if anchor == "start":
            self.maxx = max(self.maxx, x + w)
        elif anchor == "middle":
            self.maxx = max(self.maxx, x + w / 2)

    def line(self, x1, y1, x2, y2, color=INK, w=1.4):
        self.parts.append(
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{color}" stroke-width="{w}"/>')

    def svg(self, w, h):
        body = "\n".join(self.parts)
        return (f'<svg xmlns="http://www.w3.org/2000/svg" '
                f'viewBox="0 0 {w:.0f} {h:.0f}" font-family="{SANS}">\n'
                f'<rect x="0" y="0" width="{w:.0f}" height="{h:.0f}" fill="{BG}"/>\n'
                f'{body}\n</svg>\n')


def cell_dims(cell):
    lines = cell["lines"]
    w = max(_w(l, CELL_SZ, mono=True) for l in lines) + 2 * CPADX
    h = len(lines) * LINEH + 2 * CPADY
    return w, h


def draw_row(c, panel, x0, y):
    cells = panel["cells"]
    chain = panel.get("chain", False)
    has_sub = any(cell.get("sub") for cell in cells)
    cw = max(cell_dims(cell)[0] for cell in cells)
    ch = max(cell_dims(cell)[1] for cell in cells)
    arrow = 26 if chain else GAP
    x = x0
    for i, cell in enumerate(cells):
        if i:
            if chain:
                c.text(x + (arrow - GAP) / 2 + GAP / 2 - 4, y + ch / 2 + 5, "→",
                       16, color=MUTE, anchor="middle")
            x += (arrow if chain else GAP)
        c.rect(x, y, cw, ch, strong=cell.get("strong"), dim=cell.get("dim"))
        col = DIM if cell.get("dim") else INK
        n = len(cell["lines"])
        ty = y + ch / 2 - (n - 1) * LINEH / 2 + CELL_SZ * 0.35
        for j, l in enumerate(cell["lines"]):
            c.text(x + cw / 2, ty + j * LINEH, l, CELL_SZ, mono=True,
                   color=col, anchor="middle")
        if cell.get("sub"):
            c.text(x + cw / 2, y + ch + SUB_SZ + 6, cell["sub"], SUB_SZ,
                   color=MUTE, anchor="middle")
        x += cw
    bottom = y + ch + (SUB_SZ + 8 if has_sub else 0)
    return bottom


def draw_grid(c, panel, x0, y):
    g = panel["grid"]
    strong = set(tuple(t) for t in panel.get("strong", []))
    cw = max(max(_w(str(v), CELL_SZ, mono=True) for row in g for v in row) + 2 * CPADX, 42)
    ch = LINEH + 2 * CPADY
    for r, row in enumerate(g):
        for col, v in enumerate(row):
            x = x0 + col * (cw + 8)
            yy = y + r * (ch + 8)
            c.rect(x, yy, cw, ch, strong=(r, col) in strong)
            c.text(x + cw / 2, yy + ch / 2 + CELL_SZ * 0.35, str(v), CELL_SZ,
                   mono=True, anchor="middle")
    return y + len(g) * (ch + 8) - 8


def draw_text(c, panel, x0, y, usable):
    lines = panel["lines"]
    lh = LINEH + 1
    boxw = min(max(_w(l, CELL_SZ, mono=True) for l in lines) + 2 * CPADX + 4, usable)
    boxh = len(lines) * lh + 2 * CPADY
    c.rect(x0, y, boxw, boxh)
    for i, l in enumerate(lines):
        c.text(x0 + CPADX, y + CPADY + LINEH * 0.75 + i * lh, l, CELL_SZ,
               mono=True, color=INK, anchor="start")
    return y + boxh


def wrap(s, size, maxw):
    out, cur = [], ""
    for word in s.split(" "):
        t = (cur + " " + word).strip()
        if _w(t, size) <= maxw or not cur:
            cur = t
        else:
            out.append(cur)
            cur = word
    if cur:
        out.append(cur)
    return out


def render(spec):
    # first pass computes the natural content width
    probe = Canvas()
    x0 = PAD
    y = PAD
    usable = 640
    _layout(probe, spec, x0, y, usable, measure=True)
    usable = max(min(probe.maxx - PAD, 900), 560)
    # real pass
    c = Canvas()
    endy = _layout(c, spec, x0, PAD, usable, measure=False)
    width = max(c.maxx + PAD, usable + 2 * PAD)
    return c.svg(width, endy + PAD)


def _layout(c, spec, x0, y, usable, measure):
    c.text(x0, y + TITLE_SZ, spec["title"], TITLE_SZ, bold=True)
    y += TITLE_SZ + 20

    c.text(x0, y, "WHAT WE STORE", CAPS_SZ, color=MUTE, spacing="1.2")
    y += 16

    for i, panel in enumerate(spec["panels"]):
        if i:
            y += 20
        var = panel.get("var", "")
        desc = panel.get("desc", "")
        if var or desc:
            hx = x0
            if var:
                c.text(hx, y + HEAD_SZ, var, HEAD_SZ, mono=True, bold=True)
                hx += _w(var, HEAD_SZ, mono=True, bold=True) + 8
            if desc:
                c.text(hx, y + HEAD_SZ, desc, HEAD_SZ - 0.5, color=MUTE)
            y += HEAD_SZ + 12
        t = panel.get("type", "row")
        if t == "grid":
            y = draw_grid(c, panel, x0, y)
        elif t == "text":
            y = draw_text(c, panel, x0, y, usable)
        else:
            y = draw_row(c, panel, x0, y)

    notes = spec.get("notes", [])
    if notes:
        y += 22
        c.line(x0, y, x0 + usable, y, color="#e2e6ea", w=1.2)
        y += 20
        c.text(x0, y, "WHAT WE'RE DOING", CAPS_SZ, color=MUTE, spacing="1.2")
        y += 20
        for note in notes:
            for ln in wrap(note, NOTE_SZ, usable):
                c.text(x0, y, ln, NOTE_SZ, color=INK)
                y += NOTE_LH
            y += 4
        y -= 4
    return y


# =========================================================================
#  SPECS  — values match each page's own "Run it" demo
# =========================================================================
def cell(*lines, sub=None, strong=False, dim=False):
    return {"lines": list(lines), "sub": sub, "strong": strong, "dim": dim}


SPECS = {

"b1": {
 "title": "B1 · the only state carried between samples",
 "panels": [
   {"var": "prev", "desc": "the stack from the last sample", "chain": True, "cells": [
       cell("main", sub="depth 0"), cell("load_config", sub="depth 1"),
       cell("parse", sub="depth 2")]},
   {"var": "next", "desc": "the new sample arrives at t = 5", "chain": True, "cells": [
       cell("main", sub="depth 0"), cell("render", sub="depth 1")]},
 ],
 "notes": [
   "Longest common prefix = 1, so depth 0 ('main') survives and everything below it changed.",
   "Emit, in this order:  (5, end, parse)  ·  (5, end, load_config)  ·  (5, start, render).",
 ]},

"b2": {
 "title": "B2 · the frame stack, just after load starts",
 "panels": [
   {"var": "stack", "desc": "each frame = [ name, entry, resume ]", "cells": [
       cell("main", "entry   0", "resume  2"),
       cell("load", "entry   2", "resume  2", strong=True)]},
   {"var": "excl", "desc": "exclusive time credited so far", "cells": [
       cell("main → 2")]},
 ],
 "notes": [
   "START paused main: it was credited 2 − 0 = 2, then load was pushed.",
   "At END load@5:  load += 6 − 2 = 4;  main resumes at 6 and later collects 7 − 6 = 1 → total 3.",
 ]},

"b3": {
 "title": "B3 · LRUCache(2) after put a, put b, get a, put c",
 "panels": [
   {"var": "map", "desc": "key → node (for O(1) find)", "cells": [
       cell("'a'"), cell("'c'")]},
   {"var": "list", "desc": "head = most recent, tail = least", "chain": True, "cells": [
       cell("head", sub="sentinel"), cell("'c'", "val 3", sub="newest"),
       cell("'a'", "val 1"), cell("tail", sub="sentinel")]},
 ],
 "notes": [
   "get a moved 'a' off the tail, so 'b' was the node sitting at tail.prev.",
   "put c then evicted that tail.prev → 'b' is gone.",
 ]},

"b4": {
 "title": "B4 · versions stored as parallel sorted lists",
 "panels": [
   {"var": "'user:1'", "desc": "three writes, timestamps ascending", "cells": [
       cell("t 10", "'alice'"), cell("t 20", "'alice2'"),
       cell("t 30", "TOMBSTONE", dim=True)]},
   {"var": "'user:2'", "desc": "one write, carrying a TTL", "cells": [
       cell("t 15", "'bob'", "expires 25")]},
 ],
 "notes": [
   "get('user:1', 24):  bisect_right(ts, 24) = 2 → vals[1] → 'alice2'.",
   "get('user:2', 25):  finds vals[0], but 25 ≥ expiry 25 → None.",
 ]},

"b5": {
 "title": "B5 · the bank's structures before the merge",
 "panels": [
   {"var": "bal", "desc": "current balances", "cells": [
       cell("acc1", "800"), cell("acc2", "700")]},
   {"var": "out", "desc": "outgoing totals (top_spenders)", "cells": [
       cell("acc1", "1200"), cell("acc2", "1000")]},
   {"var": "sched", "desc": "cashback min-heap (expiry, seq, acct, amt)", "cells": [
       cell("(86400011, 1,", " 'acc2', 20)")]},
   {"var": "hist['acc1']", "desc": "(time, balance) — balance_at bisects this", "chain": True, "cells": [
       cell("(1, 0)"), cell("(2, 2000)"), cell("(4, 800)")]},
 ],
 "notes": [
   "After merge: alias acc2 → acc1. The heap entry still says 'acc2'; _canon resolves it when it settles.",
 ]},

"b6": {
 "title": "B6 · crawl frontier, round by round",
 "panels": [
   {"var": "frontier", "desc": "the URLs to visit next", "chain": True, "cells": [
       cell("['/']", sub="round 0"), cell("['/a', '/b']", sub="round 1"),
       cell("['/c']", sub="round 2"), cell("[ ]", sub="round 3 → stop", strong=True)]},
   {"var": "seen", "desc": "final set", "cells": [
       cell("'/'"), cell("'/a'"), cell("'/b'"), cell("'/c'")]},
 ],
 "notes": [
   "'other.com/x' was never added — wrong host.",
   "'/c' was reached from both /a and /b, but only the first thread to take the lock added it.",
 ]},

"b7": {
 "title": "B7 · the three dicts the funnel builds",
 "panels": [
   {"var": "by_size", "desc": "stage 1 — just a stat call", "cells": [
       cell("1100", "a, b, c"), cell("17", "d", dim=True),
       cell("4099", "e, f")]},
   {"var": "by_head", "desc": "stage 2 — hash of first 4 KB", "cells": [
       cell("3f1a…", "a, b, c"), cell("9c22…", "e, f")]},
   {"var": "by_full", "desc": "stage 3 — full hash", "cells": [
       cell("68cd…", "a, b, c", strong=True), cell("a41e…", "e"),
       cell("77b0…", "f")]},
 ],
 "notes": [
   "d dropped out at stage 1 (alone at its size) and was never opened.",
   "e and f shared a size AND a first 4 KB — only the full hash separated them.",
   "Result, groups of 2+ only:  [ a.txt, b.txt, nested/c.txt ].",
 ]},

"b8": {
 "title": "B8 · the per-job map, and the shared-prefix trie",
 "panels": [
   {"var": "results", "desc": "None means success", "cells": [
       cell("img0", "None"), cell("img1", "None"), cell("img2", "None"),
       cell("corrupt", "ERROR", dim=True)]},
   {"var": "trie", "desc": "shared prefixes computed once", "type": "text", "lines": [
       "root",
       "├─ thumbnail          → thumb",
       "└─ grayscale",
       "     ├─ thumbnail     → gray_thumb",
       "     └─ blur          → gray_blur"]},
 ],
 "notes": [
   "One corrupt image is an entry in the map, not an exception that ends the batch.",
   "'grayscale' is computed once and reused by the two pipelines that start with it.",
 ]},

"b9": {
 "title": "B9 · tokens for 'tokenizer rize'",
 "panels": [
   {"var": "out", "desc": "(token id, matched text)", "chain": True, "cells": [
       cell("(1,", "'token')"), cell("(4,", "'ize')"), cell("(5,", "'r')"),
       cell("(-1,", "' ')", dim=True), cell("(5,", "'r')"), cell("(4,", "'ize')")]},
 ],
 "notes": [
   "'token' beat 'tok' — the longest match wins, so 'tok' never appears.",
   "The space matched nothing, so it became one (-1, ' ') unknown token, not one per character.",
 ]},

"b10": {
 "title": "B10 · MinStack after push 5, 3, 7, 3",
 "panels": [
   {"var": "_s", "desc": "each cell = (value, min at push time)", "cells": [
       cell("val  5", "min  5", sub="[0]"),
       cell("val  3", "min  3", sub="[1]"),
       cell("val  7", "min  3", sub="[2]"),
       cell("val  3", "min  3", sub="[3] top", strong=True)]},
 ],
 "notes": [
   "get_min reads the top cell's second field → 3.",
   "Pop 3 then 7: the top becomes [1], whose min is 3.  Pop again and [0] says 5 — the old minimum is back, for free.",
 ]},

"b11": {
 "title": "B11 · after seven updates (two were stale)",
 "panels": [
   {"var": "latest", "desc": "one record per node", "cells": [
       cell("n1", "(30, down)"), cell("n2", "(30, down)"),
       cell("n3", "(5, healthy)")]},
   {"var": "counts", "desc": "maintained on every write", "cells": [
       cell("down", "2"), cell("healthy", "1")]},
   {"var": "history['n1']", "desc": "kept sorted by insort", "chain": True, "cells": [
       cell("(10,", "healthy)"), cell("(20,", "degraded)"),
       cell("(30,", "down)"), cell("(30,", "healthy)", strong=True)]},
 ],
 "notes": [
   "Both ts=30 entries live in the history, so status_at(30) answers 'healthy' while latest says 'down'.",
   "The tie rule must be made to agree in both paths.",
 ]},

"b12": {
 "title": "B12 · grants held in a min-heap by expiry",
 "panels": [
   {"var": "_h", "desc": "(expiry, seq, [remaining])", "cells": [
       cell("(10, 1,", " [100])", sub="top — dies first", strong=True),
       cell("(20, 2,", " [50])")]},
   {"var": "_total", "desc": "kept alongside for O(1) balance()", "cells": [
       cell("150")]},
 ],
 "notes": [
   "spend(120) takes all 100 from the top and pops it, then 20 from the next → its cell becomes [30].",
   "The amount is mutated in place — no re-push, because only expiry takes part in the ordering.",
 ]},

"b13": {
 "title": "B13 · resolving '/data/current/model.bin'",
 "panels": [
   {"var": "link", "desc": "/data/current → '../releases/v7'", "type": "text", "lines": [
       "step 1   out [data, current]   pending [model.bin]      '/data/current' is a link",
       "step 2   out [data]            pending [model.bin, .., releases, v7]",
       "step 3   out [ ]               pending [releases, v7, model.bin]",
       "step 4   out [releases, v7, model.bin]   →  /releases/v7/model.bin"]},
 ],
 "notes": [
   "A relative target pops the link component, then pushes the target's parts (step 2).",
   "'..' applies to the resolved path, popping 'data' (step 3) — that is what makes it more than string simplification.",
 ]},

"b14": {
 "title": "B14 · output_tokens as six chunks stream in",
 "panels": [
   {"var": "totals['output_tokens']", "desc": "running value after each chunk", "chain": True, "cells": [
       cell("50", sub="ch 1"), cell("120", sub="ch 2"),
       cell("120", sub="ch 3", dim=True), cell("300", sub="ch 4"),
       cell("305", sub="final", strong=True)]},
 ],
 "notes": [
   "Chunk 3 arrived late carrying 90.  max() kept 120 — a plain assignment would have rolled it backwards.",
   "Final: input 1200, output 305, cache 8000  →  cost = Decimal('0.010575'), rounded once.",
 ]},

"b15": {
 "title": "B15 · a full queue with parked threads",
 "panels": [
   {"var": "q", "desc": "deque, never longer than cap = 2", "chain": True, "cells": [
       cell("item 4", sub="next out"), cell("item 5")]},
   {"var": "waiters", "desc": "both conditions share ONE lock", "cells": [
       cell("not_full", "1 producer parked", "(len == cap)", dim=True),
       cell("not_empty", "2 consumers parked", "(nothing to take)", dim=True)]},
 ],
 "notes": [
   "One lock means a notify can never slip past a thread that is between its check and its wait().",
   "close() wakes everyone: consumers drain what is left, then see QueueClosed.",
 ]},

"b16": {
 "title": "B16 · k = 2, four corners infected at round 0",
 "panels": [
   {"var": "times", "desc": "the infection round (the answer)", "type": "grid",
    "grid": [["0", "1", "0"], ["1", "2", "1"], ["0", "1", "0"]],
    "strong": [[1, 1]]},
   {"var": "infected_nbrs", "desc": "the tallies that got them there", "type": "grid",
    "grid": [["–", "2", "–"], ["2", "4", "2"], ["–", "2", "–"]]},
 ],
 "notes": [
   "The centre needed two rounds: at round 1 its tally was still 0 (no infected neighbour yet).",
   "The tally persists, so the edges falling at round 1 tip the centre over at round 2.",
 ]},

"s1": {
 "title": "S1 · the store at now = 109",
 "panels": [
   {"var": "_d", "desc": "value and ABSOLUTE expiry", "cells": [
       cell("session:a", "'alice', 110"), cell("session:b", "'bob', 150"),
       cell("session:c", "'carol', None")]},
   {"var": "_heap", "desc": "expiry-ordered index", "chain": True, "cells": [
       cell("(110,", " session:a)"), cell("(150,", " session:b)")]},
 ],
 "notes": [
   "backup(120) stores what is LEFT, not when it ends:  session:b → ('bob', 30).",
   "restore at now = 1000 re-anchors it → session:b now expires at 1030, not 150.",
 ]},

"s2": {
 "title": "S2 · the limiter's entire state",
 "panels": [
   {"var": "_state", "desc": "[ tokens, last_timestamp ] per key", "cells": [
       cell("'user:1'", "[ 0.0, 0.0 ]"), cell("'user:2'", "[ 2.0, 0.4 ]")]},
 ],
 "notes": [
   "Two numbers per key, nothing else — no history, which is why it scales to millions of keys.",
   "At t = 0.2, elapsed 0.2 × rate 5 = exactly 1 token refilled, so the next request passes. No timer ran.",
 ]},

"s3": {
 "title": "S3 · after 12 messages (id 4 raises, id 7 hangs)",
 "panels": [
   {"var": "stats", "desc": "counters", "cells": [
       cell("ok", "10"), cell("retried", "4"), cell("failed", "2"),
       cell("dead", "2")]},
   {"var": "dead_letter", "desc": "persisted, never dropped", "cells": [
       cell("[ 4, 7 ]", dim=True)]},
   {"var": "breaker", "desc": "stayed closed", "cells": [
       cell("failures 0", "opened_at None")]},
 ],
 "notes": [
   "retried is 4, not 2: each bad message burned two retries before its third attempt gave up.",
   "The six failures never landed consecutively, so the breaker never opened.",
 ]},

"s4": {
 "title": "S4 · counting example.com across five docs",
 "panels": [
   {"var": "matched", "desc": "host == domain, or ends with '.'+domain", "cells": [
       cell("docs.example.com"), cell("example.com"),
       cell("example.com", "(:8443)"), cell("api.example.com")]},
   {"var": "rejected", "desc": "the two traps this question tests", "cells": [
       cell("notexample.com", "no leading dot", dim=True),
       cell("example.com.evil.net", "domain is a PREFIX", dim=True)]},
 ],
 "notes": [
   "count_domain(docs, 'example.com') = 4.",
 ]},

"s5": {
 "title": "S5 · the two numbers that split the search",
 "panels": [
   {"var": "uniform shift", "desc": "everything moved together", "cells": [
       cell("mean 65.2"), cell("p50 65.2"), cell("p99 79.5"),
       cell("tail 1.2×")]},
   {"var": "2% stalling", "desc": "a minority is waiting", "cells": [
       cell("mean 58.2"), cell("p50 40.5"), cell("p99 939.9"),
       cell("tail 23.2×", strong=True)]},
   {"var": "ledger", "desc": "one request, once you instrument it", "cells": [
       cell("auth", "0.1s"), cell("db", "0.3s"),
       cell("unaccounted", "0.1s", strong=True), cell("total", "0.5s")]},
 ],
 "notes": [
   "Tail up with the mean flat = a subset stalling.  Everything up together = a uniform cost.",
   "'unaccounted' is time before any phase began — it is queue wait, and it is a finding, not noise.",
 ]},

}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for pid, spec in SPECS.items():
        (OUT / f"{pid}.svg").write_text(render(spec))
    print(f"wrote {len(SPECS)} diagrams to {OUT}")


if __name__ == "__main__":
    main()
