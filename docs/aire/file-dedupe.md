---
title: "Robust file deduplication"
slug: /aire/file-dedupe
sidebar_position: 16
sidebar_label: "Robust file deduplication"
description: "medium · hashing · filesystem races · corruption · hardlinks vs content store · verification"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/file-dedupe/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<header>
  
  <span class="tag">medium · hashing · filesystem races · corruption · hardlinks vs content store · verification</span>
</header>
<p>Given a large filesystem (or object store), find duplicate files and reclaim space safely. The naive "hash everything and delete the copies" is where the interview starts; the score is in handling files that change while you scan, hash collisions and corruption, and making the reclaim step reversible.</p>

## Requirements {#file-dedupe-req}

<div class="board">
  <div><h4>Functional</h4><ol>
      <li>Scan a tree; identify byte‑identical files; report groups and reclaimable bytes</li>
      <li>Reclaim: replace duplicates with hardlinks/reflinks or references to a content store</li>
      <li>Incremental rescans; exclusions; dry‑run and undo</li>
      <li class="out">Near‑duplicate (similar) detection</li>
  </ol></div>
  <div><h4>Non‑functional</h4><ol>
      <li>Never lose or corrupt data: any reclaim must be verifiable and reversible</li>
      <li>Scale: 100M files, PBs; I/O‑bound, so minimize bytes read</li>
      <li>Correct under concurrent modification</li>
      <li>Handle symlinks, hardlinks, sparse files, permissions, special files</li>
  </ol></div>
</div>
<div class="note"><b>Cheap filters first:</b> group by size (free, from stat), then hash the first 64 KB, then full hash only for remaining candidates, then byte‑compare or verify before acting. Most files are unique by size alone; full‑hashing everything reads the whole disk for nothing.</div>


## Scale, performance and safety targets {#file-dedupe-targets}

<p>Dedup is an I/O‑bound scan with a destructive tail. The numbers decide the filter cascade; the safety rules decide whether anyone will ever run it twice.</p>

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>Work per run:</b> 100M files across petabytes. The scan itself is ~100M <code>stat</code> calls; what matters is how few of those turn into full reads.</li>
    <li><b>Data volume:</b> hashing everything would read petabytes. Size grouping alone typically eliminates 90%+ of files, and a 64 KB partial hash removes most of the rest — so full reads land on a few percent of the corpus.</li>
    <li><b>Growth:</b> the tree grows continuously, which makes incremental rescans a requirement rather than an optimisation: only files whose (size, mtime, ctime) changed should ever be rehashed.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> a full scan of 100M files in hours, not days; an incremental rescan in minutes. Reclaim throughput of thousands of files/s, throttled so the scan never degrades whatever else uses that filesystem.</li>
    <li><b>Throughput:</b> bounded by sequential read bandwidth, so the design goal is <em>bytes not read</em>. Ordering reads by inode or physical layout matters more than hash speed on spinning media; on NVMe, concurrency does.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>Abuse prevention:</b> the adversary is usually the filesystem itself. Files change mid‑scan, hardlinks make one inode look like many files, symlink races can redirect a write, and special files must never be read or replaced.</li>
    <li><b>Rate limiting:</b> I/O throttling and a concurrency cap so the tool cannot starve production workloads; a cap on files reclaimed per run so a bug has a bounded blast radius.</li>
    <li><b>Data sensitivity:</b> the catalog records paths and hashes, which together are an inventory of everything on the system — it needs the same protection as the data. Never log file contents, and treat the hash index as sensitive metadata rather than harmless bookkeeping.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Uptime target:</b> not a service; the requirement is that <b>no run may ever lose or corrupt a byte</b>. A dedup tool that is wrong once is a tool nobody is allowed to run again.</li>
    <li><b>Degraded mode:</b> file changed between hash and reclaim → skip it, do not act. Filesystem does not support reflinks → fall back to hardlinks, or to reporting only. Interrupted mid‑run → the catalog is a resumable journal, and every completed action has undo information.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Consistency:</b> there is no snapshot of a live filesystem, so every action re‑validates immediately before acting. The verification is the transaction; the hash is only a candidate filter.</li>
    <li><b>Durability:</b> the catalog must survive a crash so a rescan is incremental rather than a restart, and so undo information outlives the process that created it.</li>
    <li><b>Reversibility:</b> dry‑run by default, and every action recorded with enough information to undo it. This is the property that makes the tool usable at all — not a nice extra.</li></ul></div>
</div>

## Interface and algorithm {#file-dedupe-api}

<p>FileRecord (path, inode, dev, size, mtime, ctime, partialHash, fullHash, scannedAt) · DupGroup (hash, size, members[]) · Action (group, keeper, victims, mode: hardlink|reflink|contentstore, state, undo info) · Content store (hash → blob, refcount).</p>
<pre><code>scan(root) → for each file: stat; skip symlinks/special; key by (dev, inode) to ignore existing hardlinks
group by size (size&gt;0) → for groups &gt;1: hash first 64KB → regroup → full SHA-256 (streamed) → regroup
verify(group): for each victim, byte-compare against keeper OR re-hash at action time with mtime/size/ctime unchanged
act(group, mode, dry_run): keeper = oldest/most-linked; for victim: atomic replace (link tmp → rename over), record undo
undo(action): restore victim from keeper (copy) if link removed; verify hash</code></pre>

## Design {#file-dedupe-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/file-dedupe/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<figure>
<svg viewBox="0 0 980 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Dedupe pipeline: walker stats files, size grouping, partial hash, full hash, verification, reversible reclaim via hardlink/reflink or content store, with a catalog DB for incremental rescans and undo">
<defs><marker id="dg1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="dg3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.box{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.tb{font-size:12.5px;fill:#1B2430;font-weight:600}.ts{font-size:10.5px;fill:#5B6673}.f{stroke:#1F4E9E;stroke-width:1.6;fill:none;marker-end:url(#dg1)}.fa{stroke:#B45309;stroke-width:1.4;fill:none;marker-end:url(#dg3);stroke-dasharray:2 4}.lbl{font-size:10.5px;fill:#1F4E9E}</style>
<rect class="box" x="20" y="90" width="120" height="70"></rect><text class="tb" x="80" y="108" text-anchor="middle">Walker</text>
<text class="ts" x="80" y="124" text-anchor="middle">stat, skip links</text>
<text class="ts" x="80" y="137" text-anchor="middle">(dev, inode) dedupe</text>
<text class="ts" x="80" y="150" text-anchor="middle">bounded parallel I/O</text>
<rect class="box" x="170" y="90" width="120" height="70" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="230" y="108" text-anchor="middle">Size groups</text>
<text class="ts" x="230" y="124" text-anchor="middle">size == unique → skip</text>
<text class="ts" x="230" y="137" text-anchor="middle">free filter</text>
<rect class="box" x="320" y="90" width="130" height="70" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="385" y="108" text-anchor="middle">Partial hash</text>
<text class="ts" x="385" y="124" text-anchor="middle">first 64 KB</text>
<text class="ts" x="385" y="137" text-anchor="middle">cheap discriminator</text>
<rect class="box" x="480" y="90" width="130" height="70" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="545" y="108" text-anchor="middle">Full hash</text>
<text class="ts" x="545" y="124" text-anchor="middle">SHA-256 streamed</text>
<text class="ts" x="545" y="137" text-anchor="middle">only survivors</text>
<rect class="box" x="640" y="90" width="140" height="70" stroke="#B45309"></rect><text class="tb" x="710" y="108" text-anchor="middle">Verify + act</text>
<text class="ts" x="710" y="124" text-anchor="middle">recheck mtime/size/ctime</text>
<text class="ts" x="710" y="137" text-anchor="middle">byte-compare or rehash</text>
<text class="ts" x="710" y="150" text-anchor="middle">atomic link + rename</text>
<rect class="box" x="810" y="50" width="150" height="60" stroke="#0F766E" fill="#DDF3F0"></rect><text class="tb" x="885" y="68" text-anchor="middle">Catalog DB</text>
<text class="ts" x="885" y="84" text-anchor="middle">records, groups, actions</text>
<text class="ts" x="885" y="97" text-anchor="middle">undo info; incremental</text>
<rect class="box" x="810" y="130" width="150" height="60" stroke="#6B2D6B" fill="#F1E3F1"></rect><text class="tb" x="885" y="148" text-anchor="middle">Content store</text>
<text class="ts" x="885" y="164" text-anchor="middle">hash → blob, refcount</text>
<text class="ts" x="885" y="177" text-anchor="middle">(alt. to hardlinks)</text>
<line class="f" x1="140" y1="125" x2="168" y2="125"></line>
<line class="f" x1="290" y1="125" x2="318" y2="125"></line>
<line class="f" x1="450" y1="125" x2="478" y2="125"></line>
<line class="f" x1="610" y1="125" x2="638" y2="125"></line>
<line class="f" x1="780" y1="110" x2="808" y2="90"></line>
<text class="lbl" x="794" y="94" text-anchor="middle">log</text>
<line class="f" x1="780" y1="140" x2="808" y2="150"></line>
<text class="ts" x="20" y="180">Every stage shrinks the candidate set; the expensive full read happens only for files that survived two cheap filters.</text>
</svg>
</figure>

### Flow between components

<figure>
<svg viewBox="0 0 980 678" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Scan, verify, reclaim, undo">
<defs><marker id="sq1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1F4E9E"></path></marker><marker id="sq2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6B2D6B"></path></marker><marker id="sq3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#B45309"></path></marker></defs>
<style>.sb{fill:#fff;stroke:#1B2430;stroke-width:1.5;rx:6}.st{font-size:12px;fill:#1B2430;font-weight:600}.sl{font-size:10.5px;fill:#1B2430}.ln{stroke:#D6DDE5;stroke-width:1.5}.a1{stroke:#1F4E9E;stroke-width:1.5;fill:none;marker-end:url(#sq1)}.a2{stroke:#6B2D6B;stroke-width:1.5;fill:none;marker-end:url(#sq2);stroke-dasharray:5 4}.a3{stroke:#B45309;stroke-width:1.5;fill:none;marker-end:url(#sq3);stroke-dasharray:2 4}.nt{fill:#F6F8FA;stroke:#D6DDE5;rx:4}</style>
<rect class="sb" x="5" y="14" width="130" height="34"></rect><text class="st" x="70" y="36" text-anchor="middle">Operator</text>
<line class="ln" x1="70" y1="48" x2="70" y2="658"></line>
<rect class="sb" x="173" y="14" width="130" height="34"></rect><text class="st" x="238" y="36" text-anchor="middle">Walker</text>
<line class="ln" x1="238" y1="48" x2="238" y2="658"></line>
<rect class="sb" x="341" y="14" width="130" height="34"></rect><text class="st" x="406" y="36" text-anchor="middle">Hasher</text>
<line class="ln" x1="406" y1="48" x2="406" y2="658"></line>
<rect class="sb" x="509" y="14" width="130" height="34"></rect><text class="st" x="574" y="36" text-anchor="middle">Catalog</text>
<line class="ln" x1="574" y1="48" x2="574" y2="658"></line>
<rect class="sb" x="677" y="14" width="130" height="34"></rect><text class="st" x="742" y="36" text-anchor="middle">Reclaimer</text>
<line class="ln" x1="742" y1="48" x2="742" y2="658"></line>
<rect class="sb" x="845" y="14" width="130" height="34"></rect><text class="st" x="910" y="36" text-anchor="middle">Filesystem</text>
<line class="ln" x1="910" y1="48" x2="910" y2="658"></line>
<line class="a1" x1="78" y1="80" x2="230" y2="80"></line>
<text class="sl" x="154" y="74" text-anchor="middle">scan /data (exclude tmp/)</text>
<line class="a1" x1="246" y1="114" x2="902" y2="114"></line>
<text class="sl" x="574" y="108" text-anchor="middle">stat each entry</text>
<rect class="nt" x="128" y="135" width="220" height="22"></rect><text class="sl" x="238" y="150" text-anchor="middle">skip symlinks, sockets; hardlinks by (dev,inode)</text>
<line class="a1" x1="246" y1="182" x2="566" y2="182"></line>
<text class="sl" x="406" y="176" text-anchor="middle">upsert records; unchanged (size,mtime,ctime) → reuse hashes</text>
<line class="a1" x1="566" y1="216" x2="414" y2="216"></line>
<text class="sl" x="490" y="210" text-anchor="middle">size groups &gt; 1</text>
<line class="a1" x1="414" y1="250" x2="902" y2="250"></line>
<text class="sl" x="658" y="244" text-anchor="middle">read 64 KB → partial hash</text>
<line class="a1" x1="414" y1="284" x2="902" y2="284"></line>
<text class="sl" x="658" y="278" text-anchor="middle">full SHA-256 for remaining</text>
<line class="a1" x1="414" y1="318" x2="566" y2="318"></line>
<text class="sl" x="490" y="312" text-anchor="middle">dup groups</text>
<line class="a1" x1="78" y1="352" x2="566" y2="352"></line>
<text class="sl" x="322" y="346" text-anchor="middle">report: 1.2M groups, 8 TB reclaimable (dry run)</text>
<line class="a1" x1="78" y1="386" x2="734" y2="386"></line>
<text class="sl" x="406" y="380" text-anchor="middle">act --mode=reflink</text>
<line class="a1" x1="750" y1="420" x2="902" y2="420"></line>
<text class="sl" x="826" y="414" text-anchor="middle">for each victim: stat again; changed? → skip</text>
<line class="a1" x1="750" y1="454" x2="902" y2="454"></line>
<text class="sl" x="826" y="448" text-anchor="middle">byte-compare victim vs keeper (or rehash)</text>
<line class="a1" x1="750" y1="488" x2="902" y2="488"></line>
<text class="sl" x="826" y="482" text-anchor="middle">link keeper → victim.tmp; rename over victim (atomic)</text>
<line class="a1" x1="734" y1="522" x2="582" y2="522"></line>
<text class="sl" x="658" y="516" text-anchor="middle">action DONE + undo info</text>
<line class="a1" x1="78" y1="556" x2="734" y2="556"></line>
<text class="sl" x="406" y="550" text-anchor="middle">undo action 42</text>
<line class="a1" x1="750" y1="590" x2="902" y2="590"></line>
<text class="sl" x="826" y="584" text-anchor="middle">copy keeper → victim path if needed; verify hash</text>
<line class="a3" x1="246" y1="624" x2="566" y2="624"></line>
<text class="sl" x="406" y="618" text-anchor="middle">next rescan: only changed files rehashed</text>
</svg>
<figcaption>Solid = request path · dashed = response / return · dotted = async or background.</figcaption>
</figure>
<ol class="order">
  <li><b>Operator → Walker:</b> scan /data (exclude tmp/).
    Exclusions are part of the interface because some trees must never be touched — build caches, live databases, anything whose files change constantly.
    The run is a dry run by default: reporting is safe, reclaiming is the deliberate second step.</li>
  <li><b>Walker → Filesystem:</b> stat each entry.
    <code>stat</code> is nearly free and yields size, inode, device, mtime and type — enough to eliminate the overwhelming majority of files before a single byte is read.
    Reading file contents to decide whether to read file contents is the mistake this step exists to avoid.</li>
  <li><b>Walker:</b> skip symlinks, sockets; hardlinks by (dev,inode).
    Symlinks are skipped rather than followed, because following them walks outside the tree and can be redirected between check and use.
    Hardlinks are identified by (device, inode): several paths sharing one inode are already deduplicated, and "reclaiming" them would free nothing while risking real damage.
    Special files — devices, sockets, FIFOs — must never be read or replaced, and treating them as ordinary files is how a scan hangs on a FIFO.</li>
  <li><b>Walker → Catalog:</b> upsert records; unchanged (size,mtime,ctime) → reuse hashes.
    The catalog turns a full rescan into an incremental one — the difference between hours and minutes on a tree that mostly did not change.
    <code>ctime</code> is included alongside <code>mtime</code> because <code>mtime</code> can be set backwards by a program, while <code>ctime</code> cannot be forged as easily.
    This is a cache of an expensive computation, and like every cache its invalidation rule is where the bugs live.</li>
  <li><b>Catalog → Hasher:</b> size groups &gt; 1.
    Files with unique sizes cannot be duplicates, so they leave the pipeline having cost one <code>stat</code> each.
    On a typical tree this eliminates 90%+ of candidates for free — the single highest‑value filter in the design.</li>
  <li><b>Hasher → Filesystem:</b> read 64 KB → partial hash.
    Most same‑size files differ in their first few kilobytes — different headers, different first record — so a partial hash splits groups at a fraction of the read cost.
    64 KB is the practical balance: large enough to differentiate, small enough that reading it costs about the same as seeking to it.</li>
  <li><b>Hasher → Filesystem:</b> full SHA-256 for remaining.
    Only survivors of both filters are read in full, so petabytes of scanning becomes a few percent of actual reads.
    A cryptographic hash rather than a fast one is chosen deliberately: an adversarial or unlucky collision here means deleting a file that was not a duplicate.</li>
  <li><b>Hasher → Catalog:</b> dup groups.
    Groups are candidates, not conclusions — the hash is evidence, and the verification before acting is what makes it a decision.</li>
  <li><b>Operator → Catalog:</b> report: 1.2M groups, 8 TB reclaimable (dry run).
    Reporting is the default output, and it is where the operator decides whether the savings justify touching anything.
    Making the destructive step opt‑in rather than opt‑out is most of what makes this tool safe to adopt.</li>
  <li><b>Operator → Reclaimer:</b> act --mode=reflink.
    Reflinks are the best option where supported: copy‑on‑write means the files stay independent, so later modifying one does not affect the other.
    Hardlinks save the same space but silently couple the files — editing one changes both, which is a data‑loss bug that surfaces weeks later.
    Naming the mode explicitly forces that choice to be conscious rather than a default nobody examined.</li>
  <li><b>Reclaimer → Filesystem:</b> for each victim: stat again; changed? → skip.
    The hash was computed at some point in the past, and on a live filesystem the past is not evidence about the present.
    Re‑stat immediately before acting closes most of the time‑of‑check‑to‑time‑of‑use window, and any change at all means skip rather than investigate.</li>
  <li><b>Reclaimer → Filesystem:</b> byte-compare victim vs keeper (or rehash).
    Before anything destructive, the files are compared directly — this is the last line of defence and it is worth the I/O.
    It covers the hash collision case, the file‑changed‑since‑hashing case, and the catalog‑is‑stale case in one step.
    Skipping this because "SHA‑256 collisions are impossible" is exactly the reasoning that makes a dedup tool untrustworthy.</li>
  <li><b>Reclaimer → Filesystem:</b> link keeper → victim.tmp; rename over victim (atomic).
    Create the replacement under a temporary name, then <code>rename</code> over the original — rename is atomic, so at no instant does the path fail to exist.
    A delete‑then‑link sequence has a window in which the file is simply gone, and a crash inside that window is permanent data loss.
    Operating on a file descriptor opened earlier, rather than re‑resolving the path, also closes the symlink race.</li>
  <li><b>Reclaimer → Catalog:</b> action DONE + undo info.
    Every action is journalled with what was replaced, by what, and how to reverse it — written before the next action begins.
    An interrupted run is therefore resumable and reversible rather than leaving the tree in an unknown state.</li>
  <li><b>Operator → Reclaimer:</b> undo action 42.
    Undo is a first‑class operation, not a recovery procedure, which is what allows a cautious operator to try the tool at all.
    It is also the honest answer to "what if you are wrong?" — a question this tool must be able to answer.</li>
  <li><b>Reclaimer → Filesystem:</b> copy keeper → victim path if needed; verify hash.
    Restoration copies the content back and verifies it against the recorded hash, so undo is itself verified rather than assumed.
    Same atomic rename discipline on the way back, because the reverse operation deserves the same care as the forward one.</li>
  <li><b>Walker → Catalog:</b> next rescan: only changed files rehashed (async).
    Steady state is cheap: <code>stat</code> everything, rehash the few files that changed, and reuse everything else.
    This is what turns dedup from an occasional expensive event into a routine background job — and the catalog is what makes it possible.</li>
</ol>

## Deep dives {#file-dedupe-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/file-dedupe/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
<div><h4>Hashing correctly</h4><ul><li>Use a cryptographic hash (SHA‑256/BLAKE3) so accidental collisions are impossible in practice; still verify before destructive action when data matters (byte‑compare is cheap relative to the deletion risk).</li><li>Stream hashes in chunks; parallelize across files, not within one file on spinning disks; bound concurrency per device.</li><li>Partial hash on head only can be fooled by files with identical headers (media containers); use head + tail or a middle sample.</li></ul></div>
<div><h4>Races and filesystem semantics</h4><ul><li>TOCTOU: a file can change between hash and action. Re‑stat (size, mtime, ctime, inode) immediately before acting and compare; if changed, skip. Hold the file open and hash the same fd you act on where possible.</li><li>Existing hardlinks look like duplicates but aren't: key on (dev, inode). Cross‑device links are impossible; use copy‑to‑content‑store there.</li><li>Reflinks (Btrfs/XFS/APFS) share blocks copy‑on‑write and are safer than hardlinks (edits don't propagate). Hardlinks change semantics: an edit to one path edits all. Say which you'd use and why.</li><li>Atomicity: create link at temp name, then rename over the victim; rename is atomic on the same filesystem. Preserve metadata (mode, owner, xattrs) or document what changes.</li></ul></div>
<div><h4>Safety and scale</h4><ul><li>Dry‑run by default; actions logged with undo info; undo restores content from keeper. Never delete without a keeper that verified.</li><li>Corruption: verify checksums on read; if keeper is corrupt, pick a different keeper; store expected hash in the catalog for later scrubbing.</li><li>Incremental: catalog keyed by path + inode with (size, mtime, ctime) so unchanged files skip hashing; use inotify/fsevents for continuous mode.</li><li>Object stores: dedupe by content hash at upload (see CloudDrive); refcount before deleting a blob.</li></ul></div></div>


## Trade-offs {#file-dedupe-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Candidate filtering</td><td>Size → partial hash → full hash → byte compare</td><td>Four stages of code instead of one</td><td>Hashing everything is one line and reads the entire filesystem for nothing; the cascade is the whole performance story</td></tr>
  <tr><td>Hash choice</td><td>SHA‑256</td><td>Slower than xxHash or BLAKE by a meaningful factor</td><td>A fast hash is fine as a <em>filter</em>; as the basis for deletion it is not, unless a byte compare always follows</td></tr>
  <tr><td>Reclaim mechanism</td><td>Reflinks where available</td><td>Filesystem support required (XFS, Btrfs, APFS)</td><td>Hardlinks work everywhere but couple the files — editing one changes both, which is a data‑loss bug waiting to happen</td></tr>
  <tr><td>Verification</td><td>Byte compare immediately before acting</td><td>Reading both files again at reclaim time</td><td>Never skip it: it covers collisions, stale catalog entries and mid‑scan modifications in one cheap step</td></tr>
  <tr><td>Change detection</td><td>(size, mtime, ctime) in a durable catalog</td><td>A catalog to store, protect and invalidate correctly</td><td>Rehashing everything is simpler and correct but makes every rescan a full‑filesystem read</td></tr>
  <tr><td>Default mode</td><td>Dry run; acting is explicit</td><td>Two steps for the operator instead of one</td><td>Never default to destructive — the first run of a dedup tool should not be able to lose data</td></tr>
  <tr><td>Concurrent modification</td><td>Skip anything that changed</td><td>Some duplicates are missed each run</td><td>Locking a live filesystem is not available; missing a duplicate costs space, acting on a changed file costs data</td></tr>
</tbody></table>

## Safety-first design {#file-dedupe-safety}

<div class="cards">
  <div><h4>The filesystem is changing under you</h4><ul>
    <li><b>Re‑validate immediately before acting.</b> A hash computed an hour ago is a hypothesis about the past, not a fact about now.</li>
    <li><b>Byte compare is the transaction.</b> The hash narrows candidates; the comparison is what authorises destruction.</li>
    <li><b>Any change means skip.</b> A file modified mid‑run is left alone entirely — missing a duplicate costs disk space, acting on a changed file costs data.</li>
    <li><b>Act on descriptors, not paths.</b> Re‑resolving a path between check and use is the symlink race; holding the descriptor closes it.</li></ul></div>
  <div><h4>Every destructive step is reversible</h4><ul>
    <li><b>Atomic rename, never delete‑then‑create.</b> The path always resolves to a valid file, so a crash mid‑operation cannot leave a hole.</li>
    <li><b>Journal before you act.</b> Undo information is durable before the change, so an interrupted run is resumable and reversible rather than unknown.</li>
    <li><b>Undo is verified too.</b> Restoration checks the recovered content against the recorded hash instead of assuming the copy worked.</li>
    <li><b>Dry run first, always.</b> Reporting is the default; reclaiming requires an explicit mode, so the tool cannot surprise anyone on first use.</li></ul></div>
  <div><h4>Respect what is not an ordinary file</h4><ul>
    <li><b>Hardlinks are already deduplicated.</b> Multiple paths to one inode free nothing if "deduplicated" — recognising (device, inode) prevents pointless and risky work.</li>
    <li><b>Never follow symlinks.</b> Following them walks outside the scanned tree and opens a redirection window between check and use.</li>
    <li><b>Skip special files.</b> Devices, sockets and FIFOs must not be read or replaced; treating a FIFO as a regular file is how a scan hangs forever.</li>
    <li><b>Preserve metadata.</b> Permissions, ownership and timestamps survive the replacement, or the tool has changed something the operator did not agree to.</li></ul></div>
</div>

## Don't leave the room without saying {#file-dedupe-check}

<ul class="checklist">
  <li>Size → partial hash → full hash → verify; read the minimum</li>
  <li>Cryptographic hash, verify before destructive action</li>
  <li>Re‑stat before act; skip if changed; hash the fd you act on</li>
  <li>(dev, inode) to ignore existing hardlinks; reflink vs hardlink semantics</li>
  <li>Atomic link + rename; preserve metadata; dry‑run and undo</li>
  <li>Catalog for incremental rescans; refcounts in a content store</li>
</ul>

## What each level is expected to drive {#file-dedupe-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Hash all files, group, delete duplicates with a keeper</td><td>Size filter, races, undo</td></tr>
  <tr><td>Senior</td><td>Staged filtering, streaming hashes with bounded I/O, TOCTOU handling, reflink/hardlink trade‑off, atomic replace, dry‑run/undo, incremental catalog</td><td>Content store with refcounts</td></tr>
  <tr><td>Staff+</td><td>Formal safety argument for the reclaim step, filesystem‑specific behaviors, corruption scrubbing, scaling to PBs with device‑aware parallelism, continuous mode</td><td>—</td></tr>
</tbody></table>
