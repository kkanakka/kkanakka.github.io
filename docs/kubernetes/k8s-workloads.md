---
title: "Workload objects"
slug: /kubernetes/k8s-workloads
sidebar_position: 2
sidebar_label: "Workload objects"
description: "Workload objects"
---
## Pod

<p>The unit of scheduling: one or more containers sharing a network namespace (one IP, <code>localhost</code> between them), IPC namespace, and optionally volumes. A hidden <strong>pause</strong> container holds those namespaces so app containers can restart without losing the IP. <strong>Init containers</strong> run to completion, in order, before app containers; native <strong>sidecar</strong> containers (an init container with <code>restartPolicy: Always</code>, GA in 1.29) start before and outlive the app containers, which fixes the old "Job never finishes because the proxy sidecar is still running" problem. Pods are disposable; you almost never create them directly.</p>

## Deployment and ReplicaSet

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/k8s-workloads/architecture.svg" alt="The ownership chain" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<p>A Deployment manages ReplicaSets, one per template revision. <code>RollingUpdate</code> creates a new ReplicaSet and scales it up while scaling the old one down, bounded by <code>maxSurge</code> (extra pods allowed, default 25%) and <code>maxUnavailable</code> (pods allowed unready, default 25%); <code>minReadySeconds</code> makes a pod count as available only after it has been ready that long, a cheap bake time. <code>progressDeadlineSeconds</code> marks the rollout failed (it does not roll back). <code>revisionHistoryLimit</code> keeps old ReplicaSets so <code>kubectl rollout undo</code> works.</p>
<pre><code>kubectl rollout status deploy/api --timeout=5m
kubectl rollout history deploy/api; kubectl rollout undo deploy/api --to-revision=12
kubectl get rs -l app=api                    <span class="ic-c"># old and new ReplicaSets during a rollout</span>
kubectl set image deploy/api api=registry/api@sha256:...   <span class="ic-c"># digests, not mutable tags</span></code></pre>

## StatefulSet

<p>For workloads that need stable identity: pods are named <code>name-0</code>, <code>name-1</code>, each gets a stable DNS entry through a headless Service, each gets its own PersistentVolumeClaim from <code>volumeClaimTemplates</code>, and creation and termination are ordered (<code>podManagementPolicy: OrderedReady</code>) unless you choose <code>Parallel</code>. Scaling down does <em>not</em> delete the PVCs, which is both a safety feature and a cost surprise. <code>updateStrategy.rollingUpdate.partition</code> lets you update only ordinals ≥ N, which is how you canary a database cluster. A StatefulSet pod whose node dies is not rescheduled automatically until the node object is deleted or the pod is force-deleted, because Kubernetes cannot know whether the old instance is still writing to the volume.</p>

## DaemonSet, Job, CronJob

<p>DaemonSet: one pod per (matching) node, for agents, log shippers, CNI and CSI components. Job: <code>completions</code>, <code>parallelism</code>, <code>backoffLimit</code>, <code>activeDeadlineSeconds</code>, and <code>ttlSecondsAfterFinished</code> so finished Jobs don't accumulate; <code>restartPolicy</code> must be <code>OnFailure</code> or <code>Never</code>. CronJob: <code>schedule</code>, <code>concurrencyPolicy</code> (<code>Allow</code>/<code>Forbid</code>/<code>Replace</code>), <code>startingDeadlineSeconds</code>; if more than 100 runs are missed and no deadline is set, the controller stops scheduling that CronJob and logs an error, a classic "my nightly job silently stopped" cause.</p>
