/**
 * Field definitions for each Amazon Quick vended log type.
 *
 * Transcribed from the authoritative documentation on 2026-09-02:
 * https://docs.aws.amazon.com/quick/latest/userguide/monitoring-cloudwatch-logs.html
 *
 * This one file drives three things, which is why it exists rather than the field
 * lists being scattered:
 *   1. `recordFields` on each Delivery — what Quick is asked to emit.
 *   2. The Glue table columns — how Athena reads it back.
 *   3. The Quick dataset/topic column semantics.
 *
 * TWO TRAPS ENCODED HERE
 *
 * 1. Field naming is inconsistent between log types. Chat and feedback logs use
 *    `logType` and `accountId` (camelCase); every other type uses `log_type` and
 *    `account_id` (snake_case). Get it wrong and the column reads back as NULL with
 *    no error. The `envelope` per schema below captures which convention applies.
 *
 * 2. Athena lower-cases column names. A Glue column named `logType` is queried as
 *    `logtype`, and the JSON SerDe then fails to find `logType` in the record — again
 *    silently null. So camelCase source fields are mapped with an explicit
 *    `mapping` (see `serdeMapping()`), which is what makes the camelCase types work.
 */

import type { LogType } from './config';

/** Glue/Athena column type. Kept deliberately narrow. */
export type ColType = 'string' | 'bigint' | 'double' | 'int';

export interface FieldSpec {
  /** Exact field name as Quick emits it. Case matters. */
  name: string;
  type: ColType;
  /** Shown as the Glue column comment and the Quick dataset description. */
  description: string;
  /**
   * User-authored or otherwise sensitive content. Excluded from `recordFields`
   * unless QUICK_OBS_LOG_SENSITIVE=true. See config.INCLUDE_SENSITIVE_FIELDS.
   */
  sensitive?: boolean;
  /**
   * Emitted as a JSON array or object rather than a scalar. Stored as a string
   * column; Athena's json_extract can pick it apart at query time. Modelling these
   * as real Athena arrays/structs would make the table brittle to schema additions,
   * which the docs explicitly warn about ("New values might appear...").
   */
  json?: boolean;
}

export interface LogSchema {
  logType: LogType;
  /** Human name used in dashboards and docs. */
  title: string;
  /** One line on what the log type is for. */
  purpose: string;
  /** Which envelope-field convention this log type uses. */
  envelope: 'camel' | 'snake';
  fields: FieldSpec[];
}

/** Envelope fields present on every record, in the convention the type uses. */
function envelopeFields(convention: 'camel' | 'snake'): FieldSpec[] {
  return [
    { name: 'resource_arn', type: 'string', description: 'ARN of the Amazon Quick account that emitted the event.' },
    { name: 'event_timestamp', type: 'bigint', description: 'Event time as Unix epoch milliseconds.' },
    convention === 'camel'
      ? { name: 'logType', type: 'string', description: 'The vended log type.' }
      : { name: 'log_type', type: 'string', description: 'The vended log type.' },
    convention === 'camel'
      ? { name: 'accountId', type: 'string', description: 'AWS account id.' }
      : { name: 'account_id', type: 'string', description: 'AWS account id.' },
  ];
}

// ---------------------------------------------------------------------------
// CHAT_LOGS
// ---------------------------------------------------------------------------

const CHAT: LogSchema = {
  logType: 'CHAT_LOGS',
  title: 'Chat interactions',
  purpose: 'One record per chat turn: who asked, against what scope, and whether it succeeded.',
  envelope: 'camel',
  fields: [
    { name: 'user_arn', type: 'string', description: 'Quick user ARN that initiated the conversation.' },
    { name: 'user_type', type: 'string', description: 'Quick role of the user, e.g. ADMIN_PRO.' },
    {
      name: 'status_code',
      type: 'string',
      description: 'Outcome of the chat request: success, request_blocked, or no_answer_found.',
    },
    { name: 'conversation_id', type: 'string', description: 'Unique id for the conversation.' },
    { name: 'system_message_id', type: 'string', description: 'System-generated message id.' },
    {
      name: 'message_scope',
      type: 'string',
      description: 'Grounding scope: all_resources, specific_resources, or no_resources.',
    },
    { name: 'user_message_id', type: 'string', description: 'Unique id of the user message.' },
    {
      name: 'user_message',
      type: 'string',
      description: 'The question the user typed. User-authored content.',
      sensitive: true,
    },
    { name: 'agent_id', type: 'string', description: 'Chat agent id, or SYSTEM for the built-in agent.' },
    { name: 'flow_id', type: 'string', description: 'Quick Flow id, or "-" when not a flow invocation.' },
    {
      name: 'system_text_message',
      type: 'string',
      description: 'The answer the agent returned. May restate user content.',
      sensitive: true,
    },
    { name: 'user_selected_resources', type: 'string', description: 'Resources the user scoped the question to.', json: true },
    { name: 'action_connectors', type: 'string', description: 'Action connectors available in the conversation.', json: true },
    { name: 'cited_resource', type: 'string', description: 'Resources cited in the answer.', json: true },
    { name: 'file_attachment', type: 'string', description: 'Files the user attached.', json: true },
    ...envelopeFields('camel'),
  ],
};

// ---------------------------------------------------------------------------
// FEEDBACK_LOGS
// ---------------------------------------------------------------------------

const FEEDBACK: LogSchema = {
  logType: 'FEEDBACK_LOGS',
  title: 'Answer feedback',
  purpose: 'Thumbs up/down on chat answers, with the reason the user chose.',
  envelope: 'camel',
  fields: [
    { name: 'user_arn', type: 'string', description: 'Quick user ARN that gave the feedback.' },
    { name: 'user_type', type: 'string', description: 'Quick role of the user.' },
    { name: 'status_code', type: 'string', description: 'Status of the event delivery.' },
    { name: 'conversation_id', type: 'string', description: 'Conversation the feedback belongs to. Joins to chat_logs.' },
    { name: 'system_message_id', type: 'string', description: 'The answer being rated. Joins to chat_logs.' },
    { name: 'user_message_id', type: 'string', description: 'The question that produced the answer.' },
    { name: 'feedback_type', type: 'string', description: 'Useful or Not Useful.' },
    {
      name: 'feedback_reason',
      type: 'string',
      description: 'Reason chosen by the user, e.g. Inaccurate, Incomplete answer, Too wordy.',
    },
    {
      name: 'feedback_details',
      type: 'string',
      description: 'Free-text detail the user typed. User-authored content.',
      sensitive: true,
    },
    ...envelopeFields('camel'),
  ],
};

// ---------------------------------------------------------------------------
// AGENT_HOURS_LOGS
// ---------------------------------------------------------------------------

const AGENT_HOURS: LogSchema = {
  logType: 'AGENT_HOURS_LOGS',
  title: 'Agent hours consumption',
  purpose: 'Metered agent hours per user and surface, split by entitlement versus overage. This is the cost log.',
  envelope: 'camel',
  fields: [
    { name: 'user_arn', type: 'string', description: 'Quick user ARN that consumed the hours.' },
    { name: 'subscription_type', type: 'string', description: 'Subscription tier: ENTERPRISE or PROFESSIONAL.' },
    {
      name: 'reporting_service',
      type: 'string',
      description: 'Quick surface that consumed the hours, e.g. FLOW, AUTOMATION, RESEARCH.',
    },
    {
      name: 'usage_group',
      type: 'string',
      description: 'Included (within the daily entitlement, no charge) or Extra (overage, billed).',
    },
    { name: 'usage_hours', type: 'double', description: 'Agent hours consumed by this record.' },
    { name: 'service_resource_arn', type: 'string', description: 'ARN of the flow, automation or research session.' },
    ...envelopeFields('camel'),
  ],
};

// ---------------------------------------------------------------------------
// AGENT_METADATA_LOGS
// ---------------------------------------------------------------------------

const AGENT_METADATA: LogSchema = {
  logType: 'AGENT_METADATA_LOGS',
  title: 'Agent lifecycle',
  purpose: 'Create, update, delete and permission changes on chat agents. The change-audit log.',
  envelope: 'snake',
  fields: [
    { name: 'user_arn', type: 'string', description: 'Quick user ARN that performed the operation.' },
    { name: 'event_name', type: 'string', description: 'Operation, e.g. CreateAgent, UpdateAgent, UpdateAgentPermissions.' },
    { name: 'event_version', type: 'string', description: 'Schema version of the record.' },
    { name: 'agent_id', type: 'string', description: 'Agent UUID.' },
    { name: 'agent_arn', type: 'string', description: 'Full agent ARN.' },
    { name: 'agent_name', type: 'string', description: 'Agent display name.' },
    { name: 'agent_status', type: 'string', description: 'Agent status after the operation, e.g. ACTIVE.' },
    { name: 'request_id', type: 'string', description: 'Request identifier for the operation.' },
    { name: 'description', type: 'string', description: 'Agent description text.' },
    { name: 'spaces', type: 'string', description: 'Spaces attached to the agent.', json: true },
    { name: 'permissions_granted', type: 'string', description: 'Permissions added by this operation.', json: true },
    { name: 'permissions_revoked', type: 'string', description: 'Permissions removed by this operation.', json: true },
    { name: 'permissions_state', type: 'string', description: 'Permissions after the operation.', json: true },
    { name: 'update_action', type: 'string', description: 'The update action performed.' },
    { name: 'version', type: 'string', description: 'Agent version number.' },
    { name: 'icon_id', type: 'string', description: 'Icon identifier.' },
    { name: 'failed_to_add_spaces', type: 'string', description: 'Spaces that could not be attached.', json: true },
    { name: 'failed_to_remove_spaces', type: 'string', description: 'Spaces that could not be detached.', json: true },
    { name: 'draft_discarded', type: 'string', description: 'Whether a draft was discarded.' },
    // The docs flag these three as sensitive content, encrypted only when a CMK is
    // configured for delivery. This module always configures a CMK, but they are
    // still gated behind the sensitive flag because they are author-written prose.
    {
      name: 'magic_builder_query',
      type: 'string',
      description: 'Natural-language query used to create the agent via the builder.',
      sensitive: true,
    },
    { name: 'instructions', type: 'string', description: 'Agent instructions.', sensitive: true },
    { name: 'custom_prompt_input', type: 'string', description: 'Custom prompt input configured for the agent.', sensitive: true },
    { name: 'welcome_message', type: 'string', description: 'Welcome message shown to users.', sensitive: true },
    { name: 'starter_prompts', type: 'string', description: 'Starter prompts suggested to users.', sensitive: true, json: true },
    ...envelopeFields('snake'),
  ],
};

// ---------------------------------------------------------------------------
// INDEX_USAGE_LOGS
// ---------------------------------------------------------------------------

const INDEX_USAGE: LogSchema = {
  logType: 'INDEX_USAGE_LOGS',
  title: 'Index storage usage',
  purpose: 'Per-source index size and document counts for knowledge bases and Spaces. The capacity log.',
  envelope: 'snake',
  fields: [
    { name: 'user_arn', type: 'string', description: 'Quick user ARN associated with the event.' },
    { name: 'consumed_index_size', type: 'bigint', description: 'Total bytes consumed by the entire index.' },
    { name: 'source_type', type: 'string', description: 'SPACE or KB.' },
    { name: 'source_name', type: 'string', description: 'Display name of the Space or knowledge base.' },
    { name: 'source_arn', type: 'string', description: 'Full ARN of the source.' },
    { name: 'consumed_source_size', type: 'bigint', description: 'Bytes consumed by this individual source.' },
    { name: 'consumed_source_doc_count', type: 'bigint', description: 'Number of documents in this source.' },
    ...envelopeFields('snake'),
  ],
};

// ---------------------------------------------------------------------------
// KB_FILE_SYNC_LOGS
// ---------------------------------------------------------------------------

const KB_FILE_SYNC: LogSchema = {
  logType: 'KB_FILE_SYNC_LOGS',
  title: 'Knowledge base sync',
  purpose:
    'Per-document sync outcome, including the error type and suggested mitigation. This is the log that explains a knowledge base indexing zero documents.',
  envelope: 'snake',
  fields: [
    { name: 'document_id', type: 'string', description: 'Document identifier, such as a URL or file path.' },
    { name: 'document_title', type: 'string', description: 'Document title.' },
    {
      name: 'document_status',
      type: 'string',
      description: 'Terminal status: ADDED, MODIFIED, UNMODIFIED, DELETED, SKIPPED, or FAILED.',
    },
    { name: 'sync_result', type: 'string', description: 'AVAILABLE or UNAVAILABLE.' },
    { name: 'sync_id', type: 'string', description: 'Sync job execution id.' },
    { name: 'data_source_id', type: 'string', description: 'Data source the knowledge base is connected to.' },
    { name: 'source_uri', type: 'string', description: 'Source URL of the document.' },
    { name: 'error_message', type: 'string', description: 'Error description when status is FAILED or SKIPPED.' },
    { name: 'error_mitigation', type: 'string', description: 'Actionable guidance for resolving the error.' },
    { name: 'error_type', type: 'string', description: 'Error code when status is FAILED or SKIPPED.' },
    { name: 'knowledge_base_id', type: 'string', description: 'UUID of the knowledge base.' },
    ...envelopeFields('snake'),
  ],
};

// ---------------------------------------------------------------------------
// DLP_LOGS
// ---------------------------------------------------------------------------

const DLP: LogSchema = {
  logType: 'DLP_LOGS',
  title: 'Data loss prevention',
  purpose: 'DLP enforcement decisions per scanned file, plus DLP configuration changes.',
  envelope: 'snake',
  fields: [
    {
      name: 'event_type',
      type: 'string',
      description:
        'DLP_FILE_BLOCKED, DLP_FILE_WARNED, DLP_INSPECTION_FAILED, DLP_SETTING_CREATED, DLP_SETTING_UPDATED, or DLP_SETTING_DELETED.',
    },
    { name: 'request_id', type: 'string', description: 'Unique identifier for the event.' },
    { name: 'user_arn', type: 'string', description: 'Quick user ARN, or "system" for service-initiated events.' },
    { name: 'dlp_job_id', type: 'string', description: 'DLP scan job id. Enforcement events only.' },
    { name: 'dlp_setting_id', type: 'string', description: 'DLP configuration that evaluated the file.' },
    { name: 'policy_action', type: 'string', description: 'Enforcement action applied: BLOCK or WARN.' },
    {
      name: 'file_name',
      type: 'string',
      description: 'Name of the scanned file. Customer content per the documentation.',
      sensitive: true,
    },
    { name: 'file_size', type: 'bigint', description: 'Size of the scanned file in bytes.' },
    { name: 'failure_type', type: 'string', description: 'Failure category, DLP_INSPECTION_FAILED only.' },
    { name: 'policy_message', type: 'string', description: 'Warning shown to the user, or the inspection failure reason.' },
    { name: 'dlp_setting_name', type: 'string', description: 'Display name of the configuration.' },
    { name: 'status', type: 'string', description: 'Configuration status: ACTIVE or INACTIVE.' },
    { name: 'provider_type', type: 'string', description: 'DLP provider, e.g. MICROSOFT_PURVIEW.' },
    { name: 'auth_type', type: 'string', description: 'Provider authentication type.' },
    { name: 'provider_outage_mode', type: 'string', description: 'Action applied when the provider is unavailable.' },
    { name: 'unmapped_action', type: 'string', description: 'Default action for files with no mapped label.' },
    { name: 'last_updated_by', type: 'string', description: 'ARN of the principal that made the change.' },
    { name: 'changes', type: 'string', description: 'Fields that changed. DLP_SETTING_UPDATED only.', json: true },
    ...envelopeFields('snake'),
  ],
};

// ---------------------------------------------------------------------------

export const SCHEMAS: Record<LogType, LogSchema> = {
  CHAT_LOGS: CHAT,
  FEEDBACK_LOGS: FEEDBACK,
  AGENT_HOURS_LOGS: AGENT_HOURS,
  AGENT_METADATA_LOGS: AGENT_METADATA,
  INDEX_USAGE_LOGS: INDEX_USAGE,
  KB_FILE_SYNC_LOGS: KB_FILE_SYNC,
  DLP_LOGS: DLP,
};

/**
 * The `recordFields` list for a Delivery.
 *
 * A minimal subset is rejected: `CreateDelivery` returned
 * `ValidationException: Mandatory record fields are missing` for a 7-field list, but
 * accepted the full documented list minus the two sensitive chat fields. So this
 * always returns the complete list, optionally minus the sensitive ones — which is the
 * only subsetting the API was observed to tolerate.
 */
export function recordFields(t: LogType, includeSensitive: boolean): string[] {
  return SCHEMAS[t].fields
    .filter((f) => includeSensitive || !f.sensitive)
    .map((f) => f.name);
}

/** Columns for the Glue table, in delivery order. */
export function glueColumns(t: LogType, includeSensitive: boolean): FieldSpec[] {
  return SCHEMAS[t].fields.filter((f) => includeSensitive || !f.sensitive);
}

/**
 * SerDe column mapping for fields whose source name is not already lower-case.
 *
 * Athena folds column names to lower case, so a column declared as `logType` is
 * looked up in the JSON as `logtype` and comes back NULL. `mapping.<col>=<json>` on
 * the OpenX JSON SerDe restores the link. Only the camelCase envelope fields need it,
 * but this is computed rather than hard-coded so a future camelCase field is handled.
 */
export function serdeMapping(t: LogType, includeSensitive: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of glueColumns(t, includeSensitive)) {
    const lower = f.name.toLowerCase();
    if (lower !== f.name) out[`mapping.${lower}`] = f.name;
  }
  return out;
}

/** Validation checks at load time rather than at deploy time. */
for (const [key, schema] of Object.entries(SCHEMAS)) {
  if (schema.logType !== key) throw new Error(`SCHEMAS key ${key} does not match logType ${schema.logType}`);
  const names = schema.fields.map((f) => f.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) throw new Error(`${key} has duplicate field(s): ${[...new Set(dupes)].join(', ')}`);
  // Every type must carry the envelope, or records cannot be attributed or timed.
  for (const required of ['resource_arn', 'event_timestamp']) {
    if (!names.includes(required)) throw new Error(`${key} is missing the mandatory field ${required}`);
  }
  const hasType = names.includes('logType') || names.includes('log_type');
  if (!hasType) throw new Error(`${key} is missing logType/log_type`);
}
