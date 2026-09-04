/**
 * Single source of truth for the quick-observability module.
 *
 * PORTABILITY IS THE POINT OF THIS FILE. Nothing account-specific may live anywhere else
 * in the module — and, since this module is meant to be shared, nothing account-specific
 * may live *here* either.
 *
 * There are two kinds of setting below and the difference matters:
 *
 *   - **Optional**, via `env(name, fallback)`. A genuine default that is correct anywhere:
 *     a resource prefix, a retention period, a schedule.
 *   - **Required**, via `required(name, hint)`. An input only the operator can know: which
 *     account, which Quick user, which CloudTrail bucket. These deliberately have **no**
 *     default. An earlier version defaulted them to one specific account's values, which meant a
 *     deploy elsewhere that forgot one aimed at a foreign account id, or granted every
 *     Quick asset to a user that does not exist in the target account. A required input
 *     must stop the deploy with an instruction, not silently substitute someone else's.
 *
 * Values are supplied by the process environment, optionally seeded from an env file:
 *
 *   QUICK_OBS_ENV=prod npm run deploy         # loads env/prod.env
 *
 * See `env/example.env` for every variable, its default, and whether it is required.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Seed `process.env` from `env/<QUICK_OBS_ENV>.env`, or `env/.env` if present.
 *
 * Hand-rolled rather than pulling in `dotenv`, to keep the module's dependency list at
 * the four packages it already needs. Real environment variables always win, so a
 * one-off override on the command line beats the file.
 */
function loadEnvFile(): string | undefined {
  const name = process.env.QUICK_OBS_ENV?.trim();
  const candidates = name
    ? [path.resolve(__dirname, '..', 'env', `${name}.env`)]
    : [path.resolve(__dirname, '..', 'env', '.env')];

  for (const file of candidates) {
    if (!fs.existsSync(file)) {
      // An explicitly named environment that does not exist is a mistake worth reporting,
      // whereas the implicit `.env` simply being absent is normal.
      if (name) throw new Error(`QUICK_OBS_ENV=${name} but ${file} does not exist.`);
      continue;
    }
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      // Strip one layer of surrounding quotes, so values with spaces are writable.
      const value = trimmed.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      if (!(key in process.env) || !process.env[key]?.trim()) process.env[key] = value;
    }
    return file;
  }
  return undefined;
}

/** Which env file, if any, seeded this configuration. Reported by preflight. */
export const ENV_FILE = loadEnvFile();

/** Resolve an env var, falling back to a default. Empty string counts as unset. */
function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

/**
 * Resolve a required env var, or throw with instructions.
 *
 * Thrown at module load, which means at synth time — before CloudFormation is given
 * anything to do. That is the whole point: a half-configured deploy is worse than one
 * that never starts.
 */
function required(name: string, hint: string): string {
  const v = process.env[name];
  if (v && v.trim()) return v.trim();
  throw new Error(
    `${name} is required and not set.\n  ${hint}\n\n` +
      'Set it in the environment, or put it in an env file and select that file:\n' +
      `  ${name}=... npm run deploy\n` +
      '  QUICK_OBS_ENV=myaccount npm run deploy      # reads env/myaccount.env\n\n' +
      'See env/example.env for every supported variable.',
  );
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (!v || !v.trim()) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v || !v.trim()) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${v}"`);
  return n;
}

// ---------------------------------------------------------------------------
// Target account
// ---------------------------------------------------------------------------

/**
 * Target account.
 *
 * `CDK_DEFAULT_ACCOUNT` is populated by the CDK CLI from the resolved credentials, so under
 * `cdk deploy` this normally needs no setting at all. It is absent when a script runs
 * outside the CDK CLI (preflight, verify) and in credential-less CI, which is what
 * `QUICK_OBS_ACCOUNT_ID` is for.
 *
 * There is deliberately **no literal fallback**. An earlier version fell back to a hard-coded
 * account id, so a deploy elsewhere with no credentials resolved silently produced a
 * template aimed at a foreign account number.
 */
export const ACCOUNT_ID = env('QUICK_OBS_ACCOUNT_ID', '') ||
  env('CDK_DEFAULT_ACCOUNT', '') ||
  required('QUICK_OBS_ACCOUNT_ID', 'The 12-digit AWS account id hosting the Quick account.');

/**
 * Region.
 *
 * Deliberately does NOT consult `CDK_DEFAULT_REGION`, even though that would look like
 * the natural default.
 *
 * `CDK_DEFAULT_REGION` is set only when the CDK CLI runs, and it comes from the AWS
 * profile. `npm run preflight` does not run under the CDK CLI, so it would resolve a
 * different region from `cdk deploy` whenever the profile's region differs from this
 * default — which is exactly what happened here: preflight validated us-east-1 while
 * deploy targeted the profile's us-west-2 and failed on a missing bootstrap.
 *
 * `AWS_REGION` is excluded for the same reason. A globally exported `AWS_REGION` that
 * differs from the active profile's Region silently retargets the deploy away from the
 * Region the Quick account actually lives in.
 *
 * So: one explicit knob, `QUICK_OBS_REGION`, and a fixed default. No ambient
 * environment can move the target, and preflight and deploy always agree. Quick is
 * regional and vended log delivery is per Region, so this must match the Quick account.
 */
export const REGION = env('QUICK_OBS_REGION', 'us-east-1');

/**
 * CLI profile, or empty to use the AWS SDK's own default credential resolution.
 *
 * Empty is the correct default for a shared module: naming a profile that does not exist
 * on the operator's machine fails worse than not passing `--profile` at all. Scripts use
 * `awsProfileArgs()` so the flag is omitted entirely when this is empty.
 */
export const AWS_PROFILE = env('AWS_PROFILE', '');

/** `['--profile', name]`, or `[]` when no profile is configured. */
export function awsProfileArgs(): string[] {
  return AWS_PROFILE ? ['--profile', AWS_PROFILE] : [];
}

export const PREFIX = env('QUICK_OBS_PREFIX', 'quick-obs');
export const NAMESPACE = env('QUICK_OBS_NAMESPACE', 'default');

/**
 * The Quick user that owns every Quick asset this module creates.
 *
 * Required: this must be a user that already exists in the target Quick account, in the
 * form the API reports it (`aws quicksight list-users`), which for federated identities
 * includes the role name — `Admin/alice`, `AuthorPro/alice@example.com`. Guessing
 * it wrong fails mid-deploy on the first Quick asset, so it is validated by preflight.
 */
export const OWNER_USERNAME = required(
  'QUICK_OBS_OWNER',
  'Quick username to own the dashboard, topic, Space and agent. ' +
    'Find it with: aws quicksight list-users --aws-account-id <id> --namespace default',
);
export const OWNER_ARN = `arn:aws:quicksight:${REGION}:${ACCOUNT_ID}:user/${NAMESPACE}/${OWNER_USERNAME}`;

/**
 * The account-wide Quick service role. Quick assumes this to reach Athena, Glue and
 * S3 on the user's behalf, so it is the role that needs read access to the lake.
 *
 * Account-managed and pre-existing: this module attaches a scoped inline policy to it
 * rather than creating it, and teardown removes only that policy.
 */
export const QUICK_SERVICE_ROLE_NAME = env('QUICK_OBS_SERVICE_ROLE', 'aws-quicksight-service-role-v0');
export const QUICK_SERVICE_ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/service-role/${QUICK_SERVICE_ROLE_NAME}`;

/**
 * The delivery source resourceArn for Quick vended logs.
 *
 * Note the shape: the Quick *account* resource, not a user or a specific asset.
 * Verified against the live API — `PutDeliverySource` returns `service: quicksight`
 * for this ARN.
 */
export const QUICK_ACCOUNT_ARN = `arn:aws:quicksight:${REGION}:${ACCOUNT_ID}:account/${ACCOUNT_ID}`;

// ---------------------------------------------------------------------------
// Log types
// ---------------------------------------------------------------------------

/**
 * The 7 vended log types Amazon Quick supports, as of the 2026-09-02 documentation.
 * All 7 were verified accepted by `PutDeliverySource` on a real Enterprise-edition account.
 */
export const ALL_LOG_TYPES = [
  'CHAT_LOGS',
  'FEEDBACK_LOGS',
  'AGENT_HOURS_LOGS',
  'AGENT_METADATA_LOGS',
  'INDEX_USAGE_LOGS',
  'KB_FILE_SYNC_LOGS',
  'DLP_LOGS',
] as const;

export type LogType = (typeof ALL_LOG_TYPES)[number];

/**
 * Which log types to deliver. Narrow this when an account does not use a feature —
 * DLP_LOGS on an account with no DLP provider will simply never emit, which is
 * harmless but adds an idle table.
 */
export const LOG_TYPES: LogType[] = (() => {
  const raw = env('QUICK_OBS_LOG_TYPES', 'all');
  if (raw.toLowerCase() === 'all') return [...ALL_LOG_TYPES];
  const wanted = raw.split(',').map((s) => s.trim().toUpperCase());
  const bad = wanted.filter((w) => !(ALL_LOG_TYPES as readonly string[]).includes(w));
  if (bad.length) {
    throw new Error(
      `QUICK_OBS_LOG_TYPES contains unknown log type(s): ${bad.join(', ')}.\n` +
        `Valid values: ${ALL_LOG_TYPES.join(', ')} (or 'all').`,
    );
  }
  return wanted as LogType[];
})();

/**
 * Whether to deliver the chat message bodies.
 *
 * Off by default. `user_message` and `system_text_message` are user-authored content
 * and can contain anything a person typed into chat. ARCC's logging guidance is
 * explicit that personal data must not be logged in plain text, and the Quick docs
 * carry the same warning. Turning this on is a deliberate, auditable decision:
 *
 *   QUICK_OBS_LOG_SENSITIVE=true npm run deploy
 *
 * With it off, the module still captures who asked, when, against what scope, and
 * whether the answer succeeded — enough for every operational metric in the
 * dashboard. It just cannot show the question text.
 */
export const INCLUDE_SENSITIVE_FIELDS = envBool('QUICK_OBS_LOG_SENSITIVE', false);

/** CloudWatch Logs retention. S3 is the long-term store, so this is the hot window. */
export const LOG_RETENTION_DAYS = envInt('QUICK_OBS_RETENTION_DAYS', 90);

// ---------------------------------------------------------------------------
// Quick API audit source
// ---------------------------------------------------------------------------

/**
 * Where Quick API activity comes from.
 *
 * `existing-trail` is the default because of a measurement, not a preference. Most
 * accounts already have a CloudTrail trail, and in a single 10-minute window this
 * account's trail held **57 Quick API events: 55 reads and 2 writes**.
 *
 * That matters because **EventBridge does not receive read-only CloudTrail events**. The
 * `eventbridge` option would therefore have captured 2 of those 57 — about 3.5% — and
 * every `DescribeDashboard`, `DescribeDataSet` and `ListSpaceResources` (the "who looked
 * at what" signal) would have been invisible.
 *
 * Reading the existing trail is also the cheapest and simplest option: no Firehose
 * stream, no EventBridge rule, no target role, and no KMS grant on the producer — which
 * is the exact set of moving parts that failed silently while building this.
 *
 *   existing-trail  Glue table over a trail bucket you already have. No new infra, no
 *                   extra cost, reads and writes. Needs QUICK_OBS_TRAIL_BUCKET.
 *   own-trail       This module creates its own trail into its own lake. Portable to an
 *                   account with no usable trail; costs a second copy of management
 *                   events (~$2 per 100k).
 *   eventbridge     EventBridge rule -> Firehose -> lake. Writes only. Kept for anyone
 *                   who wants no dependency on a trail at all.
 *   none            No API audit table. The vended AGENT_METADATA_LOGS and DLP_LOGS
 *                   still cover agent and DLP changes, but nothing else.
 */
export const AUDIT_SOURCES = ['existing-trail', 'own-trail', 'eventbridge', 'none'] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export const AUDIT_SOURCE: AuditSource = (() => {
  const raw = env('QUICK_OBS_AUDIT_SOURCE', 'existing-trail').toLowerCase();
  if (!(AUDIT_SOURCES as readonly string[]).includes(raw)) {
    throw new Error(
      `QUICK_OBS_AUDIT_SOURCE must be one of ${AUDIT_SOURCES.join(', ')} — got "${raw}".`,
    );
  }
  return raw as AuditSource;
})();

/**
 * The bucket an existing CloudTrail trail writes to.
 *
 * Required **only** for `existing-trail`, which is why this is resolved lazily rather than
 * with a plain `required()` — the other three audit sources must not be forced to supply a
 * trail bucket they never read. An earlier version defaulted it to one specific account's trail
 * bucket, so another account's deploy would build a Glue table over a bucket it has no
 * access to and report an empty audit table with no explanation.
 *
 * Find it with:
 *   aws cloudtrail describe-trails --query 'trailList[].{N:Name,B:S3BucketName,P:S3KeyPrefix}'
 */
export const TRAIL_BUCKET =
  AUDIT_SOURCE === 'existing-trail'
    ? required(
        'QUICK_OBS_TRAIL_BUCKET',
        "S3 bucket of an existing CloudTrail trail (audit source 'existing-trail'). " +
          "Find it with: aws cloudtrail describe-trails --query 'trailList[].S3BucketName'. " +
          "Or set QUICK_OBS_AUDIT_SOURCE=own-trail to have this module create its own trail.",
      )
    : env('QUICK_OBS_TRAIL_BUCKET', '');

/** Optional key prefix configured on that trail. Empty for most trails. */
export const TRAIL_PREFIX = env('QUICK_OBS_TRAIL_PREFIX', '');

/**
 * The account whose CloudTrail logs to read. Usually the same account, but an
 * organisation trail collects many accounts into one bucket, so this is separable.
 */
export const TRAIL_ACCOUNT_ID = env('QUICK_OBS_TRAIL_ACCOUNT_ID', ACCOUNT_ID);

/**
 * S3 location of the CloudTrail logs, in the layout CloudTrail always uses:
 *   [prefix/]AWSLogs/<account>/CloudTrail/<region>/<yyyy>/<mm>/<dd>/
 *
 * Unlike the vended-log layout, this one is documented and stable, which is what makes
 * partition projection safe to use here and unsafe to guess at for the vended tables.
 */
export function trailLocation(bucket: string): string {
  const prefix = TRAIL_PREFIX ? `${TRAIL_PREFIX.replace(/^\/+|\/+$/g, '')}/` : '';
  return `s3://${bucket}/${prefix}AWSLogs/${TRAIL_ACCOUNT_ID}/CloudTrail`;
}

// ---------------------------------------------------------------------------
// Derived names
// ---------------------------------------------------------------------------

/** Lower-case, hyphen-free form for resources that reject hyphens (Glue, Athena). */
const SNAKE = PREFIX.replace(/[^a-z0-9]+/gi, '_').toLowerCase();

/**
 * Topic revision.
 *
 * `AWS::QuickSight::Topic` **cannot be updated** by CloudFormation. Changing a topic's
 * columns makes the resource handler fail with a bare
 * `Resource handler returned message: "null"` — reproduced twice, deterministically —
 * even though the underlying `UpdateTopic` API call succeeds with no error in CloudTrail.
 * The failure is in the CloudFormation handler, not the service.
 *
 * So the topic id carries a revision. **Bump this whenever the topic's datasets or columns
 * change**: the physical id changes, CloudFormation replaces the topic instead of updating
 * it, and the Space picks up the new ARN automatically because it is built as a literal.
 *
 * Revision history:
 *   1 - initial, 5 datasets / 65 columns.
 *   2 - added `event_id` to the audit dataset for de-duplication (66 columns).
 */
export const TOPIC_REVISION = envInt('QUICK_OBS_TOPIC_REVISION', 2);

/**
 * Separate Glue database holding the raw CloudTrail table.
 *
 * A CloudTrail file interleaves events from every service, and a trail's management
 * events **cannot** be narrowed to one service — the docs are explicit that `eventSource`
 * on management events for trails is exclusion-only, and only for `kms.amazonaws.com` and
 * `rdsdata.amazonaws.com`. So a table over a raw trail necessarily exposes the whole
 * account: measured here, `quick_obs_db` was surfacing 3,971 STS, 3,392 IAM, 2,490 S3 and
 * 1,181 KMS events alongside 5,924 Quick ones.
 *
 * Keeping the raw table in its own database is what makes the module Quick-only:
 *   - `<prefix>_db`      Quick data only. This is what Quick, the dashboard and the agent see.
 *   - `<prefix>_raw_db`  The raw trail. Used solely by the scheduled filter query, and the
 *                        Quick service role is granted nothing on it.
 */
export const NAMES = {
  /** S3 data lake. Account-suffixed because bucket names are global. */
  lakeBucket: `${PREFIX}-datalake-${ACCOUNT_ID}`,
  /** Athena spills query results here; separate prefix, same bucket. */
  athenaResultsPrefix: 'athena-results',
  kmsAlias: `alias/${PREFIX}-logs`,

  glueDatabase: `${SNAKE}_db`,
  // Revision-suffixed: see TOPIC_REVISION. CloudFormation cannot update a Quick topic,
  // so changing its columns requires replacing the resource.
  /** Raw CloudTrail, deliberately outside the Quick-visible database. */
  rawGlueDatabase: `${SNAKE}_raw_db`,
  athenaWorkgroup: `${PREFIX}-wg`,
  /** Hourly schedule that filters Quick events out of the raw trail. */
  materialiseSchedule: `${PREFIX}-materialise-quick-audit`,

  /** CloudTrail-sourced Quick API events. */
  auditFirehose: `${PREFIX}-audit-stream`,
  auditEventRule: `${PREFIX}-quick-api-events`,

  // Quick assets.
  athenaDataSource: `${PREFIX}-athena-source`,
  /** "Quick Pulse: Admin Observability" — adoption, answer quality and the API change log. */
  pulseDashboard: `${PREFIX}-pulse`,
  /** "Quick Observability Dashboard" — agent-hour cost, index storage and KB sync. */
  opsDashboard: `${PREFIX}-observability`,
  topic: `${PREFIX}-topic-v${TOPIC_REVISION}`,
  space: `${PREFIX}-space`,
  agent: `${PREFIX}-agent`,
} as const;

/** CloudWatch log group for a given log type. */
export function logGroupName(t: LogType): string {
  return `/aws/vendedlogs/${PREFIX}/${t.toLowerCase().replace(/_logs$/, '').replace(/_/g, '-')}`;
}

/** S3 prefix for a given log type inside the lake. */
export function s3Prefix(t: LogType): string {
  return `${t.toLowerCase()}`;
}

/** Glue table name for a given log type. Glue rejects hyphens in table names. */
export function tableName(t: LogType): string {
  return t.toLowerCase();
}

/** The Quick-only audit table, in the Quick-visible database. */
export const AUDIT_TABLE = 'quick_api_events';
export const AUDIT_S3_PREFIX = 'quick_api_events';

/** The raw CloudTrail table, in the separate raw database. Never exposed to Quick. */
export const RAW_TRAIL_TABLE = 'cloudtrail_raw';

/**
 * S3 prefix for the materialised, Quick-only audit data. **Format-specific on purpose.**
 *
 * The materialised table is Parquet; the EventBridge path writes GZIP JSON. Both once
 * shared the `quick_api_events/` prefix, and switching audit source left stale `.gz`
 * objects under a table now declared as Parquet. Athena then failed the whole table with
 * `HIVE_BAD_DATA: Malformed Parquet file. Expected magic number: PAR1 got: <gzip>` — which
 * in turn made the Quick topic fail to create, because its dataset could not be read.
 *
 * Encoding the format in the prefix makes that collision impossible: changing format
 * changes location, so old data falls outside the new table rather than corrupting it.
 */
export const AUDIT_MATERIALISED_PREFIX = 'quick_api_events_parquet';

/**
 * The one event source this module is allowed to keep.
 *
 * Quick still reports itself as `quicksight.amazonaws.com` in CloudTrail regardless of the
 * Quick Suite rebrand.
 */
export const QUICK_EVENT_SOURCE = 'quicksight.amazonaws.com';

/** Cron or rate for the filter run. Hourly by default. */
export const MATERIALISE_SCHEDULE = env('QUICK_OBS_MATERIALISE_SCHEDULE', 'rate(1 hour)');

/**
 * How far back each scheduled filter run looks.
 *
 * Must be longer than the schedule interval, so a missed or delayed run self-heals rather
 * than leaving a permanent gap. The overlap produces duplicate rows, which is why the
 * audit dataset de-duplicates on `event_id` — CloudTrail's per-event unique id — rather
 * than relying on the window being exact.
 *
 * The budget, for an hourly schedule:
 *
 *   lookback >= (gap between successful runs) + (CloudTrail delivery lag)
 *
 * Measured on this account under load: end-to-end event-to-Athena lag was **3 minutes**,
 * with a p95 of about 4 minutes across 400 consecutive trail objects. AWS documents
 * "an average of about 5 minutes" and explicitly does **not** guarantee it, so the lag
 * term is budgeted at a full hour rather than the observed few minutes.
 *
 * At 3 hours that leaves 2 hours of missed-run tolerance — two consecutive failed runs,
 * or a two-hour Scheduler/Athena outage — and costs 3x write amplification instead of the
 * 6x this used to carry. Getting this **too low** silently and permanently drops events,
 * which is far worse than storing duplicates, hence the deliberate asymmetry: the margin
 * is generous and only the wasteful half was trimmed.
 */
export const MATERIALISE_LOOKBACK_HOURS = envInt('QUICK_OBS_MATERIALISE_LOOKBACK_HOURS', 3);

/**
 * Refuse to deploy a lookback that cannot cover its own schedule.
 *
 * Nothing else catches this: too short a window loses events with no error anywhere, and
 * the loss is unrecoverable because a later run never revisits an earlier window. Only
 * `rate(N unit)` can be checked — a cron expression's true interval is not worth parsing,
 * so those are left to the operator.
 */
const rate = /^rate\(\s*(\d+)\s+(minute|minutes|hour|hours|day|days)\s*\)$/.exec(MATERIALISE_SCHEDULE);
if (rate) {
  const n = Number(rate[1]);
  const hours = rate[2].startsWith('minute') ? n / 60 : rate[2].startsWith('hour') ? n : n * 24;
  // One whole interval of slack for delivery lag and clock skew.
  const minimum = hours * 2;
  if (MATERIALISE_LOOKBACK_HOURS < minimum) {
    throw new Error(
      `QUICK_OBS_MATERIALISE_LOOKBACK_HOURS is ${MATERIALISE_LOOKBACK_HOURS}h but the schedule ` +
        `"${MATERIALISE_SCHEDULE}" runs every ${hours}h, so it needs at least ${minimum}h.\n` +
        'A lookback that does not cover its own interval plus delivery lag drops events ' +
        'silently and permanently - a later run never revisits an earlier window.',
    );
  }
}

/** True when the audit path needs the raw-trail table and the scheduled filter. */
export const AUDIT_NEEDS_MATERIALISE =
  AUDIT_SOURCE === 'existing-trail' || AUDIT_SOURCE === 'own-trail';

/**
 * Quick resource ARNs are fully determined by their id, so build them as literals.
 * Established by measurement: `Fn::GetAtt` on a Topic's `Arn` fails inside the Space
 * resource handler with a 403.
 */
export function quickArn(
  resourceType: 'dataset' | 'datasource' | 'dashboard' | 'analysis' | 'topic' | 'space' | 'agent',
  resourceId: string,
): string {
  return `arn:aws:quicksight:${REGION}:${ACCOUNT_ID}:${resourceType}/${resourceId}`;
}

// ---------------------------------------------------------------------------
// Permission sets
// ---------------------------------------------------------------------------
// Quick rejects any permission set that is not exactly one of its named roles, and the
// valid sets are not published. The provisioner Lambda parses rejection messages to
// recover the accepted set rather than relying on these lists being right.

export const DATASOURCE_OWNER_ACTIONS = [
  'quicksight:DescribeDataSource',
  'quicksight:DescribeDataSourcePermissions',
  'quicksight:PassDataSource',
  'quicksight:UpdateDataSource',
  'quicksight:DeleteDataSource',
  'quicksight:UpdateDataSourcePermissions',
];

/** `CancelIngestion` is mandatory — the API rejects the set without it. */
export const DATASET_OWNER_ACTIONS = [
  'quicksight:DescribeDataSet',
  'quicksight:DescribeDataSetPermissions',
  'quicksight:PassDataSet',
  'quicksight:DescribeIngestion',
  'quicksight:ListIngestions',
  'quicksight:UpdateDataSet',
  'quicksight:DeleteDataSet',
  'quicksight:CreateIngestion',
  'quicksight:CancelIngestion',
  'quicksight:UpdateDataSetPermissions',
];

export const DASHBOARD_OWNER_ACTIONS = [
  'quicksight:DescribeDashboard',
  'quicksight:ListDashboardVersions',
  'quicksight:UpdateDashboardPermissions',
  'quicksight:QueryDashboard',
  'quicksight:UpdateDashboard',
  'quicksight:DeleteDashboard',
  'quicksight:DescribeDashboardPermissions',
  'quicksight:UpdateDashboardPublishedVersion',
];

export const ANALYSIS_OWNER_ACTIONS = [
  'quicksight:RestoreAnalysis',
  'quicksight:UpdateAnalysisPermissions',
  'quicksight:DeleteAnalysis',
  'quicksight:QueryAnalysis',
  'quicksight:DescribeAnalysisPermissions',
  'quicksight:DescribeAnalysis',
  'quicksight:UpdateAnalysis',
];

export const TOPIC_OWNER_ACTIONS = [
  'quicksight:DescribeTopic',
  'quicksight:DescribeTopicPermissions',
  'quicksight:DescribeTopicRefresh',
  'quicksight:ListTopicRefreshSchedules',
  'quicksight:DescribeTopicRefreshSchedule',
  'quicksight:CreateTopicRefreshSchedule',
  'quicksight:UpdateTopicRefreshSchedule',
  'quicksight:DeleteTopicRefreshSchedule',
  'quicksight:UpdateTopic',
  'quicksight:DeleteTopic',
  'quicksight:UpdateTopicPermissions',
];

/** Same five-action shape as Spaces. `quicksight:InvokeAgent` is NOT valid. */
export const SPACE_OWNER_ACTIONS = [
  'quicksight:DescribeSpace',
  'quicksight:UpdateSpace',
  'quicksight:DeleteSpace',
  'quicksight:DescribeSpacePermissions',
  'quicksight:UpdateSpacePermissions',
];

export const AGENT_OWNER_ACTIONS = [
  'quicksight:DescribeAgent',
  'quicksight:UpdateAgent',
  'quicksight:DeleteAgent',
  'quicksight:DescribeAgentPermissions',
  'quicksight:UpdateAgentPermissions',
];

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export const TAGS: Record<string, string> = {
  module: 'quick-observability',
  purpose: 'amazon-quick-usage-observability',
  owner: OWNER_USERNAME,
  'data-classification': 'operational-logs',
};

// ---------------------------------------------------------------------------
// Synth-time guards
// ---------------------------------------------------------------------------

if (!/^\d{12}$/.test(ACCOUNT_ID)) {
  throw new Error(
    `Resolved account id "${ACCOUNT_ID}" is not 12 digits.\n` +
      `Set QUICK_OBS_ACCOUNT_ID, or run through the CDK CLI so CDK_DEFAULT_ACCOUNT is populated.`,
  );
}
if (!LOG_TYPES.length) throw new Error('QUICK_OBS_LOG_TYPES resolved to an empty list.');

if (AUDIT_SOURCE === 'existing-trail' && !TRAIL_BUCKET) {
  throw new Error(
    'QUICK_OBS_AUDIT_SOURCE=existing-trail needs QUICK_OBS_TRAIL_BUCKET.\n' +
      "Find it with:  aws cloudtrail describe-trails --query 'trailList[].S3BucketName'\n" +
      'Or switch to QUICK_OBS_AUDIT_SOURCE=own-trail to have this module create its own.',
  );
}
if (!/^[a-z][a-z0-9-]{1,30}$/.test(PREFIX)) {
  throw new Error(
    `QUICK_OBS_PREFIX "${PREFIX}" must be lower-case alphanumeric with hyphens, ` +
      `starting with a letter, 2-31 chars (it becomes part of an S3 bucket name).`,
  );
}
