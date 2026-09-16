---
title: "systemd deep dive"
slug: /service-management/svc-systemd
sidebar_position: 1
sidebar_label: "systemd deep dive"
description: "systemd is the substrate under every Linux host in the fleet, and its concepts (readiness, restart policy, dependency ordering, resource limits, graceful stop) are exactly the ones"
---
## Anatomy of a unit

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/svc-systemd/architecture.svg" alt="Unit dependencies and ordering" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<pre><code>[Unit]
Description=Sync API
Documentation=https://wiki.internal/sync-api
After=network-online.target postgresql.service
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=notify
User=syncapi
Group=syncapi
WorkingDirectory=/srv/syncapi
EnvironmentFile=/etc/syncapi/env
ExecStartPre=/usr/bin/syncapi --check-config
ExecStart=/usr/bin/syncapi --listen 0.0.0.0:8080
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=2s
TimeoutStopSec=30s
KillSignal=SIGTERM
KillMode=mixed
WatchdogSec=20s
LimitNOFILE=65536
MemoryMax=4G
CPUQuota=200%
TasksMax=4096
OOMScoreAdjust=500
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
StateDirectory=syncapi
LogsDirectory=syncapi

[Install]
WantedBy=multi-user.target</code></pre>

## Service types and the readiness problem

<table>
<tbody><tr><th>Type</th><th>When systemd considers it "started"</th><th>Consequence</th></tr>
<tr><td><code>simple</code> (default)</td><td>Immediately after <code>fork()</code></td><td>Units ordered <code>After=</code> it may start before it can serve; fine for things with no dependents</td></tr>
<tr><td><code>exec</code></td><td>After <code>execve()</code> succeeds</td><td>Catches a missing binary or bad permissions as a start failure instead of a mysterious exit</td></tr>
<tr><td><code>forking</code></td><td>When the parent exits</td><td>Legacy daemons; needs <code>PIDFile=</code> so systemd tracks the right main process</td></tr>
<tr><td><code>oneshot</code></td><td>When the process exits</td><td>Scripts and migrations; <code>RemainAfterExit=yes</code> keeps it "active" afterwards</td></tr>
<tr><td><code>notify</code></td><td>When the process sends <code>READY=1</code> via <code>sd_notify</code></td><td>True readiness: dependents wait until you say you're ready. Also enables <code>WatchdogSec=</code> and status strings</td></tr>
<tr><td><code>dbus</code></td><td>When a D-Bus name appears</td><td>Desktop and system daemons</td></tr>
</tbody></table>
<p>The interview point: <code>After=</code> is only useful if the thing you wait for signals real readiness. With <code>Type=simple</code>, "after" means "after it was forked," so an app that starts before its database is listening must retry itself. Prefer <code>notify</code> (most languages have a ten-line sd_notify implementation), and make the application resilient to dependencies that are up but not ready anyway.</p>

## Dependencies and ordering

<ul>
<li><code>After=</code>/<code>Before=</code> are <strong>ordering only</strong>. They do not pull anything in.</li>
<li><code>Wants=</code> pulls a unit in; if it fails, this unit still starts. <code>Requires=</code> pulls it in and fails this unit if it fails; and if the required unit is stopped, this unit stops. <code>BindsTo=</code> is stronger (stops when the dependency disappears, e.g., a device). <code>Requisite=</code> requires it to already be active. <code>PartOf=</code> propagates stop/restart.</li>
<li>Almost every "start on boot" bug is <code>network.target</code> vs <code>network-online.target</code>. <code>network.target</code> means the network stack is configured, not that interfaces have addresses. Use <code>After=network-online.target</code> <em>and</em> <code>Wants=network-online.target</code>, and accept that "online" is whatever NetworkManager or networkd decides.</li>
<li><code>systemctl list-dependencies unit</code>, <code>--reverse</code> for who depends on it, <code>systemd-analyze critical-chain</code> for the slow path.</li>
</ul>

## Restart behavior

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/svc-systemd/deep-dive.svg" alt="Restart, backoff and the rate limit" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<p><code>Restart=on-failure</code> restarts on non-zero exit, signal death, timeout, or watchdog; <code>on-abnormal</code> excludes non-zero exit codes; <code>always</code> restarts even after a clean exit (use for long-running services). <code>RestartSec=</code> is the delay. The <strong>start rate limit</strong> (default 5 starts in 10 s) flips the unit into <code>failed</code> with <code>start-limit-hit</code>, and from then on nothing restarts until <code>systemctl reset-failed unit</code>. A service that crashes instantly on a bad config hits this in seconds; set <code>StartLimitIntervalSec=</code>/<code>StartLimitBurst=</code> in <code>[Unit]</code> and <code>RestartSec=</code> long enough to not exhaust it. <code>SuccessExitStatus=</code> declares which codes are "clean."</p>

## Stopping, killing, and cgroups

<p>On <code>stop</code>, systemd runs <code>ExecStop=</code> if defined, otherwise sends <code>KillSignal</code> (SIGTERM) to the processes selected by <code>KillMode</code>: <code>control-group</code> (default: every process in the cgroup), <code>mixed</code> (SIGTERM to the main process, SIGKILL to the rest after the timeout), <code>process</code> (main only; children survive, usually a bug). After <code>TimeoutStopSec</code> (default 90 s, too long for most fleets) it sends <code>FinalKillSignal</code> (SIGKILL). Because every service lives in its own cgroup, systemd never loses track of daemonized children, and <code>systemd-cgls</code> shows the tree.</p>

## Editing, overriding, and locating units

<pre><code>systemctl cat nginx               <span class="ic-c"># the unit and every drop-in, with paths</span>
systemctl edit nginx              <span class="ic-c"># creates /etc/systemd/system/nginx.service.d/override.conf</span>
<span class="ic-c"># to replace ExecStart in a drop-in you must clear it first:</span>
[Service]
ExecStart=
ExecStart=/usr/sbin/nginx -c /etc/nginx/other.conf
systemctl daemon-reload           <span class="ic-c"># required after any unit file change</span>
systemctl show nginx -p MainPID -p NRestarts -p Result -p ActiveEnterTimestamp
systemctl list-units --failed
systemctl is-enabled nginx; systemctl enable --now nginx</code></pre>
<p>Precedence: <code>/etc/systemd/system</code> (administrator) beats <code>/run/systemd/system</code> (runtime) beats <code>/usr/lib/systemd/system</code> (package). <code>enable</code> creates the symlink in the target's <code>.wants/</code> directory; it does not start anything, and <code>start</code> does not survive reboot; <code>--now</code> does both. <code>daemon-reload</code> reparses units; <code>daemon-reexec</code> restarts PID 1 in place (after a systemd upgrade).</p>

## Templates, sockets, timers, slices

<p><strong>Templates</strong>: <code>worker@.service</code> instantiated as <code>worker@1</code>, <code>worker@2</code>, with <code>%i</code> the instance name. <strong>Socket activation</strong>: a <code>.socket</code> unit with <code>ListenStream=0.0.0.0:8080</code> makes systemd hold the listening socket and start the service on the first connection, passing the fd. Two operational wins: the socket stays open while the service restarts, so clients queue instead of getting refused, and services that aren't used don't run. <strong>Timers</strong> replace cron: <code>OnCalendar=*-*-* 03:00:00</code>, <code>OnUnitActiveSec=15m</code>, <code>Persistent=true</code> runs a missed job after boot, <code>RandomizedDelaySec=</code> spreads a fleet, and runs never overlap because the service is either active or not. <code>systemctl list-timers</code>. <strong>Slices</strong> (<code>system.slice</code>, <code>user.slice</code>) group cgroups for resource control; <strong>scopes</strong> wrap processes systemd didn't start (ssh sessions). <code>systemd-run -p MemoryMax=2G --scope ./bulk-job</code> boxes an ad-hoc job without writing a unit.</p>

## Sandboxing and capabilities

<p><code>ProtectSystem=strict</code> mounts everything read-only except what <code>ReadWritePaths=</code>, <code>StateDirectory=</code>, and friends allow; <code>PrivateTmp=</code> gives a private <code>/tmp</code>; <code>NoNewPrivileges=</code> blocks setuid escalation; <code>AmbientCapabilities=CAP_NET_BIND_SERVICE</code> lets a non-root user bind port 443 (no more running as root "because 443"); <code>DynamicUser=yes</code> allocates a throwaway UID. <code>systemd-analyze security unit</code> scores the exposure. Mention these and you signal that you run services as least-privilege by default.</p>
