import test from 'node:test'
import assert from 'node:assert/strict'
import type { StageEvent } from '../../shared/analysis.ts'
import { PiModelError } from '../agents/runtime.ts'
import { withPiFallback } from './fallback.ts'

function withFallbackEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const saved = process.env.UOM_PI_FALLBACK
  if (value === undefined) delete process.env.UOM_PI_FALLBACK
  else process.env.UOM_PI_FALLBACK = value
  return run().finally(() => {
    if (saved === undefined) delete process.env.UOM_PI_FALLBACK
    else process.env.UOM_PI_FALLBACK = saved
  })
}

test('UOM_PI_FALLBACK=direct retries an eligible first-turn Pi failure with the direct client', async () => {
  await withFallbackEnv('direct', async () => {
    const events: StageEvent[] = []
    const result = await withPiFallback(
      { onEvent: (event) => events.push(event) },
      'semantic',
      async () => {
        throw new PiModelError('Pi 语义建模模型调用失败：400 tools unsupported', true)
      },
      async () => 'direct-plan',
    )
    assert.equal(result, 'direct-plan')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'phase')
    assert.match((events[0] as { text: string }).text, /已降级为直接调用/)
    assert.match((events[0] as { text: string }).text, /tools unsupported/)
  })
})

test('the fallback stays off by default and never hides a partially executed loop', async () => {
  await withFallbackEnv(undefined, async () => {
    await assert.rejects(
      withPiFallback(
        {},
        'semantic',
        async () => {
          throw new PiModelError('first turn failed', true)
        },
        async () => 'direct-plan',
      ),
      /first turn failed/,
    )
  })
  await withFallbackEnv('direct', async () => {
    // A tool already ran, so restarting the stage with another runtime is unsafe.
    await assert.rejects(
      withPiFallback(
        {},
        'semantic',
        async () => {
          throw new PiModelError('later turn failed', false)
        },
        async () => 'direct-plan',
      ),
      /later turn failed/,
    )
  })
})

test('unrelated errors and invalid fallback values still fail the stage', async () => {
  await withFallbackEnv('direct', async () => {
    await assert.rejects(
      withPiFallback(
        {},
        'reading',
        async () => {
          throw new Error('业务说明为空')
        },
        async () => 'direct',
      ),
      /业务说明为空/,
    )
  })
  await withFallbackEnv('gpt', async () => {
    await assert.rejects(
      withPiFallback(
        {},
        'reading',
        async () => {
          throw new PiModelError('boom', true)
        },
        async () => 'direct',
      ),
      /UOM_PI_FALLBACK 只支持 direct/,
    )
  })
})
