import {
  validateCompiledModel,
  validateCompiledModelWithMeta,
} from '../validation/compiled-model.ts'
import { requireText } from '../validation/document.ts'
import { semanticModelPrompt, compileModelPrompt } from './prompts.ts'
import type { ModelingInput, ModelingResult } from '../../shared/analysis.ts'
import type { RunTurn } from '../providers/types.ts'
import { scopedTurn, type StageOptions } from './contracts.ts'
import { checkAndRepair } from './expression.ts'
import {
  modelingContent,
  reviewModelClarifications,
  type ClarificationReview,
} from '../../shared/clarifications.ts'
import { runPiModeling } from '../agents/pi-modeling.ts'
import { checkOrRepairCompiledJson } from '../agents/pi-compile.ts'
import { withPiFallback } from './fallback.ts'

export async function buildModel(
  input: ModelingInput,
  runTurn: RunTurn,
  options: StageOptions = {},
): Promise<ModelingResult> {
  requireText(input.narrative, '业务说明')
  const report = options.onEvent || (() => {})
  options.signal?.throwIfAborted()
  report({
    type: 'phase',
    part: 'semantic',
    text: '第二阶段 A：形成建模说明。',
  })
  const usePi = options.runtime === 'pi' || (options.runtime === undefined && process.env.UOM_AGENT_RUNTIME === 'pi')
  const direct = () =>
    runTurn(semanticModelPrompt(input), scopedTurn(options, 'semantic'))
  const semanticPlan = usePi
    ? await withPiFallback(
        options,
        'semantic',
        () => runPiModeling(input, runTurn, options),
        direct,
      )
    : await direct()
  options.signal?.throwIfAborted()
  if (!semanticPlan.trim()) throw new Error('未返回建模说明。')
  const review = reviewModelClarifications(semanticPlan, input.narrative)
  // Publish before compilation so errors or cancellation cannot erase it.
  report({ type: 'model-plan', part: 'semantic', semanticPlan, ...review })
  options.signal?.throwIfAborted()
  const compiled = await compileReviewedPlan(
    semanticPlan,
    review,
    runTurn,
    options,
  )
  return checkAndRepair(compiled, input.narrative, runTurn, options)
}

// Retry B with plan-only inference; the subsequent check needs current understanding.
export async function compileModel(
  semanticPlan: string,
  narrative: string,
  runTurn: RunTurn,
  options: StageOptions = {},
): Promise<ModelingResult> {
  if (typeof semanticPlan !== 'string' || !semanticPlan.trim())
    throw new Error('请先完成建模说明。')
  requireText(narrative, '业务说明')
  const compiled = await compileReviewedPlan(
    semanticPlan,
    reviewModelClarifications(semanticPlan, narrative),
    runTurn,
    options,
  )
  return checkAndRepair(compiled, narrative, runTurn, options)
}

async function compileReviewedPlan(
  semanticPlan: string,
  review: ClarificationReview,
  runTurn: RunTurn,
  options: StageOptions,
): Promise<Omit<ModelingResult, 'expressionReview'>> {
  if (semanticPlan.length > 120000)
    throw new Error('建模说明超过 12 万个字符，请先缩小建模范围。')
  if (!modelingContent(semanticPlan).trim())
    throw new Error('建模说明只有澄清问题，没有可整理的模型内容。')
  options.signal?.throwIfAborted()
  const report = options.onEvent || (() => {})
  report({ type: 'phase', part: 'compile', text: '正在整理候选模型。' })
  try {
    let raw = await runTurn(
      compileModelPrompt(semanticPlan),
      scopedTurn(options, 'compile'),
    )
    options.signal?.throwIfAborted()
    const validate = (json: string) => {
      try {
        validateCompiledModel(json)
        return { valid: true as const }
      } catch (error) {
        return {
          valid: false as const,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
    const initialValidation = validate(raw)
    const usePi =
      options.runtime === 'pi' ||
      (options.runtime === undefined &&
        process.env.UOM_AGENT_RUNTIME === 'pi')
    if (!initialValidation.valid && usePi) {
      raw = await checkOrRepairCompiledJson(
        raw,
        options.provider || 'gpt',
        initialValidation.error,
        validate,
        options,
      )
      options.signal?.throwIfAborted()
    }
    // JSON 恢复（提取/截断修复）发生时明确告知用户，不把修复结果当完整结果展示。
    const { model, notices } = validateCompiledModelWithMeta(raw)
    const elements =
      model.objects.length +
      model.relations.length +
      model.actions.length +
      model.functions.length +
      model.rules.length +
      model.activities.length
    return {
      semanticPlan,
      clarifications: review.clarifications,
      model,
      provenance: { basis: 'business-understanding', evidence: 'unlinked' },
      validation: {
        elements,
        warnings: [...notices, ...review.warnings, '基于业务说明建模，尚未关联原文证据。'],
      },
    }
  } catch (error) {
    options.signal?.throwIfAborted()
    throw new Error(
      `模型整理失败，建模说明已保留：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}
