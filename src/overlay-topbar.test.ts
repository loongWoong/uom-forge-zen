import test from 'node:test'
import assert from 'node:assert/strict'
import * as React from 'react'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// tsx transpiles .tsx with the classic JSX runtime (the root tsconfig.json has
// no `jsx` setting; tsx does not read tsconfig.app.json), so overlay components
// compiled on the fly expect a global React binding.
;(globalThis as Record<string, unknown>).React = React

// Imported through a non-literal specifier: the root tsconfig (which typechecks
// src/*.test.ts) has no `jsx` option and would reject a direct .tsx import.
const overlayModule = './overlay/topbar.tsx'
const { TopbarOverlay } = (await import(overlayModule)) as {
  TopbarOverlay: ComponentType
}

/**
 * Renders the overlay topbar without a browser. This catches render-time
 * crashes and verifies how the UI reads the upstream topbar (selected provider,
 * busy flag) and the stored model override.
 */

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.has(key) ? (this.values.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
  clear(): void {
    this.values.clear()
  }
}

interface FakeButton {
  disabled: boolean
  textContent: string
  getAttribute(name: string): string | null
}

function fakeProviderGroup(
  names: string[],
  pressedIndex: number,
  busy = false,
): { querySelectorAll: () => FakeButton[] } {
  const buttons: FakeButton[] = names.map((name, index) => ({
    disabled: busy,
    textContent: name,
    getAttribute: (attribute: string) =>
      attribute === 'aria-pressed' ? String(index === pressedIndex) : null,
  }))
  return { querySelectorAll: () => buttons }
}

async function render(
  buttonNames: string[],
  pressedIndex: number,
  options: { busy?: boolean; overrides?: Record<string, string> } = {},
): Promise<string> {
  const globalObject = globalThis as Record<string, unknown>
  const previousDocument = globalObject.document
  const previousStorage = globalObject.localStorage
  const storage = new MemoryStorage()
  for (const [key, value] of Object.entries(options.overrides ?? {}))
    storage.setItem(key, value)
  globalObject.localStorage = storage
  globalObject.document = {
    querySelector: (selector: string) =>
      selector === '[aria-label="推理提供方"]'
        ? fakeProviderGroup(buttonNames, pressedIndex, options.busy)
        : null,
  }
  try {
    return renderToStaticMarkup(createElement(TopbarOverlay))
  } finally {
    if (previousDocument === undefined) delete globalObject.document
    else globalObject.document = previousDocument
    if (previousStorage === undefined) delete globalObject.localStorage
    else globalObject.localStorage = previousStorage
  }
}

test('the overlay topbar renders the model picker and project library', async () => {
  const html = await render(['DeepSeek', 'GPT', 'Qwen'], 0)
  assert.match(html, /provider-model/)
  assert.match(html, /新建项目/)
  assert.match(html, /打开已保存的项目/)
  assert.match(html, /暂无已保存项目/)
  assert.match(html, />DS</) // DeepSeek badge
})

test('the selected upstream provider drives the picker and stored override', async () => {
  const html = await render(['DeepSeek', 'GPT', 'Qwen'], 1, {
    overrides: { 'uom-forge-model-gpt': 'gpt-6-custom' },
  })
  assert.match(html, />GPT</) // GPT badge
  assert.match(html, /gpt-6-custom/)
  assert.doesNotMatch(html, />DS</)
})

test('busy upstream buttons disable the overlay actions', async () => {
  const html = await render(['DeepSeek', 'GPT', 'Qwen'], 0, { busy: true })
  assert.match(html, /disabled=""/)
})

test('saved projects appear in the selector', async () => {
  const html = await render(['DeepSeek', 'GPT', 'Qwen'], 0, {
    overrides: {
      'uom-forge-projects-v1': JSON.stringify([
        { id: 'p1', name: '业务文档 A', updatedAt: 1700000000000 },
      ]),
    },
  })
  assert.match(html, /业务文档 A/)
  assert.doesNotMatch(html, /暂无已保存项目/)
})
