import { describe, expect, it, vi } from "vitest";
import { extractMeetingHotwordPack, extractMeetingHotwords } from "../electron/services/hotwords.mjs";
import { detectHotwordDomains, formatGlossaryEntry, parseGlossaryEntry } from "../shared/hotword-domains.mjs";
import { normalizeGlossary } from "../electron/services/transcription-prompt.mjs";
import { findGlossarySuggestions } from "../src/lib/glossary-suggestions";
import { resolveImportedSummaryMerge } from "../src/lib/summary";
import {
  buildCorrectionWindows,
  correctTranscriptWithLLM,
  extractNegationSignature,
  extractNumericTokens,
  selectWindowAliasHints,
  validateCorrectionSafety
} from "../electron/services/transcript-correction.mjs";
import {
  applyVerificationPatch,
  detectMeetingType,
  regenerateSummarySectionWithLLM,
  runSummaryPipeline,
  segmentTranscriptSemantically
} from "../electron/services/summary-pipeline.mjs";
import { selectCoreClipText } from "../electron/services/segment-retranscribe.mjs";

describe("动态会议热词引擎 (hotwords.mjs)", () => {
  it("聚合全局术语、真实参会人、英文缩写、引号专名并过滤占位符与停用词", () => {
    const terms = extractMeetingHotwords({
      title: "Q3 WebRTC 弱网优化与「登录改版」评审",
      participants: ["我", "张伟（架构）", "李敏", "发言人1", "待识别"],
      goals: ["对齐 SDK 2.4 接入和 SLA 指标"],
      notes: ["排查 Kafka 消费延迟，确认《合规清单》"],
      globalGlossary: ["MinuteFlow", "Whisper"]
    });
    expect(terms.slice(0, 2)).toEqual(["MinuteFlow", "Whisper"]);
    expect(terms).toContain("张伟");
    expect(terms).toContain("李敏");
    expect(terms).toContain("WebRTC");
    expect(terms).toContain("登录改版");
    expect(terms).toContain("Kafka");
    expect(terms).toContain("合规清单");
    expect(terms).not.toContain("我");
    expect(terms).not.toContain("发言人1");
    expect(terms).not.toContain("待识别");
    expect(terms).not.toContain("评审");
  });

  it("按 maxCount 上限截断，防止注入过多热词导致识别偏置", () => {
    const terms = extractMeetingHotwords({
      globalGlossary: Array.from({ length: 40 }, (_, i) => `Term_${i + 1}`),
      maxCount: 12
    });
    expect(terms).toHaveLength(12);
    expect(terms[0]).toBe("Term_1");
  });

  it("按会议上下文自动激活内置领域热词库与同音别名，且不挤占用户自定义术语与参会人", () => {
    const domains = detectHotwordDomains({
      title: "RAG 检索与 Whisper 声纹识别技术架构评审",
      goals: ["排查缓存延迟和模型微调效果"]
    });
    expect(domains).toContain("ai");
    expect(domains).toContain("software");

    const pack = extractMeetingHotwordPack({
      title: "本地语音模型部署沟通",
      participants: ["周杰"],
      globalGlossary: ["内部项目X"],
      transcript: [{ status: "final", text: "今天测试了欧拉马和维斯珀，还排查了卡夫卡延迟。" }]
    });
    expect(pack.hotwords[0]).toBe("内部项目X");
    expect(pack.hotwords[1]).toBe("周杰");
    expect(pack.domains).toEqual(expect.arrayContaining(["ai", "software"]));
    const matchedAliases = pack.aliasHints.filter((a) => a.matchedInText);
    expect(matchedAliases).toEqual(expect.arrayContaining([
      expect.objectContaining({ alias: "欧拉马", canonical: "Ollama" }),
      expect.objectContaining({ alias: "维斯珀", canonical: "Whisper" }),
      expect.objectContaining({ alias: "卡夫卡", canonical: "Kafka" })
    ]));
  });

  it("语义纠错自动向模型注入当前滑窗命中的同音别名对照", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      corrections: [{ id: "s1", text: "我们在 Ollama 上跑了 Whisper 和 DeepSeek 的压测。" }]
    });
    const meeting = {
      title: "AI 本地推理压测",
      participants: ["王磊"],
      transcript: [
        { id: "s1", startMs: 0, endMs: 5000, speakerId: "sp1", speakerName: "王磊", status: "final", track: "mixed", text: "我们在欧拉马上跑了维斯珀和迪普西克的鸭测。" }
      ]
    };
    const result = await correctTranscriptWithLLM({ model: "llm" }, "key", meeting, { requestJson: mockRequest });
    expect(result.correctedCount).toBe(1);
    expect(result.domains).toContain("ai");
    const sentPrompt = mockRequest.mock.calls[0][2].userPrompt;
    expect(sentPrompt).toContain("欧拉马→Ollama");
    expect(sentPrompt).toContain("维斯珀→Whisper");
    expect(sentPrompt).toContain("迪普西克→DeepSeek");
    const prioritized = selectWindowAliasHints(meeting.transcript, [
      { alias: "无关词", canonical: "Other", matchedInText: false },
      { alias: "欧拉马", canonical: "Ollama", matchedInText: true }
    ], 1);
    expect(prioritized[0].canonical).toBe("Ollama");
  });

  it("自定义术语支持「标准词 = 常见误听」写法，同时作用于转写提示词、逐字稿一键建议与 AI 校对", () => {
    expect(parseGlossaryEntry("MinuteFlow = 密尼特弗洛、迷你特弗洛")).toEqual({
      term: "MinuteFlow",
      aliases: ["密尼特弗洛", "迷你特弗洛"]
    });
    expect(parseGlossaryEntry("密尼特弗洛 -> MinuteFlow")).toEqual({
      term: "MinuteFlow",
      aliases: ["密尼特弗洛"]
    });
    expect(formatGlossaryEntry({ term: "MinuteFlow", aliases: ["密尼特弗洛"] })).toBe("MinuteFlow = 密尼特弗洛");
    // Whisper prompt 只拿干净的标准术语，不把别名后缀带进提示词
    expect(normalizeGlossary(["MinuteFlow = 密尼特弗洛", "SKU"])).toEqual(["MinuteFlow", "SKU"]);
    // 逐字稿行内建议直接命中用户自定义误听别名
    const suggestions = findGlossarySuggestions("我们今天演示密尼特弗洛桌面版", ["MinuteFlow = 密尼特弗洛"]);
    expect(suggestions[0]).toMatchObject({ original: "密尼特弗洛", replacement: "MinuteFlow" });
    // 热词包把用户自定义别名排在最前供 LLM 校对使用
    const pack = extractMeetingHotwordPack({
      globalGlossary: ["MinuteFlow = 密尼特弗洛"],
      transcript: [{ status: "final", text: "演示密尼特弗洛新功能" }]
    });
    expect(pack.hotwords[0]).toBe("MinuteFlow");
    expect(pack.aliasHints[0]).toMatchObject({ alias: "密尼特弗洛", canonical: "MinuteFlow", matchedInText: true });
  });
});

describe("受控 LLM 语义纠错引擎 (transcript-correction.mjs)", () => {
  it("提取阿拉伯与中文数字记号及否定极性", () => {
    expect(extractNumericTokens("目标提升 12.5%，预计 3 天完成")).toEqual(["12.5%", "3天"]);
    expect(extractNumericTokens("三天内完成二十万回款")).toEqual(["3天", "200000"]);
    expect(extractNegationSignature("本期不上线该功能，且不得绕过审批")).toBe(2);
    expect(extractNegationSignature("本期上线该功能")).toBe(0);
  });

  it("安全护栏放行同音术语修正并拦截数值/否定/缩水改动", () => {
    expect(validateCorrectionSafety("我们用危波RTC和卡夫卡做同步", "我们用WebRTC和Kafka做同步")).toEqual({ accepted: true });
    expect(validateCorrectionSafety("转化率从 12% 提到 15%", "转化率从 12% 提到 25%")).toEqual({
      accepted: false,
      reason: "numeric_mismatch"
    });
    expect(validateCorrectionSafety("这个需求本期不做自动退款", "这个需求本期做自动退款")).toEqual({
      accepted: false,
      reason: "negation_flip"
    });
    expect(validateCorrectionSafety("华东区完成了 320 万，目标是 400 万，还差两个客户审批", "华东区差一点")).toEqual({
      accepted: false,
      reason: "length_drift"
    });
  });

  it("滑窗切分附带前序上下文且仅处理定稿段落", () => {
    const segments = Array.from({ length: 25 }, (_, i) => ({
      id: `s-${i + 1}`,
      startMs: i * 5000,
      endMs: i * 5000 + 4000,
      speakerId: "sp-1",
      speakerName: "张三",
      status: i === 24 ? "provisional" : "final",
      text: `第 ${i + 1} 段会议发言内容。`
    }));
    const windows = buildCorrectionWindows(segments, { maxSegments: 10, overlapSegments: 3 });
    expect(windows).toHaveLength(3);
    expect(windows[0].context).toHaveLength(0);
    expect(windows[0].target).toHaveLength(10);
    expect(windows[1].context).toHaveLength(3);
    expect(windows[1].context[0].id).toBe("s-8");
    expect(windows[2].target).toHaveLength(4); // 排除了 provisional
  });

  it("执行纠错时保留 rawText，并自动丢弃未通过安全护栏的修改", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      corrections: [
        { id: "s1", text: "今天先核对 WebRTC 和 Kafka 的延迟数据。" },
        { id: "s2", text: "本期上线退款自动化，预算 50 万。" } // 翻转否定 + 改数字，应被拒绝
      ]
    });
    const meeting = {
      title: "WebRTC 延迟同步",
      participants: ["张伟"],
      transcript: [
        { id: "s1", startMs: 0, endMs: 4000, speakerId: "sp1", speakerName: "张伟", status: "final", track: "mixed", confidence: 0.42, text: "今天先核对危波RTC和卡夫卡的延迟数据。" },
        { id: "s2", startMs: 4000, endMs: 9000, speakerId: "sp1", speakerName: "张伟", status: "final", track: "mixed", text: "本期不上线退款自动化，预算 30 万。" }
      ]
    };
    const result = await correctTranscriptWithLLM({ model: "test" }, "key", meeting, {
      requestJson: mockRequest
    });
    expect(result.correctedCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(result.llmCalls).toBe(1);
    expect(result.transcript[0].text).toBe("今天先核对 WebRTC 和 Kafka 的延迟数据。");
    expect(result.transcript[0].rawText).toBe("今天先核对危波RTC和卡夫卡的延迟数据。");
    expect(result.transcript[0].corrected).toBe(true);
    // s2 保持原文不变
    expect(result.transcript[1].text).toBe("本期不上线退款自动化，预算 30 万。");
    expect(result.transcript[1].corrected).toBeUndefined();
    // 确认低置信度标记被传给了提示词
    expect(mockRequest.mock.calls[0][2].userPrompt).toContain("[低置信]");
  });
});

describe("自适应多阶段纪要与事实核验流水线 (summary-pipeline.mjs)", () => {
  it("准确识别常见会议类型，且显式模板优先", () => {
    expect(detectMeetingType({ title: "Q3 支付网关架构与 API 延迟技术评审" }).typeId).toBe("tech_review");
    expect(detectMeetingType({ title: "华东区经营分析与营收毛利完成率" }).typeId).toBe("business_review");
    expect(detectMeetingType({ title: "线上事故复盘会", template: "retro" }).typeId).toBe("retro");
  });

  it("语义分章覆盖 100% 定稿段落并在话题切换与静音间隔处自然断开", () => {
    const transcript = Array.from({ length: 40 }, (_, i) => ({
      id: `seg-${i + 1}`,
      startMs: i * 20_000 + (i === 20 ? 12_000 : 0),
      endMs: i * 20_000 + 15_000,
      speakerId: i < 20 ? "sp1" : "sp2",
      speakerName: i < 20 ? "甲" : "乙",
      status: "final",
      track: "mixed",
      text: `${i === 20 ? "接下来我们换个话题，" : ""}这是第 ${i + 1} 段比较充实的业务汇报内容，用来测试语义分章在达到目标字数后选择最佳切分边界并且不会遗漏任何一条原始发言。`
    }));
    const chapters = segmentTranscriptSemantically(transcript, { targetChars: 900, maxChars: 1400, overlapSegments: 2 });
    expect(chapters.length).toBeGreaterThanOrEqual(2);
    const allIds = chapters.flatMap((ch) => ch.lines.map((l) => l.id));
    expect(allIds).toEqual(transcript.map((s) => s.id));
    expect(chapters[1].contextLines).toHaveLength(2);
  });

  it("applyVerificationPatch 定点移除误标决策、补未决问题并修正负责人", () => {
    const base = {
      overview: "原概览",
      topics: ["发布"],
      keyPoints: ["要点1"],
      decisions: ["确定周五全量发布", "可以考虑支持暗黑模式"],
      actionItems: [{ id: "a1", title: "输出压测报告", owner: "张伟", dueDate: "周五", status: "todo", done: false, evidenceSegmentIds: [] }],
      openQuestions: [],
      risks: [],
      nextSteps: []
    };
    const { summary, issuesFixed } = applyVerificationPatch(base, {
      issuesFound: 3,
      patch: {
        removeDecisionIndices: [1],
        addOpenQuestions: ["暗黑模式是否纳入本期范围待产品确认"],
        actionItemFixes: [{ index: 0, owner: "待确认" }]
      }
    });
    expect(issuesFixed).toBe(3);
    expect(summary.decisions).toEqual(["确定周五全量发布"]);
    expect(summary.openQuestions).toEqual(["暗黑模式是否纳入本期范围待产品确认"]);
    expect(summary.actionItems[0].owner).toBe("待确认");
  });

  it("长会议在 standard 模式下走分章提取 + 全局综合，high 模式额外执行独立核验", async () => {
    const longTranscript = Array.from({ length: 80 }, (_, i) => ({
      id: `seg-${i + 1}`,
      startMs: i * 15_000,
      endMs: i * 15_000 + 12_000,
      speakerId: `sp-${(i % 2) + 1}`,
      speakerName: i % 2 === 0 ? "张伟" : "李敏",
      status: "final",
      track: "mixed",
      text: `关于支付网关架构迁移的第 ${i + 1} 项数据讨论：当前接口延迟 180ms，目标优化到 90ms 以内，并确认在下周三前完成灰度发布与回滚预案演练。`
    }));

    const requestJson = vi.fn().mockImplementation(async (_profile, _key, opts) => {
      if (opts.label.includes("结构化提取")) {
        return {
          chapterTitle: "网关迁移进展",
          facts: [{ heading: "延迟指标", text: "当前 180ms 目标 90ms", evidenceSegmentId: "S1", evidenceTime: "00:00" }],
          metrics: [],
          confirmedDecisions: [{ text: "下周三前完成灰度发布", evidenceSegmentId: "S1" }],
          pendingSuggestions: [],
          actionItems: [{ title: "完成回滚预案演练", owner: "待确认", dueDate: "下周三前", evidenceSegmentIds: ["S1"] }],
          risks: [],
          openQuestions: []
        };
      }
      if (opts.label.includes("全局纪要综合")) {
        return {
          overview: "确认支付网关架构迁移目标为延迟降至 90ms 以内。",
          topics: ["网关迁移"],
          keyPoints: [{ text: "延迟优化｜接口延迟需从 180ms 降至 90ms 以内。", evidenceTime: "00:00" }],
          discussionSections: [
            { title: "网关迁移", points: [{ heading: "性能目标", text: "当前 180ms，目标 90ms 以内。", evidenceSegmentId: "S1" }] }
          ],
          decisions: ["下周三前完成灰度发布", "建议顺便升级日志框架"],
          actionItems: [{ id: "act-1", title: "完成回滚预案演练", owner: "张伟", dueDate: "下周三前", status: "todo", done: false, evidenceSegmentIds: ["S1"] }],
          openQuestions: [],
          risks: [],
          nextSteps: []
        };
      }
      // 事实核验阶段
      return {
        issuesFound: 2,
        unverifiedNotes: [],
        patch: {
          removeDecisionIndices: [1],
          addOpenQuestions: ["日志框架是否同步升级待确认"],
          actionItemFixes: [{ index: 0, owner: "待确认" }]
        }
      };
    });

    const summary = await runSummaryPipeline(
      { model: "main-llm" },
      "key",
      { title: "支付网关架构技术评审", participants: ["张伟", "李敏"], goals: [], notes: [], transcript: longTranscript },
      { final: true, qualityMode: "high", requestJson }
    );

    expect(summary.detectedMeetingType).toBe("技术研讨会");
    expect(summary.qualityMode).toBe("high");
    expect(summary.pipelineStats.stages).toEqual([
      "type_detect",
      "semantic_segment",
      "chapter_extract",
      "global_synthesis",
      "fact_verify"
    ]);
    expect(summary.verification?.verified).toBe(true);
    expect(summary.verification?.issuesFixed).toBe(3);
    expect(summary.decisions).toEqual(["下周三前完成灰度发布"]);
    expect(summary.actionItems[0].owner).toBe("待确认");
    expect(summary.actionItems[0].evidenceSegmentIds).toEqual(["seg-1"]);
    expect(summary.discussionSections?.[0].points[0].evidenceSegmentId).toBe("seg-1");
  });

  it("局部章节重生成只替换目标章节并还原证据段落 ID", async () => {
    const meeting = {
      title: "季度复盘",
      transcript: [
        { id: "seg-a", startMs: 1000, endMs: 5000, speakerId: "sp1", speakerName: "王强", status: "final", text: "华东区完成 320 万，目标 400 万。" },
        { id: "seg-b", startMs: 6000, endMs: 10000, speakerId: "sp2", speakerName: "赵敏", status: "final", text: "华南区完成 280 万，超额 10%。" }
      ],
      summary: {
        discussionSections: [
          { title: "区域业绩", points: [{ heading: "旧小结", text: "旧内容", evidenceSegmentId: "seg-a" }] }
        ]
      }
    };
    const requestJson = vi.fn().mockResolvedValue({
      title: "区域业绩对比",
      points: [
        { heading: "华东区", text: "完成 320 万，目标 400 万，存在 80 万缺口。", evidenceSegmentId: "S1" },
        { heading: "华南区", text: "完成 280 万，超额完成 10%。", evidenceSegmentId: "S2" }
      ],
      table: {
        columns: ["区域", "已完成", "目标/状态"],
        rows: [
          ["华东区", "320 万", "目标 400 万"],
          ["华南区", "280 万", "超额 10%"]
        ]
      }
    });
    const section = await regenerateSummarySectionWithLLM({ model: "llm" }, "key", {
      meeting,
      sectionIndex: 0,
      requestJson
    });
    expect(section.title).toBe("区域业绩对比");
    expect(section.points[0].evidenceSegmentId).toBe("seg-a");
    expect(section.points[1].evidenceSegmentId).toBe("seg-b");
    expect(section.table?.rows).toHaveLength(2);
  });
});

describe("局部单段重识别窗口裁剪选择 (segment-retranscribe.mjs)", () => {
  it("优先选取中心落在原段落核心时间窗内的片段文本", () => {
    const picked = selectCoreClipText({
      text: "前文尾音核心句子内容后文开头",
      segments: [
        { startMs: 0, endMs: 500, text: "前文尾音", confidence: 0.7 },
        { startMs: 850, endMs: 2600, text: "核心句子内容", confidence: 0.92 },
        { startMs: 3100, endMs: 3600, text: "后文开头", confidence: 0.8 }
      ]
    }, 800, 1900);
    expect(picked.text).toBe("核心句子内容");
    expect(picked.confidence).toBeCloseTo(0.92);
  });
});

describe("导入阶段性纪要合并保护 (meetingStore.ts)", () => {
  const emptySummary = {
    topics: [],
    keyPoints: [],
    decisions: [],
    actionItems: [],
    openQuestions: [],
    risks: [],
    nextSteps: [],
    stale: true
  };

  it("后台转写分块推送空纪要快照时，不覆盖内存里已生成的阶段性 AI 纪要", () => {
    const rolling = {
      ...emptySummary,
      overview: "已讨论接口延迟与灰度排期。",
      keyPoints: ["延迟优化｜目标降至 90ms 以内。"],
      generationMode: "online" as const,
      updatedAt: "2026-11-26T15:30:00.000Z",
      stale: false
    };
    const merged = resolveImportedSummaryMerge(rolling, emptySummary, false);
    expect(merged.overview).toBe("已讨论接口延迟与灰度排期。");
    expect(merged.keyPoints).toEqual(["延迟优化｜目标降至 90ms 以内。"]);
    expect(merged.stale).toBe(true);
  });

  it("后台完成终稿总结并推送更新后的纪要时，正常采纳终稿", () => {
    const rolling = {
      ...emptySummary,
      overview: "阶段性纪要",
      keyPoints: ["旧结论"],
      generationMode: "online" as const,
      updatedAt: "2026-11-26T15:30:00.000Z",
      stale: true
    };
    const finalIncoming = {
      ...emptySummary,
      overview: "完整终稿纪要",
      keyPoints: ["最终结论1", "最终结论2"],
      generationMode: "online" as const,
      updatedAt: "2026-11-26T15:32:00.000Z",
      stale: false
    };
    const merged = resolveImportedSummaryMerge(rolling, finalIncoming, false);
    expect(merged.overview).toBe("完整终稿纪要");
    expect(merged.keyPoints).toEqual(["最终结论1", "最终结论2"]);
    expect(merged.stale).toBe(false);
  });
});
