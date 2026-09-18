import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentRuntimeId, ProviderId } from '../../shared/analysis.ts'
import { PROVIDERS } from '../../shared/analysis.ts'
import { resolveProvider } from '../providers/index.ts'
import { normalizeEndpoint } from './model-config.ts'

/**
 * Overlay-only endpoints, served before upstream's API middleware sees the
 * request. They exist so the model switcher can verify the effective model and
 * offer the endpoint's model list without any upstream route or type change.
 */

/**
 * Endpoint shown to the browser: normalized, and never carrying credentials
 * that an operator may have embedded in the URL.
 */
function publicEndpoint(value?: string): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const normalized = normalizeEndpoint(trimmed)
  try {
    const parsed = new URL(normalized)
    if (!parsed.username && !parsed.password) return normalized
    parsed.username = ''
    parsed.password = ''
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
  } catch {
    return normalized
  }
}

interface ProviderOption {
  value: ProviderId
  model: string
  ready: boolean
  /** Base URL this provider will call; exposes no key material. */
  endpoint?: string
}

/** Deadline for listing an endpoint's models (`UOM_MODELS_TIMEOUT_MS`). */
export function modelsTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.UOM_MODELS_TIMEOUT_MS || '', 10)
  return Number.isFinite(configured) && configured > 0 ? configured : 10000
}

function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: unknown })?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

/** Read-only provider/model descriptor for /api/config; never includes secrets. */
export function providerDescriptor(
  env: NodeJS.ProcessEnv = process.env,
): {
  provider: ProviderId
  model: string
  /** Server default runtime, only when the operator set it explicitly. */
  runtime?: AgentRuntimeId
  options: ProviderOption[]
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
  const endpoints: Record<ProviderId, string | undefined> = {
    deepseek: publicEndpoint(env.LLM_API_URL),
    gpt: publicEndpoint(env.GPT_API_URL),
    qwen: publicEndpoint(env.QWEN_API_URL),
  }
  const option = (
    value: ProviderId,
    model: string,
    ready: boolean,
  ): ProviderOption => ({
    value,
    model,
    ready,
    ...(endpoints[value] ? { endpoint: endpoints[value] } : {}),
  })
  const runtime =
    env.UOM_AGENT_RUNTIME === 'direct' || env.UOM_AGENT_RUNTIME === 'pi'
      ? env.UOM_AGENT_RUNTIME
      : undefined
  return {
    provider,
    model: models[provider],
    ...(runtime ? { runtime } : {}),
    options: [
      option('deepseek', deepseekModel, deepseekReady),
      option('gpt', gptModel, gptReady),
      option('qwen', qwenModel, qwenReady),
    ],
  }
}

/**
 * Model ids offered by the endpoint this provider will actually call
 * (GET <baseUrl>/models). The endpoint is resolved the same way the requests
 * resolve it, so the picker can never list a different baseURL than the one the
 * turn uses; a provider without its own endpoint follows the generic LLM_*
 * channel (see `provider-env.ts`) when that channel is configured. Throws with a
 * readable message when the endpoint is unreachable so the UI can fall back to
 * free-text input.
 */
export async function listEndpointModels(
  provider: ProviderId = 'deepseek',
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ models: string[]; endpoint: string }> {
  const label = PROVIDERS[provider].name
  const credentials: Record<
    ProviderId,
    { prefix: string; url?: string; key?: string }
  > = {
    deepseek: { prefix: 'LLM', url: env.LLM_API_URL, key: env.LLM_API_KEY },
    gpt: { prefix: 'GPT', url: env.GPT_API_URL, key: env.GPT_API_KEY },
    qwen: { prefix: 'QWEN', url: env.QWEN_API_URL, key: env.QWEN_API_KEY },
  }
  const { prefix, url: configuredUrl, key: apiKey } = credentials[provider]
  if (!configuredUrl || !apiKey)
    throw new Error(
      `${label} 未配置 ${prefix}_API_KEY 或 ${prefix}_API_URL，无法获取模型列表。`,
    )
  const baseUrl = normalizeEndpoint(configuredUrl)
  const endpoint = publicEndpoint(configuredUrl) as string
  const timeoutMs = modelsTimeoutMs(env)
  let response: Response
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      // A gate that accepts the connection and never answers must not leave the
      // picker spinning forever.
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (isTimeoutError(error))
      throw new Error(`模型列表获取超时（${timeoutMs} 毫秒），已放弃等待。`)
    throw new Error(
      `模型列表获取失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!response.ok) throw new Error(`模型列表获取失败：HTTP ${response.status}`)
  const payload: unknown = await response.json()
  const data = (payload as { data?: unknown })?.data
  if (!Array.isArray(data)) throw new Error('模型列表响应格式无效。')
  const ids = data
    .map((item) =>
      typeof (item as { id?: unknown })?.id === 'string'
        ? (item as { id: string }).id
        : '',
    )
    .filter(Boolean)
  return { models: [...new Set(ids)], endpoint }
}

/**
 * Handle the overlay's own routes. Returns true when the response was sent so
 * the caller must not delegate to upstream.
 */
export async function handleOverlayRoutes(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const pathname = (request.url || '').split('?')[0]
  if (pathname === '/api/config') {
    if (request.method !== 'GET') {
      response.statusCode = 405
      response.setHeader('allow', 'GET')
      response.end('Method Not Allowed')
      return true
    }
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.end(JSON.stringify(providerDescriptor()))
    return true
  }
  if (pathname === '/api/models') {
    if (request.method !== 'GET') {
      response.statusCode = 405
      response.setHeader('allow', 'GET')
      response.end('Method Not Allowed')
      return true
    }
    response.setHeader('content-type', 'application/json; charset=utf-8')
    const requested = new URL(
      request.url || '',
      'http://localhost',
    ).searchParams.get('provider')
    let provider: ProviderId
    try {
      provider = resolveProvider(requested ?? undefined)
    } catch (error) {
      response.statusCode = 400
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      return true
    }
    try {
      response.end(JSON.stringify(await listEndpointModels(provider)))
    } catch (error) {
      response.statusCode = 502
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }
    return true
  }
  return false
}
