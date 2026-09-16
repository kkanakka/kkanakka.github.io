---
title: "Architecture"
slug: /kubernetes/k8s-arch
sidebar_position: 1
sidebar_label: "Architecture"
description: "Interviewers rarely ask for YAML. They ask what happens when a pod won't start, why a rolling update threw errors, what a limit actually does in the kernel, and what you'd check wh"
---
<p>Kubernetes is a database of desired state (etcd, fronted by the API server) plus a set of controllers that each watch one kind of object and nudge reality toward it. Every controller is a <strong>level-triggered reconciliation loop</strong>: read desired state, observe actual state, act, repeat. Actions are idempotent so a controller can crash and restart without harm. Nothing calls anything directly; components watch the API server and react. That single idea explains most behaviors you'll be asked about: why things converge eventually instead of immediately, why a deleted pod can take seconds to leave a load balancer, and why the API server and etcd are the first things to check when "everything is slow."</p>

## Control plane

<!-- DIAGRAM:architecture:START -->

<img src="/diagrams/k8s-arch/architecture.svg" alt="Control plane and node" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:architecture:END -->

<ul>
<li><strong>kube-apiserver</strong>: the only component that talks to etcd. Authentication, authorization (RBAC), admission (mutating then validating webhooks, quotas, Pod Security), validation, then persistence. Horizontally scalable; stateless.</li>
<li><strong>etcd</strong>: Raft-replicated key-value store, 3 or 5 members, strongly consistent. Sensitive to disk fsync latency and to large/frequent writes. The default backend quota is 8 GiB; exceeding it raises a <code>NOSPACE</code> alarm and the cluster goes read-only until you compact, defragment, and clear the alarm.</li>
<li><strong>kube-scheduler</strong>: for each unscheduled pod, <em>filter</em> nodes (resource fit against requests, node selectors and affinity, taints, ports, volume topology) then <em>score</em> the survivors (spreading, least allocated, affinity preferences), bind the pod to the winner. It only sets <code>spec.nodeName</code>; the kubelet does the rest.</li>
<li><strong>kube-controller-manager</strong>: Deployment, ReplicaSet, StatefulSet, DaemonSet, Job, Node, EndpointSlice, ServiceAccount, garbage-collection controllers, and more, in one binary with leader election via a Lease object.</li>
<li><strong>cloud-controller-manager</strong>: node lifecycle, routes, and LoadBalancer Services on a cloud provider.</li>
</ul>

## Node

<ul>
<li><strong>kubelet</strong>: registers the node, watches for pods bound to it, pulls images and starts containers through the CRI (containerd or CRI-O), runs the probes, reports pod and node status, enforces node-pressure eviction, and mounts volumes. If the kubelet stops posting heartbeats, the node controller marks the node <code>NotReady</code>.</li>
<li><strong>kube-proxy</strong>: programs Service virtual IPs into iptables, IPVS, or nftables on every node. Some CNIs (Cilium) replace it with eBPF.</li>
<li><strong>Container runtime</strong> (containerd): pulls images, creates cgroups and namespaces, runs the container via runc.</li>
<li><strong>CNI plugin</strong> (Calico, Cilium, Flannel, cloud VPC CNIs): gives every pod an IP and routes between them. <strong>CSI drivers</strong>: attach and mount storage.</li>
</ul>
<pre><code>kubectl get --raw /readyz?verbose            <span class="ic-c"># API server health, per-check</span>
kubectl get componentstatuses                <span class="ic-c"># deprecated, but still asked about</span>
kubectl get lease -n kube-system             <span class="ic-c"># who holds scheduler / controller-manager leadership</span>
kubectl get events -A --sort-by=.lastTimestamp | tail -30
kubectl get nodes -o wide; kubectl describe node &lt;n&gt; | sed -n '/Conditions/,/Addresses/p'</code></pre>
