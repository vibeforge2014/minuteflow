import AVFAudio
import Foundation
import Observation
import Speech

enum RecordingError: LocalizedError {
  case microphoneDenied
  case speechRecognitionDenied
  case speechRecognizerUnavailable
  case failedToStart

  var errorDescription: String? {
    switch self {
    case .microphoneDenied:
      "未获得麦克风权限，请在系统设置中允许“MinuteFlow”访问麦克风。"
    case .speechRecognitionDenied:
      "未获得语音识别权限，录音仍可保存，但无法生成实时转录。"
    case .speechRecognizerUnavailable:
      "当前语言的系统语音识别暂不可用。"
    case .failedToStart:
      "无法启动录音，请检查音频设备后重试。"
    }
  }
}

@MainActor
@Observable
final class RecordingCoordinator {
  private let audioEngine = AVAudioEngine()
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var audioFile: AVAudioFile?
  private var timerTask: Task<Void, Never>?
  private var lastSummaryBoundary = 0

  private(set) var isRecording = false
  private(set) var isPaused = false
  private(set) var elapsedSeconds = 0
  private(set) var inputLevel: Float = 0
  private(set) var liveTranscript = ""
  private(set) var summaryTick = 0
  private(set) var audioURL: URL?
  private(set) var activeMeetingID: UUID?
  var errorMessage: String?

  func requestPermissions() async -> Bool {
    let microphoneGranted = await withCheckedContinuation { continuation in
      AVAudioApplication.requestRecordPermission { granted in
        continuation.resume(returning: granted)
      }
    }
    guard microphoneGranted else {
      errorMessage = RecordingError.microphoneDenied.localizedDescription
      return false
    }

    let speechStatus = await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { status in
        continuation.resume(returning: status)
      }
    }
    if speechStatus != .authorized {
      errorMessage = RecordingError.speechRecognitionDenied.localizedDescription
    }
    return true
  }

  func start(
    meetingID: UUID,
    language: String,
    summaryInterval: Int
  ) async throws {
    guard !isRecording else { return }
    guard await requestPermissions() else {
      throw RecordingError.microphoneDenied
    }

    let audioSession = AVAudioSession.sharedInstance()
    try audioSession.setCategory(
      .playAndRecord,
      mode: .measurement,
      options: [.defaultToSpeaker, .allowBluetoothHFP]
    )
    try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

    let directory = try recordingsDirectory()
    let url = directory.appendingPathComponent(
      "\(meetingID.uuidString)-\(Int(Date().timeIntervalSince1970)).caf"
    )
    let inputNode = audioEngine.inputNode
    let format = inputNode.outputFormat(forBus: 0)
    let file = try AVAudioFile(forWriting: url, settings: format.settings)

    liveTranscript = ""
    elapsedSeconds = 0
    summaryTick = 0
    lastSummaryBoundary = 0
    activeMeetingID = meetingID
    audioURL = url
    audioFile = file
    errorMessage = nil

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.addsPunctuation = true
    recognitionRequest = request

    if SFSpeechRecognizer.authorizationStatus() == .authorized,
      let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)),
      recognizer.isAvailable
    {
      recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
        Task { @MainActor in
          if let result {
            self?.liveTranscript = result.bestTranscription.formattedString
          }
          if let error {
            self?.errorMessage = "实时转录已暂停：\(error.localizedDescription)"
          }
        }
      }
    }

    inputNode.installTap(
      onBus: 0,
      bufferSize: 1_024,
      format: format
    ) { [weak self] buffer, _ in
      do {
        try file.write(from: buffer)
      } catch {
        Task { @MainActor in
          self?.errorMessage = "录音写入失败：\(error.localizedDescription)"
        }
      }
      request.append(buffer)
      let level = Self.level(for: buffer)
      Task { @MainActor in
        self?.inputLevel = level
      }
    }

    audioEngine.prepare()
    do {
      try audioEngine.start()
    } catch {
      inputNode.removeTap(onBus: 0)
      throw RecordingError.failedToStart
    }

    isRecording = true
    isPaused = false
    startTimer(summaryInterval: max(30, summaryInterval))
  }

  func pause() {
    guard isRecording, !isPaused else { return }
    audioEngine.pause()
    isPaused = true
    inputLevel = 0
  }

  func resume() throws {
    guard isRecording, isPaused else { return }
    try audioEngine.start()
    isPaused = false
  }

  func stop() {
    guard isRecording else { return }
    timerTask?.cancel()
    timerTask = nil
    if audioEngine.isRunning {
      audioEngine.stop()
    }
    audioEngine.inputNode.removeTap(onBus: 0)
    recognitionRequest?.endAudio()
    recognitionTask?.finish()
    recognitionTask = nil
    recognitionRequest = nil
    audioFile = nil
    isRecording = false
    isPaused = false
    inputLevel = 0
    try? AVAudioSession.sharedInstance().setActive(
      false,
      options: .notifyOthersOnDeactivation
    )
  }

  func addMarker() -> TimeInterval {
    TimeInterval(elapsedSeconds)
  }

  func clearCompletedSession() {
    guard !isRecording else { return }
    liveTranscript = ""
    activeMeetingID = nil
    audioURL = nil
    elapsedSeconds = 0
    summaryTick = 0
  }

  private func startTimer(summaryInterval: Int) {
    timerTask?.cancel()
    timerTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        guard !Task.isCancelled, let self else { break }
        if !self.isPaused {
          self.elapsedSeconds += 1
          let boundary = self.elapsedSeconds / summaryInterval
          if boundary > self.lastSummaryBoundary {
            self.lastSummaryBoundary = boundary
            self.summaryTick += 1
          }
        }
      }
    }
  }

  private func recordingsDirectory() throws -> URL {
    let root = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    )[0]
    let directory = root.appendingPathComponent("Recordings", isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    return directory
  }

  nonisolated private static func level(for buffer: AVAudioPCMBuffer) -> Float {
    guard
      let channel = buffer.floatChannelData?[0],
      buffer.frameLength > 0
    else {
      return 0
    }
    let count = Int(buffer.frameLength)
    var sum: Float = 0
    for index in 0..<count {
      let sample = channel[index]
      sum += sample * sample
    }
    let rootMeanSquare = sqrt(sum / Float(count))
    return min(1, max(0, rootMeanSquare * 12))
  }
}
