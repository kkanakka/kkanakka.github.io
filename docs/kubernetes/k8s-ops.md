---
title: "Operating clusters"
slug: /kubernetes/k8s-ops
sidebar_position: 8
sidebar_label: "Operating clusters"
description: "Operating clusters"
---

<!-- DIAGRAM:architecture:START -->

## Operating a cluster

<img src="/diagrams/k8s-ops/architecture.svg" alt="Operating a cluster" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->
<ul>
<li><strong>Upgrades</strong>: control plane first, one minor version at a time; kubelets may lag the API server by up to three minors but never lead it. Read the deprecated-API list before each upgrade; a removed API version turns a working manifest into a hard failure.</li>
<li><strong>Draining</strong>: <code>kubectl cordon</code> stops new scheduling; <code>kubectl drain --ignore-daemonsets --delete-emptydir-data</code> evicts pods honoring PDBs; a drain that hangs is a PDB that cannot be satisfied or a pod with no controller. Set <code>--timeout</code> and <code>--disable-eviction</code> only when you accept the risk.</li>
<li><strong>etcd backups</strong>: <code>etcdctl snapshot save</code> on a schedule, stored off-cluster, with a rehearsed restore; test the restore, because an untested backup is a hypothesis.</li>
<li><strong>Certificates</strong>: kubeadm-issued certs expire after a year; <code>kubeadm certs check-expiration</code>; enable kubelet client certificate rotation; expired certs look like NotReady nodes and API auth failures.</li>
<li><strong>RBAC and admission</strong>: least-privilege ServiceAccounts, <code>automountServiceAccountToken: false</code> where unused, <code>kubectl auth can-i --as=system:serviceaccount:ns:sa</code>. Validating and mutating webhooks with <code>failurePolicy: Fail</code> become a single point of failure: when the webhook's pods are down, nothing in their scope can be created, including the pods that would fix it; exclude <code>kube-system</code> and set sane timeouts.</li>
<li><strong>Multi-tenancy and guardrails</strong>: Namespaces, <code>ResourceQuota</code>, <code>LimitRange</code> (default requests so nothing is BestEffort by accident), Pod Security Admission (<code>restricted</code>), image digests and registry allow-lists via policy engines.</li>
<li><strong>Observability</strong>: metrics-server for HPA and <code>kubectl top</code>; kube-state-metrics for object state (restarts, unavailable replicas, Pending durations); cAdvisor via kubelet for container CPU/memory/throttling; node exporter; control-plane metrics; events shipped somewhere searchable because they expire after an hour.</li>
<li><strong>GitOps</strong> (Argo CD, Flux) makes the cluster match a repo; drift detection tells you when someone <code>kubectl edit</code>ed production. Treat clusters as replaceable: blast radius is the cluster, so run several.</li>
</ul>
