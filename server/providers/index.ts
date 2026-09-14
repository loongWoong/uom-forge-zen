import type { AgentRuntimeId, ProviderId } from '../../shared/analysis.ts'
import { DEFAULT_PROVIDER, PROVIDERS } from '../../shared/analysis.ts'
import type { RunTurn } from './types.ts'
import { normalizeEndpoint } from './model-config.ts'
// ACP is disabled in the application; retain the adapter for manual experiments.
// import { createCodexProvider } from './codex.ts'
import { createDeepSeekProvider } from './deepseek.ts'
import { createGptProvider } from './gpt.ts'
import { createQwenProvider } from './qwen.ts'

export function resolveProvider(
  value: unknown = process.env.UOM_LLM_PROVIDER || DEFAULT_PROVIDER,
): ProviderId {
  if (value === 'codex')
    throw new Error('Codex ACP 已停用，请选择 DeepSeek、GPT 或 Qwen。')
  if (value !== 'gpt' && value !== 'deepseek' && value !== 'qwen')
    throw new Error('不支持的推理提供方。')
  return value
}

/** Read-only provider/model descriptor for /api/config; never includes secrets. */
export function providerDescriptor(
  env: NodeJS.ProcessEnv = process.env,
): {
  provider: ProviderId
  model: string
  /** Server default runtime, only when the operator set it explicitly. */
  runtime?: AgentRuntimeId
  options: { value: ProviderId; model: string; ready: boolean }[]
} {
  const deepseekReady = Boolean(env.LLM_API_URL && env.LLM_API_KEY)
  const deepseekModel = env.LLM_MODEL || 'deepseek-chat'
  const gptReady = Boolean(env.GPT_API_URL && env.GPT_API_KEY)
  const gptModel = env.GPT_MODEL || 'gpt-6-astra'
  const qwenReady = Boolean(env.QWEN_API_URL && env.QWEN_API_KEY)
  const qwenModel = env.QWEN_MODEL || 'Qwen3.6'
  const provider = resolveProvider(env.UOM_LLM_PROVIDER)
  const models: Record<ProviderId, string> = {
    deepseek: deepseekModel,
    gpt: gptModel,
    qwen: qwenModel,
  }
  const runtime =
    env.UOM_AGENT_RUNTIME === 'direct' || env.UOM_AGENT_RUNTIME === 'pi'
      ? env.UOM_AGENT_RUNTIME
      : undefined
  return {
    provider,
    model: models[provider],
    ...(runtime ? { runtime } : {}),
    options: [
      { value: 'deepseek', model: deepseekModel, ready: deepseekReady },
      { value: 'gpt', model: gptModel, ready: gptReady },
      { value: 'qwen', model: qwenModel, ready: qwenReady },
    ],
  }
}

/**
 * Model ids offered by the configured OpenAI-compatible endpoint (GET /v1/models).
 * Each provider reads its own endpoint/key pair, so the GPT picker no longer
 * proxies the DeepSeek endpoint. Throws with a readable message when the
 * endpoint is unreachable so the UI can fall back to free-text input.
 */
export async function listEndpointModels(
  provider: ProviderId = 'deepseek',
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const label = PROVIDERS[provider].name
  const credentials: Record<ProviderId, { prefix: string; url?: string; key?: string }> = {
    deepseek: { prefix: 'LLM', url: env.LLM_API_URL, key: env.LLM_API_KEY },
    gpt: { prefix: 'GPT', url: env.GPT_API_URL, key: env.GPT_API_KEY },
    qwen: { prefix: 'QWEN', url: env.QWEN_API_URL, key: env.QWEN_API_KEY },
  }
  const { prefix, url: configuredUrl, key: apiKey } = credentials[provider]
  if (!configuredUrl || !apiKey)
    throw new Error(`${label} 未配置 ${prefix}_API_KEY 或 ${prefix}_API_URL，无法获取模型列表。`)
  const baseUrl = normalizeEndpoint(configuredUrl)
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
  qwen: createQwenProvider(),
}
export const runProviderTurn: RunTurn = (prompt, options = {}) => {
  options.signal?.throwIfAborted()
  return providers[resolveProvider(options.provider)](prompt, options)
}
