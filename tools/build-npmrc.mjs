/**
 * Regenerates `.npmrc` from `tools/fs-compat.mjs`.
 *
 * npm's `node-options` config injects flags into every Node process started by
 * an npm script (including the child processes spawned by tests). A relative
 * `--import ./tools/fs-compat.mjs` would be resolved against each child's cwd,
 * which for the ACP provider's temporary workspace is not this project, so the
 * shim is embedded as a cwd-independent `data:` URL instead.
 *
 * Run this after editing `tools/fs-compat.mjs`:
 *   node tools/build-npmrc.mjs
 * `node tools/pull-upstream.mjs` and the test suite call it in check mode and
 * fail when `.npmrc` is out of date.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const toolsDir = path.dirname(fileURLToPath(import.meta.url))
// Normalize line endings so the generated .npmrc is identical whatever
// core.autocrlf did to the checked-out source.
const source = readFileSync(path.join(toolsDir, 'fs-compat.mjs'), 'utf8').replace(/\r\n/g, '\n')
if (source.includes('${'))
  throw new Error('tools/fs-compat.mjs must not contain template literals: $ would be expanded in .npmrc')
if (source.trimStart().startsWith('#!'))
  throw new Error('tools/fs-compat.mjs must not keep a shebang: it is imported, not executed')

const content = `node-options=--import data:text/javascript,${encodeURIComponent(source)}\n`
const target = path.join(toolsDir, '..', '.npmrc')
const current = (() => {
  try {
    // git may check the file out with CRLF (core.autocrlf=true)
    return readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
  } catch {
    return ''
  }
})()

if (process.argv.includes('--check')) {
  if (current !== content) {
    console.error('.npmrc 与 tools/fs-compat.mjs 不同步，请运行：node tools/build-npmrc.mjs')
    process.exit(1)
  }
  console.log('.npmrc 与 tools/fs-compat.mjs 同步。')
} else {
  writeFileSync(target, content)
  console.log(`.npmrc 已生成（${content.length} 字节）。`)
}
