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
  <li><b>Candidate A → ZooKeeper:</b> create /election/n_ EPHEMERAL_SEQUENTIAL</li>
  <li><b>ZooKeeper → Candidate A:</b> n_00000041 → lowest: leader (response)</li>
  <li><b>Candidate B → ZooKeeper:</b> create → n_00000042</li>
  <li><b>Candidate B → ZooKeeper:</b> watch predecessor n_41</li>
  <li><b>Candidate A → Storage:</b> write(data, epoch=41)</li>
  <li><b>Storage → Candidate A:</b> ok (response)</li>
  <li><b>Client → ZooKeeper:</b> getData /config, watch=true</li>
  <li><b>ZooKeeper → Client:</b> data, version 812 (response)</li>
  <li><b>Candidate A:</b> GC pause 30 s; session expires</li>
  <li><b>ZooKeeper:</b> delete n_41</li>
  <li><b>ZooKeeper → Candidate B:</b> watch fires → B is leader (async)</li>
  <li><b>Candidate B → Storage:</b> write(data, epoch=42)</li>
  <li><b>Storage → Candidate B:</b> ok; last_seen=42 (response)</li>
  <li><b>Candidate A → Storage:</b> A wakes: write(data, epoch=41)</li>
  <li><b>Storage → Candidate A:</b> rejected: 41 &lt; 42 (response)</li>
  <li><b>Client → ZooKeeper:</b> setData /config v813 (CAS on 812)</li>
  <li><b>ZooKeeper → Client:</b> watch: changed (async)</li>
  <li><b>Client → ZooKeeper:</b> re-read, validate, apply, re-arm</li>
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
