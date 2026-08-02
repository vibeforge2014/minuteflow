import SwiftData
import SwiftUI

struct InsightPanelView: View {
  @Environment(AppState.self) private var appState
  let meeting: MeetingRecord

  var body: some View {
    @Bindable var appState = appState

    VStack(spacing: 0) {
      HStack {
        Picker("侧边栏内容", selection: $appState.inspectorTab) {
          ForEach(AppState.InspectorTab.allCases) { tab in
            Text(tab.rawValue).tag(tab)
          }
        }
        .pickerStyle(.segmented)
        Spacer(minLength: 8)
      }
      .padding(14)
      .background(MeetingTheme.surface)
      Divider()

      switch appState.inspectorTab {
      case .transcript:
        TranscriptPanelView(meeting: meeting)
      case .summary:
        SummaryPanelView(meeting: meeting)
      }
    }
    .background(MeetingTheme.surface)
    .navigationSplitViewColumnWidth(min: 300, ideal: 350, max: 430)
  }
}

struct TranscriptPanelView: View {
  @Environment(RecordingCoordinator.self) private var recorder
  let meeting: MeetingRecord

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          HStack {
            Label("实时转录", systemImage: "waveform")
              .font(.caption.weight(.semibold))
              .foregroundStyle(MeetingTheme.primary)
            Spacer()
            Text("\(meeting.orderedSegments.count) 段")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 12)

          ForEach(meeting.orderedSegments) { segment in
            TranscriptSegmentRow(segment: segment)
              .id(segment.id)
            Divider()
              .padding(.leading, 54)
          }

          if recorder.activeMeetingID == meeting.id,
            !recorder.liveTranscript.isEmpty
          {
            LiveTranscriptRow(
              timestamp: TimeInterval(recorder.elapsedSeconds),
              text: recorder.liveTranscript
            )
            .id("live-transcript")
          }

          if meeting.orderedSegments.isEmpty && recorder.liveTranscript.isEmpty {
            ContentUnavailableView(
              "等待转录",
              systemImage: "waveform",
              description: Text("开始录音后，临时文本会显示在这里")
            )
            .frame(minHeight: 260)
          }
        }
      }
      .scrollDismissesKeyboard(.interactively)
      .onChange(of: recorder.liveTranscript) { _, _ in
        withAnimation(.easeOut(duration: 0.2)) {
          proxy.scrollTo("live-transcript", anchor: .bottom)
        }
      }
    }
  }
}

private struct TranscriptSegmentRow: View {
  @Bindable var segment: TranscriptSegmentRecord

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Text(MeetingFormatters.timestamp(segment.startTime))
        .font(.caption.monospacedDigit())
        .foregroundStyle(.tertiary)
        .frame(width: 40, alignment: .leading)

      VStack(alignment: .leading, spacing: 6) {
        Menu {
          ForEach(["我", "Speaker 1", "Speaker 2", "刘婷", "周哲"], id: \.self) { name in
            Button(name) { segment.speaker = name }
          }
        } label: {
          HStack(spacing: 4) {
            Text(segment.speaker)
              .font(.caption.weight(.semibold))
              .foregroundStyle(speakerColor)
            Image(systemName: "chevron.down")
              .font(.caption2)
              .foregroundStyle(.tertiary)
          }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("说话人 \(segment.speaker)，点按修改")

        TextField("转录内容", text: $segment.text, axis: .vertical)
          .font(.subheadline)
          .textFieldStyle(.plain)
      }

      Image(systemName: segment.isFinal ? "checkmark.circle" : "ellipsis.circle")
        .font(.caption)
        .foregroundStyle(
          segment.isFinal
            ? Color.secondary.opacity(0.45)
            : MeetingTheme.primary
        )
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
  }

  private var speakerColor: Color {
    switch segment.speaker {
    case "我": MeetingTheme.primary
    case "刘婷": MeetingTheme.speakerViolet
    case "周哲": MeetingTheme.warning
    default: .secondary
    }
  }
}

private struct LiveTranscriptRow: View {
  let timestamp: TimeInterval
  let text: String

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Text(MeetingFormatters.timestamp(timestamp))
        .font(.caption.monospacedDigit())
        .foregroundStyle(.tertiary)
        .frame(width: 40, alignment: .leading)
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
          Text("我")
            .font(.caption.weight(.semibold))
            .foregroundStyle(MeetingTheme.primary)
          Text("临时转写中")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        Text(text)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
      Spacer()
      ProgressView()
        .controlSize(.small)
    }
    .padding(14)
    .background(MeetingTheme.primarySoft)
  }
}

struct SummaryPanelView: View {
  @Environment(\.modelContext) private var modelContext
  @Environment(RecordingCoordinator.self) private var recorder
  @Environment(AppPreferences.self) private var preferences
  @Bindable var meeting: MeetingRecord
  @State private var isSummarizing = false
  @State private var errorMessage: String?

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 14) {
        HStack {
          VStack(alignment: .leading, spacing: 3) {
            Text("结构化会议纪要")
              .font(.headline)
            Text("结合定稿转录与我的记录")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          Spacer()
          Button {
            Task { await summarize() }
          } label: {
            if isSummarizing {
              ProgressView()
                .controlSize(.small)
            } else {
              Label("更新", systemImage: "sparkles")
            }
          }
          .buttonStyle(.borderedProminent)
          .disabled(isSummarizing)
        }

        SummarySectionCard(
          title: "关键决策",
          systemImage: "checkmark.seal",
          text: $meeting.decisionsText
        )
        SummarySectionCard(
          title: "未决问题",
          systemImage: "questionmark.bubble",
          text: $meeting.openQuestionsText
        )
        SummarySectionCard(
          title: "风险",
          systemImage: "exclamationmark.triangle",
          text: $meeting.risksText
        )
        SummarySectionCard(
          title: "下一步",
          systemImage: "arrow.right.circle",
          text: $meeting.nextStepsText
        )

        if meeting.summaryText.isEmpty {
          ContentUnavailableView(
            "尚未生成纪要",
            systemImage: "sparkles",
            description: Text("开始录音后每两分钟自动更新，也可以手动生成")
          )
          .frame(minHeight: 180)
        }
      }
      .padding(16)
      .padding(.bottom, 90)
    }
    .alert(
      "纪要更新失败",
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

  private func summarize() async {
    isSummarizing = true
    defer { isSummarizing = false }
    do {
      let transcript =
        meeting.transcriptText
        + (recorder.activeMeetingID == meeting.id ? "\n\(recorder.liveTranscript)" : "")
      let draft = try await SummaryService().summarize(
        transcript: transcript,
        notes: meeting.personalNotes,
        preferences: preferences
      )
      meeting.apply(summary: draft)
      try modelContext.save()
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}

private struct SummarySectionCard: View {
  let title: String
  let systemImage: String
  @Binding var text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      Label(title, systemImage: systemImage)
        .font(.subheadline.weight(.semibold))
      TextEditor(text: $text)
        .scrollContentBackground(.hidden)
        .font(.subheadline)
        .frame(minHeight: 72)
    }
    .padding(13)
    .background(
      MeetingTheme.surfaceRaised,
      in: RoundedRectangle(cornerRadius: 12)
    )
  }
}
