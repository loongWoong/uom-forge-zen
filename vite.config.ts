import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createApiMiddleware } from './server/api.ts'

const envDirectory = path.resolve(import.meta.dirname, '..')
for (const [key, value] of Object.entries(
  loadEnv(
    process.env.NODE_ENV === 'production' ? 'production' : 'development',
    envDirectory,
    '',
  ),
)) {
  if (process.env[key] === undefined) process.env[key] = value
}

// The evidence reader is an independent project consumed as a git submodule, so a fresh
// clone without `git submodule update --init` leaves an empty directory. A static import
// of an unresolvable specifier fails the whole client bundle, which would hide every
// other feature behind one missing optional component. Alias it to the built-in read-only
// renderer only while the submodule is absent; once it is checked out the alias disappears
// and the real QQDocEditor is used again with no code change.
function evidenceReaderAlias(): string | null {
  const projectRoot = path.resolve(import.meta.dirname)
  const submodule = path.resolve(projectRoot, 'src/components/evidence/qq-doc-clone')
  const manifest = path.join(submodule, 'package.json')
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { module?: string; main?: string }
      if (existsSync(path.join(submodule, pkg.module || pkg.main || 'index.js'))) return null
    } catch {
      // malformed manifest falls through to the fallback
    }
  }
  return path.resolve(projectRoot, 'src/components/evidence/evidence-reader-fallback.jsx')
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
  envDir: envDirectory,
})
