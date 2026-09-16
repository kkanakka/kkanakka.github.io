---
title: "Pod lifecycle and probes"
slug: /kubernetes/k8s-pod
sidebar_position: 3
sidebar_label: "Pod lifecycle and probes"
description: "Pod lifecycle and probes"
---
## Phases and container states

<!-- DIAGRAM:sequence:START -->

<img src="/diagrams/k8s-pod/sequence.svg" alt="Pod lifecycle and the three probes" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<p>Pod phases: <code>Pending</code> (not yet scheduled, or scheduled but images pulling/volumes mounting), <code>Running</code>, <code>Succeeded</code>, <code>Failed</code>, <code>Unknown</code> (node unreachable). The useful detail is per-container: <code>Waiting</code> with a reason (<code>ContainerCreating</code>, <code>ImagePullBackOff</code>, <code>CrashLoopBackOff</code>, <code>CreateContainerConfigError</code>), <code>Running</code>, or <code>Terminated</code> with an exit code and reason (<code>Completed</code>, <code>Error</code>, <code>OOMKilled</code>). Exit code 137 is 128+9, killed by SIGKILL, which is what the kernel OOM killer sends; 143 is 128+15, SIGTERM. Crash restarts back off exponentially from 10 s to a cap of 5 minutes, reset after the container runs for 10 minutes.</p>

## The three probes

<table>
<tbody><tr><th>Probe</th><th>On failure</th><th>Use it for</th><th>Common mistake</th></tr>
<tr><td>startup</td><td>Container killed and restarted; other probes are disabled until it succeeds</td><td>Slow-starting apps: <code>failureThreshold × periodSeconds</code> is the max startup time</td><td>Not setting it, then loosening liveness to cover startup</td></tr>
<tr><td>liveness</td><td>Container killed and restarted per <code>restartPolicy</code></td><td>Detecting deadlock or a wedged event loop</td><td>Checking dependencies, so a slow database causes restart storms</td></tr>
<tr><td>readiness</td><td>Pod removed from Service endpoints; not restarted</td><td>"Can this instance take traffic right now"</td><td>Tying it to shared dependencies (see SVC-07)</td></tr>
</tbody></table>
<p>Defaults that bite: <code>timeoutSeconds: 1</code> (a GC pause flips readiness), <code>periodSeconds: 10</code>, <code>failureThreshold: 3</code>, so detection takes 30 s. Probe handlers: <code>httpGet</code>, <code>tcpSocket</code>, <code>exec</code> (spawns a process every period; expensive at scale), <code>grpc</code>. Probe endpoints must be cheap, unauthenticated, and never hit the database.</p>

## Termination, and the rolling-update 502

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/k8s-pod/deep-dive.svg" alt="Where the rolling-update 502 comes from" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<p>When a pod is deleted, two things happen in parallel. The API server sets <code>deletionTimestamp</code>; the EndpointSlice controller removes the pod from endpoints and kube-proxy and ingress controllers update their rules asynchronously. Meanwhile the kubelet runs the <code>preStop</code> hook, then sends SIGTERM to PID 1 of each container, and after <code>terminationGracePeriodSeconds</code> (default 30 s, counted from the start including preStop) sends SIGKILL. Because endpoint removal lags, traffic keeps arriving for a few seconds after SIGTERM. If the app closes its listener immediately, those requests fail. The standard fix:</p>
<pre><code>lifecycle:
  preStop:
    exec: { command: ["sh", "-c", "sleep 8"] }   <span class="ic-c"># let endpoint removal propagate first</span>
terminationGracePeriodSeconds: 45                <span class="ic-c"># &gt; preStop + app drain time</span></code></pre>
<p>And the app must handle SIGTERM: if the entrypoint is a shell script that runs the binary without <code>exec</code>, the shell is PID 1, ignores SIGTERM, and the container is always SIGKILLed at the deadline. Readiness-gate the start too: a pod with no readiness probe is "ready" the instant its container starts.</p>
