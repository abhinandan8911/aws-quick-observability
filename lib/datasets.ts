/**
 * Quick dataset definitions over the Athena catalogue.
 *
 * THREE DESIGN DECISIONS, EACH FOR A REASON
 *
 * 1. **Direct query, not SPICE.** Observability data should be current when you look
 *    at it. Direct query also sidesteps SPICE capacity and refresh scheduling
 *    entirely, and the row counts here are tiny compared with a business dataset.
 *
 * 2. **Custom SQL, not physical tables.** `event_timestamp` arrives as epoch
 *    milliseconds in a bigint. A dashboard date filter needs a real timestamp, so the
 *    cast has to happen somewhere. Doing it in custom SQL keeps it in CDK and avoids
 *    Athena views, which CloudFormation can only create through a fragile encoded
 *    "presto view" blob.
 *
 * 3. **Joins done here, not in the topic.** `CfnTopic` is the V1 shape and has no
 *    `DataSetRelations`. So feedback is joined
 *    onto chat activity in SQL, letting a single dataset answer "how many answers were
 *    rated not useful", which would otherwise need a cross-dataset join the topic
 *    cannot express.
 */

import { AUDIT_SOURCE, AUDIT_TABLE, LOG_TYPES, NAMES, PREFIX, tableName, type LogType } from './config';

export type ColType = 'STRING' | 'INTEGER' | 'DECIMAL' | 'DATETIME';

export interface DatasetColumn {
  /** Column name as the SQL returns it. Lower case; Athena folds case. */
  name: string;
  type: ColType;
  /** Business-friendly name surfaced in Quick. */
  friendly: string;
  description: string;
  role: 'DIMENSION' | 'MEASURE';
  aggregation?: 'SUM' | 'AVERAGE' | 'MIN' | 'MAX' | 'COUNT' | 'DISTINCT_COUNT';
  synonyms?: string[];
  semanticType?: string;
  /**
   * Keep this column out of the Quick topic.
   *
   * For plumbing columns that the dataset needs but nobody would ever ask a question
   * about — `event_id` exists purely to de-duplicate overlapping filter runs. Excluding it
   * also keeps the topic's semantic surface honest: every column it exposes should be
   * something a person might reasonably say out loud.
   */
  excludeFromTopic?: boolean;
}

export interface DatasetSpec {
  key: string;
  /** Suffix appended to the module prefix to form the dataset id. */
  idSuffix: string;
  displayName: string;
  description: string;
  sql: string;
  columns: DatasetColumn[];
  defaultDateColumn?: string;
  /**
   * Which Glue tables this dataset's SQL reads.
   *
   * Only tables that actually exist can be queried, and the pipeline creates a table
   * only for the log types in `QUICK_OBS_LOG_TYPES` plus, optionally, the audit table.
   * Without this, narrowing the log types would leave datasets pointing at missing
   * tables and the Quick stack would fail partway through with an opaque validation
   * error. `AVAILABLE_DATASETS` uses it to drop anything unsatisfiable.
   */
  requires: { logTypes?: LogType[]; audit?: boolean };
}

const DB = NAMES.glueDatabase;

/**
 * Turn an epoch bigint into a timestamp, whichever unit the log type happens to use.
 *
 * **Quick vended logs are not consistent about this.** Measured against the deployed
 * tables: `CHAT_LOGS`, `FEEDBACK_LOGS`, `INDEX_USAGE_LOGS` and `KB_FILE_SYNC_LOGS` all
 * emit epoch **milliseconds** (13 digits), but `AGENT_HOURS_LOGS` emits epoch **seconds**
 * (10 digits). Dividing everything by 1000 mapped all 169 agent-hour rows onto
 * 1970-01-21, which is silent — the KPIs still totalled correctly because they never
 * touch the date, so only the trend visual and any "last 7 days" question were wrong.
 *
 * So the unit is detected from magnitude rather than assumed. 1e11 separates the two
 * cleanly and stays correct for a very long time: as seconds it is the year 5138, as
 * milliseconds it is 1973. Any plausible value is unambiguous.
 *
 * `from_unixtime` takes seconds. Cast to bigint first: integer division on the raw value
 * is fine, but doing it in double then casting loses sub-second ordering on high-volume
 * days.
 */
const EVENT_TIME = (col = 'event_timestamp') =>
  `from_unixtime(CASE WHEN CAST(${col} AS bigint) > 100000000000 ` +
  `THEN CAST(${col} AS bigint) / 1000 ELSE CAST(${col} AS bigint) END)`;

/**
 * Pull the readable user name out of a Quick user ARN.
 *
 * ARNs look like `arn:aws:quicksight:us-east-1:123456789012:user/default/AuthorPro/name@example.com`.
 * The last slash-delimited element is the useful part; everything before it is noise
 * that would make every chart label unreadable.
 */
const USER_NAME = (col = 'user_arn') =>
  `COALESCE(NULLIF(element_at(split(${col}, '/'), -1), ''), ${col}, 'unknown')`;

// ---------------------------------------------------------------------------
// 1. Chat activity (chat + feedback, joined)
// ---------------------------------------------------------------------------

const CHAT_ACTIVITY: DatasetSpec = {
  key: 'chatActivity',
  requires: { logTypes: ['CHAT_LOGS', 'FEEDBACK_LOGS'] },
  idSuffix: 'chat-activity',
  displayName: 'Quick Chat Activity',
  description:
    'One row per chat turn, with any feedback the user later gave on that answer. The core adoption and answer-quality dataset.',
  defaultDateColumn: 'Event Time',
  // LEFT JOIN so unrated answers are kept — the ratio of rated to unrated is itself a
  // metric, and an inner join would silently drop most traffic.
  sql: `
SELECT
  c.conversation_id                              AS conversation_id,
  c.user_message_id                              AS user_message_id,
  c.system_message_id                            AS system_message_id,
  ${USER_NAME('c.user_arn')}                     AS user_name,
  c.user_type                                    AS user_type,
  c.status_code                                  AS status_code,
  c.message_scope                                AS message_scope,
  c.agent_id                                     AS agent_id,
  CASE WHEN c.flow_id IS NULL OR c.flow_id = '-' THEN 'Not a flow' ELSE c.flow_id END AS flow_id,
  CASE WHEN c.cited_resource IS NULL OR c.cited_resource = '' OR c.cited_resource = '[]'
       THEN 'No' ELSE 'Yes' END                  AS answer_cited_sources,
  CASE WHEN c.file_attachment IS NULL OR c.file_attachment = '' OR c.file_attachment = '[]'
       THEN 'No' ELSE 'Yes' END                  AS had_attachment,
  COALESCE(f.feedback_type, 'Not rated')         AS feedback_type,
  COALESCE(f.feedback_reason, 'None')            AS feedback_reason,
  CASE WHEN f.feedback_type IS NULL THEN 0 ELSE 1 END AS was_rated,
  CASE WHEN f.feedback_type = 'Useful' THEN 1 ELSE 0 END      AS rated_useful,
  CASE WHEN f.feedback_type = 'Not Useful' THEN 1 ELSE 0 END  AS rated_not_useful,
  CASE WHEN c.status_code = 'success' THEN 1 ELSE 0 END       AS succeeded,
  CASE WHEN c.status_code <> 'success' THEN 1 ELSE 0 END      AS failed,
  1                                              AS turns,
  ${EVENT_TIME('c.event_timestamp')}             AS event_time
FROM "${DB}"."${tableName('CHAT_LOGS')}" c
LEFT JOIN "${DB}"."${tableName('FEEDBACK_LOGS')}" f
  ON f.system_message_id = c.system_message_id
`.trim(),
  columns: [
    { name: 'conversation_id', type: 'STRING', friendly: 'Conversation ID', description: 'Unique id of the conversation.', role: 'DIMENSION', synonyms: ['conversation', 'thread'] },
    { name: 'user_message_id', type: 'STRING', friendly: 'Question ID', description: 'Unique id of the user question.', role: 'DIMENSION' },
    { name: 'system_message_id', type: 'STRING', friendly: 'Answer ID', description: 'Unique id of the answer. Joins chat to feedback.', role: 'DIMENSION' },
    { name: 'user_name', type: 'STRING', friendly: 'User', description: 'Quick user who asked the question.', role: 'DIMENSION', synonyms: ['who', 'person', 'requester', 'asker'] },
    { name: 'user_type', type: 'STRING', friendly: 'User Role', description: 'Quick role of the user, e.g. ADMIN_PRO, AUTHOR_PRO, READER_PRO.', role: 'DIMENSION', synonyms: ['role', 'licence', 'license', 'tier'] },
    { name: 'status_code', type: 'STRING', friendly: 'Outcome', description: 'success, no_answer_found, or request_blocked.', role: 'DIMENSION', synonyms: ['status', 'result', 'outcome'] },
    { name: 'message_scope', type: 'STRING', friendly: 'Grounding Scope', description: 'What the question was grounded on: all_resources, specific_resources, or no_resources.', role: 'DIMENSION', synonyms: ['scope', 'grounding'] },
    { name: 'agent_id', type: 'STRING', friendly: 'Agent', description: 'Chat agent that answered, or SYSTEM for the built-in Quick agent.', role: 'DIMENSION', synonyms: ['chat agent', 'assistant', 'bot'] },
    { name: 'flow_id', type: 'STRING', friendly: 'Flow', description: 'Quick Flow that produced the turn, or "Not a flow".', role: 'DIMENSION', synonyms: ['quick flow'] },
    { name: 'answer_cited_sources', type: 'STRING', friendly: 'Cited Sources', description: 'Yes when the answer cited at least one source. A grounding-quality signal.', role: 'DIMENSION', synonyms: ['citation', 'cited', 'grounded'] },
    { name: 'had_attachment', type: 'STRING', friendly: 'Had Attachment', description: 'Yes when the user attached a file to the question.', role: 'DIMENSION', synonyms: ['attachment', 'file upload'] },
    { name: 'feedback_type', type: 'STRING', friendly: 'Feedback', description: 'Useful, Not Useful, or Not rated.', role: 'DIMENSION', synonyms: ['rating', 'thumbs', 'vote'] },
    { name: 'feedback_reason', type: 'STRING', friendly: 'Feedback Reason', description: 'Reason the user selected, e.g. Inaccurate, Incomplete answer, Too wordy.', role: 'DIMENSION', synonyms: ['reason', 'complaint', 'why'] },
    { name: 'turns', type: 'INTEGER', friendly: 'Chat Turns', description: 'Count of chat turns. Sum this to count questions asked.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['questions', 'messages', 'volume', 'interactions', 'chats'] },
    { name: 'was_rated', type: 'INTEGER', friendly: 'Rated Answers', description: 'Count of answers that received any feedback.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['rated', 'feedback count'] },
    { name: 'rated_useful', type: 'INTEGER', friendly: 'Rated Useful', description: 'Count of answers rated Useful.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['thumbs up', 'positive', 'helpful'] },
    { name: 'rated_not_useful', type: 'INTEGER', friendly: 'Rated Not Useful', description: 'Count of answers rated Not Useful.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['thumbs down', 'negative', 'unhelpful'] },
    { name: 'succeeded', type: 'INTEGER', friendly: 'Successful Answers', description: 'Count of turns whose outcome was success.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['success', 'answered'] },
    { name: 'failed', type: 'INTEGER', friendly: 'Failed Answers', description: 'Count of turns that were blocked or found no answer.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['failures', 'errors', 'blocked', 'no answer'] },
    { name: 'event_time', type: 'DATETIME', friendly: 'Event Time', description: 'When the chat turn happened.', role: 'DIMENSION', synonyms: ['when', 'date', 'time', 'timestamp'], semanticType: 'DATE' },
  ],
};

// ---------------------------------------------------------------------------
// 2. Agent hours (cost)
// ---------------------------------------------------------------------------

const AGENT_HOURS: DatasetSpec = {
  key: 'agentHours',
  requires: { logTypes: ['AGENT_HOURS_LOGS'] },
  idSuffix: 'agent-hours',
  displayName: 'Quick Agent Hours',
  description:
    'Metered agent-hour consumption per user and Quick surface, split by subscription entitlement versus billable overage. This is the cost dataset.',
  defaultDateColumn: 'Event Time',
  sql: `
SELECT
  ${USER_NAME()}                                  AS user_name,
  subscription_type                               AS subscription_type,
  reporting_service                               AS reporting_service,
  usage_group                                     AS usage_group,
  CAST(usage_hours AS double)                     AS usage_hours,
  CASE WHEN usage_group = 'Extra' THEN CAST(usage_hours AS double) ELSE 0.0 END AS overage_hours,
  CASE WHEN usage_group = 'Included' THEN CAST(usage_hours AS double) ELSE 0.0 END AS included_hours,
  service_resource_arn                            AS service_resource_arn,
  ${EVENT_TIME()}                                 AS event_time
FROM "${DB}"."${tableName('AGENT_HOURS_LOGS')}"
`.trim(),
  columns: [
    { name: 'user_name', type: 'STRING', friendly: 'User', description: 'Quick user who consumed the hours.', role: 'DIMENSION', synonyms: ['who', 'person'] },
    { name: 'subscription_type', type: 'STRING', friendly: 'Subscription', description: 'ENTERPRISE or PROFESSIONAL.', role: 'DIMENSION', synonyms: ['tier', 'plan'] },
    { name: 'reporting_service', type: 'STRING', friendly: 'Quick Surface', description: 'Which Quick feature consumed the hours: FLOW, AUTOMATION, or RESEARCH.', role: 'DIMENSION', synonyms: ['feature', 'service', 'surface', 'capability'] },
    { name: 'usage_group', type: 'STRING', friendly: 'Entitlement', description: 'Included means within the daily grant at no extra charge. Extra means billable overage.', role: 'DIMENSION', synonyms: ['billing', 'overage', 'included'] },
    { name: 'service_resource_arn', type: 'STRING', friendly: 'Resource', description: 'The flow, automation or research session that consumed the hours.', role: 'DIMENSION' },
    { name: 'usage_hours', type: 'DECIMAL', friendly: 'Agent Hours', description: 'Agent hours consumed. Sum this for total consumption.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['hours', 'usage', 'consumption', 'agent time'] },
    { name: 'overage_hours', type: 'DECIMAL', friendly: 'Billable Overage Hours', description: 'Agent hours beyond the daily entitlement. These are charged.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['overage', 'extra hours', 'billed hours', 'cost'] },
    { name: 'included_hours', type: 'DECIMAL', friendly: 'Included Hours', description: 'Agent hours covered by the subscription entitlement.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['free hours', 'entitled hours'] },
    { name: 'event_time', type: 'DATETIME', friendly: 'Event Time', description: 'When the hours were metered.', role: 'DIMENSION', synonyms: ['when', 'date'], semanticType: 'DATE' },
  ],
};

// ---------------------------------------------------------------------------
// 3. Index usage (capacity)
// ---------------------------------------------------------------------------

const INDEX_USAGE: DatasetSpec = {
  key: 'indexUsage',
  requires: { logTypes: ['INDEX_USAGE_LOGS'] },
  idSuffix: 'index-usage',
  displayName: 'Quick Index Storage',
  description:
    'Index storage consumed per knowledge base and Space. Events are emitted on change, so the latest row per source is the current state.',
  defaultDateColumn: 'Event Time',
  // Events publish on change, not daily, so a naive SUM over all history would
  // multiply-count a source that changed often. The window function keeps only the
  // most recent event per source, which the docs state is how to reconstruct state.
  sql: `
WITH ranked AS (
  SELECT
    source_arn,
    source_name,
    source_type,
    CAST(consumed_source_size AS bigint)      AS consumed_source_size,
    CAST(consumed_source_doc_count AS bigint) AS consumed_source_doc_count,
    CAST(consumed_index_size AS bigint)       AS consumed_index_size,
    event_timestamp,
    ROW_NUMBER() OVER (PARTITION BY source_arn ORDER BY CAST(event_timestamp AS bigint) DESC) AS rn
  FROM "${DB}"."${tableName('INDEX_USAGE_LOGS')}"
)
SELECT
  source_name                                          AS source_name,
  source_type                                          AS source_type,
  source_arn                                           AS source_arn,
  consumed_source_size                                 AS bytes_consumed,
  ROUND(CAST(consumed_source_size AS double) / 1048576.0, 3) AS megabytes_consumed,
  consumed_source_doc_count                            AS document_count,
  consumed_index_size                                  AS total_index_bytes,
  ${EVENT_TIME()}                                      AS event_time
FROM ranked
WHERE rn = 1
`.trim(),
  columns: [
    { name: 'source_name', type: 'STRING', friendly: 'Source', description: 'Display name of the knowledge base or Space.', role: 'DIMENSION', synonyms: ['knowledge base', 'space', 'name'] },
    { name: 'source_type', type: 'STRING', friendly: 'Source Type', description: 'KB for a knowledge base, SPACE for a Space.', role: 'DIMENSION', synonyms: ['type', 'kind'] },
    { name: 'source_arn', type: 'STRING', friendly: 'Source ARN', description: 'Full ARN of the source.', role: 'DIMENSION' },
    { name: 'bytes_consumed', type: 'INTEGER', friendly: 'Bytes Consumed', description: 'Index bytes consumed by this source, as of its most recent event.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['bytes', 'size', 'storage'] },
    { name: 'megabytes_consumed', type: 'DECIMAL', friendly: 'MB Consumed', description: 'Index storage consumed by this source in megabytes.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['mb', 'megabytes', 'storage used'] },
    { name: 'document_count', type: 'INTEGER', friendly: 'Documents Indexed', description: 'Number of documents indexed from this source.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['documents', 'docs', 'files', 'doc count'] },
    { name: 'total_index_bytes', type: 'INTEGER', friendly: 'Total Index Bytes', description: 'Total size of the whole account index at the time of the event.', role: 'MEASURE', aggregation: 'MAX', synonyms: ['index size', 'total storage'] },
    { name: 'event_time', type: 'DATETIME', friendly: 'Event Time', description: 'When this source last changed.', role: 'DIMENSION', synonyms: ['when', 'last updated'], semanticType: 'DATE' },
  ],
};

// ---------------------------------------------------------------------------
// 4. Knowledge base sync
// ---------------------------------------------------------------------------

const KB_SYNC: DatasetSpec = {
  key: 'kbSync',
  requires: { logTypes: ['KB_FILE_SYNC_LOGS'] },
  idSuffix: 'kb-sync',
  displayName: 'Quick Knowledge Base Sync',
  description:
    'Per-document knowledge base sync outcomes, including the error type and suggested mitigation for failed or skipped documents.',
  defaultDateColumn: 'Event Time',
  sql: `
SELECT
  knowledge_base_id                     AS knowledge_base_id,
  sync_id                               AS sync_id,
  data_source_id                        AS data_source_id,
  document_title                        AS document_title,
  document_id                           AS document_id,
  document_status                       AS document_status,
  sync_result                           AS sync_result,
  COALESCE(NULLIF(error_type, ''), 'None')       AS error_type,
  COALESCE(NULLIF(error_message, ''), 'None')    AS error_message,
  COALESCE(NULLIF(error_mitigation, ''), 'None') AS error_mitigation,
  CASE WHEN sync_result = 'AVAILABLE' THEN 1 ELSE 0 END   AS documents_available,
  CASE WHEN sync_result = 'UNAVAILABLE' THEN 1 ELSE 0 END AS documents_unavailable,
  1                                     AS documents,
  ${EVENT_TIME()}                       AS event_time
FROM "${DB}"."${tableName('KB_FILE_SYNC_LOGS')}"
`.trim(),
  columns: [
    { name: 'knowledge_base_id', type: 'STRING', friendly: 'Knowledge Base', description: 'UUID of the knowledge base.', role: 'DIMENSION', synonyms: ['kb', 'knowledge base id'] },
    { name: 'sync_id', type: 'STRING', friendly: 'Sync Run', description: 'Sync job execution id. Group by this to see one crawl.', role: 'DIMENSION', synonyms: ['sync', 'run', 'job', 'crawl'] },
    { name: 'data_source_id', type: 'STRING', friendly: 'Data Source', description: 'Data source the knowledge base is connected to.', role: 'DIMENSION' },
    { name: 'document_title', type: 'STRING', friendly: 'Document', description: 'Title of the document.', role: 'DIMENSION', synonyms: ['title', 'file', 'page'] },
    { name: 'document_id', type: 'STRING', friendly: 'Document ID', description: 'Document identifier, usually a URL or file path.', role: 'DIMENSION', synonyms: ['url', 'path'] },
    { name: 'document_status', type: 'STRING', friendly: 'Document Status', description: 'ADDED, MODIFIED, UNMODIFIED, DELETED, SKIPPED, or FAILED.', role: 'DIMENSION', synonyms: ['status', 'outcome'] },
    { name: 'sync_result', type: 'STRING', friendly: 'Sync Result', description: 'AVAILABLE when the document is searchable, UNAVAILABLE when it is not.', role: 'DIMENSION', synonyms: ['result', 'available'] },
    { name: 'error_type', type: 'STRING', friendly: 'Error Type', description: 'Error code for a failed or skipped document, or None.', role: 'DIMENSION', synonyms: ['error', 'error code', 'failure'] },
    { name: 'error_message', type: 'STRING', friendly: 'Error Message', description: 'Why the document failed or was skipped.', role: 'DIMENSION', synonyms: ['message', 'reason'] },
    { name: 'error_mitigation', type: 'STRING', friendly: 'Suggested Fix', description: 'Actionable guidance for resolving the error.', role: 'DIMENSION', synonyms: ['fix', 'mitigation', 'remediation'] },
    { name: 'documents', type: 'INTEGER', friendly: 'Documents', description: 'Count of document sync records.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['docs', 'count', 'files'] },
    { name: 'documents_available', type: 'INTEGER', friendly: 'Documents Indexed', description: 'Count of documents that ended up searchable.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['indexed', 'succeeded', 'available'] },
    { name: 'documents_unavailable', type: 'INTEGER', friendly: 'Documents Not Indexed', description: 'Count of documents that failed, were skipped, or were deleted.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['failed', 'unavailable', 'skipped', 'missing'] },
    { name: 'event_time', type: 'DATETIME', friendly: 'Event Time', description: 'When the document was processed.', role: 'DIMENSION', synonyms: ['when', 'date'], semanticType: 'DATE' },
  ],
};

// ---------------------------------------------------------------------------
// 5. API audit
// ---------------------------------------------------------------------------

/**
 * Classify an operation name into Create / Update / Delete / Read / Other.
 *
 * Shared between the two SQL variants so the dashboard's "Reads vs Changes" chart means
 * the same thing regardless of where the audit data came from.
 */
const OPERATION_KIND = (col: string) => `
  CASE
    WHEN ${col} LIKE 'Create%' THEN 'Create'
    WHEN ${col} LIKE 'Update%' THEN 'Update'
    WHEN ${col} LIKE 'Delete%' THEN 'Delete'
    WHEN ${col} LIKE 'Describe%'
      OR ${col} LIKE 'List%'
      OR ${col} LIKE 'Search%'
      OR ${col} LIKE 'Get%'  THEN 'Read'
    ELSE 'Other'
  END`.trim();

/**
 * SQL for the API audit dataset, matching whichever audit source is configured.
 *
 * The two sources produce different files, so they need different SQL, but both project
 * the **same column contract** — so the captured dashboards and `topic-definition.ts`
 * never need to know which is in use.
 *
 *   CloudTrail direct (`existing-trail` / `own-trail`)
 *     Flat records via CloudTrailSerde. Includes read-only events. Must filter to
 *     `eventsource = 'quicksight.amazonaws.com'`, because a trail carries every
 *     management event in the account — management events cannot be narrowed to one
 *     service by event selector, so the filter has to happen here.
 *
 *   EventBridge (`eventbridge`)
 *     The CloudTrail record nested under `detail`, already filtered to aws.quicksight by
 *     the rule, and containing writes only.
 */
export function auditSql(): string {
  if (AUDIT_SOURCE === 'eventbridge') {
    // `detail` is a typed struct, not a JSON string — the OpenX SerDe returns NULL when
    // an object is read into a string column, so json_extract_scalar produced empty
    // columns on a table that queried fine.
    return `
SELECT
  detail.eventname                                                  AS event_name,
  detail.eventsource                                                AS event_source,
  COALESCE(
    NULLIF(detail.useridentity.sessioncontext.sessionissuer.username, ''),
    NULLIF(detail.useridentity.username, ''),
    NULLIF(detail.useridentity.type, ''),
    'unknown'
  )                                                                 AS actor,
  COALESCE(NULLIF(detail.useridentity.type, ''), 'unknown')         AS actor_type,
  COALESCE(NULLIF(detail.sourceipaddress, ''), 'unknown')           AS source_ip,
  COALESCE(NULLIF(detail.useragent, ''), 'unknown')                 AS user_agent,
  COALESCE(NULLIF(detail.errorcode, ''), 'None')                    AS error_code,
  COALESCE(NULLIF(detail.errormessage, ''), 'None')                 AS error_message,
  CASE WHEN detail.errorcode IS NULL OR detail.errorcode = '' THEN 1 ELSE 0 END AS successful_calls,
  CASE WHEN detail.errorcode IS NOT NULL AND detail.errorcode <> '' THEN 1 ELSE 0 END AS failed_calls,
  ${OPERATION_KIND('detail.eventname')}                             AS operation_kind,
  'No'                                                              AS is_read_only,
  1                                                                 AS api_calls,
  region                                                            AS aws_region,
  from_iso8601_timestamp(time)                                      AS event_time
FROM "${DB}"."${AUDIT_TABLE}"
`.trim();
  }

  /**
   * CloudTrail via the materialised table.
   *
   * The heavy lifting already happened: the hourly filter query wrote only
   * `eventSource = quicksight.amazonaws.com` rows, already shaped into these columns. So
   * this is a plain projection with one job of its own — **de-duplication**.
   *
   * The filter runs on an overlapping window so a missed run self-heals, which means the
   * same event can be written more than once. `ROW_NUMBER()` over `event_id` (CloudTrail's
   * per-event unique id) keeps exactly one copy. Doing it here rather than trying to make
   * the writes exactly-once keeps the pipeline stateless — there is no watermark to
   * corrupt, and a re-run is always safe.
   */
  return `
SELECT
  event_id,
  event_name,
  event_source,
  actor,
  actor_type,
  source_ip,
  user_agent,
  error_code,
  error_message,
  is_read_only,
  operation_kind,
  aws_region,
  event_time,
  CASE WHEN error_code = 'None' THEN 1 ELSE 0 END AS successful_calls,
  CASE WHEN error_code <> 'None' THEN 1 ELSE 0 END AS failed_calls,
  1 AS api_calls
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY event_time) AS rn
  FROM "${DB}"."${AUDIT_TABLE}"
)
WHERE rn = 1
`.trim();
}

const API_AUDIT: DatasetSpec = {
  key: 'apiAudit',
  requires: { audit: true },
  idSuffix: 'api-audit',
  displayName: 'Quick API Audit',
  description:
    'Amazon Quick API calls captured from CloudTrail: who did what, from where, and whether it failed. The administrative change log.',
  defaultDateColumn: 'Event Time',
  // Two shapes, one contract. See auditSql() below.
  sql: auditSql(),
  columns: [
    { name: 'event_id', type: 'STRING', friendly: 'Event ID', description: "CloudTrail's unique event id. Used to de-duplicate overlapping filter runs.", role: 'DIMENSION', excludeFromTopic: true },
    { name: 'event_name', type: 'STRING', friendly: 'API Operation', description: 'The Quick API operation called, e.g. CreateAgent, UpdateDashboard.', role: 'DIMENSION', synonyms: ['operation', 'api', 'action', 'call'] },
    { name: 'event_source', type: 'STRING', friendly: 'Event Source', description: 'Always quicksight.amazonaws.com.', role: 'DIMENSION' },
    { name: 'actor', type: 'STRING', friendly: 'Actor', description: 'IAM principal or role that made the call.', role: 'DIMENSION', synonyms: ['who', 'user', 'caller', 'principal'] },
    { name: 'actor_type', type: 'STRING', friendly: 'Actor Type', description: 'CloudTrail identity type, e.g. AssumedRole, IAMUser, AWSService.', role: 'DIMENSION', synonyms: ['identity type'] },
    { name: 'source_ip', type: 'STRING', friendly: 'Source IP', description: 'IP address or AWS service the call came from.', role: 'DIMENSION', synonyms: ['ip', 'address', 'from where'] },
    { name: 'user_agent', type: 'STRING', friendly: 'User Agent', description: 'Client that made the call, e.g. the console, the CLI, or CloudFormation.', role: 'DIMENSION', synonyms: ['client', 'agent', 'tool'] },
    { name: 'error_code', type: 'STRING', friendly: 'Error Code', description: 'CloudTrail error code, or None when the call succeeded.', role: 'DIMENSION', synonyms: ['error', 'failure', 'denied'] },
    { name: 'error_message', type: 'STRING', friendly: 'Error Message', description: 'CloudTrail error message, or None.', role: 'DIMENSION', synonyms: ['message', 'reason'] },
    { name: 'operation_kind', type: 'STRING', friendly: 'Operation Kind', description: 'Create, Update, Delete, Read, or Other. Use this to separate changes from reads.', role: 'DIMENSION', synonyms: ['kind', 'category', 'mutation', 'change type'] },
    { name: 'is_read_only', type: 'STRING', friendly: 'Read Only', description: "CloudTrail's own read-only flag. Always No when the audit source is EventBridge, which never delivers read events.", role: 'DIMENSION', synonyms: ['readonly', 'read only', 'view'] },
    { name: 'aws_region', type: 'STRING', friendly: 'Region', description: 'AWS Region the call was made in.', role: 'DIMENSION', synonyms: ['region'] },
    { name: 'api_calls', type: 'INTEGER', friendly: 'API Calls', description: 'Count of API calls.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['calls', 'requests', 'volume', 'activity'] },
    { name: 'successful_calls', type: 'INTEGER', friendly: 'Successful Calls', description: 'Count of API calls with no error.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['successes'] },
    { name: 'failed_calls', type: 'INTEGER', friendly: 'Failed Calls', description: 'Count of API calls that returned an error, including access denials.', role: 'MEASURE', aggregation: 'SUM', synonyms: ['failures', 'errors', 'denied', 'access denied'] },
    { name: 'event_time', type: 'DATETIME', friendly: 'Event Time', description: 'When the API call was made.', role: 'DIMENSION', synonyms: ['when', 'date', 'time'], semanticType: 'DATE' },
  ],
};

// ---------------------------------------------------------------------------

/** Every dataset this module knows how to build, regardless of configuration. */
export const ALL_DATASETS: DatasetSpec[] = [CHAT_ACTIVITY, AGENT_HOURS, INDEX_USAGE, KB_SYNC, API_AUDIT];

/**
 * The datasets that can actually be built for the current configuration.
 *
 * A dataset is only buildable if every Glue table its SQL reads exists, and the pipeline
 * creates tables only for the configured `QUICK_OBS_LOG_TYPES` plus, optionally, the
 * audit table. So `QUICK_OBS_LOG_TYPES=CHAT_LOGS,FEEDBACK_LOGS` yields one dataset rather
 * than five broken ones, and `QUICK_OBS_AUDIT_SOURCE=none` simply drops the audit
 * dataset instead of failing the deploy on a missing table.
 *
 * The dashboard and topic both derive from this, so narrowing the configuration produces
 * a smaller working deployment rather than a broken one.
 */
export const DATASETS: DatasetSpec[] = ALL_DATASETS.filter((spec) => {
  const needsLogTypes = spec.requires.logTypes ?? [];
  const haveLogTypes = needsLogTypes.every((t) => LOG_TYPES.includes(t));
  const haveAudit = !spec.requires.audit || AUDIT_SOURCE !== 'none';
  return haveLogTypes && haveAudit;
});

if (!DATASETS.length) {
  throw new Error(
    'No datasets are buildable for this configuration.\n' +
      `QUICK_OBS_LOG_TYPES=${LOG_TYPES.join(',')} and QUICK_OBS_AUDIT_SOURCE=${AUDIT_SOURCE} ` +
      'leave nothing to query. Widen the log types or pick an audit source.',
  );
}

/** Full dataset id for a spec, e.g. `quick-obs-chat-activity`. */
export function datasetId(spec: DatasetSpec): string {
  return `${PREFIX}-${spec.idSuffix}`;
}

/** Look up a column, throwing at synth time on a typo rather than failing the deploy. */
export function col(spec: DatasetSpec, name: string): DatasetColumn {
  const found = spec.columns.find((c) => c.name === name);
  if (!found) {
    throw new Error(
      `Dataset "${spec.key}" has no column "${name}". Available: ${spec.columns.map((c) => c.name).join(', ')}`,
    );
  }
  return found;
}

// --- Synth-time guards -----------------------------------------------------

for (const spec of DATASETS) {
  const names = spec.columns.map((c) => c.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) throw new Error(`Dataset ${spec.key} has duplicate column(s): ${[...new Set(dupes)].join(', ')}`);

  for (const c of spec.columns) {
    if (c.role === 'MEASURE' && !c.aggregation) {
      throw new Error(`Dataset ${spec.key} column ${c.name} is a MEASURE with no default aggregation.`);
    }
    if (c.name !== c.name.toLowerCase()) {
      // Athena folds identifiers to lower case, so a mixed-case column name here would
      // not match what the query actually returns.
      throw new Error(`Dataset ${spec.key} column "${c.name}" must be lower case.`);
    }
  }

  // Every column must actually be produced by the SQL, or Quick fails at create time with
  // an unhelpful validation error. This catches the common cases: a typo in a declared
  // name, or a column added to the spec but not to the SQL.
  //
  // Two valid forms are accepted. Most columns are aliased (`expr AS name`), but a
  // projection of an already-shaped table selects bare names (`SELECT event_id, ...`) —
  // requiring an alias there would force pointless `event_id AS event_id` noise.
  for (const c of spec.columns) {
    const aliased = new RegExp(`\\bAS\\s+${c.name}\\b`, 'i').test(spec.sql);
    // A bare select-list entry: the name alone on a line, optionally comma-terminated.
    const bare = new RegExp(`^\\s*${c.name}\\s*,?\\s*$`, 'im').test(spec.sql);
    if (!aliased && !bare) {
      throw new Error(
        `Dataset ${spec.key}: column "${c.name}" is declared but the SQL neither aliases it ` +
          `("... AS ${c.name}") nor selects it by name.`,
      );
    }
  }

  if (spec.defaultDateColumn) {
    const match = spec.columns.find((c) => c.friendly === spec.defaultDateColumn);
    if (!match) throw new Error(`Dataset ${spec.key}: defaultDateColumn "${spec.defaultDateColumn}" is not a column.`);
    if (match.type !== 'DATETIME') throw new Error(`Dataset ${spec.key}: defaultDateColumn must be DATETIME.`);
  }
}
