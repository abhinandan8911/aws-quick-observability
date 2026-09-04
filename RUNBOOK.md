# RUNBOOK — quick-observability

Operational guide for deploying and running the Amazon Quick observability stack.
Audience: DevOps / platform engineers with admin access to the target AWS account.

**Time to first deploy:** ~25 minutes, of which ~12 is unattended CloudFormation.

---

## 0. Before you start

### What this deploys

Two CloudFormation stacks into **one account, one Region**:

| Stack | Contains | Typical duration |
|---|---|---|
| `<prefix>-pipeline` | KMS key, S3 lake, 7 log delivery sources x 2 destinations, Glue databases and tables, Athena workgroup, EventBridge Scheduler | ~6 min |
| `<prefix>-quick` | Quick Athena data source, 5 datasets, analysis, dashboard, topic, Space, chat agent, provisioner Lambda | ~6 min |

### Prerequisites

| Requirement | How to check | If missing |
|---|---|---|
| Node.js 20+ | `node --version` | Install Node 20 LTS |
| AWS credentials with admin in the target account | `aws sts get-caller-identity` | Assume an admin role |
| Amazon Quick **Enterprise** edition | `aws quicksight describe-account-settings --aws-account-id <id> --query 'AccountSettings.Edition'` | Spaces, agents and topics are Enterprise-only. Standard returns `UnsupportedUserEditionException` |
| A Quick user with a `*_PRO` role | `aws quicksight list-users --aws-account-id <id> --namespace default --query 'UserList[].[UserName,Role]' --output table` | Only Pro roles can own a Space or agent |
| The Quick service role exists | `aws iam get-role --role-name aws-quicksight-service-role-v0` | Created the first time Quick is granted resource access in the console |
| A CloudTrail trail (for the default audit source) | `aws cloudtrail describe-trails --query 'trailList[].[Name,S3BucketName]' --output table` | Use `QUICK_OBS_AUDIT_SOURCE=own-trail` instead |
| CDK bootstrapped in the Region | `aws cloudformation describe-stacks --stack-name CDKToolkit` | `npm run bootstrap` |

### Cost

Driven by data volume, not by idle infrastructure. There are no always-on compute
resources — no Lambda in the data path, no Firehose, no NAT.

| Component | Basis | Order of magnitude |
|---|---|---|
| S3 storage | Compressed JSON + Parquet | Cents/month at POC volume |
| Athena | $5/TB scanned | The hourly filter scanned 8.4 MB for a 30-day backfill |
| KMS | $1/key/month + requests | ~$1/month |
| CloudWatch Logs | Ingest + 90-day retention | Cents/month; set `QUICK_OBS_CLOUDWATCH=false` to remove |
| Quick | Per-user subscription | **Unchanged by this module** — it creates no users |
| CloudTrail | `existing-trail` reads a trail you already pay for | $0 extra. `own-trail` adds a 2nd copy of management events, ~$2/100k |

---

## 1. Configure

```bash
npm install
cp env/example.env env/prod.env
$EDITOR env/prod.env
```

Three values are **required**; everything else has a working default. Synth fails with an
instruction if one is missing, so a half-configured deploy cannot start.

| Variable | How to find it |
|---|---|
| `QUICK_OBS_ACCOUNT_ID` | `aws sts get-caller-identity --query Account --output text` |
| `QUICK_OBS_OWNER` | `aws quicksight list-users --aws-account-id <id> --namespace default --query 'UserList[].[UserName,Role]' --output table` — copy the `UserName` **exactly**, including the role prefix for federated identities (`Admin/alice`) |
| `QUICK_OBS_TRAIL_BUCKET` | `aws cloudtrail describe-trails --query 'trailList[].[Name,S3BucketName]' --output table`. Not needed if you set `QUICK_OBS_AUDIT_SOURCE=own-trail` |

Every command below takes `QUICK_OBS_ENV=prod`. Export it once for the session:

```bash
export QUICK_OBS_ENV=prod
```

> `QUICK_OBS_REGION` must match the Region the Quick account lives in — vended log
> delivery is per Region. It deliberately ignores `AWS_REGION` and `CDK_DEFAULT_REGION`;
> honouring either caused preflight and deploy to target different Regions.

---

## 2. Preflight

```bash
npm run preflight
```

Eight read-only checks. **Do not skip it** — check 6 is the one that matters:

| Check | Why it exists |
|---|---|
| Credentials resolve, and the account matches config | Catches deploying to the wrong account |
| Region is consistent | Catches the preflight/deploy divergence described above |
| Quick account exists and is Enterprise | Standard edition cannot host Spaces or agents |
| Owner user exists, and is a Pro role | Otherwise the deploy fails on the first Quick asset |
| Quick service role exists | Needed to grant lake access |
| **No conflicting delivery source** | There can be **one delivery source per (account, log type)** account-wide. If Quick logging is already configured, `PutDeliverySource` fails with `ConflictException` mid-deploy |
| Trail bucket is readable | An unreadable bucket yields a silently empty audit table |
| CDK is bootstrapped | Deploy fails immediately without it |

If check 6 reports a conflict, it prints the exact remediation. Read it before deleting
anything — an existing delivery source may belong to another team's pipeline.

---

## 3. Deploy

```bash
npm run deploy          # preflight, then both stacks
```

Stacks deploy in dependency order. To go stack by stack:

```bash
npx cdk deploy "$PREFIX-pipeline"
npx cdk deploy "$PREFIX-quick"
```

**Expected output:** stack ARNs plus the lake bucket name, Glue database, Athena
workgroup, KMS key ARN and the delivered log types.

---

## 4. Verify

```bash
npm run verify
```

Checks structure **and** whether data is actually flowing. Two things to expect on a
first deploy, both normal:

1. **Vended log tables show 0 rows.** Quick's logs are **not retroactive** — you only get
   events that occur after delivery is configured. There is no backfill for them.
2. **The audit table has data immediately**, because `existing-trail` reads a trail that
   has been running all along.

```bash
npm run backfill -- --days 30     # load audit history; --dry-run to preview scan size
npm run query -- health           # row counts per table
```

To confirm the vended path end-to-end without waiting for real usage, create and delete a
throwaway agent — `CreateAgent` emits `AGENT_METADATA_LOGS`, and the S3 object appears
within ~5 minutes:

```bash
aws quicksight create-agent --aws-account-id "$ACCT" --agent-id vendedlog-probe --name 'Probe'
sleep 300
npm run query -- health           # agent_metadata_logs should be >= 1
aws quicksight delete-agent --aws-account-id "$ACCT" --agent-id vendedlog-probe
```

---

## 5. Operate

### Daily / weekly

```bash
npm run query                 # list the 11 named queries
npm run query -- health       # row counts: the fastest read on what is flowing
npm run query -- api-denied   # access denials, usually the useful signal
npm run query -- adoption     # chat turns, distinct users, failures per day
```

### What to monitor

| Signal | Where | Meaning if it breaks |
|---|---|---|
| `quick_api_events` row count stops growing | `npm run query -- health` | The hourly filter is failing. Check the Scheduler and Athena query history |
| Scheduler invocation errors | CloudWatch metrics, `AWS/Scheduler`, `TargetErrorCount` for `<prefix>-materialise-quick-audit` | Athena permission or syntax failure |
| Athena failed queries | Athena console, workgroup `<prefix>-wg`, Recent queries | Malformed data or a Glue schema mismatch |
| S3 prefix has objects but the table returns 0 rows | `aws s3 ls` vs `npm run query -- health` | Glue SerDe column mapping is wrong, **not** a delivery problem. See `lib/log-schemas.ts` |
| Dashboard visuals empty but tables have rows | Quick console | Dataset needs a refresh, or Quick lost lake access. Re-check the service role policy |

### Routine changes

| Task | Command |
|---|---|
| Change the filter schedule or lookback | Edit `env/prod.env`, `npm run deploy`. The lookback must be >= 2x the interval; enforced at synth |
| Narrow which log types are delivered | `QUICK_OBS_LOG_TYPES=CHAT_LOGS,FEEDBACK_LOGS`, redeploy. Datasets and dashboard visuals for absent tables are pruned automatically |
| Change the topic definition | **Bump `QUICK_OBS_TOPIC_REVISION`.** CloudFormation cannot update a Quick topic in place — see Troubleshooting |
| Load more audit history | `npm run backfill -- --days 90` |

---

## 6. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `<VAR> is required and not set` | Working as intended. Set it in `env/<name>.env` or the environment |
| `ConflictException` on `PutDeliverySource` | Another delivery source already owns that log type in this account. One source per (account, log type). Preflight prints the remediation |
| `UnsupportedUserEditionException` (403) | Quick is on Standard edition. Spaces, agents and topics need Enterprise |
| Deploy targets the wrong Region | Set `QUICK_OBS_REGION`. Do not rely on `AWS_REGION` or the profile's Region |
| Topic fails with `Resource handler returned message: "null"` | A Quick topic cannot be updated in place, and the rollback also fails, leaving `UPDATE_ROLLBACK_FAILED`. Recover with the command below, then bump `QUICK_OBS_TOPIC_REVISION` and redeploy |
| Deliveries look healthy, CloudWatch fills, **S3 stays empty** | An over-tight condition on the delivery path. Two have bitten this module: `s3:x-amz-server-side-encryption` on the bucket policy, and `kms:EncryptionContext:SourceArn` on the CMK. Both are documented in README's Troubleshooting with the correct policy |
| `HIVE_BAD_DATA: Malformed Parquet file. Expected magic number: PAR1` | A table points at an S3 prefix holding a different format. Do not reuse one prefix for two formats |
| Athena `COLUMN_NOT_FOUND` on audit queries | The audit table's shape differs per `QUICK_OBS_AUDIT_SOURCE`. `scripts/query.ts` branches on it; a hand-written query must too |

Recovering a stuck topic update:

```bash
aws cloudformation continue-update-rollback \
  --stack-name "$PREFIX-quick" --resources-to-skip Topic
# then bump QUICK_OBS_TOPIC_REVISION in env/prod.env and redeploy
```

---

## 7. Roll back

CloudFormation rolls back automatically on failure. To revert a deployed change, restore
the previous `env/<name>.env` and redeploy — the module is declarative, so config is the
only state.

**One exception:** the Quick topic. It cannot be updated or rolled back in place. Reverting
a topic change means bumping `QUICK_OBS_TOPIC_REVISION` again, which creates a replacement.
The old topic is deleted by CloudFormation.

---

## 8. Tear down

```bash
npm run destroy
```

Deletes both stacks. **Read this before running it in an account you care about:**

| Resource | Behaviour | Note |
|---|---|---|
| S3 lake bucket | **Emptied and deleted** | `autoDeleteObjects: true` is a POC setting. For production set `removalPolicy: RETAIN` in `lib/pipeline-stack.ts` first |
| KMS key | Scheduled for deletion, 7-day window | Cancellable within the window |
| Delivery sources / destinations / deliveries | Deleted | Frees the per-log-type source slot for another pipeline |
| CloudWatch log groups | Deleted | |
| Quick dashboard, topic, Space, agent, datasets | Deleted | |
| Quick service role | **Not deleted.** Only the inline policy this module attached is removed | Account-managed; other Quick resources depend on it |
| The existing CloudTrail trail and its bucket | **Never touched** | Read-only throughout. `own-trail` deletes only the trail it created |
| Materialised audit data | Deleted with the lake bucket | Rebuildable with `npm run backfill` |

Confirm afterwards:

```bash
aws logs describe-delivery-sources --query "deliverySources[?starts_with(name,'$PREFIX')]"
aws s3 ls | grep "$PREFIX"
```

---

## 9. Sharing this module with another team

This repository *is* the module: its root is what you copy. Either fork it, or drop the
tree into a subdirectory of your own repo — it has its own `package.json`, `tsconfig.json`
and `cdk.json`, and imports nothing from outside itself.

```bash
git clone https://github.com/abhinandan8911/aws-quick-observability.git
rm -f aws-quick-observability/env/*.env   # keep example.env, drop any real config
```

`env/example.env` is the only environment file that should ever ship. The module source
contains no account id, bucket name, username or profile name. Verify with your own
values rather than the placeholders below, since a grep for a placeholder always passes:

```bash
grep -rn "123456789012\|your-bucket\|your-user" lib bin scripts lambda   # expect no matches
```
