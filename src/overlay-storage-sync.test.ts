import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVE_PROJECT_KEY,
  DRAFT_KEY,
  armProjectLoad,
  armedProjectLoad,
  disarmProjectLoad,
  installStorageSync,
  listProjects,
  persistDraft,
  readActiveProjectId,
  writeActiveProjectId,
} from './overlay/storage-sync.ts'
import { PROJECT_INDEX_KEY, projectBodyKey } from './overlay/project-store.ts'
import type { ProjectStorage } from './overlay/project-store.ts'

class MemoryStorage implements ProjectStorage {
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
}

/** Project-shaped payload; the library only needs a document and a name. */
const draft = (name: string, content = 'text') =>
  JSON.stringify({
    document: { name, content, blocks: [] },
    understanding: null,
    plan: null,
    candidate: null,
    narration: '',
    assessment: null,
  })

test('persistDraft registers the first draft as a named project', () => {
  const storage = new MemoryStorage()
  const projects = persistDraft(draft('业务文档 A'), storage)
  assert.ok(projects)
  assert.equal(projects.length, 1)
  assert.equal(projects[0].name, '业务文档 A')
  const active = readActiveProjectId(storage)
  assert.equal(active, projects[0].id)
  assert.match(storage.getItem(PROJECT_INDEX_KEY) || '', /业务文档 A/)
})

test('persistDraft updates the active row instead of creating new ones', () => {
  const storage = new MemoryStorage()
  const first = persistDraft(draft('业务文档 A'), storage)
  assert.ok(first)
  const second = persistDraft(draft('业务文档 A', 'more text'), storage)
  assert.ok(second)
  assert.equal(second.length, 1)
  assert.equal(second[0].id, first[0].id)
})

test('an empty draft is not registered and never breaks autosave', () => {
  const storage = new MemoryStorage()
  const projects = persistDraft(
    JSON.stringify({ document: { name: '尚未上传业务文档', content: '' } }),
    storage,
  )
  assert.deepEqual(projects, [])
  assert.equal(readActiveProjectId(storage), '')
  assert.equal(persistDraft('not json', storage), null)
  assert.equal(persistDraft('{"document":"nope"}', storage), null)
})

test('switching projects writes the draft key and active pointer', () => {
  const storage = new MemoryStorage()
  const projects = persistDraft(draft('A'), storage)
  assert.ok(projects)
  const id = projects[0].id
  writeActiveProjectId(storage, '')
  assert.equal(readActiveProjectId(storage), '')
  storage.setItem(DRAFT_KEY, draft('A'))
  storage.setItem(ACTIVE_PROJECT_KEY, id)
  assert.equal(readActiveProjectId(storage), id)
  assert.equal(listProjects(storage).length, 1)
})

/**
 * Regression: upstream saves its in-memory workspace on `beforeunload` (and
 * 800 ms after every change). Written through the plain decorator, that stale
 * workspace replaced the project being loaded and overwrote the library row of
 * the newly active project, so a switch kept showing the last run's results.
 */
class FakeStorage extends MemoryStorage {}
const globals = globalThis as Record<string, unknown>
globals.Storage = FakeStorage
const decorated = new FakeStorage()
globals.localStorage = decorated
installStorageSync()

test('an armed load cannot be overwritten by a late upstream save', () => {
  try {
    const projects = persistDraft(draft('A'), decorated)
    assert.ok(projects)
    const idA = projects[0].id
    // persistDraft mirrors the current draft into the active row on autosave
    assert.equal(decorated.getItem(projectBodyKey(idA)), draft('A'))

    armProjectLoad(idA, draft('A'), decorated)
    assert.equal(armedProjectLoad(), true)
    assert.equal(readActiveProjectId(decorated), idA)
    assert.equal(decorated.getItem(DRAFT_KEY), draft('A'))

    // upstream's beforeunload / pending autosave writes the project it still
    // holds in memory: the pin keeps the loaded project, and nothing is mirrored
    decorated.setItem(DRAFT_KEY, draft('B'))
    assert.equal(decorated.getItem(DRAFT_KEY), draft('A'))
    assert.equal(decorated.getItem(projectBodyKey(idA)), draft('A'))
    assert.equal(listProjects(decorated).length, 1)

    // 新建项目 stays empty even if upstream saves on unload
    armProjectLoad('', null, decorated)
    assert.equal(decorated.getItem(DRAFT_KEY), null)
    assert.equal(readActiveProjectId(decorated), '')
    decorated.setItem(DRAFT_KEY, draft('B'))
    assert.equal(decorated.getItem(DRAFT_KEY), null)
    assert.equal(listProjects(decorated).length, 1)
  } finally {
    disarmProjectLoad()
    decorated.values.clear()
  }
  assert.equal(armedProjectLoad(), false)
})

test('after a page load the decorator mirrors autosave again', () => {
  // A real page load resets this module; the flag is the only thing standing
  // between "switch in flight" and normal autosave mirroring.
  disarmProjectLoad()
  const projects = persistDraft(draft('C'), decorated)
  assert.ok(projects)
  const id = readActiveProjectId(decorated)
  assert.equal(id, projects[0].id)
  decorated.setItem(DRAFT_KEY, draft('C', 'edited'))
  assert.match(decorated.getItem(projectBodyKey(id)) || '', /edited/)
})

test('a library write that fails is reported instead of swallowed', () => {
  const events: string[] = []
  const fakeWindow = {
    dispatchEvent: (event: { detail?: { message?: string } }) => {
      events.push(event.detail?.message || '')
      return true
    },
  }
  const previousWindow = globals.window
  const previousCustomEvent = globals.CustomEvent
  globals.window = fakeWindow
  globals.CustomEvent = class {
    detail: unknown
    constructor(_type: string, init?: { detail?: unknown }) {
      this.detail = init?.detail
    }
  }
  try {
    // the project body cannot be stored, e.g. the quota is exhausted
    const failing = new FakeStorage()
    const originalSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function setItem(key: string, value: string) {
      if (key.startsWith('uom-forge-project-v1-')) throw new Error('QuotaExceededError')
      originalSetItem.call(this, key, value)
    }
    try {
      // write through the decorator: the mirror runs and must report the failure
      disarmProjectLoad()
      failing.setItem(DRAFT_KEY, draft('D'))
    } finally {
      Storage.prototype.setItem = originalSetItem
    }
    assert.equal(events.length, 1)
    assert.match(events[0], /项目库保存失败/)
    assert.match(events[0], /QuotaExceededError/)
  } finally {
    globals.window = previousWindow
    globals.CustomEvent = previousCustomEvent
  }
})
