/**
 * Structured-output recovery, kept entirely in the overlay.
 *
 * Upstream parses model output with a strict `JSON.parse` (plus one repair
 * round through the Pi JSON agent when the runtime is Pi). Real providers
 * often wrap the JSON in planning prose or truncate it at max tokens, which
 * upstream then reports as "不是有效的 JSON" on the direct runtime.
 *
 * The overlay repairs the text *before* upstream validates it, by decorating
 * the injected `RunTurn`, so no upstream file needs to change. Whenever a
 * repair happened the caller should surface a notice: a silently repaired
 * result must never pass as a complete one.
 */

const previewOf = (text: string, limit = 120): string =>
  text.replace(/\s+/g, ' ').trim().slice(0, limit)

const tryParse = (
  candidate: string,
): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(candidate) as unknown }
  } catch {
    return { ok: false }
  }
}

/**
 * 从 start（一个“{”位置）开始做配平扫描并跳过字符串字面量；
 * 扫描回到深度 0 时返回该完整对象，未闭合（输出被截断）返回 null。
 */
function balancedFrom(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (!depth) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 修复从 start 开始的被截断 JSON：闭合未结束的字符串、去掉悬空的逗号/冒号/键名，
 * 再按相反顺序补齐括号。尽力而为：修复结果仍非法时由调用方兜底。
 */
function repairFrom(text: string, start: number): string | null {
  const body = text.slice(start)
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const char of body) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') stack.push(char)
    else if (char === '}' || char === ']') stack.pop()
  }
  if (!inString && !stack.length) return null
  let repaired = body
  if (inString) {
    repaired = repaired.replace(/\\u[0-9a-fA-F]{0,3}$/, '') // 不完整的 \u 转义
    repaired = repaired.replace(/\\+$/, (tail) =>
      tail.length % 2 ? tail.slice(0, -1) : tail,
    ) // 孤立反斜杠
    repaired += '"'
  }
  for (let i = 0; i < 4; i++) {
    repaired = repaired.replace(/[\s,]+$/, '')
    if (repaired.endsWith(':'))
      repaired = repaired.replace(/"[^"]*"\s*:$/, '').replace(/[\s,]+$/, '')
  }
  // 截断发生在对象键名之后时补一个占位值；数组里的未完成字符串元素直接闭合即可
  if (stack[stack.length - 1] === '{' && /[{,]\s*"[^"]*"$/.test(repaired))
    repaired += ':null'
  const closer = (char: string) => (char === '{' ? '}' : ']')
  return repaired + [...stack].reverse().map(closer).join('')
}

export interface Recovery {
  value: unknown
  notices: string[]
}

interface Candidate extends Recovery {
  length: number
  kind: 'extract' | 'repair'
  cleaned: boolean
}

/**
 * 解析提供方输出的结构化 JSON，带自动恢复。真实模型常在 JSON 前后输出规划文字
 * 或被 max tokens 截断成半截 JSON：这里依次尝试直接解析、逐个“{”位置配平提取、
 * 截断修复，并在所有可解析候选中取最长者（截断根对象的修复结果必然大于它内部的
 * 完整片段，不会被内部片段冒充）。notices 记录自动恢复动作，调用方应把它呈现给
 * 用户，避免“修复出来的结果”被当成完整结果静默展示。
 */
export function parseJsonOutputWithMeta(
  text: string,
  label = '分析结果',
): Recovery {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const direct = tryParse(cleaned)
  if (direct.ok) return { value: direct.value, notices: [] }
  const candidates: Candidate[] = []
  const consider = (
    candidate: string | null,
    kind: 'extract' | 'repair',
  ): void => {
    if (!candidate) return
    const exact = tryParse(candidate)
    if (exact.ok) {
      candidates.push({
        value: exact.value,
        notices: [],
        length: candidate.length,
        kind,
        cleaned: false,
      })
      return
    }
    const loosened = tryParse(candidate.replace(/,\s*([}\]])/g, '$1'))
    if (loosened.ok)
      candidates.push({
        value: loosened.value,
        notices: [],
        length: candidate.length,
        kind,
        cleaned: true,
      })
  }
  for (
    let start = cleaned.indexOf('{');
    start !== -1;
    start = cleaned.indexOf('{', start + 1)
  ) {
    consider(balancedFrom(cleaned, start), 'extract')
    consider(repairFrom(cleaned, start), 'repair')
  }
  if (!candidates.length)
    throw new Error(
      `${label}不是有效的 JSON：输出开头是「${previewOf(text)}」，结尾是「${previewOf(text.slice(-240))}」。常见原因：提供方输出了规划文字而非 JSON，或输出被 max tokens 截断。可重试，或更换更稳定的提供方。`,
    )
  const best = candidates.reduce((left, right) =>
    right.length > left.length ? right : left,
  )
  const notices =
    best.kind === 'repair'
      ? [
          `${label}输出不完整（疑似被截断），服务端已自动修复为可解析的 JSON；结果可能不完整，请重点核对。`,
        ]
      : best.cleaned
        ? [`${label}的 JSON 存在非法尾逗号等问题，服务端已自动修复。`]
        : [
            `${label}在 JSON 之外输出了额外文字，服务端已自动提取其中的 JSON 对象。`,
          ]
  return { value: best.value, notices }
}

/**
 * Upstream 的解析器接收字符串。恢复成功后重新序列化为标准 JSON，让上游的
 * `parseJsonOutput`/`validateCompiledModel` 原样通过；未恢复时返回原文。
 */
export function repairJsonText(
  text: string,
  label = '分析结果',
): { text: string; notices: string[] } {
  const { value, notices } = parseJsonOutputWithMeta(text, label)
  if (!notices.length) return { text, notices }
  return { text: JSON.stringify(value), notices }
}
