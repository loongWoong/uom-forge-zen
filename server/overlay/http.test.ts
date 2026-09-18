import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { once } from 'node:events'
import type { AnalysisEvent } from '../../shared/analysis.ts'
import type { RunTurn } from '../providers/types.ts'
import { currentContext } from './context.ts'
import { createOverlayApiMiddleware } from './http.ts'

async function serve(runTurn?: RunTurn) {
  const middleware = createOverlayApiMiddleware(runTurn)
  const server = createServer((request, response) => {
    void middleware(request, response, (error) => {
      if (error) {
        response.statusCode = 500
        response.end(String(error))
        return
      }
      response.statusCode = 404
      response.end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}

const post = (url: string, value: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  })

const events = (text: string): AnalysisEvent[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as AnalysisEvent)

async function mockEndpoint(
  reply: (body: Record<string, unknown>, response: ServerResponse) => void,
) {
  const bodies: Record<string, unknown>[] = []
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      let raw = ''
      request.on('data', (chunk) => (raw += chunk))
      request.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        bodies.push(body)
        reply(body, response)
      })
    },
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    bodies,
    close: () => close(server),
    url: `http://127.0.0.1:${address.port}/v1`,
  }
}

function streamOk(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(
    `data: ${JSON.stringify({ id: '1', choices: [{ index: 0, delta: { content: '## 业务概述\n说明。' } }] })}\n\n`,
  )
  response.write(
    `data: ${JSON.stringify({ id: '1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
  )
  response.write('data: [DONE]\n\n')
  response.end()
}

const ENV_KEYS = [
  'UOM_LLM_PROVIDER',
  'UOM_AGENT_RUNTIME',
  'LLM_API_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_MAX_OUTPUT_TOKENS',
  'GPT_API_URL',
  'GPT_API_KEY',
  'GPT_MODEL',
  'QWEN_API_URL',
  'QWEN_API_KEY',
  'QWEN_MODEL',
  'UOM_MAX_DOC_CHARS',
  'UOM_PI_COMPAT',
] as const

function snapshotEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {}
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  return saved
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

test('/api/config reports the effective provider and model without secrets', async () => {
  const { server, url } = await serve(async () => '')
  const saved = snapshotEnv()
  try {
    process.env.UOM_LLM_PROVIDER = 'deepseek'
    process.env.UOM_AGENT_RUNTIME = 'pi'
    process.env.LLM_MODEL = 'qwen3.8-flash'
    process.env.LLM_API_URL = 'http://test.invalid/v1'
    process.env.LLM_API_KEY = 'k'
    process.env.GPT_API_URL = 'http://test.invalid/v1'
    process.env.GPT_API_KEY = 'k'
    process.env.GPT_MODEL = 'gpt-6-astra'
    delete process.env.QWEN_API_URL
    delete process.env.QWEN_API_KEY
    delete process.env.QWEN_MODEL
    const response = await fetch(url + '/api/config')
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      provider: string
      model: string
      runtime?: string
      options: { value: string; model: string; ready: boolean }[]
    }
    assert.equal(body.provider, 'deepseek')
    assert.equal(body.runtime, 'pi')
    assert.equal(body.model, 'qwen3.8-flash')
    assert.deepEqual(body.options, [
      { value: 'deepseek', model: 'qwen3.8-flash', ready: true },
      { value: 'gpt', model: 'gpt-6-astra', ready: true },
      { value: 'qwen', model: 'Qwen3.6', ready: false },
    ])
    assert.equal((await fetch(url + '/api/config', { method: 'POST' })).status, 405)
    // 密钥绝不进入浏览器可见的响应
    assert.doesNotMatch(JSON.stringify(body), /"k"/)
  } finally {
    restoreEnv(saved)
    await close(server)
  }
})

test('/api/models reads the selected provider endpoint and reports failures', async () => {
  const endpoint = await mockEndpoint((_body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'm1' }, { id: 'm2' }, { id: 'm1' }] }))
  })
  const { server, url } = await serve(async () => '')
  const saved = snapshotEnv()
  try {
    process.env.LLM_API_URL = endpoint.url
    process.env.LLM_API_KEY = 'sk-test'
    const ok = await fetch(url + '/api/models?provider=deepseek')
    assert.equal(ok.status, 200)
    assert.deepEqual((await ok.json()) as unknown, { models: ['m1', 'm2'] })

    const unknown = await fetch(url + '/api/models?provider=nope')
    assert.equal(unknown.status, 400)

    process.env.LLM_API_URL = 'http://127.0.0.1:9/v1'
    const failed = await fetch(url + '/api/models')
    assert.equal(failed.status, 502)
    assert.ok(((await failed.json()) as { error?: string }).error)
  } finally {
    restoreEnv(saved)
    await close(server)
    await endpoint.close()
  }
})

test('modelOverride reaches the provider body through the fetch decorator', async () => {
  const endpoint = await mockEndpoint((_body, response) => streamOk(response))
  const saved = snapshotEnv()
  const { server, url } = await serve()
  try {
    process.env.LLM_API_URL = endpoint.url
    process.env.LLM_API_KEY = 'sk-test'
    process.env.LLM_MODEL = 'configured-model'
    const response = await post(url + '/api/analyze/stream', {
      stage: 'understand',
      provider: 'deepseek',
      runtime: 'direct',
      modelOverride: 'override-model',
      document: { name: 'doc', blocks: [{ id: '1', text: 'text' }] },
    })
    const output = events(await response.text())
    assert.equal(output.at(-1)?.type, 'result')
    const body = endpoint.bodies[0]
    assert.equal(body.model, 'override-model')
    assert.equal(body.max_tokens, 16384)
    assert.deepEqual(body.thinking, { type: 'disabled' })
  } finally {
    restoreEnv(saved)
    await close(server)
    await endpoint.close()
  }
})

test('invalid modelOverride is rejected before any provider call', async () => {
  let called = 0
  const { server, url } = await serve(async () => {
    called++
    return ''
  })
  try {
    const response = await post(url + '/api/analyze/stream', {
      stage: 'understand',
      provider: 'deepseek',
      modelOverride: 42,
      document: { name: 'doc', blocks: [{ id: '1', text: 'text' }] },
    })
    // SSE 路径的校验错误以 error 事件返回，HTTP 仍为 200
    assert.equal(response.status, 200)
    const output = events(await response.text())
    assert.ok(
      output.some(
        (event) => event.type === 'error' && event.error.includes('modelOverride'),
      ),
    )
    assert.equal(called, 0)

    const long = await post(url + '/api/analyze', {
      stage: 'understand',
      provider: 'deepseek',
      modelOverride: 'x'.repeat(201),
      document: { name: 'doc', blocks: [{ id: '1', text: 'text' }] },
    })
    assert.equal(long.status, 400)
    assert.match(
      ((await long.json()) as { error: string }).error,
      /modelOverride/,
    )
  } finally {
    await close(server)
  }
})

test('UOM_MAX_DOC_CHARS is enforced before upstream reads the document', async () => {
  const { server, url } = await serve(async () => '')
  const saved = snapshotEnv()
  try {
    process.env.UOM_MAX_DOC_CHARS = '10'
    const response = await post(url + '/api/analyze', {
      stage: 'understand',
      provider: 'deepseek',
      document: { name: 'doc', blocks: [{ id: '1', text: 'x'.repeat(11) }] },
    })
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error: string }
    assert.match(body.error, /UOM_MAX_DOC_CHARS/)
    assert.match(body.error, /11 字符/)
  } finally {
    restoreEnv(saved)
    await close(server)
  }
})

test('a Pi handoff failure surfaces the captured provider HTTP reason', async () => {
  const endpoint = await mockEndpoint((_body, response) => {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({ error: { message: 'tools unsupported by model custom-model' } }),
    )
  })
  const saved = snapshotEnv()
  const { server, url } = await serve(async () => {
    await fetch(endpoint.url + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'custom-model', messages: [] }),
    })
    // Give the asynchronous error-body capture a beat, then fail the way the
    // Pi agent does when its first model turn is rejected.
    await new Promise((resolve) => setTimeout(resolve, 50))
    throw new Error('Pi Agent 未通过提交工具交接建模说明。')
  })
  try {
    process.env.LLM_API_URL = endpoint.url
    process.env.LLM_API_KEY = 'sk-test'
    const response = await post(url + '/api/analyze/stream', {
      stage: 'understand',
      provider: 'deepseek',
      runtime: 'direct',
      document: { name: 'doc', blocks: [{ id: '1', text: 'text' }] },
    })
    const output = events(await response.text())
    const failure = output.find((event) => event.type === 'error')
    assert.ok(failure && failure.type === 'error')
    assert.match(failure.error, /模型调用失败/)
    assert.match(failure.error, /tools unsupported by model custom-model/)
    assert.doesNotMatch(failure.error, /未提交建模说明/)
  } finally {
    restoreEnv(saved)
    await close(server)
    await endpoint.close()
  }
})

test('JSON-recovery notices are appended to the stage result warnings', async () => {
  const { server, url } = await serve(async () => {
    currentContext()?.notices.push('服务端已自动修复截断的 JSON。')
    return '## 业务概述\n说明。'
  })
  try {
    const response = await post(url + '/api/analyze/stream', {
      stage: 'understand',
      provider: 'deepseek',
      runtime: 'direct',
      document: { name: 'doc', blocks: [{ id: '1', text: 'text' }] },
    })
    const output = events(await response.text())
    const result = output.at(-1)
    assert.ok(result && result.type === 'result')
    assert.ok('understanding' in result.result)
    assert.ok(
      result.result.understanding.warnings.includes('服务端已自动修复截断的 JSON。'),
    )
  } finally {
    await close(server)
  }
})
