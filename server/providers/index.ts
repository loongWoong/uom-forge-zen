import type { ProviderId } from '../../shared/analysis.ts'
import { DEFAULT_PROVIDER } from '../../shared/analysis.ts'
import type { RunTurn } from './types.ts'
// ACP is disabled in the application; retain the adapter for manual experiments.
// import { createCodexProvider } from './codex.ts'
import { createDeepSeekProvider } from './deepseek.ts'
import { createGptProvider } from './gpt.ts'

export function resolveProvider(
  value: unknown = process.env.UOM_LLM_PROVIDER || DEFAULT_PROVIDER,
): ProviderId {
  if (value === 'codex')
    throw new Error('Codex ACP 已停用，请选择 DeepSeek 或 GPT。')
  if (value !== 'gpt' && value !== 'deepseek')
    throw new Error('不支持的推理提供方。')
  return value
}

/** Read-only provider/model descriptor for /api/config; never includes secrets. */
export function providerDescriptor(
  env: NodeJS.ProcessEnv = process.env,
): {
  provider: ProviderId
  model: string
  options: { value: ProviderId; model: string; ready: boolean }[]
} {
  const deepseekReady = Boolean(env.LLM_API_URL && env.LLM_API_KEY)
  const deepseekModel = env.LLM_MODEL || 'deepseek-chat'
  const gptReady = Boolean(env.GPT_API_URL && env.GPT_API_KEY)
  const gptModel = env.GPT_MODEL || 'gpt-6-astra'
  const provider = resolveProvider(env.UOM_LLM_PROVIDER)
  return {
    provider,
    model: provider === 'deepseek' ? deepseekModel : gptModel,
    options: [
      { value: 'deepseek', model: deepseekModel, ready: deepseekReady },
      { value: 'gpt', model: gptModel, ready: gptReady },
    ],
  }
}

/**
 * Model ids offered by the configured OpenAI-compatible endpoint (GET /v1/models).
 * Throws with a readable message when the endpoint is unreachable so the UI can
 * fall back to free-text input.
 */
export async function listEndpointModels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const configuredUrl = env.LLM_API_URL
  const apiKey = env.LLM_API_KEY
  if (!configuredUrl || !apiKey)
    throw new Error('DeepSeek 未配置 LLM_API_KEY 或 LLM_API_URL，无法获取模型列表。')
  const baseUrl = configuredUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '')
  let response: Response
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    })
  } catch (error) {
    throw new Error(`模型列表获取失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok)
    throw new Error(`模型列表获取失败：HTTP ${response.status}`)
  const payload: unknown = await response.json()
  const data = (payload as { data?: unknown })?.data
  if (!Array.isArray(data)) throw new Error('模型列表响应格式无效。')
  const ids = data
    .map((item) => (typeof (item as { id?: unknown })?.id === 'string' ? (item as { id: string }).id : ''))
    .filter(Boolean)
  return [...new Set(ids)]
}
// const codex = createCodexProvider()
const providers: Record<ProviderId, RunTurn> = {
  deepseek: createDeepSeekProvider(),
  gpt: createGptProvider(),
}
export const runProviderTurn: RunTurn = (prompt, options = {}) => {
  options.signal?.throwIfAborted()
  return providers[resolveProvider(options.provider)](prompt, options)
}
