/**
 * 自适应多阶段 AI 会议纪要与事实核验流水线（服务层，纯函数 + 可注入 LLM 通道，易于单测）。
 *
 * 架构分层：
 * 1. 上下文装配与会议类型自动识别（detectMeetingType）：根据标题、目标、笔记和转写内容识别
 *    会议类型，动态调整关注点而不破坏既有纪要结构。
 * 2. 语义分章（segmentTranscriptSemantically）：替代粗暴截断，对长会议按静音间隔、话题切换
 *    提示词、发言人轮换做语义分章并保留跨章重叠上下文，实现 100% 原始转写覆盖。
 * 3. 分章并行结构化提取 + 全局综合（standard / high 模式，长会触发）：
 *    每章独立抽取事实、指标、已确认决策、待定建议、行动项与风险（携带 S# 证据编号），
 *    再由全局综合阶段按时间顺序消解结论演变，严禁将讨论建议误标为已拍板决定。
 * 4. 独立事实核验与定点修订（high 模式，有界 1 轮）：
 *    正向校验每条结论/决策/行动项是否有原文依据，反向检查是否漏掉明确决议/待办，
 *    通过 applyVerificationPatch 做定点增修并记录核验状态。
 * 5. 局部章节重生成（regenerateSummarySectionWithLLM）：针对单个 discussionSection 局部重写。
 */
import { randomUUID } from "node:crypto";
import {
  requestStructuredJson,
  summarizeWithOpenAICompatible,
  validateOnlineSummary
} from "./providers.mjs";
import { summaryTemplateById } from "../../shared/summary-templates.mjs";

const LONG_MEETING_CHAR_THRESHOLD = 4_500;
const CHAPTER_EXTRACTION_CONCURRENCY = 3;

const MEETING_TYPE_RULES = [
  {
    typeId: "business_review",
    label: "经营分析会",
    keywords: ["营收", "毛利", "完成率", "缺口", "预算", "KPI", "GMV", "转化率", "客单价", "利润", "业绩", "回款", "达成率", "环比", "同比", "各单位", "经营"],
    focusGuidance: "逐单位或逐业务线保留已完成值、目标值、预计值、缺口与统计口径；区分实际达成与预测预估。"
  },
  {
    typeId: "tech_review",
    label: "技术研讨会",
    keywords: ["架构", "接口", "API", "延迟", "QPS", "TPS", "部署", "数据库", "迁移", "重构", "性能", "并发", "缓存", "模型", "微服务", "算法", "压测", "方案评审", "SDK"],
    focusGuidance: "明确技术方案对比、选型理由、性能指标/约束边界、依赖接口与上线风险，区分已拍板架构和待验证方案。"
  },
  {
    typeId: "product_spec",
    label: "产品需求会",
    keywords: ["需求", "PRD", "交互", "原型", "埋点", "用户体验", "功能", "版本", "改版", "弹窗", "流程", "验收标准", "MVP", "排期"],
    focusGuidance: "突出需求范围、核心用户场景、不做的边界、交互/文案争议点及研发排期依赖。"
  },
  {
    typeId: "project_sync",
    label: "项目进度会",
    keywords: ["进度", "里程碑", "联调", "提测", "发布", "阻塞", "卡点", "上线", "周会", "站会", "同步", "延期", "排期", "交付"],
    focusGuidance: "按工作项清晰区分已完成、进行中、延期风险与阻塞卡点，行动项明确交付物、负责人与时间节点。"
  },
  {
    typeId: "retrospective",
    label: "项目复盘会",
    keywords: ["复盘", "事故", "根因", "故障", "教训", "改进措施", "反思", "回顾", "止损", "排查", "复现", "责任"],
    focusGuidance: "按时间线或维度区分直接现象、根本原因、已有止损措施与可落地的长期预防机制。"
  },
  {
    typeId: "interview",
    label: "访谈调研",
    keywords: ["访谈", "调研", "候选人", "面试", "受访者", "痛点", "使用习惯", "反馈", "用户说", "问卷", "体验"],
    focusGuidance: "保留核心观察、受访者原话支撑的痛点/诉求及待验证假设，不把个人观点包装成团队决策。"
  },
  {
    typeId: "customer_call",
    label: "客户交流会",
    keywords: ["客户", "报价", "合同", "POC", "签约", "商务", "交付", "售后", "试用", "采购", "招投标", "甲方"],
    focusGuidance: "梳理客户核心诉求、明确承诺边界、待内部评估的定制项、商务/交付节点与跟进责任人。"
  },
  {
    typeId: "deployment",
    label: "工作部署会",
    keywords: ["部署", "分工", "考核", "专项", "督办", "合规", "红线", "要求", "通报", "落实", "整改", "责任单位"],
    focusGuidance: "明确区分硬性合规要求、适用条件/例外与讨论建议，逐项列出牵头方、配合方与时间红线。"
  }
];

const TOPIC_SHIFT_PATTERN = /(?:接下来|下一个议题|下个议题|换个话题|下面讲|下面看|下面说|第二点|第三点|第四点|另外一个|还有一件事|进入下一|最后总结|总结一下|回到刚才)/;

function formatMs(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * 基于会议主题、目标、笔记与转写样本自动识别会议类型，返回聚焦指导。
 */
export function detectMeetingType({ title = "", goals = [], notes = [], transcript = [], template } = {}) {
  if (template && template !== "general") {
    const preset = summaryTemplateById(template);
    return {
      typeId: preset.id,
      label: preset.label,
      focusGuidance: preset.guidance
    };
  }
  const titleText = String(title || "").toLowerCase();
  const metaText = [...(Array.isArray(goals) ? goals : []), ...(Array.isArray(notes) ? notes : [])].join(" ").toLowerCase();
  const sampleTranscript = (Array.isArray(transcript) ? transcript : [])
    .filter((seg) => seg && seg.status !== "provisional" && typeof seg.text === "string")
    .slice(0, 80)
    .map((seg) => seg.text)
    .join(" ")
    .slice(0, 4_000)
    .toLowerCase();

  let best = null;
  for (const rule of MEETING_TYPE_RULES) {
    let score = 0;
    for (const rawKw of rule.keywords) {
      const kw = rawKw.toLowerCase();
      if (titleText.includes(kw)) score += 6;
      if (metaText.includes(kw)) score += 3;
      if (sampleTranscript.includes(kw)) score += 1.5;
    }
    if (score >= 4.5 && (!best || score > best.score)) {
      best = { ...rule, score };
    }
  }
  if (!best) {
    return {
      typeId: "general",
      label: "通用会议",
      focusGuidance: "突出核心结论、已确认决定、待澄清问题与明确行动项，避免复述过程性寒暄。"
    };
  }
  return {
    typeId: best.typeId,
    label: best.label,
    focusGuidance: best.focusGuidance
  };
}

/** 将转写列表标准化为带 S# 编号与时间戳的证据行（S# 与 providers.mjs 保持一致）。 */
export function buildIndexedTranscriptLines(transcript = []) {
  return (Array.isArray(transcript) ? transcript : []).flatMap((segment, index) => {
    if (!segment || typeof segment.text !== "string" || !segment.text.trim() || segment.status === "provisional") {
      return [];
    }
    const label = `S${index + 1}`;
    const time = formatMs(segment.startMs);
    return [{
      id: segment.id,
      label,
      time,
      timeMs: Number.isFinite(segment.startMs) ? segment.startMs : null,
      startMs: Number.isFinite(segment.startMs) ? segment.startMs : 0,
      endMs: Number.isFinite(segment.endMs) ? segment.endMs : (Number.isFinite(segment.startMs) ? segment.startMs : 0),
      speakerId: segment.speakerId || "",
      speakerName: segment.speakerName || "发言人",
      rawText: segment.text,
      text: `[${label} ${time}] ${segment.speakerName || "发言人"}: ${segment.text}`
    }];
  });
}

/**
 * 语义分章：把完整转写按静音停顿、话题切换线索与发言人轮换切分为若干章节，
 * 100% 覆盖全部定稿段落（绝不丢弃中段），并给每章保留前序重叠上下文。
 */
export function segmentTranscriptSemantically(transcript = [], {
  targetChars = 4_200,
  maxChars = 6_000,
  overlapSegments = 2,
  pauseGapMs = 6_000
} = {}) {
  const lines = buildIndexedTranscriptLines(transcript);
  if (!lines.length) return [];

  const chapters = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let chars = 0;
    let candidateBoundary = -1;
    let candidateScore = -1;

    while (end < lines.length) {
      const line = lines[end];
      const lineLen = line.text.length + 1;
      if (end > start && chars + lineLen > maxChars) break;
      chars += lineLen;
      end += 1;

      if (chars >= targetChars && end < lines.length) {
        const next = lines[end];
        const gap = Math.max(0, next.startMs - line.endMs);
        let boundaryScore = 0;
        if (gap >= pauseGapMs) boundaryScore += 5;
        if (TOPIC_SHIFT_PATTERN.test(next.rawText)) boundaryScore += 4;
        if (next.speakerId && line.speakerId && next.speakerId !== line.speakerId) boundaryScore += 2;
        if (boundaryScore >= 4) {
          candidateBoundary = end;
          break;
        }
        if (boundaryScore > candidateScore) {
          candidateScore = boundaryScore;
          candidateBoundary = end;
        }
      }
    }

    const splitAt = end < lines.length && candidateBoundary > start ? candidateBoundary : end;
    const chapterLines = lines.slice(start, splitAt);
    const contextLines = lines.slice(Math.max(0, start - overlapSegments), start);
    chapters.push({
      index: chapters.length,
      startMs: chapterLines[0].startMs,
      endMs: chapterLines[chapterLines.length - 1].endMs,
      startTime: chapterLines[0].time,
      endTime: chapterLines[chapterLines.length - 1].time,
      contextLines,
      lines: chapterLines
    });
    start = splitAt;
  }
  return chapters;
}

/** 限制最大并发数执行异步映射。 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

function buildChapterExtractionPrompt({ input, detected, chapter, totalChapters }) {
  return [
    `你在做长会议纪要的「第 ${chapter.index + 1}/${totalChapters} 章」结构化信息提取（时间段 ${chapter.startTime}–${chapter.endTime}）。`,
    `会议主题：${input.title || "未命名会议"}（识别类型：${detected.label}）`,
    `关注重点：${detected.focusGuidance}`,
    "提取原则：",
    "1. 只提取本章转写中真实出现的信息，严禁推测或补齐未说出的数字、日期、负责人。",
    "2. 严格区分「已拍板确认的决定（confirmedDecisions）」与「仅提出/讨论中/未确认的建议（pendingSuggestions）」。",
    "3. 保留关键数据指标（基线、现值、目标、缺口、单位、口径），多单位逐一汇报时分条列出不合并。",
    "4. 行动项（actionItems）只记录明确约定的工作，没说清负责人或期限填「待确认」，不得从发言人推定负责人。",
    "5. 每条尽量附带行首 S 编号（如 S12）作为证据溯源。",
    ...(chapter.contextLines.length
      ? [`前文衔接上下文（仅供理解指代，不重复提取）：\n${chapter.contextLines.map((l) => l.text).join("\n")}`]
      : []),
    `本章转写：\n${chapter.lines.map((l) => l.text).join("\n")}`,
    `只输出一个 JSON 对象：
{
  "chapterTitle": "4-16字议题标题",
  "facts": [{"heading": "对象/主题", "text": "完整事实句", "evidenceSegmentId": "S12", "evidenceTime": "mm:ss"}],
  "metrics": [{"entity": "对象", "metric": "指标名", "value": "数值与口径", "evidenceSegmentId": "S12"}],
  "confirmedDecisions": [{"text": "明确达成的决定", "evidenceSegmentId": "S12"}],
  "pendingSuggestions": [{"text": "讨论建议或未拍板项", "evidenceSegmentId": "S12"}],
  "actionItems": [{"title": "动作+可验收交付物", "owner": "负责人或待确认", "dueDate": "期限或待确认", "evidenceSegmentIds": ["S12"]}],
  "risks": [{"text": "阻塞/风险及影响", "evidenceSegmentId": "S12"}],
  "openQuestions": [{"text": "待核实或未决问题", "evidenceSegmentId": "S12"}]
}`
  ].join("\n\n");
}

function buildGlobalSynthesisPrompt({ input, detected, template, chapterExtractions, locked }) {
  return [
    "你在为没有参加会议的同事合成最终简体中文会议纪要。下方提供了整场会议按时间顺序分段提取的结构化事实（覆盖会议全量内容，无中段遗漏）。",
    `本次纪要模板：${template.label}。${template.guidance}`,
    `会议类型聚焦（${detected.label}）：${detected.focusGuidance}`,
    "全局综合规则：",
    "1. 按议题合并跨章讨论，将最重要的结论、变化与阻塞排在前面；同一事项在后章出现新结论时，以后续最终拍板为准，淘汰前期已推翻的旧想法。",
    "2. 严格区分 decisions 与 openQuestions：只有 confirmedDecisions 且未被后章推翻的事项才能进入 decisions；pendingSuggestions 与未决事项只能归入 openQuestions 或议题背景，严禁升格为已决定。",
    "3. actionItems 必须写清动作+交付物，未明确负责人或期限一律填「待确认」，不得猜测年份或把发言人默认当负责人。",
    "4. discussionSections 保留有实质内容的章节与单位小结，并忠实传递证据编号（S 编号）与关键数字口径；只有不同对象确实共享同一组可比字段时才加可选 table。",
    '5. keyPoints 优先写 3–6 条关键结论，每项为 {"text":"事项短标题｜一句完整结论","evidenceTime":"mm:ss"}；overview 一到两句交代会议范围、整体结果与最重要限制。',
    "6. 只输出一个 JSON 对象，结构包含：overview, topics, keyPoints, discussionSections, decisions, actionItems, openQuestions, risks, nextSteps。",
    `当前会议主题：${input.title || "未命名会议"}`,
    `参会人：${(input.participants ?? []).join("、") || "未提供"}`,
    `会议目标：${(input.goals ?? []).join("；") || "未提供"}`,
    `人工笔记：${(input.notes ?? []).join("；") || "暂无"}`,
    ...(Object.keys(locked).length ? [`人工锁定条目（请务必保留其语义）：${JSON.stringify(locked)}`] : []),
    `各章结构化提取结果：\n${JSON.stringify(chapterExtractions)}`
  ].join("\n\n");
}

function selectVerificationTranscriptExcerpts(lines, summary, maxChars = 14_000) {
  if (!lines.length) return "";
  const total = lines.reduce((sum, l) => sum + l.text.length + 1, 0);
  if (total <= maxChars) return lines.map((l) => l.text).join("\n");

  const referencedIds = new Set();
  for (const section of summary.discussionSections ?? []) {
    for (const point of section.points ?? []) {
      if (point.evidenceSegmentId) referencedIds.add(point.evidenceSegmentId);
    }
  }
  for (const item of summary.actionItems ?? []) {
    for (const id of item.evidenceSegmentIds ?? []) referencedIds.add(id);
  }

  const pickedIndices = new Set();
  lines.forEach((line, idx) => {
    if (referencedIds.has(line.id) || referencedIds.has(line.label)) {
      for (let d = -1; d <= 1; d += 1) {
        if (idx + d >= 0 && idx + d < lines.length) pickedIndices.add(idx + d);
      }
    }
  });

  // 同时均匀抽样首中尾各时段，确保反向漏项检查覆盖未被引用的段落。
  const buckets = 10;
  for (let b = 0; b < buckets; b += 1) {
    const start = Math.floor((lines.length * b) / buckets);
    const end = Math.min(lines.length, start + 3);
    for (let i = start; i < end; i += 1) pickedIndices.add(i);
  }

  const ordered = [...pickedIndices].sort((a, b) => a - b);
  let chars = 0;
  const result = [];
  for (const idx of ordered) {
    const line = lines[idx];
    if (chars + line.text.length + 1 > maxChars) break;
    result.push(line.text);
    chars += line.text.length + 1;
  }
  return result.join("\n");
}

function buildVerificationPrompt({ input, summary, transcriptExcerpt }) {
  return [
    "你是独立的会议纪要事实核验审稿人。请对照下方「原始转写摘录」，审查「待审纪要」的事实准确性与完整性。",
    "审查清单（正向校验 + 反向漏项检查）：",
    "1. 建议误当决定：decisions 中若有「只是某人建议/待评估/未拍板」的条目，将其移出 decisions 并补充到 openQuestions。",
    "2. 责任人/期限幻觉：actionItems 中若负责人或期限在原文中未明确约定（只是发言人随口提到），将对应字段改回「待确认」。",
    "3. 数值/事实偏差：overview 或 keyPoints 中若有与原文数字、单位、口径或事实相悖的句子，提供精确修正。",
    "4. 重大漏项：若原文有非常明确的已拍板决定、明确分派的行动项或关键风险被漏掉，补充进来（不要把琐碎闲聊加进去）。",
    "原则：如果待审纪要已准确完整，请直接返回 issuesFound: 0 且不做多余修改！",
    `会议主题：${input.title || "未命名会议"}`,
    `待审纪要（JSON）：\n${JSON.stringify({
      overview: summary.overview,
      keyPoints: summary.keyPoints,
      decisions: summary.decisions,
      actionItems: summary.actionItems,
      openQuestions: summary.openQuestions,
      risks: summary.risks
    })}`,
    `原始转写摘录：\n${transcriptExcerpt}`,
    `只输出一个 JSON 对象：
{
  "issuesFound": 0,
  "unverifiedNotes": ["如有无法从原文核实的重要风险提醒，放 0-3 条"],
  "patch": {
    "overview": "仅需修改时填写，否则省略",
    "removeDecisionIndices": [],
    "addDecisions": [],
    "addOpenQuestions": [],
    "addRisks": [],
    "actionItemFixes": [{"index": 0, "owner": "待确认", "dueDate": "待确认"}],
    "addActionItems": [{"title": "...", "owner": "...", "dueDate": "..."}]
  }
}`
  ].join("\n\n");
}

/**
 * 将审稿模型返回的定点修订补丁安全地合并到纪要对象上，不破坏未涉及的章节。
 */
export function applyVerificationPatch(summary, verificationPayload) {
  if (!summary || !verificationPayload || typeof verificationPayload !== "object") {
    return { summary, issuesFixed: 0 };
  }
  const patch = verificationPayload.patch && typeof verificationPayload.patch === "object"
    ? verificationPayload.patch
    : {};
  let issuesFixed = 0;
  const next = {
    ...summary,
    decisions: [...(summary.decisions ?? [])],
    openQuestions: [...(summary.openQuestions ?? [])],
    risks: [...(summary.risks ?? [])],
    actionItems: (summary.actionItems ?? []).map((item) => ({ ...item }))
  };

  if (typeof patch.overview === "string" && patch.overview.trim() && patch.overview.trim() !== (summary.overview ?? "").trim()) {
    next.overview = patch.overview.trim();
    issuesFixed += 1;
  }

  if (Array.isArray(patch.removeDecisionIndices) && patch.removeDecisionIndices.length) {
    const removeSet = new Set(patch.removeDecisionIndices.filter((n) => Number.isInteger(n) && n >= 0));
    const before = next.decisions.length;
    next.decisions = next.decisions.filter((_, idx) => !removeSet.has(idx));
    issuesFixed += before - next.decisions.length;
  }

  const appendUnique = (list, items) => {
    if (!Array.isArray(items)) return;
    const seen = new Set(list.map((v) => String(v).trim()));
    for (const raw of items) {
      const text = String(raw ?? "").trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      list.push(text);
      issuesFixed += 1;
    }
  };
  appendUnique(next.decisions, patch.addDecisions);
  appendUnique(next.openQuestions, patch.addOpenQuestions);
  appendUnique(next.risks, patch.addRisks);

  if (Array.isArray(patch.actionItemFixes)) {
    for (const fix of patch.actionItemFixes) {
      if (!fix || !Number.isInteger(fix.index) || fix.index < 0 || fix.index >= next.actionItems.length) continue;
      const target = next.actionItems[fix.index];
      let changed = false;
      if (typeof fix.owner === "string" && fix.owner.trim() && fix.owner.trim() !== target.owner) {
        target.owner = fix.owner.trim();
        changed = true;
      }
      if (typeof fix.dueDate === "string" && fix.dueDate.trim() && fix.dueDate.trim() !== target.dueDate) {
        target.dueDate = fix.dueDate.trim();
        changed = true;
      }
      if (typeof fix.title === "string" && fix.title.trim() && fix.title.trim() !== target.title) {
        target.title = fix.title.trim();
        changed = true;
      }
      if (changed) issuesFixed += 1;
    }
  }

  if (Array.isArray(patch.addActionItems)) {
    const existingTitles = new Set(next.actionItems.map((item) => item.title.trim()));
    for (const raw of patch.addActionItems) {
      const title = typeof raw?.title === "string" ? raw.title.trim() : "";
      if (!title || existingTitles.has(title)) continue;
      existingTitles.add(title);
      next.actionItems.push({
        id: randomUUID(),
        title,
        owner: typeof raw.owner === "string" && raw.owner.trim() ? raw.owner.trim() : "待确认",
        dueDate: typeof raw.dueDate === "string" && raw.dueDate.trim() ? raw.dueDate.trim() : "待确认",
        status: "todo",
        done: false,
        evidenceSegmentIds: []
      });
      issuesFixed += 1;
    }
  }

  return { summary: next, issuesFixed };
}

function extractLockedContext(previous = {}) {
  const locks = new Set(Array.isArray(previous?.manualLocks) ? previous.manualLocks : []);
  if (!locks.size) return {};
  const locked = {};
  for (const field of ["topics", "keyPoints", "decisions", "openQuestions", "risks", "nextSteps"]) {
    const values = Array.isArray(previous?.[field]) ? previous[field] : [];
    const kept = field === "topics"
      ? (locks.has("topics") ? values : [])
      : values.filter((_, index) => locks.has(`${field}:${index}`));
    if (kept.length) locked[field] = kept;
  }
  const lockedActions = (previous?.actionItems ?? []).filter((item) => locks.has(`action:${item?.id}`));
  if (lockedActions.length) locked.actionItems = lockedActions;
  return locked;
}

/**
 * 运行自适应 AI 纪要流水线：
 * - 滚动纪要 / fast 模式 / 短会议（<4500 字）：单阶段增强提示词直出；
 * - 中长会议会后终稿（standard / high 模式）：语义分章 → 并行结构化提取 → 全局综合；
 * - high 模式会后终稿：额外执行 1 轮独立事实核验与定点修订（可选独立 reviewProfile）。
 */
export async function runSummaryPipeline(profile, apiKey, input, {
  final = false,
  qualityMode = "standard",
  reviewProfile,
  reviewApiKey,
  signal,
  onOutput,
  onProgress,
  requestJson = requestStructuredJson,
  summarizeSingleStage = summarizeWithOpenAICompatible
} = {}) {
  const startedAt = Date.now();
  const mode = ["fast", "standard", "high"].includes(qualityMode) ? qualityMode : "standard";
  const detected = detectMeetingType(input);
  const enrichedInput = {
    ...input,
    detectedMeetingType: detected.label,
    meetingTypeGuidance: detected.focusGuidance
  };
  const allLines = buildIndexedTranscriptLines(input.transcript);
  const totalChars = allLines.reduce((sum, line) => sum + line.text.length + 1, 0);
  const stages = ["type_detect"];
  let llmCalls = 0;

  let summary;
  const shouldUseMultiStage = final && mode !== "fast" && totalChars >= LONG_MEETING_CHAR_THRESHOLD;

  if (shouldUseMultiStage) {
    const chapters = segmentTranscriptSemantically(input.transcript);
    if (chapters.length > 1) {
      stages.push("semantic_segment", "chapter_extract");
      onProgress?.("reasoning");
      const chapterExtractions = await mapWithConcurrency(
        chapters,
        CHAPTER_EXTRACTION_CONCURRENCY,
        async (chapter) => {
          signal?.throwIfAborted?.();
          llmCalls += 1;
          const prompt = buildChapterExtractionPrompt({
            input: enrichedInput,
            detected,
            chapter,
            totalChapters: chapters.length
          });
          const extracted = await requestJson(profile, apiKey, {
            systemPrompt: "你是严谨的会议信息抽取助手，只输出可解析的 JSON。",
            userPrompt: prompt,
            temperature: 0.15,
            maxTokens: 4_096,
            signal,
            label: `第 ${chapter.index + 1} 章结构化提取失败`
          });
          return {
            chapterIndex: chapter.index + 1,
            timeRange: `${chapter.startTime}-${chapter.endTime}`,
            ...extracted
          };
        }
      );

      stages.push("global_synthesis");
      const template = summaryTemplateById(input.template);
      const locked = extractLockedContext(input.previousSummary);
      const synthesisPrompt = buildGlobalSynthesisPrompt({
        input: enrichedInput,
        detected,
        template,
        chapterExtractions,
        locked
      });
      llmCalls += 1;
      const rawGlobal = await requestJson(profile, apiKey, {
        systemPrompt: "只输出可解析的 JSON。",
        userPrompt: synthesisPrompt,
        temperature: 0.2,
        maxTokens: 8_192,
        signal,
        onOutput,
        onProgress,
        label: "全局纪要综合失败"
      });
      summary = validateOnlineSummary(rawGlobal, allLines);
    }
  }

  if (!summary) {
    stages.push("single_stage_summary");
    llmCalls += 1;
    summary = await summarizeSingleStage(profile, apiKey, enrichedInput, final, signal, onOutput, onProgress);
  }

  let verification;
  if (final && mode === "high" && allLines.length > 0) {
    stages.push("fact_verify");
    const verifierProfile = reviewProfile || profile;
    const verifierKey = reviewProfile ? (reviewApiKey ?? "") : apiKey;
    try {
      signal?.throwIfAborted?.();
      llmCalls += 1;
      const excerpt = selectVerificationTranscriptExcerpts(allLines, summary);
      const verifyResult = await requestJson(verifierProfile, verifierKey, {
        systemPrompt: "你是严谨的事实核验审稿人，只输出可解析的 JSON。",
        userPrompt: buildVerificationPrompt({ input: enrichedInput, summary, transcriptExcerpt: excerpt }),
        temperature: 0.1,
        maxTokens: 4_096,
        signal,
        label: "纪要事实核验失败"
      });
      const { summary: patched, issuesFixed } = applyVerificationPatch(summary, verifyResult);
      summary = patched;
      const issuesFound = Math.max(issuesFixed, Number(verifyResult?.issuesFound) || 0);
      const unverifiedNotes = Array.isArray(verifyResult?.unverifiedNotes)
        ? verifyResult.unverifiedNotes.map((s) => String(s ?? "").trim()).filter(Boolean).slice(0, 3)
        : [];
      verification = {
        verified: true,
        checkedAt: new Date().toISOString(),
        issuesFound,
        issuesFixed,
        ...(unverifiedNotes.length ? { unverifiedNotes } : {})
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn("[summary-pipeline] 事实核验跳过，保留已生成纪要：", error instanceof Error ? error.message : error);
      verification = {
        verified: false,
        checkedAt: new Date().toISOString(),
        issuesFound: 0,
        issuesFixed: 0,
        unverifiedNotes: ["事实核验步骤未完成，当前展示为综合初稿。"]
      };
    }
  }

  return {
    ...summary,
    detectedMeetingType: detected.label,
    qualityMode: mode,
    ...(verification ? { verification } : {}),
    pipelineStats: {
      stages,
      llmCalls,
      durationMs: Date.now() - startedAt
    }
  };
}

/**
 * P1：针对会后纪要中的单个讨论章节执行局部重生成，不影响其他章节与人工锁定项。
 */
export async function regenerateSummarySectionWithLLM(profile, apiKey, {
  meeting,
  sectionIndex,
  signal,
  requestJson = requestStructuredJson
}) {
  const sections = Array.isArray(meeting?.summary?.discussionSections) ? meeting.summary.discussionSections : [];
  if (!Number.isInteger(sectionIndex) || sectionIndex < 0 || sectionIndex >= sections.length) {
    throw new Error("未找到要重新生成的议题章节。");
  }
  const targetSection = sections[sectionIndex];
  const allLines = buildIndexedTranscriptLines(meeting?.transcript ?? []);
  if (!allLines.length) {
    throw new Error("该会议缺少定稿转写内容，无法局部重生成章节。");
  }

  // 收集该章节已引用的证据段落及其前后 ±8 段，再按章节标题关键词补全相关段落。
  const evidenceIds = new Set(
    (targetSection.points ?? []).map((point) => point?.evidenceSegmentId).filter(Boolean)
  );
  const picked = new Set();
  allLines.forEach((line, idx) => {
    if (evidenceIds.has(line.id) || evidenceIds.has(line.label)) {
      for (let d = -8; d <= 8; d += 1) {
        if (idx + d >= 0 && idx + d < allLines.length) picked.add(idx + d);
      }
    }
  });
  const titleTokens = String(targetSection.title || "")
    .split(/[\s，。、：:（）()\-—/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (picked.size < 12 && titleTokens.length) {
    allLines.forEach((line, idx) => {
      if (titleTokens.some((tok) => line.rawText.includes(tok))) {
        for (let d = -2; d <= 2; d += 1) {
          if (idx + d >= 0 && idx + d < allLines.length) picked.add(idx + d);
        }
      }
    });
  }
  const selectedLines = picked.size > 0
    ? [...picked].sort((a, b) => a - b).map((idx) => allLines[idx]).slice(0, 80)
    : allLines.slice(0, 80);

  const prompt = [
    `请根据下方原始转写，重新高质量梳理会议纪要中的单个讨论章节「${targetSection.title}」。`,
    "要求：",
    "1. 只聚焦该议题相关的事实、指标、各方观点、卡点与结论，写成可独立读懂的中文要点。",
    "2. 保留精确数字、单位、口径与适用条件，严禁编造原文未提及信息。",
    "3. 每条 point 尽量复制行首 S 编号写入 evidenceSegmentId；仅当多个对象存在同口径可比数据时提供可选 table。",
    `会议主题：${meeting.title || "未命名会议"}`,
    `原章节草稿（仅供参考议题范围）：${JSON.stringify(targetSection)}`,
    `相关转写原文：\n${selectedLines.map((l) => l.text).join("\n")}`,
    '只输出一个 JSON 对象：{"title":"议题标题","points":[{"heading":"小结标题","text":"完整事实与背景","evidenceSegmentId":"S12"}],"table":{"columns":["..."],"rows":[["..."]]}}'
  ].join("\n\n");

  const raw = await requestJson(profile, apiKey, {
    systemPrompt: "只输出可解析的 JSON。",
    userPrompt: prompt,
    temperature: 0.2,
    maxTokens: 4_096,
    signal,
    label: "章节局部重生成失败"
  });

  const idMap = new Map(allLines.filter((l) => l.id).flatMap((l) => [[l.label, l.id], [l.id, l.id]]));
  const points = (Array.isArray(raw?.points) ? raw.points : [])
    .map((point) => {
      const text = typeof point?.text === "string" ? point.text.trim() : "";
      if (!text) return null;
      const heading = typeof point?.heading === "string" && point.heading.trim() ? point.heading.trim() : undefined;
      const mappedId = idMap.get(String(point?.evidenceSegmentId ?? "").trim());
      return {
        ...(heading ? { heading } : {}),
        text,
        ...(mappedId ? { evidenceSegmentId: mappedId } : {})
      };
    })
    .filter(Boolean);
  if (!points.length) {
    throw new Error("模型未返回有效的章节要点，保留原有章节内容。");
  }

  let table;
  if (raw?.table && Array.isArray(raw.table.columns) && Array.isArray(raw.table.rows)) {
    const columns = raw.table.columns.map((c) => String(c ?? "").trim()).filter(Boolean);
    const rows = raw.table.rows
      .filter((row) => Array.isArray(row) && row.length === columns.length)
      .map((row) => row.map((cell) => String(cell ?? "").trim()));
    if (columns.length >= 2 && columns.length <= 5 && rows.length >= 2) {
      table = { columns, rows };
    }
  }

  return {
    title: typeof raw?.title === "string" && raw.title.trim() ? raw.title.trim() : targetSection.title,
    points,
    ...(table ? { table } : {})
  };
}
