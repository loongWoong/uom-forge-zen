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
): {
  provider: ProviderId
  model: string
  options: { value: ProviderId; model: string; ready: boolean }[]
} {
  const deepseekReady = Boolean(env.LLM_API_URL && env.LLM_API_KEY)
  const deepseekModel = env.LLM_MODEL || 'deepseek-chat'
  let codexModel = 'gpt-6-astra'
  try {
    codexModel = String(codexConfigFromEnv(env).model)
  } catch {
    // malformed CODEX_CONFIG keeps the documented default
  }
  return {
    provider: resolveProvider(env.UOM_LLM_PROVIDER),
    model: resolveProvider(env.UOM_LLM_PROVIDER) === 'deepseek' ? deepseekModel : codexModel,
    options: [
      { value: 'deepseek', model: deepseekModel, ready: deepseekReady },
      { value: 'codex', model: codexModel, ready: true },
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
const codex = createCodexProvider()
const deepseek = createDeepSeekProvider()
export const runProviderTurn: RunTurn = (prompt, options = {}) => {
  options.signal?.throwIfAborted()
  return resolveProvider(options.provider) === 'codex'
    ? codex(prompt, options)
    : deepseek(prompt, options)
}
