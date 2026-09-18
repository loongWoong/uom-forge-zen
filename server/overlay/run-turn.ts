import type { RunTurn } from '../providers/types.ts'
import { runProviderTurn } from '../providers/index.ts'
import type { ProviderEvent, StagePart } from '../../shared/analysis.ts'
import { currentContext } from './context.ts'
import { repairJsonText } from './json-recovery.ts'

const STAGE_LABELS: Partial<Record<StagePart, string>> = {
  reading: '业务理解结果',
  semantic: '语义建模结果',
  compile: '模型整理结果',
  expression: '模型自述结果',
  repair: '模型修复结果',
  recheck: '模型复查结果',
}

/**
 * Upstream calls the injected RunTurn for every direct-runtime generation.
 * The overlay wraps it to repair structured output before upstream parses it.
 * The stage part is only visible on the events that upstream's `scopedTurn`
 * forwards, so we observe them to label the recovery notice.
 */
export function createOverlayRunTurn(base: RunTurn = runProviderTurn): RunTurn {
  return async (prompt, options = {}) => {
    const context = currentContext()
    let part: StagePart | undefined
    const onEvent = options.onEvent
    const wrapped = onEvent
      ? {
          ...options,
          onEvent: (event: ProviderEvent) => {
            const scoped = event as ProviderEvent & { part?: StagePart }
            if (scoped.part) part = scoped.part
            onEvent(event)
          },
        }
      : options
    const text = await base(prompt, wrapped)
    if (options.outputFormat !== 'json') return text
    const label = (part && STAGE_LABELS[part]) || '模型输出'
    const repaired = repairJsonText(text, label)
    if (repaired.notices.length) context?.notices.push(...repaired.notices)
    return repaired.text
  }
}
