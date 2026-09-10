import test from 'node:test'
import assert from 'node:assert/strict'
import { hydrateEvidence, normalizeModel, validateModel, resolveProvider, providerConfig, validateDocument, maxDocumentChars, parseModel, parseModelWithMeta, DEFAULT_MAX_DOCUMENT_CHARS } from './modeling.js'

const document = { name: 'test.md', blocks: [{ id: 'b1', text: '主体完成操作并产生结果' }] }

test('normalizes compact candidates into the provider-neutral model contract', () => {
  const model = hydrateEvidence(normalizeModel({
    name: '通用业务',
    objects: [{ id: '主体', name: '主体', fields: ['身份'], evidence: ['主体完成操作并产生结果'] }, { id: '结果', name: '结果' }],
    relations: [{ from: '主体', label: '产生', to: '结果', evidence: ['主体完成操作并产生结果'] }],
    actions: [{ id: 'perform', name: '完成操作', targets: ['主体', '结果'], inputs: [] }],
    activities: [{ id: 'operation', name: '执行操作', goal: '完成业务操作', elements: ['主体', '结果'], status: 'supported', evidence: ['主体完成操作并产生结果'] }],
  }), document)
  assert.equal(model.schemaVersion, '1')
  assert.equal(model.objects[0].properties[0].type, 'string')
  assert.deepEqual(model.relations[0].from, '主体')
  assert.equal(model.objects[0].evidence[0].blockId, 'b1')
  assert.doesNotThrow(() => validateModel(model, document))
})

test('rejects citations that do not exist in the submitted document', () => {
  const model = normalizeModel({ objects: [{ id: 'entity', name: '实体', evidence: [{ blockId: 'missing', quote: '不存在' }] }] })
  assert.throws(() => validateModel(model, document), /原文证据块/)
})

test('drops provider citations that are not verbatim evidence', () => {
  const model = hydrateEvidence(normalizeModel({
    actions: [{ id: 'perform', name: '完成操作', targets: [], inputs: [], evidence: [{ blockId: 'b1', quote: '主体完成了操作' }] }],
  }), document)
  assert.deepEqual(model.actions[0].evidence, [])
  assert.doesNotThrow(() => validateModel(model, document))
})

test('resolves provider names, aliases and the server default', () => {
  assert.deepEqual(resolveProvider('codex', {}), { name: 'codex', kind: 'acp' })
  assert.deepEqual(resolveProvider('Private', {}), { name: 'private', kind: 'openai' })
  assert.deepEqual(resolveProvider('openai', {}), { name: 'openai', kind: 'openai' })
  assert.deepEqual(resolveProvider(undefined, { UOM_LLM_PROVIDER: 'private' }), { name: 'private', kind: 'openai' })
  assert.deepEqual(resolveProvider(undefined, {}), { name: 'deepseek', kind: 'openai' })
  assert.throws(() => resolveProvider('gpt-9', {}), /不支持的推理提供方/)
})

test('reads a private OpenAI-compatible endpoint from PRIVATE_LLM_* with LLM_* fallback', () => {
  const dedicated = providerConfig('private', {
    PRIVATE_LLM_API_URL: 'http://127.0.0.1:8000/v1', PRIVATE_LLM_API_KEY: 'sk-123', PRIVATE_LLM_MODEL: 'qwen3.8-flash-next',
    LLM_API_URL: 'https://api.deepseek.com/v1', LLM_API_KEY: 'other', LLM_MODEL: 'deepseek-chat',
  })
  assert.equal(dedicated.url, 'http://127.0.0.1:8000/v1')
  assert.equal(dedicated.apiKey, 'sk-123')
  assert.equal(dedicated.model, 'qwen3.8-flash-next')
  assert.equal(dedicated.ready, true)
  assert.match(dedicated.label, /qwen3\.8-flash-next/)

  const fallback = providerConfig('private', { LLM_API_URL: 'http://127.0.0.1:8000/v1', LLM_API_KEY: 'sk-123', LLM_MODEL: 'qwen3.8-flash-next' })
  assert.equal(fallback.url, 'http://127.0.0.1:8000/v1')
  assert.equal(fallback.model, 'qwen3.8-flash-next')

  const incomplete = providerConfig('private', { LLM_API_URL: 'http://127.0.0.1:8000/v1' })
  assert.equal(incomplete.ready, false)
  assert.equal(incomplete.vars.model, 'PRIVATE_LLM_MODEL')

  assert.equal(providerConfig('deepseek', { LLM_API_URL: 'http://x/v1', LLM_API_KEY: 'k' }).model, 'deepseek-chat')
  assert.equal(providerConfig('codex', {}).kind, 'acp')
})

test('private provider config does not overwrite the deepseek label', () => {
  const env = { PRIVATE_LLM_PROVIDER_LABEL: '机房内网 Qwen', PRIVATE_LLM_API_URL: 'http://h/v1', PRIVATE_LLM_API_KEY: 'k', PRIVATE_LLM_MODEL: 'm' }
  assert.equal(providerConfig('private', env).label, '机房内网 Qwen')
  assert.equal(providerConfig('deepseek', { ...env, LLM_API_URL: 'http://d/v1', LLM_API_KEY: 'k' }).label, 'DeepSeek API')
})

test('document size limit is configurable and never truncates', () => {
  assert.equal(maxDocumentChars({}), DEFAULT_MAX_DOCUMENT_CHARS)
  assert.equal(maxDocumentChars({ UOM_MAX_DOC_CHARS: '140000' }), 140000)
  assert.equal(maxDocumentChars({ UOM_MAX_DOC_CHARS: 'abc' }), DEFAULT_MAX_DOCUMENT_CHARS)
  assert.equal(maxDocumentChars({ UOM_MAX_DOC_CHARS: '-5' }), DEFAULT_MAX_DOCUMENT_CHARS)

  const big = { name: 'big.md', blocks: [{ id: 'b1', text: '字'.repeat(120001) }] }
  let error
  try { validateDocument(big) } catch (caught) { error = caught }
  assert.ok(error, '超限必须报错而非截断')
  assert.equal(error.kind, 'document')
  assert.match(error.message, /120,001 字符/)
  assert.match(error.message, /UOM_MAX_DOC_CHARS/)
  assert.match(error.message, /不会截断正文/)

  const previous = process.env.UOM_MAX_DOC_CHARS
  process.env.UOM_MAX_DOC_CHARS = '200000'
  try { assert.doesNotThrow(() => validateDocument(big)) } finally {
    if (previous === undefined) delete process.env.UOM_MAX_DOC_CHARS
    else process.env.UOM_MAX_DOC_CHARS = previous
  }
})

test('parseModel extracts the JSON object from prose or code fences', () => {
  assert.deepEqual(parseModel('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseModel('先输出了一段规划文字。\n{"a":{"b":"文本"}}\n后缀说明'), { a: { b: '文本' } })
  // 字符串字面量里的括号不能干扰配平扫描
  assert.deepEqual(parseModel('说明 { 干扰\n{"q":"含 } 括号"}'), { q: '含 } 括号' })
})

test('parseModelWithMeta repairs truncated JSON and reports the recovery', () => {
  const truncated = '{"objects": [{"id": "o1", "name": "主体", "evidence": [{"blockId": "b1", "quote": "主体完成操'
  const { value, notices } = parseModelWithMeta(truncated)
  assert.equal(value.objects[0].id, 'o1')
  assert.equal(value.objects[0].evidence[0].quote, '主体完成操')
  assert.ok(notices.some((notice) => notice.includes('截断')))

  // 悬空的键名与冒号也要能闭合
  assert.deepEqual(parseModelWithMeta('{"a": 1, "b"').value, { a: 1, b: null })
  assert.deepEqual(parseModelWithMeta('{"a":').value, {})
  assert.deepEqual(parseModelWithMeta('{"list": [1, 2').value, { list: [1, 2] })
  // 数组里的未完成字符串元素直接闭合，不能错误地补成键值对
  assert.deepEqual(parseModelWithMeta('{"questions": ["待确认').value, { questions: ['待确认'] })
})

test('a truncated root object is repaired whole, not replaced by an inner fragment', () => {
  const truncated = '{"schemaVersion": "1", "name": "领域", "summary": "摘要", "objects": [{"id": "o1", "name": "主体", "description": "执行者", "properties": [], "evidence": []}], "relations": [], "actions": [], "functions": [], "rules": [], "activities": [], "questions": ["待确认'
  const { value, notices } = parseModelWithMeta(truncated)
  // 根对象必须被完整修复；若误取了内部的 objects 元素，schemaVersion 就会丢失
  assert.equal(value.schemaVersion, '1')
  assert.equal(value.objects[0].id, 'o1')
  assert.deepEqual(value.questions, ['待确认'])
  assert.ok(notices.some((notice) => notice.includes('截断')))
})

test('parseModel error carries an output preview so failures are diagnosable', () => {
  const garbage = 'Facts: need material explicit. Ensure no process step object.\n- 系统采用四层架构：数据源层、基础归集层。'
  let error
  try { parseModel(garbage) } catch (caught) { error = caught }
  assert.ok(error, '非 JSON 输出必须报错')
  assert.equal(error.kind, 'model')
  assert.match(error.message, /模型 JSON/)
  assert.match(error.message, /输出开头是/)
  assert.match(error.message, /系统采用四层架构/)
})

test('failures carry a kind so the UI can point at the right remedy', () => {
  const kinds = {}
  try { validateDocument(null) } catch (error) { kinds.document = error.kind }
  try { validateModel({ schemaVersion: 'nope' }, document) } catch (error) { kinds.model = error.kind }
  try { resolveProvider('nope', {}) } catch (error) { kinds.provider = error.kind }
  assert.deepEqual(kinds, { document: 'document', model: 'model', provider: 'provider' })
})
