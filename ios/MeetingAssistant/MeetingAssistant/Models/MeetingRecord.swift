//
//  MeetingRecord.swift
//  MeetingAssistant
//
//  会议主表 SwiftData 模型：承载会议元信息、文档字段（目标/议程/笔记/纪要等）、
//  音频文件名，并级联持有转录片段与行动项两个一对多关系。
//  所属层：模型层（SwiftData @Model）。
//

import Foundation
import SwiftData

// MARK: - 会议状态

/// 会议生命周期状态；rawValue 持久化到 `statusRaw` 字段。
enum MeetingStatus: String, Codable, CaseIterable {
  case draft
  case recording
  case processing
  case completed

  /// 面向用户的中文状态文案。
  var title: String {
    switch self {
    case .draft: "未开始"
    case .recording: "进行中"
    case .processing: "整理中"
    case .completed: "已完成"
    }
  }
}

// MARK: - 数据模型

/// 会议模型：聚合文档内容、转录片段（一对多级联）与行动项（一对多级联）。
@Model
final class MeetingRecord {
  /// 唯一标识；@Attribute(.unique) 保证全局唯一。
  /// 迁移注意：不可改为非 unique 或更换类型，否则需要自定义迁移。
  @Attribute(.unique) var id: UUID
  /// 会议标题。
  var title: String
  /// 记录创建时间；“最近删除”排序依据是 updatedAt 而非此字段。
  var createdAt: Date
  /// 会议开始时间（点击“开始录音”时刷新）。
  var startedAt: Date
  /// 最后更新时间；编辑文档或应用纪要时刷新。
  var updatedAt: Date
  /// 录音时长（秒）；停止录音时由累计计时写入。
  var duration: TimeInterval
  /// MeetingStatus.rawValue 的存储字段；字符串存储便于新增枚举值时轻量迁移。
  var statusRaw: String
  /// 是否收藏（会议库“收藏”分区）。
  var isFavorite: Bool
  /// 软删除标记；置 true 后进入“最近删除”，可恢复。
  var isDeleted: Bool
  /// 会议形式文案（线上会议/线下会议/访谈/导入录音等）。
  var meetingMode: String
  /// 参与者原文（顿号/逗号/换行分隔）；派生 participants 数组。
  var participantsText: String
  /// 标签原文（顿号/逗号/换行分隔）；派生 tags 数组，用于搜索匹配。
  var tagsText: String
  /// 议程多行文本。
  var agenda: String
  /// 会议目标。
  var goal: String
  /// 个人笔记；录音标记（🔖）追加到这里，AI 纪要不覆盖此字段。
  var personalNotes: String
  /// AI 纪要 Markdown 文本（可编辑）。
  var summaryText: String
  /// 关键决策（每行一条）。
  var decisionsText: String
  /// 未决问题（每行一条）。
  var openQuestionsText: String
  /// 风险（每行一条）。
  var risksText: String
  /// 下一步（每行一条）。
  var nextStepsText: String
  /// 录音/导入音频的文件名（文件位于 Application Support 下）。
  var audioFilename: String?
  /// 最近一次应用 AI 纪要的时间；实时纪要卡片展示用。
  var lastSummaryAt: Date?

  /// 转录片段（一对多）；deleteRule .cascade 表示删除会议时一并删除全部片段，
  /// inverse 指向 TranscriptSegmentRecord.meeting 完成双向绑定。
  /// 迁移注意：关系名与 inverse 键路径不可修改，否则需要自定义 SchemaMigration。
  @Relationship(deleteRule: .cascade, inverse: \TranscriptSegmentRecord.meeting)
  var transcriptSegments: [TranscriptSegmentRecord]

  /// 行动项（一对多）；deleteRule .cascade 表示删除会议时一并删除全部行动项。
  /// 迁移注意：同上，关系名与 inverse 必须与历史版本保持一致。
  @Relationship(deleteRule: .cascade, inverse: \ActionItemRecord.meeting)
  var actionItems: [ActionItemRecord]

  // MARK: - 初始化

  /// 创建会议记录；updatedAt 初始化为 createdAt，状态默认草稿。
  /// - Parameters:
  ///   - title: 会议标题（必填）。
  ///   - status: 初始状态，默认 .draft。
  ///   - transcriptSegments: 初始转录片段，默认空（通常后续 append 挂载）。
  ///   - actionItems: 初始行动项，默认空。
  init(
    id: UUID = UUID(),
    title: String,
    createdAt: Date = .now,
    startedAt: Date = .now,
    duration: TimeInterval = 0,
    status: MeetingStatus = .draft,
    isFavorite: Bool = false,
    isDeleted: Bool = false,
    meetingMode: String = "线下会议",
    participantsText: String = "",
    tagsText: String = "",
    agenda: String = "",
    goal: String = "",
    personalNotes: String = "",
    summaryText: String = "",
    decisionsText: String = "",
    openQuestionsText: String = "",
    risksText: String = "",
    nextStepsText: String = "",
    audioFilename: String? = nil,
    transcriptSegments: [TranscriptSegmentRecord] = [],
    actionItems: [ActionItemRecord] = []
  ) {
    self.id = id
    self.title = title
    self.createdAt = createdAt
    self.startedAt = startedAt
    self.updatedAt = createdAt
    self.duration = duration
    statusRaw = status.rawValue
    self.isFavorite = isFavorite
    self.isDeleted = isDeleted
    self.meetingMode = meetingMode
    self.participantsText = participantsText
    self.tagsText = tagsText
    self.agenda = agenda
    self.goal = goal
    self.personalNotes = personalNotes
    self.summaryText = summaryText
    self.decisionsText = decisionsText
    self.openQuestionsText = openQuestionsText
    self.risksText = risksText
    self.nextStepsText = nextStepsText
    self.audioFilename = audioFilename
    self.transcriptSegments = transcriptSegments
    self.actionItems = actionItems
  }

  // MARK: - 派生属性

  /// 状态的类型安全读写；非法存储值回退 .draft。
  var status: MeetingStatus {
    get { MeetingStatus(rawValue: statusRaw) ?? .draft }
    set { statusRaw = newValue.rawValue }
  }

  /// 按顿号/中英文逗号/换行拆分 participantsText 得到参与者数组（过滤空项）。
  var participants: [String] {
    participantsText
      .split(whereSeparator: { $0 == "、" || $0 == "," || $0 == "，" || $0.isNewline })
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
  }

  /// 按 participantsText 同样的分隔规则拆分 tagsText 得到标签数组。
  var tags: [String] {
    tagsText
      .split(whereSeparator: { $0 == "、" || $0 == "," || $0 == "，" || $0.isNewline })
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
  }

  /// 按 startTime 升序排列的转录片段（播放器同步、导出共用）。
  var orderedSegments: [TranscriptSegmentRecord] {
    transcriptSegments.sorted { $0.startTime < $1.startTime }
  }

  /// 排序后的行动项：有截止日期者按日期升序在前，无日期者按创建时间在后。
  var orderedActionItems: [ActionItemRecord] {
    actionItems.sorted {
      switch ($0.dueDate, $1.dueDate) {
      case (.some(let lhs), .some(let rhs)): lhs < rhs
      case (.some, .none): true
      case (.none, .some): false
      case (.none, .none): $0.createdAt < $1.createdAt
      }
    }
  }

  /// 全部定稿转录按序拼接成的纯文本（纪要引擎与搜索共用）。
  var transcriptText: String {
    orderedSegments.map(\.text).joined(separator: "\n")
  }

  // MARK: - 纪要应用

  /// 把一次 SummaryDraft 结果写回会议，并增量补录不重复的行动项。
  ///
  /// - Parameter summary: 结构化纪要草稿。
  /// - 副作用：直接修改模型字段（summaryText/decisionsText 等）并刷新
  ///   lastSummaryAt 与 updatedAt；仅追加标题尚不存在的新行动项。调用方负责 save()。
  func apply(summary: SummaryDraft) {
    summaryText = summary.markdown
    decisionsText = summary.decisions.map { "• \($0)" }.joined(separator: "\n")
    openQuestionsText = summary.openQuestions.map { "• \($0)" }.joined(separator: "\n")
    risksText = summary.risks.map { "• \($0)" }.joined(separator: "\n")
    nextStepsText = summary.nextSteps.map { "• \($0)" }.joined(separator: "\n")
    lastSummaryAt = .now
    updatedAt = .now

    // 以标题去重，避免重复应用纪要时生成重复行动项。
    let existingTitles = Set(actionItems.map(\.title))
    for title in summary.actionItems where !existingTitles.contains(title) {
      actionItems.append(ActionItemRecord(title: title, meeting: self))
    }
  }
}
