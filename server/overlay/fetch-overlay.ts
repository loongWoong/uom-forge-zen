import { currentContext, type OverlayRequestContext } from './context.ts'
import { isChatCompletionsUrl, providerForUrl, rewriteChatBody } from './fetch-params.ts'
import { resolveModelConfig } from './model-config.ts'
import { isRecord } from '../validation/values.ts'

/**
 * Global fetch decorator: the single interception point shared by the direct
 * providers and pi-ai (which resolves global fetch when each client is built).
 * It rewrites chat-completions request bodies with the overlay's model config
 * and records non-2xx provider responses so the middleware can replace the
 * generic Pi handoff error with the real HTTP reason.
 */

let installed = false

function urlOf(input: RequestInfo | URL): string | undefined {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url
  return undefined
}

/** Body rewrite for one request; returns undefined when nothing applies. */
function decorateInit(
  url: string,
  init: RequestInit | undefined,
  context: OverlayRequestContext,
): RequestInit | undefined {
  if (!init || typeof init.body !== 'string') return undefined
  const provider = providerForUrl(
    url,
    process.env,
    context.provider,
  )
  if (!provider) return undefined
  let body: unknown
  try {
    body = JSON.parse(init.body) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(body)) return undefined
  let config
  try {
    config = resolveModelConfig(provider, { override: context.modelOverride })
  } catch {
    // Missing credentials surface through the provider itself, with its own
    // readable message; the overlay must not mask it.
    return undefined
  }
  rewriteChatBody(body, config, process.env)
  const headers = new Headers(init.headers)
  // The rewrite changes the body length; let undici recompute the header.
  headers.delete('content-length')
  return { ...init, headers, body: JSON.stringify(body) }
}

/** Pull a readable reason out of a failed provider response body. */
export function providerFailureDetail(raw: string): string {
  const text = raw.trim()
  if (!text) return ''
  try {
    const payload: unknown = JSON.parse(text)
    if (isRecord(payload)) {
      const error = payload.error
      if (typeof error === 'string' && error.trim()) return error.trim()
      if (isRecord(error) && typeof error.message === 'string')
        return error.message.trim()
      if (typeof payload.message === 'string' && payload.message.trim())
        return payload.message.trim()
      if (typeof payload.detail === 'string' && payload.detail.trim())
        return payload.detail.trim()
    }
  } catch {
    // not JSON; use the raw body below
  }
  return text
}

function captureFailure(
  context: OverlayRequestContext,
  url: string,
  response: Response,
): void {
  const { status, statusText } = response
  // Register synchronously so a fast-failing stage can already see it, then
  // enrich with the response body when the clone finishes reading.
  const failure = { url, status, statusText, detail: '' }
  context.failures.push(failure)
  void (async () => {
    try {
      const text = await Promise.race([
        response.clone().text(),
        new Promise<string>((resolve) => setTimeout(() => resolve(''), 5000)),
      ])
      failure.detail = providerFailureDetail(text).replace(/\s+/g, ' ').slice(0, 300)
    } catch {
      // body already consumed or unreadable; the status alone still helps
    }
  })()
}

export function installFetchOverlay(): void {
  if (installed) return
  installed = true
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const context = currentContext()
    let nextInit = init
    if (context && url && isChatCompletionsUrl(url)) {
      const decorated = decorateInit(url, init, context)
      if (decorated) nextInit = decorated
    }
    const response = await original(input, nextInit)
    if (!response.ok && context && url && isChatCompletionsUrl(url))
      captureFailure(context, url, response)
    return response
  }) as typeof fetch
}

// Install on module evaluation, before any upstream module that captures
// `fetch` (the direct providers take it as a default parameter at import
// time). `server/overlay/http.ts` imports this module first on purpose.
installFetchOverlay()
