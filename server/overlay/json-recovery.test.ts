import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseJsonOutputWithMeta,
  repairJsonText,
} from './json-recovery.ts'
import { validateCompiledModel } from '../validation/compiled-model.ts'
import { parseJsonOutput } from '../validation/values.ts'
import {
  DEFAULT_MAX_DOCUMENT_CHARS,
  documentLimitError,
  maxDocumentChars,
} from './document-limit.ts'

test('parseJsonOutputWithMeta extracts the JSON object from prose or code fences', () => {
  // 恢复后的 value 直接可用；无恢复时 notices 为空
  assert.deepEqual(parseJsonOutputWithMeta('```json\n{"a":1}\n```'), {
    value: { a: 1 },
    notices: [],
  })
  const prose = parseJsonOutputWithMeta(
    '先输出了一段规划文字。\n{"a":{"b":"文本"}}\n后缀说明',
  )
  assert.deepEqual(prose.value, { a: { b: '文本' } })
  assert.equal(prose.notices.length, 1)
  // 字符串字面量里的括号不能干扰配平扫描
  assert.deepEqual(parseJsonOutputWithMeta('说明 { 干扰\n{"q":"含 } 括号"}').value, {
    q: '含 } 括号',
  })
})

test('parseJsonOutputWithMeta repairs truncated JSON and reports the recovery', () => {
  const truncated =
    '{"objects": [{"id": "o1", "name": "主体", "evidence": [{"blockId": "b1", "quote": "主体完成操'
  const { value, notices } = parseJsonOutputWithMeta(truncated)
  assert.equal((value as { objects: { id: string }[] }).objects[0].id, 'o1')
  assert.ok(notices.some((notice) => notice.includes('截断')))

  // 悬空的键名与冒号也要能闭合
  assert.deepEqual(parseJsonOutputWithMeta('{"a": 1, "b"').value, {
    a: 1,
    b: null,
  })
  assert.deepEqual(parseJsonOutputWithMeta('{"a":').value, {})
  assert.deepEqual(parseJsonOutputWithMeta('{"list": [1, 2').value, {
    list: [1, 2],
  })
  // 数组里的未完成字符串元素直接闭合，不能错误地补成键值对
  assert.deepEqual(parseJsonOutputWithMeta('{"questions": ["待确认').value, {
    questions: ['待确认'],
  })
})

test('a truncated root object is repaired whole, not replaced by an inner fragment', () => {
  const truncated =
    '{"schemaVersion": "1", "name": "领域", "summary": "摘要", "objects": [{"id": "o1", "name": "主体", "description": "执行者", "properties": [], "evidence": []}], "relations": [], "actions": [], "functions": [], "rules": [], "activities": [], "questions": ["待确认'
  const { value, notices } = parseJsonOutputWithMeta(truncated)
  // 根对象必须被完整修复；若误取了内部的 objects 元素，schemaVersion 就会丢失
  assert.equal((value as { schemaVersion: string }).schemaVersion, '1')
  assert.ok(notices.some((notice) => notice.includes('截断')))
})

test('parseJsonOutput error carries an output preview so failures are diagnosable', () => {
  const garbage = 'Facts: need material explicit.\n- 系统采用四层架构：数据源层、基础归集层。'
  assert.throws(() => parseJsonOutput(garbage), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /不是有效的 JSON/)
    return true
  })
  assert.throws(
    () => repairJsonText(garbage, '模型整理结果'),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /不是有效的 JSON/)
      assert.match(error.message, /输出开头是/)
      assert.match(error.message, /系统采用四层架构/)
      return true
    },
  )
})

test('compile-stage recovery repairs the text upstream then validates strictly', () => {
  const model = {
    schemaVersion: '1',
    name: '领域',
    summary: '摘要',
    objects: [
      {
        id: 'o1',
        name: '主体',
        description: '执行者',
        properties: [],
        evidence: [],
      },
    ],
    relations: [],
    actions: [],
    functions: [],
    rules: [],
    activities: [
      {
        id: 'a1',
        name: '活动',
        goal: '目标',
        evidence: [],
        requirements: [
          {
            description: '要求',
            elements: ['o1'],
            status: 'partial',
            reason: '待支撑评估',
            evidence: [],
          },
        ],
      },
    ],
    boundaries: [],
  }
  // 去掉结尾的 “]}” 让根对象截断在 boundaries 数组处
  const truncated = JSON.stringify(model).slice(0, -2)
  const repaired = repairJsonText(truncated, '模型整理结果')
  assert.ok(repaired.notices.some((notice) => notice.includes('截断')))
  // 上游的严格校验器必须能直接通过恢复后的文本
  assert.equal(validateCompiledModel(repaired.text).objects[0].id, 'o1')
  // 干净输出不产生恢复提示，且原样返回
  const clean = repairJsonText(JSON.stringify(model), '模型整理结果')
  assert.deepEqual(clean.notices, [])
  assert.equal(clean.text, JSON.stringify(model))
})

test('document size limit is configurable via UOM_MAX_DOC_CHARS and never truncates', () => {
  assert.equal(maxDocumentChars({}), DEFAULT_MAX_DOCUMENT_CHARS)
  assert.equal(maxDocumentChars({ UOM_MAX_DOC_CHARS: '140000' }), 140000)
  assert.equal(
    maxDocumentChars({ UOM_MAX_DOC_CHARS: 'abc' }),
    DEFAULT_MAX_DOCUMENT_CHARS,
  )
  assert.equal(
    maxDocumentChars({ UOM_MAX_DOC_CHARS: '-5' }),
    DEFAULT_MAX_DOCUMENT_CHARS,
  )
  const document = { blocks: [{ text: 'a'.repeat(5) }] }
  assert.equal(documentLimitError({ document }, { UOM_MAX_DOC_CHARS: '10' }), undefined)
  const error = documentLimitError({ document }, { UOM_MAX_DOC_CHARS: '4' })
  assert.ok(error)
  assert.match(error, /UOM_MAX_DOC_CHARS/)
  assert.match(error, /5 字符/)
})
