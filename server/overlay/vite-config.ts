import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  defineConfig,
  loadEnv,
  type AliasOptions,
  type ConfigEnv,
  type Plugin,
  type UserConfig,
} from 'vite'
import { createOverlayApiMiddleware } from './http.ts'
import { applyPiStageTimeout, inheritProviderEndpoints } from './provider-env.ts'

/**
 * Overlay Vite configuration.
 *
 * It composes the pristine upstream config instead of forking it:
 *  1. `.env` loading that also reads the parent UOM directory and clears
 *     previously injected keys so edits apply on config reload; providers
 *     without their own endpoint follow the generic LLM_* channel;
 *  2. the overlay API middleware, mounted *before* upstream's so it can add
 *     routes and decorate requests/responses;
 *  3. an extra client entry (`/src/overlay/main.tsx`) injected into the HTML
 *     before the upstream entry, which mounts the model picker / project
 *     library and patches `window.fetch` for model overrides;
 *  4. the evidence-reader fallback alias when the submodule is absent.
 *
 * Run it with:  vite --config vite.overlay.config.ts   (or `node tools/overlay.mjs dev`)
 */

const projectRoot = path.resolve(import.meta.dirname, '../..')

// Vite exposes .env values to client code through import.meta.env, but the
// server middleware uses process.env. Precedence: real environment >
// project-local .env > parent UOM .env (the first writer of a key wins).
// Vite re-evaluates this config on restart (config or .env changes) inside the
// same process, where process.env persists. Keys injected by a previous load
// are tracked and cleared first, so editing .env takes effect without a full
// process restart; real environment variables are never tracked and always win.
const injectedFromFiles = new Set<string>()
// Variables the provider fallback copied; cleared before every reload so a
// removed LLM_* value cannot keep a stale alias alive.
const inheritedKeys = new Set<string>()
function loadDotEnvDirectories(directories: string[], mode: string): void {
  for (const key of injectedFromFiles) delete process.env[key]
  injectedFromFiles.clear()
  for (const key of inheritedKeys) delete process.env[key]
  inheritedKeys.clear()
  for (const dir of directories) {
    for (const [key, value] of Object.entries(loadEnv(mode, dir, ''))) {
      if (process.env[key] === undefined) {
        process.env[key] = value
        injectedFromFiles.add(key)
      }
    }
  }
  const inherited = inheritProviderEndpoints()
  for (const key of inherited.keys) inheritedKeys.add(key)
  if (inherited.providers.length > 0)
    console.log(
      `[overlay] ${inherited.providers.join('/')} 未配置独立端点，已复用 LLM_* 通用通道：${inherited.keys.join(', ')}（用 UOM_PROVIDER_FALLBACK=off 关闭）`,
    )
  const piTimeout = applyPiStageTimeout()
  if (piTimeout) {
    inheritedKeys.add('UOM_PI_TIMEOUT_MS')
    console.log(
      `[overlay] Pi 阶段超时跟随 provider 超时：UOM_PI_TIMEOUT_MS=${piTimeout}（显式设置该变量可覆盖）`,
    )
  }
}
loadDotEnvDirectories(
  [projectRoot, path.resolve(projectRoot, '..')],
  process.env.NODE_ENV === 'production' ? 'production' : 'development',
)

// The evidence reader is an independent project consumed as a git submodule; a
// fresh clone without `git submodule update --init` leaves an empty directory.
// Alias it to the built-in read-only renderer only while the submodule is
// absent, so one missing optional component cannot break the client bundle.
function evidenceReaderFallback(): string | null {
  const submodule = path.resolve(projectRoot, 'src/components/evidence/qq-doc-clone')
  const manifest = path.join(submodule, 'package.json')
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
        module?: string
        main?: string
        exports?: unknown
      }
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
  return path.resolve(projectRoot, 'src/components/evidence/evidence-reader-fallback.jsx')
}

function mergeAlias(
  base: AliasOptions | undefined,
  extra: { find: string; replacement: string }[],
): AliasOptions {
  if (!extra.length) return base ?? {}
  if (!base) return extra
  if (Array.isArray(base))
    return [...base, ...extra]
  return { ...(base as Record<string, string>), ...Object.fromEntries(extra.map((item) => [item.find, item.replacement])) }
}

function overlayPlugin(): Plugin {
  return {
    name: 'uom-forge-overlay',
    configureServer(server) {
      server.middlewares.use(createOverlayApiMiddleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use(createOverlayApiMiddleware())
    },
    // `order: 'pre'` makes Vite treat the injected entry as a real build input
    // (a default-order injection is served in dev but left unbundled on build).
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [
          {
            tag: 'script',
            attrs: { type: 'module', src: '/src/overlay/main.tsx' },
            injectTo: 'head-prepend' as const,
          },
        ]
      },
    },
  }
}

type UpstreamConfigExport =
  | UserConfig
  | ((env: ConfigEnv) => UserConfig | Promise<UserConfig>)

export default defineConfig(async (env) => {
  const upstream = (await import('../../vite.config.ts'))
    .default as UpstreamConfigExport
  const base = typeof upstream === 'function' ? await upstream(env) : upstream
  const fallback = evidenceReaderFallback()
  if (fallback)
    console.warn(
      '[uom-forge] qq-doc-clone 子模块未检出，证据阅读已降级为内置只读渲染。执行 git submodule update --init --recursive 可恢复原组件。',
    )
  const alias = mergeAlias(
    base.resolve?.alias,
    fallback ? [{ find: 'qq-doc-clone', replacement: fallback }] : [],
  )
  return {
    ...base,
    resolve: { ...base.resolve, alias },
    // Prepended so its `configureServer` runs before the upstream API plugin
    // and can delegate to it after the overlay has handled the request.
    plugins: [overlayPlugin(), ...(base.plugins ?? [])],
  }
})
