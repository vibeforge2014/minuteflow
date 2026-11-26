//
//  SummaryService.swift
//  MeetingAssistant
//
//  纪要生成服务：向 OpenAI 兼容 chat/completions 接口发送转录与笔记，
//  对齐桌面端 SSE 流式契约（stream:true + delta 拼接 + 300s 预算），
//  防止企业网关 60s 空闲上限切断长会议请求；网关忽略 stream 时自动按整包 JSON 解码，
//  不支持 stream/response_format 时自动回退重试一次。
//  所属层：服务层（网络调用）。
//

import Foundation

// MARK: - 错误定义

/// 远程纪要调用失败的具体原因。
enum SummaryServiceError: LocalizedError {
  case invalidEndpoint
  case missingAPIKey
  case invalidResponse
  case invalidVisualSummary
  case visualSummaryNotVerified
  case outputTruncated
  case server(String)

  var errorDescription: String? {
    switch self {
    case .invalidEndpoint:
      "模型地址无效"
    case .missingAPIKey:
      "请先在设置中保存 API Key"
    case .invalidResponse:
      "模型返回的纪要格式无法解析"
    case .invalidVisualSummary:
      "模型返回的视觉纪要结构不符合要求"
    case .visualSummaryNotVerified:
      "请先在设置中开启视觉纪要并通过连接测试"
    case .outputTruncated:
      "总结模型达到输出长度上限，未能返回完整纪要，请更换模型后重试"
    case .server(let message):
      message
    }
  }
}

// MARK: - 纪要服务

/// 纪要生成入口：使用用户配置的 OpenAI 兼容模型流式生成结构化纪要与视觉纪要。
@MainActor
struct SummaryService {
  /// 与桌面端对齐的 300 秒总超时预算（SSE 持续吐 token，避免企业网关 60 秒空闲掐断）。
  private static let requestTimeoutSeconds: TimeInterval = 300

  // MARK: - 请求/响应 DTO

  /// chat 消息载荷。
  private struct ChatMessage: Encodable {
    let role: String
    let content: String
  }

  /// chat/completions 请求体（可选 stream 与 response_format，兼容回退时按需剥离）。
  private struct ChatRequest: Encodable {
    let model: String
    let messages: [ChatMessage]
    let temperature: Double
    let stream: Bool?
    let responseFormat: ResponseFormat?

    enum CodingKeys: String, CodingKey {
      case model
      case messages
      case temperature
      case stream
      case responseFormat = "response_format"
    }
  }

  /// 强制 JSON 输出的 response_format 字段。
  private struct ResponseFormat: Encodable {
    let type = "json_object"
  }

  /// 非流式 chat/completions 响应最小模型。
  private struct ChatResponse: Decodable {
    struct Choice: Decodable {
      struct Message: Decodable {
        let content: String?
      }
      let message: Message?
      let finishReason: String?

      enum CodingKeys: String, CodingKey {
        case message
        case finishReason = "finish_reason"
      }
    }
    let choices: [Choice]
  }

  /// SSE 流式分片最小模型（choices[0].delta.content + finish_reason）。
  private struct ChatStreamChunk: Decodable {
    struct Choice: Decodable {
      struct Delta: Decodable {
        let content: String?
      }
      let delta: Delta?
      let finishReason: String?

      enum CodingKeys: String, CodingKey {
        case delta
        case finishReason = "finish_reason"
      }
    }
    let choices: [Choice]?
  }

  /// 模型仅返回内容 schema；时间与来源版本由客户端写入，不能由模型伪造。
  private struct VisualPayload: Decodable {
    let schemaVersion: Int
    let title: String
    let subtitle: String
    let sections: [VisualSummarySection]
  }

  // MARK: - 公有方法

  /// 生成结构化纪要草稿。
  ///
  /// - Parameters:
  ///   - transcript: 转录文本（可拼接录音中的实时文本）。
  ///   - notes: 人工笔记。
  ///   - preferences: 决定远程接口参数。
  /// - Returns: 结构化的 SummaryDraft。
  /// - 副作用：读取 Keychain API Key 并流式请求总结模型。
  func summarize(
    transcript: String,
    notes: String,
    preferences: AppPreferences
  ) async throws -> SummaryDraft {
    guard preferences.summaryProvider == .openAICompatible else {
      throw SummaryServiceError.server("请先在「设置 → AI 总结」配置模型。")
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
    let content = try await requestChatCompletion(
      endpoint: endpoint,
      apiKey: apiKey,
      model: preferences.summaryModel,
      systemPrompt: "输出结构化、可追溯且不夸大的会议纪要。",
      userPrompt: instruction,
      temperature: 0.2,
      errorPrefix: "模型请求失败"
    )
    let jsonText = Self.extractJSONObject(from: content)
    guard
      let payload = jsonText.data(using: .utf8),
      let draft = try? JSONDecoder().decode(SummaryDraft.self, from: payload)
    else {
      throw SummaryServiceError.invalidResponse
    }
    return draft
  }

  /// 根据已经保存的普通纪要生成视觉 schema；不会重复发送完整转录或音频。
  func generateVisualSummary(
    title: String,
    participants: [String],
    summary: SummaryDraft,
    sourceSummaryUpdatedAt: Date,
    preferences: AppPreferences
  ) async throws -> VisualSummary {
    guard preferences.visualSummaryIsVerified else {
      throw SummaryServiceError.visualSummaryNotVerified
    }
    return try await requestVisualSummary(
      title: title,
      participants: participants,
      summary: summary,
      sourceSummaryUpdatedAt: sourceSummaryUpdatedAt,
      preferences: preferences
    )
  }

  /// 用一段固定转录做最小纪要请求，验证接口连通性（设置页“测试连接”）。
  ///
  /// - Parameter preferences: 用户偏好。
  /// - 副作用：同 summarize（远程模式含 Keychain 读取与网络调用）。
  func testConnection(preferences: AppPreferences) async throws {
    let draft = try await summarize(
      transcript: "连接测试：请输出主题“连接成功”。",
      notes: "",
      preferences: preferences
    )
    if preferences.visualSummaryEnabled {
      _ = try await requestVisualSummary(
        title: "视觉纪要能力测试",
        participants: ["测试参与者"],
        summary: draft,
        sourceSummaryUpdatedAt: .now,
        preferences: preferences
      )
    }
  }

  // MARK: - 私有方法

  /// 专用 300s 会话：URLSession.shared 默认 resource 超时较长但 request 超时仅 60s。
  private static func makeStreamingSession() -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = requestTimeoutSeconds
    config.timeoutIntervalForResource = requestTimeoutSeconds
    return URLSession(configuration: config)
  }

  /// 向 OpenAI 兼容端点发 SSE 流式请求并拼接 delta.content；
  /// 若网关返回非流式 JSON 自动直接解包；若 400/404/422 不认 stream 或 response_format 则剥离重试。
  private func requestChatCompletion(
    endpoint: URL,
    apiKey: String,
    model: String,
    systemPrompt: String,
    userPrompt: String,
    temperature: Double,
    errorPrefix: String
  ) async throws -> String {
    let session = Self.makeStreamingSession()
    defer { session.finishTasksAndInvalidate() }

    var useStream = true
    var useResponseFormat = true
    var lastError: Error = SummaryServiceError.invalidResponse

    for attempt in 0..<3 {
      let body = ChatRequest(
        model: model,
        messages: [
          ChatMessage(role: "system", content: systemPrompt),
          ChatMessage(role: "user", content: userPrompt),
        ],
        temperature: temperature,
        stream: useStream ? true : nil,
        responseFormat: useResponseFormat ? ResponseFormat() : nil
      )
      var request = URLRequest(url: endpoint)
      request.httpMethod = "POST"
      request.timeoutInterval = Self.requestTimeoutSeconds
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      if useStream {
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
      }
      request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
      request.httpBody = try JSONEncoder().encode(body)

      let (bytes, response) = try await session.bytes(for: request)
      guard let http = response as? HTTPURLResponse else {
        throw SummaryServiceError.invalidResponse
      }

      if !(200..<300).contains(http.statusCode) {
        let errorData = try await Self.collectData(from: bytes)
        let bodyText = String(data: errorData, encoding: .utf8) ?? "请求失败"
        let error = SummaryServiceError.server("\(errorPrefix)（\(http.statusCode)）：\(bodyText)")
        let lower = bodyText.lowercased()
        let unsupported = [400, 404, 422].contains(http.statusCode)
          || lower.contains("response_format") || lower.contains("stream")
        if unsupported && (useStream || useResponseFormat) && attempt < 2 {
          if lower.contains("response_format") { useResponseFormat = false }
          if lower.contains("stream") { useStream = false }
          if !lower.contains("response_format") && !lower.contains("stream") {
            useStream = false
            useResponseFormat = false
          }
          lastError = error
          continue
        }
        throw error
      }

      let contentType = http.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
      let content: String
      if useStream && contentType.contains("text/event-stream") {
        content = try await Self.readSSEContent(from: bytes)
      } else {
        let data = try await Self.collectData(from: bytes)
        let chat = try JSONDecoder().decode(ChatResponse.self, from: data)
        if chat.choices.first?.finishReason == "length" {
          throw SummaryServiceError.outputTruncated
        }
        content = chat.choices.first?.message?.content ?? ""
      }

      let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty {
        return trimmed
      }
      // 网关声称支持 SSE 却返回空流：回退最小非流式请求体再试一次。
      if (useStream || useResponseFormat) && attempt < 2 {
        useStream = false
        useResponseFormat = false
        lastError = SummaryServiceError.invalidResponse
        continue
      }
      throw SummaryServiceError.invalidResponse
    }
    throw lastError
  }

  /// 读取 SSE `data:` 行并拼接 choices[0].delta.content。
  private static func readSSEContent(from bytes: URLSession.AsyncBytes) async throws -> String {
    var content = ""
    let decoder = JSONDecoder()
    for try await rawLine in bytes.lines {
      let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
      guard line.hasPrefix("data:") else { continue }
      let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
      if payload == "[DONE]" { break }
      guard !payload.isEmpty, let data = payload.data(using: .utf8),
        let chunk = try? decoder.decode(ChatStreamChunk.self, from: data),
        let choice = chunk.choices?.first
      else { continue }
      if let piece = choice.delta?.content, !piece.isEmpty {
        content += piece
      }
      if choice.finishReason == "length" {
        throw SummaryServiceError.outputTruncated
      }
      if choice.finishReason == "stop" {
        break
      }
    }
    return content
  }

  private static func collectData(from bytes: URLSession.AsyncBytes) async throws -> Data {
    var data = Data()
    for try await byte in bytes {
      data.append(byte)
    }
    return data
  }

  /// 剥离推理模型可能内联的 `<think>...</think>` 与 Markdown 代码围栏，提取 JSON 对象。
  private static func extractJSONObject(from raw: String) -> String {
    var text = raw.replacingOccurrences(
      of: "<think>[\\s\\S]*?</think>",
      with: "",
      options: .regularExpression
    ).trimmingCharacters(in: .whitespacesAndNewlines)
    if let firstBrace = text.firstIndex(of: "{"), let lastBrace = text.lastIndex(of: "}") {
      text = String(text[firstBrace...lastBrace])
    }
    return text
  }

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

  private func requestVisualSummary(
    title: String,
    participants: [String],
    summary: SummaryDraft,
    sourceSummaryUpdatedAt: Date,
    preferences: AppPreferences
  ) async throws -> VisualSummary {
    guard preferences.summaryProvider == .openAICompatible else {
      throw SummaryServiceError.visualSummaryNotVerified
    }
    guard
      let apiKey = try KeychainService().load(account: KeychainService.summaryAPIKeyAccount),
      !apiKey.isEmpty
    else { throw SummaryServiceError.missingAPIKey }
    guard let endpoint = endpoint(baseURL: preferences.summaryBaseURL, path: "chat/completions")
    else { throw SummaryServiceError.invalidEndpoint }

    let summaryJSON = String(data: try JSONEncoder().encode(summary), encoding: .utf8) ?? "{}"
    let prompt = """
      你是中文信息设计师。请把已经确认的结构化会议纪要整理成应用可原生排版的视觉纪要。
      只输出 JSON，不要输出 Markdown、HTML、URL、CSS、图片或解释。全部使用简体中文。
      schemaVersion 必须为 1，并返回 title、subtitle、sections（最多 5 个）。
      section 包含 id、number、title、tone、layout；tone 只能是 coral/amber/violet/green，layout 只能是 table/cards/callout。
      table 的 columns 为 2–4 个，rows 最多 5 行且列数一致；cards 为 1–4 张，每张包含 title、可选 status、最多 4 条 bullets、可选 takeaway；callout 只放一句最终结论。
      不要为了套模板编造对比项、负责人、日期或结论。

      会议标题：\(title)
      参与者：\(participants.joined(separator: "、"))
      普通纪要：\(summaryJSON)
      """
    let content = try await requestChatCompletion(
      endpoint: endpoint,
      apiKey: apiKey,
      model: preferences.summaryModel,
      systemPrompt: "只输出符合要求的视觉纪要 JSON。",
      userPrompt: prompt,
      temperature: 0.15,
      errorPrefix: "视觉纪要请求失败"
    )
    let jsonText = Self.extractJSONObject(from: content)
    guard
      let payloadData = jsonText.data(using: .utf8),
      let payload = try? JSONDecoder().decode(VisualPayload.self, from: payloadData)
    else { throw SummaryServiceError.invalidVisualSummary }
    return try VisualSummary(
      schemaVersion: payload.schemaVersion,
      title: payload.title,
      subtitle: payload.subtitle,
      sections: payload.sections,
      generatedAt: .now,
      sourceSummaryUpdatedAt: sourceSummaryUpdatedAt,
      stale: false
    ).validated()
  }
}
