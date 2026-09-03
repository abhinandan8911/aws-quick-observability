#!/usr/bin/env ts-node
/**
 * Run a named Athena query against the observability lake, or ad-hoc SQL.
 *
 *   npm run query                          # list the named queries
 *   npm run query -- health                # run one
 *   npm run query -- --sql "SELECT ..."    # ad-hoc
 *
 * A named query per operational question, expressed as SQL so it is available from a
 * terminal without opening Quick. That matters most when the dashboard itself is what you
 * are debugging: it separates "the data is wrong" from "the visual is wrong".
 */

import { execFileSync } from 'child_process';
import { ACCOUNT_ID, AUDIT_SOURCE, AUDIT_TABLE, AWS_PROFILE, awsProfileArgs, NAMES, REGION, tableName } from '../lib/config';

const DB = NAMES.glueDatabase;

/**
 * Column expressions for the audit table, which has two different shapes.
 *
 * Reading CloudTrail directly gives flat columns; the EventBridge path nests the whole
 * record under `detail`. Rather than duplicate every query, the differing expressions live
 * here once and the named queries interpolate them. Getting this wrong is not subtle — it
 * fails with `COLUMN_NOT_FOUND`, which is exactly how the mismatch was caught after
 * switching the default audit source.
 */
const A = AUDIT_SOURCE === 'eventbridge'
  ? {
      eventName: 'detail.eventname',
      errorCode: 'detail.errorcode',
      errorMessage: 'detail.errormessage',
      actor:
        "COALESCE(NULLIF(detail.useridentity.sessioncontext.sessionissuer.username, ''), " +
        "NULLIF(detail.useridentity.username, ''), 'unknown')",
      // The rule already filters to aws.quicksight, so nothing more is needed.
      where: '1 = 1',
      // EventBridge never delivers read-only events, so this can only ever be empty.
      readOnly: '1 = 0',
    }
  : {
      // The materialised table is already shaped and already Quick-only, so these are the
      // final column names and no service filter is needed — the scheduled query wrote
      // nothing but `quicksight.amazonaws.com` in the first place.
      eventName: 'event_name',
      errorCode: 'error_code',
      errorMessage: 'error_message',
      actor: 'actor',
      where: '1 = 1',
      readOnly: "is_read_only = 'Yes'",
    };

interface NamedQuery {
  name: string;
  description: string;
  sql: string;
}

const QUERIES: NamedQuery[] = [
  {
    name: 'health',
    description: 'Row counts per table — the fastest read on what is and is not flowing',
    sql: [
      ...['CHAT_LOGS', 'FEEDBACK_LOGS', 'AGENT_HOURS_LOGS', 'AGENT_METADATA_LOGS', 'INDEX_USAGE_LOGS', 'KB_FILE_SYNC_LOGS', 'DLP_LOGS'].map(
        (t) => `SELECT '${tableName(t as any)}' AS source_table, COUNT(*) AS rows FROM "${DB}"."${tableName(t as any)}"`,
      ),
      // Quick-only by construction now, so no filter is needed. Duplicates from
      // overlapping filter runs are removed the same way the dataset does it, by event_id,
      // so this reports distinct events rather than raw file rows.
      AUDIT_SOURCE === 'eventbridge'
        ? `SELECT '${AUDIT_TABLE}' AS source_table, COUNT(*) AS rows FROM "${DB}"."${AUDIT_TABLE}"`
        : `SELECT '${AUDIT_TABLE}' AS source_table, COUNT(DISTINCT event_id) AS rows FROM "${DB}"."${AUDIT_TABLE}"`,
    ].join('\nUNION ALL\n') + '\nORDER BY 1',
  },
  {
    name: 'adoption',
    description: 'Chat turns, distinct users and failures per day',
    sql: `
SELECT date_trunc('day', from_unixtime(CAST(event_timestamp AS bigint) / 1000)) AS day,
       COUNT(*)                                                        AS turns,
       COUNT(DISTINCT user_arn)                                        AS users,
       SUM(CASE WHEN status_code <> 'success' THEN 1 ELSE 0 END)       AS failures
FROM "${DB}"."${tableName('CHAT_LOGS')}"
GROUP BY 1 ORDER BY 1 DESC`.trim(),
  },
  {
    name: 'top-users',
    description: 'Busiest chat users',
    sql: `
SELECT element_at(split(user_arn, '/'), -1) AS user_name,
       user_type,
       COUNT(*)                             AS turns
FROM "${DB}"."${tableName('CHAT_LOGS')}"
GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 25`.trim(),
  },
  {
    name: 'chat-errors',
    description: 'Chat turns that were blocked or found no answer',
    sql: `
SELECT status_code,
       message_scope,
       agent_id,
       COUNT(*) AS turns
FROM "${DB}"."${tableName('CHAT_LOGS')}"
WHERE status_code <> 'success'
GROUP BY 1, 2, 3 ORDER BY 4 DESC`.trim(),
  },
  {
    name: 'feedback',
    description: 'Answer feedback split by type and reason',
    sql: `
SELECT feedback_type,
       COALESCE(NULLIF(feedback_reason, ''), '(none given)') AS feedback_reason,
       COUNT(*)                                             AS ratings
FROM "${DB}"."${tableName('FEEDBACK_LOGS')}"
GROUP BY 1, 2 ORDER BY 3 DESC`.trim(),
  },
  {
    name: 'agent-hours',
    description: 'Agent hours by surface, split into entitlement and billable overage',
    sql: `
SELECT reporting_service,
       usage_group,
       ROUND(SUM(CAST(usage_hours AS double)), 4) AS hours,
       COUNT(*)                                  AS records
FROM "${DB}"."${tableName('AGENT_HOURS_LOGS')}"
GROUP BY 1, 2 ORDER BY 3 DESC`.trim(),
  },
  {
    name: 'index-usage',
    description: 'Current index storage per source (latest event per source only)',
    sql: `
WITH ranked AS (
  SELECT source_name, source_type,
         CAST(consumed_source_size AS bigint)      AS bytes,
         CAST(consumed_source_doc_count AS bigint) AS docs,
         ROW_NUMBER() OVER (PARTITION BY source_arn ORDER BY CAST(event_timestamp AS bigint) DESC) AS rn
  FROM "${DB}"."${tableName('INDEX_USAGE_LOGS')}"
)
SELECT source_type, source_name,
       ROUND(CAST(bytes AS double) / 1048576.0, 2) AS mb,
       docs
FROM ranked WHERE rn = 1 ORDER BY bytes DESC`.trim(),
  },
  {
    name: 'kb-failures',
    description: 'Knowledge base documents that did not index, with the suggested fix',
    sql: `
SELECT knowledge_base_id,
       document_status,
       COALESCE(NULLIF(error_type, ''), '(none)') AS error_type,
       COALESCE(NULLIF(error_mitigation, ''), '(none)') AS suggested_fix,
       COUNT(*) AS documents
FROM "${DB}"."${tableName('KB_FILE_SYNC_LOGS')}"
WHERE sync_result <> 'AVAILABLE'
GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC`.trim(),
  },
  {
    name: 'api-changes',
    description: 'Quick API calls that changed configuration (excludes reads)',
    sql: `
SELECT ${A.eventName} AS operation,
       ${A.actor}     AS actor,
       COALESCE(NULLIF(${A.errorCode}, ''), 'None') AS error_code,
       COUNT(*)       AS calls
FROM "${DB}"."${AUDIT_TABLE}"
WHERE ${A.where}
  AND ${A.eventName} NOT LIKE 'Describe%'
  AND ${A.eventName} NOT LIKE 'List%'
  AND ${A.eventName} NOT LIKE 'Search%'
  AND ${A.eventName} NOT LIKE 'Get%'
GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 50`.trim(),
  },
  {
    name: 'api-denied',
    description: 'Quick API calls that were denied or errored — often the useful signal',
    sql: `
SELECT ${A.eventName}    AS operation,
       ${A.errorCode}    AS error_code,
       ${A.errorMessage} AS error_message,
       COUNT(*)          AS calls
FROM "${DB}"."${AUDIT_TABLE}"
WHERE ${A.where}
  AND ${A.errorCode} IS NOT NULL AND ${A.errorCode} <> ''
GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 50`.trim(),
  },
  {
    name: 'api-reads',
    description: 'Who is reading which Quick assets — invisible to the EventBridge audit source',
    sql: `
SELECT ${A.eventName} AS operation,
       ${A.actor}     AS actor,
       COUNT(*)       AS calls
FROM "${DB}"."${AUDIT_TABLE}"
WHERE ${A.where}
  AND ${A.readOnly}
GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 50`.trim(),
  },
];

function aws<T = any>(args: string[]): T | null {
  try {
    const out = execFileSync('aws', [...args, ...awsProfileArgs(), '--region', REGION, '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.trim() ? (JSON.parse(out) as T) : ({} as T);
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer }).stderr ?? '');
    if (stderr) console.error(stderr.trim().split('\n').slice(-2).join('\n'));
    return null;
  }
}

function run(sql: string): void {
  const start = aws<{ QueryExecutionId: string }>([
    'athena',
    'start-query-execution',
    '--query-string',
    sql,
    '--work-group',
    NAMES.athenaWorkgroup,
  ]);
  if (!start?.QueryExecutionId) {
    console.error('Failed to start the query.');
    process.exit(1);
  }

  for (let i = 0; i < 90; i++) {
    const st = aws<{ QueryExecution: { Status: { State: string; StateChangeReason?: string } } }>([
      'athena',
      'get-query-execution',
      '--query-execution-id',
      start.QueryExecutionId,
    ]);
    const state = st?.QueryExecution?.Status?.State;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') {
      console.error(`Query ${state}: ${st?.QueryExecution?.Status?.StateChangeReason ?? 'unknown'}`);
      process.exit(1);
    }
    execFileSync('sleep', ['1']);
  }

  const res = aws<{ ResultSet: { Rows: { Data: { VarCharValue?: string }[] }[] } }>([
    'athena',
    'get-query-results',
    '--query-execution-id',
    start.QueryExecutionId,
  ]);
  const rows = (res?.ResultSet?.Rows ?? []).map((r) => r.Data.map((d) => d.VarCharValue ?? ''));
  if (!rows.length) {
    console.log('(no rows)');
    return;
  }
  // Column-aligned output; the header row comes back as the first row.
  const widths = rows[0].map((_, i) => Math.min(60, Math.max(...rows.map((r) => (r[i] ?? '').length))));
  for (const [i, row] of rows.entries()) {
    console.log('  ' + row.map((c, j) => truncate(c, widths[j]).padEnd(widths[j])).join('  '));
    if (i === 0) console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  }
  console.log(`\n  ${rows.length - 1} row(s)\n`);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

const args = process.argv.slice(2);

if (args[0] === '--sql') {
  const sql = args[1];
  if (!sql) {
    console.error('--sql needs a query string');
    process.exit(1);
  }
  console.log(`\nAthena · ${DB} · workgroup ${NAMES.athenaWorkgroup} · ${ACCOUNT_ID}/${REGION}\n`);
  run(sql);
} else if (!args.length || args[0] === '--list') {
  console.log(`\nNamed queries against ${DB} (account ${ACCOUNT_ID}, ${REGION}):\n`);
  for (const q of QUERIES) console.log(`  ${q.name.padEnd(14)} ${q.description}`);
  console.log(`\n  npm run query -- <name>\n  npm run query -- --sql "SELECT ..."\n`);
} else {
  const q = QUERIES.find((x) => x.name === args[0]);
  if (!q) {
    console.error(`Unknown query "${args[0]}". Available: ${QUERIES.map((x) => x.name).join(', ')}`);
    process.exit(1);
  }
  console.log(`\n${q.name} — ${q.description}\n`);
  run(q.sql);
}
