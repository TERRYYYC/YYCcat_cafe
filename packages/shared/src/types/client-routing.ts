import type { ClientId } from './cat.js';
import type { AccountProtocol } from './cat-breed.js';

export type BuiltinAccountClient = Extract<ClientId, 'anthropic' | 'openai' | 'google' | 'kimi' | 'opencode'>;
export type BuiltinAccountProtocol = Extract<AccountProtocol, 'anthropic' | 'openai' | 'google' | 'kimi'>;

const BUILTIN_ACCOUNT_IDS: Record<BuiltinAccountClient, string> = {
  anthropic: 'claude',
  openai: 'codex',
  google: 'gemini',
  kimi: 'kimi',
  opencode: 'opencode',
};

/**
 * Reverse map: well-known builtin account id → client identity.
 *
 * Single source of truth shared by the account resolver (synthetic builtin
 * fallback + profile derivation in api/config/account-resolver.ts) and the
 * accounts routes (Hub account listing in api/routes/accounts.ts). These two
 * previously kept private copies that drifted apart: the Hub listed the
 * canonical OAuth ids as selectable builtins while the resolver did not know
 * them, so creating an Anthropic cat failed with `provider "anthropic" not
 * found` right after the Hub offered that account.
 *
 * Three id families, all resolving to the same client:
 *  - preferred legacy ids — mirror of BUILTIN_ACCOUNT_IDS above
 *  - canonical OAuth ids — deriveAccountId display-name slugs
 *  - builtin_* — explicit reserved form
 */
export const BUILTIN_ACCOUNT_CLIENT_FOR_ID: Record<string, BuiltinAccountClient> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
  kimi: 'kimi',
  opencode: 'opencode',
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  builtin_anthropic: 'anthropic',
  builtin_openai: 'openai',
  builtin_google: 'google',
  builtin_kimi: 'kimi',
  builtin_opencode: 'opencode',
};

/** Runtime type guard mirroring BuiltinAccountClient — single source, no drifting copies. */
export function isBuiltinAccountClient(value: string): value is BuiltinAccountClient {
  return value === 'anthropic' || value === 'openai' || value === 'google' || value === 'kimi' || value === 'opencode';
}

export function builtinAccountFamilyForClient(client: ClientId): BuiltinAccountClient | null {
  switch (client) {
    case 'anthropic':
    case 'openai':
    case 'google':
    case 'kimi':
    case 'opencode':
      return client;
    // F161: generic ACP is a transport, not an account family — no synthetic builtin account.
    // Returning null prevents auto-rebase from rewriting accountRef to non-existent 'acp'.
    case 'catagent':
      return 'anthropic';
    default:
      return null;
  }
}

export function builtinAccountIdForClient(client: ClientId): string | null {
  const family = builtinAccountFamilyForClient(client);
  return family ? BUILTIN_ACCOUNT_IDS[family] : null;
}

export function protocolForClient(client: ClientId): BuiltinAccountProtocol | null {
  switch (client) {
    case 'anthropic':
    case 'catagent':
    case 'opencode':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'google':
      return 'google';
    case 'kimi':
      return 'kimi';
    default:
      return null;
  }
}
