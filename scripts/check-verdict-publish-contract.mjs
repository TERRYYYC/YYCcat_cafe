#!/usr/bin/env node

/**
 * F192 / F248 verdict publisher transport contract guard.
 *
 * Called by:
 *   1. verdict-publish-contract-runner.ts — pre-fetch (identity-only), post-fetch (full), post-commit (full)
 *   2. git-verdict-pr-refresher.ts — identity-only
 *   3. scripts/guarded-bin/gh — full (via --fresh-base-branch)
 *
 * Checks:
 *   Identity: ALL fetch URLs for --remote match --expected-repo (anchored regex, anti-spoofing).
 *   Push exfiltration: ALL push URLs (--all) match --expected-repo.
 *   Census continuity: measurement-bundles.yaml exists at resolved base ref (non-identity-only).
 *
 * Error codes written to stderr; non-zero exit on failure.
 */

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    'repo-root': { type: 'string' },
    'expected-repo': { type: 'string' },
    remote: { type: 'string', default: 'origin' },
    'base-ref': { type: 'string' },
    'fresh-base-branch': { type: 'string' },
    'source-ref': { type: 'string' },
    'identity-only': { type: 'string' },
  },
  strict: true,
});

const repoRoot = args['repo-root'];
const expectedRepo = args['expected-repo'];
const remoteName = args.remote ?? 'origin';
const identityOnly = args['identity-only'] === 'true';

if (!repoRoot || !expectedRepo) {
  fail('ARGS_MISSING', '--repo-root and --expected-repo are required');
}

// Resolve base ref: --base-ref takes precedence; --fresh-base-branch is
// shorthand for "<remote>/<branch>" used by guarded-bin/gh.
const baseRef =
  args['base-ref'] ?? (args['fresh-base-branch'] ? `${remoteName}/${args['fresh-base-branch']}` : undefined);

/**
 * Extract owner/repo from a git remote URL.
 * Supports:
 *   HTTPS: https://github.com/owner/repo.git
 *   SSH:   git@github.com:owner/repo.git
 *
 * Anchored patterns reject look-alike domains:
 *   - github.com.evil.com  (subdomain spoofing)
 *   - not-github.com       (different TLD)
 */
function extractOwnerRepo(url) {
  // HTTPS: anchored at protocol boundary, requires /owner/repo path
  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/)?$/);
  if (httpsMatch) return httpsMatch[1];

  // SSH: anchored at user@host boundary
  const sshMatch = url.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  return null;
}

/**
 * Redact userinfo (credentials) from a URL for safe diagnostics.
 * HTTPS with embedded credentials (e.g. https://oauth2:token@github.com/...)
 * must never leak the token into API responses or logs.
 */
function redactUrl(url) {
  // Strip control characters (C0 + DEL) by filtering codepoints
  const clean = [...url].filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f).join('');
  // Redact HTTPS userinfo: https://user:pass@host → https://***:***@host
  return clean.replace(/^(https?:\/\/)[^@/]+@/, '$1***:***@');
}

/**
 * Verify a single URL against the expected repo.
 * Returns null on success or {code, detail} on failure.
 */
function verifyUrl(url, label) {
  const ownerRepo = extractOwnerRepo(url);
  if (!ownerRepo) {
    return {
      code: 'IDENTITY_FAILED',
      detail: `${label} URL '${redactUrl(url)}' cannot be parsed as a GitHub remote`,
    };
  }
  if (ownerRepo.toLowerCase() !== expectedRepo.toLowerCase()) {
    return {
      code: 'IDENTITY_MISMATCH',
      detail: `${label} resolves to '${ownerRepo}', expected '${expectedRepo}'`,
    };
  }
  return null;
}

function git(gitArgs) {
  return execFileSync('git', ['-C', repoRoot, ...gitArgs], {
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
}

function fail(code, detail) {
  process.stderr.write(`${code}: ${detail}\n`);
  process.exit(1);
}

// --- Identity check: ALL fetch URLs ---
let fetchUrls;
try {
  fetchUrls = git(['remote', 'get-url', '--all', remoteName]).split('\n').filter(Boolean);
} catch {
  fail('IDENTITY_FAILED', `cannot read fetch URLs for remote '${remoteName}'`);
}
if (fetchUrls.length === 0) {
  fail('IDENTITY_FAILED', `remote '${remoteName}' has no fetch URLs`);
}
for (const url of fetchUrls) {
  const error = verifyUrl(url, `fetch[${remoteName}]`);
  if (error) fail(error.code, error.detail);
}

// --- Push URL exfiltration check: ALL push URLs ---
let pushUrls;
try {
  pushUrls = git(['remote', 'get-url', '--push', '--all', remoteName]).split('\n').filter(Boolean);
} catch {
  fail('PUSH_URL_EXFILTRATION', `cannot read push URLs for remote '${remoteName}'`);
}
if (pushUrls.length === 0) {
  fail('PUSH_URL_EXFILTRATION', `remote '${remoteName}' has no push URLs`);
}
for (const url of pushUrls) {
  const error = verifyUrl(url, `push[${remoteName}]`);
  if (error) {
    // Push URL to wrong repo = exfiltration regardless of parse/mismatch
    fail('PUSH_URL_EXFILTRATION', error.detail);
  }
}

// --- Identity-only mode: stop here ---
if (identityOnly) {
  process.exit(0);
}

// --- Full mode: census + source-ref checks ---
if (!baseRef) {
  fail('SOURCE_REF_REQUIRED', '--base-ref or --fresh-base-branch is required in full (non-identity-only) mode');
}

const sourceRef = args['source-ref'];

// Verify census file exists at the resolved base ref
const censusRelPath = 'docs/harness-feedback/registry/measurement-bundles.yaml';
try {
  git(['cat-file', '-e', `${baseRef}:${censusRelPath}`]);
} catch {
  fail(
    'CENSUS_MISSING',
    `measurement census '${censusRelPath}' not found at '${baseRef}'. ` +
      'The publisher cannot refresh the census without a baseline.',
  );
}

// When sourceRef is provided and differs from baseRef, verify the candidate
// also contains the census. A generator that deletes/omits the census must
// not pass the transport guard.
if (sourceRef && sourceRef !== baseRef) {
  try {
    git(['cat-file', '-e', `${sourceRef}:${censusRelPath}`]);
  } catch {
    fail(
      'CENSUS_MISSING_AT_SOURCE',
      `measurement census '${censusRelPath}' not found at source ref '${sourceRef}'. ` +
        'The candidate must preserve the census (generator may have deleted it).',
    );
  }
}
