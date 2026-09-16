---
title: "NALSD Overview"
slug: /nalsd/nalsd-index
sidebar_position: 1
sidebar_label: "NALSD Overview"
description: "NALSD Overview"
---
Non-Abstract Large System Design — Google SRE-style exercises designing real LinkedIn infrastructure systems with capacity planning, SLOs, failure modes, and operational trade-offs.

[

📈

## Monitoring & Alerting Platform

NALSD · LinkedIn observability stack

Design a monitoring and alerting platform for LinkedIn-scale infrastructure. Metrics ingestion, anomaly detection, alert routing, dashboard rendering, and SLO tracking.

Metrics Alerting SLOs Time-Series Anomaly Detection

Read the design →

](/docs/nalsd/nalsd-monitoring-platform)[

📜

## Distributed Logging Pipeline

NALSD · LinkedIn log infrastructure

Design a distributed logging pipeline handling billions of log events per day. Collection, transport, indexing, querying, retention policies, and cost optimization.

Log Collection Kafka Indexing Retention Query Engine

Read the design →

](/docs/nalsd/nalsd-logging-pipeline)[

⚙

## Distributed Task Queue

NALSD · LinkedIn async processing

Design a distributed task queue for reliable async job execution. Task scheduling, priority queues, dead-letter handling, retry strategies, and exactly-once semantics.

Task Scheduling Priority Queues Retries Dead Letter Idempotency

Read the design →

](/docs/nalsd/nalsd-task-queue)[

🎯

## SLO Error Budget Tracker

NALSD · LinkedIn reliability tracking

Design an SLO error budget tracker for LinkedIn-scale services. Budget calculation, burn-rate alerts, multi-window detection, and automated policy enforcement.

SLOs Error Budget Burn Rate Multi-Window Policy

Read the design →

](/docs/nalsd/nalsd-slo-tracker)[

🐦

## Canary Deployment Controller

NALSD · LinkedIn safe deployments

Design a canary deployment controller for progressive rollouts. Traffic shifting, automated rollback, metric analysis, and multi-stage promotion gates.

Canary Progressive Rollout Rollback Traffic Shifting Metrics

Read the design →

](/docs/nalsd/nalsd-canary-controller)[

🧠

## AI Anomaly Detection Platform

NALSD · LinkedIn ML-powered observability

Design an AI-driven anomaly detection platform. Statistical and ML models, real-time streaming analysis, adaptive thresholds, and automated root cause correlation.

ML Models Streaming Adaptive Thresholds Root Cause Real-Time

Read the design →

](/docs/nalsd/nalsd-anomaly-detection)[

⚡

## Global Distributed Cache

NALSD · LinkedIn caching infrastructure

Design a global distributed cache for LinkedIn-scale reads. Consistent hashing, replication strategies, cache invalidation, hot-key mitigation, and multi-datacenter topology.

Consistent Hashing Invalidation Hot Keys Multi-DC Replication

Read the design →

](/docs/nalsd/nalsd-distributed-cache)[

🚨

## Global Incident Response System

NALSD · LinkedIn incident management

Design a global incident response system. Detection, escalation, war-room coordination, communication, post-mortem automation, and cross-datacenter failover orchestration.

Detection Escalation War Room Post-Mortem Failover

Read the design →

](/docs/nalsd/nalsd-incident-response)[

📈

## Time Series Database (TSDB)

NALSD · LinkedIn metrics storage

Design a time series database for LinkedIn-scale metrics. Write-optimized storage, downsampling, retention tiers, query engine, and compaction strategies.

Time Series Downsampling Compaction Retention Write-Optimized

Read the design →

](/docs/nalsd/nalsd-tsdb)[

🔗

## Distributed Hash Table

NALSD · LinkedIn DHT infrastructure

Design a distributed hash table for LinkedIn-scale key-value lookups. Consistent hashing, virtual nodes, replication, membership protocol, and failure recovery.

Consistent Hashing Virtual Nodes Replication Gossip Protocol Failure Recovery

Read the design →

](/docs/nalsd/nalsd-dht)[

🌐

## Global Multi-Tenant DNS

NALSD · LinkedIn DNS infrastructure

Design a global, multi-tenant DNS service. Anycast edge, authoritative tiers, AXFR/IXFR replication, tenant isolation, DNSSEC, DDoS defense, and 10 failure scenarios with recovery playbooks.

Anycast BGP DNSSEC Multi-Tenant DDoS Raft

Read the design →

](/docs/nalsd/nalsd-global-multi-tenant-dns)[

🖥

## Autonomous Bare Metal Lifecycle

NALSD · Hardware fleet management

Design an autonomous bare metal lifecycle system for global data centers. Discovery, PXE provisioning, SKU verification, GPU enumeration, self-healing remediation, immutable infrastructure, and split-brain prevention across sites.

BMC / Redfish PXE HRS Self-Healing IPMI GPU

Read the design →

](/docs/nalsd/nalsd-bare-metal-lifecycle)
