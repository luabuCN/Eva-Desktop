# 对话内图像生成功能技术文档

> 目标：在对话输入框加入「图像生成」模式（对齐豆包交互），点击 chip 后输入区切换为生图参数面板（模型 / 比例 / 风格 / 模板），提交后直接出图并以图片网格形式写入会话。
>
> 状态：设计待评审 · 一期范围见「任务拆分」

---

## 1. 需求与交互设计

### 1.1 交互流程（对齐豆包截图）

```
默认态                        图像生成模式
┌──────────────────────────┐   ┌──────────────────────────────────────┐
│ 有什么可以帮忙的？…        │   │ 描述你想要的图片                      │
├──────────────────────────┤   ├──────────────────────────────────────┤
│ ⊕ │ 权限 智能体 项目 …  │   │ ⊕ │ 🖼 图像生成 ✕ │ ✦ 模型 ▾ │ 比例 ▾ │ 🎨 风格 ▾ │ 模板 │
│           模型 ▾ │ 发送 → │   │                                     │ ⏹ 发送 │
└──────────────────────────┘   └──────────────────────────────────────┘
```

1. 输入框工具行新增「🖼 图像生成」chip，点击进入图像生成模式：
   - chip 变为激活态并带 `✕`（点击退出，回到默认对话模式）；
   - textarea 占位文案切换为「描述你想要的图片」；
   - 工具行切换为生图参数行：**模型**（图片模型专属选择器）、**比例**、**风格**、**模板**（二期）；
   - 右侧隐藏对话用 ModelSelector / 推理等级，仅保留提交按钮。
2. 参数以 Popover 弹出面板选择（复用现有 ModelSelector 的 Radix Popover 模式）：
   - **模型**：列出所有启用 Provider 中命名匹配图片特征的启用模型，默认「自动」；
   - **比例**：自动 / 9:16 / 2:3 / 3:4 / 1:1 / 4:3 / 3:2 / 16:9，网格图标式选项；
   - **风格**：无 / 人像摄影 / 电影写真 / 中国风 / 动漫 / 3D 渲染 / 赛博朋克 / CG 动画 / 水墨画 / 油画 / 古典 / 水彩画 / 卡通（缩略图 + 名称的纵向列表）。
3. 提交后输入框只读、提交按钮变为加载态；完成后会话中追加：
   - 一条 user 消息（生图提示词原文）；
   - 一条 assistant 消息（图片网格 + 参数摘要），图片点击放大（复用 ImageLightbox）、可下载。
4. 生成失败时 assistant 消息写入错误说明文本（持久化，刷新后历史一致）。

### 1.2 与 Agent 生图工具的关系

现有 `generateImage` 工具（`server/src/runtime/tools/image-provider.ts`）面向「美术」子智能体批量产出素材，走 agent 循环且有审批弹窗，体验上是"让 AI 帮忙画图"。本需求是**用户直出**：绕过 agent 循环，点发送即调图片接口，无审批、无推理过程，体验对齐豆包。两者**共用底层图片调用实现**（见 §3.2），互不替代。

---

## 2. 现状盘点（可复用资产）

| 资产 | 位置 | 复用方式 |
|---|---|---|
| 图片模型自动发现（命名特征匹配） | `server/src/runtime/tools/image-provider.ts` 的 `IMAGE_MODEL_PATTERN` / `resolveImageModel` | 抽入共享 service，HTTP 路由与工具共用 |
| OpenAI 兼容 `/images/generations` 调用（b64/url 双返回、超时、大小限制） | 同上的 `fetchImageBytes` | 同上 |
| 工作区安全落盘 + 变更面板登记 | `safe-fs.ts`、`recordFileChange` | 直接调用 |
| 模型目录（`modalities`、enabled 标志） | `Provider.models` JSON、`web/src/api.ts` 的 `ProviderModel` | 前端过滤图片模型列表 |
| 消息持久化（UI 消息整体 JSON 存储） | `sessionRepository.saveUIMessages`（kind="ui" 整体快照） | 端点生成后整体保存 |
| 自定义 data part 渲染惯例 | `MessageView.tsx` 的 `TurnChangesData` 等 data parts | 新增 `data-imagegen` part 遵循同一模式 |
| 图片消息渲染 + 放大预览 | `MessageView.tsx` 的 `FilePartView`、`ImageLightbox` | 网格项点击复用 Lightbox |
| 工作区文件静态服务 | `filePreviewUrl()` → `/preview/<path>` | 网格图片 src |
| 输入框 Popover 工具行模式 | `ModelSelector.tsx`（Radix Popover 二级面板） | 三个参数选择器同构 |
| 提交按钮加载/停止态 | `PromptInputSubmit`（status 受控） | 传入生图本地状态 |

关键事实：

- 消息是 AI SDK `UIMessage`，parts 支持 `data-*` 自定义部件；持久化为整体快照，因此端点拿到全量 messages 后追加两条新消息再整体保存即可（与 `/api/chat` 的请求模型一致）。
- 前端 dev 环境 Vite(8089) 与 API(8878) 不同源，**持久化的消息里不存完整 URL**；`data-imagegen` part 只存工作区相对路径，渲染时经 `filePreviewUrl()` 运行时拼地址，端口变化不影响历史数据。

---

## 3. 总体方案

### 3.1 方案对比

| | A. 直出端点（推荐） | B. Agent 中介（复用 generateImage 工具） |
|---|---|---|
| 链路 | `POST /api/images/generate` → 图片接口 → 落盘 → 持久化 | 正常发消息 → LLM 决定调工具 → 审批 → 出图 |
| 时延 | 一次图片接口耗时（秒级~几十秒） | LLM 首 token + 工具循环，明显更慢 |
| 打断 | 无 | 工具审批弹窗（requireApproval=true） |
| 参数控制 | UI 精确控制模型/比例/风格 | 需经 system prompt 约束，不可靠 |
| 结果呈现 | 图片网格（豆包式） | 工具结果文本 + 路径 |
| 改动面 | 新端点 + 新 UI 模式 | 仅 prompt 与工具策略，但体验不达标 |

**采用方案 A**，并将图片调用底层从 `image-provider.ts` 抽取为共享 service，避免工具与端点双份实现漂移。

### 3.2 架构图

```
web (React)                                 server (Hono)
┌────────────────────────┐                  ┌────────────────────────────────┐
│ ChatPane               │                  │ routes/images.ts               │
│  └ imageMode 状态      │  POST /api/      │  └ zod 校验 → imageService.    │
│  └ ImageGenControls    │  images/generate │      generate()                │
│     ├ 模型 popover ────┼─────────────────►│  └ sessionRepository.          │
│     ├ 比例 popover     │  {id, messages,  │      saveUIMessages()          │
│     └ 风格 popover     │   prompt, model, │            │                   │
│ MessageView            │   ratio, style,  │            ▼                   │
│  └ ImageGenResultView  │   count}         │ images/image-service.ts        │
│     (data-imagegen)    │◄─────────────────┤  ├ resolveImageModel()          │
└────────────────────────┘  {messages:[u,a]} │  ├ resolveSize() 比例映射       │
                                             │  ├ buildPrompt() 风格拼接      │
                                             │  ├ fetchImageBytes() 调用接口  │
                                             │  └ saveToWorkspace() 落盘+登记 │
                                             └──────────▲─────────────────────┘
                                                        │ 抽取复用
                                    runtime/tools/image-provider.ts (generateImage 工具)
```

---

## 4. 服务端详细设计

### 4.1 共享服务 `server/src/images/image-service.ts`（新）

从 `runtime/tools/image-provider.ts` 抽取并扩展：

```ts
// 导出常量（前端经 /api/images/options 或静态复制保持一致）
IMAGE_MODEL_PATTERN   // 现有命名特征正则，原样迁移
IMAGE_STYLES          // 风格表：{ id, label, promptSuffix }
ASPECT_RATIOS         // 比例表：{ id, label, orientation, size }

resolveImageModel(override?: { providerId, modelId })
  // 现有逻辑原样迁移：显式指定 > 自动发现

resolveSize(ratioId, modelId): string | undefined
  // 比例 → API size 参数（见 §4.2）

buildPrompt(prompt, styleId): string
  // 风格后缀拼接：styleId 为 "none"/空时原样返回，
  // 否则 `${prompt}, ${style.promptSuffix}`

fetchImageBytes(model, prompt, size, count): Promise<Buffer[]>
  // 在现有实现上扩展：n=count，payload.data 遍历全部条目，
  // b64_json 与 url 混排时逐条处理

generateImages(input: {
  prompt; ratio; style; count;
  model?: { providerId; modelId };
  workspacePath; runId?; conversationId; projectId?;
}): Promise<{ files: Array<{ path, relativePath, filename, bytes }>, modelLabel }>
  // 编排：解析模型 → 拼 prompt → 解析 size → 调接口 →
  // 逐张落盘 assets/image-<ts>-<i>.png（SafeFsProvider）→
  // 逐张 recordFileChange（before/after=null，与工具一致）
```

`image-provider.ts` 改为薄壳：工具 execute 内调 `image-service`，行为不变（size enum 映射到 ratioId 或保留原 size 白名单，二选一，倾向保留原白名单避免破坏子智能体存量调用）。

### 4.2 比例映射表

```ts
const ASPECT_RATIOS = [
  { id: "auto", label: "自动", orientation: "square" },
  { id: "1:1",  label: "1:1",  orientation: "square",    size: "1024x1024"  },
  { id: "3:2",  label: "3:2",  orientation: "landscape", size: "1536x1024"  },
  { id: "2:3",  label: "2:3",  orientation: "portrait",  size: "1024x1536"  },
  { id: "4:3",  label: "4:3",  orientation: "landscape", size: "1280x960"   },
  { id: "3:4",  label: "3:4",  orientation: "portrait",  size: "960x1280"   },
  { id: "16:9", label: "16:9", orientation: "landscape", size: "1536x864"   },
  { id: "9:16", label: "9:16", orientation: "portrait",  size: "864x1536"   },
];
```

解析规则（`resolveSize`）：

- `auto` → 不传 `size`，由模型自定；
- **OpenAI 家族**（`/gpt-image|dall-e/i`）：只支持 `1024x1024 / 1536x1024 / 1024x1536` 三档，按 `orientation` 就近映射（square/landscape/portrait）；
- **其余家族**（seedream / qwen-image / cogview / flux 等多数兼容网关接受任意 `WxH`）：用表中精确尺寸；
- 接口返回 400（尺寸不被网关接受）时把错误原文透传给前端展示，不静默降级。

### 4.3 风格表（初版）

| id | 名称 | promptSuffix（英文拼接，效果更稳） |
|---|---|---|
| none | 无 | — |
| portrait | 人像摄影 | professional portrait photography, 85mm lens, soft studio lighting |
| cinematic | 电影写真 | cinematic film still, dramatic lighting, shallow depth of field |
| chinese | 中国风 | traditional Chinese style, ink-wash aesthetics, elegant composition |
| anime | 动漫 | anime style, cel shading, vibrant colors |
| render3d | 3D 渲染 | 3D render, octane render, high detail, studio lighting |
| cyberpunk | 赛博朋克 | cyberpunk style, neon lights, futuristic city, high contrast |
| cg | CG 动画 | CG animation style, polished, pixar-like rendering |
| ink | 水墨画 | Chinese ink wash painting, minimal, expressive brush strokes |
| oil | 油画 | oil painting, visible brush texture, rich colors |
| classical | 古典 | classical painting, renaissance composition, muted palette |
| watercolor | 水彩画 | watercolor painting, soft washes, paper texture |
| cartoon | 卡通 | cartoon style, flat illustration, bold outlines |

### 4.4 路由 `server/src/routes/images.ts`（新）

```ts
POST /api/images/generate
{
  id?: string,                    // 会话 id；缺省新建（与 /api/chat 同语义）
  messages: ChatUIMessage[],      // 全量历史（与 /api/chat 同构）
  prompt: string,                 // 必填，trim 后非空
  model?:  { providerId, modelId },  // 空 = 自动发现
  ratio?:  string,                // 默认 "auto"
  style?:  string,                // 默认 "none"
  count?:  number,                // 1–4，默认 1
  projectId?: string
}

200 → { id, messages: [userMessage, assistantMessage] }   // 已持久化
4xx → { error: "没有可用的图片生成模型：…" }              // 参数/配置类错误
502 → { error: "图片生成接口返回 400：…" }                // 上游调用类错误
```

处理流程：

1. zod 校验；`sessionRepository.ensure(id, …)` 保证会话行存在（项目关联沿用现有 ensure 语义，projectId 透传）。
2. 构造 user 消息：`{ id: uuid, role: "user", parts: [{ type: "text", text: prompt }] }`。
3. 调 `generateImages()`；**捕获全部错误**，成功时 assistant parts 为图片网格 data part，失败时降级为文本 part：
   ```jsonc
   // 成功：单个 data part 携带全部产物
   { "type": "data-imagegen",
     "data": { "prompt", "model": "Provider/seedream-4-5", "ratio": "3:4",
               "style": "cartoon",
               "files": [{ "path": "assets/image-1729…-0.png", "bytes": 812033 }] } }
   // 失败：错误文本 part（持久化，历史一致）
   { "type": "text", "text": "图片生成失败：图片生成接口返回 400：…" }
   ```
4. `sessionRepository.saveUIMessages(id, [...messages, userMessage, assistantMessage])` 整体快照保存。
5. 返回 `{ id, messages: [userMessage, assistantMessage] }`（不含历史，前端本地追加）。

工作区解析：沿用 run-service 的项目工作区规则——`projectId` 对应项目 `rootPath`，否则全局 workspace（`runtime/workspace.ts`）；端点内复用同一解析函数，保证图片落在用户可见的项目目录。

挂载：`app.ts` 增加 `app.route("/api/images", imageRoutes);`。

**关于审批**：直出链路不经过工具策略与审批桥——这是有意的（对齐豆包"点发送即扣费生成"的体验）。风险缓释：图像模式是显式切换的 UI 状态，且每次生成都是用户主动提交。

---

## 5. 前端详细设计

### 5.1 常量与 API（`web/src/lib/image-gen.ts` + `api.ts`）

- `lib/image-gen.ts`：`IMAGE_STYLES` / `ASPECT_RATIOS` 展示常量（label、图标比例框）、`ImageGenOptions` 类型。与服务端表保持一致（一期静态复制，避免为过小的表增加拉取接口；注释中互相指向）。
- `api.ts`：
  ```ts
  interface ImageGenRequest { id?; messages; prompt; model?; ratio?; style?; count?; projectId? }
  generateImages(input): Promise<{ id: string; messages: ChatUIMessage[] }>
  ```
  不走 `apiFetch` 的默认 JSON 错误分支也可，直接复用（错误文本即 message）。

### 5.2 ChatPane 改造

新增状态（不进全局 store，会话内有效即可）：

```ts
const [imageMode, setImageMode] = useState(false);
const [imageOptions, setImageOptions] = useState<ImageGenOptions>({
  model: null, ratio: "auto", style: "none", count: 1,
});
const [imageBusy, setImageBusy] = useState(false);
```

- **工具行**：`PermissionModeSelector` 前插入「图像生成」chip 按钮；`imageMode` 为 true 时该行整体替换为 `<ImageGenControls>`（模型/比例/风格三个 Popover + 退出 ✕），右侧隐藏 `ModelSelector`。
- **textarea**：`placeholder={imageMode ? "描述你想要的图片" : "有什么可以帮忙的？输入 / 选择技能"}`；imageMode 下禁用 `/` 技能菜单与文件引用芯片行（生图参数已占满语义），附件菜单保留（图生图二期再启用，一期隐藏避免歧义——一期隐藏 `PromptInputActionAddAttachments` 项）。
- **提交分支**（`PromptInput onSubmit` 内最前）：
  ```ts
  if (imageMode) {
    if (imageBusy || !text.trim()) return;
    setImageBusy(true);
    try {
      const result = await generateImages({
        id: chat.id, messages: chat.messages, prompt: text.trim(),
        model: imageOptions.model ?? undefined,
        ratio: imageOptions.ratio, style: imageOptions.style,
        count: imageOptions.count, projectId,
      });
      chat.setMessages([...chat.messages, ...result.messages]);
    } catch (error) {
      setAttachmentError(errorMessage(error));   // 复用输入区错误行
    } finally {
      setImageBusy(false);
    }
    return;
  }
  ```
- **生成中占位**：`imageBusy` 时在消息列表尾部渲染一条本地临时助手占位（Shimmer「正在生成图片…」），不入 messages；`PromptInputSubmit` 传 `status={imageBusy ? "streaming" : chat.status}` 复用加载/停止样式（停止仅关闭本地等待，服务端请求用 `AbortController` 一并中止）。
- 切换会话（`chat.id` 变化）时 `setImageMode(false)` 复位，避免参数串会话。

### 5.3 `ImageGenControls.tsx`（新组件）

三个 Popover 选择器，结构复刻 `ModelSelector` 的 Popover 用法：

- **模型**：trigger 显示 `✦ 模型 <名称>`；面板列出「自动」+ 各启用 Provider 下 `IMAGE_MODEL_PATTERN` 匹配的启用模型（`ProviderIcon` + 模型名，分组标题为 Provider 名）。匹配正则从 `api.ts` 导出（与 server 同一字面量，注释互指）。无匹配项时面板显示引导文案「未发现图片模型，请到设置 → 供应商中启用 seedream / gpt-image 等模型」。
- **比例**：trigger `比例 <当前>`；面板为 4×2 网格，每格一个按真实宽高比绘制的小矩形图标 + 比例文字，选中态高亮（对齐豆包截图）。
- **风格**：trigger `🎨 风格`；纵向列表（可选带 16×16 缩略圆点色块占位，一期纯文字），首项「无」。

### 5.4 结果渲染（`MessageView.tsx`）

新增 `ImageGenResultView`：

- part.type === `"data-imagegen"` 时渲染；
- 网格：`files.length > 1 ? "grid grid-cols-2 gap-2" : ""`，每项 `<img src={filePreviewUrl(resolvePath)>}`——`filePreviewUrl` 需要绝对路径，data part 里存的是工作区相对路径，先经 `resolveFilePath()`（现有 API）解析再拼 URL（组件内 `useEffect` 批量解析并缓存到 state）；
- 点击 → 现有 `ImageLightbox`；悬停右上角「下载」按钮（`<a href={previewUrl + "?download=1" …}>` 或复用现有下载链路）；
- 底部一行参数摘要（`模型 · 比例 · 风格` 小字，`title` 悬浮显示完整 prompt）。

> 说明：不使用 `file` part 存图片，是因为 `file.url` 需要持久化时即为完整 URL/dataURL，跨端口与端口变化不稳健；`data-imagegen` 存路径、运行时拼地址，与 `FileLinkContext` 的路径哲学一致。

---

## 6. 数据契约汇总

| 项 | 结构 |
|---|---|
| 请求 | §4.4 zod schema |
| 成功响应 | `{ id, messages: [user, assistant] }`，assistant 含 `data-imagegen` part |
| `data-imagegen.data` | `{ prompt, model, ratio, style, files: [{ path, bytes }] }`（`path` 为工作区相对路径，正斜杠） |
| 失败响应 | `{ error }`；同时 assistant 消息持久化错误文本 part |
| 图片文件 | `<workspace>/assets/image-<timestamp>-<index>.png`，登记 `FileChange`（create，无快照） |

---

## 7. 任务拆分（建议顺序）

| # | 任务 | 涉及文件 |
|---|---|---|
| 1 | 抽取 `image-service.ts`（模型解析/尺寸映射/风格拼接/抓取/落盘），`image-provider.ts` 改薄壳 | `server/src/images/`、`server/src/runtime/tools/image-provider.ts` |
| 2 | `POST /api/images/generate` 路由 + 消息构造 + 持久化 + 工作区解析 | `server/src/routes/images.ts`、`server/src/app.ts` |
| 3 | 前端常量与 API 封装 | `web/src/lib/image-gen.ts`、`web/src/api.ts` |
| 4 | `ImageGenControls` 三 Popover 参数行 | `web/src/components/ImageGenControls.tsx` |
| 5 | ChatPane 接入：模式 chip、提交分支、占位与复位 | `web/src/components/ChatPane.tsx` |
| 6 | `ImageGenResultView` 网格渲染 + 下载 + Lightbox | `web/src/components/MessageView.tsx` |
| 7 | 类型检查 + 端到端冒烟（真实图片模型） | `pnpm typecheck`、`.tmp-*` 冒烟目录 |

依赖关系：1 → 2 先行；3–6 可并行于 1–2（契约以 §6 为准）；7 收口。

---

## 8. 边界与错误处理

| 场景 | 处理 |
|---|---|
| 未配置/未启用图片模型且未显式选择 | 端点返回 4xx「没有可用的图片生成模型…」，模型 Popover 内同步展示引导文案 |
| 上游接口非 2xx | 透传状态码与截断后的错误原文（≤500 字符，沿用现有 `fetchImageBytes` 截断），assistant 消息持久化失败文本 |
| 生成字节为 0 / 超 20MB | 拒绝落盘并返回错误（沿用现有限制） |
| 请求超时 | 180s（与工具一致）；前端 `AbortController` 支持用户点停止提前取消（服务端请求亦中止） |
| 生成中切换会话/刷新 | 请求与连接解耦暂不做（一期）：本地等待中断，若服务端已完成则消息已持久化，回到会话时经历史回放自然出现 |
| ratio/style 传了非法 id | zod 校验拒绝（枚举校验） |
| 多 Provider 同名模型 | 显式选择始终优先；「自动」按 Provider 创建顺序取第一个匹配（与工具一致） |
| 会话不存在（首条消息即生图） | 端点 `ensure` 建会话，标题取 prompt 前 80 字符（复用 `messageTitle` 逻辑） |

---

## 9. 测试计划

1. **单元/集成（server）**：
   - `resolveSize`：auto / 三 orientation × OpenAI 家族 / 精确尺寸 × seedream 家族；
   - `buildPrompt`：none 原样、其他风格后缀拼接；
   - `resolveImageModel`：显式覆盖、Provider 停用报错、自动发现顺序；
   - 路由层：mock `fetch` 返回 b64，断言落盘路径、`FileChange` 登记、消息持久化结构（data part 含相对路径）。
2. **前端**：`pnpm typecheck` 全 workspace 通过；`ImageGenControls` 选择状态与 trigger 文案联动。
3. **端到端冒烟**：配置一个真实图片模型（如 seedream 系），走「切模式 → 选 3:4 + 卡通 → 提交 → 网格出现 → 刷新会话历史仍在 → Lightbox/下载可用」；截图存档至 `gui-test-screenshots/`（沿用项目惯例）。

---

## 10. 后续扩展（不在一期）

- **模板面板**：预设「prompt + 比例 + 风格」组合包（海报 / Logo / 绘本等），点击填入草稿（对齐豆包模板）；
- **张数选择**：UI 暴露 1/2/4（服务端 `count` 已支持，网格 `grid-cols-2` 已兼容）；
- **图生图**：图像模式下开放附件，走 `/images/edits` 或 seededit 家族模型；
- **重新生成 / 参数复用**：结果卡片上「再次生成」按钮，以同参数重发；
- **生成中 SSE 进度**：端点改流式，逐张返回落盘进度。
