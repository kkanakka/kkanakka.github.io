---
title: "B6 · Web crawler: single-threaded → multithreaded → async"
slug: /coding/arcoding/b6-web-crawler-single-threaded-multithreaded-async
sidebar_position: 13
sidebar_label: "B6 · Web crawler: single-threaded → multith…"
description: "B6 · Web crawler: single-threaded → multithreaded → async"
---

<div class="arcoding">

## B6 · Web crawler: single-threaded → multithreaded → async

<p class="covers">Covers 8 variants: single- and multi-threaded crawler · concurrent crawler · Same-Domain BFS · same-host crawler ×3 · Crawl Same-Domain Links · hostname-restricted crawler · crawler using a provided API.</p>

### The approach

<img src="/diagrams/arcoding/b6.svg" alt="URLs flow from a frontier through a link fetch, are filtered to the same host, checked against a seen set under a lock, and the survivors become the next frontier." class="doc-diagram doc-diagram-seq" />

<p>The crawl is one loop: take a frontier, fetch links, keep the same-host ones you have not seen, and those become the next frontier. The single correctness requirement is that <strong>check-and-add on the seen set is atomic</strong> — test then add as two steps lets two threads both claim a URL. Everything else is a concurrency-strategy swap over that same skeleton: a thread pool, a worker queue with poison pills, or asyncio with a semaphore for politeness.</p>

### What it looks like in memory

<p>The frontier and the seen set round by round, over the fake site used in <em>Run it</em>.</p>

<img src="/diagrams/arcoding-state/b6.svg" alt="The frontier and seen set at each round of the crawl, with the off-host link and the duplicate both rejected." class="doc-diagram doc-diagram-seq" />
<h4>Level 1 — single-threaded, correct hostname filter</h4>

```python
from urllib.parse import urlparse


def same_host(a: str, b_host: str) -> bool:
    """True if URL a lives on host b_host.

    Example:
        >>> same_host('http://ex.com/x', 'ex.com')
        True
        >>> same_host('http://other.com/y', 'ex.com')
        False
    """
    return urlparse(a).netloc == b_host


def crawl(start_url, get_links):
    """Single-threaded same-host crawl; returns every reachable URL.

    Example:
        >>> site = {'/': ['/a', '/b', 'http://x.com/z'], '/a': ['/b'], '/b': []}
        >>> sorted(crawl('/', lambda u: site.get(u, [])))
        ['/', '/a', '/b']
    """
    host = urlparse(start_url).netloc
    seen = {start_url}
    stack = [start_url]                      # DFS; deque.popleft() for BFS
    while stack:
        url = stack.pop()
        for nxt in get_links(url):
            if nxt not in seen and same_host(nxt, host):
                seen.add(nxt)
                stack.append(nxt)
    return list(seen)
```

<h4>Level 2 — multithreaded (I/O-bound ⇒ threads help despite the GIL)</h4>
<p>Two workable shapes; know both and justify your pick:</p>
<p><strong>(a) Frontier rounds</strong> — trivially correct termination, slight loss of parallelism at round edges:</p>

```python
import threading
from concurrent.futures import ThreadPoolExecutor


def crawl_mt(start_url, get_links, workers=8):
    """Same crawl across a thread pool; check-and-add on `seen` is locked.

    Example:
        >>> site = {'/': ['/a', '/b'], '/a': ['/b'], '/b': []}
        >>> sorted(crawl_mt('/', lambda u: site.get(u, []), workers=4))
        ['/', '/a', '/b']
    """
    host = urlparse(start_url).netloc
    seen = {start_url}
    lock = threading.Lock()

    def visit(url):
        found = []
        for nxt in get_links(url):                    # network I/O: GIL released
            if urlparse(nxt).netloc != host:
                continue
            with lock:
                if nxt in seen:                       # check-and-add is atomic
                    continue
                seen.add(nxt)
            found.append(nxt)
        return found

    frontier = [start_url]
    with ThreadPoolExecutor(max_workers=workers) as ex:
        while frontier:
            frontier = [u for batch in ex.map(visit, frontier) for u in batch]
    return list(seen)
```

<p><strong>(b) Shared queue + in-flight counter</strong> — full parallelism; termination is the hard part (queue empty ≠ done while any worker may still add URLs). <code>queue.Queue.task_done()/join()</code> solves exactly this:</p>

```python
import queue


def crawl_q(start_url, get_links, workers=8):
    """Same crawl with a work queue and poison-pill shutdown.

    Example:
        >>> site = {'/': ['/a', '/b'], '/a': ['/b'], '/b': []}
        >>> sorted(crawl_q('/', lambda u: site.get(u, []), workers=4))
        ['/', '/a', '/b']
    """
    host = urlparse(start_url).netloc
    seen = {start_url}
    lock = threading.Lock()
    q = queue.Queue()
    q.put(start_url)

    def worker():
        while True:
            url = q.get()
            if url is None:                           # poison pill
                q.task_done()
                return
            try:
                for nxt in get_links(url):
                    if urlparse(nxt).netloc != host:
                        continue
                    with lock:
                        if nxt in seen:
                            continue
                        seen.add(nxt)
                    q.put(nxt)
            finally:
                q.task_done()

    threads = [threading.Thread(target=worker, daemon=True)
               for _ in range(workers)]
    for th in threads:
        th.start()
    q.join()                                          # all discovered work done
    for _ in threads:
        q.put(None)                                   # release the workers
    q.join()
    return list(seen)
```

<h4>Level 3 — asyncio with politeness (rate limit + timeout + retry)</h4>

```python
import asyncio


async def crawl_async(start_url, aget_links, *, concurrency=20,
                      per_request_timeout=10, max_retries=2):
    """Same crawl on the event loop, bounded by a semaphore.

    Example:
        >>> import asyncio
        >>> site = {'/': ['/a', '/b'], '/a': [], '/b': []}
        >>> async def links(u): return site.get(u, [])
        >>> sorted(asyncio.run(crawl_async('/', links)))
        ['/', '/a', '/b']
    """
    host = urlparse(start_url).netloc
    seen = {start_url}
    sem = asyncio.Semaphore(concurrency)              # politeness knob

    async def fetch(url):
        for attempt in range(max_retries + 1):
            try:
                async with sem:
                    return await asyncio.wait_for(
                        aget_links(url), per_request_timeout)
            except asyncio.CancelledError:
                raise
            except Exception:
                if attempt == max_retries:
                    return []                          # log + skip, don't crash
                await asyncio.sleep(0.2 * 2 ** attempt)

    frontier = [start_url]
    while frontier:
        results = await asyncio.gather(*(fetch(u) for u in frontier))
        nxt = []
        for links in results:
            for u in links:
                if u not in seen and urlparse(u).netloc == host:
                    seen.add(u)
                    nxt.append(u)
        frontier = nxt
    return list(seen)
```

<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>The race:</strong> mark seen <em>before</em> fetching, inside the lock. Check-then-fetch-then-add lets two threads fetch the same URL — the specific bug this question exists to catch.</li>
<li><strong>Termination reasoning</strong> for the shared-queue version — explain why <code>join()</code> works: every <code>put</code> is eventually matched by a <code>task_done</code>, and puts only happen from tasks already counted.</li>
<li><strong>Hostname vs domain:</strong> <code>news.example.com</code> ≠ <code>example.com</code> under "same host"; under "same domain" reuse the label-boundary matcher from <a href="/docs/coding/arcoding/s4-url-parsing-domain-match-counting">S4</a>. Ask which.</li>
<li><strong>Production follow-ups:</strong> robots.txt, per-host token bucket, max depth/pages, URL normalization (fragments, trailing slashes, http/https duplicates), and cycle safety (the seen-set is the cycle guard).</li>
</ul></div>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> O(V + E) — each page fetched once (V), each link examined once (E); the seen-set makes cycles free. <strong>Space:</strong> O(V) for seen + frontier. <strong>Speedup:</strong> with W workers on I/O-bound fetches, wall time ≈ sequential/W until you saturate bandwidth, the target site, or politeness limits — the frontier-round version loses a little parallelism at round boundaries (stragglers), which the shared-queue version avoids at the cost of the harder termination argument.</p><p><strong>How efficient is it?</strong> Asymptotically optimal (every reachable page must be fetched once). The real-world constraint is politeness, not CPU: per-host rate limiting deliberately caps throughput — efficiency here means maximizing pages/sec <em>within</em> that cap, which is what the semaphore/concurrency knob tunes.</p></div>

### Run it

<p class="covers">Append this to the code above, save as <code>b6_crawler.py</code>, then run <code>python b6_crawler.py</code>. All four crawlers run against the same in-memory fake site, so the comparison is exact.</p>

```python
# A fake site: 4 same-host pages, one off-host link, one cycle back to /
SITE = {
    "http://ex.com/":  ["http://ex.com/a", "http://ex.com/b",
                        "http://other.com/x"],           # off-host: skipped
    "http://ex.com/a": ["http://ex.com/c", "http://ex.com/"],   # cycle
    "http://ex.com/b": ["http://ex.com/c"],                     # diamond
    "http://ex.com/c": [],
}


def get_links(url):
    return SITE.get(url, [])


async def aget_links(url):
    await asyncio.sleep(0.01)              # pretend it is a network call
    return SITE.get(url, [])


if __name__ == "__main__":
    start = "http://ex.com/"

    single = sorted(crawl(start, get_links))
    threaded = sorted(crawl_mt(start, get_links, workers=4))
    queued = sorted(crawl_q(start, get_links, workers=4))
    asyncd = sorted(asyncio.run(crawl_async(start, aget_links, concurrency=4)))

    for name, urls in (("single-threaded", single), ("thread pool", threaded),
                       ("worker queue", queued), ("asyncio", asyncd)):
        print(f"{name:<16}: {urls}")

    print("\nall four agree  :", single == threaded == queued == asyncd)
    print("off-host dropped:", "http://other.com/x" not in single)

    print("\n--- a flaky page must not sink the async crawl ---")
    async def flaky(url):
        if url == "http://ex.com/b":
            raise ConnectionError("boom")     # retried, then skipped
        return SITE.get(url, [])

    got = asyncio.run(crawl_async(start, flaky, max_retries=1))
    print("still crawled   :", sorted(got))
```

<p><strong>Output</strong></p>

```text
single-threaded : ['http://ex.com/', 'http://ex.com/a', 'http://ex.com/b', 'http://ex.com/c']
thread pool     : ['http://ex.com/', 'http://ex.com/a', 'http://ex.com/b', 'http://ex.com/c']
worker queue    : ['http://ex.com/', 'http://ex.com/a', 'http://ex.com/b', 'http://ex.com/c']
asyncio         : ['http://ex.com/', 'http://ex.com/a', 'http://ex.com/b', 'http://ex.com/c']

all four agree  : True
off-host dropped: True

--- a flaky page must not sink the async crawl ---
still crawled   : ['http://ex.com/', 'http://ex.com/a', 'http://ex.com/b', 'http://ex.com/c']
```

</div>
