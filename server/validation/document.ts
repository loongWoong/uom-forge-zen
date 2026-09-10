import type { BusinessDocument } from '../../shared/analysis.ts'
import { isRecord } from './values.ts'

export const DEFAULT_MAX_DOCUMENT_CHARS = 120000

/**
 * 本轮允许的正文字符上限。默认 12 万；推理模型上下文更大时可用 UOM_MAX_DOC_CHARS
 * 调高。上限始终存在且从不截断：超限必须显式拒绝，否则被剪掉的正文会让证据面板说谎。
 */
export function maxDocumentChars(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.UOM_MAX_DOC_CHARS || '', 10)
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_DOCUMENT_CHARS
}

export function validateDocument(
  value: unknown,
): asserts value is BusinessDocument {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    !Array.isArray(value.blocks) ||
    !value.blocks.length
  )
    throw new Error('请先上传包含正文的文档。')
  const ids = new Set<string>()
  let length = 0
  for (const block of value.blocks) {
    if (
      !isRecord(block) ||
      typeof block.id !== 'string' ||
      !block.id ||
      typeof block.text !== 'string' ||
      !block.text.trim() ||
      ids.has(block.id)
    )
      throw new Error('文档证据块无效或重复，请重新导入。')
    ids.add(block.id)
    length += block.text.length
  }
  const limit = maxDocumentChars()
  if (length > limit)
    throw new Error(
      `文档正文 ${length.toLocaleString('zh-CN')} 字符，超出本轮上限 ${limit.toLocaleString('zh-CN')} 字符。可按章节拆分后分批导入，或调高服务端环境变量 UOM_MAX_DOC_CHARS（需确保推理模型上下文容得下整篇文档加输出）。不会截断正文。`,
    )
}

export function requireText(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`请先提供${label}。`)
  if (value.length > 120000)
    throw new Error(`${label}超过 12 万个字符，请先拆分范围。不会截断输入。`)
}
