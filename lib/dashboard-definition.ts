/**
 * The observability dashboard: 3 sheets built type-safely from lib/datasets.ts.
 *
 * Sheets are organised by the operational question being asked, not by log type, so one
 * sheet answers one kind of question even when it needs several sources:
 *
 *   Sheet 1  Adoption & Answer Quality  <- chat activity, answer feedback
 *   Sheet 2  Cost & Capacity            <- agent hours, billable overage, index storage
 *   Sheet 3  Reliability & Audit        <- knowledge base sync, API activity and denials
 *
 * TWO CLASSES OF BUG THIS FILE IS BUILT TO PREVENT, both observed on a live deployment:
 *
 *   - A `CategoricalDimensionField` pointed at a non-string column fails the whole
 *     dashboard version with `COLUMN_TYPE_INCOMPATIBLE`. So `dim()` resolves the
 *     declared type from the dataset spec and emits the matching field kind. It is
 *     impossible to get wrong by hand here.
 *   - `fieldId` must be unique across the entire definition, but a `fieldSort`
 *     legitimately *references* an existing id. `assertFieldIds()` separates
 *     declarations from references, so it catches real duplicates and dangling sorts
 *     without flagging every sorted visual.
 */

import type { CfnDashboard } from 'aws-cdk-lib/aws-quicksight';
import { AVAILABLE_ALIASES, BY_KEY, col, type DatasetSpec } from './datasets';

type Dimension = CfnDashboard.DimensionFieldProperty;
type Measure = CfnDashboard.MeasureFieldProperty;

/** Placeholder identifiers, resolved to real dataset ARNs by the stack. */
export const IDENTIFIERS = {
  chat: 'chat',
  hours: 'hours',
  index: 'index',
  kbsync: 'kbsync',
  audit: 'audit',
} as const;

const specFor = (alias: string): DatasetSpec => {
  const found = Object.values(BY_KEY).find((d) => d.alias === alias);
  if (!found) throw new Error(`No dataset with alias "${alias}"`);
  return found;
};

/**
 * A dimension field of the correct kind for the column's declared type.
 *
 * This is the guard against COLUMN_TYPE_INCOMPATIBLE: the type comes from the dataset
 * spec, not from whatever the author assumed.
 */
function dim(fieldId: string, alias: string, columnName: string, granularity = 'DAY'): Dimension {
  const spec = specFor(alias);
  const c = col(spec, columnName);
  const column = { dataSetIdentifier: alias, columnName: c.friendly };
  switch (c.type) {
    case 'STRING':
      return { categoricalDimensionField: { fieldId, column } };
    case 'INTEGER':
    case 'DECIMAL':
      return { numericalDimensionField: { fieldId, column } };
    case 'DATETIME':
      return { dateDimensionField: { fieldId, column, dateGranularity: granularity } };
  }
}

/** A measure using the column's declared default aggregation. */
function measure(fieldId: string, alias: string, columnName: string, agg?: string): Measure {
  const spec = specFor(alias);
  const c = col(spec, columnName);
  const column = { dataSetIdentifier: alias, columnName: c.friendly };
  const fn = agg ?? c.aggregation ?? 'SUM';
  if (c.type === 'STRING') {
    return { categoricalMeasureField: { fieldId, column, aggregationFunction: fn === 'DISTINCT_COUNT' ? 'DISTINCT_COUNT' : 'COUNT' } };
  }
  if (c.type === 'DATETIME') {
    return { dateMeasureField: { fieldId, column, aggregationFunction: fn === 'MIN' ? 'MIN' : 'MAX' } };
  }
  return { numericalMeasureField: { fieldId, column, aggregationFunction: { simpleNumericalAggregation: fn } } };
}

// --- Visual builders -------------------------------------------------------

function kpi(id: string, title: string, value: Measure): CfnDashboard.VisualProperty {
  return {
    kpiVisual: {
      visualId: id,
      title: { visibility: 'VISIBLE', formatText: { plainText: title } },
      chartConfiguration: { fieldWells: { values: [value] } },
    },
  };
}

function barChart(
  id: string,
  title: string,
  category: Dimension,
  value: Measure,
  opts: { horizontal?: boolean; sortByValueId?: string; limit?: number } = {},
): CfnDashboard.VisualProperty {
  return {
    barChartVisual: {
      visualId: id,
      title: { visibility: 'VISIBLE', formatText: { plainText: title } },
      chartConfiguration: {
        orientation: opts.horizontal ? 'HORIZONTAL' : 'VERTICAL',
        barsArrangement: 'CLUSTERED',
        fieldWells: { barChartAggregatedFieldWells: { category: [category], values: [value] } },
        sortConfiguration: opts.sortByValueId
          ? {
              categorySort: [
                { fieldSort: { fieldId: opts.sortByValueId, direction: 'DESC' } },
              ],
              categoryItemsLimit: opts.limit ? { itemsLimit: opts.limit, otherCategories: 'INCLUDE' } : undefined,
            }
          : undefined,
      },
    },
  };
}

function lineChart(
  id: string,
  title: string,
  category: Dimension,
  values: Measure[],
): CfnDashboard.VisualProperty {
  return {
    lineChartVisual: {
      visualId: id,
      title: { visibility: 'VISIBLE', formatText: { plainText: title } },
      chartConfiguration: {
        type: 'LINE',
        fieldWells: { lineChartAggregatedFieldWells: { category: [category], values } },
      },
    },
  };
}

function donut(id: string, title: string, category: Dimension, value: Measure): CfnDashboard.VisualProperty {
  return {
    pieChartVisual: {
      visualId: id,
      title: { visibility: 'VISIBLE', formatText: { plainText: title } },
      chartConfiguration: {
        donutOptions: { arcOptions: { arcThickness: 'MEDIUM' } },
        fieldWells: { pieChartAggregatedFieldWells: { category: [category], values: [value] } },
      },
    },
  };
}

function table(
  id: string,
  title: string,
  groupBy: Dimension[],
  values: Measure[],
  sortFieldId?: string,
): CfnDashboard.VisualProperty {
  return {
    tableVisual: {
      visualId: id,
      title: { visibility: 'VISIBLE', formatText: { plainText: title } },
      chartConfiguration: {
        fieldWells: { tableAggregatedFieldWells: { groupBy, values } },
        sortConfiguration: sortFieldId
          ? { rowSort: [{ fieldSort: { fieldId: sortFieldId, direction: 'DESC' } }] }
          : undefined,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Sheet 1 — Adoption & Answer Quality
// ---------------------------------------------------------------------------

const sheetAdoption: CfnDashboard.SheetDefinitionProperty = {
  sheetId: 'adoption',
  name: 'Adoption & Answer Quality',
  title: 'Who is using Quick chat, and are the answers any good?',
  visuals: [
    kpi('k-turns', 'Chat Turns', measure('m-k-turns', 'chat', 'turns')),
    kpi('k-users', 'Active Users', measure('m-k-users', 'chat', 'user_name', 'DISTINCT_COUNT')),
    kpi('k-convos', 'Conversations', measure('m-k-convos', 'chat', 'conversation_id', 'DISTINCT_COUNT')),
    kpi('k-failed', 'Failed Answers', measure('m-k-failed', 'chat', 'failed')),
    kpi('k-notuseful', 'Rated Not Useful', measure('m-k-notuseful', 'chat', 'rated_not_useful')),

    lineChart('v-trend', 'Chat Turns Over Time', dim('d-trend-day', 'chat', 'event_time', 'DAY'), [
      measure('m-trend-turns', 'chat', 'turns'),
      measure('m-trend-failed', 'chat', 'failed'),
    ]),

    barChart('v-by-user', 'Chat Turns by User', dim('d-user', 'chat', 'user_name'), measure('m-user-turns', 'chat', 'turns'), {
      horizontal: true,
      sortByValueId: 'm-user-turns',
      limit: 15,
    }),

    barChart('v-by-agent', 'Chat Turns by Agent', dim('d-agent', 'chat', 'agent_id'), measure('m-agent-turns', 'chat', 'turns'), {
      horizontal: true,
      sortByValueId: 'm-agent-turns',
      limit: 10,
    }),

    donut('v-outcome', 'Outcome of Chat Requests', dim('d-status', 'chat', 'status_code'), measure('m-status-turns', 'chat', 'turns')),

    donut('v-feedback', 'Answer Feedback', dim('d-feedback', 'chat', 'feedback_type'), measure('m-feedback-turns', 'chat', 'turns')),

    barChart(
      'v-reason',
      'Why Answers Were Rated Not Useful',
      dim('d-reason', 'chat', 'feedback_reason'),
      measure('m-reason-count', 'chat', 'rated_not_useful'),
      { horizontal: true, sortByValueId: 'm-reason-count', limit: 10 },
    ),

    barChart('v-scope', 'Grounding Scope Used', dim('d-scope', 'chat', 'message_scope'), measure('m-scope-turns', 'chat', 'turns')),

    donut('v-cited', 'Did the Answer Cite a Source?', dim('d-cited', 'chat', 'answer_cited_sources'), measure('m-cited-turns', 'chat', 'turns')),

    table(
      'v-chat-detail',
      'Chat Detail',
      [
        dim('d-t-user', 'chat', 'user_name'),
        dim('d-t-agent', 'chat', 'agent_id'),
        dim('d-t-status', 'chat', 'status_code'),
        dim('d-t-feedback', 'chat', 'feedback_type'),
        dim('d-t-reason', 'chat', 'feedback_reason'),
        dim('d-t-time', 'chat', 'event_time', 'DAY'),
      ],
      [measure('m-t-turns', 'chat', 'turns')],
      'm-t-turns',
    ),
  ],
};

// ---------------------------------------------------------------------------
// Sheet 2 — Cost & Capacity
// ---------------------------------------------------------------------------

const sheetCost: CfnDashboard.SheetDefinitionProperty = {
  sheetId: 'cost',
  name: 'Cost & Capacity',
  title: 'Where are agent hours and index storage going?',
  visuals: [
    kpi('k-hours', 'Total Agent Hours', measure('m-k-hours', 'hours', 'usage_hours')),
    kpi('k-overage', 'Billable Overage Hours', measure('m-k-overage', 'hours', 'overage_hours')),
    kpi('k-included', 'Included Hours', measure('m-k-included', 'hours', 'included_hours')),
    kpi('k-index-mb', 'Index Storage MB', measure('m-k-indexmb', 'index', 'megabytes_consumed')),
    kpi('k-docs', 'Documents Indexed', measure('m-k-docs', 'index', 'document_count')),

    lineChart('v-hours-trend', 'Agent Hours Over Time', dim('d-hours-day', 'hours', 'event_time', 'DAY'), [
      measure('m-ht-included', 'hours', 'included_hours'),
      measure('m-ht-overage', 'hours', 'overage_hours'),
    ]),

    barChart(
      'v-hours-surface',
      'Agent Hours by Quick Surface',
      dim('d-surface', 'hours', 'reporting_service'),
      measure('m-surface-hours', 'hours', 'usage_hours'),
      { sortByValueId: 'm-surface-hours' },
    ),

    barChart(
      'v-hours-user',
      'Agent Hours by User',
      dim('d-hours-user', 'hours', 'user_name'),
      measure('m-hu-hours', 'hours', 'usage_hours'),
      { horizontal: true, sortByValueId: 'm-hu-hours', limit: 15 },
    ),

    donut('v-entitlement', 'Included vs Billable Overage', dim('d-entitlement', 'hours', 'usage_group'), measure('m-ent-hours', 'hours', 'usage_hours')),

    barChart(
      'v-index-source',
      'Index Storage by Source',
      dim('d-index-source', 'index', 'source_name'),
      measure('m-is-mb', 'index', 'megabytes_consumed'),
      { horizontal: true, sortByValueId: 'm-is-mb', limit: 15 },
    ),

    donut('v-index-type', 'Index Storage by Source Type', dim('d-index-type', 'index', 'source_type'), measure('m-it-mb', 'index', 'megabytes_consumed')),

    table(
      'v-index-detail',
      'Index Storage Detail',
      [dim('d-id-source', 'index', 'source_name'), dim('d-id-type', 'index', 'source_type'), dim('d-id-time', 'index', 'event_time', 'DAY')],
      [measure('m-id-mb', 'index', 'megabytes_consumed'), measure('m-id-docs', 'index', 'document_count')],
      'm-id-mb',
    ),
  ],
};

// ---------------------------------------------------------------------------
// Sheet 3 — Reliability & Audit
// ---------------------------------------------------------------------------

const sheetReliability: CfnDashboard.SheetDefinitionProperty = {
  sheetId: 'reliability',
  name: 'Reliability & Audit',
  title: 'Are knowledge bases syncing, and who is changing things?',
  visuals: [
    kpi('k-kb-docs', 'Documents Processed', measure('m-k-kbdocs', 'kbsync', 'documents')),
    kpi('k-kb-bad', 'Documents Not Indexed', measure('m-k-kbbad', 'kbsync', 'documents_unavailable')),
    kpi('k-api', 'Quick API Calls', measure('m-k-api', 'audit', 'api_calls')),
    kpi('k-api-failed', 'Failed API Calls', measure('m-k-apifailed', 'audit', 'failed_calls')),

    donut('v-sync-result', 'Knowledge Base Sync Result', dim('d-sync-result', 'kbsync', 'sync_result'), measure('m-sr-docs', 'kbsync', 'documents')),

    barChart(
      'v-sync-status',
      'Documents by Sync Status',
      dim('d-doc-status', 'kbsync', 'document_status'),
      measure('m-ds-docs', 'kbsync', 'documents'),
      { sortByValueId: 'm-ds-docs' },
    ),

    barChart(
      'v-sync-error',
      'Knowledge Base Sync Errors by Type',
      dim('d-err-type', 'kbsync', 'error_type'),
      measure('m-et-docs', 'kbsync', 'documents_unavailable'),
      { horizontal: true, sortByValueId: 'm-et-docs', limit: 10 },
    ),

    table(
      'v-sync-detail',
      'Documents That Did Not Index',
      [
        dim('d-sd-title', 'kbsync', 'document_title'),
        dim('d-sd-status', 'kbsync', 'document_status'),
        dim('d-sd-error', 'kbsync', 'error_type'),
        dim('d-sd-fix', 'kbsync', 'error_mitigation'),
      ],
      [measure('m-sd-docs', 'kbsync', 'documents_unavailable')],
      'm-sd-docs',
    ),

    lineChart('v-api-trend', 'Quick API Calls Over Time', dim('d-api-day', 'audit', 'event_time', 'DAY'), [
      measure('m-at-calls', 'audit', 'api_calls'),
      measure('m-at-failed', 'audit', 'failed_calls'),
    ]),

    barChart(
      'v-api-op',
      'Top Quick API Operations',
      dim('d-api-op', 'audit', 'event_name'),
      measure('m-ao-calls', 'audit', 'api_calls'),
      { horizontal: true, sortByValueId: 'm-ao-calls', limit: 15 },
    ),

    donut('v-api-kind', 'Reads vs Changes', dim('d-api-kind', 'audit', 'operation_kind'), measure('m-ak-calls', 'audit', 'api_calls')),

    barChart(
      'v-api-actor',
      'Quick API Calls by Actor',
      dim('d-api-actor', 'audit', 'actor'),
      measure('m-aa-calls', 'audit', 'api_calls'),
      { horizontal: true, sortByValueId: 'm-aa-calls', limit: 15 },
    ),

    table(
      'v-api-detail',
      'Changes and Failures',
      [
        dim('d-ad-op', 'audit', 'event_name'),
        dim('d-ad-actor', 'audit', 'actor'),
        dim('d-ad-kind', 'audit', 'operation_kind'),
        dim('d-ad-error', 'audit', 'error_code'),
        dim('d-ad-agent', 'audit', 'user_agent'),
        dim('d-ad-time', 'audit', 'event_time', 'DAY'),
      ],
      [measure('m-ad-calls', 'audit', 'api_calls')],
      'm-ad-calls',
    ),
  ],
};

const ALL_SHEETS: CfnDashboard.SheetDefinitionProperty[] = [sheetAdoption, sheetCost, sheetReliability];

/**
 * Drop anything the current configuration cannot support.
 *
 * A visual referencing a dataset that was not built fails the whole dashboard version, so
 * narrowing `QUICK_OBS_LOG_TYPES` or setting `QUICK_OBS_AUDIT_SOURCE=none` has to prune
 * the definition rather than produce a broken one. A sheet left with no visuals is
 * dropped too, because Quick rejects an empty sheet.
 *
 * With the default configuration nothing is pruned, so this is a no-op in the common
 * case — it exists to keep the module honest when someone reconfigures it.
 */
function prune(
  sheets: CfnDashboard.SheetDefinitionProperty[],
): CfnDashboard.SheetDefinitionProperty[] {
  const aliasesIn = (node: unknown, found = new Set<string>()): Set<string> => {
    if (Array.isArray(node)) {
      for (const item of node) aliasesIn(item, found);
      return found;
    }
    if (!node || typeof node !== 'object') return found;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'dataSetIdentifier' && typeof value === 'string') found.add(value);
      else aliasesIn(value, found);
    }
    return found;
  };

  const out: CfnDashboard.SheetDefinitionProperty[] = [];
  for (const sheet of sheets) {
    const visuals = (sheet.visuals as CfnDashboard.VisualProperty[] | undefined) ?? [];
    const kept = visuals.filter((v) => [...aliasesIn(v)].every((a) => AVAILABLE_ALIASES.has(a)));
    if (kept.length) out.push({ ...sheet, visuals: kept });
  }
  if (!out.length) {
    throw new Error(
      'Pruning left the dashboard with no sheets. The configured log types and audit ' +
        'source support no visuals at all.',
    );
  }
  return out;
}

export const SHEETS: CfnDashboard.SheetDefinitionProperty[] = prune(ALL_SHEETS);

/**
 * Validate every fieldId in the definition.
 *
 * Declarations are the `fieldId` inside a *Field object; references are the `fieldId`
 * inside a `fieldSort` or `columnSort`. Conflating the two is why a naive uniqueness
 * check flags every sorted visual as a duplicate.
 */
export function assertFieldIds(sheets: CfnDashboard.SheetDefinitionProperty[]): void {
  const declared: string[] = [];
  const referenced: string[] = [];

  const walk = (node: unknown, parentKey = ''): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, parentKey);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'fieldId' && typeof value === 'string') {
        if (/Sort$/i.test(parentKey)) referenced.push(value);
        else declared.push(value);
      } else {
        walk(value, key);
      }
    }
  };
  walk(sheets);

  const dupes = declared.filter((id, i) => declared.indexOf(id) !== i);
  if (dupes.length) {
    throw new Error(`Duplicate fieldId declaration(s) in the dashboard: ${[...new Set(dupes)].join(', ')}`);
  }
  const dangling = referenced.filter((id) => !declared.includes(id));
  if (dangling.length) {
    throw new Error(`Sort references a fieldId that is never declared: ${[...new Set(dangling)].join(', ')}`);
  }
}

assertFieldIds(SHEETS);
