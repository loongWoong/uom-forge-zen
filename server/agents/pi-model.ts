import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { Model } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import type { ModelConfig } from '../providers/model-config.ts'

/**
 * Adapter from the shared ModelConfig to the pi-ai Model shape. This is the
 * only place where the Pi runtime turns provider configuration into a client:
 * endpoint, id, api key, context window and output cap all come from
 * resolveModelConfig instead of being hard-coded per agent.
 */
export function toPiModel(config: ModelConfig): Model<'openai-completions'> {
  return {
    id: config.modelId,
    name: config.modelId,
    api: 'openai-completions',
    provider: config.piProvider,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.pi.contextWindow,
    maxTokens: config.pi.maxTokens,
    // Empty compat keeps pi-ai's URL/provider auto-detection (the merged
    // behavior); explicit flags only appear when the user configures them.
    ...(Object.keys(config.pi.compat).length ? { compat: config.pi.compat } : {}),
  }
}

/**
 * Build the Agent streamFn for one resolved config. Request parameters that the
 * direct client already sends (thinking disabled / reasoning effort, provider
 * output cap, per-call timeout) are applied here so both runtimes agree.
 * `fetch` is injectable for wire-capture tests.
 */
export function createPiStreamFn(
  config: ModelConfig,
  overrides: { fetch?: typeof fetch } = {},
): StreamFn {
  return (model, context, options) =>
    streamSimple(model as Model<'openai-completions'>, context, {
      ...options,
      apiKey: config.apiKey,
      maxTokens: config.pi.maxTokens,
      timeoutMs: config.timeoutMs,
      ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
      onPayload: (payload) => {
        const params = payload as Record<string, unknown>
        if (config.pi.disableThinking) params.thinking = { type: 'disabled' }
        else if (config.pi.reasoningEffort)
          params.reasoning_effort = config.pi.reasoningEffort
        return params
      },
    })
}
