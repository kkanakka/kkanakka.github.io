---
title: "B7 · File deduplication at scale"
slug: /coding/arcoding/b7-file-deduplication-at-scale
sidebar_position: 14
sidebar_label: "B7 · File deduplication at scale"
description: "B7 · File deduplication at scale"
---

<div class="arcoding">

## B7 · File deduplication at scale

<p class="covers">Covers 9 variants: Find Duplicate Files · Detect duplicate files efficiently/by content · Group Duplicate Files by Content · file dedup at scale ×3 · Find and remove duplicates · dedup across nested directories · duplicate files + image ops (Part A). Also the toy-input variant (directory description strings) and the design variant (chunking strategy).</p>
<h4>The expected answer: a three-stage funnel</h4>
<p>Never hash everything. Each stage is strictly cheaper than the next and eliminates most candidates: <strong>size</strong> (free, from metadata) → <strong>head hash</strong> (first 4 KB) → <strong>full streaming hash</strong>. State the cost model: total ≈ one <code>stat</code> per file + 4 KB per size-collided file + full read only for genuine near-duplicates.</p>

```python
import hashlib
import os
from collections import defaultdict


def digest(path, limit=None, chunk=1 << 20, algo="sha256"):
    """Streaming hash — constant memory regardless of file size."""
    h = hashlib.new(algo)
    remaining = limit
    with open(path, "rb") as f:
        while remaining is None or remaining > 0:
            take = chunk if remaining is None else min(chunk, remaining)
            block = f.read(take)
            if not block:
                break
            h.update(block)
            if remaining is not None:
                remaining -= len(block)
    return h.hexdigest()


def identical(p1, p2, chunk=1 << 20):
    """Optional stage 4: byte compare for certainty (or for the paranoid
    interviewer who asks about hash collisions)."""
    with open(p1, "rb") as f1, open(p2, "rb") as f2:
        while True:
            b1, b2 = f1.read(chunk), f2.read(chunk)
            if b1 != b2:
                return False
            if not b1:
                return True


def duplicate_groups(root, follow_symlinks=False):
    by_size = defaultdict(list)                       # stage 1: size
    for dirpath, dirnames, filenames in os.walk(root,
                                                followlinks=follow_symlinks):
        for name in filenames:
            p = os.path.join(dirpath, name)
            try:
                st = os.stat(p, follow_symlinks=follow_symlinks)
            except OSError:
                continue                              # vanished / no permission
            if st.st_size > 0:                        # policy: skip empty files
                by_size[st.st_size].append(p)

    groups = []
    for size, paths in by_size.items():
        if len(paths) < 2:
            continue
        by_head = defaultdict(list)                   # stage 2: first 4 KB
        for p in paths:
            try:
                by_head[digest(p, limit=4096)].append(p)
            except OSError:
                continue
        for cands in by_head.values():
            if len(cands) < 2:
                continue
            by_full = defaultdict(list)               # stage 3: full hash
            for p in cands:
                try:
                    by_full[digest(p)].append(p)
                except OSError:
                    continue
            groups.extend(g for g in by_full.values() if len(g) > 1)
    return groups
```

<h4>The toy-input variant (parse directory-description strings)</h4>

```python
def duplicates_from_records(records):
    """records like: 'root/a 1.txt(abc) 2.txt(def)' — group by content."""
    by_content = defaultdict(list)
    for rec in records:
        parts = rec.split()
        root = parts[0]
        for entry in parts[1:]:
            name, content = entry.split("(", 1)
            by_content[content.rstrip(")")].append(f"{root}/{name}")
    return [g for g in by_content.values() if len(g) > 1]
```

<h4>The design variant — chunking for a dedup <em>storage</em> system</h4>
<p>Different question: dedup at the block level across versions of files. Fixed-size chunking breaks on insertion (every later block shifts → all hashes change); <strong>content-defined chunking</strong> (a rolling hash like Rabin fingerprints declares a chunk boundary whenever <code>hash &amp; mask == 0</code>, giving ~power-of-two average chunk sizes) realigns after edits so only touched chunks re-store. Choose SHA-256 for chunk identity, mention the collision probability is ≪ hardware error rates, and index chunks in a content-addressed store.</p>
<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>Streaming discipline:</strong> "never load whole files" is in the problem text — a <code>f.read()</code> without a chunk size fails a 100 GB test file.</li>
<li><strong>Filesystem edge cases:</strong> permission errors and files vanishing mid-walk (catch <code>OSError</code>, keep going); symlink loops (don't follow by default); hard links (same inode = same file, not a duplicate — check <code>st_ino</code>/<code>st_dev</code> if asked); empty files (policy call, state it).</li>
<li><strong>Removal variant:</strong> which copy survives? Deterministic rule (shortest path / oldest mtime), and replace deleted copies with hard links if the FS supports it — offering the hard-link trick is a standout moment.</li>
<li><strong>Parallelizing:</strong> hashing is I/O-bound on spinning disks (thread pool fine) but CPU-visible on NVMe (process pool per stage-3 group). Knowing that the bottleneck depends on the medium is the senior answer.</li>
</ul></div>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> O(files) stats + one 4 KB read per size-collided file + full streaming read only for head-hash-collided candidates. Total I/O ≈ bytes of true near-duplicates — for typical trees a tiny fraction of total bytes. <strong>Space:</strong> O(files) for the grouping maps; O(1) per hash thanks to chunked reading.</p><p><strong>How efficient is it?</strong> Near-optimal: genuine duplicates must be fully read (or byte-compared) to be confirmed, and the funnel ensures almost nothing else is read at all — unique-size files cost one <code>stat</code>. The naive hash-everything approach reads 100% of bytes; the funnel typically reads a few percent. That ratio is the answer to "why the three stages."</p></div>

</div>
