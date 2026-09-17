---
title: "Strongly consistent config service / leader election with fencing tokens"
slug: /system-design-notes/infra-config
sidebar_position: 21
sidebar_label: "Strongly consistent config service / lea…"
description: "medium · ZooKeeper · quorum · watches · sessions · fencing · last‑known‑good"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/infra-config/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">medium · ZooKeeper · quorum · watches · sessions · fencing · last‑known‑good</span>
</header>

## Requirements {#infra-config-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Store small config with versioning; clients get updates within seconds</li>
      <li>Elect exactly one leader per shard/resource; re‑elect on failure</li>
      <li>Prevent a stale leader from writing (fencing)</li>
      <li>Clients keep operating if the config service is unavailable</li>
      <li class="out">Large blobs; secrets management</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Linearizable writes; tolerate f node failures with 2f+1</li>
      <li>Leader failover in seconds (session timeout bound)</li>
      <li>Thousands of watching clients without overloading the ensemble</li>
      <li>Bad config must be revertible in one action</li>
    </ol>
  </div>
</div>


## Scale, performance and safety targets {#infra-config-targets}

<p>This is a small‑data, high‑consequence system: kilobytes of state that every other service depends on. The numbers below are why it is a consensus ensemble and not a database.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>QPS:</b> writes are rare — hundreds per day, a few per second at most during a rollout. Reads are almost all local cache hits; the ensemble sees a few thousand watch registrations and reconnects per second at worst.</li>
    <li><b>Data volume:</b> tens of thousands of znodes, each a few KB — the whole dataset fits in memory by design. Tens of thousands of client sessions and watches is the real capacity dimension, not bytes.</li>
    <li><b>Growth:</b> client count grows with the fleet (~2× annually), so watch fan‑out grows too. Config size should stay flat — the moment it does not, the blob belongs in S3 with only the pointer here.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> quorum write p50 &lt; 5 ms, p99 &lt; 50 ms within a region; local read &lt; 1 ms; config change visible to all clients p99 &lt; 5 s; leader failover bounded by the session timeout, so 5–30 s.</li>
    <li><b>Throughput:</b> tens of thousands of writes/s is the ceiling of the ensemble and far more than needed — the design target is to stay two orders of magnitude below it, because a config service under write pressure is a config service being misused.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the dangers are internal and self‑inflicted — a watch storm from thousands of clients re‑arming at once, a service polling config in a tight loop, and above all a bad config value propagating to the entire fleet in seconds. Schema validation, canaries and observer nodes are the defences.</li>
    <li><b>Rate limiting:</b> per‑client caps on watches and requests, backoff with jitter on reconnect so an ensemble restart does not trigger a stampede, and a write rate limit on config paths so a runaway automation cannot flood the log.</li>
    <li><b>Data sensitivity:</b> config, not secrets — no credentials, tokens or PII in znodes, because everything here is replicated five ways and cached on every client. Secrets go to a secrets manager; ACLs restrict write paths to the owning service; every write is authenticated and audited.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> 99.95% for the ensemble, but the number that matters more is that dependent services target four nines <em>while tolerating</em> a config outage — availability comes from client caching, not from the ensemble never failing.</li>
    <li><b>Degraded mode:</b> ensemble unreachable → clients serve last‑known‑good config from local disk and alarm; they never block startup on it. Quorum lost → the ensemble refuses writes rather than accepting unreplicated ones, and elections pause until it returns. Stale beats down, always.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> linearizable writes — this is the entire reason for consensus. Reads are served locally and may lag, so a caller needing a linearizable read must <code>sync()</code> first, and that distinction should be stated explicitly.</li>
    <li><b>Durability:</b> a committed write survives f failures in a 2f+1 ensemble; the transaction log is fsynced before acknowledgement, which is also why write latency is measured in milliseconds rather than microseconds.</li>
    <li><b>Compliance:</b> every config change is an audited, attributable event with a previous version to revert to — which is as much a change‑management requirement as a technical one.</li></ul></div>
</div>

## Entities and API {#infra-config-api}

<p>ZNode (path, data, version, ephemeral?, seq) · Session (id, timeout, heartbeat) · Watch (path, client, one‑shot) · Leader (resource, holder, epoch) · FencingToken (monotonic epoch) · ConfigVersion</p>
<pre><code>create(/election/shardN/n_, EPHEMERAL_SEQUENTIAL)   -&gt; /election/shardN/n_00000042
getChildren(/election/shardN) ; watch(predecessor)
getData(/config/router, watch=true)                  -&gt; {data, version}
setData(/config/router, data, expectedVersion)       -&gt; CAS write
Downstream store API: write(payload, epoch)  → rejected if epoch &lt; last_seen</code></pre>

## Design {#infra-config-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/infra-config/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 290" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ZooKeeper quorum of 5; ephemeral sequential znodes for leader election; watches notify clients of config changes; session timeouts detect dead leaders; fencing token (epoch) passed to storage which rejects stale epochs; clients cache last-known-good config">
  <defs><marker id="k1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="k2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
  <style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.tm{font-size:10.5px;fill:#1B2430;font-family:"IBM Plex Mono",Menlo,monospace}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#k1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#k2);stroke-dasharray:2 4}.lbla{font-size:10.5px;fill:#B45309}</style>
  <rect class="box" x="20" y="30" width="240" height="110" stroke="#0F766E"></rect><text class="tb" x="140" y="50" text-anchor="middle">ZooKeeper ensemble (5 nodes)</text>
  <text class="ts" x="30" y="68">quorum = 3; tolerates 2 failures</text><text class="ts" x="30" y="82">writes: leader proposes, majority acks (ZAB)</text><text class="ts" x="30" y="96">reads: local, linearizable with sync()</text>
  <text class="tm" x="30" y="114">/config/router  v=812</text><text class="tm" x="30" y="128">/election/shard7/n_00000041 (ephemeral, seq)</text>
  <rect class="box" x="300" y="30" width="200" height="110"></rect><text class="tb" x="400" y="50" text-anchor="middle">Leader election</text>
  <text class="ts" x="310" y="68">each candidate creates an ephemeral</text><text class="ts" x="310" y="82">sequential znode; lowest seq = leader</text><text class="ts" x="310" y="96">others watch the node just below them</text><text class="ts" x="310" y="110">(no herd). Session timeout (e.g. 10 s)</text><text class="ts" x="310" y="124">→ znode deleted → next becomes leader</text>
  <rect class="box" x="540" y="30" width="200" height="110" stroke="#B45309"></rect><text class="tb" x="640" y="50" text-anchor="middle">Fencing token</text>
  <text class="ts" x="550" y="68">token = epoch = znode seq / zxid</text><text class="ts" x="550" y="82">monotonic across leaders</text><text class="ts" x="550" y="96">leader includes it in every write</text><text class="ts" x="550" y="110">storage rejects token &lt; last seen</text><text class="ts" x="550" y="124">→ paused old leader can't corrupt</text>
  <rect class="box" x="780" y="30" width="180" height="110"></rect><text class="tb" x="870" y="50" text-anchor="middle">Storage / resource</text>
  <text class="tm" x="790" y="68">write(data, epoch=41)</text><text class="tm" x="790" y="82">if epoch &lt; 42: reject</text>
  <text class="ts" x="790" y="102">the resource, not ZK,</text><text class="ts" x="790" y="116">enforces single‑writer;</text><text class="ts" x="790" y="130">ZK only hands out epochs</text>
  <path class="fa" d="M740 85 L778 85"></path>
  <rect class="box" x="20" y="170" width="480" height="105"></rect><text class="tb" x="30" y="190">Clients: watches and last‑known‑good</text>
  <text class="ts" x="30" y="208">· read config once, set a watch; on change notification re‑read (watches are one‑shot; re‑arm)</text>
  <text class="ts" x="30" y="222">· cache to local disk; on ZK unreachable keep serving with cached config (stale &gt; down)</text>
  <text class="ts" x="30" y="236">· config carries a version; apply only if newer; validate schema before apply</text>
  <text class="ts" x="30" y="250">· never block startup on ZK: boot from cache, reconcile when reachable</text>
  <text class="ts" x="30" y="264">· jittered reconnect; session re‑establish before re‑arming watches</text>
  <rect class="box" x="540" y="170" width="420" height="105"></rect><text class="tb" x="550" y="190">Why the lease alone isn't enough</text>
  <text class="ts" x="550" y="208">Leader A GC‑pauses 30 s. Its session expires; B is elected. A wakes, still</text>
  <text class="ts" x="550" y="222">believes it's leader, writes. Without fencing, two writers. With epochs,</text>
  <text class="ts" x="550" y="236">A's writes carry 41, storage has seen 42, rejects them.</text>
  <text class="ts" x="550" y="254">Same reason Redlock is unsafe for correctness‑critical locks: the lock</text>
  <text class="ts" x="550" y="268">service can't stop a client that thinks it holds the lock; only the resource can.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 780" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Config service and leader election flow">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="5" y="14" width="130" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Client</text>
<line class="ln" x1="70" y1="48" x2="70" y2="760"></line>
<rect class="sb" x="215" y="14" width="130" height="34"></rect><text class="st" x="280" y="36" text-anchor="middle">ZooKeeper</text>
<line class="ln" x1="280" y1="48" x2="280" y2="760"></line>
<rect class="sb" x="425" y="14" width="130" height="34"></rect><text class="st" x="490" y="36" text-anchor="middle">Candidate A</text>
<line class="ln" x1="490" y1="48" x2="490" y2="760"></line>
<rect class="sb" x="635" y="14" width="130" height="34"></rect><text class="st" x="700" y="36" text-anchor="middle">Candidate B</text>
<line class="ln" x1="700" y1="48" x2="700" y2="760"></line>
<rect class="sb" x="845" y="14" width="130" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Storage</text>
<line class="ln" x1="910" y1="48" x2="910" y2="760"></line>
<line class="a1" x1="482" y1="80" x2="288" y2="80"></line>
<text class="sl" x="385" y="74" text-anchor="middle">create /election/n_ EPHEMERAL_SEQUENTIAL</text>
<line class="a2" x1="288" y1="114" x2="482" y2="114"></line>
<text class="sl" x="385" y="108" text-anchor="middle">n_00000041 → lowest: leader</text>
<line class="a1" x1="692" y1="148" x2="288" y2="148"></line>
<text class="sl" x="490" y="142" text-anchor="middle">create → n_00000042</text>
<line class="a1" x1="692" y1="182" x2="288" y2="182"></line>
<text class="sl" x="490" y="176" text-anchor="middle">watch predecessor n_41</text>
<line class="a1" x1="498" y1="216" x2="902" y2="216"></line>
<text class="sl" x="700" y="210" text-anchor="middle">write(data, epoch=41)</text>
<line class="a2" x1="902" y1="250" x2="498" y2="250"></line>
<text class="sl" x="700" y="244" text-anchor="middle">ok</text>
<line class="a1" x1="78" y1="284" x2="272" y2="284"></line>
<text class="sl" x="175" y="278" text-anchor="middle">getData /config, watch=true</text>
<line class="a2" x1="272" y1="318" x2="78" y2="318"></line>
<text class="sl" x="175" y="312" text-anchor="middle">data, version 812</text>
<rect class="nt" x="-28" y="339" width="196" height="22"></rect><text class="sl" x="70" y="354" text-anchor="middle">cache last-known-good to disk</text>
<rect class="nt" x="389" y="373" width="202" height="22"></rect><text class="sl" x="490" y="388" text-anchor="middle">GC pause 30 s; session expires</text>
<rect class="nt" x="235" y="407" width="90" height="22"></rect><text class="sl" x="280" y="422" text-anchor="middle">delete n_41</text>
<line class="a3" x1="288" y1="454" x2="692" y2="454"></line>
<text class="sl" x="490" y="448" text-anchor="middle">watch fires → B is leader</text>
<line class="a1" x1="708" y1="488" x2="902" y2="488"></line>
<text class="sl" x="805" y="482" text-anchor="middle">write(data, epoch=42)</text>
<line class="a2" x1="902" y1="522" x2="708" y2="522"></line>
<text class="sl" x="805" y="516" text-anchor="middle">ok; last_seen=42</text>
<line class="a1" x1="498" y1="556" x2="902" y2="556"></line>
<text class="sl" x="700" y="550" text-anchor="middle">A wakes: write(data, epoch=41)</text>
<line class="a2" x1="902" y1="590" x2="498" y2="590"></line>
<text class="sl" x="700" y="584" text-anchor="middle">rejected: 41 &lt; 42</text>
<line class="a1" x1="78" y1="624" x2="272" y2="624"></line>
<text class="sl" x="175" y="618" text-anchor="middle">setData /config v813 (CAS on 812)</text>
<line class="a3" x1="272" y1="658" x2="78" y2="658"></line>
<text class="sl" x="175" y="652" text-anchor="middle">watch: changed</text>
<line class="a1" x1="78" y1="692" x2="272" y2="692"></line>
<text class="sl" x="175" y="686" text-anchor="middle">re-read, validate, apply, re-arm</text>
<rect class="nt" x="-40" y="713" width="220" height="22"></rect><text class="sl" x="70" y="728" text-anchor="middle">ZK unreachable → keep serving cached config, alarm</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Candidate A → ZooKeeper:</b> create /election/n_ EPHEMERAL_SEQUENTIAL.
    Ephemeral ties the node's existence to A's live session, so leadership evaporates automatically if A dies — no lease to expire manually, no cleanup job.
    Sequential gives every candidate a globally ordered number from a single consensus‑ordered counter, which turns "who is leader?" into a total order rather than a negotiation.
    The two properties together are the whole election: the rest is just reading the list.</li>
  <li><b>ZooKeeper → Candidate A:</b> n_00000041 → lowest: leader (response).
    A reads the children, sees its own sequence is the smallest, and concludes it is leader — no votes, no messages between candidates.
    The number itself becomes the epoch, and that is what makes the fencing later possible.</li>
  <li><b>Candidate B → ZooKeeper:</b> create → n_00000042.
    B follows the identical code path and gets a higher number, so it is a follower; there is no separate "run for leader" and "stand by" logic to keep consistent.
    Candidates are therefore symmetric, which is what makes the protocol easy to reason about under churn.</li>
  <li><b>Candidate B → ZooKeeper:</b> watch predecessor n_41.
    B watches only the node immediately before it, not the parent — this is the detail that separates a working election from an outage.
    Watching the parent means every candidate wakes on every change: a thousand candidates produce a thousand notifications and a herd that can take the ensemble down.
    Watching the predecessor means exactly one candidate wakes when one node disappears.</li>
  <li><b>Candidate A → Storage:</b> write(data, epoch=41).
    The leader does its actual job, and crucially it stamps every downstream write with its epoch.
    Passing the token is cheap when nothing is wrong, and it is the only thing that will save the system when something is.</li>
  <li><b>Storage → Candidate A:</b> ok (response).
    Storage records 41 as the highest epoch it has seen and accepts the write — this is the state that later makes a stale leader harmless.</li>
  <li><b>Client → ZooKeeper:</b> getData /config, watch=true.
    Config is read once and then subscribed to; clients do not poll, which is what keeps a service with thousands of clients from generating constant load.
    The read also returns a version, which is what makes later compare‑and‑swap writes safe.</li>
  <li><b>ZooKeeper → Client:</b> data, version 812 (response).
    The client caches the value and writes it to local disk as last‑known‑good, so a restart during an ensemble outage still comes up with working config.
    Version 812 is carried along so the client can ignore a notification that turns out to be older than what it already has.</li>
  <li><b>Candidate A:</b> GC pause 30 s; session expires.
    This is the scenario the whole design exists for: A is not dead and not partitioned, just stopped, and it does not know time has passed.
    Nothing A can do detects this from the inside, which is why correctness cannot depend on the old leader behaving well.</li>
  <li><b>ZooKeeper:</b> delete n_41.
    Missing heartbeats expire the session, and the ephemeral node vanishes with it — failure detection and leadership release are the same event.
    The timeout is a real trade‑off: short means fast failover but false positives under GC; long means fewer false alarms but slower recovery. Fencing is what lets you choose the longer, safer timeout.</li>
  <li><b>ZooKeeper → Candidate B:</b> watch fires → B is leader (async).
    Exactly one notification goes to exactly one candidate, and B re‑reads the children to confirm it is now lowest rather than assuming it.
    Watches are one‑shot, so B re‑arms as part of handling this one — forgetting to re‑arm is the classic bug that makes an election work once and then silently stop.</li>
  <li><b>Candidate B → Storage:</b> write(data, epoch=42).
    The new leader's epoch is strictly higher, because it comes from a monotonically increasing counter ordered by consensus.
    At this instant there are genuinely two processes that believe they are leader — the design does not prevent that, it makes it harmless.</li>
  <li><b>Storage → Candidate B:</b> ok; last_seen=42 (response).
    Storage moves its high‑water mark to 42, and that single number now invalidates every older leader forever.</li>
  <li><b>Candidate A → Storage:</b> A wakes: write(data, epoch=41).
    A resumes mid‑operation, still holding what it believes is valid leadership, and does exactly what it was about to do before the pause.
    From A's perspective nothing is wrong; there is no check it could have run that would have told it otherwise.</li>
  <li><b>Storage → Candidate A:</b> rejected: 41 &lt; 42 (response).
    The resource itself refuses the stale write — this is the critical placement: fencing must be enforced by the thing being protected, not by the coordinator.
    A lock service can only tell you that you held the lock a moment ago; only the storage layer can refuse the write happening now.
    This is also precisely why a lock protocol without fencing tokens is unsafe no matter how careful its timeouts are.</li>
  <li><b>Client → ZooKeeper:</b> setData /config v813 (CAS on 812).
    Writes are compare‑and‑swap on the version the client last read, so two concurrent updaters cannot silently clobber each other.
    A rejected CAS means re‑read, re‑apply and retry — the same discipline as any optimistic concurrency scheme.</li>
  <li><b>ZooKeeper → Client:</b> watch: changed (async).
    The notification deliberately carries no data: it says something changed, not what, which keeps the ensemble from fanning out payloads to thousands of watchers.
    It also fires once, so every client must re‑arm; with many clients, observer nodes or a fan‑out proxy absorb this load instead of the voting members.</li>
  <li><b>Client → ZooKeeper:</b> re-read, validate, apply, re-arm.
    The client re‑reads, validates against a schema, and only applies if the version is newer — validation here is the last line of defence before a bad value reaches production.
    Clients report the version they have applied, which turns "did the config land?" into an observable rollout rather than a guess.
    Because the previous version is still stored, a bad config is one CAS write away from being reverted fleet‑wide.</li>
</ol>

## How it works, step by step {#infra-config-flow}

<ol class="order">
  <li>Ensemble of 5 runs ZAB/Raft; a write is committed when 3 acknowledge; reads are local (sync() for linearizable).</li>
  <li>Candidates create ephemeral sequential znodes; the lowest sequence is leader; each watches only its predecessor to avoid a herd.</li>
  <li>Leader’s session is kept alive by heartbeats; if it misses the timeout, its znode disappears and the next candidate is notified and takes over.</li>
  <li>The new leader’s epoch (its sequence or the zxid) is the fencing token; it includes it in every write to the downstream store, which rejects any lower epoch. A paused old leader’s writes are refused.</li>
  <li>Clients read config with a watch; on notification they re‑read, validate the schema, apply if the version is newer, and re‑arm the watch.</li>
  <li>Clients persist last‑known‑good config locally; if the ensemble is unreachable they keep serving from cache and alarm; they never block startup on the config service.</li>
  <li>Config rollout is a versioned write, canaried to a client subset by policy, with one‑click revert to the previous version.</li>
</ol>

## Deep dives {#infra-config-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/infra-config/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
  <div><h4>Consensus facts to have ready</h4><ul>
    <li>2f+1 nodes tolerate f failures; 5 is the sweet spot (3 too fragile during upgrades, 7 slows writes).</li>
    <li>ZAB/Raft: single leader orders writes; followers ack; commit at majority. Writes ~ms; throughput tens of thousands/s; not a database.</li>
    <li>Reads are served locally and may lag; <code>sync()</code> before read for linearizability.</li>
    <li>Session = heartbeat + timeout. Too short → false leader loss under GC; too long → slow failover. Typically 5–30 s.</li></ul></div>
  <div><h4>Config service specifics</h4><ul>
    <li>Small values (KBs), few writes, many readers: ZK/etcd shape exactly. Large blobs go in S3 with the pointer in ZK.</li>
    <li>Watch fan‑out: thousands of clients watching one node → observer nodes / a fan‑out proxy so the ensemble isn't hammered.</li>
    <li>Rollout of config = versioned write + gradual client pickup; clients report applied version so you can see propagation.</li>
    <li>Guard against bad config: schema validation, canary subset of clients, one‑click revert to previous version.</li></ul></div>
  <div><h4>The hooks from ownership</h4><ul>
    <li>"We saw split brain during a network partition until we added fencing tokens to the downstream store."</li>
    <li>"Session timeout tuning against GC pauses; we moved to a longer session plus fencing rather than shorter sessions."</li>
    <li>"Clients that failed closed on ZK outage took the product down; now they serve last‑known‑good and alarm."</li>
    <li>"Watch storms on a hot znode; fixed with observers and by batching config into fewer nodes."</li></ul></div>
</div>


## Trade-offs {#infra-config-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Ensemble size</td><td>5 nodes (tolerates 2 failures)</td><td>Write latency — every commit waits for 3 acks</td><td>3 when the ensemble is small and upgrades are rare; 7 only if you genuinely need to survive 3 simultaneous failures and can pay the slower writes</td></tr>
  <tr><td>Read semantics</td><td>Local reads that may lag</td><td>Linearizability by default; callers who need it must <code>sync()</code> first</td><td>Always sync when the read decides something safety‑critical; never sync on the hot path, or you lose the point of local reads</td></tr>
  <tr><td>Session timeout</td><td>Long session plus fencing tokens</td><td>Slower failover — leadership can take tens of seconds to move</td><td>Shorter sessions only if GC pauses are genuinely bounded; without fencing, shortening the timeout trades one correctness bug for another</td></tr>
  <tr><td>Where fencing is enforced</td><td>At the downstream resource, on every write</td><td>Every storage API must carry and check an epoch</td><td>Never move it into the coordinator — a lock service can only attest to the past, and that is exactly the gap a paused leader walks through</td></tr>
  <tr><td>Election topology</td><td>Watch your predecessor only</td><td>Slightly more bookkeeping than watching the parent</td><td>Never watch the parent at scale: one departure then wakes every candidate and the herd can take the ensemble down</td></tr>
  <tr><td>Client failure behaviour</td><td>Serve last‑known‑good from local disk</td><td>Clients can run on stale config for the length of an outage</td><td>Fail closed only where stale config is actively dangerous; for most services, stale beats down by a wide margin</td></tr>
  <tr><td>What goes in a znode</td><td>Small values; blobs live in S3 with a pointer here</td><td>An extra fetch for anything large</td><td>Never store blobs directly — the dataset is replicated five ways and held in memory, so size is a cluster‑wide cost</td></tr>
</tbody></table>

## Safety-first design {#infra-config-safety}

<div class="cards">
  <div><h4>Assume the leader is lying</h4><ul>
    <li><b>Split brain is not preventable, only survivable.</b> A paused process cannot know it lost leadership, so the design makes its writes harmless instead of trying to stop them.</li>
    <li><b>Epochs are monotonic and consensus‑ordered.</b> A new leader's token is always strictly higher, which permanently invalidates every earlier one at the resource.</li>
    <li><b>Enforcement belongs to the resource.</b> Storage rejects any write below its high‑water epoch — the check happens where the damage would happen.</li>
    <li><b>Fencing is what buys a safe timeout.</b> With it you can choose a session long enough to survive GC pauses without risking two live writers.</li></ul></div>
  <div><h4>A bad config is a fleet‑wide outage</h4><ul>
    <li><b>Validate before applying.</b> Schema validation on the client is the last gate before a malformed value reaches a running service.</li>
    <li><b>Canary the rollout.</b> A versioned write picked up by a subset of clients first turns "push to everyone in 5 seconds" into a controlled change.</li>
    <li><b>Revert in one action.</b> The previous version is always present, so recovery is a single CAS write rather than a redeploy.</li>
    <li><b>Watch the propagation.</b> Clients report the version they have applied, so a stuck or partially applied config is visible instead of mysterious.</li></ul></div>
  <div><h4>Never take the fleet down with you</h4><ul>
    <li><b>Last‑known‑good on every client.</b> Config is cached to local disk, so an ensemble outage degrades to "running on yesterday's config and alarming", not "nothing starts".</li>
    <li><b>Never block startup.</b> A service that cannot boot without the config service has converted a dependency into a hard availability ceiling.</li>
    <li><b>Protect the ensemble from its clients.</b> Observer nodes absorb watch fan‑out, and reconnects use jittered backoff so a restart does not become a stampede.</li>
    <li><b>No secrets, no blobs, no PII.</b> Everything here is replicated five ways, held in memory and cached on every client — which makes it exactly the wrong place for sensitive data.</li></ul></div>
</div>

## Don't leave the room without saying {#infra-config-check}

<ul class="checklist">
  <li>2f+1, quorum, why 5</li>
  <li>Ephemeral sequential znodes; watch the predecessor, not the parent</li>
  <li>Session timeout trade‑off vs GC pauses</li>
  <li>Fencing tokens enforced by the resource, not the coordinator; why Redlock is unsafe without them</li>
  <li>Watches are one‑shot; re‑arm; observers for fan‑out</li>
  <li>Last‑known‑good on clients; stale beats down</li>
  <li>Versioned config, schema validation, canary, revert</li>
</ul>

## What each level is expected to drive {#infra-config-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>ZK/etcd for config and leader election; watches for updates</td><td>Fencing, session tuning</td></tr>
  <tr><td>Senior</td><td>Full election protocol, fencing tokens with the split‑brain scenario, client caching and reconnect behaviour, watch fan‑out</td><td>Observer nodes, config canaries</td></tr>
  <tr><td>Staff+</td><td>Consensus trade‑offs (ZAB vs Raft, read semantics), failure stories from ownership, blast‑radius control for config, capacity of the ensemble and operational upgrades</td><td>—</td></tr>
</tbody></table>
