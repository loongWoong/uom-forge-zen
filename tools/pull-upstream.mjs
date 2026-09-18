/**
 * Conflict-free upstream pull.
 *
 * The overlay keeps every upstream file byte-identical, so a plain
 * `git merge origin/main` has nothing to conflict on. This tool makes that an
 * explicit, verified workflow:
 *
 *   1. verifies `.npmrc` still matches tools/fs-compat.mjs;
 *   2. fetches and refuses to merge when a locally modified file exists in the
 *      upstream tree (that is exactly the state that produces conflicts);
 *   3. merges, reinstalls dependencies when the lockfile changed, and runs the
 *      verification suite (`--no-verify` skips it, `--build` adds a build).
 *
 *   node tools/pull-upstream.mjs [--no-verify] [--build]
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const skipVerify = args.includes('--no-verify')
const withBuild = args.includes('--build')

const capture = (command, commandArgs) =>
  execFileSync(command, commandArgs, { cwd: projectRoot, encoding: 'utf8' }).trim()

const run = (command, commandArgs) => {
  execFileSync(command, commandArgs, { cwd: projectRoot, stdio: 'inherit' })
}

const step = (message) => console.log(`\n== ${message}`)

try {
  step('.npmrc 与 tools/fs-compat.mjs 同步检查')
  run(process.execPath, ['tools/build-npmrc.mjs', '--check'])

  step('获取远端更新')
  run('git', ['fetch', 'origin', '--prune'])

  let upstreamRef = 'origin/main'
  try {
    upstreamRef = capture('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  } catch {
    console.warn('当前分支没有上游跟踪引用，使用 origin/main。')
  }

  const upstreamPaths = new Set(
    capture('git', ['ls-tree', '-r', '--name-only', upstreamRef]).split('\n').filter(Boolean),
  )
  const differing = new Set([
    ...capture('git', ['diff', '--name-only', upstreamRef, 'HEAD'])
      .split('\n')
      .filter(Boolean),
    // 未提交的改动同样会让合并冲突，必须一起检查
    ...capture('git', ['diff', '--name-only', upstreamRef])
      .split('\n')
      .filter(Boolean),
  ])
  const violations = [...differing].filter((file) => upstreamPaths.has(file))
  if (violations.length) {
    console.error('\n以下上游文件在本地被修改过，合并会产生冲突：')
    for (const file of violations) console.error(`  - ${file}`)
    console.error(
      '\n请把这些改动迁移到 overlay（server/overlay、src/overlay、tools、overlay 文档），' +
        `并运行 git checkout ${upstreamRef} -- <文件> 恢复上游版本后重试。`,
    )
    process.exit(1)
  }
  const localOnly = [...differing].filter((file) => !upstreamPaths.has(file))
  console.log(`本地领先的文件（overlay 侧）：${localOnly.length} 个`)

  const behind = Number(
    capture('git', ['rev-list', '--count', `HEAD..${upstreamRef}`]),
  )
  if (!behind) {
    console.log('已是最新，无需合并。')
    process.exit(0)
  }
  const before = capture('git', ['rev-parse', 'HEAD'])
  step(`合并 ${upstreamRef}（${behind} 个新提交）`)
  try {
    run('git', ['merge', '--no-edit', upstreamRef])
  } catch {
    console.error(
      '\n合并出现冲突。守卫检查本应避免这种情况：请查看 git status，' +
        '把冲突文件的功能迁移到 overlay 并保留上游版本，然后重新提交。',
    )
    process.exit(1)
  }

  const merged = capture('git', ['diff', '--name-only', before, 'HEAD'])
  if (merged.split('\n').includes('package-lock.json')) {
    step('package-lock.json 有更新，安装依赖')
    run('npm', ['install'])
  }
  if (merged.split('\n').includes('package.json')) {
    console.warn('package.json 有更新，请检查依赖是否仍需安装：npm install')
  }

  if (!skipVerify) {
    step('类型检查')
    run('npm', ['run', 'typecheck'])
    step('测试')
    run('npm', ['test'])
    if (withBuild) {
      step('构建（overlay 配置）')
      run(process.execPath, ['tools/overlay.mjs', 'build'])
    }
  }

  const ahead = capture('git', ['rev-list', '--count', `${upstreamRef}..HEAD`])
  console.log(`\n完成：${upstreamRef} 已包含，本地领先 ${ahead} 个提交。`)
} catch (error) {
  console.error(`\n失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
