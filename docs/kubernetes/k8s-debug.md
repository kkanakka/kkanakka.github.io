---
title: "Debugging playbook"
slug: /kubernetes/k8s-debug
sidebar_position: 7
sidebar_label: "Debugging playbook"
description: "Debugging playbook"
---
<pre><code>kubectl get pod p -o wide                     <span class="ic-c"># node, IP, restarts, age</span>
kubectl describe pod p                        <span class="ic-c"># events at the bottom: scheduling, pulls, probes, kills</span>
kubectl logs p -c app --previous              <span class="ic-c"># the crashed container's output</span>
kubectl get events -n ns --sort-by=.lastTimestamp
kubectl debug -it p --image=busybox --target=app     <span class="ic-c"># ephemeral container sharing the process namespace</span>
kubectl debug node/n -it --image=ubuntu       <span class="ic-c"># a shell on the node's root filesystem at /host</span>
kubectl exec p -- sh -c 'cat /proc/1/status | grep -E "State|VmRSS"'
kubectl get pod p -o yaml | yq .status        <span class="ic-c"># conditions, containerStatuses, reasons</span></code></pre>

## CrashLoopBackOff

<!-- DIAGRAM:deep-dive:START -->

<img src="/diagrams/k8s-debug/deep-dive.svg" alt="Debugging by the phase you are stuck in" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:deep-dive:END -->

<ol>
<li><code>logs --previous</code>: what did it print before dying? Stack trace, "config not found," "cannot connect to."</li>
<li><code>describe</code>: last state exit code and reason. <code>OOMKilled</code>/137 is memory; 1 is an application error; 126/127 is a bad command or missing binary; a termination with "Liveness probe failed" in events is the probe, not the app.</li>
<li>Config: <code>CreateContainerConfigError</code> means a referenced ConfigMap/Secret key is missing. Wrong <code>command</code>/<code>args</code> overriding the image entrypoint is frequent.</li>
<li>Reproduce: <code>kubectl debug</code> a copy with <code>--copy-to</code> and <code>command: sleep</code>, exec in, run the binary by hand.</li>
</ol>

## ImagePullBackOff

<p>Events say why: manifest unknown (wrong tag or digest), unauthorized (missing or expired <code>imagePullSecrets</code>, registry token rotation), too many requests (registry rate limit; cache images in a pull-through mirror), no match for platform (arm64 vs amd64), or registry unreachable (egress policy, proxy). <code>imagePullPolicy: Always</code> on a mutable tag makes the registry a dependency of every restart.</p>

## Pending

<p><code>describe</code> gives the scheduler's verdict: "0/120 nodes are available: 40 Insufficient cpu, 60 node(s) had untolerated taint, 20 node(s) didn't match pod anti-affinity rules." Fix the named constraint: lower requests, add tolerations, relax anti-affinity, scale the node pool. If there is no event at all, the pod may not exist: a <code>ResourceQuota</code> rejected it and the error is on the ReplicaSet (<code>kubectl describe rs</code>). A pod stuck in <code>ContainerCreating</code> is the kubelet: volume attach/mount failures (PVC Pending, wrong zone, CSI driver down), CNI failures ("failed to allocate IP," pool exhausted), or a failing admission/mutating webhook on the node side.</p>

## Readiness failing, no endpoints

<p>Ingress returns 503 or a Service connection hangs while pods show <code>Running</code>. Check <code>READY 0/1</code> in <code>get pod</code>, probe failure events in <code>describe</code>, and an empty EndpointSlice. Then hit the probe path yourself from an ephemeral container. The usual suspects: app listening on a different port or only on <code>127.0.0.1</code>, a 1-second probe timeout, TLS on the port with an HTTP probe, or a probe path behind authentication.</p>

## Node NotReady

<p>The kubelet stopped reporting: process down, node rebooted, certificate expired, disk full (kubelet cannot write), container runtime hung, or network partition from the API server. Pods on the node keep running if the node is merely partitioned; after <code>tolerationSeconds</code> (300 s) the node lifecycle controller evicts them, and Deployments reschedule elsewhere while StatefulSet pods wait. Check <code>describe node</code> conditions (<code>MemoryPressure</code>, <code>DiskPressure</code>, <code>PIDPressure</code>, <code>NetworkUnavailable</code>), <code>journalctl -u kubelet</code> and <code>-u containerd</code> on the node, <code>df -h /var/lib/kubelet /var/lib/containerd</code>, and whether the node can reach the API server.</p>

## Control plane slow

<p>Symptoms: <code>kubectl</code> timeouts, controllers lagging, leader elections flapping. Start with etcd: <code>etcd_disk_wal_fsync_duration_seconds</code> and <code>etcd_disk_backend_commit_duration_seconds</code> p99 should be well under 25 ms and 100 ms; leader changes indicate I/O or network trouble; database size against quota; run <code>etcdctl endpoint status -w table</code>, <code>endpoint health</code>, <code>alarm list</code>, and <code>defrag</code> one member at a time. Then the API server: <code>apiserver_request_duration_seconds</code> by verb, expensive <code>LIST</code> calls from a misbehaving controller or a CI job listing all pods every second, huge objects (ConfigMaps near 1 MiB), webhook latency (<code>apiserver_admission_webhook_admission_duration_seconds</code>), and priority-and-fairness rejections (429s).</p>
