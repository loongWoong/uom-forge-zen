import type { ProviderId } from '../../shared/analysis.ts'
import type { RunTurn } from './types.ts'
import { createCodexProvider, codexConfigFromEnv } from './codex.ts'
import { createDeepSeekProvider } from './deepseek.ts'

export function resolveProvider(
  value: unknown = process.env.UOM_LLM_PROVIDER || 'deepseek',
): ProviderId {
  if (value !== 'codex' && value !== 'deepseek')
    throw new Error('不支持的推理提供方。')
  return value
}

/** Read-only provider/model descriptor for /api/config; never includes secrets. */
export function providerDescriptor(
  env: NodeJS.ProcessEnv = process.env,
): { provider: ProviderId; model: string } {
  const provider = resolveProvider(env.UOM_LLM_PROVIDER)
  if (provider === 'deepseek')
    return { provider, model: env.LLM_MODEL || 'deepseek-chat' }
  try {
    return { provider, model: String(codexConfigFromEnv(env).model) }
  } catch {
    return { provider, model: 'gpt-6-astra' }
  }
}
const codex = createCodexProvider()
const deepseek = createDeepSeekProvider()
export const runProviderTurn: RunTurn = (prompt, options = {}) => {
  options.signal?.throwIfAborted()
  return resolveProvider(options.provider) === 'codex'
    ? codex(prompt, options)
    : deepseek(prompt, options)
}
