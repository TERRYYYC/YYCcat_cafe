/**
 * Protocol-aware idempotent LLM endpoint builder (re-review P2).
 * Root-style and already-versioned bases must both produce exactly one
 * version segment; kimi reuses the repo's /coding → /coding/v1 normalization;
 * unparsable bases fail before any fetch could happen.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { buildLlmEndpoint } = await import('../dist/config/llm-provider-endpoints.js');

describe('buildLlmEndpoint', () => {
  it('anthropic: official default, root-style base, and versioned base are all single-versioned', () => {
    assert.equal(buildLlmEndpoint('anthropic', undefined), 'https://api.anthropic.com/v1/messages');
    assert.equal(
      buildLlmEndpoint('anthropic', 'https://gw.example.com/anthropic'),
      'https://gw.example.com/anthropic/v1/messages',
    );
    assert.equal(buildLlmEndpoint('anthropic', 'https://gw.example.com/v1'), 'https://gw.example.com/v1/messages');
    assert.equal(buildLlmEndpoint('anthropic', 'https://gw.example.com/v1/'), 'https://gw.example.com/v1/messages');
  });

  it('openai: root-style base gains /v1 exactly once; versioned base is untouched', () => {
    assert.equal(buildLlmEndpoint('openai', undefined), 'https://api.openai.com/v1/chat/completions');
    assert.equal(
      buildLlmEndpoint('openai', 'https://api.deepseek.com'),
      'https://api.deepseek.com/v1/chat/completions',
    );
    assert.equal(
      buildLlmEndpoint('openai', 'https://api.deepseek.com/v1'),
      'https://api.deepseek.com/v1/chat/completions',
    );
  });

  it('google: v1beta appended exactly once around the model resource', () => {
    assert.equal(
      buildLlmEndpoint('google', undefined, 'gemini-3.5-flash'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
    );
    assert.equal(
      buildLlmEndpoint('google', 'https://gw.example.com/v1beta', 'm'),
      'https://gw.example.com/v1beta/models/m:generateContent',
    );
    assert.equal(
      buildLlmEndpoint('google', 'https://gw.example.com', 'm'),
      'https://gw.example.com/v1beta/models/m:generateContent',
    );
  });

  it('kimi: reuses the repo /coding → /coding/v1 normalization and the moonshot default', () => {
    assert.equal(buildLlmEndpoint('kimi', undefined), 'https://api.moonshot.ai/v1/chat/completions');
    assert.equal(
      buildLlmEndpoint('kimi', 'https://api.kimi.com/coding'),
      'https://api.kimi.com/coding/v1/chat/completions',
    );
    assert.equal(buildLlmEndpoint('kimi', 'https://api.moonshot.ai/v1'), 'https://api.moonshot.ai/v1/chat/completions');
  });

  it('unparsable base fails before any network call could be made', () => {
    assert.throws(() => buildLlmEndpoint('anthropic', 'not a url'), /invalid anthropic base URL/);
  });
});
