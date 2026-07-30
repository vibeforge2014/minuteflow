import SwiftData
import SwiftUI
import UniformTypeIdentifiers

struct AppRootView: View {
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  @Environment(\.modelContext) private var modelContext
  @Environment(AppState.self) private var appState
  @Environment(RecordingCoordinator.self) private var recorder
  @Environment(AppPreferences.self) private var preferences
  @Environment(AudioImportCoordinator.self) private var importCoordinator
  @Query(sort: \MeetingRecord.startedAt, order: .reverse)
  private var meetings: [MeetingRecord]

  @State private var isFileImporterPresented = false
  @State private var seedError: String?

  var body: some View {
    @Bindable var appState = appState

    Group {
      if horizontalSizeClass == .regular {
        TabletWorkspaceView(
          meetings: activeMeetings,
          onImport: { isFileImporterPresented = true }
        )
      } else {
        PhoneWorkspaceView(
          meetings: activeMeetings,
          onImport: { isFileImporterPresented = true }
        )
      }
    }
    .tint(MeetingTheme.blue)
    .background(MeetingTheme.canvas)
    .sheet(item: $appState.presentedSheet) { sheet in
      switch sheet {
      case .newMeeting:
        NewMeetingView()
      case .settings:
        NavigationStack {
          SettingsView(showsDoneButton: true)
        }
      case .importAudio:
        ImportHelpView {
          appState.presentedSheet = nil
          isFileImporterPresented = true
        }
      }
    }
    .fileImporter(
      isPresented: $isFileImporterPresented,
      allowedContentTypes: [.audio, .movie],
      allowsMultipleSelection: false
    ) { result in
      guard case .success(let urls) = result, let url = urls.first else {
        if case .failure(let error) = result {
          importCoordinator.errorMessage = error.localizedDescription
        }
        return
      }
      Task {
        do {
          let meeting = try await importCoordinator.importAudio(
            from: url,
            preferences: preferences,
            modelContext: modelContext
          )
          appState.selectedMeetingID = meeting.id
        } catch {
          importCoordinator.errorMessage = error.localizedDescription
        }
      }
    }
    .overlay {
      if importCoordinator.isImporting {
        ImportProgressOverlay(text: importCoordinator.progressText)
      }
    }
    .alert(
      "无法导入",
      isPresented: Binding(
        get: { importCoordinator.errorMessage != nil },
        set: { if !$0 { importCoordinator.errorMessage = nil } }
      )
    ) {
      Button("好") { importCoordinator.errorMessage = nil }
    } message: {
      Text(importCoordinator.errorMessage ?? "")
    }
    .alert(
      "本地数据错误",
      isPresented: Binding(
        get: { seedError != nil },
        set: { if !$0 { seedError = nil } }
      )
    ) {
      Button("好") { seedError = nil }
    } message: {
      Text(seedError ?? "")
    }
    .fullScreenCover(
      isPresented: Binding(
        get: { !preferences.hasCompletedOnboarding },
        set: { if !$0 { preferences.hasCompletedOnboarding = true } }
      )
    ) {
      OnboardingView()
    }
    .task {
      do {
        try DemoDataSeeder.seedIfNeeded(modelContext: modelContext)
        if appState.selectedMeetingID == nil {
          appState.selectedMeetingID = activeMeetings.first?.id
        }
      } catch {
        seedError = error.localizedDescription
      }
    }
    .onChange(of: meetings.map(\.id)) { _, _ in
      if appState.selectedMeetingID == nil {
        appState.selectedMeetingID = activeMeetings.first?.id
      }
    }
    .onChange(of: recorder.summaryTick) { _, _ in
      guard let meeting = activeRecordingMeeting else { return }
      Task { await refreshSummary(for: meeting) }
    }
  }

  private var activeMeetings: [MeetingRecord] {
    meetings.filter { !$0.isDeleted }
  }

  private var activeRecordingMeeting: MeetingRecord? {
    guard let id = recorder.activeMeetingID else { return nil }
    return meetings.first { $0.id == id }
  }

  private func refreshSummary(for meeting: MeetingRecord) async {
    do {
      let draft = try await SummaryService().summarize(
        transcript: meeting.transcriptText + "\n" + recorder.liveTranscript,
        notes: meeting.personalNotes,
        preferences: preferences
      )
      meeting.apply(summary: draft)
      try modelContext.save()
    } catch {
      appState.toastMessage = "自动纪要稍后重试：\(error.localizedDescription)"
    }
  }
}

private struct ImportProgressOverlay: View {
  let text: String

  var body: some View {
    ZStack {
      Color.black.opacity(0.18)
        .ignoresSafeArea()
      VStack(spacing: 14) {
        ProgressView()
          .controlSize(.large)
        Text(text)
          .font(.headline)
      }
      .padding(28)
      .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(text)
  }
}

#Preview("iPad") {
  AppRootView()
    .environment(AppState())
    .environment(RecordingCoordinator())
    .environment(AppPreferences())
    .environment(AudioImportCoordinator())
    .modelContainer(
      for: [
        MeetingRecord.self,
        TranscriptSegmentRecord.self,
        ActionItemRecord.self,
      ], inMemory: true)
}
