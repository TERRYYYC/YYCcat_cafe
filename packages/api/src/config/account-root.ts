/**
 * Account-store compatibility resolver (#1303 / F289 Phase 0 slice).
 *
 * Accounts and credentials are written to the persistent workspace by
 * routes/accounts.ts (redirectRuntimeProjectPath), but legacy split-topology
 * installs may still hold material only in the runtime root. Every consumer
 * that resolves an accountRef (create/update validation in routes/cats.ts,
 * primary dispatch in invoke-single-cat.ts, game LLM calls) must consume the
 * SAME per-ref verdict:
 *
 *   - canonical-only  → workspace store
 *   - legacy-only     → runtime store (legacy installs stay readable — no
 *                       forced cutover, no dual-write, no auto-migration)
 *   - both, equal     → workspace store (canonical)
 *   - both, divergent → CONFLICT — fail closed; this includes TORN pairs
 *                       (account entry in one store, its credential in the
 *                       other). Authority is a human/F289 reconciler decision,
 *                       never a silent "workspace wins".
 *   - malformed store → INVALID — fail closed; a parse failure is never
 *                       treated as absence.
 *
 * CAT_CAFE_GLOBAL_CONFIG_ROOT is the highest-precedence store root inside
 * catalog-accounts/credentials (resolveGlobalRoot): when it is set there is
 * exactly ONE store regardless of projectRoot, so the topology collapses to
 * single-store and the runtime/workspace split (including a missing workspace
 * root) is irrelevant. This matches the upstream #1303 workaround.
 *
 * Store probing is STRICTLY read-only: this module reads accounts.json,
 * cat-catalog.json (embedded accounts, pre-migration installs) and
 * credentials.json directly and never triggers the migration-aware writers.
 *
 * Broader unification (ACP, CatAgent, first-run, deletion integrity,
 * background consumers, actual migration) is owned by F289.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type AccountConfig, protocolForClient } from '@cat-cafe/shared';
import { redirectRuntimeProjectPath } from '../utils/persistent-project-path.js';
import {
  type BuiltinAccountClient,
  builtinAccountIdForClient,
  builtinCandidateIdsForClient,
  deriveAccountClient,
  type RuntimeProviderProfile,
  resolveByAccountRef,
} from './account-resolver.js';

export interface AccountStoreTopology {
  /** Canonical root — the store account writes resolve to. */
  primaryRoot: string;
  /** Runtime root when it diverges from the workspace, else null (single store). */
  legacyRoot: string | null;
}

export type AccountStoreSelection =
  | { kind: 'ok'; root: string; origin: 'canonical' | 'legacy' | 'both-equal' }
  | { kind: 'absent'; root: string }
  | { kind: 'conflict'; ref: string; reason: 'divergent' | 'torn' }
  | { kind: 'invalid'; ref: string; store: string };

/** Resolve the store topology. null = unresolvable (callers fail closed). */
export async function resolveAccountStoreTopology(projectRoot: string): Promise<AccountStoreTopology | null> {
  // Highest precedence: a configured global root collapses everything to one
  // store — resolveGlobalRoot() inside catalog-accounts/credentials ignores
  // projectRoot entirely when this env var is set (upstream #1303 workaround).
  const globalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT?.trim();
  if (globalRoot) {
    return { primaryRoot: resolve(globalRoot), legacyRoot: null };
  }
  const primaryRoot = await redirectRuntimeProjectPath(projectRoot);
  if (!primaryRoot) return null;
  const legacyRoot = resolve(primaryRoot) === resolve(projectRoot) ? null : projectRoot;
  return { primaryRoot, legacyRoot };
}

/** Single-root convenience for consumers that only need the canonical root. */
export async function resolveAccountsRoot(projectRoot: string): Promise<string | null> {
  const topology = await resolveAccountStoreTopology(projectRoot);
  return topology?.primaryRoot ?? null;
}

// ── Read-only typed store snapshots (never migration-aware, never write) ──

type StoreFileRead =
  | { state: 'ok'; value: Record<string, unknown> }
  | { state: 'absent' }
  | { state: 'invalid'; file: string };

function readJsonMap(path: string): StoreFileRead {
  if (!existsSync(path)) return { state: 'absent' };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { state: 'invalid', file: path };
    }
    return { state: 'ok', value: parsed as Record<string, unknown> };
  } catch {
    return { state: 'invalid', file: path };
  }
}

interface StoreEntrySnapshot {
  account: AccountConfig | undefined;
  credential: unknown;
  invalidFile: string | null;
}

/** Strictly read-only per-ref snapshot of one store: accounts.json first, then
 *  the pre-migration embedded catalog accounts. No migration is triggered. */
function readStoreEntrySnapshot(root: string, ref: string): StoreEntrySnapshot {
  const dir = resolve(root, '.cat-cafe');
  let account: AccountConfig | undefined;
  let invalidFile: string | null = null;

  const accountsRead = readJsonMap(resolve(dir, 'accounts.json'));
  if (accountsRead.state === 'invalid') invalidFile = accountsRead.file;
  else if (accountsRead.state === 'ok') account = accountsRead.value[ref] as AccountConfig | undefined;
  else {
    // Pre-migration installs embed accounts in cat-catalog.json.
    const catalogRead = readJsonMap(resolve(dir, 'cat-catalog.json'));
    if (catalogRead.state === 'invalid') invalidFile = catalogRead.file;
    else if (catalogRead.state === 'ok') {
      const embedded = catalogRead.value.accounts;
      if (embedded && typeof embedded === 'object' && !Array.isArray(embedded)) {
        account = (embedded as Record<string, unknown>)[ref] as AccountConfig | undefined;
      }
    }
  }

  let credential: unknown;
  const credentialsRead = readJsonMap(resolve(dir, 'credentials.json'));
  if (credentialsRead.state === 'invalid') invalidFile ??= credentialsRead.file;
  else if (credentialsRead.state === 'ok') credential = credentialsRead.value[ref];

  return { account, credential, invalidFile };
}

/** Key-sorted JSON so semantically equal entries compare equal regardless of
 *  key order; undefined normalizes to null explicitly. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

function snapshotsEqual(a: StoreEntrySnapshot, b: StoreEntrySnapshot): boolean {
  return (
    canonicalJson(a.account) === canonicalJson(b.account) && canonicalJson(a.credential) === canonicalJson(b.credential)
  );
}

function hasMaterial(snapshot: StoreEntrySnapshot): boolean {
  return snapshot.account !== undefined || snapshot.credential !== undefined;
}

/** Per-ref store verdict. Presence counts BOTH the account entry and its
 *  credential, so a torn pair (entry in one store, secret in the other) fails
 *  closed instead of validating on one side and missing the key at dispatch. */
export function selectAccountStoreForRef(topology: AccountStoreTopology, ref: string): AccountStoreSelection {
  const primary = readStoreEntrySnapshot(topology.primaryRoot, ref);
  if (primary.invalidFile) return { kind: 'invalid', ref, store: primary.invalidFile };
  if (!topology.legacyRoot) {
    return primary.account
      ? { kind: 'ok', root: topology.primaryRoot, origin: 'canonical' }
      : { kind: 'absent', root: topology.primaryRoot };
  }
  const legacy = readStoreEntrySnapshot(topology.legacyRoot, ref);
  if (legacy.invalidFile) return { kind: 'invalid', ref, store: legacy.invalidFile };

  const primaryHas = hasMaterial(primary);
  const legacyHas = hasMaterial(legacy);
  if (primaryHas && legacyHas) {
    if (snapshotsEqual(primary, legacy)) return { kind: 'ok', root: topology.primaryRoot, origin: 'both-equal' };
    const torn =
      (primary.account !== undefined) !== (legacy.account !== undefined) ||
      (primary.credential !== undefined) !== (legacy.credential !== undefined);
    return { kind: 'conflict', ref, reason: torn ? 'torn' : 'divergent' };
  }
  if (primaryHas) {
    return primary.account
      ? { kind: 'ok', root: topology.primaryRoot, origin: 'canonical' }
      : { kind: 'absent', root: topology.primaryRoot };
  }
  if (legacyHas) {
    return legacy.account
      ? { kind: 'ok', root: topology.legacyRoot, origin: 'legacy' }
      : { kind: 'absent', root: topology.primaryRoot };
  }
  return { kind: 'absent', root: topology.primaryRoot };
}

/** Typed fail-closed verdict error so consumers (invoke catch blocks) can
 *  re-throw it verbatim instead of wrapping it into a generic message. */
export class AccountStoreVerdictError extends Error {}

/** Shared fail-closed error text for an unresolvable topology. */
export function accountsRootUnresolvableError(): Error {
  return new AccountStoreVerdictError(
    'accounts root unresolvable (invalid CAT_CAFE_RUNTIME_ROOT/CAT_CAFE_WORKSPACE_ROOT topology) — account bindings cannot be resolved',
  );
}

/** Shared fail-closed error text for a divergent/torn/invalid store verdict. */
export function accountStoreConflictError(selection: { ref: string } & Record<string, unknown>): Error {
  if ('store' in selection && typeof selection.store === 'string') {
    return new AccountStoreVerdictError(
      `account "${selection.ref}" store is malformed (${selection.store}) — repair the file before use; a parse failure is never treated as absence`,
    );
  }
  const reason = 'reason' in selection && selection.reason === 'torn' ? 'torn across' : 'divergent between';
  return new AccountStoreVerdictError(
    `account "${selection.ref}" is ${reason} the runtime and workspace stores — ` +
      'reconcile the copies before use (F289); refusing to guess which one is authoritative',
  );
}

// ── Atomic family + profile resolution (no split-brain second selection) ──

export type RuntimeAccountResolution = { kind: 'ok'; profile: RuntimeProviderProfile; root: string } | { kind: 'none' };

/**
 * ONE atomic verdict for "which account does this cat use": explicit binding
 * takes the per-ref store verdict then resolves that exact ref; without a
 * binding, every family candidate (well-known, canonical, builtin_*,
 * installer-*) is store-verdicted AND identity-checked first, and only then
 * ranked (api_key-with-credential preferred, else first match) — each
 * candidate resolved against ITS OWN verdict root. Any candidate in
 * conflict/invalid state fails the whole family: ranking must never silently
 * route around a torn candidate. Throws on topology failure, conflict, or
 * invalid stores. Consumed by primary dispatch AND game LLM calls so no
 * consumer re-derives a divergent selection.
 */
export async function resolveRuntimeAccountProfile(
  projectRoot: string,
  client: BuiltinAccountClient,
  boundAccountRef: string | null | undefined,
): Promise<RuntimeAccountResolution> {
  const topology = await resolveAccountStoreTopology(projectRoot);
  if (!topology) throw accountsRootUnresolvableError();

  const trimmedRef = boundAccountRef?.trim();
  if (trimmedRef) {
    const selection = selectAccountStoreForRef(topology, trimmedRef);
    if (selection.kind === 'conflict' || selection.kind === 'invalid') throw accountStoreConflictError(selection);
    const profile = resolveByAccountRef(selection.root, trimmedRef);
    return profile ? { kind: 'ok', profile, root: selection.root } : { kind: 'none' };
  }

  const candidates: Array<{ ref: string; root: string }> = [];
  for (const ref of builtinCandidateIdsForClient(client)) {
    const selection = selectAccountStoreForRef(topology, ref);
    if (selection.kind === 'conflict' || selection.kind === 'invalid') throw accountStoreConflictError(selection);
    if (selection.kind !== 'ok') continue;
    candidates.push({ ref, root: selection.root });
  }

  let firstMatch: RuntimeAccountResolution | null = null;
  for (const candidate of candidates) {
    const snapshot = readStoreEntrySnapshot(candidate.root, candidate.ref);
    if (!snapshot.account) continue;
    // Identity check: a foreign persisted clientId never auto-resolves for
    // this family; legacy entries without clientId keep the alias fallback.
    if (snapshot.account.clientId && deriveAccountClient(candidate.ref, snapshot.account) !== client) continue;
    const profile = resolveByAccountRef(candidate.root, candidate.ref);
    if (!profile) continue;
    if (profile.authType === 'api_key' && profile.apiKey) return { kind: 'ok', profile, root: candidate.root };
    firstMatch ??= { kind: 'ok', profile, root: candidate.root };
  }
  if (firstMatch) return firstMatch;
  // Fresh install / only foreign squatters: synthetic builtin OAuth profile —
  // the same semantics resolveForClient always had for empty stores. The
  // subscription CLIs carry their own login state, so a keyless builtin
  // profile is dispatchable (and api_key consumers still fail fast on no key).
  // Constructed directly and NEVER re-read from the store: resolveByAccountRef
  // would resurrect the exact foreign-clientId squatter the identity check
  // just skipped, handing its credential to this family.
  const wellKnownRef = builtinAccountIdForClient(client);
  if (!wellKnownRef) return { kind: 'none' };
  const protocol = protocolForClient(client);
  return {
    kind: 'ok',
    root: topology.primaryRoot,
    profile: {
      id: wellKnownRef,
      authType: 'oauth',
      kind: 'builtin',
      client,
      ...(protocol ? { protocol } : {}),
    },
  };
}
