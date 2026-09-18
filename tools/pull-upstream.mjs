/**
 * Conflict-free upstream pull.
 *
 * The overlay keeps every upstream file byte-identical, so a plain
 * `git merge origin/main` has nothing to conflict on. This tool makes that an
 * explicit, verified workflow:
 *
 *   1. fetches, then refuses to merge when a file we changed since the merge
 *      base also exists in the incoming upstream tree (that is exactly the
 *      state that produces conflicts), or when an untracked local file has the
 *      same path as a newly added upstream one;
 *   2. merges, reinstalls dependencies when the lockfile changed, and runs the
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

/** npm/npx are .cmd shims on Windows; spawn/exec need the extension. */
const exe = (name) =>
  process.platform === 'win32' && /^(npm|npx)$/.test(name) ? `${name}.cmd` : name

const capture = (command, commandArgs) =>
  execFileSync(exe(command), commandArgs, { cwd: projectRoot, encoding: 'utf8' }).trim()

const run = (command, commandArgs) => {
  execFileSync(exe(command), commandArgs, { cwd: projectRoot, stdio: 'inherit' })
}

const step = (message) => console.log(`\n== ${message}`)

/**
 * Does an untracked working-tree file already match the upstream blob?
 * `--path` makes hash-object apply the same clean filters (core.autocrlf) git
 * would apply on add, so CRLF checkouts do not look like a difference.
 */
function identicalToUpstream(file, ref) {
  try {
    return (
      capture('git', ['hash-object', `--path=${file}`, file]) ===
      capture('git', ['rev-parse', `${ref}:${file}`])
    )
  } catch {
    return false
  }
}

try {
  step('获取远端更新')
  try {
    run('git', ['fetch', 'origin', '--prune'])
  } catch {
    // Offline / no credentials must not block merging a ref we already have.
    console.warn('git fetch 失败，继续使用本地已有的远端引用。')
  }

  let upstreamRef = 'origin/main'
  try {
    upstreamRef = capture('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  } catch {
    console.warn('当前分支没有上游跟踪引用，使用 origin/main。')
  }

  const upstreamPaths = new Set(
    capture('git', ['ls-tree', '-r', '--name-only', upstreamRef]).split('\n').filter(Boolean),
  )
  // Compare against the merge base, never against the upstream tip: after a
  // fetch, `git diff <upstream> HEAD` also lists the files *upstream* changed,
  // and those are exactly what a conflict-free merge is supposed to bring in.
  const mergeBase = capture('git', ['merge-base', 'HEAD', upstreamRef])
  const differing = new Set([
    // 自共同祖先以来，本地已提交的改动
    ...capture('git', ['diff', '--name-only', mergeBase, 'HEAD'])
      .split('\n')
      .filter(Boolean),
    // 未提交的改动同样会让合并冲突，必须一起检查
    ...capture('git', ['diff', '--name-only', 'HEAD'])
      .split('\n')
      .filter(Boolean),
  ])
  // Untracked local files that upstream also ships: git refuses to overwrite
  // them, so the merge stops even though nothing is “modified” locally.
  const untrackedClash = capture('git', ['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter((file) => upstreamPaths.has(file))
    .filter((file) => !identicalToUpstream(file, upstreamRef))
  if (untrackedClash.length) {
    console.error('\n以下未跟踪的本地文件与上游新增文件同名，合并会被 git 拒绝：')
    for (const file of untrackedClash) console.error(`  - ${file}`)
    console.error('请先确认它是否应转为 overlay 路径（或提交/删除）后重试。')
    process.exit(1)
  }
  const violations = [...differing].filter((file) => upstreamPaths.has(file))
  if (violations.length) {
    console.error('\n以下上游文件自共同祖先以来被本地修改过，合并会产生冲突：')
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
    // 本机的 npm 版本会顺手重写 lock（加 dev 标记、合并平台包）。依赖已装好，
    // 但仓库里的 lock 必须保持上游原样，否则下次拉取又是一条“本地修改”。
    if (capture('git', ['diff', '--name-only', 'HEAD']).split('\n').includes('package-lock.json')) {
      run('git', ['checkout', '--', 'package-lock.json'])
      console.warn('package-lock.json 已恢复为上游版本（本机 npm 会重写它，属正常现象）。')
    }
  }
  if (merged.split('\n').includes('package.json')) {
    console.warn('package.json 有更新，请检查依赖是否仍需安装：npm install')
  }

  if (!skipVerify) {
    step('类型检查')
    run('npm', ['run', 'typecheck'])
    step('测试（overlay 入口：带上 tools/fs-compat.mjs 的 Windows 重试）')
    run(process.execPath, ['tools/overlay.mjs', 'test'])
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
