# Overlay：不修改上游源码的本地扩展

本仓库相对上游的全部本地改动集中在 `server/overlay/`、`src/overlay/`、`tools/`、
`vite.overlay.config.ts`、`.npmrc` 与 `OVERLAY.md`；上游文件保持逐字节一致，因此
`git merge origin/main` 不会产生任何冲突。本地功能全部通过"装饰器"（组合、注入、
包装、监听）挂接在上游的接缝上。此外还有三类原本就只存在于本地的文件
（上游没有、也不会与之冲突）：`.env.example`、中文分析文档（`*分析.md/.html`）、
`src/components/evidence/evidence-reader-fallback.jsx`。

## 快速开始

```bash
# 开发（overlay 配置：本地功能全部生效）
node tools/overlay.mjs dev          # 等价于 vite --config vite.overlay.config.ts

# 直接使用上游原版（没有任何本地功能，用于对照/排查）
npm run dev

# 生产构建 / 预览（overlay 配置）
node tools/overlay.mjs build
node tools/overlay.mjs preview

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
  overlay.mjs                 用 overlay 配置运行 vite
  pull-upstream.mjs           无冲突拉取工作流 + 上游文件清洁守卫
  fs-compat.mjs               Windows EBUSY 重试（见下）
  build-npmrc.mjs             由 fs-compat.mjs 生成 .npmrc
.npmrc                        npm 通过 node-options 加载 fs-compat.mjs（data: URL，见下）
```

## 功能 → 装饰点对照

| 本地功能 | 装饰方式 |
| --- | --- |
| `.env` 加载（项目根 + 上级 UOM 目录；改 .env 后配置热加载） | `server/overlay/vite-config.ts` 先加载环境，再动态 `import('../../vite.config.ts')` 组合 |
| `/api/config`、`/api/models` 路由 | overlay middleware 注册在上游 API plugin 之前；命中即响应，其余 `next()` 委托 |
| `modelOverride`（每次请求切换模型） | `http.ts` 缓冲请求体 → 校验 → 存入 AsyncLocalStorage；`fetch-overlay.ts` 在发出的请求体里改写 `model` |
| direct 与 Pi 运行时参数统一（`max_tokens`、DeepSeek `thinking`、GPT `reasoning_effort`、`UOM_PI_COMPAT` 兼容开关） | 同一 fetch 装饰（两条链路最终都走 HTTP），配置来自 `model-config.ts` |
| Pi provider 报错不再被"未通过提交工具交接…"掩盖 | fetch 装饰捕获非 2xx 响应体 → `http.ts` 重写 error 事件 / error JSON |
| JSON 恢复（截断、前后规划文字、非法尾逗号）+ 恢复提示 | `run-turn.ts` 包装注入的 `RunTurn`；提示经响应装饰追加到 `validation.warnings` / `understanding.warnings` |
| `UOM_MAX_DOC_CHARS` | `document-limit.ts` 在委托上游前显式拒绝超限请求（不截断正文） |
| 顶栏模型选择器 | `transformIndexHtml` 注入 `/src/overlay/main.tsx`（在应用入口之前执行）；React 挂载到 `.topbar-actions`；`window.fetch` 装饰注入 `modelOverride` |
| 项目库（保存/切换/新建不丢草稿） | `Storage.prototype.setItem` 装饰：上游每次自动保存草稿时同步项目库；UI 写 `uom-forge-project-v3` + `uom-forge-active-project-v1` 后刷新页面 |
| 证据阅读子模块缺失时降级 | overlay 配置在子模块不可解析时加 `qq-doc-clone` alias |
| Windows 上 Codex ACP 清理 EBUSY（上游缺陷） | `tools/fs-compat.mjs` 通过 `.npmrc` 的 `node-options` 预加载，给 `fs.rm`/`fs.promises.rm` 加重试；`syncBuiltinESMExports()` 让上游 `import { rm } from 'node:fs/promises'` 生效 |

## 为什么 `.npmrc` 里是一大串 data: URL

`npm test` 会启动多个 Node 子进程，其中 ACP 测试的子进程 cwd 在临时目录。
若 `node-options=--import ./tools/fs-compat.mjs`，子进程会按自己的 cwd 解析相对
路径而加载失败。因此 `.npmrc` 里内嵌的是 `data:text/javascript,...`（与 cwd 无关、
可移植）。修改 `tools/fs-compat.mjs` 后运行：

```bash
node tools/build-npmrc.mjs
```

`pull-upstream.mjs` 和守卫检查会校验二者同步。

## 上游接缝清单（上游若改动这些，需要更新 overlay，但不会产生 git 冲突）

- `server/api.ts` 的 `createApiMiddleware(runTurn)` 注入点
- `server/providers/index.ts` 的 `runProviderTurn`、`server/providers/types.ts` 的 `RunTurn`/`TurnOptions`
- `vite.config.ts`（被 overlay 配置动态 import 组合）
- 前端 DOM：`.topbar-actions`、`.assistant-toggle`、`[aria-label="推理提供方"]` 按钮的 `aria-pressed`/`disabled`
- 前端请求：`POST /api/analyze`、`/api/analyze/stream`、`/api/discuss` 的 JSON body 形状
- localStorage：`uom-forge-project-v3`、主保存按钮的 `aria-label="保存草稿"`

## 已知限制（与旧本地分支的差异）

- **`UOM_MAX_DOC_CHARS` 无法超过 120000**：上游 `validateDocument` 的硬上限仍在，
  overlay 的前置校验只能收紧或给出更清晰的报错，无法放宽。
- **`UOM_PI_FALLBACK=direct` 未移植**：它需要阶段级重跑（SSE 已输出部分内容），
  无法在请求边界无副作用地装饰；Pi 首轮失败现在会直接暴露 provider 的真实 HTTP 原因。
- **Pi 阶段超时**：不再按 provider 超时自动放宽，使用上游默认 300000ms；
  需要更久请显式设置 `UOM_PI_TIMEOUT_MS`。
- **Codex（已停用的 ACP 适配器）** 的本地 `model` 覆盖未移植；仅影响
  `scripts/compare-reasoning.ts` 的手动实验。
- **项目切换依赖上游 800ms 自动保存**：overlay 在"新建/切换/保存到项目库"前会先
  点击上游的保存按钮刷新草稿，正常情况下不会丢最后几毫秒的编辑。

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
