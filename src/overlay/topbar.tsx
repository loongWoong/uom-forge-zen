import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, FilePlus2, Save } from 'lucide-react'
import type { ProviderId } from '../../shared/analysis.ts'
import { PROVIDERS } from '../../shared/analysis.ts'
import {
  DRAFT_KEY,
  listProjects,
  persistDraft,
  projectBodyKey,
  readActiveProjectId,
  withSuppressedMirror,
  writeActiveProjectId,
} from './storage-sync.ts'
import { modelOverrideFor, writeModelOverride } from './request-override.ts'
import { projectTimestamp, type ProjectSummary } from './project-store.ts'

/**
 * The overlay UI is mounted into upstream's `.topbar-actions` from the outside:
 * the state that matters (selected provider, busy flag) is read back from the
 * DOM the upstream React tree renders, and the model override is applied to
 * requests by the fetch decorator. Nothing in upstream's component tree changes.
 */

const PROVIDER_IDS: ProviderId[] = ['deepseek', 'gpt', 'qwen']

interface ProviderConfig {
  provider: ProviderId
  model: string
  runtime?: string
  options: { value: ProviderId; model: string; ready: boolean }[]
}

interface Selection {
  provider: ProviderId
  busy: boolean
}

function readSelection(): Selection {
  const group = document.querySelector('[aria-label="推理提供方"]')
  if (!group) return { provider: 'deepseek', busy: false }
  const buttons = Array.from(group.querySelectorAll('button'))
  const busy = buttons.some((button) => button.disabled)
  const pressed = buttons.find(
    (button) => button.getAttribute('aria-pressed') === 'true',
  )
  if (!pressed) return { provider: 'deepseek', busy }
  const name = pressed.textContent?.trim() || ''
  const byName = PROVIDER_IDS.find((id) => PROVIDERS[id].name === name)
  if (byName) return { provider: byName, busy }
  const index = buttons.indexOf(pressed)
  return { provider: PROVIDER_IDS[index] ?? 'deepseek', busy }
}

function useUpstreamSelection(): Selection {
  const [selection, setSelection] = useState<Selection>(readSelection)
  useEffect(() => {
    let scheduled = false
    const update = () => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        setSelection((current) => {
          const next = readSelection()
          return next.provider === current.provider && next.busy === current.busy
            ? current
            : next
        })
      })
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-pressed', 'disabled'],
    })
    return () => observer.disconnect()
  }, [])
  return selection
}

function ModelPicker({ provider, busy }: { provider: ProviderId; busy: boolean }) {
  const [config, setConfig] = useState<ProviderConfig | null>(null)
  const [open, setOpen] = useState(false)
  const [override, setOverride] = useState(() => modelOverrideFor(provider))
  const [models, setModels] = useState<Partial<Record<ProviderId, string[] | null>>>({})
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setOverride(modelOverrideFor(provider))
    setOpen(false)
  }, [provider])

  useEffect(() => {
    let cancelled = false
    fetch('/api/config')
      .then((response) => (response.ok ? response.json() : null))
      .then((value: ProviderConfig | null) => {
        if (!cancelled && value && Array.isArray(value.options)) setConfig(value)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node))
        setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const defaultModel =
    config?.options.find((option) => option.value === provider)?.model || ''
  const effective = override || defaultModel || '模型'

  const openPicker = () => {
    setDraft(override || defaultModel)
    setError('')
    setOpen(true)
    if (models[provider] === undefined)
      fetch('/api/models?provider=' + provider)
        .then((response) =>
          response.ok
            ? response.json()
            : Promise.reject(new Error('HTTP ' + response.status)),
        )
        .then((data: { models?: string[] }) =>
          setModels((current) => ({
            ...current,
            [provider]: Array.isArray(data.models) ? data.models : [],
          })),
        )
        .catch((failure: Error) => setError(failure.message))
  }

  const apply = (value: string) => {
    const next = value.trim()
    const normalized = next && next !== defaultModel ? next : ''
    writeModelOverride(provider, normalized)
    setOverride(normalized)
    setOpen(false)
  }

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="provider-model"
        title="点击切换模型"
        disabled={busy}
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        <ProviderBadge provider={provider} />
        {effective}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="model-popover" role="dialog" aria-label="切换模型">
          <strong>{PROVIDERS[provider].name} 模型</strong>
          <div className="model-list">
            {models[provider] === undefined && !error && (
              <small>正在获取模型列表…</small>
            )}
            {error && (
              <small className="model-error">
                {error}，可直接输入模型 id。
              </small>
            )}
            {models[provider]?.map((id) => (
              <button
                key={id}
                type="button"
                className={id === draft ? 'active' : ''}
                onClick={() => setDraft(id)}
              >
                {id}
              </button>
            ))}
          </div>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="模型 id"
            aria-label="模型 id"
          />
          <div className="model-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => apply(draft)}
            >
              应用
            </button>
            {override && (
              <button
                type="button"
                onClick={() => apply(defaultModel)}
              >
                恢复默认
              </button>
            )}
            <button type="button" onClick={() => setOpen(false)}>
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ProviderBadge({ provider }: { provider: ProviderId }) {
  return (
    <span className="overlay-provider-badge" aria-hidden="true">
      {PROVIDERS[provider].name.slice(0, 2)}
    </span>
  )
}

function ProjectLibrary({
  busy,
  notify,
}: {
  busy: boolean
  notify: (message: string) => void
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>(() =>
    listProjects(localStorage),
  )
  const [activeId, setActiveId] = useState(() =>
    readActiveProjectId(localStorage),
  )

  const refresh = () => {
    setProjects(listProjects(localStorage))
    setActiveId(readActiveProjectId(localStorage))
  }

  // Upstream's save button writes its freshest in-memory project synchronously;
  // clicking it (the storage decorator mirrors the write) beats waiting for the
  // 800 ms autosave debounce before switching projects.
  const flushDraft = () => {
    const upstreamSave = document.querySelector<HTMLButtonElement>(
      'button[aria-label="保存草稿"]',
    )
    if (upstreamSave && !upstreamSave.disabled) upstreamSave.click()
    else persistDraft(localStorage.getItem(DRAFT_KEY))
  }

  useEffect(() => {
    const timer = window.setInterval(refresh, 3000)
    return () => window.clearInterval(timer)
  }, [])

  const openProject = (id: string) => {
    if (!id || id === activeId) return
    const body = localStorage.getItem(projectBodyKey(id))
    if (!body) {
      notify('该项目已不存在，可能已被清理。')
      refresh()
      return
    }
    flushDraft()
    withSuppressedMirror(() => {
      writeActiveProjectId(localStorage, id)
      localStorage.setItem(DRAFT_KEY, body)
    })
    window.location.reload()
  }

  const createProject = () => {
    flushDraft()
    withSuppressedMirror(() => {
      writeActiveProjectId(localStorage, '')
      localStorage.removeItem(DRAFT_KEY)
    })
    window.location.reload()
  }

  const saveLibrary = () => {
    flushDraft()
    refresh()
    notify('项目已保存')
  }

  return (
    <div className="project-actions">
      <select
        className="project-select"
        aria-label="打开已保存的项目"
        title="打开已保存的项目"
        value={activeId}
        disabled={busy || projects.length === 0}
        onFocus={refresh}
        onChange={(event) => openProject(event.target.value)}
      >
        <option value="">
          {projects.length === 0
            ? '暂无已保存项目'
            : activeId
              ? '选择其他项目'
              : '打开已保存的项目'}
        </option>
        {projects.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
            {item.updatedAt ? ` · ${projectTimestamp(item.updatedAt)}` : ''}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="icon-button project-button"
        aria-label="新建项目"
        title="新建项目（当前草稿会保存在项目库）"
        disabled={busy}
        onClick={createProject}
      >
        <FilePlus2 size={18} />
      </button>
      <button
        type="button"
        className="icon-button project-button"
        aria-label="保存到项目库"
        title="保存到项目库"
        disabled={busy}
        onClick={saveLibrary}
      >
        <Save size={18} />
      </button>
    </div>
  )
}

export function TopbarOverlay(): ReactNode {
  const { provider, busy } = useUpstreamSelection()
  const [toast, setToast] = useState('')

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  return (
    <>
      <ModelPicker provider={provider} busy={busy} />
      <ProjectLibrary busy={busy} notify={setToast} />
      {toast && (
        <div className="overlay-toast" role="status">
          {toast}
        </div>
      )}
    </>
  )
}
