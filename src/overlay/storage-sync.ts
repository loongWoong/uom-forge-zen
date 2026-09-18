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

/**
 * Project load in flight. While armed, every write to the draft key is pinned
 * to the project being loaded (`null` = keep the key absent for 新建项目) and
 * nothing is mirrored.
 *
 * Upstream rewrites the draft from its **in-memory** workspace on `beforeunload`
 * and 800 ms after the last change. A switch writes the target project into the
 * draft slot and reloads, so without the pin upstream would restore the project
 * that is being left behind — and that stale workspace would then be mirrored
 * into the newly active project, corrupting the library (the whole workspace
 * kept showing the last run's results).
 */
let pendingLoad: { raw: string | null } | null = null

export function armedProjectLoad(): boolean {
  return pendingLoad !== null
}

/** Cancel an armed load (page loads reset this module state anyway). */
export function disarmProjectLoad(): void {
  pendingLoad = null
}

/** Fired when the project library could not store a draft (quota, private mode). */
export const STORAGE_ERROR_EVENT = 'uom-forge-storage-error'

function reportStorageError(error: unknown): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(
      new CustomEvent(STORAGE_ERROR_EVENT, {
        detail: {
          message: `项目库保存失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      }),
    )
  } catch {
    // reporting must never break upstream's autosave
  }
}

/**
 * Point the workspace at one project (or at a fresh one) and reload.
 * `activeId` is the library row to keep writing into; `raw` is that project's
 * stored body, or null for 新建项目.
 */
export function armProjectLoad(
  activeId: string,
  raw: string | null,
  storage: ProjectStorage = localStorage,
): void {
  pendingLoad = { raw }
  writeActiveProjectId(storage, activeId)
  if (raw === null) storage.removeItem(DRAFT_KEY)
  else storage.setItem(DRAFT_KEY, raw)
}

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

let installed = false

export function installStorageSync(): void {
  if (installed) return
  installed = true
  const originalSetItem = Storage.prototype.setItem
  const originalRemoveItem = Storage.prototype.removeItem
  Storage.prototype.setItem = function setItem(key: string, value: string): void {
    if (key === DRAFT_KEY && pendingLoad) {
      // A switch or 新建项目 is loading: whoever writes (autosave, unload save)
      // must not replace the project we are about to load, and must never be
      // mirrored into a library row.
      if (pendingLoad.raw === null) originalRemoveItem.call(this, key)
      else originalSetItem.call(this, key, pendingLoad.raw)
      return
    }
    originalSetItem.call(this, key, value)
    if (key !== DRAFT_KEY) return
    try {
      persistDraft(value, this)
    } catch (error) {
      // never let the mirror break upstream's autosave, but never lose a project
      // silently either
      reportStorageError(error)
    }
  }
}
