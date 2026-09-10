// 结构化阶段与提供方之间的 JSON 恢复链路端到端测试：
// 用本地假 SSE 端点模拟“输出规划文字 / 截断 JSON”的私有模型，验证
// 提取、截断修复与自动修复轮都能把建模请求救回来。
import http from 'node:http'
import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeWithProvider } from './codex-acp.js'

const document = { name: 'test.md', blocks: [{ id: 'b1', text: '主体完成操作并产生结果' }] }

const VALID_MODEL = JSON.stringify({
  schemaVersion: '1', name: '测试领域', summary: '测试摘要',
  objects: [{ id: '主体', name: '主体', description: '执行者', properties: [], evidence: [{ blockId: 'b1', quote: '主体完成操作并产生结果' }] }],
  relations: [], actions: [], functions: [], rules: [], activities: [], questions: [],
})

/** 假 OpenAI 兼容 SSE 端点：按请求次序回放 responses，并记录收到的请求体。 */
function startFakeProvider(responses) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push(JSON.parse(body))
      const payload = responses[Math.min(requests.length - 1, responses.length - 1)] || ''
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (let i = 0; i < payload.length; i += 40) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: payload.slice(i, i + 40) } }] })}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })))
}

const ENV_KEYS = ['PRIVATE_LLM_API_URL', 'PRIVATE_LLM_API_KEY', 'PRIVATE_LLM_MODEL', 'LLM_MAX_OUTPUT_TOKENS']

async function withFakeProvider(responses, run) {
  const { server, requests, port } = await startFakeProvider(responses)
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  process.env.PRIVATE_LLM_API_URL = `http://127.0.0.1:${port}/v1`
  process.env.PRIVATE_LLM_API_KEY = 'sk-test'
  process.env.PRIVATE_LLM_MODEL = 'test-model'
  delete process.env.LLM_MAX_OUTPUT_TOKENS
  try {
    return await run(requests)
  } finally {
    server.close()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('a non-JSON first output triggers exactly one multi-turn repair request', async () => {
  await withFakeProvider(['Facts: need material explicit. 无 JSON。', VALID_MODEL], async (requests) => {
    const { model, notices } = await analyzeWithProvider(document, null, '', { provider: 'private' })
    assert.equal(requests.length, 2, '解析失败后应自动追加一轮修复请求')
    assert.equal(model.objects[0].id, '主体')
    assert.deepEqual(notices, [], '修复轮输出的是干净 JSON，不应有恢复提示')
    // 修复轮必须带上原始提示与上一次输出，模型才能保住证据引用
    assert.equal(requests[1].messages.length, 3)
    assert.equal(requests[1].messages[0].role, 'user')
    assert.equal(requests[1].messages[1].role, 'assistant')
    assert.equal(requests[1].messages[1].content, 'Facts: need material explicit. 无 JSON。')
    assert.match(requests[1].messages[2].content, /只输出一个符合此前要求的 JSON 对象/)
    // 未设置 LLM_MAX_OUTPUT_TOKENS 时不得发送 max_tokens，避免小上下文端点报 400
    assert.equal(requests[0].max_tokens, undefined)
  })
})

test('JSON embedded in planning prose is extracted without a retry', async () => {
  await withFakeProvider([`我先规划一下：\n${VALID_MODEL}\n以上。`], async (requests) => {
    const { model, notices } = await analyzeWithProvider(document, null, '', { provider: 'private' })
    assert.equal(requests.length, 1)
    assert.equal(model.objects[0].id, '主体')
    assert.ok(notices.some((notice) => notice.includes('提取')))
  })
})

test('a truncated JSON output is repaired and flagged', async () => {
  await withFakeProvider([VALID_MODEL.slice(0, -2) + '"待确'], async (requests) => {
    const { model, notices } = await analyzeWithProvider(document, null, '', { provider: 'private' })
    assert.equal(requests.length, 1)
    assert.equal(model.objects[0].id, '主体')
    assert.deepEqual(model.questions, ['待确'])
    assert.ok(notices.some((notice) => notice.includes('截断')))
  })
})

test('LLM_MAX_OUTPUT_TOKENS is forwarded as max_tokens when configured', async () => {
  await withFakeProvider([VALID_MODEL], async (requests) => {
    process.env.LLM_MAX_OUTPUT_TOKENS = '8192'
    const { model } = await analyzeWithProvider(document, null, '', { provider: 'private' })
    assert.equal(model.objects[0].id, '主体')
    assert.equal(requests[0].max_tokens, 8192)
  })
})
