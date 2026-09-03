/**
 * Account-store compatibility resolver (#1303 / F289 Phase 0 slice).
 *
 * ONE pure snapshot/profile pipeline: every consumer of an accountRef
 * (create/update validation in routes/cats.ts, primary dispatch in
 * invoke-single-cat.ts, game LLM calls) resolves through the same read-only,
 * shape-validated, per-ref store verdict — and the profile is constructed
 * directly from the verdicted snapshot. Nothing downstream re-reads stores,
 * re-selects sources, or triggers migration.
 *
 * Per-ref verdict across the workspace (canonical) and runtime (legacy) stores:
 *   - canonical-only  → workspace store
 *   - legacy-only     → runtime store (legacy installs stay readable — no
 *                       forced cutover, no dual-write, no auto-migration)
 *   - both, equal     → workspace store (canonical); equality uses the SAME
 *                       canonical semantics the accounts store already defines
 *                       (catalog-accounts canonicalizeAccount: baseUrl trailing
 *                       slashes, displayName whitespace, models order/dupes)
 *                       plus identity-bearing fields (clientId, envVars)
 *   - both, divergent → CONFLICT — fail closed; includes TORN pairs (entry in
 *                       one store, credential in the other). Authority is a
 *                       human/F289 reconciler decision, never a silent winner.
 *   - malformed store → INVALID — fail closed; parse OR SHAPE failure is never
 *                       treated as absence (a corrupt entry must not leak keys).
 *
 * The per-ref snapshot replicates the effective merge view the migration-aware
 * readers would produce — external accounts.json entry first, pre-migration
 * embedded cat-catalog accounts as per-ref fallback — WITHOUT performing the
 * migration, so the verdict compares exactly what any later reader would see.
 *
 * CAT_CAFE_GLOBAL_CONFIG_ROOT (highest precedence in resolveGlobalRoot)
 * collapses the topology to a single store; this module is the only place the
 * env var is interpreted for verdicts, and profiles are built from snapshots,
 * so no second component re-reads process.env with different normalization.
 *
 * Broader unification (ACP, CatAgent, first-run, deletion integrity,
 * background consumers, actual migration) is owned by F289.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type AccountConfig, BUILTIN_ACCOUNT_CLIENT_FOR_ID, protocolForClient } from '@cat-cafe/shared';
import { redirectRuntimeProjectPath } from '../utils/persistent-project-path.js';
import {
  type BuiltinAccountClient,
  buildRuntimeProfile,
  builtinAccountIdForClient,
  builtinCandidateIdsForClient,
  deriveAccountClient,
  type RuntimeProviderProfile,
} from './account-resolver.js';
import { canonicalizeAccount } from './catalog-accounts.js';

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
  // store (upstream #1303 workaround). This is the single interpretation
  // point for the env var — snapshots and profiles all flow from this root.
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

/** Runtime shape validation for a stored account entry. Forward-compatible:
 *  unknown extra fields are tolerated, but every known field must have the
 *  right type and authType is mandatory — a structurally broken entry must
 *  become INVALID, never a usable profile that leaks a credential. */
/** Known stored authType values: 'subscription' is the pre-clowder-ai#340
 *  legacy spelling still present in real stores; downstream treats any
 *  non-api_key value as subscription-style, so it stays readable. */
const KNOWN_AUTH_TYPES = new Set(['oauth', 'api_key', 'subscription']);

function validateAccountShape(value: unknown): AccountConfig | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.authType !== 'string' || !KNOWN_AUTH_TYPES.has(value.authType)) return null;
  if (value.clientId !== undefined && typeof value.clientId !== 'string') return null;
  if (value.baseUrl !== undefined && typeof value.baseUrl !== 'string') return null;
  if (value.displayName !== undefined && typeof value.displayName !== 'string') return null;
  if (value.models !== undefined) {
    if (!Array.isArray(value.models) || !value.models.every((m) => typeof m === 'string')) return null;
  }
  if (value.modelAliases !== undefined && !isStringRecord(value.modelAliases)) return null;
  if (value.envVars !== undefined && !isStringRecord(value.envVars)) return null;
  return value as unknown as AccountConfig;
}

interface CredentialSnapshot {
  apiKey?: string;
  raw: Record<string, unknown>;
}

/** Runtime shape validation for a stored credential entry: must be an object
 *  and any secret present must be a string (a numeric/array apiKey is INVALID). */
function validateCredentialShape(value: unknown): CredentialSnapshot | null {
  if (!isPlainObject(value)) return null;
  if (value.apiKey !== undefined && typeof value.apiKey !== 'string') return null;
  return { ...(typeof value.apiKey === 'string' ? { apiKey: value.apiKey } : {}), raw: value };
}

interface StoreEntrySnapshot {
  account: AccountConfig | undefined;
  credential: CredentialSnapshot | undefined;
  invalidFile: string | null;
}

/**
 * Strictly read-only per-ref snapshot of one store.
 *
 * Replicates the effective per-ref merge view the migration-aware readers
 * produce — the external accounts.json entry wins, and the pre-migration
 * embedded cat-catalog accounts fill PER-REF gaps (not only when the whole
 * accounts.json file is missing) — without triggering any migration write.
 * Parse or shape failures surface as invalidFile, never as absence.
 */
function readStoreEntrySnapshot(root: string, ref: string): StoreEntrySnapshot {
  const dir = resolve(root, '.cat-cafe');
  let account: AccountConfig | undefined;
  let invalidFile: string | null = null;

  const accountsPath = resolve(dir, 'accounts.json');
  const accountsRead = readJsonMap(accountsPath);
  if (accountsRead.state === 'invalid') invalidFile = accountsRead.file;
  else if (accountsRead.state === 'ok' && accountsRead.value[ref] !== undefined) {
    const validated = validateAccountShape(accountsRead.value[ref]);
    if (!validated) invalidFile = accountsPath;
    else account = validated;
  }

  // Per-ref embedded fallback — the same gap-filling the migration performs.
  if (!account && !invalidFile) {
    const catalogPath = resolve(dir, 'cat-catalog.json');
    const catalogRead = readJsonMap(catalogPath);
    if (catalogRead.state === 'invalid') invalidFile = catalogRead.file;
    else if (catalogRead.state === 'ok' && catalogRead.value.accounts !== undefined) {
      if (!isPlainObject(catalogRead.value.accounts)) {
        invalidFile = catalogPath;
      } else if (catalogRead.value.accounts[ref] !== undefined) {
        const validated = validateAccountShape(catalogRead.value.accounts[ref]);
        if (!validated) invalidFile = catalogPath;
        else account = validated;
      }
    }
  }

  let credential: CredentialSnapshot | undefined;
  const credentialsPath = resolve(dir, 'credentials.json');
  const credentialsRead = readJsonMap(credentialsPath);
  if (credentialsRead.state === 'invalid') invalidFile ??= credentialsRead.file;
  else if (credentialsRead.state === 'ok' && credentialsRead.value[ref] !== undefined) {
    const validated = validateCredentialShape(credentialsRead.value[ref]);
    if (!validated) invalidFile ??= credentialsPath;
    else credential = validated;
  }

  return { account, credential, invalidFile };
}

/** Key-sorted JSON for the parts without store-defined canonical semantics. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

/** Store-semantic canonical form: reuses catalog-accounts canonicalizeAccount
 *  (trailing-slash baseUrl, whitespace displayName, models order/dupes are
 *  equivalent) and adds the identity-bearing fields it does not cover. */
function canonicalAccountKey(account: AccountConfig | undefined): string {
  if (!account) return canonicalJson(undefined);
  return canonicalJson({
    ...canonicalizeAccount(account),
    ...(account.clientId ? { clientId: account.clientId } : {}),
    ...(account.envVars && Object.keys(account.envVars).length > 0 ? { envVars: account.envVars } : {}),
  });
}

function snapshotsEqual(a: StoreEntrySnapshot, b: StoreEntrySnapshot): boolean {
  return (
    canonicalAccountKey(a.account) === canonicalAccountKey(b.account) &&
    canonicalJson(a.credential?.raw) === canonicalJson(b.credential?.raw)
  );
}

function hasMaterial(snapshot: StoreEntrySnapshot): boolean {
  return snapshot.account !== undefined || snapshot.credential !== undefined;
}

interface VerdictedSnapshot {
  selection: AccountStoreSelection;
  /** Snapshot backing an 'ok' selection — the ONLY source profiles come from. */
  snapshot: StoreEntrySnapshot | null;
}

function verdictForRef(topology: AccountStoreTopology, ref: string): VerdictedSnapshot {
  const primary = readStoreEntrySnapshot(topology.primaryRoot, ref);
  if (primary.invalidFile) return { selection: { kind: 'invalid', ref, store: primary.invalidFile }, snapshot: null };
  if (!topology.legacyRoot) {
    return primary.account
      ? { selection: { kind: 'ok', root: topology.primaryRoot, origin: 'canonical' }, snapshot: primary }
      : { selection: { kind: 'absent', root: topology.primaryRoot }, snapshot: null };
  }
  const legacy = readStoreEntrySnapshot(topology.legacyRoot, ref);
  if (legacy.invalidFile) return { selection: { kind: 'invalid', ref, store: legacy.invalidFile }, snapshot: null };

  const primaryHas = hasMaterial(primary);
  const legacyHas = hasMaterial(legacy);
  if (primaryHas && legacyHas) {
    if (snapshotsEqual(primary, legacy)) {
      return { selection: { kind: 'ok', root: topology.primaryRoot, origin: 'both-equal' }, snapshot: primary };
    }
    const torn =
      (primary.account !== undefined) !== (legacy.account !== undefined) ||
      (primary.credential !== undefined) !== (legacy.credential !== undefined);
    return { selection: { kind: 'conflict', ref, reason: torn ? 'torn' : 'divergent' }, snapshot: null };
  }
  if (primaryHas) {
    return primary.account
      ? { selection: { kind: 'ok', root: topology.primaryRoot, origin: 'canonical' }, snapshot: primary }
      : { selection: { kind: 'absent', root: topology.primaryRoot }, snapshot: null };
  }
  if (legacyHas) {
    return legacy.account
      ? { selection: { kind: 'ok', root: topology.legacyRoot, origin: 'legacy' }, snapshot: legacy }
      : { selection: { kind: 'absent', root: topology.primaryRoot }, snapshot: null };
  }
  return { selection: { kind: 'absent', root: topology.primaryRoot }, snapshot: null };
}

/** Per-ref store verdict (public shape kept for route validation). */
export function selectAccountStoreForRef(topology: AccountStoreTopology, ref: string): AccountStoreSelection {
  return verdictForRef(topology, ref).selection;
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

function profileFromVerdict(ref: string, verdict: VerdictedSnapshot): RuntimeProviderProfile | null {
  if (verdict.selection.kind !== 'ok' || !verdict.snapshot?.account) return null;
  // Built purely from the verdicted snapshot — never through a reader that
  // could migrate or re-select a source the verdict did not compare.
  return buildRuntimeProfile(ref, verdict.snapshot.account, verdict.snapshot.credential?.apiKey);
}

/** Synthetic builtin profile for a well-known account id (map lookup) — the
 *  same fresh-install semantics the migration-aware resolveByAccountRef had,
 *  but constructed directly (never re-reading a store). */
function syntheticProfileForRef(ref: string): RuntimeProviderProfile | null {
  const client = BUILTIN_ACCOUNT_CLIENT_FOR_ID[ref];
  if (!client) return null;
  const protocol = protocolForClient(client);
  return { id: ref, authType: 'oauth', kind: 'builtin', client, ...(protocol ? { protocol } : {}) };
}

/**
 * Per-ref verdict + profile from the SAME pure pipeline — for route
 * validation. selection mirrors selectAccountStoreForRef; profile is built
 * from the verdicted snapshot ('ok') or is the map-synthetic builtin
 * ('absent' on a well-known id), never from a migration-aware reader.
 */
export function resolveVerdictedRefProfile(
  topology: AccountStoreTopology,
  ref: string,
): { selection: AccountStoreSelection; profile: RuntimeProviderProfile | null } {
  const verdict = verdictForRef(topology, ref);
  if (verdict.selection.kind === 'ok') {
    return { selection: verdict.selection, profile: profileFromVerdict(ref, verdict) };
  }
  if (verdict.selection.kind === 'absent') {
    return { selection: verdict.selection, profile: syntheticProfileForRef(ref) };
  }
  return { selection: verdict.selection, profile: null };
}

function syntheticBuiltinProfile(client: BuiltinAccountClient): RuntimeProviderProfile | null {
  const wellKnownRef = builtinAccountIdForClient(client);
  if (!wellKnownRef) return null;
  const protocol = protocolForClient(client);
  return {
    id: wellKnownRef,
    authType: 'oauth',
    kind: 'builtin',
    client,
    ...(protocol ? { protocol } : {}),
  };
}

/**
 * ONE atomic verdict for "which account does this cat use": explicit binding
 * takes the per-ref store verdict and the profile is built from that exact
 * verdicted snapshot; without a binding, every family candidate (well-known,
 * canonical, builtin_*, installer-*) is store-verdicted AND identity-checked
 * first, and only then ranked (api_key-with-credential preferred, else first
 * match) — each candidate's profile built from its own verdicted snapshot.
 * Any candidate in conflict/invalid state fails the whole family: ranking
 * must never silently route around a torn candidate. Empty stores resolve to
 * a directly-constructed synthetic builtin OAuth profile (never re-read
 * through a store, which could resurrect a skipped foreign squatter).
 * Consumed by primary dispatch AND game LLM calls.
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
    const verdict = verdictForRef(topology, trimmedRef);
    if (verdict.selection.kind === 'conflict' || verdict.selection.kind === 'invalid') {
      throw accountStoreConflictError(verdict.selection);
    }
    if (verdict.selection.kind === 'ok') {
      const profile = profileFromVerdict(trimmedRef, verdict);
      if (profile) return { kind: 'ok', profile, root: verdict.selection.root };
    }
    // Absent explicit ref: only well-known builtin ids resolve synthetically —
    // a foreign-family synthetic still fails compatibility checks downstream.
    const synthetic = syntheticProfileForRef(trimmedRef);
    return synthetic ? { kind: 'ok', profile: synthetic, root: topology.primaryRoot } : { kind: 'none' };
  }

  const verdicts: Array<{ ref: string; verdict: VerdictedSnapshot }> = [];
  for (const ref of builtinCandidateIdsForClient(client)) {
    const verdict = verdictForRef(topology, ref);
    if (verdict.selection.kind === 'conflict' || verdict.selection.kind === 'invalid') {
      throw accountStoreConflictError(verdict.selection);
    }
    if (verdict.selection.kind !== 'ok') continue;
    verdicts.push({ ref, verdict });
  }

  let firstMatch: RuntimeAccountResolution | null = null;
  for (const { ref, verdict } of verdicts) {
    const account = verdict.snapshot?.account;
    if (!account) continue;
    // Identity check: a foreign persisted clientId never auto-resolves for
    // this family; legacy entries without clientId keep the alias fallback.
    if (account.clientId && deriveAccountClient(ref, account) !== client) continue;
    const profile = profileFromVerdict(ref, verdict);
    if (!profile) continue;
    const root = verdict.selection.kind === 'ok' ? verdict.selection.root : topology.primaryRoot;
    if (profile.authType === 'api_key' && profile.apiKey) return { kind: 'ok', profile, root };
    firstMatch ??= { kind: 'ok', profile, root };
  }
  if (firstMatch) return firstMatch;

  const synthetic = syntheticBuiltinProfile(client);
  return synthetic ? { kind: 'ok', profile: synthetic, root: topology.primaryRoot } : { kind: 'none' };
}
