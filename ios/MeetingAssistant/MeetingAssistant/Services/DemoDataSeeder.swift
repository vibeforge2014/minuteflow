//
//  DemoDataSeeder.swift
//  MeetingAssistant
//
//  演示数据种子：首次启动且数据库为空时，写入一场“进行中”的示例会议
//  （含转录片段、行动项与纪要）和若干历史会议，便于直接体验完整界面。
//  所属层：服务层（开发/演示用途，仅在库为空时执行一次）。
//

import Foundation
import SwiftData

// MARK: - 种子数据

/// 首启演示数据播种工具（无状态枚举命名空间）。
@MainActor
enum DemoDataSeeder {
  /// 数据库为空时播种演示数据；已有任何会议则直接返回。
  ///
  /// - Parameter modelContext: SwiftData 上下文。
  /// - 副作用：插入示例 MeetingRecord/TranscriptSegmentRecord/ActionItemRecord 并保存。
  static func seedIfNeeded(modelContext: ModelContext) throws {
    var descriptor = FetchDescriptor<MeetingRecord>()
    descriptor.fetchLimit = 1
    guard try modelContext.fetch(descriptor).isEmpty else { return }

    // 一场已完成的主示例会议：完整的目标/议程/笔记/纪要与元信息。
    // （曾用「录音中」状态模拟实时界面，但假录音会让新用户困惑
    // 「为什么没有声音/时间不走」，演示数据一律用已完成状态。）
    let meeting = MeetingRecord(
      title: "产品团队周会",
      startedAt: .now.addingTimeInterval(-1_477),
      duration: 1_477,
      status: .completed,
      isFavorite: true,
      meetingMode: "线上会议",
      participantsText: "我、刘婷、周哲、王敏（法务）",
      tagsText: "产品、周会",
      agenda: "1. 登录流程改版进展\n2. 数据埋点方案\n3. 灰度发布与风险",
      goal: "对齐本周重点进展与风险\n决定登录流程改版的下一步方案\n明确需要跨团队协作的事项",
      personalNotes: "• 关注登录改版的 AB 方案选择\n• 确认埋点需求与数据口径\n• 跟进客服反馈的两类高频问题",
      summaryText: """
        ## 主题要点
        - 登录流程改版已进入可用性测试阶段
        - 数据埋点方案需要补充失败原因分类
        - 下周安排客服与需求评审

        ## 关键结论
        - AB 测试先采用 5% 流量灰度
        - 法务在灰度前完成第三方登录合规复核
        """,
      decisionsText: "• AB 测试先采用 5% 流量灰度\n• 周四完成埋点方案评审",
      openQuestionsText: "• 登录失败原因需要细分为几类？",
      risksText: "• 第三方登录合规复核可能影响灰度时间",
      nextStepsText: "• 完成可用性测试\n• 补齐埋点方案\n• 安排客服评审"
    )

    // 示例转录片段：每段约 45 秒，全部为定稿。
    let segments: [(TimeInterval, String, String)] = [
      (0, "我", "大家好，我们开始今天的周会，先快速对齐议程和目标。"),
      (62, "刘婷", "我先汇报登录流程改版的进展。A 方案的可用性测试已经完成，整体反馈比 B 方案更好。"),
      (183, "周哲", "我看过埋点方案，有个补充：登录失败原因需要再细分几个类型，方便后续分析。"),
      (305, "我", "这个很关键，细分一下原因我们才能更准确定位问题。"),
      (367, "刘婷", "关于 AB 测试，我倾向先在 5% 流量灰度，验证转化和留存影响。"),
      (489, "周哲", "另外需要确认埋点评审时间，我争取周四前完成。"),
      (611, "我", "下周可以邀请客服一起参与需求评审，把高频问题的处理方案一起过一遍。"),
    ]
    for (index, value) in segments.enumerated() {
      meeting.transcriptSegments.append(
        TranscriptSegmentRecord(
          startTime: value.0,
          endTime: value.0 + 45,
          speaker: value.1,
          text: value.2,
          isFinal: true,
          meeting: meeting
        )
      )
    }

    // 示例行动项：不同负责人、截止日期与状态，覆盖排序分支。
    meeting.actionItems = [
      ActionItemRecord(
        title: "输出登录流程 AB 测试方案并评审",
        owner: "刘婷",
        dueDate: Calendar.current.date(byAdding: .day, value: 4, to: .now),
        status: .inProgress,
        meeting: meeting
      ),
      ActionItemRecord(
        title: "补充登录失败原因的埋点设计",
        owner: "周哲",
        dueDate: Calendar.current.date(byAdding: .day, value: 2, to: .now),
        status: .inProgress,
        meeting: meeting
      ),
      ActionItemRecord(
        title: "法务评估第三方登录合规风险",
        owner: "王敏",
        dueDate: Calendar.current.date(byAdding: .day, value: 3, to: .now),
        meeting: meeting
      ),
    ]
    modelContext.insert(meeting)

    // 历史会议：真实感的结构化纪要，保证「关键结论」卡片等旗舰视图有内容可演示。
    let previousMeetings: [(String, Int, TimeInterval, String, String)] = [
      (
        "项目复盘：移动端体验优化", -2, 3_492.0, "复盘、移动端",
        """
        ## 主题要点
        - 三条核心链路里，登录与数据导出的收益最明确
        - 灰度节奏与验收口径已经对齐

        ## 关键结论
        - 登录链路优先压缩首屏步骤，作为主推方向
        - 数据导出补齐失败重试与状态反馈，并行推进
        - 设置中心的信息架构调整延后，避免分散回归窗口
        """
      ),
      (
        "设计评审：登录流程改版", -3, 2_538.0, "设计、登录",
        """
        ## 主题要点
        - A 方案三步完成的转化数据优于 B 方案
        - 异常与弱网场景的反馈样式仍需补齐

        ## 关键结论
        - 登录主流程采用 A 方案的信息架构
        - 异常路径补齐空态与重试引导后再定稿
        """
      ),
      (
        "与市场团队对齐会", -4, 2_165.0, "市场、对齐",
        """
        ## 主题要点
        - 下季度投放素材以真实使用场景为主
        - 官网与商店页文案需要同步更新

        ## 关键结论
        - 发布节奏按双周一个里程碑推进
        - 市场物料统一使用新的品牌视觉规范
        """
      ),
      (
        "产品团队周会（上周）", -7, 3_321.0, "产品、周会",
        """
        ## 主题要点
        - 完成埋点方案评审与客服反馈归因
        - 本周进入灰度发布准备

        ## 关键结论
        - AB 测试固定 5% 流量起步，观察两周
        - 高频问题先由客服话术兜底，产品侧排期修复
        """
      ),
      (
        "Q3 规划讨论", -8, 4_702.0, "规划、Q3",
        """
        ## 主题要点
        - Q3 聚焦稳定性与核心转化指标
        - 新需求统一进入需求池排序

        ## 关键结论
        - 稳定性专项优先于新功能排期
        - 每月最后一次周会做指标复盘
        """
      ),
      (
        "需求澄清会：数据导出", -9, 1_931.0, "需求、数据",
        """
        ## 主题要点
        - 导出范围确认为主流格式优先
        - 大文件导出改为后台任务

        ## 关键结论
        - 首批支持 CSV 与 Excel 两种格式
        - 超过一万行的导出走后台生成并通知
        """
      ),
    ]
    for (index, item) in previousMeetings.enumerated() {
      let date = Calendar.current.date(byAdding: .day, value: item.1, to: .now) ?? .now
      let previous = MeetingRecord(
        title: item.0,
        createdAt: date,
        startedAt: date,
        duration: item.2,
        status: .completed,
        participantsText: "刘婷、周哲、王敏",
        tagsText: item.3,
        summaryText: item.4,
        decisionsText: "• 第一阶段先覆盖核心流程\n• 两周后根据数据复盘",
        risksText: "• 回归窗口较紧，需要提前锁定范围",
        nextStepsText: "• 补齐异常路径\n• 完成灰度检查表"
      )
      if index == 0 {
        try previous.apply(visualSummary: VisualSummary(
          schemaVersion: 1,
          title: "移动端体验优化复盘",
          subtitle: "聚焦核心路径、交付节奏与灰度风险",
          sections: [
            VisualSummarySection(
              id: "strategy", number: 1, title: "方案分析与决策", tone: .amber, layout: .table,
              table: VisualSummaryTable(
                columns: ["方向", "核心判断", "评估结论"],
                rows: [
                  ["登录链路", "优先压缩首屏步骤", "主推方向"],
                  ["数据导出", "补齐失败重试与状态反馈", "并行推进"],
                  ["设置中心", "延后非核心信息架构调整", "后续优化"],
                ]
              ), cards: nil, callout: nil
            ),
            VisualSummarySection(
              id: "delivery", number: 2, title: "系统交付与体验突破", tone: .violet, layout: .cards,
              table: nil,
              cards: [
                VisualSummaryCard(
                  title: "核心流程回归", status: "进行中",
                  bullets: ["覆盖登录与导出关键路径", "补齐异常反馈", "周五前形成检查表"],
                  takeaway: "先保证高频任务稳定"
                ),
                VisualSummaryCard(
                  title: "灰度与指标", status: "待确认",
                  bullets: ["首批覆盖 5% 用户", "观察成功率与任务耗时", "两周后统一复盘"],
                  takeaway: "用真实数据决定扩量"
                ),
              ], callout: nil
            ),
            VisualSummarySection(
              id: "collaboration", number: 3, title: "协作与风险控制", tone: .green, layout: .cards,
              table: nil,
              cards: [
                VisualSummaryCard(
                  title: "跨团队协作", status: "已对齐",
                  bullets: ["产品锁定优先级", "设计补齐空状态", "研发同步回归窗口"],
                  takeaway: "减少交付过程中的反复"
                )
              ], callout: nil
            ),
            VisualSummarySection(
              id: "conclusion", number: 4, title: "会议定调", tone: .coral, layout: .callout,
              table: nil, cards: nil,
              callout: "第一阶段聚焦核心任务闭环，小流量灰度验证后再逐步扩展改版范围。"
            ),
          ],
          generatedAt: date,
          sourceSummaryUpdatedAt: date,
          stale: false
        ))
      }
      modelContext.insert(previous)
    }
    try modelContext.save()
  }
}
