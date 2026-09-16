---
title: "Robust file deduplication"
slug: /system-design-notes/file-dedupe
sidebar_position: 36
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
  <li><b>Operator → Walker:</b> scan /data (exclude tmp/)</li>
  <li><b>Walker → Filesystem:</b> stat each entry</li>
  <li><b>Walker:</b> skip symlinks, sockets; hardlinks by (dev,inode)</li>
  <li><b>Walker → Catalog:</b> upsert records; unchanged (size,mtime,ctime) → reuse hashes</li>
  <li><b>Catalog → Hasher:</b> size groups &gt; 1</li>
  <li><b>Hasher → Filesystem:</b> read 64 KB → partial hash</li>
  <li><b>Hasher → Filesystem:</b> full SHA-256 for remaining</li>
  <li><b>Hasher → Catalog:</b> dup groups</li>
  <li><b>Operator → Catalog:</b> report: 1.2M groups, 8 TB reclaimable (dry run)</li>
  <li><b>Operator → Reclaimer:</b> act --mode=reflink</li>
  <li><b>Reclaimer → Filesystem:</b> for each victim: stat again; changed? → skip</li>
  <li><b>Reclaimer → Filesystem:</b> byte-compare victim vs keeper (or rehash)</li>
  <li><b>Reclaimer → Filesystem:</b> link keeper → victim.tmp; rename over victim (atomic)</li>
  <li><b>Reclaimer → Catalog:</b> action DONE + undo info</li>
  <li><b>Operator → Reclaimer:</b> undo action 42</li>
  <li><b>Reclaimer → Filesystem:</b> copy keeper → victim path if needed; verify hash</li>
  <li><b>Walker → Catalog:</b> next rescan: only changed files rehashed (async)</li>
</ol>

## Deep dives {#file-dedupe-deep}

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/file-dedupe/deep-dive.svg" alt="Deep dive" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<div class="cards">
<div><h4>Hashing correctly</h4><ul><li>Use a cryptographic hash (SHA‑256/BLAKE3) so accidental collisions are impossible in practice; still verify before destructive action when data matters (byte‑compare is cheap relative to the deletion risk).</li><li>Stream hashes in chunks; parallelize across files, not within one file on spinning disks; bound concurrency per device.</li><li>Partial hash on head only can be fooled by files with identical headers (media containers); use head + tail or a middle sample.</li></ul></div>
<div><h4>Races and filesystem semantics</h4><ul><li>TOCTOU: a file can change between hash and action. Re‑stat (size, mtime, ctime, inode) immediately before acting and compare; if changed, skip. Hold the file open and hash the same fd you act on where possible.</li><li>Existing hardlinks look like duplicates but aren't: key on (dev, inode). Cross‑device links are impossible; use copy‑to‑content‑store there.</li><li>Reflinks (Btrfs/XFS/APFS) share blocks copy‑on‑write and are safer than hardlinks (edits don't propagate). Hardlinks change semantics: an edit to one path edits all. Say which you'd use and why.</li><li>Atomicity: create link at temp name, then rename over the victim; rename is atomic on the same filesystem. Preserve metadata (mode, owner, xattrs) or document what changes.</li></ul></div>
<div><h4>Safety and scale</h4><ul><li>Dry‑run by default; actions logged with undo info; undo restores content from keeper. Never delete without a keeper that verified.</li><li>Corruption: verify checksums on read; if keeper is corrupt, pick a different keeper; store expected hash in the catalog for later scrubbing.</li><li>Incremental: catalog keyed by path + inode with (size, mtime, ctime) so unchanged files skip hashing; use inotify/fsevents for continuous mode.</li><li>Object stores: dedupe by content hash at upload (see CloudDrive); refcount before deleting a blob.</li></ul></div></div>

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
