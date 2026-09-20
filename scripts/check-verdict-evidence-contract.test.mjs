import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, describe, it } from 'node:test';

const SCRIPT = resolve(import.meta.dirname, 'check-verdict-evidence-contract.mjs');

function makeCandidate() {
  return mkdtempSync(`${tmpdir()}/verdict-evidence-test-`);
}

function seedBundle(candidateRoot, verdictId, { lifecycleRoot, snapshot } = {}) {
  const bundleDir = resolve(candidateRoot, 'docs/harness-feedback/bundles', verdictId);
  mkdirSync(bundleDir, { recursive: true });
  if (lifecycleRoot !== undefined) {
    writeFileSync(
      resolve(bundleDir, 'lifecycle-root.json'),
      JSON.stringify(
        lifecycleRoot === true
          ? {
              schemaVersion: 1,
              verdictId,
              domainId: 'eval:a2a',
              createdAt: '2026-01-01T00:00:00.000Z',
              verdict: 'keep_observe',
              harnessUnderEval: { featureId: 'F1', componentId: 'C1', name: 'test' },
              ownerAsk: { targetFeatureId: 'F1', targetOwnerCatId: 'opus', requestedAction: 'observe' },
              acceptanceReevalPlan: { nextEvalAt: '2026-02-01T00:00:00.000Z', closureCondition: 'stable' },
            }
          : lifecycleRoot,
        null,
        2,
      ),
    );
  }
  if (snapshot !== undefined) {
    writeFileSync(
      resolve(bundleDir, 'snapshot.json'),
      typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot),
    );
  }
  return bundleDir;
}

function run(candidateRoot) {
  return execFileSync(process.execPath, [SCRIPT, '--candidate-root', candidateRoot], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runExpectFail(candidateRoot) {
  try {
    run(candidateRoot);
    assert.fail('expected script to exit non-zero');
  } catch (err) {
    return err.stderr?.trim() ?? '';
  }
}

const dirs = [];
function tracked(dir) {
  dirs.push(dir);
  return dir;
}

describe('check-verdict-evidence-contract', () => {
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('passes with valid lifecycle-root', () => {
    const dir = tracked(makeCandidate());
    seedBundle(dir, 'test-valid-2026', { lifecycleRoot: true, snapshot: { data: 1 } });
    run(dir); // no throw = pass
  });

  it('passes with no bundles directory (fresh repo)', () => {
    const dir = tracked(makeCandidate());
    run(dir);
  });

  it('tolerates historical bundles without lifecycle-root.json', () => {
    const dir = tracked(makeCandidate());
    // Historical bundle: only snapshot.json, no lifecycle-root
    seedBundle(dir, 'legacy-2026', { snapshot: { data: 1 } });
    run(dir);
  });

  it('rejects lifecycle-root with mismatched verdictId', () => {
    const dir = tracked(makeCandidate());
    seedBundle(dir, 'dir-name-2026', {
      lifecycleRoot: {
        schemaVersion: 1,
        verdictId: 'wrong-id',
        domainId: 'eval:a2a',
        createdAt: '2026-01-01T00:00:00.000Z',
        verdict: 'keep_observe',
        harnessUnderEval: { featureId: 'F1', componentId: 'C1', name: 'test' },
        ownerAsk: { targetFeatureId: 'F1', targetOwnerCatId: 'opus', requestedAction: 'observe' },
        acceptanceReevalPlan: { nextEvalAt: '2026-02-01T00:00:00.000Z', closureCondition: 'stable' },
      },
    });
    const stderr = runExpectFail(dir);
    assert.match(stderr, /LIFECYCLE_ROOT_IDENTITY_MISMATCH/);
    assert.match(stderr, /wrong-id/);
  });

  it('rejects invalid lifecycle-root JSON', () => {
    const dir = tracked(makeCandidate());
    const bundleDir = resolve(dir, 'docs/harness-feedback/bundles/bad-json-2026');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(resolve(bundleDir, 'lifecycle-root.json'), '{not valid json');
    const stderr = runExpectFail(dir);
    assert.match(stderr, /LIFECYCLE_ROOT_INVALID/);
  });

  it('rejects invalid snapshot.json', () => {
    const dir = tracked(makeCandidate());
    seedBundle(dir, 'bad-snap-2026', { lifecycleRoot: true, snapshot: '{not valid' });
    const stderr = runExpectFail(dir);
    assert.match(stderr, /SNAPSHOT_INVALID/);
  });

  it('rejects missing required args', () => {
    try {
      execFileSync(process.execPath, [SCRIPT], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.fail('expected non-zero exit');
    } catch (err) {
      assert.match(err.stderr, /ARGS_MISSING/);
    }
  });
});
