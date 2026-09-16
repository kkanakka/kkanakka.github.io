---
title: "Linux Systems Guide"
slug: /linux/linux-systems-guide
sidebar_position: 1
sidebar_label: "Linux Systems Guide"
description: "Linux Systems Guide"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/linux-systems-guide/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

Deep dives into how Linux manages processes, memory, containers, and networking — with diagrams, code examples, and real-world debugging techniques.

[

⚙️

## Scheduling & Container Isolation

Process scheduling, cgroups, namespaces

How Linux decides which process runs when — PREEMPT models, scheduling classes, priority, nice values — plus container isolation with cgroups, namespaces, CPU pinning, and NUMA effects.

PREEMPT\_RT SCHED\_FIFO CFS cgroups v2 PID namespaces CPU pinning NUMA TLB effects

Learn scheduling internals →

](/docs/linux/linux-scheduling-containers)[

🔄

## Processes & Memory Management

fork(), exec(), virtual memory, stack frames

How programs become processes — process creation, memory layout, stack frames, environment variables, and the relationship between processes, threads, and the kernel.

fork() exec() Virtual Memory Stack Frames Environment PID

Explore process lifecycle →

](/docs/linux/linux-processes-memory)[

🧠

## Memory Architecture

Virtual memory, page tables, heap vs stack

Deep dive into Linux memory management — virtual address spaces, page tables, memory mapping, heap allocation, garbage collection, and JVM memory mapped to Linux internals.

Virtual Memory Page Tables Heap Stack Memory Mapping JVM Internals

Understand memory layout →

](/docs/linux/linux-memory-architecture)[

🌐

## Networking Deep Dive

TCP/IP stack, packet journey, load balancing

What happens when you type linkedin.com — DNS resolution, ARP, DHCP, BGP routing, TCP/TLS handshakes, load balancing, and how packets travel from browser to server.

DNS ARP DHCP BGP TCP/TLS Load Balancing

Trace the network journey →

](/docs/linux/linux-networking)[

🎯

## Linux Scenario Design

System design interview scenarios

Four canonical Linux/SRE scenarios: distributed patch management, real-time processing, Ceph scaling, and K8s resource allocation. Plus eBPF deep dive and design patterns.

Patch Management Real-time Ceph Scaling eBPF K8s Resources System Design

Explore scenarios →

](/docs/linux/linux-scenario-design)[

🔴

## Google SRE Interview Questions

Networking, Processes, Filesystems, Containers, SysAdmin

29 deep-dive questions from the Google SRE interview question bank — signals, fork(), virtual memory, inodes, namespaces, routing tables, permissions, and incident response scenarios with kernel diagrams and commands.

Signals fork()/exec() Virtual Memory Inodes Namespaces Routing Permissions SSH

Study all questions →

](/docs/sre/google-sre-interview-questions)[

🔧

## Kernel Internals & Kubelet

Preemption, cgroups, namespaces, Kubernetes deep-dive

Linux kernel preemption models, scheduling classes, cgroups v2, namespaces, advanced networking, memory management, storage I/O, systemd tuning, troubleshooting, and Kubernetes resource allocation with kubelet internals.

Preemption cgroups v2 Namespaces BBR XDP io\_uring Kubelet QoS Classes

Explore kernel internals →

](/docs/linux/kernel-internals-kubelet)[

🎮

## GPUs in Kubernetes

Allocation, RDMA networking, inference, operations

How kubelet allocates GPUs, cgroup limitations, MIG/MPS/time-slicing, DRA, RDMA & GPUDirect networking, SR-IOV, NCCL, inference optimizations (KV cache, speculative decoding), and GPU Operator operations.

MIG MPS DRA RDMA GPUDirect SR-IOV NCCL KV Cache

Read the GPU field guide →

](/docs/linux/gpus-in-kubernetes)
