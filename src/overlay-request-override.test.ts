import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decorateFetch,
  isProviderId,
  modelOverrideFor,
  writeModelOverride,
} from './overlay/request-override.ts'

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.has(key) ? (this.values.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const storage = () => new MemoryStorage() as unknown as Storage

test('model overrides are stored per provider and cleared to the default', () => {
  const store = storage()
  assert.equal(modelOverrideFor('deepseek', store), '')
  writeModelOverride('deepseek', '  qwen3.8-flash  ', store)
  assert.equal(modelOverrideFor('deepseek', store), 'qwen3.8-flash')
  assert.equal(modelOverrideFor('gpt', store), '')
  writeModelOverride('deepseek', '   ', store)
  assert.equal(modelOverrideFor('deepseek', store), '')
})

test('the fetch decorator injects the override into analysis requests only', async () => {
  const store = storage()
  writeModelOverride('deepseek', 'override-model', store)
  const seen: { url: string; body: unknown; method?: string }[] = []
  const original = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let body: unknown
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    seen.push({
      url: String(input),
      method: init?.method,
      body,
    })
    return new Response('{}')
  }) as typeof fetch
  const decorated = decorateFetch(
    original,
    'http://localhost:5173/',
    store,
  )

  const analyze = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage: 'understand', provider: 'deepseek' }),
  }
  await decorated('/api/analyze/stream', analyze)
  assert.deepEqual((seen[0].body as { modelOverride?: string }).modelOverride, 'override-model')

  // 其他提供方没有覆盖时不添加字段
  await decorated('/api/discuss', {
    method: 'POST',
    body: JSON.stringify({ provider: 'gpt' }),
  })
  assert.equal((seen[1].body as { modelOverride?: string }).modelOverride, undefined)

  // 显式传入的 modelOverride 优先
  await decorated('/api/analyze', {
    method: 'POST',
    body: JSON.stringify({ provider: 'deepseek', modelOverride: 'explicit' }),
  })
  assert.equal((seen[2].body as { modelOverride?: string }).modelOverride, 'explicit')

  // 非分析请求和非 JSON body 原样通过
  await decorated('/api/config')
  assert.equal(seen[3].body, undefined)
  await decorated('/api/analyze', {
    method: 'POST',
    body: 'not json',
  })
  assert.equal(seen[4].body, 'not json')
})

test('provider ids are validated while reading request bodies', () => {
  assert.equal(isProviderId('deepseek'), true)
  assert.equal(isProviderId('gpt'), true)
  assert.equal(isProviderId('qwen'), true)
  assert.equal(isProviderId('codex'), false)
  assert.equal(isProviderId(42), false)
})
