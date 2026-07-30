import { create } from "zustand";
import { api } from "../lib/api";
import { mergeTranscriptSegments } from "../lib/transcript";
import type { CreateMeetingInput, Meeting, MeetingPreferences, MeetingSummary, ModelProfile, TranscriptSegment } from "../types";

interface MeetingState {
  meetings: Meeting[];
  selectedId: string | null;
  search: string;
  profiles: ModelProfile[];
  preferences: MeetingPreferences;
  loading: boolean;
  saving: boolean;
  error: string | null;
  initialize(): Promise<void>;
  setSearch(value: string): Promise<void>;
  selectMeeting(id: string): void;
  createMeeting(input: CreateMeetingInput): Promise<Meeting>;
  updateMeeting(id: string, updater: (meeting: Meeting) => Meeting, persist?: boolean): Promise<void>;
  appendTranscript(id: string, segment: TranscriptSegment): Promise<void>;
  updateSummary(id: string, summary: MeetingSummary): Promise<void>;
  deleteMeeting(id: string): Promise<void>;
  setProfiles(profiles: ModelProfile[]): void;
  loadProfiles(): Promise<void>;
  updatePreferences(preferences: MeetingPreferences): Promise<void>;
  clearError(): void;
}

export const useMeetingStore = create<MeetingState>((set, get) => ({
  meetings: [],
  selectedId: null,
  search: "",
  profiles: [],
  preferences: {
    summaryIntervalSeconds: 120,
    defaultMode: "online",
    glossary: [],
    retentionDays: null,
    onboardingCompleted: false
  },
  loading: true,
  saving: false,
  error: null,

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

  async setSearch(value) {
    set({ search: value, loading: true });
    try {
      set({ meetings: await api.meetings.list(value), loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "搜索失败" });
    }
  },

  selectMeeting(id) {
    set({ selectedId: id });
  },

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

  async appendTranscript(id, segment) {
    await get().updateMeeting(id, (meeting) => ({
      ...meeting,
      transcript: mergeTranscriptSegments(meeting.transcript, segment),
      summary: { ...meeting.summary, stale: true }
    }));
  },

  async updateSummary(id, summary) {
    await get().updateMeeting(id, (meeting) => ({ ...meeting, summary }));
  },

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

  setProfiles(profiles) {
    set({ profiles });
  },

  async loadProfiles() {
    set({ profiles: await api.models.list() });
  },

  async updatePreferences(preferences) {
    set({ preferences });
    try {
      set({ preferences: await api.preferences.save(preferences) });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "偏好设置保存失败" });
    }
  },

  clearError() {
    set({ error: null });
  }
}));
