import { createRoot, type Root } from 'react-dom/client'
import './styles.css'
import { installRequestOverride } from './request-override.ts'
import { installStorageSync } from './storage-sync.ts'
import { TopbarOverlay } from './topbar.tsx'

/**
 * Overlay client entry, injected into `index.html` before upstream's
 * `/src/main.tsx`. It patches `window.fetch` and `Storage.setItem` first (so
 * they are in place before the app runs), then mounts the model picker and
 * project library into the topbar once upstream has rendered it.
 */

const HOST_ID = 'uom-forge-overlay'

installRequestOverride()
installStorageSync()

let root: Root | null = null

function mount(): boolean {
  if (document.getElementById(HOST_ID)) return true
  const actions = document.querySelector('.topbar-actions')
  if (!actions) return false
  const host = document.createElement('div')
  host.id = HOST_ID
  host.className = 'overlay-topbar'
  const toggle = actions.querySelector('.assistant-toggle')
  actions.insertBefore(host, toggle)
  root?.unmount()
  root = createRoot(host)
  root.render(<TopbarOverlay />)
  return true
}

function start(): void {
  if (mount()) {
    // React owns the topbar; if a future upstream re-render ever drops our
    // host, put it back instead of silently losing the overlay.
    const topbar = document.querySelector('.topbar') ?? document.body
    const observer = new MutationObserver(() => {
      if (!document.getElementById(HOST_ID)) mount()
    })
    observer.observe(topbar, { childList: true, subtree: true })
    return
  }
  const observer = new MutationObserver(() => {
    if (mount()) observer.disconnect()
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', start, { once: true })
else start()
