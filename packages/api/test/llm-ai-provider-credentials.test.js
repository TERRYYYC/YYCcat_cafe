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

  it('no resolvable credential: throws before any fetch', async () => {
    makeGlobalStore({}, {});
    registerGameCat('game-no-key');

    const provider = new LlmAIProvider('game-no-key');
    await assert.rejects(() => provider.generateSpeech('say hi'), /No anthropic API key resolvable/);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});
