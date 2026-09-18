import type { Project } from '../types.ts'
import { restoreProject } from '../persistence.ts'

/**
 * Named-project library on top of the draft autosave slot in main.tsx.
 *
 * The draft key keeps the backward-compatible "resume where I left off"
 * behavior; the library below turns saved drafts into selectable projects so
 * 新建 can always switch away without losing work.
 */

/** Minimal localStorage surface so the store stays unit-testable. */
export interface ProjectStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface ProjectSummary {
  id: string
  name: string
  updatedAt: number
}

export const PROJECT_INDEX_KEY = 'uom-forge-projects-v1'
export const ACTIVE_PROJECT_KEY = 'uom-forge-active-project-v1'
export const projectBodyKey = (id: string) => `uom-forge-project-v1-${id}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const UNTITLED = '未命名项目'
const EMPTY_DOCUMENT_NAME = '尚未上传业务文档'

/** Users recognise a draft by its document name; fall back to a stable label. */
export function projectDisplayName(project: Project): string {
  const name = project.document.name.trim()
  if (name && name !== EMPTY_DOCUMENT_NAME) return name
  return UNTITLED
}

/** Short local timestamp for the project dropdown; empty when unknown. */
export function projectTimestamp(updatedAt: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return ''
  const date = new Date(updatedAt)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function listProjects(storage: ProjectStorage): ProjectSummary[] {
  try {
    const parsed: unknown = JSON.parse(
      storage.getItem(PROJECT_INDEX_KEY) || '[]',
    )
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (item): item is Record<string, unknown> =>
          isRecord(item) && typeof item.id === 'string' && item.id !== '',
      )
      .map((item) => ({
        id: item.id as string,
        name:
          typeof item.name === 'string' && item.name.trim()
            ? item.name
            : UNTITLED,
        updatedAt:
          typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)
            ? item.updatedAt
            : 0,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

/** Restore one stored project; `null` when the body is missing or unreadable. */
export function readProject(
  storage: ProjectStorage,
  id: string,
  empty: Project,
): Project | null {
  if (!id) return null
  try {
    const raw = storage.getItem(projectBodyKey(id))
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value)) return null
    return restoreProject(value, empty)
  } catch {
    return null
  }
}

/** Upsert one project body and index row; returns the refreshed index. */
export function writeProject(
  storage: ProjectStorage,
  id: string,
  project: Project,
  now: number = Date.now(),
): ProjectSummary[] {
  const summary: ProjectSummary = {
    id,
    name: projectDisplayName(project),
    updatedAt: now,
  }
  const rest = listProjects(storage).filter((item) => item.id !== id)
  storage.setItem(projectBodyKey(id), JSON.stringify(project))
  const next = [summary, ...rest]
  storage.setItem(PROJECT_INDEX_KEY, JSON.stringify(next))
  return next
}

export function readActiveProjectId(storage: ProjectStorage): string {
  return storage.getItem(ACTIVE_PROJECT_KEY) || ''
}

export function writeActiveProjectId(
  storage: ProjectStorage,
  id: string,
): void {
  if (id) storage.setItem(ACTIVE_PROJECT_KEY, id)
  else storage.removeItem(ACTIVE_PROJECT_KEY)
}

/** Does this draft carry work worth keeping as a named project? */
export function projectHasContent(project: Project): boolean {
  return Boolean(
    project.document.content ||
      project.understanding ||
      project.plan ||
      project.candidate ||
      project.narration ||
      project.assessment,
  )
}
