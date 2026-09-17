# bash 长命令后台化：runInBackground + 后台任务查询工具

## 背景与目标
AI SDK 步进循环里，下一轮 LLM 请求必须等本步全部工具 Promise 完成，`pnpm add ...` 这类命令会把整个 agent 回合阻塞数分钟。目标：bash 支持 `runInBackground` —— 命令转后台进程、工具立即返回 taskId，主 agent 继续写代码；新增 `bashTaskOutput`（可阻塞等待）/ `bashTaskList` / `bashTaskStop` 收敛结果；前端实时显示后台任务卡片。**任务跨回合存活**：回合结束不杀进程，注册表保留，下回合可查（已确认）。零额外 LLM 开销（不经过子智能体）。

## Server 改动（6 个文件）

### 1. 新建 `server/src/runtime/background-tasks.ts` — BackgroundTaskHub
- **静态（模块级）records Map**：跨 run 存活；上限并发 running 5、保留 settled 50（prune 最旧）。每 run new 一个薄实例（镜像 DelegationHub 生命周期），notify 为实例字段。
- `start({command, cwd, conversationId})`：**普通 `spawn`（不 detached、`windowsHide: true`）**，持有 child 引用收 `close`/`error` 事件——不需要 dev-server 那套日志文件轮询（那是 detached 才需要的），stdout/stderr 直接流式收集进尾部环形缓冲（各 64KB）。shell 包装复用 SafeShellProvider 的 PowerShell/bash invocation（含 LASTEXITCODE 透传）。30 分钟硬超时 kill。
- notice 事件：`start` / `progress`（输出增量尾部，节流 ≥2s）/ `done`（exitCode、时长）/ `error`；emit 走 try-catch，流结束后静默丢弃。
- `output({taskId?, conversationId, block, timeoutSeconds})`：taskId 缺省取该会话最近任务；block=true 阻塞等待（镜像 delegation-hub 的 completion promise + setTimeout），**等待期间每 5s emit progress 保活**（空闲看门狗默认 240s，防误杀）；等待超时不算错误，返回 running 状态 + 引导 note。返回 stdout 尾 ≤8K / stderr 尾 ≤4K。
- `list(conversationId)` / `stop(taskIds?, conversationId?)`。运行结束只解绑 notify，不停止任务。

### 2. `server/src/safe-fs.ts`
把 `SafeShellProvider.invocation()` 抽为导出函数 `shellInvocation(command)`，类内改为调用它；后台任务复用同一包装。

### 3. `server/src/runtime/tools/types.ts`
新增 `BackgroundTaskRecord`（taskId、command、status: running|completed|failed|stopped、exitCode、startedAt、completedAt、输出尾部、error）与 `BackgroundTaskBridge`（start/output/list/stop），镜像 DelegationBridge 形态。

### 4. `server/src/runtime/tools/run-context.ts`
`RunContextInit` 加 `backgroundTasks?: BackgroundTaskBridge`；子代理经 `deriveContext` 的 `...parent` 展开自动继承（子代理也能查/等后台任务）。

### 5. `server/src/runtime/tools/workspace-provider.ts`
- bash inputSchema 加 `runInBackground?: boolean`；description 写清使用规范：依赖安装（pnpm/npm/yarn/bun install、pip install、cargo fetch）、长构建设 true；返回后继续其他工作；**任何依赖该安装的命令（dev/build/test/import）前必须先 bashTaskOutput(block=true) 确认成功；回合结束前收敛所有后台任务**。
- execute：`looksLikeDevServer` 判断保持最优先；其次 `runInBackground` → `run.backgroundTasks.start()`，返回 `{ taskId, status: "running", message }`。
- 新增三工具 + descriptors（risk low / mutating false / requireApproval false，对齐 Delegate 家族；不触发审批，启动命令本身已在 bash 审批时审过）：
  - `bashTaskOutput`：`{ taskId?, block?=false, timeoutSeconds?(1-600，默认60) }`
  - `bashTaskList`：`{}`
  - `bashTaskStop`：`{ taskIds? }`（缺省停该会话全部运行中任务）

### 6. `server/src/runtime/agent-runtime.ts`
- `createToolSet` 之前：`const backgroundTasks = new BackgroundTaskHub()` 并注入 runContext。
- stream execute 内注入 `backgroundTasks.notify` → `markAlive()` + `writer.write({ type: "data-oh:bgtask.<kind>" })`（紧挨 delegationHub.notify）。
- `ownershipComplete.finally` 里只解绑 notify，不 dispose 任务。

## Web 改动（3 个文件）

### 7. `web/src/lib/chat-utils.ts`
`BgTaskEventData` 接口；`ChatUIMessage` 泛型加 `oh:bgtask.start|progress|done|error` 四个部件类型。

### 8. `web/src/components/MessageView.tsx`
`collapseBgTaskParts`（同一 taskId 折叠为单卡，仿 collapseSubagentParts）+ `BgTaskCard`：命令、运行中转圈+实时计时、完成显示 ✓/✗ + exitCode + 时长，展开可看输出尾部（仿 DelegationCard 骨架）。

### 9. `web/src/lib/tool-display.ts`
bash 摘要在 `runInBackground` 时加「后台」标记；三个新工具的中文标签与摘要（动词"查看/停止"，摘要显示 taskId/状态）。

## 关键决策回顾
- 不用 detached：child 由常驻的 node 服务进程持有，exit 事件可直接收、输出直接 pipe，比 dev-server 方案简单；windowsHide 即可防弹窗（弹窗问题特指 detached）。
- 审批/plan 门控天然生效：后台启动走原 bash 审批包装；三个查询工具非 mutating 不受 plan 门控。
- 断线重连/刷新回放：data 部件随消息持久化（与 subagent 部件同机制），无需额外入库。

## 验证
1. `pnpm typecheck`（server + web）。
2. tsx 冒烟脚本直调 BackgroundTaskHub：跑 `Start-Sleep`/短命令，验证 exitCode 透传、输出尾部、block 等待与超时 note、stop、并发上限。
3. 起 dev 服务真实对话一轮：让 agent 后台装一个小包并继续编辑文件，确认主循环不被阻塞、前端卡片显示进度与完成状态、下回合 bashTaskOutput 可查。