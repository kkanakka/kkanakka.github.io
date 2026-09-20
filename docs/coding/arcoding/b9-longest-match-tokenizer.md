---
title: "B9 · Longest-match tokenizer"
slug: /coding/arcoding/b9-longest-match-tokenizer
sidebar_position: 16
sidebar_label: "B9 · Longest-match tokenizer"
description: "B9 · Longest-match tokenizer"
---

<div class="arcoding">

## B9 · Longest-match tokenizer

<p class="covers">Covers: Implement a Longest-Match Tokenizer (both listed versions). Maximally on-theme for an LLM company.</p>
<div class="adm info"><div class="adm-title">ℹ️ Problem</div>
<p>Given a case-sensitive vocabulary <code>token_text → id</code>, tokenize input greedily: at each position take the <em>longest</em> vocab match. Characters matching nothing become unknown tokens — per character, or coalesced into runs (level boundary). Emit <code>(token_id, exact_consumed_text)</code>.</p></div>
<h4>Version 1 — direct (correct first)</h4>

```
def tokenize(text, vocab, *, unk_id=-1, coalesce_unknown=True):
    max_len = max(map(len, vocab), default=0)
    out, unk_run = [], []
    i = 0

    def flush_unknown():
        if unk_run:
            out.append((unk_id, "".join(unk_run)))
            unk_run.clear()

    while i < len(text):
        for length in range(min(max_len, len(text) - i), 0, -1):
            piece = text[i:i + length]
            if piece in vocab:                    # longest match wins
                flush_unknown()
                out.append((vocab[piece], piece))
                i += length
                break
        else:                                     # for/else: nothing matched
            if coalesce_unknown:
                unk_run.append(text[i])
            else:
                out.append((unk_id, text[i]))
            i += 1
    flush_unknown()
    return out
```

<h4>Version 2 — trie (the optimization they'll ask for)</h4>
<p>The direct version does O(max_len) slices per position — fine until the vocab has one very long token. A trie walks characters once per position and remembers the <em>last</em> accepting depth:</p>

```
class TrieTokenizer:
    def __init__(self, vocab):
        self.root = {}
        for tok, tid in vocab.items():
            node = self.root
            for ch in tok:
                node = node.setdefault(ch, {})
            node["$"] = tid                       # terminal marker

    def tokenize(self, text, *, unk_id=-1, coalesce_unknown=True):
        out, unk_run, i, n = [], [], 0, len(text)

        def flush():
            if unk_run:
                out.append((unk_id, "".join(unk_run)))
                unk_run.clear()

        while i < n:
            node, j = self.root, i
            best_end, best_id = -1, None
            while j < n and text[j] in node:      # walk as far as possible...
                node = node[text[j]]
                j += 1
                if "$" in node:                   # ...remembering last accept
                    best_end, best_id = j, node["$"]
            if best_end > i:
                flush()
                out.append((best_id, text[i:best_end]))
                i = best_end
            else:
                if coalesce_unknown:
                    unk_run.append(text[i])
                else:
                    out.append((unk_id, text[i]))
                i += 1
        flush()
        return out
```

<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>The remember-last-accept detail:</strong> the trie walk may pass <em>through</em> shorter tokens (vocab <code>{"in", "inte", "internal"}</code>, text <code>"inter"</code> → must emit <code>inte</code>, not fail at the dead end after <code>inter</code>). This is the actual test in the hard version.</li>
<li><strong>Greedy ≠ optimal:</strong> vocab <code>{"ab", "bc", "a"}</code>, text <code>"abc"</code> → greedy gives <code>ab</code> + unknown <code>c</code>; <code>a</code>+<code>bc</code> covers everything. State that the spec mandates greedy, and that minimal-token or maximal-coverage segmentation would be DP over positions — knowing where greedy breaks is the differentiator.</li>
<li><strong>Round-trip invariant:</strong> concatenating consumed texts must equal the input exactly — offer it as your property test.</li>
<li><strong>Bridge to BPE:</strong> real LLM tokenizers (BPE) merge by learned rank, not longest-match — one sentence contrasting them shows domain awareness.</li>
</ul></div>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> naive version O(n &times; L<sub>max</sub>) worst case (n positions, up to L<sub>max</sub> slice probes each, plus O(L) hashing per slice); trie version walks each starting position once down a shared path — worst case still O(n &times; L<sub>max</sub>) on adversarial input, but typical cost is O(n + matched characters), with no slice allocations and no repeated hashing. <strong>Space:</strong> trie O(total vocab characters).</p><p><strong>How efficient is it?</strong> For the greedy-longest-match spec, the trie is the practical optimum. The theory footnote worth one sentence: Aho–Corasick gives O(n) matching over <em>all</em> patterns simultaneously via failure links, but changes the matching discipline — overkill here, and knowing why it doesn’t apply cleanly to longest-match greedy is the senior answer.</p></div>

</div>
