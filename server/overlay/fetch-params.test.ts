import test from 'node:test'
import assert from 'node:assert/strict'
import { isChatCompletionsUrl, providerForUrl, rewriteChatBody } from './fetch-params.ts'
import { resolveModelConfig, type ModelConfig } from './model-config.ts'

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
