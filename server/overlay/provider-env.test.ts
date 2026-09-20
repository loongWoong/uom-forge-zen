import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyPiStageTimeout,
  inheritProviderEndpoints,
  inheritedProviders,
  INHERITED_ENV_KEY,
} from './provider-env.ts'
import { listEndpointModels, providerDescriptor } from './routes.ts'
import { resolveModelConfig } from './model-config.ts'

/** A single-gateway deployment: only LLM_* is configured. */
function genericEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    LLM_API_URL: 'http://gw.test/v1',
    LLM_API_KEY: 'generic-key',
    LLM_MODEL: 'gw-default',
    LLM_API_TIMEOUT_MS: '900000',
    LLM_MAX_OUTPUT_TOKENS: '32768',
    ...extra,
  }
}

test('unconfigured providers follow the generic channel', () => {
  const env = genericEnv()
  const result = inheritProviderEndpoints(env)
  assert.deepEqual(result.providers, ['gpt', 'qwen', 'glm'])
  for (const prefix of ['GPT', 'QWEN', 'GLM']) {
    assert.equal(env[`${prefix}_API_URL`], 'http://gw.test/v1')
    assert.equal(env[`${prefix}_API_KEY`], 'generic-key')
    assert.equal(env[`${prefix}_MODEL`], 'gw-default')
    assert.equal(env[`${prefix}_API_TIMEOUT_MS`], '900000')
    assert.equal(env[`${prefix}_MAX_OUTPUT_TOKENS`], '32768')
  }
  // The turn resolves the same endpoint the list does.
  const config = resolveModelConfig('gpt', { env })
  assert.equal(config.baseUrl, 'http://gw.test/v1')
  assert.equal(config.modelId, 'gw-default')
})

test('explicit provider configuration always wins', () => {
  const env = genericEnv({
    GPT_API_URL: 'http://openai.test/v1',
    GPT_API_KEY: 'gpt-key',
    GPT_MODEL: 'gpt-real',
    QWEN_API_URL: 'http://qwen.test/v1',
    QWEN_API_KEY: 'qwen-key',
    QWEN_MODEL: 'qwen-real',
    GLM_API_URL: 'http://zhipu.test/v4',
    GLM_API_KEY: 'glm-key',
    GLM_MODEL: 'glm-real',
  })
  assert.deepEqual(inheritProviderEndpoints(env), { providers: [], keys: [] })
  assert.equal(env.GPT_API_URL, 'http://openai.test/v1')
  assert.equal(env.GPT_MODEL, 'gpt-real')
  assert.equal(env.QWEN_API_URL, 'http://qwen.test/v1')
  assert.equal(env.QWEN_MODEL, 'qwen-real')
  assert.equal(env.GLM_API_URL, 'http://zhipu.test/v4')
  assert.equal(env.GLM_MODEL, 'glm-real')
})

test('a partially configured provider keeps its own accurate error', () => {
  const env = genericEnv({ GPT_API_KEY: 'only-a-key' })
  const result = inheritProviderEndpoints(env)
  assert.deepEqual(result.providers, ['qwen', 'glm'])
  // GPT keeps its own (incomplete) configuration, so upstream still reports it.
  assert.equal(env.GPT_API_URL, undefined)
  assert.throws(() => resolveModelConfig('gpt', { env }), /GPT_API_URL/)
})

test('empty values count as unset, as in a copied .env.example', () => {
  const env = genericEnv({ GPT_API_URL: '', GPT_API_KEY: '', QWEN_API_URL: '  ' })
  assert.deepEqual(inheritProviderEndpoints(env).providers, ['gpt', 'qwen', 'glm'])
  assert.equal(env.GPT_API_URL, 'http://gw.test/v1')
  assert.equal(env.QWEN_API_URL, 'http://gw.test/v1')
})

test('without a generic channel there is nothing to follow', () => {
  const env: NodeJS.ProcessEnv = { GPT_MODEL: 'gpt-real' }
  assert.deepEqual(inheritProviderEndpoints(env), { providers: [], keys: [] })
  assert.equal(env.GPT_API_URL, undefined)
})

test('an inherited provider behaves like the generic channel', () => {
  const env = genericEnv()
  inheritProviderEndpoints(env)
  const generic = resolveModelConfig('deepseek', { env })
  for (const provider of ['gpt', 'qwen', 'glm'] as const) {
    const config = resolveModelConfig(provider, { env })
    assert.equal(config.baseUrl, generic.baseUrl)
    assert.equal(config.modelId, generic.modelId)
    assert.equal(config.pi.disableThinking, generic.pi.disableThinking)
    assert.equal(config.pi.maxTokens, generic.pi.maxTokens)
    assert.equal(config.pi.reasoningEffort, generic.pi.reasoningEffort)
    assert.equal(config.piProvider, generic.piProvider)
  }
  // The operator's own model name still wins when it was set explicitly.
  const named = genericEnv({ GPT_MODEL: 'my-gpt-alias' })
  inheritProviderEndpoints(named)
  assert.equal(resolveModelConfig('gpt', { env: named }).modelId, 'my-gpt-alias')
})

test('UOM_PROVIDER_FALLBACK=off disables the alias', () => {
  const env = genericEnv({ UOM_PROVIDER_FALLBACK: 'off' })
  assert.deepEqual(inheritProviderEndpoints(env), { providers: [], keys: [] })
  assert.equal(env.GPT_API_URL, undefined)
})

test('the picker lists the models of the baseURL the turn will call', async () => {
  const env = genericEnv()
  inheritProviderEndpoints(env)
  const requested: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requested.push(`${url} | ${new Headers(init?.headers).get('authorization') || ''}`)
    return new Response(
      JSON.stringify({ object: 'list', data: [{ id: 'qwen3.8-flash' }, { id: 'glm-5.3' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  try {
    // Exactly the deployment that used to answer "HTTP 502" for GPT/Qwen.
    for (const provider of ['gpt', 'qwen', 'glm'] as const) {
      const listed = await listEndpointModels(provider, env)
      assert.deepEqual(listed.models, ['qwen3.8-flash', 'glm-5.3'])
      assert.equal(listed.endpoint, 'http://gw.test/v1')
    }
    const descriptor = providerDescriptor(env)
    assert.deepEqual(
      descriptor.options.map((option) => [option.value, option.ready, option.model, option.endpoint]),
      [
        ['deepseek', true, 'gw-default', 'http://gw.test/v1'],
        ['gpt', true, 'gw-default', 'http://gw.test/v1'],
        ['qwen', true, 'gw-default', 'http://gw.test/v1'],
        ['glm', true, 'gw-default', 'http://gw.test/v1'],
      ],
    )
  } finally {
    globalThis.fetch = original
  }
  assert.deepEqual(requested, [
    'http://gw.test/v1/models | Bearer generic-key',
    'http://gw.test/v1/models | Bearer generic-key',
    'http://gw.test/v1/models | Bearer generic-key',
  ])
})

test('the inherited marker disappears once every provider stands on its own', () => {
  const env = genericEnv()
  inheritProviderEndpoints(env)
  assert.deepEqual(inheritedProviders(env), ['gpt', 'qwen', 'glm'])
  // The operator later configures real per-provider endpoints in .env.
  const configured = genericEnv({
    GPT_API_URL: 'http://openai.test/v1',
    GPT_API_KEY: 'gpt-key',
    GPT_MODEL: 'gpt-real',
    QWEN_API_URL: 'http://dashscope.test/v1',
    QWEN_API_KEY: 'qwen-key',
    QWEN_MODEL: 'qwen-real',
    GLM_API_URL: 'http://zhipu.test/v4',
    GLM_API_KEY: 'glm-key',
    GLM_MODEL: 'glm-real',
  })
  delete configured[INHERITED_ENV_KEY]
  // Simulate the same process re-running the alias with the new environment:
  // the stale marker must not keep the generic profile stuck on gpt/qwen.
  configured[INHERITED_ENV_KEY] = 'gpt,qwen,glm'
  inheritProviderEndpoints(configured)
  assert.deepEqual(inheritedProviders(configured), [])
  assert.equal(resolveModelConfig('gpt', { env: configured }).modelId, 'gpt-real')
})

test('UOM_PROVIDER_FALLBACK=off also clears a marker from an earlier start', () => {
  const env = genericEnv({ UOM_PROVIDER_FALLBACK: 'off', [INHERITED_ENV_KEY]: 'gpt,qwen,glm' })
  const result = inheritProviderEndpoints(env)
  assert.deepEqual(result.providers, [])
  assert.deepEqual(inheritedProviders(env), [])
})

test('a Pi stage inherits the longest configured provider deadline', () => {
  const env: NodeJS.ProcessEnv = {
    LLM_API_TIMEOUT_MS: '900000',
    GPT_API_TIMEOUT_MS: '120000',
  }
  assert.equal(applyPiStageTimeout(env), '900000')
  // Idempotent: the derived value is never overwritten by a second pass.
  assert.equal(applyPiStageTimeout(env), undefined)
  assert.equal(env.UOM_PI_TIMEOUT_MS, '900000')
})

test('an explicit UOM_PI_TIMEOUT_MS always wins', () => {
  const env: NodeJS.ProcessEnv = {
    UOM_PI_TIMEOUT_MS: '60000',
    LLM_API_TIMEOUT_MS: '900000',
  }
  assert.equal(applyPiStageTimeout(env), undefined)
  assert.equal(env.UOM_PI_TIMEOUT_MS, '60000')
})

test('without a configured provider timeout upstream keeps its own default', () => {
  const env: NodeJS.ProcessEnv = { LLM_API_TIMEOUT_MS: 'abc' }
  assert.equal(applyPiStageTimeout(env), undefined)
  assert.equal(env.UOM_PI_TIMEOUT_MS, undefined)
})
