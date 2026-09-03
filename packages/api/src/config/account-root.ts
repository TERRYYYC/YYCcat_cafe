/**
 * Account-root contract (#1303 / F289 narrow slice).
 *
 * Accounts and credentials live in the persistent workspace: routes/accounts.ts
 * reads and writes them through redirectRuntimeProjectPath. Every consumer that
 * resolves an accountRef (create/update validation in routes/cats.ts, primary
 * dispatch in invoke-single-cat.ts) must use this same root — validating or
 * dispatching against the raw runtime root made an account that the Hub had
 * just listed invisible ("provider not found") or, worse, let a binding pass
 * validation that dispatch could not resolve.
 *
 * Fail-closed: returns null when the runtime/workspace topology cannot be
 * resolved (matching the 400 the accounts routes already return). Callers must
 * surface an explicit error instead of silently falling back to a divergent
 * root. In a single-checkout topology (no CAT_CAFE_RUNTIME_ROOT, or runtime ===
 * workspace) the input root is returned unchanged.
 *
 * Broader unification (ACP, CatAgent, first-run, deletion integrity,
 * background consumers) is owned by F289.
 */
import { redirectRuntimeProjectPath } from '../utils/persistent-project-path.js';

export async function resolveAccountsRoot(projectRoot: string): Promise<string | null> {
  return redirectRuntimeProjectPath(projectRoot);
}
