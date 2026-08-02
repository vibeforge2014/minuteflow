import Foundation
import SwiftData

@MainActor
enum DemoDataSeeder {
  static func seedIfNeeded(modelContext: ModelContext) throws {
    var descriptor = FetchDescriptor<MeetingRecord>()
    descriptor.fetchLimit = 1
    guard try modelContext.fetch(descriptor).isEmpty else { return }

    let meeting = MeetingRecord(
      title: "产品团队周会",
      startedAt: .now.addingTimeInterval(-1_477),
      duration: 1_477,
      status: .recording,
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
          isFinal: index < segments.count - 1,
          meeting: meeting
        )
      )
    }

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

    let previousMeetings = [
      ("项目复盘：移动端体验优化", -2, 3_492.0, "复盘、移动端"),
      ("设计评审：登录流程改版", -3, 2_538.0, "设计、登录"),
      ("与市场团队对齐会", -4, 2_165.0, "市场、对齐"),
      ("产品团队周会（上周）", -7, 3_321.0, "产品、周会"),
      ("Q3 规划讨论", -8, 4_702.0, "规划、Q3"),
      ("需求澄清会：数据导出", -9, 1_931.0, "需求、数据"),
    ]
    for item in previousMeetings {
      let date = Calendar.current.date(byAdding: .day, value: item.1, to: .now) ?? .now
      modelContext.insert(
        MeetingRecord(
          title: item.0,
          createdAt: date,
          startedAt: date,
          duration: item.2,
          status: .completed,
          tagsText: item.3,
          summaryText: "## 会议纪要\n- 已完成会议整理，可继续编辑和补充。"
        )
      )
    }
    try modelContext.save()
  }
}
