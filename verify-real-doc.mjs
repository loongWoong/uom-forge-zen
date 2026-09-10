// 真实文档验证。用法：node verify-real-doc.mjs <gate|run> <BASE_URL>
//   gate —— 服务端上限为 120000 时，121,307 字符的文档必须被拒且给出可操作文案
//   run  —— 服务端上限为 140000（.env）时，同一文档应通过闸门并跑完 understand 阶段
import mammoth from 'mammoth'
import { understandingPrompt } from './server/modeling.js'

const MODE = process.argv[2] || 'gate'
const BASE = process.argv[3] || 'http://127.0.0.1:5199'
const DOCX = 'F:/duanyi/dome-ontology/日志分析平台/交易日志监测和分析系统方案设计V2.1 (1).docx'

function topBlocks(src) {
  const blocks = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('<', i)
    if (open === -1) break
    const close = src.indexOf('>', open)
    const tag = /^<\s*\/?\s*([a-zA-Z][\w-]*)/.exec(src.slice(open, close + 1))
    if (!tag) { i = close + 1; continue }
    const name = tag[1]
    if (src[open + 1] === '/') { i = close + 1; continue }
    const re = new RegExp(`<\\s*${name}(\\s[^>]*)?>|<\\s*/\\s*${name}\\s*>`, 'gi')
    re.lastIndex = open
    let depth = 0, end = src.length, m
    while ((m = re.exec(src))) {
      if (m[0].includes('</')) { depth--; if (depth === 0) { end = re.lastIndex; break } }
      else depth++
    }
    const text = src.slice(open, end).replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()
    if (text) blocks.push({ id: `block-${blocks.length + 1}`, type: name.toLowerCase(), text })
    i = Math.max(end, close + 1)
  }
  return blocks
}

const { value: html } = await mammoth.convertToHtml({ path: DOCX })
const blocks = topBlocks(html)
const chars = blocks.reduce((n, b) => n + b.text.length, 0)
const document = { name: '交易日志监测和分析系统方案设计V2.1 (1).docx', blocks }
console.log('[%s] 真实文档：块 %d · 正文 %s 字符 · 提示词 %s 字符',
  MODE, blocks.length, chars.toLocaleString(), understandingPrompt(document).length.toLocaleString())

const started = Date.now()
const response = await fetch(BASE + '/api/analyze/stream', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ stage: 'understand', provider: 'private', document }),
})
const events = []
const reader = response.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
while (true) {
  const { value, done } = await reader.read()
  buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
  const parts = buffer.split(/\n\n/)
  buffer = parts.pop() || ''
  for (const part of parts) for (const line of part.split('\n')) {
    if (!line.startsWith('data:')) continue
    try { events.push(JSON.parse(line.slice(5).trim())) } catch { /* 半包 */ }
  }
  if (done) break
}
const seconds = ((Date.now() - started) / 1000).toFixed(1)
const error = events.find((e) => e.type === 'error')
const result = events.find((e) => e.type === 'result')
console.log('HTTP %s · %ss · phase %d · delta %d · %s', response.status, seconds,
  events.filter((e) => e.type === 'phase').length, events.filter((e) => e.type === 'delta').length,
  error ? 'error' : result ? 'result' : '无结果')
for (const e of events.filter((x) => x.type === 'phase')) console.log('  phase:', e.text)

if (error) {
  console.log('  kind =', error.kind)
  console.log('  文案 =', error.error)
} else if (result) {
  const u = result.result.understanding
  const items = [...(u.concepts || []), ...(u.processes || [])]
  console.log('  summary:', (u.summary || '').slice(0, 180))
  console.log('  目标 %d · 概念 %d · 过程 %d · 事实 %d · 规则 %d · 待确认 %d',
    u.goals.length, u.concepts.length, u.processes.length, u.facts.length, u.rules.length, u.questions.length)
  console.log('  带逐字引文条目: %d/%d', items.filter((x) => x.evidence?.length).length, items.length)
  console.log('  样例引文:', JSON.stringify(items[0]?.evidence?.[0] || {}).slice(0, 200))
  console.log('  概念样例:', items.slice(0, 6).map((x) => x.name).join(' / '))
  console.log('  待确认问题样例:', (u.questions || []).slice(0, 2).join(' | ').slice(0, 200))
}
