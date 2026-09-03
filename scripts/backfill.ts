#!/usr/bin/env ts-node
/**
 * Backfill the Quick-only audit table from CloudTrail history.
 *
 * The hourly schedule only looks back a few hours, so on a fresh deploy the audit table
 * holds nothing older than that — even though the trail itself has months of history.
 * This runs the same filter over a wider window, once.
 *
 *   npm run backfill                # last 30 days
 *   npm run backfill -- --days 90
 *   npm run backfill -- --dry-run   # print the SQL, run nothing
 *
 * Safe to re-run. The filter writes duplicates when windows overlap, and the audit
 * dataset removes them by `event_id`, so there is no state to corrupt and no need to
 * track what has already been copied.
 */

import { execFileSync } from 'child_process';
import {
  ACCOUNT_ID,
  AUDIT_SOURCE,
  AUDIT_TABLE,
  AWS_PROFILE, awsProfileArgs,
  NAMES,
  QUICK_EVENT_SOURCE,
  RAW_TRAIL_TABLE,
  REGION,
} from '../lib/config';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const daysIdx = args.indexOf('--days');
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : 30;

if (!Number.isFinite(days) || days <= 0) {
  console.error('--days must be a positive number');
  process.exit(1);
}

if (AUDIT_SOURCE !== 'existing-trail' && AUDIT_SOURCE !== 'own-trail') {
  console.error(
    `Nothing to backfill: QUICK_OBS_AUDIT_SOURCE is "${AUDIT_SOURCE}".\n` +
      'Backfill only applies to the CloudTrail sources, because EventBridge cannot replay\n' +
      'past events onto the bus and "none" has no audit table.',
  );
  process.exit(1);
}

/**
 * Same shaping as the scheduled filter, over a wider window.
 *
 * The two partition predicates are what keep this affordable: a trail holds every
 * management event in the account, so without pruning by date this would scan the entire
 * bucket. The `eventsource` filter is what makes the module Quick-only.
 */
const sql = `
INSERT INTO "${NAMES.glueDatabase}"."${AUDIT_TABLE}"
SELECT
  eventid                                                            AS event_id,
  from_iso8601_timestamp(eventtime)                                  AS event_time,
  eventname                                                          AS event_name,
  eventsource                                                        AS event_source,
  COALESCE(
    NULLIF(useridentity.sessioncontext.sessionissuer.username, ''),
    NULLIF(useridentity.username, ''),
    NULLIF(useridentity.type, ''),
    'unknown'
  )                                                                  AS actor,
  COALESCE(NULLIF(useridentity.type, ''), 'unknown')                 AS actor_type,
  COALESCE(NULLIF(sourceipaddress, ''), 'unknown')                   AS source_ip,
  COALESCE(NULLIF(useragent, ''), 'unknown')                         AS user_agent,
  COALESCE(NULLIF(errorcode, ''), 'None')                            AS error_code,
  COALESCE(NULLIF(errormessage, ''), 'None')                         AS error_message,
  CASE WHEN lower(CAST(readonly AS varchar)) = 'true' THEN 'Yes' ELSE 'No' END AS is_read_only,
  CASE
    WHEN eventname LIKE 'Create%' THEN 'Create'
    WHEN eventname LIKE 'Update%' THEN 'Update'
    WHEN eventname LIKE 'Delete%' THEN 'Delete'
    WHEN eventname LIKE 'Describe%' OR eventname LIKE 'List%'
      OR eventname LIKE 'Search%'   OR eventname LIKE 'Get%'  THEN 'Read'
    ELSE 'Other'
  END                                                                AS operation_kind,
  awsregion                                                          AS aws_region
FROM "${NAMES.rawGlueDatabase}"."${RAW_TRAIL_TABLE}"
WHERE eventsource = '${QUICK_EVENT_SOURCE}'
  AND region = '${REGION}'
  AND CAST(year AS integer) * 10000 + CAST(month AS integer) * 100 + CAST(day AS integer)
      >= CAST(date_format(current_date - interval '${days}' day, '%Y%m%d') AS integer)
`.trim();

console.log(
  `\nBackfilling ${AUDIT_TABLE} from ${RAW_TRAIL_TABLE}, last ${days} day(s)\n` +
    `  source filter : eventsource = ${QUICK_EVENT_SOURCE}\n` +
    `  target        : ${NAMES.glueDatabase}.${AUDIT_TABLE}\n` +
    `  workgroup     : ${NAMES.athenaWorkgroup}\n` +
    `  account       : ${ACCOUNT_ID}/${REGION}\n`,
);

if (dryRun) {
  console.log(sql);
  console.log('\n--dry-run: nothing executed.\n');
  process.exit(0);
}

function aws<T = any>(a: string[]): T | null {
  try {
    const out = execFileSync('aws', [...a, ...awsProfileArgs(), '--region', REGION, '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    return out.trim() ? (JSON.parse(out) as T) : ({} as T);
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer }).stderr ?? '');
    if (stderr) console.error(stderr.trim().split('\n').slice(-2).join('\n'));
    return null;
  }
}

const start = aws<{ QueryExecutionId: string }>([
  'athena',
  'start-query-execution',
  '--query-string',
  sql,
  '--work-group',
  NAMES.athenaWorkgroup,
  '--query-execution-context',
  `Database=${NAMES.glueDatabase}`,
]);

if (!start?.QueryExecutionId) {
  console.error('Failed to start the backfill query.');
  process.exit(1);
}
console.log(`  query ${start.QueryExecutionId} running...`);

for (let i = 0; i < 180; i++) {
  const st = aws<{
    QueryExecution: {
      Status: { State: string; StateChangeReason?: string };
      Statistics?: { DataScannedInBytes?: number };
    };
  }>(['athena', 'get-query-execution', '--query-execution-id', start.QueryExecutionId]);
  const state = st?.QueryExecution?.Status?.State;

  if (state === 'SUCCEEDED') {
    const scanned = st?.QueryExecution?.Statistics?.DataScannedInBytes ?? 0;
    console.log(`  SUCCEEDED, scanned ${(scanned / 1024 / 1024).toFixed(1)} MB\n`);
    console.log('  Confirm with:  npm run query -- health\n');
    process.exit(0);
  }
  if (state === 'FAILED' || state === 'CANCELLED') {
    console.error(`  ${state}: ${st?.QueryExecution?.Status?.StateChangeReason ?? 'unknown'}\n`);
    process.exit(1);
  }
  execFileSync('sleep', ['2']);
}

console.error('  Timed out waiting for the backfill query. Check the Athena console.\n');
process.exit(1);
