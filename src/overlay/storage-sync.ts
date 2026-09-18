import { createId } from '../id.ts'
import {
  ACTIVE_PROJECT_KEY,
  PROJECT_INDEX_KEY,
  projectBodyKey,
  listProjects,
  projectHasContent,
  readActiveProjectId,
  writeActiveProjectId,
  writeProject,
  type ProjectSummary,
  type ProjectStorage,
} from './project-store.ts'
import type { Project } from '../types.ts'

/**
 * Storage decorator that mirrors upstream's draft autosave into the local
 * project library.
 *
 * Upstream autosaves the whole workspace into `uom-forge-project-v3` and knows
 * nothing about named projects. Wrapping `Storage.setItem` lets the overlay
 * register/update the active library row on every autosave, so "新建项目" can
 * always switch away without losing the current draft — the same guarantee the
 * previous in-component implementation provided.
 */

export const DRAFT_KEY = 'uom-forge-project-v3'
export { ACTIVE_PROJECT_KEY, PROJECT_INDEX_KEY, projectBodyKey, listProjects, readActiveProjectId, writeActiveProjectId }

let suppressed = false

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The raw draft is upstream's own Project JSON; only trust well-formed ones. */
function asProject(value: unknown): Project | null {
  if (!isRecord(value) || !isRecord(value.document)) return null
  if (typeof value.document.name !== 'string') return null
  return value as unknown as Project
}

/**
 * Upsert the draft into the library. Returns the refreshed index, or null when
 * the value cannot be understood (the mirror must never break autosave).
 */
export function persistDraft(
  raw: string | null,
  storage: ProjectStorage = localStorage,
): ProjectSummary[] | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  const project = asProject(parsed)
  if (!project) return null
  const activeId = readActiveProjectId(storage)
  if (activeId) return writeProject(storage, activeId, project)
  if (!projectHasContent(project)) return listProjects(storage)
  const projects = writeProject(storage, createId(), project)
  const created = projects[0]?.id || ''
  writeActiveProjectId(storage, created)
  return projects
}

/** Run library writes that must not bump the active row's timestamp. */
export function withSuppressedMirror<T>(run: () => T): T {
  suppressed = true
  try {
    return run()
  } finally {
    suppressed = false
  }
}

let installed = false

export function installStorageSync(): void {
  if (installed) return
  installed = true
  const originalSetItem = Storage.prototype.setItem
  Storage.prototype.setItem = function setItem(key: string, value: string): void {
    originalSetItem.call(this, key, value)
    if (suppressed || key !== DRAFT_KEY) return
    try {
      persistDraft(value, this)
    } catch {
      // never let the mirror break upstream's autosave
    }
  }
}
