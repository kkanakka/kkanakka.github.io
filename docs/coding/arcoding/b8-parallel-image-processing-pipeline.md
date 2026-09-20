---
title: "B8 · Parallel image processing pipeline"
slug: /coding/arcoding/b8-parallel-image-processing-pipeline
sidebar_position: 15
sidebar_label: "B8 · Parallel image processing pipeline"
description: "B8 · Parallel image processing pipeline"
---

<div class="arcoding">

## B8 · Parallel image processing pipeline

<p class="covers">Covers 4 variants: Implement a Parallel Image Processor · Implement Parallel Image Processing · Batch Image Processor · Generate outputs for images and pipelines (the m×n matrix version).</p>

### The approach

<img src="/diagrams/arcoding/b8.svg" alt="Image paths are distributed to worker processes, each wrapping its whole open-process-save sequence in a try/except so a failure returns an error entry instead of killing the batch." class="doc-diagram doc-diagram-seq" />

<p>Image work is CPU-bound, so this is the one problem in the set that wants <strong>processes rather than threads</strong> — the GIL would serialise threads here. Each worker wraps its entire open → transform → save sequence in one try/except and returns <code>(path, error_or_None)</code>, so a single corrupt file produces an error entry rather than taking down the run. This is the boundary where a broad <code>except Exception</code> is the right call, and saying <em>why</em> is part of the answer.</p>

### What it looks like in memory

<p>What comes back from the batch in <em>Run it</em>, plus the trie built for the three named pipelines.</p>

<img src="/diagrams/arcoding-state/b8.svg" alt="The per-job results map with one error entry, and the pipeline trie sharing a common prefix." class="doc-diagram doc-diagram-seq" />

<p>With m images × n pipelines, pipelines often share prefixes (<code>[resize, gray, blur]</code> and <code>[resize, gray, sharpen]</code> share two ops). Build a trie of ops and DFS it per image, so each shared prefix is computed once:</p>

<p>Cost drops from Σ|pipeline| ops per image to |trie nodes| per image. Note the purity requirement out loud — this only works because each op returns a new image (hence <code>op_thumbnail</code> copying first); an in-place op would corrupt sibling branches.</p>

<p class="covers">The complete program — save it as <code>b8_image_pipeline.py</code> and run <code>python b8_image_pipeline.py</code>.</p>

```python
import os
from concurrent.futures import ProcessPoolExecutor, as_completed
from PIL import Image, ImageFilter


def op_grayscale(im): return im.convert("L")
def op_rotate90(im):  return im.rotate(-90, expand=True)
def op_blur(im):      return im.filter(ImageFilter.GaussianBlur(2))
def op_thumbnail(im):
    im = im.copy()
    im.thumbnail((128, 128))              # in-place; returns None — classic trap
    return im

OPS = {"grayscale": op_grayscale, "rotate90": op_rotate90,
       "blur": op_blur, "thumbnail": op_thumbnail}


def process_one(path, pipeline, out_dir):
    """Runs in a worker PROCESS. Returns (path, error_or_None):
    one corrupt image must produce an error entry, not kill the batch.

    Example:
        # runs in a worker process; a bad file becomes an entry, not a crash
        process_one('img0.png', ['grayscale', 'thumbnail'], out)  -> ('img0.png', None)
        process_one('corrupt.png', ['grayscale'], out)
          -> ('corrupt.png', 'UnidentifiedImageError: ...')
    """
    try:
        with Image.open(path) as im:
            im.load()                      # force decode inside the try
            for op in pipeline:
                im = OPS[op](im)
            base, _ = os.path.splitext(os.path.basename(path))
            out = os.path.join(out_dir, base + ".png")
            im.save(out)
            return path, None
    except Exception as e:                 # Pillow raises many types; catch wide,
        return path, f"{type(e).__name__}: {e}"   # report precisely


def run_batch(paths, pipeline, out_dir, workers=None):
    """Example.

    Example:
        # fans the jobs across processes, returns a per-job status map:
        run_batch(paths, ['grayscale', 'thumbnail'], out)
        {'img0.png': None, 'img1.png': None, 'corrupt.png': 'UnidentifiedImageError: ...'}
    """
    os.makedirs(out_dir, exist_ok=True)
    results = {}
    with ProcessPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(process_one, p, pipeline, out_dir): p
                   for p in paths}
        for fut in as_completed(futures):
            path, err = fut.result()
            results[path] = err
    return results                          # per-job status map

def build_pipeline_trie(pipelines):
    """pipelines: {name: [op, ...]} -> nested trie:
    node = {'children': {op: node}, 'outputs': [pipeline_names ending here]}

    Example:
        >>> build_pipeline_trie({'g': ['grayscale'], 'gt': ['grayscale', 'thumbnail']})
        {'children': {'grayscale': {'children': {'thumbnail': {'children': {}, 'outputs': ['gt']}}, 'outputs': ['g']}}, 'outputs': []}
    """
    root = {"children": {}, "outputs": []}
    for name, ops in pipelines.items():
        node = root
        for op in ops:
            node = node["children"].setdefault(
                op, {"children": {}, "outputs": []})
        node["outputs"].append(name)
    return root


def apply_trie(image_path, trie, out_dir):
    results = {}
    with Image.open(image_path) as im:
        im.load()
        base = os.path.splitext(os.path.basename(image_path))[0]

        def dfs(node, img):
            for name in node["outputs"]:
                img.save(os.path.join(out_dir, f"{base}__{name}.png"))
                results[name] = None
            for op, child in node["children"].items():
                dfs(child, OPS[op](img))   # ops are pure: img not mutated
        dfs(trie, im)
    return image_path, results


if __name__ == "__main__":
    import shutil, tempfile

    work = tempfile.mkdtemp()
    src, out = os.path.join(work, "in"), os.path.join(work, "out")
    os.makedirs(src)
    try:
        for i, colour in enumerate(("red", "green", "blue")):
            Image.new("RGB", (400, 300), colour).save(
                os.path.join(src, f"img{i}.png"))
        with open(os.path.join(src, "corrupt.png"), "wb") as f:
            f.write(b"not actually a PNG")          # must not kill the batch

        paths = sorted(os.path.join(src, n) for n in os.listdir(src))
        results = run_batch(paths, ["grayscale", "thumbnail"], out, workers=2)

        print("--- per-job status (None = success) ---")
        for p in sorted(results):
            print(f"  {os.path.basename(p):<13} {results[p]}")

        ok = [p for p, e in results.items() if e is None]
        print(f"\n{len(ok)}/{len(results)} succeeded; one bad file did not "
              f"abort the batch")
        print("outputs written:", sorted(os.listdir(out)))
        with Image.open(os.path.join(out, "img0.png")) as im:
            print("img0 after pipeline:", im.mode, im.size)   # 'L', <=128px

        print("\n--- trie: shared prefixes computed once ---")
        pipelines = {"thumb": ["thumbnail"],
                     "gray_thumb": ["grayscale", "thumbnail"],
                     "gray_blur": ["grayscale", "blur"]}
        trie = build_pipeline_trie(pipelines)
        print("grayscale is a shared prefix of 2 pipelines:",
              sorted(trie["children"]["grayscale"]["children"]))

        _, res = apply_trie(os.path.join(src, "img0.png"), trie, out)
        print("variants produced:", sorted(res))
    finally:
        shutil.rmtree(work)
```

<p><strong>Output</strong></p>

```text
--- per-job status (None = success) ---
  corrupt.png   UnidentifiedImageError: cannot identify image file '/tmp/batch/in/corrupt.png'
  img0.png      None
  img1.png      None
  img2.png      None

3/4 succeeded; one bad file did not abort the batch
outputs written: ['img0.png', 'img1.png', 'img2.png']
img0 after pipeline: L (128, 96)

--- trie: shared prefixes computed once ---
grayscale is a shared prefix of 2 pipelines: ['blur', 'thumbnail']
variants produced: ['gray_blur', 'gray_thumb', 'thumb']
```

<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>Processes, not threads — and why:</strong> pixel transforms are CPU-bound Python/Pillow work; the GIL serializes threads. (Nuance if pushed: many Pillow ops release the GIL internally, so threads aren't useless — but processes are the safe default answer, and measuring beats asserting.)</li>
<li><strong>Picklability:</strong> process pools pickle tasks — pass <em>paths</em> and op <em>names</em>, not Image objects or lambdas. This is why <code>OPS</code> maps names to module-level functions.</li>
<li><strong>The thumbnail trap:</strong> <code>Image.thumbnail()</code> mutates and returns <code>None</code> — chaining it breaks. Catching this shows real Pillow familiarity.</li>
<li><strong>Per-job error isolation</strong> is in the reported grading ("per-job error handling"): a results map with an error string per failed input, batch always completes.</li>
</ul></div>

<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> O(total pixels &times; ops) of unavoidable transform work; with P processes on CPU-bound transforms, wall time ≈ sequential/P until disk decode/encode saturates. The trie version cuts the m&times;n variant from Σ|pipeline| ops per image to |trie nodes| per image — shared prefixes computed once.</p><p><strong>How efficient is it?</strong> The parallelism is embarrassingly clean (no shared state between jobs), so scaling is near-linear in cores; overheads to name are process startup and pickling of paths (tiny). The trie optimization is the algorithmic win: for pipelines like 10 variants of one base transform chain, it approaches a 10&times; reduction in compute.</p></div>

</div>
