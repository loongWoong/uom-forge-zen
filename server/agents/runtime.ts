import type { AgentRuntimeId } from '../../shared/analysis.ts'
import type { StageOptions } from '../stages/contracts.ts'

/**
 * Stage-level deadline for a Pi run. `UOM_PI_TIMEOUT_MS` overrides the budget;
 * otherwise the caller passes the provider's per-call timeout so a slow custom
 * endpoint is not cut at the 5-minute default while the direct runtime is
 * allowed its full LLM_API_TIMEOUT_MS / GPT_API_TIMEOUT_MS.
 */
export function piSignal(
  options: StageOptions,
  label: string,
  fallbackMs = 300000,
) {
  const configured = Number(process.env.UOM_PI_TIMEOUT_MS)
  const timeoutMs =
    Number.isFinite(configured) && configured > 0 ? configured : fallbackMs
  const controller = new AbortController()
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`${label}超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`),
      ),
    timeoutMs,
  )
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal
  return { signal, dispose: () => clearTimeout(timer) }
}

/**
 * Provider failures inside a Pi run end as an assistant message whose
 * stopReason is "error"; the Agent keeps that text on state.errorMessage.
 * Without this the stage could only report "Pi Agent 未提交…" and hide the
 * real cause (HTTP status, rejected fields, unsupported tools).
 *
 * `fallbackEligible` is true only when no tool ever ran, i.e. the very first
 * model turn failed and a direct retry cannot duplicate side effects.
 */
export class PiModelError extends Error {
  readonly fallbackEligible: boolean
  constructor(message: string, fallbackEligible: boolean) {
    super(message)
    this.name = 'PiModelError'
    this.fallbackEligible = fallbackEligible
  }
}

export function piModelError(
  agent: { state: { errorMessage?: string } },
  label: string,
  fallbackEligible: boolean,
): PiModelError | undefined {
  const message = agent.state.errorMessage?.trim()
  if (!message) return undefined
  return new PiModelError(`${label}模型调用失败：${message}`, fallbackEligible)
}

/** Opt-in graceful degradation when a custom endpoint cannot serve Pi. */
export function piFallbackRuntime(
  env: NodeJS.ProcessEnv = process.env,
): AgentRuntimeId | undefined {
  const value = (env.UOM_PI_FALLBACK || '').trim().toLowerCase()
  if (!value || ['off', 'none', 'false', '0'].includes(value)) return undefined
  if (value === 'direct') return 'direct'
  throw new Error('UOM_PI_FALLBACK 只支持 direct（或留空关闭）。')
}
