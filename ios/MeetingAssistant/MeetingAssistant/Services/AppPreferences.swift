import Foundation
import Observation

enum SummaryProviderKind: String, CaseIterable, Identifiable {
  case local = "本地基础纪要"
  case openAICompatible = "OpenAI 兼容接口"

  var id: String { rawValue }
}

enum TranscriptionProviderKind: String, CaseIterable, Identifiable {
  case appleSpeech = "Apple Speech"
  case remoteWhisper = "远程 Whisper"

  var id: String { rawValue }
}

@MainActor
@Observable
final class AppPreferences {
  @ObservationIgnored private let defaults: UserDefaults

  private enum Key {
    static let summaryProvider = "model.summary.provider"
    static let summaryBaseURL = "model.summary.baseURL"
    static let summaryModel = "model.summary.model"
    static let transcriptionProvider = "model.transcription.provider"
    static let transcriptionBaseURL = "model.transcription.baseURL"
    static let transcriptionModel = "model.transcription.model"
    static let language = "model.transcription.language"
    static let summaryInterval = "meeting.summary.interval"
    static let hasCompletedOnboarding = "app.hasCompletedOnboarding"
  }

  var summaryProvider: SummaryProviderKind {
    didSet { persist() }
  }

  var summaryBaseURL: String {
    didSet { persist() }
  }

  var summaryModel: String {
    didSet { persist() }
  }

  var transcriptionProvider: TranscriptionProviderKind {
    didSet { persist() }
  }

  var transcriptionBaseURL: String {
    didSet { persist() }
  }

  var transcriptionModel: String {
    didSet { persist() }
  }

  var language: String {
    didSet { persist() }
  }

  var summaryIntervalSeconds: Int {
    didSet { persist() }
  }

  var hasCompletedOnboarding: Bool {
    didSet { persist() }
  }

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    summaryProvider =
      SummaryProviderKind(
        rawValue: defaults.string(forKey: Key.summaryProvider) ?? ""
      ) ?? .local
    summaryBaseURL =
      defaults.string(forKey: Key.summaryBaseURL)
      ?? "https://api.openai.com/v1"
    summaryModel = defaults.string(forKey: Key.summaryModel) ?? "gpt-4.1-mini"
    transcriptionProvider =
      TranscriptionProviderKind(
        rawValue: defaults.string(forKey: Key.transcriptionProvider) ?? ""
      ) ?? .appleSpeech
    transcriptionBaseURL =
      defaults.string(forKey: Key.transcriptionBaseURL)
      ?? "https://api.openai.com/v1"
    transcriptionModel =
      defaults.string(forKey: Key.transcriptionModel)
      ?? "whisper-1"
    language = defaults.string(forKey: Key.language) ?? "zh-CN"
    let storedInterval = defaults.integer(forKey: Key.summaryInterval)
    summaryIntervalSeconds = storedInterval > 0 ? storedInterval : 120
    hasCompletedOnboarding = defaults.bool(forKey: Key.hasCompletedOnboarding)
    if ProcessInfo.processInfo.arguments.contains("UI_TESTING") {
      hasCompletedOnboarding = true
    }
  }

  private func persist() {
    defaults.set(summaryProvider.rawValue, forKey: Key.summaryProvider)
    defaults.set(summaryBaseURL, forKey: Key.summaryBaseURL)
    defaults.set(summaryModel, forKey: Key.summaryModel)
    defaults.set(transcriptionProvider.rawValue, forKey: Key.transcriptionProvider)
    defaults.set(transcriptionBaseURL, forKey: Key.transcriptionBaseURL)
    defaults.set(transcriptionModel, forKey: Key.transcriptionModel)
    defaults.set(language, forKey: Key.language)
    defaults.set(summaryIntervalSeconds, forKey: Key.summaryInterval)
    defaults.set(hasCompletedOnboarding, forKey: Key.hasCompletedOnboarding)
  }
}
