//
//  ActionItemRecord.swift
//  MeetingAssistant
//
//  行动项 SwiftData 模型：记录一条从会议中提炼出的待办（标题、负责人、
//  截止日期、状态），并反向关联所属会议；删除会议时按级联规则一并删除。
//  所属层：模型层（SwiftData @Model）。
//

import Foundation
import SwiftData

// MARK: - 行动项状态

/// 行动项三档进度状态；rawValue 持久化到 `statusRaw` 字段。
enum ActionItemStatus: String, Codable, CaseIterable {
  case todo
  case inProgress
  case done

  /// 面向用户的中文状态文案。
  var title: String {
    switch self {
    case .todo: "未开始"
    case .inProgress: "进行中"
    case .done: "已完成"
    }
  }
}

// MARK: - 数据模型

/// 行动项模型；每条行动项可选地归属一场会议（多对一关系）。
@Model
final class ActionItemRecord {
  /// 唯一标识；@Attribute(.unique) 保证全局不重复。
  /// 迁移注意：unique 约束与 UUID 类型不可变更，存量数据若出现重复值会导致
  /// 轻量迁移失败，需先清洗再迁移。
  @Attribute(.unique) var id: UUID
  /// 行动项标题（就地可编辑）。
  var title: String
  /// 负责人姓名；空字符串表示未指派。
  var owner: String
  /// 截止日期；nil 表示未设置。
  var dueDate: Date?
  /// ActionItemStatus.rawValue 的存储字段；用字符串而非枚举存储以便轻量迁移。
  var statusRaw: String
  /// 创建时间；无截止日期的行动项排序时回退使用。
  var createdAt: Date
  /// 证据转录片段的 ID（指向生成该行动项的 TranscriptSegmentRecord.id）；
  /// 以 ID 弱关联而非 SwiftData 关系，片段删除后此字段悬空但存储不受影响。
  var evidenceSegmentID: UUID?
  /// 所属会议（多对一）；与 MeetingRecord.actionItems 的 inverse 互为双向关联。
  var meeting: MeetingRecord?

  // MARK: - 初始化

  /// 创建一条行动项。
  /// - Parameters:
  ///   - title: 行动项标题。
  ///   - owner: 负责人，默认空（未指派）。
  ///   - dueDate: 截止日期，默认 nil。
  ///   - status: 初始状态，默认未开始。
  ///   - createdAt: 创建时间，默认当前时间。
  ///   - evidenceSegmentID: 证据转录片段 ID，默认 nil。
  ///   - meeting: 所属会议，默认 nil（可稍后挂载）。
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

  // MARK: - 派生属性

  /// 状态的类型安全读写入口；内部转存 statusRaw，非法存储值回退 .todo。
  var status: ActionItemStatus {
    get { ActionItemStatus(rawValue: statusRaw) ?? .todo }
    set { statusRaw = newValue.rawValue }
  }
}
