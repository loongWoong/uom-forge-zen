// 用浏览器同款路径测量：mammoth → documentToHtml → documentToBlocks → validateDocument 口径
import mammoth from 'mammoth'
import { understandingPrompt, modelingPrompt } from './server/modeling.js'
import fs from 'node:fs'

const path = 'F:/duanyi/dome-ontology/日志分析平台/交易日志监测和分析系统方案设计V2.1 (1).docx'
const { value: html } = await mammoth.convertToHtml({ path })

// 复刻 documentToBlocks：按顶层元素切块，取 textContent 并折叠空白
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
    // 找到该顶层元素的匹配结束标签
    const re = new RegExp(`<\\s*${name}(\\s[^>]*)?>|<\\s*/\\s*${name}\\s*>`, 'gi')
    re.lastIndex = open
    let depth = 0, end = src.length, m
    while ((m = re.exec(src))) {
      if (m[0].includes('</')) { depth--; if (depth === 0) { end = re.lastIndex; break } }
      else depth++
      if (m.index === open && src[close + 1] === '/' ) break
    }
    const inner = src.slice(open, end)
    const text = inner.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()
    if (text) blocks.push({ id: `block-${blocks.length + 1}`, type: name.toLowerCase(), text })
    i = Math.max(end, close + 1)
  }
  return blocks
}

const blocks = topBlocks(html)
const total = blocks.reduce((n, b) => n + b.text.length, 0)
const document = { name: '交易日志监测和分析系统方案设计V2.1 (1).docx', blocks }

const up = understandingPrompt(document)
const mp = modelingPrompt(document, null, '')
const cjk = (up.match(/[\u4e00-\u9fff]/g) || []).length

console.log('块数            :', blocks.length)
console.log('正文字符(校验口径):', total, ' · 12万上限占比:', (total / 120000 * 100).toFixed(0) + '%')
console.log('最长块          :', Math.max(...blocks.map((b) => b.text.length)), '字符')
console.log('understand 提示词:', up.length, '字符（文档 JSON 开销 +' + (up.length - total) + '）')
console.log('model 提示词      :', mp.length, '字符')
console.log('中文占比          :', (cjk / up.length * 100).toFixed(0) + '%')
console.log('估算 prompt tokens: 保守(1.0/字)=' + up.length.toLocaleString() + ' · 中文为主(0.9)=' + Math.round(up.length * 0.9).toLocaleString())
console.log('模型上下文        : 262,144（/v1/models 报告）→ 余量给输出:', (262144 - up.length * 0.9).toFixed(0), 'tokens')
