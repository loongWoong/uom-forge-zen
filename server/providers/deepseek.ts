import type { RunTurn } from './types.ts'
import { createChatCompletionsProvider } from './chat-completions.ts'
import { resolveModelConfig } from './model-config.ts'

export function createDeepSeekProvider(
  fetcher: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): RunTurn {
  return createChatCompletionsProvider(() => {
    // Resolve per call so the UI model override and .env edits apply without a restart.
    const config = resolveModelConfig('deepseek', { env })
    return {
      provider: 'deepseek',
      label: config.label,
      apiKey: config.apiKey,
      url: config.baseUrl,
      model: config.modelId,
      timeoutMs: config.timeoutMs,
      // Candidate JSON can be large; reserve enough room for validation rather
      // than allowing the provider to truncate a structurally valid model.
      parameters: {
        thinking: { type: 'disabled' },
        max_tokens: config.maxOutputTokens,
      },
    }
  }, fetcher)
}
