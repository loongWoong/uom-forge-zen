import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { analyzeWithProvider, understandWithProvider, assessWithProvider, narrateModelWithProvider, discussWithProvider, providerStatus } from './server/codex-acp.js'

// Vite exposes .env values to client code through import.meta.env, but the
// server middleware uses process.env. Load .env files explicitly so the selected
// provider can read its credentials server-side. Precedence: real environment >
// project-local .env > parent UOM .env (the first writer of a key wins).
const envMode = process.env.NODE_ENV === 'production' ? 'production' : 'development'
for (const dir of [process.cwd(), path.resolve(process.cwd(), '..')]) {
  const fileEnv = loadEnv(envMode, dir, '')
  for (const [key, value] of Object.entries(fileEnv)) if (process.env[key] === undefined) process.env[key] = value
}

// The evidence reader is an independent project consumed as a git submodule, so a fresh
// clone without `git submodule update --init` leaves an empty directory. A static import
// of an unresolvable specifier fails the whole client bundle, which would hide every
// other feature behind one missing optional component. Alias it to the built-in read-only
// renderer only while the submodule is absent; once it is checked out the alias disappears
// and the real QQDocEditor is used again with no code change.
function evidenceReaderAlias() {
  const submodule = path.resolve(process.cwd(), 'src/components/evidence/qq-doc-clone')
  const manifest = path.join(submodule, 'package.json')
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      if (existsSync(path.join(submodule, pkg.module || pkg.main || 'index.js'))) return null
    } catch { /* malformed manifest falls through to the fallback */ }
  }
  return path.resolve(process.cwd(), 'src/components/evidence/evidence-reader-fallback.jsx')
}

const evidenceReaderFallback = evidenceReaderAlias()
if (evidenceReaderFallback) {
  console.warn('[uom-forge] qq-doc-clone 子模块未检出，证据阅读已降级为内置只读渲染。执行 git submodule update --init --recursive 可恢复原组件。')
}

export default defineConfig({
  server: {
    host: '0.0.0.0',
    allowedHosts: ['onto.njuics.cn'],
  },
  resolve: { alias: evidenceReaderFallback ? { 'qq-doc-clone': evidenceReaderFallback } : {} },
  plugins: [react(), {
    name: 'uom-forge-api',
    configureServer(server) {
      const handleJson = (req) => new Promise((resolve, reject) => {
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (error) { reject(new Error('请求内容不是有效 JSON')) } })
        req.on('error', reject)
      })
      server.middlewares.use(async (req, res, next) => {
        const pathname = (req.url || '').split('?')[0]
        // Read-only, key-free provider descriptor so the UI can show the real
        // provider name/model and honour the server-side default provider.
        if (pathname === '/api/config') {
          if (req.method !== 'GET') { res.statusCode = 405; res.end('Method Not Allowed'); return }
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(providerStatus()))
          return
        }
        if (!['/api/analyze', '/api/analyze/stream', '/api/discuss'].includes(pathname)) return next()
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method Not Allowed'); return }
        // `IncomingMessage.close` also fires after the request body has been
        // fully consumed.  That is a normal part of a POST and must not stop
        // the response stream.  Track the response socket instead so an
        // actual browser disconnect is handled correctly.
        let closed = false
        res.on('close', () => { closed = true })
        req.on('aborted', () => { closed = true })
        const streaming = pathname === '/api/analyze/stream'
        const emit = streaming ? (event) => { if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`) } : null
        if (streaming) {
          res.statusCode = 200
          res.setHeader('content-type', 'text/event-stream; charset=utf-8')
          res.setHeader('cache-control', 'no-cache, no-transform')
          res.setHeader('connection', 'keep-alive')
          res.flushHeaders?.()
          emit({ type: 'phase', text: '已收到分析请求，正在读取文档证据。' })
        }
        try {
          const body = await handleJson(req)
          const providerName = providerStatus(body.provider).label
          if (pathname === '/api/analyze') {
            const result = await analyzeWithProvider(body.document, body.model, body.instruction, { provider: body.provider })
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(result))
            return
          }
          if (pathname === '/api/discuss') {
            const text = await discussWithProvider(body.document, body.model, body.messages || [], { provider: body.provider })
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ text }))
            return
          }
          emit({ type: 'phase', text: `已读取文档，准备启动 ${providerName}。` })
          let result
          if (body.stage === 'understand') {
            result = await understandWithProvider(body.document, { provider: body.provider, onEvent: emit })
          } else if (body.stage === 'narrate') {
            // Model narration is deliberately isolated from the evidence and
            // business understanding: the provider receives only the candidate model.
            result = await narrateModelWithProvider(body.model, { provider: body.provider, onEvent: emit })
          } else if (body.stage === 'assess') {
            result = await assessWithProvider(body.document, body.understanding, body.model, { provider: body.provider, onEvent: emit })
          } else {
            const instruction = body.understanding ? `${body.instruction || ''}\n\n第一阶段业务理解（仅作为建模依据）：${JSON.stringify(body.understanding)}` : body.instruction
            result = await analyzeWithProvider(body.document, body.model, instruction, { provider: body.provider, onEvent: emit })
          }
          emit({ type: 'result', result })
          if (!closed) res.end()
        } catch (error) {
          // kind 区分文档/模型校验失败与推理提供方失败：前者是 400（请求内容本身不合法），
          // 后者才是 502（上游不可用）。SSE 模式统一以 error 事件携带 kind。
          const errorKind = error.kind || 'provider'
          if (pathname === '/api/analyze/stream') {
            if (!closed) { res.write(`data: ${JSON.stringify({ type: 'error', error: error.message || '推理提供方调用失败', kind: errorKind })}\n\n`); res.end() }
          } else if (!closed) {
            res.statusCode = errorKind === 'provider' ? 502 : 400
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: error.message || '推理提供方调用失败', kind: errorKind }))
          }
        }
      })
    },
  }],
  // Keep the root .env available for future server-side adapters. Only VITE_*
  // variables are exposed to the browser by Vite.
  envDir: path.resolve(process.cwd(), '..'),
})
