/**
 * Account-store compatibility resolver (#1303 / F289 Phase 0 slice).
 *
 * Per-ref verdict across the workspace (canonical) and runtime (legacy)
 * stores: canonical-only, legacy-only (legacy installs stay readable),
 * both-equal, and divergent copies which must fail closed as a conflict —
 * never a silent "workspace wins".
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

const { resolveAccountStoreTopology, selectAccountStoreForFamily, selectAccountStoreForRef } = await import(
  '../dist/config/account-root.js'
);
const { resetMigrationState } = await import('../dist/config/catalog-accounts.js');

const tempDirs = [];

const ENV_KEYS_TO_ISOLATE = [
  'CAT_CAFE_GLOBAL_CONFIG_ROOT',
  'CAT_CAFE_RUNTIME_ROOT',
  'CAT_CAFE_WORKSPACE_ROOT',
  'CAT_CAFE_SKIP_HOMEDIR_MIGRATION',
];

function makeRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(root);
  mkdirSync(join(root, '.cat-cafe'), { recursive: true });
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
  });

  it('same account but divergent credential secrets fails closed as a conflict', async () => {
    const entry = { acme: { authType: 'api_key', clientId: 'anthropic' } };
    writeStore(workspaceRoot, entry, { acme: { apiKey: 'sk-workspace' } });
    writeStore(runtimeRoot, entry, { acme: { apiKey: 'sk-runtime' } });
    const sel = selectAccountStoreForRef(await topology(), 'acme');
    assert.equal(sel.kind, 'conflict', 'divergent secrets must not silently pick a winner');
  });

  it('family verdict uses the first candidate present in either store', async () => {
    writeStore(workspaceRoot, {});
    writeStore(runtimeRoot, { claude: { authType: 'oauth' } });
    const sel = selectAccountStoreForFamily(await topology(), ['claude', 'builtin_anthropic', 'installer-anthropic']);
    assert.equal(sel.kind, 'ok');
    assert.equal(sel.origin, 'legacy');
  });

  it('single-checkout topology has no legacy root and always resolves canonically', async () => {
    delete process.env.CAT_CAFE_RUNTIME_ROOT;
    delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    const t = await resolveAccountStoreTopology(workspaceRoot);
    assert.ok(t);
    assert.equal(t.legacyRoot, null);
    writeStore(workspaceRoot, { acme: { authType: 'api_key', clientId: 'anthropic' } });
    const sel = selectAccountStoreForRef(t, 'acme');
    assert.equal(sel.kind, 'ok');
    assert.equal(sel.origin, 'canonical');
  });

  it('declared runtime root without workspace root is an unresolvable topology', async () => {
    delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    const t = await resolveAccountStoreTopology(runtimeRoot);
    assert.equal(t, null, 'callers must fail closed on unresolvable topology');
  });
});
