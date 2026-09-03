/**
 * The observability pipeline: log delivery, the S3 lake, and the Glue catalogue.
 *
 * Kept separate from the Quick assets stack because of a hard ordering dependency —
 * Quick datasets cannot be created over Athena tables that do not exist yet, and the
 * tables cannot be usefully queried until logs have actually arrived. Two stacks let
 * you deploy this one, generate traffic, and only then build the visuals.
 */

import {
  Aws,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Size,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import type { Construct } from 'constructs';

import {
  ACCOUNT_ID,
  AUDIT_S3_PREFIX,
  AUDIT_SOURCE,
  AUDIT_TABLE,
  INCLUDE_SENSITIVE_FIELDS,
  LOG_RETENTION_DAYS,
  LOG_TYPES,
  NAMES,
  PREFIX,
  MATERIALISE_LOOKBACK_HOURS,
  MATERIALISE_SCHEDULE,
  AUDIT_MATERIALISED_PREFIX,
  QUICK_ACCOUNT_ARN,
  QUICK_EVENT_SOURCE,
  RAW_TRAIL_TABLE,
  REGION,
  TRAIL_ACCOUNT_ID,
  TRAIL_BUCKET,
  logGroupName,
  s3Prefix,
  tableName,
  trailLocation,
  type LogType,
} from './config';
import { SCHEMAS, glueColumns, recordFields, serdeMapping } from './log-schemas';

export interface PipelineStackProps extends StackProps {
  /** Also deliver to CloudWatch Logs, for live Logs Insights and fast delivery checks. */
  readonly deliverToCloudWatch?: boolean;
}

export class QuickObservabilityPipelineStack extends Stack {
  readonly lakeBucket: s3.Bucket;
  readonly key: kms.Key;
  readonly database: glue.CfnDatabase;
  // Assigned by buildWorkgroup(), called from the constructor. Not `readonly` because
  // the build is split across methods for legibility rather than done inline.
  workgroup!: athena.CfnWorkGroup;

  constructor(scope: Construct, id: string, props: PipelineStackProps = {}) {
    super(scope, id, props);

    const deliverToCloudWatch = props.deliverToCloudWatch ?? true;

    // -----------------------------------------------------------------------
    // Encryption key
    // -----------------------------------------------------------------------

    this.key = new kms.Key(this, 'LogsKey', {
      alias: NAMES.kmsAlias,
      description: 'Encrypts Amazon Quick observability logs at rest - S3 lake, log groups and Firehose',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY, // POC: production would RETAIN
      pendingWindow: Duration.days(7),
    });

    /**
     * Vended log delivery to S3 will not work without this, and gets it wrong quietly.
     *
     * The shape below is copied from the CloudWatch Logs documentation for delivery to
     * an SSE-KMS bucket ("Logs sent to Amazon S3" -> "Amazon S3 bucket server-side
     * encryption"): the full action set, gated on `aws:SourceAccount` plus an
     * `aws:SourceArn` that matches a delivery *source* in this account.
     *
     * An earlier version instead gated on
     * `kms:EncryptionContext:SourceArn = arn:aws:logs:<region>:<account>:*`, which never
     * matches. When the delivery service encrypts an S3 object it passes the S3
     * encryption context (`aws:s3:arn`), not a logs ARN, so the condition failed, the
     * Allow never applied, and KMS denied every write. The symptom is invisible: the
     * deliveries report healthy, the CloudWatch mirror fills normally (it is covered by
     * the separate `AllowCloudWatchLogs` statement below), and the S3 prefixes stay
     * empty with no error surfaced anywhere. Same failure mode as the bucket-policy
     * `s3:x-amz-server-side-encryption` mistake noted further down: an over-tight
     * condition on a delivery path that reports success either way.
     *
     * `aws:SourceArn` still scopes this to this account's own deliveries, so it is no
     * broader than intended - it is simply the condition key that actually exists here.
     */
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowVendedLogDeliveryService',
        principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:SourceAccount': ACCOUNT_ID },
          ArnLike: { 'aws:SourceArn': `arn:aws:logs:${REGION}:${ACCOUNT_ID}:delivery-source:*` },
        },
      }),
    );

    // CloudWatch Logs needs to use the key for the log groups it writes into.
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        principals: [new iam.ServicePrincipal(`logs.${REGION}.amazonaws.com`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:*` },
        },
      }),
    );

    // -----------------------------------------------------------------------
    // S3 data lake
    // -----------------------------------------------------------------------

    this.lakeBucket = new s3.Bucket(this, 'LakeBucket', {
      bucketName: NAMES.lakeBucket,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      enforceSSL: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY, // POC
      autoDeleteObjects: true, // POC
      lifecycleRules: [
        {
          // ARCC SAX-06: 90 days immediately accessible, then cheaper tiers.
          id: 'log-retention-tiering',
          enabled: true,
          transitions: [
            { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: Duration.days(90) },
            { storageClass: s3.StorageClass.DEEP_ARCHIVE, transitionAfter: Duration.days(365) },
          ],
        },
        {
          // Athena result spillage is disposable; do not archive it.
          id: 'expire-athena-results',
          enabled: true,
          prefix: `${NAMES.athenaResultsPrefix}/`,
          expiration: Duration.days(30),
        },
        { id: 'abort-incomplete-uploads', enabled: true, abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ],
    });

    /**
     * Let the log delivery service write, and require it to encrypt with our key.
     *
     * The `aws:SourceAccount` condition is what stops another account naming this
     * bucket as its delivery destination.
     */
    this.lakeBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowVendedLogDeliveryWrite',
        principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [this.lakeBucket.arnForObjects('*')],
        // Scoped to this account only, so another account cannot name this bucket as
        // its delivery destination.
        //
        // Deliberately NOT also conditioned on `s3:x-amz-server-side-encryption`.
        // That condition key only exists when the caller *explicitly* requests
        // encryption on the PutObject; the delivery service relies on the bucket's
        // default encryption instead, so the key is absent, the condition fails, the
        // Allow never applies and every put is denied. That produced exactly the
        // symptom seen here on the first deploy: deliveries reported healthy, log
        // streams filling in CloudWatch, and zero objects in S3, with no error
        // surfaced anywhere.
        //
        // Encryption is still guaranteed: the bucket sets KMS default encryption with
        // this CMK, and `enforceSSL` denies any non-TLS request.
        conditions: { StringEquals: { 'aws:SourceAccount': ACCOUNT_ID } },
      }),
    );
    this.lakeBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowVendedLogDeliveryAclCheck',
        principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
        actions: ['s3:GetBucketAcl', 's3:ListBucket'],
        resources: [this.lakeBucket.bucketArn],
        conditions: { StringEquals: { 'aws:SourceAccount': ACCOUNT_ID } },
      }),
    );

    // -----------------------------------------------------------------------
    // Vended log delivery: one source per log type, fanned out to destinations
    // -----------------------------------------------------------------------

    /**
     * One `DeliverySource` per log type. Note the account-level constraint discovered
     * by probing: there can be only ONE delivery source per (resourceArn, logType) in
     * an account. If the target account already has Quick logging configured, these
     * fail with ConflictException — which is why `npm run preflight` checks first.
     *
     * `CfnDelivery` is used rather than an L2 because no L2 exists for vended log
     * delivery in aws-cdk-lib 2.267.0.
     */
    for (const logType of LOG_TYPES) {
      const schema = SCHEMAS[logType];
      const idBase = pascal(logType);

      const source = new logs.CfnDeliverySource(this, `${idBase}Source`, {
        name: `${PREFIX}-${logType.toLowerCase()}`,
        logType,
        resourceArn: QUICK_ACCOUNT_ARN,
      });

      // --- S3 destination: the analytics path -----------------------------
      const s3Dest = new logs.CfnDeliveryDestination(this, `${idBase}S3Dest`, {
        name: `${PREFIX}-${logType.toLowerCase()}-s3`,
        destinationResourceArn: `${this.lakeBucket.bucketArn}/${s3Prefix(logType)}`,
        outputFormat: 'json',
      });
      s3Dest.node.addDependency(this.lakeBucket);

      const s3Delivery = new logs.CfnDelivery(this, `${idBase}S3Delivery`, {
        deliverySourceName: source.name,
        deliveryDestinationArn: s3Dest.attrArn,
        // Privacy by default: sensitive fields are omitted unless explicitly enabled.
        recordFields: recordFields(logType, INCLUDE_SENSITIVE_FIELDS),
        s3EnableHiveCompatiblePath: true,
      });
      s3Delivery.addDependency(source);
      s3Delivery.addDependency(s3Dest);

      // --- CloudWatch destination: the live path ---------------------------
      // Optional. Cheap at these volumes and the fastest way to confirm delivery is
      // working at all, because log streams appear within seconds whereas S3 buffers.
      if (deliverToCloudWatch) {
        const group = new logs.LogGroup(this, `${idBase}LogGroup`, {
          logGroupName: logGroupName(logType),
          retention: toRetention(LOG_RETENTION_DAYS),
          encryptionKey: this.key,
          removalPolicy: RemovalPolicy.DESTROY,
        });
        group.node.addDependency(this.key);

        const cwDest = new logs.CfnDeliveryDestination(this, `${idBase}CwDest`, {
          name: `${PREFIX}-${logType.toLowerCase()}-cwl`,
          destinationResourceArn: group.logGroupArn,
          outputFormat: 'json',
        });
        cwDest.node.addDependency(group);

        const cwDelivery = new logs.CfnDelivery(this, `${idBase}CwDelivery`, {
          deliverySourceName: source.name,
          deliveryDestinationArn: cwDest.attrArn,
          recordFields: recordFields(logType, INCLUDE_SENSITIVE_FIELDS),
        });
        cwDelivery.addDependency(source);
        cwDelivery.addDependency(cwDest);
        // Serialise the two deliveries from the same source. Creating both at once
        // occasionally races on the shared source.
        cwDelivery.addDependency(s3Delivery);
      }

      void schema;
    }

    // -----------------------------------------------------------------------
    // Quick API audit events
    // -----------------------------------------------------------------------
    // Four strategies, selected by QUICK_OBS_AUDIT_SOURCE. See config.ts for why
    // `existing-trail` is the default: EventBridge does not deliver read-only CloudTrail
    // events, and reads were 55 of 57 Quick API events in a sampled window — so the
    // EventBridge path sees about 3.5% of the activity.

    this.auditLocation = this.buildAuditSource();

    // -----------------------------------------------------------------------
    // Glue catalogue
    // -----------------------------------------------------------------------

    this.database = new glue.CfnDatabase(this, 'Database', {
      catalogId: Aws.ACCOUNT_ID,
      databaseInput: {
        name: NAMES.glueDatabase,
        description: 'Amazon Quick observability: vended usage logs and API audit events',
        locationUri: `s3://${this.lakeBucket.bucketName}/`,
      },
    });

    // Order matters: the Athena workgroup must exist before the audit path, because the
    // materialise schedule runs its filter query inside that workgroup.
    this.buildVendedTables();
    this.buildWorkgroup();
    this.buildAuditTable();
    this.buildOutputs();
  }

  // =========================================================================
  // Audit source
  // =========================================================================

  /** S3 location the audit table reads, or null when auditing is disabled. */
  private auditLocation: string | null = null;

  /** Bucket the audit table reads, when it is not this module's own lake. */
  private externalAuditBucket: string | null = null;

  /** Exposed so the Quick stack can grant read access to an external trail bucket. */
  get auditBucketName(): string | null {
    return this.externalAuditBucket;
  }

  private buildAuditSource(): string | null {
    switch (AUDIT_SOURCE) {
      case 'none':
        return null;

      case 'existing-trail': {
        // Nothing to create. The trail already exists and already writes to S3, so this
        // is purely a read: a Glue table over someone else's bucket.
        //
        // This is why it is the default — zero new infrastructure, zero extra cost, and
        // it captures read-only events that no EventBridge rule can see.
        this.externalAuditBucket = TRAIL_BUCKET;
        return trailLocation(TRAIL_BUCKET);
      }

      case 'own-trail': {
        // For an account with no usable trail. Costs a second copy of management events.
        //
        // Management events cannot be narrowed to a single service: advanced event
        // selectors only support `eventCategory` and `readOnly` for management events,
        // not `eventSource`. So this captures everything and the Quick filter happens at
        // query time instead.
        const trail = new cloudtrail.Trail(this, 'AuditTrail', {
          bucket: this.lakeBucket,
          s3KeyPrefix: AUDIT_S3_PREFIX,
          isMultiRegionTrail: true,
          includeGlobalServiceEvents: true,
          // ARCC SAX-08 asks for log file validation, which CloudTrail gives natively
          // and the Firehose path cannot.
          enableFileValidation: true,
          managementEvents: cloudtrail.ReadWriteType.ALL,
          encryptionKey: this.key,
        });
        this.externalAuditBucket = null;
        // Trail prefixes are nested under the key prefix, then the standard layout.
        return `s3://${this.lakeBucket.bucketName}/${AUDIT_S3_PREFIX}/AWSLogs/${TRAIL_ACCOUNT_ID}/CloudTrail`;
      }

      case 'eventbridge':
        return this.buildEventBridgeAuditPath();
    }
  }

  /**
   * EventBridge -> Firehose -> S3.
   *
   * Retained as an option, not the default. It needs a Firehose stream, an EventBridge
   * rule, a delivery role, a target role and a KMS grant on the producer — five moving
   * parts to capture strictly less data than reading a trail. Every one of the comments
   * below records a way it failed silently while being built.
   */
  private buildEventBridgeAuditPath(): string {
    const firehoseRole = new iam.Role(this, 'AuditFirehoseRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
      description: 'Lets the Quick API audit Firehose stream write to the observability lake',
    });

    /**
     * The L2 `DeliveryStream`, not `CfnDeliveryStream`, specifically because of
     * stream-level encryption.
     *
     * With a customer-managed CMK on the stream, the *producer* of each record needs
     * `kms:GenerateDataKey` on that key. The L1 plus the deprecated
     * `KinesisFirehoseStream` event target could not express this: the target
     * auto-creates its own IAM role, accepts no role override, and CDK cannot know it
     * needs KMS. The result was a rule that matched events and failed every single
     * invocation — 17 matched, 17 FailedInvocations, 0 IncomingRecords — with no error
     * anywhere except those CloudWatch metrics.
     *
     * The L2 exposes `grantPutRecords()`, which grants the Firehose actions *and* the
     * key permissions together, so the encryption and the grant cannot drift apart.
     */
    const auditStream = new firehose.DeliveryStream(this, 'AuditStream', {
      // Intentionally unnamed, so CloudFormation generates the physical name.
      //
      // A fixed name makes any change that replaces this resource fail: CloudFormation
      // creates the replacement before deleting the original, and the two collide on
      // the name. That is exactly what happened when this moved from the L1 to the L2
      // construct — "already exists" on a stream the same stack owned. A generated name
      // makes future refactors safe. The real name is published as a stack output.
      encryption: firehose.StreamEncryption.customerManagedKey(this.key),
      destination: new firehose.S3Bucket(this.lakeBucket, {
        role: firehoseRole,
        dataOutputPrefix: `${AUDIT_S3_PREFIX}/`,
        errorOutputPrefix: `${AUDIT_S3_PREFIX}-errors/`,
        // Flushes on whichever limit comes first. Quick API volume is low, so in
        // practice this is a ~5 minute lag from API call to queryable in Athena.
        bufferingInterval: Duration.seconds(300),
        bufferingSize: Size.mebibytes(64),
        compression: firehose.Compression.GZIP,
        encryptionKey: this.key,
        loggingConfig: new firehose.EnableLogging(
          new logs.LogGroup(this, 'AuditFirehoseErrors', {
            logGroupName: `/aws/kinesisfirehose/${NAMES.auditFirehose}`,
            retention: toRetention(LOG_RETENTION_DAYS),
            removalPolicy: RemovalPolicy.DESTROY,
          }),
        ),
      }),
    });

    // Match every Quick/QuickSight API call. The service still reports itself as
    // `aws.quicksight` in CloudTrail regardless of the Quick Suite rebrand.
    const auditRule = new events.Rule(this, 'QuickApiEventsRule', {
      ruleName: NAMES.auditEventRule,
      description: 'Routes Amazon Quick API calls from CloudTrail to the observability lake',
      eventPattern: {
        source: ['aws.quicksight'],
        detailType: ['AWS API Call via CloudTrail'],
      },
    });

    auditRule.addTarget(new targets.FirehoseDeliveryStream(auditStream));

    /**
     * Grant the EventBridge target role use of the CMK.
     *
     * This is the actual fix for the silent failure, and it is not something CDK does
     * for you. When a Firehose stream is encrypted with a customer managed key, the
     * *producer* of each record needs `kms:GenerateDataKey` on that key. Neither the
     * event target nor `DeliveryStream.grantPutRecords()` grants it — verified by
     * reading the role's inline policy after deploy, which contained only
     * `firehose:PutRecord` and `firehose:PutRecordBatch`.
     *
     * The symptom is nasty: the rule matches, EventBridge reports `Invocations` climbing
     * *and* `FailedInvocations` climbing by the same amount, Firehose reports zero
     * `IncomingRecords`, and nothing appears in any log. Those two CloudWatch metrics
     * are the only evidence.
     *
     * The target creates its role via `singletonEventRole()`, which attaches it as a
     * child of the stream construct under the id `EventsRole`, so it can be reached
     * after `addTarget` and granted directly. Asserting it was found matters: if a
     * future CDK renames that child, this must fail loudly at synth rather than
     * silently reintroduce the original bug.
     */
    const eventsRole = auditStream.node.tryFindChild('EventsRole') as iam.IRole | undefined;
    if (!eventsRole) {
      throw new Error(
        "Could not find the EventBridge target's 'EventsRole' on the Firehose stream. " +
          'Without kms:GenerateDataKey on the delivery CMK every rule invocation fails ' +
          'silently, so this is fatal rather than a warning. Check how the CDK version ' +
          'in use names the singleton event role.',
      );
    }
    this.key.grantEncryptDecrypt(eventsRole);

    new CfnOutput(this, 'AuditFirehoseName', {
      value: auditStream.deliveryStreamName,
      description: 'Firehose stream carrying Quick API audit events from EventBridge to the lake',
    });

    return `s3://${this.lakeBucket.bucketName}/${AUDIT_S3_PREFIX}`;
  }

  // =========================================================================
  // Glue tables
  // =========================================================================

  private buildVendedTables(): void {
    for (const logType of LOG_TYPES) {
      const cols = glueColumns(logType, INCLUDE_SENSITIVE_FIELDS);
      const table = new glue.CfnTable(this, `${pascal(logType)}Table`, {
        catalogId: Aws.ACCOUNT_ID,
        databaseName: NAMES.glueDatabase,
        tableInput: {
          name: tableName(logType),
          description: SCHEMAS[logType].purpose,
          tableType: 'EXTERNAL_TABLE',
          parameters: {
            classification: 'json',
            // No partitions. The delivered S3 layout could not be confirmed by probing, and Athena scans sub-prefixes recursively, so
            // an unpartitioned table is correct whatever layout the service uses.
            // `event_timestamp` is on every record, so time filtering needs no
            // partitions. Revisit as an optimisation once real paths are observed.
            'projection.enabled': 'false',
          },
          storageDescriptor: {
            location: `s3://${this.lakeBucket.bucketName}/${s3Prefix(logType)}/`,
            inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
            outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
            compressed: true,
            columns: cols.map((c) => ({ name: c.name.toLowerCase(), type: c.type, comment: c.description })),
            serdeInfo: {
              serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
              parameters: {
                // Vended logs sometimes wrap records; never fail a whole file on one
                // bad line, and never fail on a field the docs have not caught up with.
                'ignore.malformed.json': 'true',
                'dots.in.keys': 'false',
                // Restores camelCase source fields that Athena would otherwise
                // lower-case and fail to find. See serdeMapping() for why.
                ...serdeMapping(logType, INCLUDE_SENSITIVE_FIELDS),
              },
            },
          },
        },
      });
      table.addDependency(this.database);
    }

  }

  /**
   * The Quick API audit table.
   *
   * Its shape depends on the source, because the two produce genuinely different files:
   *
   *   - CloudTrail writing to S3 produces `{"Records":[ ... ]}` — one object per file
   *     containing an array. That needs `CloudTrailSerde`, which understands the
   *     `Records` wrapper. A plain JSON SerDe reads zero rows from it, silently.
   *   - EventBridge -> Firehose produces one EventBridge envelope per line, with the
   *     CloudTrail record nested under `detail`.
   *
   * So `eventbridge` gets a nested table and everything else gets the flat CloudTrail
   * table. `lib/datasets.ts` has matching SQL for each, and the dashboard and topic see
   * an identical set of columns either way.
   */
  private buildAuditTable(): void {
    if (!this.auditLocation) return;

    if (AUDIT_SOURCE === 'eventbridge') {
      // Already Quick-only: the EventBridge rule matches `source: aws.quicksight`, so
      // nothing else ever reaches the lake. No filtering needed.
      this.eventBridgeAuditTable().addDependency(this.database);
      return;
    }

    // CloudTrail: raw table in the raw database, then a scheduled query that copies only
    // Quick events into the Quick-visible database.
    const rawDb = new glue.CfnDatabase(this, 'RawDatabase', {
      catalogId: Aws.ACCOUNT_ID,
      databaseInput: {
        name: NAMES.rawGlueDatabase,
        description:
          'Raw CloudTrail, account-wide. Deliberately separate from the Quick database so ' +
          'non-Quick activity is never reachable from Quick.',
      },
    });
    const raw = this.rawTrailTable();
    raw.addDependency(rawDb);

    const materialised = this.quickOnlyAuditTable();
    materialised.addDependency(this.database);

    this.buildMaterialiseSchedule(materialised, raw);
  }

  /**
   * The Quick-only audit table. This is the only audit table Quick can see.
   *
   * Columns are the already-projected logical contract rather than raw CloudTrail fields,
   * so the filter query does the shaping once and the dataset SQL stays a plain SELECT.
   * That also means non-Quick data cannot leak through an unshaped column.
   */
  private quickOnlyAuditTable(): glue.CfnTable {
    return new glue.CfnTable(this, 'AuditTable', {
      catalogId: Aws.ACCOUNT_ID,
      databaseName: NAMES.glueDatabase,
      tableInput: {
        name: AUDIT_TABLE,
        description:
          `Amazon Quick API calls only (eventSource = ${QUICK_EVENT_SOURCE}), filtered out of ` +
          'CloudTrail hourly. Includes read-only events.',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          classification: 'parquet',
          'parquet.compression': 'SNAPPY',
        },
        storageDescriptor: {
          location: `s3://${this.lakeBucket.bucketName}/${AUDIT_MATERIALISED_PREFIX}/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          compressed: true,
          columns: [
            { name: 'event_id', type: 'string', comment: 'CloudTrail event id. Used to de-duplicate overlapping filter runs.' },
            { name: 'event_time', type: 'timestamp', comment: 'When the API call was made.' },
            { name: 'event_name', type: 'string', comment: 'Quick API operation, e.g. CreateAgent.' },
            { name: 'event_source', type: 'string', comment: `Always ${QUICK_EVENT_SOURCE}.` },
            { name: 'actor', type: 'string', comment: 'IAM principal that made the call.' },
            { name: 'actor_type', type: 'string', comment: 'CloudTrail identity type, e.g. AssumedRole.' },
            { name: 'source_ip', type: 'string', comment: 'Caller IP, or an AWS service name.' },
            { name: 'user_agent', type: 'string', comment: 'Client that made the call.' },
            { name: 'error_code', type: 'string', comment: 'Error code, or None.' },
            { name: 'error_message', type: 'string', comment: 'Error message, or None.' },
            { name: 'is_read_only', type: 'string', comment: 'Yes for a read, No for a change.' },
            { name: 'operation_kind', type: 'string', comment: 'Create, Update, Delete, Read or Other.' },
            { name: 'aws_region', type: 'string', comment: 'Region the call was made in.' },
          ],
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
            parameters: { 'serialization.format': '1' },
          },
        },
      },
    });
  }

  /**
   * Hourly Athena query that copies Quick events out of the raw trail into the lake.
   *
   * EventBridge Scheduler calls `athena:StartQueryExecution` directly as a universal
   * target, so there is **no Lambda** — the whole filter is one SQL statement in the
   * schedule's input.
   *
   * Overlapping windows are deliberate: the lookback is longer than the interval so a
   * missed run self-heals. That produces duplicate rows, which the dataset removes by
   * `event_id`. Choosing dedupe-on-read over exactly-once writes keeps the pipeline
   * stateless — there is no watermark to get wrong.
   */
  private buildMaterialiseSchedule(target: glue.CfnTable, raw: glue.CfnTable): void {
    const role = new iam.Role(this, 'MaterialiseRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Runs the hourly Athena query that filters Quick events out of CloudTrail',
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AthenaExecute',
        actions: [
          'athena:StartQueryExecution',
          'athena:GetQueryExecution',
          'athena:GetQueryResults',
          'athena:GetWorkGroup',
        ],
        resources: [`arn:aws:athena:${REGION}:${ACCOUNT_ID}:workgroup/${NAMES.athenaWorkgroup}`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'GlueBothDatabases',
        actions: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetTables', 'glue:GetPartitions', 'glue:BatchCreatePartition', 'glue:UpdateTable'],
        resources: [
          `arn:aws:glue:${REGION}:${ACCOUNT_ID}:catalog`,
          `arn:aws:glue:${REGION}:${ACCOUNT_ID}:database/${NAMES.glueDatabase}`,
          `arn:aws:glue:${REGION}:${ACCOUNT_ID}:database/${NAMES.rawGlueDatabase}`,
          `arn:aws:glue:${REGION}:${ACCOUNT_ID}:table/${NAMES.glueDatabase}/*`,
          `arn:aws:glue:${REGION}:${ACCOUNT_ID}:table/${NAMES.rawGlueDatabase}/*`,
        ],
      }),
    );
    // This role — not Quick — is the only identity granted the trail bucket.
    if (this.externalAuditBucket) {
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'RawTrailRead',
          actions: ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation'],
          resources: [
            `arn:aws:s3:::${this.externalAuditBucket}`,
            `arn:aws:s3:::${this.externalAuditBucket}/*`,
          ],
        }),
      );
    }
    this.lakeBucket.grantReadWrite(role);
    this.key.grantEncryptDecrypt(role);

    /**
     * The filter itself.
     *
     * Two filters matter:
     *   1. `eventsource = quicksight` — the whole point. Nothing else is ever written.
     *   2. The partition predicates — a trail holds every management event in the account,
     *      so without date pruning each run would scan the entire history.
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
      >= CAST(date_format(current_date - interval '2' day, '%Y%m%d') AS integer)
  AND from_iso8601_timestamp(eventtime) >= current_timestamp - interval '${MATERIALISE_LOOKBACK_HOURS}' hour
`.trim();

    const schedule = new scheduler.CfnSchedule(this, 'MaterialiseSchedule', {
      name: NAMES.materialiseSchedule,
      description: `Hourly: copy ${QUICK_EVENT_SOURCE} events out of CloudTrail into ${AUDIT_TABLE}`,
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: MATERIALISE_SCHEDULE,
      state: 'ENABLED',
      target: {
        // Universal target: call the Athena SDK directly, no Lambda in between.
        arn: 'arn:aws:scheduler:::aws-sdk:athena:startQueryExecution',
        roleArn: role.roleArn,
        input: JSON.stringify({
          QueryString: sql,
          WorkGroup: NAMES.athenaWorkgroup,
          QueryExecutionContext: { Database: NAMES.glueDatabase },
        }),
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
      },
    });
    schedule.node.addDependency(target);
    schedule.node.addDependency(raw);
    schedule.node.addDependency(this.workgroupOrThrow());

    // Exposed so `npm run backfill` can run exactly the same statement over all history.
    this.materialiseSql = sql;
  }

  /** The filter SQL, so scripts can reuse it verbatim rather than reimplementing it. */
  materialiseSql: string | null = null;

  /**
   * The workgroup is built after the tables, but the schedule must not run before it
   * exists. Rather than reorder the build, depend on it explicitly and fail loudly if the
   * ordering ever changes.
   */
  private workgroupOrThrow(): athena.CfnWorkGroup {
    if (!this.workgroup) {
      throw new Error('Athena workgroup must be built before the materialise schedule.');
    }
    return this.workgroup;
  }

  /**
   * The raw CloudTrail table — in the **raw** database, never the Quick-visible one.
   *
   * This is the table that unavoidably contains the whole account's management activity,
   * because a CloudTrail file interleaves every service and a trail cannot be narrowed to
   * one `eventSource`. It exists only so the scheduled filter query has something to read.
   * Nothing in Quick is granted access to this database or to the trail bucket.
   */
  private rawTrailTable(): glue.CfnTable {
    return new glue.CfnTable(this, 'RawTrailTable', {
      catalogId: Aws.ACCOUNT_ID,
      databaseName: NAMES.rawGlueDatabase,
      tableInput: {
        name: RAW_TRAIL_TABLE,
        description:
          'Raw CloudTrail management events. Contains the whole account, not just Quick — ' +
          'read only by the scheduled filter that materialises Quick events into ' +
          `${NAMES.glueDatabase}.${AUDIT_TABLE}.`,
        tableType: 'EXTERNAL_TABLE',
        partitionKeys: [
          { name: 'region', type: 'string', comment: 'AWS Region partition.' },
          { name: 'year', type: 'string', comment: 'Year partition.' },
          { name: 'month', type: 'string', comment: 'Month partition.' },
          { name: 'day', type: 'string', comment: 'Day partition.' },
        ],
        parameters: {
          classification: 'cloudtrail',
          /**
           * Partition projection, which the vended tables deliberately do NOT use.
           *
           * The difference is knowledge: CloudTrail's layout is documented and stable
           * (`AWSLogs/<account>/CloudTrail/<region>/<yyyy>/<mm>/<dd>/`), verified by
           * listing the live bucket. The vended-log layout could not be confirmed, so
           * guessing a template there would have produced a table that silently returned
           * nothing.
           *
           * Projection matters more here than for the vended logs: a trail contains
           * every management event in the account, not just Quick's — 364 records for 57
           * Quick ones in a sampled window — so date pruning is what keeps scan cost
           * sane.
           */
          'projection.enabled': 'true',
          'projection.region.type': 'enum',
          // Only this Region. Quick is regional and its log delivery is per Region, so
          // widening this would scan other Regions' management events for nothing.
          'projection.region.values': REGION,
          'projection.year.type': 'integer',
          'projection.year.range': '2024,2034',
          'projection.year.digits': '4',
          'projection.month.type': 'integer',
          'projection.month.range': '1,12',
          'projection.month.digits': '2',
          'projection.day.type': 'integer',
          'projection.day.range': '1,31',
          'projection.day.digits': '2',
          'storage.location.template':
            `${this.auditLocation}/\${region}/\${year}/\${month}/\${day}`,
        },
        storageDescriptor: {
          location: `${this.auditLocation}/`,
          // CloudTrail's own input format, not TextInputFormat. This is what unwraps the
          // `Records` array into rows.
          inputFormat: 'com.amazon.emr.cloudtrail.CloudTrailInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          compressed: true,
          columns: [
            { name: 'eventversion', type: 'string', comment: 'CloudTrail record schema version.' },
            {
              name: 'useridentity',
              type:
                'struct<' +
                'type:string,principalid:string,arn:string,accountid:string,invokedby:string,' +
                'accesskeyid:string,username:string,' +
                'sessioncontext:struct<' +
                'attributes:struct<mfaauthenticated:string,creationdate:string>,' +
                'sessionissuer:struct<type:string,principalid:string,arn:string,accountid:string,username:string>' +
                '>>',
              comment: 'Who made the call.',
            },
            { name: 'eventtime', type: 'string', comment: 'ISO-8601 event time.' },
            { name: 'eventsource', type: 'string', comment: 'Service endpoint, e.g. quicksight.amazonaws.com.' },
            { name: 'eventname', type: 'string', comment: 'API operation, e.g. CreateAgent.' },
            { name: 'awsregion', type: 'string', comment: 'Region the call was made in.' },
            { name: 'sourceipaddress', type: 'string', comment: 'Caller IP, or an AWS service name.' },
            { name: 'useragent', type: 'string', comment: 'Client that made the call.' },
            { name: 'errorcode', type: 'string', comment: 'Error code, null on success.' },
            { name: 'errormessage', type: 'string', comment: 'Error message, null on success.' },
            { name: 'requestid', type: 'string', comment: 'Service request id.' },
            { name: 'eventid', type: 'string', comment: 'CloudTrail event id.' },
            {
              name: 'resources',
              type: 'array<struct<arn:string,accountid:string,type:string>>',
              comment: 'Resources the call touched, when the service reports them.',
            },
            { name: 'eventtype', type: 'string', comment: 'e.g. AwsApiCall.' },
            { name: 'apiversion', type: 'string', comment: 'API version, when reported.' },
            {
              name: 'readonly',
              type: 'string',
              comment: 'CloudTrail read-only flag. This is the field EventBridge silently drops on.',
            },
            { name: 'recipientaccountid', type: 'string', comment: 'Account that received the event.' },
            { name: 'sharedeventid', type: 'string', comment: 'Set when one event is delivered to several accounts.' },
            { name: 'vpcendpointid', type: 'string', comment: 'VPC endpoint, when the call came through one.' },
            // requestParameters / responseElements / additionalEventData are deliberately
            // omitted: their shape varies per operation, so declaring them typed would
            // break on some events and declaring them as string yields NULL.
          ],
          serdeInfo: {
            serializationLibrary: 'com.amazon.emr.hive.serde.CloudTrailSerde',
            parameters: { 'serialization.format': '1' },
          },
        },
      },
    });
  }

  /** Nested EventBridge-envelope table, used only for AUDIT_SOURCE=eventbridge. */
  private eventBridgeAuditTable(): glue.CfnTable {
    return new glue.CfnTable(this, 'AuditTable', {
      catalogId: Aws.ACCOUNT_ID,
      databaseName: NAMES.glueDatabase,
      tableInput: {
        name: AUDIT_TABLE,
        description: 'Quick API calls captured from CloudTrail via EventBridge. Write events only.',
        tableType: 'EXTERNAL_TABLE',
        parameters: { classification: 'json' },
        storageDescriptor: {
          location: `${this.auditLocation}/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          compressed: true,
          columns: [
            { name: 'version', type: 'string', comment: 'EventBridge envelope version.' },
            { name: 'id', type: 'string', comment: 'EventBridge event id.' },
            { name: 'detail_type', type: 'string', comment: 'Always "AWS API Call via CloudTrail".' },
            { name: 'source', type: 'string', comment: 'Always "aws.quicksight".' },
            { name: 'account', type: 'string', comment: 'AWS account id.' },
            { name: 'time', type: 'string', comment: 'ISO-8601 event time.' },
            { name: 'region', type: 'string', comment: 'Region the call was made in.' },
            {
              name: 'detail',
              // A typed struct, not a string: the OpenX SerDe returns NULL for a JSON
              // object read into a string column, so json_extract_scalar produced empty
              // columns on a table that queried perfectly well.
              type:
                'struct<' +
                'eventname:string,eventsource:string,eventtime:string,awsregion:string,' +
                'sourceipaddress:string,useragent:string,errorcode:string,errormessage:string,' +
                'readonly:boolean,' +
                'useridentity:struct<type:string,username:string,arn:string,principalid:string,' +
                'accountid:string,' +
                'sessioncontext:struct<sessionissuer:struct<username:string,arn:string,type:string>>>' +
                '>',
              comment: 'The CloudTrail record. Read as detail.eventname, detail.useridentity.username, etc.',
            },
          ],
          serdeInfo: {
            serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
            parameters: {
              'ignore.malformed.json': 'true',
              // EventBridge emits "detail-type"; a hyphen is not a legal column name.
              'mapping.detail_type': 'detail-type',
            },
          },
        },
      },
    });
  }

  // =========================================================================
  // Athena workgroup and outputs
  // =========================================================================

  private buildWorkgroup(): void {
    this.workgroup = new athena.CfnWorkGroup(this, 'Workgroup', {
      name: NAMES.athenaWorkgroup,
      description: 'Amazon Quick observability queries',
      state: 'ENABLED',
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        // Enforced so a caller cannot redirect results to an unencrypted bucket.
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        resultConfiguration: {
          outputLocation: `s3://${this.lakeBucket.bucketName}/${NAMES.athenaResultsPrefix}/`,
          encryptionConfiguration: { encryptionOption: 'SSE_KMS', kmsKey: this.key.keyArn },
        },
      },
    });
    this.workgroup.node.addDependency(this.lakeBucket);
  }

  private buildOutputs(): void {
    new CfnOutput(this, 'LakeBucketName', { value: this.lakeBucket.bucketName, description: 'S3 observability lake' });
    new CfnOutput(this, 'GlueDatabaseName', { value: NAMES.glueDatabase, description: 'Glue database' });
    new CfnOutput(this, 'AthenaWorkgroupName', { value: NAMES.athenaWorkgroup, description: 'Athena workgroup' });
    new CfnOutput(this, 'KmsKeyArn', { value: this.key.keyArn, description: 'CMK encrypting the lake and log groups' });
    new CfnOutput(this, 'DeliveredLogTypes', { value: LOG_TYPES.join(','), description: 'Quick log types delivered' });
    new CfnOutput(this, 'AuditSource', {
      value: AUDIT_SOURCE,
      description: 'Where Quick API audit events come from (QUICK_OBS_AUDIT_SOURCE)',
    });
    new CfnOutput(this, 'AuditLocation', {
      value: this.auditLocation ?? '(auditing disabled)',
      description: 'S3 location the Quick API audit table reads',
    });
    new CfnOutput(this, 'SensitiveFieldsIncluded', {
      value: String(INCLUDE_SENSITIVE_FIELDS),
      description: 'Whether chat message bodies are delivered (QUICK_OBS_LOG_SENSITIVE)',
    });
  }
}

/** CHAT_LOGS -> ChatLogs, for CloudFormation logical ids. */
function pascal(logType: LogType): string {
  return logType
    .toLowerCase()
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/**
 * Map a day count onto the nearest CloudWatch retention enum at or above it.
 *
 * CloudWatch only accepts a fixed set of values, so an arbitrary number has to be
 * rounded. Rounding *up* is deliberate: silently keeping logs for less time than
 * asked would be a compliance surprise.
 */
function toRetention(days: number): logs.RetentionDays {
  const allowed: [number, logs.RetentionDays][] = [
    [1, logs.RetentionDays.ONE_DAY],
    [3, logs.RetentionDays.THREE_DAYS],
    [5, logs.RetentionDays.FIVE_DAYS],
    [7, logs.RetentionDays.ONE_WEEK],
    [14, logs.RetentionDays.TWO_WEEKS],
    [30, logs.RetentionDays.ONE_MONTH],
    [60, logs.RetentionDays.TWO_MONTHS],
    [90, logs.RetentionDays.THREE_MONTHS],
    [120, logs.RetentionDays.FOUR_MONTHS],
    [150, logs.RetentionDays.FIVE_MONTHS],
    [180, logs.RetentionDays.SIX_MONTHS],
    [365, logs.RetentionDays.ONE_YEAR],
    [400, logs.RetentionDays.THIRTEEN_MONTHS],
    [545, logs.RetentionDays.EIGHTEEN_MONTHS],
    [731, logs.RetentionDays.TWO_YEARS],
    [1827, logs.RetentionDays.FIVE_YEARS],
    [3653, logs.RetentionDays.TEN_YEARS],
  ];
  for (const [d, enumValue] of allowed) if (days <= d) return enumValue;
  return logs.RetentionDays.INFINITE;
}
