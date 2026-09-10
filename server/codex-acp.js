import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import readline from 'node:readline'
import { discussionPrompt, modelingPrompt, modelNarrativePrompt, understandingPrompt, assessmentPrompt, validateDocument, validateModel, parseModelWithMeta, normalizeModel, normalizeUnderstanding, normalizeAssessment, hydrateEvidence, resolveProvider, providerConfig, forgeError } from './modeling.js'

const require = createRequire(import.meta.url)
const ACP_ENTRY = require.resolve('@agentclientprotocol/codex-acp')

export async function analyzeWithProvider(document, currentModel, instruction = '', options = {}) {
  validateDocument(document)
  const { value, notices } = await structuredModelTurn(modelingPrompt(document, currentModel, instruction), options)
  const model = hydrateEvidence(normalizeModel(value), document)
  const validation = validateModel(model, document)
  return { model, validation, notices }
}

export async function understandWithProvider(document, options = {}) {
  validateDocument(document)
  const { value, notices } = await structuredModelTurn(understandingPrompt(document), options)
  const understanding = normalizeUnderstanding(hydrateEvidence(value, document))
  return notices.length ? { understanding, notices } : { understanding }
}

export async function assessWithProvider(document, understanding, model, options = {}) {
  validateDocument(document)
  const { value, notices } = await structuredModelTurn(assessmentPrompt(document, understanding, model), options)
  const assessment = normalizeAssessment(hydrateEvidence(value, document))
  return notices.length ? { assessment, notices } : { assessment }
}

export async function narrateModelWithProvider(model, options = {}) {
  const narrative = await runProviderTurn(modelNarrativePrompt(model), options)
  return { narrative: narrative.trim() }
}

export async function discussWithProvider(document, model, messages, options = {}) {
  validateDocument(document)
  return runProviderTurn(discussionPrompt(document, model, messages), options)
}

export const analyzeWithCodex = analyzeWithProvider
export const understandWithCodex = understandWithProvider
export const assessWithCodex = assessWithProvider
export const narrateModelWithCodex = narrateModelWithProvider
export const discussWithCodex = discussWithProvider

/** Non-secret provider description for the UI. Never includes the API key. */
export function providerStatus(requested) {
  const active = providerConfig(requested)
  const options = ['codex', 'deepseek', 'private'].map((name) => {
    const config = providerConfig(name)
    return { value: config.name, label: config.label, model: config.model, ready: config.ready }
  })
  return { provider: active.name, kind: active.kind, label: active.label, model: active.model, ready: active.ready, options }
}

async function runProviderTurn(prompt, options = {}) {
  const { kind } = resolveProvider(options.provider)
  try {
    return await (kind === 'openai' ? runOpenAICompatibleTurn(prompt, options) : runAcpTurn(prompt, options))
  } catch (error) {
    // 推理过程中的未分类失败一律归为 provider 连接类，UI 才能给出对应指引。
    if (!error.kind) error.kind = 'provider'
    throw error
  }
}

// 结构化阶段必须产出可解析的 JSON。较弱的模型有时先输出一段规划文字或被 max
// tokens 截断的半截 JSON；解析失败时自动追加一轮“只输出 JSON”的修复请求，多数
// 情况无需用户介入即可恢复。只重试一次，避免把失败放大成双倍等待。
const JSON_REPAIR_INSTRUCTION = '你上一次的输出无法解析为 JSON。请重新输出最终结果：只输出一个符合此前要求的 JSON 对象，以 { 开头、以 } 结尾，不要代码围栏、不要解释、不要规划或草稿文字。'

const outputPreview = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160)

function attemptParse(text) {
  try { return parseModelWithMeta(text) } catch { return null }
}

async function structuredModelTurn(prompt, options = {}) {
  const firstRaw = await runProviderTurn(prompt, options)
  const first = attemptParse(firstRaw)
  if (first) return first
  const { kind } = resolveProvider(options.provider)
  // OpenAI 兼容端点用多轮对话修复：带上原始提示与上一次输出，模型只需改写格式，
  // 证据引用不会失真。ACP 每轮都是全新会话，只能带着更强的输出要求完整重跑。
  const retryOptions = kind === 'openai'
    ? { ...options, messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: firstRaw }, { role: 'user', content: JSON_REPAIR_INSTRUCTION }] }
    : options
  const retryPrompt = kind === 'openai' ? prompt : `${prompt}\n\n补充要求（必须遵守）：${JSON_REPAIR_INSTRUCTION}\n你上一次输出的开头是：「${outputPreview(firstRaw)}」`
  const secondRaw = await runProviderTurn(retryPrompt, retryOptions)
  const second = attemptParse(secondRaw)
  if (second) return second
  throw forgeError(`两次输出都无法解析为 JSON。第一次输出开头：「${outputPreview(firstRaw)}」；第二次输出开头：「${outputPreview(secondRaw)}」。请直接重试，或更换更稳定的提供方。`, 'model')
}

/**
 * Streaming chat-completions client for any OpenAI-compatible endpoint: DeepSeek,
 * a self-hosted vLLM/llama.cpp gateway, or any other private model server.
 */
async function runOpenAICompatibleTurn(prompt, options = {}) {
  const config = providerConfig(options.provider)
  if (!config.url || !config.apiKey) throw new Error(`${config.label} 未配置 ${config.vars.url} 或 ${config.vars.key}。`)
  if (!config.model) throw new Error(`${config.label} 未配置 ${config.vars.model}。`)
  const baseUrl = config.url.replace(/\/+$/, '')
  const url = /\/chat\/completions$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`
  const controller = new AbortController()
  const timeoutMs = Number.parseInt(process.env.LLM_API_TIMEOUT_MS || process.env.CODEX_ACP_TIMEOUT_MS || '300000', 10)
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 300000)
  const report = typeof options.onEvent === 'function' ? options.onEvent : () => {}
  // 常规轮是单条 user 消息；JSON 修复轮通过 options.messages 复用同一请求通道。
  const messages = Array.isArray(options.messages) && options.messages.length ? options.messages : [{ role: 'user', content: prompt }]
  // 部分端点（如 DeepSeek）默认输出上限只有几千 token，大模型 JSON 会被截断；
  // 设置 LLM_MAX_OUTPUT_TOKENS 可显式放宽。不默认发送，避免小上下文端点报 400。
  const maxOutputTokens = Number.parseInt(process.env.LLM_MAX_OUTPUT_TOKENS || '', 10)
  let response
  try {
    response = await fetch(url, { method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: config.model, stream: true, messages, ...(Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? { max_tokens: maxOutputTokens } : {}) })
    })
  } catch (error) {
    clearTimeout(timer)
    if (error.name === 'AbortError') throw new Error(`${config.label} 请求超时（超过 ${Math.round(timeoutMs / 60000)} 分钟）`)
    throw new Error(`${config.label} 请求失败：${error.message}（${url}）`)
  }
  if (!response.ok) throw new Error(`${config.label} 返回 HTTP ${response.status}：${(await response.text()).slice(0, 800)}`)
  if (!response.body) { clearTimeout(timer); throw new Error(`${config.label} 没有返回流式响应。`) }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let responseText = ''
  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      let chunk
      try { chunk = JSON.parse(data) } catch { continue }
      const delta = chunk.choices?.[0]?.delta || {}
      const reasoning = delta.reasoning_content || ''
      const text = delta.content || ''
      // Reasoning models (DeepSeek R1-style, Qwen thinking mode, ...) emit a long
      // reasoning stream before the final answer.
      // Forward it as progress so the UI does not appear stuck, while only
      // accumulating answer content for the structured JSON parser.
      if (reasoning) report({ type: 'delta', text: reasoning, size: responseText.length + reasoning.length, reasoning: true })
      if (text) { responseText += text; report({ type: 'delta', text, size: responseText.length }) }
    }
    if (done) break
  }
  clearTimeout(timer)
  return responseText
}

function send(child, id, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
}

async function runAcpTurn(prompt, options = {}) {
  const report = typeof options.onEvent === 'function' ? options.onEvent : () => {}
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'uom-forge-acp-'))
  const configuredCodex = (() => {
    try { return JSON.parse(process.env.CODEX_CONFIG || '{}') } catch { return {} }
  })()
  const child = spawn(process.execPath, [ACP_ENTRY], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    env: {
      ...process.env,
      NO_BROWSER: '1',
      INITIAL_AGENT_MODE: 'read-only',
      CODEX_CONFIG: JSON.stringify({ model_reasoning_effort: process.env.CODEX_REASONING_EFFORT || 'medium', ...configuredCodex }),
    },
  })
  const output = readline.createInterface({ input: child.stdout })
  let responseText = ''
  let failure
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const configuredTimeout = Number.parseInt(process.env.CODEX_ACP_TIMEOUT_MS || '300000', 10)
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 300000
  const timer = setTimeout(() => { failure = new Error(`Codex ACP 分析超时（超过 ${Math.round(timeoutMs / 60000)} 分钟）`); resolveDone() }, timeoutMs)
  let stderrText = ''
  child.stderr.on('data', (chunk) => { stderrText += String(chunk).slice(-4000) })
  const heartbeat = setInterval(() => report({ type: 'phase', text: 'Codex 正在推理模型结构，仍在处理文档证据。' }), 10000)
  output.on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.error) {
      failure = new Error(message.error.message || 'ACP 请求失败')
      resolveDone()
      return
    }
    if (message.id === 1 && message.result) {
      report({ type: 'phase', text: 'ACP 已连接，正在创建 Codex 会话。' })
      send(child, 2, 'session/new', { cwd, mcpServers: [] })
    } else if (message.id === 2 && message.result) {
      report({ type: 'phase', text: 'Codex 会话已创建，开始分析证据块。' })
      send(child, 3, 'session/prompt', { sessionId: message.result.sessionId, prompt: [{ type: 'text', text: prompt }] })
    }
    else if (message.method === 'session/update') {
      const update = message.params?.update
      if (update?.sessionUpdate === 'agent_message_chunk') {
        const chunk = update.content?.text || ''
        responseText += chunk
        report({ type: 'delta', text: chunk, size: responseText.length })
      }
    } else if (message.id === 3) {
      report({ type: 'phase', text: 'Codex 输出已完成，正在校验模型和证据引用。' })
      if (message.result?.stopReason !== 'end_turn' && !failure) failure = new Error(`Codex ACP 未正常结束（${message.result?.stopReason || 'unknown'}）`)
      resolveDone()
    }
  })
  child.on('error', (error) => { failure = error; resolveDone() })
  child.on('exit', (code) => { if (!responseText && !failure) failure = new Error(`Codex ACP 进程退出（${code}）`); resolveDone() })
  send(child, 1, 'initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'uom-forge', version: '0.1.0' } })
  await done
  clearTimeout(timer)
  clearInterval(heartbeat)
  output.close()
  child.stdin.destroy()
  if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
  await rm(cwd, { recursive: true, force: true })
  if (failure) {
    if (stderrText.trim()) failure.message += `：${stderrText.trim().slice(-1000)}`
    throw failure
  }
  return responseText
}
