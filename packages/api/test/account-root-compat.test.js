/**
 * Account-store compatibility resolver (#1303 / F289 Phase 0 slice).
 *
 * Per-ref verdict across the workspace (canonical) and runtime (legacy)
 * stores: canonical-only, legacy-only (legacy installs stay readable),
 * both-equal, divergent copies and TORN pairs fail closed, malformed stores
 * are INVALID (never treated as absent), probing is strictly read-only, and
 * CAT_CAFE_GLOBAL_CONFIG_ROOT collapses the topology to a single store
 * (upstream #1303 workaround stays supported).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

const { resolveAccountStoreTopology, resolveRuntimeAccountProfile, selectAccountStoreForRef } = await import(
  '../dist/config/account-root.js'
);
const { resetMigrationState } = await import('../dist/config/catalog-accounts.js');

const tempDirs = [];

const ENV_KEYS_TO_ISOLATE = [
  'CAT_CAFE_GLOBAL_CONFIG_ROOT',
  'CAT_CAFE_RUNTIME_ROOT',
  'CAT_CAFE_WORKSPACE_ROOT',
  'CAT_CAFE_SKIP_HOMEDIR_MIGRATION',
  'PROJECT_ALLOWED_ROOTS',
  'PROJECT_ALLOWED_ROOTS_APPEND',
  'PROJECT_DENIED_ROOTS',
];

function makeRoot(prefix, { withCatCafeDir = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(root);
  if (withCatCafeDir) mkdirSync(join(root, '.cat-cafe'), { recursive: true });
  return root;
}

function writeStore(root, accounts, credentials) {
  writeFileSync(join(root, '.cat-cafe', 'accounts.json'), JSON.stringify(accounts, null, 2), 'utf-8');
  if (credentials) {
    writeFileSync(join(root, '.cat-cafe', 'credentials.json'), JSON.stringify(credentials, null, 2), 'utf-8');
  }
}

describe('account-store compatibility verdict', { concurrency: false }, () => {
  const savedEnv = {};
  let runtimeRoot;
  let workspaceRoot;

  beforeEach(() => {
    for (const key of ENV_KEYS_TO_ISOLATE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CAT_CAFE_SKIP_HOMEDIR_MIGRATION = '1';
    resetMigrationState();
    runtimeRoot = makeRoot('acct-compat-rt-');
    workspaceRoot = makeRoot('acct-compat-ws-');
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;
  });

  afterEach(() => {
    for (const key of ENV_KEYS_TO_ISOLATE) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    resetMigrationState();
  });

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function topology() {
    const t = await resolveAccountStoreTopology(runtimeRoot);
    assert.ok(t, 'split topology must resolve');
    assert.ok(t.legacyRoot, 'legacy root must be detected in split topology');
    return t;
  }

  it('canonical-only account resolves to the workspace store', async () => {
    writeStore(workspaceRoot, { acme: { authType: 'api_key', clientId: 'anthropic', models: ['m'] } });
    writeStore(runtimeRoot, {});
    const sel = selectAccountStoreForRef(await topology(), 'acme');
    assert.equal(sel.kind, 'ok');
    assert.equal(sel.origin, 'canonical');
  });

  it('legacy-only account stays readable from the runtime store', async () => {
    writeStore(workspaceRoot, {});
    writeStore(runtimeRoot, { 'legacy-acme': { authType: 'api_key', clientId: 'openai' } });
    const sel = selectAccountStoreForRef(await topology(), 'legacy-acme');
    assert.equal(sel.kind, 'ok');
    assert.equal(sel.origin, 'legacy');
  });

  it('equal copies in both stores resolve to the canonical store', async () => {
    const entry = { acme: { authType: 'api_key', clientId: 'anthropic', models: ['m'] } };
    const cred = { acme: { apiKey: 'sk-same' } };
    writeStore(workspaceRoot, entry, cred);
    writeStore(runtimeRoot, entry, cred);
    const sel = selectAccountStoreForRef(await topology(), 'acme');
    assert.equal(sel.kind, 'ok');
    assert.equal(sel.origin, 'both-equal');
  });

  it('divergent account content fails closed as a conflict', async () => {
    writeStore(workspaceRoot, { acme: { authType: 'api_key', clientId: 'anthropic', baseUrl: 'https://a' } });
    writeStore(runtimeRoot, { acme: { authType: 'api_key', clientId: 'anthropic', baseUrl: 'https://b' } });
    const sel = selectAccountStoreForRef(await topology(), 'acme');
    assert.equal(sel.kind, 'conflict', 'divergent copies must not silently pick a winner');
    assert.equal(sel.reason, 'divergent');
  });

  it('same account but divergent credential secrets fails closed as a conflict', async () => {
    const entry = { acme: { authType: 'api_key', clientId: 'anthropic' } };
    writeStore(workspaceRoot, entry, { acme: { apiKey: 'sk-workspace' } });
    writeStore(runtimeRoot, entry, { acme: { apiKey: 'sk-runtime' } });
    const sel = selectAccountStoreForRef(await topology(), 'acme');
    assert.equal(sel.kind, 'conflict', 'divergent secrets must not silently pick a winner');
  });

  it('torn pair (canonical account, legacy-only credential) fails closed', async () => {
    writeStore(workspaceRoot, { acme: { authType: 'api_key', clientId: 'anthropic' } });
    writeStore(runtimeRoot, {}, { acme: { apiKey: 'sk-only-in-legacy' } });
    const sel = selectAccountStoreForRef(await topology(), 'acme');
    assert.equal(sel.kind, 'conflict', 'a torn pair must not validate on one side and lose its key at dispatch');
    assert.equal(sel.reason, 'torn');
  });

  it('torn pair (legacy account, canonical-only credential) fails closed', async () => {
    writeStore(workspaceRoot, {}, { acme: { apiKey: 'sk-only-in-canonical' } });
    writeStore(runtimeRoot, { acme: { authType: 'api_key', clientId: 'anthropic' } });
    const sel = selectAccountStoreForRef(await topology(), 'acme');
    assert.equal(sel.kind, 'conflict');
    assert.equal(sel.reason, 'torn');
  });

  it('malformed store file is INVALID, never absent', async () => {
    writeStore(workspaceRoot, { acme: { authType: 'api_key', clientId: 'anthropic' } });
    writeFileSync(join(runtimeRoot, '.cat-cafe', 'accounts.json'), '{ not json', 'utf-8');
    const sel = selectAccountStoreForRef(await topology(), 'acme');
    assert.equal(sel.kind, 'invalid', 'a parse failure must fail closed, not read as absence');
    assert.match(sel.store, /accounts\.json/);
  });

  it('store probing is strictly read-only — no migration writes into the probed root', async () => {
    // Legacy root contains ONLY a pre-migration embedded catalog. The old
    // migration-aware reader would materialize accounts.json here on probe.
    writeFileSync(
      join(runtimeRoot, '.cat-cafe', 'cat-catalog.json'),
      JSON.stringify({ version: 2, breeds: [], roster: {}, accounts: { emb: { authType: 'oauth' } } }, null, 2),
      'utf-8',
    );
    const before = readdirSync(join(runtimeRoot, '.cat-cafe')).sort();
    const sel = selectAccountStoreForRef(await topology(), 'emb');
    assert.equal(sel.kind, 'ok', 'embedded pre-migration account must be readable');
    assert.equal(sel.origin, 'legacy');
    const afterFiles = readdirSync(join(runtimeRoot, '.cat-cafe')).sort();
    assert.deepEqual(afterFiles, before, 'probing must not create or migrate any file in the probed store');
  });

  it('CAT_CAFE_GLOBAL_CONFIG_ROOT collapses to a single global store (upstream #1303 workaround)', async () => {
    const globalRoot = makeRoot('acct-compat-global-');
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
    // Runtime declared, workspace missing — previously an unresolvable
    // topology; with GLOBAL set it must be a healthy single store.
    delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    writeStore(globalRoot, { acme: { authType: 'api_key', clientId: 'anthropic', models: ['m'] } });

    const t = await resolveAccountStoreTopology(runtimeRoot);
    assert.ok(t, 'GLOBAL root must yield a resolvable topology even without a workspace root');
    assert.equal(t.legacyRoot, null);
    const sel = selectAccountStoreForRef(t, 'acme');
    assert.equal(sel.kind, 'ok', 'the account stored under the global root must be found');
  });

  it('declared runtime root without workspace root (and no GLOBAL) is unresolvable', async () => {
    delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    const t = await resolveAccountStoreTopology(runtimeRoot);
    assert.equal(t, null, 'callers must fail closed on unresolvable topology');
  });

  // ── Atomic family + profile resolution ──

  it('family resolution fails closed when ANY candidate is divergent, even an unranked installer', async () => {
    // Both stores agree on the oauth "claude" builtin…
    const claude = { claude: { authType: 'oauth' } };
    // …but the installer credential secret diverges. A split ranking would
    // lock the root by "claude" then silently pick one installer secret.
    writeStore(
      workspaceRoot,
      { ...claude, 'installer-anthropic': { authType: 'api_key' } },
      {
        'installer-anthropic': { apiKey: 'sk-canonical' },
      },
    );
    writeStore(
      runtimeRoot,
      { ...claude, 'installer-anthropic': { authType: 'api_key' } },
      {
        'installer-anthropic': { apiKey: 'sk-legacy' },
      },
    );
    await assert.rejects(
      () => resolveRuntimeAccountProfile(runtimeRoot, 'anthropic', undefined),
      /divergent between/i,
      'ranking must never route around a divergent candidate',
    );
  });

  it('family resolution ranks an identity-matched credentialed candidate from ITS OWN verdict root', async () => {
    // claude oauth equal in both stores; installer key exists ONLY in legacy.
    writeStore(workspaceRoot, { claude: { authType: 'oauth' } });
    writeStore(
      runtimeRoot,
      { claude: { authType: 'oauth' }, 'installer-anthropic': { authType: 'api_key', clientId: 'anthropic' } },
      { 'installer-anthropic': { apiKey: 'sk-legacy-installer' } },
    );
    const resolution = await resolveRuntimeAccountProfile(runtimeRoot, 'anthropic', undefined);
    assert.equal(resolution.kind, 'ok');
    assert.equal(resolution.profile.id, 'installer-anthropic');
    assert.equal(resolution.profile.apiKey, 'sk-legacy-installer');
    assert.equal(resolution.root, runtimeRoot, 'profile must come from the candidate own verdict root');
  });

  it('family resolution skips foreign-clientId squatters and includes canonical ids', async () => {
    writeStore(
      workspaceRoot,
      {
        claude: { authType: 'api_key', clientId: 'openai' },
        anthropic: { authType: 'api_key', clientId: 'anthropic', models: ['m'] },
      },
      { claude: { apiKey: 'sk-openai-foreign' }, anthropic: { apiKey: 'sk-real-anthropic' } },
    );
    writeStore(runtimeRoot, {});
    const resolution = await resolveRuntimeAccountProfile(runtimeRoot, 'anthropic', undefined);
    assert.equal(resolution.kind, 'ok');
    assert.equal(resolution.profile.id, 'anthropic', 'canonical id must participate; foreign squatter must be skipped');
    assert.equal(resolution.profile.apiKey, 'sk-real-anthropic');
  });

  it('explicit binding takes the per-ref verdict and resolves that exact ref', async () => {
    writeStore(
      workspaceRoot,
      { 'my-gw': { authType: 'api_key', clientId: 'anthropic', baseUrl: 'https://gw' } },
      {
        'my-gw': { apiKey: 'sk-gw' },
      },
    );
    writeStore(runtimeRoot, {});
    const resolution = await resolveRuntimeAccountProfile(runtimeRoot, 'anthropic', 'my-gw');
    assert.equal(resolution.kind, 'ok');
    assert.equal(resolution.profile.id, 'my-gw');
    assert.equal(resolution.profile.baseUrl, 'https://gw');
  });
});
