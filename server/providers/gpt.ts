import type { RunTurn } from './types.ts'
import { createChatCompletionsProvider } from './chat-completions.ts'
import { resolveModelConfig } from './model-config.ts'

export function createGptProvider(
  fetcher: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): RunTurn {
  return createChatCompletionsProvider(() => {
    const config = resolveModelConfig('gpt', { env })
    return {
      provider: 'gpt',
      label: config.label,
      apiKey: config.apiKey,
      url: config.baseUrl,
      model: config.modelId,
      reasoningEffort: config.reasoningEffort,
      timeoutMs: config.timeoutMs,
      parameters: {
        reasoning_effort: config.reasoningEffort ?? 'medium',
        // Only sent when GPT_MAX_OUTPUT_TOKENS is configured; unchanged otherwise.
        ...(config.maxOutputTokens !== undefined
          ? { max_tokens: config.maxOutputTokens }
          : {}),
      },
    }
  }, fetcher)
}
