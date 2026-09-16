---
title: "Capacity Planner"
slug: /linkedin/linkedin-capacity-planner
sidebar_position: 8
sidebar_label: "Capacity Planner"
description: "Capacity Planner"
---
Forecast-Driven Infrastructure — Cost vs Reliability Optimization

An intelligent capacity planning system that forecasts compute, storage, and network needs across hundreds of LinkedIn services: ≤8% forecast error, 99% reservation hit-rate, automated procurement, and capacity error budget management with ensemble ML models and hierarchical reconciliation.

ML Forecasting

Error Budgets

Automated Procurement

[Home](/) [Design Framework](/docs/foundations/sre-design-framework) [SRE Systems](/docs/sre/sre-sysdesign) [K8s Autoscaler](/docs/linkedin/linkedin-kubernetes-autoscaler)

## Page 1 — System Overview & Capacity Planning Philosophy

### What This System Is

A **"Mission-Critical Capacity Forecasting Platform"** that predicts compute, storage, and network needs for hundreds of LinkedIn services across regions. The system ingests historical load, seasonality patterns, marketing events, and SLO targets, then emits actionable reservations and risk reports to prevent both SLO breaches (under-provision) and resource waste (over-provision).

#### Capacity Planning Service Level Objectives (SLOs)

| Objective | Target | Measurement |
| --- | --- | --- |
| Forecast Horizon | 1-12 weeks | Weekly updates with daily deltas |
| P95 Forecast Error (MAPE) | ≤ 8% near-term (≤2 weeks)  
≤ 15% mid-term (3-12 weeks) | Per service × region accuracy |
| Reservation Lead Time Hit-Rate | ≥ 99% | Hardware/quota ready before demand |
| SLO Risk Exposure | ≤ 1% of hours at >85% utilization | Capacity error budget management |
| Planner API Availability | ≥ 99.99% | CI/CD and autoscalers depend on forecasts |
| Data Freshness | < 10 min lag | Real-time metrics ingestion for accuracy |

### Capacity Planning Philosophy: Probabilistic Resource Management

#### Core Capacity Planning Principles

-   **Ensemble + Quantile Forecasts** — Produce P50/P90/P99 demand curves, plan to service tier
-   **Capacity Error Budget (CEB)** — Allowable hours per month above 85% utilization
-   **Constraint-Aware Planning** — Include node shapes, GPU scarcity, storage IOPS, AZ balance
-   **Event Injection Channel** — Product/marketing teams submit dated events with uplift factors
-   **Safety Buffers** — Minimum floor per service plus surge buffer for unknowns
-   **Closed Loop with Autoscaler** — Near-term (≤72h) via autoscaling, mid/long-term via reservations

### Seven Core Components

1.  **Ingest Pipeline** — Pulls metrics (RPS, CPU, memory, storage growth), event calendars, SLOs
2.  **Feature Builder** — Extracts seasonality (daily/weekly), trends, anomalies, promo flags
3.  **Forecaster** — Ensemble models (Prophet/ETS + XGBoost) with hierarchical reconciliation
4.  **Risk Engine** — Transforms forecasts → saturation probability vs headroom analysis
5.  **Action Planner** — Emits reservations (node pools, disks, LB capacity) + change requests
6.  **Planner API/UI** — Dashboards, approval workflows, alerts, and capacity governance
7.  **Feedback Loop** — Compares actuals vs forecasts for continuous model retraining

### LinkedIn Service Capacity Categories

#### Service Types by Planning Complexity

| Service Category | Forecast Drivers | Planning Quantile | Lead Time |
| --- | --- | --- | --- |
| **Feed Generation** | User growth, engagement | P90 (critical user experience) | 2-4 weeks |
| **Search & Discovery** | Query volume, ML model complexity | P85 (high user visibility) | 3-6 weeks |
| **Messaging Platform** | Active users, message volume | P90 (real-time communication) | 1-3 weeks |
| **Ads Serving** | Campaign budgets, bid competition | P95 (revenue critical) | 2-4 weeks |
| **Analytics/Reporting** | Data volume, report complexity | P70 (batch workloads) | 4-8 weeks |
| **ML Training** | Model size, training frequency | P80 (GPU constraints) | 6-12 weeks |

#### Reliability Stressors (What Can Break)

#### Critical Capacity Planning Failure Modes

-   **Regime Shifts:** Product virality breaks historical patterns → forecast models fail
-   **Data Gaps/Outliers:** Ingestion downtime skews models → inaccurate predictions
-   **Hidden Constraints:** Bin-packing, AZ quotas, storage warmup not modeled
-   **Lead-Time Misses:** Vendor/quota approval delays → capacity not ready when needed
-   **Coupled Services:** Upstream surge (auth) drives downstream (DB) non-linearly
-   **Procurement Failures:** Hardware shortages, quota exhaustion, budget freezes

## Page 2 — Architecture & Machine Learning Pipeline

### System Architecture Overview

<img src="/diagrams/linkedin-capacity-planner/1.svg" alt="linkedin-capacity-planner diagram 1" class="doc-diagram" />

### Ensemble ML Forecasting Pipeline

#### Multi-Model Ensemble Architecture

**Hierarchical Forecasting:** Global → Region → Cluster reconciliation with model diversity

##### Model Portfolio Strategy

-   **Prophet Model (40% weight):** Handles seasonality and holidays, robust to missing data
-   **ETS (Exponential Triple Smoothing) (30% weight):** Classical time-series, stable predictions
-   **XGBoost Ensemble (25% weight):** Captures complex feature interactions and events
-   **Linear Regression (5% weight):** Baseline model, interpretable coefficients

##### Feature Engineering Pipeline

-   **Time Features:** Hour of day, day of week, month, quarter, holiday flags
-   **Trend Features:** Moving averages (7d, 30d), growth rates, momentum indicators
-   **Seasonality Features:** Fourier transforms, periodic components, weekly cycles
-   **Event Features:** Product launches, marketing campaigns, A/B tests, holidays
-   **External Features:** Economic indicators, weather, social trends
-   **Cross-Service Features:** Upstream dependency signals, correlated service patterns

### Capacity Error Budget (CEB) Framework

#### Probabilistic Capacity Management

**Error Budget for Capacity:** Similar to SLO error budgets, but for resource utilization

##### CEB Calculation Methodology

CEB\_hours\_per\_month = total\_monthly\_hours \* utilization\_risk\_tolerance Example: 720 hours/month \* 0.01 = 7.2 hours above 85% utilization allowed

##### Service Tier CEB Allocation

-   **Tier 0 (Critical):** 0.5% CEB (3.6 hours/month) → Plan to P95 demand
-   **Tier 1 (Important):** 1.0% CEB (7.2 hours/month) → Plan to P90 demand
-   **Tier 2 (Standard):** 2.0% CEB (14.4 hours/month) → Plan to P85 demand
-   **Tier 3 (Best Effort):** 5.0% CEB (36 hours/month) → Plan to P70 demand

##### CEB Burn Rate Monitoring

-   **Real-time Tracking:** Current utilization vs capacity allocated
-   **Burn Rate Alerts:** Warn at 70% of monthly CEB, page at 90%
-   **Predictive Burn:** Forecast CEB consumption based on current trends
-   **Emergency Capacity:** Auto-provision when CEB burn rate critical

### Constraint-Aware Planning Engine

#### Multi-Dimensional Optimization

**Beyond CPU/Memory:** Include all infrastructure constraints in planning

##### Infrastructure Constraint Categories

-   **Compute Constraints:** Node shapes, CPU architectures, GPU availability
-   **Storage Constraints:** IOPS limits, bandwidth quotas, local vs network storage
-   **Network Constraints:** Bandwidth, packet rates, cross-AZ costs
-   **Quota Constraints:** Cloud provider limits, internal budget caps
-   **Physical Constraints:** Rack space, power, cooling capacity
-   **Geographic Constraints:** Data residency, latency requirements

##### Constraint Satisfaction Algorithm

-   **Mixed Integer Programming (MIP):** Optimal solution for complex constraints
-   **Greedy Heuristics:** Fast approximation for real-time planning
-   **Constraint Relaxation:** Fallback when no feasible solution exists
-   **Multi-Objective Optimization:** Balance cost, performance, availability

## Page 3 — Event Integration & Operational Excellence

### Event Injection & Calendar Integration

#### Marketing & Product Event Forecasting

**Human-in-the-Loop Planning:** Integrate business events with ML forecasts

##### Event Types & Impact Modeling

-   **Product Launches:** New feature rollouts, platform updates, mobile app releases
-   **Marketing Campaigns:** Email blasts, social media campaigns, paid advertising
-   **Seasonal Events:** Holidays, back-to-school, industry conferences
-   **External Events:** News cycles, viral content, competitor actions
-   **Internal Events:** A/B test launches, infrastructure changes, maintenance windows

##### Event Impact Quantification

-   **Uplift Factors:** Historical analysis of similar events (1.2× to 5× traffic)
-   **Duration Modeling:** Event start/peak/decay curves based on event type
-   **Service Correlation:** Map events to affected services (direct vs indirect)
-   **Confidence Intervals:** Uncertainty bounds around event impact predictions

### Viral Growth Scenario Management

#### Regime Shift Response Plan

**Scenario:** Viral adoption causes 3× traffic surge in 48 hours, forecast undershot by 25%, quotas not approved

##### Automated Emergency Response

1.  **Anomaly Detection (15 min):** CEB burn alarm triggers, forecast error exceeds threshold
2.  **Emergency Scaling (30 min):** Switch autoscaler to burst profile, enable graceful degradation
3.  **Quota Acceleration (2 hours):** Expedited quota request playbook, temporary region redistribution
4.  **Model Retraining (24 hours):** Inject event signal, retrain with uplift factors
5.  **Capacity Buffer (72 hours):** Increase overprovision buffer for next 2 weeks

##### Post-Incident Analysis & Learning

-   **Forecast Error Analysis:** Decompose error sources (seasonality, trend, event impact)
-   **Feature Gap Analysis:** Identify missing signals that could have predicted surge
-   **Model Improvement:** Adjust ensemble weights, add new feature categories
-   **Process Improvement:** Faster quota approval, better emergency playbooks

### Feedback Loop & Continuous Improvement

#### Model Performance Tracking

**Continuous Learning:** Monitor accuracy and retrain models automatically

##### Forecast Accuracy Metrics

-   **MAPE (Mean Absolute Percentage Error):** Primary accuracy metric by service/region
-   **Quantile Coverage:** How often P90 forecasts capture actual demand
-   **Direction Accuracy:** Correctly predict increase vs decrease in demand
-   **Peak Detection:** Accuracy in forecasting traffic spikes and seasonal peaks

##### Model Drift Detection

-   **Statistical Tests:** Kolmogorov-Smirnov test for distribution changes
-   **Performance Degradation:** MAPE increase above baseline threshold
-   **Feature Drift:** Input data distribution changes over time
-   **Concept Drift:** Relationship between features and target changes

##### Automated Retraining Pipeline

-   **Weekly Retraining:** Update models with latest data, hyperparameter tuning
-   **Trigger-based Retraining:** Major events, accuracy degradation, data quality issues
-   **A/B Testing:** Compare new model performance against production baseline
-   **Gradual Rollout:** Deploy new models to small subset of services first

### Cost Optimization & Budget Management

#### Cost-Aware Capacity Planning

**Budget SLO Integration:** Balance forecast accuracy with cost efficiency

##### Multi-Objective Cost Function

total\_cost = infrastructure\_cost + slo\_breach\_penalty + waste\_cost Where: - infrastructure\_cost = reserved\_capacity × unit\_price - slo\_breach\_penalty = breach\_hours × revenue\_impact\_per\_hour - waste\_cost = unused\_capacity × unit\_price × waste\_penalty\_factor

##### Planning Quantile Selection Strategy

-   **Revenue-Critical Services:** Plan to P95 (minimize SLO breach risk)
-   **User-Facing Services:** Plan to P85-P90 (balance user experience and cost)
-   **Internal Services:** Plan to P70-P80 (cost-optimized)
-   **Batch Workloads:** Plan to P60-P70 (elastic, cost-sensitive)

##### Budget Guardrails & Governance

-   **Monthly Budget Caps:** Hard limits per service/team/region
-   **Cost Approval Workflows:** Automatic approval under threshold, manual review above
-   **Budget Burn Rate Monitoring:** Alert at 70%, freeze at 90% of monthly budget
-   **Cost Attribution:** Detailed breakdown by service, team, project for chargeback

##### ✅ System Benefits

-   ≤8% forecast error with ensemble ML models
-   99% reservation hit-rate with constraint awareness
-   Capacity error budget prevents both under/over-provision
-   Event injection handles marketing campaigns and launches
-   Hierarchical reconciliation ensures consistency
-   Continuous learning adapts to changing patterns

##### ⚠️ System Limitations

-   12-week forecast horizon limited by pattern stability
-   Viral growth and regime shifts can break models
-   Complex constraint solving adds computational overhead
-   Event impact modeling requires historical precedents
-   Procurement lead times constrain planning effectiveness
-   Cross-service dependencies increase prediction complexity
