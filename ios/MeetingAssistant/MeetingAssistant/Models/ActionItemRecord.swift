import Foundation
import SwiftData

enum ActionItemStatus: String, Codable, CaseIterable {
  case todo
  case inProgress
  case done

  var title: String {
    switch self {
    case .todo: "未开始"
    case .inProgress: "进行中"
    case .done: "已完成"
    }
  }
}

@Model
final class ActionItemRecord {
  @Attribute(.unique) var id: UUID
  var title: String
  var owner: String
  var dueDate: Date?
  var statusRaw: String
  var createdAt: Date
  var evidenceSegmentID: UUID?
  var meeting: MeetingRecord?

  init(
    id: UUID = UUID(),
    title: String,
    owner: String = "",
    dueDate: Date? = nil,
    status: ActionItemStatus = .todo,
    createdAt: Date = .now,
    evidenceSegmentID: UUID? = nil,
    meeting: MeetingRecord? = nil
  ) {
    self.id = id
    self.title = title
    self.owner = owner
    self.dueDate = dueDate
    statusRaw = status.rawValue
    self.createdAt = createdAt
    self.evidenceSegmentID = evidenceSegmentID
    self.meeting = meeting
  }

  var status: ActionItemStatus {
    get { ActionItemStatus(rawValue: statusRaw) ?? .todo }
    set { statusRaw = newValue.rawValue }
  }
}
