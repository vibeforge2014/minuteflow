/**
 * 纪要模板（渲染层与主进程共用的唯一来源）。
 *
 * 模板只改变归纳视角——提示词里的关注点与写法要求——不改变纪要的七段结构
 * （topics / keyPoints / decisions / actionItems / openQuestions / risks / nextSteps）。
 * 这样同一个可编辑纪要文档、同一套渲染与锁定逻辑对所有模板通用，
 * 也避免为每种模板引入新的 schema 与迁移。
 *
 * 主要导出：SUMMARY_TEMPLATES、SUMMARY_TEMPLATE_IDS、summaryTemplateById。
 */

/** @typedef {"general" | "weekly" | "interview" | "retro"} SummaryTemplateId */

export const SUMMARY_TEMPLATES = [
  {
    id: "general",
    label: "通用会议",
    description: "决策、行动项与风险均衡呈现",
    guidance: "按常规会议归纳：先结论后细节，行动项说清谁做什么，风险与未决问题单独列出。"
  },
  {
    id: "weekly",
    label: "周会同步",
    description: "按进展、阻塞与下周安排组织",
    guidance: [
      "这是周期性同步会：topics 里优先区分「本期进展」「阻塞与依赖」两类。",
      "keyPoints 只保留本期实际发生的变化与结论，不复述例行汇报。",
      "actionItems 必须写明负责人与时间（会上没提到就写「待确认」，不要推测）。",
      "nextSteps 聚焦下一周期要推进的事项；risks 记录会阻塞交付的依赖。"
    ].join("")
  },
  {
    id: "interview",
    label: "访谈调研",
    description: "保留受访者原话观点与待跟进问题",
    guidance: [
      "这是访谈/调研场景：keyPoints 优先保留受访者的观点与原话（可轻度整理，但不改变意思，标注说话人）。",
      "decisions 记录已确认的事实与结论，不要把受访者的假设写成结论。",
      "openQuestions 记录还没问清、需要回访确认的点；actionItems 只收调研方明确承诺的跟进动作。"
    ].join("")
  },
  {
    id: "retro",
    label: "项目复盘",
    description: "做得好、待改进与根因、改进项",
    guidance: [
      "这是项目复盘：keyPoints 按「做得好」「待改进」「根因」三类归纳。",
      "risks 写清可能复发的隐患与触发条件；nextSteps 写成可执行的改进项并尽量指明负责人。",
      "decisions 记录复盘达成的共识，actionItems 只保留会上确认要做的改进动作。"
    ].join("")
  }
];

export const SUMMARY_TEMPLATE_IDS = SUMMARY_TEMPLATES.map((template) => template.id);

/**
 * 按 id 取模板；未知 id（旧数据、手工构造的载荷）回落到通用会议，
 * 保证提示词永远有可用模板且入参不会因拼写差异报错。
 * @param {string | undefined} id
 */
export function summaryTemplateById(id) {
  return SUMMARY_TEMPLATES.find((template) => template.id === id) ?? SUMMARY_TEMPLATES[0];
}
