#!/usr/bin/env python3
"""Regenerate the AI System Design index from the files in ai-system-design/.

Drop a .html file into ai-system-design/ and run this (or let the GitHub
Action run it). It reads each file's metadata and rewrites the generated
blocks in ai-index.html and index.html.

Per-file metadata, all optional except <title>:

    <title>LLM Serving Architecture</title>
    <meta name="card-title"   content="LLM Serving Architecture">
    <meta name="description"  content="KV cache, batching, tensor parallelism">
    <meta name="tags"         content="vLLM, KV Cache, Batching">
    <meta name="accent"       content="#6940a5">
    <meta name="order"        content="10">

Ordering: by `order` (ascending) when present, then by title.
"""

import html
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTENT_DIR = ROOT / "ai-system-design"
AI_INDEX = ROOT / "ai-index.html"
SITE_INDEX = ROOT / "index.html"

DEFAULT_ACCENT = "#6940a5"
ACCENT_CYCLE = [
    "#6940a5", "#2383e2", "#0f7b0f", "#d9730d",
    "#cf222e", "#0969da", "#d33a8c", "#00695c",
]


def meta(source, name):
    """Value of <meta name="..." content="...">, order-insensitive."""
    for pattern in (
        rf'<meta\s+name=["\']{name}["\']\s+content=["\'](.*?)["\']',
        rf'<meta\s+content=["\'](.*?)["\']\s+name=["\']{name}["\']',
    ):
        m = re.search(pattern, source, re.I | re.S)
        if m:
            return html.unescape(m.group(1).strip())
    return ""


def strip_suffix(title):
    """'Foo — Kiran's Tech Hub' -> 'Foo'."""
    for sep in (" — ", " – ", " | ", " - "):
        if sep in title:
            head = title.split(sep)[0].strip()
            if head:
                return head
    return title.strip()


def collect():
    if not CONTENT_DIR.is_dir():
        return []
    pages = []
    for path in sorted(CONTENT_DIR.glob("*.html")):
        # index.html and _underscore-prefixed files (templates, drafts) are not entries
        if path.name == "index.html" or path.name.startswith(("_", ".")):
            continue
        source = path.read_text(encoding="utf-8", errors="replace")

        m = re.search(r"<title[^>]*>(.*?)</title>", source, re.I | re.S)
        raw_title = html.unescape(m.group(1).strip()) if m else ""
        title = meta(source, "card-title") or strip_suffix(raw_title) \
            or path.stem.replace("-", " ").replace("_", " ").title()

        order_raw = meta(source, "order")
        try:
            order = int(order_raw)
        except ValueError:
            order = 10_000

        pages.append({
            "href": f"{CONTENT_DIR.name}/{path.name}",
            "title": title,
            "description": meta(source, "description"),
            "tags": [t.strip() for t in meta(source, "tags").split(",") if t.strip()],
            "accent": meta(source, "accent"),
            "order": order,
        })

    pages.sort(key=lambda p: (p["order"], p["title"].lower()))
    for i, page in enumerate(pages):
        if not page["accent"]:
            page["accent"] = ACCENT_CYCLE[i % len(ACCENT_CYCLE)]
    return pages


def render_entries(pages):
    if not pages:
        return (
            '      <p class="empty">No guides yet. Drop an <code>.html</code> file into '
            '<code>ai-system-design/</code>, push, and it appears here automatically.</p>'
        )
    out = []
    for page in pages:
        e = html.escape
        out.append(f'      <a href="{e(page["href"])}" class="entry" '
                   f'style="--entry-accent: {e(page["accent"])};">')
        out.append(f'        <h2>{e(page["title"])}</h2>')
        if page["description"]:
            out.append(f'        <p>{e(page["description"])}</p>')
        if page["tags"]:
            out.append('        <div class="tag-row">')
            for tag in page["tags"]:
                out.append(f'          <span class="tag">{e(tag)}</span>')
            out.append('        </div>')
        out.append('        <div class="cta">Read the guide &rarr;</div>')
        out.append('      </a>')
    return "\n".join(out)


def replace_block(text, marker, replacement, where):
    start = f"<!-- {marker}:START -->"
    end = f"<!-- {marker}:END -->"
    pattern = re.compile(
        re.escape(start) + r".*?" + re.escape(end), re.S
    )
    if not pattern.search(text):
        sys.exit(f"error: markers {start} / {end} not found in {where}")
    return pattern.sub(f"{start}\n{replacement}\n      {end}", text, count=1)


def write_if_changed(path, new_text):
    old = path.read_text(encoding="utf-8") if path.exists() else None
    if old == new_text:
        print(f"  unchanged  {path.relative_to(ROOT)}")
        return False
    path.write_text(new_text, encoding="utf-8")
    print(f"  updated    {path.relative_to(ROOT)}")
    return True


def main():
    pages = collect()
    count = len(pages)
    print(f"found {count} guide(s) in {CONTENT_DIR.name}/")
    for page in pages:
        print(f"  - {page['title']}  ({page['href']})")

    changed = False

    text = AI_INDEX.read_text(encoding="utf-8")
    text = replace_block(text, "AI-ENTRIES", render_entries(pages), AI_INDEX.name)
    noun = "guide" if count == 1 else "guides"
    text = replace_block(
        text, "AI-COUNT", f"      {count} {noun}", AI_INDEX.name
    )
    changed |= write_if_changed(AI_INDEX, text)

    text = SITE_INDEX.read_text(encoding="utf-8")
    text = replace_block(
        text, "AI-CARD-COUNT",
        f"      {count} {noun} on building AI systems", SITE_INDEX.name
    )
    changed |= write_if_changed(SITE_INDEX, text)

    print("done." if changed else "done — nothing to update.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
