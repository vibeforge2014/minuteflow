#!/usr/bin/env node
/**
 * MinuteFlow 转写与纪要质量离线评估基线脚本。
 *
 * 指标：
 *  1. 动态热词召回率（Hotword Recall）与噪声过滤率
 *  2. 语义纠错安全护栏拦截率（数值改动 / 否定翻转 / 异常缩水）与合法修正放行率
 *  3. 模拟纠错前后 CER（字错误率）下降幅度
 *  4. 会议类型自动识别准确率
 *  5. 长会议语义分章 100% 原始段落覆盖率与零丢段验证
 *
 * 用法：node scripts/eval-quality.mjs
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractMeetingHotwordPack, extractMeetingHotwords } from "../electron/services/hotwords.mjs";
import { validateCorrectionSafety } from "../electron/services/transcript-correction.mjs";
import { detectMeetingType, segmentTranscriptSemantically } from "../electron/services/summary-pipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "..", "tests", "fixtures", "quality-eval-cases.json");

function levenshtein(a, b) {
  const s = [...a];
  const t = [...b];
  const dp = Array.from({ length: s.length + 1 }, () => new Array(t.length + 1).fill(0));
  for (let i = 0; i <= s.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= t.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[s.length][t.length];
}

function calcCer(reference, hypothesis) {
  const normRef = String(reference).replace(/[\s，。！？、,.!?;；:：]/g, "");
  const normHyp = String(hypothesis).replace(/[\s，。！？、,.!?;；:：]/g, "");
  if (!normRef.length) return 0;
  return levenshtein(normRef, normHyp) / normRef.length;
}

const fixtures = JSON.parse(await readFile(fixturePath, "utf8"));
let failed = false;

// 1. Hotword Recall & Precision
let hotwordHits = 0;
let hotwordTotal = 0;
let excludedLeaks = 0;
for (const c of fixtures.hotwordCases) {
  const actual = extractMeetingHotwords(c.input);
  for (const term of c.expectedIncludes) {
    hotwordTotal += 1;
    if (actual.includes(term)) hotwordHits += 1;
  }
  for (const banned of c.expectedExcludes) {
    if (actual.includes(banned)) excludedLeaks += 1;
  }
}
const hotwordRecall = hotwordTotal ? hotwordHits / hotwordTotal : 1;
if (hotwordRecall < 1 || excludedLeaks > 0) failed = true;

// 2. Correction Safety Guardrails
let safetyCorrect = 0;
for (const c of fixtures.correctionSafetyCases) {
  const verdict = validateCorrectionSafety(c.original, c.candidate);
  const ok = verdict.accepted === c.expectAccepted && (!c.expectReason || verdict.reason === c.expectReason);
  if (ok) safetyCorrect += 1;
  else {
    failed = true;
    console.error(`[FAIL] 安全护栏用例「${c.name}」预期 accepted=${c.expectAccepted}/${c.expectReason ?? "-"}，实际 ${verdict.accepted}/${verdict.reason ?? "-"}`);
  }
}
const safetyAccuracy = safetyCorrect / fixtures.correctionSafetyCases.length;

// 3. CER Reduction
const rawCerAvg = fixtures.cerCases.reduce((sum, c) => sum + calcCer(c.reference, c.rawAsr), 0) / fixtures.cerCases.length;
const corrCerAvg = fixtures.cerCases.reduce((sum, c) => sum + calcCer(c.reference, c.corrected), 0) / fixtures.cerCases.length;
if (corrCerAvg >= rawCerAvg) failed = true;

// 4. Meeting Type Detection
let typeCorrect = 0;
for (const c of fixtures.meetingTypeCases) {
  const detected = detectMeetingType({ title: c.title, goals: c.goals });
  if (detected.typeId === c.expectedTypeId) typeCorrect += 1;
  else {
    failed = true;
    console.error(`[FAIL] 会议类型识别「${c.title}」预期 ${c.expectedTypeId}，实际 ${detected.typeId}`);
  }
}
const typeAccuracy = typeCorrect / fixtures.meetingTypeCases.length;

// 5. Long-Meeting Semantic Segmentation Coverage (60-minute synthetic transcript ~12k chars)
const syntheticTranscript = Array.from({ length: 120 }, (_, i) => ({
  id: `seg-${i + 1}`,
  startMs: i * 30_000 + (i % 25 === 0 && i > 0 ? 10_000 : 0),
  endMs: i * 30_000 + 22_000,
  speakerId: `speaker-${(i % 3) + 1}`,
  speakerName: `发言人${(i % 3) + 1}`,
  status: "final",
  track: "mixed",
  text: `${i % 25 === 0 && i > 0 ? "接下来我们进入下一个议题，" : ""}第 ${i + 1} 段关于订单系统与支付网关性能压测的详细讨论，当前 P99 延迟维持在 ${120 + (i % 15)}ms，需继续跟踪缓存命中率与超时阈值配置。`
}));
const chapters = segmentTranscriptSemantically(syntheticTranscript);
const coveredIds = new Set(chapters.flatMap((ch) => ch.lines.map((l) => l.id)));
const coverageRatio = coveredIds.size / syntheticTranscript.length;
if (coverageRatio < 1 || chapters.length < 2) failed = true;

// 6. Built-in Domain Detection & Homophone Alias Recall
let aliasHits = 0;
let aliasTotal = 0;
let domainHits = 0;
let domainTotal = 0;
for (const c of fixtures.domainAliasCases ?? []) {
  const pack = extractMeetingHotwordPack({
    title: c.title,
    transcript: [{ status: "final", text: c.transcriptText }]
  });
  for (const d of c.expectedDomains) {
    domainTotal += 1;
    if (pack.domains.includes(d)) domainHits += 1;
    else failed = true;
  }
  for (const [alias, canonical] of c.expectedAliasPairs) {
    aliasTotal += 1;
    if (pack.aliasHints.some((h) => h.alias === alias && h.canonical === canonical && h.matchedInText)) {
      aliasHits += 1;
    } else {
      failed = true;
      console.error(`[FAIL] 同音别名未命中：${alias} -> ${canonical}`);
    }
  }
}

console.log("=== MinuteFlow 质量基线评估报告 ===");
console.log(`1. 动态热词召回率       : ${(hotwordRecall * 100).toFixed(1)}% (${hotwordHits}/${hotwordTotal})，噪声泄漏=${excludedLeaks}`);
console.log(`2. 纠错安全护栏准确率   : ${(safetyAccuracy * 100).toFixed(1)}% (${safetyCorrect}/${fixtures.correctionSafetyCases.length})`);
console.log(`3. 示例集 CER 变化      : ${(rawCerAvg * 100).toFixed(2)}% -> ${(corrCerAvg * 100).toFixed(2)}%`);
console.log(`4. 会议类型识别准确率   : ${(typeAccuracy * 100).toFixed(1)}% (${typeCorrect}/${fixtures.meetingTypeCases.length})`);
console.log(`5. 长会议语义分章覆盖率 : ${(coverageRatio * 100).toFixed(1)}% (${coveredIds.size}/${syntheticTranscript.length} 段，共 ${chapters.length} 章)`);
console.log(`6. 内置领域与同音别名   : 领域 ${(domainHits / Math.max(1, domainTotal) * 100).toFixed(1)}% (${domainHits}/${domainTotal})，同音别名命中 ${(aliasHits / Math.max(1, aliasTotal) * 100).toFixed(1)}% (${aliasHits}/${aliasTotal})`);

if (failed) {
  console.error("[eval-quality] 存在未达标指标");
  process.exit(1);
}
console.log("[eval-quality] 全部质量基线达标");
