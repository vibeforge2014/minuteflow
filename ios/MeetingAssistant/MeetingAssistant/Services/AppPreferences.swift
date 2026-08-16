//
//  AppPreferences.swift
//  MeetingAssistant
//
//  用户偏好服务：集中管理纪要/转录 Provider 选择、接口地址与模型名、识别语言、
//  自动纪要间隔与引导完成标记；所有字段变更即经 UserDefaults 持久化。
//  所属层：服务层（@Observable 环境对象）。
//

import Foundation
import Observation

// MARK: - Provider 枚举

/// 纪要生成方式：本地关键词引擎或 OpenAI 兼容 chat/completions 接口。
enum SummaryProviderKind: String, CaseIterable, Identifiable {
  case local = "本地基础纪要"
  case openAICompatible = "OpenAI 兼容接口"

  var id: String { rawValue }
}

/// 转录方式：Apple Speech（SFSpeechRecognizer）或远程 Whisper 接口。
enum TranscriptionProviderKind: String, CaseIterable, Identifiable {
  case appleSpeech = "Apple Speech"
  case remoteWhisper = "远程 Whisper"

  var id: String { rawValue }
}

// MARK: - 偏好存储

/// 用户偏好容器：任意属性变更即写回 UserDefaults（didSet → persist()）。
@MainActor
@Observable
final class AppPreferences {
  /// UserDefaults 句柄；不参与观察。
  @ObservationIgnored private let defaults: UserDefaults

  // MARK: - 存储键

  /// UserDefaults 键名常量；改名会导致老用户偏好丢失，务必保持稳定。
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

  // MARK: - 偏好属性（每次变更即持久化）

  /// 纪要 Provider；默认本地基础纪要。
  var summaryProvider: SummaryProviderKind {
    didSet { persist() }
  }

  /// OpenAI 兼容纪要接口的 Base URL。
  var summaryBaseURL: String {
    didSet { persist() }
  }

  /// 纪要模型名称。
  var summaryModel: String {
    didSet { persist() }
  }

  /// 转录 Provider；默认 Apple Speech。
  var transcriptionProvider: TranscriptionProviderKind {
    didSet { persist() }
  }

  /// 远程 Whisper 的 Base URL。
  var transcriptionBaseURL: String {
    didSet { persist() }
  }

  /// Whisper 模型名称。
  var transcriptionModel: String {
    didSet { persist() }
  }

  /// 语音识别语言（BCP 47 标记，如 zh-CN）；决定 SFSpeechRecognizer 的 locale。
  var language: String {
    didSet { persist() }
  }

  /// 自动纪要间隔（秒）；录音计时器按该间隔触发 summaryTick。
  var summaryIntervalSeconds: Int {
    didSet { persist() }
  }

  /// 是否已完成首次引导；控制 OnboardingView 的 fullScreenCover。
  var hasCompletedOnboarding: Bool {
    didSet { persist() }
  }

  // MARK: - 初始化

  /// 从 UserDefaults 读取偏好并填充默认值。
  /// - Parameter defaults: 注入的 UserDefaults（默认 .standard，便于测试替换）。
  /// - 副作用：写入内存默认值；带 UI_TESTING 启动参数时强制视为已完成引导，
  ///   以便 UI 测试跳过 Onboarding。
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

  // MARK: - 私有方法

  /// 把全部偏好一次性写回 UserDefaults。
  /// - 副作用：UserDefaults 写入（每次属性变更都会触发）。
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
