import SwiftData
import SwiftUI

@main
struct MeetingAssistantApp: App {
  private let modelContainer: ModelContainer
  @State private var appState = AppState()
  @State private var recorder = RecordingCoordinator()
  @State private var preferences = AppPreferences()
  @State private var importCoordinator = AudioImportCoordinator()

  init() {
    do {
      let schema = Schema([
        MeetingRecord.self,
        TranscriptSegmentRecord.self,
        ActionItemRecord.self,
      ])
      let configuration = ModelConfiguration(
        "MeetingAssistant",
        schema: schema,
        isStoredInMemoryOnly: false
      )
      modelContainer = try ModelContainer(
        for: schema,
        configurations: [configuration]
      )
    } catch {
      fatalError("无法创建本地会议数据库：\(error.localizedDescription)")
    }
  }

  var body: some Scene {
    WindowGroup {
      AppRootView()
        .environment(appState)
        .environment(recorder)
        .environment(preferences)
        .environment(importCoordinator)
    }
    .modelContainer(modelContainer)
  }
}
