import Foundation

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

@MainActor
struct RemoteWhisperService {
  private struct TranscriptionResponse: Decodable {
    let text: String
  }

  func transcribe(
    audioURL: URL,
    preferences: AppPreferences
  ) async throws -> String {
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

    let boundary = "MeetingAssistant-\(UUID().uuidString)"
    let bodyURL = try makeMultipartBody(
      audioURL: audioURL,
      model: preferences.transcriptionModel,
      language: preferences.language,
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

    let (data, response) = try await URLSession.shared.upload(
      for: request,
      fromFile: bodyURL
    )
    guard let http = response as? HTTPURLResponse else {
      throw RemoteWhisperError.invalidResponse
    }
    guard (200..<300).contains(http.statusCode) else {
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
    return result.text
  }

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

  private func makeMultipartBody(
    audioURL: URL,
    model: String,
    language: String,
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

    try write("--\(boundary)\r\n")
    try write("Content-Disposition: form-data; name=\"model\"\r\n\r\n")
    try write("\(model)\r\n")

    try write("--\(boundary)\r\n")
    try write("Content-Disposition: form-data; name=\"language\"\r\n\r\n")
    try write("\(language.prefix(2))\r\n")

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
}
