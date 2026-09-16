---
title: "Networking"
slug: /kubernetes/k8s-net
sidebar_position: 5
sidebar_label: "Networking"
description: "Networking"
---
<p>The model: every pod has a routable IP, all pods can reach all pods without NAT, and nodes can reach pods. The CNI plugin implements it with overlays (VXLAN), BGP, or cloud VPC routing. Inside a pod the containers share one network namespace, so ports are per pod.</p>

## Services

<!-- DIAGRAM:sequence:START -->

<img src="/diagrams/k8s-net/sequence.svg" alt="How a request reaches a pod" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

<p>A <strong>ClusterIP</strong> is a virtual IP that exists on no interface; kube-proxy programs DNAT rules on every node so a packet to the VIP:port is rewritten to a backend pod IP chosen from the Service's <strong>EndpointSlices</strong> (ready pods matching the selector). With iptables mode the choice is random per connection and rule count grows with endpoints; IPVS uses hash tables and supports real balancing algorithms; nftables mode is the newer iptables replacement. Because this is connection-level DNAT, long-lived connections (gRPC, HTTP/2) pin to one pod and do not rebalance when you scale; use client-side balancing, a mesh, or an L7 proxy. Types: <code>NodePort</code> opens a port (30000–32767) on every node; <code>LoadBalancer</code> asks the cloud for an external LB that targets the NodePort; <code>ExternalName</code> is a DNS CNAME; a <strong>headless</strong> Service (<code>clusterIP: None</code>) has no VIP and its DNS returns pod IPs directly, which StatefulSets rely on for <code>db-0.db.ns.svc.cluster.local</code>. <code>externalTrafficPolicy: Local</code> preserves client source IPs and avoids a second hop but only routes to pods on the node that received the packet, so the external LB must health-check per node.</p>

## DNS

<p>CoreDNS serves <code>&lt;svc&gt;.&lt;ns&gt;.svc.cluster.local</code>. Pods get <code>resolv.conf</code> with search domains and <code>ndots:5</code>, the cause of the extra lookups described in LNX-11. Two operational classics: CoreDNS under-provisioned (scale it with the cluster, enable the cache plugin, or run NodeLocal DNSCache), and the <strong>conntrack race</strong> where parallel A and AAAA UDP queries from the same socket collide in netfilter and one is dropped, producing exactly-5-second DNS delays; mitigations are NodeLocal DNSCache, <code>single-request-reopen</code> in <code>dnsConfig.options</code>, or forcing TCP.</p>

## Ingress, Gateway, and NetworkPolicy

<p>An <strong>Ingress</strong> is only a rule object; an ingress controller (nginx, HAProxy, Envoy-based, cloud) watches it and programs an L7 proxy; the <strong>Gateway API</strong> is the successor with role-separated Gateway and HTTPRoute resources. The ingress controller's own capacity, timeouts, and connection draining are part of your reliability story. <strong>NetworkPolicy</strong> is default-allow until a policy selects a pod; then it is allow-list for the directions the policy covers; enforcement needs a CNI that supports it. Forgetting to allow DNS egress is the standard first failure after applying a default-deny.</p>
<pre><code>kubectl get endpointslices -l kubernetes.io/service-name=api -o wide   <span class="ic-c"># empty? readiness failing</span>
kubectl run dbg --rm -it --image=nicolaka/netshoot -- bash           <span class="ic-c"># nslookup, curl, tcpdump, ss in-cluster</span>
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=100
kubectl exec -it p -- cat /etc/resolv.conf</code></pre>
