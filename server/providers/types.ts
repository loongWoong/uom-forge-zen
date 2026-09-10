import type { ProviderEvent, ProviderId } from '../../shared/analysis.ts'

export interface TurnOptions {
  provider?: ProviderId
  signal?: AbortSignal
  onEvent?: (event: ProviderEvent) => void
  // Per-call model override; when absent each provider falls back to its
  // environment default (LLM_MODEL / CODEX_MODEL).
  model?: string
}
// Each invocation receives only its explicit prompt, without session history.
export type RunTurn = (prompt: string, options: TurnOptions) => Promise<string>
