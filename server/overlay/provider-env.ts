import type { ProviderId } from '../../shared/analysis.ts'

/**
 * A deployment can configure a single OpenAI-compatible gateway (LLM_*) that
 * serves several model families. Upstream resolves GPT/Qwen/GLM credentials
 * strictly, so without an alias such a gateway could not list its models for
 * those providers — the picker would report an error instead of the configured
 * baseURL's model list, and every turn would be rejected even though
 * the gateway is reachable.
 *
 * This seam knows nothing about upstream's logic: it only copies missing
 * environment variables before the server starts. `UOM_PROVIDER_FALLBACK=off`
 * disables it, an explicit GPT_/QWEN_ value always wins, and a partially
 * configured provider (for example a key without a URL) is never touched so it
 * keeps reporting its own, accurate error.
 */
const FALLBACK_PROVIDERS: ProviderId[] = ['gpt', 'qwen', 'glm']

/** Generic-channel variables a fallback provider copies when it has none. */
const FALLBACK_FIELDS = [
  'API_URL',
  'API_KEY',
  'MODEL',
  'API_TIMEOUT_MS',
  'MAX_OUTPUT_TOKENS',
] as const

const DISABLED_VALUES = ['0', 'false', 'off', 'no']

/** Internal marker: which providers took over the generic channel. */
export const INHERITED_ENV_KEY = 'UOM_OVERLAY_INHERITED_PROVIDERS'

export interface ProviderEnvInheritance {
  /** Providers that took over the generic channel. */
  providers: ProviderId[]
  /** Variables written, so a config reload can undo them. */
  keys: string[]
}

/** Per-provider deadlines that also bound a Pi stage. */
const PROVIDER_TIMEOUT_KEYS = [
  'LLM_API_TIMEOUT_MS',
  'GPT_API_TIMEOUT_MS',
  'QWEN_API_TIMEOUT_MS',
  'GLM_API_TIMEOUT_MS',
] as const

/**
 * `piSignal` (server/agents/runtime.ts) reads only `UOM_PI_TIMEOUT_MS` and
 * otherwise aborts a stage after 5 minutes, while the direct runtime honours
 * the selected provider's timeout. Without this alias a slow custom endpoint
 * (LLM_API_TIMEOUT_MS=900000) is cut off 5 minutes into a Pi run.
 *
 * The longest configured provider deadline wins, so the alias stays
 * request-independent (no per-request environment mutation) and never shortens
 * a run below what the slowest endpoint allows. Setting UOM_PI_TIMEOUT_MS
 * explicitly always wins.
 */
export function applyPiStageTimeout(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.UOM_PI_TIMEOUT_MS?.trim()) return undefined
  let longest = 0
  for (const key of PROVIDER_TIMEOUT_KEYS) {
    const value = Number(env[key])
    if (Number.isFinite(value) && value > longest) longest = value
  }
  if (longest <= 0) return undefined
  env.UOM_PI_TIMEOUT_MS = String(longest)
  return env.UOM_PI_TIMEOUT_MS
}

/** Providers an earlier `inheritProviderEndpoints` call aliased. */
export function inheritedProviders(env: NodeJS.ProcessEnv = process.env): ProviderId[] {
  const raw = env[INHERITED_ENV_KEY]?.trim()
  if (!raw) return []
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is ProviderId =>
      (FALLBACK_PROVIDERS as string[]).includes(value),
    )
}

/** `UOM_PROVIDER_FALLBACK` disables the alias; unset means enabled. */
export function providerFallbackDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.UOM_PROVIDER_FALLBACK?.trim().toLowerCase()
  return raw !== undefined && raw !== '' && DISABLED_VALUES.includes(raw)
}

function prefixOf(provider: ProviderId): string {
  return provider === 'gpt' ? 'GPT' : provider === 'qwen' ? 'QWEN' : 'GLM'
}

/**
 * Record which providers this pass aliased. A stale marker must never survive:
 * `model-config.ts` reads it to decide whether a provider behaves like the
 * generic channel (thinking off, DeepSeek Pi provider, generic compat flags).
 */
function syncMarker(
  env: NodeJS.ProcessEnv,
  providers: ProviderId[],
  keys: string[],
): void {
  if (providers.length === 0) {
    delete env[INHERITED_ENV_KEY]
    return
  }
  env[INHERITED_ENV_KEY] = providers.join(',')
  keys.push(INHERITED_ENV_KEY)
}

/**
 * Fill unset GPT_/QWEN_ variables from the generic LLM_* channel. Mutates the
 * passed environment (idempotent) and reports what it wrote.
 */
export function inheritProviderEndpoints(
  env: NodeJS.ProcessEnv = process.env,
): ProviderEnvInheritance {
  const result: ProviderEnvInheritance = { providers: [], keys: [] }
  if (providerFallbackDisabled(env)) {
    syncMarker(env, result.providers, result.keys)
    return result
  }
  const generic: Record<(typeof FALLBACK_FIELDS)[number], string | undefined> = {
    API_URL: env.LLM_API_URL?.trim(),
    API_KEY: env.LLM_API_KEY?.trim(),
    MODEL: env.LLM_MODEL?.trim(),
    API_TIMEOUT_MS: env.LLM_API_TIMEOUT_MS?.trim(),
    MAX_OUTPUT_TOKENS: env.LLM_MAX_OUTPUT_TOKENS?.trim(),
  }
  // Without an endpoint or a key there is nothing meaningful to inherit.
  if (!generic.API_URL && !generic.API_KEY) {
    syncMarker(env, result.providers, result.keys)
    return result
  }
  for (const provider of FALLBACK_PROVIDERS) {
    const prefix = prefixOf(provider)
    const name = (field: string) => `${prefix}_${field}`
    const own = (field: string) => env[name(field)]?.trim()
    if (own('API_URL') || own('API_KEY')) continue
    const written: string[] = []
    for (const field of FALLBACK_FIELDS) {
      const value = generic[field]
      if (!value || own(field)) continue
      env[name(field)] = value
      written.push(name(field))
    }
    if (written.length === 0) continue
    result.providers.push(provider)
    result.keys.push(...written)
  }
  syncMarker(env, result.providers, result.keys)
  return result
}
