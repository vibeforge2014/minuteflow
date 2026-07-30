import Foundation

enum MeetingExportFormat: String, CaseIterable, Identifiable {
  case markdown = "Markdown"
  case text = "TXT"
  case subtitles = "SRT"
  case backup = "JSON 备份"

  var id: String { rawValue }

  var fileExtension: String {
    switch self {
    case .markdown: "md"
    case .text: "txt"
    case .subtitles: "srt"
    case .backup: "json"
    }
  }
}

struct ExportService {
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
  }

  private struct TranscriptBackup: Codable {
    let startTime: TimeInterval
    let endTime: TimeInterval
    let speaker: String
    let text: String
  }

  private struct ActionBackup: Codable {
    let title: String
    let owner: String
    let dueDate: Date?
    let status: String
  }

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
        }
      )
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
      encoder.dateEncodingStrategy = .iso8601
      try encoder.encode(backup).write(to: url, options: .atomic)
    }
    return url
  }

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

  private func plainText(_ meeting: MeetingRecord) -> String {
    markdown(meeting)
      .replacingOccurrences(of: #"^#+\s*"#, with: "", options: [.regularExpression])
  }

  private func srt(_ meeting: MeetingRecord) -> String {
    meeting.orderedSegments.enumerated().map { index, segment in
      let fallbackEnd = max(segment.startTime + 3, segment.endTime)
      return """
        \(index + 1)
        \(srtTime(segment.startTime)) --> \(srtTime(fallbackEnd))
        \(segment.speaker)：\(segment.text)
        """
    }
    .joined(separator: "\n\n")
  }

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
