import test from 'node:test'
import assert from 'node:assert/strict'
import type { Project } from './types.ts'
import { initialRevisions } from './workspace.ts'
import {
  ACTIVE_PROJECT_KEY,
  PROJECT_INDEX_KEY,
  listProjects,
  projectBodyKey,
  projectDisplayName,
  projectHasContent,
  projectTimestamp,
  readActiveProjectId,
  readProject,
  writeActiveProjectId,
  writeProject,
  type ProjectStorage,
} from './project-store.ts'

class MemoryStorage implements ProjectStorage {
  private items = new Map<string, string>()
  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }
  removeItem(key: string): void {
    this.items.delete(key)
  }
}

const empty: Project = {
  version: 4,
  document: { name: '', content: '', size: '', updated: '', blocks: [] },
  understanding: null,
  answers: {},
  questionsSaved: false,
  feedback: '',
  feedbackDocumentRevision: null,
  plan: null,
  candidate: null,
  narration: '',
  assessment: null,
  outputs: {},
  timings: {},
  revisions: initialRevisions,
  messages: [],
}

const withDocument = (name: string, content: string): Project => ({
  ...empty,
  document: { ...empty.document, name, content, size: '1 KB', updated: '今天' },
})

test('saved projects keep one index row per id, newest first, named by document', () => {
  const storage = new MemoryStorage()
  writeProject(storage, 'a', withDocument('融资租赁流程', '正文'), 1000)
  writeProject(storage, 'b', withDocument('供电抢修', '正文'), 2000)
  assert.deepEqual(
    listProjects(storage).map(({ id, name, updatedAt }) => [id, name, updatedAt]),
    [
      ['b', '供电抢修', 2000],
      ['a', '融资租赁流程', 1000],
    ],
  )

  // Re-saving the active project updates its row instead of appending a copy.
  writeProject(storage, 'a', withDocument('融资租赁流程（修订）', '正文'), 3000)
  assert.deepEqual(
    listProjects(storage).map(({ id, name, updatedAt }) => [id, name, updatedAt]),
    [
      ['a', '融资租赁流程（修订）', 3000],
      ['b', '供电抢修', 2000],
    ],
  )
  assert.equal(
    JSON.parse(storage.getItem(PROJECT_INDEX_KEY) || '[]').length,
    2,
  )
})

test('untitled drafts still get a readable label and a fallback timestamp', () => {
  assert.equal(projectDisplayName(empty), '未命名项目')
  assert.equal(
    projectDisplayName(withDocument('尚未上传业务文档', '正文')),
    '未命名项目',
  )
  assert.equal(projectTimestamp(0), '')
  assert.equal(projectTimestamp(new Date(2026, 8, 14, 3, 5).getTime()), '09-14 03:05')
})

test('stored projects restore through the draft decoder and missing ids read as null', () => {
  const storage = new MemoryStorage()
  writeProject(storage, 'project-1', withDocument('供电抢修', '正文内容'), 1000)
  const restored = readProject(storage, 'project-1', empty)
  assert.ok(restored)
  assert.equal(restored.document.name, '供电抢修')
  assert.equal(restored.document.content, '正文内容')
  assert.equal(restored.version, 4)

  assert.equal(readProject(storage, 'missing', empty), null)
  assert.equal(readProject(storage, '', empty), null)
  storage.setItem(projectBodyKey('broken'), 'not json')
  assert.equal(readProject(storage, 'broken', empty), null)
  storage.setItem(projectBodyKey('number'), '42')
  assert.equal(readProject(storage, 'number', empty), null)
})

test('active project id survives storage and clears without leftovers', () => {
  const storage = new MemoryStorage()
  assert.equal(readActiveProjectId(storage), '')
  writeActiveProjectId(storage, 'project-1')
  assert.equal(storage.getItem(ACTIVE_PROJECT_KEY), 'project-1')
  assert.equal(readActiveProjectId(storage), 'project-1')
  writeActiveProjectId(storage, '')
  assert.equal(storage.getItem(ACTIVE_PROJECT_KEY), null)
})

test('empty drafts are not registered and corrupt indexes degrade to an empty list', () => {
  assert.equal(projectHasContent(empty), false)
  assert.equal(projectHasContent(withDocument('空文档', '')), false)
  assert.equal(projectHasContent(withDocument('空文档', '内容')), true)

  const storage = new MemoryStorage()
  storage.setItem(PROJECT_INDEX_KEY, '{ not json')
  assert.deepEqual(listProjects(storage), [])
  storage.setItem(PROJECT_INDEX_KEY, JSON.stringify([{ id: 1 }, { name: 'x' }]))
  assert.deepEqual(listProjects(storage), [])
})
