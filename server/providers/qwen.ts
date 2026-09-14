import type { RunTurn } from './types.ts'
import { createChatCompletionsProvider } from './chat-completions.ts'
import { resolveModelConfig } from './model-config.ts'

/** Qwen uses the same OpenAI-compatible streaming API as the other providers. */
export function createQwenProvider(
  fetcher: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): RunTurn {
  return createChatCompletionsProvider(() => {
    const config = resolveModelConfig('qwen', { env })
    return {
      provider: 'qwen',
      label: config.label,
      apiKey: config.apiKey,
      url: config.baseUrl,
      model: config.modelId,
      timeoutMs: config.timeoutMs,
      // Standard OpenAI-compatible shape: plain max_tokens, no reasoning fields.
      parameters: { max_tokens: config.maxOutputTokens },
    }
  }, fetcher)
}
