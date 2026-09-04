# quick-observability

Enterprise observability for an Amazon Quick account, as a **self-contained CDK
module**. Quick's vended usage logs and its CloudTrail API activity land in a governed
S3 lake, are catalogued in Glue, queried through Athena, and surfaced as two Quick
dashboards plus a chat agent you can ask questions in plain English.

Self-contained: it has its own `package.json`, `tsconfig.json` and `cdk.json`, and imports
nothing from outside its own tree. Fork it, or copy the tree into a subdirectory of your own
repo, and it works as-is.

```bash
npm install
npm run bootstrap     # once per account/region
npm run deploy        # preflight -> pipeline -> Quick assets
npm run verify        # proves logs are flowing and Athena can read them
npm run query         # named Athena queries from the terminal
```

---

## Read this first: logs are not retroactive

> *"Set up vended log delivery shortly after enabling Amazon Quick AI features. Logs are
> not retroactive – you only receive events that occur after delivery is configured."*
> — [Quick docs](https://docs.aws.amazon.com/quick/latest/userguide/monitoring-cloudwatch-logs.html)

This applies to the **seven vended log tables**, which are empty at deploy time. Nothing
that happened before you deployed is recoverable for them — there is no backfill.

The **audit table is different**: with the default `existing-trail` source it reads a
CloudTrail trail that has been running all along, so it has history from the moment you
deploy. In this account a 30-day backfill produced 6,386 Quick API events immediately.

So on a fresh deploy expect the API-audit visuals in the Quick Pulse dashboard to have
data immediately, while everything sourced from vended usage logs — chat, agent hours,
index storage and knowledge base sync — stays blank until Quick is used.

Two consequences worth knowing:

- A vended table at 0 rows is normal on day one, and stays at 0 for any Quick feature
  nobody uses. `DLP_LOGS` never emits without a DLP provider configured.
- If you want a populated dashboard for a demo, generate traffic first. `CHAT_LOGS` and
  `FEEDBACK_LOGS` appear only after real chat activity, so ask a Quick chat agent a batch
  of questions and rate some of the answers before deploying the Quick layer.

---

## Configure it for another account

Everything account-specific is one file, `lib/config.ts`, and every value there reads an
environment variable. No code edits.

| Variable | Default | What it does |
|---|---|---|
| `QUICK_OBS_ACCOUNT_ID` | from CDK credentials | Target AWS account |
| `QUICK_OBS_REGION` | `us-east-1` | **Must match the Region the Quick account lives in.** Delivery is per Region |
| `AWS_PROFILE` | *(unset)* | CLI profile. Leave empty to use the SDK's own credential resolution |
| `QUICK_OBS_PREFIX` | `quick-obs` | Prefixes every resource name, including the S3 bucket |
| `QUICK_OBS_OWNER` | *(required)* | Quick username that owns the dashboard, topic, Space and agent |
| `QUICK_OBS_NAMESPACE` | `default` | Quick namespace |
| `QUICK_OBS_LOG_TYPES` | `all` | Comma list to narrow which of the 7 log types to deliver |
| `QUICK_OBS_LOG_SENSITIVE` | `false` | `true` also delivers chat message bodies. See below |
| `QUICK_OBS_AUDIT_SOURCE` | `existing-trail` | `existing-trail` \| `own-trail` \| `eventbridge` \| `none`. See Audit source |
| `QUICK_OBS_TRAIL_BUCKET` | *(required for `existing-trail`)* | Bucket an existing CloudTrail trail writes to |
| `QUICK_OBS_TRAIL_PREFIX` | *(empty)* | Key prefix on that trail, if it has one |
| `QUICK_OBS_TRAIL_ACCOUNT_ID` | same as target | Whose logs to read. Differs for an organisation trail |
| `QUICK_OBS_MATERIALISE_SCHEDULE` | `rate(1 hour)` | How often the Quick-only filter runs |
| `QUICK_OBS_MATERIALISE_LOOKBACK_HOURS` | `3` | Filter lookback. Must be at least 2x the schedule interval; enforced at synth time |
| `QUICK_OBS_TOPIC_REVISION` | `2` | Bump to replace the topic. CloudFormation cannot update a Quick topic |
| `QUICK_OBS_CLOUDWATCH` | `true` | `false` skips the CloudWatch destination and delivers only to S3 |
| `QUICK_OBS_RETENTION_DAYS` | `90` | CloudWatch retention. S3 is the long-term store |
| `QUICK_OBS_SERVICE_ROLE` | `aws-quicksight-service-role-v0` | The account's Quick service role |

```bash
QUICK_OBS_ACCOUNT_ID=111122223333 \
QUICK_OBS_REGION=eu-west-1 \
QUICK_OBS_PREFIX=acme-quickobs \
QUICK_OBS_OWNER='someone@example.com' \
AWS_PROFILE=acme \
npm run deploy
```

**`QUICK_OBS_REGION` deliberately ignores `AWS_REGION` and `CDK_DEFAULT_REGION`.** Both
were tried and both caused the module to report one Region and deploy to another —
`CDK_DEFAULT_REGION` is set only under the CDK CLI, so preflight and deploy disagreed;
and `AWS_REGION` is exported globally on some workstations, shadowing the profile's own
Region. One explicit knob means preflight and deploy can never diverge.

---

## Architecture

```
Amazon Quick account
  │
  │  vended logs, 7 types
  ▼
DeliverySource (one per log type)
  ├──► DeliveryDestination(S3)  ──► Delivery ──► s3://<prefix>-datalake-<acct>/<log_type>/
  └──► DeliveryDestination(CWL) ──► Delivery ──► /aws/vendedlogs/<prefix>/<type>
                                                    (live Logs Insights; fastest proof
                                                     delivery works — streams appear in
                                                     seconds, S3 buffers ~5 min)

CloudTrail (Quick API calls, reads AND writes)
  └──► <prefix>_raw_db.cloudtrail_raw          ← raw trail, account-wide, NOT visible to Quick
         │  EventBridge Scheduler, hourly, no Lambda
         │  Athena INSERT ... WHERE eventsource = 'quicksight.amazonaws.com'
         ▼
       <prefix>_db.quick_api_events            ← Quick-only, in this module's lake

S3 lake ──► Glue Data Catalog (8 tables) ──► Athena workgroup
                                              │
                                              ▼
                             Quick: Athena data source
                                    5 direct-query datasets
                                    2 dashboards
                                    topic + Space + chat agent
```

### Why there is no Firehose and no Lambda in the log path

The conventional way to land vended logs in S3 is, per log type: CloudWatch log group →
**subscription filter** → **Firehose** → **Lambda transform** → S3.

Verified by probe that **S3 is a first-class delivery destination**, and that **one
delivery source can feed multiple destinations**. So the same result needs only
`DeliverySource` → `DeliveryDestination` → `Delivery`, which removes a Firehose stream, a
Lambda function, its role, its log group and a subscription filter **per log type** —
about 35 fewer resources across 7 types — and removes the transform code as a failure
mode.

**There is now no Firehose at all by default.** The audit path originally used
EventBridge → Firehose → S3, until measurement showed that EventBridge never delivers
read-only CloudTrail events: in one 10-minute window this account logged **57 Quick API
events, 55 of them reads**. That path saw ~3.5% of activity.

Reading an existing trail's S3 bucket instead removed the Firehose stream, the
EventBridge rule, the delivery role, the target role and a KMS producer grant — five
resources — and took the audit table from **3 rows to 5,905**. CloudTrail also backfills,
so unlike vended logs the audit history is there from the moment you deploy.

## Audit source

`QUICK_OBS_AUDIT_SOURCE` selects where Quick API activity comes from:

| Value | Infra | Coverage | Cost | When |
|---|---|---|---|---|
| **`existing-trail`** *(default)* | raw table + hourly Athena filter (no Lambda) | reads **and** writes, with history, **Quick-only** | Athena scan only | Almost always. Needs `QUICK_OBS_TRAIL_BUCKET` |
| `own-trail` | trail + raw table + hourly filter | reads and writes, Quick-only in the Quick DB | second copy of management events, ~$2/100k. **Note the raw trail lands in this module's bucket**, so account-wide data is stored even though only Quick is exposed | No usable trail exists |
| `eventbridge` | rule + Firehose + 2 roles + KMS grant | **writes only** | negligible | You specifically want no trail dependency |
| `none` | none | agent and DLP changes only, from vended logs | none | You do not want an API audit table |

### Quick-only by construction, not by filtering

A CloudTrail trail contains **every** management event in the account, and it cannot be
narrowed to one service: the docs are explicit that for trails, `eventSource` on management
events is exclusion-only, and only for `kms.amazonaws.com` and `rdsdata.amazonaws.com`.
CloudTrail files also interleave services, so the data cannot be scoped by S3 prefix
either.

An earlier version read the trail directly with a `WHERE eventsource = 'quicksight...'` in
the dataset. The dashboard looked right, but the module was **not** Quick-only:

- `quick_obs_db.quick_api_events` exposed the whole account — measured: 3,971 STS, 3,392
  IAM, 2,490 S3, 1,181 KMS, plus Lambda, EC2 and CloudFormation, alongside 5,924 Quick.
- The Quick service role held `s3:GetObject` on the **entire** trail bucket.

So the filter now happens **once, at ingest**:

| | |
|---|---|
| `<prefix>_raw_db.cloudtrail_raw` | Raw trail. Account-wide. Read only by the materialise role. Quick is granted **nothing** on this database or the trail bucket |
| `<prefix>_db.quick_api_events` | Quick-only Parquet in this module's lake. The single audit table Quick can see |

Verified after deploying: the Quick-visible table contains exactly one `event_source`
(`quicksight.amazonaws.com`, 6,386 events — 5,460 reads, 926 writes), the Quick service
role has zero references to the trail bucket, and its Glue grant covers `quick_obs_db`
only.

The hourly filter is an **EventBridge Scheduler universal target calling
`athena:StartQueryExecution` directly** — no Lambda. Its lookback (3h, configurable) is
deliberately longer than the interval so a missed run self-heals; the resulting duplicates
are removed by `event_id`, which keeps the pipeline stateless with no watermark to corrupt.

The window is sized from a measurement, not a guess. End-to-end event-to-Athena lag on
this account under load was **3 minutes**, p95 about **4 minutes** across 400 consecutive
trail objects. AWS documents "an average of about 5 minutes" and does not guarantee it, so
the lag term is budgeted at a full hour anyway. 3h therefore buys **2 hours of missed-run
tolerance** at 3x write amplification, where the original 6h bought 5 hours at 6x.

The asymmetry is deliberate: too *long* only wastes storage that dedupe-on-read already
hides, whereas too *short* drops events silently and permanently, because a later run never
revisits an earlier window. `lib/config.ts` therefore refuses at synth time to deploy a
lookback under 2x the schedule interval:

```
QUICK_OBS_MATERIALISE_LOOKBACK_HOURS is 1h but the schedule "rate(1 hour)" runs every 1h,
so it needs at least 2h.
```

```bash
npm run backfill                # last 30 days of history into the Quick-only table
npm run backfill -- --days 90
npm run backfill -- --dry-run
```

Remaining trade-offs:

- **You depend on a bucket you do not own** — the existing trail bucket. Preflight
  checks it is readable and has objects, and fails with the fix if not.
- **The scheduled query scans the trail**, pruned to the last two days by partition
  projection. The 30-day backfill scanned 8.4 MB.
- **A CMK-encrypted trail bucket** would need that key granted to the materialise role
  (not to Quick). This account's trail is SSE-S3, so there is nothing to grant.

### Why there is no tool gateway for the agent

The usual way to give a chat agent operational answers is a catalogue of query tools: one
named function per question, each wrapping a fixed query, exposed over a gateway with its
own authentication and **registered in Quick by hand**. That cannot be one-click deployed,
cannot be shared as code without also handing over a runbook and a client secret, and
answers only the questions someone thought to write a tool for.

With the data in Athena and exposed as a Quick topic, the agent answers those questions
from declared column semantics — and the ones nobody anticipated too. So the
**list of questions was kept as the specification** for what the dashboard, topic and
`npm run query` must answer, and the gateway was dropped.

---

## The 7 log types

| Log type | Table | What it tells you |
|---|---|---|
| `CHAT_LOGS` | `chat_logs` | Who asked what, against what scope, and whether it succeeded |
| `FEEDBACK_LOGS` | `feedback_logs` | Thumbs up/down and the reason given |
| `AGENT_HOURS_LOGS` | `agent_hours_logs` | Metered agent hours, split entitlement vs billable overage. The cost log |
| `AGENT_METADATA_LOGS` | `agent_metadata_logs` | Agent create/update/delete and permission changes |
| `INDEX_USAGE_LOGS` | `index_usage_logs` | Index storage and document counts per knowledge base and Space |
| `KB_FILE_SYNC_LOGS` | `kb_file_sync_logs` | Per-document sync outcome, with error type and suggested fix |
| `DLP_LOGS` | `dlp_logs` | DLP enforcement decisions and configuration changes |

Plus `quick_api_events` from CloudTrail.

### Privacy by default

`user_message`, `system_text_message`, `feedback_details`, DLP `file_name` and the agent
prompt fields are **not delivered** unless you opt in:

```bash
QUICK_OBS_LOG_SENSITIVE=true npm run deploy
```

Without them you still get who asked, when, against what, and whether it worked — every
metric in the dashboard. You just cannot read the questions. ARCC's logging guidance is
explicit that personal data must not be logged in plain text, and the Quick docs carry
the same warning.

`recordFields` cannot be trimmed arbitrarily: a 7-field subset was rejected with
`Mandatory record fields are missing`. The full documented list minus the sensitive
fields is accepted, and that is what the module sends.

---

## Commands

| Command | Does |
|---|---|
| `npm run bootstrap` | CDK bootstrap for the target account/region |
| `npm run preflight` | Prerequisite gate; exits non-zero on a blocker |
| `npm run deploy` | Preflight, then both stacks |
| `npm run verify` | Structural checks **plus** real Athena row counts |
| `npm run query` | List named Athena queries |
| `npm run query -- health` | Row counts per table — fastest read on what is flowing |
| `npm run query -- api-denied` | Quick API calls that were denied or errored |
| `npm run query -- api-reads` | Who is reading which Quick assets — invisible to the `eventbridge` source |
| `npm run query -- --sql "…"` | Ad-hoc SQL |
| `npm run backfill` | Load 30 days of Quick-only audit history. Safe to re-run |
| `npm run typecheck` | Typecheck without deploying |
| `npm run destroy` | Remove both stacks |

Deploy just one stack: `npx cdk deploy quick-obs-pipeline`.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `ConflictException: This ResourceId has already been used in another Delivery Source` | Only **one** delivery source may exist per (Quick account, log type) per AWS account. Something else already claims it. `npm run preflight` detects this and prints the exact delete commands, or narrow `QUICK_OBS_LOG_TYPES` |
| Tables at 0 rows on a fresh deploy | Expected. Logs are not retroactive and unused features emit nothing |
| A table stays at 0 rows **while its S3 prefix has objects** | The Glue column names do not match the JSON. This is the real trap — see below |
| Preflight cannot read a Quick subscription | Wrong Region. Delivery is per Region; set `QUICK_OBS_REGION` |
| Bucket name rejected | S3 names are global. Change `QUICK_OBS_PREFIX` |
| Dashboard renders but every visual is empty | No data yet, not a broken dashboard. Check `npm run query -- health` first |
| Agent not listed in Quick | Use the **All chat agents** filter. A CloudFormation-created agent has no Quick user as creator, so it is absent from "My chat agents" and from the composer's picker |

### Field naming is inconsistent across log types

Chat and feedback logs use `logType` and `accountId` (camelCase). **Every other type**
uses `log_type` and `account_id` (snake_case). Get it wrong and the column reads back
`NULL` with no error at all. `lib/log-schemas.ts` encodes the correct convention per type
and is the single place to change it.

### A JSON object cannot be read into a string column

The OpenX JSON SerDe returns `NULL` for an object read into a `string` column, so
`json_extract_scalar` on it yields nothing — a table that queries successfully with every
column empty. The `quick_api_events.detail` column is therefore a typed `struct`, read as
`detail.eventname`, not as JSON text. Only fields always present on a CloudTrail record
are declared; `requestParameters` is omitted because its shape varies per operation.

### EventBridge does not receive read-only CloudTrail events

This is why `eventbridge` is no longer the default. Read-only calls (`List*`,
`Describe*`, `Get*`) are never delivered to EventBridge, so with that source the
dashboard's "Reads vs Changes" chart is entirely changes and the `Read Only` column is
always `No`. Measured here: 55 of 57 Quick events in a sampled window were reads.

If you must use `eventbridge`, expect roughly 3.5% coverage and no history — CloudTrail
does not replay past events onto the bus.

### The audit table has two different shapes

CloudTrail writing to S3 produces `{"Records":[ ... ]}` — one object per file containing
an array — and needs `CloudTrailSerde`, which understands that wrapper. A plain JSON
SerDe reads **zero rows** from it. The EventBridge path instead produces one envelope per
line with the record nested under `detail`.

So the Glue table, the dataset SQL (`auditSql()` in `lib/datasets.ts`) and the named
queries (`A` in `scripts/query.ts`) all branch on `QUICK_OBS_AUDIT_SOURCE`. Switching
source without updating all three fails loudly with `COLUMN_NOT_FOUND`, which is how the
mismatch was caught. The dashboard and topic see an identical column contract either way.

### Firehose with a customer-managed key needs a KMS grant on the *producer*

If the EventBridge rule shows `Invocations` and `FailedInvocations` climbing by the same
amount while Firehose reports zero `IncomingRecords`, the target role is missing
`kms:GenerateDataKey` on the delivery key. Neither the event target nor
`DeliveryStream.grantPutRecords()` adds it. `lib/pipeline-stack.ts` reaches the target's
singleton `EventsRole` and grants the key explicitly, and throws at synth if it cannot
find that role — because the failure is otherwise invisible outside those two metrics.

### A Quick topic cannot be updated — bump `QUICK_OBS_TOPIC_REVISION`

`AWS::QuickSight::Topic` fails with a bare `Resource handler returned message: "null"`
whenever its columns change — on update **and** on rollback, which wedges the stack in
`UPDATE_ROLLBACK_FAILED`. The underlying `CreateTopic`/`UpdateTopic` API calls succeed with
no error in CloudTrail; the failure is in the CloudFormation handler.

So the topic id **and** its construct logical id both carry `TOPIC_REVISION`. Changing only
`topicId` is not enough — CloudFormation still attempts an in-place update. Bump the
revision and it replaces the topic instead.

To recover a wedged stack:

```bash
aws cloudformation continue-update-rollback --stack-name <prefix>-quick \
  --resources-to-skip Topic --profile <profile> --region <region>
```

### Never point two file formats at one S3 prefix

The materialised audit table is Parquet at `quick_api_events_parquet/`, deliberately not the
`quick_api_events/` prefix the EventBridge/Firehose path writes GZIP JSON to. Sharing them
once left stale `.gz` objects under a Parquet table, and Athena failed the **whole table**
with `HIVE_BAD_DATA: Malformed Parquet file. Expected magic number: PAR1 got: <gzip>` —
which then made the Quick topic fail to create, because its dataset could not be read.
Encoding the format in the prefix makes the collision impossible.

### `UpdateAgent` replaces omitted fields with null

`UpdateAgent` is **not** a merge. Calling it without `StarterPrompts` or
`WelcomeMessage` silently clears them, and CloudFormation will not report drift
afterwards — so a hand-run CLI update against a CDK-managed agent quietly degrades it.
Its parameters are also not symmetric with `CreateAgent`: it takes `SpacesToAdd` /
`SpacesToRemove` rather than `Spaces`, and has no `AgentLifecycle` at all.

If you need to repair an agent to match the code:

```bash
python3 - <<'PY'
import boto3
qs = boto3.Session(profile_name='my-profile', region_name='us-east-1').client('quicksight')
qs.update_agent(AwsAccountId='<account>', AgentId='<prefix>-agent',
                Name=..., Description=..., WelcomeMessage=..., StarterPrompts=[...])
PY
```

`npm run verify` reports the starter-prompt count, which is how this was caught.

### Do not condition a delivery bucket policy on the encryption header

`s3:x-amz-server-side-encryption` only exists as a condition key when the caller
*explicitly* requests encryption on `PutObject`. The log delivery service relies on the
bucket's default encryption instead, so the key is absent, the condition fails, the
`Allow` never applies, and every put is silently denied. The symptom is deliveries
reporting healthy, CloudWatch streams filling, and **zero objects in S3**. Encryption is
still guaranteed by the bucket's default KMS encryption plus `enforceSSL`.

### And do not condition the CMK policy on a logs encryption context

Exactly the same symptom, a second cause, found only after the bucket policy was already
right. The key policy statement for `delivery.logs.amazonaws.com` was gated on
`kms:EncryptionContext:SourceArn = arn:aws:logs:<region>:<account>:*`. That condition never
matches: when the delivery service encrypts an **S3 object** it passes the S3 encryption
context (`aws:s3:arn`), not a logs ARN. KMS denied every write.

Use the documented form instead - the full action set, gated on `aws:SourceAccount` plus
`aws:SourceArn` matching a delivery *source*:

```json
{ "Sid": "AllowVendedLogDeliveryService",
  "Effect": "Allow",
  "Principal": { "Service": "delivery.logs.amazonaws.com" },
  "Action": ["kms:Encrypt","kms:Decrypt","kms:ReEncrypt*","kms:GenerateDataKey*","kms:DescribeKey"],
  "Resource": "*",
  "Condition": {
    "StringEquals": { "aws:SourceAccount": "<account>" },
    "ArnLike": { "aws:SourceArn": "arn:aws:logs:<region>:<account>:delivery-source:*" } } }
```

Both bugs share a shape worth remembering: **an over-tight condition on a delivery path
that reports success either way.** The CloudWatch mirror keeps working throughout, because
it is covered by a different key-policy statement, which makes the pipeline look healthy
while the S3 side delivers nothing.

To prove the S3 path without waiting for real chat traffic, create and delete a scratch
agent - `CreateAgent` emits `AGENT_METADATA_LOGS`, and the object appears within ~5 minutes:

```bash
python3 - <<'PY'
import boto3
q = boto3.Session(profile_name='my-profile', region_name='us-east-1').client('quicksight')
q.create_agent(AwsAccountId='<account>', AgentId='vendedlog-probe', Name='Vended Log Probe')
PY
aws s3 ls s3://<prefix>-datalake-<account>/agent_metadata_logs/ --recursive
```

---

## Layout

```
bin/app.ts                     Two stacks: <prefix>-pipeline, then <prefix>-quick
lib/config.ts                  Single source of truth. All portability lives here
lib/log-schemas.ts             The 7 log types' fields, transcribed from the docs
lib/pipeline-stack.ts          CMK, S3 lake, 7 sources x 2 destinations, Firehose, Glue, Athena
lib/quick-assets-stack.ts      Athena data source, 5 datasets, 2 dashboards, topic, Space, agent
lib/datasets.ts                Dataset SQL and column semantics
lib/dashboards.ts              Loads the two captured dashboards, binds them to the datasets
lib/dashboards/*.json          The two dashboards, exported verbatim from Amazon Quick
lib/topic-definition.ts        Topic semantics, custom instructions, agent copy
lib/boto3-layer.ts             Pinned boto3 layer (the runtime's boto3 lacks the Agents API)
lambda/provisioner/index.py    Topic and agent permissions, which CloudFormation cannot set
scripts/preflight.ts           Prerequisite gate
scripts/verify.ts              Post-deploy checks incl. real Athena row counts
scripts/query.ts               Named Athena queries
```

Two stacks because Quick datasets are validated against live Athena tables at creation
time, so the pipeline must exist first.

---

## Security posture

Follows ARCC SAX-08 (secure logging by default) and SAX-06 (approved log storage). Log
data is classified higher than ordinary demo data — chat logs can contain whatever a user
typed.

| Control | Implementation |
|---|---|
| Encryption at rest | Customer-managed KMS key, rotation on. Key policy grants `delivery.logs.amazonaws.com` `kms:GenerateDataKey`/`Decrypt` scoped by `kms:EncryptionContext:SourceArn` — required, delivery fails without it |
| Sensitive fields | Excluded by default; opt in with `QUICK_OBS_LOG_SENSITIVE=true` |
| Encryption in transit | `enforceSSL` plus explicit `Deny` on `aws:SecureTransport = false` |
| Retention tiering | S3 Standard → Glacier Instant at 90 days → Deep Archive at 365. Athena results expire at 30 days |
| Public access | `BlockPublicAccess.BLOCK_ALL` |
| Integrity | Bucket versioning |
| Least privilege | Quick's Athena/Glue/S3/KMS grants are scoped to this database, workgroup, bucket and key. No wildcards. The provisioner Lambda is scoped to `<prefix>-*` topics and agents |
| Cross-account | Delivery writes conditioned on `aws:SourceAccount` |

**POC deviations, to change for production:** `RemovalPolicy.DESTROY` and
`autoDeleteObjects` on the bucket and key; no S3 Object Lock; no cross-region
replication; no separate security account. ARCC asks for 7-year retention on security
logs — the lifecycle here tiers but does not expire, so set an explicit expiration to
match your policy.
