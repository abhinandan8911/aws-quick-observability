/**
 * The Quick layer: Athena data source, 5 direct-query datasets, two dashboards captured
 * verbatim from Amazon Quick, a topic, a Space and the chat agent.
 *
 * CloudFormation gaps that force custom resources:
 *   - `CfnTopic` has no `permissions` -> a CloudFormation-created topic has no owner.
 *   - `CfnAgent` has no `permissions` -> same for agents.
 * One Python Lambda serves both.
 */

import {
  CfnOutput,
  CfnResource,
  CustomResource,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as qs from 'aws-cdk-lib/aws-quicksight';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as custom from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import * as path from 'path';

import {
  ACCOUNT_ID,
  AGENT_OWNER_ACTIONS,
  DASHBOARD_OWNER_ACTIONS,
  DATASET_OWNER_ACTIONS,
  DATASOURCE_OWNER_ACTIONS,
  NAMES,
  OWNER_ARN,
  PREFIX,
  QUICK_SERVICE_ROLE_ARN,
  REGION,
  SPACE_OWNER_ACTIONS,
  TOPIC_OWNER_ACTIONS,
  TOPIC_REVISION,
  quickArn,
} from './config';
import { BOTO3_SPEC, buildBoto3Layer } from './boto3-layer';
import { DATASETS, datasetId } from './datasets';
import { CAPTURED_DASHBOARDS, resolveDashboard } from './dashboards';
import {
  AGENT_DESCRIPTION,
  AGENT_NAME,
  AGENT_STARTER_PROMPTS,
  AGENT_WELCOME_MESSAGE,
  TOPIC_CUSTOM_INSTRUCTIONS,
  topicDatasets,
} from './topic-definition';

export interface QuickAssetsStackProps extends StackProps {
  readonly lakeBucket: s3.IBucket;
  readonly key: kms.IKey;
  /**
   * Bucket holding CloudTrail logs when the audit source is a trail this module does not
   * own. Null when the audit data lives in our own lake, or when auditing is off.
   */
  readonly auditBucketName?: string | null;
}

export class QuickObservabilityAssetsStack extends Stack {
  constructor(scope: Construct, id: string, props: QuickAssetsStackProps) {
    super(scope, id, props);

    const { lakeBucket, key } = props;

    // -----------------------------------------------------------------------
    // Let the Quick service role read the lake through Athena
    // -----------------------------------------------------------------------
    // Quick queries Athena under the account-wide Quick service role, so that role
    // needs Athena, Glue and S3 access. Scoped to this database, workgroup and bucket
    // only — no wildcards, per ARCC least-privilege guidance.

    const quickRole = iam.Role.fromRoleArn(this, 'QuickServiceRole', QUICK_SERVICE_ROLE_ARN, {
      mutable: true,
    });

    quickRole.attachInlinePolicy(
      new iam.Policy(this, 'QuickAthenaAccess', {
        policyName: `${PREFIX}-quick-athena-access`,
        statements: [
          new iam.PolicyStatement({
            sid: 'AthenaQuery',
            actions: [
              'athena:StartQueryExecution',
              'athena:GetQueryExecution',
              'athena:GetQueryResults',
              'athena:GetQueryResultsStream',
              'athena:StopQueryExecution',
              'athena:GetWorkGroup',
              'athena:ListDataCatalogs',
              'athena:GetDataCatalog',
              'athena:ListDatabases',
              'athena:GetDatabase',
              'athena:ListTableMetadata',
              'athena:GetTableMetadata',
            ],
            resources: [
              `arn:aws:athena:${REGION}:${ACCOUNT_ID}:workgroup/${NAMES.athenaWorkgroup}`,
              `arn:aws:athena:${REGION}:${ACCOUNT_ID}:datacatalog/AwsDataCatalog`,
            ],
          }),
          new iam.PolicyStatement({
            sid: 'GlueCatalogRead',
            actions: [
              'glue:GetDatabase',
              'glue:GetDatabases',
              'glue:GetTable',
              'glue:GetTables',
              'glue:GetPartition',
              'glue:GetPartitions',
              'glue:BatchGetPartition',
            ],
            resources: [
              `arn:aws:glue:${REGION}:${ACCOUNT_ID}:catalog`,
              `arn:aws:glue:${REGION}:${ACCOUNT_ID}:database/${NAMES.glueDatabase}`,
              `arn:aws:glue:${REGION}:${ACCOUNT_ID}:table/${NAMES.glueDatabase}/*`,
            ],
          }),
          new iam.PolicyStatement({
            sid: 'LakeRead',
            actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket', 's3:GetBucketLocation'],
            resources: [lakeBucket.bucketArn, lakeBucket.arnForObjects('*')],
          }),
          new iam.PolicyStatement({
            // Athena writes result sets back to the lake, so this one needs write.
            sid: 'AthenaResultsWrite',
            actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
            resources: [lakeBucket.arnForObjects(`${NAMES.athenaResultsPrefix}/*`)],
          }),
          new iam.PolicyStatement({
            sid: 'LakeDecrypt',
            actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:GenerateDataKey'],
            resources: [key.keyArn],
          }),
          /**
           * NO GRANT ON THE CLOUDTRAIL BUCKET. This omission is deliberate and is the
           * point of the materialise design.
           *
           * An earlier version granted the Quick service role `s3:GetObject` on the whole
           * trail bucket so a direct-query dataset could read it. That handed Quick read
           * access to every CloudTrail log in the account — IAM, STS, KMS, S3, EC2 — and
           * a CloudTrail file interleaves services, so it cannot be narrowed by prefix.
           *
           * Instead the scheduled filter query (running as its own role in the pipeline
           * stack) reads the trail and writes only `quicksight.amazonaws.com` rows into
           * this module's lake. Quick reads the lake and nothing else, so non-Quick
           * activity is not merely hidden from the dashboard — it is unreachable.
           *
           * `auditBucketName` is still passed in so this stack can assert the invariant
           * rather than silently drift back.
           */
        ],
      }),
    );

    if (props.auditBucketName) {
      // Fail the synth if anyone re-adds a trail-bucket grant above, since the whole
      // Quick-only guarantee rests on its absence.
      const granted = JSON.stringify(
        (this.node.tryFindChild('QuickAthenaAccess') as iam.Policy | undefined)?.document.toJSON() ?? {},
      );
      if (granted.includes(props.auditBucketName)) {
        throw new Error(
          `The Quick service role must NOT be granted access to the CloudTrail bucket ` +
            `"${props.auditBucketName}". A trail contains the whole account's activity and ` +
            `cannot be filtered by prefix, so granting it would expose non-Quick data to Quick. ` +
            `Quick reads only the materialised, Quick-only table in the lake.`,
        );
      }
    }

    // -----------------------------------------------------------------------
    // Athena data source
    // -----------------------------------------------------------------------

    const dataSource = new qs.CfnDataSource(this, 'AthenaSource', {
      awsAccountId: ACCOUNT_ID,
      dataSourceId: NAMES.athenaDataSource,
      name: 'Quick Observability (Athena)',
      type: 'ATHENA',
      dataSourceParameters: {
        athenaParameters: { workGroup: NAMES.athenaWorkgroup },
      },
      sslProperties: { disableSsl: false },
      permissions: [{ principal: OWNER_ARN, actions: DATASOURCE_OWNER_ACTIONS }],
    });

    // -----------------------------------------------------------------------
    // Datasets
    // -----------------------------------------------------------------------

    const datasetArns = new Map<string, string>();
    const datasetResources: qs.CfnDataSet[] = [];
    const datasetResourceByKey = new Map<string, qs.CfnDataSet>();

    for (const spec of DATASETS) {
      const dsId = datasetId(spec);
      datasetArns.set(spec.key, quickArn('dataset', dsId));

      const ds = new qs.CfnDataSet(this, `${pascal(spec.key)}DataSet`, {
        awsAccountId: ACCOUNT_ID,
        dataSetId: dsId,
        name: spec.displayName,
        // Direct query so the dashboard is current without an ingestion schedule.
        importMode: 'DIRECT_QUERY',
        physicalTableMap: {
          // Map keys must match [0-9a-zA-Z-]*. Underscores are rejected.
          src: {
            customSql: {
              dataSourceArn: dataSource.attrArn,
              name: spec.displayName,
              sqlQuery: spec.sql,
              columns: spec.columns.map((c) => ({ name: c.name, type: athenaType(c.type) })),
            },
          },
        },
        logicalTableMap: {
          main: {
            alias: spec.displayName,
            source: { physicalTableId: 'src' },
            // Rename to the business-friendly names the dashboard and topic use.
            dataTransforms: spec.columns
              .filter((c) => c.name !== c.friendly)
              .map((c) => ({ renameColumnOperation: { columnName: c.name, newColumnName: c.friendly } })),
          },
        },
        permissions: [{ principal: OWNER_ARN, actions: DATASET_OWNER_ACTIONS }],
      });
      ds.addDependency(dataSource);
      datasetResources.push(ds);
      datasetResourceByKey.set(spec.key, ds);
    }

    // -----------------------------------------------------------------------
    // Dashboards
    // -----------------------------------------------------------------------
    //
    // Two dashboards, each captured verbatim from Amazon Quick (see lib/dashboards.ts):
    //
    //   pulse       "Quick Pulse: Admin Observability"  adoption, answer quality, API audit
    //   operations  "Quick Observability Dashboard"     agent-hour cost, index storage, KB sync
    //
    // The captured JSON is CloudFormation's own `Definition` shape, so it is injected raw via
    // a low-level CfnResource rather than reshaped into the L1's camelCase props — that keeps
    // the freeform layout, theme, calculated fields and conditional formatting byte-for-byte.
    // `resolveDashboard` binds each dataset identifier in the definition to the ARN this stack
    // created above.

    const dashboardIdByKey: Record<string, string> = {
      pulse: NAMES.pulseDashboard,
      operations: NAMES.opsDashboard,
    };

    const dashboards: CfnResource[] = [];
    for (const cap of CAPTURED_DASHBOARDS) {
      const resolved = resolveDashboard(cap, datasetArns);
      const dashboardId = dashboardIdByKey[cap.key];
      if (!dashboardId) throw new Error(`No dashboard id configured in NAMES for "${cap.key}".`);

      const dashboard = new CfnResource(this, `${pascal(cap.key)}Dashboard`, {
        type: 'AWS::QuickSight::Dashboard',
        properties: {
          AwsAccountId: ACCOUNT_ID,
          DashboardId: dashboardId,
          Name: resolved.name,
          ThemeArn: resolved.themeArn,
          DashboardPublishOptions: resolved.publishOptions,
          Definition: resolved.definition,
          Permissions: [{ Principal: OWNER_ARN, Actions: DASHBOARD_OWNER_ACTIONS }],
        },
      });
      // Depend on every dataset the dashboard binds to; a dashboard version fails to create
      // if a referenced dataset does not yet exist.
      for (const key of resolved.datasetKeys) {
        const ds = datasetResourceByKey.get(key);
        if (ds) dashboard.addDependency(ds);
      }
      dashboards.push(dashboard);
    }

    // -----------------------------------------------------------------------
    // Topic
    // -----------------------------------------------------------------------

    /**
     * The construct id carries the revision, so bumping `TOPIC_REVISION` changes the
     * **logical** id and not merely the physical one.
     *
     * Changing only `topicId` was not enough: CloudFormation still attempted an in-place
     * update and failed, so `TopicId` is evidently treated as mutable. A new logical id is
     * unambiguous — CloudFormation creates the new topic and deletes the old one, never
     * calling the broken update path.
     *
     * This matters because `AWS::QuickSight::Topic` cannot be updated at all: the handler
     * returns a bare `Resource handler returned message: "null"` on update *and* on
     * rollback, which wedges the stack in UPDATE_ROLLBACK_FAILED and needs
     * `continue-update-rollback --resources-to-skip Topic` to recover. Replacement avoids
     * the whole failure mode.
     */
    const topic = new qs.CfnTopic(this, `TopicV${TOPIC_REVISION}`, {
      awsAccountId: ACCOUNT_ID,
      topicId: NAMES.topic,
      name: 'Quick Observability',
      description: 'Natural-language operational questions about this Amazon Quick account.',
      // Required: the service rejects custom instructions on a legacy topic.
      userExperienceVersion: 'NEW_READER_EXPERIENCE',
      dataSets: topicDatasets((k) => datasetArns.get(k)!),
      customInstructions: { customInstructionsString: TOPIC_CUSTOM_INSTRUCTIONS },
    });
    for (const ds of datasetResources) topic.addDependency(ds);

    // -----------------------------------------------------------------------
    // Custom resource provider for the CloudFormation permission gaps
    // -----------------------------------------------------------------------

    // The runtime's bundled boto3 has no update_agent_permissions, so pin it.
    const boto3Layer = new lambda.LayerVersion(this, 'Boto3Layer', {
      layerVersionName: `${PREFIX}-boto3`,
      code: lambda.Code.fromAsset(buildBoto3Layer()),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: `Pinned ${BOTO3_SPEC} — the Python 3.12 runtime's boto3 predates the Quick Agents API`,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const provisioner = new lambda.Function(this, 'Provisioner', {
      functionName: `${PREFIX}-provisioner`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.on_event',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'provisioner')),
      layers: [boto3Layer],
      timeout: Duration.minutes(5),
      memorySize: 512,
      description: 'Sets owner permissions on the Quick topic and agent, which CloudFormation cannot express',
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    provisioner.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'QuickPermissionManagement',
        actions: [
          'quicksight:DescribeTopic',
          'quicksight:DescribeTopicPermissions',
          'quicksight:UpdateTopicPermissions',
          'quicksight:DescribeAgent',
          'quicksight:DescribeAgentPermissions',
          'quicksight:UpdateAgentPermissions',
        ],
        resources: [
          `arn:aws:quicksight:${REGION}:${ACCOUNT_ID}:topic/${PREFIX}-*`,
          `arn:aws:quicksight:${REGION}:${ACCOUNT_ID}:agent/${PREFIX}-*`,
        ],
      }),
    );

    const provider = new custom.Provider(this, 'ProvisionerProvider', {
      onEventHandler: provisioner,
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    const topicPermissions = new CustomResource(this, 'TopicPermissions', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::TopicPermissions',
      properties: {
        Kind: 'TopicPermissions',
        AwsAccountId: ACCOUNT_ID,
        Region: REGION,
        TopicId: NAMES.topic,
        Principal: OWNER_ARN,
        Actions: TOPIC_OWNER_ACTIONS,
      },
    });
    topicPermissions.node.addDependency(topic);

    // -----------------------------------------------------------------------
    // Space and agent
    // -----------------------------------------------------------------------

    const space = new qs.CfnSpace(this, 'Space', {
      awsAccountId: ACCOUNT_ID,
      spaceId: NAMES.space,
      name: 'Quick Observability',
      description: 'Operational telemetry for this Amazon Quick account.',
      // CreateSpace leaves an empty permission set, so the Space would be orphaned
      // without this.
      permissions: [{ principal: OWNER_ARN, actions: SPACE_OWNER_ACTIONS }],
      // Property is `resources`, not `spaceResources`.
      resources: [
        ...Object.values(dashboardIdByKey).map((id) => ({
          resourceArn: quickArn('dashboard', id),
          resourceType: 'DASHBOARD',
        })),
        { resourceArn: quickArn('topic', NAMES.topic), resourceType: 'TOPIC' },
        ...DATASETS.map((spec) => ({
          resourceArn: datasetArns.get(spec.key)!,
          resourceType: 'DATA_SET',
        })),
      ],
    });
    for (const dashboard of dashboards) space.addDependency(dashboard);
    space.addDependency(topic);
    for (const ds of datasetResources) space.addDependency(ds);

    const agent = new qs.CfnAgent(this, 'Agent', {
      awsAccountId: ACCOUNT_ID,
      agentId: NAMES.agent,
      name: AGENT_NAME,
      description: AGENT_DESCRIPTION,
      welcomeMessage: AGENT_WELCOME_MESSAGE,
      starterPrompts: AGENT_STARTER_PROMPTS,
      agentLifecycle: 'PUBLISHED',
      spaces: [quickArn('space', NAMES.space)],
    });
    agent.addDependency(space);

    const agentPermissions = new CustomResource(this, 'AgentPermissions', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::AgentPermissions',
      properties: {
        Kind: 'AgentPermissions',
        AwsAccountId: ACCOUNT_ID,
        Region: REGION,
        AgentId: NAMES.agent,
        Principal: OWNER_ARN,
        Actions: AGENT_OWNER_ACTIONS,
      },
    });
    agentPermissions.node.addDependency(agent);

    // -----------------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------------

    const console = `https://${REGION}.quicksight.aws.amazon.com/sn/start`;
    new CfnOutput(this, 'PulseDashboardUrl', {
      value: `${console}/dashboards/${NAMES.pulseDashboard}`,
      description: 'Quick Pulse: Admin Observability (adoption, answer quality, API audit)',
    });
    new CfnOutput(this, 'ObservabilityDashboardUrl', {
      value: `${console}/dashboards/${NAMES.opsDashboard}`,
      description: 'Quick Observability Dashboard (agent-hour cost, index storage, KB sync)',
    });
    new CfnOutput(this, 'AgentsListUrl', {
      value: `${console}/agents?filter=all-agents`,
      description: 'Chat agents. Use the "All chat agents" filter — a CloudFormation-created agent is not listed elsewhere.',
    });
    new CfnOutput(this, 'TopicId', { value: NAMES.topic, description: 'Quick topic for natural-language questions' });
    new CfnOutput(this, 'SpaceId', { value: NAMES.space, description: 'Space grounding the chat agent' });
    new CfnOutput(this, 'AgentId', { value: NAMES.agent, description: 'Chat agent id' });
    new CfnOutput(this, 'DataSetIds', {
      value: DATASETS.map((s) => datasetId(s)).join(','),
      description: 'Direct-query datasets over Athena',
    });
  }
}

function pascal(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Quick's dataset column types are a narrower set than Athena's. */
function athenaType(t: 'STRING' | 'INTEGER' | 'DECIMAL' | 'DATETIME'): string {
  return t;
}
