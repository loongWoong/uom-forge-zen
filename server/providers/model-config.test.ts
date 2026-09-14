import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEndpoint, resolveModelConfig } from './model-config.ts'

const env: NodeJS.ProcessEnv = {
  LLM_API_KEY: 'deepseek-key',
  LLM_API_URL: 'http://deepseek.invalid/v1',
  LLM_MODEL: 'configured-deepseek',
  LLM_API_TIMEOUT_MS: '1000',
  GPT_API_KEY: 'gpt-key',
  GPT_API_URL: 'http://gpt.invalid/v1/chat/completions/',
  GPT_MODEL: 'configured-gpt',
  GPT_API_TIMEOUT_MS: '2000',
}

test('endpoint normalization strips trailing slashes and one chat/completions suffix', () => {
  assert.equal(normalizeEndpoint('http://h/v1/'), 'http://h/v1')
  assert.equal(normalizeEndpoint('http://h/v1/chat/completions'), 'http://h/v1')
  assert.equal(normalizeEndpoint('http://h/v1/chat/completions/'), 'http://h/v1')
  assert.equal(normalizeEndpoint('http://h/'), 'http://h')
})

test('DeepSeek resolves the merged defaults from one place', () => {
  const config = resolveModelConfig('deepseek', { env })
  assert.equal(config.provider, 'deepseek')
  assert.equal(config.label, 'DeepSeek')
  assert.equal(config.modelId, 'configured-deepseek')
  assert.equal(config.apiKey, 'deepseek-key')
  assert.equal(config.baseUrl, 'http://deepseek.invalid/v1')
  assert.equal(config.chatCompletionsUrl, 'http://deepseek.invalid/v1/chat/completions')
  assert.equal(config.timeoutMs, 1000)
  assert.equal(config.maxOutputTokens, 16384)
  assert.deepEqual(config.pi, {
    maxTokens: 16384,
    contextWindow: 128000,
    disableThinking: true,
    compat: {},
  })
})

test('request override wins and GPT keeps its own endpoint, effort and no implicit cap', () => {
  const config = resolveModelConfig('gpt', { env, override: 'custom-gpt' })
  assert.equal(config.modelId, 'custom-gpt')
  assert.equal(config.apiKey, 'gpt-key')
  assert.equal(config.baseUrl, 'http://gpt.invalid/v1')
  assert.equal(config.chatCompletionsUrl, 'http://gpt.invalid/v1/chat/completions')
  assert.equal(config.timeoutMs, 2000)
  assert.equal(config.maxOutputTokens, undefined)
  assert.equal(config.reasoningEffort, 'medium')
  assert.deepEqual(config.pi, {
    maxTokens: 24000,
    contextWindow: 128000,
    disableThinking: false,
    reasoningEffort: 'medium',
    compat: {},
  })
})

test('Qwen resolves its own endpoint and keeps the direct request shape', () => {
  const qwenEnv: NodeJS.ProcessEnv = {
    ...env,
    QWEN_API_KEY: 'qwen-key',
    QWEN_API_URL: 'http://qwen.invalid/v1',
    QWEN_MODEL: 'configured-qwen',
    QWEN_API_TIMEOUT_MS: '3000',
  }
  const config = resolveModelConfig('qwen', { env: qwenEnv })
  assert.equal(config.provider, 'qwen')
  assert.equal(config.label, 'Qwen')
  assert.equal(config.modelId, 'configured-qwen')
  assert.equal(config.apiKey, 'qwen-key')
  assert.equal(config.baseUrl, 'http://qwen.invalid/v1')
  assert.equal(config.chatCompletionsUrl, 'http://qwen.invalid/v1/chat/completions')
  assert.equal(config.timeoutMs, 3000)
  assert.equal(config.maxOutputTokens, 16384)
  assert.equal(config.reasoningEffort, undefined)
  assert.equal(config.piProvider, 'qwen')
  assert.deepEqual(config.pi, {
    maxTokens: 16384,
    contextWindow: 128000,
    disableThinking: false,
    compat: { supportsStore: false, maxTokensField: 'max_tokens' },
  })
  assert.throws(() => resolveModelConfig('qwen', { env: {} }), /Qwen 未配置/)

  const generic = resolveModelConfig('qwen', {
    env: { ...qwenEnv, UOM_PI_COMPAT: 'generic' },
  })
  assert.deepEqual(generic.pi.compat, {
    supportsStore: false,
    maxTokensField: 'max_tokens',
    supportsUsageInStreaming: false,
    supportsStrictMode: false,
    supportsReasoningEffort: false,
  })
})

test('invalid output-token settings fail loudly instead of reaching the endpoint', () => {
  assert.throws(
    () =>
      resolveModelConfig('deepseek', {
        env: { ...env, LLM_MAX_OUTPUT_TOKENS: 'invalid' },
      }),
    /LLM_MAX_OUTPUT_TOKENS 必须为正整数/,
  )
  assert.throws(
    () =>
      resolveModelConfig('gpt', { env: { ...env, GPT_MAX_OUTPUT_TOKENS: '0' } }),
    /GPT_MAX_OUTPUT_TOKENS 必须为正整数/,
  )
  assert.throws(
    () => resolveModelConfig('deepseek', { env: { ...env, UOM_PI_MAX_TOKENS: '-1' } }),
    /UOM_PI_MAX_TOKENS 必须为正整数/,
  )
  assert.throws(
    () =>
      resolveModelConfig('deepseek', {
        env: { ...env, UOM_PI_MAX_TOKENS_FIELD: 'max_output_tokens' },
      }),
    /UOM_PI_MAX_TOKENS_FIELD 必须是 max_tokens 或 max_completion_tokens/,
  )
})

test('UOM_PI_COMPAT=generic disables vendor extensions and individual flags override it', () => {
  const generic = resolveModelConfig('deepseek', {
    env: { ...env, UOM_PI_COMPAT: 'generic' },
  })
  assert.deepEqual(generic.pi.compat, {
    supportsUsageInStreaming: false,
    supportsStrictMode: false,
    supportsStore: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
  })
  // Minimal gateways often reject the DeepSeek thinking field too.
  assert.equal(generic.pi.disableThinking, false)
  assert.equal(generic.pi.maxTokens, 16384)

  const strict = resolveModelConfig('deepseek', {
    env: { ...env, UOM_PI_COMPAT: 'generic', UOM_PI_STRICT: 'true' },
  })
  assert.equal(strict.pi.compat.supportsStrictMode, true)
  assert.equal(strict.pi.compat.supportsUsageInStreaming, false)
  // generic also suppresses the GPT-side reasoning field unless requested.
  const genericGpt = resolveModelConfig('gpt', {
    env: { ...env, UOM_PI_COMPAT: 'generic' },
  })
  assert.equal(genericGpt.pi.reasoningEffort, undefined)
  const explicit = resolveModelConfig('gpt', {
    env: { ...env, UOM_PI_COMPAT: 'generic', UOM_PI_REASONING_EFFORT: 'low' },
  })
  assert.equal(explicit.pi.reasoningEffort, 'low')
  assert.throws(
    () =>
      resolveModelConfig('deepseek', { env: { ...env, UOM_PI_COMPAT: 'vendor' } }),
    /只支持 generic/,
  )
})

test('Pi-only overrides change the runtime request without touching the direct client', () => {
  const config = resolveModelConfig('deepseek', {
    env: {
      ...env,
      UOM_PI_MAX_TOKENS: '9000',
      UOM_PI_CONTEXT_WINDOW: '64000',
      UOM_PI_DISABLE_THINKING: 'false',
      UOM_PI_REASONING_EFFORT: 'low',
    },
  })
  assert.equal(config.maxOutputTokens, 16384)
  assert.deepEqual(config.pi, {
    maxTokens: 9000,
    contextWindow: 64000,
    disableThinking: false,
    reasoningEffort: 'low',
    compat: {},
  })

  const off = resolveModelConfig('gpt', {
    env: { ...env, UOM_PI_REASONING_EFFORT: 'off' },
  })
  assert.equal(off.pi.reasoningEffort, undefined)
  assert.equal(off.pi.disableThinking, false)
})

test('missing credentials and malformed endpoints report the provider', () => {
  assert.throws(() => resolveModelConfig('deepseek', { env: {} }), /DeepSeek 未配置/)
  assert.throws(() => resolveModelConfig('gpt', { env: {} }), /GPT 未配置/)
  assert.throws(
    () => resolveModelConfig('deepseek', { env: { LLM_API_KEY: 'k', LLM_API_URL: '/' } }),
    /DeepSeek 的 API URL 无效/,
  )
})
