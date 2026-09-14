import type { OpenAICompletionsCompat } from '@earendil-works/pi-ai'
import type { ProviderId } from '../../shared/analysis.ts'
import { timeoutFromEnv } from './lifetime.ts'

/**
 * Single source of truth for model configuration. Both runtimes resolve their
 * endpoint, credentials, model id, timeouts and request parameters here:
 *
 *   direct runtime -> providers/deepseek.ts | providers/gpt.ts -> chat-completions.ts
 *   Pi runtime     -> agents/pi-model.ts (toPiModel / createPiStreamFn)
 *
 * Reading the environment in one place keeps the two clients from drifting
 * (the Pi agents used to build their own Model objects with hard-coded
 * maxTokens/contextWindow and no access to the provider parameters).
 */
export interface PiModelSettings {
  maxTokens: number
  contextWindow: number
  /** Send `thinking: { type: 'disabled' }` on every request (DeepSeek-style endpoints). */
  disableThinking: boolean
  /** Send `reasoning_effort` when thinking is not disabled (OpenAI-style endpoints). */
  reasoningEffort?: string
  /** Explicit pi-ai compatibility overrides; empty means "auto-detect from URL". */
  compat: OpenAICompletionsCompat
}

export interface ModelConfig {
  provider: ProviderId
  label: string
  modelId: string
  apiKey: string
  /** Normalized endpoint without a trailing `/chat/completions`. */
  baseUrl: string
  /** Exact URL used by the direct client. */
  chatCompletionsUrl: string
  /** Per-call timeout for the direct client; also the default Pi stage budget. */
  timeoutMs: number
  /** Direct-client output cap. DeepSeek always sends it; GPT only when configured. */
  maxOutputTokens?: number
  /** GPT reasoning effort for the direct client. */
  reasoningEffort?: string
  pi: PiModelSettings
}

/** Strip trailing slashes and one trailing `/chat/completions`. */
export function normalizeEndpoint(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/+$/, '')
}

function directUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return /\/chat\/completions$/i.test(trimmed)
    ? trimmed
    : `${normalizeEndpoint(trimmed)}/chat/completions`
}

function envBoolean(
  value: string | undefined,
  name: string,
): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false
  throw new Error(`${name} 必须是布尔值（true/false）。`)
}

function positiveInt(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  const parsed = Number(value ? value : fallback)
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} 必须为正整数。`)
  return parsed
}

function optionalPositiveInt(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return positiveInt(value, name, 1)
}

/** `UOM_PI_COMPAT=generic` switches off the vendor-specific extensions a minimal
 *  OpenAI-compatible gateway is likely to reject. Individual flags win over it. */
function piCompat(env: NodeJS.ProcessEnv, generic: boolean): OpenAICompletionsCompat {
  const compat: OpenAICompletionsCompat = {}
  if (generic) {
    compat.supportsUsageInStreaming = false
    compat.supportsStrictMode = false
    compat.supportsStore = false
    compat.supportsReasoningEffort = false
    compat.maxTokensField = 'max_tokens'
  }
  const usage = envBoolean(env.UOM_PI_STREAM_OPTIONS, 'UOM_PI_STREAM_OPTIONS')
  if (usage !== undefined) compat.supportsUsageInStreaming = usage
  const strict = envBoolean(env.UOM_PI_STRICT, 'UOM_PI_STRICT')
  if (strict !== undefined) compat.supportsStrictMode = strict
  const store = envBoolean(env.UOM_PI_STORE, 'UOM_PI_STORE')
  if (store !== undefined) compat.supportsStore = store
  const field = env.UOM_PI_MAX_TOKENS_FIELD
  if (field !== undefined && field.trim() !== '') {
    const normalized = field.trim()
    if (normalized !== 'max_tokens' && normalized !== 'max_completion_tokens')
      throw new Error(
        'UOM_PI_MAX_TOKENS_FIELD 必须是 max_tokens 或 max_completion_tokens。',
      )
    compat.maxTokensField = normalized
  }
  return compat
}

export function resolveModelConfig(
  provider: ProviderId,
  options: { override?: string; env?: NodeJS.ProcessEnv } = {},
): ModelConfig {
  const env = options.env || process.env
  const isGpt = provider === 'gpt'
  const label = isGpt ? 'GPT' : 'DeepSeek'
  const apiKey = isGpt ? env.GPT_API_KEY : env.LLM_API_KEY
  const rawUrl = isGpt ? env.GPT_API_URL : env.LLM_API_URL
  if (!apiKey || !rawUrl)
    throw new Error(
      `${label} 未配置 ${isGpt ? 'GPT' : 'LLM'}_API_KEY 或 ${isGpt ? 'GPT' : 'LLM'}_API_URL。`,
    )
  const override = options.override?.trim()
  const modelId =
    (override ? override : undefined) ||
    (isGpt ? env.GPT_MODEL : env.LLM_MODEL) ||
    (isGpt ? 'gpt-6-astra' : 'deepseek-chat')
  const baseUrl = normalizeEndpoint(rawUrl)
  if (!baseUrl) throw new Error(`${label} 的 API URL 无效。`)
  const timeoutMs = timeoutFromEnv(
    isGpt ? env.GPT_API_TIMEOUT_MS : env.LLM_API_TIMEOUT_MS,
  )
  const maxOutputTokens = isGpt
    ? optionalPositiveInt(env.GPT_MAX_OUTPUT_TOKENS, 'GPT_MAX_OUTPUT_TOKENS')
    : positiveInt(env.LLM_MAX_OUTPUT_TOKENS, 'LLM_MAX_OUTPUT_TOKENS', 16384)
  const reasoningEffort = isGpt
    ? env.GPT_REASONING_EFFORT || 'medium'
    : undefined

  const generic = (env.UOM_PI_COMPAT || '').trim().toLowerCase() === 'generic'
  if (
    env.UOM_PI_COMPAT !== undefined &&
    env.UOM_PI_COMPAT.trim() !== '' &&
    !generic
  )
    throw new Error('UOM_PI_COMPAT 目前只支持 generic。')
  const disableThinking =
    envBoolean(env.UOM_PI_DISABLE_THINKING, 'UOM_PI_DISABLE_THINKING') ??
    (!isGpt && !generic)
  const rawPiEffort = env.UOM_PI_REASONING_EFFORT
  const piEffort =
    rawPiEffort === undefined
      ? generic
        ? undefined
        : reasoningEffort
      : ['', 'off', 'none'].includes(rawPiEffort.trim().toLowerCase())
        ? undefined
        : rawPiEffort.trim()
  const pi: PiModelSettings = {
    // Keep the merged runtime's 24000 fallback only when no provider cap exists.
    maxTokens:
      optionalPositiveInt(env.UOM_PI_MAX_TOKENS, 'UOM_PI_MAX_TOKENS') ??
      maxOutputTokens ??
      24000,
    contextWindow:
      optionalPositiveInt(env.UOM_PI_CONTEXT_WINDOW, 'UOM_PI_CONTEXT_WINDOW') ??
      128000,
    disableThinking,
    ...(disableThinking ? {} : { reasoningEffort: piEffort }),
    compat: piCompat(env, generic),
  }
  return {
    provider,
    label,
    modelId,
    apiKey,
    baseUrl,
    chatCompletionsUrl: directUrl(rawUrl),
    timeoutMs,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    pi,
  }
}
