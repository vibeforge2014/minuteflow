//
//  SummaryService.swift
//  MeetingAssistant
//
//  纪要生成服务：本地模式直接调用 SummaryEngine；远程模式向 OpenAI 兼容
//  chat/completions 接口发送转录与笔记，解析 JSON 模式的结构化纪要草稿。
//  所属层：服务层（网络调用）。
//

import Foundation

// MARK: - 错误定义

/// 远程纪要调用失败的具体原因。
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

// MARK: - 纪要服务

/// 纪要生成入口：按用户偏好选择本地引擎或 OpenAI 兼容接口。
@MainActor
struct SummaryService {
  // MARK: - 请求/响应 DTO

  /// chat 消息载荷。
  private struct ChatMessage: Encodable {
    let role: String
    let content: String
  }

  /// chat/completions 请求体（强制 response_format=json_object）。
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

  /// 强制 JSON 输出的 response_format 字段。
  private struct ResponseFormat: Encodable {
    let type = "json_object"
  }

  /// chat/completions 响应的最小解析模型（choices[0].message.content）。
  private struct ChatResponse: Decodable {
    struct Choice: Decodable {
      struct Message: Decodable {
        let content: String
      }
      let message: Message
    }
    let choices: [Choice]
  }

  // MARK: - 公有方法

  /// 生成结构化纪要草稿。
  ///
  /// - Parameters:
  ///   - transcript: 转录文本（可拼接录音中的实时文本）。
  ///   - notes: 人工笔记。
  ///   - preferences: 决定本地/远程及接口参数。
  /// - Returns: 结构化的 SummaryDraft。
  /// - 副作用：远程模式读取 Keychain API Key 并发起 HTTPS POST（超时 45 秒）；
  ///   本地模式纯计算、无副作用。
  func summarize(
    transcript: String,
    notes: String,
    preferences: AppPreferences
  ) async throws -> SummaryDraft {
    // 本地 Provider 直接走离线关键词引擎。
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

    // 提示词要求严格 JSON 输出且字段与 SummaryDraft 一一对应，不编造负责人/日期。
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
    // 模型内容是“JSON 字符串”，需要二次解码为 SummaryDraft。
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

  /// 用一段固定转录做最小纪要请求，验证接口连通性（设置页“测试连接”）。
  ///
  /// - Parameter preferences: 用户偏好。
  /// - 副作用：同 summarize（远程模式含 Keychain 读取与网络调用）。
  func testConnection(preferences: AppPreferences) async throws {
    _ = try await summarize(
      transcript: "连接测试：请输出主题“连接成功”。",
      notes: "",
      preferences: preferences
    )
  }

  // MARK: - 私有方法

  /// 把 Base URL 归一化为 …/<path> 端点（容忍末尾斜杠与已带路径）。
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
