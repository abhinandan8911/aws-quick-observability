#!/usr/bin/env ts-node
/**
 * Prerequisite gate. Runs before `cdk deploy` and exits non-zero on a blocker.
 *
 * The check that justifies this file's existence is the **delivery-source conflict**.
 * There can be only one delivery source per (Quick account ARN, logType) in an AWS
 * account, so if the target account already has Quick logging configured — by hand, by
 * another stack, or by a previous run of this module — deploy fails partway
 * through with a bare `ConflictException` and leaves a half-built stack. For a module
 * whose whole point is being shared into other accounts, that is the single most likely
 * failure, so it is detected up front with the exact remediation printed.
 *
 *   npm run preflight
 */

import { execFileSync } from 'child_process';
import {
  ACCOUNT_ID,
  AUDIT_SOURCE,
  AWS_PROFILE, awsProfileArgs,
  LOG_TYPES,
  NAMES,
  OWNER_USERNAME,
  PREFIX,
  QUICK_ACCOUNT_ARN,
  REGION,
  NAMESPACE,
  TRAIL_BUCKET,
  trailLocation,
} from '../lib/config';

let failures = 0;
let warnings = 0;

/** `--profile x ` for copy-pasteable commands, or empty when no profile is configured. */
const PROFILE_FLAG = AWS_PROFILE ? `--profile ${AWS_PROFILE} ` : '';

function aws<T = any>(args: string[]): T | null {
  try {
    const out = execFileSync('aws', [...args, ...awsProfileArgs(), '--region', REGION, '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    return out.trim() ? (JSON.parse(out) as T) : ({} as T);
  } catch {
    return null;
  }
}

function check(name: string, ok: boolean, detail: string, remediation?: string): boolean {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(32)} ${detail}`);
  if (!ok && remediation) console.log(`\n${remediation}\n`);
  return ok;
}

function warn(name: string, detail: string, guidance: string): void {
  warnings++;
  console.log(`  ! ${name.padEnd(32)} ${detail}`);
  console.log(`      ${guidance}`);
}

/** Informational only — neither a pass/fail nor a warning. */
function note(name: string, detail: string): void {
  console.log(`  i ${name.padEnd(32)} ${detail}`);
}

console.log(`\nPreflight — ${PREFIX} into ${ACCOUNT_ID}/${REGION} (profile ${AWS_PROFILE})\n`);

// --- 1. Credentials --------------------------------------------------------
const who = aws<{ Account: string; Arn: string }>(['sts', 'get-caller-identity']);
if (
  !check(
    'AWS credentials',
    Boolean(who?.Account),
    who ? `${who.Arn.split('/').slice(-2).join('/')}` : 'MISSING',
    `  Credentials for profile "${AWS_PROFILE}" are not usable.\n` +
      `  If this profile uses IAM Identity Center, run:  aws sso login`,
  )
) {
  process.exit(1);
}

check(
  'account matches config',
  who!.Account === ACCOUNT_ID,
  `credentials ${who!.Account}, config ${ACCOUNT_ID}`,
  `  The credentials point at ${who!.Account} but the module is configured for ${ACCOUNT_ID}.\n` +
    `  Either switch profile, or set:  export QUICK_OBS_ACCOUNT_ID=${who!.Account}`,
);

// --- 2. Quick subscription -------------------------------------------------
// This doubles as the region check. describe-account-subscription is regional, so it
// only succeeds in the Region the Quick account actually lives in — which is why a
// wrong QUICK_OBS_REGION shows up here rather than as a confusing failure at deploy.
const sub = aws<{ AccountInfo: { Edition: string; AccountName: string; NotificationEmail?: string } }>([
  'quicksight',
  'describe-account-subscription',
  '--aws-account-id',
  ACCOUNT_ID,
]);
const edition = sub?.AccountInfo?.Edition ?? '';
check(
  'Quick subscription',
  ['ENTERPRISE', 'ENTERPRISE_AND_Q'].includes(edition),
  `${sub?.AccountInfo?.AccountName ?? 'MISSING'} (${edition || 'unknown'}) in ${REGION}`,
  `  Could not read a Quick subscription in ${REGION}.\n` +
    `  Either the Region is wrong, or the subscription is not Enterprise/Professional.\n` +
    `  Vended log delivery is per Region and must run where the Quick account lives.\n` +
    `  Set the Region explicitly:  export QUICK_OBS_REGION=<region>\n` +
    `  (The module ignores CDK_DEFAULT_REGION on purpose, so preflight and deploy agree.)`,
);

// --- 3. Owner user exists --------------------------------------------------
const user = aws<{ User: { Role: string; Arn: string } }>([
  'quicksight',
  'describe-user',
  '--aws-account-id',
  ACCOUNT_ID,
  '--namespace',
  NAMESPACE,
  '--user-name',
  OWNER_USERNAME,
]);
check(
  'Quick owner user',
  Boolean(user?.User?.Arn),
  user?.User ? `${OWNER_USERNAME} (${user.User.Role})` : 'MISSING',
  `  The configured owner user does not exist in namespace "${NAMESPACE}".\n` +
    `  List users:  aws quicksight list-users --aws-account-id ${ACCOUNT_ID} --namespace ${NAMESPACE} \\\n` +
    `                 ${PROFILE_FLAG}--region ${REGION} --query 'UserList[].UserName'\n` +
    `  Then set:    export QUICK_OBS_OWNER='<username>'`,
);

// A *_PRO role is required for Spaces and chat agents. Not fatal for the pipeline
// stack, so this is a warning rather than a failure.
if (user?.User?.Role && !['ADMIN_PRO', 'AUTHOR_PRO', 'READER_PRO'].includes(user.User.Role)) {
  warn(
    'owner role is not Pro',
    user.User.Role,
    `Spaces and chat agents need a *_PRO role. The pipeline stack will deploy, but the\n` +
      `      Space and agent in the ${PREFIX}-quick stack will not be usable. Upgrade with:\n` +
      `      aws quicksight update-user --aws-account-id ${ACCOUNT_ID} --namespace ${NAMESPACE} \\\n` +
      `        --user-name '${OWNER_USERNAME}' --email '<email>' --role ADMIN_PRO \\\n` +
      `        ${PROFILE_FLAG}--region ${REGION}`,
  );
}

// --- 4. THE ONE THAT MATTERS: delivery-source conflicts --------------------
// One delivery source per (resourceArn, logType) per account. Anything already
// claiming a log type we want will fail the deploy with ConflictException.
const sources = aws<{ deliverySources: { name: string; logType: string; resourceArns: string[] }[] }>([
  'logs',
  'describe-delivery-sources',
]);

if (sources === null) {
  check(
    'delivery-source conflicts',
    false,
    'could not list delivery sources',
    `  Needs logs:DescribeDeliverySources. Without it the conflict cannot be checked\n` +
      `  and the deploy may fail partway through.`,
  );
} else {
  const existing = sources.deliverySources ?? [];
  const mine = new Set(LOG_TYPES.map((t) => `${PREFIX}-${t.toLowerCase()}`));

  // A conflict is any source that claims one of our log types for this Quick account
  // and is not one of ours (ours are safe — CloudFormation will simply update them).
  const conflicts = existing.filter(
    (s) =>
      (LOG_TYPES as readonly string[]).includes(s.logType) &&
      (s.resourceArns ?? []).includes(QUICK_ACCOUNT_ARN) &&
      !mine.has(s.name),
  );

  const ok = check(
    'delivery-source conflicts',
    conflicts.length === 0,
    conflicts.length ? `${conflicts.length} conflicting source(s)` : `none (${existing.length} unrelated source(s))`,
  );

  if (!ok) {
    console.log(
      `  Only ONE delivery source may exist per (Quick account, log type) in an AWS account.\n` +
        `  These already claim log types this module wants, so deploy would fail with\n` +
        `  ConflictException. Either delete them, or narrow QUICK_OBS_LOG_TYPES to avoid them.\n`,
    );
    for (const c of conflicts) {
      console.log(`    ${c.logType.padEnd(22)} held by "${c.name}"`);
    }
    console.log(`\n  To reuse this module's log types, delete the conflicting sources:\n`);
    for (const c of conflicts) {
      console.log(
        `    aws logs delete-delivery-source --name ${c.name} ${PROFILE_FLAG}--region ${REGION}`,
      );
    }
    console.log(
      `\n  Deliveries referencing them must go first:\n` +
        `    aws logs describe-deliveries ${PROFILE_FLAG}--region ${REGION} \\\n` +
        `      --query 'deliveries[].{id:id,source:deliverySourceName}'\n` +
        `    aws logs delete-delivery --id <id> ${PROFILE_FLAG}--region ${REGION}\n` +
        `\n  Or keep them and deliver only the remaining types:\n` +
        `    export QUICK_OBS_LOG_TYPES=${LOG_TYPES.filter((t) => !conflicts.some((c) => c.logType === t)).join(',') || '<none left>'}\n`,
    );
  }
}

// --- 4b. Audit source is usable --------------------------------------------
console.log('');
note('audit source', AUDIT_SOURCE);

if (AUDIT_SOURCE === 'existing-trail') {
  // The whole appeal of this mode is that it needs no new infrastructure — but that
  // means it depends on a bucket this module does not own. Fail here with the fix rather
  // than deploying a Glue table over a location nobody can read.
  const location = trailLocation(TRAIL_BUCKET);
  let readable = false;
  let detail = '';
  try {
    const out = execFileSync(
      'aws',
      ['s3api', 'list-objects-v2', '--bucket', TRAIL_BUCKET, '--prefix',
       location.replace(`s3://${TRAIL_BUCKET}/`, ''), '--max-items', '1',
       ...awsProfileArgs(), '--output', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const parsed = JSON.parse(out || '{}') as { Contents?: unknown[] };
    readable = true;
    detail = parsed.Contents?.length ? 'readable, has objects' : 'readable but empty at that prefix';
  } catch (err) {
    const msg = String((err as { stderr?: Buffer }).stderr ?? '');
    detail = /AccessDenied|403/.test(msg) ? 'access denied' : /NoSuchBucket/.test(msg) ? 'no such bucket' : 'unreadable';
  }

  check(
    'trail bucket readable',
    readable,
    `${TRAIL_BUCKET} (${detail})`,
    `  ${location}\n` +
      `  is not readable with this profile, so the audit table would return nothing.\n\n` +
      `  Find the right bucket:\n` +
      `    aws cloudtrail describe-trails ${PROFILE_FLAG}--region ${REGION} \\\n` +
      `      --query 'trailList[].{Name:Name,Bucket:S3BucketName,Prefix:S3KeyPrefix}'\n\n` +
      `  Then either point at it:\n` +
      `    export QUICK_OBS_TRAIL_BUCKET=<bucket>   # and QUICK_OBS_TRAIL_PREFIX if it has one\n` +
      `  or have this module create its own trail:\n` +
      `    export QUICK_OBS_AUDIT_SOURCE=own-trail`,
  );

  // Readable but empty usually means a wrong prefix or account, which is worth calling
  // out separately — it is not fatal, but it will look like "no audit data".
  if (readable && detail.includes('empty')) {
    warn(
      'trail prefix has no objects',
      detail,
      `Expected layout: ${location}/<region>/<yyyy>/<mm>/<dd>/\n` +
        `      Check QUICK_OBS_TRAIL_PREFIX and QUICK_OBS_TRAIL_ACCOUNT_ID.`,
    );
  }
} else if (AUDIT_SOURCE === 'own-trail') {
  warn(
    'own-trail bills a second copy',
    'management events duplicated',
    `This creates a second trail. The first copy of management events per account is\n` +
      `      free; further copies bill at roughly $2 per 100k events. Prefer\n` +
      `      QUICK_OBS_AUDIT_SOURCE=existing-trail when a trail already exists.`,
  );
} else if (AUDIT_SOURCE === 'eventbridge') {
  warn(
    'eventbridge misses read events',
    'write events only',
    `CloudTrail does not deliver read-only events to EventBridge. In a sampled window\n` +
      `      this account logged 57 Quick API events of which 55 were reads, so this mode\n` +
      `      captures roughly 3.5% of activity. Prefer existing-trail.`,
  );
}

// --- 5. Bucket name is available -------------------------------------------
// S3 bucket names are global, so a shared module hitting a taken name should say so
// clearly rather than surfacing BucketAlreadyExists from CloudFormation.
const head = (() => {
  try {
    execFileSync('aws', ['s3api', 'head-bucket', '--bucket', NAMES.lakeBucket, '--profile', AWS_PROFILE], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return 'ours';
  } catch (err) {
    const msg = String((err as { stderr?: Buffer }).stderr ?? '');
    if (/404|Not Found/.test(msg)) return 'available';
    if (/403|Forbidden/.test(msg)) return 'taken';
    return 'unknown';
  }
})();
check(
  'lake bucket name',
  head === 'available' || head === 'ours',
  `${NAMES.lakeBucket} (${head})`,
  head === 'taken'
    ? `  That bucket name is taken by another AWS account. Change the prefix:\n` +
      `    export QUICK_OBS_PREFIX=<something-unique>`
    : undefined,
);

// --- 6. CDK bootstrap ------------------------------------------------------
const bootstrap = aws<{ Parameters: { Value: string }[] }>([
  'ssm',
  'get-parameters',
  '--names',
  '/cdk-bootstrap/hnb659fds/version',
]);
check(
  'CDK bootstrap',
  Boolean(bootstrap?.Parameters?.length),
  bootstrap?.Parameters?.[0]?.Value ? `version ${bootstrap.Parameters[0].Value}` : 'MISSING',
  `  Bootstrap this account and region once:\n    npm run bootstrap`,
);

// --- 7. python3 + pip for the boto3 layer ---------------------------------
const python = process.env.PYTHON ?? 'python3';
let pythonOk = false;
let pythonDetail = 'MISSING';
try {
  const v = execFileSync(python, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync(python, ['-m', 'pip', '--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  pythonOk = true;
  pythonDetail = `${v} with pip`;
} catch {
  pythonOk = false;
}
check(
  'python3 + pip',
  pythonOk,
  pythonDetail,
  `  The provisioner Lambda needs a pinned boto3 layer, built with pip at synth time.\n` +
    `  Install Python 3 with pip, or set PYTHON to a suitable interpreter.`,
);

// --- 8. Existing Quick logging, informational -----------------------------
const groups = aws<{ logGroups: { logGroupName: string }[] }>([
  'logs',
  'describe-log-groups',
  '--log-group-name-prefix',
  '/aws/vendedlogs',
]);
const quickGroups = (groups?.logGroups ?? []).filter((g) => /quick/i.test(g.logGroupName));
if (quickGroups.length) {
  console.log(`  i existing vended log groups        ${quickGroups.length} found`);
  for (const g of quickGroups.slice(0, 8)) console.log(`      ${g.logGroupName}`);
}

// --- Summary ---------------------------------------------------------------
console.log('');
if (failures) {
  console.log(`${failures} blocker(s). Fix the above, then re-run.\n`);
  process.exit(1);
}
console.log(
  `Preflight passed${warnings ? ` with ${warnings} warning(s)` : ''}.\n\n` +
    `  Delivering ${LOG_TYPES.length} log type(s): ${LOG_TYPES.join(', ')}\n\n` +
    `  Reminder: vended logs are NOT retroactive. Nothing before this deploy is\n` +
    `  recoverable, and the tables start empty. Generate some Quick activity, then\n` +
    `  run: npm run verify\n`,
);
process.exit(0);
