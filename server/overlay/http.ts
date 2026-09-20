// This import must stay first: it installs the fetch decorator while the
// module graph is still loading, before upstream providers capture `fetch`.
import './fetch-overlay.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createApiMiddleware } from '../api.ts'
import { resolveProvider } from '../providers/index.ts'
import type { RunTurn } from '../providers/types.ts'
import type { AgentRuntimeId, ProviderId } from '../../shared/analysis.ts'
import { isRecord } from '../validation/values.ts'
import {
  createContext,
  overlayContext,
  type OverlayRequestContext,
} from './context.ts'
import { documentLimitError } from './document-limit.ts'
import { installFetchOverlay } from './fetch-overlay.ts'
import { applyPiStageTimeout, inheritProviderEndpoints } from './provider-env.ts'
import { handleOverlayRoutes } from './routes.ts'
import { createOverlayRunTurn } from './run-turn.ts'

const API_PATHS = ['/api/analyze', '/api/analyze/stream', '/api/discuss']
const MAX_MODEL_OVERRIDE_CHARS = 200

/**
 * Overlay API middleware.
 *
 * Upstream's `createApiMiddleware` is mounted *behind* this middleware and
 * stays byte-identical: the overlay only adds its own routes, validates what
 * upstream does not know about (model override, configurable document limit),
 * re-exposes the buffered request body, and decorates the response to surface
 * provider errors and JSON-recovery notices. It also is the place where the
 * request-scoped context (used by the fetch decorator and the decorated
 * RunTurn) is established, so concurrent requests cannot leak into each other.
 */
export function createOverlayApiMiddleware(
  runTurn?: RunTurn,
): (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => Promise<void> {
  installFetchOverlay()
  // Providers without their own endpoint follow the generic OpenAI-compatible
  // channel, so the model list and the turn agree on one baseURL. Idempotent:
  // the Vite config already did this for the dev/build process.
  inheritProviderEndpoints()
  applyPiStageTimeout()
  const upstream = createApiMiddleware(createOverlayRunTurn(runTurn))

  return async (request, response, next) => {
    try {
      if (await handleOverlayRoutes(request, response)) return
      const pathname = (request.url || '').split('?')[0]
      if (!API_PATHS.includes(pathname) || request.method !== 'POST') {
        next()
        return
      }
      const raw = await readBody(request)
      const parsed = parseBody(raw)
      if (!isRecord(parsed)) {
        // Invalid JSON is upstream's error to report; delegate unchanged.
        await overlayContext.run(createContext({}), () =>
          upstream(request, response, next),
        )
        return
      }
      const override = readModelOverride(parsed)
      if (override.error) {
        respondError(
          response,
          pathname === '/api/analyze/stream',
          400,
          override.error,
        )
        return
      }
      const limitError = documentLimitError(parsed)
      if (limitError) {
        respondError(
          response,
          pathname === '/api/analyze/stream',
          400,
          limitError,
        )
        return
      }
      const context = createContext({
        provider: readProvider(parsed),
        runtime: readRuntime(parsed),
        modelOverride: override.value,
      })
      decorateResponse(response, context)
      await overlayContext.run(context, () =>
        upstream(request, response, next),
      )
    } catch (error) {
      next(error)
    }
  }
}

/**
 * Read the request body once and make the stream readable again for upstream's
 * `readJson`. Node streams expose `Symbol.asyncIterator` on the prototype, so
 * an instance-level override replays the buffered bytes exactly once.
 */
async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  const body = Buffer.concat(chunks)
  let replayed = false
  ;(
    request as unknown as Record<symbol, unknown>
  )[Symbol.asyncIterator] = async function* () {
    if (replayed) return
    replayed = true
    if (body.length) yield body
  }
  request.headers['content-length'] = String(body.length)
  return body
}

function parseBody(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8') || '{}') as unknown
  } catch {
    return undefined
  }
}

function readModelOverride(body: Record<string, unknown>): {
  value?: string
  error?: string
} {
  const value = body.modelOverride
  if (value === undefined || value === null) return {}
  if (typeof value !== 'string')
    return { error: 'modelOverride 必须是字符串（模型 id）。' }
  const trimmed = value.trim()
  if (!trimmed) return {}
  if (trimmed.length > MAX_MODEL_OVERRIDE_CHARS)
    return { error: `modelOverride 过长（最多 ${MAX_MODEL_OVERRIDE_CHARS} 个字符）。` }
  return { value: trimmed }
}

function readProvider(body: Record<string, unknown>): ProviderId | undefined {
  const value = body.provider
  if (
    value === 'deepseek' ||
    value === 'gpt' ||
    value === 'qwen' ||
    value === 'glm'
  )
    return value
  // Upstream resolves a missing `provider` from UOM_LLM_PROVIDER. The fetch
  // decorator has to name the same provider, otherwise it rewrites the request
  // with another provider's model and vendor parameters (e.g. a GPT turn sent
  // with DeepSeek's model and thinking:{type:'disabled'}).
  try {
    return resolveProvider(undefined)
  } catch {
    // an unset/invalid UOM_LLM_PROVIDER is upstream's error to report
    return undefined
  }
}

function readRuntime(body: Record<string, unknown>): AgentRuntimeId | undefined {
  const value = body.runtime
  return value === 'pi' || value === 'direct' ? value : undefined
}

function respondError(
  response: ServerResponse,
  streaming: boolean,
  status: number,
  message: string,
): void {
  if (streaming) {
    response.statusCode = 200
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('cache-control', 'no-cache, no-transform')
    response.setHeader('connection', 'keep-alive')
    response.flushHeaders()
    response.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`)
    response.end()
    return
  }
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify({ error: message }))
}

/** Turn a generic Pi handoff failure into the real provider rejection. */
export function overlayErrorText(
  original: string,
  context: OverlayRequestContext,
): string {
  const failure = context.failures[context.failures.length - 1]
  if (!failure) return original
  const label = original.includes('未通过提交工具交接建模说明')
    ? 'Pi 语义建模'
    : original.includes('未通过提交工具交接业务理解')
      ? 'Pi 业务理解'
      : original.includes('未通过提交工具交接模型 JSON')
        ? 'Pi JSON 修复'
        : ''
  if (!label) return original
  const detail = failure.detail || failure.statusText || '提供方拒绝了请求'
  return `${label}模型调用失败：HTTP ${failure.status} ${detail}`
}

/**
 * Rewrite the response on its way out:
 *  - generic Pi errors are replaced by the captured provider HTTP reason, and
 *  - JSON-recovery notices are appended to the stage result's warnings.
 */
function decorateResponse(
  response: ServerResponse,
  context: OverlayRequestContext,
): void {
  let noticesDelivered = false

  const withNotices = (value: unknown): unknown => {
    if (noticesDelivered || !context.notices.length || !isRecord(value))
      return value
    noticesDelivered = true
    const validation = value.validation
    if (isRecord(validation) && Array.isArray(validation.warnings))
      return {
        ...value,
        validation: {
          ...validation,
          warnings: [...validation.warnings, ...context.notices],
        },
      }
    const understanding = value.understanding
    if (isRecord(understanding) && Array.isArray(understanding.warnings))
      return {
        ...value,
        understanding: {
          ...understanding,
          warnings: [...understanding.warnings, ...context.notices],
        },
      }
    if (Array.isArray(value.warnings))
      return { ...value, warnings: [...value.warnings, ...context.notices] }
    return { ...value, warnings: [...context.notices] }
  }

  const rewriteJson = (value: unknown): unknown => {
    if (!isRecord(value)) return value
    if (typeof value.error === 'string') {
      const next = overlayErrorText(value.error, context)
      return next === value.error ? value : { ...value, error: next }
    }
    return withNotices(value)
  }

  const rewriteEvent = (event: unknown): unknown => {
    if (!isRecord(event)) return event
    if (event.type === 'error' && typeof event.error === 'string') {
      const next = overlayErrorText(event.error, context)
      return next === event.error ? event : { ...event, error: next }
    }
    if (event.type === 'result') return { ...event, result: withNotices(event.result) }
    return event
  }

  const rewriteText = (text: string): string => {
    if (!text) return text
    if (text.includes('data: '))
      return text
        .split('\n')
        .map((line) => {
          if (!line.startsWith('data: ')) return line
          try {
            const event: unknown = JSON.parse(line.slice(6))
            const next = rewriteEvent(event)
            return next === event ? line : `data: ${JSON.stringify(next)}`
          } catch {
            return line
          }
        })
        .join('\n')
    const trimmed = text.trim()
    if (!trimmed.startsWith('{')) return text
    try {
      const value: unknown = JSON.parse(trimmed)
      const next = rewriteJson(value)
      return next === value ? text : JSON.stringify(next)
    } catch {
      return text
    }
  }

  const rewriteChunk = (chunk: unknown): unknown => {
    if (typeof chunk === 'string') return rewriteText(chunk)
    if (Buffer.isBuffer(chunk)) {
      const text = rewriteText(chunk.toString('utf8'))
      return text === chunk.toString('utf8') ? chunk : Buffer.from(text, 'utf8')
    }
    if (chunk instanceof Uint8Array) {
      const buffer = Buffer.from(chunk)
      const text = rewriteText(buffer.toString('utf8'))
      return text === buffer.toString('utf8') ? chunk : Buffer.from(text, 'utf8')
    }
    return chunk
  }

  const mutable = response as unknown as {
    write: (...args: unknown[]) => boolean
    end: (...args: unknown[]) => unknown
  }
  const originalWrite = mutable.write.bind(response)
  const originalEnd = mutable.end.bind(response)
  mutable.write = (chunk, ...rest) => originalWrite(rewriteChunk(chunk), ...rest)
  mutable.end = (chunk, ...rest) =>
    originalEnd(chunk === undefined ? undefined : rewriteChunk(chunk), ...rest)
}
