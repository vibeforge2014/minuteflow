/**
 * 渲染层全局类型定义：会议、转录段落、AI 纪要、模型配置、偏好、导入任务等领域实体，
 * 以及渲染进程与 Electron 主进程之间的 MeetingAPI 通道契约（由 preload 注入 window.meetingAPI）。
 *
 * 所属层：类型层（跨 store / hooks / services / api 共享的数据契约）。
 * 主要导出：Meeting、TranscriptSegment、MeetingSummary、ModelProfile、MeetingPreferences、MeetingAPI 等。
 */

/** 会议生命周期状态：草稿 / 录音中 / 已暂停 / 已完成 / 被中断（如系统睡眠导致）。 */
export type MeetingStatus = "draft" | "recording" | "paused" | "complete" | "interrupted";
/** 会议形式：online（线上会议，录制麦克风+系统音频）或 offline（线下，仅麦克风）。 */
export type MeetingMode = "online" | "offline";
/** 转录段落状态：provisional（临时中间结果，可能被 final 覆盖）/ final（定稿）/ failed。 */
export type TranscriptStatus = "provisional" | "final" | "failed";
/** 音频轨道来源：麦克风 / 系统（远端）音频 / 两路混音后的文件。 */
export type AudioTrackKind = "microphone" | "system" | "mixed";

/**
 * 转录段落：一段带时间戳和说话人信息的文字。
 * startMs/endMs 相对会议录音起点，用于播放器同步高亮与排序；track 标明来自哪条音频轨。
 */
export interface TranscriptSegment {
  id: string;
  /** 段落起始时间（毫秒，相对录音起点）。 */
  startMs: number;
  /** 段落结束时间（毫秒）。 */
  endMs: number;
  /** 说话人标识（可被说话人合并操作重映射）。 */
  speakerId: string;
  /** 说话人显示名。 */
  speakerName: string;
  /** 转录文本。 */
  text: string;
  status: TranscriptStatus;
  track: AudioTrackKind;
  /** 转写引擎返回的置信度（可选）。 */
  confidence?: number;
}

/**
 * 行动项（会议待办）：从纪要中提炼的任务，含负责人、截止日期与完成状态。
 */
export interface ActionItem {
  id: string;
  title: string;
  /** 负责人姓名。 */
  owner: string;
  /** 截止日期。 */
  dueDate: string;
  status: "todo" | "in_progress" | "done";
  done: boolean;
  /** 支撑该行动项的转录段落 id 列表（证据溯源，可选）。 */
  evidenceSegmentIds?: string[];
}

/**
 * AI 会议纪要：结构化的会议产出，分为主题、要点、决定、行动项、待澄清问题、风险与下一步。
 * stale 表示转写有更新而纪要尚未重新生成；manualLocks 记录用户手动锁定、AI 不得覆盖的字段键。
 */
export interface MeetingSummary {
  /** 讨论主题列表。 */
  topics: string[];
  /** 关键要点列表。 */
  keyPoints: string[];
  /** 已达成的决定列表。 */
  decisions: string[];
  /** 行动项列表。 */
  actionItems: ActionItem[];
  /** 待澄清的开放问题。 */
  openQuestions: string[];
  /** 风险提示。 */
  risks: string[];
  /** 下一步计划。 */
  nextSteps: string[];
  /** 纪要最近一次生成/更新的时间。 */
  updatedAt?: string;
  /** 当前纪要由在线模型或本机基础归纳生成。 */
  generationMode?: "online" | "local";
  /** 本次纪要已覆盖到的转录时间点。 */
  sourceThroughMs?: number;
  /** 转写已更新但纪要未刷新时为 true，UI 据此提示重新总结。 */
  stale?: boolean;
  /** 手动锁定字段键集合（如 "keyPoints:0"、"action:<id>"），AI 重算时保留这些内容。 */
  manualLocks?: string[];
}

/**
 * 会议：核心数据实体，包含元信息、笔记、纪要与完整转写。
 * status/mode 驱动录音行为；deletedAt 非空表示已进入“最近删除”（软删除，可恢复）。
 */
export interface Meeting {
  id: string;
  title: string;
  /** 计划/实际开会时间（ISO 字符串）。 */
  scheduledAt: string;
  /** 录音时长（秒），录音过程中随暂停/停止更新。 */
  durationSeconds: number;
  status: MeetingStatus;
  mode: MeetingMode;
  /** 是否收藏（星标）。 */
  favorite: boolean;
  /** 参会人列表。 */
  participants: string[];
  /** 标签列表。 */
  tags: string[];
  /** 会议目标（新建时填写，作为 AI 总结的输入提示）。 */
  goals: string[];
  /** 个人笔记条目（每条一段，含重点标记等时间线标注）。 */
  notes: string[];
  /** 笔记的 Markdown 源文本；存在时以它为准渲染，保持 .md 导入与编辑的兼容。 */
  notesMarkdown?: string;
  summary: MeetingSummary;
  /** 全量转录段落（按 startMs 有序）。 */
  transcript: TranscriptSegment[];
  createdAt: string;
  updatedAt: string;
  /** 软删除时间戳；非空表示在“最近删除”中，可恢复。 */
  deletedAt?: string;
}

/**
 * 模型档案：一个可用的转录/总结/说话人分离服务配置。
 * kind 区分用途；transport 决定调用协议；密钥明文不落在本对象里，只存 secretId 引用（由主进程经安全存储解析）。
 */
export interface ModelProfile {
  id?: string;
  /** 配置显示名。 */
  name: string;
  /** 用途：llm=纪要总结，stt=语音转写，diarization=说话人分离。 */
  kind: "llm" | "stt" | "diarization";
  /** 调用通道：OpenAI 兼容 chat/audio、Ollama、离线基础纪要、whisper.cpp、Python Whisper、faster-whisper、MLX、sherpa-onnx。 */
  transport: "openai-chat" | "openai-audio" | "ollama" | "local-summary" | "whisper-cpp" | "whisper-python" | "faster-whisper" | "mlx-whisper" | "sherpa-onnx";
  /** 服务基础地址。 */
  baseUrl: string;
  /** 模型名/本地模型文件名。 */
  model: string;
  /** 凭据引用 id（实际密钥保存在主进程安全存储，渲染层不接触明文）。 */
  secretId?: string;
  options: {
    /** 请求超时（毫秒）。 */
    timeoutMs?: number;
    /** 本地 whisper.cpp 可执行文件路径（仅高级排查场景使用，正常流程不出现）。 */
    executablePath?: string;
    /** Python Whisper 运行时解释器路径。 */
    pythonExecutablePath?: string;
    /** 本地模型文件路径。 */
    modelPath?: string;
    /** 主进程解析的应用内置 FFmpeg 路径；仅作运行时字段，不对用户暴露。 */
    ffmpegPath?: string;
    /** 说话人分割模型路径。 */
    segmentationModelPath?: string;
    /** 说话人嵌入模型路径。 */
    embeddingModelPath?: string;
    /** 说话人聚类阈值。 */
    clusteringThreshold?: number;
    /** 接口格式：OpenAI 兼容 / Anthropic 原生 / Gemini 原生；new-api 仅供旧档案迁移。 */
    apiFlavor?: "openai" | "new-api" | "anthropic" | "gemini";
    /** 转写响应格式偏好。 */
    responseFormat?: "json" | "verbose_json" | "text";
    /** 自定义 chat 端点路径（容忍端点变体）。 */
    chatEndpoint?: string;
    /** 自定义转写端点路径。 */
    transcriptionEndpoint?: string;
    /** 附加请求头。 */
    headers?: Record<string, string>;
  };
  /** 是否启用；录音与总结只挑选已启用的档案。 */
  enabled: boolean;
}

/**
 * 音频块：待写入磁盘或送转写的一段内存音频，含相对会议起点的时间区间与来源轨道。
 */
export interface AudioChunk {
  data: ArrayBuffer;
  fileName: string;
  startMs: number;
  endMs: number;
  track: AudioTrackKind;
}

/**
 * 转写上下文：随音频块传递的辅助信息（语言、术语表、前文），帮助模型保持用词一致。
 */
export interface TranscriptContext {
  language: string;
  glossary?: string[];
  previousText?: string;
}

/**
 * 音频资产：已落盘的音频文件引用（供说话人分离等离线处理使用）。
 */
export interface AudioAsset {
  filePath: string;
  durationMs?: number;
}

/**
 * 播放资产：会议播放器可加载的一条音频轨（含可播放 URL），按轨道区分麦克风与系统音频。
 */
export interface PlaybackAsset {
  id: string;
  track: AudioTrackKind;
  originalName: string;
  durationMs?: number;
  url: string;
}

/**
 * 说话人分离（diarization）选项：预期说话人数与聚类阈值。
 */
export interface DiarizationOptions {
  expectedSpeakers?: number;
  threshold?: number;
}

/**
 * 说话人轮次：某说话人在一段时间区间内发言（分离模型的原始输出）。
 */
export interface SpeakerTurn {
  startMs: number;
  endMs: number;
  speakerId: string;
}

/**
 * 增量纪要输入：录音过程中的滚动总结入参（标题、目标、笔记、当前转写与上一版纪要）。
 */
export interface SummaryDeltaInput {
  title: string;
  goals: string[];
  notes: string[];
  transcript: TranscriptSegment[];
  previousSummary: MeetingSummary;
}

/** 最终纪要输入：结构与增量输入相同，仅在会议结束时全量使用。 */
export type FinalSummaryInput = SummaryDeltaInput;
/** 纪要修订版本：AI 每次生成/定稿返回的纪要快照，与 MeetingSummary 同构。 */
export type MeetingSummaryRevision = MeetingSummary;

/**
 * 转写提供方接口：消费一个音频块并产出转录段落（不同引擎实现同一契约）。
 */
export interface TranscriptionProvider {
  transcribe(chunk: AudioChunk, context: TranscriptContext): Promise<TranscriptSegment[]>;
}

/**
 * 说话人分离提供方接口：对整段音频产出说话人轮次。
 */
export interface DiarizationProvider {
  diarize(audio: AudioAsset, options: DiarizationOptions): Promise<SpeakerTurn[]>;
}

/**
 * 纪要提供方接口：update 为录音中滚动增量，finalize 为会后最终总结。
 */
export interface SummaryProvider {
  update(input: SummaryDeltaInput): Promise<MeetingSummaryRevision>;
  finalize(input: FinalSummaryInput): Promise<MeetingSummaryRevision>;
}

/**
 * 新建会议的输入参数（区别于内部完整 Meeting 实体）。
 */
export interface CreateMeetingInput {
  title: string;
  scheduledAt?: string;
  mode: MeetingMode;
  participants: string[];
  goals: string[];
  tags?: string[];
}

/**
 * 用户偏好设置：滚动纪要频率、默认会议形式、术语表、保留策略与首run引导状态。
 * permissionsVersion 用于版本化首run权限流程（升级到新流程时重新弹出）。
 */
export interface MeetingPreferences {
  /** 滚动 AI 纪要的生成间隔（秒）。 */
  summaryIntervalSeconds: number;
  /** 智能滚动纪要节奏版本；升级时把旧默认值迁移为约 1 分钟。 */
  summaryCadenceVersion?: number;
  /** 新建会议的默认形式（online/offline）。 */
  defaultMode: MeetingMode;
  /** 术语表：转写时传给模型，统一专有名词写法。 */
  glossary: string[];
  /** 会议保留天数；null 表示永久保留。 */
  retentionDays: number | null;
  /** 新手引导是否已完成。 */
  onboardingCompleted: boolean;
  /** 首run系统权限引导是否已完成。 */
  systemPermissionsCompleted: boolean;
  /** 权限引导流程版本号，递增以便老用户重新走新版流程。 */
  permissionsVersion: number;
}

/** 系统权限取值：已授权 / 拒绝 / 受限 / 未询问 / 未知。 */
export type SystemPermissionValue = "granted" | "denied" | "restricted" | "not-determined" | "unknown";

/**
 * 系统权限状态：麦克风与屏幕（系统音频）权限，以及当前平台是否依赖系统音频与选取器提示。
 */
export interface SystemPermissionStatus {
  microphone: SystemPermissionValue;
  screen: SystemPermissionValue;
  /** 该平台录制系统音频是否必须（如 macOS 线上会议）。 */
  systemAudioRequired: boolean;
  /** 是否需要提示 macOS 系统音频选取器用法。 */
  systemAudioPickerHint: boolean;
}

/**
 * 授权（许可）状态：¥99 一次性购买的激活/校验结果。
 * offline 表示处于离线宽限期；insecureStorage 提示许可证存储未加密。
 */
export interface LicenseStatus {
  state: "licensed" | "unlicensed" | "error";
  productId: string;
  customerEmail?: string;
  entitlementId?: string;
  activatedAt?: string;
  lastVerifiedAt?: string;
  /** 是否离线（宽限期）状态。 */
  offline: boolean;
  message?: string;
  /** 是否已配置 HTTPS 校验服务。 */
  verificationConfigured: boolean;
  /** 是否已配置购买/结账渠道。 */
  checkoutConfigured: boolean;
  /** 许可证是否存储在不安全的存储中（提示风险）。 */
  insecureStorage: boolean;
}

/**
 * macOS 更新清单条目：从官网校验过的 JSON 更新 manifest 中读取的单条版本信息（含 sha256 与最低系统版本）。
 */
export interface MacUpdateInfo {
  schemaVersion: 1;
  version: string;
  platform: "darwin";
  architectures: string[];
  publishedAt: string;
  notes: string;
  /** 当前 DMG 的稳定下载地址。 */
  downloadUrl: string;
  /** 版本发布页地址。 */
  releasePageUrl: string;
  assetUrl: string;
  /** DMG 的 SHA-256 校验值。 */
  sha256: string;
  minimumSystemVersion: string;
}

/**
 * 应用更新检查结果：idle/available/up-to-date/unsupported/error 五种状态及当前版本信息。
 */
export interface AppUpdateCheckResult {
  status: "idle" | "available" | "up-to-date" | "unsupported" | "error";
  currentVersion: string;
  checkedAt: string;
  message: string;
  /** 有可用更新时携带的版本详情。 */
  update?: MacUpdateInfo;
}

/**
 * 录音会话启动结果：主进程分配的 sessionId（后续 append/stop 都要带上）与会话开始时间戳。
 */
export interface RecordingStartResult {
  sessionId: string;
  startedAt: number;
}

/**
 * 本地模型文件：磁盘扫描或手动选择发现的一个 Whisper 模型；engine 指明应由哪个运行时加载。
 */
export interface LocalModelFile {
  path: string;
  name: string;
  format: string;
  engine: "whisper-cpp" | "whisper-python" | "faster-whisper" | "mlx-whisper";
  sizeBytes: number;
}

/**
 * 本地运行时发现结果：各可选组件（whisper.cpp、托管 Whisper、Python、FFmpeg 等）是否可用。
 */
export interface LocalRuntimeDiscovery {
  whisperCpp?: boolean;
  managedWhisper?: boolean;
  python?: boolean;
  ffmpeg?: boolean;
  fasterWhisper?: boolean;
  mlxWhisper?: boolean;
}

/**
 * 本地模型扫描结果：发现的模型文件 + 可用运行时。
 */
export interface LocalModelScanResult {
  models: LocalModelFile[];
  runtimes: LocalRuntimeDiscovery;
}

/**
 * 可下载模型条目：应用内模型目录中的一项（含来源、许可证、体积与是否已安装）。
 */
export interface DownloadableModel {
  id: string;
  name: string;
  description: string;
  engine: "whisper-cpp" | "whisper-python" | "faster-whisper" | "mlx-whisper";
  format: string;
  sizeBytes: number;
  fileName: string;
  source: string;
  license: string;
  installed: boolean;
  localPath?: string;
  /** 下载完整性校验算法（当前为 sha256）。 */
  digestAlgorithm?: "sha256" | "sha1";
}

/**
 * 模型下载进度事件：准备/下载/校验/就绪/失败五阶段及字节进度。
 */
export interface ModelDownloadProgress {
  modelId: string;
  downloadedBytes: number;
  totalBytes: number;
  status: "preparing" | "downloading" | "verifying" | "ready" | "error";
  message?: string;
}

/**
 * 导入候选：用户选择或拖入、尚未确认入队的一个音频文件描述（由主进程解析文件元信息）。
 */
export interface ImportCandidate {
  sourcePath: string;
  name: string;
  title: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  lastModifiedAt: string;
  durationMs?: number;
}

/** 导入任务阶段：复制 → 预处理 → 转写 → 说话人分离 → 总结 → 完成。 */
export type ImportStage = "copying" | "preparing" | "transcribing" | "diarizing" | "summarizing" | "complete";
/**
 * 导入任务状态：队列与各阶段之外，还包含三种可恢复等待态——
 * waiting_for_model / waiting_for_summary_model / waiting_for_audio_tool（缺组件时暂停而非报错）。
 */
export type ImportStatus = "queued" | "copying" | "preparing" | "transcribing" | "diarizing" | "summarizing" |
  "waiting_for_model" | "waiting_for_summary_model" | "waiting_for_audio_tool" | "complete" | "cancelled" | "failed";

/**
 * 导入任务：后台单 Worker 处理的音频导入作业，关联生成的会议与所选模型档案。
 */
export interface ImportJob {
  id: string;
  /** 导入生成的会议 id。 */
  meetingId: string;
  type: "import";
  title: string;
  sourceName: string;
  status: ImportStatus;
  stage: ImportStage;
  /** 0-1 进度。 */
  progress: number;
  /** 分段转录总块数；旧任务没有该字段。 */
  totalChunks?: number;
  /** 已完成并落盘的分段数。 */
  completedChunks?: number;
  /** 当前正在处理的音频时间区间。 */
  currentChunkStartMs?: number;
  currentChunkEndMs?: number;
  /** 分块方案版本与持久化参数；用于旧任务按原断点续跑。 */
  chunkingVersion?: number;
  chunkDurationMs?: number;
  chunkOverlapMs?: number;
  /** 最近一次滚动纪要已覆盖的音频位置与完成块数。 */
  lastSummaryThroughMs?: number;
  lastSummaryCompletedChunks?: number;
  lastSummaryAt?: string;
  language: string;
  sttProfileId?: string;
  llmProfileId?: string;
  diarizationEnabled: boolean;
  autoSummarize: boolean;
  audioAssetId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 渲染层与后端的完整 API 契约。Electron 下由 preload 通过 contextBridge 注入 window.meetingAPI（IPC 代理到主进程）；
 * 纯浏览器/演示模式下 lib/api.ts 提供同构的 localStorage 兜底实现。
 * 分组职责：meetings 会议 CRUD、recordings 录音会话、transcription 转写、summary 纪要生成、
 * models 模型档案与本地模型管理、notes 笔记导入、imports 音频导入队列、exports 导出、
 * preferences 偏好读写、licensing 授权、updates 应用更新、system 平台与权限事件、window 迷你窗控制。
 */
export interface MeetingAPI {
  /** 会议 CRUD：列表（可搜索、可含最近删除）、读取、创建、保存、软删除与恢复。 */
  meetings: {
    list(query?: string, includeDeleted?: boolean): Promise<Meeting[]>;
    get(id: string): Promise<Meeting | null>;
    create(input: CreateMeetingInput): Promise<Meeting>;
    save(meeting: Meeting): Promise<Meeting>;
    delete(id: string): Promise<boolean>;
    restore(id: string): Promise<Meeting>;
  };
  /** 录音会话：主进程侧建会话、按序号追加音频块、停止（等落盘后返回产出文件）、中止、打开录音目录与列出播放资产。 */
  recordings: {
    start(meetingId: string): Promise<RecordingStartResult>;
    append(payload: {
      meetingId: string;
      sessionId: string;
      track: AudioTrackKind;
      sequence: number;
      data: ArrayBuffer;
      mimeType?: string;
    }): Promise<{ ok: true }>;
    stop(payload: {
      meetingId: string;
      sessionId: string;
      durationSeconds: number;
    }): Promise<Record<string, string>>;
    abort(payload: { meetingId: string; sessionId: string }): Promise<{ ok: true }>;
    open(meetingId: string): Promise<{ path: string }>;
    assets(meetingId: string): Promise<PlaybackAsset[]>;
    /** 主进程推送的录音写盘失败告警（首次失败即时送达，不等停止收尾）。 */
    onWriteError(callback: (payload: { track: AudioTrackKind; message: string }) => void): () => void;
  }
  /** 转写：把一个音频块交给所选 stt 档案处理，返回单个转录段落。 */
  transcription: {
    processChunk(payload: {
      profileId: string;
      data: ArrayBuffer;
      fileName: string;
      language: string;
      startMs: number;
      endMs: number;
      track: AudioTrackKind;
      glossary?: string[];
    }): Promise<TranscriptSegment>;
  };
  /**
   * 纪要生成：final=false 为录音中滚动增量，true 为会后最终总结；由用户手动触发的最终总结不跟随录音停止自动执行。
   * degraded=true 表示结果来自本地规则引擎回退（未配置或在线失败），degradedReason 为给用户的说明。
   */
  summary: {
    generate(payload: {
      meetingId: string;
      profileId?: string;
      final: boolean;
      input: {
        title: string;
        goals: string[];
        notes: string[];
        transcript: TranscriptSegment[];
        previousSummary: MeetingSummary;
      };
    }): Promise<MeetingSummary & { degraded?: boolean; degradedReason?: string }>;
    /** 取消一场会议进行中的总结请求（中止主进程侧的 AbortController）。 */
    cancel(meetingId: string): Promise<{ ok: true }>;
  };
  models: {
    list(): Promise<ModelProfile[]>;
    save(profile: ModelProfile, apiKey?: string): Promise<ModelProfile>;
    test(profile: ModelProfile, apiKey?: string): Promise<{ ok: boolean; message: string }>;
    deleteSecret(secretId: string): Promise<void>;
    scanLocal(): Promise<LocalModelScanResult>;
    chooseLocal(): Promise<LocalModelFile | null>;
    catalog(): Promise<DownloadableModel[]>;
    download(modelId: string): Promise<LocalModelFile>;
    onDownloadProgress(callback: (progress: ModelDownloadProgress) => void): () => void;
  };
  /** 笔记导入：打开文件选择器读取 Markdown 源文本（渲染层保持 Markdown 可编辑）。 */
  notes: {
    importMarkdown(): Promise<{ filePath: string; content: string } | null>;
  };
  imports: {
    choose(): Promise<ImportCandidate[]>;
    fromDropped(files: File[]): Promise<ImportCandidate[]>;
    enqueue(items: ImportCandidate[], options: {
      sttProfileId?: string;
      llmProfileId?: string;
      language?: string;
      diarizationEnabled?: boolean;
      autoSummarize?: boolean;
    }): Promise<ImportJob[]>;
    list(): Promise<ImportJob[]>;
    retry(id: string): Promise<ImportJob>;
    cancel(id: string): Promise<ImportJob>;
    onJobUpdated(callback: (job: ImportJob) => void): () => void;
    /** 导入队列每完成一个音频分段后推送最新会议快照。 */
    onMeetingUpdated(callback: (meeting: Meeting) => void): () => void;
  };
  /** 导出：把会议另存为指定格式（主进程弹出系统保存框）。 */
  exports: {
    save(meeting: Meeting, format: string): Promise<{ canceled: boolean; filePath?: string }>;
  };
  preferences: {
    get(): Promise<MeetingPreferences>;
    save(preferences: MeetingPreferences): Promise<MeetingPreferences>;
  };
  /** 授权：查询/激活/停用许可证，打开购买结账页（密钥校验只在主进程与服务端进行）。 */
  licensing: {
    getStatus(refresh?: boolean): Promise<LicenseStatus>;
    activate(licenseKey: string): Promise<LicenseStatus>;
    deactivate(): Promise<LicenseStatus>;
    openCheckout(): Promise<{ opened: true }>;
  };
  updates: {
    getState(): Promise<AppUpdateCheckResult>;
    check(): Promise<AppUpdateCheckResult>;
    openDownload(): Promise<{ opened: true }>;
    onAvailable(callback: (result: AppUpdateCheckResult) => void): () => void;
  };
  /** 系统能力：平台标识、权限查询/申请路由到系统设置、系统睡眠/唤醒事件订阅。 */
  system: {
    platform: "darwin" | "win32" | "linux" | "web";
    getPermissions(): Promise<SystemPermissionStatus>;
    requestMicrophone(): Promise<SystemPermissionValue>;
    openSettings(kind?: "microphone" | "screen"): Promise<void>;
    onSuspend(callback: () => void): () => void;
    onResume(callback: () => void): () => void;
  };
  /** 窗口：迷你录音窗开关与状态同步。 */
  window: {
    toggleMini(enabled: boolean): Promise<boolean>;
    onMiniChanged(callback: (enabled: boolean) => void): () => void;
  };
}

// 把可选的 meetingAPI 声明到全局 Window 上：Electron 中由 preload 注入；浏览器中保持 undefined，api.ts 据此切换兜底实现。
declare global {
  interface Window {
    meetingAPI?: MeetingAPI;
  }
}
