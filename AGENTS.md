# AGENTS.md — 本仓库的 Agent 工作规范

> 本文件面向所有在此仓库工作的 AI 编码代理（pi、deepseek harness 等）与人类协作者。
> 详细设计文档见 `OVERLAY.md`；本文件是**必须遵守的硬性约束**。

## 唯一目标（先读这一段）

**上游文件逐字节一致，`git merge origin/main` 永不冲突。**

本仓库所有本地功能都以"装饰器模式"（overlay）挂在上游代码的接缝上，而不是直接改
上游源码。违反本规范的改动会让每次拉取上游都变成手工冲突解决——这是本仓库最贵
的错误，没有之一。

## 硬性规则（无例外）

### 规则 1：禁止修改任何上游文件

判定方法（唯一标准，不要凭记忆判断）：

```bash
git cat-file -e "origin/main:<path>" && echo "上游文件，禁止修改"
```

上游文件包括但不限于：`package.json`、`package-lock.json`、`tsconfig.json`、
`tsconfig.app.json`、`vite.config.ts`、`index.html`、`.npmrc`、`README.md`、
`docs/**`、`scripts/**`、`shared/**`、`server/**`、`src/**`。

特别注意：

- `.npmrc` 现在是上游文件（`install-links=false`），不得再往里加 `node-options`。
- Windows 的 `fs.rm` 重试 shim 由 `tools/overlay.mjs` 通过 `NODE_OPTIONS` 注入，
  不要为了"修 EBUSY"去改上游的 `server/providers/codex.ts` 或恢复本地 `.npmrc`。

### 规则 2：本地代码只能写在这些位置

这些路径上游不存在，因此永远不会冲突：

| 位置 | 职责 |
| --- | --- |
| `server/overlay/**` | 服务端装饰器：middleware、全局 fetch 装饰、RunTurn 包装、env 别名、模型配置 |
| `src/overlay/**` | 前端装饰器：顶栏 UI、`window.fetch`/`Storage` 装饰、项目库 |
| `tools/**` | 本地工具：`overlay.mjs`（dev/build/preview/test 入口）、`pull-upstream.mjs`、`fs-compat.mjs` |
| `vite.overlay.config.ts` | overlay 的 Vite 配置（动态组合上游配置，上游零改动） |
| `OVERLAY.md`、`AGENTS.md`、`.env.example`、`analysis/**` | 本地文档与配置样例 |
| `src/components/evidence/evidence-reader-fallback.jsx` | 子模块缺失时的降级组件 |
| `server/overlay/*.test.ts`、`src/overlay-*.test.ts` | overlay 测试（前端测试必须放 `src/` 顶层，受根 tsconfig include 限制） |

### 规则 3：新建文件前先确认上游没有同名路径

上游未来可能新增与我们同名的文件（add/add 冲突，守卫查不到）：

```bash
git cat-file -e "origin/main:<new-path>" && echo "换个名字或换位置"
```

## 装饰器模式：怎么"改"上游行为

不改上游文件，而是通过接缝装饰。现有接缝清单（上游若改了这些，更新 overlay 侧，
**而不是改上游**）：

- **Vite 配置组合**：`server/overlay/vite-config.ts` 动态 `import` 上游 `vite.config.ts` 再合并
- **API middleware**：上游 `createApiMiddleware(runTurn)` 注入点；overlay middleware 前插、命中即响应、其余 `next()` 委托
- **全局 `fetch`**：`server/overlay/fetch-overlay.ts`（请求体重写 + provider 失败捕获）
- **`RunTurn`**：`server/overlay/run-turn.ts` 包装（JSON 恢复）
- **请求上下文**：`server/overlay/context.ts`（AsyncLocalStorage，并发隔离）
- **前端入口**：`transformIndexHtml` 注入 `/src/overlay/main.tsx`（在应用入口之前）
- **DOM 挂载点**：`.topbar-actions`、`.assistant-toggle`、`[aria-label="推理提供方"]`（含 `aria-pressed`/`disabled`）、`button[aria-label="保存草稿"]`
- **`Storage.prototype.setItem`**：`src/overlay/storage-sync.ts`（项目库镜像 + 切换时钉住草稿键）
- **环境变量别名**：`server/overlay/provider-env.ts`（只填空值，显式配置优先，可关闭）

需要新行为时：先找接缝；找不到就在 overlay 里造接缝（middleware 前插、模块别名、
事件监听、原型装饰），仍然不碰上游文件。

## 常用命令（一律走 overlay 入口）

```bash
node tools/overlay.mjs dev        # 开发（本地功能全部生效）
node tools/overlay.mjs build      # 生产构建（overlay 配置）
node tools/overlay.mjs preview    # 预览
node tools/overlay.mjs test       # 测试（带 Windows fs.rm 重试 shim）
npm run typecheck                 # 类型检查
node tools/pull-upstream.mjs      # 拉取上游（守卫 + merge + 安装依赖 + 验证）
npm run dev                       # 纯上游对照（没有任何本地功能，用于排查）
```

## 提交前自检（每次提交都必须通过）

```bash
# 1) 上游文件零改动（无输出 = 通过）
{ git diff --name-only origin/main HEAD; git diff --name-only origin/main; } | sort -u |
  while read -r p; do git cat-file -e "origin/main:$p" 2>/dev/null && echo "违规: $p"; done

# 2) 类型 + 测试 + 构建
npm run typecheck && node tools/overlay.mjs test && node tools/overlay.mjs build
```

## 已知限制与陷阱（不要试图在上游"修"它们）

- **正文 120000 字符硬上限**：上游 `server/validation/document.ts` 的字面量常量，
  overlay 无法放宽（该模块被 `vite.config.ts` 静态 import、打进配置 bundle，Vite 的
  别名/插件管线不经过它）。`UOM_MAX_DOC_CHARS` 只能 ≤ 120000，超限请拆分文档。
- **`npm test` 在 Windows 上固定挂 6 个 Codex ACP 测试**（`EBUSY: rmdir uom-forge-acp-*`，
  上游缺陷：杀子进程后立刻删临时目录）。用 `node tools/overlay.mjs test`（全绿）。
  不要为此改上游或加回本地 `.npmrc`。
- **本机 npm 会重写 `package-lock.json`**（补 `dev: true`、合并平台包）：手动
  `npm install` 后如 git 显示 lock 被改，`git checkout -- package-lock.json`；
  `pull-upstream.mjs` 装完依赖会自动恢复。
- **Pi 阶段超时**：`UOM_PI_TIMEOUT_MS` 未设置时由 overlay 取各 provider 超时的最大值
  （启动日志会打印）；显式设置永远优先。
- **未授权不得 `git push`。**
- 上游 dev server 监听 `0.0.0.0`，`/api/config` 会回显内网网关地址（不含 key）——
  不要把该服务暴露到公网。

## 发现上游文件被改了怎么办（自愈流程）

```bash
git diff --name-only origin/main -- <path>   # 确认差异
git checkout origin/main -- <path>           # 恢复上游版本
```

然后把该改动迁移到 overlay（参考 `OVERLAY.md` 的"功能 → 装饰点对照"表），
重新提交。`tools/pull-upstream.mjs` 的守卫会在合并前把这类文件列出来并拒绝合并。
