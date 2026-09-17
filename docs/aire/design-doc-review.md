---
title: "Review and improve a flawed design document"
slug: /aire/design-doc-review
sidebar_position: 48
sidebar_label: "Review and improve a flawed design docum…"
description: "hard · Anthropic · senior+ · find the unsafe assumptions · rank by blast radius · write the review"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/design-doc-review/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

## How it works

<header>
  
  <span class="tag">hard · Anthropic · senior+ · find the unsafe assumptions · rank by blast radius · write the review</span>
</header>
<p>You are handed a design document with important omissions and unsafe assumptions, and asked to review it. This is a senior‑and‑above question because it tests judgment rather than recall: can you find what is missing (harder than critiquing what is present), rank findings by consequence rather than by how obvious they are, and deliver the review in a way that improves the design instead of just scoring points on its author.</p>

## Requirements {#ddr-req}

<div class="board">
  <div>
    <h4>Functional</h4>
    <ol>
      <li>Identify the unstated assumptions, not just the stated mistakes</li>
      <li>Rank findings by blast radius and reversibility, not by how easy they were to spot</li>
      <li>Propose concrete alternatives, with their trade‑offs</li>
      <li>Deliver it so the author can act on it and still wants to</li>
      <li class="out">Rewriting the design yourself, litigating style preferences</li>
    </ol>
  </div>
  <div>
    <h4>Non‑functional</h4>
    <ol>
      <li>Every finding is falsifiable: a specific scenario where the design fails</li>
      <li>Distinguish blocking issues from improvements from questions</li>
      <li>Cover safety, failure modes and operability, not only the happy path</li>
      <li>Timeboxed — a review that arrives after the code is written is documentation</li>
    </ol>
  </div>
</div>
<div class="note"><b>The core skill:</b> critiquing what is written is easy; noticing what is absent is the job. A design document rarely says "we have not thought about what happens when this dependency is slow" — it simply never mentions it. So the review runs a checklist against the document rather than reading it linearly, because a linear read only surfaces what the author already thought about.</div>

## Scale, performance and safety targets {#ddr-targets}

<div class="cards">
  <div><h4>Scale</h4><ul>
    <li><b>Work per review:</b> a 10–30 page document covering a system meant to run for years. Two to four hours of focused reading is the realistic budget, which is why a checklist beats an open‑ended read.</li>
    <li><b>Findings volume:</b> expect 20–40 observations and deliver 5–10. A review with forty equally weighted comments is indistinguishable from no review, because the author cannot tell what matters.</li>
    <li><b>Growth:</b> the cost of a missed assumption grows with how much is built on it — roughly an order of magnitude per phase, from design to implementation to production. That ratio is the entire justification for spending hours here.</li></ul></div>
  <div><h4>Performance</h4><ul>
    <li><b>Latency:</b> return the review within a day or two. A review that arrives after implementation has started is no longer a review; it is a change request, and it will be resisted for good reasons.</li>
    <li><b>Throughput:</b> the measure is findings that change the design per hour spent. Three blocking issues the author acts on beat thirty comments they skim and dismiss.</li></ul></div>
  <div><h4>Safety and security</h4><ul>
    <li><b>What gets missed most:</b> failure modes of dependencies, the behaviour of the system when it is overloaded rather than when it is healthy, data deletion and retention, blast radius of a bad deploy, and what an attacker or a careless internal user could do with the interface as designed.</li>
    <li><b>Unsafe assumptions to hunt:</b> "the database will be fast enough", "this call won't fail", "we'll add monitoring later", "users won't do that", "we can migrate afterwards", "the queue won't back up" — each is a load‑bearing claim presented as background.</li>
    <li><b>Data handling:</b> check whether the document says where sensitive data lives, how long it stays, who can read it, and how deletion propagates to derived copies. Its absence is one of the most common and most expensive omissions.</li></ul></div>
  <div><h4>Availability and fault tolerance</h4><ul>
    <li><b>Reviewing the failure story:</b> for every dependency, ask what happens when it is slow (not just down), what the caller does, and whether that behaviour was chosen or inherited. Most documents describe the happy path only.</li>
    <li><b>Degraded mode:</b> a design without a stated degraded mode has one anyway — usually "fail everything" — and nobody chose it. Making that explicit is often the single highest‑value finding in a review.</li></ul></div>
  <div><h4>Also worth pinning down</h4><ul>
    <li><b>Reversibility:</b> rank findings by how hard they are to change later. A wrong data model is expensive for years; a wrong retry policy is a config change. Spend your influence on the irreversible ones.</li>
    <li><b>Falsifiability:</b> "this won't scale" is an opinion; "at 10K QPS this single counter row serialises every write, and you said peak is 30K" is a finding. Every item should name a scenario.</li>
    <li><b>Tone as a technical requirement:</b> a correct review the author dismisses has zero value. Separating blocking issues from suggestions and questions is what makes it actionable rather than adversarial.</li></ul></div>
</div>

## Entities and API {#ddr-api}

<p>Finding (severity, claim, scenario, suggestion) · Severity (BLOCKING | SHOULD‑FIX | CONSIDER | QUESTION) · Assumption (stated | unstated | load‑bearing) · Checklist (dimension → questions) · Review (summary, findings[], what‑is‑good).</p>
<pre><code>Checklist dimensions, run against the document rather than read linearly:
  Requirements   are scale, latency, growth and consistency stated as numbers?
  Data model     what is the source of truth? what is derived? what is the access pattern?
  Failure        for each dependency: slow? down? partial? what does the caller do?
  Overload       what happens above capacity - shed, queue, or fall over?
  Safety         abuse vectors, rate limits, blast radius of a bad deploy or bad data
  Data lifecycle where does sensitive data live, for how long, who reads it, how is it deleted?
  Operability    how is it monitored, how is it rolled back, how is it debugged at 3am?
  Migration      how does it get from today's system to this one, incrementally?

Finding format:  [BLOCKING] <claim> - <concrete failing scenario> - <suggested alternative + its cost></code></pre>

## Design {#ddr-design}

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/design-doc-review/architecture.svg" alt="Architecture" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

### Flow between components

<ol class="order">
  <li><b>Reviewer → Document:</b> first pass — read for intent, not for errors.
    The first read is to understand what problem is being solved and what the author believes about it, without stopping to note issues.
    Reviewing while first reading anchors you on early details and makes you miss structural problems entirely.
    By the end of this pass you should be able to state the design's central bet in one sentence — and if you cannot, that is itself the first finding.</li>
  <li><b>Reviewer → Requirements section:</b> are the numbers there, and are they numbers?
    Check for QPS, data volume, growth, latency targets, availability and consistency — stated as figures rather than adjectives.
    A design without numbers cannot be evaluated, because every choice is defensible in the absence of a target; this is the most common and most upstream omission.
    If they are absent, that is usually the top finding, since every other judgement depends on it.</li>
  <li><b>Reviewer → Checklist:</b> run dimensions against the document rather than reading linearly.
    This is the mechanical core of the method: a linear read finds errors in what the author wrote, while a checklist finds the sections the author never wrote.
    Absence is invisible to a linear read — nobody notices a missing paragraph about dependency timeouts, because there is nothing there to notice.
    Working through fixed dimensions turns "what's missing?" from an act of inspiration into a process that reliably terminates.</li>
  <li><b>Reviewer → Data model:</b> identify the source of truth and what is derived.
    Ask which store is authoritative, what can be rebuilt from it, and what would be unrecoverable if lost.
    Designs that cannot answer this usually have two sources of truth that will diverge, which is among the most expensive and least reversible problems available.
    Check the access patterns against the schema too — a data model that does not match the queries is a rewrite later, not a tweak.</li>
  <li><b>Reviewer → Dependencies:</b> for each one, ask slow / down / partial.
    "Down" is usually considered; "slow" almost never is, and slow is the more common and more damaging failure.
    For each dependency the document should say what the caller does — timeout, retry with what policy, fall back to what, or fail with what error.
    A retry policy without backoff, jitter and a budget is a finding every time, because it turns a dependency's bad minute into an outage.</li>
  <li><b>Reviewer → Overload behaviour:</b> what happens above capacity?
    Every system has a behaviour above capacity; the question is only whether it was chosen. The default — accept everything and collapse — is chosen by omission.
    Look for admission control, shedding, queue bounds and back‑pressure. Unbounded queues are a recurring finding because they convert a latency problem into a memory problem and then a crash.
    If the document says "we'll autoscale", check whether the scaling is faster than the traffic and what happens in the minutes before it arrives.</li>
  <li><b>Reviewer → Safety and abuse:</b> what can a hostile or careless user do?
    Ask what the most expensive request is and whether anything bounds it; what a single tenant can do to everyone else; and what an internal mistake — a bad config, a bad deploy, a bad backfill — can reach.
    Blast radius is the frame: not "will this happen" but "how much does it cost when it does".
    Rate limits, quotas and isolation boundaries are the usual missing pieces, and their absence is rarely deliberate.</li>
  <li><b>Reviewer → Data lifecycle:</b> where does sensitive data live, and how does it leave?
    Trace it through every store, cache, log, index, backup and derived artifact, then ask how deletion reaches all of them.
    This is one of the most commonly omitted sections and among the more expensive to retrofit, because by then the copies already exist.
    Retention stated as a number, and a deletion path that covers derivatives, is what you are looking for.</li>
  <li><b>Reviewer → Operability:</b> how is this monitored, rolled back and debugged?
    "We'll add monitoring later" means the first incident will be diagnosed with no data, so the specific signals belong in the design.
    Ask how a bad version is reverted, how long that takes, and whether anything — a schema change, a data migration — makes it one‑way.
    A design that cannot be rolled back has converted every deploy into a permanent decision, which is worth raising as blocking.</li>
  <li><b>Reviewer → Migration:</b> how do we get there from what exists today?
    Many documents describe a destination and skip the journey, and the journey is usually where the real risk lives.
    Ask whether it can be done incrementally, whether both systems run in parallel, how data is backfilled, and what the rollback looks like at each step.
    A migration that must happen atomically is a finding in itself, because atomic cutovers are where the outages are.</li>
  <li><b>Reviewer:</b> rank by blast radius × reversibility.
    Now that the findings exist, they must be ordered by consequence rather than by the order they were found or how clever they make you look.
    A data‑model flaw is expensive for years; a retry policy is a config change. Spend your credibility on the irreversible ones.
    Deliberately drop the merely stylistic findings — including them dilutes the ones that matter and trains the author to skim.</li>
  <li><b>Reviewer:</b> make each finding falsifiable — claim, scenario, suggestion.
    "This won't scale" invites argument; "at 30K QPS peak, this single counter row serialises every write, so throughput caps around 2K/s" invites a fix.
    Each finding names a concrete failing scenario and proposes an alternative <em>with its cost</em>, because a suggestion without a trade‑off is not engineering advice.
    Findings you are unsure about go in as questions rather than assertions — being wrong loudly costs more than being wrong quietly.</li>
  <li><b>Reviewer → Author:</b> deliver with severities separated, and say what is good.
    BLOCKING, SHOULD‑FIX, CONSIDER and QUESTION let the author triage instead of treating forty comments as equally urgent.
    Naming what is genuinely good is not politeness — it tells the author which parts not to change while fixing the rest, which is information they do not otherwise have.
    A correct review that the author dismisses has zero value, so tone is a technical requirement rather than a courtesy.</li>
  <li><b>Author → Reviewer:</b> disagreement is data — where the design was misread, the document is unclear.
    If the author explains that a finding rests on a misreading, the document needs a sentence; the next reader will misread it the same way.
    Reviews that end in agreement on every point usually mean the reviewer was not looking hard enough or the author was not listening.
    The deliverable is a better design, not a won argument — and revisiting the blocking items after revision is part of the job.</li>
</ol>

## How it works, step by step {#ddr-flow}

<ol class="order">
  <li>Read once for intent, without noting issues, until you can state the design's central bet in a sentence.</li>
  <li>Check whether requirements exist as numbers; if not, that is usually the top finding because everything else depends on them.</li>
  <li>Run a fixed checklist against the document — data model, dependencies, overload, safety, data lifecycle, operability, migration — rather than reading linearly, because absence is invisible to a linear read.</li>
  <li>For each dependency ask slow / down / partial, and for the system ask what it does above capacity.</li>
  <li>Rank findings by blast radius and reversibility, then cut the list to the handful that will actually change the design.</li>
  <li>Write each as claim + concrete failing scenario + alternative with its cost, separate severities, and say what is good.</li>
</ol>

## Deep dives {#ddr-deep}

<div class="cards">
  <div><h4>Unsafe assumptions to hunt for</h4><ul>
    <li><b>"It'll be fast enough."</b> No number, no measurement, and usually a synchronous call inside a latency budget that cannot hold it.</li>
    <li><b>"This call won't fail."</b> Every network call fails; the question is only what the caller does when it does.</li>
    <li><b>"We'll add monitoring later."</b> Guarantees the first incident is debugged blind, and later never has a deadline.</li>
    <li><b>"Users won't do that."</b> They will, and a hostile one will do it deliberately and repeatedly.</li>
    <li><b>"We can migrate afterwards."</b> Data model and migration are the least reversible parts of any design.</li></ul></div>
  <div><h4>Absence is harder than error</h4><ul>
    <li>A linear read finds mistakes in what was written; only a checklist finds the section that was never written.</li>
    <li>Nobody notices a missing paragraph — there is nothing on the page to react to.</li>
    <li>Fixed dimensions turn "what's missing?" from inspiration into a process that reliably terminates.</li>
    <li>The most commonly absent sections: overload behaviour, dependency slowness, data lifecycle, rollback, and the migration path.</li></ul></div>
  <div><h4>Making a review land</h4><ul>
    <li>Rank by blast radius × reversibility, not by discovery order or cleverness.</li>
    <li>Five findings the author acts on beat forty they skim; cutting the list is part of the work.</li>
    <li>Claim + scenario + alternative with its cost — a suggestion with no trade‑off is not engineering advice.</li>
    <li>Separate severities and say what is good, so the author knows what to keep while fixing the rest.</li></ul></div>
</div>

## Trade-offs {#ddr-tradeoffs}

<table>
  <tbody><tr><th>Decision</th><th>What we chose</th><th>What we gave up</th><th>When to flip it</th></tr>
  <tr><td>Reading method</td><td>Checklist against the document</td><td>The narrative flow of a linear read</td><td>Linear reading is fine for a short document and systematically misses everything the author never considered</td></tr>
  <tr><td>Finding count</td><td>Cut to 5–10 that matter</td><td>Completeness — real issues go unmentioned</td><td>Deliver everything only when the author explicitly wants exhaustive coverage; otherwise volume destroys signal</td></tr>
  <tr><td>Ranking</td><td>Blast radius × reversibility</td><td>Easy, obvious findings lose their prominence</td><td>Never rank by ease of spotting — that optimises for the reviewer looking thorough rather than for the design improving</td></tr>
  <tr><td>Certainty</td><td>Assertions for what you can demonstrate, questions for the rest</td><td>A less confident‑sounding review</td><td>Asserting something you cannot support costs credibility on every finding, including the correct ones</td></tr>
  <tr><td>Scope</td><td>Design‑level issues only</td><td>Style, naming and formatting go unmentioned</td><td>Style comments belong in code review; in a design review they dilute the findings that matter</td></tr>
  <tr><td>Alternatives</td><td>Propose one, with its cost</td><td>The author's ownership of the solution</td><td>Naming a problem without a direction is often unhelpful; prescribing in detail removes the author's judgment — suggest, do not design</td></tr>
  <tr><td>Timing</td><td>Return within a day or two</td><td>Depth of analysis</td><td>A deeper review delivered after implementation starts is a change request, and will be resisted for good reasons</td></tr>
</tbody></table>

## Safety-first design {#ddr-safety}

<div class="cards">
  <div><h4>Review the failure path, not the happy path</h4><ul>
    <li><b>Slow, not just down.</b> Partial degradation is more common and more damaging than clean failure, and is almost never in the document.</li>
    <li><b>Behaviour above capacity is always chosen.</b> If the document does not choose it, the default is "accept everything and collapse".</li>
    <li><b>Unbounded queues are a finding every time.</b> They convert a latency problem into a memory problem and then into a crash.</li>
    <li><b>Retries need backoff, jitter and a budget.</b> Without all three they amplify the incident that triggered them.</li></ul></div>
  <div><h4>Follow the data all the way</h4><ul>
    <li><b>Name the source of truth.</b> Two authoritative stores will diverge, and that is among the least reversible mistakes available.</li>
    <li><b>Trace sensitive data into every copy.</b> Caches, logs, indexes, backups and derived artifacts all count.</li>
    <li><b>Deletion must reach the derivatives.</b> A delete path that stops at the primary store is not a delete path.</li>
    <li><b>Retention as a number.</b> "As long as needed" is not a policy and cannot be implemented.</li></ul></div>
  <div><h4>A review is only useful if it is used</h4><ul>
    <li><b>Falsifiable findings.</b> A concrete failing scenario converts an argument about opinions into a question with an answer.</li>
    <li><b>Severities separated.</b> Blocking, should‑fix, consider and question, so the author can triage rather than skim.</li>
    <li><b>Say what is good.</b> It tells the author which parts to keep while changing the rest — information they cannot get otherwise.</li>
    <li><b>Disagreement is a documentation bug.</b> If the author says you misread it, the next reader will too, and the document needs a sentence.</li></ul></div>
</div>

## Don't leave the room without saying {#ddr-check}

<ul class="checklist">
  <li>Read for intent first; state the design's central bet in one sentence before critiquing anything</li>
  <li>Requirements as numbers — without them no choice in the document can be evaluated</li>
  <li>Run a checklist, not a linear read, because absence is invisible when you read straight through</li>
  <li>For every dependency: slow, down, partial — and what the caller does in each case</li>
  <li>What happens above capacity is always chosen; by omission it is "collapse"</li>
  <li>Data lifecycle: source of truth, every copy, retention as a number, deletion that reaches derivatives</li>
  <li>Rank by blast radius × reversibility; cut to the handful that will change the design</li>
  <li>Claim + scenario + alternative with its cost; separate severities; say what is good</li>
</ul>

## What each level is expected to drive {#ddr-levels}

<table>
  <tbody><tr><th>Level</th><th>Unprompted</th><th>OK if guided</th></tr>
  <tr><td>Mid</td><td>Spot concrete technical errors in what is written; ask for missing numbers</td><td>Finding omissions, ranking by consequence</td></tr>
  <tr><td>Senior</td><td>Checklist‑driven review, dependency failure analysis, overload behaviour, falsifiable findings with alternatives, severity separation</td><td>Data lifecycle, migration risk, reversibility ranking</td></tr>
  <tr><td>Staff+</td><td>Identifying the load‑bearing unstated assumption, ranking by blast radius and reversibility, treating tone and delivery as part of the engineering outcome, and turning disagreement into documentation fixes</td><td>—</td></tr>
</tbody></table>
