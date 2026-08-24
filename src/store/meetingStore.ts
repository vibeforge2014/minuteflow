/**
 * Zustand 全局状态仓库：会议列表、选中项、搜索词、模型档案与用户偏好的唯一数据源。
 * 数据流：组件调用 action → 先乐观更新内存 state（UI 即时反馈）→ 再经 api 持久化
 * （Electron 主进程写本地磁盘 / 浏览器兜底写 localStorage）→ 用保存结果回填 state。
 *
 * 所属层：渲染层状态（Zustand store）。
 * 主要导出：useMeetingStore。
 */
import { create } from "zustand";
import { api } from "../lib/api";
import { mergeTranscriptSegments } from "../lib/transcript";
import { mergeSummaryRevision } from "../lib/summary";
import type { CreateMeetingInput, Meeting, MeetingPreferences, MeetingSummary, ModelProfile, TranscriptSegment } from "../types";

/**
 * 转录增量落盘的节流间隔：录音中每 8 秒产生一条新段落，逐条全量保存会造成
 * “会议级 UPSERT × 段落全量重写”的写放大；这里改为内存即时入账、至多每 10 秒
 * 冲刷一次（停止录音时立即冲刷兜底）。
 */
const TRANSCRIPT_FLUSH_INTERVAL_MS = 10_000;

interface MeetingState {
  meetings: Meeting[];
  /** 当前选中的会议 id（会议库高亮项，null 表示空状态）。 */
  selectedId: string | null;
  /** 当前搜索关键词（与服务端/localStorage 查询保持一致）。 */
  search: string;
  profiles: ModelProfile[];
  preferences: MeetingPreferences;
  /** 首次加载中（控制全屏 loading）。 */
  loading: boolean;
  /** 持久化进行中（标题栏“正在保存/已自动保存”指示）。 */
  saving: boolean;
  /** 全局错误消息（Toast 展示）。 */
  error: string | null;
  /** 并行加载会议/档案/偏好，完成应用启动所需的全部基础数据。 */
  initialize(): Promise<void>;
  /** 按当前搜索词重新拉取会议列表；选中项被删时回落到第一个。 */
  refreshMeetings(): Promise<void>;
  /** 更新搜索词并重新查询（侧栏搜索框输入）。 */
  setSearch(value: string): Promise<void>;
  selectMeeting(id: string): void;
  /** 合并后台导入快照，只更新队列拥有的字段，保留用户正在编辑的标题与笔记。 */
  mergeImportedMeeting(meeting: Meeting): void;
  createMeeting(input: CreateMeetingInput): Promise<Meeting>;
  /** 乐观更新：updater 产出新会议后先改内存，persist=true 时再走 api 保存并回填。 */
  updateMeeting(id: string, updater: (meeting: Meeting) => Meeting, persist?: boolean): Promise<void>;
  /** 并入一条定稿转写段落（去重合并 + 纪要置 stale），落盘走节流冲刷。 */
  appendTranscript(id: string, segment: TranscriptSegment): Promise<void>;
  /** 并入一条临时（provisional）转写段落：只更新内存展示，不置 stale、不落盘。 */
  appendProvisionalTranscript(id: string, segment: TranscriptSegment): void;
  /** 移除一条临时段落（转写失败/空结果时），只影响内存展示。 */
  dropProvisionalTranscript(id: string, segmentId?: string): void;
  /** 立即把某会议当前的内存状态（过滤临时段后）持久化；清除其节流定时器。 */
  flushMeeting(id: string): Promise<void>;
  /** 整体替换会议纪要（AI 结果合并锁定字段后调用）。 */
  updateSummary(id: string, summary: MeetingSummary): Promise<void>;
  /** 软删除会议（移入“最近删除”），并修正选中项。 */
  deleteMeeting(id: string): Promise<void>;
  /** 直接替换档案列表（设置页本地编辑后的同步）。 */
  setProfiles(profiles: ModelProfile[]): void;
  loadProfiles(): Promise<void>;
  /** 先乐观保存偏好，再经 api 持久化；失败时仅置 error 不回滚 UI。 */
  updatePreferences(preferences: MeetingPreferences): Promise<void>;
  clearError(): void;
}

// 各会议待冲刷的节流定时器（meetingId → timer），模块级保证 store 重建也不悬挂。
const flushTimers = new Map<string, number>();

/**
 * 保存会议并在回填时保留仅存在于内存的临时（provisional）段落：
 * 临时段不落库（数据库里只应有定稿内容），但也不能因保存回填把“转写中”指示闪没。
 */
async function persistMeetingToBackend(updated: Meeting): Promise<Meeting> {
  const hasProvisional = updated.transcript.some((segment) => segment.status === "provisional");
  const persisted = hasProvisional
    ? { ...updated, transcript: updated.transcript.filter((segment) => segment.status !== "provisional") }
    : updated;
  const saved = await api.meetings.save(persisted);
  if (!hasProvisional) return saved;
  // 冲刷时未被定稿覆盖的临时段仍在途（被覆盖的已在合并时移除），拼回展示态。
  const provisional = updated.transcript.filter((segment) => segment.status === "provisional");
  return {
    ...saved,
    transcript: [...saved.transcript, ...provisional].sort((left, right) => left.startMs - right.startMs)
  };
}

export const useMeetingStore = create<MeetingState>((set, get) => ({
  // —— 初始 state：空会议列表 + 默认偏好，loading=true 让首帧先渲染全屏加载态 ——
  meetings: [],
  selectedId: null,
  search: "",
  profiles: [],
  preferences: {
    summaryIntervalSeconds: 60,
    summaryCadenceVersion: 1,
    defaultMode: "online",
    glossary: [],
    retentionDays: null,
    onboardingCompleted: false,
    systemPermissionsCompleted: false,
    permissionsVersion: 0,
    modelDownloadSourceKind: "official",
    modelDownloadCustomBase: ""
  },
  loading: true,
  saving: false,
  error: null,

  /** 启动初始化：并行拉取会议、模型档案与偏好，默认选中第一个会议。 */
  async initialize() {
    set({ loading: true, error: null });
    try {
      const [meetings, profiles, preferences] = await Promise.all([
        api.meetings.list(),
        api.models.list(),
        api.preferences.get()
      ]);
      set({
        meetings,
        profiles,
        preferences,
        selectedId: meetings[0]?.id ?? null,
        loading: false
      });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "初始化失败" });
    }
  },

  /** 用当前搜索词刷新会议列表；选中项仍存在则保留，否则回落到列表第一项。 */
  async refreshMeetings() {
    try {
      const meetings = await api.meetings.list(get().search);
      set((state) => ({ meetings, selectedId: state.selectedId && meetings.some((item) => item.id === state.selectedId) ? state.selectedId : meetings[0]?.id ?? null }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "刷新会议失败" });
    }
  },

  /** 侧栏搜索：先记录关键词并置 loading，查询完成后替换列表（由 api 端做全文匹配）。 */
  async setSearch(value) {
    set({ search: value, loading: true });
    try {
      set({ meetings: await api.meetings.list(value), loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "搜索失败" });
    }
  },

  /** 纯内存操作：切换选中的会议。 */
  selectMeeting(id) {
    set({ selectedId: id });
  },

  mergeImportedMeeting(incoming) {
    set((state) => {
      const current = state.meetings.find((meeting) => meeting.id === incoming.id);
      if (!current) return { meetings: [incoming, ...state.meetings] };
      const currentSegments = new Map(current.transcript.map((segment) => [segment.id, segment]));
      const merged: Meeting = {
        ...current,
        transcript: incoming.transcript.map((segment) => {
          const existing = currentSegments.get(segment.id);
          // 后台可以更新时间戳/说话人；已经显示过的文本以本地编辑值为准。
          if (!existing) return segment;
          // 后台自然段落可能沿用第一片的稳定 id 并向后扩展。它包含当前文本时应接受
          // 追加结果；只有区间未增长或后台不含本地文字时才视为用户编辑并保留本地值。
          const backgroundExtended = segment.endMs > existing.endMs && segment.text.includes(existing.text);
          return backgroundExtended ? segment : { ...segment, text: existing.text };
        }),
        durationSeconds: incoming.durationSeconds,
        status: incoming.status,
        summary: {
          ...mergeSummaryRevision(current.summary, incoming.summary),
          stale: incoming.summary.stale
        },
        participants: incoming.participants,
        updatedAt: incoming.updatedAt
      };
      return {
        meetings: state.meetings.map((meeting) => meeting.id === incoming.id ? merged : meeting)
      };
    });
  },

  /** 创建会议：api 成功后把新会议插到列表头部并选中；失败抛错由调用方处理。 */
  async createMeeting(input) {
    set({ saving: true, error: null });
    try {
      const meeting = await api.meetings.create(input);
      set((state) => ({
        meetings: [meeting, ...state.meetings],
        selectedId: meeting.id,
        saving: false
      }));
      return meeting;
    } catch (error) {
      set({ saving: false, error: error instanceof Error ? error.message : "创建会议失败" });
      throw error;
    }
  },

  /**
   * 会议更新的核心通道（乐观更新）：
   * 1. 用 updater(current) 计算新值并刷新 updatedAt，立即写回内存（编辑零延迟）；
   * 2. persist=false 时到此为止——高频转写追加等场景由调用方自行决定何时落盘；
   * 3. persist=true（默认）时置 saving 并调用 api.meetings.save，用持久化结果回填。
   */
  async updateMeeting(id, updater, persist = true) {
    const current = get().meetings.find((meeting) => meeting.id === id);
    if (!current) return;
    const updated = { ...updater(current), updatedAt: new Date().toISOString() };
    set((state) => ({
      meetings: state.meetings.map((meeting) => meeting.id === id ? updated : meeting)
    }));
    if (!persist) return;
    set({ saving: true });
    try {
      const saved = await persistMeetingToBackend(updated);
      set((state) => ({
        meetings: state.meetings.map((meeting) => meeting.id === id ? saved : meeting),
        saving: false
      }));
    } catch (error) {
      set({ saving: false, error: error instanceof Error ? error.message : "保存失败" });
    }
  },

  /**
   * 定稿转写段落入账：经 mergeTranscriptSegments 去重合并（临时段被定稿结果取代），
   * 同时把纪要置为 stale（提示需重新总结）；落盘走 10 秒节流冲刷（见 flushMeeting），
   * 避免长会议每个 8 秒块都触发一次会议级全量保存。
   */
  async appendTranscript(id, segment) {
    await get().updateMeeting(id, (meeting) => ({
      ...meeting,
      transcript: mergeTranscriptSegments(meeting.transcript, segment),
      summary: {
        ...meeting.summary,
        stale: true,
        visualSummary: meeting.summary.visualSummary
          ? { ...meeting.summary.visualSummary, stale: true }
          : undefined
      }
    }), false);
    const existing = flushTimers.get(id);
    if (existing === undefined) {
      flushTimers.set(id, window.setTimeout(() => {
        flushTimers.delete(id);
        void get().flushMeeting(id);
      }, TRANSCRIPT_FLUSH_INTERVAL_MS));
    }
  },

  /** 临时转写段落入账：只更新内存（“转写中…”指示），不落盘、不影响纪要 stale。 */
  appendProvisionalTranscript(id, segment) {
    const current = get().meetings.find((meeting) => meeting.id === id);
    if (!current) return;
    set((state) => ({
      meetings: state.meetings.map((meeting) => meeting.id === id
        ? { ...meeting, transcript: mergeTranscriptSegments(meeting.transcript, segment) }
        : meeting)
    }));
  },

  /** 移除临时段落：segmentId 省略时清空该会议全部临时段（停止录音时收尾用）。 */
  dropProvisionalTranscript(id, segmentId) {
    const current = get().meetings.find((meeting) => meeting.id === id);
    if (!current?.transcript.some((segment) => segment.status === "provisional")) return;
    set((state) => ({
      meetings: state.meetings.map((meeting) => meeting.id === id
        ? {
            ...meeting,
            transcript: meeting.transcript.filter((segment) => segmentId === undefined
              ? segment.status !== "provisional"
              : segment.id !== segmentId)
          }
        : meeting)
    }));
  },

  /** 立即冲刷某会议的节流落盘：清除定时器后把当前内存态（过滤临时段）持久化并回填。 */
  async flushMeeting(id) {
    const timer = flushTimers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      flushTimers.delete(id);
    }
    const current = get().meetings.find((meeting) => meeting.id === id);
    if (!current) return;
    set({ saving: true });
    try {
      const saved = await persistMeetingToBackend(current);
      set((state) => ({
        meetings: state.meetings.map((meeting) => meeting.id === id ? saved : meeting),
        saving: false
      }));
    } catch (error) {
      set({ saving: false, error: error instanceof Error ? error.message : "保存失败" });
    }
  },

  /** 替换会议纪要（AI 结果已按 mergeSummaryRevision 合并锁定字段后写入）。 */
  async updateSummary(id, summary) {
    await get().updateMeeting(id, (meeting) => ({ ...meeting, summary }));
  },

  /** 软删除（移入最近删除）：先持久化删除标记，再从内存列表移除并修正选中项。 */
  async deleteMeeting(id) {
    await api.meetings.delete(id);
    set((state) => {
      const meetings = state.meetings.filter((meeting) => meeting.id !== id);
      return {
        meetings,
        selectedId: state.selectedId === id ? meetings[0]?.id ?? null : state.selectedId
      };
    });
  },

  /** 设置页直接同步本地编辑后的档案列表（不做持久化，保存仍走 api.models.save）。 */
  setProfiles(profiles) {
    set({ profiles });
  },

  /** 从后端重新拉取模型档案。 */
  async loadProfiles() {
    set({ profiles: await api.models.list() });
  },

  /** 偏好更新：先乐观写入内存，再经 api 持久化；失败只置 error，不打断 UI。 */
  async updatePreferences(preferences) {
    set({ preferences });
    try {
      set({ preferences: await api.preferences.save(preferences) });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "偏好设置保存失败" });
    }
  },

  /** 清除全局错误（关闭 Toast 时调用）。 */
  clearError() {
    set({ error: null });
  }
}));
