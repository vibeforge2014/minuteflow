//
//  RecordingCoordinator.swift
//  MeetingAssistant
//
//  录音协调器：基于 AVAudioEngine 与 SFSpeechRecognizer 完成麦克风录音落盘、
//  实时转录、输入电平、暂停/恢复、每秒计时与自动纪要节拍（summaryTick）。
//  所属层：服务层（@Observable 环境对象，RecorderBar 与各面板共享）。
//

import AVFAudio
import AVFoundation
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

// MARK: - 识别请求槽位

/// 音频线程与主线程共享的识别请求槽位：输入 tap 在音频线程 append，
/// 识别任务重建时主线程替换请求；请求对象本身线程安全，槽位只保护引用替换。
private final class RecognitionRequestSlot: @unchecked Sendable {
  private let lock = NSLock()
  private var underlying: SFSpeechAudioBufferRecognitionRequest?

  func store(_ request: SFSpeechAudioBufferRecognitionRequest?) {
    lock.lock()
    underlying = request
    lock.unlock()
  }

  func append(_ buffer: AVAudioPCMBuffer) {
    lock.lock()
    let request = underlying
    lock.unlock()
    request?.append(buffer)
  }

  func endAudio() {
    lock.lock()
    let request = underlying
    lock.unlock()
    request?.endAudio()
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
  /// 音频线程喂缓冲的请求槽位；识别任务重建时主线程替换引用。
  private let recognitionRequestSlot = RecognitionRequestSlot()
  /// 当前语言的识别器；重建识别任务时复用，避免重新构造。
  private var activeRecognizer: SFSpeechRecognizer?
  /// 语音识别任务；持有以便结束时 finish()。
  private var recognitionTask: SFSpeechRecognitionTask?
  /// 已封存的段落：识别任务每次重建时封存上一任务的草稿，新任务从新流起点继续，
  /// 段落拼接不丢字（服务器识别任务有约 1 分钟音频上限，长会必须重建）。
  private var sealedParagraphs: [NaturalTranscriptParagraph] = []
  /// 当前识别任务的音频流起点（录音累计秒）；分段时间戳加上它才是录音时间轴。
  private var recognitionStreamStartSeconds = 0
  /// 上次重建识别任务的时间；用于限制重建频率。
  private var lastRecognitionRestartDate: Date?
  /// 录音使用的语言标识（BCP 47）；停止后的缺口回填用同一语言重建识别器。
  private var recordingLocaleIdentifier: String?
  /// 尚未补上实时转录的时间窗起点（录音累计秒）；识别任务重建成功时闭合。
  private var pendingGapStartSeconds: TimeInterval?
  /// 实时转录未能覆盖的区间（录音时间轴）；stop 后用归档音频做文件级回填。
  private var speechGapRanges: [ClosedRange<TimeInterval>] = []
  /// 停止后对缺口区间做文件级补转的任务；跨会话存活到下一次 start。
  private var gapBackfillTask: Task<Void, Never>?
  /// 缺口补转完成回调：把回填段落并入会议转录并落盘（由 RecorderBar 在 start 时注入）。
  var onGapBackfill: (([NaturalTranscriptParagraph]) -> Void)?
  /// 音频会话中断/路由观察者；协调器与应用同生命周期，无需注销。
  private var sessionObservers: [NSObjectProtocol] = []
  /// stop 后短暂等待 Speech 最后一份定稿；超时也必须恢复，不能卡住录音收尾。
  private var speechFinalizationContinuation: CheckedContinuation<Void, Never>?
  private var speechFinalized = false
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
  /// 实时转录的临时全文（由自然段落拼接，供纪要上下文使用）。
  private(set) var liveTranscript = ""
  /// 实时转录的自然段落草稿；Speech 部分结果更新时整体替换，不会重复追加。
  private(set) var liveParagraphs: [NaturalTranscriptParagraph] = []
  /// 自动纪要节拍计数；每到达 summaryInterval 递增一次。
  private(set) var summaryTick = 0
  /// 当前录音文件 URL；停止后保留供固化 audioFilename。
  private(set) var audioURL: URL?
  /// 正在录音的会议 ID。
  private(set) var activeMeetingID: UUID?
  /// 面向用户的错误文案（权限、转录中断等）。
  var errorMessage: String?
  /// Apple Speech 部分结果会反复修订；按毫秒起点复用 UUID，保持段落滚动位置稳定。
  private var liveFragmentIDs: [Int: UUID] = [:]

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
  ///   - onGapBackfill: 识别不可用窗口的补转回调；stop 后把回填段落并入会议转录。
  /// - 副作用：配置并激活 AVAudioSession（playAndRecord/measurement，支持扬声器和
  ///   蓝牙 HFP）；可能触发系统权限弹窗；在 Application Support/Recordings 创建
  ///   音频文件；启动 AVAudioEngine 输入 tap 与 SFSpeechRecognizer 识别任务。
  func start(
    meetingID: UUID,
    language: String,
    summaryInterval: Int,
    onGapBackfill: (([NaturalTranscriptParagraph]) -> Void)? = nil
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
    liveParagraphs = []
    liveFragmentIDs = [:]
    sealedParagraphs = []
    recognitionStreamStartSeconds = 0
    lastRecognitionRestartDate = nil
    speechFinalized = false
    elapsedSeconds = 0
    summaryTick = 0
    lastSummaryBoundary = 0
    // 上一场的缺口补转若仍在跑，随新会话一并终止。
    gapBackfillTask?.cancel()
    gapBackfillTask = nil
    recordingLocaleIdentifier = language
    pendingGapStartSeconds = nil
    speechGapRanges = []
    activeMeetingID = meetingID
    audioURL = url
    audioFile = file
    errorMessage = nil
    self.onGapBackfill = onGapBackfill

    // 流式识别请求：汇报中间结果并自动加标点。
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.addsPunctuation = true
    recognitionRequest = request
    recognitionRequestSlot.store(request)

    // 已授权即创建识别任务：识别器暂不可用（联网校验中/识别资产未就绪）时任务
    // 不会产出文本，但音频缓冲与归档不受影响；秒级守望会在可用后自动重建任务，
    // 缺口窗口由 stop 后的文件级回填补上——绝不让“模型未就位期间的录音”漏转。
    if SFSpeechRecognizer.authorizationStatus() == .authorized,
      let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language))
    {
      activeRecognizer = recognizer
      if !recognizer.isAvailable {
        markSpeechGapStart()
      }
      recognitionTask = recognizer.recognitionTask(
        with: request,
        resultHandler: makeRecognitionResultHandler(request: request)
      )
    }

    // 中断/路由观察者：来电、拔耳机、前后台切换后自动恢复音频管线。
    installSessionObserversIfNeeded()

    // 输入 tap：每个缓冲区写文件、经槽位喂当前识别请求（任务重建后无缝切换）
    // 并计算电平。
    inputNode.installTap(
      onBus: 0,
      bufferSize: 1_024,
      format: format
    ) { [weak self, slot = recognitionRequestSlot] buffer, _ in
      do {
        try file.write(from: buffer)
      } catch {
        Task { @MainActor in
          self?.errorMessage = "录音写入失败：\(error.localizedDescription)"
        }
      }
      slot.append(buffer)
      let level = Self.level(for: buffer)
      Task { @MainActor in
        self?.inputLevel = level
      }
    }

    audioEngine.prepare()
    do {
      try audioEngine.start()
    } catch {
      // 引擎启动失败时清理 tap 与识别任务，避免残留回调。
      inputNode.removeTap(onBus: 0)
      recognitionRequest?.endAudio()
      recognitionTask?.cancel()
      recognitionRequestSlot.store(nil)
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

  /// 恢复已暂停的录音：重激活会话（中断恢复失败转入暂停后，会话可能已失效）
  /// 并按需重建识别任务。
  func resume() throws {
    guard isRecording, isPaused else { return }
    try AVAudioSession.sharedInstance().setActive(
      true,
      options: .notifyOthersOnDeactivation
    )
    try audioEngine.start()
    isPaused = false
    ensureRecognitionTranscription()
  }

  /// 停止录音：停引擎、移除 tap、结束识别请求与任务并停用音频会话。
  ///
  /// - 副作用：AVAudioSession setActive(false)（notifyOthersOnDeactivation 通知
  ///   其他音频恢复）；仅结束本地录音状态，不触发远程 AI 调用。
  func stop() async -> [NaturalTranscriptParagraph] {
    guard isRecording else { return liveParagraphs }
    timerTask?.cancel()
    timerTask = nil
    if audioEngine.isRunning {
      audioEngine.stop()
    }
    audioEngine.inputNode.removeTap(onBus: 0)
    recognitionRequestSlot.endAudio()
    recognitionTask?.finish()
    if recognitionTask != nil, !speechFinalized {
      await withCheckedContinuation { continuation in
        speechFinalizationContinuation = continuation
        Task { [weak self] in
          try? await Task.sleep(for: .milliseconds(800))
          await MainActor.run { self?.finishSpeechFinalizationWait() }
        }
      }
    }
    recognitionTask = nil
    recognitionRequest = nil
    recognitionRequestSlot.store(nil)
    audioFile = nil
    isRecording = false
    isPaused = false
    inputLevel = 0
    // 未闭合的缺口以停止时刻收口；随后用归档音频对全部缺口做文件级补转。
    closeSpeechGap(end: TimeInterval(elapsedSeconds))
    try? AVAudioSession.sharedInstance().setActive(
      false,
      options: .notifyOthersOnDeactivation
    )
    scheduleGapBackfill()
    return liveParagraphs
  }

  /// 返回当前秒数作为标记点；由 RecorderBar 转成文字写入笔记。
  func addMarker() -> TimeInterval {
    TimeInterval(elapsedSeconds)
  }

  /// 清理已完成会话的临时状态（转录文本、时长等），准备下一段录音。
  /// 进行中的缺口补转任务不受影响（持有自己的音频 URL 与回调）。
  func clearCompletedSession() {
    guard !isRecording else { return }
    liveTranscript = ""
    liveParagraphs = []
    liveFragmentIDs = [:]
    sealedParagraphs = []
    recognitionStreamStartSeconds = 0
    activeRecognizer = nil
    activeMeetingID = nil
    audioURL = nil
    elapsedSeconds = 0
    summaryTick = 0
    recordingLocaleIdentifier = nil
    pendingGapStartSeconds = nil
    speechGapRanges = []
  }

  /// 回到前台的自愈入口（scenePhase → active）：后台期间引擎或识别若被系统中断，
  /// 自动恢复，不要求用户手动干预。
  func handleAppBecameActive() {
    guard isRecording, !isPaused else { return }
    if audioEngine.isRunning {
      ensureRecognitionTranscription()
    } else {
      recoverAudioSession()
    }
  }

  // MARK: - 会话中断与识别自愈

  /// 安装音频会话中断与路由变化观察者（整个应用生命周期一次）。
  private func installSessionObserversIfNeeded() {
    guard sessionObservers.isEmpty else { return }
    let center = NotificationCenter.default
    sessionObservers.append(
      center.addObserver(
        forName: AVAudioSession.interruptionNotification,
        object: nil,
        queue: .main
      ) { [weak self] notification in
        Task { @MainActor in self?.handleInterruption(notification) }
      }
    )
    sessionObservers.append(
      center.addObserver(
        forName: AVAudioSession.routeChangeNotification,
        object: nil,
        queue: .main
      ) { [weak self] notification in
        Task { @MainActor in self?.handleRouteChange(notification) }
      }
    )
  }

  /// 系统中断（来电、Siri、闹钟）：开始时引擎被系统暂停，保留录音状态；
  /// 结束时尝试自动续录。
  private func handleInterruption(_ notification: Notification) {
    guard
      let userInfo = notification.userInfo,
      let typeRaw = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: typeRaw)
    else { return }
    switch type {
    case .began:
      break
    case .ended:
      recoverAudioSession()
    @unknown default:
      break
    }
  }

  /// 路由变化（拔/插耳机、蓝牙连接断开）：引擎被停时按新路由续录。
  private func handleRouteChange(_ notification: Notification) {
    guard
      let userInfo = notification.userInfo,
      let reasonRaw = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
      let reason = AVAudioSession.RouteChangeReason(rawValue: reasonRaw)
    else { return }
    switch reason {
    case .oldDeviceUnavailable, .newDeviceAvailable:
      recoverAudioSession()
    default:
      break
    }
  }

  /// 中断结束/路由变化/回前台后恢复音频管线；恢复失败转入手动暂停态，
  /// 由用户显式「继续」重试，界面不假装还在录。
  private func recoverAudioSession() {
    guard isRecording, !isPaused else { return }
    do {
      try AVAudioSession.sharedInstance().setActive(
        true,
        options: .notifyOthersOnDeactivation
      )
      if !audioEngine.isRunning {
        try audioEngine.start()
      }
      ensureRecognitionTranscription()
    } catch {
      errorMessage = "录音被系统中断，已暂停；点「继续」恢复录音。"
      isPaused = true
      inputLevel = 0
    }
  }

  /// 识别任务缺失（失败后被清空）但录音仍在进行时重建任务。
  private func ensureRecognitionTranscription() {
    guard isRecording, !isPaused else { return }
    guard SFSpeechRecognizer.authorizationStatus() == .authorized else { return }
    if recognitionRequest == nil || recognitionTask == nil {
      restartRecognitionTranscription()
    }
  }

  /// 重建流式识别任务：旧请求 endAudio、旧任务 finish，当前草稿整体封存，
  /// 新任务从当前录音秒数起以平移后的时间轴继续，段落拼接不丢字。
  /// 识别器暂不可用时清空引用并记下缺口起点，守望循环会在可用后自动重建。
  private func restartRecognitionTranscription() {
    guard isRecording, !isPaused else { return }
    guard
      SFSpeechRecognizer.authorizationStatus() == .authorized,
      let recognizer = activeRecognizer,
      recognizer.isAvailable
    else {
      recognitionTask = nil
      recognitionRequest = nil
      recognitionRequestSlot.store(nil)
      markSpeechGapStart()
      return
    }
    // 冷却窗口：识别不可用/网络中断时避免高频空转重建。
    if let lastRecognitionRestartDate,
      Date().timeIntervalSince(lastRecognitionRestartDate) < 2
    {
      return
    }
    lastRecognitionRestartDate = Date()

    recognitionRequest?.endAudio()
    recognitionTask?.finish()
    sealedParagraphs = liveParagraphs
    recognitionStreamStartSeconds = elapsedSeconds
    closeSpeechGap()

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.addsPunctuation = true
    recognitionRequest = request
    recognitionRequestSlot.store(request)
    recognitionTask = recognizer.recognitionTask(
      with: request,
      resultHandler: makeRecognitionResultHandler(request: request)
    )
  }

  /// 生成识别结果回调：当前请求的结果刷新草稿；被重启替换的旧请求的迟到回调
  /// 不覆盖草稿（封存已保住文本），只用于解除 stop 的收尾等待。
  private func makeRecognitionResultHandler(
    request: SFSpeechAudioBufferRecognitionRequest
  ) -> (SFSpeechRecognitionResult?, Error?) -> Void {
    { [weak self] result, error in
      Task { @MainActor in
        guard let self else { return }
        guard request === self.recognitionRequest else {
          if result?.isFinal == true {
            self.finishSpeechFinalizationWait()
          }
          return
        }
        if let result {
          self.updateLiveTranscription(result.bestTranscription, isFinal: result.isFinal)
          if result.isFinal {
            self.speechFinalized = true
            self.finishSpeechFinalizationWait()
          }
        }
        if let error {
          self.finishSpeechFinalizationWait()
          if self.isRecording, !self.isPaused {
            // 录音仍在进行：重建任务续录（服务器任务约 1 分钟上限、来电/切后台
            // 或网络抖动都可能中断识别）。
            self.restartRecognitionTranscription()
          } else {
            // 暂停/停止期间的识别失败：清引用，恢复录音时按需重建。
            self.recognitionTask = nil
            self.recognitionRequest = nil
            self.recognitionRequestSlot.store(nil)
            self.errorMessage = "实时转录已暂停：\(error.localizedDescription)"
          }
        }
      }
    }
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
          // 秒级守望：识别任务缺失（不可用期被清空/中断未恢复）时每 3 秒尝试重建，
          // 识别一旦恢复，后续音频立即回到实时转录，录音本身不中断。
          if self.elapsedSeconds % 3 == 0 {
            self.ensureRecognitionTranscription()
          }
        }
      }
    }
  }

  /// 从 Speech 的带时间片结果重建当前任务的实时草稿；模型没有片段时退回全文
  /// 标点分段。重建过识别任务后，分段时间戳相对新任务流起点，需平移回录音
  /// 时间轴，再拼在已封存段落之后。
  private func updateLiveTranscription(_ transcription: SFTranscription, isFinal: Bool) {
    // 当前请求开始产出文本：此前记录的不可用窗口就此闭合（若尚未闭合）。
    closeSpeechGap()
    let streamOffset = Double(recognitionStreamStartSeconds)
    let fragments: [TranscriptFragment]
    if transcription.segments.isEmpty {
      fragments = NaturalTranscriptParagraphBuilder.timedFragments(
        text: transcription.formattedString,
        startTime: streamOffset,
        endTime: max(streamOffset + 0.001, TimeInterval(elapsedSeconds)),
        speaker: "我",
        isFinal: isFinal
      )
    } else {
      fragments = transcription.segments.map { segment in
        let startTime = streamOffset + segment.timestamp
        let key = Int((startTime * 1_000).rounded())
        let id = liveFragmentIDs[key] ?? UUID()
        liveFragmentIDs[key] = id
        return TranscriptFragment(
          id: id,
          startTime: startTime,
          endTime: startTime + max(0.001, segment.duration),
          speaker: "我",
          text: segment.substring,
          isFinal: isFinal
        )
      }
    }
    liveParagraphs =
      sealedParagraphs + NaturalTranscriptParagraphBuilder.paragraphs(from: fragments)
    liveTranscript = liveParagraphs.map(\.text).joined(separator: "\n")
  }

  private func finishSpeechFinalizationWait() {
    speechFinalizationContinuation?.resume()
    speechFinalizationContinuation = nil
  }

  // MARK: - 识别缺口记录与回填

  /// 记录实时转录断开的起点（幂等：保留最早值）。
  private func markSpeechGapStart() {
    if pendingGapStartSeconds == nil {
      pendingGapStartSeconds = TimeInterval(elapsedSeconds)
    }
  }

  /// 实时转录恢复：以当前流起点（或指定时刻）闭合缺口区间，等 stop 后统一回填。
  private func closeSpeechGap(end: TimeInterval? = nil) {
    guard let start = pendingGapStartSeconds else { return }
    pendingGapStartSeconds = nil
    let upper = end ?? TimeInterval(recognitionStreamStartSeconds)
    // 亚秒级抖动不值得为它做文件回填。
    guard start < upper - 0.4 else { return }
    speechGapRanges.append(start...upper)
  }

  /// 停止后对未覆盖的缺口做文件级补转：把缺口区间从归档 CAF 裁出转成 M4A，
  /// 交给 SFSpeechURLRecognitionRequest；结果按录音时间轴平移后经回调并入会议。
  /// 补转在后台静默进行，失败只放弃该缺口（音频已完整归档），不打扰用户。
  private func scheduleGapBackfill() {
    guard
      onGapBackfill != nil,
      !speechGapRanges.isEmpty,
      let url = audioURL,
      let localeIdentifier = recordingLocaleIdentifier,
      SFSpeechRecognizer.authorizationStatus() == .authorized,
      gapBackfillTask == nil
    else {
      speechGapRanges = []
      return
    }
    let ranges = speechGapRanges
    speechGapRanges = []
    gapBackfillTask = Task { [weak self] in
      let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier))
      guard let recognizer, recognizer.isAvailable else { return }
      for range in ranges {
        if Task.isCancelled { return }
        guard
          let paragraphs = await Self.backfillParagraphs(
            range: range,
            audioURL: url,
            recognizer: recognizer
          ),
          !Task.isCancelled
        else { continue }
        self?.onGapBackfill?(paragraphs)
      }
    }
  }

  /// 裁出缺口区间音频并用文件级识别补转；时间戳平移回录音时间轴后整理成自然段落。
  nonisolated private static func backfillParagraphs(
    range: ClosedRange<TimeInterval>,
    audioURL: URL,
    recognizer: SFSpeechRecognizer
  ) async -> [NaturalTranscriptParagraph]? {
    guard
      let trimmedURL = await exportTrimmedAudio(
        source: audioURL,
        start: range.lowerBound,
        end: range.upperBound
      )
    else { return nil }
    defer { try? FileManager.default.removeItem(at: trimmedURL) }

    let request = SFSpeechURLRecognitionRequest(url: trimmedURL)
    request.shouldReportPartialResults = false
    request.addsPunctuation = true
    let gate = BackfillResultGate()
    let holder = BackfillTaskHolder()
    let transcription: SFTranscription? = await withCheckedContinuation { continuation in
      // 兜底超时：文件识别最多等 120 秒，超时放弃该缺口，绝不悬挂等待。
      holder.timeoutTask = Task {
        try? await Task.sleep(for: .seconds(120))
        guard !Task.isCancelled else { return }
        gate.finish {
          holder.task?.finish()
          continuation.resume(returning: nil)
        }
      }
      holder.task = recognizer.recognitionTask(with: request) { result, error in
        if let result, result.isFinal {
          gate.finish { continuation.resume(returning: result.bestTranscription) }
        } else if error != nil {
          gate.finish { continuation.resume(returning: nil) }
        }
      }
    }
    holder.timeoutTask?.cancel()
    guard let transcription else { return nil }
    let fragments: [TranscriptFragment]
    if transcription.segments.isEmpty {
      fragments = NaturalTranscriptParagraphBuilder.timedFragments(
        text: transcription.formattedString,
        startTime: range.lowerBound,
        endTime: range.upperBound,
        speaker: "我"
      )
    } else {
      // 文件级识别的分段时间戳相对裁出音频的起点，平移回录音时间轴。
      fragments = transcription.segments.map { segment in
        let startTime = range.lowerBound + segment.timestamp
        return TranscriptFragment(
          startTime: startTime,
          endTime: startTime + max(0.001, segment.duration),
          speaker: "我",
          text: segment.substring
        )
      }
    }
    let paragraphs = NaturalTranscriptParagraphBuilder.paragraphs(from: fragments)
    return paragraphs.isEmpty ? nil : paragraphs
  }

  /// 用 AVAssetExportSession 把 [start, end) 区间转出为临时 M4A（AAC），供文件级识别。
  nonisolated private static func exportTrimmedAudio(
    source: URL,
    start: TimeInterval,
    end: TimeInterval
  ) async -> URL? {
    let outputURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("gap-backfill-\(UUID().uuidString).m4a")
    try? FileManager.default.removeItem(at: outputURL)
    let asset = AVURLAsset(url: source)
    guard let exportSession = AVAssetExportSession(
      asset: asset,
      presetName: AVAssetExportPresetAppleM4A
    ) else { return nil }
    exportSession.timeRange = CMTimeRange(
      start: CMTime(seconds: start, preferredTimescale: 600),
      duration: CMTime(seconds: max(0.5, end - start), preferredTimescale: 600)
    )
    do {
      try await exportSession.export(to: outputURL, as: .m4a)
    } catch {
      try? FileManager.default.removeItem(at: outputURL)
      return nil
    }
    return outputURL
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

// MARK: - 缺口回填辅助

/// 一次性结果闸门：文件识别回调与超时兜底竞争时，保证 continuation 只被 resume 一次。
private final class BackfillResultGate: @unchecked Sendable {
  private let lock = NSLock()
  private var fired = false

  /// 首次调用执行 body；后续调用直接忽略。
  func finish(_ body: () -> Void) {
    lock.lock()
    let shouldFire = !fired
    fired = true
    lock.unlock()
    if shouldFire { body() }
  }
}

/// 持有文件级识别任务与超时任务的强引用，避免任务在等待期间被释放。
private final class BackfillTaskHolder: @unchecked Sendable {
  var task: SFSpeechRecognitionTask?
  var timeoutTask: Task<Void, Never>?
}
