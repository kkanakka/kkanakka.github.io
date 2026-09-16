---
title: "Google SRE Interview Questions"
slug: /sre/google-sre-interview-questions
sidebar_position: 1
sidebar_label: "Google SRE Interview Questions"
description: "Google SRE Interview Questions"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/google-sre-interview-questions/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->

Comprehensive deep-dives into Linux internals, networking, processes, filesystems, containers, and sysadmin — with kernel diagrams, commands, and follow-up chains.

[Kiran's Tech Hub](/) → [Linux Systems Guide](/docs/linux/linux-systems-guide) → Google SRE Interview

## Table of Contents

Networking

[How does networking work?](#net-how-it-works) [Network Attacks](#net-attacks) [Routing Tables](#net-routing-tables) [Telnet or Curl Mechanics](#net-telnet-curl) [What happens when you telnet www.foo.com?](#net-foo-com)

Processes

[Signals and Trapping](#proc-signals) [Fork — Parent/Child Relationships](#proc-fork) [Orphaned Processes](#proc-orphaned) [Fork: What happens on the system?](#proc-fork-system) [What does kill do?](#proc-kill) [Describe exec](#proc-exec) [What does exec do? Calling exec()](#proc-exec-args) [Virtual Memory](#proc-vm)

Filesystems

[Inode Contents](#fs-inodes) [Unix-type Filesystems Organization](#fs-unix-types) [Symlinks vs Hardlinks](#fs-symlinks-hardlinks) [UNIX Permissions](#fs-permissions) [Implement pwd](#fs-pwd) [Implement the "lsof" command](#fs-lsof)

Containers & VMs

[Container vs VM](#cont-vs-vm) [Container Isolation & Namespaces](#cont-isolation)

SysAdmin

[Copy Disk, Verify](#sys-copy-verify) [Diskless Booting](#sys-diskless-boot) [Init Process & PID 1](#sys-pid-init) [Load Average & Uptime](#sys-load-average) [Remove a file named -f](#sys-remove-f) [Apache Security Advisory Scenario](#sys-apache-advisory) [Passwordless SSH](#sys-passwordless-ssh) [UNIX Timestamps](#sys-timestamps)

## Networking 5 Questions

<a id="net-how-it-works"></a>

### \[network\] How does network/data(base) boot work? (tcp, ftp, bootp)

L3–L5

#### Question

How does network/database boot work? Explain protocols like TCP, FTP, BOOTP.

#### Answer

Network booting involves a client machine with no local OS obtaining its network configuration and boot image entirely over the network. The process relies on a layered set of protocols:

```text
┌──────────────┐                              ┌──────────────┐
│   PXE Client │                              │  DHCP/TFTP   │
│ (no local OS)│                              │    Server     │
└──────┬───────┘                              └──────┬───────┘
       │  1. DHCPDISCOVER (broadcast)                │
       │ ──────────────────────────────────────────> │
       │                                             │
       │  2. DHCPOFFER (IP + next-server + filename) │
       │ <────────────────────────────────────────── │
       │                                             │
       │  3. DHCPREQUEST                             │
       │ ──────────────────────────────────────────> │
       │                                             │
       │  4. DHCPACK                                 │
       │ <────────────────────────────────────────── │
       │                                             │
       │  5. TFTP Read Request (pxelinux.0)          │
       │ ──────────────────────────────────────────> │
       │                                             │
       │  6. TFTP Data (boot loader binary)          │
       │ <────────────────────────────────────────── │
       │                                             │
       │  7. Boot loader fetches kernel + initrd     │
       │ ──────────────────────────────────────────> │
       │                                             │
       │  8. Kernel boots, NFS/HTTP root mount        │
       │ ──────────────────────────────────────────> │
       ▼                                             ▼
```

#### Protocol Stack

| Protocol | Purpose | Layer | Port |
| --- | --- | --- | --- |
| `BOOTP/DHCP` | Obtain IP address, next-server, boot filename | Application (L7) | 67/68 UDP |
| `TFTP` | Transfer boot loader binary (small, no auth) | Application (L7) | 69 UDP |
| `PXE` | Pre-boot Execution Environment (firmware-level) | Firmware | — |
| `NFS/HTTP` | Mount root filesystem after kernel boot | Application (L7) | 2049/80 |

#### TCP/IP Fundamentals

```text
Application Layer    │ HTTP, FTP, DNS, SSH, SMTP
─────────────────────┼──────────────────────────
Transport Layer      │ TCP (reliable, ordered, connection-oriented)
                     │ UDP (unreliable, unordered, connectionless)
─────────────────────┼──────────────────────────
Network Layer        │ IP (addressing, routing), ICMP, ARP
─────────────────────┼──────────────────────────
Data Link Layer      │ Ethernet frames, MAC addresses, switches
─────────────────────┼──────────────────────────
Physical Layer       │ Cables, radio waves, electrical signals
```

#### TCP Three-Way Handshake (Kernel Level)

```
/* Kernel: net/ipv4/tcp_input.c — simplified handshake state machine */

Client                          Server
  │                               │
  │── SYN (seq=x) ──────────────>│  // tcp_v4_connect() → tcp_connect()
  │                               │  // Server: SYN_RECV, create request_sock
  │<── SYN-ACK (seq=y, ack=x+1) ─│  // tcp_v4_send_synack()
  │                               │
  │── ACK (ack=y+1) ────────────>│  // tcp_rcv_state_process() → ESTABLISHED
  │                               │
  │       ESTABLISHED              │

/* SYN queue (half-open) → Accept queue (fully established) */
/* Tuning: net.ipv4.tcp_max_syn_backlog, net.core.somaxconn */
```

#### Key Commands

```
# Show TCP connection states
ss -tan state established | head -20
ss -s   # Summary statistics

# Trace packet path
traceroute -T -p 443 google.com

# Watch real-time TCP handshakes with tcpdump
sudo tcpdump -i eth0 'tcp[tcpflags] & (tcp-syn|tcp-ack) != 0' -nn

# Kernel TCP parameters
sysctl net.ipv4.tcp_max_syn_backlog
sysctl net.core.somaxconn
sysctl net.ipv4.tcp_syncookies
```

##### Follow-up Questions

-   What is the difference between BOOTP and DHCP?
-   Why does TFTP use UDP instead of TCP?
-   What happens if the TFTP server is unreachable during PXE boot?
-   How does iPXE extend the original PXE standard?

<a id="net-attacks"></a>

### \[attack\] Name a few typical network attacks. Detect & defend?

L3–L5

#### Question

Name a few typical network attacks. How would you detect and defend against them?

#### Answer

This is a discussion question. Assuming the person can name and describe some of the network attacks — ask them to detect and defend.

#### Common Network Attacks

| Attack | Mechanism | Detection | Defense |
| --- | --- | --- | --- |
| **SYN Flood** | Send many SYN packets, never complete handshake. Fills SYN queue. | `netstat -s | grep "SYNs to LISTEN"`  
Watch half-open connections | SYN cookies: `sysctl net.ipv4.tcp_syncookies=1`  
Rate limiting with iptables |
| **ARP Spoofing** | Send fake ARP replies to associate attacker's MAC with target IP | `arpwatch`, duplicate IP detection, ARP table monitoring | Static ARP entries, 802.1X, Dynamic ARP Inspection (DAI) |
| **DNS Spoofing** | Forge DNS responses to redirect traffic to malicious server | DNSSEC validation failures, unexpected DNS response IPs | DNSSEC, DNS over HTTPS/TLS, randomized source ports |
| **DDoS** | Volumetric: overwhelm bandwidth. Protocol: exploit L3/L4. App: exhaust L7 resources | Traffic anomaly detection, baseline deviation, flow analysis | CDN/scrubbing centers, rate limiting, anycast, BCP38 |
| **MITM** | Position between two parties, intercept/modify traffic | Certificate pinning failures, unexpected cert changes | TLS everywhere, HSTS, certificate transparency logs |

#### Kernel-Level Network Defense

```
# Enable SYN cookies (kernel responds to SYN floods without state)
echo 1 > /proc/sys/net/ipv4/tcp_syncookies

# Reduce SYN-ACK retries (default 5 = ~3 min timeout)
echo 2 > /proc/sys/net/ipv4/tcp_synack_retries

# Enable reverse path filtering (drops spoofed source IPs)
echo 1 > /proc/sys/net/ipv4/conf/all/rp_filter

# Rate limit ICMP (prevent ping floods)
iptables -A INPUT -p icmp --icmp-type echo-request \
  -m limit --limit 1/s --limit-burst 4 -j ACCEPT
iptables -A INPUT -p icmp --icmp-type echo-request -j DROP

# Detect ARP spoofing
arpwatch -i eth0 -f /var/lib/arpwatch/eth0.dat

# Connection tracking table (conntrack)
conntrack -L | wc -l
sysctl net.netfilter.nf_conntrack_max
```

```text
SYN Flood Attack & SYN Cookie Defense
══════════════════════════════════════

Normal:                         SYN Flood:
Client → SYN → Server           Attacker → 1000s SYN → Server
       ← SYN-ACK ←                       ← SYN-ACK (fills queue)
       → ACK →                            (never ACKs → half-open)
       ESTABLISHED                        SYN queue exhausted!

SYN Cookie Defense (kernel):
┌─────────────────────────────────────────────────┐
│ Server does NOT allocate state on SYN            │
│ Instead, encodes: MSS + timestamp + hash         │
│ into the sequence number of SYN-ACK              │
│                                                   │
│ On ACK:                                           │
│   1. Extract cookie from ack_seq - 1              │
│   2. Validate HMAC(src_ip, dst_ip, ports, secret) │
│   3. If valid → create connection (no queue used) │
└─────────────────────────────────────────────────┘
```

##### Follow-up Questions

-   How do SYN cookies work without allocating state? What information is encoded in the sequence number?
-   What is the difference between a DDoS attack called "amplification" vs a "reflection" attack?
-   Can you use `eBPF` for DDoS mitigation? How does XDP help?
-   What is BCP38 and how does it prevent IP spoofing at the network level?

<a id="net-routing-tables"></a>

### \[rtable\] How do you determine the current routing table?

L3–L5

#### Question

Talk about the routing table. How do you view it? What are the key concepts?

#### Answer

This is a very open-ended question. Any candidate with any practical experience is expected to know at least basic knowledge of routing. This isn't about being a network engineer — more about showing you understand how packets find their destination.

#### Basic Concepts

-   A **routing table** tells the OS/router where to forward a packet based on its destination IP
-   A route is an `(destination, gateway, interface, metric)` tuple
-   The most specific match wins (longest prefix match)
-   Default route (`0.0.0.0/0`) is used when no specific route matches

#### Commands to Check Routing Table

```
# Modern Linux (iproute2)
ip route show
ip -6 route show    # IPv6 routes

# Legacy
route -n            # Numeric output, skip DNS
netstat -rn

# Specific route lookup
ip route get 8.8.8.8
ip route get 2001:4860:4860::8888   # IPv6

# Show routing table for specific table
ip route show table main
ip route show table local
ip route show table all

# Kernel routing cache (older kernels)
ip route show cache
```

#### Routing Table Anatomy

```text
$ ip route show
default via 10.0.0.1 dev eth0 proto dhcp metric 100
10.0.0.0/24 dev eth0 proto kernel scope link src 10.0.0.50 metric 100
172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1
192.168.1.0/24 via 10.0.0.254 dev eth0 metric 200

Field Breakdown:
──────────────────────────────────────────────────────
default         → destination 0.0.0.0/0 (catch-all)
via 10.0.0.1    → next-hop gateway
dev eth0        → outgoing interface
proto dhcp      → route was learned via DHCP
proto kernel    → route auto-created by kernel for directly connected networks
scope link      → destination is on-link (same L2 segment)
src 10.0.0.50   → preferred source address when using this route
metric 100      → preference (lower = preferred)
```

#### Advanced Concepts

-   **Policy Routing**: Multiple routing tables, selected by rules (`ip rule list`)
-   **MPLS**: Multiprotocol Label Switching — label-based forwarding instead of IP lookup
-   **BGP**: Border Gateway Protocol — how the internet's routing tables are built
-   **ECMP**: Equal-Cost Multi-Path — load balance across multiple next hops
-   **Blackholing**: `ip route add blackhole 192.168.1.0/24` — silently drop traffic

```
# Policy routing example
ip rule list
ip rule add from 10.0.1.0/24 table 100
ip route add default via 10.0.0.2 table 100

# Add a route
ip route add 192.168.2.0/24 via 10.0.0.254 dev eth0

# Add blackhole (drop)
ip route add blackhole 198.51.100.0/24

# ECMP routing
ip route add default \
  nexthop via 10.0.0.1 weight 1 \
  nexthop via 10.0.0.2 weight 1

# Programmatic access to routing table
# Linux: AF_NETLINK socket with protocol NETLINK_ROUTE
# Or /proc/net/route, /proc/net/ipv6_route
```

Longest Prefix Match — How the Kernel Picks a Route ════════════════════════════════════════════════════ Destination: 10.0.1.50 Route Table: 10.0.0.0/16 → via gateway A (matches /16 = 16 bits) 10.0.1.0/24 → via gateway B (matches /24 = 24 bits) ← WINNER 10.0.1.48/28 → via gateway C (matches /28 = 28 bits) ← ACTUALLY WINS 0.0.0.0/0 → via gateway D (matches /0 = 0 bits) The kernel uses a **trie** (LC-trie in Linux) for O(log n) lookup. Source: net/ipv4/fib\_trie.c

##### Evaluation Guidance

-   **L3**: Any answer that is able to provide the current routing table and discuss its contents is sufficient
-   **L4**: Should include ability to discuss routing concepts, diagnose routing problems, modify routing tables, and familiarity with IPv4 and IPv6 differences
-   **L5+**: Familiarity with netlink kernel interface, policy routing, MPLS, IPMP/ECMP, blackholing, discovery protocols, and routing protocols

<a id="net-telnet-curl"></a>

### \[tcurl\] What happens when you run curl / telnet? Describe the network flow.

L3–L5

#### Question

What happens when you run `curl http://example.com` or `telnet example.com 80`? Walk through the network mechanics step by step.

#### Answer

This is a discussion question. Depending on the candidate's level of experience, you can go from a straightforward simple answer to a deep drill.

#### Complete Network Flow

```text
$ curl http://www.example.com/page

Step 1: DNS Resolution
   curl → getaddrinfo("www.example.com")
     → /etc/nsswitch.conf → "hosts: files dns"
     → /etc/hosts (miss)
     → /etc/resolv.conf → nameserver 10.0.0.1
     → UDP:53 query A www.example.com
     ← 93.184.216.34

Step 2: Socket Creation
   socket(AF_INET, SOCK_STREAM, 0) → fd=3
   ↓ kernel: allocate struct socket, struct sock

Step 3: TCP Connect (3-way handshake)
   connect(fd, {93.184.216.34:80})
   → [SYN seq=x]              → kernel: tcp_v4_connect()
   ← [SYN-ACK seq=y ack=x+1]  ← kernel: tcp_v4_do_rcv()
   → [ACK ack=y+1]             → ESTABLISHED

Step 4: HTTP Request
   send(fd, "GET /page HTTP/1.1\r\n"
            "Host: www.example.com\r\n"
            "\r\n")
   → kernel: tcp_sendmsg() → sk_buff → ip_queue_xmit()
   → IP: src=10.0.0.50 dst=93.184.216.34 proto=TCP
   → Ethernet: src_mac → dst_mac(gateway) → wire

Step 5: HTTP Response
   recv(fd, buffer, 8192)
   ← "HTTP/1.1 200 OK\r\n..."
   ← kernel: tcp_rcv_established() → sk_buff → socket buffer

Step 6: Connection Close
   close(fd)
   → [FIN] → [ACK] → [FIN] → [ACK]  (4-way teardown)
   → kernel: tcp_close() → TIME_WAIT (2*MSL = 60s default)
```

#### Kernel Path of a Packet

```text
Outgoing Packet (curl sends data):
═══════════════════════════════════

  Application: write(fd, data)
       │
       ▼
  Socket Layer: sock_sendmsg()
       │
       ▼
  TCP: tcp_sendmsg() → segment, set seq/ack, checksum
       │
       ▼
  IP: ip_queue_xmit() → route lookup (fib_lookup)
       │                → set src/dst IP, TTL, checksum
       ▼
  Netfilter: NF_INET_LOCAL_OUT → iptables OUTPUT chain
       │
       ▼
  Neighbor/ARP: neigh_resolve_output() → ARP cache or ARP request
       │
       ▼
  Device: dev_queue_xmit() → Ethernet frame → qdisc
       │
       ▼
  NIC Driver: e1000_xmit_frame() → DMA ring buffer → wire
```

```
# Trace the full network path of a curl request
strace -e trace=network curl -s http://example.com >/dev/null

# Watch DNS resolution
strace -e trace=network curl -s http://example.com 2>&1 | grep -E 'connect|sendto|recvfrom'

# Use telnet to manually send HTTP
telnet www.example.com 80
GET / HTTP/1.1
Host: www.example.com

# tcpdump to see the packets
sudo tcpdump -i eth0 host 93.184.216.34 -nn -v
```

##### Follow-up Questions

-   If you used `curl -I` before and `-I` and the basic `GET`, what things should you look at when writing something that handles coded responses for HTTP
-   How is `TIME_WAIT` state handled? Why does it last 2\*MSL? What are the consequences?
-   What is the difference between `curl` and `telnet` for connection testing?

##### Evaluation Guidance

-   **L3**: Can describe DNS lookup, TCP connection, HTTP request cycle
-   **L4**: Understands kernel path, can trace with strace/tcpdump, knows about TIME\_WAIT
-   **L5**: Can describe full kernel packet path, netfilter hooks, qdisc, DMA ring buffers

<a id="net-foo-com"></a>

### \[telnet\] What happens when you telnet www.foo.com?

L3–L5

#### Question

What happens when you type `telnet www.foo.com`?

#### Answer

This is essentially a simplified version of the curl question but specifically tests understanding of the client-side connection lifecycle:

1.  **Shell parses command** → `fork()` + `exec("telnet", ["telnet", "www.foo.com"])`
2.  **DNS Resolution** → `getaddrinfo("www.foo.com")` → checks `/etc/nsswitch.conf`, `/etc/hosts`, then DNS resolver at `/etc/resolv.conf`
3.  **Socket creation** → `socket(AF_INET, SOCK_STREAM, 0)`
4.  **TCP handshake** → `connect()` to port 23 (default telnet port) → SYN → SYN-ACK → ACK
5.  **Telnet negotiation** → IAC (Interpret As Command) option negotiation (WILL/WONT/DO/DONT)
6.  **Interactive session** → bidirectional byte stream, terminal I/O via `read()/write()`
7.  **Disconnect** → TCP FIN → four-way teardown → TIME\_WAIT

**Key insight:** Telnet defaults to port 23 (plaintext!). If you `telnet host 80`, you're just making a raw TCP connection — useful for testing HTTP manually but insecure. Modern equivalent: `nc` (netcat) or `openssl s_client` for TLS.

## Processes 8 Questions

<a id="proc-signals"></a>

### \[tis-a-trap\] What signals can't be trapped?

L3–L5

#### Question

Write a program to work out which signals can't be trapped.

#### Answer

`SIGKILL` (9) and `SIGSTOP` (19) cannot be caught, blocked, or ignored. They are handled directly by the kernel to ensure the system can always stop a process.

#### Why Can't They Be Trapped?

```text
Signal Delivery Path in the Kernel
═══════════════════════════════════

  Signal sent (kill(), kernel event)
       │
       ▼
  kernel/signal.c: send_signal()
       │
       ├── SIGKILL or SIGSTOP?
       │     YES → force_sig_info()
       │           → Cannot be blocked (sigdelsetmask)
       │           → Cannot have handler (SIG_DFL forced)
       │           → Kernel handles directly
       │
       └── Other signal?
             → Add to task's pending signal set
             → When returning to userspace:
               do_signal() → handle_signal()
               → Call registered handler (if any)
               → Or default action (SIG_DFL)
```

#### Program to Find Untrappable Signals

```
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>

void handler(int sig) { }

int main(int argc, char *argv[]) {
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = handler;

    for (int sig = 1; sig < NSIG; sig++) {
        if (sigaction(sig, &sa, NULL) == -1) {
            printf("Signal %2d (%s): CANNOT be trapped — %s\n",
                   sig, strsignal(sig), strerror(errno));
        }
    }
    return 0;
}
```

```
# Output:
Signal  9 (Killed): CANNOT be trapped — Invalid argument
Signal 19 (Stopped): CANNOT be trapped — Invalid argument
# (Signal 32 and 33 are also untrappable — used internally by NPTL threading)
```

#### Common Signals Reference

| Signal | # | Default Action | Trappable | Use Case |
| --- | --- | --- | --- | --- |
| `SIGHUP` | 1 | Terminate | Yes | Daemon reload config |
| `SIGINT` | 2 | Terminate | Yes | Ctrl+C |
| `SIGQUIT` | 3 | Core dump | Yes | Ctrl+\\ |
| `SIGKILL` | 9 | Terminate | **NO** | Force kill (last resort) |
| `SIGSEGV` | 11 | Core dump | Yes | Segmentation fault |
| `SIGTERM` | 15 | Terminate | Yes | Graceful shutdown |
| `SIGSTOP` | 19 | Stop | **NO** | Freeze process |
| `SIGTSTP` | 20 | Stop | Yes | Ctrl+Z |
| `SIGCHLD` | 17 | Ignore | Yes | Child exited |
| `SIGUSR1` | 10 | Terminate | Yes | User-defined |

##### Follow-up Questions

-   Write a program (a shell wrapper) that sets up signal handlers for all trappable signals
-   What is the difference between `signal()` and `sigaction()`? Why prefer `sigaction()`?
-   What happens when a signal is delivered to a multi-threaded process? Which thread gets it?
-   What is a signal mask? How does `sigprocmask()` work?

<a id="proc-fork"></a>

### \[fork\] Discuss the parent/child relationship of UNIX processes

L3–L5

#### Question

Discuss various aspects of the parent/child relationship for UNIX processes. For instance: read the relationship, how many children, what data about children, and vice versa.

#### Answer

The relationship is read by `fork(1)` or `clone(1)` and preserved across `exec(1)`. The parent PID is only changed when a parent exits. Then all its children are re-parented to the init process. The child process gets a copy of the parent process using `fork()`, but with different PID.

#### Process Tree in the Kernel

```text
Kernel Data Structures (include/linux/sched.h)
═══════════════════════════════════════════════

struct task_struct {
    pid_t pid;                    // Process ID
    pid_t tgid;                   // Thread Group ID (= pid for main thread)

    struct task_struct *parent;   // Pointer to parent
    struct list_head children;    // List of children
    struct list_head sibling;     // Linkage in parent's children list

    struct task_struct *real_parent;  // Actual parent (before ptrace)
    struct task_struct *group_leader; // Thread group leader

    int exit_code;               // Exit status for parent to read
    int exit_signal;             // Signal to send to parent on exit
    ...
};

Process Tree:
─────────────
     init (PID 1)
     ├── sshd (PID 100)
     │   └── bash (PID 200)
     │       ├── vim (PID 300)
     │       └── grep (PID 301)
     ├── cron (PID 101)
     └── nginx (PID 102)
         ├── worker (PID 400)
         └── worker (PID 401)
```

#### fork() Deep Dive

```
#include <unistd.h>
#include <stdio.h>
#include <sys/wait.h>

int main() {
    pid_t pid = fork();

    if (pid == -1) {
        perror("fork failed");
        return 1;
    }

    if (pid == 0) {
        // CHILD: fork() returned 0
        printf("Child: PID=%d, PPID=%d\n", getpid(), getppid());
        sleep(2);
        _exit(42);  // Exit with status 42
    } else {
        // PARENT: fork() returned child's PID
        printf("Parent: PID=%d, child=%d\n", getpid(), pid);

        int status;
        waitpid(pid, &status, 0);  // Reap child

        if (WIFEXITED(status))
            printf("Child exited with %d\n", WEXITSTATUS(status));
    }
    return 0;
}
```

#### What Happens in the Kernel During fork()

```text
fork() → sys_fork() → kernel_clone() → copy_process()
═══════════════════════════════════════════════════════

1. copy_process():
   ├── dup_task_struct()     → Allocate new task_struct + kernel stack
   ├── copy_creds()          → Copy credentials (uid, gid, capabilities)
   ├── copy_mm()             → Clone memory map (COW page tables)
   │   └── dup_mmap()        → Duplicate VMAs, mark pages read-only
   │       └── All pages are shared with COW (Copy-on-Write)
   │           → Parent writes? Page fault → copy_one_pte() → new page
   ├── copy_fs()             → Copy filesystem context (cwd, root)
   ├── copy_files()          → Duplicate file descriptor table
   │   └── Each fd shares same struct file (refcount++)
   ├── copy_sighand()        → Copy signal handlers
   ├── copy_signal()         → Copy signal delivery state
   ├── copy_io()             → Copy I/O context
   └── copy_thread()         → Set up new kernel stack, return point

2. Assign new PID (alloc_pid)
3. Add to parent's children list
4. Wake up new process (wake_up_new_task)
```

#### Key Observations

-   The child process can find the parent's PID using `getppid()` call
-   The parent process gets the child's PID from the return value of `fork()`
-   If parent exits first: children are re-parented to PID 1 (init/systemd) or the nearest subreaper
-   If child exits first: becomes a **zombie** until parent calls `wait()`/`waitpid()`
-   The child inherits open file descriptors, signal handlers, environment, and cwd
-   The child does NOT inherit: PID, parent PID, pending signals, file locks, timers

```
# View process tree
pstree -p $$
ps -ef --forest
ps auxf

# Parent/child relationship
ls -la /proc/$$/status | grep -E 'PPid|Pid|Threads'
cat /proc/$$/status | grep -E '^(Name|Pid|PPid|Threads)'

# Children of a process
cat /proc/$$/task/$$/children
```

##### Follow-up Questions

-   How does the kernel keep track of which of its children have exited?
-   What happens when a child exits but the parent is ignoring SIGCHLD?
-   Explain Copy-on-Write. What happens when a child writes to a page shared with the parent?
-   What is a **subreaper**? How does `prctl(PR_SET_CHILD_SUBREAPER)` work?
-   When a process calls fork, what happens on the system? How many returns from fork are there? If more than 1, how does the system tell them apart?

<a id="proc-orphaned"></a>

### \[orphans\] What happens if a parent exits before its child does?

L3–L5

#### Question

What happens if a parent process exits before its child dies?

#### Answer

The orphaned process is re-parented. In the old days, orphaned processes were always adopted by `init` (PID 1). Modern Linux has the concept of **subreapers**.

```text
Re-parenting Flow
═════════════════

Parent (PID 100) exits while Child (PID 200) still running:

BEFORE:                           AFTER:
  init (1)                         init (1)
  └── Parent (100)                 └── Child (200)  ← re-parented!
      └── Child (200)

With subreaper (e.g., systemd, Docker):
  init (1)
  └── container-shim (50) [SUBREAPER]
      └── Parent (100)
          └── Child (200)

Parent exits → Child re-parented to subreaper (50), NOT init (1)
```

#### Kernel Code Path

```
/* kernel/exit.c — forget_original_parent() */
/* Called when a process exits — re-parents its children */

static void forget_original_parent(struct task_struct *father) {
    struct task_struct *reaper;

    /* Find the new parent:
     * 1. Walk up the tree looking for a subreaper
     * 2. If none found, use init_task (PID 1)
     */
    reaper = find_child_reaper(father);

    /* Re-parent all children to the reaper */
    list_for_each_entry(child, &father->children, sibling) {
        child->real_parent = reaper;
        if (child->exit_state)
            /* Zombie child — send SIGCHLD to new parent */
            do_notify_parent(child, child->exit_signal);
    }
}
```

#### Zombie vs Orphan

|  | Zombie | Orphan |
| --- | --- | --- |
| **Definition** | Child exited but parent hasn't called `wait()` | Parent exited while child still running |
| **State** | `Z` (zombie) in `ps` | Normal running state, just different PPID |
| **Resources** | Only entry in process table (task\_struct) | Full process with all resources |
| **Resolution** | Parent must call `wait()`, or parent exits (then init reaps) | Automatically re-parented to init/subreaper |

```
# Find zombie processes
ps aux | grep 'Z'
ps -eo pid,ppid,stat,comm | grep -E '^|Z'

# Find orphaned processes (PPID = 1)
ps -eo pid,ppid,comm | awk '$2 == 1'

# Set subreaper flag
prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
```

##### Follow-up Questions

-   If they seem tired, you may want to listen to the direction of init
-   Is there also a "reaper" mechanism? How does it work?
-   How do you decide if you need to use the direction of init?

##### Leveling Guidance

-   **L3**: Knows orphans are re-parented to init
-   **L4**: Can explain zombie vs orphan distinction, knows about SIGCHLD and wait()
-   **L5**: Understands subreapers, can trace kernel code path, knows about process groups and sessions

<a id="proc-fork-system"></a>

### \[fork\] When a process calls fork, what happens on the system?

L4–L5

#### Question

When a process calls fork, what happens on the system? How many returns from fork are there? If more than 1, how does the system tell them apart?

#### Answer

The `fork()` system call creates a (nearly) complete copy of a process, which has the original process as its parent. The new process has its own PID, its own copy of all open file descriptors (including exec-on-close), memory regions, signal handlers.

`fork()` returns **twice**: once in the parent (returning child's PID) and once in the child (returning 0). The kernel distinguishes them by setting different return values in each process's register context.

```text
How fork() Returns Twice
════════════════════════

kernel_clone() → copy_process()
  │
  ├── Create child task_struct (copy of parent)
  │   └── copy_thread() sets child's pt_regs:
  │       child_regs->ax = 0    ← child will "return" 0
  │
  └── Return child's PID to parent
      parent_regs->ax = child_pid  ← parent gets child's PID

Both processes resume from the SAME instruction
(the return from the fork() syscall), but with
different values in RAX register:

Parent thread:                     Child thread:
  RAX = child_pid (> 0)             RAX = 0
  → fork() "returns" child_pid      → fork() "returns" 0
```

#### Copy-on-Write (COW) Memory

```text
Before fork():
┌─────────────────────────┐
│ Parent Process (PID 100) │
│                          │
│ Virtual Page → Physical  │
│ 0x1000 → Frame A (RW)   │
│ 0x2000 → Frame B (RW)   │
│ 0x3000 → Frame C (RW)   │
└─────────────────────────┘

After fork() (both point to SAME physical pages, marked READ-ONLY):
┌─────────────────────┐     ┌─────────────────────┐
│ Parent (PID 100)     │     │ Child (PID 200)      │
│ 0x1000 → Frame A (R) │     │ 0x1000 → Frame A (R) │
│ 0x2000 → Frame B (R) │     │ 0x2000 → Frame B (R) │
│ 0x3000 → Frame C (R) │     │ 0x3000 → Frame C (R) │
└─────────────────────┘     └─────────────────────┘

Child writes to 0x2000:
  1. Page fault (write to read-only page)
  2. Kernel: do_wp_page() → wp_page_copy()
  3. Allocate new Frame D, copy Frame B → Frame D
  4. Update child's page table: 0x2000 → Frame D (RW)
  5. If parent is only remaining reference: mark Frame B as RW

┌─────────────────────┐     ┌─────────────────────┐
│ Parent (PID 100)     │     │ Child (PID 200)      │
│ 0x1000 → Frame A (R) │     │ 0x1000 → Frame A (R) │
│ 0x2000 → Frame B (RW)│     │ 0x2000 → Frame D (RW)│ ← NEW COPY
│ 0x3000 → Frame C (R) │     │ 0x3000 → Frame C (R) │
└─────────────────────┘     └─────────────────────┘
```

<a id="proc-kill"></a>

### \[kill\] What does kill do?

L3–L5

#### Question

What does `kill(1)` do? This question tests TC's understanding of UNIX signals and inter-process communication.

#### Answer

The `kill(1)` command (and the `kill(2)` system call) sends a signal to the specified process. The default signal is `SIGTERM` (15). Despite the name, `kill` doesn't always kill — it's really "send signal."

```
# Send SIGTERM (default — graceful shutdown request)
kill 1234

# Send SIGKILL (force kill — cannot be caught)
kill -9 1234
kill -SIGKILL 1234

# Send signal to process group
kill -TERM -1234    # Negative PID = entire process group

# Send signal to all processes of a user
kill -TERM -1       # All processes you own (except PID 1)

# List available signals
kill -l
```

#### Kernel Path: kill() System Call

```text
kill(pid, sig) → sys_kill() → kill_something_info()
════════════════════════════════════════════════════

pid > 0:  kill_proc_info(sig, pid)
          → Send signal to specific process

pid == 0: kill_pgrp_info(sig, current->pgrp)
          → Send signal to entire process group

pid == -1: for_each_process(p)
           → Send signal to all processes you can signal

pid < -1: kill_pgrp_info(sig, -pid)
          → Send signal to process group |pid|

Actual delivery:
  → group_send_sig_info()
    → __send_signal()
      → Allocate sigqueue
      → Add to task->pending.signal or task->signal->shared_pending
      → set_tsk_thread_flag(TIF_SIGPENDING)
      → wake_up_state(task, TASK_INTERRUPTIBLE)
```

##### Follow-up Questions

-   What is the difference between `kill`, `pkill`, and `killall`?
-   Why would an application trap SIGTERM? Give an example.
-   What happens when a signal is pending for a process that is in `TASK_UNINTERRUPTIBLE` (D state)?
-   What happens in the case of multi-threaded process — which thread gets the signal?

<a id="proc-exec"></a>

### \[exec\] What does exec do? Describe the exec() system call.

L3–L5

#### Question

What does the `exec(1)` system call do?

#### Answer

It replaces the current process image with a new image. The PID stays the same. All of the memory is replaced. Open file descriptors are preserved (unless `FD_CLOEXEC` / `O_CLOEXEC` is set).

#### The exec() Family

| Function | Path lookup | Args format | Environment |
| --- | --- | --- | --- |
| `execl()` | Full path | Variadic list | Inherited |
| `execlp()` | PATH search | Variadic list | Inherited |
| `execle()` | Full path | Variadic list | Explicit |
| `execv()` | Full path | Array | Inherited |
| `execvp()` | PATH search | Array | Inherited |
| `execvpe()` | PATH search | Array | Explicit |
| `execve()` | Full path | Array | Explicit (this is the actual syscall) |

#### What exec() Does in the Kernel

```text
execve("/bin/ls", ["ls", "-la"], envp)
→ sys_execve() → do_execveat_common()
════════════════════════════════════════

1. open_exec(filename)
   → Open the binary, check permissions (+x)
   → Read first 128 bytes to detect format

2. Detect binary format:
   → ELF: "\x7fELF" → load_elf_binary()
   → Script: "#!" → load_script() → re-exec interpreter
   → a.out (legacy)

3. flush_old_exec()
   → Release old memory mappings (mm_struct)
   → Clear signal handlers (reset to SIG_DFL)
   → Close FD_CLOEXEC file descriptors

4. setup_new_exec()
   → Set process name (comm field)
   → Set new credentials if setuid/setgid

5. Load new image:
   ├── Map .text section (executable code) → read-only, executable
   ├── Map .data section (initialized data) → read-write
   ├── Map .bss section (zeroed data) → read-write
   ├── Set up stack (argv, envp, auxv)
   ├── Map dynamic linker (ld-linux.so) if dynamically linked
   └── Set instruction pointer to entry point (e_entry or ld.so)

6. start_thread(regs, elf_entry, sp)
   → Set registers: RIP=entry_point, RSP=new_stack
   → Return to userspace → new program begins
```

#### Key: exec() Never Returns (on success)

```
/* Classic fork+exec pattern */
pid_t pid = fork();
if (pid == 0) {
    /* Child: replace ourselves with /bin/ls */
    char *args[] = {"ls", "-la", NULL};
    execvp("ls", args);

    /* If we get here, exec FAILED */
    perror("execvp failed");
    _exit(127);
}
/* Parent continues here */
waitpid(pid, &status, 0);
```

**Important:** There are only 6 (or 7) variants of exec, all of which in Linux are frontends for the `execve(2)` system call. In all cases the exec() doesn't return unless there was an error, and `errno` is set.

##### Follow-up Questions

-   If you used fork() and the exec fails, what things should you look at when writing some handling code?
-   What is `FD_CLOEXEC` and why is it important for security?
-   How does the kernel handle the `#!` (shebang) line in scripts?
-   What happens to memory-mapped files across exec?

<a id="proc-exec-args"></a>

### \[exec2\] What types of arguments are passed to exec()?

L3–L4

#### Question

What does exec do? What happens to the process calling exec? What types of arguments are passed to exec (i.e. exec, file, arguments, env vars)? What attributes of a process survive an exec?

#### What Survives exec()

| Survives | Replaced / Reset |
| --- | --- |
| PID, PPID, PGID, SID  
Real UID/GID  
Open FDs (without CLOEXEC)  
Current working directory  
Root directory  
umask  
Resource limits  
Controlling terminal  
Process group membership | Memory image (text, data, heap, stack)  
Signal handlers (reset to SIG\_DFL)  
Memory mappings  
Pending signals (cleared)  
FDs with CLOEXEC flag  
Effective UID/GID (may change for setuid)  
Core dump settings |

<a id="proc-vm"></a>

### \[vm\] What is virtual memory?

L3–L6

#### Question

What is virtual memory? How does it work? This is a deep and complex topic that tests the candidate's ability to explain complex things simply.

#### Answer

Virtual memory is an abstraction where each process sees its own private, contiguous address space. The OS + hardware (MMU) transparently maps virtual addresses to physical RAM pages. This provides isolation, allows overcommit, and enables features like demand paging and memory-mapped files.

```text
Process Virtual Address Space (x86_64)
══════════════════════════════════════

 0xFFFFFFFFFFFFFFFF ┌─────────────────┐
                    │  Kernel Space     │ (upper half, per-architecture)
 0xFFFF800000000000 ├─────────────────┤
                    │  (hole/unused)    │
 0x00007FFFFFFFFFFF ├─────────────────┤
                    │  Stack ↓          │ grows downward
                    │  ...              │
                    │  Memory-mapped    │ shared libs, mmap regions
                    │  ...              │
                    │  Heap ↑           │ grows upward (brk/sbrk/mmap)
                    ├─────────────────┤
                    │  BSS (.bss)       │ uninitialized globals (zeroed)
                    │  Data (.data)     │ initialized globals
                    │  Text (.text)     │ executable code (read-only)
 0x0000000000400000 ├─────────────────┤
                    │  (reserved/null)  │ NULL pointer dereference → SIGSEGV
 0x0000000000000000 └─────────────────┘
```

#### Page Table Walk (4-Level on x86\_64)

```text
Virtual Address: 48 bits used (of 64)
┌──────┬──────┬──────┬──────┬──────┐
│ PML4 │ PDPT │  PD  │  PT  │Offset│
│9 bits│9 bits│9 bits│9 bits│12 bit│
└──┬───┴──┬───┴──┬───┴──┬───┴──┬───┘
   │      │      │      │      │
   ▼      ▼      ▼      ▼      ▼
┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌────────────┐
│PML4E│→│PDPTE│→│ PDE │→│ PTE │→│Physical Addr│
│Table│ │Table│ │Table│ │Table│ │ (+ offset)  │
└─────┘ └─────┘ └─────┘ └─────┘ └────────────┘
  ↑
  CR3 register (per-process, stored in task_struct->mm->pgd)

TLB (Translation Lookaside Buffer):
  Cache of recent virtual→physical translations
  TLB miss → full page table walk (expensive!)
  Context switch → TLB flush (unless PCID used)
```

#### Page Fault Types

| Type | Cause | Kernel Action |
| --- | --- | --- |
| **Minor** | Page in memory but PTE not set (e.g., demand paging, COW) | Map the page, no I/O needed. `do_anonymous_page()` |
| **Major** | Page not in memory, must read from disk (swap, file-backed) | Read from disk, block process. `do_swap_page()` |
| **Invalid** | Access to unmapped address or permission violation | `SIGSEGV` or `SIGBUS` |

```
# View process memory map
cat /proc/$$/maps
pmap -x $$

# Page fault statistics
ps -o pid,min_flt,maj_flt,cmd -p $$

# System-wide memory
cat /proc/meminfo
free -h
vmstat 1   # si/so = swap in/out, bi/bo = block in/out

# Look at process memory usage
cat /proc/$$/status | grep -E 'VmSize|VmRSS|VmSwap'
# VmSize = Virtual (total address space)
# VmRSS  = Resident (actually in physical RAM)
# VmSwap = Swapped to disk
```

##### Follow-up Questions

-   I'm writing a program that uses memory. Can I tell if it is in RAM? (`mincore()`, `/proc/self/smaps`)
-   What happens when you run `p = malloc(1GB)`? (Virtual size grows, RSS doesn't until you touch pages)
-   What is the impact of disabling swap?
-   How do you see the rate of swapping? (`vmstat`, `sar`)

##### Evaluation Guidance

-   **L3**: Can describe basics of virtual memory, page faults, swapping
-   **L4**: Can discuss page tables, TLB, COW, demand paging in detail
-   **L5**: Can describe architecture of virtual memory on one or more existing system, including trade-offs
-   **L6/7**: Demonstrated precise understanding of implementation details and challenges on multiple existing systems

## Filesystems 6 Questions

<a id="fs-inodes"></a>

### \[inodes\] What information is stored in an inode?

L3–L5

#### Question

What information is stored in an inode? How is this information used? How are file system inodes connected to in-memory inodes?

**Caveat:** This question also appears in the pre-screen questions. Do not repeat. If the candidate doesn't know what an inode is, consider guiding them. Focus on the follow-up questions.

#### Answer

An inode is the on-disk (and in-memory) representation of a file in the file system. It stores all metadata about a file EXCEPT the filename.

#### Inode Contents

```text
struct inode (on-disk, ext4 as example):
════════════════════════════════════════

Field                  Description
──────────────────── ─ ─────────────────────────────────
i_mode               File type + permissions (rwxrwxrwx)
i_uid                Owner user ID
i_gid                Owner group ID
i_size               File size in bytes
i_atime              Last access time
i_mtime              Last modification time
i_ctime              Last inode change time (NOT creation)
i_links_count        Number of hard links to this inode
i_blocks             Number of 512-byte blocks allocated
i_block[15]          Pointers to data blocks:
                       [0-11]  → 12 direct block pointers
                       [12]    → indirect (points to block of pointers)
                       [13]    → double indirect
                       [14]    → triple indirect
i_flags              Immutable, append-only, etc.

In ext4, also: extents (instead of block pointers for large files)
```

```text
Block Pointers (Traditional Unix FS):
═════════════════════════════════════

inode
┌──────────┐
│ direct 0  │ → [data block]
│ direct 1  │ → [data block]
│ ...        │
│ direct 11 │ → [data block]         ← 12 × 4KB = 48KB directly
│            │
│ indirect   │ → [ptr block] → [data blocks]        ← ~4MB
│ dbl indir  │ → [ptr] → [ptr block] → [data]       ← ~4GB
│ tpl indir  │ → [ptr] → [ptr] → [ptr] → [data]     ← ~4TB
└──────────┘

ext4 uses EXTENTS instead (more efficient for large files):
  (start_block, length) tuples stored in inode or extent tree
```

#### Commands

```
# View inode information
stat /etc/passwd
ls -li /etc/passwd   # -i shows inode number

# Inode usage on filesystem
df -i

# Find file by inode number
find / -inum 12345

# Detailed inode info (ext4)
debugfs -R 'stat <12345>' /dev/sda1

# In-memory inode cache
cat /proc/sys/fs/inode-nr   # allocated vs free inodes in slab cache
slabtop | grep inode
```

#### What is NOT in an Inode

-   **Filename** — stored in directory entries, not the inode itself
-   **File content** — stored in data blocks pointed to by the inode
-   This separation is why hard links work: multiple directory entries point to the same inode

##### Follow-up Questions

-   How do I see the inode information for a file? (`stat`, `ls -i`)
-   What information is stored in an inode? vs what is stored in a directory?
-   What happens when a hard link is deleted? When does the content of the file get deleted?
-   What is the difference between `ctime` and `mtime`?

<a id="fs-unix-types"></a>

### \[inodes\] In-depth discussion of how Unix-type filesystems are organized

L4–L5

#### Question

Describe in-depth how Unix-type filesystems are organized.

#### Filesystem Layout (ext4)

```text
Disk Layout:
═══════════

┌──────────┬──────────────────────────────────────────────────┐
│Boot Block│              Block Group 0                        │
│(1024 B)  │                                                   │
├──────────┼─────────┬──────┬──────┬─────────┬────────────────┤
│          │Super    │Group │Block │ Inode   │ Data Blocks     │
│          │Block    │Desc  │Bitmap│ Bitmap  │                 │
│          │         │Table │      │         │ Inode Table     │
├──────────┼─────────┼──────┼──────┼─────────┼────────────────┤
│          │              Block Group 1                        │
│          ├─────────┬──────┬──────┬─────────┬────────────────┤
│          │Super    │Group │Block │ Inode   │ Data Blocks     │
│          │(backup) │Desc  │Bitmap│ Bitmap  │                 │
│          │         │(bkup)│      │         │ Inode Table     │
└──────────┴─────────┴──────┴──────┴─────────┴────────────────┘

Key Components:
  Superblock:    Filesystem metadata (block size, inode count, free blocks)
  Group Desc:    Per-group metadata (bitmap locations, free counts)
  Block Bitmap:  1 bit per block (0=free, 1=used)
  Inode Bitmap:  1 bit per inode (0=free, 1=used)
  Inode Table:   Array of inode structures
  Data Blocks:   Actual file content + directory entries
```

#### Directory Structure

```text
A directory is just a file whose data blocks contain directory entries:

Directory "/home/user":
┌────────────┬──────────┬────────────┬───────────┐
│ inode: 100 │ rec_len  │ name_len:1 │ name: "." │  ← current dir
├────────────┼──────────┼────────────┼───────────┤
│ inode: 50  │ rec_len  │ name_len:2 │ name: ".."│  ← parent dir
├────────────┼──────────┼────────────┼───────────┤
│ inode: 201 │ rec_len  │ name_len:8 │ name:"doc"│  ← regular file
├────────────┼──────────┼────────────┼───────────┤
│ inode: 202 │ rec_len  │ name_len:5 │ name:"pics"│ ← subdirectory
└────────────┴──────────┴────────────┴───────────┘

Looking up "/home/user/docs/file.txt":
  1. Start at root inode (inode 2)
  2. Read root directory data → find "home" → inode 50
  3. Read inode 50 data → find "user" → inode 100
  4. Read inode 100 data → find "docs" → inode 201
  5. Read inode 201 data → find "file.txt" → inode 305
  6. Read inode 305 → get file metadata + block pointers
```

#### Virtual Filesystem (VFS) Layer

```text
Linux VFS — Uniform Interface to All Filesystem Types
═════════════════════════════════════════════════════

  User Space:  open() / read() / write() / stat()
       │
       ▼
  VFS Layer:   struct file_operations {
                 .read = generic_file_read_iter,
                 .write = generic_file_write_iter,
                 .open = ext4_file_open,
                 ...
               }
       │
       ├── ext4       → ext4_readdir(), ext4_lookup()
       ├── xfs        → xfs_file_read_iter()
       ├── btrfs      → btrfs_readdir()
       ├── tmpfs      → shmem_readdir()
       ├── procfs     → proc_readdir()
       ├── sysfs      → sysfs_readdir()
       └── NFS        → nfs_readdir()

Key VFS objects:
  struct super_block   → Represents a mounted filesystem
  struct inode         → In-memory inode (cached from disk)
  struct dentry        → Directory entry cache (name → inode mapping)
  struct file          → Open file instance (position, flags)
```

<a id="fs-symlinks-hardlinks"></a>

### \[links\] Symlinks v. Hardlinks. Discuss.

L3–L5

#### Question

Symlinks v. Hardlinks. Discuss.

#### Answer

|  | Hard Link | Symbolic (Soft) Link |
| --- | --- | --- |
| **What it is** | Additional directory entry pointing to same inode | A special file or another file, containing a path to the target |
| **Inode** | Same inode number as original | Different inode (its own inode, content = path string) |
| **Cross filesystem** | No — must be on same filesystem | Yes — can point anywhere |
| **Directories** | Cannot hard link directories (to prevent cycles) | Can symlink to directories |
| **Target deleted** | File still accessible (link count decremented) | Dangling symlink (broken) |
| **Performance** | Direct inode lookup (fast) | Extra dereference (read symlink → then resolve path) |
| **`ls -l`** | Looks like regular file, link count > 1 | Shows `l` type, displays `→ target` |

```text
Hard Link:
──────────
  Directory A:              Directory B:
  "file.txt" → inode 42    "backup.txt" → inode 42
                     ↓
              ┌────────────┐
              │ Inode 42    │  i_links_count = 2
              │ size, perms │  Same content, same metadata
              │ block ptrs  │
              └────────────┘
  Delete "file.txt" → i_links_count = 1, data NOT freed
  Delete "backup.txt" → i_links_count = 0, data freed


Symbolic Link:
──────────────
  "shortcut" → inode 99 (type: symlink)
                 ↓
  Content of inode 99's data: "/path/to/original"
                                ↓
  Kernel: resolve "/path/to/original" → inode 42 → actual data

  Delete original → "shortcut" still exists but points to nothing (ENOENT)
```

```
# Create hard link
ln original.txt hardlink.txt
ls -li original.txt hardlink.txt  # Same inode number!

# Create symbolic link
ln -s original.txt symlink.txt
ls -li symlink.txt  # Different inode, shows →

# Find all hard links to a file
find / -samefile original.txt
find / -inum $(stat -c '%i' original.txt)

# Read where a symlink points
readlink symlink.txt
readlink -f symlink.txt  # Fully resolve (follow chain)

# Check link count
stat -c '%h' original.txt
```

##### Follow-up Questions

-   What information is stored in an inode?
-   What happens when a hard link is deleted? When does the content of the file get deleted?
-   How does the `lstat()` system call differ from `stat()`?
-   Why can't you hard link directories? (Prevents cycles in the directory graph)

##### Leveling Guidance

-   **L3**: Knows the basics of symlinks and hardlinks
-   **L4**: Can explain the difference in terms of inodes and directory entries, understands cross-filesystem limitation
-   **L5**: Understands kernel implementation, knows about `AT_EMPTY_PATH`, `O_NOFOLLOW`, can explain symlink resolution in the VFS

<a id="fs-permissions"></a>

### \[perms\] On native UNIX filesystems, talk about the 12-bit permissions block

L3–L5

#### Question

On native UNIX filesystems, talk about the 12-bit permissions block. Sticky bits, setuid/setgid bits: how do they work differently on directories? If a file is not owned by you, but you are in the same group as the file, and the file has permission 0707, can you read the file? Why/why not?

#### Answer

```text
The 12-bit Permission Field:
════════════════════════════

  Bit layout (octal representation):
  ┌───┬───┬───┬───┐
  │ S │ U │ G │ O │
  │sst│rwx│rwx│rwx│
  └───┴───┴───┴───┘

  Special bits (S):
    4 = setuid (s in user execute)
    2 = setgid (s in group execute)
    1 = sticky (t in other execute)

  Example: 4755 = -rwsr-xr-x (setuid + rwx for owner, rx for group/other)

Permission Check Order (FIRST match wins):
  1. Are you the owner? → Use owner bits (U)
  2. Are you in the group? → Use group bits (G)  ← STOPS HERE
  3. Otherwise → Use other bits (O)
```

#### The 0707 Trick Question

**0707 = ---rwx---rwx**  
If you are in the file's group, the GROUP bits apply: `---` (no permissions!). You CANNOT read the file, even though "other" has rwx. The kernel stops at the first matching category.

#### Special Permissions Deep Dive

| Bit | On Files | On Directories |
| --- | --- | --- |
| **setuid** (4) | Execute as file owner's UID (e.g., `/usr/bin/passwd`) | No standard effect on Linux |
| **setgid** (2) | Execute as file group's GID | New files inherit directory's group (not creator's group) |
| **sticky** (1) | Historically: keep in swap. Modern: ignored for files | Only file owner/dir owner/root can delete files (`/tmp` uses this) |

```
# View permissions including special bits
stat -c '%a %A %n' /usr/bin/passwd
# Output: 4755 -rwsr-xr-x /usr/bin/passwd

# /tmp with sticky bit
ls -ld /tmp
# drwxrwxrwt — the 't' means sticky bit set

# Set setuid
chmod u+s program     # or chmod 4755 program

# Set setgid on directory (new files inherit group)
chmod g+s /shared/    # or chmod 2775 /shared/

# Set sticky bit on directory
chmod +t /shared/     # or chmod 1777 /shared/

# Find all setuid binaries (security audit)
find / -perm -4000 -type f -ls 2>/dev/null

# Find all setgid binaries
find / -perm -2000 -type f -ls 2>/dev/null
```

##### Follow-up Questions

-   How does UNIX know that an executable file is executable? (Check +x permission, read magic bytes for format)
-   How do setuid/setgid programs deal with shared libraries?
-   What are the limitations of this model and how can they be addressed? (ACLs, SELinux, capabilities)

<a id="fs-pwd"></a>

### \[pwd\] Implement the "pwd" command.

L4–L5

#### Question

How would you implement the `pwd` command? How do you figure out the absolute path of the current directory?

#### Answer

The general approach is to recurse up the directory tree from the current directory to the root by repeatedly looking at `..` entries.

#### Algorithm

1.  `stat(".")` to get the inode of the current directory
2.  `stat("/")` to get the root inode — this is our stopping condition
3.  While current inode != root inode:
    -   Open `..` (parent directory)
    -   Read directory entries to find which entry has our inode number
    -   Push that name onto a stack
    -   `chdir("..")` and repeat
4.  Print the names from root to current

#### Implementation

```
#include <stdio.h>
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>
#include <string.h>

#define MAX_PATH 4096

ino_t get_inode(const char *path) {
    struct stat sb;
    stat(path, &sb);
    return sb.st_ino;
}

dev_t get_dev(const char *path) {
    struct stat sb;
    stat(path, &sb);
    return sb.st_dev;
}

int main() {
    char path[MAX_PATH] = "";
    char components[256][256];
    int depth = 0;

    ino_t root_inode = get_inode("/");
    ino_t cur_inode = get_inode(".");

    while (cur_inode != root_inode) {
        ino_t target = cur_inode;
        chdir("..");
        cur_inode = get_inode(".");

        /* Read parent directory to find our name */
        DIR *dp = opendir(".");
        struct dirent *entry;
        while ((entry = readdir(dp)) != NULL) {
            if (entry->d_ino == target) {
                strcpy(components[depth++], entry->d_name);
                break;
            }
        }
        closedir(dp);
    }

    /* Print path from root to current */
    if (depth == 0) {
        printf("/");
    } else {
        for (int i = depth - 1; i >= 0; i--)
            printf("/%s", components[i]);
    }
    printf("\n");
    return 0;
}
```

**Edge cases to consider:**

-   Crossing filesystem boundaries (check `st_dev` too, not just `st_ino`)
-   Bind mounts may cause `st_dev` differences
-   The real `getcwd()` syscall uses `d_path()` in the kernel which walks the dentry cache — much faster

<a id="fs-lsof"></a>

### \[lsof\] Implement the "lsof" command.

L4–L5

#### Question

How would you implement the `lsof` command?

#### Answer

`lsof` lists open files for processes. On Linux, everything is exposed via `/proc`:

```
# For each process, /proc/PID/fd/ contains symlinks to open files
ls -la /proc/$$/fd/
# 0 → /dev/pts/0 (stdin)
# 1 → /dev/pts/0 (stdout)
# 2 → /dev/pts/0 (stderr)
# 3 → /home/user/file.txt (open file)

# /proc/PID/fdinfo/N has offset, flags, mnt_id
cat /proc/$$/fdinfo/0
```

#### Simplified lsof Implementation

```
#!/bin/bash
# Simplified lsof using /proc

printf "%-8s %-6s %-4s %s\n" "COMMAND" "PID" "FD" "NAME"

for pid_dir in /proc/[0-9]*; do
    pid=$(basename "$pid_dir")
    comm=$(cat "$pid_dir/comm" 2>/dev/null) || continue

    for fd in "$pid_dir"/fd/*; do
        fd_num=$(basename "$fd")
        target=$(readlink "$fd" 2>/dev/null) || continue
        printf "%-8s %-6s %-4s %s\n" "$comm" "$pid" "$fd_num" "$target"
    done
done
```

#### Kernel Perspective

```text
Process File Descriptor Table (kernel)
═══════════════════════════════════════

task_struct
  └── files (struct files_struct)
        └── fdt (struct fdtable)
              └── fd[] (array of struct file *)
                    [0] → struct file { f_path, f_pos, f_op, f_mode }
                    [1] → struct file { ... }
                    [2] → struct file { ... }
                    [3] → struct file { f_path → /home/user/data.txt }

struct file:
  f_path    → (vfsmount, dentry) → full path
  f_pos     → current read/write offset
  f_op      → file_operations (read, write, mmap, ...)
  f_mode    → FMODE_READ | FMODE_WRITE
  f_flags   → O_RDONLY, O_NONBLOCK, etc.
  f_count   → reference count (fork shares, close decrements)
```

## Containers & VMs 2 Questions

<a id="cont-vs-vm"></a>

### \[containers-vs-vm\] What is a container and how is it different to a Virtual Machine?

L3–L5

#### Question

Can we talk about containers? What is a container and how is it different from a VM? Think about what specific technologies like Docker, LXC, Zones, VMs use. Discuss three filtering mechanisms: the host level, the container level, and the VM level.

#### Answer

|  | Container | Virtual Machine |
| --- | --- | --- |
| **Isolation** | OS-level (namespaces + cgroups), shares host kernel | Hardware-level (hypervisor), own kernel |
| **Startup** | Milliseconds (no kernel boot) | Seconds to minutes (full OS boot) |
| **Overhead** | Minimal (process-level) | Significant (full OS + virtual hardware) |
| **Density** | 100s–1000s per host | 10s per host |
| **Security** | Shared kernel = larger attack surface | Strong isolation (separate kernels) |
| **Use case** | Microservices, CI/CD, dev environments | Multi-tenant, different OS, strong isolation |

```text
Virtual Machine Architecture:
═════════════════════════════

┌──────────┐ ┌──────────┐ ┌──────────┐
│   App A   │ │   App B   │ │   App C   │
├──────────┤ ├──────────┤ ├──────────┤
│ Bins/Libs │ │ Bins/Libs │ │ Bins/Libs │
├──────────┤ ├──────────┤ ├──────────┤
│ Guest OS  │ │ Guest OS  │ │ Guest OS  │  ← Full kernel each!
└────┬─────┘ └────┬─────┘ └────┬─────┘
     └────────────┼────────────┘
          ┌───────┴───────┐
          │  Hypervisor    │  (KVM, Xen, VMware)
          ├───────────────┤
          │   Host OS      │
          ├───────────────┤
          │   Hardware     │
          └───────────────┘


Container Architecture:
═══════════════════════

┌──────────┐ ┌──────────┐ ┌──────────┐
│   App A   │ │   App B   │ │   App C   │
├──────────┤ ├──────────┤ ├──────────┤
│ Bins/Libs │ │ Bins/Libs │ │ Bins/Libs │
└────┬─────┘ └────┬─────┘ └────┬─────┘
     │ namespaces  │  cgroups   │
     └────────────┼────────────┘
          ┌───────┴───────┐
          │ Container      │  (Docker, containerd, CRI-O)
          │ Runtime        │
          ├───────────────┤
          │ Shared Kernel  │  ← ONE kernel for all!
          ├───────────────┤
          │   Hardware     │
          └───────────────┘
```

#### Common Container Implementations

-   **Docker** / **containerd** — most popular, uses Linux namespaces + cgroups
-   **LXC** / **LXD** — system containers (more like lightweight VMs)
-   **Solaris Zones** / FreeBSD Jails — older OS-level virtualization
-   **gVisor** — user-space kernel for stronger isolation
-   **Kata Containers** — lightweight VMs that look like containers

<a id="cont-isolation"></a>

### \[namespaces\] How are containers isolated from themselves and the host?

L4–L5

#### Question

By what mechanisms are containers separated from each other and from the host OS?

#### Answer

Containers use two primary kernel features: **namespaces** (isolation) and **cgroups** (resource limits). Plus additional mechanisms like seccomp, capabilities, and AppArmor/SELinux.

#### Linux Namespaces (8 types)

| Namespace | Isolates | Flag | Example |
| --- | --- | --- | --- |
| `mnt` | Mount points | `CLONE_NEWNS` | Container sees its own `/` |
| `pid` | Process IDs | `CLONE_NEWPID` | Container PID 1 ≠ host PID 1 |
| `net` | Network stack | `CLONE_NEWNET` | Own interfaces, IPs, routes, iptables |
| `uts` | Hostname | `CLONE_NEWUTS` | Container has own hostname |
| `ipc` | IPC resources | `CLONE_NEWIPC` | Separate SysV IPC, message queues |
| `user` | User/group IDs | `CLONE_NEWUSER` | Root in container ≠ root on host |
| `cgroup` | Cgroup root | `CLONE_NEWCGROUP` | Container sees its own cgroup tree |
| `time` | Clock | `CLONE_NEWTIME` | Introduced in 5.6 (boot/monotonic) |

```text
How Docker Creates a Container (simplified):
═════════════════════════════════════════════

  dockerd receives "docker run alpine /bin/sh"
       │
       ▼
  containerd → runc (OCI runtime)
       │
       ▼
  runc calls clone() with namespace flags:
    clone(CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWNET |
          CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER)
       │
       ├── New PID namespace → process is PID 1 inside
       ├── New mount namespace → pivot_root to container rootfs
       ├── New network namespace → veth pair (container ↔ bridge)
       ├── New UTS namespace → set hostname
       └── New user namespace → map UID 0 → host UID 100000
       │
       ▼
  Set up cgroups:
    /sys/fs/cgroup/cpu/docker/<container-id>/cpu.max
    /sys/fs/cgroup/memory/docker/<container-id>/memory.max
    /sys/fs/cgroup/pids/docker/<container-id>/pids.max
       │
       ▼
  Apply security:
    seccomp filter (block dangerous syscalls)
    Drop capabilities (CAP_SYS_ADMIN, etc.)
    AppArmor/SELinux profile
       │
       ▼
  exec("/bin/sh") inside the container
```

#### Cgroups v2 Resource Control

```
# View container's cgroup limits
cat /sys/fs/cgroup/system.slice/docker-<id>.scope/cpu.max
cat /sys/fs/cgroup/system.slice/docker-<id>.scope/memory.max
cat /sys/fs/cgroup/system.slice/docker-<id>.scope/pids.max

# Set CPU limit (100ms per 200ms period = 50% CPU)
echo "100000 200000" > cpu.max

# Set memory limit (512MB)
echo 536870912 > memory.max

# View current usage
cat memory.current
cat cpu.stat

# View namespaces of a process
ls -la /proc/$$/ns/
# ipc -> ipc:[4026531839]
# mnt -> mnt:[4026531840]
# net -> net:[4026531992]
# pid -> pid:[4026531836]

# Enter a container's namespace
nsenter --target <PID> --mount --uts --ipc --net --pid
```

```text
Container Network Namespace (veth pair):
════════════════════════════════════════

Host Network Namespace          Container Network Namespace
┌───────────────────────┐      ┌──────────────────────────┐
│                       │      │                          │
│  eth0 (10.0.0.50)     │      │  eth0 (172.17.0.2)       │
│  docker0 (172.17.0.1) │      │    ↑                     │
│    │                   │      │    │                     │
│    ├── veth123abc ─────┼──────┼── veth (renamed eth0)    │
│    ├── veth456def ─────┼──┐   │                          │
│    └── ...             │  │   └──────────────────────────┘
│                       │  │
│  iptables NAT:        │  │   Container 2 Network Namespace
│  172.17.0.0/16 →      │  │   ┌──────────────────────────┐
│    MASQUERADE          │  └───┼── veth (renamed eth0)    │
│                       │      │  eth0 (172.17.0.3)       │
└───────────────────────┘      └──────────────────────────┘
```

**WARNING:** This isn't school; don't expect candidates to reel off all eight namespaces perfectly. A good candidate might only get three or four, but if they can't get at least mount and networking, they aren't showing a good understanding of containers.

##### Leveling Guidance

-   **L3**: Can name at least 2 different namespaces
-   **L4**: Can explain 3-4 namespaces plus cgroups, understands the kernel mechanisms
-   **L5**: Deep understanding of all namespace types, can explain seccomp, capabilities, rootless containers, and edge cases

## SysAdmin 8 Questions

<a id="sys-copy-verify"></a>

### \[copy-verify\] Copy host A's disk to host B's disk and verify.

L3–L4

#### Question

Copy host A's disk to host B's disk and verify. You are at host A.

#### Answer

```
# Method 1: dd over SSH (block-level copy)
dd if=/dev/sda bs=64K | ssh hostB "dd of=/dev/sda bs=64K"

# Verify with checksums
ssh hostA "md5sum /dev/sda" &
ssh hostB "md5sum /dev/sda" &
wait  # Compare the two checksums

# Method 2: dd + netcat (faster, no encryption overhead)
# On host B (receiver):
nc -l -p 9000 | dd of=/dev/sda bs=64K

# On host A (sender):
dd if=/dev/sda bs=64K | nc hostB 9000

# Method 3: rsync for filesystem-level copy
rsync -avz --progress / hostB:/ --exclude /proc --exclude /sys

# Verify: compare checksums
# On host A:
sha256sum /dev/sda | ssh hostB "sha256sum -c -"
```

**Key points for interviewer:**

-   Does candidate know if the tar completed successfully in their solution? (`$?` check, `set -o pipefail`)
-   Do they validate the copy? (hash verification is critical)
-   Do they consider that the filesystem should ideally be unmounted/read-only during copy?
-   The candidate doesn't need to know syntax perfectly — understanding the concepts matters more

<a id="sys-diskless-boot"></a>

### \[diskless\] How does network/diskless boot work? (tcp, ftp, bootp)

L3–L5

#### Question

How does a network/diskless boot work?

#### Answer

A diskless boot has no permanent storage, so there are generally two stages: getting an IP address and getting the boot image.

1.  **PXE firmware** sends DHCPDISCOVER broadcast
2.  **DHCP server** responds with IP + next-server (TFTP) + boot filename
3.  **TFTP transfer** — download boot loader (pxelinux.0 or iPXE)
4.  **Boot loader** downloads kernel + initrd via TFTP/HTTP
5.  **Kernel boots**, mounts root filesystem via NFS or iSCSI

**Modern approaches:** iPXE extends PXE with HTTP/HTTPS support, UEFI HTTP boot can skip TFTP entirely. Cloud providers use similar techniques with cloud-init for instance metadata.

<a id="sys-pid-init"></a>

### \[init\] What process is PID=1? What does it do? How does it know?

L3–L5

#### Question

What process is PID 1? What does it do? How does it know what to start?

#### Answer

PID 1 is the `init` process — the first (and possibly only) user process brought up by the kernel. It is responsible for configuring the system and starting daemons. It is the ultimate progenitor to (nearly) all user processes and becomes the parent for any orphaned processes.

```text
Kernel Boot → PID 1
═══════════════════

Bootloader (GRUB) → loads vmlinuz + initrd
  → Kernel: start_kernel()
    → ... hardware init, scheduler init, memory init ...
    → kernel_init()
      → Try to exec, in order:
        1. /sbin/init
        2. /etc/init
        3. /bin/init
        4. /bin/sh (last resort)
      → This becomes PID 1

init Systems Evolution:
  SysV init  →  Upstart  →  systemd (most Linux distros today)
  (sequential)  (event)     (parallel, dependency graph, socket activation)
```

#### PID 1 Special Properties

-   **Cannot be killed** — kernel ignores SIGKILL/SIGSTOP for PID 1
-   **Reaps orphans** — becomes parent of any process whose parent exits
-   **If PID 1 exits, kernel panics** — the system cannot function without init
-   **Signal handling** — PID 1 only receives signals it has registered handlers for (unlike other processes)

```
# What is PID 1?
ps -p 1 -o pid,comm,args
# PID COMMAND     COMMAND
#   1 systemd     /sbin/init

# systemd: view service dependencies
systemctl list-dependencies
systemctl list-units --type=service --state=running

# Boot process timeline
systemd-analyze
systemd-analyze blame    # Slowest services
systemd-analyze critical-chain

# In containers: PID 1 matters too!
# Docker: CMD/ENTRYPOINT becomes PID 1
# Must handle SIGTERM! Or use tini/dumb-init
```

##### Follow-up Questions

-   What happens if init process dies? (Kernel panic)
-   How does systemd know what services to start and in what order?
-   Why is PID 1 special for signal handling in containers?
-   What is `tini` / `dumb-init` and why do containers need it?

<a id="sys-load-average"></a>

### \[loading\] What is loading? What do the three #s in uptime represent?

L3–L5

#### Question

What is load average? What do the three numbers in `uptime` represent?

#### Answer

Load average is the average number of processes in the run queue or a given period. The three numbers in uptime represent the 1-minute, 5-minute, and 15-minute exponentially-weighted moving averages.

```
$ uptime
 14:32:01 up 45 days, 3:21, 2 users, load average: 2.15, 1.89, 1.45
                                                     ^^^   ^^^   ^^^
                                                     1min  5min  15min
```

#### What Counts as "Load"

-   **Running processes** (R state) — on CPU or waiting for CPU
-   **Uninterruptible sleep** (D state) — typically waiting for disk I/O
-   Unlike other Unixes, Linux includes D-state processes (I/O wait) in load average

**Interpreting load average:**

-   On a single-CPU system: load 1.0 = fully utilized
-   On a 4-core system: load 4.0 = fully utilized, load 8.0 = double overloaded
-   A rising number (1min > 5min > 15min) indicates increasing load
-   High load + low CPU usage often indicates I/O bottleneck (many D-state processes)

```
# Check load average
uptime
cat /proc/loadavg
# 2.15 1.89 1.45 3/245 12345
#                 ^^^^^
#                 running_threads/total_threads  last_pid

# Check number of CPUs (to interpret load)
nproc
grep -c processor /proc/cpuinfo

# Find D-state (uninterruptible) processes contributing to load
ps aux | awk '$8 ~ /D/'

# More detailed: top, htop, or vmstat
vmstat 1    # r = run queue, b = blocked (D state)
```

<a id="sys-remove-f"></a>

### \[remove-f\] How might you remove a file named -f?

L3–L5

#### Question

How might you remove a file named `-f`?

**NOTE:** This question is not about understanding the `rm -f` (force) option. It is about understanding how shell argument processing (POSIX argument handling) and the `--` end-of-options marker work.

#### Answer

```
# Method 1: Use -- to mark end of options (POSIX standard)
rm -- -f

# Method 2: Use ./ prefix to avoid leading dash
rm ./-f

# Method 3: Use full path
rm /path/to/-f

# Method 4: Use find
find . -name '-f' -delete

# Method 5: Using inode number
ls -i     # find the inode of -f
find . -inum 12345 -delete
```

#### Why `--` Works

The POSIX/GNU convention is that `--` signals the end of options. Everything after `--` is treated as a positional argument, not a flag. This works for virtually any POSIX-compliant CLI tool.

```
# This also works for other "problem" filenames
touch -- --help         # Create a file named --help
cat -- --help           # Read the file (not display help)
ls -- -la               # List a file named -la

# GNU getopt processing: flags → "--" → positional args
# e.g.: rm -v -- -f   means: verbose mode, delete file named "-f"
```

##### Follow-up Questions

-   How would you create a file named `-f` in the first place? (`touch -- -f`)
-   What about files with spaces, newlines, or unicode in their names?
-   How does the shell/kernel/libc handle the `--` convention? Where is it implemented?

<a id="sys-apache-advisory"></a>

### \[advisory\] It's 4pm on Friday. A security advisory for Apache pops into your inbox.

L4–L7

#### Question

It's 4pm on a Friday and you get a mail that says "last batch alert: apache recently was found to contain a previously unknown attack." What do you do?

#### Answer — Structured Incident Response

#### Good things to hear

-   Not panicking. Acknowledge that changing things on Friday at 4pm is risky.
-   Don't be affected by "Friday 4pm" pressure — assess first
-   By not doing nothing: the security risk is real and needs assessment
-   Acknowledging that balancing the risk of leaving the system unpatched with the risk of a botched deployment: rushed fixes can make things worse

#### Bad things to hear

-   "I would just patch right away"
-   "I would tell the patch in the lab and then roll it out everywhere"

#### Impact Assessment

-   Is the vulnerability **actively exploited** in the wild?
-   Is our service externally facing / internet-reachable?
-   Which version(s) are affected? Are we running an affected version?
-   What's the CVSS score / severity?
-   Do we have WAF/reverse proxy that could provide interim mitigation?
-   Can we use the feature flag system to reduce exposure?

#### Communication

-   How do we authenticate the warning? Is the URL in the "advisory" pointing to a known legitimate source?
-   Who do we tell? How do people get status updates? Who do the pointy-hairs get called? How do we prevent that impeding actual progress?
-   Longer term: did we lose data? Did data get corrupted? How do we tell? Who do we inform?

#### Workarounds

-   Reverse proxy to block the attack pattern
-   If they already have a reverse proxy set up, this makes sense. Configurating that is safer than patching Apache
-   Rate limiting, IP blocking, WAF rules
-   Disable specific Apache modules if the vulnerability is module-specific

#### Rollout (if patching)

-   **Good:** Test it in the lab first on one machine. Do a controlled upgrade over the course of N hours. Bonus points if you tell the proxy to mark your origin server as unhealthy during the upgrade
-   **Bad:** Just install it on every machine

##### Evaluation Guidance

-   **L4**: Shows structured thinking, assesses risk before acting
-   **L5**: Considers impact scope, communication plan, interim mitigations, staged rollout
-   **L6/7**: Discusses organizational response, fleet-wide audit, post-incident learning, automation of future responses

<a id="sys-passwordless-ssh"></a>

### \[ssh-agent\] How do you set up passwordless SSH? What if I set up ssh-agent?

L3–L5

#### Question

How do I set up passwordless SSH? What if I sell/exit my private key protected with a passphrase? ssh-agent?

#### Answer — Things to Cover

1.  Set up a key pair (`ssh-keygen`)
2.  Put the private key somewhere safe (`-i` argument to ssh, or `~/.ssh/id_rsa`)
3.  Put the public key in `~/.ssh/authorized_keys` on the remote machine
4.  If passphrase was set, ask about protecting the key from physical compromise
5.  If no mention of `ssh-agent`, ask about avoiding entering passphrase every time
6.  Modern security: hardware keys (YubiKey), key rotation, certificate-based SSH

```
# Generate key pair
ssh-keygen -t ed25519 -C "user@host"
# Creates: ~/.ssh/id_ed25519 (private) and ~/.ssh/id_ed25519.pub (public)

# Copy public key to remote host
ssh-copy-id user@remote-host
# OR manually:
cat ~/.ssh/id_ed25519.pub | ssh user@remote "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"

# ssh-agent: cache decrypted key in memory
eval $(ssh-agent)        # Start agent
ssh-add ~/.ssh/id_ed25519 # Add key (enter passphrase once)
ssh-add -l               # List cached keys

# Now SSH without passphrase prompt:
ssh user@remote-host     # Agent provides the key
```

#### How ssh-agent Works

```text
ssh-agent Architecture:
═══════════════════════

  ssh-agent (daemon process)
  ├── Listens on Unix domain socket: $SSH_AUTH_SOCK
  ├── Holds decrypted private keys in memory
  └── Accepts signing requests from ssh clients

  Flow:
  1. ssh connects to remote server
  2. Remote server sends challenge
  3. ssh asks ssh-agent (via socket) to sign the challenge
  4. ssh-agent signs with the private key IN MEMORY
  5. ssh sends signed response to server
  → Private key NEVER leaves the agent's memory
  → Private key NEVER sent over the network

  Agent Forwarding (ssh -A):
  ┌─────────┐    ┌─────────┐    ┌─────────┐
  │ Laptop   │───→│ Jump Box │───→│ Target   │
  │ (agent)  │    │ (forward)│    │ (auth)   │
  └─────────┘    └─────────┘    └─────────┘
  Agent socket forwarded: target asks jumpbox,
  jumpbox asks your laptop's agent to sign
```

##### Follow-up Questions

-   If I have ssh-agent running on my computer at work and I'm SSHed in from home, can I piggyback on the ssh-agent I have running?
-   What if the server gets broken into and /root/.ssh/authorized\_keys is stolen. Do you have to re-generate your key?
-   What mitigations can be put in place to prevent the private key and passphrase being stolen? (Manage keys centrally, certificate-based, hardware tokens)

##### Evaluation Guidance

-   **L3**: Familiar with basic security properties of public key cryptography
-   **L5**: Can reason about threat models and manageability at scale, may need some prompting
-   **L7**: Can design a solid solution over the available mechanisms and their properties without prompting

<a id="sys-timestamps"></a>

### \[timestamps\] On native UNIX filesystems, files have three different times. Describe.

L3–L5

#### Question

On native UNIX filesystems, files have three different times associated with them. Describe them. What can you use atime for? How could you get the benefits of atime without the costs?

#### Answer

| Timestamp | Name | Updated When | Example |
| --- | --- | --- | --- |
| `atime` | Access time | File content is read | `cat file`, `less file` |
| `mtime` | Modification time | File content is modified | `echo "x" >> file`, `vim` save |
| `ctime` | Change time (inode change) | Inode metadata changes | `chmod`, `chown`, `mv`, `ln` |

**Common misconception:** `ctime` is NOT creation time. Unix traditionally has no creation time. ext4 has `crtime` (birth time) but it's not exposed through standard POSIX APIs. Use `stat` or `debugfs` to see it.

```
# View all timestamps
stat filename
#   Access: 2026-05-10 14:30:00.000000000 -0700
#   Modify: 2026-05-09 10:15:00.000000000 -0700
#   Change: 2026-05-09 10:15:00.000000000 -0700
#    Birth: 2026-05-01 09:00:00.000000000 -0700  (ext4 only)

# ls shows different timestamps
ls -l file     # mtime (default)
ls -lu file    # atime
ls -lc file    # ctime

# Find files accessed in last 7 days
find /tmp -atime -7

# Find files modified in last 24 hours
find /var/log -mtime -1
```

#### Disable atime

Many systems mount filesystems with atime disabled (`noatime` mount option). Reading a file triggers an inode update (write!) for every read — this is expensive on rotating disks and reduces SSD lifespan.

```
# Mount with noatime
mount -o noatime /dev/sda1 /mnt

# Or use relatime (default on modern Linux)
# Only updates atime if: atime < mtime, or atime older than 24h
mount -o relatime /dev/sda1 /mnt

# In /etc/fstab:
/dev/sda1  /  ext4  defaults,noatime  0 1
```

#### Use Case for atime

-   `tmpwatch` / `tmpreaper` — remove files from `/tmp` that haven't been accessed in N days
-   Incremental backups — only back up files accessed since last backup
-   Old-school "you have new mail" indicator (check mbox `atime` vs `mtime`)

##### Follow-up Questions

-   How could you get the benefits of atime without the costs? (`relatime` mount option)
-   What information is stored in an inode? (Links to inode question)
-   On a conventional disk, what is the extra write overhead for atime updates? (Read-modify-write of inode block)
