import Foundation

enum SummaryServiceError: LocalizedError {
  case invalidEndpoint
  case missingAPIKey
  case invalidResponse
  case server(String)

  var errorDescription: String? {
    switch self {
    case .invalidEndpoint:
      "模型地址无效"
    case .missingAPIKey:
      "请先在设置中保存 API Key"
    case .invalidResponse:
      "模型返回的纪要格式无法解析"
    case .server(let message):
      message
    }
  }
}

@MainActor
struct SummaryService {
  private struct ChatMessage: Encodable {
    let role: String
    let content: String
  }

  private struct ChatRequest: Encodable {
    let model: String
    let messages: [ChatMessage]
    let temperature: Double
    let responseFormat: ResponseFormat

    enum CodingKeys: String, CodingKey {
      case model
      case messages
      case temperature
      case responseFormat = "response_format"
    }
  }

  private struct ResponseFormat: Encodable {
    let type = "json_object"
  }

  private struct ChatResponse: Decodable {
    struct Choice: Decodable {
      struct Message: Decodable {
        let content: String
      }
      let message: Message
    }
    let choices: [Choice]
  }

  func summarize(
    transcript: String,
    notes: String,
    preferences: AppPreferences
  ) async throws -> SummaryDraft {
    guard preferences.summaryProvider == .openAICompatible else {
      return SummaryEngine.summarize(transcript: transcript, notes: notes)
    }

    guard
      let apiKey = try KeychainService().load(
        account: KeychainService.summaryAPIKeyAccount
      ),
      !apiKey.isEmpty
    else {
      throw SummaryServiceError.missingAPIKey
    }
    guard
      let endpoint = endpoint(
        baseURL: preferences.summaryBaseURL,
        path: "chat/completions"
      )
    else {
      throw SummaryServiceError.invalidEndpoint
    }

    let instruction = """
      你是中文会议纪要助手。请根据新增转录和人工笔记输出严格 JSON，不要输出 Markdown 围栏。
      JSON 字段必须为 topics、keyPoints、decisions、actionItems、openQuestions、risks、nextSteps，
      每个字段都是字符串数组。不要编造负责人或截止日期；无法确认的内容放入 openQuestions。

      转录：
      \(transcript)

      我的记录：
      \(notes)
      """
    let body = ChatRequest(
      model: preferences.summaryModel,
      messages: [
        ChatMessage(role: "system", content: "输出结构化、可追溯且不夸大的会议纪要。"),
        ChatMessage(role: "user", content: instruction),
      ],
      temperature: 0.2,
      responseFormat: ResponseFormat()
    )
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.timeoutInterval = 45
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
    request.httpBody = try JSONEncoder().encode(body)

    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw SummaryServiceError.invalidResponse
    }
    guard (200..<300).contains(http.statusCode) else {
      let message = String(data: data, encoding: .utf8) ?? "请求失败"
      throw SummaryServiceError.server("模型请求失败（\(http.statusCode)）：\(message)")
    }
    let chat = try JSONDecoder().decode(ChatResponse.self, from: data)
    guard
      let content = chat.choices.first?.message.content,
      let payload = content.data(using: .utf8),
      let draft = try? JSONDecoder().decode(SummaryDraft.self, from: payload)
    else {
      throw SummaryServiceError.invalidResponse
    }
    return draft
  }

  func testConnection(preferences: AppPreferences) async throws {
    _ = try await summarize(
      transcript: "连接测试：请输出主题“连接成功”。",
      notes: "",
      preferences: preferences
    )
  }

  private func endpoint(baseURL: String, path: String) -> URL? {
    guard
      var components = URLComponents(
        string: baseURL.trimmingCharacters(in: .whitespacesAndNewlines))
    else {
      return nil
    }
    var currentPath = components.path
    if !currentPath.hasSuffix("/") {
      currentPath += "/"
    }
    if !currentPath.hasSuffix("\(path)/") && !currentPath.hasSuffix(path) {
      currentPath += path
    }
    components.path = currentPath
    return components.url
  }
}
