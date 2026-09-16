---
title: "Autonomous Bare Metal Lifecycle"
slug: /nalsd/nalsd-bare-metal-lifecycle
sidebar_position: 13
sidebar_label: "Autonomous Bare Metal Lifecycle"
description: "Autonomous Bare Metal Lifecycle"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/nalsd-bare-metal-lifecycle/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

Complete visual guide — the full interview module: end-to-end lifecycle, the five layers, discovery orchestration, PXE & imaging, validation, GPU discovery, metrics, SKU management, remediation, self-healing, immutable infra, firmware, config, supply chain, compliance, split-brain, catastrophic recovery, and cloud/hybrid. 7 diagrams.

**Contents**

-   [**★ Advanced Prompts — Answer Map**](#answermap)
-   [↳ Edge Case Follow-ups](#answermap)
-   [0 · Scenario & the One Job](#scenario)
-   [1 · Overview & Flow Walkthrough](#overview)
-   [2 · Full Lifecycle — PO to Production](#flow)
-   [3 · The State Machine](#states)
-   [4 · The Five Layers + Control Plane](#layers)
-   [5 · Layer 1 — Discovery & Inventory](#discovery)
-   [6 · Who Initiates Discovery](#orchestration)
-   [7 · Asset DB — Why PostgreSQL](#assetdb)
-   [8 · PXE Boot — What & Where](#pxe)
-   [9 · Image Build & Distribution](#image)
-   [10 · Post-Boot Validation](#postboot)
-   [11 · GPU Discovery](#gpu)
-   [12 · Metrics Catalog by Layer](#metrics)
-   [13 · SKU Management & Spare Pool](#sku)
-   [14 · Node Profiles & Per-SKU Tuning](#profiles)
-   [15 · Remediation & Reintegration](#remediation)
-   [16 · Self-Healing Architecture](#selfheal)
-   [17 · Immutable Infrastructure](#immutable)
-   [18 · Firmware Updates & Decommissioning](#firmware)
-   [19 · Configuration Consistency](#config)
-   [20 · Supply Chain Risk](#supply)
-   [21 · Regulatory Compliance & Audit](#compliance)
-   [22 · Split-Brain Between Sites](#splitbrain)
-   [23 · Catastrophic Recovery](#catastrophe)
-   [24 · Cloud / Hybrid Integration](#cloud)
-   [25 · Architectural Heterogeneity](#hetero)

## ★ Advanced Prompts — Answer Map {#answermap}

The interview module is built around a fixed set of advanced prompts. The 26 sections below are the raw material; **this map groups them by the question they answer**, so each prompt has a clear reading path. Every prompt is covered — most by several sections working together.

How to use this

For each prompt: read the **primary** section first (it carries the core answer), then the **supporting** sections for depth and the details an interviewer will probe. The one-line answer under each is the 15-second version to lead with.

##### Q1 · Self-healing — automatic detection & remediation of hardware faults

Primary: [16 · Self-Healing Architecture](#selfheal) · [15 · Remediation & Reintegration](#remediation)

Supporting: [12 · Metrics Catalog](#metrics) (detection signals) · [10 · Post-Boot Validation](#postboot) (the re-check) · [3 · State Machine](#states) (the repair loop)

Closed loop: detect → decide → act → validate, with bounded blast radius — concurrency caps, cooldowns, kill switch, escalation. Nothing is fire-and-forget.

##### Q2 · Immutable infrastructure & re-provisioning at scale

Primary: [17 · Immutable Infrastructure](#immutable)

Supporting: [9 · Image Build & Distribution](#image) · [8 · PXE Boot](#pxe) · [19 · Configuration Consistency](#config) (drift agents enforce declared state)

The disk is disposable — we reimage, never `apt upgrade` in place. Re-provisioning is safe any time; cohorted rollouts (1%→5%→25%→100%) gated on SLO telemetry.

##### Q3 · Secure, auditable firmware/BIOS updates & hardware decommissioning

Primary: [18 · Firmware Updates & Decommissioning](#firmware)

Supporting: [20 · Supply Chain Risk](#supply) (attestation) · [21 · Compliance & Audit](#compliance) (the audit trail) · [9 · Image Build](#image) (signed-artifact trust chain)

Firmware is the highest-risk op — cohort policy + TPM attestation gate every flash. Decommission = NIST 800-88 crypto-erase, BMC reset, signed audit entry, certificate of destruction.

##### Q4 · Consistency of configuration & state across thousands of servers and multiple sites

Primary: [19 · Configuration Consistency](#config) · [22 · Split-Brain Between Sites](#splitbrain)

Supporting: [7 · Asset DB](#assetdb) (the source of truth) · [14 · Node Profiles](#profiles) (SKU+role resolution) · [23 · Catastrophic Recovery](#catastrophe)

Declared state is the truth, observed state is the lie. Git → compiled per node → pull-based agents → drift detection. Cross-site state: leased ownership + quorum, CRDTs for tolerant fields.

##### Q5 · Hardware supply chain risk — counterfeit components, firmware tampering

Primary: [20 · Supply Chain Risk](#supply)

Supporting: [13 · SKU Management](#sku) (component verification table) · [18 · Firmware](#firmware) (TPM/PCR, Secure Boot) · [2 · Lifecycle](#flow) Phase 2 (receiving gate)

Every component's serial + firmware hash checked against a signed vendor manifest at receiving — mismatch = quarantine. Continuous TPM attestation catches tampering post-deploy.

##### Q6 · Designing for regulatory compliance, data sovereignty & audit

Primary: [21 · Regulatory Compliance & Audit](#compliance)

Supporting: [7 · Asset DB](#assetdb) (region tags) · [22 · Split-Brain](#splitbrain) (per-region storage) · [18 · Firmware](#firmware) (right-to-erasure)

Hard region/jurisdiction tags + scheduler-enforced locality. Append-only hash-chained audit log, per-region, 7-year retention. Continuous compliance scans; break-glass access only.

##### Q7 · Handling heterogeneous hardware

Primary: [13 · SKU Management](#sku) · [14 · Node Profiles](#profiles) · [25 · Architectural Heterogeneity](#hetero)

Supporting: [5 · Discovery](#discovery) + [6 · Discovery Controller](#orchestration) (detect what the hardware is) · [11 · GPU Discovery](#gpu)

Two axes: *config* heterogeneity (SKUs, per-SKU tuning profiles) and *architectural* heterogeneity (x86/ARM, mixed GPU vendors, iDRAC/iLO/OpenBMC) — abstracted behind per-arch images and a uniform Redfish layer.

##### Q8 · Dynamic scaling — adding/removing racks, sites, entire regions

Primary: [13 · Spare Pool](#sku) · [22 · Split-Brain Between Sites](#splitbrain)

Supporting: [4 · The Five Layers](#layers) · [24 · Cloud / Hybrid](#cloud) · [5 · Discovery](#discovery) (new racks self-enroll)

New racks self-enroll via discovery; new sites stand up an autonomous control plane and join quorum; the warm spare pool absorbs demand. Cloud is "just another site" in the asset DB.

Coverage summary

All eight advanced prompts are fully covered. Q1–Q6 map onto dedicated sections written for exactly that question. Q7 originally had a soft spot — config heterogeneity was strong, but *architectural* heterogeneity (ISA, BMC vendor, accelerator vendor) was thin — so **[§25](#hetero)** was added to close it. Q8 is answered by composition rather than one section: spare pool + split-brain + discovery + cloud together.

### Edge Case Follow-ups

Beyond the main prompts, interviewers probe three edge cases — the failure modes that separate a design that works on the happy path from one that survives a bad day. Each already has a dedicated section; this is the reading path.

##### E1 · How does the system handle "split-brain" between sites?

Primary: [22 · Split-Brain Between Sites](#splitbrain)

Supporting: [7 · Asset DB](#assetdb) (CRDT / last-writer-wins fields) · [23 · Catastrophic Recovery](#catastrophe) (network-partition recovery)

Every server has exactly one owner via a TTL-leased lock in a quorum store. Cross-site changes need a majority vote (3 regions + 1 witness). A partitioned minority simply can't out-vote the others — so two sites never claim the same server.

##### E2 · How do you recover from a catastrophic provisioning-system failure? (DB corruption, network partition)

Primary: [23 · Catastrophic Recovery](#catastrophe)

Supporting: [7 · Asset DB](#assetdb) (backups) · [9 · Image Build](#image) (multi-region registry + per-rack cache) · [5 · Discovery](#discovery) (state reconstruction by re-discovery)

Layered fallback: 15-min cross-region asset-DB backups, multi-region image registry with per-rack caches, 2+ PXE servers per rack, out-of-band BMC break-glass, and full Layer 1 re-discovery if the DB is gone entirely. Recovery is sequenced; the control plane must never depend on what it provisions.

##### E3 · How do you integrate with cloud or hybrid environments?

Primary: [24 · Cloud / Hybrid Integration](#cloud)

Supporting: [7 · Asset DB](#assetdb) (unified schema, `provider` field) · [19 · Config Consistency](#config) (same agent both tiers) · [25 · Architectural Heterogeneity](#hetero) (uniform Provision API)

Cloud is just another "site" in the asset DB — same schema, `provider=aws|gcp|azure|baremetal`, same labels. Cloud-init replaces PXE behind a uniform Provision API; the same config agent runs on both. Drift detection, audit, and scheduling then work identically across tiers.

Why these three get asked

They each attack a different assumption. **E1** attacks "the control plane is consistent" — what if the network splits it? **E2** attacks "the source of truth exists" — what if the database is gone? **E3** attacks "all hardware is bare metal we own" — what if half the fleet is rented? A complete design has an answer for each; this guide's §22–§25 are those answers.

## 0 · Scenario & the One Job {#scenario}

The interview scenario

"Design an autonomous bare metal lifecycle management system for globally distributed data centers. The system must minimize human intervention, handle heterogeneous hardware, and support dynamic scaling — adding/removing racks, sites, or entire regions."

Strip away the detail and the system has **one job**: turn a physical server in a rack into a productive member of a fleet — and keep it that way — without humans in the loop. Five layers do the heavy lifting; a global control plane orchestrates them across regions; an immutable audit log captures every action.

The big picture — what the whole system is for

<img src="/diagrams/nalsd-bare-metal-lifecycle/1.svg" alt="nalsd-bare-metal-lifecycle diagram 1" class="doc-diagram" />

## 1 · Overview & Flow Walkthrough {#overview}

A new server arrives at a data center. It is racked, cabled to two switches (production + management), and powered on. Within an hour it should be running production workloads. The flow:

-   **Discovery** — the server's BMC DHCPs onto the management VLAN. Layer 1 detects the new IP, pulls FRU data over IPMI/Redfish, captures LLDP from the switch port, and writes the asset to the inventory DB. Now we know: serial, model, NIC count, GPU count, rack location.
-   **Provisioning** — the inventory DB enqueues a provisioning job. Layer 2 sends an IPMI command to PXE-boot the host, wipes disks, lays down a GPT partition table, installs the golden OS image, joins the cluster.
-   **Configuration** — Layer 3 picks up the new node. Based on its SKU and assigned role, it applies sysctl tuning, kernel modules, and agent config from Git-versioned hieradata.
-   **Monitoring** — agents report. Layer 4 runs OBHC checks, emits 100+ metrics, watches kernel events, monitors GPUs.
-   **Remediation** — when monitoring flags a fault, Layer 5 cordons, drains, reimages or routes for hardware repair, validates, and reintegrates — or files an RMA.

The control plane runs **active-active across regions**. Every action is logged to an immutable, signed audit trail.

## 2 · Full Lifecycle — From Purchase Order to Production Workload {#flow}

The full lifecycle of a physical server — every step, every handoff, every gate — from the moment it's ordered to the moment it's running production pods, and what happens when it breaks.

The 8-phase lifecycle — from purchase order to production workload

<img src="/diagrams/nalsd-bare-metal-lifecycle/2.svg" alt="nalsd-bare-metal-lifecycle diagram 2" class="doc-diagram" />

### Phase 1 — Procurement & Receiving

-   **Purchase order created** — Capacity planning determines need (e.g. "200 GPU nodes for ML training cluster in LTX1"). PO specifies exact SKU: CPU model + stepping, DIMM count + speed, NIC model, GPU model, disk config, BMC firmware version.
-   **Vendor ships hardware** — Vendor attaches a signed manifest listing every component's serial number, firmware hash, and VBIOS hash. Imported into the Asset DB *before* the hardware arrives.
-   **Receiving dock intake** — Rack tech scans chassis barcodes, verifies count against PO. Each server gets a physical asset tag. Staged in a receiving area, NOT placed into production racks yet.
-   **Racking & cabling** — Servers placed into designated rack slots per the DC floor plan. Two network cables: (a) management NIC → management switch (out-of-band), (b) production NIC(s) → production TOR switch. Power to redundant PSUs (A+B feeds).
-   **Power on** — The BMC boots first (independent of the host OS) and DHCPs onto the management VLAN. The host has no OS on disk — it sits in PXE boot mode.

### Phase 2 — Hardware Discovery & SKU Verification

-   **BMC detected on management VLAN** — The discovery service sees the new DHCP lease. It queries the BMC via IPMI/Redfish: serial number, model, FRU data, firmware versions, GPU presence, NIC MACs.
-   **LLDP topology mapping** — The management switch reports which port the server is on via LLDP. Maps the server to rack ID, row, DC, TOR switch — without any human input.
-   **SMBIOS/DMI deep scan** — A lightweight probe image is PXE-booted to run `dmidecode`, `lshw`, `lspci`: exact CPU model + steppings, DIMM serials + capacity + speed, PCIe slot population, disk models + firmware, GPU models + VBIOS hashes.
-   **SKU verification against PO** — Every discovered component compared against the vendor's signed manifest. CPU model matches? All 16 DIMMs present at correct speed? NIC firmware on approved list? GPU VBIOS hash matches NVIDIA's signed list? BMC firmware hash on internal allowlist?
-   **Gate: verification pass or quarantine** — ALL match → proceed to certification. ANY mismatch → *quarantine*: alert procurement, hold for human review, possible counterfeit investigation. Three-strike rule: 3 mismatches from same vendor batch → escalate to vendor account manager.
-   **Asset DB record created** — Server is now a first-class entry: serial, SKU, location, all component serials, firmware versions, lifecycle state = `discovered`, timestamp, PO reference.

### Phase 3 — Performance Certification

-   **Server joins certification cluster** — An isolated, non-production cluster owned by Performance Engineering. PXE-booted with a certification image (golden OS + full benchmark suite).
-   **Automated benchmark suite runs** — unattended, in sequence:
    -   CPU: SPEC CPU2017 (integer + floating point)
    -   Memory: STREAM (bandwidth), HPL (Linpack) — DIMM speed and NUMA locality
    -   Disk: fio (random read/write IOPS, sequential throughput, latency)
    -   Network: iperf3 (TCP/UDP throughput), RDMA bandwidth test (if InfiniBand/RoCE)
    -   GPU: DCGM diagnostics (level 2 stress), NCCL all-reduce benchmark, memory bandwidth test
-   **Results compared against known-good envelope** — Each SKU has a performance envelope: the median ±5% from a population of previously certified peers. All within → PASS. Any outside → FAIL.
-   **Gate: certification pass or triage** — PASS: Asset DB updated with `perf_certified=true`, certification ID, image hash, benchmark results. FAIL: held for triage (reseat RAM, update firmware, replace suspect disk). Three certification failures → file RMA.

### Phase 4 — Spare Pool

-   **Server enters warm spare pool** — The certified server is rebooted, BMC stays reachable, but no OS is running (or a minimal standby image). Asset DB state = `spare`. Tagged with verified SKU, region, rack, certification date.
-   **Spare pool inventory managed per SKU per region** — The capacity system maintains target spare counts (e.g. "keep 20 GPU-A100 spares in LTX1, 10 in LVA1"). Below target → new POs created. Spare servers are already racked, cabled, certified — ready to deploy in **minutes, not days**.

### Phase 5 — Deployment to Production

-   **Deployment triggered** — Either (a) capacity system auto-requests more nodes, (b) HRS needs a replacement for a failed node, or (c) ops manually requests scale-up. The orchestrator selects a spare matching the required SKU + region.
-   **PXE boot into production image** — The orchestrator sends an IPMI command to power-cycle the spare into PXE boot. DHCP directs it to TFTP, iPXE loads the golden OS image from the per-rack cache (or region mirror). Image signature verified before writing to disk.
-   **Disk wipe + OS install** — Disks securely erased (NIST 800-88). GPT partition table created: /boot (512MB), / (root, 50GB), /var (remaining SSD), /export (data disks if present). Golden image written, SHA256 verified, boot sector installed.
-   **First boot: OS + agents start** — systemd starts core services: kubelet, containerd, flannel (CNI), node-exporter, OBHC agent. The node is not yet schedulable.
-   **Configuration applied (Layer 3)** — Puppet/UCM agent runs on first boot. Pulls config from Git-versioned hieradata by SKU (→ kernel params, modules, GPU config), role (→ sysctl tuning, agent config), site (→ NTP, DNS). Config compiled server-side, delivered as complete files — no partial merges.
-   **Cluster join** — `kubeadm join` with a bootstrap token. Node labels applied: `node-pool=gpu-a100`, `rack=A12`, `sku=HGX-H100`, `topology.kubernetes.io/zone=ltx1-row3`. The node is cordoned (unschedulable) pending validation.

### Phase 6 — Post-Boot Validation

-   **Validation pipeline runs** — the same script used in both initial deployment AND post-remediation:
    -   Goss: declarative checks — filesystem structure, service running, ports listening, file permissions
    -   OBHC full suite: kubelet responding, containerd healthy, disk accessible, flannel running, NTP synced (<50ms offset), certificates valid, DNS resolving, kernel version correct (12+ checks)
    -   Disk smoke test: fio 15s random read/write — confirms expected IOPS
    -   Network reachability: ping upstream gateway, DNS resolution, iperf3 to rack target
    -   GPU diagnostics: `dcgmi diag -r 2` (if GPU SKU) — stress test, ECC check, NVLink validation
    -   Cluster health: `kubectl get node $(hostname)` shows Ready
-   **SKU-appropriate perf smoke test** — A 60–120 second subset of the full certification benchmark. Catches regressions like "disk at 70% of expected — bad SSD" or "GPU memory bandwidth dropped — thermal throttling".
-   **Gate: validation pass or hold** — ALL green → proceed. ANY fail → node stays cordoned in `recovering` state. Auto-retry once after 5 min. Second failure → alert on-call.

### Phase 7 — Production Ready

-   **Uncordon** — `kubectl uncordon $(hostname)` — the K8s scheduler can now place pods.
-   **Workload-aware ramp (optional)** — For the first 30 min, the node carries a label `capacity=low` limiting it to a subset of workloads. This soak period limits blast radius if validation missed a latent issue.
-   **Asset DB state = active** — Final state update: `discovered → certified → spare → provisioned → validated → active`. Full audit trail from PO to production.
-   **Continuous monitoring begins** — Layer 4 takes over: OBHC every 60s, AMF scrapes 100+ metrics every 15s, NPD watches kernel events, DCGM monitors GPU health.

### Phase 8 — Ongoing Lifecycle (Remediation Loop)

-   **Fault detected** — OBHC reports kubelet unresponsive, or AMF shows ECC error count climbing, or NPD detects a kernel panic, or DCGM reports XID 79 (GPU fallen off bus).
-   **HRS auto-remediates** — Cordon (no new pods) → Drain (evict pods, respect PDBs) → Diagnose (SEL, smartctl, edac) → Classify (software / firmware / hardware fault).
-   **Action based on classification**:
    -   **Software fault:** PXE reimage to golden image → Layer 3 config → validate → uncordon. ~15 min.
    -   **Firmware fault:** Redfish firmware flash → measured reboot → TPM attestation → validate → uncordon. ~30 min.
    -   **Hardware fault:** Auto-create RMA ticket → move server to `decommissioned` → pull replacement from spare pool → deploy replacement (back to Phase 5).
-   **Post-remediation validation** — Same validation pipeline as Phase 6. Only after ALL checks pass does the node return to service.
-   **Audit log entry** — detection timestamp, fault type, classification, action taken, validation results, time-to-recovery, any human approver if escalated.

## 3 · The State Machine {#states}

Every server moves through these states, tracked in the Asset DB. A server is always in exactly one state, and the rules say which state it can move to next.

The state machine — the happy path, the repair loop, and the two dead ends

<img src="/diagrams/nalsd-bare-metal-lifecycle/3.svg" alt="nalsd-bare-metal-lifecycle diagram 3" class="doc-diagram" />

| State | What's Happening | Who Owns It |
| --- | --- | --- |
| `ordered` | PO submitted, hardware in transit from vendor | Procurement |
| `received` | Hardware at DC receiving dock, not yet racked | DC Ops |
| `discovered` | Racked, powered on, BMC detected, components enumerated | Layer 1 (auto) |
| `verifying` | SKU verification against PO manifest running | Layer 1 (auto) |
| `quarantined` | SKU mismatch detected, held for human review | Procurement + Security |
| `certifying` | Running benchmark suite in isolated certification cluster | Perf Engineering (auto) |
| `spare` | Certified, idle, BMC reachable, ready to deploy in minutes | Capacity system |
| `provisioning` | PXE booting, imaging, OS install in progress | Layer 2 (auto) |
| `validating` | Post-boot checks + perf smoke test running | Layer 2/5 (auto) |
| `active` | Running production workloads, continuously monitored | Layer 4 (auto) |
| `cordoned` | Fault detected, marked unschedulable, no new pods | Layer 5 / HRS (auto) |
| `draining` | Evicting pods, waiting for graceful termination | Layer 5 / HRS (auto) |
| `recovering` | Reimage / firmware flash / repair in progress | Layer 5 / HRS (auto) |
| `decommissioned` | Crypto-erased, BMC reset, removed from fleet, RMA or recycled | DC Ops + Vendor |

## 4 · The Five Layers + Control Plane {#layers}

This is the architecture map. The original five layers are kept intact; SKU management and a spare pool are added as a parallel intake path before provisioning. Each layer has a single, simple job.

The five layers — plus the global brain and the audit log

<img src="/diagrams/nalsd-bare-metal-lifecycle/4.svg" alt="nalsd-bare-metal-lifecycle diagram 4" class="doc-diagram" />

## 5 · Layer 1 — Discovery & Inventory {#discovery}

Layer 1's job: find new servers and write down what they are and where they sit — with no human input.

| Component | What it does | Tools |
| --- | --- | --- |
| **BMC** | Baseboard Management Controller — a dedicated microcontroller on the server motherboard. Runs independently of the host CPU/OS, has its own NIC on the management VLAN. Provides remote power on/off, serial console, sensor reading, and firmware management even when the server is powered down. | Redfish API, OpenBMC, iDRAC, iLO, XCC |
| **IPMI** | Intelligent Platform Management Interface — a legacy protocol for talking to the BMC. Out-of-band commands: power cycle, read sensors, view System Event Log (SEL), set PXE boot order. Being replaced by Redfish. | ipmitool, ipmiutil, FreeIPMI |
| **BMC/IPMI scan** | Out-of-band query to every newly-DHCP'd management IP. Reads serial, model, FW version, FRU data without booting the OS. | ipmitool, Redfish, OpenBMC, iDRAC, iLO |
| **PXE boot probe** | Network-boots a tiny discovery image to enumerate hardware capabilities and validate NIC/BIOS before full provisioning. | iPXE, PXELINUX, MAAS, Tinkerbell |
| **LLDP topology** | Reads switch-port neighbour info to map every NIC to rack, row, DC. | lldpd, LLDP-MED, SNMP, Netbox auto-discovery |
| **SMBIOS/DMI** | Once a probe OS is up, reads detailed CPU, RAM DIMM, PCIe slot data from BIOS. | dmidecode, lshw, hwinfo, facter |
| **Asset DB** | Source of truth for every server's lifecycle state, location, ownership. | Netbox, GLPI, Ralph, ServiceNow CMDB |
| **GPU/NIC discovery** | Enumerates accelerators and smart NICs, verifies drivers and firmware. | nvidia-smi, lspci, ethtool, DCGM, mlxconfig |

## 6 · Who Initiates Each Discovery Step — The Discovery Controller {#orchestration}

A common interview question: "Who kicks off the scan? Is the BMC pushing data or is something pulling?" The answer: a single software service — the **Discovery Controller** — orchestrates everything. It runs on the management plane (not on the servers being discovered) and is event-driven.

Discovery orchestration — the controller initiates, the server just responds

<img src="/diagrams/nalsd-bare-metal-lifecycle/5.svg" alt="nalsd-bare-metal-lifecycle diagram 5" class="doc-diagram" />

#### Step-by-step: who initiates what

-   **1\. BMC/IPMI Scan — initiated by the Discovery Controller.** A new server is racked, cabled, powered on. Its BMC boots and sends a DHCP request. The DHCP server assigns an IP and logs the lease. The Discovery Controller watches DHCP lease events (relay logs, webhook, or polling). On a new MAC → it initiates an IPMI/Redfish query (`ipmitool ... fru print` or `GET /redfish/v1/Systems/1`). Results written to Asset DB. *The BMC doesn't push data anywhere — it's a passive responder. The Discovery Controller is the active initiator.*
-   **2\. PXE Boot Probe — initiated by the Discovery Controller via IPMI.** After the BMC scan gives basic info, deeper enumeration is needed (CPU stepping, DIMM serials, PCIe population, NVMe firmware). The controller sends IPMI commands to force-PXE-boot (`chassis bootdev pxe`, `power cycle`). The server boots a tiny discovery Linux into RAM, runs `dmidecode`/`lshw`/`lspci`/`nvidia-smi`, then HTTP-POSTs the full inventory back to the controller. *The controller never SSHes into the server — the probe image pushes data to the controller.*
-   **3\. LLDP Topology — nobody "initiates" it; the controller reads it.** LLDP is continuous and passive — every switch port broadcasts LLDP frames every 30s. The controller reads it either from the switch (SNMP / gNMI: "what's on port Eth1/23?") or from the probe image (`lldpctl`). The mapping: NIC MAC → switch → port → rack → row → DC. No human input.
-   **4\. SMBIOS/DMI — why the probe image is needed.** The BMC gives ~60% of the picture; SMBIOS/DMI (needs a booted kernel) gives 100%.

| Data Point | BMC Knows? | SMBIOS/DMI Knows? | Why It Matters |
| --- | --- | --- | --- |
| Server serial, model | Yes | Yes | Basic identity |
| Power state, temperatures | Yes | No (needs OS polling) | Remote monitoring |
| Exact CPU model + stepping | Sometimes (partial) | Yes (full detail) | Stepping matters — different microcode, different perf |
| DIMM serials + speed + slot mapping | Partial (count only) | Yes (per-slot) | Verify every DIMM against PO |
| PCIe slot population | No | Yes | Verify GPUs, NICs, NVMe in correct slots |
| NVMe disk firmware versions | No | Yes | Known-bad firmware causes data loss — must match allowlist |
| GPU model + VBIOS hash | No | Yes (via lspci + nvidia-smi) | VBIOS hash must match NVIDIA's signed list |
| NIC firmware version | No | Yes (via ethtool) | NIC firmware bugs cause packet drops at scale |

Interview answer

"The BMC is fast and works without booting the host, so we use it first for quick identity (serial, model). But for SKU verification — confirming every DIMM serial, GPU VBIOS hash, NVMe firmware version — we must boot a probe image and read SMBIOS/DMI tables. This two-phase approach (BMC scan → probe boot) minimizes time while maximizing coverage."

## 7 · Asset DB — Why PostgreSQL, Not NoSQL {#assetdb}

An interviewer will ask: "What database backs the Asset DB?" The answer is **relational (PostgreSQL)**, and the reasoning matters.

-   **The data is inherently relational.** A server belongs to a rack, a rack to a row, a row to a DC. A server has many components, each with their own serial/firmware. You need JOINs: "show me all servers in rack A12 with GPU firmware older than v535 that are currently active."
-   **Strong consistency is non-negotiable.** Two orchestrators must never provision the same spare simultaneously. You need ACID transactions with row-level locking (`SELECT ... FOR UPDATE`). NoSQL gives eventual consistency — two controllers could grab the same spare.
-   **The dataset is small.** Even at 1M servers × ~50 columns = a few hundred GB. Fits comfortably in a single PostgreSQL instance with read replicas. You never need NoSQL's horizontal write scalability.
-   **Complex queries are the primary access pattern.** "How many H100 spares in LTX1?" "Which servers failed certification twice this month?" — trivial in SQL, painful in NoSQL.

| Criteria | PostgreSQL | Cassandra / DynamoDB | MongoDB |
| --- | --- | --- | --- |
| ACID transactions | Yes | No (eventual consistency) | Yes (single-doc only) |
| Complex JOINs | Native, fast | No | Slow ($lookup) |
| Write throughput at 100K/s | No (needs sharding) | Yes | Yes |
| Asset DB fit | **Perfect** | Wrong model — overkill | Workable but unnecessary |

**What about the other data stores in this system?**

| Data Type | Best Store | Why |
| --- | --- | --- |
| Asset DB (servers, components, state) | **PostgreSQL** | Relational data, ACID for spare allocation, complex queries |
| Immutable audit log | **Kafka → S3/Parquet** | Append-only, partitioned by time, rarely queried interactively |
| Real-time metrics (OBHC, AMF) | **TimescaleDB or InfluxDB** | High write throughput, time-series compression, TTL expiry |
| Config lookup by hostname | **Redis / etcd** | Key-value, sub-ms latency, caching layer in front of Postgres |
| Benchmark results (certification) | **PostgreSQL (same DB)** | Relational — results linked to server serial, PO, SKU |

## 8 · PXE Boot — What It Is, Where Images Live {#pxe}

**PXE = Preboot eXecution Environment.** It's a network-boot protocol baked into the NIC firmware. When the server boots with no OS on disk (or BIOS configured to network-boot first), the NIC's PXE ROM kicks in: DHCP gets an IP and the location of a boot file, TFTP serves a tiny bootloader, and iPXE chain-loads the real kernel.

**Three classes of PXE images:**

-   **PXE bootloader** (`undionly.kpxe`, `ipxe.efi`) — the tiny image TFTP serves first. Built once, replicated to every site, served from per-rack TFTP servers.
-   **Discovery / probe images** — a stripped Linux used by Layer 1 to introspect hardware before full provisioning. Same distribution path as the bootloader.
-   **Golden OS images** — the production images actually installed on disks (1–5 GB). These live in an artifact registry replicated globally.

| Term | What It Is |
| --- | --- |
| **Redfish** | A modern RESTful API standard (DMTF) for server hardware management via the BMC. Replaces IPMI with JSON over HTTPS. Supports firmware updates, power control, inventory queries, event subscriptions. |
| **FRU** | Field Replaceable Unit — any component that can be swapped in the field (CPU, DIMM, disk, PSU, fan, NIC). Each has serial, part number, manufacturer data stored in the BMC's FRU inventory. |
| **DHCP** | Dynamic Host Configuration Protocol — assigns the server an IP and tells it where to find the TFTP server and boot file (via 'next-server' and 'filename' options). |
| **TFTP** | Trivial File Transfer Protocol — a simple UDP-based protocol (port 69) used to serve the initial bootloader binary. Small and stateless by design. |
| **iPXE** | An open-source PXE implementation that extends the original PXE ROM. Supports HTTP/HTTPS, scripting, DNS, and can chain-load kernels directly. |
| **initrd** | Initial RAM Disk — a temporary root filesystem loaded into memory alongside the kernel. Contains the installer, drivers, and scripts needed to set up the real OS. |
| **Kickstart / Cloud-init / Ignition** | Automated install / first-boot config systems. Kickstart (Red Hat), Cloud-init (multi-distro), Ignition (CoreOS/Flatcar — runs once on first boot, immutable by design). |
| **GPT** | GUID Partition Table — modern disk partition layout replacing MBR. Supports >2TB disks, up to 128 partitions, includes a backup partition table. |
| **SHA256** | A cryptographic hash. Used to verify image integrity — if even one bit of the image changes, the hash is completely different. |

## 9 · Image Build & Distribution Pipeline {#image}

Images are **first-class artifacts**: built by CI, signed, replicated, cached, verified at boot. The trust chain is end-to-end: source code in Git → CI builder → signing key → artifact registry → region cache → client-side signature check at install. Every link is verified cryptographically.

| Term | What It Is |
| --- | --- |
| **Packer** | HashiCorp tool that builds machine images from a template. Automates: start a VM/container, run provisioning scripts, capture the resulting disk as an image. Reproducible builds. |
| **SBOM** | Software Bill of Materials — a machine-readable list of every component (packages, libraries, firmware) in the image. Required for supply-chain auditing (SPDX or CycloneDX format). |
| **cosign** | A tool from the Sigstore project for signing and verifying images and artifacts. Keyless or key-based signing with transparency logs for tamper-proof provenance. |
| **GPG** | GNU Privacy Guard — asymmetric encryption. The build system signs with a private key; consumers verify with the public key. |
| **S3 / GCS / Ceph** | Object storage backends used as the global artifact registry for golden images, with built-in replication and versioning. |
| **Signed URLs** | Time-limited, cryptographically signed download URLs. The region mirror generates a URL valid for minutes — only authorized PXE clients can pull images. |
| **Per-rack cache** | Nginx or Squid HTTP proxy deployed in each rack. Caches the most-used images locally so PXE boot doesn't depend on cross-DC network. If the global registry is down, cached images still work. |

## 10 · Post-Boot Validation {#postboot}

After the OS is installed and the node has joined the cluster, you must **prove the server is fit for traffic** before the scheduler places pods on it. A layered validation pipeline:

-   **Goss** — declarative server testing, sub-second per check
-   **InSpec / Serverspec** — broader compliance (CIS, SOC2 baselines)
-   **OBHC** — On-Box Health Check daemon: kubelet, containerd, certificates, DNS, kernel version (12+ checks)
-   **fio** — disk IOPS smoke test
-   **iperf3** — network throughput against a fixed in-rack target
-   **dcgmi diag** — NVIDIA GPU diagnostics with multiple severity levels
-   **chrony** — NTP sync check, offset within 50 ms tolerance

One implementation, two callers

Reuse the *same script* in Layer 2 (initial provisioning) and Layer 5 (post-remediation). This keeps the definition of "healthy" identical for fresh nodes and recovered ones.

## 11 · GPU Discovery (and What the BMC Sees) {#gpu}

**Does the BMC see GPUs? Partially.** Modern BMCs that speak PLDM over SMBus/PCIe can enumerate GPUs and pull basic identity, firmware, and ECC counters via Redfish — without the host OS being up.

-   **What the BMC alone can see (no OS):** GPU presence, vendor, model, serial; GPU board firmware version; temperature, power draw, fan; ECC error counters.
-   **What the BMC cannot see — needs a running OS with drivers:** CUDA driver version, MIG slice configuration; NVLink/NVSwitch topology; per-process utilization; detailed performance counters.

| Tool | Purpose | Notes |
| --- | --- | --- |
| `nvidia-smi` | Quick status — name, memory, util, temp | Built into NVIDIA driver, baseline tool |
| `nvidia-smi -q` | Full hardware detail dump | Includes serial, VBIOS, ECC, NUMA |
| `NVML` | C/Python library for programmatic access | Foundation of most exporters |
| `DCGM` | Production-grade GPU monitoring daemon | Health checks, policies, profiling |
| `DCGM Exporter` | Prometheus exporter for DCGM | Standard for GPU clusters |
| `lspci -nn -d 10de:` | Bare PCI enumeration | Driver-independent, works pre-CUDA |
| `nvidia-fabricmanager` | NVLink / NVSwitch topology and health | Required on DGX/HGX |
| `GPU Operator` | K8s-native lifecycle for GPU stack | Driver, runtime, monitoring all-in-one |

## 12 · Metrics Catalog by Layer {#metrics}

Each layer emits its own counters, histograms, and alerts. This is the observability backbone — you can't run anything autonomously that you can't measure.

| Layer | Counters / Gauges | Histograms / SLIs | Alerts |
| --- | --- | --- | --- |
| **L1 Discovery** | servers\_discovered\_total, asset\_db\_writes\_total, lldp\_neighbours\_count, sku\_mismatch\_total | discovery\_duration\_seconds, time\_to\_first\_inventory\_seconds | SKU mismatch; rack with no LLDP neighbours |
| **L2 Provisioning** | provisioning\_attempts\_total, failures\_total, image\_pull\_bytes\_total, pxe\_boot\_count | provision\_duration\_seconds (P50/P95/P99), time\_to\_cluster\_join\_seconds | Failure rate >2%; P99 install >30 min |
| **L3 Config** | puppet\_runs\_total, puppet\_failures\_total, drift\_events\_total, compliance\_violations\_total | puppet\_run\_duration\_seconds, time\_since\_last\_successful\_run | Config drift >1% of fleet; agent silent >30 min |
| **L4 Health** | cpu\_seconds\_total, mem\_bytes, disk\_io\_bytes, ecc\_errors\_total, smart\_reallocated\_sectors, gpu\_xid\_errors\_total | load1, gpu\_temp\_c, gpu\_power\_watts, disk\_latency\_seconds | ECC double-bit; XID 79/48; fan failure; conntrack >80% |
| **L5 Remediation** | remediation\_attempts\_total, successes\_total, rma\_tickets\_total, reimage\_count\_per\_node | mttr\_seconds (P50/P95), drain\_duration\_seconds | Remediation rate >threshold (kill switch); MTTR regression |
| **Control Plane** | api\_requests\_total, etcd\_writes\_total, replication\_lag\_seconds, leader\_elections\_total | api\_request\_duration\_seconds, replication\_lag\_seconds (P99) | Replication lag >30s; leader churn; audit log gap |

## 13 · SKU Management & Spare Pool {#sku}

Hardware comes in classes — **SKUs** — and not every SKU is interchangeable. Spare pool management tracks this, certifies it, and gates deployment.

| Term | What It Is |
| --- | --- |
| **SKU** | Stock Keeping Unit — a specific hardware configuration (CPU model, RAM size, disk type, GPU type). E.g. 'R740-Compute-256GB' or 'HGX-H100-8GPU'. Different SKUs cannot substitute for each other. |
| **RMA** | Return Merchandise Authorization — returning defective hardware to the vendor. An RMA ticket tracks: defective serial, failure reason, replacement ETA, chain of custody. |
| **RCA** | Root Cause Analysis — investigating why a component failed. Manufacturing defect, firmware bug, thermal issue, or counterfeit part? Drives vendor accountability. |
| **Performance certification** | Running standardized benchmarks (CPU: SPEC, Memory: STREAM/HPL, Disk: fio, Network: iperf3, GPU: DCGM diag + NCCL) in an isolated cluster to verify the ±5% known-good envelope. |
| **Known-good envelope** | The acceptable performance range per SKU, derived from a population of certified peers. Outside ±5% of the median → flagged for triage. |
| **Warm spare pool** | Pre-certified servers powered on with BMC reachable but no OS running. Deploy in minutes vs. hours for cold stock. Tagged by SKU and region. |
| **Quarantine** | A holding state for servers that fail SKU verification or certification. Isolated, held for human review. Could indicate a counterfeit component or shipping damage. |
| **SPEC / STREAM / HPL / NCCL** | Benchmark suites: SPEC CPU2017 (CPU), STREAM (memory bandwidth), HPL/Linpack (compute + memory at peak — the TOP500 benchmark), NCCL (multi-GPU communication health). |

#### SKU Verification — Component Check

| Component | Read via | Matched against |
| --- | --- | --- |
| CPU model + steppings | Redfish `Processors` | PO CPU SKU |
| DIMM serials, capacity, speed | Redfish `Memory` + DMI | Vendor manifest |
| NIC model + firmware | Redfish `NetworkAdapters` | Approved NIC list |
| Disk serials | Redfish `Storage` + smartctl | Vendor manifest, anti-counterfeit list |
| GPU model + VBIOS hash | Redfish `Processors[GPU]` / nvidia-smi | NVIDIA-signed VBIOS hash list |
| BMC firmware hash | Redfish `UpdateService` | Internal allowlist |

## 14 · Node Profiles & Per-SKU Tuning {#profiles}

Tuning is the intersection of **SKU** (what the hardware is) and **role** (what we're using it for). Both come from Git, resolved declaratively at apply time. Resolution order — later overrides earlier:

`defaults → sku/<sku> → role/<role> → site/<site> → node/<hostname>`

| Sysctl | R740-Compute | R750xa-GPU-A100 | Storage-i4i |
| --- | --- | --- | --- |
| `vm.swappiness` | 10 | 0 | 1 |
| `vm.nr_hugepages` | 0 | 2048 (4 GB) | 0 |
| `vm.dirty_ratio` | 20 | 20 | 5 |
| `net.core.rmem_max` | 16 MB | 536 MB (RDMA) | 64 MB |
| `net.core.netdev_max_backlog` | 5,000 | 250,000 | 30,000 |
| `kernel.numa_balancing` | 1 | 0 (manual pinning) | 1 |

## 15 · Remediation & Reintegration {#remediation}

When monitoring flags a fault, Layer 5 runs the cycle: **cordon → drain → diagnose → classify → fix → validate → uncordon**. Nothing is fire-and-forget.

| Term | What It Is |
| --- | --- |
| **Cordon** | `kubectl cordon` — marks a node unschedulable. Existing pods keep running but no new pods are placed. First step in safe remediation; reversible. |
| **Drain** | `kubectl drain` — evicts all pods, respecting PodDisruptionBudgets. Waits for graceful termination. The node must be empty before reimage/repair. |
| **PDB** | PodDisruptionBudget — limits how many pods of a set can be down simultaneously. Prevents drain from evicting too many replicas at once. |
| **SEL** | System Event Log — stored in the BMC, records hardware events: temperature warnings, power faults, ECC errors, fan failures. Readable even when the OS is down. |
| **smartctl** | Reads SMART data from disks — reallocated sectors, pending sectors, temperature, power-on hours. Predicts disk failure before it happens. |
| **edac** | Error Detection and Correction — Linux kernel subsystem tracking memory ECC errors. Single-bit corrected silently; double-bit (uncorrectable) crashes the process or kernel. |
| **Redfish UpdateService** | A RESTful API endpoint on the BMC for firmware updates. POST pushes a firmware image; the BMC verifies its signature and flashes it. |
| **HRS** | Host Remediation Service — the automated remediation system. Coordinates the full cordon → drain → fix → validate → uncordon cycle with concurrency limits and safety gates. |
| **Uncordon** | `kubectl uncordon` — removes the unschedulable mark. Only done after post-boot validation passes. |

#### How a Node Returns After Remediation

-   Node has been reimaged (or firmware flashed). Boot succeeds.
-   Layer 3 reapplies configuration automatically — the agent runs on first boot, pulling its profile by SKU + role.
-   Post-boot validation runs. If any check fails, the node is held in `recovering` state and re-cordoned.
-   SKU-appropriate perf smoke test (60–120s subset of the certification suite) catches latent regressions.
-   HRS sets the node state to `ready`. `kubectl uncordon` issued. Scheduler can place pods.
-   Workload-aware ramp — labels like `capacity=low` stay for a soak period (30 min) to limit blast radius.
-   Audit log entry written: detection, classification, action, validation results, TTR, any human approver.

## 16 · Self-Healing Architecture {#selfheal}

The pattern: **closed-loop control with bounded blast radius**. Detect → Decide → Act → Validate — with strict safety limits.

The self-healing loop — detect, decide, act, validate — with safety limits

<img src="/diagrams/nalsd-bare-metal-lifecycle/6.svg" alt="nalsd-bare-metal-lifecycle diagram 6" class="doc-diagram" />

-   **Detection** runs on every node (OBHC, NPD, AMF, DCGM) plus regional aggregators that watch for cross-node patterns.
-   **Decision** happens in the regional HRS controller, using rate-limited, idempotent state machines. Each node has a state in {healthy, suspect, cordoned, draining, recovering, ready, decommissioned}.
-   **Action** is taken with concurrency caps — never reimage more than X% of a cluster, never more than Y% of a single AZ in Z minutes.
-   **Validation** is mandatory after every action. No fire-and-forget.
-   **Escalation** — after N automated remediation attempts, escalated to humans. Kill switch is automatic.

| Failure Mode | Mitigation |
| --- | --- |
| **Flapping** — node oscillates between healthy/unhealthy | Cooldown timers, hysteresis, fault counters that decay slowly. After 3 round-trips in 24h, hold for human review. |
| **Cascading remediation** — bad config rolls out, every node fails, HRS reimages all | Canary remediation, quorum locks per AZ, kill-switch at 1% fleet/hour, image rollouts gated on Goss + SLO probes. |
| **Silent failures** — node looks healthy but corrupts data | Workload-level checksums, randomized end-to-end probes, NPD with custom synthetic probes, periodic forced re-validation. |

## 17 · Immutable Infrastructure at Scale {#immutable}

Three principles:

-   **The disk is disposable.** Anything that matters lives in Git, in the asset DB, or in the workload's own state store.
-   **We do not `apt upgrade` in place. We reimage.** Configuration is enforced by drift agents back to declared state.
-   **Re-provisioning a node is safe at any time.** The provisioning rate is the only thing humans cap.

#### How Re-provisioning at Scale Works

-   New golden image built by CI, signed, pushed to image registries.
-   Rollout policy declared as data: `cohort = 1%`, `soak = 24h`, `exit_criteria = no SLO regression`.
-   HRS picks 1% of cluster, cordons, drains, reimages, re-validates, returns to service.
-   SLO telemetry compared against baseline. Green → 5% → 25% → 100%. Red → halt, roll back.
-   Audit log captures every node, every image hash, every decision.

## 18 · Firmware / BIOS Updates & Decommissioning {#firmware}

Firmware updates are the highest-risk operation in the fleet — a bad flash can brick hardware. They are rolled out with attestation and cohort policies.

| Term | What It Is |
| --- | --- |
| **TPM** | Trusted Platform Module — a dedicated security chip that stores cryptographic keys and performs measured boot. PCR values capture a hash of each boot stage. |
| **PCR** | Platform Configuration Registers — slots inside the TPM that accumulate hash measurements of firmware, bootloader, kernel, config. Comparing against known-good values detects tampering. |
| **Measured boot** | Each boot component measures the next component's hash into TPM PCRs before executing it. A tamper-evident chain — any modification changes the PCR values. |
| **Remote attestation** | A server sends its TPM PCR values to an attestation server, compared against known-good golden values for that SKU. Pass = trusted. Fail = quarantine for forensics. |
| **UEFI Secure Boot** | A firmware feature that only allows booting kernels/bootloaders signed by trusted keys. Prevents rootkits and unauthorized OS from loading. |
| **Cohort policy** | Firmware rollout strategy: start with 0.1% of fleet (canary), soak for SLO validation, expand to 1%, 10%, fleet-wide. Auto-halts if any SLO regresses. Prevents fleet-wide bricking. |
| **PSID revert** | Physical Security ID revert — a factory-reset for self-encrypting drives. Destroys the encryption key, making all data irrecoverable. Used for instant crypto-erase at decommissioning. |
| **NIST 800-88** | NIST guidelines for media sanitization. 'Purge' level means data is irrecoverable even with lab equipment. SSDs use crypto-erase or block-erase; HDDs use multi-pass overwrite. |

#### Hardware Decommissioning

-   Drain workloads gracefully (PDB-respecting).
-   Cryptographic erase of all storage to NIST 800-88 purge level (SSDs: `blkdiscard` or vendor crypto-erase; HDDs: `nwipe`; self-encrypting drives: PSID revert).
-   BMC factory reset; remove from management network ACL.
-   Asset DB transitions to `decommissioned`; ownership chain-of-custody record created.
-   Physical removal: rack tech scans chassis serial out of the rack scanner.
-   Audit log entry signed; certificate of destruction archived per regulatory retention.

## 19 · Configuration Consistency at Scale {#config}

The core principle

Declared state is the truth, observed state is the lie.

-   **Source of truth:** Git repos with required PR review and CI-tested changes.
-   **Compilation:** hieradata/template engine resolves declared state per node from SKU + role + site hierarchy.
-   **Distribution:** pull-based agents (Puppet, Salt minion) — pull avoids push-cascade failures across thousands of nodes.
-   **Drift detection:** every divergence emits an event. Below threshold = auto-remediate. Above = page on-call.
-   **Rollouts:** never global. Always cohorted with auto-halt on metric regression.
-   **Convergence visibility:** a dashboard shows per cohort the % of nodes that applied the latest config in the last 30 minutes. Anything <99% is investigated.

## 20 · Supply Chain Risk {#supply}

-   **Vendor provenance** — only buy from authorized resellers; require an SBOM for firmware.
-   **Receiving verification** — every component's serial and firmware hash read via BMC, matched against vendor manifest. Mismatch = quarantine.
-   **Continuous attestation** — TPM-based remote attestation: at boot, the host reports PCR measurements; the attestation server compares to known-good golden values per SKU.
-   **Firmware monitoring** — Redfish-pulled firmware versions/hashes compared against internal allowlist; unexpected changes page on-call.
-   **Secure Boot** — UEFI Secure Boot enabled with custom platform key; only signed kernels accepted.
-   **Physical security** — tamper-evident seals, intrusion sensors via BMC (chassis open detection), audited rack access.

## 21 · Regulatory Compliance & Audit {#compliance}

-   **Region tagging** — every server has a hard region/jurisdiction tag. Workloads carry sovereignty labels. The scheduler enforces locality.
-   **Audit trail** — append-only, hash-chained log of every action. Per-region storage. Each entry: timestamp, actor, action, target, before/after state, signed digest.
-   **Compliance scans** — OpenSCAP, kube-bench, Lynis run continuously. Reports stored per region with 7-year retention.
-   **Right-to-erasure** — disk wipe per NIST 800-88; certificates of destruction logged.
-   **Access control** — break-glass workflows; every BMC/Redfish call auditor-logged. SSH is short-lived OIDC certs only; root disabled.

## 22 · Split-Brain Between Sites {#splitbrain}

The system runs across many data centers with **no central boss** — each site runs its own control plane and owns its own servers (active-active). The danger is "split-brain": two sites both thinking they own the same server. The fix is leased ownership plus a quorum vote.

Many sites without a single point of failure — leased ownership + majority vote

<img src="/diagrams/nalsd-bare-metal-lifecycle/7.svg" alt="nalsd-bare-metal-lifecycle diagram 7" class="doc-diagram" />

| Term | What It Is |
| --- | --- |
| **Active-active** | All regions run their own control plane simultaneously and can accept writes. No single 'primary' — each region is the authority for its own servers. |
| **Leased ownership** | Each server is 'owned' by one region via a time-limited (TTL) lock. The owning region can write to that server's record. Ownership transfer requires a quorum vote — prevents two regions claiming the same server. |
| **TTL** | Time To Live — the lease duration for server ownership. If the owning region doesn't renew within the TTL (e.g. due to a network partition), the lock expires and another region can claim ownership via quorum. |
| **Quorum** | A majority vote needed for cross-region operations. With 3 regions + 1 witness, quorum = 3 of 4. Prevents split-brain — no partitioned minority can make authoritative changes. |
| **Witness region** | A small, stateless arbiter in a separate availability zone (often a different cloud provider). Participates in quorum votes but doesn't own servers. Breaks ties. |
| **CRDT** | Conflict-free Replicated Data Type — a data structure that can be updated independently on multiple replicas and always converges. Used for asset DB fields that tolerate eventual consistency. |
| **Last-writer-wins** | A conflict resolution strategy where the most recent write (by timestamp + region priority) wins during reconciliation after a partition heals. Simple but can lose writes — acceptable for non-critical metadata. |
| **Federation** | Connecting multiple independent K8s clusters so workloads can be managed across them. Karmada / Cluster API provide a unified control plane while clusters stay autonomous during partitions. |

| Risk | Mitigation |
| --- | --- |
| Control-plane split-brain | Every server has a primary owner region. Ownership is a TTL-leased lock in a quorum store. Cross-region ops require a quorum vote. |
| Asset DB split | Globally unique asset IDs; per-asset CRDT or last-writer-wins-with-region-priority. A reconciliation job re-converges after a partition heals. |
| Workload scheduler split | Per-region scheduler is default. Cross-region scheduling via federation with lease-based locks. PDBs are per-region. |

## 23 · Catastrophic Recovery {#catastrophe}

Worst case: provisioning DB corrupted, image registry unavailable, control plane offline.

-   **Backups** — asset DB backed up every 15 min to immutable cross-region object storage (S3 Object Lock). Restore tested monthly.
-   **Image registry** — multi-region replication; per-rack caches let provisioning continue even if the primary registry is down.
-   **PXE infrastructure** — at least 2 PXE/TFTP servers per rack; failure of one is invisible to clients.
-   **Out-of-band recovery** — even if the control plane is down, BMCs are reachable. A break-glass `ipmitool`/Redfish runbook lets a small team manually re-PXE a fleet.
-   **State reconstruction** — if the asset DB is gone entirely, full Layer 1 re-discovery over the management network rebuilds it. Slow but possible.
-   **Game days** — quarterly exercises that pull plugs, partition networks, drop databases, verify recovery within RTO.
-   **Recovery sequencing** — (1) restore audit log readability, (2) restore asset DB read-only, (3) restore image registry, (4) bring PXE back, (5) flip asset DB to read-write, (6) resume HRS in dry-run mode for 24h.

The anti-pattern

A control plane that depends on something it provisions. The control plane must bootstrap from cloud/cold-standby infrastructure that needs zero help from the control plane — otherwise full recovery is impossible.

## 24 · Cloud / Hybrid Integration {#cloud}

-   **Asset DB unified.** Cloud instances are first-class entries with `provider=aws|gcp|azure|baremetal` and region tags. Same schema, same labels.
-   **Provisioning abstraction.** Cloud nodes use cloud-init + AMI equivalents instead of PXE; the control plane sees a uniform Provision API.
-   **Configuration management.** Same Puppet/Ansible/Salt agent runs on both bare-metal and cloud. Profiles include cloud-aware variants.
-   **Federated cluster control.** Cluster API or Karmada handles multi-cluster orchestration; same labels and policies apply.
-   **Cost-aware scheduling.** Workload placement considers $/perf, sovereignty, and latency. Bare metal for steady state; cloud for burst, dev/test, and DR.
-   **Disaster recovery cross-tier.** A bare-metal region's loss can fail over (degraded) to cloud capacity standing warm.

The unifying idea

Cloud is just another "site" in the asset DB. Once that's true, everything else — drift detection, compliance scans, audit, scheduling — falls out for free.

## 25 · Architectural Heterogeneity {#hetero}

The scenario demands the system "handle heterogeneous hardware." Earlier sections cover **configuration** heterogeneity well — [SKUs](#sku), [per-SKU tuning profiles](#profiles), role-based config. This section closes the harder gap: **architectural** heterogeneity, where the differences are deep enough to need different images, different drivers, or different management code paths.

### Three axes of architectural difference

| Axis | The variation | Where it bites |
| --- | --- | --- |
| **CPU ISA** | x86-64 (Intel/AMD) vs ARM64 (Ampere, Graviton-class, NVIDIA Grace) | Golden image is ISA-specific — a single image cannot boot both. Kernel, bootloader, every binary differs. |
| **Accelerator vendor** | NVIDIA vs AMD (Instinct) vs Intel (Gaudi) — different drivers, different diagnostics, different telemetry | `nvidia-smi`/DCGM only speak NVIDIA. AMD needs `rocm-smi`; Intel needs `hl-smi`. Validation and monitoring must branch. |
| **BMC implementation** | Dell iDRAC vs HPE iLO vs OpenBMC vs Lenovo XCC — same concepts, different quirks and partial Redfish coverage | Discovery and firmware flows hit vendor-specific Redfish gaps; some still need IPMI fallback. |

### How the system absorbs each one

-   **ISA — branch at PXE, not in the image.** The [Discovery Controller](#orchestration) reads CPU architecture from the SMBIOS/DMI probe *before* provisioning. The provisioning job selects the matching per-arch golden image (`golden-x86_64` / `golden-arm64`) from the artifact registry. Images are built per-arch by the same CI pipeline, signed with the same key, share the same SBOM structure — the trust chain is identical, only the binaries differ. The asset DB carries an `arch` field; Kubernetes node labels (`kubernetes.io/arch`) let the scheduler place arch-specific workloads correctly.
-   **Accelerator vendor — a pluggable validation/telemetry interface.** [Post-boot validation](#postboot) and [Layer 4 monitoring](#metrics) call a vendor-abstracted "GPU check" interface, not `dcgmi` directly. Each vendor has an adapter (NVIDIA → DCGM, AMD → ROCm SMI, Intel → Habana tools) that emits the same normalized metrics (`gpu_temp_c`, `gpu_ecc_errors_total`, `gpu_xid_errors_total` or its equivalent). The asset DB records `accelerator_vendor` + `accelerator_model`; the right adapter is chosen by SKU.
-   **BMC — Redfish first, capability-detected, IPMI as fallback.** All [discovery](#discovery) and [firmware](#firmware) code targets the Redfish standard. On first contact the controller probes which Redfish endpoints the BMC actually implements and records a capability profile per BMC model. Vendor quirks live in thin per-vendor shims, not scattered through the codebase. Where a BMC's Redfish coverage is incomplete, the shim falls back to `ipmitool` for that specific operation — the caller never sees the difference.

One principle holds it together: **detect the difference early, normalize it behind an interface, and keep the heterogeneity out of the control plane's core logic.** The asset DB carries `arch`, `accelerator_vendor`, and a `bmc_capability_profile` — and every downstream layer keys off those fields instead of hard-coding one vendor's tools.

Interview answer

"Heterogeneity splits into two kinds. *Configuration* heterogeneity — RAM size, disk layout, NIC model — is handled by SKUs and per-SKU tuning profiles resolved from Git. *Architectural* heterogeneity — ISA, GPU vendor, BMC implementation — is deeper: it needs per-arch golden images selected at PXE time, a pluggable GPU validation interface so monitoring isn't NVIDIA-only, and a Redfish-first BMC layer with capability detection and IPMI fallback. The unifying move is the same in all three cases: discover the difference during Layer 1, write it to the asset DB, and have every later layer branch on a data field — never hard-code a single vendor's assumptions into the control plane."

Common trap

Claiming "one universal golden image for everything." You cannot — an x86 image will not boot an ARM host. The honest, stronger answer is *one universal **pipeline*** producing a small, fixed set of per-arch images, all sharing the same build process, signing key, and validation suite.

* * *

Module 1 complete visual guide — the full Autonomous Bare Metal Lifecycle module: an Advanced Prompts answer map plus 25 sections covering the end-to-end lifecycle, the five layers, discovery orchestration, PXE & imaging, validation, GPU discovery, metrics, SKU management, remediation, self-healing, immutable infra, firmware, config consistency, supply chain, compliance, split-brain, catastrophic recovery, cloud/hybrid, and architectural heterogeneity — with 7 clarity diagrams. Companion to the Module 2 (Global DNS) visual study guide.
