/**
 * Builds a pinned boto3 Lambda layer at synth time.
 *
 * The Python 3.12 runtime bundles a boto3 that predates the Quick Suite API surface,
 * so `update_agent_permissions` is simply absent — the provisioner Lambda raises
 * AttributeError without this. boto3 and botocore are pure Python, so
 * `pip install --target` produces a valid layer with no Docker and no
 * cross-compilation.
 *
 * The build is skipped when an up-to-date layer is already present, which keeps repeat
 * synths fast and, more importantly, keeps the asset hash stable so `cdk diff` stays
 * empty when nothing has actually changed.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Must be >= 1.43.19 for the Agents API. */
export const BOTO3_SPEC = 'boto3==1.43.83';

const LAYER_DIR = path.resolve(__dirname, '..', 'assets', 'layers', 'boto3');
const SITE_PACKAGES = path.join(LAYER_DIR, 'python');
const STAMP = path.join(LAYER_DIR, '.build-spec');

export function layerPath(): string {
  return LAYER_DIR;
}

export function buildBoto3Layer(verbose = true): string {
  if (fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8').trim() === BOTO3_SPEC) {
    if (verbose) console.log(`boto3 layer          already built (${BOTO3_SPEC})`);
    return LAYER_DIR;
  }

  if (verbose) console.log(`boto3 layer          building ${BOTO3_SPEC} ...`);
  fs.rmSync(LAYER_DIR, { recursive: true, force: true });
  fs.mkdirSync(SITE_PACKAGES, { recursive: true });

  const python = process.env.PYTHON ?? 'python3';
  try {
    execFileSync(
      python,
      [
        '-m',
        'pip',
        'install',
        '--quiet',
        '--no-compile',
        // pip resolves --target installs against the ambient environment, so it warns
        // about "conflicts" with unrelated globally-installed packages. They do not
        // affect the layer; silence them so the deploy output stays readable.
        '--no-warn-conflicts',
        '--disable-pip-version-check',
        '--only-binary',
        ':all:',
        '--platform',
        'manylinux2014_x86_64',
        '--python-version',
        '3.12',
        '--implementation',
        'cp',
        '--target',
        SITE_PACKAGES,
        BOTO3_SPEC,
      ],
      { stdio: verbose ? 'inherit' : 'ignore' },
    );
  } catch (err) {
    throw new Error(
      `Failed to build the boto3 Lambda layer with '${python}'.\n` +
        `Set PYTHON to a Python 3 interpreter with pip, or run:\n` +
        `  ${python} -m pip install --target ${SITE_PACKAGES} ${BOTO3_SPEC}\n` +
        `Original error: ${(err as Error).message}`,
    );
  }

  // Strip bytecode caches and metadata that carry build timestamps, so the asset hash
  // is stable across rebuilds.
  stripNonDeterministic(SITE_PACKAGES);
  fs.writeFileSync(STAMP, BOTO3_SPEC + '\n');

  if (verbose) {
    const bytes = dirSize(SITE_PACKAGES);
    console.log(`boto3 layer          ${(bytes / 1024 / 1024).toFixed(1)} MB at ${LAYER_DIR}`);
  }
  return LAYER_DIR;
}

function stripNonDeterministic(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') {
        fs.rmSync(p, { recursive: true, force: true });
        continue;
      }
      stripNonDeterministic(p);
    } else if (['RECORD', 'INSTALLER', 'REQUESTED'].includes(entry.name)) {
      fs.rmSync(p, { force: true });
    }
  }
}

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

if (require.main === module) buildBoto3Layer();
