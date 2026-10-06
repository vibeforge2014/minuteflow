//
//  MeetingChatService.swift
//  MeetingAssistant
//
//  AI 问答复用已启用的在线纪要模型（OpenAI 兼容 chat/completions）回答关于
//  当前会议的问题：只发送纪要与转录文本（绝不发送音频），按会议在内存中
//  维护会话；回答以 SSE 流式接收，渲染层做打字机平滑（对标桌面端观感：
//  约 40 字/秒起步、随缓冲增大提速、160 字/秒封顶，标点处自然小停顿），
//  传输层剥离思维链，不提供思考过程展示。
//  所属层：服务层（@Observable 会话存储 + 流式网络调用）。
//

import Foundation
import Observation

// MARK: - 错误定义

/// AI 问答失败的具体原因。
enum MeetingChatError: LocalizedError {
  case notConfigured
  case missingAPIKey
  case invalidEndpoint
  case busyStreaming
  case invalidResponse
  case server(String)

  var errorDescription: String? {
    switch self {
    case .notConfigured:
      "AI 问答需要在线模型。请在「设置 → AI 总结」选择在线服务并完成配置。"
    case .missingAPIKey:
      "请先在「设置 → AI 总结」保存 API Key。"
    case .invalidEndpoint:
      "模型地址无效，请检查设置中的 Base URL。"
    case .busyStreaming:
      "正在回答上一个问题…"
    case .invalidResponse:
      "模型返回内容无法解析，请稍后重试。"
    case .server(let message):
      message
    }
  }
}

// MARK: - 会话模型

/// 一轮问答（用户提问或助手回答）。
struct ChatTurn: Identifiable, Equatable {
  /// 稳定标识（列表动画与定位）。
  let id: UUID
  /// 角色：user / assistant。
  let role: String
  /// 完整目标文本（流式写入完成后即最终内容）。
  private(set) var targetText: String
  /// 打字机已铺出的可见文本。
  private(set) var displayedText: String
  /// 是否仍在流式接收中。
  private(set) var isStreaming: Bool

  init(
    id: UUID = UUID(),
    role: String,
    text: String = "",
    isStreaming: Bool = false
  ) {
    self.id = id
    self.role = role
    self.targetText = text
    self.displayedText = text
    self.isStreaming = isStreaming
  }

  /// 流式追加目标文本（渲染层按打字机节奏消费）。
  mutating func appendTarget(_ delta: String) {
    targetText += delta
  }

  /// 直接写入目标与可见文本（用户提问等无需铺字场景）。
  mutating func complete(_ text: String) {
    targetText = text
    displayedText = text
    isStreaming = false
  }

  /// 打字机步进：从目标文本再铺出一个字符，返回该字符（供标点停顿判断）。
  mutating func revealOneCharacter() -> Character? {
    guard displayedText.count < targetText.count else { return nil }
    let next = targetText[targetText.index(targetText.startIndex, offsetBy: displayedText.count)]
    displayedText.append(next)
    return next
  }

  /// 剩余待铺字数（驱动提速曲线）。
  var remainingBuffer: Int {
    targetText.count - displayedText.count
  }

  /// 结束接收（打字机仍可继续消费剩余缓冲）。
  mutating func finishStreaming() {
    isStreaming = false
  }

  static func == (lhs: ChatTurn, rhs: ChatTurn) -> Bool {
    lhs.id == rhs.id
      && lhs.role == rhs.role
      && lhs.targetText == rhs.targetText
      && lhs.displayedText == rhs.displayedText
      && lhs.isStreaming == rhs.isStreaming
  }
}

// MARK: - 打字机节奏

/// 打字机节奏计算（纯函数，便于单测）。
enum TypewriterPacing {
  /// 基础速度（字/秒）。
  static let baseCharactersPerSecond: Double = 40
  /// 封顶速度（字/秒）。
  static let maxCharactersPerSecond: Double = 160
  /// 句末标点停顿（毫秒）。
  static let sentencePauseMilliseconds: Double = 120
  /// 句中标点停顿（毫秒）。
  static let clausePauseMilliseconds: Double = 40
  /// 每档缓冲对应提速（字/秒/字缓冲）。
  private static let rampPerBufferedCharacter: Double = 1.2

  /// 按剩余缓冲量计算当前铺字速度：40 起步、随缓冲线性提速、160 封顶。
  static func charactersPerSecond(buffer: Int) -> Double {
    guard buffer > 0 else { return 0 }
    return min(
      maxCharactersPerSecond,
      baseCharactersPerSecond + Double(buffer) * rampPerBufferedCharacter
    )
  }

  /// 刚铺出的字符若为标点，返回应停顿的毫秒数。
  static func pauseMilliseconds(after character: Character) -> Double? {
    switch character {
    case "。", "！", "？", "…", "；", ".", "!", "?", ";":
      sentencePauseMilliseconds
    case "，", "、", "：", ",", ":":
      clausePauseMilliseconds
    default:
      nil
    }
  }
}

// MARK: - 会话存储

/// AI 问答会话存储：按会议 ID 在内存中维护多轮对话，并驱动打字机铺字。
@MainActor
@Observable
final class MeetingChatStore {
  /// 各会议的会话（内存态，退出即清）。
  private(set) var sessions: [UUID: [ChatTurn]] = [:]
  /// 正在流式接收的会议集合（每会议同时只允许一条在途回答）。
  private var streamingMeetingIDs: Set<UUID> = []

  /// 指定会议的会话（无则空数组，供视图读取）。
  func turns(for meetingID: UUID) -> [ChatTurn] {
    sessions[meetingID] ?? []
  }

  /// 清空指定会议的会话。
  func clearSession(for meetingID: UUID) {
    sessions[meetingID] = nil
  }

  /// 提问并向在线模型流式获取回答；回答经打字机平滑逐步可见。
  ///
  /// - Parameters:
  ///   - question: 用户问题。
  ///   - meeting: 当前会议（提供纪要与转录上下文）。
  ///   - liveTranscript: 录音中的实时转录（可为空）。
  ///   - preferences: 纪要 Provider 配置（问答与纪要共用同一在线模型）。
  /// - 副作用：网络流式调用；写入会话存储；启动打字机 Task。
  func send(
    question: String,
    meeting: MeetingRecord,
    liveTranscript: String = "",
    preferences: AppPreferences
  ) async throws {
    let meetingID = meeting.id
    guard !streamingMeetingIDs.contains(meetingID) else {
      throw MeetingChatError.busyStreaming
    }

    // 配置门槛：问答复用纪要的在线模型；未配置时给出可行动的错误。
    guard preferences.summaryProvider == .openAICompatible else {
      throw MeetingChatError.notConfigured
    }
    guard
      let apiKey = try KeychainService().load(
        account: KeychainService.summaryAPIKeyAccount
      ),
      !apiKey.isEmpty
    else {
      throw MeetingChatError.missingAPIKey
    }
    guard
      let endpoint = Self.endpoint(
        baseURL: preferences.summaryBaseURL,
        path: "chat/completions"
      )
    else {
      throw MeetingChatError.invalidEndpoint
    }

    // 记录用户提问（立即可见，不铺字）。
    var history = turns(for: meetingID)
    history.append(ChatTurn(role: "user", text: question))
    let answerTurn = ChatTurn(role: "assistant", text: "", isStreaming: true)
    history.append(answerTurn)
    sessions[meetingID] = history
    streamingMeetingIDs.insert(meetingID)

    let answerID = answerTurn.id
    defer { streamingMeetingIDs.remove(meetingID) }

    // 上下文：系统提示 + 会议纪要与转录（截尾保最近内容）。
    let context = Self.meetingContext(
      title: meeting.title,
      summary: meeting.summaryText,
      decisions: meeting.decisionsText,
      transcript: meeting.transcriptText + liveTranscript
    )
    // 对话历史：近 8 轮（更早的轮次省略，避免上下文膨胀）。
    let historyMessages: [MeetingChatStore.Message] = [
      MeetingChatStore.Message(role: "system", content: context)
    ] + history.dropLast(1).suffix(8).map { turn in
      MeetingChatStore.Message(role: turn.role, content: turn.targetText)
    } + [MeetingChatStore.Message(role: "user", content: question)]

    let body = Self.ChatRequestBody(
      model: preferences.summaryModel,
      messages: historyMessages,
      stream: true
    )
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.timeoutInterval = 90
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
    request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
    request.httpBody = try JSONEncoder().encode(body)

    var stripReasoning = ThinkingStreamStripper()
    do {
      let (bytes, response) = try await URLSession.shared.bytes(for: request)
      guard let http = response as? HTTPURLResponse else {
        throw MeetingChatError.invalidResponse
      }
      guard (200..<300).contains(http.statusCode) else {
        var serverText = ""
        for try await line in bytes.lines {
          serverText += line
          if serverText.count > 400 { break }
        }
        throw MeetingChatError.server(
          "问答请求失败（\(http.statusCode)）：\(serverText.isEmpty ? "请稍后重试" : String(serverText.prefix(200)))"
        )
      }

      var sawSSE = false
      var sawAnyContent = false
      for try await rawLine in bytes.lines {
        guard !Task.isCancelled else { break }
        let line = rawLine.trimmingCharacters(in: .whitespaces)
        guard !line.isEmpty else { continue }
        guard line.hasPrefix("data:") else { continue }
        sawSSE = true
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        if payload == "[DONE]" { break }
        guard
          let data = payload.data(using: .utf8),
          let chunk = try? JSONDecoder().decode(
            Self.StreamChunk.self, from: data
          ),
          let delta = chunk.choices.first?.delta?.content,
          !delta.isEmpty
        else { continue }
        sawAnyContent = true
        // 传输层剥离思维链；正文增量追加到目标文本，由打字机消费。
        if let visible = stripReasoning.push(delta) {
          appendToTurn(meetingID: meetingID, turnID: answerID, delta: visible)
        }
      }
      // 收尾：冲刷半截思维链标记；网关忽略 stream 参数时回退整包解析。
      if let tail = stripReasoning.flush() {
        appendToTurn(meetingID: meetingID, turnID: answerID, delta: tail)
      }
      if !sawAnyContent, !sawSSE {
        throw MeetingChatError.invalidResponse
      }
      if !sawAnyContent, sawSSE {
        // SSE 通了但没有 delta：可能是网关把整包塞进一行 data。
        appendToTurn(
          meetingID: meetingID,
          turnID: answerID,
          delta: "（模型没有返回内容，请换个问法试试）"
        )
      }
      finishTurn(meetingID: meetingID, turnID: answerID)
    } catch {
      finishTurn(meetingID: meetingID, turnID: answerID)
      // 已铺出内容的中断不报错（内容仍可读）；空白失败才移除占位并抛出。
      let hasContent = (sessions[meetingID] ?? []).contains {
        $0.id == answerID && !$0.targetText.isEmpty
      }
      if !hasContent {
        sessions[meetingID]?.removeAll { $0.id == answerID }
        throw error
      }
    }
  }

  // MARK: - 打字机驱动

  /// 为目标回答追加流式增量（打字机目标文本）。
  private func appendToTurn(meetingID: UUID, turnID: UUID, delta: String) {
    guard var turns = sessions[meetingID] else { return }
    guard let index = turns.firstIndex(where: { $0.id == turnID }) else { return }
    turns[index].appendTarget(delta)
    sessions[meetingID] = turns
    // 首个增量到达时启动该轮的打字机 Task（每轮一个）。
    startTypewriterIfNeeded(meetingID: meetingID, turnID: turnID)
  }

  /// 结束流式接收（打字机继续消费缓冲直到铺完）。
  private func finishTurn(meetingID: UUID, turnID: UUID) {
    guard var turns = sessions[meetingID] else { return }
    guard let index = turns.firstIndex(where: { $0.id == turnID }) else { return }
    turns[index].finishStreaming()
    sessions[meetingID] = turns
  }

  /// 正在铺字的轮次（防重复启动）。
  @ObservationIgnored private var typewriterTurnIDs: Set<UUID> = []

  /// 打字机基础节拍（毫秒）：每拍按当前速度铺 1~N 个字符。
  private static let tickMilliseconds: Double = 24

  /// 启动一轮回答的打字机 Task；铺完（缓冲耗尽且已结束流式）自动退出。
  private func startTypewriterIfNeeded(meetingID: UUID, turnID: UUID) {
    guard !typewriterTurnIDs.contains(turnID) else { return }
    typewriterTurnIDs.insert(turnID)
    Task { @MainActor [weak self] in
      defer { self?.typewriterTurnIDs.remove(turnID) }
      while let self, !Task.isCancelled {
        guard var turns = self.sessions[meetingID],
          let index = turns.firstIndex(where: { $0.id == turnID })
        else { return }
        var turn = turns[index]
        guard turn.remainingBuffer > 0 else {
          // 缓冲暂时耗尽：流式仍在进行就等新增量，已收尾则结束。
          if turn.isStreaming {
            try? await Task.sleep(for: .milliseconds(60))
            continue
          }
          return
        }
        // 每拍铺出的字符数由当前速度决定：40 字/秒 ≈ 每拍 1 字，
        // 缓冲增大提速后每拍多字，从而真正达到 160 字/秒封顶。
        let speed = TypewriterPacing.charactersPerSecond(
          buffer: turn.remainingBuffer
        )
        let perTick = max(
          1,
          Int((speed * Self.tickMilliseconds / 1_000).rounded())
        )
        var pause: Double = 0
        for _ in 0..<perTick {
          if let character = turn.revealOneCharacter() {
            pause = TypewriterPacing.pauseMilliseconds(after: character) ?? 0
          } else { break }
        }
        turns[index] = turn
        self.sessions[meetingID] = turns
        try? await Task.sleep(
          for: .milliseconds(Self.tickMilliseconds + pause)
        )
      }
    }
  }

  // MARK: - 上下文构造

  /// 组装问答上下文：角色定位 + 会议元信息 + 纪要 + 转录（截尾）。
  nonisolated static func meetingContext(
    title: String,
    summary: String,
    decisions: String,
    transcript: String,
    summaryLimit: Int = 4_000,
    transcriptLimit: Int = 12_000
  ) -> String {
    func clamp(_ text: String, _ limit: Int) -> String {
      text.count <= limit ? text : "…\(text.suffix(limit))"
    }
    var parts: [String] = [
      "你是 MinuteFlow 的会议问答助手。只依据下面提供的会议纪要与转录回答问题；"
        + "用简体中文、简洁直接地回答；资料里没有的信息要明说不知道，不要编造。",
      "会议标题：\(title)",
    ]
    if !summary.isEmpty {
      parts.append("会议纪要：\n\(clamp(summary, summaryLimit))")
    }
    if !decisions.isEmpty {
      parts.append("决策：\n\(clamp(decisions, 2_000))")
    }
    if !transcript.isEmpty {
      parts.append("转录（可能截尾，仅保留最近部分）：\n\(clamp(transcript, transcriptLimit))")
    }
    if summary.isEmpty && transcript.isEmpty {
      parts.append("（本会议还没有纪要或转录内容，请如实告知用户先录音或导入音频。）")
    }
    return parts.joined(separator: "\n\n")
  }

  // MARK: - 请求/响应 DTO

  /// chat 消息载荷。
  struct Message: Encodable {
    let role: String
    let content: String
  }

  /// chat/completions 流式请求体。
  struct ChatRequestBody: Encodable {
    let model: String
    let messages: [Message]
    let stream: Bool
    let temperature: Double

    init(model: String, messages: [Message], stream: Bool) {
      self.model = model
      self.messages = messages
      self.stream = stream
      temperature = 0.4
    }
  }

  /// SSE 增量块（choices[0].delta.content）。
  struct StreamChunk: Decodable {
    struct Choice: Decodable {
      struct Delta: Decodable {
        let content: String?
      }
      let delta: Delta?
    }
    let choices: [Choice]
  }

  /// 把 Base URL 归一化为 …/<path> 端点（容忍末尾斜杠与已带路径）。
  static func endpoint(baseURL: String, path: String) -> URL? {
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

// MARK: - 思维链剥离

/// 流式 <think> 剥离器：增量到达时状态机过滤，防内联思维链泄入正文。
struct ThinkingStreamStripper {
  /// 累积未判定的尾部（可能是不完整标记）。
  private var pending = ""
  /// 是否处于 <think>…</think> 区间内。
  private var insideThinking = false

  /// 输入一个增量，返回应显示的正文部分（无可显示内容时为 nil）。
  mutating func push(_ delta: String) -> String? {
    pending += delta
    var output = ""
    loop: while true {
      if insideThinking {
        guard let range = pending.range(of: "</think>") else {
          // 尾部可能是没到齐的结束标记，保留不确定区，其余按思维链吞掉。
          let keep = Self.partialSuffixLength(of: "</think>", in: pending)
          if keep < pending.count {
            pending.removeFirst(pending.count - keep)
          }
          break loop
        }
        pending.removeSubrange(..<range.upperBound)
        insideThinking = false
      } else {
        guard let range = pending.range(of: "<think>") else {
          let keep = Self.partialSuffixLength(of: "<think>", in: pending)
          if keep < pending.count {
            output += String(pending.dropLast(keep))
            pending = String(pending.suffix(keep))
          }
          break loop
        }
        output += String(pending[..<range.lowerBound])
        pending.removeSubrange(..<range.upperBound)
        insideThinking = true
      }
    }
    return output.isEmpty ? nil : output
  }

  /// 流结束时冲刷：闭合区外的残留即正文返回；未闭合的思维链整段丢弃。
  mutating func flush() -> String? {
    if insideThinking {
      pending = ""
      return nil
    }
    let result = pending
    pending = ""
    return result.isEmpty ? nil : result
  }

  /// 计算文本尾部与 `marker` 前缀匹配的最长字符数（保留不确定区用）。
  private static func partialSuffixLength(of marker: String, in text: String) -> Int {
    let characters = Array(text)
    guard !characters.isEmpty else { return 0 }
    var best = 0
    for length in 1...min(marker.count, characters.count) {
      let suffix = String(characters[(characters.count - length)...])
      if marker.hasPrefix(suffix) {
        best = length
      }
    }
    return best
  }
}
