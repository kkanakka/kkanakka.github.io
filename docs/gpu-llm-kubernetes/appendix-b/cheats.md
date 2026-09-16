---
title: "Command cheat sheet"
slug: /gpu-llm-kubernetes/cheats
sidebar_position: 1
sidebar_label: "Command cheat sheet"
description: "Appendix B"
---

<!-- DIAGRAM:sequence:START -->

## How it works

<img src="/diagrams/cheats/sequence.svg" alt="How it works" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->
### GPU

<pre><code>nvidia-smi                                    <span class="gm-c"># overview</span>
nvidia-smi -l 1                               <span class="gm-c"># refresh every second</span>
nvidia-smi --query-gpu=utilization.gpu,memory.used,temperature.gpu,power.draw --format=csv -l 1
nvidia-smi topo -m                            <span class="gm-c"># NUMA / NVLink map</span>
nvidia-smi -q -d ERR,ECC,CLOCK,PERFORMANCE     <span class="gm-c"># faults and throttle reasons</span>
dcgmi discovery -l; dcgmi diag -r 1           <span class="gm-c"># DCGM inventory and quick diag</span>
nsys profile -o run python train.py           <span class="gm-c"># timeline profile (find CPU gaps)</span>
ncu --set full python train.py                <span class="gm-c"># per-kernel roofline metrics</span></code></pre>

### Kubernetes

<pre><code>kubectl get nodes -L nvidia.com/gpu.product -L nvidia.com/gpu.count
kubectl describe node gpu-node-01 | grep -A5 -E <span class="gm-s">"Allocatable|Allocated resources"</span>
kubectl get pods -A -o wide --field-selector spec.nodeName=gpu-node-01
kubectl top pods -n ml-training --containers
kubectl get events -A --sort-by=.lastTimestamp | tail -30
kubectl exec pod -- cat /sys/fs/cgroup/cpuset.cpus.effective /sys/fs/cgroup/cpu.stat
kubectl cordon / drain / uncordon gpu-node-01
kubectl debug node/gpu-node-01 -it --image=busybox -- chroot /host sh
kubectl get clusterpolicy -o yaml             <span class="gm-c"># GPU Operator config</span></code></pre>

### Networking and storage

<pre><code>ibstat; ibv_devinfo                           <span class="gm-c"># InfiniBand links</span>
NCCL_DEBUG=INFO python train.py 2&gt;&amp;1 | grep -E <span class="gm-s">"NET/|NVLS|Using"</span>
nccl-tests: ./build/all_reduce_perf -b 8 -e 8G -f 2 -g 8
fio --name=seq --rw=read --bs=1M --size=10G --numjobs=4 --direct=1 --filename=/mnt/nvme-raid0/t
cat /proc/mdstat; mdadm --detail /dev/md0</code></pre>

### Inference engines

<pre><code>curl localhost:8000/metrics | grep -E <span class="gm-s">"vllm:(num_requests|gpu_cache|time_to_first|time_per_output)"</span>
curl localhost:8000/v1/chat/completions -d <span class="gm-s">'{"model":"x","messages":[{"role":"user","content":"hi"}],"stream":true}'</span></code></pre>
<hr>
<p style="color:var(--ink-3);font-size:14px">Source material: your "Comprehensive Kubernetes GPU Operations Guide" (Part D), reorganized with corrections marked in red/amber boxes. Everything else is general engineering knowledge current to mid-2026; verify vendor-specific figures, product names and prices against official documentation before relying on them.</p>
