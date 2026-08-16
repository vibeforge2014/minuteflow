//
//  TranscriptSegmentRecord.swift
//  MeetingAssistant
//
//  转录片段 SwiftData 模型：一段带起止时间戳与说话人名称的转录文本，
//  通过多对一关系挂到所属会议，用于实时转录展示、SRT 导出与纪要生成。
//  所属层：模型层（SwiftData @Model）。
//

import Foundation
import SwiftData

// MARK: - 数据模型

/// 转录片段模型；startTime/endTime 单位为秒（相对会议起点）。
@Model
final class TranscriptSegmentRecord {
  /// 唯一标识；@Attribute(.unique) 供 ForEach/ScrollViewReader 精确定位片段。
  /// 迁移注意：unique UUID 类型不可变更，避免轻量迁移失败。
  @Attribute(.unique) var id: UUID
  /// 片段开始时间（秒）；播放器同步与 SRT 导出使用。
  var startTime: TimeInterval
  /// 片段结束时间（秒）。
  var endTime: TimeInterval
  /// 说话人展示名；可在转录面板中手动改名。
  var speaker: String
  /// 转录文本；可在转录面板内就地编辑。
  var text: String
  /// 是否已定稿；false 表示临时/未确认片段。
  var isFinal: Bool
  /// 创建时间。
  var createdAt: Date
  /// 所属会议（多对一）；与 MeetingRecord.transcriptSegments 互为 inverse。
  /// 迁移注意：关系名与 inverse 键路径不可修改，否则需要自定义迁移。
  var meeting: MeetingRecord?

  // MARK: - 初始化

  /// 创建一条转录片段。
  /// - Parameters:
  ///   - startTime: 开始时间（秒，相对会议起点）。
  ///   - endTime: 结束时间（秒）。
  ///   - speaker: 说话人名称。
  ///   - text: 转录文本。
  ///   - isFinal: 是否定稿，默认 true。
  ///   - createdAt: 创建时间，默认当前时间。
  ///   - meeting: 所属会议，默认 nil。
  init(
    id: UUID = UUID(),
    startTime: TimeInterval,
    endTime: TimeInterval,
    speaker: String,
    text: String,
    isFinal: Bool = true,
    createdAt: Date = .now,
    meeting: MeetingRecord? = nil
  ) {
    self.id = id
    self.startTime = startTime
    self.endTime = endTime
    self.speaker = speaker
    self.text = text
    self.isFinal = isFinal
    self.createdAt = createdAt
    self.meeting = meeting
  }
}
