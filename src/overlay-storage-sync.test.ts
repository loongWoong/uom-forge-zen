import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVE_PROJECT_KEY,
  DRAFT_KEY,
  listProjects,
  persistDraft,
  readActiveProjectId,
  writeActiveProjectId,
} from './overlay/storage-sync.ts'
import { PROJECT_INDEX_KEY } from './overlay/project-store.ts'
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
