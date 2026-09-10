# UOM Forge

Evidence-first domain modeling workbench. Forge produces a provider-neutral candidate
model from business documents and lets a domain expert review the evidence before it
is exported to a runtime-specific model.

The project will encode a repeatable modeling methodology that helps domain experts
identify stable concepts, business objects, facts, relations, constraints, and
capabilities before describing business processes.

## Prototype

The browser UI keeps the working document, candidate model, activity assessment and
conversation in local browser storage. Analysis is performed by the local Vite
server through the standard Agent Client Protocol (ACP): the server starts the
installed `@agentclientprotocol/codex-acp` adapter, creates a temporary read-only
Codex session, sends the evidence blocks, and validates the returned model before
showing it. Forge keeps provider credentials on the server and never exposes them to the
browser. 建模请求使用 `/api/analyze/stream` 以 SSE 流式返回阶段状态和当前提供方的输出片段，
完整 JSON 在服务端接收完毕并通过证据校验后才应用到工作区；`/api/analyze` 仍提供非流式调用。

建模采用三个阶段：先形成独立的业务理解，再生成候选对象关系模型，最后评估模型对业务过程的支撑情况。
用户反馈后保留业务理解，从候选模型阶段重新生成并再次评估。

业务文档视图使用 `src/components/evidence/qq-doc-clone` 子模块中的
`QQDocEditor` 作为证据阅读组件。Forge 以嵌入、只读模式加载文档，保留原始文档的
排版和后续证据定位能力；QQ 文档组件本身仍作为独立项目维护，Forge 不复制其实现。
上传入口支持 DOCX、Markdown、TXT 和 HTML；DOCX 在浏览器端转换为 HTML 后交给编辑器展示。

子模块更新后，在本目录执行：

```bash
git submodule update --init --recursive
npm install
```

子模块尚未检出时（例如刚 clone 或没有该仓库的访问权限），Forge 不会白屏：`vite.config.js`
会把 `qq-doc-clone` 别名到 `src/components/evidence/evidence-reader-fallback.jsx`，以内置只读
渲染保留文档排版，证据分块、建模、校验与评估全部照常工作（仅缺少批注与证据定位）；
启动日志会提示一次降级状态，子模块检出后别名自动失效，无需改任何代码。

```bash
npm install
npm run dev
```

The Codex provider uses the installation and configuration available to the user
running the Vite server. The `deepseek` and `private` providers are the same
OpenAI-compatible chat-completions client with different environment variables, so
`private` targets a self-hosted or intranet model server. Both expose the same staged
interface and return the same validated provider-neutral model containing objects,
relations, actions, functions, rules, activities, questions and block-level evidence.
`/api/discuss` uses the selected provider through the same interface.

## 私有模型（OpenAI 兼容端点）

任何暴露 `POST /v1/chat/completions` 的服务（vLLM、llama.cpp、自建网关等）都可以直接
接入，无需改代码。在项目根目录 `.env`（已被 .gitignore 忽略）中写入：

```bash
UOM_LLM_PROVIDER=private
PRIVATE_LLM_API_URL=http://127.0.0.1:8000/v1
PRIVATE_LLM_API_KEY=sk-123
PRIVATE_LLM_MODEL=qwen3.8-flash-next
LLM_API_TIMEOUT_MS=900000   # 本地推理较慢时放宽，默认 300000
```

- `PRIVATE_LLM_API_URL` 写到 `/v1` 或写全 `/v1/chat/completions` 都可以。
- 变量前缀为 `PRIVATE_LLM_`，未设置时回退到通用的 `LLM_API_URL` / `LLM_API_KEY` / `LLM_MODEL`
  （这三项是 `deepseek` 提供方的配置，因此两套配置互不干扰）。
- `local`、`openai` 是 `private` 的别名；UI 顶栏的提供方切换会覆盖 `UOM_LLM_PROVIDER`。
- 密钥只在服务端进程内使用，`GET /api/config` 只返回提供方名称、模型名与是否已配置，
  永不返回密钥；未配置的提供方在 UI 上会被标为「未配置」。
- 推理型模型（Qwen thinking、DeepSeek R1 等）的 `reasoning_content` 只作为进度转发给 UI，
  不会进入结构化 JSON 的解析内容。
- 弱模型偶尔不按 JSON 输出（先输出规划文字）或被 max tokens 截断。服务端会依次尝试：
  提取混杂在文字里的最外层 JSON 对象、修复被截断的 JSON、追加一轮「只输出 JSON」的
  多轮修复请求；自动恢复发生时会在会话里明确提示，修复结果需重点核对。若两次都无法
  解析，报错会带上模型输出预览，便于判断是提供方问题还是提示词问题。
- 部分端点（如 DeepSeek）默认输出上限只有几千 token，大模型 JSON 会被截断；可在 .env
  设置 `LLM_MAX_OUTPUT_TOKENS=32768` 显式放宽（需小于模型上下文减去提示词长度）。

配置是否生效可用 `curl http://127.0.0.1:5173/api/config` 自检。

## 文档体量上限

`validateDocument` 默认拒绝正文超过 **12 万字符**的文档，并且**从不截断**：截断会制造
“某概念无原文依据”这种无法分辨是“文档里真没有”还是“被剪掉了”的现象，让整个证据面板说谎。
需要处理更大的文档时在 `.env` 中调高：

```bash
UOM_MAX_DOC_CHARS=140000
```

取值请按推理模型的上下文预算：`prompt tokens ≈ 正文字符数 × 1.25`（证据块 JSON 包装开销），
剩下部分要留给输出 JSON。超限报错会直接告知实际字符数、当前上限与超限百分比。

失败提示分三类（服务端错误携带 `kind`）：`document`（文档无效或超限）、`model`（结构/引用/
逐字引文未通过校验）、`provider`（推理后端连接、超时或 HTTP 错误），UI 按类型给出对应指引。

The UI provider switch is saved locally for the next session. The server default comes
from `UOM_LLM_PROVIDER` (`private` in the example above); it applies until the switch is
used once. DeepSeek credentials are loaded from the project or parent UOM `.env` and
remain server-side.

默认单次 ACP 分析最长等待 5 分钟。文档较大或 Codex 推理较慢时，可通过
`CODEX_ACP_TIMEOUT_MS`（毫秒）调整，例如 `CODEX_ACP_TIMEOUT_MS=600000`。

The server starts with:

```bash
npm install
npm run dev -- --host 127.0.0.1
```

The Codex adapter needs a working Codex login or API-compatible provider in the
user's Codex configuration. If the ACP call fails, the UI reports the error and
keeps the previous draft; it never silently falls back to fixed demo data.
