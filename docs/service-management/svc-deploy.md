---
title: "Deployment strategies"
slug: /service-management/svc-deploy
sidebar_position: 4
sidebar_label: "Deployment strategies"
description: "Deployment strategies"
---
<p>Most outages are caused by changes, so the deploy system is the most important reliability tool you own. Know the strategies and the constraint each one imposes.</p>
<table>
<tbody><tr><th>Strategy</th><th>Mechanics</th><th>Constraint it imposes</th><th>Rollback</th></tr>
<tr><td>Rolling</td><td>Replace instances N at a time; wait for readiness between batches</td><td>Old and new run concurrently: APIs, message formats, and schema must be backward and forward compatible</td><td>Roll the old artifact forward; takes as long as a deploy</td></tr>
<tr><td>Blue/green</td><td>Two full environments; flip traffic at the LB or DNS</td><td>Double capacity; database is still shared, so schema compatibility still applies</td><td>Flip back; seconds</td></tr>
<tr><td>Canary</td><td>1% → 10% → 50% → 100% with bake time and automated comparison against the baseline</td><td>Needs good metrics and enough traffic to see a signal at 1%; canary and baseline must be comparable (same hardware, same traffic mix)</td><td>Stop promotion, route away from canary</td></tr>
<tr><td>Feature flags</td><td>Deploy dark, enable by cohort or percentage at runtime</td><td>Flag debt; combinatorial testing; flags must fail safe</td><td>Flip the flag; seconds, no deploy</td></tr>
</tbody></table>

## Rollback as a design requirement

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/svc-deploy/architecture.svg" alt="Deployment strategies compared" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<p>Artifacts are immutable and versioned (image digests, not tags like <code>latest</code>); rollback is "deploy the previous artifact," and it is exercised routinely so it works under pressure. Target minutes, not tens of minutes. Roll forward only when rollback is impossible, which should be rare and known in advance. The thing that makes rollback impossible is almost always data: a schema change or a new message format already written.</p>

## Schema migrations: expand and contract

<ol>
<li><strong>Expand</strong>: add the new column (nullable, with a default that doesn't rewrite the table), new table, or new field. Deploy. Old code ignores it.</li>
<li><strong>Dual write</strong>: deploy code that writes both old and new shapes, reads old.</li>
<li><strong>Backfill</strong> in batches, throttled, resumable.</li>
<li><strong>Switch reads</strong> to the new shape behind a flag. Verify.</li>
<li><strong>Contract</strong>: stop writing old; after a bake period, drop the old column in its own deploy.</li>
</ol>
<p>Never rename or change a type in one step. For large tables use online DDL (PostgreSQL <code>CREATE INDEX CONCURRENTLY</code>, <code>ADD COLUMN</code> with a constant default is metadata-only since PG 11; MySQL via gh-ost or pt-online-schema-change) and watch for lock waits and replication lag during the backfill.</p>

## Config is a deploy

<p>Config pushes cause as many outages as code (a bad flag value, a wrong upstream address, a typo in a rate limit) and are often shipped with less ceremony. Treat them the same: versioned, validated before apply (<code>sshd -t</code>, <code>nginx -t</code>, schema-checked JSON), canaried, and rollback-able. At fleet scale, roll by failure domain (host → rack → zone → region) with bake time and an automatic halt when SLOs regress.</p>

## Supervision beyond systemd

<p>Containers: the runtime restart policy (<code>always</code>, <code>on-failure</code>, <code>unless-stopped</code>) or the Kubernetes kubelet plays the systemd role; PID 1 inside the container must forward signals and reap children (<code>tini</code>). Process managers like supervisord and runit still appear in legacy stacks. At Apple scale, "service management" also means service discovery, configuration distribution, secret rotation, fleet orchestration by failure domain, and health aggregation; be ready to describe the system you used for each and what failed in it.</p>
