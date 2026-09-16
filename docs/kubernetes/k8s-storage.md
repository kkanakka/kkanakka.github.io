---
title: "Storage and config"
slug: /kubernetes/k8s-storage
sidebar_position: 6
sidebar_label: "Storage and config"
description: "Storage and config"
---
## ConfigMaps and Secrets

<p>Mounted as volumes, they update in the running pod eventually (kubelet sync period, about a minute, plus cache TTL), <em>unless</em> mounted with <code>subPath</code>, which never updates. Injected as environment variables, they never update; the pod must restart, which is why deployment tools hash the ConfigMap into a pod annotation to force a rollout. <code>immutable: true</code> prevents accidental edits and reduces API server watch load on big clusters. A Secret is base64, not encrypted: enable encryption at rest for etcd, restrict RBAC on Secrets, and prefer an external secrets operator or CSI secrets driver with rotation.</p>

## Volumes

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/k8s-storage/architecture.svg" alt="PV, PVC and the CSI chain" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<p><code>emptyDir</code> lives as long as the pod (can be <code>medium: Memory</code>, which counts against the memory limit). <code>hostPath</code> ties pods to nodes and is a security risk. <strong>PersistentVolumeClaim</strong> → <strong>PersistentVolume</strong> via a <strong>StorageClass</strong> with dynamic provisioning through a CSI driver. Access modes: <code>ReadWriteOnce</code> (one node), <code>ReadOnlyMany</code>, <code>ReadWriteMany</code> (needs a shared filesystem like NFS), <code>ReadWriteOncePod</code>. <code>volumeBindingMode: WaitForFirstConsumer</code> delays provisioning until the pod is scheduled so the volume lands in the right zone; <code>Immediate</code> is the source of "pod Pending: volume node affinity conflict." <code>reclaimPolicy: Delete</code> destroys data when the PVC is deleted; use <code>Retain</code> for anything you care about. Expansion is online for most drivers; snapshots are a CSI feature.</p>
