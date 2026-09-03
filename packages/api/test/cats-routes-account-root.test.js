/**
 * POST /api/cats — account resolution parity with routes/accounts.ts.
 *
 * Regression tests for the "Hub add-Anthropic-cat fails" bug:
 *  1. The accounts page lists canonical OAuth ids ('anthropic', 'openai',
 *     'google') as builtin, but the resolver's builtin map didn't know them,
 *     so create failed with `provider "anthropic" not found` even though the
 *     Hub had just offered the account for selection.
 *  2. routes/accounts.ts reads/writes accounts in the persistent workspace
 *     (redirectRuntimeProjectPath), while POST /api/cats validated against the
 *     raw runtime root — an account visible in the Hub could be invisible to
 *     create-cat when the two roots diverged.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { catRegistry } from '@cat-cafe/shared';
import './helpers/setup-cat-registry.js';

const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

const tempDirs = [];

const ENV_KEYS_TO_ISOLATE = [
  'CAT_TEMPLATE_PATH',
  'CAT_CAFE_GLOBAL_CONFIG_ROOT',
  'CAT_CAFE_CONFIG_ROOT',
  'CAT_CAFE_RUNTIME_ROOT',
  'CAT_CAFE_WORKSPACE_ROOT',
];

function resetRegistryToBuiltins() {
  catRegistry.reset();
  const allConfigs = toAllCatConfigs(loadCatConfig());
  for (const [id, config] of Object.entries(allConfigs)) {
    catRegistry.register(id, config);
  }
}

function makeTemplate() {
  return {
    version: 2,
    breeds: [],
    roster: {},
    reviewPolicy: {
      requireDifferentFamily: true,
      preferActiveInThread: true,
      preferLead: true,
      excludeUnavailable: true,
    },
    coCreator: {
      name: 'Co-worker',
      aliases: ['共创伙伴'],
      mentionPatterns: ['@co-worker', '@owner'],
    },
  };
}

function createProjectRoot(prefix) {
  const projectRoot = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(projectRoot);
  writeFileSync(join(projectRoot, 'cat-template.json'), JSON.stringify(makeTemplate(), null, 2));
  mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.cat-cafe', 'cat-catalog.json'),
    `${JSON.stringify(makeTemplate(), null, 2)}\n`,
    'utf-8',
  );
  return projectRoot;
}

function baseCreatePayload(overrides) {
  return {
    catId: 'probe-anthropic',
    name: '探针猫',
    displayName: '探针猫',
    color: { primary: '#888888', secondary: '#eeeeee' },
    mentionPatterns: ['@probe-anthropic'],
    roleDescription: '回归测试探针',
    clientId: 'anthropic',
    accountRef: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    ...overrides,
  };
}

async function buildApp() {
  const Fastify = (await import('fastify')).default;
  const { catsRoutes } = await import('../dist/routes/cats.js');
  const app = Fastify();
  await app.register(catsRoutes);
  return app;
}

function postCat(app, payload) {
  return app.inject({
    method: 'POST',
    url: '/api/cats',
    headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'terry' },
    body: JSON.stringify(payload),
  });
}

describe('cats routes account-root parity', { concurrency: false }, () => {
  const savedEnv = {};

  beforeEach(() => {
    for (const key of ENV_KEYS_TO_ISOLATE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetRegistryToBuiltins();
  });

  afterEach(() => {
    for (const key of ENV_KEYS_TO_ISOLATE) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    resetRegistryToBuiltins();
  });

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST /api/cats accepts the canonical "anthropic" oauth account id without a stored account', async () => {
    const projectRoot = createProjectRoot('cats-acct-canon-');
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;

    const app = await buildApp();
    const res = await postCat(app, baseCreatePayload({}));
    assert.equal(
      res.statusCode,
      201,
      `expected create to succeed via synthetic builtin fallback, got ${res.statusCode}: ${res.body}`,
    );
    const body = JSON.parse(res.body);
    assert.equal(body.cat.id, 'probe-anthropic');
    assert.equal(body.cat.clientId, 'anthropic');
    await app.close();
  });

  it('POST /api/cats validates accounts against the persistent workspace root (accounts.ts parity)', async () => {
    const runtimeRoot = createProjectRoot('cats-acct-runtime-');
    const workspaceRoot = createProjectRoot('cats-acct-workspace-');
    process.env.CAT_TEMPLATE_PATH = join(runtimeRoot, 'cat-template.json');
    // No CAT_CAFE_GLOBAL_CONFIG_ROOT — mirrors production, where account reads
    // resolve against the projectRoot argument, exposing the runtime/workspace split.
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;

    // The account exists ONLY in the workspace accounts store — exactly what
    // routes/accounts.ts produces when the Hub saves a login while the API
    // serves from the runtime checkout.
    writeFileSync(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify(
        {
          'team-anthropic': {
            authType: 'api_key',
            clientId: 'anthropic',
            displayName: 'Team Anthropic',
            models: ['claude-sonnet-4-6'],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const app = await buildApp();
    const res = await postCat(
      app,
      baseCreatePayload({
        catId: 'probe-workspace',
        mentionPatterns: ['@probe-workspace'],
        accountRef: 'team-anthropic',
      }),
    );
    assert.equal(
      res.statusCode,
      201,
      `expected workspace-stored account to validate, got ${res.statusCode}: ${res.body}`,
    );
    const body = JSON.parse(res.body);
    assert.equal(body.cat.id, 'probe-workspace');
    await app.close();
  });
});
