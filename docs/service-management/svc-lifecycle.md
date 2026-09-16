---
title: "Graceful lifecycle"
slug: /service-management/svc-lifecycle
sidebar_position: 3
sidebar_label: "Graceful lifecycle"
description: "Graceful lifecycle"
---
## What "graceful shutdown" actually requires

<!-- DIAGRAM:sequence:START -->

<img src="/diagrams/svc-lifecycle/sequence.svg" alt="Graceful shutdown, step by step" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<ol>
<li>Stop being chosen: fail the readiness check or deregister from the load balancer / service discovery, and wait for propagation. This is the step people skip, and it is the source of the errors seen during "successful" deploys.</li>
<li>Stop accepting: close the listening socket (or stop calling <code>accept()</code>). For HTTP keep-alive, send <code>Connection: close</code> on the next response; for HTTP/2 and gRPC send GOAWAY so clients reconnect elsewhere.</li>
<li>Drain: let in-flight requests finish, with a hard deadline shorter than <code>TimeoutStopSec</code> / <code>terminationGracePeriodSeconds</code>.</li>
<li>Finish and flush: commit or roll back background work, flush buffers and metrics, close database connections cleanly (so the pool on the other side doesn't hold a dead socket until TCP keepalive notices).</li>
<li>Exit 0. A non-zero exit during a planned stop makes <code>Restart=on-failure</code> restart it and pollutes dashboards.</li>
</ol>
<p>The race to understand: the load balancer learned the instance is gone only after its next health check or an explicit deregistration, so requests keep arriving for a few seconds after SIGTERM. A server that closes immediately resets those connections. The fix is ordering (step 1 before step 2) plus a small delay; in Kubernetes that is the <code>preStop</code> sleep, on bare metal it is "drain from the LB, then stop." Apache-style prefork servers do the same with <code>graceful-stop</code>.</p>

## Restarts and reloads without dropping connections

<ul>
<li><strong>Socket activation</strong>: systemd keeps the socket; the new process inherits it; the backlog absorbs the gap.</li>
<li><strong><code>SO_REUSEPORT</code></strong>: the new process binds the same port before the old one stops; the kernel spreads new connections across both.</li>
<li><strong>nginx-style binary upgrade</strong>: <code>SIGUSR2</code> to the master forks a new master that inherits listeners; <code>SIGWINCH</code> gracefully retires old workers; <code>SIGHUP</code> reloads config by starting new workers and letting old ones finish. Test config first (<code>nginx -t</code>); a bad reload keeps the old workers running.</li>
<li><strong>Config reload</strong> over <code>ExecReload=</code> (usually SIGHUP) beats restart when supported; a restart should still be safe and fast, because reload paths are tested less.</li>
</ul>

## Health checks: three questions, not one

<table>
<tbody><tr><th>Check</th><th>Question</th><th>Wrong answer's consequence</th><th>systemd analog</th></tr>
<tr><td>Startup</td><td>Has initialization finished?</td><td>Killing a slow-starting JVM before it's up, forever</td><td><code>TimeoutStartSec</code>, <code>Type=notify</code></td></tr>
<tr><td>Liveness</td><td>Is the process deadlocked or wedged?</td><td>Restart loops under load if it checks dependencies</td><td><code>WatchdogSec</code></td></tr>
<tr><td>Readiness</td><td>Can this instance serve right now?</td><td>All instances unready at once if it checks a shared dependency</td><td><code>sd_notify READY=1</code>, LB health endpoint</td></tr>
</tbody></table>
<p>The senior-level nuance: readiness should reflect <em>this instance's</em> ability to serve, not the health of shared dependencies. If every replica marks itself unready because the database is slow, you turn a degraded backend into a full outage with no capacity to serve cached or partial responses. Liveness should be the cheapest possible "am I alive" check, never a dependency check.</p>
