import Foundation
import Observation
import Speech
import SwiftData

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

@MainActor
@Observable
final class AudioImportCoordinator {
  private(set) var isImporting = false
  private(set) var progressText = ""
  var errorMessage: String?

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

    let didStartAccess = sourceURL.startAccessingSecurityScopedResource()
    defer {
      if didStartAccess {
        sourceURL.stopAccessingSecurityScopedResource()
      }
    }

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
      meeting.status = .processing
      errorMessage = error.localizedDescription
      try? modelContext.save()
      throw error
    }
  }

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
