import type { ProviderId } from '../../shared/analysis.ts'

export interface EndpointModels {
  models: string[]
  /** Base URL the ids came from; absent when the server could not resolve one. */
  endpoint?: string
}

/** Readable reason for a failed request — never a bare status code. */
async function failureReason(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json()
    if (payload && typeof payload === 'object') {
      const error = (payload as { error?: unknown }).error
      if (typeof error === 'string' && error.trim()) return error.trim()
    }
  } catch {
    // body was not JSON; the status alone still explains the failure
  }
  return 'HTTP ' + response.status
}

/**
 * Model ids offered by the endpoint the selected provider will actually call.
 * The server resolves that endpoint exactly like the turn does and reports it
 * back, so the picker can show which baseURL the list came from.
 */
export async function fetchEndpointModels(
  provider: ProviderId,
  fetchImpl: typeof fetch = fetch,
): Promise<EndpointModels> {
  const response = await fetchImpl('/api/models?provider=' + provider)
  if (!response.ok) throw new Error(await failureReason(response))
  const data = (await response.json()) as { models?: unknown; endpoint?: unknown }
  return {
    models: Array.isArray(data.models)
      ? data.models.filter((id): id is string => typeof id === 'string')
      : [],
    ...(typeof data.endpoint === 'string' && data.endpoint
      ? { endpoint: data.endpoint }
      : {}),
  }
}
