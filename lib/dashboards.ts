/**
 * The dashboards this module ships, captured verbatim from Amazon Quick.
 *
 * Each dashboard is a hand-refined Quick dashboard exported with
 * `describe-dashboard-definition` and stored under `lib/dashboards/*.json` exactly as the
 * API returns it: freeform layout, the NITRO theme, calculated fields, conditional
 * formatting, sparklines. None of that survives a round-trip through a hand-written
 * builder, so the export is the source of truth. To change a dashboard, edit it in Quick,
 * re-export it, and replace the file — do not hand-patch the JSON.
 *
 * Only the dataset ARNs are not baked in. Each stored `DataSetIdentifierDeclaration` keeps
 * the identifier its visuals reference (e.g. `quick-obs-chat-activity`) and a placeholder
 * ARN; `resolveDashboard` rebinds every declaration to the dataset this deployment actually
 * created, matched by dataset suffix rather than the literal id. So the definitions carry no
 * account id and survive a different `QUICK_OBS_PREFIX`, and a configuration that drops a
 * dataset a dashboard needs fails loudly at synth instead of deploying a broken version.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { DATASETS, datasetId, type DatasetSpec } from './datasets';

interface DashboardAsset {
  Name: string;
  ThemeArn?: string;
  DashboardPublishOptions?: unknown;
  Definition: {
    DataSetIdentifierDeclarations: { Identifier: string; DataSetArn: string }[];
    [key: string]: unknown;
  };
}

export interface CapturedDashboard {
  /** Stable key: the construct id stem and the `NAMES` entry that gives the dashboard id. */
  key: string;
  /** File under `lib/dashboards`. */
  file: string;
}

/** The shipped dashboards, in the order they should appear. */
export const CAPTURED_DASHBOARDS: CapturedDashboard[] = [
  { key: 'pulse', file: 'pulse.json' },
  { key: 'operations', file: 'operations.json' },
];

export interface ResolvedDashboard {
  key: string;
  name: string;
  themeArn?: string;
  publishOptions?: unknown;
  /** PascalCase CloudFormation `Definition`, every `DataSetArn` rebound to this deployment. */
  definition: Record<string, unknown>;
  /** Dataset spec keys this dashboard binds to, so the stack can order dependencies. */
  datasetKeys: string[];
}

/** Match a captured identifier to a built dataset by its stable suffix. */
function specFor(identifier: string): DatasetSpec | undefined {
  return DATASETS.find(
    (s) => identifier === datasetId(s) || identifier === s.idSuffix || identifier.endsWith(`-${s.idSuffix}`),
  );
}

/**
 * Load a captured dashboard and rebind its datasets to this deployment.
 *
 * @param cap             which dashboard to load
 * @param datasetArnByKey dataset spec key -> the ARN the stack created for it
 */
export function resolveDashboard(cap: CapturedDashboard, datasetArnByKey: Map<string, string>): ResolvedDashboard {
  const asset = JSON.parse(readFileSync(join(__dirname, 'dashboards', cap.file), 'utf8')) as DashboardAsset;

  const datasetKeys: string[] = [];
  for (const decl of asset.Definition.DataSetIdentifierDeclarations) {
    const spec = specFor(decl.Identifier);
    if (!spec) {
      throw new Error(
        `Dashboard "${cap.file}" references dataset "${decl.Identifier}", which the current ` +
          `configuration does not build. Available: ${DATASETS.map((s) => datasetId(s)).join(', ')}. ` +
          `Widen QUICK_OBS_LOG_TYPES / QUICK_OBS_AUDIT_SOURCE, or drop the dashboard from CAPTURED_DASHBOARDS.`,
      );
    }
    const arn = datasetArnByKey.get(spec.key);
    if (!arn) throw new Error(`No ARN was resolved for dataset "${spec.key}" needed by "${cap.file}".`);
    // Leave the identifier alone — every visual references it — and bind only the ARN.
    decl.DataSetArn = arn;
    datasetKeys.push(spec.key);
  }

  return {
    key: cap.key,
    name: asset.Name,
    themeArn: asset.ThemeArn,
    publishOptions: asset.DashboardPublishOptions,
    definition: asset.Definition as unknown as Record<string, unknown>,
    datasetKeys,
  };
}
