import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentRuntimeId, ProviderId } from '../../shared/analysis.ts'

/** A non-2xx provider response observed during one overlay request. */
export interface ProviderFailure {
  url: string
  status: number
  statusText: string
  /** Short, human-readable reason extracted from the response body. */
  detail: string
}

export interface OverlayRequestContext {
  provider?: ProviderId
  runtime?: AgentRuntimeId
  /** Validated per-request model override coming from the UI. */
  modelOverride?: string
  /** Automatic JSON repairs performed for this request, in order. */
  notices: string[]
  /** Provider errors captured by the fetch decorator, oldest first. */
  failures: ProviderFailure[]
}

/**
 * Request-scoped state shared by the middleware, the decorated RunTurn and the
 * fetch decorator. Both the direct providers and the Pi agents run inside the
 * request's async context, so AsyncLocalStorage keeps concurrent conversations
 * from leaking overrides or notices into each other.
 */
export const overlayContext = new AsyncLocalStorage<OverlayRequestContext>()

export function currentContext(): OverlayRequestContext | undefined {
  return overlayContext.getStore()
}

export function createContext(input: {
  provider?: ProviderId
  runtime?: AgentRuntimeId
  modelOverride?: string
}): OverlayRequestContext {
  return {
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
    notices: [],
    failures: [],
  }
}
