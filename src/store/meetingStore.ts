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
import type { CreateMeetingInput, Meeting, MeetingPreferences, MeetingSummary, ModelProfile, TranscriptSegment } from "../types";

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
  createMeeting(input: CreateMeetingInput): Promise<Meeting>;
  /** 乐观更新：updater 产出新会议后先改内存，persist=true 时再走 api 保存并回填。 */
  updateMeeting(id: string, updater: (meeting: Meeting) => Meeting, persist?: boolean): Promise<void>;
  /** 并入一条转写段落（含去重合并），并把纪要标记为 stale。 */
  appendTranscript(id: string, segment: TranscriptSegment): Promise<void>;
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

export const useMeetingStore = create<MeetingState>((set, get) => ({
  // —— 初始 state：空会议列表 + 默认偏好，loading=true 让首帧先渲染全屏加载态 ——
  meetings: [],
  selectedId: null,
  search: "",
  profiles: [],
  preferences: {
    summaryIntervalSeconds: 120,
    defaultMode: "online",
    glossary: [],
    retentionDays: null,
    onboardingCompleted: false,
    systemPermissionsCompleted: false,
    permissionsVersion: 0
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
      const saved = await api.meetings.save(updated);
      set((state) => ({
        meetings: state.meetings.map((meeting) => meeting.id === id ? saved : meeting),
        saving: false
      }));
    } catch (error) {
      set({ saving: false, error: error instanceof Error ? error.message : "保存失败" });
    }
  },

  /** 转写段落入账：经 mergeTranscriptSegments 去重合并，同时把纪要置为 stale（提示需重新总结）。 */
  async appendTranscript(id, segment) {
    await get().updateMeeting(id, (meeting) => ({
      ...meeting,
      transcript: mergeTranscriptSegments(meeting.transcript, segment),
      summary: { ...meeting.summary, stale: true }
    }));
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
