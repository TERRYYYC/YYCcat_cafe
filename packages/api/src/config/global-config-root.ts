/**
 * SINGLE normalization contract for CAT_CAFE_GLOBAL_CONFIG_ROOT (re-review P2).
 *
 * The store writers (catalog-accounts, credentials) and the account-store
 * topology verdict must interpret the env var identically — previously the
 * verdict trimmed it while the writers resolved the raw value, so a value
 * with surrounding whitespace made writes land in one directory and verdicts
 * read another.
 */
export function globalConfigRootEnv(): string | undefined {
  const trimmed = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT?.trim();
  return trimmed ? trimmed : undefined;
}
