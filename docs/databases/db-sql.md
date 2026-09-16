---
title: "SQL refresher"
slug: /databases/db-sql
sidebar_position: 7
sidebar_label: "SQL refresher"
description: "SQL refresher"
---

<!-- DIAGRAM:sequence:START -->

## Reading a query plan

<img src="/diagrams/db-sql/sequence.svg" alt="Reading a query plan" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:sequence:END -->
<p>Interviewers sometimes ask you to write the query behind a dashboard. Patterns worth having in your hands:</p>
<pre><code>-- p95 latency per service per minute (PostgreSQL)
SELECT date_trunc('minute', ts) AS minute, service,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
       count(*) FILTER (WHERE status &gt;= 500) * 1.0 / count(*) AS error_rate
FROM requests
WHERE ts &gt;= now() - interval '1 hour'
GROUP BY 1, 2 HAVING count(*) &gt; 100 ORDER BY 1, 2;

-- top 3 slowest endpoints per service (window function)
SELECT * FROM (
  SELECT service, endpoint, avg(latency_ms) AS avg_ms,
         row_number() OVER (PARTITION BY service ORDER BY avg(latency_ms) DESC) AS rn
  FROM requests GROUP BY service, endpoint) t
WHERE rn &lt;= 3;

-- hosts with no heartbeat in 5 minutes (anti-join)
SELECT h.hostname FROM hosts h
WHERE NOT EXISTS (SELECT 1 FROM heartbeats b
                  WHERE b.host_id = h.id AND b.seen_at &gt; now() - interval '5 minutes');

-- deduplicate keeping the latest row per key
DELETE FROM events e USING (
  SELECT id, row_number() OVER (PARTITION BY key ORDER BY updated_at DESC) AS rn FROM events) d
WHERE e.id = d.id AND d.rn &gt; 1;

-- running total and change versus previous row
SELECT day, bytes, sum(bytes) OVER (ORDER BY day) AS cumulative,
       bytes - lag(bytes) OVER (ORDER BY day) AS delta FROM daily_usage;</code></pre>
