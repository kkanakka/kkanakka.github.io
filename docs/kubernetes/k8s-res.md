---
title: "Resources and scheduling"
slug: /kubernetes/k8s-res
sidebar_position: 4
sidebar_label: "Resources and scheduling"
description: "Resources and scheduling"
---
## Requests, limits, and what they do in the kernel

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/k8s-res/architecture.svg" alt="Requests, limits and QoS" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<p><strong>Requests</strong> are what the scheduler uses to place the pod (sum of requests ≤ allocatable) and what sets the cgroup <code>cpu.weight</code>, so under contention CPU is shared proportionally to requests. <strong>Limits</strong> are enforced by the kernel: the CPU limit becomes a CFS quota (<code>cpu.max</code>), and a container that uses its quota within a 100 ms period is <strong>throttled</strong> for the rest of the period even on an idle node; the memory limit becomes <code>memory.max</code>, and exceeding it triggers the cgroup OOM killer, the container exits 137 with reason <code>OOMKilled</code>, and the kubelet restarts it (the pod stays). Memory is not throttled, only killed; CPU is not killed, only throttled.</p>
<p><strong>QoS classes</strong> follow from the numbers: <code>Guaranteed</code> (every container has requests equal to limits for both CPU and memory), <code>Burstable</code> (some requests set), <code>BestEffort</code> (nothing set). Under node memory pressure the kubelet evicts BestEffort first, then Burstable pods using the most over their requests, and Guaranteed last. Practical guidance many large fleets converge on: always set requests from measured usage; set memory limits (equal to requests for predictability); be skeptical of CPU limits for latency-sensitive services because throttling shows up as tail latency with low average CPU, and multi-threaded runtimes (Go, JVM) that size thread pools by host cores are hit hardest; if you keep CPU limits, set <code>GOMAXPROCS</code>/<code>-XX:ActiveProcessorCount</code> to match.</p>
<pre><code>kubectl top pod -n app --containers
kubectl get pod p -o jsonpath='{.status.containerStatuses[*].lastState}'   <span class="ic-c"># OOMKilled? exit code?</span>
<span class="ic-c"># throttling, from inside the container or the node's cgroup tree:</span>
cat /sys/fs/cgroup/cpu.stat | grep -E 'nr_throttled|throttled_usec'
<span class="ic-c"># Prometheus: rate(container_cpu_cfs_throttled_periods_total[5m]) / rate(container_cpu_cfs_periods_total[5m])</span></code></pre>

## Node-pressure eviction, priority, preemption

<p>The kubelet watches <code>memory.available</code>, <code>nodefs.available</code>, <code>imagefs.available</code>, and <code>pid.available</code> against eviction thresholds and evicts pods (status <code>Evicted</code>, which lingers until cleaned up) ranked by usage over request and QoS. A <code>PriorityClass</code> changes both eviction order and scheduling: a high-priority Pending pod can <strong>preempt</strong> lower-priority pods on a node that would fit it. System components run with <code>system-node-critical</code> for this reason; give your on-call tooling and ingress a high class too.</p>

## Placing pods

<ul>
<li><code>nodeSelector</code> and <code>nodeAffinity</code> (<code>requiredDuringScheduling…</code> is a hard filter; <code>preferred…</code> is a score).</li>
<li><code>podAntiAffinity</code> with <code>topologyKey: kubernetes.io/hostname</code> or zone spreads replicas; required anti-affinity on a small cluster is a common cause of Pending.</li>
<li><code>topologySpreadConstraints</code> (<code>maxSkew</code>, <code>whenUnsatisfiable: DoNotSchedule|ScheduleAnyway</code>) spread across zones more flexibly than anti-affinity.</li>
<li><strong>Taints and tolerations</strong>: a taint on a node repels pods without a matching toleration; effects <code>NoSchedule</code>, <code>PreferNoSchedule</code>, <code>NoExecute</code> (evicts running pods; <code>tolerationSeconds</code> controls how long a pod survives on a node tainted <code>not-ready</code> or <code>unreachable</code>, default 300 s, which is the "pods took five minutes to move off a dead node" answer).</li>
<li><strong>PodDisruptionBudget</strong>: <code>minAvailable</code> or <code>maxUnavailable</code>, honored by the eviction API (drain, cluster autoscaler, upgrades), not by node crashes or OOM kills. A PDB that can never be satisfied (minAvailable equals replicas) blocks every drain forever.</li>
</ul>

## Autoscaling

<p>The <strong>HPA</strong> scales replicas on CPU or memory utilization (a percentage of <em>requests</em>, so it needs requests and metrics-server) or on custom/external metrics (queue depth, RPS). It scales up quickly and down slowly (default 5-minute stabilization window), evaluates every 15 s, and won't act while the target's pods lack metrics. The <strong>VPA</strong> recommends or rewrites requests. The <strong>Cluster Autoscaler</strong> (or Karpenter) adds nodes when pods are Pending for lack of resources and removes underused nodes, subject to PDBs and pods it can't move (local storage, no controller). HPA and VPA on the same metric fight each other.</p>
