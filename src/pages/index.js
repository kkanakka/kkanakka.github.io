import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import styles from './index.module.css';

const SECTIONS = [
  { to: '/docs/coding', icon: '{ }', title: 'Coding & Algorithms', count: '3 guides',
    blurb: 'Algorithm walkthroughs with step-by-step traces, 38 SRE Python problems, and data-structure drills seen through a reliability lens.',
    tags: ['Arrays & Hashing', 'Two Pointers', 'Python', 'Complexity'], accent: 'blue' },
  { to: '/docs/linux', icon: '$_', title: 'Linux Internals', count: '10 guides',
    blurb: 'Processes, virtual memory, scheduling, cgroups and namespaces — the kernel paths that containers and the kubelet actually ride on.',
    tags: ['Processes', 'Memory', 'cgroups', 'Namespaces', 'GPUs'], accent: 'green' },
  { to: '/docs/foundations', icon: '\u{1F9F0}', title: 'System Design Foundations', count: '4 guides',
    blurb: 'The building blocks: OSI and transport protocols, caching strategies, choosing an architecture, and a reusable design framework.',
    tags: ['TCP/UDP/QUIC', 'REST/gRPC', 'Caching', 'Load Balancing'], accent: 'pink' },
  { to: '/docs/ddia', icon: '☀', title: 'Data-Intensive Systems', count: '6 chapters',
    blurb: 'Reliability, data models, storage engines, Raft consensus, replication and caching — how large companies really handle data.',
    tags: ['Reliability', 'Storage', 'Raft', 'Replication'], accent: 'navy' },
  { to: '/docs/nalsd', icon: '\u{1F527}', title: 'NALSD', count: '13 exercises',
    blurb: 'Non-Abstract Large System Design: monitoring platforms, logging pipelines, TSDBs and DHTs with real capacity math and failure modes.',
    tags: ['Capacity Planning', 'SLOs', 'Failure Modes'], accent: 'red' },
  { to: '/docs/sre', icon: '⚙', title: 'SRE Interview Prep', count: '7 guides',
    blurb: 'Google SRE interview questions across Linux, networking and processes, plus systems-design playbooks and production debugging scenarios.',
    tags: ['Interview Questions', 'Debugging', 'Playbooks'], accent: 'orange' },
  { to: '/docs/hello-interview', icon: '☁', title: 'Hello Interview', count: '4 problems',
    blurb: 'Classic problems reworked with compact visual walkthroughs and mappings onto the LinkedIn stack — Ambry, Espresso, Kafka, Samza.',
    tags: ['Dropbox', 'Google News', 'Ticketmaster'], accent: 'sky' },
  { to: '/docs/linkedin', icon: '\u{1F517}', title: 'LinkedIn Production Systems', count: '12 deep dives',
    blurb: 'Feature flags, secrets rotation, disaster recovery, build caches and Espresso backup — production systems examined end to end.',
    tags: ['Feature Flags', 'DR', 'Espresso', 'Build Cache'], accent: 'teal' },
  { to: '/docs/databases', icon: '\u{1F5C4}', title: 'Databases & Analytics', count: '8 topics',
    blurb: 'Databases from an operator\u2019s seat: why replication lags, how failover avoids split brain, what a tombstone costs a read, and the Kafka half of the pipeline.',
    tags: ['MVCC', 'Failover', 'Cassandra', 'FoundationDB', 'Kafka'], accent: 'navy' },
  { to: '/docs/service-management', icon: '\u2699', title: 'Service Management', count: '5 topics',
    blurb: 'Keeping a process alive, healthy and replaceable: systemd units and ordering, journald, graceful lifecycle, and deployments that do not drop traffic.',
    tags: ['systemd', 'journald', 'Graceful shutdown', 'Rollout'], accent: 'green' },
  { to: '/docs/kubernetes', icon: '\u2638', title: 'Kubernetes', count: '9 topics',
    blurb: 'The reconciliation machine and how it fails: control plane, workload objects, pod lifecycle and probes, scheduling, networking, storage, and the debugging playbook.',
    tags: ['Pod lifecycle', 'Probes', 'Scheduling', 'Services'], accent: 'sky' },
  { to: '/docs/system-design-notes', icon: '\u{1F4D0}', title: 'System Design Notes', count: '37 problems',
    blurb: 'Interview-shaped notes: a reference checklist, then one page per problem — requirements, entities and API, the design, and the deep dives the interviewer is waiting for.',
    tags: ['Flash sale', 'Bit.ly', 'Instagram', 'Inference API'], accent: 'orange' },
  { to: '/docs/gpu-llm-kubernetes', icon: '\u{1F3AE}', title: 'GPU, LLM & Kubernetes', count: '25 chapters',
    blurb: 'From silicon to the chat window: how a GPU works, how a language model runs on it, how a chat product is built around that, and how it is all operated on Kubernetes.',
    tags: ['CUDA', 'NVLink', 'Inference', 'GPU ops'], accent: 'teal' },
  { to: '/docs/ai-system-design', icon: '\u{1F9E0}', title: 'AI System Design', count: 'new',
    blurb: 'Designing systems that train, serve and scale machine learning: inference architecture, vector search, retrieval pipelines, GPU scheduling.',
    tags: ['LLM Serving', 'Vector DBs', 'RAG', 'GPU Scheduling'], accent: 'purple' },
];

export default function Home() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout title="Home" description={siteConfig.tagline}>
      <header className={styles.hero}>
        <div className={styles.heroInner}>
          <h1 className={styles.heroTitle}>
            Kiran's <span className={styles.heroAccent}>Tech Hub</span>
          </h1>
          <p className={styles.heroSub}>{siteConfig.tagline}</p>
          <div className={styles.heroActions}>
            <Link className={styles.primaryBtn} to="/docs/foundations">Start with the basics</Link>
            <Link className={styles.secondaryBtn} to="/docs/sre">SRE interview prep</Link>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.grid}>
          {SECTIONS.map((s) => (
            <Link key={s.to} to={s.to} className={`${styles.card} ${styles[s.accent]}`}>
              <div className={styles.cardIcon}>{s.icon}</div>
              <h2 className={styles.cardTitle}>{s.title}</h2>
              <div className={styles.cardCount}>{s.count}</div>
              <p className={styles.cardBlurb}>{s.blurb}</p>
              <div className={styles.tagRow}>
                {s.tags.map((t) => <span key={t} className={styles.tag}>{t}</span>)}
              </div>
              <div className={styles.cardCta}>Explore &rarr;</div>
            </Link>
          ))}
        </div>
      </main>
    </Layout>
  );
}
