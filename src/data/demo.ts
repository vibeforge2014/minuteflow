/**
 * 演示数据：浏览器/官网模式下首次打开时写入 localStorage 的示例会议。
 * 覆盖主要状态（录音中/已完成/收藏/线上线下），让官网访客无需录音即可预览
 * 会议库、文档、纪要与转写面板的完整 UI。
 *
 * 所属层：渲染层数据（仅演示，Electron 桌面端不使用）。
 * 主要导出：demoMeetings。
 */
import type { Meeting, MeetingSummary } from "../types";

/** 共享的示例纪要底稿：各会议在此基础上覆盖差异字段。 */
const baseSummary: MeetingSummary = {
  topics: ["登录流程改版", "AB 测试流量", "客服高频问题"],
  keyPoints: [
    "会议开始，主持人说明本周议程与目标。",
    "刘婷汇报登录流程改版进展，A 方案已完成可用性测试。",
    "周哲反馈数据埋点方案，需要补充登录失败原因的细分埋点。",
    "讨论 AB 测试方案，倾向先在 5% 流量灰度。",
    "确认需要法务评估第三方登录的合规风险。",
    "建议下周邀请客服参与需求评审。",
    "决定本周四前完成埋点方案评审。",
    "针对用户反馈的高频问题，由产品与客服对齐处理方案。"
  ],
  decisions: ["本周四前完成埋点方案评审。"],
  actionItems: [
    { id: "a1", title: "输出登录流程 AB 测试方案并评审", owner: "刘婷", dueDate: "08-03", status: "in_progress", done: false },
    { id: "a2", title: "补充登录失败原因的埋点设计", owner: "周哲", dueDate: "08-01", status: "in_progress", done: false },
    { id: "a3", title: "法务评估第三方登录合规风险", owner: "王敏（法务）", dueDate: "08-02", status: "todo", done: false },
    { id: "a4", title: "整理客服高频问题并对齐处理方案", owner: "我", dueDate: "08-04", status: "todo", done: false }
  ],
  openQuestions: ["登录失败原因是否需要拆分到设备维度？"],
  risks: ["第三方登录合规评估可能影响上线时间。"],
  nextSteps: ["完成小流量灰度后复盘转化和留存表现。"],
  updatedAt: "2026-07-30T10:20:00+08:00",
  visualSummary: {
    schemaVersion: 1,
    title: "登录流程改版与灰度决策",
    subtitle: "聚焦体验方案、数据验证与合规风险，形成可执行的上线闭环",
    generatedAt: "2026-07-30T10:21:00+08:00",
    sourceSummaryUpdatedAt: "2026-07-30T10:20:00+08:00",
    stale: false,
    sections: [
      {
        id: "overview", number: 1, title: "方案与风险总览", tone: "amber", layout: "table",
        table: {
          columns: ["议题", "核心结论", "风险 / 约束", "状态"],
          rows: [
            ["登录体验", "A 方案可用性反馈优于 B 方案", "仍需验证真实流量表现", "主推方向"],
            ["数据验证", "先以 5% 流量启动灰度", "失败原因埋点需要补齐", "准备中"],
            ["第三方登录", "进入法务合规评估", "可能影响上线时间", "需关注"]
          ]
        }
      },
      {
        id: "delivery", number: 2, title: "系统对接与验证", tone: "violet", layout: "cards",
        cards: [
          { title: "埋点方案评审", status: "进行中", bullets: ["细分登录失败原因", "统一转化与留存口径", "周四前完成评审"], takeaway: "先补齐数据能力，再进入灰度。" },
          { title: "跨团队协作", status: "待协调", bullets: ["邀请客服参与需求评审", "整理两类高频用户问题", "同步法务合规结论"], takeaway: "把体验、数据和合规放进同一条发布链路。" }
        ]
      },
      {
        id: "actions", number: 3, title: "行动安排", tone: "green", layout: "cards",
        cards: [
          { title: "输出 AB 测试方案", status: "刘婷 · 08-03", bullets: ["明确 5% 灰度范围", "定义转化与留存观察指标"] },
          { title: "补充失败原因埋点", status: "周哲 · 08-01", bullets: ["拆分失败类型", "完成评审并冻结口径"] }
        ]
      },
      { id: "closing", number: 4, title: "会议定调", tone: "coral", layout: "callout", callout: "先完成埋点与合规前置，再启动 5% 小流量灰度，并在下周复盘真实用户表现。" }
    ]
  },
  stale: false
};

/** 示例会议列表：第一条为含完整转写的「录音中」周会，其余覆盖不同标签/形式/收藏态。 */
export const demoMeetings: Meeting[] = [
  {
    id: "product-weekly-2026-07-30",
    title: "产品团队周会",
    scheduledAt: "2026-07-30T10:00:00+08:00",
    durationSeconds: 1477,
    status: "recording",
    mode: "online",
    favorite: false,
    participants: ["我", "刘婷", "周哲", "王敏"],
    tags: ["产品", "周会"],
    goals: ["对齐本周重点进展与风险", "决定登录流程改版的下一步方案", "明确需要跨团队协作的事项"],
    notes: ["关注登录改版的 AB 方案选择", "确认埋点需求与数据口径", "跟进客服反馈的两类高频问题"],
    summary: baseSummary,
    transcript: [
      { id: "t1", startMs: 0, endMs: 12000, speakerId: "me", speakerName: "我", text: "大家好，我们开始今天的周会，先快速对齐议程。", status: "final", track: "microphone" },
      { id: "t2", startMs: 60000, endMs: 92000, speakerId: "liuting", speakerName: "刘婷", text: "我先汇报登录流程改版的进展。A 方案的可用性测试已经完成，整体反馈比 B 方案更好。", status: "final", track: "system" },
      { id: "t3", startMs: 180000, endMs: 212000, speakerId: "zhouzhe", speakerName: "周哲", text: "我这边看了初版埋点方案，有个补充：登录失败原因需要再细分几个类型，方便后续分析。", status: "final", track: "system" },
      { id: "t4", startMs: 300000, endMs: 327000, speakerId: "me", speakerName: "我", text: "好的，这个很关键，细分一下原因我们才能更准确定位问题。", status: "final", track: "microphone" },
      { id: "t5", startMs: 360000, endMs: 392000, speakerId: "liuting", speakerName: "刘婷", text: "关于 AB 测试，我倾向先在 5% 流量灰度，验证转化和留存影响。", status: "final", track: "system" },
      { id: "t6", startMs: 480000, endMs: 512000, speakerId: "zhouzhe", speakerName: "周哲", text: "同意，另外需要确认一下埋点评审的时间，我争取周四前完成。", status: "final", track: "system" },
      { id: "t7", startMs: 600000, endMs: 632000, speakerId: "me", speakerName: "我", text: "下周可以邀请客服一起参与需求评审，把高频问题的处理方案一起过一遍。", status: "final", track: "microphone" }
    ],
    createdAt: "2026-07-30T09:52:00+08:00",
    updatedAt: "2026-07-30T10:24:00+08:00"
  },
  {
    id: "mobile-review-2026-07-28",
    title: "项目复盘：移动端体验优化",
    scheduledAt: "2026-07-28T16:00:00+08:00",
    durationSeconds: 3492,
    status: "complete",
    mode: "online",
    favorite: false,
    participants: ["我", "赵宇"],
    tags: ["复盘"],
    goals: ["复盘移动端体验问题"],
    notes: ["聚焦首屏速度与导航层级"],
    summary: { ...baseSummary, topics: ["移动端体验"], keyPoints: ["确认首屏加载和导航层级是主要改进点。"], actionItems: [] },
    transcript: [
      { id: "mr1", startMs: 28_000, endMs: 52_000, speakerId: "me", speakerName: "我", text: "今天重点复盘首屏加载、导航层级和数据导出三个高频路径。", status: "final", track: "microphone" },
      { id: "mr2", startMs: 96_000, endMs: 136_000, speakerId: "zhaoyu", speakerName: "赵宇", text: "首屏优化已经有明显收益，但登录失败后的恢复路径还需要补齐状态反馈。", status: "final", track: "system" },
      { id: "mr3", startMs: 210_000, endMs: 254_000, speakerId: "me", speakerName: "我", text: "第一阶段先锁定核心任务闭环，以 5% 流量灰度观察成功率和任务耗时。", status: "final", track: "microphone" },
      { id: "mr4", startMs: 328_000, endMs: 372_000, speakerId: "zhaoyu", speakerName: "赵宇", text: "设计会补齐空状态和异常提示，研发同步回归窗口，两周后统一复盘数据。", status: "final", track: "system" }
    ],
    createdAt: "2026-07-28T15:55:00+08:00",
    updatedAt: "2026-07-28T17:02:00+08:00"
  },
  {
    id: "design-review-2026-07-28",
    title: "设计评审：登录流程改版",
    scheduledAt: "2026-07-28T10:00:00+08:00",
    durationSeconds: 2538,
    status: "complete",
    mode: "online",
    favorite: true,
    participants: ["我", "刘婷", "王敏"],
    tags: ["设计"],
    goals: ["评审登录流程"],
    notes: ["重点关注错误恢复"],
    summary: { ...baseSummary, topics: ["登录流程"], keyPoints: ["A 方案在错误恢复上更清晰。"], decisions: ["进入可用性测试。"], actionItems: [] },
    transcript: [],
    createdAt: "2026-07-28T09:52:00+08:00",
    updatedAt: "2026-07-28T10:47:00+08:00"
  },
  {
    id: "market-sync-2026-07-27",
    title: "与市场团队对齐会",
    scheduledAt: "2026-07-27T14:30:00+08:00",
    durationSeconds: 2165,
    status: "complete",
    mode: "offline",
    favorite: false,
    participants: ["我", "陈晨"],
    tags: ["市场"],
    goals: ["对齐发布节奏"],
    notes: [],
    summary: { ...baseSummary, topics: ["发布节奏"], keyPoints: [], decisions: [], actionItems: [] },
    transcript: [],
    createdAt: "2026-07-27T14:22:00+08:00",
    updatedAt: "2026-07-27T15:10:00+08:00"
  },
  {
    id: "q3-planning-2026-07-23",
    title: "Q3 规划讨论",
    scheduledAt: "2026-07-23T15:30:00+08:00",
    durationSeconds: 4702,
    status: "complete",
    mode: "offline",
    favorite: false,
    participants: ["我", "团队"],
    tags: ["规划"],
    goals: ["确定 Q3 优先级"],
    notes: [],
    summary: { ...baseSummary, topics: ["Q3 规划"], keyPoints: [], actionItems: [] },
    transcript: [],
    createdAt: "2026-07-23T15:25:00+08:00",
    updatedAt: "2026-07-23T16:50:00+08:00"
  }
];
