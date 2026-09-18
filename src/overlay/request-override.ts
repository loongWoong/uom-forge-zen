import type { ProviderId } from '../../shared/analysis.ts'

/**
 * Client-side fetch decorator: injects the picker's per-provider model override
 * into the upstream requests. Upstream's `main.tsx` builds its own request
 * bodies and knows nothing about the overlay, so this is the seam that makes
 * the switcher work without editing it.
 */

const OVERRIDE_PREFIX = 'uom-forge-model-'
const PROVIDERS: ProviderId[] = ['deepseek', 'gpt', 'qwen']

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDERS as string[]).includes(value)
}

export function modelOverrideFor(
  provider: ProviderId,
  storage: Storage = localStorage,
): string {
  return storage.getItem(OVERRIDE_PREFIX + provider)?.trim() || ''
}

export function writeModelOverride(
  provider: ProviderId,
  value: string,
  storage: Storage = localStorage,
): void {
  const trimmed = value.trim()
  if (trimmed) storage.setItem(OVERRIDE_PREFIX + provider, trimmed)
  else storage.removeItem(OVERRIDE_PREFIX + provider)
}

const OVERRIDE_PATHS = new Set(['/api/analyze', '/api/analyze/stream', '/api/discuss'])

/**
 * Wrap a fetch implementation with the override injection. Exported for tests;
 * the browser entry uses `installRequestOverride`.
 */
export function decorateFetch(
  original: typeof fetch,
  locationHref: string,
  storage: Storage = localStorage,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    let next = init
    if (
      init &&
      typeof init.body === 'string' &&
      (init.method || 'GET').toUpperCase() === 'POST'
    ) {
      try {
        const pathname = new URL(url, locationHref).pathname
        if (OVERRIDE_PATHS.has(pathname)) {
          const body: unknown = JSON.parse(init.body)
          if (
            body &&
            typeof body === 'object' &&
            !Array.isArray(body) &&
            isProviderId((body as Record<string, unknown>).provider) &&
            typeof (body as Record<string, unknown>).modelOverride !== 'string'
          ) {
            const provider = (body as Record<string, unknown>).provider as ProviderId
            const override = modelOverrideFor(provider, storage)
            if (override)
              next = {
                ...init,
                body: JSON.stringify({ ...body, modelOverride: override }),
              }
          }
        }
      } catch {
        // leave the original request untouched when the body is not JSON
      }
    }
    return original(input, next)
  }) as typeof fetch
}

let installed = false

export function installRequestOverride(win: Window = window): void {
  if (installed) return
  installed = true
  win.fetch = decorateFetch(win.fetch.bind(win), win.location.href, win.localStorage)
}
