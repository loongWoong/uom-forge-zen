import test from 'node:test'
import assert from 'node:assert/strict'
import type { RunTurn } from '../providers/types.ts'
import { createContext, overlayContext } from './context.ts'
import { createOverlayRunTurn } from './run-turn.ts'

test('decorated runTurn repairs truncated JSON and records a labelled notice', async () => {
  const base: RunTurn = async (_prompt, options = {}) => {
    const onEvent = options.onEvent as
      | ((event: { type: 'phase'; part: string; text: string }) => void)
      | undefined
    onEvent?.({ type: 'phase', part: 'compile', text: '正在整理候选模型。' })
    return '{"objects":[{"id":"o1","properties":[]'
  }
  const run = createOverlayRunTurn(base)
  const context = createContext({ provider: 'deepseek' })
  const text = await overlayContext.run(context, () =>
    run('prompt', {
      provider: 'deepseek',
      outputFormat: 'json',
      onEvent: (event) => void event,
    }),
  )
  assert.deepEqual(JSON.parse(text), { objects: [{ id: 'o1', properties: [] }] })
  assert.equal(context.notices.length, 1)
  assert.match(context.notices[0], /模型整理结果/)
  assert.match(context.notices[0], /截断/)
})

test('clean JSON and non-JSON output pass through unchanged', async () => {
  const base: RunTurn = async (prompt) =>
    prompt === 'json' ? '{"ok":true}' : '## 业务概述\n说明。'
  const run = createOverlayRunTurn(base)
  const context = createContext({})
  const clean = await overlayContext.run(context, () =>
    run('json', { outputFormat: 'json' }),
  )
  assert.equal(clean, '{"ok":true}')
  assert.deepEqual(context.notices, [])
  const text = await overlayContext.run(context, () => run('text', {}))
  assert.equal(text, '## 业务概述\n说明。')
  assert.deepEqual(context.notices, [])
})

test('a provider rejection propagates unchanged', async () => {
  const base: RunTurn = async () => {
    throw new Error('DeepSeek 请求失败：HTTP 400')
  }
  const run = createOverlayRunTurn(base)
  await assert.rejects(
    () => overlayContext.run(createContext({}), () => run('p', {})),
    /HTTP 400/,
  )
})
