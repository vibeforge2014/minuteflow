# MinuteFlow 代码导航地图（source-map）

> 本文件是全仓库核心代码的索引，供 AI 与开发者快速定位「什么功能在哪个文件」。
> 所有核心源码均已带中文注释（文件头 + 导出符号文档 + 关键行内注释）。
> 最后更新：2026-08-16（v0.1.11，注释化改造后）。

## 1. 项目概览

MinuteFlow 是**本地优先**的会议助手，一份代码库包含三个产品形态：

| 形态 | 技术栈 | 目录 |
|---|---|---|
| 桌面端（Windows 10 22H2+ / macOS 14.2+） | Electron 43 + React 19 + TypeScript + Vite | `electron/` + `src/` |
| 官网 | 同上（纯浏览器渲染，localStorage 演示兜底） | `src/MarketingSite.tsx` |
| iOS / iPadOS 18+ | SwiftUI + SwiftData + Apple Speech | `ios/MeetingAssistant/` |

### 桌面端架构与数据流

```
src/（渲染层，React）
  main.tsx ──按环境分流──▶ App.tsx（桌面工作台） 或 MarketingSite.tsx（官网）
  App.tsx ──组装──▶ Sidebar │ DocumentWorkspace │ TranscriptPanel │ RecorderBar
                 └─ 弹窗：NewMeeting/Settings/ImportDrawer/Paywall/SystemPermissions/Onboarding/Deleted
  store/meetingStore.ts（Zustand 全局状态）
  hooks/useMeetingRecorder.ts ──驱动──▶ services/recording.ts（MediaRecorder 录音引擎）
                    │
                    ▼  api = window.meetingAPI ?? browserApi
  lib/api.ts（环境桥）─── preload.cjs（contextBridge）───▶ electron/main.mjs（主进程）
                                                            ├─ database.mjs（SQLite + FTS5）
                                                            └─ services/（providers/secrets/licensing/
                                                                        local-models/import-queue/
                                                                        diarization/exports/updates）
```

- 渲染层只通过 `window.meetingAPI.*`（`src/types.ts` 的 `MeetingAPI` 契约）访问系统能力；
  纯浏览器/官网模式回落到 `lib/api.ts` 内的 localStorage 实现（接口同构）。
- **付费墙**：录音/转写/总结/导入/导出在每个相关 IPC 通道入口由主进程 `requireLicense()` 强制。
- **两道首run门**：先 `SystemPermissionsDialog`（版本化系统权限引导），再 `OnboardingDialog`。

### iOS 端架构

```
MeetingAssistantApp.swift（入口，装配 SwiftData 容器与环境对象）
  ├─ AppState.swift（全局 UI 状态）
  ├─ AppRootView.swift ──按尺寸类──▶ WorkspaceViews：TabletWorkspaceView（iPad 三栏）
  │                                              或 PhoneWorkspaceView（iPhone 三标签）
  ├─ RecordingCoordinator.swift（AVAudioEngine + SFSpeechRecognizer 录音/实时转录）
  ├─ SummaryService / SummaryEngine（远程 LLM 或本地离线纪要）
  ├─ RemoteWhisperService（OpenAI 兼容音频转录，Keychain 存密钥）
  └─ AudioImportCoordinator / ExportService（导入与分享导出）
```

## 2. 桌面端 Electron 主进程（`electron/`）

| 文件 | 职责 | 关键符号 |
|---|---|---|
| `main.mjs` | 主进程入口：窗口创建、特权媒体协议、session 权限收紧、全部 IPC 通道注册与付费墙前置 | `trustedHandle`、`recordings:* / transcription:chunk / summary:generate / summary:cancel / models:* / imports:* / licensing:* / updates:* / window:toggle-mini`；录音首块写盘失败经 `recordings:write-error` 即时推送；总结失败回退本地引擎并带 degraded 标记；`recordings:start` 清理同会议遗留会话 |
| `database.mjs` | node:sqlite 本地数据层：会议/转录段/模型档案/音频资产/任务表 + FTS5 全文索引；转录段按 id 差量增删改（长会议滚动保存不再全表重写） | `openDatabase`、`saveMeeting`、`listMeetings`、`saveJob`、`markInterruptedRecordings` |
| `services/providers.mjs` | 转录与纪要的模型调用层：OpenAI 兼容远程（含 New API 网关预设）、Anthropic/Gemini 原生协议、真实 WAV 转录连接测试 + 四种本地 Whisper 运行时 + 本地规则纪要（120 段窗口）+ robust JSON 提取 | `summarizeWithOpenAICompatible`、`summarizeLocally`、`extractJson`、`transcribeRemote`、`transcribeWithWhisperCpp`、`resolveProviderEndpoint`、`testModelProfile` |
| `services/secrets.mjs` | 密钥保险库：safeStorage 加密、明文降级、串行原子写盘、内存缓存 | `storeSecret`、`readSecret`、`flushSecrets` |
| `services/licensing.mjs` | ¥99 一次性授权：HTTPS 验证、机器指纹绑定、72h 缓存、30 天离线宽限、时钟回拨检测 | `requireLicense`、`activateLicense`、`getLicenseStatus`、`openCheckout` |
| `services/local-models.mjs` | 本地 Whisper 零路径配置：模型发现/sha256 校验下载（tiny→large-v3 共 7 个 GGML 模型）/托管运行时解析 | `discoverLocalModels`、`downloadModel`、`ensureManagedLocalRuntime`、`looksLikeWhisperModel` |
| `services/import-queue.mjs` | 持久化单 worker 导入队列：归档→预处理→转写→分离→总结，缺组件可恢复暂停 | `enqueueImports`、`runQueue`、`processJob`、`cancelImport` |
| `services/diarization.mjs` | sherpa-onnx 离线说话人分离与轮次标签回填 | `diarizeWithSherpa`、`applyDiarization` |
| `services/exports.mjs` | 八种格式导出（md/txt/pdf/docx/srt/vtt/json/zip）与导入文件选择 | `exportMeeting`、`chooseImportFiles` |
| `services/updates.mjs` | macOS + Windows 更新：分平台官网 JSON 清单 + GitHub 兜底、版本比较、allow-list HTTPS 校验 | `checkForAppUpdate`、`compareVersions`、`validateUpdateManifest` |
| `services/formatters.mjs` | 纯函数格式化：Markdown 纪要、SRT/VTT、时间戳 | `markdown`、`subtitle`、`formatTime` |

## 3. 桌面端渲染层（`src/`）

### 入口与全局

| 文件 | 职责 | 关键符号 |
|---|---|---|
| `main.tsx` | 渲染入口：按环境分流桌面工作台（lazy chunk）或官网；`?preview=desktop` 本地预览 | `Root` |
| `App.tsx` | 工作台根组件：三栏布局 + 底部录音条 + 全部弹窗调度 + 导入队列订阅 + 首run两道门 + 滚动纪要节拍 | `App` |
| `types.ts` | 全部领域类型与 `MeetingAPI` IPC 契约（含每个通道的语义注释） | `Meeting`、`TranscriptSegment`、`MeetingSummary`、`ModelProfile`、`MeetingAPI` |
| `store/meetingStore.ts` | Zustand 全局状态：会议 CRUD（乐观更新）、偏好、档案、搜索；定稿转写节流落盘（10s flush）、provisional 段仅内存并随保存过滤 | `useMeetingStore`、`updateMeeting`、`appendTranscript`、`appendProvisionalTranscript`、`flushMeeting` |
| `lib/api.ts` | 环境桥：Electron 用 preload 注入的 IPC 桥；浏览器用 localStorage 兜底实现 | `api`、`isElectronRuntime`、`browserApi` |
| `lib/transcript.ts` | 转写段合并（provisional→final 覆盖）与说话人标签合并 | `mergeTranscriptSegments`、`mergeSpeakerLabels` |
| `lib/summary.ts` | 纪要手动锁与 AI 修订版合并（保护用户编辑不被覆盖） | `lockSummaryField`、`mergeSummaryRevision` |
| `lib/format.ts` | 时长/间隔格式化 | `formatDuration`、`formatInterval` |
| `lib/library.ts` | 会议库分组（收藏置顶/时间分组）与搜索高亮切分 | `groupLibraryMeetings`、`splitHighlight` |
| `data/demo.ts` | 官网/浏览器模式演示会议数据 | `demoMeetings` |

### 录音链路

| 文件 | 职责 |
|---|---|
| `hooks/useMeetingRecorder.ts` | 录音状态机（idle→starting→recording⇄paused→stopping）+ 电平/转写回调 + 滚动纪要定时器（暂停即停、ref 取最新回调）+ final 自动推导 + 总结取消/降级提示 + 刷新后假录音态修复 |
| `services/recording.ts` | `MeetingRecorder` 引擎：双轨采集、15s 归档块、独立 8s 转写块、停止时等全部落盘再收尾 |
| `components/RecorderBar.tsx` | 底部悬浮录音条：状态灯/计时/双轨真实电平（持续静音告警）/队列徽标/停止二次确认/迷你窗切换 |
| `components/MeetingPlayer.tsx` | 文档上方回放条：时间轴、±15s、与转写时间戳双向联动（歌词式高亮） |

### 工作区组件（`src/components/`）

| 文件 | 位置/职责 |
|---|---|
| `Sidebar.tsx` | 左栏会议库：搜索（⌘K 聚焦、一键清除、无结果提示）、今天/本周/更早分组、导入/最近删除/设置入口 |
| `DocumentWorkspace.tsx` | 中栏会议文档：Tiptap 富文本（Markdown 真源、.md 导入、DOMPurify）、实时纪要、行动项表格、决策四宫格 |
| `TranscriptPanel.tsx` | 右栏：转录（发言人改名/合并、窗口化加载、播放同步高亮）与 AI 总结两标签 |
| `SettingsDialog.tsx` | 设置工作台：AI 总结/转录（服务目录 + 档案编辑 + `LocalModelManager` 零路径本地 Whisper）、通用、存储隐私、软件更新 |
| `ImportDrawer.tsx` | 右侧导入抽屉：待确认文件（改标题/选模型）+ 后台任务队列（重试/取消/等待配置） |
| `NewMeetingDialog.tsx` | 新建会议：模板/标题/线上线下模式/参与者/目标 |
| `PaywallDialog.tsx` | ¥99 付费墙：购买跳转、激活码输入、恢复购买 |
| `SystemPermissionsDialog.tsx` | 首run第一道门：麦克风 + macOS 屏幕录制集中授权（录音中永不弹权限） |
| `OnboardingDialog.tsx` | 首run第二道门：本地优先/权限/模型配置三条承诺 |
| `DeletedMeetingsDialog.tsx` | 最近删除（软删除恢复） |
| `ExportMenu.tsx` | 八种导出格式菜单 |
| `Toast.tsx` / `EmptyState.tsx` / `BrandMark.tsx` | 轻量反馈（成功/警告双通道叠放）/空状态（首run 引导与搜索无结果两变体）/品牌标（多环境图片地址解析） |
| `MarketingSite.tsx` | 官网整站：首页（Hero/演示/隐私/平台）、规格页（七节锚点）、定价/条款/隐私/退款四政策页 |

## 4. iOS 端（`ios/MeetingAssistant/MeetingAssistant/`）

| 文件 | 层 | 职责 |
|---|---|---|
| `App/MeetingAssistantApp.swift` | 入口 | 创建 SwiftData ModelContainer，注入 AppState/RecordingCoordinator/AppPreferences/AudioImportCoordinator |
| `App/AppState.swift` | 状态 | 选中会议、iPhone 标签、检查面板标签、全局 sheet、搜索、Toast |
| `Models/MeetingRecord.swift` | 模型 | 会议主表：元信息 + 文档字段 + 级联转录片段/行动项 |
| `Models/TranscriptSegmentRecord.swift` | 模型 | 转录片段（时间戳 + 说话人） |
| `Models/ActionItemRecord.swift` | 模型 | 行动项（负责人/截止/状态） |
| `Services/RecordingCoordinator.swift` | 服务 | AVAudioEngine 录音落盘 + SFSpeechRecognizer 实时转录 + 电平 + 纪要节拍 |
| `Services/SummaryEngine.swift` | 服务 | 离线本地纪要引擎（句子切分 + 中文关键词） |
| `Services/SummaryService.swift` | 服务 | 纪要路由：本地引擎或远程 LLM（OpenAI 兼容） |
| `Services/RemoteWhisperService.swift` | 服务 | 远程 Whisper 转录（/audio/transcriptions，Keychain 取密钥） |
| `Services/AudioImportCoordinator.swift` | 服务 | 外部音频导入：沙盒归档 → 建会议 → 整段转录 |
| `Services/ExportService.swift` | 服务 | Markdown/TXT/SRT/JSON 导出 + 系统分享 |
| `Services/KeychainService.swift` | 服务 | API Key 的 Keychain 存取 |
| `Services/AppPreferences.swift` | 服务 | 偏好持久化（Provider 选择/语言/间隔/引导标记） |
| `Services/DemoDataSeeder.swift` | 服务 | 首启动演示数据 |
| `Utilities/MeetingFormatters.swift` | 工具 | 时间戳/时长/中文日期格式化 |
| `Views/AppRootView.swift` | 视图 | 根视图：按尺寸类切换 iPad 三栏 / iPhone 标签；挂全局 sheet、导入进度、错误提示 |
| `Views/WorkspaceViews.swift` | 视图 | `TabletWorkspaceView`（iPad 三栏）、`PhoneWorkspaceView`（三标签）、`PhoneMeetingDetailView`（文档/转录/纪要分段）、行动项总览 |
| `Views/MeetingLibraryView.swift` | 视图 | 会议库侧栏（搜索/收藏/最近、滑操作） |
| `Views/MeetingDocumentView.swift` | 视图 | 会议文档（目标/记录/纪要/行动项，就地编辑） |
| `Views/InsightPanelView.swift` | 视图 | 转录 / AI 纪要洞察面板（iPad 第三栏） |
| `Views/RecorderBar.swift` | 视图 | 底部录音工具条 |
| `Views/Sheets.swift` | 视图 | 新建会议/设置/最近删除/首次引导/分享等弹层 |
| `Views/MeetingTheme.swift` | 视图 | TuneSync 风格主题（暖橙主色、语义色、说话人配色）+ 通用组件 |

## 5. 基础设施

| 文件 | 职责 |
|---|---|
| `worker/index.js` | Sites 托管 Worker：SPA 回退 + `__SITE_ORIGIN__` 注入（**须保持功能不变**） |
| `scripts/prepare-sites-build.mjs` | 组装 Sites 交付物到 `dist/`（client/server/.openai）+ GitHub Pages 404.html（**须保持功能不变**） |
| `scripts/write-release-manifest.mjs` | 发版时生成 `public/releases/latest-macos.json`（含 DMG sha256） |
| `tests/meeting-core.test.ts` | 核心单测（vitest）：formatters/providers/local-models/diarization/updates/lib 纯函数 |
| `tests/sites-worker.test.mjs` | Sites Worker 行为测试（node:test）（**须保持功能不变**） |
| `forge.config.mjs` | Electron 打包：asar unpack 原生模块、Developer ID 签名/公证或 ad-hoc 降级 |
| `vite.config.mjs` | 渲染层构建：相对 base、dist/client 产物 |
| `public/downloads/macos/latest/redirect.js` | 官网最新 DMG 跳转页（仅信任 github.com 官方 release 地址） |

## 6. 功能索引（「我想改 X → 去哪里」）

| 需求 | 位置 |
|---|---|
| 新增/修改一个 IPC 通道 | `electron/main.mjs`（注册）+ `src/types.ts`（MeetingAPI 契约）+ `electron/preload.cjs`（暴露） |
| 调整 AI 总结提示词/响应解析 | `electron/services/providers.mjs`（`summarizeWithOpenAICompatible`） |
| 新增一个服务提供商预设 | `src/components/SettingsDialog.tsx`（`providerPresets` + `llmProviderGroups`） |
| 本地 Whisper 下载目录/运行时探测 | `electron/services/local-models.mjs` |
| 录音分块时长/停止收尾逻辑 | `src/services/recording.ts`（15s 归档块 / 8s 转写块 / `stop()`） |
| 音频块落盘与产物合并 | `electron/main.mjs`（recordings:append/stop 处理器） |
| 说话人分离/合并标签 | `electron/services/diarization.mjs` + `src/lib/transcript.ts` + `src/components/TranscriptPanel.tsx` |
| 纪要手动锁定（防 AI 覆盖） | `src/lib/summary.ts` + `src/components/DocumentWorkspace.tsx` |
| 笔记 Markdown 导入/渲染 | `src/components/DocumentWorkspace.tsx`（marked + DOMPurify + turndown） |
| 导出格式 | `electron/services/exports.mjs` + `src/components/ExportMenu.tsx` |
| 导入队列（暂停/恢复/重试） | `electron/services/import-queue.mjs` + `src/components/ImportDrawer.tsx` |
| 付费墙/激活/离线宽限 | `electron/services/licensing.mjs` + `src/components/PaywallDialog.tsx` |
| 首run权限引导流程版本 | `src/App.tsx`（permissionsVersion 判断）+ `src/components/SystemPermissionsDialog.tsx` |
| 应用更新（清单校验/跳转） | `electron/services/updates.mjs` + `src/components/SettingsDialog.tsx`（updates 页）+ `public/downloads/{macos,windows}/latest/redirect.js` |
| 官网首页文案/区块 | `src/MarketingSite.tsx`（LandingPage） |
| 官网政策页（定价/条款/隐私/退款） | `src/MarketingSite.tsx`（PolicyPage + 四个 *Content） |
| 数据库表结构/搜索索引 | `electron/database.mjs` |
| macOS 窗口红绿灯留白/标题栏 | `electron/main.mjs`（窗口创建）+ `src/styles.css`（`[data-platform="darwin"]`） |
| iOS 录音/实时转录 | `ios/.../Services/RecordingCoordinator.swift` |
| iOS 三栏/标签自适应布局 | `ios/.../Views/AppRootView.swift` + `WorkspaceViews.swift` |
| iOS 主题配色 | `ios/.../Views/MeetingTheme.swift` |

## 7. 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev:electron` | 同时起 Vite dev server + Electron 开发模式 |
| `npm run dev` | 仅 Vite（浏览器预览官网；`?preview=desktop` 预览桌面 UI） |
| `npm test` | vitest 核心单测（32 例，含 DB 差量持久化） |
| `npm run test:sites` | Sites Worker 测试（4 例） |
| `npm run typecheck` | tsc --noEmit |
| `npm run build` | Vite 构建 + Sites 交付物组装（须产出 dist/client/index.html、dist/server/index.js、dist/.openai/hosting.json） |
| `npm run make` | Electron Forge 打包（DMG/Squirrel/ZIP） |
| `node scripts/write-release-manifest.mjs --version X.Y.Z --dmg <path>` / `--setup <path>` | 发版更新官网清单（macOS DMG / Windows 安装程序） |
