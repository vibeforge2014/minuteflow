// mf-apple-speech — MinuteFlow 桌面端的 Apple Speech 本机转录 helper。
//
// 由 electron/services/apple-speech.mjs 以子进程方式调用（macOS 专属）：
//   mf-apple-speech transcribe <wav-path> [--locale zh-CN] [--allow-server] [--timeout 55]
//   mf-apple-speech check [--locale zh-CN]
//
// stdout 恒为单行 JSON：
//   成功 {"ok":true,"onDeviceUsed":true,"text":"…","segments":[{"start":0,"end":480,"text":"好的"},…]}
//   失败 {"ok":false,"code":"not_authorized|locale_unsupported|timeout|read_failed|…","message":"…"}
// 时间戳一律毫秒；check 模式输出 {"ok":true,"authorization":"authorized","supportsOnDevice":true}。
//
// 实现要点（实测踩坑）：主线程必须持续运转 RunLoop，Speech 框架的回调才会送达——
// 用 DispatchSemaphore 阻塞主线程会导致零回调直到超时。
import Foundation
import Speech

final class FinishedFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var done = false
  var isFinished: Bool {
    lock.lock(); defer { lock.unlock() }
    return done
  }
  func mark() {
    lock.lock(); done = true; lock.unlock()
  }
}

func emit(_ payload: [String: Any]) -> Never {
  if let data = try? JSONSerialization.data(withJSONObject: payload) {
    // MF_SPEECH_OUT 供 LaunchServices 包装测试使用（open --env 启动时 stdout 丢失）；正常走 stdout。
    let outPath = ProcessInfo.processInfo.environment["MF_SPEECH_OUT"] ?? ""
    if !outPath.isEmpty {
      try? data.write(to: URL(fileURLWithPath: outPath))
    } else {
      FileHandle.standardOutput.write(data)
      FileHandle.standardOutput.write(Data([0x0A]))
    }
  }
  exit(payload["ok"] as? Bool == true ? 0 : 1)
}

func fail(_ code: String, _ message: String) -> Never {
  emit(["ok": false, "code": code, "message": message])
}

let args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "check"
var locale = "zh-CN"
var allowServer = false
var timeoutSeconds = 55.0
var wavPath = ""
var index = 1
while index < args.count {
  let arg = args[index]
  switch arg {
  case "--locale":
    index += 1
    if index < args.count { locale = args[index] }
  case "--allow-server":
    allowServer = true
  case "--timeout":
    index += 1
    if index < args.count, let value = Double(args[index]), value > 0 { timeoutSeconds = min(value, 300) }
  default:
    if wavPath.isEmpty { wavPath = arg }
  }
  index += 1
}

// 授权：notDetermined 时发起请求并等 TCC 弹窗结果（归属父 app 的
// NSSpeechRecognitionUsageDescription）；denied/restricted 直接给出可读错误。
var status = SFSpeechRecognizer.authorizationStatus()
if status == .notDetermined {
  SFSpeechRecognizer.requestAuthorization { _ in }
  let deadline = Date().addingTimeInterval(30)
  while Date() < deadline && SFSpeechRecognizer.authorizationStatus() == .notDetermined {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
  }
  status = SFSpeechRecognizer.authorizationStatus()
}
if command == "check" {
  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
    emit(["ok": true, "authorization": String(describing: status), "supportsOnDevice": false, "localeAvailable": false])
  }
  emit([
    "ok": true,
    "authorization": String(describing: status),
    "supportsOnDevice": recognizer.supportsOnDeviceRecognition,
    "localeAvailable": recognizer.isAvailable
  ])
}
guard status == .authorized else {
  fail("not_authorized", "macOS 语音识别权限未开启。请在 系统设置 → 隐私与安全性 → 语音识别 中允许 MinuteFlow。")
}
guard !wavPath.isEmpty else {
  fail("read_failed", "缺少音频文件参数。")
}
guard FileManager.default.fileExists(atPath: wavPath) else {
  fail("read_failed", "音频文件不存在：\(wavPath)")
}
guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
  fail("locale_unsupported", "此 Mac 不支持语言「\(locale)」的语音识别。")
}
if !recognizer.isAvailable {
  fail("locale_unsupported", "语音识别「\(locale)」当前不可用，请稍后重试。")
}

let url = URL(fileURLWithPath: wavPath)
let request = SFSpeechURLRecognitionRequest(url: url)
request.shouldReportPartialResults = true
if #available(macOS 13.0, *) {
  request.addsPunctuation = true
}
let onDeviceCapable = recognizer.supportsOnDeviceRecognition
if onDeviceCapable && !allowServer {
  // 默认强制本机识别：离线可用、音频不出设备。资源缺失时任务会静默停滞，
  // 由下方超时兜底并提示用户到系统设置下载听写资源。
  request.requiresOnDeviceRecognition = true
}

final class Collector: @unchecked Sendable {
  var segments: [[String: Any]] = []
  var text = ""
  var errorMessage: String?
  let lock = NSLock()
}
let collector = Collector()
let finished = FinishedFlag()

let task = recognizer.recognitionTask(with: request) { result, error in
  collector.lock.lock()
  if let result {
    collector.text = result.bestTranscription.formattedString
    collector.segments = result.bestTranscription.segments.map { segment in
      [
        "start": Int(segment.timestamp * 1000),
        "end": Int((segment.timestamp + segment.duration) * 1000),
        "text": segment.substring
      ]
    }
    if result.isFinal { finished.mark() }
  }
  if let error {
    collector.errorMessage = error.localizedDescription
    finished.mark()
  }
  collector.lock.unlock()
}

// 主线程 RunLoop 自旋；本机识别 10 秒音频约 2-4 秒完成。
let deadline = Date().addingTimeInterval(timeoutSeconds)
while Date() < deadline && !finished.isFinished {
  RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
}
task.finish()
if !finished.isFinished {
  collector.lock.lock()
  let partialText = collector.text
  collector.lock.unlock()
  // 有部分结果就采用（弱化超时），完全没有则按超时报错——常见于听写资源未下载。
  if partialText.isEmpty {
    fail("timeout", "语音识别超时。若反复出现，请在 系统设置 → 键盘 → 听写 中下载「\(locale)」的离线资源。")
  }
  emit(["ok": true, "onDeviceUsed": onDeviceCapable, "text": partialText, "segments": collector.segments, "partial": true])
}
collector.lock.lock()
defer { collector.lock.unlock() }
if let message = collector.errorMessage {
  fail("recognition_failed", message)
}
emit([
  "ok": true,
  "onDeviceUsed": onDeviceCapable,
  "text": collector.text,
  "segments": collector.segments
])
