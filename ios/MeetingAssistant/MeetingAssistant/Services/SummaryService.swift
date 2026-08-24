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
  case invalidVisualSummary
  case visualSummaryNotVerified
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
    let body = ChatRequest(
      model: preferences.summaryModel,
      messages: [
        ChatMessage(role: "system", content: "只输出符合要求的视觉纪要 JSON。"),
        ChatMessage(role: "user", content: prompt),
      ],
      temperature: 0.15,
      responseFormat: ResponseFormat()
    )
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.timeoutInterval = 60
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
    request.httpBody = try JSONEncoder().encode(body)
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw SummaryServiceError.invalidResponse }
    guard (200..<300).contains(http.statusCode) else {
      throw SummaryServiceError.server("视觉纪要请求失败（\(http.statusCode)）：\(String(data: data, encoding: .utf8) ?? "请求失败")")
    }
    let chat = try JSONDecoder().decode(ChatResponse.self, from: data)
    guard let content = chat.choices.first?.message.content,
      let payloadData = content.data(using: .utf8),
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
