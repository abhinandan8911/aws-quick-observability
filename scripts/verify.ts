#!/usr/bin/env ts-node
/**
 * Post-deploy verification.
 *
 * `cdk deploy` succeeding proves the resources exist. It does not prove that Quick is
 * actually emitting logs, that they are landing, or that Athena can read them — and
 * every one of those can fail silently:
 *
 *   - A delivery can exist while Quick emits nothing (wrong Region, or no activity).
 *   - Logs can land in S3 while Athena returns zero rows, because a Glue column name
 *     does not match the JSON field. That is the camelCase trap in log-schemas.ts, and
 *     it produces NULL columns rather than an error.
 *
 * So this checks the resources, then actually runs Athena queries and reports row
 * counts per table.
 *
 *   npm run verify
 */

import { execFileSync } from 'child_process';
import {
  ACCOUNT_ID,
  AUDIT_SOURCE,
  AUDIT_TABLE,
  AWS_PROFILE, awsProfileArgs,
  LOG_TYPES,
  NAMES,
  NAMESPACE,
  OWNER_ARN,
  OWNER_USERNAME,
  PREFIX,
  REGION,
  logGroupName,
  tableName,
} from '../lib/config';
import { DATASETS, datasetId } from '../lib/datasets';

let failures = 0;
let empty = 0;

function aws<T = any>(args: string[]): T | null {
  try {
    const out = execFileSync('aws', [...args, ...awsProfileArgs(), '--region', REGION, '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.trim() ? (JSON.parse(out) as T) : ({} as T);
  } catch {
    return null;
  }
}
const qs = <T = any>(args: string[]): T | null =>
  aws<T>(['quicksight', ...args, '--aws-account-id', ACCOUNT_ID]);

function check(name: string, ok: boolean, detail: string): boolean {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(34)} ${detail}`);
  return ok;
}

function note(name: string, detail: string): void {
  console.log(`  i ${name.padEnd(34)} ${detail}`);
}

const ownedBy = (perms: { Principal: string }[] | undefined) =>
  Boolean(perms?.some((p) => p.Principal === OWNER_ARN));

console.log(`\nVerifying ${PREFIX} in ${ACCOUNT_ID}/${REGION}\n`);

// --- 1. Delivery configuration --------------------------------------------
const sources = aws<{ deliverySources: { name: string; logType: string }[] }>(['logs', 'describe-delivery-sources']);
const mySources = (sources?.deliverySources ?? []).filter((s) => s.name.startsWith(`${PREFIX}-`));
check(
  'delivery sources',
  mySources.length === LOG_TYPES.length,
  `${mySources.length} of ${LOG_TYPES.length} expected`,
);

const deliveries = aws<{ deliveries: { deliverySourceName: string; deliveryDestinationType: string }[] }>([
  'logs',
  'describe-deliveries',
]);
const myDeliveries = (deliveries?.deliveries ?? []).filter((d) => d.deliverySourceName?.startsWith(`${PREFIX}-`));
const s3Count = myDeliveries.filter((d) => d.deliveryDestinationType === 'S3').length;
const cwlCount = myDeliveries.filter((d) => d.deliveryDestinationType === 'CWL').length;
check('deliveries to S3', s3Count === LOG_TYPES.length, `${s3Count} of ${LOG_TYPES.length}`);
note('deliveries to CloudWatch', `${cwlCount} (optional; QUICK_OBS_CLOUDWATCH)`);

// --- 2. Which log types have actually emitted anything --------------------
// Log streams appear within seconds of the first event, so this is the fastest read on
// whether Quick is really emitting. An empty group is not a failure: a feature that has
// not been used emits nothing, and logs are not retroactive.
console.log('');
let emitted = 0;
for (const t of LOG_TYPES) {
  const streams = aws<{ logStreams: { logStreamName: string; lastEventTimestamp?: number }[] }>([
    'logs',
    'describe-log-streams',
    '--log-group-name',
    logGroupName(t),
    '--order-by',
    'LastEventTime',
    '--descending',
    '--max-items',
    '1',
  ]);
  const stream = streams?.logStreams?.[0];
  if (stream) emitted++;
  const when = stream?.lastEventTimestamp ? new Date(stream.lastEventTimestamp).toISOString() : 'no events yet';
  note(`  ${t.toLowerCase()}`, stream ? `emitting, last event ${when}` : 'no events yet');
}
check('log types emitting', emitted > 0, `${emitted} of ${LOG_TYPES.length} have produced events`);

// --- 3. Glue catalogue ----------------------------------------------------
console.log('');
const tables = aws<{ TableList: { Name: string }[] }>(['glue', 'get-tables', '--database-name', NAMES.glueDatabase]);
const tableNames = (tables?.TableList ?? []).map((t) => t.Name);
const expectedTables =
  AUDIT_SOURCE === 'none' ? LOG_TYPES.map(tableName) : [...LOG_TYPES.map(tableName), AUDIT_TABLE];
const missing = expectedTables.filter((t) => !tableNames.includes(t));
check('glue tables', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${tableNames.length} tables`);

// --- 4. Athena actually returns rows -------------------------------------
// The real test. Counts rows per table so a silently-broken SerDe mapping shows up as
// "0 rows" against a table whose S3 prefix has objects in it.
console.log('');

function athena(sql: string): string[][] | null {
  const start = aws<{ QueryExecutionId: string }>([
    'athena',
    'start-query-execution',
    '--query-string',
    sql,
    '--work-group',
    NAMES.athenaWorkgroup,
  ]);
  if (!start?.QueryExecutionId) return null;
  const id = start.QueryExecutionId;

  for (let i = 0; i < 40; i++) {
    const state = aws<{ QueryExecution: { Status: { State: string; StateChangeReason?: string } } }>([
      'athena',
      'get-query-execution',
      '--query-execution-id',
      id,
    ]);
    const s = state?.QueryExecution?.Status?.State;
    if (s === 'SUCCEEDED') break;
    if (s === 'FAILED' || s === 'CANCELLED') {
      console.log(`      query ${s}: ${state?.QueryExecution?.Status?.StateChangeReason ?? 'unknown'}`);
      return null;
    }
    execFileSync('sleep', ['1']);
  }

  const res = aws<{ ResultSet: { Rows: { Data: { VarCharValue?: string }[] }[] } }>([
    'athena',
    'get-query-results',
    '--query-execution-id',
    id,
  ]);
  return (res?.ResultSet?.Rows ?? []).map((r) => r.Data.map((d) => d.VarCharValue ?? ''));
}

// No audit filter is needed any more. The audit table used to be a view over a shared
// trail containing every service, so counting it unfiltered overstated Quick activity ~5x.
// It is now materialised Quick-only by construction — the scheduled filter writes nothing
// but `quicksight.amazonaws.com` — so a plain COUNT(*) is already the Quick figure.
let queryable = 0;
for (const t of expectedTables) {
  const rows = athena(`SELECT COUNT(*) FROM "${NAMES.glueDatabase}"."${t}"`);
  if (rows === null) {
    check(`  athena ${t}`, false, 'query failed');
    continue;
  }
  const count = Number(rows[1]?.[0] ?? '0');
  queryable++;
  if (count === 0) empty++;
  note(`  athena ${t}`, `${count} row(s)`);
}
check('athena queries', queryable === expectedTables.length, `${queryable} of ${expectedTables.length} tables queryable`);

// --- 5. Quick assets ------------------------------------------------------
console.log('');
const ds = qs<{ DataSource: { Status: string; Type: string } }>([
  'describe-data-source',
  '--data-source-id',
  NAMES.athenaDataSource,
]);
check(
  'athena data source',
  ds?.DataSource?.Status === 'CREATION_SUCCESSFUL' && ds.DataSource.Type === 'ATHENA',
  `${ds?.DataSource?.Status ?? 'MISSING'}`,
);

let goodDatasets = 0;
for (const spec of DATASETS) {
  const id = datasetId(spec);
  const d = qs<{ DataSet: { ImportMode: string; OutputColumns: unknown[] } }>(['describe-data-set', '--data-set-id', id]);
  const perms = qs<{ Permissions: { Principal: string }[] }>(['describe-data-set-permissions', '--data-set-id', id]);
  const ok = Boolean(d?.DataSet) && ownedBy(perms?.Permissions);
  if (ok) goodDatasets++;
  note(`  dataset ${spec.key}`, `${d?.DataSet?.ImportMode ?? 'MISSING'}, ${d?.DataSet?.OutputColumns?.length ?? 0} cols`);
}
check('datasets', goodDatasets === DATASETS.length, `${goodDatasets} of ${DATASETS.length} present and owned`);

const db = qs<{ Dashboard: { Version: { Status: string; Sheets: unknown[]; Errors?: unknown[] } } }>([
  'describe-dashboard',
  '--dashboard-id',
  NAMES.dashboard,
]);
const dbPerms = qs<{ Permissions: { Principal: string }[] }>(['describe-dashboard-permissions', '--dashboard-id', NAMES.dashboard]);
const v = db?.Dashboard?.Version;
check(
  'dashboard',
  v?.Status === 'CREATION_SUCCESSFUL' && v.Sheets?.length === 3 && !v.Errors?.length && ownedBy(dbPerms?.Permissions),
  `${v?.Status ?? 'MISSING'}, ${v?.Sheets?.length ?? 0} sheets, ${v?.Errors?.length ?? 0} errors`,
);

const topic = qs<{ Topic: { DataSets: { Columns?: unknown[] }[] }; CustomInstructions?: { CustomInstructionsString: string } }>([
  'describe-topic',
  '--topic-id',
  NAMES.topic,
]);
const tPerms = qs<{ Permissions: { Principal: string }[] }>(['describe-topic-permissions', '--topic-id', NAMES.topic]);
const cols = topic?.Topic?.DataSets?.reduce((n: number, d) => n + (d.Columns?.length ?? 0), 0) ?? 0;
check(
  'topic',
  (topic?.Topic?.DataSets?.length ?? 0) === DATASETS.length && cols > 40 && ownedBy(tPerms?.Permissions),
  `${topic?.Topic?.DataSets?.length ?? 0} datasets, ${cols} columns, ${
    topic?.CustomInstructions?.CustomInstructionsString?.length ?? 0
  } chars instructions`,
);

const spRes = aws<{ SpaceResources: { ResourceType: string }[] }>([
  'quicksight',
  'list-space-resources',
  '--aws-account-id',
  ACCOUNT_ID,
  '--space-id',
  NAMES.space,
]);
const spPerms = aws<{ Permissions: { Principal: string }[] }>([
  'quicksight',
  'describe-space-permissions',
  '--aws-account-id',
  ACCOUNT_ID,
  '--space-id',
  NAMES.space,
]);
const types = (spRes?.SpaceResources ?? []).map((r) => r.ResourceType);
check(
  'space',
  types.includes('DASHBOARD') && types.includes('TOPIC') && ownedBy(spPerms?.Permissions),
  `${types.length} resources (${[...new Set(types)].sort().join(', ')})`,
);

const agent = qs<{ Agent: { AgentStatus: string; AgentLifecycle?: string; Spaces?: string[]; StarterPrompts?: string[] } }>([
  'describe-agent',
  '--agent-id',
  NAMES.agent,
]);
const aPerms = qs<{ Permissions: { Principal: string }[] }>(['describe-agent-permissions', '--agent-id', NAMES.agent]);
const a = agent?.Agent;
check(
  'chat agent',
  a?.AgentStatus === 'ACTIVE' && (a.Spaces?.length ?? 0) > 0 && ownedBy(aPerms?.Permissions),
  `${a?.AgentStatus ?? 'MISSING'}, ${a?.AgentLifecycle ?? '?'}, ${a?.StarterPrompts?.length ?? 0} prompts`,
);

const user = aws<{ User: { Role: string } }>([
  'quicksight',
  'describe-user',
  '--aws-account-id',
  ACCOUNT_ID,
  '--namespace',
  NAMESPACE,
  '--user-name',
  OWNER_USERNAME,
]);
check(
  'owner role is Pro',
  ['ADMIN_PRO', 'AUTHOR_PRO', 'READER_PRO'].includes(user?.User?.Role ?? ''),
  user?.User?.Role ?? 'MISSING',
);

// --- Summary --------------------------------------------------------------
console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.\n`);
} else {
  console.log('All structural checks passed.\n');
}

if (empty) {
  console.log(
    `${empty} table(s) returned 0 rows. That is expected on a fresh deploy:\n` +
      `  vended logs are NOT retroactive, so only activity after deployment is captured,\n` +
      `  and a Quick feature nobody has used emits nothing at all.\n\n` +
      `  Generate some activity, wait ~5 minutes for the S3 buffer to flush, then re-run.\n` +
      `  A quick way to produce chat and feedback logs is the sibling agent-test module:\n` +
      `    cd ../ && npm run agent-test -- --limit 20\n\n` +
      `  If a table stays at 0 rows while its S3 prefix has objects, the SerDe column\n` +
      `  mapping is wrong rather than the data being absent — see lib/log-schemas.ts.\n`,
  );
}

process.exit(failures ? 1 : 0);
