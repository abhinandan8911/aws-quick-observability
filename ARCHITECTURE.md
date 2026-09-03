# ARCHITECTURE — quick-observability

Enterprise observability for an Amazon Quick account. Quick's vended usage logs and its
CloudTrail API activity land in a governed S3 lake, are catalogued in Glue, queried through
Athena, and surfaced as a Quick dashboard plus a chat agent.

**Shape:** fully serverless, event-driven ingest with a scheduled batch filter. No compute
in the data path — no Lambda, no Firehose, no VPC, no NAT, nothing always-on.

---

## 1. Deployment diagram

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ AWS Account <account-id>                                             Region <region>     │
│                                                                                          │
│  ┌───────────────────────────┐                                                           │
│  │  Amazon Quick Suite       │  (regional, account-level service)                        │
│  │  Enterprise edition       │                                                           │
│  │                           │                                                           │
│  │  chat · agents · index    │                                                           │
│  │  knowledge bases · Spaces │                                                           │
│  └────────┬─────────────┬────┘                                                           │
│           │             │                                                                │
│  vended   │             │ every API call (control plane)                                 │
│  logs     │             │                                                                │
│  7 types  │             ▼                                                                │
│           │      ┌──────────────────┐        ┌───────────────────────────────────────┐   │
│           │      │   CloudTrail     │───────▶│ S3  existing trail bucket             │   │
│           │      │  (pre-existing)  │        │     READ-ONLY to this module          │   │
│           │      └──────────────────┘        └──────────────┬────────────────────────┘   │
│           │                                                 │                            │
│           ▼                                                 │ Glue external table        │
│  ┌─────────────────────────────┐                            ▼                            │
│  │ CloudWatch Logs             │                 ┌──────────────────────────┐            │
│  │ vended log delivery         │                 │ Glue DB                  │            │
│  │                             │                 │  <prefix>_raw_db         │            │
│  │  DeliverySource  x7         │                 │  └ cloudtrail_raw        │            │
│  │   (one per log type)        │                 │     account-wide,        │            │
│  │      │                      │                 │     NOT visible to Quick │            │
│  │      ├──▶ DeliveryDest S3   │                 └────────────┬─────────────┘            │
│  │      │      └─▶ Delivery ───┼──────┐                       │                          │
│  │      │                      │      │          ┌────────────▼─────────────┐            │
│  │      └──▶ DeliveryDest CWL  │      │          │ EventBridge Scheduler    │            │
│  │             └─▶ Delivery    │      │          │ rate(1 hour)             │            │
│  │                    │        │      │          │                          │            │
│  │  ┌─────────────────▼──────┐ │      │          │ universal target ───────▶│            │
│  │  │ /aws/vendedlogs/       │ │      │          │ athena:StartQueryExec    │            │
│  │  │   <prefix>/<type>  x7  │ │      │          │  INSERT ... WHERE        │            │
│  │  │ 90-day retention       │ │      │          │  eventsource =           │            │
│  │  │ live Logs Insights     │ │      │          │  'quicksight.amazonaws'  │            │
│  │  └────────────────────────┘ │      │          └────────────┬─────────────┘            │
│  └─────────────────────────────┘      │                       │ Quick-only rows          │
│                                       ▼                       ▼                          │
│                        ┌──────────────────────────────────────────────────────┐          │
│                        │ S3  <prefix>-datalake-<account-id>                   │          │
│                        │  SSE-KMS (CMK) · TLS enforced · versioned · no public│          │
│                        │                                                      │          │
│                        │   chat_logs/            ┐                            │          │
│                        │   feedback_logs/        │ 7 vended prefixes          │          │
│                        │   agent_hours_logs/     │ hive-compatible paths      │          │
│                        │   agent_metadata_logs/  │ gzip JSON                  │          │
│                        │   index_usage_logs/     │                            │          │
│                        │   kb_file_sync_logs/    │                            │          │
│                        │   dlp_logs/             ┘                            │          │
│                        │   quick_api_events_parquet/   Parquet, Quick-only    │          │
│                        │   athena-results/             30-day expiry          │          │
│                        │                                                      │          │
│                        │  Lifecycle: 90d ▶ Glacier IR, 365d ▶ Deep Archive    │          │
│                        └───────────────────────┬──────────────────────────────┘          │
│                                                │                                         │
│                        ┌───────────────────────▼──────────────────────────────┐          │
│                        │ Glue Data Catalog   <prefix>_db     (8 tables)       │          │
│                        │   partition projection · OpenX JSON + Parquet SerDe  │          │
│                        └───────────────────────┬──────────────────────────────┘          │
│                                                │                                         │
│                        ┌───────────────────────▼──────────────────────────────┐          │
│                        │ Athena workgroup  <prefix>-wg                        │          │
│                        │   results ▶ s3://.../athena-results/                 │          │
│                        └───────────────────────┬──────────────────────────────┘          │
│                                                │ direct query (no SPICE)                 │
│  ┌─────────────────────────────────────────────▼────────────────────────────────────┐    │
│  │ Amazon Quick assets                                                              │    │
│  │                                                                                  │    │
│  │   DataSource (Athena) ──▶ 5 DataSets ──┬──▶ Analysis ──▶ Dashboard (3 sheets)    │    │
│  │                                        └──▶ Topic ──▶ Space ──▶ Chat agent       │    │
│  │                                                                                  │    │
│  │   accessed via  IAM role  aws-quicksight-service-role-v0                         │    │
│  │                 + inline policy scoped to <prefix>_db and the lake bucket ONLY   │    │
│  └──────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                          │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐    │
│  │ KMS CMK  alias/<prefix>-logs   rotation on                                       │    │
│  │   grants: delivery.logs.amazonaws.com (S3 writes) · logs.<region> (log groups)   │    │
│  │           materialise role · Quick service role (decrypt for read)               │    │
│  └──────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                          │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐    │
│  │ Lambda  <prefix>-provisioner   (control plane only, NOT in the data path)        │    │
│  │   Python 3.12 + pinned boto3 layer. Runs at deploy time for the three things     │    │
│  │   CloudFormation cannot express: topic permissions, agent permissions, agent     │    │
│  │   publish state.                                                                 │    │
│  └──────────────────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### Mermaid equivalent

```mermaid
flowchart TB
  subgraph QUICK[Amazon Quick Suite - Enterprise]
    Q[chat / agents / index / KB / Spaces]
  end

  subgraph INGEST[Ingest]
    DS[DeliverySource x7]
    DD1[DeliveryDestination S3]
    DD2[DeliveryDestination CloudWatch]
    CWL[(/aws/vendedlogs/prefix/type x7)]
    CT[CloudTrail - pre-existing]
    TB[(S3 trail bucket - READ ONLY)]
  end

  subgraph FILTER[Quick-only filter]
    RAW[(Glue prefix_raw_db.cloudtrail_raw<br/>account-wide, not visible to Quick)]
    SCH[EventBridge Scheduler<br/>rate 1 hour, no Lambda]
    ATH1[athena:StartQueryExecution<br/>INSERT WHERE eventsource=quicksight]
  end

  subgraph LAKE[Governed lake]
    S3[(S3 prefix-datalake-account<br/>SSE-KMS, TLS, versioned)]
    GLUE[Glue prefix_db - 8 tables]
    WG[Athena workgroup prefix-wg]
  end

  subgraph QA[Quick assets]
    DSRC[Athena DataSource]
    SETS[5 DataSets - direct query]
    DASH[Dashboard - 3 sheets]
    TOPIC[Topic]
    SPACE[Space]
    AGENT[Chat agent]
  end

  Q -->|vended logs, 7 types| DS
  DS --> DD1 --> S3
  DS --> DD2 --> CWL
  Q -->|every API call| CT --> TB --> RAW
  SCH --> ATH1 --> S3
  RAW -.reads.-> ATH1
  S3 --> GLUE --> WG --> DSRC --> SETS
  SETS --> DASH
  SETS --> TOPIC --> SPACE --> AGENT
```

---

## 2. Components

| # | Component | Service | Purpose | Notes |
|---|---|---|---|---|
| 1 | Delivery source x7 | CloudWatch Logs | Registers the Quick account as a log producer, one per log type | **One source per (account, log type) account-wide.** A second pipeline collides with `ConflictException` |
| 2 | Delivery destination x14 | CloudWatch Logs | S3 and CloudWatch targets | One source feeds both — verified by probe |
| 3 | Delivery x14 | CloudWatch Logs | Binds source to destination | Hive-compatible S3 paths |
| 4 | Log groups x7 | CloudWatch Logs | Live tail and Logs Insights | Streams appear in seconds; S3 buffers ~5 min. Fastest proof delivery works. Optional |
| 5 | Lake bucket | S3 | Long-term store, Athena source | SSE-KMS with CMK, TLS enforced, versioned, all public access blocked, tiering at 90/365 days |
| 6 | CMK | KMS | Encrypts lake and log groups | Rotation on. Grants scoped by `aws:SourceAccount` + `aws:SourceArn` |
| 7 | Raw trail table | Glue | External table over the existing trail bucket | Account-wide. **Quick is granted nothing on this database or bucket** |
| 8 | Materialise schedule | EventBridge Scheduler | Hourly Quick-only filter | Universal target calls Athena directly. No Lambda |
| 9 | Audit table | Glue + S3 Parquet | Quick-only API events | Written by #8, deduplicated on read by `event_id` |
| 10 | Vended tables x7 | Glue | One per log type | Partition projection; OpenX JSON SerDe with case-insensitive mapping |
| 11 | Workgroup | Athena | Query isolation and result location | Results expire after 30 days |
| 12 | Quick data source | Quick | Athena connection | |
| 13 | Datasets x5 | Quick | Direct query, pre-joined | Direct query, not SPICE: no refresh schedule, no staleness |
| 14 | Dashboard | Quick | 3 sheets: Adoption, Cost & Capacity, Reliability & Audit | Visuals for unavailable tables are pruned at synth |
| 15 | Topic | Quick | Semantic layer for natural language | Column synonyms, data roles and default aggregations, so questions resolve without pre-written queries |
| 16 | Space + agent | Quick | Grounded chat over the topic | Requires a Pro-role owner |
| 17 | Provisioner | Lambda | Deploy-time only, for CFN gaps | Not in the data path |

---

## 3. Data flow

### Path A — vended usage logs (event-driven, near real time)

```
Quick activity ─▶ DeliverySource ─▶ Delivery ─┬─▶ S3 (~5 min buffer) ─▶ Glue ─▶ Athena
                                              └─▶ CloudWatch Logs (seconds)
```

**Not retroactive.** Only events after delivery is configured are captured; there is no
backfill. A table at 0 rows on day one is normal, and stays at 0 for any feature nobody
uses — `DLP_LOGS` never emits without a DLP provider.

### Path B — API audit (scheduled batch, Quick-only by construction)

```
Quick API call ─▶ CloudTrail ─▶ existing trail bucket
                                       │
                    Glue external table (account-wide, private to this module)
                                       │
                    hourly: Athena INSERT ... WHERE eventsource = 'quicksight.amazonaws.com'
                                       │
                    Parquet in this module's lake ─▶ the only audit table Quick can see
```

Filtering happens **once, at ingest**, because it cannot happen at source: for a trail,
`eventSource` on management events is exclusion-only and only for `kms` and `rdsdata`.
Event data stores can include-only any source but are queryable solely through CloudTrail
Lake, which cannot back an Athena dataset. CloudTrail files also interleave services, so
S3-prefix scoping is impossible.

**Duplicates are expected and correct.** The filter runs on a 3-hour window every hour, so
a missed run self-heals. `ROW_NUMBER() OVER (PARTITION BY event_id)` in the dataset keeps
one copy. This keeps the pipeline stateless — no watermark to corrupt, and a re-run is
always safe. Cost is ~3x write amplification, deliberately traded for the guarantee that a
two-hour outage loses nothing.

Unlike Path A, this **has history from the moment you deploy**, because the trail was
already running.

---

## 4. Security

| Control | Implementation |
|---|---|
| Encryption at rest | Customer-managed KMS key on the lake and all log groups. Bucket keys on for cost |
| Encryption in transit | `enforceSSL` denies any non-TLS request to the lake |
| Network exposure | None. No VPC, no endpoint, no public access. All public access blocked on the bucket |
| Least privilege — Quick | Inline policy on the Quick service role grants read on `<prefix>_db` and the lake bucket **only**. Explicitly **not** the raw database or the trail bucket. A synth-time assertion fails the build if that grant is ever re-added |
| Least privilege — filter | The materialise role is the only principal that can read the trail bucket |
| Sensitive content | Chat message bodies are **off by default** (`QUICK_OBS_LOG_SENSITIVE=false`). That is customer content and the dashboard does not need it |
| Delivery-path grants | Scoped by `aws:SourceAccount` and `aws:SourceArn` to this account's own delivery sources |
| Blast radius | Read-only on everything pre-existing. The trail and its bucket are never written to |

### What Quick can and cannot see

| | Quick service role |
|---|---|
| `<prefix>_db` (8 tables, Quick-only audit) | read |
| `<prefix>-datalake-<account>` | read |
| `<prefix>_raw_db` (account-wide CloudTrail) | **no access** |
| existing trail bucket | **no access** |

Verified after deploying: the Quick-visible audit table contains exactly one
`event_source`, `quicksight.amazonaws.com`, and the Quick service role has zero references
to the trail bucket.

---

## 5. Failure modes

Every one of these was observed while building this module. All fail **silently** —
healthy-looking resources, no error anywhere.

| Failure | Symptom | Guard now in place |
|---|---|---|
| Over-tight condition on a delivery grant | Deliveries healthy, CloudWatch fills, **S3 empty**. Two instances: `s3:x-amz-server-side-encryption` on the bucket policy, `kms:EncryptionContext:SourceArn` on the CMK | Documented policies in README. The CloudWatch mirror is authorised separately, which is why it keeps working and masks the fault |
| Region resolved differently by preflight and deploy | Deploy targets the wrong Region, fails on a missing bootstrap | `QUICK_OBS_REGION` only; ambient region variables ignored |
| Two formats in one S3 prefix | `HIVE_BAD_DATA: Expected magic number: PAR1`, and the whole table fails | Parquet uses a distinct prefix from the legacy JSON |
| Materialise lookback shorter than the schedule | Events dropped silently and **unrecoverably** — a later run never revisits an earlier window | Synth-time assertion: lookback >= 2x interval |
| Delivery source already exists | `ConflictException` mid-deploy | Preflight check 6 |
| Topic changed in place | `Resource handler returned message: "null"`, then `UPDATE_ROLLBACK_FAILED` | `QUICK_OBS_TOPIC_REVISION` forces replacement |
| Dataset points at a table that was never created | Stack fails when `QUICK_OBS_LOG_TYPES` is narrowed | Datasets declare `requires`; unavailable ones and their visuals are pruned at synth |

**The general lesson:** a green `describe-deliveries` proves configuration, not delivery.
Only an object in S3 does that.

---

## 6. Two things this deliberately does not build

Both are the obvious way to solve their problem, and both were rejected on measurement.

### No Firehose, and no Lambda transform, in the log path

The conventional shape for getting vended logs into S3 is: log group → subscription filter
→ Firehose → Lambda transform → S3. Across 7 log types that is 7 streams, 7 functions, 7
roles, 7 log groups and 7 subscription filters.

Probing established two facts that make all of it unnecessary: **S3 is a first-class
delivery destination**, and **one delivery source can feed multiple destinations**. So
`DeliverySource → DeliveryDestination → Delivery` reaches the same result with roughly **35
fewer resources**, and custom transform code disappears as a failure mode entirely.

Reshaping now happens declaratively — Glue SerDe column mapping and dataset SQL — which is
easier to inspect but cannot do anything conditional. Nothing here needed that.

### No tool gateway for the chat agent

The alternative to a semantic layer is a catalogue of query tools: one function per
question, each wrapping a fixed query, exposed to the agent over a gateway with its own
authentication and registered in Quick by hand.

Rejected because it fails both requirements of this module — it **cannot be one-click
deployed**, since registering the integration is a console step, and it **cannot be shared
as code**, since handing it over means handing over a runbook and a client secret. It also
answers only the questions someone thought to write a tool for.

A Quick topic over Athena datasets answers those same questions natively, from declared
column semantics, plus the ones nobody anticipated. The 11 named queries in
`scripts/query.ts` keep the terminal path for debugging.
