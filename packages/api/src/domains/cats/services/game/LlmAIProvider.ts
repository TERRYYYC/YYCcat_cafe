/**
 * LlmAIProvider (F101 Phase H3)
 *
 * Concrete AIProvider implementation that routes LLM calls to the correct
 * provider (Anthropic/OpenAI/Google) based on the resolved runtime cat config.
 *
 * Design decisions (from Phase H plan TD-H1):
 * - Lightweight HTTP API calls (not CLI spawn) — game is single-turn structured
 *   reasoning, not a full agent session.
 * - Each cat uses its own model via getCatModel(catId).
 * - 10s timeout per call; fallback to null on failure (caller handles fallback).
 */

import { catRegistry } from '@cat-cafe/shared';
import { type BuiltinAccountClient, profileFamilyIdentity } from '../../../../config/account-resolver.js';
import { resolveRuntimeAccountProfile } from '../../../../config/account-root.js';
import { resolveBoundAccountRefForCat } from '../../../../config/cat-account-binding.js';
import { getCatModel } from '../../../../config/cat-models.js';
import { buildLlmEndpoint } from '../../../../config/llm-provider-endpoints.js';
import type { AIActionResponse, AIProvider } from '../game/werewolf/WerewolfAIPlayer.js';

const LLM_TIMEOUT_MS = 10_000;

interface LlmCallResult {
  text: string;
}

export class LlmAIProvider implements AIProvider {
  private readonly model: string;
  private readonly provider: string;
  private readonly catId: string;

  constructor(catId: string) {
    this.catId = catId;
    this.model = getCatModel(catId);
    const entry = catRegistry.tryGet(catId);
    this.provider = entry?.config.clientId ?? 'anthropic';
  }

  async generateAction(prompt: string, _schema: Record<string, unknown>): Promise<AIActionResponse> {
    const result = await this.callLlm(prompt);
    return this.parseActionResponse(result.text);
  }

  async generateSpeech(prompt: string): Promise<string> {
    const result = await this.callLlm(prompt);
    return result.text.trim();
  }

  private async callLlm(prompt: string): Promise<LlmCallResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    try {
      switch (this.provider) {
        case 'anthropic':
          return await this.callAnthropic(prompt, controller.signal);
        case 'openai':
          return await this.callOpenAI(prompt, controller.signal);
        case 'google':
          return await this.callGoogle(prompt, controller.signal);
        case 'kimi':
          return await this.callKimi(prompt, controller.signal);
        default:
          // Unsupported providers (antigravity, etc.) — fall through to Anthropic
          return await this.callAnthropic(prompt, controller.signal);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolve the FULL credential (key + endpoint) through the same atomic
   * account verdict primary dispatch consumes (#1303 / F289 Phase 0).
   *
   * - An explicit cat binding is the only deliberate cross-protocol path and
   *   carries its own baseUrl: a gateway-bound key is sent to the gateway,
   *   never to the official domain.
   * - Without a binding, family resolution is identity-checked — a foreign
   *   persisted clientId squatting a well-known id ("claude" with clientId
   *   "openai") is never selected, so its key never leaves the machine.
   * - No resolvable key → throw BEFORE any network call (fail closed, zero
   *   network on foreign/missing credentials).
   */
  private async resolveCredential(client: BuiltinAccountClient): Promise<{ apiKey: string; baseUrl?: string }> {
    const entry = catRegistry.tryGet(this.catId);
    const boundRef = entry ? resolveBoundAccountRefForCat(process.cwd(), this.catId, entry.config) : undefined;
    const resolution = await resolveRuntimeAccountProfile(process.cwd(), client, boundRef);
    const apiKey = resolution.kind === 'ok' ? resolution.profile.apiKey : undefined;
    if (resolution.kind !== 'ok' || !apiKey) {
      throw new Error(
        `No ${client} API key resolvable for cat "${this.catId}" — bind an account with a credential in Hub > account settings`,
      );
    }
    const profile = resolution.profile;
    const baseUrl = profile.baseUrl?.trim() || undefined;
    if (profile.authType === 'api_key') {
      // The official default endpoint is reserved for keys provably belonging
      // to this family. An explicitly bound cross-protocol/unknown api_key
      // account must carry its own baseUrl — otherwise we would send a foreign
      // key to the official domain (credential disclosure). Fail before fetch.
      const identity = profileFamilyIdentity(profile);
      if (identity !== client && !baseUrl) {
        throw new Error(
          `account "${profile.id}" is not provably a ${client} credential (clientId: ${profile.persistedClientId ?? '(none)'}) ` +
            'and has no custom baseUrl — refusing to send its key to the official endpoint',
        );
      }
    }
    return { apiKey, ...(baseUrl ? { baseUrl } : {}) };
  }

  private async callAnthropic(prompt: string, signal: AbortSignal): Promise<LlmCallResult> {
    const { apiKey, baseUrl } = await this.resolveCredential('anthropic');

    const resp = await fetch(buildLlmEndpoint('anthropic', baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Anthropic API error ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = (await resp.json()) as { content: Array<{ text: string }> };
    return { text: data.content[0]?.text ?? '' };
  }

  private async callOpenAI(prompt: string, signal: AbortSignal): Promise<LlmCallResult> {
    const { apiKey, baseUrl } = await this.resolveCredential('openai');

    const resp = await fetch(buildLlmEndpoint('openai', baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`OpenAI API error ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return { text: data.choices[0]?.message.content ?? '' };
  }

  private async callGoogle(prompt: string, signal: AbortSignal): Promise<LlmCallResult> {
    const { apiKey, baseUrl } = await this.resolveCredential('google');

    const resp = await fetch(`${buildLlmEndpoint('google', baseUrl, this.model)}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 256 },
      }),
      signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Google AI API error ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = (await resp.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    return { text: data.candidates[0]?.content.parts[0]?.text ?? '' };
  }

  private async callKimi(prompt: string, signal: AbortSignal): Promise<LlmCallResult> {
    const { apiKey, baseUrl } = await this.resolveCredential('kimi');

    const resp = await fetch(buildLlmEndpoint('kimi', baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Kimi API error ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return { text: data.choices[0]?.message.content ?? '' };
  }

  /** Parse LLM text response into structured action. Tolerates markdown wrapping. */
  private parseActionResponse(text: string): AIActionResponse {
    // Strip markdown code fences if present
    const cleaned = text.replace(/```(?:json)?\n?/g, '').trim();
    try {
      const parsed = JSON.parse(cleaned) as Record<string, unknown>;
      return {
        actionName: String(parsed.actionName ?? ''),
        targetSeat: parsed.targetSeat ? String(parsed.targetSeat) : undefined,
      };
    } catch {
      // Fallback: try to extract targetSeat from natural language
      const match = cleaned.match(/P\d+/);
      return {
        actionName: '',
        targetSeat: match ? match[0] : undefined,
      };
    }
  }
}
