import { isRecord } from '../validation/values.ts'

/**
 * Overlay view of the document size limit.
 *
 * Upstream hard-codes a 120000-character cap and a fixed message inside
 * `server/validation/document.ts`. The overlay re-checks the limit *before*
 * delegating to upstream so the message explains the configured limit and how
 * to raise it. Values above upstream's own cap cannot help (upstream still
 * rejects them); the check is therefore an honest, stricter-or-equal gate and
 * never truncates.
 */
export const DEFAULT_MAX_DOCUMENT_CHARS = 120000

/**
 * 本轮允许的正文字符上限。默认 12 万；推理模型上下文更大时可用 UOM_MAX_DOC_CHARS
 * 调高（但受上游 12 万硬上限约束）。上限始终存在且从不截断：超限必须显式拒绝，
 * 否则被剪掉的正文会让证据面板说谎。
 */
export function maxDocumentChars(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.UOM_MAX_DOC_CHARS || '', 10)
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_DOCUMENT_CHARS
}

/** Total characters across all document blocks; ignores malformed input. */
export function documentChars(value: unknown): number {
  if (!isRecord(value) || !Array.isArray(value.blocks)) return 0
  let length = 0
  for (const block of value.blocks)
    if (isRecord(block) && typeof block.text === 'string')
      length += block.text.length
  return length
}

/**
 * Returns a user-facing error when the request document exceeds the configured
 * limit, or `undefined` when the request can be delegated to upstream.
 */
export function documentLimitError(
  body: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!isRecord(body) || body.document === undefined) return undefined
  const length = documentChars(body.document)
  const limit = maxDocumentChars(env)
  if (length <= limit) return undefined
  return `文档正文 ${length.toLocaleString('zh-CN')} 字符，超出本轮上限 ${limit.toLocaleString('zh-CN')} 字符。可按章节拆分后分批导入，或调高服务端环境变量 UOM_MAX_DOC_CHARS（需确保推理模型上下文容得下整篇文档加输出）。不会截断正文。`
}
