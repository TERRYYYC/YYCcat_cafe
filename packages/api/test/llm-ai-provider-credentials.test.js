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
  'CAT_CAFE_RUNTIME_ROOT',
  'CAT_CAFE_WORKSPACE_ROOT',
  'CAT_CAFE_SKIP_HOMEDIR_MIGRATION',
  'PROJECT_ALLOWED_ROOTS',
  'PROJECT_ALLOWED_ROOTS_APPEND',
  'PROJECT_DENIED_ROOTS',
];

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

  it('no resolvable credential: throws before any fetch', async () => {
    makeGlobalStore({}, {});
    registerGameCat('game-no-key');

    const provider = new LlmAIProvider('game-no-key');
    await assert.rejects(() => provider.generateSpeech('say hi'), /No anthropic API key resolvable/);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});
