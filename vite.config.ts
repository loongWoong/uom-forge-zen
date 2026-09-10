import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createApiMiddleware } from './server/api.ts'

// Vite exposes .env values to client code through import.meta.env, but the
// server middleware uses process.env. Load .env files explicitly so the selected
// provider can read its credentials server-side. Precedence: real environment >
// project-local .env > parent UOM .env (the first writer of a key wins).
// Vite re-evaluates this config on restart (config or .env changes) inside the
// same process, where process.env persists. Keys injected by a previous load are
// tracked and cleared first, so editing .env takes effect without a full
// process restart; real environment variables are never tracked and always win.
const injectedFromFiles = new Set<string>()
function loadDotEnvDirectories(directories: string[], mode: string): void {
  for (const key of injectedFromFiles) delete process.env[key]
  injectedFromFiles.clear()
  for (const dir of directories) {
    for (const [key, value] of Object.entries(loadEnv(mode, dir, ''))) {
      if (process.env[key] === undefined) {
        process.env[key] = value
        injectedFromFiles.add(key)
      }
    }
  }
}

const projectRoot = path.resolve(import.meta.dirname)
loadDotEnvDirectories(
  [projectRoot, path.resolve(projectRoot, '..')],
  process.env.NODE_ENV === 'production' ? 'production' : 'development',
)

// The evidence reader is an independent project consumed as a git submodule, so a fresh
// clone without `git submodule update --init` leaves an empty directory. A static import
// of an unresolvable specifier fails the whole client bundle, which would hide every
// other feature behind one missing optional component. Alias it to the built-in read-only
// renderer only while the submodule is absent; once it is checked out the alias disappears
// and the real QQDocEditor is used again with no code change.
function evidenceReaderAlias(): string | null {
  const root = path.resolve(import.meta.dirname)
  const submodule = path.resolve(root, 'src/components/evidence/qq-doc-clone')
  const manifest = path.join(submodule, 'package.json')
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
        module?: string
        main?: string
        exports?: unknown
      }
      // Resolve the package entry: exports["."] (string or { import, default }),
      // then legacy module/main, then a root index.js. A checked-out submodule
      // with a resolvable entry keeps the real QQDocEditor; anything else falls
      // back to the built-in read-only renderer.
      const dot = (pkg.exports as Record<string, unknown> | undefined)?.['.']
      const entry =
        typeof dot === 'string'
          ? dot
          : dot && typeof dot === 'object'
            ? ((dot as Record<string, unknown>).import as string) ||
              ((dot as Record<string, unknown>).default as string)
            : undefined
      const resolved = entry || pkg.module || pkg.main || 'index.js'
      if (existsSync(path.join(submodule, resolved))) return null
    } catch {
      // malformed manifest falls through to the fallback
    }
  }
  return path.resolve(root, 'src/components/evidence/evidence-reader-fallback.jsx')
}

const evidenceReaderFallback = evidenceReaderAlias()
if (evidenceReaderFallback) {
  console.warn(
    '[uom-forge] qq-doc-clone 子模块未检出，证据阅读已降级为内置只读渲染。执行 git submodule update --init --recursive 可恢复原组件。',
  )
}

export default defineConfig({
  server: { host: '0.0.0.0', allowedHosts: ['onto.njuics.cn'] },
  resolve: evidenceReaderFallback ? { alias: { 'qq-doc-clone': evidenceReaderFallback } } : {},
  plugins: [
    react(),
    {
      name: 'uom-forge-api',
      configureServer(server) {
        server.middlewares.use(createApiMiddleware())
      },
    },
  ],
  envDir: projectRoot,
})
