//
//  AudioImportCoordinator.swift
//  MeetingAssistant
//
//  音频导入服务：把用户选择的外部音频安全复制进 App 沙盒，创建“导入录音”会议，
//  再按偏好走 Apple Speech 或远程 Whisper 完成整段转录后落库。
//  所属层：服务层（@Observable 环境对象，负责导入进度与错误展示）。
//

import Foundation
import Observation
import Speech
import SwiftData

// MARK: - 错误定义

/// 音频导入/转录失败的具体原因（权限、语言、空结果）。
enum AudioImportError: LocalizedError {
  case permissionDenied
  case unsupportedLanguage
  case noTranscription

  var errorDescription: String? {
    switch self {
    case .permissionDenied:
      "没有语音识别权限"
    case .unsupportedLanguage:
      "当前语言暂不支持系统转录"
    case .noTranscription:
      "音频中没有识别到可用文本"
    }
  }
}

// MARK: - 导入协调器

/// 音频导入协调器：一次处理一段导入，暴露进度文案与错误信息供全局遮罩/弹窗展示。
@MainActor
@Observable
final class AudioImportCoordinator {
  // MARK: - 状态属性

  /// 是否正在导入（驱动全屏进度遮罩）。
  private(set) var isImporting = false
  /// 当前进度文案（复制中/转录中）。
  private(set) var progressText = ""
  /// 最近一次导入错误；由 AppRootView 以 alert 展示。
  var errorMessage: String?

  // MARK: - 导入流程

  /// 导入一段外部音频并生成已完成转录的会议。
  ///
  /// - Parameters:
  ///   - sourceURL: 文件选择器返回的（可能受安全作用域保护的）音频 URL。
  ///   - preferences: 用户偏好，决定转录 Provider 与语言。
  ///   - modelContext: SwiftData 写入上下文。
  /// - Returns: 新建的 MeetingRecord。
  /// - 副作用：访问安全作用域资源；复制文件到 Application Support/Imports；
  ///   插入并保存 SwiftData 数据；转录失败时会议停留在 processing 状态并记录错误。
  func importAudio(
    from sourceURL: URL,
    preferences: AppPreferences,
    modelContext: ModelContext
  ) async throws -> MeetingRecord {
    isImporting = true
    progressText = "正在复制音频…"
    errorMessage = nil
    defer {
      isImporting = false
      progressText = ""
    }

    // 文件选择器返回的 URL 可能需要安全作用域才能读取。
    let didStartAccess = sourceURL.startAccessingSecurityScopedResource()
    defer {
      if didStartAccess {
        sourceURL.stopAccessingSecurityScopedResource()
      }
    }

    // 先复制进沙盒，再创建“导入录音”会议占位并立即落盘。
    let importedURL = try copyIntoAppStorage(sourceURL)
    let meeting = MeetingRecord(
      title: sourceURL.deletingPathExtension().lastPathComponent,
      status: .processing,
      meetingMode: "导入录音",
      audioFilename: importedURL.lastPathComponent
    )
    modelContext.insert(meeting)
    try modelContext.save()

    progressText = "正在转录音频…"
    do {
      // 按偏好选择转录路径：Apple Speech（本地系统）或远程 Whisper（网络）。
      let text: String
      switch preferences.transcriptionProvider {
      case .appleSpeech:
        text = try await transcribe(
          url: importedURL,
          language: preferences.language
        )
      case .remoteWhisper:
        text = try await RemoteWhisperService().transcribe(
          audioURL: importedURL,
          preferences: preferences
        )
      }
      // 导入的整段文本固化为一个片段，会议标记完成。
      let segment = TranscriptSegmentRecord(
        startTime: 0,
        endTime: 0,
        speaker: "Speaker 1",
        text: text,
        meeting: meeting
      )
      meeting.transcriptSegments.append(segment)
      meeting.status = .completed
      meeting.updatedAt = .now
      try modelContext.save()
      return meeting
    } catch {
      // 失败时保留会议（整理中）供稍后重试，并记录错误信息。
      meeting.status = .processing
      errorMessage = error.localizedDescription
      try? modelContext.save()
      throw error
    }
  }

  // MARK: - 私有方法

  /// 使用 Apple Speech 对音频文件做一次性整段转录。
  ///
  /// - Parameters:
  ///   - url: 已复制到沙盒内的音频文件。
  ///   - language: BCP 47 语言标记。
  /// - Returns: 识别出的完整文本。
  /// - 副作用：若授权状态为未决定，会触发系统语音识别授权弹窗
  ///   （SFSpeechRecognizer.requestAuthorization）。
  private func transcribe(url: URL, language: String) async throws -> String {
    let authorization = SFSpeechRecognizer.authorizationStatus()
    let resolvedAuthorization: SFSpeechRecognizerAuthorizationStatus
    if authorization == .notDetermined {
      resolvedAuthorization = await withCheckedContinuation { continuation in
        SFSpeechRecognizer.requestAuthorization { status in
          continuation.resume(returning: status)
        }
      }
    } else {
      resolvedAuthorization = authorization
    }
    guard resolvedAuthorization == .authorized else {
      throw AudioImportError.permissionDenied
    }
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)) else {
      throw AudioImportError.unsupportedLanguage
    }

    // 以文件 URL 发起一次性识别；只在 isFinal 或出错时恢复 continuation 一次。
    return try await withCheckedThrowingContinuation { continuation in
      let request = SFSpeechURLRecognitionRequest(url: url)
      request.shouldReportPartialResults = false
      request.addsPunctuation = true
      var didResume = false
      recognizer.recognitionTask(with: request) { result, error in
        guard !didResume else { return }
        if let result, result.isFinal {
          didResume = true
          let text = result.bestTranscription.formattedString
          if text.isEmpty {
            continuation.resume(throwing: AudioImportError.noTranscription)
          } else {
            continuation.resume(returning: text)
          }
        } else if let error {
          didResume = true
          continuation.resume(throwing: error)
        }
      }
    }
  }

  /// 把源音频复制到 Application Support/Imports（UUID 重命名避免覆盖）。
  ///
  /// - Parameter sourceURL: 源文件 URL。
  /// - Returns: 目标文件 URL。
  /// - 副作用：按需创建 Imports 目录并复制文件。
  private func copyIntoAppStorage(_ sourceURL: URL) throws -> URL {
    let root = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    )[0]
    let directory = root.appendingPathComponent("Imports", isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    let filename = "\(UUID().uuidString).\(sourceURL.pathExtension)"
    let destination = directory.appendingPathComponent(filename)
    try FileManager.default.copyItem(at: sourceURL, to: destination)
    return destination
  }
}
