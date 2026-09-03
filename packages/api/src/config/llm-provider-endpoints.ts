/**
 * ONE protocol-aware, idempotent LLM endpoint builder (re-review P2).
 *
 * String concatenation produced doubled version segments (`/v1/v1/messages`,
 * double `/v1beta`), missed the repo's existing kimi `/coding` → `/coding/v1`
 * normalization, and dropped `/v1` for root-style OpenAI bases. This builder
 * parses the base URL, appends the protocol path exactly once regardless of
 * whether the stored base is root-style or already versioned, and fails
 * BEFORE any fetch on an unparsable base.
 */
import { normalizeKimiApiBaseUrl } from '../domains/cats/services/agents/providers/kimi-config.js';

export type LlmEndpointProtocol = 'anthropic' | 'openai' | 'google' | 'kimi';

const OFFICIAL_BASES: Record<LlmEndpointProtocol, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  google: 'https://generativelanguage.googleapis.com',
  kimi: 'https://api.moonshot.ai',
};

/** version segment + resource path per protocol */
const PROTOCOL_PATHS: Record<LlmEndpointProtocol, { version: string; resource: (model?: string) => string }> = {
  anthropic: { version: 'v1', resource: () => '/messages' },
  openai: { version: 'v1', resource: () => '/chat/completions' },
  kimi: { version: 'v1', resource: () => '/chat/completions' },
  google: { version: 'v1beta', resource: (model) => `/models/${model}:generateContent` },
};

/**
 * Build the request URL for a protocol from an optional custom base.
 * Idempotent w.r.t. the version segment: a base that already ends with the
 * protocol's version (root-style vs versioned storage both occur in real
 * account data) gets the resource path only. Throws on an unparsable base.
 */
export function buildLlmEndpoint(protocol: LlmEndpointProtocol, baseUrl: string | undefined, model?: string): string {
  let base = baseUrl?.trim() ? baseUrl.trim() : OFFICIAL_BASES[protocol];
  if (protocol === 'kimi') base = normalizeKimiApiBaseUrl(base) || OFFICIAL_BASES.kimi;

  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`invalid ${protocol} base URL "${base}" — refusing to build an endpoint from it`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`invalid ${protocol} base URL "${base}" — only http(s) endpoints are allowed`);
  }

  const { version, resource } = PROTOCOL_PATHS[protocol];
  const basePath = parsed.pathname.replace(/\/+$/, '');
  const alreadyVersioned = basePath === `/${version}` || basePath.endsWith(`/${version}`);
  parsed.pathname = `${basePath}${alreadyVersioned ? '' : `/${version}`}${resource(model)}`;
  return parsed.toString();
}
