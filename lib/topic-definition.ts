/**
 * The Quick topic: the semantic layer that lets the chat agent answer operational
 * questions in natural language.
 *
 * This is what removes the need for a catalogue of hand-written query tools — one named
 * function per question, each wrapping a fixed query. Instead the columns themselves carry
 * synonyms, data roles and default aggregations, so "how many chat errors last week"
 * resolves without anyone having written that query in advance, and a question nobody
 * anticipated still gets an answer.
 *
 * Two constraints on the resource itself:
 *   - `CfnTopic` is the **V1** shape: per-column semantics are supported, but there is
 *     no `DataSetRelations`, so cross-dataset joins are impossible. Anything needing a
 *     join is pre-joined in lib/datasets.ts instead.
 *   - `userExperienceVersion` must be `NEW_READER_EXPERIENCE`, or the service rejects
 *     custom instructions with "Custom Instructions is not supported for legacy topics".
 */

import type { CfnTopic } from 'aws-cdk-lib/aws-quicksight';
import { DATASETS, type DatasetColumn, type DatasetSpec } from './datasets';

/** Map a dataset column onto a topic column, preserving its declared semantics. */
function topicColumn(c: DatasetColumn): CfnTopic.TopicColumnProperty {
  if (c.role === 'MEASURE' && !c.aggregation) {
    throw new Error(`Topic column ${c.name} is a MEASURE with no default aggregation.`);
  }
  return {
    columnName: c.friendly,
    columnFriendlyName: c.friendly,
    columnDescription: c.description,
    columnSynonyms: c.synonyms?.length ? c.synonyms : undefined,
    columnDataRole: c.role,
    aggregation: c.role === 'MEASURE' ? c.aggregation : undefined,
    semanticType: c.semanticType ? { typeName: c.semanticType } : undefined,
    // Never aggregate an identifier in a filter — summing conversation ids is
    // meaningless and Quick will happily do it if not told otherwise.
    neverAggregateInFilter: /_id$/.test(c.name) || /_arn$/.test(c.name) || undefined,
    isIncludedInTopic: true,
    timeGranularity: c.type === 'DATETIME' ? 'DAY' : undefined,
  };
}

function topicDataset(spec: DatasetSpec, datasetArn: string): CfnTopic.DatasetMetadataProperty {
  return {
    datasetArn,
    datasetName: spec.displayName,
    datasetDescription: spec.description,
    // Plumbing columns are omitted entirely rather than flagged as excluded, so the
    // topic's column list contains only things a user could meaningfully ask about.
    columns: spec.columns.filter((c) => !c.excludeFromTopic).map(topicColumn),
    dataAggregation: spec.defaultDateColumn
      ? {
          datasetRowDateGranularity: 'DAY',
          defaultDateColumnName: spec.defaultDateColumn,
        }
      : undefined,
  };
}

/** Build the topic's dataset list. `arnFor` resolves a dataset key to its ARN. */
export function topicDatasets(arnFor: (key: string) => string): CfnTopic.DatasetMetadataProperty[] {
  return DATASETS.map((spec) => topicDataset(spec, arnFor(spec.key)));
}

/**
 * Custom instructions.
 *
 * These are the rules that stop a plausible-but-wrong answer. Each line exists because
 * the underlying data has a shape that a naive reading gets wrong — the index-usage
 * and agent-hours rules in particular.
 */
export const TOPIC_CUSTOM_INSTRUCTIONS = [
  'This topic covers operational telemetry for an Amazon Quick account: chat usage, answer feedback, agent hours consumption, index storage, knowledge base sync outcomes, and Quick API audit events.',
  'All timestamps are in UTC. "Today" means the current UTC day.',
  'Chat Turns counts individual questions asked. Conversations counts distinct chat sessions, so one conversation usually contains several turns. Do not use them interchangeably.',
  'Active Users means the distinct count of User, not a sum.',
  'An answer is successful when Outcome is success. Outcomes of no_answer_found and request_blocked are failures and should be reported as such.',
  'Feedback of "Not rated" means the user never rated that answer. It is not negative feedback. When asked about satisfaction, compare Rated Useful against Rated Not Useful and state how many answers were unrated.',
  'Agent Hours: Included hours are covered by the subscription entitlement and cost nothing extra. Extra hours are billable overage. When asked about cost, report Billable Overage Hours, not total Agent Hours.',
  'Index storage events are emitted only when a source changes, and this dataset already keeps just the most recent event per source. So summing MB Consumed across sources gives current total storage - do not attempt to deduplicate it again.',
  'Knowledge base sync: a document is searchable only when Sync Result is AVAILABLE. Statuses SKIPPED, FAILED and DELETED all mean the document is not searchable. When a sync looks wrong, report the Error Type and the Suggested Fix.',
  'Quick API audit: Operation Kind separates Read calls from Create, Update and Delete. When asked what changed, exclude Read. Failed Calls includes access denials, which are often the useful signal.',
  'Vended logs are not retroactive. There is no data before log delivery was configured on this account, so an empty result for an early date range means logging was not yet enabled rather than that nothing happened.',
  'Always state the time range you used for an answer.',
].join(' ');

// ---------------------------------------------------------------------------
// Agent copy
// ---------------------------------------------------------------------------

export const AGENT_NAME = 'Quick Observability Agent';

export const AGENT_DESCRIPTION = [
  'Answers operational questions about this Amazon Quick account: who is using chat, whether answers are rated useful,',
  'how many agent hours are being consumed and how much is billable overage, how much index storage each knowledge base',
  'and Space uses, which knowledge base documents failed to sync and why, and which Quick API calls changed configuration or were denied.',
  'Grounded on Athena tables built from Quick vended logs and CloudTrail.',
  'Always state the time range used. Output is operational reporting, not a billing statement.',
].join(' ');

export const AGENT_WELCOME_MESSAGE =
  'I can report on Quick usage, answer quality, agent hours, index storage and API audit activity. Ask me about adoption, cost or failures.';

/** Max 3 prompts, each <= 100 characters. */
export const AGENT_STARTER_PROMPTS = [
  'Give me a system health overview for the last 7 days.',
  'Which users consumed the most agent hours, and how much was billable overage?',
  'Which knowledge base documents failed to sync, and what is the suggested fix?',
];

// Fail at synth time rather than midway through a deploy.
for (const p of AGENT_STARTER_PROMPTS) {
  if (p.length > 100) throw new Error(`Starter prompt exceeds 100 chars (${p.length}): ${p}`);
}
if (AGENT_STARTER_PROMPTS.length > 3) throw new Error('At most 3 starter prompts are allowed');
if (AGENT_WELCOME_MESSAGE.length > 300) throw new Error('Welcome message exceeds 300 chars');
if (AGENT_NAME.length > 50) throw new Error('Agent name exceeds 50 chars');
if (AGENT_DESCRIPTION.length > 1000) throw new Error('Agent description exceeds 1000 chars');
