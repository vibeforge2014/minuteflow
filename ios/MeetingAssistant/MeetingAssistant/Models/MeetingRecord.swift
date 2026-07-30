import Foundation
import SwiftData

enum MeetingStatus: String, Codable, CaseIterable {
  case draft
  case recording
  case processing
  case completed

  var title: String {
    switch self {
    case .draft: "未开始"
    case .recording: "进行中"
    case .processing: "整理中"
    case .completed: "已完成"
    }
  }
}

@Model
final class MeetingRecord {
  @Attribute(.unique) var id: UUID
  var title: String
  var createdAt: Date
  var startedAt: Date
  var updatedAt: Date
  var duration: TimeInterval
  var statusRaw: String
  var isFavorite: Bool
  var isDeleted: Bool
  var meetingMode: String
  var participantsText: String
  var tagsText: String
  var agenda: String
  var goal: String
  var personalNotes: String
  var summaryText: String
  var decisionsText: String
  var openQuestionsText: String
  var risksText: String
  var nextStepsText: String
  var audioFilename: String?
  var lastSummaryAt: Date?

  @Relationship(deleteRule: .cascade, inverse: \TranscriptSegmentRecord.meeting)
  var transcriptSegments: [TranscriptSegmentRecord]

  @Relationship(deleteRule: .cascade, inverse: \ActionItemRecord.meeting)
  var actionItems: [ActionItemRecord]

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

  var status: MeetingStatus {
    get { MeetingStatus(rawValue: statusRaw) ?? .draft }
    set { statusRaw = newValue.rawValue }
  }

  var participants: [String] {
    participantsText
      .split(whereSeparator: { $0 == "、" || $0 == "," || $0 == "，" || $0.isNewline })
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
  }

  var tags: [String] {
    tagsText
      .split(whereSeparator: { $0 == "、" || $0 == "," || $0 == "，" || $0.isNewline })
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
  }

  var orderedSegments: [TranscriptSegmentRecord] {
    transcriptSegments.sorted { $0.startTime < $1.startTime }
  }

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

  var transcriptText: String {
    orderedSegments.map(\.text).joined(separator: "\n")
  }

  func apply(summary: SummaryDraft) {
    summaryText = summary.markdown
    decisionsText = summary.decisions.map { "• \($0)" }.joined(separator: "\n")
    openQuestionsText = summary.openQuestions.map { "• \($0)" }.joined(separator: "\n")
    risksText = summary.risks.map { "• \($0)" }.joined(separator: "\n")
    nextStepsText = summary.nextSteps.map { "• \($0)" }.joined(separator: "\n")
    lastSummaryAt = .now
    updatedAt = .now

    let existingTitles = Set(actionItems.map(\.title))
    for title in summary.actionItems where !existingTitles.contains(title) {
      actionItems.append(ActionItemRecord(title: title, meeting: self))
    }
  }
}
