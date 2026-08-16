//
//  RecordingCoordinator.swift
//  MeetingAssistant
//
//  录音协调器：基于 AVAudioEngine 与 SFSpeechRecognizer 完成麦克风录音落盘、
//  实时转录、输入电平、暂停/恢复、每秒计时与自动纪要节拍（summaryTick）。
//  所属层：服务层（@Observable 环境对象，RecorderBar 与各面板共享）。
//

import AVFAudio
import Foundation
import Observation
import Speech

// MARK: - 错误定义

/// 录音启动/权限失败的具体原因。
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

// MARK: - 录音协调器

/// 录音会话协调器：单会话模型，同一时刻只维护一段录音。
@MainActor
@Observable
final class RecordingCoordinator {
  // MARK: - 私有属性

  /// 音频引擎：麦克风输入 tap + 写文件。
  private let audioEngine = AVAudioEngine()
  /// 流式语音识别请求；stop 时 endAudio() 收尾。
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  /// 语音识别任务；持有以便结束时 finish()。
  private var recognitionTask: SFSpeechRecognitionTask?
  /// 录音输出文件句柄（.caf 格式）。
  private var audioFile: AVAudioFile?
  /// 每秒走动的计时 Task（累计时长并触发自动纪要节拍）。
  private var timerTask: Task<Void, Never>?
  /// 上次触发自动纪要所在的间隔序号。
  private var lastSummaryBoundary = 0

  // MARK: - 状态属性（供视图观察）

  /// 是否正在录音。
  private(set) var isRecording = false
  /// 是否处于暂停（引擎已 pause，可 resume）。
  private(set) var isPaused = false
  /// 累计录音秒数（暂停期间不累计）。
  private(set) var elapsedSeconds = 0
  /// 当前麦克风输入电平（0~1，RMS 放大后截断）。
  private(set) var inputLevel: Float = 0
  /// 实时转录的临时全文（未定稿，停止录音时固化成一段）。
  private(set) var liveTranscript = ""
  /// 自动纪要节拍计数；每到达 summaryInterval 递增一次。
  private(set) var summaryTick = 0
  /// 当前录音文件 URL；停止后保留供固化 audioFilename。
  private(set) var audioURL: URL?
  /// 正在录音的会议 ID。
  private(set) var activeMeetingID: UUID?
  /// 面向用户的错误文案（权限、转录中断等）。
  var errorMessage: String?

  // MARK: - 权限

  /// 请求麦克风与语音识别权限（首次引导与开始录音前调用）。
  ///
  /// - Returns: 麦克风是否可用；语音识别被拒仍返回 true（可录音但无实时转录）。
  /// - 副作用：可能弹出系统麦克风/语音识别授权对话框；被拒时写 errorMessage。
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

  // MARK: - 录音控制

  /// 开始一段新录音：配置 AVAudioSession、创建 .caf 文件、安装输入 tap、
  /// 启动流式识别与每秒计时。
  ///
  /// - Parameters:
  ///   - meetingID: 关联的会议 ID。
  ///   - language: 识别语言（BCP 47 标记）。
  ///   - summaryInterval: 自动纪要间隔秒数（内部下限 30 秒）。
  /// - 副作用：配置并激活 AVAudioSession（playAndRecord/measurement，支持扬声器和
  ///   蓝牙 HFP）；可能触发系统权限弹窗；在 Application Support/Recordings 创建
  ///   音频文件；启动 AVAudioEngine 输入 tap 与 SFSpeechRecognizer 识别任务。
  func start(
    meetingID: UUID,
    language: String,
    summaryInterval: Int
  ) async throws {
    guard !isRecording else { return }
    guard await requestPermissions() else {
      throw RecordingError.microphoneDenied
    }

    // 录音会话：边录边播模式 + measurement 消回声，默认走扬声器、兼容蓝牙 HFP。
    let audioSession = AVAudioSession.sharedInstance()
    try audioSession.setCategory(
      .playAndRecord,
      mode: .measurement,
      options: [.defaultToSpeaker, .allowBluetoothHFP]
    )
    try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

    // 以 “会议ID-时间戳” 命名音频文件，避免多次录音互相覆盖。
    let directory = try recordingsDirectory()
    let url = directory.appendingPathComponent(
      "\(meetingID.uuidString)-\(Int(Date().timeIntervalSince1970)).caf"
    )
    let inputNode = audioEngine.inputNode
    let format = inputNode.outputFormat(forBus: 0)
    let file = try AVAudioFile(forWriting: url, settings: format.settings)

    // 重置上一段会话的临时状态。
    liveTranscript = ""
    elapsedSeconds = 0
    summaryTick = 0
    lastSummaryBoundary = 0
    activeMeetingID = meetingID
    audioURL = url
    audioFile = file
    errorMessage = nil

    // 流式识别请求：汇报中间结果并自动加标点。
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.addsPunctuation = true
    recognitionRequest = request

    // 已授权且识别器可用时才启动实时转录；被拒则只录音不转录。
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

    // 输入 tap：每个缓冲区写文件、喂识别器并计算电平。
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
      // 引擎启动失败时清理 tap，避免残留回调。
      inputNode.removeTap(onBus: 0)
      throw RecordingError.failedToStart
    }

    isRecording = true
    isPaused = false
    startTimer(summaryInterval: max(30, summaryInterval))
  }

  /// 暂停录音（引擎 pause，文件与会话保持，可恢复）。
  func pause() {
    guard isRecording, !isPaused else { return }
    audioEngine.pause()
    isPaused = true
    inputLevel = 0
  }

  /// 恢复已暂停的录音。
  func resume() throws {
    guard isRecording, isPaused else { return }
    try audioEngine.start()
    isPaused = false
  }

  /// 停止录音：停引擎、移除 tap、结束识别请求与任务并停用音频会话。
  ///
  /// - 副作用：AVAudioSession setActive(false)（notifyOthersOnDeactivation 通知
  ///   其他音频恢复）；仅结束本地录音状态，不触发远程 AI 调用。
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

  /// 返回当前秒数作为标记点；由 RecorderBar 转成文字写入笔记。
  func addMarker() -> TimeInterval {
    TimeInterval(elapsedSeconds)
  }

  /// 清理已完成会话的临时状态（转录文本、时长等），准备下一段录音。
  func clearCompletedSession() {
    guard !isRecording else { return }
    liveTranscript = ""
    activeMeetingID = nil
    audioURL = nil
    elapsedSeconds = 0
    summaryTick = 0
  }

  // MARK: - 私有方法

  /// 启动每秒计时 Task：累计时长并按间隔递增 summaryTick（自动纪要节拍）。
  private func startTimer(summaryInterval: Int) {
    timerTask?.cancel()
    timerTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        guard !Task.isCancelled, let self else { break }
        if !self.isPaused {
          self.elapsedSeconds += 1
          // 每跨过一个 summaryInterval 边界递增一次节拍，驱动界面刷新纪要。
          let boundary = self.elapsedSeconds / summaryInterval
          if boundary > self.lastSummaryBoundary {
            self.lastSummaryBoundary = boundary
            self.summaryTick += 1
          }
        }
      }
    }
  }

  /// 返回（并按需创建）Application Support/Recordings 目录。
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

  /// 计算一个缓冲区的输入电平（RMS ×12 后夹在 0~1）；nonisolated 供音频回调线程调用。
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
