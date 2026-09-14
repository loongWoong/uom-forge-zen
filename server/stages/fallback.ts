import type { StagePart } from '../../shared/analysis.ts'
import { PiModelError, piFallbackRuntime } from '../agents/runtime.ts'
import type { StageOptions } from './contracts.ts'

/**
 * A Pi run needs a model endpoint that can stream OpenAI-style tool calls. When
 * a custom endpoint rejects that request shape, the merged runtime could only
 * report "Pi Agent 未提交…" and the stage failed for good.
 *
 * UOM_PI_FALLBACK=direct retries the stage with the direct client, but only
 * when the failure happened before any tool ran, so a partially executed loop
 * is never silently restarted and provider errors are never hidden by default.
 */
export async function withPiFallback<T>(
  options: StageOptions,
  part: StagePart,
  pi: () => Promise<T>,
  direct: () => Promise<T>,
): Promise<T> {
  try {
    return await pi()
  } catch (error) {
    if (!(error instanceof PiModelError) || !error.fallbackEligible)
      throw error
    if (piFallbackRuntime() !== 'direct') throw error
    options.onEvent?.({
      type: 'phase',
      part,
      text: `Pi Agent 调用失败，已降级为直接调用：${error.message}`,
    })
    return direct()
  }
}
