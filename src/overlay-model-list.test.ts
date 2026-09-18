import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchEndpointModels } from './overlay/model-list.ts'

function stubFetch(
  body: BodyInit | null,
  status = 200,
  type = 'application/json',
): typeof fetch {
  return (async () => new Response(body, { status, headers: { 'content-type': type } })) as typeof fetch
}

test('returns the models together with the endpoint they came from', async () => {
  const result = await fetchEndpointModels(
    'gpt',
    stubFetch(
      JSON.stringify({ models: ['gw-model', 7, 'glm-5.3'], endpoint: 'http://gw.test/v1' }),
    ),
  )
  assert.deepEqual(result, {
    models: ['gw-model', 'glm-5.3'],
    endpoint: 'http://gw.test/v1',
  })
})

test('an endpoint-less response is still usable', async () => {
  const result = await fetchEndpointModels('qwen', stubFetch(JSON.stringify({ models: [] })))
  assert.deepEqual(result, { models: [] })
})

test('surfaces the server reason instead of a bare status code', async () => {
  await assert.rejects(
    fetchEndpointModels(
      'qwen',
      stubFetch(JSON.stringify({ error: 'Qwen 未配置 QWEN_API_KEY 或 QWEN_API_URL。' }), 502),
    ),
    /Qwen 未配置 QWEN_API_KEY 或 QWEN_API_URL。/,
  )
})

test('falls back to the status when the failure body is not JSON', async () => {
  await assert.rejects(fetchEndpointModels('gpt', stubFetch('bad gateway', 502, 'text/plain')), /HTTP 502/)
})

test('always asks the server for the provider it was given', async () => {
  const requested: string[] = []
  const impl = (async (input: RequestInfo | URL) => {
    requested.push(String(input))
    return new Response(JSON.stringify({ models: [] }), { status: 200 })
  }) as typeof fetch
  await fetchEndpointModels('deepseek', impl)
  assert.deepEqual(requested, ['/api/models?provider=deepseek'])
})
