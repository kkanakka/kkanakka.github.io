---
title: "S4 · URL parsing / domain match counting"
slug: /coding/arcoding/s4-url-parsing-domain-match-counting
sidebar_position: 6
sidebar_label: "S4 · URL parsing / domain match counting"
description: "S4 · URL parsing / domain match counting"
---

<div class="arcoding">

## S4 · URL parsing / domain match counting

<p class="covers">Reported screen question: "parse all URLs from a list and count matches for a given domain, with follow-ups on asynchronous design and scaling."</p>
<h4>Level 1 — extraction + correct domain matching</h4>
<p>The correctness core is the matcher: <code>api.example.com</code> matches <code>example.com</code>, but <code>badexample.com</code> must not — compare on label boundaries, never with a raw substring test.</p>

```
import re
from collections import Counter
from urllib.parse import urlparse

# Pragmatic extractor; note aloud that a full-RFC URL grammar is out of scope.
URL_RE = re.compile(r"""https?://[^\s<>"'\)\]]+""", re.IGNORECASE)


def extract_urls(text: str) -> list[str]:
    return [u.rstrip(".,;:!?") for u in URL_RE.findall(text)]   # trim trailing punctuation


def normalize_host(url: str) -> str | None:
    try:
        host = urlparse(url).netloc
    except ValueError:
        return None
    host = host.split("@")[-1]        # strip userinfo  user:pass@host
    host = host.split(":")[0]         # strip port
    return host.lower().rstrip(".") or None


def host_matches(host: str, domain: str) -> bool:
    domain = domain.lower().rstrip(".")
    return host == domain or host.endswith("." + domain)


def count_domain(docs: list[str], domain: str) -> int:
    n = 0
    for doc in docs:
        for url in extract_urls(doc):
            host = normalize_host(url)
            if host and host_matches(host, domain):
                n += 1
    return n
```

<h4>Follow-up 1 — make it asynchronous (the docs are URLs to fetch)</h4>

```
import asyncio
import aiohttp


async def count_domain_async(page_urls, domain, *, concurrency=100, timeout=10):
    sem = asyncio.Semaphore(concurrency)          # bound in-flight requests
    counts = Counter()

    async def fetch_and_count(session, url):
        async with sem:
            try:
                async with session.get(
                        url, timeout=aiohttp.ClientTimeout(total=timeout)) as r:
                    if r.status != 200:
                        counts["fetch_errors"] += 1
                        return
                    text = await r.text()
            except Exception:
                counts["fetch_errors"] += 1
                return
        for u in extract_urls(text):              # parse OUTSIDE the semaphore
            host = normalize_host(u)
            if host and host_matches(host, domain):
                counts["matches"] += 1

    async with aiohttp.ClientSession() as session:
        await asyncio.gather(*(fetch_and_count(session, u) for u in page_urls))
    return counts
```

<p>Justify the choices: fetching is I/O-bound → asyncio, not threads-per-request; the semaphore is the politeness/capacity knob; error counts are a first-class output (an SRE answer reports what it failed to fetch, not just what matched).</p>
<h4>Follow-up 2 — scale to billions of documents</h4>
<p>Classic map-reduce shape: shard documents across workers; each worker emits partial <code>Counter</code>s; reduce by summation. The three things to say: workers are <strong>stateless and idempotent</strong> (a retried shard must not double-count — process shards exactly-once by recording shard completion, or make output keyed by shard id and overwrite); <strong>combine locally</strong> before shuffling so a hot domain doesn't melt one reducer; and per-domain counting is <em>associative</em>, which is what makes the whole thing embarrassingly parallel. If they push on "count per domain for all domains": emit <code>(registrable_domain, 1)</code> pairs and note that extracting the registrable domain properly needs the Public Suffix List (<code>co.uk</code> is not a registrable domain) — knowing that footnote is a strong signal.</p>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> extraction is O(total text) — the regex is a single linear scan; matching is O(len(domain)) per URL via <code>endswith</code>. The async fetcher’s throughput is concurrency-bound: ≈ semaphore_size / avg_fetch_latency pages/sec, with parsing effectively free next to network time. <strong>Space:</strong> O(URLs per doc) transiently; counters are O(distinct domains).</p><p><strong>How efficient is it?</strong> Linear and streamable — nothing needs the full corpus in memory, which is exactly why the map-reduce scale-up is trivial: per-domain counting is associative, local pre-aggregation shrinks the shuffle, and adding workers scales throughput linearly until network or the hottest reducer saturates.</p></div>

</div>
