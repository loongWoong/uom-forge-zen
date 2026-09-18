/**
 * Runs the overlay variants of the project commands, without touching
 * upstream's package.json.
 *
 *   node tools/overlay.mjs dev        # vite dev with vite.overlay.config.ts
 *   node tools/overlay.mjs build      # vite build with the overlay config
 *   node tools/overlay.mjs preview    # vite preview with the overlay config
 *   node tools/overlay.mjs test       # upstream's `npm test` + the fs shim
 *
 * Every command preloads `tools/fs-compat.mjs` through NODE_OPTIONS (not a
 * plain `--import` argument) so child processes — Vite's config loader, the
 * per-file processes of the test runner — inherit it as well. Upstream's
 * `.npmrc` belongs to upstream, so the shim can no longer live there; `npm run
 * dev` / `npm test` therefore stay the pure upstream commands.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shim = pathToFileURL(path.join(projectRoot, 'tools', 'fs-compat.mjs')).href
const [command = 'dev', ...rest] = process.argv.slice(2)

/** Upstream's test patterns (package.json `test`), kept in sync by intent. */
const TEST_PATTERNS = ['server/*.test.ts', 'server/*/*.test.ts', 'src/*.test.ts']

const entries = {
  vite: path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
  tsx: path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
}

let argv
if (['dev', 'build', 'preview', 'optimize'].includes(command))
  argv = [entries.vite, command, '--config', 'vite.overlay.config.ts', ...rest]
else if (command === 'test') argv = [entries.tsx, '--test', ...TEST_PATTERNS, ...rest]
else {
  console.error(
    `未知命令：${command}（可用：dev | build | preview | optimize | test）`,
  )
  process.exit(1)
}

const nodeOptions = [process.env.NODE_OPTIONS, `--import ${shim}`]
  .filter((part) => part && part.trim())
  .join(' ')
  .trim()

const result = spawnSync(process.execPath, argv, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
})
process.exit(result.status ?? 1)
