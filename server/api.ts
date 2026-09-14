import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AnalysisEvent } from '../shared/analysis.ts'
import { PROVIDERS } from '../shared/analysis.ts'
import type { RunTurn } from './providers/types.ts'
import { runProviderTurn, resolveProvider, providerDescriptor, listEndpointModels } from './providers/index.ts'
import { runStage } from './stages/index.ts'
import { discuss } from './stages/discussion.ts'
import {
  parseAnalysisRequest,
  parseDiscussionRequest,
} from './validation/requests.ts'
import { isRecord, errorMessage } from './validation/values.ts'

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
  } catch {
    throw new Error('请求内容不是有效 JSON。')
  }
}

export function createApiMiddleware(runTurn: RunTurn = runProviderTurn) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    const pathname = (request.url || '').split('?')[0]
    // Read-only, key-free provider descriptor so the effective provider/model can
    // be verified from outside (the UI does not display the model name).
    if (pathname === '/api/config') {
      if (request.method !== 'GET') {
        response.statusCode = 405
        response.setHeader('allow', 'GET')
        response.end('Method Not Allowed')
        return
      }
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end(JSON.stringify(providerDescriptor()))
      return
    }
    // Model ids offered by the configured OpenAI-compatible endpoint, for the
    // UI's model switcher. Free-text input remains the fallback when this fails.
    if (pathname === '/api/models') {
      if (request.method !== 'GET') {
        response.statusCode = 405
        response.setHeader('allow', 'GET')
        response.end('Method Not Allowed')
        return
      }
      response.setHeader('content-type', 'application/json; charset=utf-8')
      try {
        response.end(JSON.stringify({ models: await listEndpointModels() }))
      } catch (error) {
        response.statusCode = 502
        response.end(JSON.stringify({ error: errorMessage(error) }))
      }
      return
    }
    if (
      !['/api/analyze', '/api/analyze/stream', '/api/discuss'].includes(
        pathname,
      )
    ) {
      next()
      return
    }
    if (request.method !== 'POST') {
      response.statusCode = 405
      response.setHeader('allow', 'POST')
      response.end('Method Not Allowed')
      return
    }
    const controller = new AbortController()
    const disconnected = () => {
      if (!response.writableEnded)
        controller.abort(new DOMException('客户端已断开连接', 'AbortError'))
    }
    // A request's normal close after reading its body is not a cancellation.
    response.on('close', disconnected)
    request.on('aborted', disconnected)
    const streaming = pathname === '/api/analyze/stream'
    let invoked = false
    const emit = (event: AnalysisEvent) => {
      if (!controller.signal.aborted && !response.writableEnded)
        response.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    if (streaming) {
      response.setHeader('content-type', 'text/event-stream; charset=utf-8')
      response.setHeader('cache-control', 'no-cache, no-transform')
      response.setHeader('connection', 'keep-alive')
      response.flushHeaders()
    } else response.setHeader('content-type', 'application/json; charset=utf-8')
    try {
      const body = await readJson(request)
      controller.signal.throwIfAborted()
      const provider = resolveProvider(
        isRecord(body) ? body.provider : undefined,
      )
      // Optional per-request model override; must be a non-empty string when present.
      const rawOverride = isRecord(body) ? body.modelOverride : undefined
      if (rawOverride !== undefined && typeof rawOverride !== 'string')
        throw new Error('modelOverride 必须是文本。')
      const modelOverride = rawOverride?.trim() || undefined
      if (modelOverride && modelOverride.length > 200)
        throw new Error('modelOverride 过长。')
      if (pathname === '/api/discuss') {
        const input = parseDiscussionRequest(body, provider)
        invoked = true
        const text = await discuss(
          input.document,
          input.model,
          input.messages,
          runTurn,
          { provider, signal: controller.signal, model: modelOverride },
        )
        if (!controller.signal.aborted) response.end(JSON.stringify({ text }))
      } else {
        const input = parseAnalysisRequest(
          body,
          provider,
          streaming ? undefined : 'model',
        )
        if (streaming)
          emit({
            type: 'phase',
            text: `已收到阶段输入，准备启动 ${PROVIDERS[provider].label}。`,
          })
        invoked = true
        const result = await runStage(input, runTurn, {
          signal: controller.signal,
          onEvent: streaming ? emit : undefined,
          model: modelOverride,
        })
        if (!controller.signal.aborted) {
          if (streaming) {
            emit({ type: 'result', result })
            response.end()
          } else response.end(JSON.stringify(result))
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (streaming) {
          emit({ type: 'error', error: errorMessage(error) })
          response.end()
        } else {
          response.statusCode = invoked ? 502 : 400
          response.end(JSON.stringify({ error: errorMessage(error) }))
        }
      }
    } finally {
      response.off('close', disconnected)
      request.off('aborted', disconnected)
    }
  }
}
