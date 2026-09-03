import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('account-resolver (4b unified runtime resolution)', () => {
  let projectRoot;
  let previousGlobalRoot;
  const ENV_KEYS_TO_ISOLATE = [
    'CAT_CAFE_GLOBAL_CONFIG_ROOT',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_API_KEY',
    'HOME',
  ];
  const savedEnv = {};

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'acct-resolve-'));
    // Snapshot and clear all env vars that could pollute resolver results
    for (const key of ENV_KEYS_TO_ISOLATE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;
    // Isolate homedir so the homedir migration doesn't pick up real ~/.cat-cafe/ files
    process.env.HOME = projectRoot;
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
  });

  afterEach(async () => {
    // Restore all saved env vars
    for (const key of ENV_KEYS_TO_ISOLATE) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await rm(projectRoot, { recursive: true, force: true });
  });

  function writeCatalog(accounts) {
    const catalog = {
      version: 2,
      breeds: [],
      roster: {},
      reviewPolicy: {
        requireDifferentFamily: true,
        preferActiveInThread: true,
        preferLead: true,
        excludeUnavailable: true,
      },
      accounts,
    };
    return writeFile(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(catalog, null, 2), 'utf-8');
  }

  function writeCredentials(creds) {
    return writeFile(join(projectRoot, '.cat-cafe', 'credentials.json'), JSON.stringify(creds, null, 2), 'utf-8');
  }

  it('providerRequiresThreadWorkspace: only OpenCode requires a thread workspace (provider-level capability, not hardcoded in invocation layer)', async () => {
    const { providerRequiresThreadWorkspace } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-rtw`);
    // OpenCode resolves project files relative to cwd and has no silent fallback like
    // Claude/Codex — without a validated workspace it would inherit the runtime cwd.
    assert.equal(providerRequiresThreadWorkspace('opencode'), true);
    // Providers with their own cwd sources / silent fallback must NOT be forced.
    assert.equal(providerRequiresThreadWorkspace('anthropic'), false);
    assert.equal(providerRequiresThreadWorkspace('openai'), false);
    assert.equal(providerRequiresThreadWorkspace('google'), false);
    assert.equal(providerRequiresThreadWorkspace('kimi'), false);
    // Unknown / undefined provider must default to false (no surprise hard-fail).
    assert.equal(providerRequiresThreadWorkspace(undefined), false);
  });

  it('resolveByAccountRef returns RuntimeProviderProfile from accounts + credentials', async () => {
    const { resolveByAccountRef } = await import(`../dist/config/account-resolver.js?t=${Date.now()}`);
    await writeCatalog({
      'my-glm': {
        authType: 'api_key',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        models: ['glm-5'],
        modelAliases: { 'glm-5': 'upstream-glm-5' },
        displayName: 'My GLM',
      },
    });
    await writeCredentials({ 'my-glm': { apiKey: 'glm-xxx' } });

    const profile = resolveByAccountRef(projectRoot, 'my-glm');
    assert.ok(profile);
    assert.equal(profile.id, 'my-glm');
    assert.equal(profile.authType, 'api_key');
    assert.equal(profile.kind, 'api_key');
    // clowder-ai#340: protocol no longer on custom accounts — derived at runtime by client/provider
    assert.equal(profile.protocol, undefined);
    assert.equal(profile.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
    assert.equal(profile.apiKey, 'glm-xxx');
    assert.deepEqual(profile.models, ['glm-5']);
    assert.deepEqual(profile.modelAliases, { 'glm-5': 'upstream-glm-5' });
  });

  it('resolveByAccountRef returns builtin-style profile for oauth accounts', async () => {
    const { resolveByAccountRef } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-1`);
    await writeCatalog({
      claude: {
        authType: 'oauth',
        models: ['claude-opus-4-6', 'claude-sonnet-4-6'],
      },
    });
    await writeCredentials({});

    const profile = resolveByAccountRef(projectRoot, 'claude');
    assert.ok(profile);
    assert.equal(profile.id, 'claude');
    assert.equal(profile.authType, 'oauth');
    assert.equal(profile.protocol, 'anthropic');
    assert.equal(profile.apiKey, undefined);
  });

  it('resolveByAccountRef returns null for unknown ref', async () => {
    const { resolveByAccountRef } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-2`);
    await writeCatalog({});

    const profile = resolveByAccountRef(projectRoot, 'nonexistent');
    assert.equal(profile, null);
  });

  it('resolveByAccountRef injects apiKey from credentials', async () => {
    const { resolveByAccountRef } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-3`);
    await writeCatalog({
      custom: { authType: 'api_key' },
    });
    await writeCredentials({ custom: { apiKey: 'sk-custom-key' } });

    const profile = resolveByAccountRef(projectRoot, 'custom');
    assert.ok(profile);
    assert.equal(profile.apiKey, 'sk-custom-key');
  });

  it('resolveByAccountRef maps client from well-known ID for builtin accounts', async () => {
    const { resolveByAccountRef } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-4`);
    await writeCatalog({
      codex: { authType: 'oauth', models: ['gpt-5.3-codex'] },
    });
    await writeCredentials({});

    const profile = resolveByAccountRef(projectRoot, 'codex');
    assert.ok(profile);
    assert.equal(profile.client, 'openai');
  });

  it('resolveForClient resolves by well-known builtin ID', async () => {
    const { resolveForClient } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-5`);
    await writeCatalog({
      claude: { authType: 'oauth', models: ['claude-opus-4-6'] },
      codex: { authType: 'oauth', models: ['gpt-5.3-codex'] },
    });
    await writeCredentials({});

    const profile = resolveForClient(projectRoot, 'anthropic');
    assert.ok(profile);
    assert.equal(profile.id, 'claude');
    assert.equal(profile.protocol, 'anthropic');
  });

  it('resolveForClient prefers preferredAccountRef when provided', async () => {
    const { resolveForClient } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-6`);
    await writeCatalog({
      claude: { authType: 'oauth' },
      'my-ant': { authType: 'api_key', baseUrl: 'https://custom.ant.com' },
    });
    await writeCredentials({ 'my-ant': { apiKey: 'sk-custom' } });

    const profile = resolveForClient(projectRoot, 'anthropic', 'my-ant');
    assert.ok(profile);
    assert.equal(profile.id, 'my-ant');
    assert.equal(profile.baseUrl, 'https://custom.ant.com');
    assert.equal(profile.apiKey, 'sk-custom');
  });

  it('resolveForClient returns null when explicit preferredAccountRef is not found (fail closed)', async () => {
    const { resolveForClient } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-7`);
    await writeCatalog({
      claude: { authType: 'oauth' },
    });
    await writeCredentials({});

    // Explicit ref that doesn't exist must return null, not silently fall back to 'claude'
    const profile = resolveForClient(projectRoot, 'anthropic', 'deleted-custom-account');
    assert.equal(profile, null, 'explicit preferredAccountRef miss must fail closed');
  });

  it('resolveForClient discovers installer-${client} API key account when no builtin exists', async () => {
    const { resolveForClient } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-7b`);
    // Only installer-openai exists — no canonical 'codex' or 'builtin_openai'
    await writeCatalog({
      'installer-openai': { authType: 'api_key', displayName: 'Installer OpenAI' },
    });
    await writeCredentials({ 'installer-openai': { apiKey: 'sk-installer-key' } });

    const profile = resolveForClient(projectRoot, 'openai');
    assert.ok(profile, 'installer-openai should be discoverable');
    assert.equal(profile.id, 'installer-openai');
    assert.equal(profile.apiKey, 'sk-installer-key');
  });

  it('resolveForClient falls through to synthetic builtin when no well-known ID matches', async () => {
    const { resolveForClient } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-8`);
    await writeCatalog({
      'claude-main': { authType: 'api_key', displayName: 'Claude Main' },
      'claude-backup': { authType: 'api_key', displayName: 'Claude Backup' },
    });
    await writeCredentials({});

    // clowder-ai#340: No protocol matching — custom accounts not discoverable by client.
    // Falls through to synthetic builtin for 'anthropic' → 'claude'.
    const profile = resolveForClient(projectRoot, 'anthropic');
    assert.ok(profile);
    assert.equal(profile.id, 'claude');
    assert.equal(profile.authType, 'oauth');
  });

  it('resolveForClient finds custom account via preferredAccountRef (not protocol)', async () => {
    const { resolveForClient } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-10`);
    await writeCatalog({
      'custom-ant': {
        authType: 'api_key',
        baseUrl: 'https://custom-proxy.example.com',
      },
    });
    await writeCredentials({ 'custom-ant': { apiKey: 'sk-custom-proxy' } });

    // clowder-ai#340: Custom accounts require explicit preferredAccountRef
    const profile = resolveForClient(projectRoot, 'anthropic', 'custom-ant');
    assert.ok(profile);
    assert.equal(profile.apiKey, 'sk-custom-proxy');
    assert.equal(profile.baseUrl, 'https://custom-proxy.example.com');
  });

  it('resolveForClient prefers credentialed installer account over uncredentialed OAuth builtin', async () => {
    const { resolveForClient } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-12`);
    // Scenario: 'claude' exists as OAuth (no API key), 'installer-anthropic' has an API key.
    // The resolver should skip 'claude' and return 'installer-anthropic'.
    await writeCatalog({
      claude: { authType: 'oauth', models: ['claude-opus-4-6'] },
      'installer-anthropic': { authType: 'api_key', displayName: 'Installer Anthropic' },
    });
    await writeCredentials({ 'installer-anthropic': { apiKey: 'sk-installer-ant' } });

    const profile = resolveForClient(projectRoot, 'anthropic');
    assert.ok(profile, 'should resolve an account');
    assert.equal(profile.apiKey, 'sk-installer-ant', 'should prefer the credentialed installer account');
    assert.equal(profile.id, 'installer-anthropic');
  });

  it('resolveForClient prefers api_key installer account over a credentialed OAuth builtin', async () => {
    const { resolveForClient } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-12b`);
    await writeCatalog({
      codex: { authType: 'oauth', models: ['gpt-5.3-codex'] },
      'installer-openai': { authType: 'api_key', displayName: 'Installer OpenAI' },
    });
    await writeCredentials({
      codex: { apiKey: 'sk-oauth-stale' },
      'installer-openai': { apiKey: 'sk-installer-openai' },
    });

    const profile = resolveForClient(projectRoot, 'openai');
    assert.ok(profile, 'should resolve an account');
    assert.equal(profile.id, 'installer-openai');
    assert.equal(profile.authType, 'api_key');
    assert.equal(profile.apiKey, 'sk-installer-openai');
  });

  it('resolveForClient returns OAuth builtin when no candidate has credentials (subscription mode)', async () => {
    const { resolveForClient } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-13`);
    // Scenario: only 'claude' OAuth exists, no credentials anywhere.
    // Should still return 'claude' for subscription mode — not null.
    await writeCatalog({
      claude: { authType: 'oauth', models: ['claude-opus-4-6'] },
    });
    await writeCredentials({});

    const profile = resolveForClient(projectRoot, 'anthropic');
    assert.ok(profile, 'should still resolve the OAuth builtin');
    assert.equal(profile.id, 'claude');
    assert.equal(profile.apiKey, undefined, 'no credential expected');
  });

  it('env fallback retired (#329): resolveByAccountRef returns undefined apiKey when credentials absent', async () => {
    const { resolveByAccountRef } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-11`);
    await writeCatalog({
      custom: { authType: 'api_key' },
    });
    // No credentials written — env fallback removed in #329 (protocol退場)
    const profile = resolveByAccountRef(projectRoot, 'custom');
    assert.ok(profile);
    assert.equal(profile.apiKey, undefined, 'env fallback retired: no apiKey without stored credential');
  });

  // ── Deterministic runtime resolution (502 regression) ──

  it('resolveAnthropicRuntimeProfile uses deterministic binding, not discovery chain', async () => {
    const { resolveAnthropicRuntimeProfile } = await import(
      `../dist/config/account-resolver.js?t=${Date.now()}-hijack1`
    );
    // Setup: 'claude' OAuth (subscription) + 'installer-anthropic' with fake API key
    // This simulates the 502 scenario: discovery chain would prefer installer-anthropic
    await writeCatalog({
      claude: { authType: 'oauth', models: ['claude-opus-4-6'] },
      'installer-anthropic': { authType: 'api_key', displayName: 'Installer Anthropic' },
    });
    await writeCredentials({ 'installer-anthropic': { apiKey: 'sk-fake-installer-key' } });

    const profile = resolveAnthropicRuntimeProfile(projectRoot);
    // Must use deterministic 'claude' binding, NOT get hijacked by installer-anthropic
    assert.equal(profile.id, 'claude', 'runtime must use deterministic claude binding, not discovery');
    assert.equal(profile.mode, 'subscription', 'must be subscription mode (OAuth)');
    assert.equal(profile.apiKey, undefined, 'must NOT pick up installer-anthropic fake key');
  });

  it('resolveAnthropicRuntimeProfile accepts explicit preferredAccountRef override', async () => {
    const { resolveAnthropicRuntimeProfile } = await import(
      `../dist/config/account-resolver.js?t=${Date.now()}-hijack2`
    );
    await writeCatalog({
      claude: { authType: 'oauth' },
      'my-proxy': { authType: 'api_key', baseUrl: 'https://proxy.example.com' },
    });
    await writeCredentials({ 'my-proxy': { apiKey: 'sk-proxy-key' } });

    // Caller can explicitly override the account — this is deterministic, not discovery
    const profile = resolveAnthropicRuntimeProfile(projectRoot, 'my-proxy');
    assert.equal(profile.id, 'my-proxy');
    assert.equal(profile.mode, 'api_key');
    assert.equal(profile.apiKey, 'sk-proxy-key');
    assert.equal(profile.baseUrl, 'https://proxy.example.com');
  });

  it('resolveAnthropicRuntimeProfile does NOT fall back to installer when builtin_anthropic alias exists', async () => {
    const { resolveAnthropicRuntimeProfile } = await import(
      `../dist/config/account-resolver.js?t=${Date.now()}-builtin-alias`
    );
    // builtin_anthropic is a valid Anthropic builtin alias — must NOT fall through to installer
    await writeCatalog({
      builtin_anthropic: { authType: 'oauth' },
      'installer-anthropic': { authType: 'api_key', displayName: 'Installer Anthropic' },
    });
    await writeCredentials({ 'installer-anthropic': { apiKey: 'sk-should-not-use' } });

    const profile = resolveAnthropicRuntimeProfile(projectRoot);
    assert.equal(profile.mode, 'subscription', 'builtin_anthropic alias must resolve as subscription');
    assert.equal(profile.apiKey, undefined, 'must NOT pick up installer key when builtin alias exists');
  });

  it('resolveAnthropicRuntimeProfile falls back to installer-anthropic when no builtin claude exists', async () => {
    const { resolveAnthropicRuntimeProfile } = await import(
      `../dist/config/account-resolver.js?t=${Date.now()}-installer-only`
    );
    // Installer-only setup: no 'claude' in catalog, only installer-anthropic
    await writeCatalog({
      'installer-anthropic': { authType: 'api_key', displayName: 'Installer Anthropic' },
    });
    await writeCredentials({ 'installer-anthropic': { apiKey: 'sk-real-installer-key' } });

    const profile = resolveAnthropicRuntimeProfile(projectRoot);
    // Must find installer-anthropic via controlled fallback (not discovery chain)
    assert.equal(profile.id, 'installer-anthropic', 'installer-only: must fall back to installer-anthropic');
    assert.equal(profile.mode, 'api_key');
    assert.equal(profile.apiKey, 'sk-real-installer-key');
  });

  // ── Canonical OAuth account ids (Hub add-Anthropic-cat failure) ──
  // deriveAccountId (routes/accounts.ts) slugs OAuth display names to canonical
  // ids ('anthropic', 'openai', 'google') and BUILTIN_CLIENT_FOR_ID lists them
  // as builtin, so the Hub shows them as selectable accounts. The resolver must
  // recognize the same ids — both file-backed and as synthetic fallback —
  // otherwise POST /api/cats fails with `provider "anthropic" not found`.

  it('resolveByAccountRef resolves canonical oauth ids synthetically when absent from accounts', async () => {
    const { resolveByAccountRef } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-canon-syn`);
    await writeCatalog({});

    for (const [ref, client] of [
      ['anthropic', 'anthropic'],
      ['openai', 'openai'],
      ['google', 'google'],
    ]) {
      const profile = resolveByAccountRef(projectRoot, ref);
      assert.ok(profile, `canonical oauth ref "${ref}" must resolve to a synthetic builtin profile`);
      assert.equal(profile.kind, 'builtin', `"${ref}" must be recognized as builtin`);
      assert.equal(profile.client, client);
      assert.equal(profile.authType, 'oauth');
    }
  });

  it('resolveByAccountRef returns builtin profile with client for file-backed canonical oauth id', async () => {
    const { resolveByAccountRef } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-canon-file`);
    await writeCatalog({ anthropic: { authType: 'oauth', models: ['claude-opus-5'] } });

    const profile = resolveByAccountRef(projectRoot, 'anthropic');
    assert.ok(profile);
    assert.equal(profile.kind, 'builtin', 'file-backed canonical oauth account must be recognized as builtin');
    assert.equal(profile.client, 'anthropic', 'profile.client must be derived for canonical oauth id');
    assert.deepEqual(profile.models, ['claude-opus-5']);
  });

  // ── Canonical alias occupancy is NOT OAuth identity (review P2) ──
  // Account ids are display-name slugs; a well-known id may be occupied by an
  // account whose real identity is different. Occupancy alone must not grant
  // builtin identity or suppress installer credential fallback.

  it('api_key account occupying the "anthropic" id does not suppress installer fallback', async () => {
    const { resolveAnthropicRuntimeProfile } = await import(
      `../dist/config/account-resolver.js?t=${Date.now()}-occupy-apikey`
    );
    await writeCatalog({
      anthropic: { authType: 'api_key', displayName: 'anthropic', models: ['claude-sonnet-4-6'] },
      'installer-anthropic': { authType: 'api_key', displayName: 'Installer Anthropic' },
    });
    await writeCredentials({ 'installer-anthropic': { apiKey: 'sk-installer-real' } });

    const profile = resolveAnthropicRuntimeProfile(projectRoot);
    assert.equal(profile.id, 'installer-anthropic', 'api_key id squatting must not shadow installer credentials');
    assert.equal(profile.mode, 'api_key');
    assert.equal(profile.apiKey, 'sk-installer-real');
  });

  it('persisted clientId overrides the id→client map for canonical ids', async () => {
    const { resolveAnthropicRuntimeProfile, resolveByAccountRef } = await import(
      `../dist/config/account-resolver.js?t=${Date.now()}-persisted-client`
    );
    // OAuth account whose id slugs to "anthropic" but whose real client is OpenAI.
    await writeCatalog({
      anthropic: { authType: 'oauth', clientId: 'openai', displayName: 'anthropic' },
      'installer-anthropic': { authType: 'api_key', displayName: 'Installer Anthropic' },
    });
    await writeCredentials({ 'installer-anthropic': { apiKey: 'sk-installer-still-reachable' } });

    const profile = resolveByAccountRef(projectRoot, 'anthropic');
    assert.ok(profile);
    assert.equal(profile.client, 'openai', 'persisted clientId is authoritative over the id slug');

    // And it is not a "real Anthropic builtin" either — installer fallback stays reachable.
    const anthropicProfile = resolveAnthropicRuntimeProfile(projectRoot);
    assert.equal(anthropicProfile.id, 'installer-anthropic');
    assert.equal(anthropicProfile.apiKey, 'sk-installer-still-reachable');
  });

  // ── Auto-discovery must not hand out a foreign family's credential (re-review P1) ──

  it('default binding skips a "claude" slug whose persisted clientId is a different family', async () => {
    const { resolveAnthropicRuntimeProfile } = await import(
      `../dist/config/account-resolver.js?t=${Date.now()}-foreign-slug`
    );
    // The well-known Anthropic id is occupied by an OpenAI api_key account.
    await writeCatalog({
      claude: { authType: 'api_key', clientId: 'openai', baseUrl: 'https://api.openai.com' },
    });
    await writeCredentials({ claude: { apiKey: 'sk-openai-secret' } });

    const profile = resolveAnthropicRuntimeProfile(projectRoot);
    assert.notEqual(profile.apiKey, 'sk-openai-secret', 'must NEVER hand the OpenAI key to the Anthropic runtime');
    assert.equal(profile.mode, 'subscription', 'without any Anthropic credential this resolves to subscription');
    assert.equal(profile.baseUrl, undefined, 'foreign baseUrl must not leak into the Anthropic profile');
  });

  it('default binding still honors a legacy "claude" entry without clientId (alias fallback)', async () => {
    const { resolveAnthropicRuntimeProfile } = await import(
      `../dist/config/account-resolver.js?t=${Date.now()}-legacy-alias`
    );
    await writeCatalog({ claude: { authType: 'api_key', displayName: 'Claude Key' } });
    await writeCredentials({ claude: { apiKey: 'sk-legacy-anthropic' } });

    const profile = resolveAnthropicRuntimeProfile(projectRoot);
    assert.equal(profile.id, 'claude');
    assert.equal(profile.apiKey, 'sk-legacy-anthropic');
  });

  it('explicit preferred ref remains a deliberate cross-protocol path', async () => {
    const { resolveAnthropicRuntimeProfile } = await import(
      `../dist/config/account-resolver.js?t=${Date.now()}-explicit-xproto`
    );
    // Third-party anthropic-protocol gateway bound explicitly (z-ai style).
    await writeCatalog({
      'my-gateway': { authType: 'api_key', clientId: 'anthropic', baseUrl: 'https://gw.example.com' },
    });
    await writeCredentials({ 'my-gateway': { apiKey: 'sk-gateway' } });

    const profile = resolveAnthropicRuntimeProfile(projectRoot, 'my-gateway');
    assert.equal(profile.id, 'my-gateway');
    assert.equal(profile.apiKey, 'sk-gateway');
  });

  it('validateRuntimeProviderBinding fails closed on a non-builtin OAuth identity', async () => {
    const { resolveByAccountRef, validateRuntimeProviderBinding } = await import(
      `../dist/config/account-resolver.js?t=${Date.now()}-nonbuiltin-oauth`
    );
    await writeCatalog({ weird: { authType: 'oauth', clientId: 'not-a-builtin' } });

    const profile = resolveByAccountRef(projectRoot, 'weird');
    assert.ok(profile);
    assert.equal(profile.client, undefined);
    const error = validateRuntimeProviderBinding('anthropic', profile);
    assert.match(
      error ?? '',
      /not a recognized builtin OAuth identity/,
      'explicit but unresolvable OAuth identity must not pass as an anonymous builtin',
    );
  });
});
