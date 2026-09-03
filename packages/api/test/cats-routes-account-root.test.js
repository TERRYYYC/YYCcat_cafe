/**
 * POST/PATCH /api/cats — account resolution parity with routes/accounts.ts
 * and with primary dispatch (invoke-single-cat).
 *
 * Regression tests for the "Hub add-Anthropic-cat fails" bug (upstream #1303):
 *  1. The accounts page lists canonical OAuth ids ('anthropic', 'openai',
 *     'google') as builtin, but the resolver's builtin map didn't know them,
 *     so create failed with `provider "anthropic" not found` even though the
 *     Hub had just offered the account for selection.
 *  2. routes/accounts.ts reads/writes accounts in the persistent workspace
 *     (redirectRuntimeProjectPath), while POST /api/cats validated against the
 *     raw runtime root — an account visible in the Hub could be invisible to
 *     create-cat when the two roots diverged.
 *  3. A binding that passes validation MUST also resolve on the dispatch path
 *     (same account-root contract), otherwise create turns a safe 400 into a
 *     persisted broken binding.
 *
 * Hermetic: template path stays on the isolated copy installed by
 * helpers/setup-cat-registry.js, homedir account migration is disabled, and
 * project-root allow/deny env policy is cleared for the duration of each test.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { catRegistry } from '@cat-cafe/shared';
import './helpers/setup-cat-registry.js';

// Captured AFTER the setup helper ran: the isolated temp template copy.
// resetRegistryToBuiltins() must always load THIS path explicitly — falling
// back to env/cwd discovery can migrate/write the real repo catalog.
const ISOLATED_TEMPLATE_PATH = process.env.CAT_TEMPLATE_PATH;
assert.ok(ISOLATED_TEMPLATE_PATH, 'setup-cat-registry.js must install an isolated CAT_TEMPLATE_PATH');

const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
const { resetMigrationState } = await import('../dist/config/catalog-accounts.js');

const tempDirs = [];

const ENV_KEYS_TO_ISOLATE = [
  'CAT_TEMPLATE_PATH',
  'CAT_CAFE_GLOBAL_CONFIG_ROOT',
  'CAT_CAFE_CONFIG_ROOT',
  'CAT_CAFE_RUNTIME_ROOT',
  'CAT_CAFE_WORKSPACE_ROOT',
  'CAT_CAFE_SKIP_HOMEDIR_MIGRATION',
  'PROJECT_ALLOWED_ROOTS',
  'PROJECT_ALLOWED_ROOTS_APPEND',
  'PROJECT_DENIED_ROOTS',
];

function resetRegistryToBuiltins() {
  catRegistry.reset();
  const allConfigs = toAllCatConfigs(loadCatConfig(ISOLATED_TEMPLATE_PATH));
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

function writeAccountsStore(workspaceRoot, accounts) {
  writeFileSync(join(workspaceRoot, '.cat-cafe', 'accounts.json'), JSON.stringify(accounts, null, 2), 'utf-8');
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

function injectCat(app, method, url, payload) {
  return app.inject({
    method,
    url,
    headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'terry' },
    body: JSON.stringify(payload),
  });
}

/** Fast-layer dispatch check: calls the EXACT atomic resolver primary
 *  dispatch and game LLM calls consume. The full wiring (real invokeSingleCat
 *  + stub service) is covered in invoke-single-cat.test.js. */
async function resolveLikeDispatch(runtimeProjectRoot, builtinClient, accountRef) {
  const { resolveRuntimeAccountProfile } = await import('../dist/config/account-root.js');
  const resolution = await resolveRuntimeAccountProfile(runtimeProjectRoot, builtinClient, accountRef);
  return resolution.kind === 'ok' ? resolution.profile : null;
}

describe('cats routes account-root parity', { concurrency: false }, () => {
  const savedEnv = {};

  beforeEach(() => {
    for (const key of ENV_KEYS_TO_ISOLATE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Hermetic: never let the accounts store walk into the real home directory.
    process.env.CAT_CAFE_SKIP_HOMEDIR_MIGRATION = '1';
    resetMigrationState();
    resetRegistryToBuiltins();
  });

  afterEach(() => {
    for (const key of ENV_KEYS_TO_ISOLATE) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    resetMigrationState();
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
    const res = await injectCat(app, 'POST', '/api/cats', baseCreatePayload({}));
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

  it('POST /api/cats accepts a workspace-stored account AND the binding resolves on the dispatch path', async () => {
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
    writeAccountsStore(workspaceRoot, {
      'team-anthropic': {
        authType: 'api_key',
        clientId: 'anthropic',
        displayName: 'Team Anthropic',
        models: ['claude-sonnet-4-6'],
      },
    });

    const app = await buildApp();
    const res = await injectCat(
      app,
      'POST',
      '/api/cats',
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

    // P1 guard: what validation accepted, dispatch must resolve (same contract).
    const dispatched = await resolveLikeDispatch(runtimeRoot, 'anthropic', 'team-anthropic');
    assert.ok(dispatched, 'binding accepted by POST must be resolvable on the dispatch path');
    assert.equal(dispatched.id, 'team-anthropic');
    assert.equal(dispatched.authType, 'api_key');
    await app.close();
  });

  it('PATCH /api/cats rebinding to a workspace-stored account validates and resolves on the dispatch path', async () => {
    const runtimeRoot = createProjectRoot('cats-acct-patch-rt-');
    const workspaceRoot = createProjectRoot('cats-acct-patch-ws-');
    process.env.CAT_TEMPLATE_PATH = join(runtimeRoot, 'cat-template.json');
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;

    writeAccountsStore(workspaceRoot, {
      'team-anthropic': {
        authType: 'api_key',
        clientId: 'anthropic',
        displayName: 'Team Anthropic',
        models: ['claude-sonnet-4-6'],
      },
      'team-anthropic-2': {
        authType: 'api_key',
        clientId: 'anthropic',
        displayName: 'Team Anthropic 2',
        models: ['claude-sonnet-4-6'],
      },
    });

    const app = await buildApp();
    const createRes = await injectCat(
      app,
      'POST',
      '/api/cats',
      baseCreatePayload({
        catId: 'probe-patch',
        mentionPatterns: ['@probe-patch'],
        accountRef: 'team-anthropic',
      }),
    );
    assert.equal(createRes.statusCode, 201, `create precondition failed: ${createRes.body}`);

    // Upstream #1303 reports exactly this journey: newly saved account is
    // visible in the Hub, then rebinding the cat fails with provider not found.
    const patchRes = await injectCat(app, 'PATCH', '/api/cats/probe-patch', {
      accountRef: 'team-anthropic-2',
    });
    assert.equal(
      patchRes.statusCode,
      200,
      `expected rebinding to a workspace-stored account to succeed, got ${patchRes.statusCode}: ${patchRes.body}`,
    );

    const dispatched = await resolveLikeDispatch(runtimeRoot, 'anthropic', 'team-anthropic-2');
    assert.ok(dispatched, 'binding accepted by PATCH must be resolvable on the dispatch path');
    assert.equal(dispatched.id, 'team-anthropic-2');
    await app.close();
  });

  it('POST /api/cats fails closed (400) when the account has divergent runtime/workspace copies', async () => {
    const runtimeRoot = createProjectRoot('cats-acct-conflict-rt-');
    const workspaceRoot = createProjectRoot('cats-acct-conflict-ws-');
    process.env.CAT_TEMPLATE_PATH = join(runtimeRoot, 'cat-template.json');
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;

    // Same id, divergent content — authority is a reconciler decision (F289),
    // create must not silently pick the workspace copy.
    writeAccountsStore(workspaceRoot, {
      'team-anthropic': { authType: 'api_key', clientId: 'anthropic', baseUrl: 'https://a', models: ['m'] },
    });
    writeAccountsStore(runtimeRoot, {
      'team-anthropic': { authType: 'api_key', clientId: 'anthropic', baseUrl: 'https://b', models: ['m'] },
    });

    const app = await buildApp();
    const res = await injectCat(app, 'POST', '/api/cats', baseCreatePayload({ accountRef: 'team-anthropic' }));
    assert.equal(res.statusCode, 400, `expected conflict to fail closed, got ${res.statusCode}: ${res.body}`);
    assert.match(JSON.parse(res.body).error, /divergent between/i);
    await app.close();
  });

  it('PATCH of an unrelated field succeeds even when the topology is unresolvable', async () => {
    // First create the cat in a healthy single-checkout topology.
    const projectRoot = createProjectRoot('cats-acct-unrelated-');
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;

    const app = await buildApp();
    const createRes = await injectCat(
      app,
      'POST',
      '/api/cats',
      baseCreatePayload({ catId: 'probe-unrelated', mentionPatterns: ['@probe-unrelated'] }),
    );
    assert.equal(createRes.statusCode, 201, `create precondition failed: ${createRes.body}`);

    // Now break the topology: runtime declared, workspace missing. A PATCH
    // that touches neither account nor provider nor serviceTier must not be
    // blocked by account-store resolution.
    process.env.CAT_CAFE_RUNTIME_ROOT = projectRoot;
    delete process.env.CAT_CAFE_WORKSPACE_ROOT;

    const patchRes = await injectCat(app, 'PATCH', '/api/cats/probe-unrelated', {
      displayName: '改个名字',
    });
    assert.equal(
      patchRes.statusCode,
      200,
      `unrelated PATCH must not require account topology, got ${patchRes.statusCode}: ${patchRes.body}`,
    );
    await app.close();
  });

  it('POST /api/cats fails closed (400) when the runtime/workspace topology is unresolvable', async () => {
    const runtimeRoot = createProjectRoot('cats-acct-badtopo-');
    process.env.CAT_TEMPLATE_PATH = join(runtimeRoot, 'cat-template.json');
    // Runtime root declared, workspace root missing → redirect cannot resolve.
    // The accounts routes already fail closed here; create must not fail open
    // into validating against a divergent root.
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    delete process.env.CAT_CAFE_WORKSPACE_ROOT;

    const app = await buildApp();
    const res = await injectCat(app, 'POST', '/api/cats', baseCreatePayload({}));
    assert.equal(
      res.statusCode,
      400,
      `expected fail-closed 400 on unresolvable topology, got ${res.statusCode}: ${res.body}`,
    );
    assert.match(JSON.parse(res.body).error, /accounts root unresolvable/i);
    await app.close();
  });
});
