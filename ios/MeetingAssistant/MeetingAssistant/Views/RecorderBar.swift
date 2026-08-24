//
//  RecorderBar.swift
//  MeetingAssistant
//
//  底部悬浮录音工具条：展示录音状态红点与计时、麦克风音量条、
//  标记/暂停/停止（或开始录音）按钮；停止时只固化音频与转录，最终纪要由用户主动生成。
//  所属层：视图层。
//

import SwiftData
import SwiftUI

/// 录音工具条。
/// 导航位置：iPad 以 overlay 悬浮于三栏工作区底部；iPhone 以 safeAreaInset
/// 固定在会议详情页底部。
struct RecorderBar: View {
  // MARK: - 环境与状态

  /// SwiftData 上下文（开始/停止时保存会议）。
  @Environment(\.modelContext) private var modelContext
  /// 录音协调器。
  @Environment(RecordingCoordinator.self) private var recorder
  /// 读取语言与自动纪要间隔。
  @Environment(AppPreferences.self) private var preferences
  /// 绑定的会议。
  let meeting: MeetingRecord

  /// 录音错误文案（alert 展示）。
  @State private var errorMessage: String?
  /// 是否正在停止并固化本地录音（防重复点击）。
  @State private var isFinishing = false

  // MARK: - 视图内容

  var body: some View {
    HStack(spacing: 14) {
      // 当前会话：红点 + 计时；否则显示“准备录音”待机态。
      if isCurrentSession {
        Circle()
          .fill(.red)
          .frame(width: 9, height: 9)
          .shadow(color: .red.opacity(0.4), radius: 4)
        Text(MeetingFormatters.timestamp(TimeInterval(recorder.elapsedSeconds)))
          .font(.headline.monospacedDigit())
          .contentTransition(.numericText())
      } else {
        Image(systemName: "mic.circle.fill")
          .font(.title2)
          .foregroundStyle(MeetingTheme.primary)
        Text("准备录音")
          .font(.subheadline.weight(.semibold))
      }

      Divider()
        .frame(height: 30)

      inputMeter

      Spacer(minLength: 0)

      // 录音中：标记/暂停/停止；待机：开始录音。
      if isCurrentSession {
        Button {
          addMarker()
        } label: {
          Label("标记", systemImage: "bookmark")
        }
        .buttonStyle(.borderless)

        Button {
          togglePause()
        } label: {
          Label(
            recorder.isPaused ? "继续" : "暂停",
            systemImage: recorder.isPaused ? "play.fill" : "pause.fill"
          )
        }
        .buttonStyle(.borderless)

        Button(role: .destructive) {
          Task { await stopAndFinalize() }
        } label: {
          if isFinishing {
            ProgressView()
          } else {
            Label("停止", systemImage: "stop.fill")
          }
        }
        .buttonStyle(.bordered)
        .tint(.red)
        .disabled(isFinishing)
        .accessibilityIdentifier("stop-recording-button")
      } else {
        Button {
          Task { await startRecording() }
        } label: {
          Label("开始录音", systemImage: "record.circle")
        }
        .buttonStyle(.borderedProminent)
        .disabled(recorder.isRecording)
        .accessibilityIdentifier("start-recording-button")
      }
    }
    .font(.subheadline)
    .padding(.horizontal, 16)
    .frame(minHeight: 58)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 15))
    .overlay {
      RoundedRectangle(cornerRadius: 15)
        .stroke(MeetingTheme.divider)
    }
    .shadow(color: .black.opacity(0.1), radius: 14, y: 5)
    // 录音错误提示。
    .alert(
      "录音错误",
      isPresented: Binding(
        get: { errorMessage != nil },
        set: { if !$0 { errorMessage = nil } }
      )
    ) {
      Button("好") { errorMessage = nil }
    } message: {
      Text(errorMessage ?? "")
    }
  }

  // MARK: - 私有属性

  /// 本工具条对应的会议是否正处于当前录音会话。
  private var isCurrentSession: Bool {
    recorder.isRecording && recorder.activeMeetingID == meeting.id
  }

  /// 四格麦克风音量条（按 inputLevel 逐格点亮）。
  private var inputMeter: some View {
    HStack(spacing: 7) {
      Image(systemName: "mic")
        .foregroundStyle(.secondary)
      Text("麦克风")
        .foregroundStyle(.secondary)
      HStack(spacing: 2) {
        ForEach(0..<4, id: \.self) { index in
          Capsule()
            .fill(
              recorder.inputLevel > Float(index) * 0.22
                ? MeetingTheme.success
                : Color.secondary.opacity(0.2)
            )
            .frame(width: 3, height: CGFloat(7 + index * 3))
        }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("麦克风音量 \(Int(recorder.inputLevel * 100))%")
  }

  // MARK: - 私有方法

  /// 开始录音并更新会议状态为进行中。
  /// - 副作用：启动 AVAudioEngine/Speech 会话；修改 meeting 字段并保存 SwiftData。
  private func startRecording() async {
    do {
      try await recorder.start(
        meetingID: meeting.id,
        language: preferences.language,
        summaryInterval: preferences.summaryIntervalSeconds
      )
      meeting.startedAt = .now
      meeting.status = .recording
      meeting.updatedAt = .now
      try modelContext.save()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  /// 在暂停/恢复之间切换。
  private func togglePause() {
    if recorder.isPaused {
      do {
        try recorder.resume()
      } catch {
        errorMessage = error.localizedDescription
      }
    } else {
      recorder.pause()
    }
  }

  /// 在“我的记录”末尾追加带时间戳的书签标记（🔖 [mm:ss] ）。
  /// - 副作用：修改 personalNotes/updatedAt 并保存 SwiftData。
  private func addMarker() {
    let timestamp = MeetingFormatters.timestamp(recorder.addMarker())
    let prefix = meeting.personalNotes.isEmpty ? "" : "\n"
    meeting.personalNotes += "\(prefix)🔖 [\(timestamp)] "
    meeting.updatedAt = .now
    try? modelContext.save()
  }

  /// 停止录音：固化音频文件名与整段实时转录并保存会议，不访问远程模型。
  ///
  /// - 副作用：结束音频/识别会话；追加 TranscriptSegmentRecord；调用纪要服务
  ///   多次保存 SwiftData。最终纪要由 AI 纪要页的用户操作显式触发。
  private func stopAndFinalize() async {
    isFinishing = true
    // 先快照会话数据，再停止协调器（停止后临时状态会被清理）。
    let elapsed = recorder.elapsedSeconds
    let transcript = recorder.liveTranscript
    let audioName = recorder.audioURL?.lastPathComponent
    recorder.stop()

    // 有实时转录时固化为一个完整片段，接续在最后一段之后。
    if !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      let start = meeting.orderedSegments.last?.endTime ?? 0
      meeting.transcriptSegments.append(
        TranscriptSegmentRecord(
          startTime: start,
          endTime: TimeInterval(elapsed),
          speaker: "我",
          text: transcript,
          meeting: meeting
        )
      )
    }
    // 先本地落盘（时长/音频名/状态），再做最终纪要。
    meeting.duration = TimeInterval(elapsed)
    meeting.audioFilename = audioName
    meeting.status = .completed
    meeting.updatedAt = .now
    try? modelContext.save()
    recorder.clearCompletedSession()
    isFinishing = false
  }
}
