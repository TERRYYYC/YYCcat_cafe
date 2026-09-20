#!/usr/bin/env node

/**
 * F192 / F248 verdict evidence contract guard (post-commit).
 *
 * Called by verdict-publish-contract-runner.ts when sourceRef === 'HEAD'
 * (after generator + commit, before push). Validates structural integrity
 * of generated evidence artifacts in the candidate worktree.
 *
 * Checks:
 *   1. Lifecycle-root identity: every bundle with lifecycle-root.json has
 *      a verdictId matching its directory name.
 *   2. Same-domain/same-window collision: no two bundles in the candidate
 *      share the same verdictId (idempotency guard).
 *   3. Snapshot identity: each bundle with snapshot.json references a
 *      parseable JSON structure (structural, not semantic).
 *
 * Historical bundles that predate lifecycle-root.json are tolerated
 * (they only have attribution.json + provenance.json + snapshot.json).
 *
 * Error codes written to stderr; non-zero exit on failure.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    'candidate-root': { type: 'string' },
    'api-dist-root': { type: 'string' },
    'git-root': { type: 'string' },
  },
  strict: true,
});

const candidateRoot = args['candidate-root'];
if (!candidateRoot) {
  fail('ARGS_MISSING', '--candidate-root is required');
}

function fail(code, detail) {
  process.stderr.write(`${code}: ${detail}\n`);
  process.exit(1);
}

const bundlesDir = join(candidateRoot, 'docs/harness-feedback/bundles');
if (!existsSync(bundlesDir)) {
  // No bundles directory = nothing to validate (fresh repo bootstrap)
  process.exit(0);
}

const entries = readdirSync(bundlesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name));

const seenVerdictIds = new Map();

for (const entry of entries) {
  const bundleDir = join(bundlesDir, entry.name);
  const lifecycleRootPath = join(bundleDir, 'lifecycle-root.json');

  // Historical bundles without lifecycle-root.json are tolerated
  if (!existsSync(lifecycleRootPath)) continue;

  let root;
  try {
    root = JSON.parse(readFileSync(lifecycleRootPath, 'utf8'));
  } catch (err) {
    fail('LIFECYCLE_ROOT_INVALID', `${entry.name}/lifecycle-root.json is not valid JSON: ${err.message}`);
  }

  // Identity check: verdictId must match bundle directory name
  if (typeof root.verdictId !== 'string' || !root.verdictId) {
    fail('LIFECYCLE_ROOT_INVALID', `${entry.name}/lifecycle-root.json missing verdictId`);
  }
  if (root.verdictId !== entry.name) {
    fail(
      'LIFECYCLE_ROOT_IDENTITY_MISMATCH',
      `${entry.name}/lifecycle-root.json verdictId '${root.verdictId}' does not match directory '${entry.name}'`,
    );
  }

  // Required fields: domainId, schemaVersion
  if (typeof root.domainId !== 'string' || !root.domainId) {
    fail('LIFECYCLE_ROOT_INVALID', `${entry.name}/lifecycle-root.json missing domainId`);
  }
  if (typeof root.schemaVersion !== 'number') {
    fail('LIFECYCLE_ROOT_INVALID', `${entry.name}/lifecycle-root.json missing schemaVersion`);
  }

  // Same-domain collision: no two bundles with same verdictId
  if (seenVerdictIds.has(root.verdictId)) {
    fail(
      'verdict_window_duplicated_in_candidate',
      `verdictId '${root.verdictId}' appears in multiple bundle directories: ` +
        `'${seenVerdictIds.get(root.verdictId)}' and '${entry.name}'`,
    );
  }
  seenVerdictIds.set(root.verdictId, entry.name);

  // Snapshot structural check (if present)
  const snapshotPath = join(bundleDir, 'snapshot.json');
  if (existsSync(snapshotPath)) {
    try {
      JSON.parse(readFileSync(snapshotPath, 'utf8'));
    } catch (err) {
      fail('SNAPSHOT_INVALID', `${entry.name}/snapshot.json is not valid JSON: ${err.message}`);
    }
  }
}
