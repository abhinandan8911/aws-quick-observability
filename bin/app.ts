#!/usr/bin/env node
/**
 * CDK entry point for the quick-observability module.
 *
 * Two stacks, deployed in this order:
 *
 *   <prefix>-pipeline   log delivery, S3 lake, Glue catalogue, Athena workgroup
 *   <prefix>-quick      Athena data source, datasets, dashboard, topic, space, agent
 *
 * The split is not cosmetic. Quick datasets are validated against live Athena tables
 * at creation time, so the pipeline must exist first — and ideally have data in it,
 * because vended logs are not retroactive and a dataset over an empty table gives a
 * blank dashboard. `npm run deploy` deploys both; deploy just the pipeline with:
 *
 *   npx cdk deploy <prefix>-pipeline
 */

import 'source-map-support/register';
import { App, Tags } from 'aws-cdk-lib';
import { ACCOUNT_ID, PREFIX, REGION, TAGS } from '../lib/config';
import { QuickObservabilityPipelineStack } from '../lib/pipeline-stack';
import { QuickObservabilityAssetsStack } from '../lib/quick-assets-stack';

const app = new App();

const env = { account: ACCOUNT_ID, region: REGION };

const pipeline = new QuickObservabilityPipelineStack(app, `${PREFIX}-pipeline`, {
  env,
  description: 'Amazon Quick observability: vended log delivery, S3 lake, Glue catalogue, Athena workgroup',
  // Set QUICK_OBS_CLOUDWATCH=false to save the CloudWatch ingestion cost and rely on
  // S3 alone. On by default because a log stream appearing within seconds is the
  // quickest possible confirmation that delivery is actually working.
  deliverToCloudWatch: (process.env.QUICK_OBS_CLOUDWATCH ?? 'true').toLowerCase() !== 'false',
});

const assets = new QuickObservabilityAssetsStack(app, `${PREFIX}-quick`, {
  env,
  description: 'Amazon Quick observability: Athena data source, datasets, dashboard, topic, space and chat agent',
  lakeBucket: pipeline.lakeBucket,
  key: pipeline.key,
  // Only set when reading a trail bucket this module does not own, so the Quick service
  // role can be granted read on it.
  auditBucketName: pipeline.auditBucketName,
});
// Explicit, because the dependency is on live Athena tables rather than on any
// CloudFormation value being passed between the stacks.
assets.addDependency(pipeline);

for (const [k, v] of Object.entries(TAGS)) {
  Tags.of(app).add(k, v);
}
