# AI System Design

Drop an `.html` file in this folder, push, and it appears on
<https://kkanakka.github.io/ai-index.html> and in the **AI System Design**
card on the homepage. No manual index editing.

## Adding a guide

```bash
cp ai-system-design/_template.html ai-system-design/llm-serving.html
# edit the <title> and <meta> tags, write the content
git add ai-system-design/llm-serving.html
git commit -m "Add LLM serving architecture guide"
git push
```

The `Build AI System Design index` GitHub Action regenerates the index and
commits the result. The live site updates a minute or so later.

## How a file becomes a card

The builder reads these from each file's `<head>`:

| Tag | Required | Purpose |
|---|---|---|
| `<title>` | yes | Card heading. A ` — Kiran's Tech Hub` suffix is stripped. |
| `<meta name="description">` | no | One-line summary under the heading. |
| `<meta name="tags">` | no | Comma-separated pills. |
| `<meta name="order">` | no | Sort position, lower first. Default: alphabetical. |
| `<meta name="card-title">` | no | Overrides `<title>` for the card only. |
| `<meta name="accent">` | no | Hex accent colour. Default: auto-assigned from a palette. |

Files beginning with `_` (like `_template.html`) are ignored — use that for
drafts and templates.

## Running it locally

```bash
python3 scripts/build_ai_index.py
```

Stdlib only, no dependencies. Safe to run repeatedly; it rewrites only the
blocks between the `<!-- AI-ENTRIES:START -->` / `<!-- AI-COUNT:START -->`
markers and leaves everything else alone.
