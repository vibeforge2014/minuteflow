//
//  MeetingQuickStart.swift
//  MeetingAssistant
//
//  零填写快速开会：所有「新建会议」入口共用的默认内容与录音启动。
//  固定「线下会议」麦克风模式（不区分线上线下，无系统权限墙），
//  创建后立即录音转录，第一时间捕捉会议内容；完整表单通过「详细新建…」显式进入。
//  所属层：服务层（SwiftData 落盘 + 录音协调，无 UI）。
//

import SwiftData
import SwiftUI

// MARK: - 缺口补转落盘

/// 识别缺口补转的落盘出口：录音启动方（RecorderBar 与快速开会入口）共用。
/// 段落按时间序并入会议转录并保存 SwiftData；静默进行，失败不拖累录音。
@MainActor
enum TranscriptGapBackfill {
  static func append(
    _ paragraphs: [NaturalTranscriptParagraph],
    to meeting: MeetingRecord,
    in context: ModelContext
  ) {
    let fresh = paragraphs.filter {
      !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    guard !fresh.isEmpty else { return }
    withAnimation(ContentMotion.quick) {
      for paragraph in fresh {
        meeting.transcriptSegments.append(
          TranscriptSegmentRecord(
            id: paragraph.id,
            startTime: paragraph.startTime,
            endTime: paragraph.endTime,
            speaker: paragraph.speaker,
            text: paragraph.text,
            isFinal: true,
            meeting: meeting
          )
        )
      }
      // 补转段落的时间可能早于已有段（缺口在录音中段），按时间轴重排保持阅读顺序。
      meeting.transcriptSegments.sort { $0.startTime < $1.startTime }
    }
    meeting.updatedAt = .now
    try? context.save()
  }
}

// MARK: - 快速开会

enum MeetingQuickStart {
  /// 快速会议默认标题：快速会议 M月d日 HH:mm（月日不补零，时分补零，与桌面端一致）。
  static func title(at date: Date = .now) -> String {
    let parts = Calendar.current.dateComponents([.month, .day, .hour, .minute], from: date)
    func two(_ value: Int?) -> String {
      let text = String(value ?? 0)
      return text.count < 2 ? "0\(text)" : text
    }
    return "快速会议 \(parts.month ?? 1)月\(parts.day ?? 1)日 \(two(parts.hour)):\(two(parts.minute))"
  }

  /// 创建零填写会议并立即启动录音转录；返回会议供调用方导航。
  /// 模式固定「线下会议」、参与者「我」；启动失败时会议保留为草稿，错误交给调用方展示。
  /// - 副作用：插入 SwiftData 并多次保存；更新 appState.selectedMeetingID；
  ///   启动 AVAudioEngine/Speech 会话（可能触发权限弹窗）。
  @MainActor
  static func createAndStartRecording(
    in context: ModelContext,
    appState: AppState,
    recorder: RecordingCoordinator,
    preferences: AppPreferences
  ) async throws -> MeetingRecord {
    let meeting = MeetingRecord(
      title: title(),
      startedAt: .now,
      meetingMode: "线下会议",
      participantsText: "我"
    )
    context.insert(meeting)
    try? context.save()
    appState.selectedMeetingID = meeting.id
    try await recorder.start(
      meetingID: meeting.id,
      language: preferences.language,
      summaryInterval: preferences.summaryIntervalSeconds,
      onGapBackfill: { paragraphs in
        TranscriptGapBackfill.append(paragraphs, to: meeting, in: context)
      }
    )
    meeting.startedAt = .now
    meeting.status = .recording
    meeting.updatedAt = .now
    try? context.save()
    return meeting
  }
}
