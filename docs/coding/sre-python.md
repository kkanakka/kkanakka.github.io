---
title: "SRE Python: 38 Production Problems"
slug: /coding/sre-python
sidebar_position: 2
sidebar_label: "SRE Python: 38 Production Problems"
description: "SRE Python: 38 Production Problems"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/sre-python/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

38 production-flavored Python problems — from log dedupers to circuit breakers. Baseline → Improved → Production-grade, with Google SRE context for each.

Google SRE • Python Workbook • 38 Problems • 153 Pages

[Home](/) [Debugging Handbook](/docs/sre/sre-debugging) [NALSD Scenarios](/docs/sre/sre-nalsd)

## 38 Problems — 5 Sections

### Section 1: Core Infrastructure Utilities (1-8)

1.  [Log Deduper Script](#p1)
2.  [Disk Usage Monitor](#p2)
3.  [Rolling Log Compressor](#p3)
4.  [File Integrity Checker](#p4)
5.  [Temp File Cleaner](#p5)
6.  [Port Scanner Utility](#p6)
7.  [Service Restart Automator](#p7)
8.  [Config Drift Detector](#p8)

### Section 2: Networking & APIs (9-16)

9.  [HTTP Health Checker](#p9)
10.  [DNS Resolver Tool](#p10)
11.  [Simple TCP Proxy](#p11)
12.  [API Pagination Fetcher](#p12)
13.  [gRPC Health Check Client](#p13)
14.  [Latency Distribution Tool](#p14)
15.  [SSL Expiry Checker](#p15)
16.  [Cloud API Inventory Tool](#p16)

### Section 3: Data Handling & Parsing (17-23)

17.  [JSON Log Parser](#p17)
18.  [CSV Aggregator](#p18)
19.  [Streaming Median Calculator](#p19)
20.  [Log Window Aggregator](#p20)
21.  [XML Config Parser](#p21)
22.  [Streaming Join of Two Logs](#p22)
23.  [Text Metrics Extractor](#p23)

### Section 4: Reliability Automation (24-31)

24.  [Canary Rollout Script](#p24)
25.  [Retry with Exponential Backoff](#p25)
26.  [Quota Enforcer](#p26)
27.  [Dead-Letter Queue Reprocessor](#p27)
28.  [Auto-Scaler Simulator](#p28)
29.  [Feature Flag Simulator](#p29)
30.  [Chaos Monkey](#p30)
31.  [IAM Policy Analyzer](#p31)

### Section 5: Advanced / Stretch (32-38)

32.  [Distributed Lock (File-Based)](#p32)
33.  [Simple Metrics Exporter](#p33)
34.  [Circuit Breaker Wrapper](#p34)
35.  [Distributed Cache Client](#p35)
36.  [Backup Pruner](#p36)
37.  [Alert Simulator](#p37)
38.  [Secret/Key Rotation Script](#p38)

### The SRE Coding Mantra — Before Every Problem

```
1. ASSUME HOSTILE SCALE: Your code will run on data 1,000,000x larger. Stream, don't load.
2. ASSUME HOSTILE ENVIRONMENTS: Every I/O call will eventually fail. Handle exceptions, retry with backoff.
3. ASSUME HOSTILE ACTIONS: Script may run concurrently. Design for idempotency. Include dry-run mode.
4. ASSUME A BLIND OPERATOR: Code must log its actions, emit metrics, make state visible.

"Your goal is not the most clever algorithm, but the most robust, observable, and trustworthy utility."
```

Section 1: Core Infrastructure Utilities (Problems 1-8)

<a id="p1"></a>

### Problem 1: Log Deduper Script

**Prompt:** Write a Python script that reads a log file and removes duplicate lines while preserving order. Must handle 10GB+ logs.

#### Why Google Asks This

Duplicate log entries waste storage, flood monitoring, and overwhelm operators. Tests stream processing, memory-efficient hashing, and production awareness.

#### Evolution: Naive → Streaming → Production

```python
## BASELINE (naive — fails at scale)
def dedupe_log(file_path, output_path):
    seen = set()
    with open(file_path, "r") as infile, open(output_path, "w") as outfile:
        for line in infile:
            if line not in seen:
                seen.add(line)
                outfile.write(line)

## IMPROVED (streaming + hashing — handles 10GB+)
import hashlib
def dedupe_log_stream(file_path, output_path):
    seen = set()
    with open(file_path, "r") as infile, open(output_path, "w") as outfile:
        for line in infile:
            digest = hashlib.sha256(line.encode()).hexdigest()
            if digest not in seen:
                seen.add(digest)
                outfile.write(line)
# Stores only 64-byte hashes, not full lines. Much better.
# For billions of unique lines → swap to Bloom filter.

## ADVANCED (follow mode — live log cleaning like tail -f)
import hashlib, os, time
def dedupe_tail(file_path):
    seen = set()
    with open(file_path, "r") as f:
        f.seek(0, os.SEEK_END)
        while True:
            line = f.readline()
            if not line:
                time.sleep(0.5)
                continue
            digest = hashlib.sha256(line.encode()).hexdigest()
            if digest not in seen:
                seen.add(digest)
                print(line.strip())
```

**Checklist:** Works for arbitrarily large files? Preserves first occurrence order? Handles empty files, binary lines? Modular and documented? Would another SRE trust this in production?

<a id="p2"></a>

### Problem 2: Disk Usage Monitor

**Prompt:** Build a script that alerts if disk usage crosses a configurable threshold. Support multiple mount points.

```python
## PRODUCTION VERSION (multi-mount + JSON + Slack alert)
import shutil, json, sys, requests

def check_disk_usage(mounts, threshold=80):
    results = {}
    for path in mounts:
        try:
            total, used, free = shutil.disk_usage(path)
            usage_pct = (used / total) * 100
            results[path] = round(usage_pct, 2)
            if usage_pct > threshold:
                print(f"ALERT: {path} at {usage_pct:.1f}%", file=sys.stderr)
        except FileNotFoundError:
            results[path] = "ERROR: mount not found"
    return results

if __name__ == "__main__":
    mounts = ["/", "/var", "/tmp", "/mnt/data"]
    results = check_disk_usage(mounts, threshold=80)
    print(json.dumps(results, indent=2))
```

#### Senior Signal

Don't alert at 80% blindly — predict **time-to-fill (TTF)** given current write rate. Much smarter, fewer false alarms.

<a id="p3"></a>

### Problem 3: Rolling Log Compressor

**Prompt:** Rotate logs: keep last N uncompressed, gzip older ones. Use atomic tmp + rename to avoid corruption. Exclude the active log file being written.

```python
import os, gzip, shutil
from pathlib import Path

def safe_rotate(log_dir, keep=3):
    logs = sorted(Path(log_dir).glob("*.log"), key=os.path.getmtime, reverse=True)
    logs = logs[1:]  # exclude active (latest) file
    for i, log in enumerate(logs):
        if i >= keep - 1:
            tmp = log.with_suffix(log.suffix + ".gz.tmp")
            final = log.with_suffix(log.suffix + ".gz")
            with open(log, "rb") as f_in, gzip.open(tmp, "wb") as f_out:
                shutil.copyfileobj(f_in, f_out)
            os.rename(tmp, final)  # atomic!
            os.remove(log)
```

<a id="p4"></a>

### Problem 4: File Integrity Checker

**Prompt:** SHA-256 hash all files in a directory tree. Stream in chunks (64KB) for large files. Output JSON. Parallelize with multiprocessing.

```python
import os, hashlib, json
from multiprocessing import Pool

def hash_file(path, block_size=65536):
    sha = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            while chunk := f.read(block_size):
                sha.update(chunk)
        return (path, sha.hexdigest())
    except Exception as e:
        return (path, f"ERROR: {e}")

def parallel_hash_dir(directory):
    paths = [os.path.join(r, f) for r, _, fs in os.walk(directory) for f in fs]
    with Pool(8) as pool:
        return dict(pool.map(hash_file, paths))
```

<a id="p5"></a>

### Problem 5: Temp File Cleaner

**Prompt:** Delete files in /tmp older than N days. Skip symlinks. Dry-run mode. Structured JSON logging.

```python
import argparse, json, os, time, sys
from pathlib import Path

def clean_tmp(root="/tmp", days=7, dry_run=True):
    cutoff = time.time() - days * 86400
    log = {"deleted": [], "skipped_symlink": [], "errors": [], "dry_run": dry_run}
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            p = Path(dirpath) / name
            try:
                if p.is_symlink():
                    log["skipped_symlink"].append(str(p))
                    continue
                if not p.is_file():
                    continue
                if p.stat().st_mtime < cutoff:
                    if dry_run:
                        log["deleted"].append(str(p))
                    else:
                        p.unlink()
                        log["deleted"].append(str(p))
            except OSError as e:
                log["errors"].append({"path": str(p), "error": str(e)})
    print(json.dumps(log, indent=2))

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="/tmp")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--execute", action="store_true", help="actually delete (default dry-run)")
    args = ap.parse_args()
    clean_tmp(args.root, args.days, dry_run=not args.execute)
```

**Notes:** Default is dry-run; require explicit `--execute` for deletes. Never follow symlinks (`is_symlink()` first).

<a id="p6"></a>

### Problem 6: Port Scanner Utility

**Prompt:** Scan a host for open TCP ports. Sequential → ThreadPool → asyncio. Handle timeouts.

```python
## ASYNCIO (correct await on open_connection)
import asyncio

async def scan_port(host: str, port: int, timeout=1.0):
    try:
        conn = asyncio.open_connection(host, port)
        reader, writer = await asyncio.wait_for(conn, timeout=timeout)
        writer.close()
        await writer.wait_closed()
        return port, True
    except Exception:
        return port, False

async def scan_range(host, ports):
    results = await asyncio.gather(*(scan_port(host, p) for p in ports))
    return [p for p, ok in results if ok]

# asyncio.run(scan_range("127.0.0.1", range(8000, 8010)))

## THREAD POOL (bounded concurrency)
from concurrent.futures import ThreadPoolExecutor, as_completed
import socket

def scan_tcp(host, port, timeout=1.0):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        if s.connect_ex((host, port)) == 0:
            return port
    finally:
        s.close()
    return None

def scan_threaded(host, ports, workers=256):
    open_ports = []
    with ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(scan_tcp, host, p): p for p in ports}
        for fut in as_completed(futs):
            r = fut.result()
            if r is not None:
                open_ports.append(r)
    return sorted(open_ports)
```

<a id="p7"></a>

### Problem 7: Service Restart Automator

**Prompt:** Auto-restart a flaky service if health check fails. Exponential backoff. Prometheus metrics. Circuit breaker: stop after 5 failures.

```python
import time, requests, subprocess, logging

def restart_with_backoff(service="myapp", url="http://localhost:8080/healthz", attempts=5):
    for i in range(attempts):
        try:
            if requests.get(url, timeout=2).status_code == 200:
                logging.info("Service healthy")
                return
        except: pass
        wait = 2 ** i
        logging.warning(f"Attempt {i+1}: restart {service}, wait {wait}s")
        subprocess.run(["systemctl", "restart", service], check=False)
        time.sleep(wait)
    logging.error(f"CIRCUIT OPEN: {service} failed {attempts}x → escalate to human")
```

<a id="p8"></a>

### Problem 8: Config Drift Detector

**Prompt:** Compare two JSON configs recursively. Detect missing keys, different values, type mismatches. Generate patch JSON.

```python
def recursive_diff(d1, d2, path=""):
    diffs = {}
    for key in set(d1.keys()).union(d2.keys()):
        p = f"{path}.{key}" if path else key
        if key not in d1:      diffs[p] = ("MISSING", d2[key])
        elif key not in d2:    diffs[p] = (d1[key], "MISSING")
        elif isinstance(d1[key], dict) and isinstance(d2[key], dict):
            diffs.update(recursive_diff(d1[key], d2[key], p))
        elif d1[key] != d2[key]:
            diffs[p] = (d1[key], d2[key])
    return diffs
```

Section 2: Networking & APIs (Problems 9-16)

<a id="p9"></a>

### P9: HTTP Health Checker

Check multiple endpoints concurrently. Measure response time. Report status + latency in JSON. Alert on failures. ThreadPoolExecutor.

```python
import json, time
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.request

def probe(url, timeout=5):
    t0 = time.perf_counter()
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(256)  # cap read
            ms = (time.perf_counter() - t0) * 1000
            return {"url": url, "ok": True, "status": r.status, "latency_ms": round(ms, 2)}
    except Exception as e:
        ms = (time.perf_counter() - t0) * 1000
        return {"url": url, "ok": False, "error": str(e), "latency_ms": round(ms, 2)}

def check_all(urls, workers=16):
    out = []
    with ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(probe, u): u for u in urls}
        for fut in as_completed(futs):
            out.append(fut.result())
    bad = [x for x in out if not x["ok"]]
    for b in bad:
        print(f"ALERT: {b['url']} -> {b.get('error','bad status')}", flush=True)
    print(json.dumps({"results": out, "failed": len(bad)}, indent=2))
```

<a id="p10"></a>

### P10: DNS Resolver Tool

Resolve A/AAAA/MX/CNAME records. Compare against multiple resolvers (8.8.8.8, 1.1.1.1, authoritative). Detect propagation inconsistencies. Uses `dns.resolver` (dnspython).

```python
# pip install dnspython
import dns.resolver

def resolve_at(name, rtype, nameserver):
    r = dns.resolver.Resolver(configure=False)
    r.nameservers = [nameserver]
    r.lifetime = 3
    ans = r.resolve(name, rtype, raise_on_no_answer=False)
    return sorted({str(a) for a in ans})

def compare_resolvers(name, rtype="A"):
    targets = {"google": "8.8.8.8", "cloudflare": "1.1.1.1"}
    sets = {k: set(resolve_at(name, rtype, ip)) for k, ip in targets.items()}
    inconsistent = sets["google"] != sets["cloudflare"]
    return {"name": name, "rtype": rtype, "by_resolver": {k: sorted(v) for k, v in sets.items()}, "inconsistent": inconsistent}
```

<a id="p11"></a>

### P11: Simple TCP Proxy

Forward TCP connections from one port to another. Bidirectional data relay with threading. Useful for debugging service-to-service communication.

```python
import socket, threading

def relay(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try: src.close()
        except OSError: pass
        try: dst.close()
        except OSError: pass

def handle(client, upstream_host, upstream_port):
    up = socket.create_connection((upstream_host, upstream_port), timeout=10)
    t1 = threading.Thread(target=relay, args=(client, up), daemon=True)
    t2 = threading.Thread(target=relay, args=(up, client), daemon=True)
    t1.start(); t2.start()

def serve(listen_port, upstream_host, upstream_port):
    ls = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    ls.bind(("0.0.0.0", listen_port))
    ls.listen(128)
    while True:
        c, _ = ls.accept()
        threading.Thread(target=handle, args=(c, upstream_host, upstream_port), daemon=True).start()
```

<a id="p12"></a>

### P12: API Pagination Fetcher

Fetch all pages from a paginated REST API. Handle rate limits (429 + Retry-After). Exponential backoff. Stream results to file/stdout.

```python
import json, time, random, urllib.error, urllib.request

def fetch_page(url):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    for attempt in range(8):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                if r.status == 429:
                    ra = int(r.headers.get("Retry-After", "2"))
                    time.sleep(ra + random.random())
                    continue
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                ra = int(e.headers.get("Retry-After", "2"))
                time.sleep(ra + random.uniform(0, 1))
                continue
            raise
        except Exception:
            time.sleep((2 ** attempt) + random.random())
    raise RuntimeError("give up")

def crawl(start_url, next_url_fn, out_fp):
    """next_url_fn(body) -> str|None for next page URL"""
    url = start_url
    while url:
        body = fetch_page(url)
        out_fp.write(json.dumps(body) + "\n")
        out_fp.flush()
        url = next_url_fn(body)
```

<a id="p13"></a>

### P13: gRPC Health Check Client

Call the standard gRPC health check endpoint. Report SERVING/NOT\_SERVING/UNKNOWN. Uses `grpcio-health-checking`.

```python
# pip install grpcio grpcio-health-checking
import grpc
from grpc_health.v1 import health_pb2, health_pb2_grpc

def grpc_health(target: str, service: str = "", timeout=3.0):
    """target like 'localhost:50051'"""
    ch = grpc.insecure_channel(target)
    stub = health_pb2_grpc.HealthStub(ch)
    resp = stub.Check(health_pb2.HealthCheckRequest(service=service), timeout=timeout)
    return {"status": health_pb2.HealthCheckResponse.ServingStatus.Name(resp.status)}
```

<a id="p14"></a>

### P14: Latency Distribution Tool

Hit an endpoint N times, collect latencies, compute p50/p95/p99/p999. Display histogram. Concurrent load with ThreadPool.

```python
import time, statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.request

def one_get(url):
    t0 = time.perf_counter()
    with urllib.request.urlopen(url, timeout=10) as r:
        r.read(64)
    return (time.perf_counter() - t0) * 1000

def percentiles(latencies):
    s = sorted(latencies)
    def pct(p):
        if not s: return None
        k = max(0, min(len(s)-1, int(round((p/100)*(len(s)-1)))))
        return s[k]
    return {"p50": pct(50), "p95": pct(95), "p99": pct(99), "p999": pct(99.9), "n": len(s)}

def load_test(url, n=200, workers=32):
    lat = []
    with ThreadPoolExecutor(workers) as ex:
        futs = [ex.submit(one_get, url) for _ in range(n)]
        for fut in as_completed(futs):
            lat.append(fut.result())
    return percentiles(lat)
```

<a id="p15"></a>

### P15: SSL Expiry Checker

Check TLS certificate expiry for multiple hosts. Alert if expiring within N days. Uses `ssl` + `socket`. Output JSON.

```python
import json, ssl, socket
from datetime import datetime, timezone, timedelta

def cert_expiry(host, port=443, timeout=5):
    ctx = ssl.create_default_context()
    with socket.create_connection((host, port), timeout=timeout) as raw:
        with ctx.wrap_socket(raw, server_hostname=host) as ss:
            cert = ss.getpeercert()
    # notAfter like 'Jan 15 23:59:59 2027 GMT'
    exp = datetime.strptime(cert["notAfter"], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
    days_left = (exp - datetime.now(timezone.utc)).days
    return {"host": host, "not_after": cert["notAfter"], "days_left": days_left}

def check_hosts(hosts, warn_days=30):
    out = []
    for h in hosts:
        info = cert_expiry(h)
        out.append(info)
        if info["days_left"] < warn_days:
            print(f"ALERT: {h} cert expires in {info['days_left']}d", flush=True)
    print(json.dumps(out, indent=2))
```

<a id="p16"></a>

### P16: Cloud API Inventory Tool

List all GCP/AWS resources (VMs, disks, LBs) via API. Detect unused resources (unattached disks, idle VMs). Output cost-saving recommendations.

```python
# Pattern: thin wrappers + one report — swap in real SDK clients in prod.

def aws_find_unattached_volumes(ec2_client):
    vols = ec2_client.describe_volumes()["Volumes"]
    return [v["VolumeId"] for v in vols if v.get("Attachments") == []]

def gcp_find_unused_disks(compute, project, zone):
    # disks with users=[] are unattached
    req = compute.disks().list(project=project, zone=zone)
    unatt = []
    while req is not None:
        resp = req.execute()
        for d in resp.get("items", []):
            if not d.get("users"):
                unatt.append(d["name"])
        req = compute.disks().list_next(previous_request=req, previous_response=resp)
    return unatt

def report(recommendations):
    import json
    print(json.dumps({"cost_savings_candidates": recommendations}, indent=2))
```

Section 3: Data Handling & Parsing (Problems 17-23)

<a id="p17"></a>

### P17: JSON Log Parser

Parse structured JSON logs. Filter by severity/timestamp/field. Stream processing for large files. Output matching lines or aggregate counts.

```python
import json, sys

def parse_stream(fp, min_level="ERROR", field_must_exist=None):
    levels = {"DEBUG":10,"INFO":20,"WARN":30,"WARNING":30,"ERROR":40,"FATAL":50}
    thr = levels.get(min_level.upper(), 40)
    counts = {}
    for line in fp:
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        sev = str(o.get("severity") or o.get("level") or "INFO").upper()
        if levels.get(sev, 20) < thr:
            continue
        if field_must_exist and field_must_exist not in o:
            continue
        counts[sev] = counts.get(sev, 0) + 1
        print(line)
    print(json.dumps({"aggregates": counts}, indent=2), file=sys.stderr)
```

<a id="p18"></a>

### P18: CSV Aggregator

Aggregate a large CSV: GROUP BY + SUM/AVG/COUNT. Stream without loading entire file. Uses `csv.DictReader` + `collections.defaultdict`.

```python
import csv
from collections import defaultdict

def aggregate_csv(path, group_col, value_col, mode="sum"):
    """mode: sum | count | avg (stores sum+count)"""
    acc = defaultdict(lambda: [0, 0])  # sum, count
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            g = row[group_col]
            if mode == "count":
                acc[g][1] += 1
            else:
                v = float(row[value_col])
                acc[g][0] += v
                acc[g][1] += 1
    out = {}
    for g, (s, c) in acc.items():
        out[g] = c if mode == "count" else (s / c if mode == "avg" else s)
    return out
```

<a id="p19"></a>

### P19: Streaming Median Calculator

Compute running median of a data stream. Two-heap approach (max-heap + min-heap). O(log n) per insert, O(1) median query. Uses `heapq`.

```python
import heapq

class StreamingMedian:
    def __init__(self):
        self.low = []   # max-heap (negated values)
        self.high = []  # min-heap

    def add(self, x):
        if not self.low or x <= -self.low[0]:
            heapq.heappush(self.low, -x)
        else:
            heapq.heappush(self.high, x)
        if len(self.low) > len(self.high) + 1:
            heapq.heappush(self.high, -heapq.heappop(self.low))
        elif len(self.high) > len(self.low):
            heapq.heappush(self.low, -heapq.heappop(self.high))

    def median(self):
        if len(self.low) > len(self.high):
            return -self.low[0]
        return (-self.low[0] + self.high[0]) / 2
```

<a id="p20"></a>

### P20: Log Window Aggregator

Sliding time window aggregation: count events per 5-min bucket. Handles out-of-order events. Watermark-based flushing. SRE metric pipeline mini-sim.

```python
import json
from collections import defaultdict
from datetime import datetime, timezone, timedelta

BUCKET = timedelta(minutes=5)
WATERMARK_LAG = timedelta(minutes=15)

def floor_bucket(ts: datetime):
    epoch = int(ts.timestamp())
    step = int(BUCKET.total_seconds())
    return datetime.fromtimestamp((epoch // step) * step, tz=timezone.utc)

def process_stream(events, now):
    """events: iterable of (ts, obj); emit counts for buckets fully behind watermark"""
    counts = defaultdict(int)
    wm = now - WATERMARK_LAG
    for ts, obj in events:
        b = floor_bucket(ts)
        if b <= wm:
            counts[b.isoformat()] += 1
    return dict(sorted(counts.items()))
```

<a id="p21"></a>

### P21: XML Config Parser

Parse XML configs safely (`defusedxml` for XXE protection). Extract nested values. Compare old vs new configs. Handle malformed XML gracefully.

```python
# pip install defusedxml
import defusedxml.ElementTree as ET

def parse_safe(xml_bytes: bytes):
    try:
        root = ET.fromstring(xml_bytes)
        return root
    except ET.ParseError as e:
        return {"error": str(e)}

def xml_to_flat_dict(root):
    out = {}
    for el in root.iter():
        if el.text and el.text.strip():
            out[el.tag] = el.text.strip()
    return out
```

<a id="p22"></a>

### P22: Streaming Join of Two Logs

Merge two timestamp-sorted log files into one sorted stream. Handles different time formats. O(1) memory (two file pointers + merge sort).

```python
import heapq

def merge_sorted_logs(iter_a, iter_b, key_fn):
    """iter_* yield lines; key_fn(line)->comparable ts (merge by first tuple field)"""
    it = heapq.merge(
        ((key_fn(la), la) for la in iter_a),
        ((key_fn(lb), lb) for lb in iter_b),
    )
    for _, line in it:
        yield line
```

<a id="p23"></a>

### P23: Text Metrics Extractor

Extract numeric metrics from unstructured text (log lines like "latency=42ms"). Regex extraction + statistical summary (mean, p95, p99).

```python
import re, statistics

LAT_RE = re.compile(r"latency[=:](\d+(?:\.\d+)?)\s*ms", re.I)

def extract_latencies(lines):
    vals = []
    for ln in lines:
        m = LAT_RE.search(ln)
        if m:
            vals.append(float(m.group(1)))
    if not vals:
        return {}
    vals.sort()
    def pct(p):
        i = max(0, min(len(vals)-1, int(round((p/100)*(len(vals)-1)))))
        return vals[i]
    return {
        "n": len(vals),
        "mean": round(statistics.mean(vals), 3),
        "p95": pct(95),
        "p99": pct(99),
    }
```

Section 4: Reliability Automation (Problems 24-31)

<a id="p24"></a>

### P24: Canary Rollout Script

Simulate progressive rollout: 1% → 5% → 25% → 100%. At each stage, check error rate. Auto-rollback if errors > threshold. Sleep between stages.

```python
import time

def canary_rollout(error_fn, stages=[(0.01, 0.02), (0.05, 0.02), (0.25, 0.02), (1.0, 0.02)]):
    """error_fn(traffic_frac)->error_rate in [0,1]. Roll back if error > limit."""
    traffic = 0.0
    for target, err_limit in stages:
        traffic = target
        err = error_fn(traffic)
        print(f"traffic={traffic:.0%} err={err:.3f} limit={err_limit}")
        if err > err_limit:
            print("ROLLBACK")
            traffic = max(0.0, traffic / 4)
            break
        time.sleep(0.2)
    return traffic
```

<a id="p25"></a>

### P25: Retry with Exponential Backoff

Generic retry decorator. Exponential backoff + jitter. Configurable max retries, base delay. Respects Retry-After header. The most reusable SRE pattern.

```python
import functools, random, time, urllib.error, urllib.request

def retry_with_backoff(func, max_retries=5, base_delay=1):
    for attempt in range(max_retries):
        try:
            return func()
        except Exception as e:
            if attempt == max_retries - 1:
                raise
            delay = base_delay * (2 ** attempt) + random.uniform(0, 1)
            print(f"Retry {attempt+1}/{max_retries} in {delay:.1f}s: {e}")
            time.sleep(delay)

def retry_http_get(url, max_retries=6, base=0.5):
    for attempt in range(max_retries):
        try:
            return urllib.request.urlopen(url, timeout=15).read()
        except urllib.error.HTTPError as e:
            if e.code == 429:
                ra = float(e.headers.get("Retry-After", base * (2 ** attempt)))
                time.sleep(ra + random.random())
                continue
            raise
        except Exception:
            if attempt == max_retries - 1:
                raise
            time.sleep(base * (2 ** attempt) + random.random())

def backoff_decorator(max_retries=5, base_delay=1):
    def deco(fn):
        @functools.wraps(fn)
        def wrapped(*a, **kw):
            for attempt in range(max_retries):
                try:
                    return fn(*a, **kw)
                except Exception as e:
                    if attempt == max_retries - 1:
                        raise
                    d = base_delay * (2 ** attempt) + random.uniform(0, 1)
                    time.sleep(d)
        return wrapped
    return deco
```

<a id="p26"></a>

### P26: Quota Enforcer

Token bucket rate limiter in Python. Track requests per tenant. Return 429 when quota exceeded. Configurable refill rate. Thread-safe.

```python
import threading, time

class TokenBucket:
    def __init__(self, rate_per_sec, burst):
        self.rate = rate_per_sec
        self.burst = burst
        self.tokens = float(burst)
        self.last = time.monotonic()
        self.lock = threading.Lock()

    def allow(self):
        with self.lock:
            now = time.monotonic()
            self.tokens = min(self.burst, self.tokens + (now - self.last) * self.rate)
            self.last = now
            if self.tokens < 1:
                return False
            self.tokens -= 1
            return True

class QuotaEnforcer:
    def __init__(self, rate, burst):
        self.rate, self.burst = rate, burst
        self._b = {}
        self._lock = threading.Lock()

    def check(self, tenant):
        with self._lock:
            b = self._b.setdefault(tenant, TokenBucket(self.rate, self.burst))
        return (200, "ok") if b.allow() else (429, "quota exceeded")
```

<a id="p27"></a>

### P27: Dead-Letter Queue Reprocessor

Read failed messages from DLQ. Attempt re-delivery with backoff. Move permanently failed to archive. Track success/failure metrics.

```python
import json, random, time

def reprocess_dlq(dlq_path, deliver_fn, max_attempts=5, archive_path="archive.jsonl"):
    stats = {"ok": 0, "fail": 0}
    with open(dlq_path) as dlq, open(archive_path, "a") as arch:
        for line in dlq:
            msg = json.loads(line)
            for n in range(max_attempts):
                try:
                    deliver_fn(msg)
                    stats["ok"] += 1
                    break
                except Exception:
                    time.sleep((2 ** n) + random.random())
            else:
                arch.write(line)
                stats["fail"] += 1
    return stats
```

<a id="p28"></a>

### P28: Auto-Scaler Simulator

Simulate auto-scaling: monitor request rate, scale up/down instances. Cooldown period between scale events. Print instance count over time.

```python
def autosim(rps_series, target_rps_per_inst=100, cooldown=2, min_n=1, max_n=20):
    n = min_n
    last_change = -cooldown - 1
    for t, rps in enumerate(rps_series):
        desired = max(min_n, min(max_n, (rps + target_rps_per_inst - 1) // target_rps_per_inst))
        if t - last_change >= cooldown and desired != n:
            n = int(desired)
            last_change = t
        print(f"t={t} rps={rps} instances={n}")
```

<a id="p29"></a>

### P29: Feature Flag Simulator

In-memory feature flag system. Percentage-based rollout. Override per user. Evaluate flags with consistent hashing (user always gets same result).

```python
import hashlib

class FeatureFlags:
    def __init__(self):
        self.rollout = {}
        self.overrides = {}

    def set_rollout(self, flag, pct):
        self.rollout[flag] = pct

    def set_user(self, flag, user, on):
        self.overrides[(flag, user)] = on

    def is_on(self, flag, user: str) -> bool:
        if (flag, user) in self.overrides:
            return self.overrides[(flag, user)]
        pct = self.rollout.get(flag, 0)
        h = int(hashlib.sha256(f"{flag}:{user}".encode()).hexdigest(), 16)
        return (h % 100) < pct
```

<a id="p30"></a>

### P30: Chaos Monkey

Randomly kill processes/pods from a target list. Configurable probability. Dry-run mode. Structured logging. Exclude protected services. Cooldown between kills.

```python
import json, random

def chaos_pick(targets, p=0.1, protected=None, dry_run=True, cooldown=30):
    protected = set(protected or [])
    # Enforce cooldown between cron invocations outside this function
    victim = [t for t in targets if t not in protected and random.random() < p]
    print(json.dumps({"dry_run": dry_run, "victims": victim}))
    return victim
```

<a id="p31"></a>

### P31: IAM Policy Analyzer

Parse IAM/RBAC policies (JSON). Detect overprivileged roles (e.g., admin on prod). Flag wildcards (\* in actions/resources). Output risk report.

```python
def analyze_policy(doc):
    risks = []
    for stmt in doc.get("Statement", []):
        actions = stmt.get("Action") or stmt.get("Actions") or []
        if isinstance(actions, str):
            actions = [actions]
        res = stmt.get("Resource") or stmt.get("Resources") or []
        if isinstance(res, str):
            res = [res]
        for a in actions:
            if a == "*" or str(a).endswith(":*"):
                risks.append({"type": "wildcard_action", "action": a})
        for r in res:
            if r == "*":
                risks.append({"type": "wildcard_resource", "resource": r})
        if stmt.get("Effect") == "Allow" and ("*" in actions or any(str(a).endswith(":*") for a in actions)):
            risks.append({"type": "admin_like", "statement": stmt})
    return {"risk_count": len(risks), "risks": risks}
```

Section 5: Advanced / Stretch (Problems 32-38)

<a id="p32"></a>

### P32: Distributed Lock (File-Based)

File-based locking using `fcntl.flock()`. Prevent concurrent script execution. Timeout + stale lock detection. Critical for cron job safety.

```python
import os, time, fcntl

class FileLock:
    def __init__(self, path, stale_after=3600):
        self.path = path
        self.stale_after = stale_after

    def acquire(self, blocking=True, timeout=30):
        self.f = open(self.path, "a+")
        start = time.time()
        while True:
            try:
                fcntl.flock(self.f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.f.seek(0)
                self.f.write(str(os.getpid()))
                self.f.flush()
                return True
            except BlockingIOError:
                if os.path.exists(self.path):
                    age = time.time() - os.path.getmtime(self.path)
                    if age > self.stale_after:
                        os.unlink(self.path)
                if not blocking or (time.time() - start) > timeout:
                    return False
                time.sleep(0.2)

    def release(self):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()
```

<a id="p33"></a>

### P33: Simple Metrics Exporter

Expose Prometheus-compatible `/metrics` endpoint. Counter, Gauge, Histogram. Uses `prometheus_client`. Push custom SRE metrics from any script.

```python
# pip install prometheus_client
import time
from prometheus_client import Counter, Gauge, Histogram, start_http_server

REQ = Counter("demo_requests_total", "requests", ["route"])
LAT = Histogram("demo_latency_seconds", "latency", buckets=(.005, .01, .025, .05, .1, .25, 1))
UP = Gauge("demo_up", "1 if process healthy")

if __name__ == "__main__":
    start_http_server(9100)
    UP.set(1)
    while True:
        REQ.labels(route="/").inc()
        LAT.observe(0.012)
        time.sleep(5)
```

<a id="p34"></a>

### P34: Circuit Breaker Wrapper

Three states: CLOSED (normal) → OPEN (fail fast) → HALF-OPEN (test recovery). Track failure rate. Configurable threshold + reset timeout.

```python
import time

class CircuitBreaker:
    def __init__(self, failure_threshold=5, reset_timeout=30):
        self.failure_threshold = failure_threshold
        self.reset_timeout = reset_timeout
        self.failures = 0
        self.state = "CLOSED"
        self.last_failure_time = 0

    def call(self, func, *args, **kwargs):
        if self.state == "OPEN":
            if time.time() - self.last_failure_time > self.reset_timeout:
                self.state = "HALF_OPEN"
            else:
                raise Exception("Circuit OPEN — failing fast")
        try:
            result = func(*args, **kwargs)
            if self.state == "HALF_OPEN":
                self.state = "CLOSED"
                self.failures = 0
            return result
        except Exception as e:
            self.failures += 1
            self.last_failure_time = time.time()
            if self.failures >= self.failure_threshold:
                self.state = "OPEN"
            raise
```

<a id="p35"></a>

### P35: Distributed Cache Client

Client wrapper for Redis/Memcached. GET/SET with TTL. Cache-aside pattern. Handle connection failures gracefully (serve without cache). Metrics.

```python
# pip install redis
import redis

class CacheAside:
    def __init__(self, url="redis://localhost:6379/0"):
        try:
            self.r = redis.Redis.from_url(url, socket_timeout=0.5)
            self.r.ping()
            self.ok = True
        except Exception:
            self.r = None
            self.ok = False

    def get(self, key, loader_fn):
        if self.ok:
            try:
                v = self.r.get(key)
                if v is not None:
                    return v.decode()
            except Exception:
                pass
        v = loader_fn()
        if self.ok:
            try:
                self.r.setex(key, 300, v)
            except Exception:
                pass
        return v
```

<a id="p36"></a>

### P36: Backup Pruner

Implement retention policy: keep daily for 7 days, weekly for 4 weeks, monthly for 12 months. Delete the rest. Dry-run mode. Works on S3/GCS/local.

```python
import os, re, time
from datetime import datetime, timedelta

def prune_backups(root, dry_run=True):
    """Filenames like backup-2026-04-01.sql.gz — keep tiers, delete older."""
    pat = re.compile(r"backup-(\d{4}-\d{2}-\d{2})")
    files = []
    for name in os.listdir(root):
        m = pat.search(name)
        if m:
            files.append((datetime.strptime(m.group(1), "%Y-%m-%d"), os.path.join(root, name)))
    files.sort(reverse=True)
    keep = set()
    for dt, path in files:
        age = (datetime.utcnow() - dt).days
        if age <= 7 or (age <= 28 and dt.weekday() == 6) or (age <= 365 and dt.day == 1):
            keep.add(path)
    for _, path in files:
        if path not in keep:
            print(("DRY " if dry_run else "") + f"delete {path}")
            if not dry_run:
                os.remove(path)
```

<a id="p37"></a>

### P37: Alert Simulator

Generate synthetic alerts at configurable rates. Test alert pipelines, PagerDuty routing, Slack integration. Useful for game days.

```python
import json, random, time

def fire_alerts(rate_per_min=60, duration_sec=10, out=print):
    end = time.time() + duration_sec
    interval = 60.0 / max(1, rate_per_min)
    while time.time() < end:
        alert = {
            "severity": random.choice(["info", "warning", "critical"]),
            "service": random.choice(["payments", "search", "auth"]),
            "msg": "synthetic load test",
        }
        out(json.dumps(alert))
        time.sleep(interval)
```

<a id="p38"></a>

### P38: Secret/Key Rotation Script

Generate new secret, update in secret manager (Vault/GCP KMS), update service config, verify service health, rollback on failure. Zero-downtime rotation.

```python
import os, secrets, subprocess, time

def rotate_secret(health_url, set_secret_fn, verify_fn):
    old = os.environ.get("API_SECRET")
    new = secrets.token_hex(32)
    set_secret_fn("API_SECRET_NEXT", new)
    subprocess.run(["deploy", "canary", "10pct"], check=False)
    time.sleep(10)
    if not verify_fn(health_url):
        set_secret_fn("API_SECRET_NEXT", old)
        subprocess.run(["deploy", "rollback"], check=False)
        raise SystemExit("rotation aborted")
    set_secret_fn("API_SECRET", new)
    set_secret_fn("API_SECRET_NEXT", "")
    subprocess.run(["deploy", "full"], check=False)
```

Pattern: **dual-secret** — write new as secondary, canary, verify, promote, clear old. Wire `set_secret_fn` to Vault/GCP SM. Add `import os` at top.
