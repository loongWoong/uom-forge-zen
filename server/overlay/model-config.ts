import type { OpenAICompletionsCompat } from '@earendil-works/pi-ai'
import type { ProviderId } from '../../shared/analysis.ts'
import { PROVIDERS } from '../../shared/analysis.ts'
import { timeoutFromEnv } from '../providers/lifetime.ts'
import { inheritedProviders } from './provider-env.ts'

/**
 * Single source of truth for model configuration. Both runtimes resolve their
 * endpoint, credentials, model id, timeouts and request parameters here:
 *
 *   direct runtime -> providers/deepseek.ts | providers/gpt.ts | providers/qwen.ts
 *                     -> chat-completions.ts
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
  /** Send GLM's required `thinking: { type: 'enabled', clear_thinking: false }` (GLM-5.3-Flash refuses to run without it). */
  glmThinking?: boolean
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
  /** Direct-client output cap. DeepSeek and Qwen always send it; GPT only when configured. */
  maxOutputTokens?: number
  /** GPT reasoning effort for the direct client. */
  reasoningEffort?: string
  /** pi-ai provider name (`openai` / `deepseek` / `qwen`). */
  piProvider: string
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

interface ProviderProfile {
  label: string
  apiKey?: string
  url?: string
  model: string
  timeoutEnv?: string
  maxOutputTokens?: number
  reasoningEffort?: string
  /** Direct requests carry `thinking: { type: 'disabled' }` for this provider. */
  disableThinking: boolean
  /** Direct requests carry GLM's mandatory enabled-thinking parameters. */
  glmThinking?: boolean
  piProvider: string
  /** Per-provider pi-ai compat that keeps Pi requests aligned with the direct client. */
  compat: OpenAICompletionsCompat
}

/** Environment-variable prefix of one provider (GLM_API_* etc.). */
function envPrefix(provider: ProviderId): string {
  return provider === 'gpt'
    ? 'GPT'
    : provider === 'qwen'
      ? 'QWEN'
      : provider === 'glm'
        ? 'GLM'
        : 'LLM'
}

function credentialNames(provider: ProviderId): string {
  // GLM has an upstream default endpoint, so only the key is mandatory.
  return provider === 'glm'
    ? 'GLM_API_KEY'
    : `${envPrefix(provider)}_API_KEY 或 ${envPrefix(provider)}_API_URL`
}

/**
 * Profile of the generic OpenAI-compatible channel. An inherited provider is
 * that channel under another name, so it reuses these settings verbatim
 * (thinking suppression, pi-ai compat, timeouts, output cap) and only differs
 * by label and model id. Without the shared profile an inherited GPT/Qwen turn
 * would send vendor parameters the generic gateway never sees from LLM_*.
 */
function genericProfile(env: NodeJS.ProcessEnv): ProviderProfile {
  return {
    label: PROVIDERS.deepseek.name,
    apiKey: env.LLM_API_KEY,
    url: env.LLM_API_URL,
    model: env.LLM_MODEL || 'deepseek-chat',
    timeoutEnv: env.LLM_API_TIMEOUT_MS,
    maxOutputTokens: positiveInt(
      env.LLM_MAX_OUTPUT_TOKENS,
      'LLM_MAX_OUTPUT_TOKENS',
      16384,
    ),
    disableThinking: true,
    piProvider: 'deepseek',
    compat: {},
  }
}

/** Environment-backed defaults for one provider, read by both runtimes. */
function providerProfile(
  provider: ProviderId,
  env: NodeJS.ProcessEnv,
): ProviderProfile {
  if (provider !== 'deepseek' && inheritedProviders(env).includes(provider)) {
    const prefix = envPrefix(provider)
    const generic = genericProfile(env)
    return {
      ...generic,
      label: PROVIDERS[provider].name,
      model: env[`${prefix}_MODEL`]?.trim() || generic.model,
    }
  }
  if (provider === 'glm')
    return {
      label: 'GLM',
      apiKey: env.GLM_API_KEY,
      // Upstream's default: GLM coding-plan keys are provisioned against this
      // endpoint (server/providers/model-config.ts).
      url: env.GLM_API_URL || 'https://open.bigmodel.cn/api/coding/paas/v4',
      model: env.GLM_MODEL || 'glm-5.3-flash',
      timeoutEnv: env.GLM_API_TIMEOUT_MS,
      maxOutputTokens: positiveInt(
        env.GLM_MAX_OUTPUT_TOKENS,
        'GLM_MAX_OUTPUT_TOKENS',
        32768,
      ),
      reasoningEffort: env.GLM_REASONING_EFFORT || 'max',
      disableThinking: false,
      // GLM-5.3-Flash requires thinking, including tool handoff/retry turns.
      glmThinking: true,
      piProvider: 'zai',
      compat: {
        supportsStore: false,
        supportsStrictMode: false,
        maxTokensField: 'max_tokens',
      },
    }
  if (provider === 'gpt')
    return {
      label: 'GPT',
      apiKey: env.GPT_API_KEY,
      url: env.GPT_API_URL,
      model: env.GPT_MODEL || 'gpt-6-astra',
      timeoutEnv: env.GPT_API_TIMEOUT_MS,
      maxOutputTokens: optionalPositiveInt(
        env.GPT_MAX_OUTPUT_TOKENS,
        'GPT_MAX_OUTPUT_TOKENS',
      ),
      reasoningEffort: env.GPT_REASONING_EFFORT || 'medium',
      disableThinking: false,
      piProvider: 'openai',
      compat: {},
    }
  if (provider === 'qwen')
    return {
      label: 'Qwen',
      apiKey: env.QWEN_API_KEY,
      url: env.QWEN_API_URL,
      model: env.QWEN_MODEL || 'Qwen3.6',
      timeoutEnv: env.QWEN_API_TIMEOUT_MS,
      maxOutputTokens: positiveInt(
        env.QWEN_MAX_OUTPUT_TOKENS,
        'QWEN_MAX_OUTPUT_TOKENS',
        16384,
      ),
      disableThinking: false,
      piProvider: 'qwen',
      // Qwen direct requests send a plain max_tokens and no store flag; keep
      // the Pi adapter on the same shape for this OpenAI-compatible endpoint.
      compat: { supportsStore: false, maxTokensField: 'max_tokens' },
    }
  return genericProfile(env)
}

/** `UOM_PI_COMPAT=generic` switches off the vendor-specific extensions a minimal
 *  OpenAI-compatible gateway is likely to reject. Individual flags win over it. */
function piCompat(
  env: NodeJS.ProcessEnv,
  generic: boolean,
  base: OpenAICompletionsCompat,
): OpenAICompletionsCompat {
  const compat: OpenAICompletionsCompat = { ...base }
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
  const profile = providerProfile(provider, env)
  if (!profile.apiKey || !profile.url)
    throw new Error(
      `${profile.label} 未配置 ${credentialNames(provider)}。`,
    )
  const override = options.override?.trim()
  const modelId = override || profile.model
  const baseUrl = normalizeEndpoint(profile.url)
  if (!baseUrl) throw new Error(`${profile.label} 的 API URL 无效。`)
  const timeoutMs = timeoutFromEnv(profile.timeoutEnv)
  const maxOutputTokens = profile.maxOutputTokens
  const reasoningEffort = profile.reasoningEffort

  const generic = (env.UOM_PI_COMPAT || '').trim().toLowerCase() === 'generic'
  if (
    env.UOM_PI_COMPAT !== undefined &&
    env.UOM_PI_COMPAT.trim() !== '' &&
    !generic
  )
    throw new Error('UOM_PI_COMPAT 目前只支持 generic。')
  const disableThinking =
    envBoolean(env.UOM_PI_DISABLE_THINKING, 'UOM_PI_DISABLE_THINKING') ??
    (profile.disableThinking && !generic)
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
    ...(disableThinking || piEffort === undefined
      ? {}
      : { reasoningEffort: piEffort }),
    ...(profile.glmThinking && !disableThinking ? { glmThinking: true } : {}),
    compat: piCompat(env, generic, profile.compat),
  }
  return {
    provider,
    label: profile.label,
    modelId,
    apiKey: profile.apiKey,
    baseUrl,
    chatCompletionsUrl: directUrl(profile.url),
    timeoutMs,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    piProvider: profile.piProvider,
    pi,
  }
}

/**
 * Environment-backed provider descriptor used by the Pi agents that only need
 * the endpoint, credentials and model id (not the full direct-call settings).
 */
export interface ModelProviderConfig {
  label: string
  apiKey?: string
  url?: string
  model: string
  piProvider: string
}

export function modelProviderConfig(
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): ModelProviderConfig {
  if (provider === 'glm')
    return {
      label: 'GLM',
      apiKey: env.GLM_API_KEY,
      url: env.GLM_API_URL || 'https://open.bigmodel.cn/api/coding/paas/v4',
      model: env.GLM_MODEL || 'glm-5.3-flash',
      piProvider: 'zai',
    }
  if (provider === 'gpt')
    return {
      label: 'GPT',
      apiKey: env.GPT_API_KEY,
      url: env.GPT_API_URL,
      model: env.GPT_MODEL || 'gpt-6-astra',
      piProvider: 'openai',
    }
  if (provider === 'qwen')
    return {
      label: 'Qwen',
      apiKey: env.QWEN_API_KEY,
      url: env.QWEN_API_URL,
      model: env.QWEN_MODEL || 'Qwen3.6',
      piProvider: 'qwen',
    }
  return {
    label: 'DeepSeek',
    apiKey: env.LLM_API_KEY,
    url: env.LLM_API_URL,
    model: env.LLM_MODEL || 'deepseek-chat',
    piProvider: 'deepseek',
  }
}

export function requireModelProviderConfig(
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): ModelProviderConfig {
  const config = modelProviderConfig(provider, env)
  if (!config.apiKey || !config.url)
    throw new Error(`${config.label} 未配置 ${credentialNames(provider)}。`)
  return config
}
