import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, describe, it } from 'node:test';

const SCRIPT = resolve(import.meta.dirname, 'check-verdict-publish-contract.mjs');
const EXPECTED_REPO = 'zts212653/clowder-ai';

function makeRepo({ fetchUrl, pushUrls, seedCensus = false } = {}) {
  const dir = mkdtempSync(`${tmpdir()}/verdict-contract-test-`);
  execSync('git init --initial-branch=main', { cwd: dir, stdio: 'pipe' });
  // Configure fixture-local identity so tests pass in CI (no global git config)
  execSync('git config user.name "test" && git config user.email "test@test"', { cwd: dir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: 'pipe' });
  if (fetchUrl) {
    execSync(`git remote add origin "${fetchUrl}"`, { cwd: dir, stdio: 'pipe' });
  }
  if (pushUrls && pushUrls.length > 0) {
    // First push URL: set-url --push replaces the inferred push URL
    execSync(`git remote set-url --push origin "${pushUrls[0]}"`, { cwd: dir, stdio: 'pipe' });
    // Additional push URLs: add --push appends
    for (let i = 1; i < pushUrls.length; i++) {
      execSync(`git remote set-url --add --push origin "${pushUrls[i]}"`, { cwd: dir, stdio: 'pipe' });
    }
  }
  if (seedCensus) {
    const censusDir = resolve(dir, 'docs/harness-feedback/registry');
    mkdirSync(censusDir, { recursive: true });
    writeFileSync(resolve(censusDir, 'measurement-bundles.yaml'), 'entries: []\n');
    execSync('git add -A && git commit -m "seed census"', { cwd: dir, stdio: 'pipe' });
  }
  return dir;
}

function run(repoDir, opts = {}) {
  const args = [
    SCRIPT,
    '--repo-root',
    repoDir,
    '--expected-repo',
    opts.expectedRepo ?? EXPECTED_REPO,
    '--remote',
    opts.remote ?? 'origin',
  ];
  if (opts.identityOnly) args.push('--identity-only', 'true');
  if (opts.baseRef) args.push('--base-ref', opts.baseRef);
  if (opts.freshBaseBranch) args.push('--fresh-base-branch', opts.freshBaseBranch);
  if (opts.sourceRef) args.push('--source-ref', opts.sourceRef);
  return execFileSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runExpectFail(repoDir, opts = {}) {
  try {
    run(repoDir, opts);
    assert.fail('expected script to exit non-zero');
  } catch (err) {
    return err.stderr?.trim() ?? '';
  }
}

/** Dirs to clean up after all tests. */
const dirs = [];
function tracked(dir) {
  dirs.push(dir);
  return dir;
}

describe('check-verdict-publish-contract', () => {
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  // --- Identity checks ---

  it('passes identity-only for HTTPS URL', () => {
    const dir = tracked(makeRepo({ fetchUrl: `https://github.com/${EXPECTED_REPO}.git` }));
    run(dir, { identityOnly: true }); // no throw = pass
  });

  it('passes identity-only for SSH URL', () => {
    const dir = tracked(makeRepo({ fetchUrl: `git@github.com:${EXPECTED_REPO}.git` }));
    run(dir, { identityOnly: true });
  });

  it('passes identity-only for HTTPS URL without .git suffix', () => {
    const dir = tracked(makeRepo({ fetchUrl: `https://github.com/${EXPECTED_REPO}` }));
    run(dir, { identityOnly: true });
  });

  // --- Anti-spoofing ---

  it('rejects subdomain-spoofed URL (github.com.evil.com)', () => {
    const dir = tracked(makeRepo({ fetchUrl: `https://github.com.evil.com/${EXPECTED_REPO}.git` }));
    const stderr = runExpectFail(dir, { identityOnly: true });
    assert.match(stderr, /IDENTITY_FAILED/);
  });

  it('rejects different-TLD URL (not-github.com)', () => {
    const dir = tracked(makeRepo({ fetchUrl: `https://not-github.com/${EXPECTED_REPO}.git` }));
    const stderr = runExpectFail(dir, { identityOnly: true });
    assert.match(stderr, /IDENTITY_FAILED/);
  });

  it('rejects mismatched repo (IDENTITY_MISMATCH)', () => {
    const dir = tracked(makeRepo({ fetchUrl: 'https://github.com/someone/other-repo.git' }));
    const stderr = runExpectFail(dir, { identityOnly: true });
    assert.match(stderr, /IDENTITY_MISMATCH/);
  });

  // --- Push URL exfiltration ---

  it('rejects push URL pointing to wrong repo', () => {
    const dir = tracked(
      makeRepo({
        fetchUrl: `https://github.com/${EXPECTED_REPO}.git`,
        pushUrls: ['https://github.com/attacker/exfil.git'],
      }),
    );
    const stderr = runExpectFail(dir, { identityOnly: true });
    assert.match(stderr, /PUSH_URL_EXFILTRATION/);
  });

  it('rejects secondary push URL exfiltration (multi-push-URL bypass)', () => {
    // P1 finding: `git remote get-url --push` without --all only returns the
    // first push URL, allowing a second exfiltration URL to pass undetected.
    // This test verifies the guard checks ALL push URLs.
    const dir = tracked(
      makeRepo({
        fetchUrl: `https://github.com/${EXPECTED_REPO}.git`,
        pushUrls: [`https://github.com/${EXPECTED_REPO}.git`, 'https://github.com/attacker/exfil.git'],
      }),
    );
    const stderr = runExpectFail(dir, { identityOnly: true });
    assert.match(stderr, /PUSH_URL_EXFILTRATION/);
  });

  // --- Census check ---

  it('passes full mode when census exists at base ref', () => {
    const dir = tracked(
      makeRepo({
        fetchUrl: `https://github.com/${EXPECTED_REPO}.git`,
        seedCensus: true,
      }),
    );
    // base-ref = HEAD (the commit that seeded census), source-ref = HEAD
    run(dir, { baseRef: 'HEAD', sourceRef: 'HEAD' });
  });

  it('fails full mode when census is missing at base ref', () => {
    const dir = tracked(
      makeRepo({
        fetchUrl: `https://github.com/${EXPECTED_REPO}.git`,
        // no seedCensus
      }),
    );
    const stderr = runExpectFail(dir, { baseRef: 'HEAD', sourceRef: 'HEAD' });
    assert.match(stderr, /CENSUS_MISSING/);
  });

  it('requires --base-ref or --fresh-base-branch in full mode', () => {
    const dir = tracked(
      makeRepo({
        fetchUrl: `https://github.com/${EXPECTED_REPO}.git`,
        seedCensus: true,
      }),
    );
    const stderr = runExpectFail(dir, { sourceRef: 'HEAD' });
    assert.match(stderr, /SOURCE_REF_REQUIRED/);
  });

  // --- guarded-bin/gh compat ---

  it('accepts --fresh-base-branch as alias for base-ref', () => {
    const dir = tracked(
      makeRepo({
        fetchUrl: `https://github.com/${EXPECTED_REPO}.git`,
        seedCensus: true,
      }),
    );
    // --fresh-base-branch=main → resolves to origin/main
    // But our test repo has no remote tracking; use local ref to test parsing
    // Create a ref that looks like origin/main
    execSync(`git update-ref refs/remotes/origin/main HEAD`, { cwd: dir, stdio: 'pipe' });
    run(dir, { freshBaseBranch: 'main', sourceRef: 'HEAD' });
  });

  // --- URL extraction edge cases ---

  it('extracts owner/repo from SSH URL with .git suffix', () => {
    const dir = tracked(makeRepo({ fetchUrl: `git@github.com:${EXPECTED_REPO}.git` }));
    run(dir, { identityOnly: true });
  });

  it('extracts owner/repo from HTTPS URL with trailing slash', () => {
    const dir = tracked(makeRepo({ fetchUrl: `https://github.com/${EXPECTED_REPO}/` }));
    run(dir, { identityOnly: true });
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

  // --- Source-ref census validation (P1 finding #1) ---

  it('fails when source-ref lacks census but base-ref has it', () => {
    const dir = tracked(
      makeRepo({
        fetchUrl: `https://github.com/${EXPECTED_REPO}.git`,
        seedCensus: true,
      }),
    );
    // Create a branch where census is deleted
    execSync('git checkout -b no-census', { cwd: dir, stdio: 'pipe' });
    execSync('git rm -r docs/harness-feedback/registry && git commit -m "rm census"', { cwd: dir, stdio: 'pipe' });
    const stderr = runExpectFail(dir, { baseRef: 'main', sourceRef: 'HEAD' });
    assert.match(stderr, /CENSUS_MISSING_AT_SOURCE/);
  });

  it('passes when both base and source have census', () => {
    const dir = tracked(
      makeRepo({
        fetchUrl: `https://github.com/${EXPECTED_REPO}.git`,
        seedCensus: true,
      }),
    );
    // source = HEAD = main, same ref with census
    run(dir, { baseRef: 'HEAD~0', sourceRef: 'HEAD' });
  });

  // --- Credential redaction (P1 finding #3) ---

  it('redacts credential-bearing URLs in error messages', () => {
    const dir = tracked(
      makeRepo({
        fetchUrl: `https://oauth2:sentinel-secret@github.com/${EXPECTED_REPO}.git`,
      }),
    );
    const stderr = runExpectFail(dir, { identityOnly: true });
    assert.match(stderr, /IDENTITY_FAILED/);
    // The secret must NOT appear in stderr
    assert.ok(!stderr.includes('sentinel-secret'), `secret leaked in stderr: ${stderr}`);
    // Redacted placeholder should appear
    assert.match(stderr, /\*\*\*:\*\*\*/);
  });
});
