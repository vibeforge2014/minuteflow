/**
 * 转写视图（中央工作区「转写」标签页的内容，也可嵌入其他容器）：
 * 发言人色点与改名/合并管理、可编辑的转写段落（textarea 直接改写文本并标记纪要过期）、
 * 时间戳点击跳转播放器、播放进度驱动的歌词式高亮（is-playing）、
 * 长会议按 200 条增量加载 + 跟随尾部自动滚动。
 * 视图自身不带外壳与滚动容器：外层（如中央文档列）负责提供 .workspace-transcript。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowClockwise,
  ArrowUUpLeft,
  CaretDown,
  CaretUp,
  CheckCircle,
  Check,
  Copy,
  FingerprintSimple,
  MagicWand,
  MagnifyingGlass,
  PencilSimple,
  Swap,
  Trash,
  Users,
  WarningCircle,
  Waveform,
  X
} from "@phosphor-icons/react";
import type { ImportJob, Meeting, ModelProfile, TranscriptSegment, VoiceprintPerson } from "../types";
import { api } from "../lib/api";
import { ConfirmDialog, useConfirmDialog } from "./ConfirmDialog";
import { findPlayingSegment } from "../lib/workspace";
import { countOccurrences, mergeSpeakerLabels, replaceOccurrences } from "../lib/transcript";
import { classifyTextChange } from "../lib/content-motion";
import type { LiveTranscriptionFailure } from "../services/recording";
import { useEnteringItemIds } from "../hooks/useContentMotion";
import { useExitPresence } from "../hooks/useExitPresence";
import { ImportProcessingMeta } from "./ImportProcessingMeta";
import {
  canRetryTranscriptionGaps,
  describeImportProcessing,
  hasUnassignedImportSpeakers,
  isActiveImportJob,
  isRetryableImportJob
} from "../lib/import-status";
import { useStreamingTranscript } from "../hooks/useStreamingTranscript";
import { shortcutLabel } from "../lib/platform";
import { useMeetingStore } from "../store/meetingStore";
import { isLowConfidence, countLowConfidence } from "../lib/transcript-confidence";
import {
  MAX_SUGGESTION_TEXT_CHARS,
  applyGlossarySuggestion,
  findGlossarySuggestions
} from "../lib/glossary-suggestions";
import type { GlossarySuggestion } from "../lib/glossary-suggestions";
import type { WorkspaceStage } from "../lib/workspace";

export interface TranscriptJump {
  ms: number;
  nonce: number;
  segmentId?: string;
}

interface TranscriptViewProps {
  meeting: Meeting;
  importJob?: ImportJob;
  sttProfiles?: ModelProfile[];
  splitWorkspace?: boolean;
  stage: WorkspaceStage;
  onChange(meeting: Meeting): void;
  /** 当前播放位置（毫秒），用于高亮同步段落。 */
  playbackMs?: number;
  playbackPlaying?: boolean;
  /** 点击时间戳时请求播放器跳转。 */
  onSeek?(ms: number): void;
  /** 空逐字稿在会后提供唯一、明确的恢复动作。 */
  emptyActionLabel?: string;
  onEmptyAction?(): void;
  /** 关键结论回链：跳到该时刻所在段落并短暂高亮（nonce 变化触发一次性定位）。 */
  jumpTarget?: TranscriptJump | null;
  summaryBusy?: boolean;
  /** 实时转写连续失败后的持久提示；录音结束后也保留，直到用户处理或忽略。 */
  transcriptionFailure?: LiveTranscriptionFailure | null;
  transcriptionIsLocal?: boolean;
  onUseLocalWhisper?(): void;
  onChooseTranscriptionService?(): void;
  onDismissTranscriptionFailure?(): void;
  /** 导入任务可恢复操作：失败/取消后重试，处理中暂停。 */
  onRetryImport?(id: string, sttProfileId?: string): void;
  onCancelImport?(id: string): void;
  /** 跳过说话人识别，保留转写继续生成纪要。 */
  onSkipDiarization?(id: string): void;
  /** 重新转录：用已归档录音重跑转写/识别/纪要（在线转写失败后的会后补救路径）。 */
  onRetranscribe?(): void;
  onConfigureTranscription?(): void;
}

export function TranscriptView({ meeting, importJob, sttProfiles = [], stage, splitWorkspace = stage === "live", onChange, playbackMs = 0, playbackPlaying = false, onSeek, emptyActionLabel, onEmptyAction, jumpTarget, summaryBusy, transcriptionFailure, transcriptionIsLocal = false, onUseLocalWhisper, onChooseTranscriptionService, onDismissTranscriptionFailure, onRetryImport, onCancelImport, onSkipDiarization, onRetranscribe, onConfigureTranscription }: TranscriptViewProps) {
  /** 段落批量改写（查找替换 / 撤销）走 store：在最新转写上执行，不会被渲染快照覆盖。 */
  const patchTranscript = useMeetingStore((state) => state.patchTranscript);
  /** 正在重命名的说话人 id（显示浮层输入框）。 */
  const [speakerEditor, setSpeakerEditor] = useState<string | null>(null);
  /** 改名时是否把这个人注册进本机声纹簿（默认勾选，可显式关闭）。 */
  const [rememberVoice, setRememberVoice] = useState(true);
  const [managerOpen, setManagerOpen] = useState(false);
  const [mergeSource, setMergeSource] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");
  /** 当前渲染的转写条数（从最新往前窗口化，长会议渐进加载）。 */
  const [visibleCount, setVisibleCount] = useState(200);
  /** 文内查找：⌘F / Ctrl+F 打开，带命中计数、上下跳转与按发言人筛选。 */
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  /**
   * 校对替换：替换内容 + 上一次替换的撤销快照（只保留最近一次，避免误撤更早的修改）。
   * 快照记录每段的「替换前 / 替换后」文本，撤销时只有仍等于「替换后」的段落才回滚。
   */
  const [replaceText, setReplaceText] = useState("");
  const [replaceNotice, setReplaceNotice] = useState("");
  const [undoState, setUndoState] = useState<{
    /** 本次替换实际改写的处数，用于撤销提示。 */
    occurrences: number;
    entries: Array<{ id: string; before: string; after: string }>;
  } | null>(null);
  const [speakerFilter, setSpeakerFilter] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [searchFocusId, setSearchFocusId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
    setSpeakerFilter("");
    setSearchFocusId(null);
    setReplaceNotice("");
    window.setTimeout(() => searchTriggerRef.current?.focus(), 0);
  }, []);
  const [autoScroll, setAutoScroll] = useState(true);
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  /** 用户已忽略的术语建议（段落 id + 建议 id），不会自动改字。 */
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(() => new Set());
  /** 只看引擎标为可能不准的片段，便于会后集中复核。 */
  const [onlyLowConfidence, setOnlyLowConfidence] = useState(false);
  const [voiceprints, setVoiceprints] = useState<VoiceprintPerson[]>([]);
  const [learningSpeakerId, setLearningSpeakerId] = useState<string | null>(null);
  const [voiceprintMessage, setVoiceprintMessage] = useState("");
  /** AI 语义校对与局部单段重识别状态。 */
  const [correctingTranscript, setCorrectingTranscript] = useState(false);
  const [retranscribingSegmentId, setRetranscribingSegmentId] = useState<string | null>(null);
  const [expandedRawIds, setExpandedRawIds] = useState<Set<string>>(() => new Set());
  const confirmDialog = useConfirmDialog();
  /** 关键结论回链定位到的段落 id（短暂高亮后清除）。 */
  const [jumpHighlightId, setJumpHighlightId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 自定义术语：识别时进 prompt，识别后生成可确认的纠错建议。 */
  const globalGlossary = useMeetingStore((state) => state.preferences.glossary);
  const glossary = useMemo(() => [...new Set([...(importJob?.transcriptionTerms ?? []), ...globalGlossary])], [globalGlossary, importJob?.transcriptionTerms]);
  const speakersUnassigned = hasUnassignedImportSpeakers(importJob);
  // 从转写中提取去重后的说话人 (id → name) 列表。
  const speakers = useMemo(() => Array.from(new Map(
    meeting.transcript.filter((segment) => !speakersUnassigned || segment.speakerId !== "speaker-1" || segment.speakerName !== "发言人1")
      .map((segment) => [segment.speakerId, segment.speakerName])
  )), [meeting.transcript, speakersUnassigned]);
  // 转写流式揭示：导入进行中（任务未终结）或会议进行中时，新到达文本按打字机
  // 节奏逐拍铺开，与 AI 问答同一观感；未轮到出字的段落暂不露出空时间戳。
  const importActive = Boolean(importJob) && !["complete", "failed", "cancelled"].includes(importJob?.status ?? "");
  const { segments: displayTranscript, streamingSegmentId } = useStreamingTranscript(meeting, importActive || stage === "live");
  /** 发言人筛选先于窗口化：只加载所选发言人的段落，长会议查找不会把无关内容一起渲染。 */
  const lowConfidenceCount = useMemo(() => countLowConfidence(displayTranscript), [displayTranscript]);
  const filteredTranscript = useMemo(
    () => {
      const bySpeaker = speakerFilter
        ? displayTranscript.filter((segment) => segment.speakerId === speakerFilter)
        : displayTranscript;
      return onlyLowConfidence
        ? bySpeaker.filter((segment) => isLowConfidence(segment.confidence))
        : bySpeaker;
    },
    [displayTranscript, speakerFilter, onlyLowConfidence]
  );
  /** 命中段落 id（按时间顺序），上下跳转在 filteredTranscript 的窗口里定位。 */
  const searchMatches = useMemo(
    () => normalizedQuery
      ? filteredTranscript.filter((segment) => segment.text.toLowerCase().includes(normalizedQuery)).map((segment) => segment.id)
      : [],
    [filteredTranscript, normalizedQuery]
  );
  // 窗口切片必须 memo：非 memo 时父组件任意一次重渲染（录音计时、Toast 等）都会
  // 产生新数组，级联使下面 3 个 useMemo 与 useEnteringItemIds 全部失效。
  const visibleSegments = useMemo(
    () => filteredTranscript.slice(-visibleCount),
    [filteredTranscript, visibleCount]
  );
  const visibleSegmentIds = useMemo(() => visibleSegments.map((segment) => segment.id), [visibleSegments]);
  const enteringSegmentIds = useEnteringItemIds(meeting.id, visibleSegmentIds);
  // 同一批新入场的段落按 0/40/80ms 级联出现；用 Map 查询，避免批量入场时
  // 对每段做一次数组 indexOf（近千段时退化为 O(N²)）。
  const enteringSequence = useMemo(
    () => new Map(visibleSegments
      .filter((segment) => enteringSegmentIds.has(segment.id))
      .map((segment, index) => [segment.id, index])),
    [visibleSegments, enteringSegmentIds]
  );
  /**
   * 术语纠错建议：只算可见段落，按「段落文本 + 术语表」缓存，长会议滚动不会重复
   * 做编辑距离。计算用会议里的完整原文（流式揭示期间显示层文本可能只出到一半），
   * 结果仅展示，确认后才由 applyGlossarySuggestion 改写。
   */
  const suggestionCache = useRef(new Map<string, { text: string; key: string; items: GlossarySuggestion[] }>());
  const glossaryKey = glossary.join("\u0000");
  const fullTextById = useMemo(
    () => new Map(meeting.transcript.map((segment) => [segment.id, segment.text])),
    [meeting.transcript]
  );
  const suggestionsBySegment = useMemo(() => {
    const result = new Map<string, GlossarySuggestion[]>();
    if (!glossary.length) return result;
    // 缓存按段落 id 单调增长，长会议滚动会一直堆；超过 500 条直接整体失效重算，
    // 命中率几乎不变，但内存有上界。
    if (suggestionCache.current.size > 500) suggestionCache.current.clear();
    for (const segment of visibleSegments) {
      if (segment.status !== "final" || editingSegmentId === segment.id) continue;
      const text = fullTextById.get(segment.id) ?? segment.text;
      if (!text || text.length > MAX_SUGGESTION_TEXT_CHARS) continue;
      const cached = suggestionCache.current.get(segment.id);
      const fresh = !cached || cached.text !== text || cached.key !== glossaryKey;
      const items = fresh ? findGlossarySuggestions(text, glossary, 2) : cached!.items;
      if (fresh) suggestionCache.current.set(segment.id, { text, key: glossaryKey, items });
      const visible = items.filter((item) => !dismissedSuggestions.has(`${segment.id}:${item.id}`));
      if (visible.length) result.set(segment.id, visible);
    }
    return result;
  }, [glossary, glossaryKey, visibleSegments, fullTextById, dismissedSuggestions, editingSegmentId]);
  const tailSegment = displayTranscript.at(-1);
  const tailSignature = tailSegment ? `${tailSegment.id}:${tailSegment.text.length}:${tailSegment.status}` : "";

  /**
   * 校对替换：命中预览与原地改写。
   * 范围与查找一致（发言人与「可能不准」筛选之后的段落），计数按出现次数而非段落数，
   * 让「全部替换」在点下之前就能看到会影响多少处。
   * 改写本身交给 store 在最新转写上执行（见 onPatchTranscript）：录音持续追加段落时，
   * 用渲染快照回写会把刚到的内容抹掉。
   */
  const replaceNeedle = query.trim();
  const replacePreview = useMemo(() => {
    if (!replaceNeedle) return { segments: 0, occurrences: 0 };
    let segments = 0;
    let occurrences = 0;
    for (const segment of filteredTranscript) {
      const hits = countOccurrences(fullTextById.get(segment.id) ?? segment.text, replaceNeedle);
      if (hits > 0) {
        segments += 1;
        occurrences += hits;
      }
    }
    return { segments, occurrences };
  }, [filteredTranscript, fullTextById, replaceNeedle]);

  /**
   * 应用一次替换：改写函数交给 store 在最新转写上执行，并留下最近一次的撤销快照。
   * scopeIds 限定改写范围（与查找的发言人/低置信筛选一致），mode 决定每段改一处还是全部。
   * 返回实际改写的处数与快照；没有命中（例如段落刚被新转写覆盖）时返回 null。
   */
  const applyReplacement = (scopeIds: Set<string>, mode: "first" | "all") => {
    const snapshot: Array<{ id: string; before: string; after: string }> = [];
    const changed = patchTranscript(meeting.id, (segment) => {
      if (!scopeIds.has(segment.id)) return null;
      const result = replaceOccurrences(segment.text, replaceNeedle, replaceText, mode);
      if (!result.count) return null;
      snapshot.push({ id: segment.id, before: segment.text, after: result.text });
      return result.text;
    });
    if (!changed || !snapshot.length) {
      setReplaceNotice("没有可替换的命中：这段转写可能刚刚更新");
      return null;
    }
    // 处数按「替换前文本」统计，single 模式每段只算一处。
    const occurrences = mode === "first"
      ? snapshot.length
      : snapshot.reduce((sum, entry) => sum + countOccurrences(entry.before, replaceNeedle), 0);
    const notice = `已替换 ${occurrences} 处，可撤销`;
    setUndoState({ occurrences, entries: snapshot });
    setReplaceNotice(notice);
    return { occurrences, snapshot };
  };

  /** 替换当前定位到的这一处（命中段里只改第一处，其余留给下一次点击确认）。 */
  const replaceCurrentMatch = () => {
    if (!replaceNeedle || !searchMatches.length) return;
    const targetId = searchMatches[Math.min(activeMatch, searchMatches.length - 1)];
    const applied = applyReplacement(new Set([targetId]), "first");
    if (!applied) return;
    // 该段已无命中时把光标顺到下一段，连续校对不用再点「下一个」。
    if (!countOccurrences(applied.snapshot[0].after, replaceNeedle)) jumpToMatch(activeMatch);
  };

  /** 全部替换：先给出命中段落数与处数的确认预览，替换后可一键撤销。 */
  const replaceAllMatches = async () => {
    if (!replaceNeedle || !replacePreview.occurrences) return;
    const accepted = await confirmDialog.confirm({
      title: `全部替换「${replaceNeedle}」？`,
      body: `将在 ${replacePreview.segments} 个段落中替换 ${replacePreview.occurrences} 处为「${replaceText || "（空）"}」，替换后可以一次性撤销。`,
      confirmLabel: `替换 ${replacePreview.occurrences} 处`
    });
    if (!accepted) return;
    applyReplacement(new Set(filteredTranscript.map((segment) => segment.id)), "all");
  };

  /**
   * 撤销最近一次替换：只回滚「当前仍是替换结果」的段落。
   * 录音/转写可能已经在替换之后更新了这些段落，盲目套用旧快照会把新内容抹掉，
   * 因此逐段比较后再交换，被跳过的段落会在提示里说明。
   */
  const undoReplacement = () => {
    if (!undoState) return;
    const entries = new Map(undoState.entries.map((entry) => [entry.id, entry]));
    let skipped = 0;
    const restored = patchTranscript(meeting.id, (segment) => {
      const entry = entries.get(segment.id);
      if (!entry) return null;
      if (segment.text !== entry.after) {
        skipped += 1;
        return null;
      }
      return entry.before;
    });
    if (!restored) {
      setReplaceNotice("这些段落已随转写更新，没有可回滚的内容");
    } else {
      const undone = skipped ? `${restored} 段` : `${undoState.occurrences} 处`;
      setReplaceNotice(`已撤销上次替换（${undone}）${skipped ? `；${skipped} 段转写已更新，未回滚` : ""}`);
    }
    setUndoState(null);
  };

  const refreshVoiceprints = useCallback(() => {
    api.voiceprints.list().then(setVoiceprints).catch(() => setVoiceprints([]));
  }, []);

  // 切换会议时重置窗口化计数。
  useEffect(() => {
    setVisibleCount(200);
    setAutoScroll(true);
    setManagerOpen(false);
    setSpeakerEditor(null);
    setEditingSegmentId(null);
    setVoiceprintMessage("");
    setSearchOpen(false);
    setQuery("");
    setReplaceText("");
    setReplaceNotice("");
    setUndoState(null);
    setSpeakerFilter("");
    setActiveMatch(0);
    setSearchFocusId(null);
    setDismissedSuggestions(new Set());
    setOnlyLowConfidence(false);
    setExpandedRawIds(new Set());
    setRetranscribingSegmentId(null);
    suggestionCache.current.clear();
    refreshVoiceprints();
  }, [meeting.id, refreshVoiceprints]);

  /** 回放位置对应的段落（间隙保留上一段高亮，见 findPlayingSegment）。 */
  const playingSegment = useMemo(
    () => findPlayingSegment(meeting.transcript, playbackMs),
    [meeting.transcript, playbackMs]
  );

  /** 跟随滚动自身触发的 scroll 事件在该时间戳之前不参与“是否脱离跟随”判定。 */
  const followGuardUntil = useRef(0);

  // Auto-scroll to keep the newest transcript in view during a live meeting.
  // Only sticks when the user is already near the bottom so reading older
  // segments is not interrupted — a standard "follow tail" behavior.
  // 回放进行中改由下方的“跟随回放”效果接管，两条跟随互斥。
  useEffect(() => {
    const list = listRef.current;
    if (!list || !autoScroll || playingSegment || meeting.transcript.length === 0 || (stage !== "live" && !importActive)) return;
    // 刚发生回链/回放定位的程序性滚动短时间内不参与“跟随尾部”，避免两股滚动互相拉扯。
    if (performance.now() < followGuardUntil.current) return;
    list.scrollTo({
      top: list.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
    });
  }, [tailSignature, autoScroll, visibleCount, playingSegment, stage, importActive]);

  // 回放跟随（歌词式）：播放进入新段落时把该段滚到列表上部约 1/3 处；
  // 段落已在可视上中部时不重复滚动，减少无谓位移。正在播放的段落落在
  // 窗口化渲染之外时先扩窗，扩窗重渲染后本效果再次运行并完成定位。
  useEffect(() => {
    const list = listRef.current;
    if (!playingSegment || !autoScroll || !list) return;
    const el = list.querySelector<HTMLElement>(`[data-segment-id="${playingSegment.id}"]`);
    if (!el) {
      const index = meeting.transcript.findIndex((segment) => segment.id === playingSegment.id);
      if (index >= 0) setVisibleCount((count) => Math.max(count, meeting.transcript.length - index + 20));
      return;
    }
    const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top;
    if (top >= list.clientHeight * 0.1 && top <= list.clientHeight * 0.5) return;
    followGuardUntil.current = performance.now() + 450;
    list.scrollTo({
      top: Math.max(0, list.scrollTop + top - list.clientHeight / 3),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
    });
  }, [playingSegment?.id, autoScroll, visibleCount, meeting.transcript]);

  // 关键结论回链定位：扩窗到目标段、把该段滚到列表约 1/3 处并短暂高亮 2 秒。
  // 一次性动作只由 nonce 驱动；双 rAF 等待扩窗重渲染完成后再定位。
  useEffect(() => {
    if (!jumpTarget) return;
    const target = jumpTarget.segmentId
      ? meeting.transcript.find((segment) => segment.id === jumpTarget.segmentId)
      : findPlayingSegment(meeting.transcript, jumpTarget.ms);
    if (!target) return;
    if (!filteredTranscript.some((segment) => segment.id === target.id)) {
      setQuery("");
      setSpeakerFilter("");
      setOnlyLowConfidence(false);
    }
    const index = meeting.transcript.findIndex((segment) => segment.id === target.id);
    if (index >= 0 && index < meeting.transcript.length - visibleCount) {
      setVisibleCount((count) => Math.max(count, meeting.transcript.length - index + 20));
    }
    followGuardUntil.current = performance.now() + 450;
    setAutoScroll(false);
    const list = listRef.current;
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = list?.querySelector<HTMLElement>(`[data-segment-id="${CSS.escape(target.id)}"]`);
      if (!el || !list) return;
      const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top;
      list.scrollTo({
        top: Math.max(0, list.scrollTop + top - list.clientHeight / 3),
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
      });
    }));
    setJumpHighlightId(target.id);
    const timer = window.setTimeout(() => setJumpHighlightId(null), 2000);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [jumpTarget?.nonce]);

  /** 用户向上阅读时暂停跟随；回到底部或点击恢复后重新跟随最新内容。
      回放中改用“正在播放的段落是否仍在可视区”判定，跟随滚动自身触发的事件被忽略。 */
  const handleTranscriptScroll = () => {
    const list = listRef.current;
    if (!list) return;
    if (performance.now() < followGuardUntil.current) return;
    if (playingSegment) {
      const el = list.querySelector<HTMLElement>(`[data-segment-id="${playingSegment.id}"]`);
      if (el) {
        const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top;
        setAutoScroll(top > -el.offsetHeight && top < list.clientHeight);
        return;
      }
    }
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    setAutoScroll(distanceFromBottom < 64);
  };

  /** 跳到第 index 个命中：必要时扩窗、暂停尾部跟随、把该段滚到列表约 1/3 处并短暂高亮。 */
  const jumpToMatch = useCallback((index: number) => {
    if (!searchMatches.length) return;
    const next = ((index % searchMatches.length) + searchMatches.length) % searchMatches.length;
    setActiveMatch(next);
    const targetId = searchMatches[next];
    const targetIndex = filteredTranscript.findIndex((segment) => segment.id === targetId);
    if (targetIndex >= 0) setVisibleCount((count) => Math.max(count, filteredTranscript.length - targetIndex + 20));
    followGuardUntil.current = performance.now() + 700;
    setAutoScroll(false);
    setSearchFocusId(targetId);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const list = listRef.current;
      const el = list?.querySelector<HTMLElement>(`[data-segment-id="${targetId}"]`);
      if (!el || !list) return;
      const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top;
      list.scrollTo({
        top: Math.max(0, list.scrollTop + top - list.clientHeight / 3),
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
      });
    }));
  }, [searchMatches, filteredTranscript]);
  const jumpRef = useRef(jumpToMatch);
  jumpRef.current = jumpToMatch;

  // 输入关键词 / 切换发言人时自动定位第一个命中；录音持续追加段落时不重跑，
  // 避免把正在查看的第 N 个命中反复拉回开头。
  useEffect(() => {
    if (!searchOpen || !normalizedQuery) return;
    jumpRef.current(0);
  }, [searchOpen, normalizedQuery, speakerFilter]);

  // 替换后命中数会变少：把光标收回到有效范围，避免显示「5 / 3」这种越界计数。
  useEffect(() => {
    setActiveMatch((current) => (searchMatches.length ? Math.min(current, searchMatches.length - 1) : 0));
  }, [searchMatches.length]);

  // ⌘F / Ctrl+F 打开文内查找；Esc 关闭、Enter / Shift+Enter 前后跳转。
  // 有弹层在前台时让位，不在被遮住的转写视图里抢焦点。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "f") {
        if (document.querySelector(".modal-backdrop, .import-drawer")) return;
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
        return;
      }
      if (!searchOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeSearch();
        return;
      }
      if (event.key === "Enter" && document.activeElement === searchInputRef.current) {
        event.preventDefault();
        jumpRef.current(activeMatch + (event.shiftKey ? -1 : 1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen, activeMatch, closeSearch]);

  /**
   * 重命名说话人：批量替换其全部段落的显示名，并把纪要标记为过期（stale）。
   * 默认同时从本机音频注册声纹；用户可以在浮层里显式关闭“记住声音”。
   */
  const renameSpeaker = (speakerId: string, name: string, remember = true) => {
    onChange({
      ...meeting,
      transcript: meeting.transcript.map((segment) =>
        segment.speakerId === speakerId ? { ...segment, speakerName: name } : segment),
      summary: { ...meeting.summary, stale: true }
    });
    setSpeakerEditor(null);
    if (!remember) {
      setVoiceprintMessage(`姓名已应用到全部片段；没有记住声纹，下次分离不会自动使用「${name}」。`);
      return;
    }
    setLearningSpeakerId(speakerId);
    setVoiceprintMessage(`正在从本地音频记住“${name}”…`);
    void api.voiceprints.enroll({ meetingId: meeting.id, speakerId, name }).then((result) => {
      setVoiceprintMessage(`已在本机记住“${result.name}”（${result.sampleCount} 份样本），下次分离时会尝试自动命名。`);
      refreshVoiceprints();
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setVoiceprintMessage(`姓名已修改，但暂未记住声纹：${message.replace(/^Error invoking remote method '[^']+':\s*/, "")}`);
    }).finally(() => setLearningSpeakerId(null));
  };

  /** 打开改名浮层时默认勾选“记住声音”，用户每次都可以改。 */
  const openSpeakerEditor = (speakerId: string) => {
    setRememberVoice(true);
    setSpeakerEditor(speakerId);
  };

  /** 删除本地声纹不会改动历史逐字稿，只影响后续自动识别。 */
  const forgetVoiceprint = async (name: string) => {
    if (!(await confirmDialog.confirm({
      title: `忘记“${name}”的声纹？`,
      body: "只删除本机保存的声纹样本，历史会议中的姓名不会改变。",
      confirmLabel: "忘记声纹"
    }))) return;
    try {
      await api.voiceprints.forget(name);
      setVoiceprintMessage(`已忘记“${name}”的声纹，历史会议内容保持不变。`);
      refreshVoiceprints();
    } catch (error) {
      setVoiceprintMessage(`暂时无法删除声纹：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** 合并两个说话人标签（同一人被识别成两个 id 的场景），实际重映射在 lib/transcript.ts。 */
  const mergeSpeakers = () => {
    if (!mergeSource || !mergeTarget || mergeSource === mergeTarget) return;
    const targetName = speakers.find(([id]) => id === mergeTarget)?.[1] ?? "发言人";
    onChange({
      ...meeting,
      transcript: mergeSpeakerLabels(meeting.transcript, mergeSource, mergeTarget, targetName),
      summary: { ...meeting.summary, stale: true }
    });
    setMergeSource("");
    setMergeTarget("");
  };

  const updateSegmentText = (segmentId: string, text: string) => {
    // 手动改写后旧的替换快照不再可信：撤销只保证能回到「上一次替换前」，
    // 中间夹了人工编辑时会连编辑一起回退，所以直接作废。
    setUndoState(null);
    setReplaceNotice("");
    onChange({
      ...meeting,
      transcript: meeting.transcript.map((item) =>
        item.id === segmentId ? { ...item, text } : item),
      summary: { ...meeting.summary, stale: true }
    });
  };

  /** 手动触发整场转写的受控 LLM 语义纠错（保留原稿 rawText 可随时对照恢复）。 */
  const runTranscriptCorrection = async () => {
    if (correctingTranscript || stage === "live" || importActive) return;
    setCorrectingTranscript(true);
    setVoiceprintMessage("");
    try {
      const result = await api.transcription.correct({ meetingId: meeting.id });
      onChange(result.meeting);
      setVoiceprintMessage(
        result.correctedCount > 0
          ? `已完成 AI 校对：修正 ${result.correctedCount} 段（保留原稿可恢复）`
          : "AI 校对完成，未发现明显识别错误。"
      );
    } catch (error) {
      setVoiceprintMessage(`AI 校对失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCorrectingTranscript(false);
    }
  };

  /** 局部重识别单个段落（只裁剪该段对应归档音频，不重跑整场）。 */
  const retranscribeSegment = async (segmentId: string) => {
    if (retranscribingSegmentId || stage === "live" || importActive) return;
    setRetranscribingSegmentId(segmentId);
    setVoiceprintMessage("");
    try {
      const result = await api.transcription.retranscribeSegment({ meetingId: meeting.id, segmentId });
      onChange(result.meeting);
      setVoiceprintMessage("已完成该段落的局部重识别。");
    } catch (error) {
      setVoiceprintMessage(`局部重识别失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRetranscribingSegmentId(null);
    }
  };

  /** 将校对或重识别后的段落一键恢复为原始 ASR 文本。 */
  const restoreRawSegmentText = (segmentId: string) => {
    setUndoState(null);
    onChange({
      ...meeting,
      transcript: meeting.transcript.map((item) =>
        item.id === segmentId && item.rawText != null
          ? { ...item, text: item.rawText, rawText: undefined, corrected: false }
          : item),
      summary: { ...meeting.summary, stale: true }
    });
    setExpandedRawIds((previous) => {
      const next = new Set(previous);
      next.delete(segmentId);
      return next;
    });
  };

  const toggleRawPreview = (segmentId: string) => {
    setExpandedRawIds((previous) => {
      const next = new Set(previous);
      if (next.has(segmentId)) next.delete(segmentId);
      else next.add(segmentId);
      return next;
    });
  };

  const speakerButton = (speakers.length > 0 || voiceprints.length > 0) && (
    <button className="text-button transcript-speakers" aria-expanded={managerOpen} aria-controls={managerOpen ? "transcript-speaker-manager" : undefined} onClick={() => setManagerOpen((value) => !value)}>
      <Users size={16} />发言人
    </button>
  );

  const canRunPostActions = stage !== "live" && !importActive && meeting.transcript.some((seg) => seg.status !== "provisional" && seg.text.trim());

  const transcriptToolbar = (
    <div className="transcript-toolbar">
      {speakerButton}
      {canRunPostActions && (
        <button
          type="button"
          className={`text-button transcript-correct-trigger ${correctingTranscript ? "is-busy" : ""}`}
          disabled={correctingTranscript}
          title="结合热词与上下文修复同音错别字和专业术语（保留原稿可恢复）"
          onClick={() => void runTranscriptCorrection()}
        >
          <MagicWand size={15} />{correctingTranscript ? "校对中…" : "AI 校对"}
        </button>
      )}
      <button
        ref={searchTriggerRef}
        type="button"
        className={`text-button transcript-search-trigger ${searchOpen ? "is-active" : ""}`}
        aria-expanded={searchOpen}
        aria-controls="transcript-search-bar"
        title={`在逐字稿中查找（${shortcutLabel("F")}）`}
        onClick={() => {
          if (searchOpen) {
            closeSearch();
            return;
          }
          setSearchOpen(true);
          window.setTimeout(() => searchInputRef.current?.focus(), 0);
        }}
      >
        <MagnifyingGlass size={15} />查找<kbd>{shortcutLabel("F")}</kbd>
      </button>
      {lowConfidenceCount > 0 && (
        <button
          type="button"
          className={`text-button transcript-review-filter ${onlyLowConfidence ? "is-active" : ""}`}
          aria-pressed={onlyLowConfidence}
          title="只看引擎把握较低的片段，集中对照录音复核"
          onClick={() => setOnlyLowConfidence((value) => !value)}
        >
          <WarningCircle size={15} />存疑 {lowConfidenceCount}
        </button>
      )}
    </div>
  );

  const summaryInSidePanel = splitWorkspace && importJob?.status === "summarizing";
  const transcriptStatus = stage === "live"
    ? { label: "实时接收", tone: "live" }
    : !summaryInSidePanel && isActiveImportJob(importJob)
      ? { label: "后台处理中", tone: "active" }
      : importJob?.transcriptionGaps?.length
        ? { label: "有漏段", tone: "idle" }
        : importJob?.transcriptionNoSpeech
          ? { label: "无语音", tone: "idle" }
          : meeting.transcript.length || (importJob && importJob.status !== "complete")
            ? null
            : { label: "等待内容", tone: "idle" };
  const transcriptSubtitle = meeting.transcript.length
    ? `${meeting.transcript.length} 段内容${speakersUnassigned
      ? importJob?.diarizationOutcome === "pending" && isActiveImportJob(importJob) ? " · 正在分离发言人" : " · 未分离发言人"
      : speakers.length ? ` · ${speakers.length} 位发言人` : ""}`
    : "语音与录音时间轴自动同步";

  return (
    <>
      <header className={`transcript-header ${splitWorkspace ? "live-transcript-header transcript-header--live" : ""}`}>
        <div className="transcript-header__identity">
          <span className="transcript-header__symbol" aria-hidden="true">
            <Waveform size={22} weight="duotone" />
          </span>
          <div className="transcript-header__copy">
            <div className="transcript-header__title-row">
              <h2 id={splitWorkspace ? "live-transcript-title" : undefined}>{stage === "live" ? "实时转写" : splitWorkspace ? "转写" : "会议转写"}</h2>
              {transcriptStatus && <span className={`transcript-header__status is-${transcriptStatus.tone}`}>
                <i aria-hidden="true" />{transcriptStatus.label}
              </span>}
            </div>
            <p>{transcriptSubtitle}</p>
          </div>
        </div>
        {transcriptToolbar}
      </header>
      {searchOpen && (
        <div className="transcript-search" id="transcript-search-bar" role="search">
          <div className="transcript-search__row">
            <MagnifyingGlass size={15} />
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              aria-label="在逐字稿中查找"
              placeholder="在逐字稿中查找…"
              onChange={(event) => { setQuery(event.target.value); setActiveMatch(0); setReplaceNotice(""); }}
            />
            <select
              value={speakerFilter}
              aria-label="按发言人筛选"
              onChange={(event) => { setSpeakerFilter(event.target.value); setActiveMatch(0); }}
            >
              <option value="">全部发言人</option>
              {speakers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <span className="transcript-search__count" role="status">
              {normalizedQuery
                ? searchMatches.length ? `${activeMatch + 1} / ${searchMatches.length}` : "无匹配"
                : `${filteredTranscript.length} 段`}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="上一个匹配"
              title="上一个匹配（Shift + 回车）"
              disabled={!searchMatches.length}
              onClick={() => jumpToMatch(activeMatch - 1)}
            ><CaretUp size={15} weight="bold" /></button>
            <button
              type="button"
              className="icon-button"
              aria-label="下一个匹配"
              title="下一个匹配（回车）"
              disabled={!searchMatches.length}
              onClick={() => jumpToMatch(activeMatch + 1)}
            ><CaretDown size={15} weight="bold" /></button>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭查找"
              onClick={closeSearch}
            ><X size={15} /></button>
          </div>
          <div className="transcript-search__row transcript-search__replace">
            <Swap size={15} aria-hidden="true" />
            <input
              type="text"
              value={replaceText}
              aria-label="替换为"
              placeholder="替换为…"
              onChange={(event) => { setReplaceText(event.target.value); setReplaceNotice(""); }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (event.metaKey || event.ctrlKey) void replaceAllMatches();
                else replaceCurrentMatch();
              }}
            />
            <button
              type="button"
              className="text-button transcript-replace__action"
              disabled={!searchMatches.length}
              title="替换当前定位到的一处"
              onClick={replaceCurrentMatch}
            >替换</button>
            <button
              type="button"
              className="text-button transcript-replace__action"
              disabled={!replacePreview.occurrences}
              title={replacePreview.occurrences
                ? `在 ${replacePreview.segments} 个段落中替换 ${replacePreview.occurrences} 处（⌘/Ctrl + 回车）`
                : "当前没有可替换的命中"}
              onClick={() => void replaceAllMatches()}
            >
              全部替换{replacePreview.occurrences ? `（${replacePreview.occurrences}）` : ""}
            </button>
            {undoState && (
              <button
                type="button"
                className="text-button transcript-replace__undo"
                title={`撤销上次替换（${undoState.occurrences} 处）`}
                onClick={undoReplacement}
              ><ArrowUUpLeft size={14} />撤销</button>
            )}
            <span className="transcript-search__notice" role="status">{replaceNotice}</span>
          </div>
        </div>
      )}
      {managerOpen && (
        <section className="speaker-manager" id="transcript-speaker-manager" aria-label="发言人管理">
          <header>
            <div>
              <strong>发言人管理</strong>
            </div>
            <button className="icon-button" onClick={() => setManagerOpen(false)} aria-label="关闭发言人管理">
              <X size={15} />
            </button>
          </header>
          <div className="speaker-manager__names">
            {speakers.map(([id, name]) => (
              <label key={id}>
                <span className={`speaker-dot speaker-dot--${speakerColor(id)}`} />
                <input
                  aria-label={`重命名 ${name}`}
                  defaultValue={name}
                  disabled={learningSpeakerId === id}
                  // 与气泡改名保持一致：Enter 立即应用（另保留失焦提交通道）。
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    const next = event.currentTarget.value.trim();
                    if (next && next !== name) {
                      event.currentTarget.dataset.committed = "true";
                      renameSpeaker(id, next);
                    }
                    event.currentTarget.blur();
                  }}
                  onBlur={(event) => {
                    if (event.currentTarget.dataset.committed === "true") {
                      delete event.currentTarget.dataset.committed;
                      return;
                    }
                    const next = event.currentTarget.value.trim();
                    if (next && next !== name) renameSpeaker(id, next);
                  }}
                />
              </label>
            ))}
          </div>
          {speakers.length > 1 && (
            <div className="speaker-manager__merge">
              <select value={mergeSource} onChange={(event) => setMergeSource(event.target.value)}>
                <option value="">选择待合并标签</option>
                {speakers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
              <span>合并到</span>
              <select value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)}>
                <option value="">选择目标发言人</option>
                {speakers.filter(([id]) => id !== mergeSource).map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
              </select>
              <button
                className="button button--secondary button--small"
                disabled={!mergeSource || !mergeTarget}
                onClick={mergeSpeakers}
              >
                合并
              </button>
            </div>
          )}
          <div className="voiceprint-book">
            <div className="voiceprint-book__title">
              <FingerprintSimple size={15} weight="duotone" />
              <span>本地声纹簿</span>
              <small>{voiceprints.length ? `${voiceprints.length} 人` : "尚未学习"}</small>
            </div>
            {voiceprints.length > 0 && (
              <div className="voiceprint-book__people">
                {voiceprints.map((person) => (
                  <span key={person.name}>
                    {person.name}<small>{person.sampleCount} 份</small>
                    <button
                      type="button"
                      aria-label={`忘记 ${person.name} 的声纹`}
                      title="只删除本地声纹，不修改历史会议"
                      onClick={() => void forgetVoiceprint(person.name)}
                    >
                      <Trash size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
      {voiceprintMessage && <p className="voiceprint-message" aria-live="polite">{voiceprintMessage}</p>}
      {transcriptionFailure && (
        <section className="transcription-failure content-status-enter" role="alert">
          <span className="transcription-failure__icon"><WarningCircle size={19} weight="fill" /></span>
          <div className="transcription-failure__body">
            <strong>{transcriptionIsLocal ? "本地转写暂时没有结果" : "在线转写暂时不可用"}</strong>
            <p>
              {transcriptionIsLocal
                ? "本机模型可能尚未下载完成或正在加载。"
                : "网络、密钥或服务额度可能有问题。"}
              连续 {transcriptionFailure.consecutive} 次转写没有结果，录音和音频存档不受影响。
              {!transcriptionIsLocal && stage === "live" ? "改用本地 Whisper 会从下一段起生效。" : ""}
            </p>
            {transcriptionFailure.message && (
              <small title={transcriptionFailure.message}>{transcriptionFailure.message}</small>
            )}
            <div className="transcription-failure__actions">
              <button type="button" className="button button--small button--primary" onClick={onUseLocalWhisper}>
                {transcriptionIsLocal ? "检查本地 Whisper" : "改用本地 Whisper"}
              </button>
              <button type="button" className="button button--small" onClick={onChooseTranscriptionService}>
                {transcriptionIsLocal ? "改用在线服务" : "更换转写服务"}
              </button>
              <button type="button" className="text-button" onClick={onDismissTranscriptionFailure}>暂时忽略</button>
            </div>
          </div>
          <button type="button" className="icon-button transcription-failure__dismiss" aria-label="关闭转写失败提示" onClick={onDismissTranscriptionFailure}>
            <X size={15} />
          </button>
        </section>
      )}
      {importJob && !summaryInSidePanel && (isActiveImportJob(importJob) || isRetryableImportJob(importJob) || [
        "failed", "cancelled", "waiting_for_network", "waiting_for_model",
        "waiting_for_summary_model", "waiting_for_audio_tool"
      ].includes(importJob.status)) && (
        <section
          className={`transcript-import-status transcript-import-status--${importJob.status} content-status-enter`}
          aria-live="polite"
        >
          <div className="transcript-import-status__head">
            <strong>
              {describeImportProcessing(importJob) ?? `${importJob.transcriptionGaps?.length ?? 0} 段待补转`}
            </strong>
            <div className="transcript-import-status__actions">
              {isRetryableImportJob(importJob) && onRetryImport && !canRetryTranscriptionGaps(importJob) && (
                <button type="button" className="text-button" onClick={() => onRetryImport(importJob.id)}>
                  <ArrowClockwise size={13} />
                  {importJob.status === "waiting_for_network" ? "立即重试" : "重试"}
                </button>
              )}
              {["waiting_for_model", "waiting_for_summary_model"].includes(importJob.status)
                && onConfigureTranscription && (
                  <button type="button" className="text-button" onClick={onConfigureTranscription}>配置模型</button>
                )}
              {importJob.status === "diarizing" && onSkipDiarization && (
                <button type="button" className="text-button" onClick={() => onSkipDiarization(importJob.id)}>
                  跳过识别，生成纪要
                </button>
              )}
              {isActiveImportJob(importJob) && onCancelImport && (
                <button
                  type="button"
                  className="text-button"
                  title="暂停后可随时继续，已完成的转写不会丢失"
                  onClick={() => onCancelImport(importJob.id)}
                >
                  <X size={13} />暂停处理
                </button>
              )}
            </div>
          </div>
          <ImportProcessingMeta job={importJob} compact />
          {canRetryTranscriptionGaps(importJob) && isRetryableImportJob(importJob) && (
            <TranscriptionGapRetry
              key={`${importJob.id}:${importJob.sttProfileId ?? ""}`}
              job={importJob}
              profiles={sttProfiles}
              onRetry={onRetryImport}
              onSeek={onSeek}
            />
          )}
        </section>
      )}
      <div
        className="transcript-list"
        id="transcript-content"
        role={splitWorkspace ? "region" : undefined}
        aria-labelledby={splitWorkspace ? "live-transcript-title" : undefined}
        ref={listRef}
        onScroll={handleTranscriptScroll}
      >
        {!splitWorkspace && <TranscriptOverview
          key={meeting.id}
          summary={meeting.summary}
          busy={summaryBusy}
        />}
        {filteredTranscript.length > visibleCount && (
          <button className="load-earlier" onClick={() => setVisibleCount((value) => value + 200)}>
            加载更早的 {Math.min(200, filteredTranscript.length - visibleCount)} 条
          </button>
        )}
        {visibleSegments.length ? visibleSegments.map((segment, index) => {
          const enteringIndex = enteringSequence.get(segment.id) ?? -1;
          const previous = visibleSegments[index - 1];
          const continuation = previous?.speakerId === segment.speakerId && segment.startMs - previous.endMs < 1500;
          const segmentSpeakerColor = speakerColor(segment.speakerId);
          const speakerUnassigned = speakersUnassigned && segment.speakerId === "speaker-1" && segment.speakerName === "发言人1";
          const isStreamingSegment = streamingSegmentId === segment.id && editingSegmentId !== segment.id;
          return (
            // is-playing：当前播放位置命中的段落整行高亮；data-segment-id 供回放跟随定位。
            <article
              className={`transcript-item transcript-item--${segment.status} transcript-item--speaker-${segmentSpeakerColor} ${continuation ? "is-continuation" : ""} ${playingSegment?.id === segment.id ? "is-playing" : ""} ${isStreamingSegment ? "is-streaming" : ""} ${jumpHighlightId === segment.id ? "is-jump-highlight" : ""} ${searchFocusId === segment.id ? "is-search-hit" : ""} ${enteringIndex >= 0 ? "content-motion-enter" : ""}`}
              data-segment-id={segment.id}
              key={segment.id}
              style={enteringIndex >= 0 ? { animationDelay: `${Math.min(enteringIndex, 2) * 40}ms` } : undefined}
            >
            <div className="transcript-item__meta">
              {speakerUnassigned ? (
                <span className="speaker-name">未分离</span>
              ) : segment.speakerId.startsWith("pending-speaker-") ? (
                <span className={`speaker-name speaker-name--${segmentSpeakerColor}`} title="同一人可能暂时有多个编号，识别结束后统一校准">
                  {segment.speakerName} · 待校准
                </span>
              ) : <button className={`speaker-name speaker-name--${segmentSpeakerColor}`} onClick={() => openSpeakerEditor(segment.speakerId)}>
                <span className="transcript-speaker-avatar" aria-hidden="true">{segment.speakerName.trim().charAt(0) || "人"}</span>
                <span>{segment.speakerName}</span>
                {voiceprints.some((person) => person.name === segment.speakerName) && (
                  <FingerprintSimple size={11} weight="fill" aria-label="已保存在本地声纹簿" />
                )}
              </button>}
              <button className="transcript-time" aria-label={`定位到 ${formatTranscriptTime(segment.startMs)}`} onClick={() => onSeek?.(segment.startMs)}>{formatTranscriptTime(segment.startMs)}</button>
              {playbackPlaying && playingSegment?.id === segment.id && (
                <span className="transcript-playing" aria-label="正在播放当前段落">
                  <span className="transcript-playing__bars" aria-hidden="true"><i /><i /><i /></span>
                  正在播放
                </span>
              )}
              {isLowConfidence(segment.confidence) && (
                <button
                  type="button"
                  className="confidence-flag"
                  title="引擎对这段的识别把握较低，点击编辑或使用右侧重识别按钮复核"
                  onClick={() => setEditingSegmentId(segment.id)}
                >
                  <WarningCircle size={12} />可能不准
                </button>
              )}
              {segment.corrected && segment.rawText && segment.rawText !== segment.text && (
                <button
                  type="button"
                  className={`transcript-corrected-pill ${expandedRawIds.has(segment.id) ? "is-open" : ""}`}
                  aria-expanded={expandedRawIds.has(segment.id)}
                  title="点击对照或恢复原始识别文本"
                  onClick={() => toggleRawPreview(segment.id)}
                >
                  已校对
                </button>
              )}
            </div>
            <div className="transcript-bubble">
            <div className="transcript-bubble__content">
              {editingSegmentId === segment.id ? (
                <textarea
                  autoFocus
                  className="transcript-editor"
                  value={segment.text}
                  rows={Math.max(2, Math.ceil(segment.text.length / 24))}
                  onChange={(event) => updateSegmentText(segment.id, event.target.value)}
                  onBlur={() => setEditingSegmentId(null)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditingSegmentId(null);
                    }
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault();
                      setEditingSegmentId(null);
                    }
                  }}
                />
              ) : normalizedQuery ? (
                <p className="transcript-copy"><HighlightedTranscriptCopy text={segment.text} query={normalizedQuery} /></p>
              ) : (
                <AnimatedTranscriptCopy
                  text={segment.text}
                  animate={!enteringSegmentIds.has(segment.id)}
                  streaming={isStreamingSegment}
                />
              )}
              <ProvisionalBadge visible={segment.status === "provisional"} />
              {expandedRawIds.has(segment.id) && segment.rawText && (
                <div className="transcript-raw-preview">
                  <span>原稿：{segment.rawText}</span>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => restoreRawSegmentText(segment.id)}
                  >
                    <ArrowUUpLeft size={12} />恢复原稿
                  </button>
                </div>
              )}
              {!normalizedQuery && editingSegmentId !== segment.id && (suggestionsBySegment.get(segment.id)?.length ?? 0) > 0 && (
                <div className="glossary-suggestions" aria-label="术语纠错建议">
                  {suggestionsBySegment.get(segment.id)!.map((suggestion) => (
                    <span className="glossary-suggestion" key={suggestion.id}>
                      <span className="glossary-suggestion__text">
                        「{suggestion.original}」可能应为 <strong>{suggestion.replacement}</strong>
                      </span>
                      <button
                        type="button"
                        className="glossary-suggestion__apply"
                        title="用术语表中的写法替换这一处，不会改动其他文字"
                        onClick={() => {
                          const source = fullTextById.get(segment.id) ?? segment.text;
                          updateSegmentText(segment.id, applyGlossarySuggestion(source, suggestion));
                        }}
                      >应用</button>
                      <button
                        type="button"
                        className="glossary-suggestion__ignore"
                        aria-label="忽略这条建议"
                        title="忽略这条建议"
                        onClick={() => setDismissedSuggestions((previous) => new Set(previous).add(`${segment.id}:${suggestion.id}`))}
                      ><X size={12} /></button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="transcript-item__actions">
              {segment.status !== "provisional" && stage !== "live" && !importActive && (
                <button
                  type="button"
                  className={`transcript-edit transcript-retranscribe ${retranscribingSegmentId === segment.id ? "is-busy" : ""}`}
                  aria-label={`局部重识别 ${formatTranscriptTime(segment.startMs)} 的转写`}
                  title="仅重识别这一段音频"
                  disabled={Boolean(retranscribingSegmentId)}
                  onClick={() => void retranscribeSegment(segment.id)}
                >
                  <ArrowClockwise size={14} />
                </button>
              )}
              {segment.status !== "provisional" && (
                <button
                  className="transcript-edit"
                  aria-label={`编辑 ${formatTranscriptTime(segment.startMs)} 的转写`}
                  onClick={() => setEditingSegmentId(segment.id)}
                >
                  <PencilSimple size={14} />
                </button>
              )}
            </div>
            </div>
            </article>
          );
        }) : (
          <div className="panel-empty transcript-empty">
            <div className="transcript-empty__visual" aria-hidden="true">
              <Waveform size={28} weight="duotone" />
              <span className="transcript-empty__signal"><i /><i /><i /><i /></span>
            </div>
            {meeting.transcript.length > 0 && (speakerFilter || normalizedQuery || onlyLowConfidence) ? (
              <>
                <strong>没有匹配的内容</strong>
                <p>没有符合当前查找或筛选条件的段落。</p>
                <button
                  className="button button--secondary button--small"
                  onClick={() => { setQuery(""); setSpeakerFilter(""); setSearchFocusId(null); setOnlyLowConfidence(false); }}
                >清除查找与筛选</button>
              </>
            ) : (
              <>
                <strong>{stage === "live" ? "正在聆听，文字即将出现" : "暂无转写内容"}</strong>
                <p>{importJob
                  ? importTranscriptStatus(importJob)
                  : stage === "review"
                    ? "这场会议没有逐字稿；笔记与纪要仍保留。"
                    : "等待转写…"}</p>
                {!importJob && stage === "review" && emptyActionLabel && onEmptyAction && (
                  <button className="button button--secondary button--small" onClick={onEmptyAction}>
                    {emptyActionLabel}
                  </button>
                )}
                {!importJob && stage === "review" && onRetranscribe && (
                  <button
                    className="button button--secondary button--small"
                    title="用已归档的录音重新转录这场会议；笔记与手动锁定的纪要内容会保留"
                    onClick={onRetranscribe}
                  >
                    <ArrowClockwise size={15} />从录音重新转录
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {filteredTranscript.length > 0 && (!autoScroll || stage === "live" || importActive || playingSegment) && <button
        className={`follow-control ${autoScroll ? "is-active" : ""}`}
        aria-pressed={autoScroll}
        onClick={() => {
          const list = listRef.current;
          if (!list) return;
          setAutoScroll(true);
          const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" as const : "smooth" as const;
          const el = playingSegment ? list.querySelector<HTMLElement>(`[data-segment-id="${playingSegment.id}"]`) : null;
          followGuardUntil.current = performance.now() + 450;
          if (el) {
            const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top;
            list.scrollTo({ top: Math.max(0, list.scrollTop + top - list.clientHeight / 3), behavior });
          } else {
            list.scrollTo({ top: list.scrollHeight, behavior });
          }
        }}
      >
        {autoScroll ? <CheckCircle size={14} weight="fill" /> : <ArrowDown size={14} weight="bold" />}
        {autoScroll ? (playingSegment ? "跟随回放" : "正在跟随") : "恢复跟随"}
      </button>}

      {speakerEditor && (
        <div className="speaker-popover">
          <PencilSimple size={16} />
          <input
            className="speaker-popover__input"
            autoFocus
            defaultValue={speakers.find(([id]) => id === speakerEditor)?.[1] ?? ""}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                renameSpeaker(
                  speakerEditor,
                  event.currentTarget.value.trim() || "未命名发言人",
                  rememberVoice
                );
              }
              if (event.key === "Escape") setSpeakerEditor(null);
            }}
          />
          <small>回车应用到该发言人的全部片段</small>
          <label className="speaker-popover__remember">
            <input
              type="checkbox"
              checked={rememberVoice}
              onChange={(event) => setRememberVoice(event.target.checked)}
            />
            <span>
              让本机记住这个声音，下次自动命名
              <small>声纹只保存在这台设备，可随时在发言人管理里删除。</small>
            </span>
          </label>
        </div>
      )}
      <ConfirmDialog open={confirmDialog.open} request={confirmDialog.request} onSettle={confirmDialog.settle} />
    </>
  );
}

/** 概览只摘录已有纪要，不改写原文，也不会因打开转写页触发模型请求。 */
function TranscriptOverview({ summary, busy }: {
  summary: Meeting["summary"];
  busy?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const points = summary.overview ? [summary.overview] : summary.keyPoints.filter((point) => point.trim());
  const text = points.join("\n");
  useEffect(() => { setCopyState("idle"); }, [text]);

  if (!points.length && !busy) return null;

  return (
    <section className={`transcript-overview ${summary.stale ? "is-stale" : ""}`} aria-label="纪要概览">
      <header>
        <h2><MagicWand size={16} weight="duotone" aria-hidden="true" />纪要概览</h2>
        <div className="transcript-overview__actions">

          {points.length > 0 && <button className="icon-button" title="复制概览" aria-label="复制纪要概览" onClick={async () => {
            try { await navigator.clipboard.writeText(text); setCopyState("copied"); }
            catch { setCopyState("failed"); }
          }}>{copyState === "copied" ? <Check size={17} /> : <Copy size={17} />}</button>}
        </div>
      </header>
      {points.length ? <>
        <p>{points.slice(0, 2).join(" ")}</p>
        {points.length > 2 && <>
          <div className={`transcript-overview__expansion ${expanded ? "is-expanded" : ""}`} inert={!expanded}>
            <div id="transcript-overview-more"><p>{points.slice(2).join(" ")}</p></div>
          </div>
          <button className="transcript-overview__toggle" aria-expanded={expanded} aria-controls="transcript-overview-more" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "收起概览" : "展开概览"}<CaretDown size={13} />
          </button>
        </>}
      </> : null}
      {(busy || summary.stale || copyState !== "idle") && (
        <footer>
          {busy && <span>正在更新…</span>}
          {summary.stale && !busy && <span className="transcript-overview__stale">有新内容 · 待更新</span>}
          <span role="status">{copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败，请重试" : ""}</span>
        </footer>
      )}
    </section>
  );
}

/** 「临时转写中…」定稿时保留 140ms 播放与入场对称的淡出，避免瞬间消失。 */
function ProvisionalBadge({ visible }: { visible: boolean }) {
  const { mounted, closing } = useExitPresence(visible, 140);
  if (!mounted) return null;
  return (
    <span className={`provisional content-status-enter${closing ? " is-closing" : ""}`}>
      临时转写中
      <span className="provisional__dots" aria-hidden="true"><i /><i /><i /></span>
    </span>
  );
}

/** 同一自然段续写时只让新增尾文轻淡入；正在流式揭示的段落末尾附带柔和光标。 */
function AnimatedTranscriptCopy({ text, animate, streaming = false }: { text: string; animate: boolean; streaming?: boolean }) {
  const previousRef = useRef(text);
  const change = animate
    ? classifyTextChange(previousRef.current, text)
    : { kind: "unchanged" as const, prefix: text, suffix: "" };
  useEffect(() => { previousRef.current = text; }, [text]);

  const caret = streaming ? <span className="transcript-streaming-caret" aria-hidden="true" /> : null;
  if (change.kind === "appended") {
    return (
      <p className={`transcript-copy ${streaming ? "is-streaming" : ""}`}>
        {change.prefix}<span className="transcript-copy__tail" key={text.length}>{change.suffix}</span>{caret}
      </p>
    );
  }
  return <p className={`transcript-copy ${change.kind === "updated" ? "content-motion-update" : ""} ${streaming ? "is-streaming" : ""}`}>{text}{caret}</p>;
}

/** 文内查找命中片段：用 <mark> 逐段包裹，不改变原文、不影响编辑入口。 */
function HighlightedTranscriptCopy({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let found = lower.indexOf(query);
  while (found >= 0) {
    if (found > cursor) parts.push(text.slice(cursor, found));
    parts.push(<mark className="transcript-hit" key={`hit-${found}`}>{text.slice(found, found + query.length)}</mark>);
    cursor = found + query.length;
    found = lower.indexOf(query, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/** 导入任务阶段 → 即时状态；已有文本时仍保留状态行，不替换转写内容。 */
function TranscriptionGapRetry({ job, profiles, onRetry, onSeek }: {
  job: ImportJob;
  profiles: ModelProfile[];
  onRetry?: TranscriptViewProps["onRetryImport"];
  onSeek?: TranscriptViewProps["onSeek"];
}) {
  const [profileId, setProfileId] = useState("");
  return (
    <details className="transcript-gap-retry">
      <summary>查看待补转时段</summary>
      <ul>
        {job.transcriptionGaps?.map(({ startMs, endMs }, index) => {
          const timeRange = `${formatTranscriptTime(startMs)} – ${formatTranscriptTime(endMs)}`;
          return <li key={`${startMs}:${endMs}:${index}`}>{onSeek
            ? <button type="button" className="text-button" onClick={() => onSeek(startMs)}>{timeRange}</button>
            : timeRange}</li>;
        })}
      </ul>
      {onRetry && <div className="transcript-import-status__actions">
        {profiles.some((profile) => profile.id) && (
          <select aria-label="补转模型" value={profileId} onChange={(event) => setProfileId(event.target.value)}>
            <option value="">{profiles.find((profile) => profile.id === job.sttProfileId)?.name ?? "当前默认模型"}</option>
            {profiles.filter((profile) => profile.id && profile.id !== job.sttProfileId).map((profile) => (
              <option value={profile.id} key={profile.id}>{profile.name}</option>
            ))}
          </select>
        )}
        <button type="button" className="text-button" onClick={() => onRetry(job.id, profileId || undefined)}>
          <ArrowClockwise size={13} />补转漏段
        </button>
      </div>}
    </details>
  );
}

function importTranscriptStatus(job: ImportJob) {
  if (job.transcriptionNoSpeech) return "这段录音没有检测到语音。";
  if (job.status === "queued" && job.stage === "copying") return "等待归档录音…";
  if (job.status === "copying" || job.stage === "copying") return "正在归档录音…";
  if (job.status === "preparing" || job.stage === "preparing") return "正在准备音频…";
  if (job.status === "waiting_for_model") return "等待配置转录模型，录音已安全归档。";
  if (job.status === "waiting_for_summary_model") return "等待配置总结模型。";
  if (job.status === "waiting_for_audio_tool") return "音频组件需要恢复后才能继续转录。";
  if (job.status === "waiting_for_network") {
    return "转录服务暂时不可达，稍后将自动从断点继续。";
  }
  if (job.status === "failed") return `转录暂停：${job.error || "处理失败"}`;
  if (job.status === "cancelled") return "处理已暂停，已有转录仍会保留，可随时继续未完成的阶段。";
  if (job.status === "transcribing" || job.stage === "transcribing") {
    return job.totalChunks
      ? `正在转录第 ${Math.min((job.completedChunks || 0) + 1, job.totalChunks)}/${job.totalChunks} 段，约每 10 秒音频持续追加。`
      : "正在分析音频，首段文本很快会出现在这里。";
  }
  if (job.status === "diarizing") return "转录完成，正在识别不同发言人…";
  if (job.status === "summarizing") return "转录完成，正在整理会议纪要…";
  return "录音中没有识别到可显示的语音。";
}

/** 转写时间戳 → HH:MM:SS / MM:SS（相对录音起点，与播放器时间轴对齐）。 */
export function formatTranscriptTime(ms: number) {
  // Relative to recording start (00:00:00), with seconds. startMs is measured
  // from when recording began, so this aligns with the audio timeline.
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** 说话人配色：自己固定蓝色，其余按 id 哈希稳定分配橙/紫/绿（颜色即身份语义）。 */
function speakerColor(id: string) {
  if (id === "me") return "blue";
  const colors = ["orange", "purple", "green"];
  return colors[Math.abs(hash(id)) % colors.length];
}

/** 简单字符串哈希（用于稳定选色）。 */
function hash(value: string) {
  return Array.from(value).reduce((total, character) => total + character.charCodeAt(0), 0);
}
