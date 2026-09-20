import test from 'node:test'
import assert from 'node:assert/strict'
import { isChatCompletionsUrl, providerForUrl, rewriteChatBody } from './fetch-params.ts'
import { resolveModelConfig, type ModelConfig } from './model-config.ts'
import { inheritProviderEndpoints } from './provider-env.ts'

const env: NodeJS.ProcessEnv = {
  LLM_API_URL: 'http://deepseek.invalid/v1',
  LLM_API_KEY: 'deepseek-key',
  LLM_MODEL: 'configured-deepseek',
  LLM_API_TIMEOUT_MS: '1000',
  GPT_API_URL: 'http://gateway.invalid/openai/v1',
  GPT_API_KEY: 'gpt-key',
  GPT_MODEL: 'configured-gpt',
  GPT_REASONING_EFFORT: 'high',
  GPT_API_TIMEOUT_MS: '2000',
  QWEN_API_URL: 'http://gateway.invalid/qwen/v1',
  QWEN_API_KEY: 'qwen-key',
  QWEN_MODEL: 'configured-qwen',
}

const config = (provider: 'deepseek' | 'gpt' | 'qwen', override?: string): ModelConfig =>
  resolveModelConfig(provider, { env, override })

test('providerForUrl prefers the request provider and otherwise matches the longest base', () => {
  assert.equal(providerForUrl('http://deepseek.invalid/v1/chat/completions', env), 'deepseek')
  assert.equal(
    providerForUrl('http://gateway.invalid/qwen/v1/chat/completions', env),
    'qwen',
  )
  // preferred 只在端点匹配时生效：qwen 的 URL 仍然是 qwen 的请求
  assert.equal(
    providerForUrl('http://gateway.invalid/qwen/v1/chat/completions', env, 'gpt'),
    'qwen',
  )
  // 多个提供方共用一个端点时，请求里的 provider 决定配置
  const shared: NodeJS.ProcessEnv = {
    ...env,
    GPT_API_URL: 'http://shared.invalid/v1',
    QWEN_API_URL: 'http://shared.invalid/v1',
  }
  assert.equal(
    providerForUrl('http://shared.invalid/v1/chat/completions', shared, 'qwen'),
    'qwen',
  )
  assert.equal(
    providerForUrl('http://shared.invalid/v1/chat/completions', shared, 'gpt'),
    'gpt',
  )
  assert.equal(providerForUrl('http://elsewhere.invalid/v1/chat/completions', env), undefined)
})

test('isChatCompletionsUrl only matches the completions endpoint', () => {
  assert.equal(isChatCompletionsUrl('http://h/v1/chat/completions'), true)
  assert.equal(isChatCompletionsUrl('http://h/v1/chat/completions/'), true)
  assert.equal(isChatCompletionsUrl('http://h/v1/models'), false)
  assert.equal(isChatCompletionsUrl('not a url'), false)
})

test('the model override wins over the configured model for both runtimes', () => {
  const body: Record<string, unknown> = { model: 'pi-built-model', max_tokens: 9999 }
  rewriteChatBody(body, config('deepseek', 'override-model'), env)
  assert.equal(body.model, 'override-model')
  assert.equal(body.max_tokens, 16384)
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.equal(body.reasoning_effort, undefined)
})

test('GPT keeps reasoning effort and an explicit output cap when configured', () => {
  const body: Record<string, unknown> = { model: 'x', max_completion_tokens: 100 }
  rewriteChatBody(body, config('gpt'), env)
  assert.equal(body.model, 'configured-gpt')
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.thinking, undefined)
  // 未显式配置 GPT_MAX_OUTPUT_TOKENS 时保留调用方（Pi）的上限
  assert.equal(body.max_completion_tokens, 24000)

  const explicit = resolveModelConfig('gpt', {
    env: { ...env, GPT_MAX_OUTPUT_TOKENS: '4096' },
  })
  const capped: Record<string, unknown> = { model: 'x' }
  rewriteChatBody(capped, explicit, { ...env, GPT_MAX_OUTPUT_TOKENS: '4096' })
  assert.equal(capped.max_tokens, 4096)
  assert.equal(capped.max_completion_tokens, undefined)
})

test('an inherited provider sends no vendor reasoning parameters', () => {
  const shared: NodeJS.ProcessEnv = {
    ...env,
    LLM_API_URL: 'http://gw.test/v1',
    LLM_API_KEY: 'k',
    LLM_MODEL: 'gw-model',
    GPT_API_URL: '',
    GPT_API_KEY: '',
    GPT_MODEL: '',
  }
  inheritProviderEndpoints(shared)
  // Upstream's direct GPT client always sends reasoning_effort; the generic
  // gateway must not receive it (nor the literal 'off' of the opt-out value).
  const body: Record<string, unknown> = { model: 'x', reasoning_effort: 'medium' }
  rewriteChatBody(body, resolveModelConfig('gpt', { env: shared }), shared)
  assert.equal(body.model, 'gw-model')
  assert.equal(body.reasoning_effort, undefined)
  assert.deepEqual(body.thinking, { type: 'disabled' })
})

test('GPT_API_TIMEOUT_MS 未配置时继承 LLM_API_TIMEOUT_MS', () => {
  const shared: NodeJS.ProcessEnv = {
    ...env,
    LLM_API_URL: 'http://gw.test/v1',
    LLM_API_KEY: 'k',
    LLM_API_TIMEOUT_MS: '900000',
    GPT_API_URL: '',
    GPT_API_KEY: '',
  }
  inheritProviderEndpoints(shared)
  assert.equal(resolveModelConfig('gpt', { env: shared }).timeoutMs, 900000)
})

test('UOM_PI_COMPAT=generic strips vendor extensions and renames the token field', () => {
  const compatible: NodeJS.ProcessEnv = {
    ...env,
    UOM_PI_COMPAT: 'generic',
    UOM_LLM_PROVIDER: 'deepseek',
  }
  const body: Record<string, unknown> = {
    model: 'x',
    max_completion_tokens: 123,
    store: true,
    stream_options: { include_usage: true },
    reasoning_effort: 'high',
  }
  rewriteChatBody(body, resolveModelConfig('deepseek', { env: compatible }), compatible)
  assert.equal(body.max_tokens, 16384)
  assert.equal(body.max_completion_tokens, undefined)
  assert.equal(body.store, undefined)
  assert.equal(body.stream_options, undefined)
  assert.equal(body.reasoning_effort, undefined)
  assert.equal(body.thinking, undefined)
})

test('individual compatibility switches win over the defaults', () => {
  const switched: NodeJS.ProcessEnv = {
    ...env,
    UOM_PI_STORE: 'false',
    UOM_PI_STREAM_OPTIONS: 'false',
    UOM_PI_MAX_TOKENS_FIELD: 'max_tokens',
  }
  const body: Record<string, unknown> = {
    model: 'x',
    max_completion_tokens: 123,
    store: false,
    stream_options: { include_usage: true },
  }
  rewriteChatBody(body, resolveModelConfig('deepseek', { env: switched }), switched)
  assert.equal(body.store, undefined)
  assert.equal(body.stream_options, undefined)
  assert.equal(body.max_tokens, 16384)
  assert.equal(body.max_completion_tokens, undefined)
})

test('a GLM request keeps its mandatory thinking and vendor parameters', () => {
  const glmEnv: NodeJS.ProcessEnv = {
    GLM_API_KEY: 'glm-key',
    GLM_MODEL: 'glm-configured',
  }
  const config = resolveModelConfig('glm', { env: glmEnv })
  // 上游默认端点（coding-plan），只需 GLM_API_KEY。
  assert.equal(config.baseUrl, 'https://open.bigmodel.cn/api/coding/paas/v4')
  assert.equal(config.modelId, 'glm-configured')
  assert.equal(config.piProvider, 'zai')
  assert.equal(config.pi.glmThinking, true)
  assert.equal(config.pi.reasoningEffort, 'max')
  const body: Record<string, unknown> = {
    model: 'glm-5.3-flash',
    messages: [],
    thinking: { type: 'enabled', clear_thinking: false },
    reasoning_effort: 'max',
    temperature: 1,
    top_p: 0.95,
    max_tokens: 32768,
  }
  rewriteChatBody(body, config, glmEnv)
  // GLM-5.3-Flash 强制开思考：改写不得剥掉 thinking/temperature/top_p。
  assert.deepEqual(body.thinking, { type: 'enabled', clear_thinking: false })
  assert.equal(body.reasoning_effort, 'max')
  assert.equal(body.temperature, 1)
  assert.equal(body.top_p, 0.95)
  assert.equal(body.model, 'glm-configured')
  assert.equal(body.max_tokens, 32768)
})

test('the GLM default endpoint resolves to the glm provider', () => {
  assert.equal(
    providerForUrl(
      'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
      { GLM_API_KEY: 'k' },
    ),
    'glm',
  )
})

test('an inherited GLM follows the generic channel like GPT/Qwen', () => {
  const inherited = { ...env }
  inheritProviderEndpoints(inherited)
  const config = resolveModelConfig('glm', { env: inherited })
  assert.equal(config.baseUrl, 'http://deepseek.invalid/v1')
  assert.equal(config.pi.glmThinking, undefined)
  assert.equal(config.pi.disableThinking, true)
  const body: Record<string, unknown> = {
    model: 'glm-5.3-flash',
    messages: [],
    thinking: { type: 'enabled', clear_thinking: false },
    reasoning_effort: 'max',
  }
  rewriteChatBody(body, config, inherited)
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.equal(body.reasoning_effort, undefined)
})
