//
//  ExportService.swift
//  MeetingAssistant
//
//  导出服务：把会议渲染为 Markdown / 纯文本 / SRT 字幕 / JSON 备份四种格式，
//  写入临时目录后交给系统分享面板（UIActivityViewController）。
//  所属层：服务层（无状态结构体）。
//

import Foundation
import SwiftUI

// MARK: - 导出格式

/// 支持的导出格式及其文件扩展名。
enum MeetingExportFormat: String, CaseIterable, Identifiable {
  case markdown = "Markdown"
  case text = "TXT"
  case subtitles = "SRT"
  case backup = "JSON 备份"
  case visualPNG = "视觉纪要图"

  var id: String { rawValue }

  /// 各格式对应的文件扩展名。
  var fileExtension: String {
    switch self {
    case .markdown: "md"
    case .text: "txt"
    case .subtitles: "srt"
    case .backup: "json"
    case .visualPNG: "png"
    }
  }
}

// MARK: - 导出服务

/// 导出器：由会议文档视图的分享菜单调用。
struct ExportService {
  // MARK: - 备份 DTO

  /// JSON 备份的会议载荷（独立于 SwiftData 模型的 Codable DTO）。
  private struct MeetingBackup: Codable {
    let title: String
    let startedAt: Date
    let duration: TimeInterval
    let participants: [String]
    let agenda: String
    let goal: String
    let notes: String
    let summary: String
    let transcript: [TranscriptBackup]
    let actionItems: [ActionBackup]
    let visualSummary: VisualSummary?
  }

  /// 备份中的转录片段 DTO。
  private struct TranscriptBackup: Codable {
    let startTime: TimeInterval
    let endTime: TimeInterval
    let speaker: String
    let text: String
  }

  /// 备份中的行动项 DTO。
  private struct ActionBackup: Codable {
    let title: String
    let owner: String
    let dueDate: Date?
    let status: String
  }

  // MARK: - 导出入口

  /// 生成导出文件。
  ///
  /// - Parameters:
  ///   - meeting: 目标会议。
  ///   - format: 目标格式。
  /// - Returns: 临时目录中的文件 URL。
  /// - 副作用：按需创建 tmp/MeetingAssistantExports 目录并写文件（同名覆盖）。
  @MainActor
  func makeFile(
    meeting: MeetingRecord,
    format: MeetingExportFormat
  ) throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("MeetingAssistantExports", isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    // 去掉文件系统非法字符，用标题作为导出文件名。
    let safeName = meeting.title
      .replacingOccurrences(of: "/", with: "-")
      .replacingOccurrences(of: ":", with: "-")
    let url = directory.appendingPathComponent(
      "\(safeName).\(format.fileExtension)"
    )

    switch format {
    case .markdown:
      try markdown(meeting).write(
        to: url,
        atomically: true,
        encoding: .utf8
      )
    case .text:
      try plainText(meeting).write(
        to: url,
        atomically: true,
        encoding: .utf8
      )
    case .subtitles:
      try srt(meeting).write(
        to: url,
        atomically: true,
        encoding: .utf8
      )
    case .backup:
      // JSON 备份：结构化字段 + 转录 + 行动项，ISO 8601 日期、键排序、易读缩进。
      let backup = MeetingBackup(
        title: meeting.title,
        startedAt: meeting.startedAt,
        duration: meeting.duration,
        participants: meeting.participants,
        agenda: meeting.agenda,
        goal: meeting.goal,
        notes: meeting.personalNotes,
        summary: meeting.summaryText,
        transcript: meeting.orderedSegments.map {
          TranscriptBackup(
            startTime: $0.startTime,
            endTime: $0.endTime,
            speaker: $0.speaker,
            text: $0.text
          )
        },
        actionItems: meeting.orderedActionItems.map {
          ActionBackup(
            title: $0.title,
            owner: $0.owner,
            dueDate: $0.dueDate,
            status: $0.status.title
          )
        },
        visualSummary: meeting.visualSummary
      )
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
      encoder.dateEncodingStrategy = .iso8601
      try encoder.encode(backup).write(to: url, options: .atomic)
    case .visualPNG:
      guard let visual = meeting.visualSummary, !visual.stale else {
        throw CocoaError(.fileNoSuchFile, userInfo: [NSLocalizedDescriptionKey: "这场会议还没有可导出的视觉纪要"])
      }
      let renderer = ImageRenderer(
        content: VisualSummaryPoster(meeting: meeting, visual: visual)
          .frame(width: 1_200)
          .fixedSize(horizontal: false, vertical: true)
          .padding(48)
          .background(Color.white)
      )
      renderer.proposedSize = ProposedViewSize(width: 1_296, height: nil)
      renderer.scale = 4.0 / 3.0
      guard let data = renderer.uiImage?.pngData() else {
        throw CocoaError(.fileWriteUnknown, userInfo: [NSLocalizedDescriptionKey: "无法生成视觉纪要图片"])
      }
      try data.write(to: url, options: .atomic)
    }
    return url
  }

  // MARK: - 私有渲染

  /// 渲染 Markdown 版会议文档（元信息 + 各章节 + 带时间戳的转录）。
  private func markdown(_ meeting: MeetingRecord) -> String {
    """
    # \(meeting.title)

    - 时间：\(meeting.startedAt.formatted(date: .abbreviated, time: .shortened))
    - 参与者：\(meeting.participants.joined(separator: "、"))
    - 时长：\(MeetingFormatters.timestamp(meeting.duration))

    ## 会议目标
    \(meeting.goal)

    ## 议程
    \(meeting.agenda)

    ## 我的记录
    \(meeting.personalNotes)

    ## 会议纪要
    \(meeting.summaryText)

    ## 决策
    \(meeting.decisionsText)

    ## 未决问题
    \(meeting.openQuestionsText)

    ## 风险
    \(meeting.risksText)

    ## 下一步
    \(meeting.nextStepsText)

    ## 转录
    \(meeting.orderedSegments.map { "[\(MeetingFormatters.timestamp($0.startTime))] \($0.speaker)：\($0.text)" }.joined(separator: "\n\n"))
    """
  }

  /// 由 Markdown 去掉标题井号前缀得到纯文本版。
  private func plainText(_ meeting: MeetingRecord) -> String {
    markdown(meeting)
      .replacingOccurrences(of: #"^#+\s*"#, with: "", options: [.regularExpression])
  }

  /// 渲染 SRT 字幕（序号、时间轴、说话人 + 文本）。
  private func srt(_ meeting: MeetingRecord) -> String {
    meeting.orderedSegments.enumerated().map { index, segment in
      // 片段缺结束时间时以“开始 + 3 秒”兜底，保证时间轴合法。
      let fallbackEnd = max(segment.startTime + 3, segment.endTime)
      return """
        \(index + 1)
        \(srtTime(segment.startTime)) --> \(srtTime(fallbackEnd))
        \(segment.speaker)：\(segment.text)
        """
    }
    .joined(separator: "\n\n")
  }

  /// 秒 → "HH:mm:ss,SSS" 的 SRT 时间码（负数归零）。
  private func srtTime(_ interval: TimeInterval) -> String {
    let milliseconds = max(0, Int(interval * 1_000))
    let hours = milliseconds / 3_600_000
    let minutes = (milliseconds % 3_600_000) / 60_000
    let seconds = (milliseconds % 60_000) / 1_000
    let remainder = milliseconds % 1_000
    return String(
      format: "%02d:%02d:%02d,%03d",
      hours,
      minutes,
      seconds,
      remainder
    )
  }
}
