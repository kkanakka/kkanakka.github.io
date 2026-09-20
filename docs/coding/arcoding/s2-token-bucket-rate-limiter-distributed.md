---
title: "S2 · Token-bucket rate limiter → distributed"
slug: /coding/arcoding/s2-token-bucket-rate-limiter-distributed
sidebar_position: 4
sidebar_label: "S2 · Token-bucket rate limiter → distributed"
description: "S2 · Token-bucket rate limiter → distributed"
---

<div class="arcoding">

## S2 · Token-bucket rate limiter → distributed

<div class="adm info"><div class="adm-title">ℹ️ Problem</div>
<ol>
<li><strong>L1:</strong> Per-API-key token bucket: <code>allow(key, now)</code> under rate r/sec with burst B.</li>
<li><strong>L2:</strong> Correct under concurrent callers.</li>
<li><strong>L3:</strong> 20 stateless gateway replicas must enforce one <em>global</em> limit. Design it; write the Redis version.</li>
<li><strong>Follow-up:</strong> What happens when the limiter backend is down?</li>
</ol></div>
<h4>Why token bucket (say this first)</h4>
<p>Fixed windows allow 2× bursts at boundaries; sliding-window logs are exact but O(requests) memory; sliding-window <em>counters</em> approximate well; token bucket gives smooth rate + configurable burst in O(1) state per key — the standard choice for API gateways. Naming the alternatives and choosing is worth more than the code.</p>
<h4>Levels 1–2</h4>

```python
import threading


class TokenBucket:
    """Lazy refill: no background timer thread. Tokens are recomputed from
    elapsed time on each call — O(1) state per key, exact."""

    def __init__(self, rate: float, burst: float):
        self.rate = rate            # tokens per second
        self.burst = burst          # bucket capacity
        self._state = {}            # key -> [tokens, last_ts]
        self._lock = threading.Lock()

    def allow(self, key: str, now: float, cost: float = 1.0) -> bool:
        with self._lock:
            tokens, last = self._state.get(key, (self.burst, now))
            if now < last:                      # clock skew guard
                now = last
            tokens = min(self.burst, tokens + (now - last) * self.rate)
            if tokens >= cost:
                self._state[key] = [tokens - cost, now]
                return True
            self._state[key] = [tokens, now]
            return False
```

<p>Sharpen L2 if asked about lock contention at high QPS: shard into N buckets of state, each with its own lock, chosen by <code>hash(key) % N</code> — contention drops N× with zero semantic change. Note the <code>cost</code> parameter: for an LLM API you rate-limit <em>tokens</em>, not requests, so a request costs its estimated token count — an on-theme observation.</p>
<h4>Level 3 — the distributed version</h4>
<p>Walk the three designs, then implement the centralized one:</p>
<ol>
<li><strong>Static split</strong> (each replica gets global/N): zero coordination, but wrong under skewed routing — one hot replica rejects while others sit idle.</li>
<li><strong>Centralized state in Redis</strong>: exact, one network hop on the hot path. The refill-and-take must be atomic — a GET/compute/SET from Python has a race between replicas — so it lives in a Lua script (or Redis functions):</li>
</ol>

```lua
-- rate_limit.lua  KEYS[1]=bucket  ARGV: rate, burst, now_ms, cost
local s      = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local rate   = tonumber(ARGV[1])
local burst  = tonumber(ARGV[2])
local now    = tonumber(ARGV[3])
local cost   = tonumber(ARGV[4])
local tokens = tonumber(s[1]) or burst
local ts     = tonumber(s[2]) or now
if now < ts then now = ts end
tokens = math.min(burst, tokens + (now - ts) * rate / 1000.0)
local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], 60000)   -- idle buckets self-clean
return allowed
```


```python
import time

class DistributedLimiter:
    def __init__(self, redis_client, rate, burst, local_fallback_frac=0.25):
        self.r = redis_client
        self.rate, self.burst = rate, burst
        self.script = self.r.register_script(open("rate_limit.lua").read())
        # conservative local bucket used only when Redis is unreachable:
        self.fallback = TokenBucket(rate * local_fallback_frac,
                                    burst * local_fallback_frac)

    def allow(self, key, cost=1.0):
        now_ms = int(time.time() * 1000)
        try:
            return bool(self.script(keys=[f"rl:{key}"],
                                    args=[self.rate, self.burst, now_ms, cost]))
        except Exception:
            # FAIL OPEN, bounded: don't take the API down because the
            # limiter died — but don't allow unlimited traffic either.
            return self.fallback.allow(key, now_ms / 1000.0, cost)
```

<ol start="3">
<li><strong>Hybrid quota distribution</strong>: local buckets, refilled by an async distributor that reapportions the global rate by observed per-replica demand every ~1 s. No hot-path network hop; accuracy is eventual (bounded overshoot ≈ one sync interval of burst). This is what you'd actually build at very high QPS — say so, and say why you'd still start with Redis (simpler, exact, and one hop is fine until proven otherwise).</li>
</ol>
<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>Fail open vs closed is a reliability decision, not a default.</strong> For a paid inference API: fail open with a conservative local fallback (availability &gt; perfect enforcement), but fail <em>closed</em> for abuse-tier keys. Being able to argue both directions is the point.</li>
<li><strong>Atomicity:</strong> identify the read-modify-write race across replicas before they ask; that's why the Lua script exists.</li>
<li><strong>Response semantics:</strong> return <code>429</code> with <code>Retry-After</code> computed from the token deficit — clients that back off correctly are part of the design.</li>
</ul></div>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> <code>allow()</code> is O(1) per call — the lazy-refill formula recomputes tokens from elapsed time instead of ticking a timer, so cost is independent of how long the bucket sat idle. <strong>Space:</strong> O(1) per active key; Redis keys self-expire via PEXPIRE, so idle keys cost nothing forever.</p><p><strong>How efficient is it?</strong> The distributed version adds exactly one round-trip per request (the Lua script is O(1) server-side); at very high QPS that RTT becomes the bottleneck, which is when the hybrid local-bucket + async-quota design wins — zero hot-path hops at the price of ~one sync interval of over-admission. Lock contention in-process is solved by sharding state across N locks: contention drops N&times; with no semantic change.</p></div>

### Run it

<p class="covers">Append this to the code above, save as <code>s2_token_bucket.py</code>, then run <code>python s2_token_bucket.py</code>. This exercises the in-process bucket; the Redis variant needs a live Redis and <code>rate_limit.lua</code>.</p>

```python
if __name__ == "__main__":
    # 5 tokens/sec, bucket holds 3 -> a burst of 3, then one per 200 ms
    tb = TokenBucket(rate=5.0, burst=3.0)

    print("--- burst then throttle (same key) ---")
    for i in range(5):
        print(f"t=0.00 req {i}: {tb.allow('user:1', now=0.0)}")

    print("\n--- refill is computed from elapsed time, no timer thread ---")
    for t in (0.1, 0.2, 0.4, 1.0):
        print(f"t={t:<4}: {tb.allow('user:1', now=t)}")

    print("\n--- keys are independent ---")
    print("user:2 first req:", tb.allow("user:2", now=0.4))

    print("\n--- cost > 1 for expensive calls ---")
    tb2 = TokenBucket(rate=1.0, burst=10.0)
    print("cost=8 :", tb2.allow("k", now=0.0, cost=8))
    print("cost=8 :", tb2.allow("k", now=0.0, cost=8))   # only 2 left
    print("cost=2 :", tb2.allow("k", now=0.0, cost=2))

    print("\n--- a clock that jumps backwards cannot mint tokens ---")
    tb3 = TokenBucket(rate=1.0, burst=2.0)
    print("t=10 :", tb3.allow("k", now=10.0))
    print("t=9  :", tb3.allow("k", now=9.0))             # skew clamped
    print("t=9  :", tb3.allow("k", now=9.0))
```

<p><strong>Output</strong></p>

```text
--- burst then throttle (same key) ---
t=0.00 req 0: True
t=0.00 req 1: True
t=0.00 req 2: True
t=0.00 req 3: False
t=0.00 req 4: False

--- refill is computed from elapsed time, no timer thread ---
t=0.1 : False
t=0.2 : True
t=0.4 : True
t=1.0 : True

--- keys are independent ---
user:2 first req: True

--- cost > 1 for expensive calls ---
cost=8 : True
cost=8 : False
cost=2 : True

--- a clock that jumps backwards cannot mint tokens ---
t=10 : True
t=9  : True
t=9  : False
```

</div>
