# Overlay：不修改上游源码的本地扩展

本仓库相对上游的全部本地改动集中在 `server/overlay/`、`src/overlay/`、`tools/`、
`vite.overlay.config.ts` 与 `OVERLAY.md`；上游文件保持逐字节一致，因此
`git merge origin/main` 不会产生任何冲突。本地功能全部通过"装饰器"（组合、注入、
包装、监听）挂接在上游的接缝上。此外还有三类原本就只存在于本地的文件
（上游没有、也不会与之冲突）：`.env.example`、中文分析文档（`*分析.md/.html`）、
`src/components/evidence/evidence-reader-fallback.jsx`。

> 曾经也放在本地的 `.npmrc` 已让位给上游（上游用它固定 `install-links=false`），
> Windows 的 `fs.rm` 重试改由 `tools/overlay.mjs` 注入，见下文。

## 快速开始

```bash
# 开发（overlay 配置：本地功能全部生效）
node tools/overlay.mjs dev          # 等价于 vite --config vite.overlay.config.ts

# 直接使用上游原版（没有任何本地功能，用于对照/排查）
npm run dev

# 生产构建 / 预览（overlay 配置）
node tools/overlay.mjs build
node tools/overlay.mjs preview

# 测试：npm test 是上游纯版本；下面这条同模式但预加载了 Windows fs.rm 重试
node tools/overlay.mjs test

# 拉取上游更新（无冲突工作流）
node tools/pull-upstream.mjs              # fetch + 守卫 + merge + typecheck + test
node tools/pull-upstream.mjs --no-verify  # 只合并，不跑验证
node tools/pull-upstream.mjs --build      # 合并后再跑 overlay 构建
```

## 目录

```
vite.overlay.config.ts        根入口，仅 re-export server/overlay/vite-config.ts
server/overlay/
  vite-config.ts              组合上游 vite.config.ts、加载 .env、注入前端入口、挂 middleware
  http.ts                     overlay API middleware（路由、请求体缓冲、响应装饰、ALS 上下文）
  routes.ts                   /api/config、/api/models
  run-turn.ts                 包装 RunTurn：JSON 恢复 + 恢复提示
  json-recovery.ts            截断/混入文字/尾逗号的 JSON 恢复（原 server/validation/values.ts 的本地增强）
  document-limit.ts           UOM_MAX_DOC_CHARS 前置校验
  fetch-overlay.ts            全局 fetch 装饰：请求体重写 + provider 失败捕获
  fetch-params.ts             provider 端点匹配、请求体参数统一（纯函数）
  model-config.ts             统一模型配置（原 server/providers/model-config.ts 的本地增强版）
  context.ts                  AsyncLocalStorage 请求上下文
src/overlay/
  main.tsx                    客户端入口：安装 fetch/Storage 装饰，挂载顶栏 UI
  topbar.tsx                  模型选择器 + 项目库（React 组件，挂到 .topbar-actions）
  request-override.ts         window.fetch 装饰：把 modelOverride 注入分析请求
  storage-sync.ts             Storage.setItem 装饰：把草稿同步进项目库
  project-store.ts            命名项目库（localStorage）
  styles.css                  overlay 样式
tools/
  overlay.mjs                 用 overlay 配置运行 vite；也提供带 fs 兼容 shim 的 test 入口
  pull-upstream.mjs           无冲突拉取工作流 + 上游文件清洁守卫
  fs-compat.mjs               Windows EBUSY 重试（由 overlay.mjs 预加载，见下）
```

## 功能 → 装饰点对照

| 本地功能 | 装饰方式 |
| --- | --- |
| `.env` 加载（项目根 + 上级 UOM 目录；改 .env 后配置热加载） | `server/overlay/vite-config.ts` 先加载环境，再动态 `import('../../vite.config.ts')` 组合 |
| 单网关部署下 GPT/Qwen 复用通用通道 | `provider-env.ts` 在启动时把未配置的 `GPT_*`/`QWEN_*` 从 `LLM_*` 补齐（URL/KEY/MODEL/超时/输出上限），使模型列表与请求命中同一个 baseURL；显式配置优先，`UOM_PROVIDER_FALLBACK=off` 关闭 |
| Pi 阶段超时跟随 provider 超时 | `provider-env.ts` 的 `applyPiStageTimeout`：`UOM_PI_TIMEOUT_MS` 未设置时，取各 provider `*_API_TIMEOUT_MS` 的最大值写入（上游 `piSignal` 只读这一个变量，否则 5 分钟就中断慢端点）；显式设置永远优先 |
| `/api/config`、`/api/models` 路由 | overlay middleware 注册在上游 API plugin 之前；命中即响应，其余 `next()` 委托；`/api/models` 返回 `{models, endpoint}`，把列表来源的 baseURL 暴露给界面，并用 `AbortSignal.timeout`（`UOM_MODELS_TIMEOUT_MS`，默认 10000）兜住不回话的网关，否则选择器会永远停在“正在获取模型列表…” |
| `modelOverride`（每次请求切换模型） | `http.ts` 缓冲请求体 → 校验 → 存入 AsyncLocalStorage；`fetch-overlay.ts` 在发出的请求体里改写 `model` |
| direct 与 Pi 运行时参数统一（`max_tokens`、DeepSeek `thinking`、GPT `reasoning_effort`、`UOM_PI_COMPAT` 兼容开关） | 同一 fetch 装饰（两条链路最终都走 HTTP），配置来自 `model-config.ts` |
| Pi provider 报错不再被"未通过提交工具交接…"掩盖 | fetch 装饰捕获非 2xx 响应体 → `http.ts` 重写 error 事件 / error JSON |
| JSON 恢复（截断、前后规划文字、非法尾逗号）+ 恢复提示 | `run-turn.ts` 包装注入的 `RunTurn`；提示经响应装饰追加到 `validation.warnings` / `understanding.warnings` |
| `UOM_MAX_DOC_CHARS` | `document-limit.ts` 在委托上游前显式拒绝超限请求（不截断正文） |
| 顶栏模型选择器 | `transformIndexHtml` 注入 `/src/overlay/main.tsx`（在应用入口之前执行）；React 挂载到 `.topbar-actions`；`window.fetch` 装饰注入 `modelOverride`；`model-list.ts` 拉取列表并显示来源 baseURL，失败时展示服务端原因而非 `HTTP 502` |
| 项目库（保存/切换/新建不丢草稿，完整切换结果） | `Storage.prototype.setItem` 装饰：上游每次自动保存草稿（`uom-forge-project-v3`，内含候选模型/自述/评估/时序等全部结果）时同步项目库；切换/新建前先落盘当前项目，然后**钉住草稿键**（`armProjectLoad`）再刷新页面——上游会在 `beforeunload` 和变更后 800ms 把内存里的工作区写回草稿键，不钉住就会把刚离开的项目当成新项目加载（并污染新激活的项目行）。库写入失败（配额/隐私模式）通过 `uom-forge-storage-error` 事件提示，不再静默丢数据 |
| 证据阅读子模块缺失时降级 | overlay 配置在子模块不可解析时加 `qq-doc-clone` alias |
| Windows 上 Codex ACP 清理 EBUSY（上游缺陷） | `tools/fs-compat.mjs` 由 `tools/overlay.mjs` 通过 `NODE_OPTIONS=--import <绝对路径>` 预加载，给 `fs.rm`/`fs.promises.rm` 加重试；`syncBuiltinESMExports()` 让上游 `import { rm } from 'node:fs/promises'` 生效 |

## Windows 的 fs.rm 重试为何走 NODE_OPTIONS

上游 `server/providers/codex.ts` 杀掉 ACP 子进程后立刻删除临时目录，Windows 上
子进程还短暂持有 cwd 句柄，`fs.rm` 报 EBUSY，于是真正的失败被文件系统错误掩盖。
修复（重试）不能写进上游源码，所以放在 `tools/fs-compat.mjs` 里 patch 内置模块。

注入方式必须是 **`NODE_OPTIONS` 而不是命令行 `--import`**：测试运行器会为每个测试
文件开一个子进程，只有环境变量能继承过去（已实测）。路径用 `file://` 绝对 URL，
因为子进程的 cwd 在临时目录，相对路径会解析失败。

早期版本把这段内嵌成 `.npmrc` 的 `node-options` data: URL；上游现在自己发了
`.npmrc`（`install-links=false`），为保持“上游文件逐字节一致”，本地 `.npmrc` 已删除，
改由 `tools/overlay.mjs` 注入。副作用：**`npm test`（上游命令）在这台 Windows 机器上
固定有 6 个 Codex ACP 测试因 EBUSY 失败**（上游缺陷：杀子进程后立刻
rmdir 临时目录），请改用 `node tools/overlay.mjs test`（同模式，已预加载 shim，
200/200）；`pull-upstream.mjs` 的验证步骤已经走后者。若希望 `npm test` 也全绿，
可把 `node-options=--import file:///F:/caochun/uom-forge/tools/fs-compat.mjs`
写进用户级 `~/.npmrc`（影响本机所有 npm 项目，自行权衡）。

另外：本机 npm 会在 `npm install` 时用自己版本重写 `package-lock.json`
（补 `dev: true`、合并平台包），`pull-upstream.mjs` 装完依赖后会自动把 lock
恢复为上游版本；手动 `npm install` 后如 git 显示 lock 被改，
`git checkout -- package-lock.json` 即可（依赖本身不受影响）。

## 上游接缝清单（上游若改动这些，需要更新 overlay，但不会产生 git 冲突）

- `server/api.ts` 的 `createApiMiddleware(runTurn)` 注入点
- `server/providers/index.ts` 的 `runProviderTurn`、`server/providers/types.ts` 的 `RunTurn`/`TurnOptions`
- `vite.config.ts`（被 overlay 配置动态 import 组合）
- 前端 DOM：`.topbar-actions`、`.assistant-toggle`、`[aria-label="推理提供方"]` 按钮的 `aria-pressed`/`disabled`
- 前端请求：`POST /api/analyze`、`/api/analyze/stream`、`/api/discuss` 的 JSON body 形状
- localStorage：`uom-forge-project-v3`、主保存按钮的 `aria-label="保存草稿"`

## 已知限制（与旧本地分支的差异）

- **`UOM_MAX_DOC_CHARS` 无法超过 120000**：上游 `server/validation/document.ts` 的
  硬上限（`validateDocument` 正文合计 120000、`requireText` 单段文本 120000）是字面量，
  实测 121307 字符的请求会被上游拒绝为“本轮最多分析 12 万个正文字符…”。
  overlay 的前置校验只能收紧或把报错说得更清楚，无法放宽：该常量位于
  `vite.config.ts` 静态 import 的 server 代码里，由 esbuild 打进配置 bundle，
  Vite 的 `resolve.alias`/插件管线根本不经过它，所以没有“不改上游文件也能替换校验器”的
  装饰点。要跑 >12 万字符的文档，只能按章节拆分，或明确授权直接改上游常量
  （会破坏“上游文件逐字节一致”，`pull-upstream.mjs` 会将其报为违规）。
- **`UOM_PI_FALLBACK=direct` 未移植**：它需要阶段级重跑（SSE 已输出部分内容），
  无法在请求边界无副作用地装饰；Pi 首轮失败现在会直接暴露 provider 的真实 HTTP 原因。
- **Pi 阶段超时**：`UOM_PI_TIMEOUT_MS` 未设置时自动取各 provider 超时的最大值
  （启动日志会打印 `[overlay] Pi 阶段超时跟随 provider 超时：…`）；取最大值而非
  “当前 provider 的值”，是为了不去在请求中修改全局环境变量（并发请求会互相干扰）。
  需要固定值就显式设置 `UOM_PI_TIMEOUT_MS`。
- **Codex（已停用的 ACP 适配器）** 的本地 `model` 覆盖未移植；仅影响
  `scripts/compare-reasoning.ts` 的手动实验。
- **项目切换依赖上游 800ms 自动保存**：overlay 在"新建/切换/保存到项目库"前会先
  点击上游的保存按钮刷新草稿，正常情况下不会丢最后几毫秒的编辑。
- **项目库占用 localStorage 配额**：每个项目存一份完整 `Project` JSON（含正文块、
  候选模型、消息记录），浏览器 5MB 左右；配额写满时会弹出“项目库保存失败”，
  已保存的项目不受影响，可先删除旧项目或导出后继续。
- **项目库没有删除/重命名入口**：只能保存和切换。项目行不会自动清理，长期
  使用会一直占着 localStorage 配额（与上一条同源，需要时可补一个列表管理面板）。
- **项目时间戳会随每次自动保存刷新**：库里的“更新时间”不是“最后一次手动保存”，
  所以下拉列表的排序会随后台自动保存变动。
- **`/api/config` 会回显各 provider 的 endpoint**（不含 key）；上游 dev server 默认监听
  `0.0.0.0`，同一局域网内的人能看到内网网关地址。不要在这个服务上暴露公网。
- **`pull-upstream.mjs` 只能校验“上游已有的文件”**：若上游未来新增一个与本地
  overlay 同名的文件（例如 `OVERLAY.md`、`tools/overlay.mjs`），合并仍会报 add/add
  冲突，需要人工选一侧。
- **GPT/Qwen 端点的回退只影响环境变量**：`provider-env.ts` 只填空值；若某提供方
  只配了一半（例如只有 key 没有 URL），overlay 不会补另一半，该提供方继续报自己的
  "未配置"错误，以免把请求发到错误的端点。

## 上游更新流程

```bash
node tools/pull-upstream.mjs
```

守卫规则：上游树中存在的任何文件只要在本地（含未提交改动）与 `origin/main` 有差异，
工具就拒绝合并并列出文件——这正是会产生冲突的状态。正确做法是把该功能迁移到
overlay 目录，然后 `git checkout origin/main -- <文件>` 恢复上游版本。

验证命令（与 CI 等价）：

```bash
npm run typecheck
npm test                          # 上游 + overlay 全部测试
node tools/overlay.mjs build
git diff origin/main --stat       # 只应出现 overlay 文件
```
