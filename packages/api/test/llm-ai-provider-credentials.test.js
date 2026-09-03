/**
 * LlmAIProvider credential resolution (re-review P1: credential disclosure).
 *
 * The game LLM path must consume the same atomic account verdict as primary
 * dispatch:
 *  - a foreign-clientId account squatting a well-known id must cause ZERO
 *    network traffic (its key must never be sent to the official endpoint);
 *  - an explicitly bound gateway account sends its key to the gateway baseUrl,
 *    never to the official domain;
 *  - no resolvable key fails closed before any fetch.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';

import { catRegistry } from '@cat-cafe/shared';
import './helpers/setup-cat-registry.js';

const { LlmAIProvider } = await import('../dist/domains/cats/services/game/LlmAIProvider.js');
const { resetMigrationState } = await import('../dist/config/catalog-accounts.js');

const tempDirs = [];
const ENV_KEYS_TO_ISOLATE = [
  'CAT_CAFE_GLOBAL_CONFIG_ROOT',
  'CAT_CAFE_CONFIG_ROOT',
  'CAT_TEMPLATE_PATH',
  'CAT_CAFE_RUNTIME_ROOT',
  'CAT_CAFE_WORKSPACE_ROOT',
  'CAT_CAFE_SKIP_HOMEDIR_MIGRATION',
  'PROJECT_ALLOWED_ROOTS',
  'PROJECT_ALLOWED_ROOTS_APPEND',
  'PROJECT_DENIED_ROOTS',
];

// setup-cat-registry installed this isolated path; restore it per-test so
// deleting CAT_TEMPLATE_PATH inside a case never leaks to other files.
const ISOLATED_TEMPLATE_PATH = process.env.CAT_TEMPLATE_PATH;

function makeGlobalStore(accounts, credentials) {
  const root = mkdtempSync(join(tmpdir(), 'llm-provider-cred-'));
  tempDirs.push(root);
  mkdirSync(join(root, '.cat-cafe'), { recursive: true });
  writeFileSync(join(root, '.cat-cafe', 'accounts.json'), JSON.stringify(accounts, null, 2), 'utf-8');
  if (credentials) {
    writeFileSync(join(root, '.cat-cafe', 'credentials.json'), JSON.stringify(credentials, null, 2), 'utf-8');
  }
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  return root;
}

function registerGameCat(catId, accountRef) {
  const base =
    catRegistry.tryGet('opus')?.config ?? catRegistry.getAllConfigs()[Object.keys(catRegistry.getAllConfigs())[0]];
  assert.ok(base, 'a template cat must exist to derive a game cat');
  catRegistry.register(catId, {
    ...base,
    id: catId,
    mentionPatterns: [`@${catId}`],
    clientId: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    ...(accountRef ? { accountRef } : {}),
  });
}

describe('LlmAIProvider credential safety', { concurrency: false }, () => {
  const savedEnv = {};
  let registrySnapshot;
  let fetchMock;

  beforeEach(() => {
    for (const key of ENV_KEYS_TO_ISOLATE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CAT_CAFE_SKIP_HOMEDIR_MIGRATION = '1';
    if (ISOLATED_TEMPLATE_PATH) process.env.CAT_TEMPLATE_PATH = ISOLATED_TEMPLATE_PATH;
    resetMigrationState();
    registrySnapshot = catRegistry.getAllConfigs();
    fetchMock = mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      json: async () => ({ content: [{ text: '{"actionName":"noop"}' }] }),
      text: async () => '',
    }));
  });

  afterEach(() => {
    fetchMock.mock.restore();
    for (const key of ENV_KEYS_TO_ISOLATE) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    resetMigrationState();
    catRegistry.reset();
    for (const [id, config] of Object.entries(registrySnapshot)) {
      catRegistry.register(id, config);
    }
  });

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('foreign-clientId squatter on "claude": fails closed with ZERO network calls', async () => {
    makeGlobalStore(
      { claude: { authType: 'api_key', clientId: 'openai', baseUrl: 'https://api.openai.com' } },
      { claude: { apiKey: 'sk-openai-secret' } },
    );
    registerGameCat('game-foreign-squat');

    const provider = new LlmAIProvider('game-foreign-squat');
    await assert.rejects(
      () => provider.generateSpeech('say hi'),
      /No anthropic API key resolvable/,
      'a foreign key must never be treated as an Anthropic credential',
    );
    assert.equal(fetchMock.mock.callCount(), 0, 'the foreign key must cause zero network traffic');
  });

  it('explicit gateway binding: key goes to the gateway baseUrl, never the official domain', async () => {
    makeGlobalStore(
      { 'my-gw': { authType: 'api_key', clientId: 'anthropic', baseUrl: 'https://gw.example.com/anthropic' } },
      { 'my-gw': { apiKey: 'sk-gateway-key' } },
    );
    registerGameCat('game-gateway', 'my-gw');

    const provider = new LlmAIProvider('game-gateway');
    await provider.generateSpeech('say hi');

    assert.equal(fetchMock.mock.callCount(), 1);
    const [url, init] = fetchMock.mock.calls[0].arguments;
    assert.equal(url, 'https://gw.example.com/anthropic/v1/messages', 'request must target the gateway endpoint');
    assert.equal(init.headers['x-api-key'], 'sk-gateway-key');
  });

  it('structurally broken account entry: fails closed with ZERO network calls', async () => {
    // Reviewer repro: a bare string where the account object should be, plus a
    // well-formed credential — the sentinel key must never reach the wire.
    makeGlobalStore({ claude: 'not-an-account' }, { claude: { apiKey: 'sk-sentinel-must-not-leak' } });
    registerGameCat('game-broken-shape');

    const provider = new LlmAIProvider('game-broken-shape');
    await assert.rejects(() => provider.generateSpeech('say hi'), /malformed/);
    assert.equal(fetchMock.mock.callCount(), 0, 'a shape-invalid entry must cause zero network traffic');
  });

  it('explicit foreign api_key binding WITHOUT baseUrl: fails closed with ZERO network calls', async () => {
    // Reviewer repro: deliberately bound cross-protocol account with no custom
    // endpoint — its key must not be sent to the official Anthropic domain.
    makeGlobalStore(
      { 'my-openai': { authType: 'api_key', clientId: 'openai' } },
      { 'my-openai': { apiKey: 'sk-openai-explicit' } },
    );
    registerGameCat('game-foreign-explicit', 'my-openai');

    const provider = new LlmAIProvider('game-foreign-explicit');
    await assert.rejects(
      () => provider.generateSpeech('say hi'),
      /refusing to send its key to the official endpoint/,
      'a foreign key without a custom baseUrl must never target the official domain',
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it('explicit same-family api_key without baseUrl still uses the official endpoint', async () => {
    makeGlobalStore(
      { 'my-anthropic': { authType: 'api_key', clientId: 'anthropic' } },
      { 'my-anthropic': { apiKey: 'sk-real-anthropic' } },
    );
    registerGameCat('game-same-family', 'my-anthropic');

    const provider = new LlmAIProvider('game-same-family');
    await provider.generateSpeech('say hi');
    assert.equal(fetchMock.mock.callCount(), 1);
    const [url, init] = fetchMock.mock.calls[0].arguments;
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.headers['x-api-key'], 'sk-real-anthropic');
  });

  it('gateway base already containing /v1 is not double-versioned', async () => {
    makeGlobalStore(
      { 'my-gw-v1': { authType: 'api_key', clientId: 'anthropic', baseUrl: 'https://gw.example.com/v1' } },
      { 'my-gw-v1': { apiKey: 'sk-gw-v1' } },
    );
    registerGameCat('game-gw-v1', 'my-gw-v1');

    const provider = new LlmAIProvider('game-gw-v1');
    await provider.generateSpeech('say hi');
    const [url] = fetchMock.mock.calls[0].arguments;
    assert.equal(url, 'https://gw.example.com/v1/messages', 'versioned gateway base must not double the version');
  });

  it('foreign OAUTH account carrying a key: fails closed with ZERO network calls', async () => {
    // Reviewer repro: the family gate must be independent of authType — an
    // oauth entry with a stored key can leak it just like an api_key one.
    makeGlobalStore(
      { 'my-openai-oauth': { authType: 'oauth', clientId: 'openai' } },
      { 'my-openai-oauth': { apiKey: 'sk-oauth-foreign' } },
    );
    registerGameCat('game-oauth-foreign', 'my-openai-oauth');

    const provider = new LlmAIProvider('game-oauth-foreign');
    await assert.rejects(() => provider.generateSpeech('say hi'), /refusing to send its key to the official endpoint/);
    assert.equal(fetchMock.mock.callCount(), 0, 'a foreign oauth key must cause zero network traffic');
  });

  it('foreign legacy-SUBSCRIPTION account carrying a key: fails closed with ZERO network calls', async () => {
    makeGlobalStore(
      { 'my-openai-sub': { authType: 'subscription', clientId: 'openai' } },
      { 'my-openai-sub': { apiKey: 'sk-subscription-foreign' } },
    );
    registerGameCat('game-sub-foreign', 'my-openai-sub');

    const provider = new LlmAIProvider('game-sub-foreign');
    await assert.rejects(() => provider.generateSpeech('say hi'), /refusing to send its key to the official endpoint/);
    assert.equal(fetchMock.mock.callCount(), 0, 'a foreign legacy-subscription key must cause zero network traffic');
  });

  it('freshly-created "claude" api_key WITHOUT clientId: display-name slug is not identity, ZERO network calls', async () => {
    // Reviewer repro: an unknown api_key account whose deriveAccountId slug
    // collides with the well-known builtin id must not inherit its identity.
    makeGlobalStore({ claude: { authType: 'api_key' } }, { claude: { apiKey: 'sk-slug-impostor' } });
    registerGameCat('game-slug-impostor', 'claude');

    const provider = new LlmAIProvider('game-slug-impostor');
    await assert.rejects(() => provider.generateSpeech('say hi'), /refusing to send its key to the official endpoint/);
    assert.equal(fetchMock.mock.callCount(), 0, 'a slug-impostor key must cause zero network traffic');
  });

  it('launcher coordinate: resolves the workspace store even when cwd is runtime/packages/api', async () => {
    // Production mirror: start-dev.sh runs the API from packages/api, GLOBAL
    // unset, accounts only in the workspace root. Raw process.cwd() misses
    // them; the provider must resolve the ACTIVE project root like dispatch.
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'llm-launcher-rt-'));
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'llm-launcher-ws-'));
    tempDirs.push(runtimeRoot, workspaceRoot);
    mkdirSync(join(runtimeRoot, 'packages', 'api'), { recursive: true });
    writeFileSync(join(runtimeRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');
    mkdirSync(join(workspaceRoot, '.cat-cafe'), { recursive: true });
    writeFileSync(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({ 'ws-anthropic': { authType: 'api_key', clientId: 'anthropic' } }, null, 2),
      'utf-8',
    );
    writeFileSync(
      join(workspaceRoot, '.cat-cafe', 'credentials.json'),
      JSON.stringify({ 'ws-anthropic': { apiKey: 'sk-workspace-launcher' } }, null, 2),
      'utf-8',
    );
    delete process.env.CAT_TEMPLATE_PATH;
    delete process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;
    registerGameCat('game-launcher', 'ws-anthropic');

    const previousCwd = process.cwd();
    try {
      process.chdir(join(runtimeRoot, 'packages', 'api'));
      const provider = new LlmAIProvider('game-launcher');
      await provider.generateSpeech('say hi');
    } finally {
      process.chdir(previousCwd);
    }
    assert.equal(fetchMock.mock.callCount(), 1, 'workspace-stored key must resolve from the launcher cwd');
    const [, init] = fetchMock.mock.calls[0].arguments;
    assert.equal(init.headers['x-api-key'], 'sk-workspace-launcher');
  });

  it('google call injects the key via searchParams (base with existing query stays intact)', async () => {
    makeGlobalStore(
      { 'my-google': { authType: 'api_key', clientId: 'google', baseUrl: 'https://gw.example.com?alt=json' } },
      { 'my-google': { apiKey: 'sk-google-key' } },
    );
    const base =
      catRegistry.tryGet('opus')?.config ?? catRegistry.getAllConfigs()[Object.keys(catRegistry.getAllConfigs())[0]];
    catRegistry.register('game-google', {
      ...base,
      id: 'game-google',
      mentionPatterns: ['@game-google'],
      clientId: 'google',
      defaultModel: 'gemini-3.5-flash',
      accountRef: 'my-google',
    });
    fetchMock.mock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
      text: async () => '',
    }));

    const provider = new LlmAIProvider('game-google');
    await provider.generateSpeech('say hi');
    const [url] = fetchMock.mock.calls[0].arguments;
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('key'), 'sk-google-key', 'key must be set via searchParams');
    assert.equal(parsed.searchParams.get('alt'), 'json', 'pre-existing query params must survive');
  });

  it('no resolvable credential: throws before any fetch', async () => {
    makeGlobalStore({}, {});
    registerGameCat('game-no-key');

    const provider = new LlmAIProvider('game-no-key');
    await assert.rejects(() => provider.generateSpeech('say hi'), /No anthropic API key resolvable/);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});
