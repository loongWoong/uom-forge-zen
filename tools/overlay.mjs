/**
 * Runs Vite with the overlay config, without touching upstream's package.json.
 *
 *   node tools/overlay.mjs dev
 *   node tools/overlay.mjs build
 *   node tools/overlay.mjs preview
 *
 * Equivalent to `vite <command> --config vite.overlay.config.ts`.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [command = 'dev', ...rest] = process.argv.slice(2)
const allowed = new Set(['dev', 'build', 'preview', 'optimize'])
if (!allowed.has(command)) {
  console.error(`未知命令：${command}（可用：${[...allowed].join(' | ')}）`)
  process.exit(1)
}

const viteEntry = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const result = spawnSync(
  process.execPath,
  [viteEntry, command, '--config', 'vite.overlay.config.ts', ...rest],
  { cwd: projectRoot, stdio: 'inherit' },
)
process.exit(result.status ?? 1)
