/**
 * Account-store compatibility resolver (#1303 / F289 Phase 0 slice).
 *
 * Accounts and credentials are written to the persistent workspace by
 * routes/accounts.ts (redirectRuntimeProjectPath), but legacy split-topology
 * installs may still hold accounts only in the runtime root. Every consumer
 * that resolves an accountRef (create/update validation in routes/cats.ts,
 * primary dispatch in invoke-single-cat.ts) must consume the SAME per-ref
 * verdict:
 *
 *   - canonical-only  → workspace store
 *   - legacy-only     → runtime store (legacy installs stay readable — no
 *                       forced cutover, no dual-write, no auto-migration)
 *   - both, equal     → workspace store (canonical)
 *   - both, divergent → CONFLICT — fail closed; authority is a human/F289
 *                       reconciler decision, never a silent "workspace wins"
 *
 * Topology failures (declared runtime root with unresolvable workspace) also
 * fail closed, matching the 400 the accounts routes already return.
 *
 * Broader unification (ACP, CatAgent, first-run, deletion integrity,
 * background consumers, actual migration) is owned by F289.
 */
import { resolve } from 'node:path';
import type { AccountConfig } from '@cat-cafe/shared';
import { redirectRuntimeProjectPath } from '../utils/persistent-project-path.js';
import { readCatalogAccounts } from './catalog-accounts.js';
import { readCredential } from './credentials.js';

export interface AccountStoreTopology {
  /** Canonical (workspace) root — the store routes/accounts.ts writes to. */
  primaryRoot: string;
  /** Runtime root when it diverges from the workspace, else null. */
  legacyRoot: string | null;
}

export type AccountStoreSelection =
  | { kind: 'ok'; root: string; origin: 'canonical' | 'legacy' | 'both-equal' }
  | { kind: 'absent'; root: string }
  | { kind: 'conflict'; ref: string };

/** Resolve the two-store topology. null = unresolvable (callers fail closed). */
export async function resolveAccountStoreTopology(projectRoot: string): Promise<AccountStoreTopology | null> {
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

/** Key-sorted JSON so semantically equal entries compare equal. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

function entriesEqual(
  primary: { account: AccountConfig | undefined; credential: unknown },
  legacy: { account: AccountConfig | undefined; credential: unknown },
): boolean {
  return (
    canonicalJson(primary.account) === canonicalJson(legacy.account) &&
    canonicalJson(primary.credential) === canonicalJson(legacy.credential)
  );
}

function readStoreEntry(root: string, ref: string): { account: AccountConfig | undefined; credential: unknown } {
  return {
    account: readCatalogAccounts(root)[ref],
    credential: readCredential(ref, root),
  };
}

/** Per-ref store verdict. Sync (fs-backed) so dispatch and validation can share it. */
export function selectAccountStoreForRef(topology: AccountStoreTopology, ref: string): AccountStoreSelection {
  if (!topology.legacyRoot) {
    const single = readStoreEntry(topology.primaryRoot, ref);
    return single.account
      ? { kind: 'ok', root: topology.primaryRoot, origin: 'canonical' }
      : { kind: 'absent', root: topology.primaryRoot };
  }
  const primary = readStoreEntry(topology.primaryRoot, ref);
  const legacy = readStoreEntry(topology.legacyRoot, ref);
  if (primary.account && legacy.account) {
    if (entriesEqual(primary, legacy)) return { kind: 'ok', root: topology.primaryRoot, origin: 'both-equal' };
    return { kind: 'conflict', ref };
  }
  if (primary.account) return { kind: 'ok', root: topology.primaryRoot, origin: 'canonical' };
  if (legacy.account) return { kind: 'ok', root: topology.legacyRoot, origin: 'legacy' };
  return { kind: 'absent', root: topology.primaryRoot };
}

/**
 * Family-level verdict for consumers without an explicit accountRef: the first
 * candidate present in either store decides the root (candidate order is the
 * caller's discovery priority). Deliberately conservative — discovery never
 * mixes stores; cross-store candidate blending is an F289 reconciler concern.
 */
export function selectAccountStoreForFamily(
  topology: AccountStoreTopology,
  candidateRefs: readonly string[],
): AccountStoreSelection {
  for (const ref of candidateRefs) {
    const selection = selectAccountStoreForRef(topology, ref);
    if (selection.kind !== 'absent') return selection;
  }
  return { kind: 'absent', root: topology.primaryRoot };
}

/** Shared fail-closed error text for an unresolvable topology. */
export function accountsRootUnresolvableError(): Error {
  return new Error(
    'accounts root unresolvable (invalid CAT_CAFE_RUNTIME_ROOT/CAT_CAFE_WORKSPACE_ROOT topology) — account bindings cannot be resolved',
  );
}

/** Shared fail-closed error text for a divergent runtime/workspace account. */
export function accountStoreConflictError(ref: string): Error {
  return new Error(
    `account "${ref}" exists in both the runtime and workspace stores with divergent content — ` +
      'reconcile the copies before use (F289); refusing to guess which one is authoritative',
  );
}
