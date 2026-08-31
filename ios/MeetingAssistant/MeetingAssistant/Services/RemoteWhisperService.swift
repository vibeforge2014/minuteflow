//
//  RemoteWhisperService.swift
//  MeetingAssistant
//
//  远程 Whisper 转录服务：向 OpenAI 兼容的 /audio/transcriptions 接口上传
//  multipart 音频并解析返回文本；API Key 从 Keychain 读取。
//  所属层：服务层（网络调用）。
//

import AVFAudio
import Foundation

// MARK: - 错误定义

/// 远程 Whisper 调用失败的具体原因。
enum RemoteWhisperError: LocalizedError {
  case missingAPIKey
  case invalidEndpoint
  case invalidResponse
  case server(Int, String)

  var errorDescription: String? {
    switch self {
    case .missingAPIKey:
      "请先在设置中保存 Whisper API Key"
    case .invalidEndpoint:
      "Whisper Base URL 无效"
    case .invalidResponse:
      "Whisper 返回内容无法解析"
    case .server(let code, let message):
      "Whisper 请求失败（\(code)）：\(message)"
    }
  }
}

// MARK: - 远程转录服务

/// Whisper 转录客户端；由导入流程在用户选择“远程 Whisper”时调用。
@MainActor
struct RemoteWhisperService {
  private struct ResponseSegment: Decodable {
    let start: TimeInterval
    let end: TimeInterval
    let text: String
  }

  /// OpenAI verbose_json 与普通 JSON 的兼容响应模型。
  private struct TranscriptionResponse: Decodable {
    let text: String
    let duration: TimeInterval?
    let segments: [ResponseSegment]?
  }

  // MARK: - 公有方法

  /// 上传音频文件并返回全文及可用的细粒度时间片。
  ///
  /// - Parameters:
  ///   - audioURL: 沙盒内的音频文件。
  ///   - preferences: 提供 Base URL、模型名与语言。
  /// - Returns: 识别全文与原子片段；服务不支持 verbose_json 时按全文标点降级。
  /// - 副作用：读取 Keychain 中的 API Key；在临时目录生成 multipart 请求体文件
  ///   （请求完成后删除）；发起 HTTPS 上传（超时 180 秒）。
  func transcribe(
    audioURL: URL,
    preferences: AppPreferences
  ) async throws -> TranscriptRecognitionResult {
    guard
      let apiKey = try KeychainService().load(
        account: KeychainService.transcriptionAPIKeyAccount
      ),
      !apiKey.isEmpty
    else {
      throw RemoteWhisperError.missingAPIKey
    }
    guard let endpoint = endpoint(baseURL: preferences.transcriptionBaseURL) else {
      throw RemoteWhisperError.invalidEndpoint
    }

    // 优先请求 verbose_json 获取时间片；明确不支持该格式的兼容网关退回普通 JSON。
    let responseFormats: [String?] = ["verbose_json", nil]
    for responseFormat in responseFormats {
      let boundary = "MeetingAssistant-\(UUID().uuidString)"
      let bodyURL = try makeMultipartBody(
        audioURL: audioURL,
        model: preferences.transcriptionModel,
        language: preferences.language,
        responseFormat: responseFormat,
        boundary: boundary
      )
      defer { try? FileManager.default.removeItem(at: bodyURL) }

      var request = URLRequest(url: endpoint)
      request.httpMethod = "POST"
      request.timeoutInterval = 180
      request.setValue(
        "multipart/form-data; boundary=\(boundary)",
        forHTTPHeaderField: "Content-Type"
      )
      request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")

      let (data, response) = try await URLSession.shared.upload(for: request, fromFile: bodyURL)
      guard let http = response as? HTTPURLResponse else {
        throw RemoteWhisperError.invalidResponse
      }
      guard (200..<300).contains(http.statusCode) else {
        if responseFormat != nil, [400, 404, 422].contains(http.statusCode) {
          continue
        }
        throw RemoteWhisperError.server(
          http.statusCode,
          String(data: data, encoding: .utf8) ?? "未知错误"
        )
      }
      guard
        let result = try? JSONDecoder().decode(TranscriptionResponse.self, from: data),
        !result.text.isEmpty
      else {
        throw RemoteWhisperError.invalidResponse
      }
      let fragments = result.segments?.compactMap { segment -> TranscriptFragment? in
        let text = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return TranscriptFragment(
          startTime: max(0, segment.start),
          endTime: max(segment.start + 0.001, segment.end),
          speaker: "Speaker 1",
          text: text
        )
      } ?? []
      if !fragments.isEmpty {
        return TranscriptRecognitionResult(text: result.text, fragments: fragments)
      }
      let duration = result.duration ?? audioDuration(at: audioURL)
      return TranscriptRecognitionResult(
        text: result.text,
        fragments: NaturalTranscriptParagraphBuilder.timedFragments(
          text: result.text,
          startTime: 0,
          endTime: max(0.001, duration),
          speaker: "Speaker 1"
        )
      )
    }
    throw RemoteWhisperError.invalidResponse
  }

  // MARK: - 私有方法

  /// 把 Base URL 归一化为 …/audio/transcriptions 端点（容忍末尾斜杠与已带路径）。
  private func endpoint(baseURL: String) -> URL? {
    guard
      var components = URLComponents(
        string: baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
      )
    else {
      return nil
    }
    var path = components.path
    if !path.hasSuffix("/") {
      path += "/"
    }
    if !path.hasSuffix("audio/transcriptions") {
      path += "audio/transcriptions"
    }
    components.path = path
    return components.url
  }

  /// 以流式方式把音频拼装成 multipart/form-data 临时文件（256KB 分块读写）。
  private func makeMultipartBody(
    audioURL: URL,
    model: String,
    language: String,
    responseFormat: String?,
    boundary: String
  ) throws -> URL {
    let outputURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("\(UUID().uuidString).multipart")
    FileManager.default.createFile(atPath: outputURL.path, contents: nil)
    let output = try FileHandle(forWritingTo: outputURL)
    defer { try? output.close() }

    func write(_ string: String) throws {
      try output.write(contentsOf: Data(string.utf8))
    }

    // 表单字段：model 与 language（语言取 BCP 47 前两位，如 zh-CN → zh）。
    try write("--\(boundary)\r\n")
    try write("Content-Disposition: form-data; name=\"model\"\r\n\r\n")
    try write("\(model)\r\n")

    try write("--\(boundary)\r\n")
    try write("Content-Disposition: form-data; name=\"language\"\r\n\r\n")
    try write("\(language.prefix(2))\r\n")

    if let responseFormat {
      try write("--\(boundary)\r\n")
      try write("Content-Disposition: form-data; name=\"response_format\"\r\n\r\n")
      try write("\(responseFormat)\r\n")
    }

    // 文件字段：以原始文件名与二进制流写入。
    let filename = audioURL.lastPathComponent
    try write("--\(boundary)\r\n")
    try write(
      "Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n"
    )
    try write("Content-Type: application/octet-stream\r\n\r\n")

    let input = try FileHandle(forReadingFrom: audioURL)
    defer { try? input.close() }
    while let data = try input.read(upToCount: 256 * 1_024), !data.isEmpty {
      try output.write(contentsOf: data)
    }
    try write("\r\n--\(boundary)--\r\n")
    return outputURL
  }

  private func audioDuration(at url: URL) -> TimeInterval {
    guard let file = try? AVAudioFile(forReading: url), file.processingFormat.sampleRate > 0 else {
      return 0.001
    }
    return TimeInterval(file.length) / file.processingFormat.sampleRate
  }
}
