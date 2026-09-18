import type { ProviderId } from '../../shared/analysis.ts'
import { normalizeEndpoint, type ModelConfig } from './model-config.ts'

const PROVIDER_ORDER: ProviderId[] = ['deepseek', 'gpt', 'qwen']

function envBoolean(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined || value.trim() === '') return fallback
  return ['1', 'true', 'on', 'yes'].includes(value.trim().toLowerCase())
}

/** Raw configured endpoints, keyed by provider (credentials not needed here). */
function providerUrls(env: NodeJS.ProcessEnv): Record<ProviderId, string> {
  return {
    deepseek: env.LLM_API_URL || '',
    gpt: env.GPT_API_URL || '',
    qwen: env.QWEN_API_URL || '',
  }
}

/**
 * Which provider does this chat-completions URL belong to? Prefers the
 * provider named by the current request, then picks the longest configured
 * endpoint that prefixes the URL (endpoints are frequently nested, e.g. a
 * gateway serving several model families under one /v1).
 */
export function providerForUrl(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
  preferred?: ProviderId,
): ProviderId | undefined {
  const urls = providerUrls(env)
  const order = preferred
    ? [preferred, ...PROVIDER_ORDER.filter((item) => item !== preferred)]
    : PROVIDER_ORDER
  let best: { provider: ProviderId; length: number } | undefined
  for (const provider of order) {
    const base = normalizeEndpoint(urls[provider] || '')
    if (!base) continue
    const request = normalizeEndpoint(url)
    if (request !== base && !request.startsWith(`${base}/`)) continue
    if (!best || base.length > best.length)
      best = { provider, length: base.length }
  }
  return best?.provider
}

function maxTokensField(
  config: ModelConfig,
  env: NodeJS.ProcessEnv,
): 'max_tokens' | 'max_completion_tokens' | undefined {
  const configured = env.UOM_PI_MAX_TOKENS_FIELD?.trim()
  if (configured === 'max_tokens' || configured === 'max_completion_tokens')
    return configured
  return config.pi.compat.maxTokensField
}

/**
 * Rewrite one chat-completions request body with the overlay's model config.
 *
 * Both runtimes end up at the same HTTP call: the direct providers build their
 * body from environment defaults, Pi agents build theirs inside pi-ai. Doing
 * the rewrite at the fetch boundary is what keeps the two clients from
 * drifting: the model override, the output cap, thinking/reasoning parameters
 * and the minimal-gateway compatibility switches are applied to both without
 * touching any upstream provider file.
 */
export function rewriteChatBody(
  body: Record<string, unknown>,
  config: ModelConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const generic = (env.UOM_PI_COMPAT || '').trim().toLowerCase() === 'generic'

  body.model = config.modelId

  if (config.pi.disableThinking) {
    body.thinking = { type: 'disabled' }
    delete body.reasoning_effort
  } else if (config.pi.reasoningEffort !== undefined) {
    body.reasoning_effort = config.pi.reasoningEffort
    delete body.thinking
  } else {
    // The operator asked for no reasoning parameters (X_REASONING_EFFORT=off),
    // or the provider follows the generic channel: drop what upstream sent
    // instead of forwarding a vendor flag a minimal gateway may reject.
    delete body.reasoning_effort
  }
  // A minimal gateway must not receive vendor reasoning extensions at all.
  if (generic) {
    delete body.thinking
    delete body.reasoning_effort
  }

  const field = maxTokensField(config, env)
  const existing =
    'max_completion_tokens' in body
      ? 'max_completion_tokens'
      : 'max_tokens' in body
        ? 'max_tokens'
        : undefined
  const target = field ?? existing ?? 'max_tokens'
  if (config.maxOutputTokens !== undefined) {
    body[target] = config.maxOutputTokens
    for (const other of ['max_tokens', 'max_completion_tokens'])
      if (other !== target) delete body[other]
  } else if (existing) {
    // Pi (and any caller that already sends a cap) keeps a bounded output.
    body[existing] = config.pi.maxTokens
  }

  if (generic || !envBoolean(env.UOM_PI_STORE, true)) delete body.store
  if (generic || !envBoolean(env.UOM_PI_STREAM_OPTIONS, true))
    delete body.stream_options

  if (generic && 'max_completion_tokens' in body) {
    body.max_tokens = body.max_completion_tokens
    delete body.max_completion_tokens
  } else if (
    field === 'max_tokens' &&
    'max_completion_tokens' in body
  ) {
    body.max_tokens = body.max_completion_tokens
    delete body.max_completion_tokens
  }
}

/** True when the URL is a chat-completions call handled by this overlay. */
export function isChatCompletionsUrl(url: string): boolean {
  try {
    return /\/chat\/completions\/?$/i.test(new URL(url).pathname)
  } catch {
    return /\/chat\/completions\/?$/i.test(url.split('?')[0] || '')
  }
}
