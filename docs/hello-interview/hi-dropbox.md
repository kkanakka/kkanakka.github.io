---
title: "Dropbox"
slug: /hello-interview/hi-dropbox
sidebar_position: 2
sidebar_label: "Dropbox"
description: "Dropbox"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/hi-dropbox/sequence.svg" alt="How it works — hi-dropbox" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
[home](/)/ [hello interview](/docs/hello-interview/hi-index)/ **Dropbox**

hellointerview·2026-05

Design

[01 Requirements](#req) [02 Entities & API](#entities) [03 Upload flow](#upload) [04 Download flow](#download) [05 Sharing](#share) [06 Sync](#sync)

Deep Dives

[07 Architecture](#highlevel) [08 Large uploads](#large) [09 Chunking](#chunking) [10 Speed](#speed) [11 Delta sync](#cdc) [12 Security](#security) [13 Complete flow](#full) [14 Glossary](#glossary)

Cloud Storage Blob + Metadata Ambry + CDN Files up to 50GB Multipart Upload Delta Sync

Designing a cloud file storage service. Users upload, download, share, and auto-sync files across devices. The interesting parts are large-file uploads (chunking, resumability, deduplication) and efficient sync (delta sync with content-defined chunking).

**LinkedIn mapping:** Ambry (blob store) replaces S3, Espresso (NoSQL) replaces DynamoDB for metadata, LinkedIn CDN replaces CloudFront, and Kafka + Samza replace the notification push layer.

## 01 — Requirements {#req}

##### In scope

-   Upload a file from any device
-   Download a file from any device
-   Share a file with other users
-   Auto-sync files across devices

##### Out of scope

-   Editing files in the cloud
-   Viewing files without downloading
-   Storage quotas, versioning
-   Virus / malware scanning

Fig 1 Non-functional pillars

<img src="/diagrams/hi-dropbox/1.svg" alt="hi-dropbox diagram 1" class="doc-diagram" />

CAP trade-off

Prioritize consistency only when every read must see the latest write (e.g. stock trading). Dropbox tolerates a few seconds of delay between devices, so we go for **availability + eventual consistency** (AP).

## 02 — Core entities & API {#entities}

Fig 2 Entities — bytes in Ambry, metadata in Espresso

<img src="/diagrams/hi-dropbox/2.svg" alt="hi-dropbox diagram 2" class="doc-diagram" />

#### API endpoints

```
POST   /files                            # initiate upload
       { name, size, mimeType, fingerprint }
GET    /files/:fileId                    # download (returns signed URL)
POST   /files/:fileId/share              # share with users
GET    /files/changes?since=:timestamp   # sync — pull changes (Kafka offset)
```

## 03 — Upload flow {#upload}

Three options — only presigned URLs win.

Fig 3 Upload options — presigned URL is the winner

<img src="/diagrams/hi-dropbox/3.svg" alt="hi-dropbox diagram 3" class="doc-diagram" />

Server only handles small metadata calls. File bytes flow client ↔ Ambry directly. Scales infinitely.

Why this wins

Server only handles small metadata. Bytes flow client ↔ Ambry directly. At LinkedIn, Ambry serves petabytes of media this way.

## 04 — Download flow {#download}

Fig 4 Download via CDN with signed URL

<img src="/diagrams/hi-dropbox/4.svg" alt="hi-dropbox diagram 4" class="doc-diagram" />

## 05 — Sharing {#share}

Fig 5 SharedFiles ACL in Espresso

<img src="/diagrams/hi-dropbox/5.svg" alt="hi-dropbox diagram 5" class="doc-diagram" />

## 06 — Sync across devices {#sync}

Two directions: **Local → Remote** (client uploads changes) and **Remote → Local** (client receives changes).

Fig 6 Local → Remote sync

<img src="/diagrams/hi-dropbox/6.svg" alt="hi-dropbox diagram 6" class="doc-diagram" />

Fig 7 Remote → Local: push (Kafka) + poll (fallback)

<img src="/diagrams/hi-dropbox/7.svg" alt="hi-dropbox diagram 7" class="doc-diagram" />

## 07 — High-level architecture {#highlevel}

Fig 8 Full architecture — LinkedIn stack

<img src="/diagrams/hi-dropbox/8.svg" alt="hi-dropbox diagram 8" class="doc-diagram" />

Control plane (metadata) and data plane (bytes) are separate — the core Dropbox insight.

| Component | LinkedIn equivalent | Responsibility |
| --- | --- | --- |
| File Service | Li REST service | Metadata CRUD, generates presigned URLs (never touches bytes) |
| FileMetadata DB | **Espresso** | name, size, mime, owner, fingerprint, chunks, status |
| SharedFiles table | **Espresso** | ACL: which user can access which file |
| Blob store | **Ambry** | Raw file bytes. Encrypted at rest. Replicated across DCs. |
| CDN | **LinkedIn CDN / Akamai** | Edge caches for download. Signed URLs. |
| Notifications | **Kafka + Samza** | Event stream. Samza consumer pushes ChangeEvents via WebSocket. |

## 08 — Large file uploads: the problem {#large}

Fig 9 Why a single POST fails for 50GB

<img src="/diagrams/hi-dropbox/9.svg" alt="hi-dropbox diagram 9" class="doc-diagram" />

Fix: chunking. Break into 5–10MB pieces and upload each independently.

## 09 — Chunking & resumability {#chunking}

Fig 10 Parallel chunk uploads

<img src="/diagrams/hi-dropbox/10.svg" alt="hi-dropbox diagram 10" class="doc-diagram" />

Fig 11 Upload sequence diagram

<img src="/diagrams/hi-dropbox/11.svg" alt="hi-dropbox diagram 11" class="doc-diagram" />

#### Fingerprinting

Client computes `SHA-256(file)` before uploading. Two wins: **deduplication** (same file = one copy in Ambry) and **resumability** (which chunks made it?).

```json
{ "id": "uuid", "fingerprint": "sha256:...", "name": "presentation.key",
  "size": 50000000000, "status": "uploading",
  "chunks": [
    { "id": "chunk1", "fingerprint": "...", "status": "uploaded" },
    { "id": "chunk2", "fingerprint": "...", "status": "uploading" },
    { "id": "chunk3", "fingerprint": "...", "status": "not-uploaded" }
  ]}
```

## 10 — Speeding things up {#speed}

Fig 12 Four speed levers

<img src="/diagrams/hi-dropbox/12.svg" alt="hi-dropbox diagram 12" class="doc-diagram" />

Compress before encrypting

Encryption introduces randomness; randomness compresses poorly. Compress first, then encrypt.

## 11 — Delta sync & Content-Defined Chunking {#cdc}

Fig 13 Fixed chunks vs CDC — why CDC wins

<img src="/diagrams/hi-dropbox/13.svg" alt="hi-dropbox diagram 13" class="doc-diagram" />

## 12 — Security {#security}

Fig 14 Four security layers

<img src="/diagrams/hi-dropbox/14.svg" alt="hi-dropbox diagram 14" class="doc-diagram" />

Signed URLs are bearer tokens

Anyone with a valid, unexpired signed URL can use it. The 5-min expiry limits exposure. For sensitive workloads, bind to requester’s IP or cookie.

## 13 — Complete end-to-end flow {#full}

Fig 15 End-to-end — LinkedIn stack

<img src="/diagrams/hi-dropbox/15.svg" alt="hi-dropbox diagram 15" class="doc-diagram" />

| # | Step | What happens |
| --- | --- | --- |
| 1 | Initiate upload | Client computes fingerprints, hits API Gateway with JWT. |
| 2 | File Service | Creates Espresso row, calls Ambry CreateMultipartUpload. |
| 3 | Persist | Metadata saved in Espresso: status=uploading, chunk list. |
| 4 | Direct upload | Client PUTs each chunk directly to Ambry via presigned URL. |
| 5 | Notify | On complete, publish ChangeEvent to Kafka. Samza pushes via WebSocket. |
| 6 | Device B event | Receives push, triggers download. |
| 7 | Download via CDN | Device B fetches from nearest LinkedIn CDN edge (or just changed chunks). |

## 14 — Glossary {#glossary}

Presigned URL

URL cryptographically signed by the server, granting time-limited PUT/GET to a specific blob. Bytes flow client ↔ Ambry directly.

Multipart Upload

Ambry/S3 feature: upload one object in many parts (5MB–5GB each). Initiate → upload parts → complete.

Chunk

5–10MB piece of a file. Uploaded independently, in parallel, with progress tracking.

Fingerprint

SHA-256 hash of file content. Dedup key + resume key.

Deduplication

Same fingerprint = one copy in Ambry, even across users.

CDC

Content-Defined Chunking. Rolling hash sets boundaries from content, not fixed offsets. Edits don’t shift later chunks.

Delta Sync

Sync only changed chunks, not the whole file. Requires CDC.

Ambry

LinkedIn’s distributed blob store. Replicated across DCs. Equivalent to S3.

Espresso

LinkedIn’s NoSQL document store (MySQL + Helix). Metadata + ACL live here.

Kafka

LinkedIn’s event streaming platform. ChangeEvents published here.

Samza

LinkedIn’s stream processor. Consumes Kafka events, pushes via WebSocket.

CDN

Content Delivery Network. LinkedIn uses Akamai + internal CDN for edge caching.

Control / Data Plane

Control = metadata + signed URLs (small). Data = bytes (huge). Separating them is the key insight.

Rolling Hash

Hash recomputed efficiently as window slides (Rabin fingerprint). Finds CDC boundaries.

ETag

Returned per uploaded part. Required to call CompleteMultipartUpload.

Last-Write-Wins

Conflict resolution: most recent edit wins. Simple; loses concurrent edits.

WebSocket

Persistent TCP connection for server push. ChangeEvents flow here.

JWT

Signed token carrying userId. In headers, not body.

CAP Theorem

Pick 2 of 3: Consistency, Availability, Partition tolerance. Dropbox is AP.

On this page

-   [01 Requirements](#req)
-   [02 Entities](#entities)
-   [03 Upload](#upload)
-   [04 Download](#download)
-   [05 Sharing](#share)
-   [06 Sync](#sync)
-   [07 Architecture](#highlevel)
-   [08 Large uploads](#large)
-   [09 Chunking](#chunking)
-   [10 Speed](#speed)
-   [11 Delta sync](#cdc)
-   [12 Security](#security)
-   [13 Complete flow](#full)
-   [14 Glossary](#glossary)
