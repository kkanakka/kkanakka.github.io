# AI System Design — drop folder

Put an `.html` file in this folder, push, and it becomes a page in the
**AI System Design** section of the site. The deploy workflow runs
`node scripts/convert.js --ai-only`, which converts each file to markdown
under `docs/ai-system-design/` and rebuilds the section overview.

```bash
cp ai-system-design/_template.html ai-system-design/llm-serving.html
# write it, then:
git add ai-system-design/llm-serving.html
git commit -m "Add LLM serving guide"
git push
```

## Metadata the converter reads

| Tag | Required | Purpose |
|---|---|---|
| `<title>` | yes | Page and sidebar title. A ` — Kiran's Tech Hub` suffix is stripped. |
| `<meta name="description">` | no | Page description and search snippet. |
| `<meta name="order">` | no | Sort position in the sidebar, lower first. Default: alphabetical. |
| `<meta name="card-title">` | no | Overrides `<title>` for the sidebar label. |

Files beginning with `_` are ignored — use that prefix for drafts and
templates.

## Writing markdown instead

You do not have to use HTML. Anything you add directly to
`docs/ai-system-design/` as a `.md` file shows up in the sidebar with no
conversion step at all — that is the native Docusaurus path and the better
option for new writing:

```markdown
---
title: "RAG Pipeline Design"
sidebar_position: 5
---

Your content here.
```

This drop folder exists for HTML you already have, and for diagram-heavy
pages you would rather hand-build.

## Running the conversion locally

```bash
npm run ai      # refresh just this section
npm start       # preview the site
```
