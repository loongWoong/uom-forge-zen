import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { Type, type Context } from '@earendil-works/pi-ai'
import { resolveModelConfig } from '../providers/model-config.ts'
import { createPiStreamFn, toPiModel } from './pi-model.ts'
import { runPiModeling } from './pi-modeling.ts'

type Recorder = {
  bodies: Record<string, unknown>[]
  close: () => Promise<void>
}

async function mockEndpoint(
  reply: (body: Record<string, unknown>, response: ServerResponse) => void,
): Promise<{ recorder: Recorder; url: string }> {
  const bodies: Record<string, unknown>[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      bodies.push(body)
      reply(body, response)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    recorder: {
      bodies,
      close: async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      },
    },
    url: `http://127.0.0.1:${address.port}/v1`,
  }
}

function streamOk(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ id: '1', choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ id: '1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
  response.write('data: [DONE]\n\n')
  response.end()
}

const context: Context = {
  systemPrompt: '只输出计划',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'narrative' }], timestamp: Date.now() }],
  tools: [{ name: 'check_modeling', description: '检查', parameters: Type.Object({ plan: Type.String() }) }],
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) void _event
}

test('Pi requests carry the resolved model, DeepSeek thinking and the configured output cap', async () => {
  const { recorder, url } = await mockEndpoint((_body, response) => streamOk(response))
  try {
    const config = resolveModelConfig('deepseek', {
      env: {
        LLM_API_URL: url,
        LLM_API_KEY: 'sk-test',
        LLM_MODEL: 'configured',
        LLM_API_TIMEOUT_MS: '1000',
      },
      override: 'deepseek-v4-pro-1782368669576-za54gp',
    })
    await drain(createPiStreamFn(config)(toPiModel(config), context) as AsyncIterable<unknown>)
    const body = recorder.bodies[0]
    assert.equal(body.model, 'deepseek-v4-pro-1782368669576-za54gp')
    assert.equal(body.max_tokens, 16384)
    assert.deepEqual(body.thinking, { type: 'disabled' })
    assert.deepEqual(body.stream_options, { include_usage: true })
    const tools = body.tools as { function: { name: string; strict?: boolean } }[]
    assert.deepEqual(tools.map((tool) => tool.function.name), ['check_modeling'])
    assert.equal(tools[0].function.strict, false)
  } finally {
    await recorder.close()
  }
})

test('UOM_PI_COMPAT=generic strips stream_options, strict and thinking for minimal gateways', async () => {
  const { recorder, url } = await mockEndpoint((_body, response) => streamOk(response))
  try {
    const config = resolveModelConfig('deepseek', {
      env: {
        LLM_API_URL: url,
        LLM_API_KEY: 'sk-test',
        LLM_MODEL: 'configured',
        UOM_PI_COMPAT: 'generic',
        UOM_PI_MAX_TOKENS: '9000',
      },
    })
    await drain(createPiStreamFn(config)(toPiModel(config), context) as AsyncIterable<unknown>)
    const body = recorder.bodies[0]
    assert.equal(body.model, 'configured')
    assert.equal(body.max_tokens, 9000)
    assert.equal(body.thinking, undefined)
    assert.equal(body.stream_options, undefined)
    const tools = body.tools as { function: { strict?: boolean } }[]
    assert.equal(tools[0].function.strict, undefined)
  } finally {
    await recorder.close()
  }
})

test('the GPT channel injects reasoning_effort and generic suppresses it', async () => {
  const { recorder, url } = await mockEndpoint((_body, response) => streamOk(response))
  try {
    const base = {
      GPT_API_URL: url,
      GPT_API_KEY: 'sk-test',
      GPT_MODEL: 'configured',
      GPT_API_TIMEOUT_MS: '1000',
    }
    const config = resolveModelConfig('gpt', {
      env: { ...base, GPT_REASONING_EFFORT: 'high' },
    })
    await drain(createPiStreamFn(config)(toPiModel(config), context) as AsyncIterable<unknown>)
    assert.equal(recorder.bodies[0].reasoning_effort, 'high')
    assert.equal(recorder.bodies[0].thinking, undefined)

    const generic = resolveModelConfig('gpt', {
      env: { ...base, GPT_REASONING_EFFORT: 'high', UOM_PI_COMPAT: 'generic' },
    })
    await drain(createPiStreamFn(generic)(toPiModel(generic), context) as AsyncIterable<unknown>)
    assert.equal(recorder.bodies[1].reasoning_effort, undefined)
    assert.equal(recorder.bodies[1].stream_options, undefined)
  } finally {
    await recorder.close()
  }
})

test('a provider rejection surfaces the HTTP reason instead of a generic Pi message', async () => {
  const { recorder, url } = await mockEndpoint((_body, response) => {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'tools unsupported by model custom-model' } }))
  })
  const saved = {
    LLM_API_URL: process.env.LLM_API_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL,
    UOM_PI_TIMEOUT_MS: process.env.UOM_PI_TIMEOUT_MS,
  }
  process.env.LLM_API_URL = url
  process.env.LLM_API_KEY = 'sk-test'
  process.env.LLM_MODEL = 'configured'
  process.env.UOM_PI_TIMEOUT_MS = '10000'
  try {
    await assert.rejects(
      runPiModeling(
        { narrative: 'n' },
        async () => JSON.stringify({ checked: true, gaps: [] }),
        { provider: 'deepseek', runtime: 'pi', model: 'custom-model' },
      ),
      (error: Error) => {
        assert.match(error.message, /模型调用失败/)
        assert.match(error.message, /tools unsupported by model custom-model/)
        assert.doesNotMatch(error.message, /未提交建模说明/)
        return true
      },
    )
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await recorder.close()
  }
})
