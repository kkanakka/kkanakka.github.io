---
title: "Realtime Metrics Aggregator"
slug: /linkedin/linkedin-metrics-aggregator
sidebar_position: 6
sidebar_label: "Realtime Metrics Aggregator"
description: "Realtime Metrics Aggregator"
---
Observability Reliability — High-Cardinality Streams at Scale

The backbone of LinkedIn's monitoring culture: 10M metrics/sec ingestion, 2-second query latency, dynamic cardinality control, and SLO-driven alerting across millions of nodes worldwide with Gorilla compression and tiered storage.

High Cardinality

Real-time Processing

SLO Alerting

[Home](/) [Design Framework](/docs/foundations/sre-design-framework) [SRE Systems](/docs/sre/sre-sysdesign) [Config Management](/docs/linkedin/linkedin-config-management)

## Page 1 — System Overview & Observability Reliability Philosophy

### What This System Is

A **"Mission-Critical Observability Platform"** that ingests telemetry data (CPU, memory, latency, request counts) from millions of LinkedIn nodes worldwide. The aggregator supports high-cardinality dimensions (per-host, per-region, per-service labels) while maintaining query speed and SLO-driven alerting pipelines — the backbone of LinkedIn's monitoring culture.

#### Metrics Platform Service Level Objectives (SLOs)

| Objective | Target | Measurement |
| --- | --- | --- |
| Ingestion Throughput | ≥ 10M metrics/s | Globally with sustained bursts |
| Ingest Latency | p99 ≤ 1s | From node to aggregator |
| Query Latency | p99 ≤ 2s | Even under load |
| Availability | ≥ 99.999% | Monitoring must never go dark |
| Metric Loss Rate | < 0.001% | Reliability of observability itself |
| Cardinality Growth | < 5% weekly | Prevent cardinality explosion |

### Observability Reliability Philosophy: Monitoring is Infrastructure

#### Core Metrics Platform Principles

-   **Sharded Ingestion with Consistent Hashing** — Evenly distributes load across ingestion nodes
-   **Dynamic Cardinality Control** — Drops high-cardinality labels above safety thresholds
-   **Backpressure + Autoscaling** — Stream processor scales out with demand
-   **Tiered Storage** — 24h hot storage (SSD), long-term cold archival (object store)
-   **Index Compaction & Compression** — Delta + Gorilla compression for high volume
-   **Query Federation Layer** — Routes queries to regional stores to avoid overload
-   **Clock Sync Protocols** — NTP/chrony enforcement for accurate timestamps

### Seven Core Components

1.  **Node Agent Exporter** — Pushes raw metrics periodically from every host
2.  **Ingestion Gateways** — Regionally sharded, load-balanced endpoints
3.  **Stream Processor** — Aggregates, deduplicates, compresses in real-time
4.  **Hot Storage (TSDB)** — Recent metrics in memory/SSD (LinkedIn's InGraphs)
5.  **Cold Storage** — Historical data in object store (Ambry)
6.  **Query Service** — PromQL-style queries and dashboards
7.  **Alert Engine** — SLO evaluation and notification pipelines

### LinkedIn Metric Types & Cardinality

#### Metric Categories by Volume & Cardinality

| Metric Category | Volume/sec | Cardinality | Storage Strategy |
| --- | --- | --- | --- |
| **Infrastructure** | 2M | Low (host, DC) | Hot storage + long retention |
| **Application** | 5M | Medium (service, endpoint) | Hot storage + 30-day retention |
| **Business** | 2M | High (user, experiment) | Aggressive compression + sampling |
| **Security** | 500K | Medium (auth, audit) | Cold storage + compliance retention |
| **Network** | 300K | Low (switches, routers) | Hot storage + alerting |
| **Debug/Tracing** | 200K | Very High (trace, span) | Sampling + short retention |

#### Reliability Stressors (What Can Break)

#### Critical Metrics Platform Failure Modes

-   **Hot Shard Overload:** One region floods with metrics → ingestion nodes choke
-   **Cardinality Explosion:** New label → exponential series growth → memory exhaustion
-   **Backpressure Cascade:** Downstream processor lags → queues overflow → data loss
-   **Query Hotspots:** Same dashboard hammered by thousands → query service overload
-   **Clock Skew:** Metrics misaligned in time windows → incorrect aggregations
-   **Storage Tier Overflow:** Hot storage fills up → forced cold storage promotion

## Page 2 — Architecture & LinkedIn Integration

### System Architecture Overview

<img src="/diagrams/linkedin-metrics-aggregator/1.svg" alt="linkedin-metrics-aggregator diagram 1" class="doc-diagram" />

 

![LinkedIn Metrics Aggregator Architecture](/images/metrics-aggregator-architecture.png)

Complete LinkedIn Metrics Aggregator Architecture with Tiered Storage and Stream Processing

### Architecture Component Deep Dive

#### Node Agents — Distributed Metric Collection Infrastructure

**Multi-Protocol Metric Exporters:** Lightweight agents deployed on 50K+ LinkedIn hosts, collecting system-level metrics (CPU, memory, disk, network) and custom application metrics through multiple protocols including Prometheus exposition format, StatsD, and custom LinkedIn telemetry formats. Each agent implements intelligent batching with exponential backoff, local buffering during network partitions, and automatic discovery of new services through integration with LinkedIn's service mesh. The agents use consistent hashing to determine which ingestion gateway to target, ensuring even load distribution and automatic failover when gateways become unavailable. Advanced features include metric sampling based on cardinality thresholds, local pre-aggregation for high-frequency counters, and integration with LinkedIn's configuration management system for dynamic metric collection policies.

#### Ingestion Gateways — Regional Sharded Entry Points

**Horizontally Sharded Regional Clusters:** Geographically distributed ingestion endpoints using consistent hashing across 48 shards (0-15 LTX1, 16-31 LVA1, 32-47 EI4) to handle 10M+ metrics/second globally while maintaining sub-second ingestion latency. Each gateway implements multiple ingestion protocols including HTTP/JSON for web services, gRPC for high-throughput applications, and direct Kafka producer integration for streaming applications. The gateways perform initial validation, deduplication, and basic aggregation before forwarding to the stream processing layer. They include sophisticated rate limiting, backpressure detection, and circuit breaker patterns to protect downstream systems during traffic spikes. Auto-scaling capabilities dynamically provision additional gateway instances based on ingestion load, with Kubernetes HPA managing scaling decisions using custom metrics from the stream processor queue depth.

#### Stream Processor — Real-Time Aggregation & Compression Engine

**Kafka Streams + Samza Hybrid Processing:** A sophisticated stream processing pipeline combining Kafka Streams for stateless operations with Apache Samza for stateful aggregations, processing 10M+ metrics/second into 2M aggregated time series through advanced techniques including Gorilla compression (achieving 90% storage reduction), dynamic cardinality control with automatic label dropping above safety thresholds, and time window processing with late data handling capabilities up to 5 minutes. The processor implements automatic backpressure detection through queue depth monitoring, triggering auto-scaling of processing instances via custom Kubernetes operators. Advanced features include duplicate detection using bloom filters, metric interpolation for missing data points, and real-time cardinality explosion prevention that drops high-cardinality labels (user\_id, trace\_id) while preserving essential operational dimensions (service, region, datacenter).

#### Hot Storage (InGraphs TSDB) — High-Performance Recent Data Store

**LinkedIn's Custom Time-Series Database:** InGraphs TSDB optimized for sub-second query latency on recent metrics (24-hour retention) using a hybrid SSD + memory architecture with intelligent data locality optimization. Unlike traditional RRD (Round-Robin Database) systems that use fixed-size circular buffers, InGraphs implements dynamic schema evolution, supporting high-cardinality labels without pre-allocation overhead. The system uses advanced indexing strategies including inverted indexes for label queries, time-based sharding for range queries, and bloom filters for negative lookups. Hot storage integrates directly with LinkedIn's service mesh for automatic service discovery and metric registration, supports real-time streaming updates via change data capture, and implements write-optimized LSM trees with configurable compaction strategies. The architecture handles query federation across multiple InGraphs instances, with intelligent query routing based on metric metadata and time ranges to minimize cross-shard operations.

#### Cold Storage (Ambry) — Cost-Optimized Historical Archive

**Tiered Object Storage with Compression:** LinkedIn's Ambry object store providing 90-day retention for historical metrics with aggressive compression and cost optimization, implementing a sophisticated tiered storage strategy where data transitions from hot SSDs to warm spinning disks to cold object storage based on access patterns and age. The system uses advanced compression techniques including delta encoding for timestamps, dictionary compression for repeated label values, and Gorilla compression algorithm for floating-point values achieving 95%+ compression ratios. Cold storage supports efficient range queries through metadata indexing, enabling time-series queries across long historical periods without scanning raw data. The architecture integrates with LinkedIn's data lifecycle management policies, automatically transitioning metrics between tiers while maintaining query capability across all tiers through a unified query interface that abstracts storage location from users.

#### Query Service — Federated PromQL Engine

**Multi-Tier Query Federation with Caching:** A sophisticated query engine implementing PromQL (Prometheus Query Language) compatibility with intelligent federation across hot and cold storage tiers, achieving sub-2-second query latency even for complex aggregations spanning multiple datacenters. The service implements a multi-level caching strategy including query result caching, metadata caching, and intermediate aggregation caching to minimize repeated computation. \*\*Why Grafana Pulls from Query Service (Not Kafka):\*\* Grafana connects to the Query Service via PromQL API rather than directly consuming from Kafka because real-time dashboards require historical context, complex aggregations (percentiles, rates, moving averages), and the ability to correlate metrics across different time windows - capabilities that require a proper TSDB query engine rather than raw stream consumption. The Query Service provides the necessary abstractions for dashboard visualization while Kafka serves as the ingestion pipeline, maintaining separation of concerns between data ingestion and analytical querying.

#### Alert Engine — SLO-Driven Notification System

**Multi-Threshold Alerting with Escalation:** An intelligent alerting system that evaluates SLO compliance across thousands of services using configurable alert rules, automated escalation policies, and integration with LinkedIn's incident response workflows. The engine implements sophisticated rate limiting to prevent alert storms, intelligent grouping of related alerts to reduce noise, and automatic correlation with deployment events to identify potential causes. Advanced features include predictive alerting using linear regression and seasonal decomposition, alert suppression during maintenance windows, and integration with LinkedIn's on-call rotation system for proper escalation. The system supports multiple notification channels including Slack, email, SMS, and PagerDuty, with configurable notification templates and severity-based routing rules.

#### Cardinality Control — High-Cardinality Protection System

**Dynamic Label Management & Sampling:** A critical protection mechanism preventing cardinality explosions that could destabilize the entire metrics infrastructure through intelligent label dropping, dynamic sampling rates, and real-time cardinality monitoring across all metric dimensions. The system maintains a cardinality budget per service, automatically dropping problematic labels (user IDs, trace IDs, session tokens) while preserving operationally relevant dimensions (service name, datacenter, instance). Advanced features include machine learning-based cardinality prediction, automatic alert generation when services approach their cardinality limits, and integration with LinkedIn's service ownership system for automatic notification of responsible teams. The control system implements sophisticated sampling strategies including stratified sampling for rare events, reservoir sampling for consistent representation, and adaptive sampling rates based on metric importance scores derived from historical access patterns.

#### Metadata Store — Schema & Service Registry

**Distributed Metric Schema Management:** A comprehensive metadata store managing metric schemas, service registrations, cardinality budgets, and retention policies across LinkedIn's entire observability infrastructure, implemented as a distributed system using Espresso for primary storage with ZooKeeper for coordination and configuration management. \*\*Why Separate Metadata Storage is Essential:\*\* The metadata store is crucial because it maintains the relationship between metrics and services, tracks schema evolution over time, manages cardinality quotas per service, stores retention policies, and provides the service discovery mechanism that allows automatic metric registration when new services deploy. This separation enables the TSDB to focus on time-series data while delegating complex metadata operations to a system optimized for relational queries and ACID transactions. The metadata store integrates with LinkedIn's service mesh to automatically discover new services, validates metric schemas against organizational policies, and provides APIs for programmatic metric registration and schema evolution.

### Schema Management & Distribution System

📋 LINKEDIN METRICS SCHEMA STORAGE — Espresso + ZooKeeper Architecture

🗄️ Distributed Schema Storage Implementation

📊 ESPRESSO (Primary Storage)

**Stores:** Metric schemas, service registrations, cardinality budgets  
**Features:** ACID transactions, relational queries, high-volume reads  
**Scale:** 20K+ services, millions of metric definitions  
**Performance:** Sub-millisecond schema lookups with heavy caching

⚙️ ZOOKEEPER (Coordination)

**Manages:** Distributed consensus, configuration management  
**Coordinates:** Schema updates, service discovery across DCs  
**Handles:** Cardinality budgets, retention policy configs  
**Ensures:** Consistent schema state across all components

📝 Schema Definition Example

{  
  "metric\_name": "cpu\_usage\_percent",  
  "service": "profile-service",  
  "labels": \["datacenter", "instance", "cpu\_core"\],  
  "cardinality\_budget": 10000,  
  "retention\_policy": "hot\_24h\_cold\_90d",  
  "schema\_version": "v2.1",  
  "created\_at": "2026-01-15T10:30:00Z"  
}

🔄 SCHEMA FETCH PATTERNS — Who Gets Schemas When

👥 Schema Consumer Components

**🚪 INGESTION GATEWAYS**  
Primary Consumers  
Validate every metric  
5-15min cache TTL

**⚡ STREAM PROCESSOR**  
Schema-Aware  
Cardinality control  
Event-driven updates

**🔍 QUERY SERVICE**  
Query Planning  
Storage tier routing  
Metadata joins

**📡 NODE AGENTS**  
Service Registration  
Startup validation  
Update subscriptions

🔄 Gateway Schema Validation Flow

**New Metric Arrives**  
At ingestion gateway  
`cpu.usage{service=api}`

→

**Check Local Cache**  
5-15 min TTL cache  
`schema_cache.get()`

→

**\[CACHE MISS\]**  
Fetch from Metadata Store  
`espresso.getSchema()`

→

**Validate & Forward**  
Schema + budget check  
Cache for future use

→

**Stream Processor**  
Validated metric  
Ready for aggregation

⚡ Multi-Level Caching

• Gateway local cache: 5-15min TTL  
• Regional Redis: Cross-gateway sharing  
• CDN layer: Static schema elements

📡 Event-Driven Updates

• Schema change events via Kafka  
• Incremental updates only  
• 30-60s propagation acceptable

📦 Bulk Operations

• Batch schema fetches  
• Connection pooling  
• Compressed payloads

🛡️ SCHEMA SYSTEM FAILURE HANDLING

🚨 METADATA STORE DOWN

**Policy:** Fail-open with cached schemas  
**Degraded Mode:** Basic validation only  
**Alert:** Immediate page when fetches fail  
**Recovery:** Full validation when store returns

☠️ CACHE POISONING

**Protection:** Version numbers + checksums  
**Validation:** Schema integrity verification  
**Rollback:** Revert to previous versions  
**Circuit Breaker:** Stop bad schema propagation

🔄 SCHEMA EVOLUTION

**Backward Compatibility:** Version lineage tracking  
**Gradual Rollout:** Schema changes via canary  
**Rollback Ready:** Previous versions preserved  
**Migration:** Automated schema transformation

🎯 CRITICAL PRINCIPLE: Schema fetching optimized for 10M+ metrics/second validation with sub-millisecond lookup latency

### Technical Architecture Insights

#### Why Cold Storage is Essential for Metrics Systems

**Cost-Performance Trade-offs:** Cold storage addresses three critical needs in large-scale metrics systems: \*\*Cost Management\*\* - storing 90 days of metrics on high-performance SSDs would cost 20x more than object storage while most historical data is rarely accessed; \*\*Compliance Requirements\*\* - many organizations need metrics retention for audit, debugging historical incidents, and capacity planning analysis requiring months of data; \*\*Query Capability Preservation\*\* - unlike simple archival, cold storage maintains full query capability through metadata indexing, enabling on-demand historical analysis without requiring data restoration. The tiered architecture automatically transitions metrics based on access patterns, with 95% of queries targeting the last 24 hours (hot storage) while cold storage handles the remaining 5% with acceptable 3-5 second latency, optimizing both cost and performance across the entire retention lifecycle.

### Sharded Ingestion with Consistent Hashing

#### Load Distribution Strategy

**Consistent Hashing:** Evenly distributes high-volume metrics across ingestion shards

```
// LinkedIn Metrics Ingestion with consistent hashing
public class ShardedMetricsIngestion {
    
    private final ConsistentHashRing<IngestionShard> hashRing;
    private final Map<String, IngestionShard> activeShards;
    
    // Route metrics to appropriate shard based on series hash
    public void ingestMetrics(List<MetricSample> metrics) {
        // Group metrics by target shard for batching
        Map<IngestionShard, List<MetricSample>> shardBatches = metrics.stream()
            .collect(Collectors.groupingBy(this::selectShardForMetric));
        
        // Send batches to shards in parallel
        shardBatches.entrySet().parallelStream().forEach(entry -> {
            IngestionShard shard = entry.getKey();
            List<MetricSample> batch = entry.getValue();
            
            try {
                shard.ingestBatch(batch);
                metricsClient.increment("metrics.ingested", 
                                      Map.of("shard", shard.getId()),
                                      batch.size());
            } catch (Exception e) {
                logger.error("Failed to ingest batch to shard {}", shard.getId(), e);
                // Retry with different shard
                retryWithAlternateShard(batch, shard);
            }
        });
    }
    
    // Select shard using consistent hashing on series fingerprint
    private IngestionShard selectShardForMetric(MetricSample metric) {
        String seriesFingerprint = generateSeriesFingerprint(metric);
        return hashRing.get(seriesFingerprint);
    }
    
    // Generate stable fingerprint for metric series
    private String generateSeriesFingerprint(MetricSample metric) {
        // Sort labels for consistent ordering
        Map<String, String> sortedLabels = metric.getLabels().entrySet().stream()
            .sorted(Map.Entry.comparingByKey())
            .collect(LinkedHashMap::new, 
                    (map, entry) -> map.put(entry.getKey(), entry.getValue()),
                    LinkedHashMap::putAll);
        
        StringBuilder fingerprint = new StringBuilder();
        fingerprint.append(metric.getMetricName());
        
        for (Map.Entry<String, String> label : sortedLabels.entrySet()) {
            fingerprint.append("|").append(label.getKey()).append("=").append(label.getValue());
        }
        
        return DigestUtils.sha256Hex(fingerprint.toString());
    }
    
    // Dynamic shard management based on load
    @Scheduled(fixedDelay = 300000) // every 5 minutes
    public void rebalanceShards() {
        Map<String, Double> shardLoads = calculateShardLoads();
        
        // Find overloaded shards (>80% capacity)
        List<String> overloadedShards = shardLoads.entrySet().stream()
            .filter(entry -> entry.getValue() > 0.8)
            .map(Map.Entry::getKey)
            .collect(Collectors.toList());
        
        if (!overloadedShards.isEmpty()) {
            logger.warn("Overloaded shards detected: {}", overloadedShards);
            
            // Scale out overloaded shards
            for (String shardId : overloadedShards) {
                scaleOutShard(shardId);
            }
        }
        
        // Find underloaded shards (<20% capacity)
        List<String> underloadedShards = shardLoads.entrySet().stream()
            .filter(entry -> entry.getValue() < 0.2)
            .map(Map.Entry::getKey)
            .collect(Collectors.toList());
        
        // Scale in underloaded shards (but maintain minimum)
        if (underloadedShards.size() > MIN_SHARDS) {
            for (String shardId : underloadedShards.subList(0, 
                    Math.min(2, underloadedShards.size()))) {
                scaleInShard(shardId);
            }
        }
    }
}
```

### Dynamic Cardinality Control

#### Cardinality Explosion Prevention

```
// Intelligent cardinality management to prevent system overload
public class DynamicCardinalityController {
    
    private static final int MAX_SERIES_PER_METRIC = 10000;
    private static final double CARDINALITY_GROWTH_THRESHOLD = 0.05; // 5% weekly
    
    // Monitor and control cardinality in real-time
    public MetricSample processMetricSample(MetricSample sample) {
        String metricName = sample.getMetricName();
        
        // Check current cardinality for this metric
        CardinalityStats stats = getCardinalityStats(metricName);
        
        if (stats.getCurrentSeries() > MAX_SERIES_PER_METRIC) {
            // Metric has too many series - apply cardinality reduction
            return reduceCardinality(sample, stats);
        }
        
        // Check growth rate
        double weeklyGrowth = stats.getWeeklyGrowthRate();
        if (weeklyGrowth > CARDINALITY_GROWTH_THRESHOLD) {
            // Growing too fast - apply proactive sampling
            return applySampling(sample, weeklyGrowth);
        }
        
        // Update cardinality tracking
        updateCardinalityStats(metricName, sample);
        
        return sample;
    }
    
    // Reduce cardinality by dropping high-cardinality labels
    private MetricSample reduceCardinality(MetricSample sample, CardinalityStats stats) {
        Map<String, String> originalLabels = sample.getLabels();
        Map<String, String> reducedLabels = new HashMap<>(originalLabels);
        
        // Identify high-cardinality labels to drop
        List<String> highCardinalityLabels = stats.getHighCardinalityLabels();
        
        for (String labelToRemove : highCardinalityLabels) {
            if (reducedLabels.containsKey(labelToRemove)) {
                String removedValue = reducedLabels.remove(labelToRemove);
                
                logger.debug("Dropped high-cardinality label: {}={} from metric {}", 
                           labelToRemove, removedValue, sample.getMetricName());
                
                // Add to dropped labels tracking
                metricsClient.increment("cardinality.labels_dropped",
                                      Map.of("metric", sample.getMetricName(),
                                            "label", labelToRemove));
                
                // Check if cardinality is now acceptable
                if (estimateCardinalityAfterReduction(sample.getMetricName(), reducedLabels) 
                    < MAX_SERIES_PER_METRIC) {
                    break;
                }
            }
        }
        
        return sample.withLabels(reducedLabels);
    }
    
    // Apply statistical sampling for high-growth metrics
    private MetricSample applySampling(MetricSample sample, double growthRate) {
        // Calculate sampling rate inversely proportional to growth
        double samplingRate = Math.min(1.0, CARDINALITY_GROWTH_THRESHOLD / growthRate);
        
        // Use consistent hashing for stable sampling
        String seriesHash = generateSeriesFingerprint(sample);
        double hashValue = (double) (Math.abs(seriesHash.hashCode()) % 10000) / 10000.0;
        
        if (hashValue > samplingRate) {
            // Drop this sample
            metricsClient.increment("cardinality.samples_dropped",
                                  Map.of("metric", sample.getMetricName()));
            return null;
        }
        
        // Keep sample but add sampling metadata
        Map<String, String> labelWithSampling = new HashMap<>(sample.getLabels());
        labelWithSampling.put("__sampling_rate__", String.format("%.4f", samplingRate));
        
        return sample.withLabels(labelWithSampling);
    }
    
    // Periodic cardinality analysis and alerting
    @Scheduled(fixedDelay = 3600000) // every hour
    public void analyzeCardinalityTrends() {
        Map<String, CardinalityStats> allStats = getAllCardinalityStats();
        
        for (Map.Entry<String, CardinalityStats> entry : allStats.entrySet()) {
            String metricName = entry.getKey();
            CardinalityStats stats = entry.getValue();
            
            // Alert on dangerous cardinality growth
            if (stats.getWeeklyGrowthRate() > CARDINALITY_GROWTH_THRESHOLD * 2) {
                alertManager.warn("Dangerous cardinality growth for metric {}: {}% weekly",
                                metricName, stats.getWeeklyGrowthRate() * 100);
            }
            
            // Auto-enable aggressive sampling for runaway metrics
            if (stats.getCurrentSeries() > MAX_SERIES_PER_METRIC * 2) {
                enableAggressiveSampling(metricName);
                alertManager.page("Auto-enabled aggressive sampling for metric {} with {} series",
                                metricName, stats.getCurrentSeries());
            }
        }
    }
}
```

## Page 3 — Stream Processing & Storage Reliability

### Real-Time Stream Processing with Backpressure

#### Kafka Streams + Samza Processing Pipeline

High-throughput stream processing with automatic backpressure and scaling

```
// LinkedIn metrics stream processing with backpressure handling
public class MetricsStreamProcessor {
    
    private final KafkaStreams streamsApp;
    private final SamzaContainer samzaContainer;
    private final BackpressureDetector backpressureDetector;
    
    // Process metrics stream with aggregation and compression
    public StreamsBuilder buildProcessingTopology() {
        StreamsBuilder builder = new StreamsBuilder();
        
        // Input: raw metrics from ingestion gateways
        KStream<String, MetricSample> rawMetrics = builder.stream("metrics-raw");
        
        // Step 1: Deduplication within time window
        KStream<String, MetricSample> dedupedMetrics = rawMetrics
            .selectKey((key, sample) -> generateDeduplicationKey(sample))
            .transform(DeduplicationTransformer::new, "dedup-store");
        
        // Step 2: Cardinality control
        KStream<String, MetricSample> controlledMetrics = dedupedMetrics
            .mapValues(this::applyCardinalityControl)
            .filter((key, sample) -> sample != null); // Remove dropped samples
        
        // Step 3: Time-windowed aggregation
        KGroupedStream<String, MetricSample> groupedMetrics = controlledMetrics
            .selectKey((key, sample) -> generateAggregationKey(sample))
            .groupByKey();
        
        // Step 4: Aggregate in 1-minute windows with Gorilla compression
        KTable<Windowed<String>, AggregatedMetric> aggregatedMetrics = groupedMetrics
            .windowedBy(TimeWindows.of(Duration.ofMinutes(1)))
            .aggregate(
                AggregatedMetric::new,
                (key, sample, aggregate) -> aggregate.add(sample),
                Named.as("metrics-aggregation"),
                Materialized.with(Serdes.String(), aggregatedMetricSerde)
            );
        
        // Step 5: Output to hot storage and cold archival
        aggregatedMetrics.toStream()
            .peek(this::detectBackpressure) // Monitor for processing lag
            .mapValues(this::compressWithGorilla)
            .to("metrics-hot-storage");
        
        // Step 6: Archive stream for cold storage
        aggregatedMetrics.toStream()
            .filter((key, metric) -> shouldArchive(metric))
            .mapValues(this::prepareForArchival)
            .to("metrics-cold-archive");
        
        return builder;
    }
    
    // Backpressure detection and mitigation
    private void detectBackpressure(Windowed<String> key, AggregatedMetric metric) {
        long processingLag = System.currentTimeMillis() - metric.getTimestamp();
        
        if (processingLag > 30000) { // 30 second lag threshold
            backpressureDetector.reportLag(processingLag);
            
            if (processingLag > 60000) { // 1 minute - critical
                // Trigger aggressive mitigation
                activateBackpressureMitigation();
            }
        }
    }
    
    // Backpressure mitigation strategies
    private void activateBackpressureMitigation() {
        logger.warn("Activating backpressure mitigation due to processing lag");
        
        // Strategy 1: Increase sampling rate
        cardinalityController.increaseSamplingRate(0.5); // Drop 50% of metrics temporarily
        
        // Strategy 2: Scale out processing capacity
        autoscaler.scaleOutStreamProcessors(2); // Double the processors
        
        // Strategy 3: Prioritize high-value metrics
        enableHighValueMetricPrioritization();
        
        // Strategy 4: Temporary disable expensive aggregations
        disableComplexAggregations(Duration.ofMinutes(10));
        
        metricsClient.increment("backpressure.mitigation_activated");
        alertManager.warn("Metrics backpressure mitigation activated - processing lag detected");
    }
    
    // Gorilla compression for time series efficiency
    private AggregatedMetric compressWithGorilla(AggregatedMetric metric) {
        GorillaCompressor compressor = new GorillaCompressor();
        
        // Compress timestamp deltas
        long baseTimestamp = metric.getWindowStart();
        List<Long> timestampDeltas = metric.getDataPoints().stream()
            .map(dp -> dp.getTimestamp() - baseTimestamp)
            .collect(Collectors.toList());
        
        byte[] compressedTimestamps = compressor.compressTimestamps(timestampDeltas);
        
        // Compress value deltas
        List<Double> values = metric.getDataPoints().stream()
            .map(DataPoint::getValue)
            .collect(Collectors.toList());
        
        byte[] compressedValues = compressor.compressValues(values);
        
        return metric.withCompression(compressedTimestamps, compressedValues, 
                                     calculateCompressionRatio(metric));
    }
    
    // Auto-scaling based on throughput and lag
    @Scheduled(fixedDelay = 120000) // every 2 minutes
    public void autoScaleProcessors() {
        ProcessingMetrics metrics = gatherProcessingMetrics();
        
        // Scale up conditions
        if (metrics.getAverageProcessingLag() > Duration.ofSeconds(30) ||
            metrics.getCpuUtilization() > 0.8 ||
            metrics.getMemoryUtilization() > 0.85) {
            
            int currentInstances = streamProcessorManager.getCurrentInstances();
            int targetInstances = Math.min(currentInstances * 2, MAX_PROCESSORS);
            
            if (targetInstances > currentInstances) {
                streamProcessorManager.scaleToInstances(targetInstances);
                logger.info("Scaled up stream processors: {} -> {}", currentInstances, targetInstances);
            }
        }
        
        // Scale down conditions (be conservative)
        else if (metrics.getAverageProcessingLag().compareTo(Duration.ofSeconds(5)) < 0 &&
                metrics.getCpuUtilization() < 0.4 &&
                metrics.getMemoryUtilization() < 0.5) {
            
            int currentInstances = streamProcessorManager.getCurrentInstances();
            int targetInstances = Math.max(currentInstances / 2, MIN_PROCESSORS);
            
            if (targetInstances < currentInstances) {
                // Wait for stable low load before scaling down
                if (isLoadStableLow(Duration.ofMinutes(10))) {
                    streamProcessorManager.scaleToInstances(targetInstances);
                    logger.info("Scaled down stream processors: {} -> {}", currentInstances, targetInstances);
                }
            }
        }
    }
}
```

### Tiered Storage Strategy

#### Hot SSD + Cold Object Store Architecture

```
// LinkedIn metrics tiered storage management
public class TieredMetricsStorage {
    
    private final InGraphsTSDB hotStorage;    // LinkedIn's time-series DB
    private final AmbryClient coldStorage;    // LinkedIn's object store
    
    // Intelligent data placement based on access patterns
    public void storeMetric(AggregatedMetric metric) {
        MetricMetadata metadata = analyzeMetricMetadata(metric);
        
        // Always store in hot storage initially
        hotStorage.store(metric);
        
        // Decide on cold storage based on retention policy
        if (shouldArchiveImmediately(metadata)) {
            // High-volume, low-query metrics go to cold storage immediately
            archiveToColdStorage(metric, metadata);
        }
        
        // Update access tracking for future placement decisions
        updateAccessPatterns(metric.getSeriesId(), AccessType.WRITE);
    }
    
    // Query with automatic tier routing
    public QueryResult queryMetrics(MetricsQuery query) {
        QueryPlan plan = generateQueryPlan(query);
        
        // Try hot storage first for recent data
        if (plan.requiresHotStorage()) {
            QueryResult hotResult = queryHotStorage(query);
            
            if (hotResult.isComplete()) {
                updateAccessPatterns(query.getSeriesIds(), AccessType.READ_HOT);
                return hotResult;
            }
        }
        
        // Fall back to cold storage for historical data
        if (plan.requiresColdStorage()) {
            QueryResult coldResult = queryColdStorage(query);
            
            // Promote frequently accessed cold data to hot storage
            if (shouldPromoteToHot(query, coldResult)) {
                promoteToHotStorage(coldResult.getMetrics());
            }
            
            updateAccessPatterns(query.getSeriesIds(), AccessType.READ_COLD);
            return coldResult;
        }
        
        // Federated query across both tiers
        return executeFederatedQuery(query, plan);
    }
    
    // Automated data lifecycle management
    @Scheduled(fixedDelay = 3600000) // every hour
    public void manageDataLifecycle() {
        // Phase 1: Hot to cold migration based on age and access
        List<MetricSeries> candidatesForArchival = hotStorage.findArchivalCandidates(
            Duration.ofHours(24), // Older than 24 hours
            0.1 // Less than 0.1 queries per hour
        );
        
        for (MetricSeries series : candidatesForArchival) {
            try {
                archiveToColdStorage(series);
                hotStorage.delete(series.getId());
                
                metricsClient.increment("storage.hot_to_cold_migration");
            } catch (Exception e) {
                logger.error("Failed to migrate series {} to cold storage", series.getId(), e);
            }
        }
        
        // Phase 2: Cold storage cleanup based on retention policies
        List<ArchivedMetric> expiredMetrics = coldStorage.findExpiredMetrics();
        
        for (ArchivedMetric metric : expiredMetrics) {
            try {
                coldStorage.delete(metric.getBlobId());
                metricsClient.increment("storage.expired_metric_deleted");
            } catch (Exception e) {
                logger.error("Failed to delete expired metric {}", metric.getId(), e);
            }
        }
        
        // Phase 3: Hot storage capacity management
        manageHotStorageCapacity();
    }
    
    private void manageHotStorageCapacity() {
        StorageCapacity capacity = hotStorage.getCapacityMetrics();
        
        if (capacity.getUsagePercentage() > 0.85) { // 85% threshold
            logger.warn("Hot storage approaching capacity: {}%", capacity.getUsagePercentage());
            
            // Aggressive archival of least accessed data
            List<MetricSeries> leastAccessed = hotStorage.findLeastAccessedSeries(1000);
            
            for (MetricSeries series : leastAccessed) {
                archiveToColdStorage(series);
                hotStorage.delete(series.getId());
            }
            
            alertManager.warn("Hot storage capacity management activated: {}% usage", 
                            capacity.getUsagePercentage());
        }
    }
    
    // Intelligent data promotion from cold to hot
    private boolean shouldPromoteToHot(MetricsQuery query, QueryResult result) {
        // Promote if frequently queried
        AccessStats stats = getAccessStats(query.getSeriesIds());
        
        if (stats.getQueriesPerHour() > 5) {
            return true;
        }
        
        // Promote if part of dashboard or alerting
        if (query.getContext() == QueryContext.DASHBOARD || 
            query.getContext() == QueryContext.ALERTING) {
            return true;
        }
        
        // Promote if recent data (last 7 days) is being queried
        if (query.getTimeRange().isWithinLast(Duration.ofDays(7))) {
            return true;
        }
        
        return false;
    }
}
```

### Query Federation & Performance

#### Sub-2s Query Performance at Scale

```
// High-performance query engine with federation
public class MetricsQueryEngine {
    
    private final QueryCache queryCache;
    private final QueryPlanner queryPlanner;
    private final List<QueryExecutor> regionalExecutors;
    
    // Execute query with sub-2s latency SLO
    public QueryResult executeQuery(MetricsQuery query) {
        long startTime = System.currentTimeMillis();
        
        try {
            // Step 1: Check query cache
            Optional<QueryResult> cachedResult = queryCache.get(query.getCacheKey());
            if (cachedResult.isPresent() && !cachedResult.get().isStale()) {
                metricsClient.increment("query.cache_hit");
                return cachedResult.get();
            }
            
            // Step 2: Generate optimized query plan
            QueryPlan plan = queryPlanner.generatePlan(query);
            
            // Step 3: Execute federated query across regions/tiers
            QueryResult result = executeFederatedQuery(plan);
            
            // Step 4: Cache result for future queries
            queryCache.put(query.getCacheKey(), result, plan.getCacheTTL());
            
            long latency = System.currentTimeMillis() - startTime;
            metricsClient.timer("query.latency", latency);
            
            if (latency > 2000) { // SLO violation
                alertManager.warn("Query latency SLO violation: {}ms for query {}", 
                                latency, query.getSummary());
            }
            
            return result;
            
        } catch (Exception e) {
            metricsClient.increment("query.error");
            throw new QueryExecutionException("Query failed: " + query.getSummary(), e);
        }
    }
    
    // Federated execution across multiple data sources
    private QueryResult executeFederatedQuery(QueryPlan plan) {
        List<SubQuery> subQueries = plan.getSubQueries();
        
        // Execute sub-queries in parallel
        List<CompletableFuture<SubQueryResult>> futures = subQueries.stream()
            .map(this::executeSubQueryAsync)
            .collect(Collectors.toList());
        
        // Wait for all sub-queries to complete (with timeout)
        try {
            List<SubQueryResult> subResults = futures.stream()
                .map(future -> future.get(1500, TimeUnit.MILLISECONDS)) // 1.5s timeout
                .collect(Collectors.toList());
            
            // Merge results according to query plan
            return plan.mergeResults(subResults);
            
        } catch (TimeoutException e) {
            // Cancel remaining queries and return partial results
            futures.forEach(future -> future.cancel(true));
            
            List<SubQueryResult> completedResults = futures.stream()
                .filter(CompletableFuture::isDone)
                .map(future -> {
                    try {
                        return future.get();
                    } catch (Exception ex) {
                        return null;
                    }
                })
                .filter(Objects::nonNull)
                .collect(Collectors.toList());
            
            metricsClient.increment("query.partial_timeout");
            return plan.mergePartialResults(completedResults);
        }
    }
    
    // Intelligent query optimization
    private class QueryOptimizer {
        
        public QueryPlan optimizeQuery(MetricsQuery query) {
            QueryPlan plan = new QueryPlan(query);
            
            // Optimization 1: Push down filters to reduce data transfer
            plan = pushDownFilters(plan);
            
            // Optimization 2: Use pre-aggregated data when possible
            plan = usePreaggregatedData(plan);
            
            // Optimization 3: Parallel execution for independent sub-queries
            plan = parallelizeExecution(plan);
            
            // Optimization 4: Cache-aware planning
            plan = optimizeForCaching(plan);
            
            return plan;
        }
        
        private QueryPlan pushDownFilters(QueryPlan plan) {
            // Move time range and label filters to storage layer
            for (SubQuery subQuery : plan.getSubQueries()) {
                if (subQuery.hasTimeFilter()) {
                    subQuery.addStorageFilter(subQuery.getTimeFilter());
                }
                
                if (subQuery.hasLabelFilters()) {
                    subQuery.addStorageFilters(subQuery.getLabelFilters());
                }
            }
            
            return plan;
        }
    }
}
```

##### ✅ System Benefits

-   10M metrics/sec ingestion with consistent hashing
-   Sub-2s query latency with federated architecture
-   Dynamic cardinality control prevents explosions
-   Tiered storage optimizes cost and performance
-   Gorilla compression reduces storage by 90%
-   Automatic backpressure and scaling

##### ⚠️ System Limitations

-   1s ingestion latency may be slow for real-time alerts
-   Cardinality control can drop valuable high-detail metrics
-   Complex federation adds query latency overhead
-   Hot storage requires significant SSD investment
-   Clock skew across nodes affects time alignment
-   Backpressure mitigation can impact data quality
