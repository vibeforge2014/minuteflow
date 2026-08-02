import SwiftData
import SwiftUI

struct RecorderBar: View {
  @Environment(\.modelContext) private var modelContext
  @Environment(RecordingCoordinator.self) private var recorder
  @Environment(AppPreferences.self) private var preferences
  let meeting: MeetingRecord

  @State private var errorMessage: String?
  @State private var isFinishing = false

  var body: some View {
    HStack(spacing: 14) {
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

  private var isCurrentSession: Bool {
    recorder.isRecording && recorder.activeMeetingID == meeting.id
  }

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

  private func addMarker() {
    let timestamp = MeetingFormatters.timestamp(recorder.addMarker())
    let prefix = meeting.personalNotes.isEmpty ? "" : "\n"
    meeting.personalNotes += "\(prefix)🔖 [\(timestamp)] "
    meeting.updatedAt = .now
    try? modelContext.save()
  }

  private func stopAndFinalize() async {
    isFinishing = true
    let elapsed = recorder.elapsedSeconds
    let transcript = recorder.liveTranscript
    let audioName = recorder.audioURL?.lastPathComponent
    recorder.stop()

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
    meeting.duration = TimeInterval(elapsed)
    meeting.audioFilename = audioName
    meeting.status = .processing
    meeting.updatedAt = .now
    try? modelContext.save()

    do {
      let draft = try await SummaryService().summarize(
        transcript: meeting.transcriptText,
        notes: meeting.personalNotes,
        preferences: preferences
      )
      meeting.apply(summary: draft)
      meeting.status = .completed
      try modelContext.save()
    } catch {
      meeting.status = .processing
      errorMessage = "录音已安全保存，最终纪要稍后可重试：\(error.localizedDescription)"
    }
    recorder.clearCompletedSession()
    isFinishing = false
  }
}
