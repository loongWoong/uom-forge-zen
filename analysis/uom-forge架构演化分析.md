# UOM Forge 架构演化分析报告

> **分析对象**：`F:/caochun/uom-forge` 的 git 历史
> **分析日期**：2026-09-10
> **依据**：全量 3 个提交（`git log --all`），时间跨度 2026-09-08 22:15 → 2026-09-09 22:47，合计 **31 小时 32 分钟**；逐提交 `--name-status` + `git show` + `git show <commit>:<path>` 取回旧版本全文比对
> **规模说明（依据 skill 约定）**：本项目历史极短（3 提交、无分支、无 stash），本报告因此不覆盖"长期领域模型扩张"，而是完整还原一次**压缩在一天半内的范式切换**——它恰好包含了一次单体演示壳 → 分层可信系统的完整重构，证据密度足以支撑演化规律结论。

## 结论先行

1. 三个提交构成三个阶段：**宣言期 → 演示壳期 → 证据转向期**。真正的架构诞生发生在第 3 个提交 `71c1887`，它同时完成三件事：物理删除全部演示数据、从零建立服务端守护层与共享契约层、把 README 的项目定义从"产出已验证的 UOM/OAG 模型"改写为"产出 Provider 中立的候选模型"。
2. 决定性重构的**主要动作不是新增功能，而是移动职责**：模型形状定义上移为跨端契约、校验与提示词下沉到服务端、领域词汇（电网高压接入）从代码中彻底移出到运行时文档。约 130 行硬编码领域数据被替换为三个空数组加一句注释。
3. 守护层不是先验设计，而是**被真实故障塑造**的：`hydrateEvidence` 的注释与第 3 个测试用例直接对应"ACP 输出把有效块 id 配上转述引文"这一实际观察到的失败模式——这是本项目最有价值的"领域需求反向驱动基础层"证据。
4. 演化的方向可以一句话概括：**从"让流程看起来可用"转向"让结论可被追责"**。

---

## 1. 演化时间线总览

| 阶段 | 提交 | 日期时刻 | 间隔 | 文件数（去锁文件） | 性质 |
| --- | --- | --- | --- | --- | --- |
| A 宣言期 | `6281ba3` | 2026-09-08 22:15 | — | 1 | 文档沉淀（方法论宣言） |
| B 演示壳期 | `9c2b7e2` | 2026-09-08 22:59 | +44 min | 7 | 增量功能（纯前端原型） |
| C 证据转向期 | `71c1887` | 2026-09-09 22:47 | +23 h 48 min | 15 | **范式切换 + 重命名级重构** |

```
22:15 ── 44min ──▶ 22:59 ──── 23h48m ────▶ 22:47(次日)
  A 宣言              B 演示壳                 C 证据转向
 README only      单文件前端 + 假分析      五层架构 + 八级校验 + 双 Provider
```

提交体量：B 为 +1,824 行（全新文件）；C 为 **+4,984 / −648**，其中 `src/main.jsx` 单独变化 635 行（+373 / −262），即原型文件被改写了近半。

---

## 2. 阶段详解

### 阶段 A · 宣言期（`6281ba3`，仅 README）

初始 README 的一句话定位包含两个后来都被推翻的断言：

```
LLM-assisted domain modeling workbench for producing validated UOM/OAG domain models.
```

- **"validated UOM/OAG domain models"**：预设了①产物的验收方是某个具体运行时（UOM/OAG），②Forge 自身拥有"validated"的资格。
- 但同一段已经写下了会保留至今的方法论内核：*"identify stable concepts, business objects, facts, relations, constraints, and capabilities **before** describing business processes"*——先概念后过程，这条约束在阶段 C 变成了 `modelingPrompt` 里的显式指令（"概念只建模为对象及其关系……不要把过程步骤机械地建成对象"，modeling.js:163）。

**阶段 A 的意义**：方法论先于实现被写下来，后续代码是对它的逐步兑现与对首句定位的自我修正。

### 阶段 B · 演示壳期（`9c2b7e2`）

一次提交交付 7 个文件、1,824 行。全部逻辑在 `src/main.jsx`（538 行），`vite.config.js` 只有 10 行（`plugins:[react()]` + `envDir`），**没有任何服务端代码**。

系统当时的"领域"是硬编码在源码里的电网高压接入业务（`/tmp/old-main.jsx` L39-166）：

```js
// 旧版 src/main.jsx（9c2b7e2）L39 起
const DEFAULT_DOCUMENT = { name: '高压接入方案业务规则说明.md', content: [...].join('\n') }
const INITIAL_OBJECTS = [
  { id: 'demand', name: '用电需求', ..., fields: ['需求类型', '供电电压', '合同容量', '用户重要等级'] },
  { id: 'supply-point', name: '电源点', ... }, { id: 'feeder', name: '馈线', ... },
  { id: 'substation', name: '变电站', ... }, { id: 'plan', name: '供电方案', ... },
]
const INITIAL_RELATIONS = [
  { from: '用电需求', label: '筛选', to: '电源点' },
  { from: '电源点', label: '关联', to: '馈线' }, ...
]
const INITIAL_ACTIVITIES = [
  { id: 'new-install', ..., coverage: 86, status: 'supported', elements: ['用电需求', '电源点', '馈线', '变电站', '容量校核'] },
  { id: 'capacity-upgrade', ..., coverage: 68, ... }, ...
]
```

三个"假"的机制：

```js
// 旧版 L249-259：假分析 —— 定时器 + 固定话术
const runAnalysis = () => {
  setIsAnalyzing(true)
  setMessages((c) => [...c, { role: 'assistant', content: '正在对文档进行分段理解，并将候选概念映射到模型元素……' }])
  window.setTimeout(() => { setIsAnalyzing(false); setActiveView('model')
    setMessages((c) => [...c, { role: 'assistant', content: '首轮建模完成。建议先确认"用电需求"和"电源点"的边界……' }])
  }, 1050)
}

// 旧版 L282-292：假讨论 —— 关键词分支
window.setTimeout(() => {
  const response = content.includes('设备')
    ? '文档确实提到设备投运年限、缺陷和历史停电，但目前它们只作为评分依据出现……'
    : '我会把这条意见记录为模型调整建议……'
  setMessages((c) => [...c, { role: 'assistant', content: response }])
}, 620)
```

同时，LLM 的"配置状态"是前端环境变量存在性判断：

```js
// 旧版 L208
const llmConfigured = Boolean(import.meta.env.VITE_LLM_API_URL && import.meta.env.VITE_LLM_MODEL)
```

当时的 README 对这种状态是坦白的：*"The built-in demo provider makes the workflow usable before an LLM gateway is added."* —— 演示优先，真实性后置。

**阶段 B 的三个结构性特征**（决定了 C 必须重构什么）：
1. **展示层拥有全部真相**：模型、关系、活动、覆盖率全是前端常量，`INITIAL_RELATIONS`/`INITIAL_ACTIVITIES` 甚至没有对应的 setter（不可变）。
2. **无契约**：对象的形状就是字面量的形状（`fields: string[]`），关系是 `{from,to,label}` 名称三元组，覆盖率是字面量数字。
3. **无校验**：不存在任何"这个模型合法吗"的概念。

### 阶段 C · 证据转向期（`71c1887`）

一次提交引入 8 个新文件、删除演示数据、改写 README。详见第 3 节。

---

## 3. 决定性重构深挖：`71c1887`

### 3.1 文件迁移与职责变化对照表

| 演化前（`9c2b7e2`） | 演化后（`71c1887`） | 职责变化方向 |
| --- | --- | --- |
| — | `shared/model-contract.js`（+51） | **上移·抽象化**：模型形状从"前端字面量的形状"升格为前后端共用的 JSON Schema 契约 |
| — | `server/modeling.js`（+261） | **下沉·机制化**：文档闸门、四阶段提示词、规范化器、八级校验管道，前端不再拥有真相 |
| — | `server/codex-acp.js`（+178） | **新增·集成层**：Codex ACP 子进程与 DeepSeek 流式，双 provider 统一接口 |
| — | `server/modeling.test.js`（+33） | **新增**：校验管道获得回归保护（3 例，全部针对证据可信性） |
| `vite.config.js`（10 行） | `vite.config.js`（92 行） | **升格**：从"构建配置"变成"传输层 / API 服务器"（`uom-forge-api` 插件 + SSE） |
| `src/main.jsx` 538 行 | `src/main.jsx` 649 行（+373/−262） | **降格**：从"演示数据宿主 + 假分析"降为"证据呈现 + 人工确认壳" |
| `INITIAL_OBJECTS`（5 对象）/`INITIAL_RELATIONS`（4 关系）/`INITIAL_ACTIVITIES`（4 活动）≈130 行电网领域数据 | `= []` + 注释（main.jsx:51-53） | **移出代码**：领域词汇物理删除，领域内容只能在运行时由文档提供 |
| `runAnalysis` = `setTimeout(1050)` | `runStage` → `/api/analyze/stream` → `*WithProvider` | 假延时 → 真推理 + SSE 阶段事件 |
| `sendMessage` = `setTimeout(620)` + `includes('设备')` | `discussionPrompt` + `/api/discuss` | 模板回复 → 真讨论，且新增约束"此轮仅讨论，不声称修改了模型"（modeling.js:188） |
| 关系 `{from:'用电需求', label:'筛选', to:'电源点'}` | `{id, from:objId, to:objId, properties, evidence}` | 名称标签 → **id 引用 + 端点存在性校验** |
| `activities[].coverage = 86/68/54/41`（字面量） | `activityCoverage(requirements)` 推导（contract:34） | **状态由事实推导**：不再直接存百分比 |
| `localStorage 'uom-forge-project'`（无版本） | `'uom-forge-project-v3'` + `version:3` + `version<2` 拒读 | 草稿获得版本契约与迁移闸门 |
| `llmConfigured = Boolean(VITE_*)` | `llmConfigured = true`；凭据改为服务端 `process.env` | 凭据从浏览器可见 → 服务端独占（代价见 §5.3） |
| 4 视图（文档/模型/活动/评估） | 5 视图（文档/理解/模型/**自述**/评估） | 方法论阶段显式化为 UI 阶段 |
| — | `.gitmodules` + `src/components/evidence/qq-doc-clone` | 证据阅读能力外置为独立子项目 |
| — | `deploy/uom-forge.service` | 获得部署形态（systemd + EnvironmentFile） |
| `package.json` 5 依赖、无 test | 12 依赖 + `"test": "node --test server/*.test.js"` | 工程化基线（ajv/dompurify/mammoth/react-markdown/ACP SDK） |

### 3.2 三条分层本质

**（1）上移 = 抽象化：模型形状脱离业务。** 阶段 B 里"对象长什么样"由前端字面量决定；阶段 C 把它抽到 `shared/model-contract.js`，并显式声明中立性：

```js
// shared/model-contract.js:14
// Provider-neutral modeling output; no dependency on UOM/OAG runtime schemas.
```

这行注释正是对阶段 A README 首句（"validated UOM/OAG domain models"）的正面否定——契约**故意不认识** UOM/OAG。

**（2）下沉 = 机制化：校验与提示词进入服务端。** 阶段 B 没有任何校验概念；阶段 C 的 `analyzeWithProvider` 把"信任"从展示层彻底移走：

```js
// server/codex-acp.js:12-17（阶段 C 新增）
validateDocument(document)
const text = await runProviderTurn(modelingPrompt(document, currentModel, instruction), options)
const model = hydrateEvidence(normalizeModel(parseModel(text)), document)
const validation = validateModel(model, document)
```

同时凭据也一并下沉：README 新增 "Forge keeps provider credentials on the server and never exposes them to the browser"，`vite.config.js:9` 显式 `loadEnv` 父目录 `.env` 到 `process.env`。

**（3）领域化 = 从代码里搬走：注册方式从"改代码"变成"给文档"。** 阶段 B 新增一个业务领域 = 改写 `INITIAL_OBJECTS/RELATIONS/ACTIVITIES` 三组常量（并让假数据与真实文档无关）。阶段 C 之后：

```js
// src/main.jsx:51-53-54
/* Demo candidates are intentionally not loaded. Analysis must come from the
   current evidence document through the ACP provider. */
const INITIAL_OBJECTS = []
```

**代码不再携带任何领域词汇**——机制（如何建模、如何校验）与词汇（哪个行业）彻底分离，新增领域的成本从"改代码 + 编演示数据"降为"上传一份文档"。这是本项目最彻底的一次抽象下沉。

### 3.3 README 的概念边界移动（同一提交内）

```diff
-LLM-assisted domain modeling workbench for producing validated UOM/OAG domain models.
+Evidence-first domain modeling workbench. Forge produces a provider-neutral candidate
+model from business documents and lets a domain expert review the evidence before it
+is exported to a runtime-specific model.
```

三个语义变化同时发生：**证据优先**（evidence-first）取代 **LLM 辅助**；**候选**（candidate）取代 **已验证**（validated）；**运行时专属模型是导出后的下游产物**，不是 Forge 的产物。

以及可靠性承诺的反转：

```diff
-The built-in demo provider makes the workflow usable before an LLM gateway is added.
+If the ACP call fails, the UI reports the error and keeps the previous draft;
+it never silently falls back to fixed demo data.
```

新增的方法论段落也值得注意——它把阶段划分写成了契约：*"建模采用三个阶段：先形成独立的业务理解，再生成候选对象关系模型，最后评估模型对业务过程的支撑情况。用户反馈后保留业务理解，从候选模型阶段重新生成并再次评估。"* 对应实现正是 `runAnalysis` 的 L219（`fromFeedback && understanding ? understanding : await runStage('understand', ...)`）。

---

## 4. 领域/需求反向驱动基础层的证据

阶段 C 之后基础层被"需求"塑形的位置有四处，都能在代码里指认：

**（1）真实 LLM 故障 → 证据修复机制（最强证据）。** `hydrateEvidence` 的注释直接记录了观察到的失败模式：

```js
// server/modeling.js:132-134
// ACP output occasionally pairs a valid block id with a paraphrase rather
// than a verbatim quote. Keep only grounded citations, and repair the block
// id when the same quote is present elsewhere in the document.
```

配套的回归测试（`server/modeling.test.js:24-31`）断言转述引文被丢弃且模型仍通过校验——**故障观察 → 基础层新增能力 → 测试固化**，完整的反向驱动闭环。

**（2）Provider 行为差异 → 传输层协议扩展。** DeepSeek 会先吐长串思考流，基础层为此在 delta 事件上增加了 `reasoning: true` 标志，把"给 UI 看的进度"与"给 JSON 解析器吃的内容"分成两条流：

```js
// server/codex-acp.js:92-97
if (reasoning) report({ type: 'delta', text: reasoning, size: ..., reasoning: true })
if (text) { responseText += text; report({ type: 'delta', text, size: responseText.length }) }
```

**（3）方法论要求"自述必须独立" → 传输层多出一条协议规则。** 阶段隔离不是靠提示词自觉，而是靠请求体物理裁剪，且前端同步：

```js
// src/main.jsx:192
if (stage !== 'narrate') requestBody.document = document
```

**（4）证据阅读保真需求 → 基础层开放嵌入契约。** Forge 没有复制文档编辑器，而是以子模块引入并约定嵌入协议（`embedded readOnly initialTitle initialContent`，main.jsx:439-444）。README 明确边界：*"QQ 文档组件本身仍作为独立项目维护，Forge 不复制其实现。"* 基础层（工作台外壳）因此获得了一个可替换的证据呈现插槽。

---

## 5. 演化规律总结

### 5.1 维度对比表

| 维度 | 演化前（阶段 B） | 演化后（阶段 C） |
| --- | --- | --- |
| 领域内容来源 | 硬编码电网演示常量（≈130 行） | 运行时上传文档的证据块，代码零领域词汇 |
| 分析真实性 | `setTimeout(1050)` + 固定话术 | 真 LLM 推理 + SSE 阶段/增量事件 + 八级校验 |
| 模型形态定义权 | 前端字面量形状（`fields: string[]`） | `shared` JSON Schema（`additionalProperties:false`，前后端共用） |
| 关系表示 | 名称三元组 `{from:'用电需求',label,to}` | `{id, from:objId, to:objId}` + 端点存在性校验 |
| 支撑度来源 | 字面量 `coverage: 86` | `activityCoverage(requirements)` 由逐项状态推导 |
| 讨论能力 | 关键词分支模板回复 | provider 驱动 + "此轮仅讨论，不声称修改了模型" |
| Provider 抽象 | `VITE_*` 变量存在性判断 | 双 provider 统一接口，`runProviderTurn` 4 行分发，凭据服务端独占 |
| 阶段/视图 | 4 视图（文档/模型/活动/评估） | 5 视图（新增业务理解、模型自述），阶段即 UI |
| 失败策略 | 演示兜底（"demo provider 让流程先可用"） | 显式报错 + 保留上一轮草稿 + 禁止静默兜底 |
| 工程基线 | 无测试、无部署 | `node --test` 3 例 + systemd unit + 子模块工作流 |
| 前端状态复杂度 | 13 个 `useState` | 28 个 `useState`（流式、阶段、多 provider、问题答案的成本） |

### 5.2 驱动力量

1. **诚实性觉醒**：阶段 B 的坦白（"demo provider 让流程先可用"）在阶段 C 被改写为禁令（"never silently falls back to fixed demo data"）。驱动力量不是性能或功能，而是**工具的可信性定位**——一个会编造领域模型的演示工具没有价值。
2. **概念边界重划（范式觉醒）**：README 首行重写意味着"Forge 的产物是什么"被重新定义——从"运行时的已验证模型"变成"可导出前的中立候选 + 证据"。这个定义变化一次性决定了契约层（中立 schema）、守护层（证据校验）与 UI（一律 `status:'review'`）三者的存在理由。
3. **真实故障反向塑造基础层**：一旦接入真 LLM，"转述引文""围栏包裹 JSON""紧凑词汇""长思考流"等真实故障立刻要求规范化器、解析器、delta 分类器与证据修复器——守护层的每一条几乎都对应一种具体不可靠性，而非先验的架构美学。
4. **方法论先于代码**：阶段 A 的"先概念后过程"、阶段 C 的"三阶段建模"段落都先出现在 README，随后才在 prompt 与 `runAnalysis` 中兑现——文档沉淀驱动实现，而非事后补写。

### 5.3 演化的残留与漂移（诚实清单）

演化并非无损，以下残留可在代码中直接指认：

| 残留 | 位置 | 性质 |
| --- | --- | --- |
| `ActivitiesView` 组件已无渲染点 | `src/main.jsx:606` | 阶段 B 的"业务活动"视图残留（其职责被 `AssessmentView` 吸收） |
| `modelDiff` 导出但无任何调用 | `shared/model-contract.js:40` | 为"graph review"预留但尚未接线的 API |
| `llmConfigured` 退化为常量 `true` | `src/main.jsx:112` | 阶段 B 的凭据自检被删除，顶栏指示灯恒为在线——**演化中丢失的一处诚实性** |
| README 称默认提供方为 Codex，代码默认 `deepseek` | README L44 vs `main.jsx:104`、`codex-acp.js:49` | 文档与代码漂移 |
| 未使用的图标导入（`GitBranch`/`Zap`/`ShieldCheck`） | `src/main.jsx:3-33` | 原型期遗留 |

---

## 6. 结论

UOM Forge 的 31 小时历史里发生了一次完整的范式切换：**从"用假数据演示一个建模工作台的形状"，到"用真推理但强校验的管道产出可被追责的候选模型"**。这次切换的主导动作是职责移动而非功能增加——形状上移为契约、机制下沉为守护、领域词汇移出代码。三处残留（死视图、未接线 API、恒亮的在线指示灯）恰好标出了下一步该收的尾。

> 互链：[架构实现分析](./uom-forge架构实现分析.md) · [第一性原理与设计巧思分析](./uom-forge第一性原理与设计巧思分析.md)
