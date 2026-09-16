---
title: "journald and logging"
slug: /service-management/svc-journal
sidebar_position: 2
sidebar_label: "journald and logging"
description: "journald and logging"
---

<!-- DIAGRAM:sequence:START -->

## Where your stdout actually goes

<img src="/diagrams/svc-journal/sequence.svg" alt="Where your stdout actually goes" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->
<p>journald captures every service's stdout/stderr, kernel messages, and syslog into indexed binary logs with structured fields (<code>_SYSTEMD_UNIT</code>, <code>_PID</code>, <code>PRIORITY</code>, <code>_COMM</code>, <code>MESSAGE</code>). Storage is volatile in <code>/run/log/journal</code> unless <code>/var/log/journal</code> exists or <code>Storage=persistent</code> is set; a reboot on a volatile configuration erases the evidence you needed.</p>
<pre><code>journalctl -u syncapi -f                      <span class="ic-c"># follow one unit</span>
journalctl -u syncapi -b -1 -p err            <span class="ic-c"># errors from the previous boot</span>
journalctl --since "2026-08-20 14:00" --until "14:30" _PID=2211
journalctl -k                                 <span class="ic-c"># kernel ring buffer, like dmesg but persistent</span>
journalctl -o json-pretty -n 1 -u syncapi     <span class="ic-c"># see the structured fields</span>
journalctl --disk-usage
journalctl --vacuum-size=2G --vacuum-time=14d
journalctl -u syncapi | grep -c 'Suppressed'  <span class="ic-c"># rate-limiting dropped messages</span></code></pre>
<p>Cap journald correctly with <code>SystemMaxUse=</code> and <code>SystemKeepFree=</code> in <code>/etc/systemd/journald.conf</code>, not with a cron job that deletes files. Rate limiting (<code>RateLimitIntervalSec</code>/<code>RateLimitBurst</code>, per service) silently drops floods and prints "Suppressed N messages"; a service that logs every request at debug will have gaps. Forwarding: <code>ForwardToSyslog=</code> to rsyslog, or an agent (Vector, Fluent Bit, journalbeat) tailing the journal to the central pipeline. For services that write their own files, <code>logrotate</code> rotates with either <code>copytruncate</code> (safe for any writer, may lose a few lines) or <code>create</code> plus a <code>postrotate</code> signal (<code>kill -USR1</code> for nginx) so the daemon reopens; forgetting the signal is the deleted-open-file disk leak from the LNX chapter.</p>
