//
//  MeetingChatPanelView.swift
//  MeetingAssistant
//
//  AI 问答面板：基于当前会议的纪要与转录回答问题（复用已启用的在线纪要模型，
//  只发送文本上下文）。iPad 作为洞察面板第三标签，iPhone 作为详情分段之一。
//  回答以打字机平滑铺出，等待期间显示输入点动画；未配置在线模型时给出
//  可行动的设置引导而不是静默失败。
//  所属层：视图层。
//

import SwiftUI

/// AI 问答面板：消息列表 + 输入栏。
struct MeetingChatPanelView: View {
  /// 会话存储（按会议维护问答历史与打字机状态）。
  @Environment(MeetingChatStore.self) private var chatStore
  /// 用户偏好（判断在线模型是否已配置）。
  @Environment(AppPreferences.self) private var preferences
  /// 录音协调器（录音中拼入实时转录上下文）。
  @Environment(RecordingCoordinator.self) private var recorder
  /// 全局 UI 状态（打开设置弹层）。
  @Environment(AppState.self) private var appState
  /// iPhone 上「去设置」直接切底部设置 tab，避免 sheet 叠 sheet 还要多退一层。
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  /// 关闭包着本面板的弹层（iPhone 问答 sheet）。
  @Environment(\.dismiss) private var dismiss
  /// 目标会议。
  let meeting: MeetingRecord
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// 输入框草稿。
  @State private var draft = ""
  /// 发送/流式失败文案（inline 展示）。
  @State private var sendError: String?

  /// 当前会议的会话轮次。
  private var turns: [ChatTurn] {
    chatStore.turns(for: meeting.id)
  }

  /// 是否可发送（有草稿且当前没有在途回答）。
  private var canSend: Bool {
    !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !turns.contains { $0.isStreaming }
  }

  /// 在线模型是否已配置（问答与纪要共用）。
  private var isConfigured: Bool {
    preferences.summaryProvider == .openAICompatible
  }

  var body: some View {
    VStack(spacing: 0) {
      if !isConfigured {
        setupGuidance
      } else {
        panelHeader
        messageList
        inputBar
      }
    }
    .background(MeetingTheme.surface)
  }

  // MARK: - 面板页眉

  /// 面板页眉：副标题说明回答依据；有对话时提供「清空对话」。
  private var panelHeader: some View {
    HStack(alignment: .firstTextBaseline) {
      VStack(alignment: .leading, spacing: 2) {
        Text("AI 问答")
          .font(.headline)
        Text("基于本场会议的转写与纪要回答")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer()
      if !turns.isEmpty {
        Button {
          chatStore.clearSession(for: meeting.id)
        } label: {
          Image(systemName: "eraser")
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel("清空这场会议的问答记录")
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .background(MeetingTheme.surface)
    .overlay(alignment: .bottom) { Divider() }
  }

  // MARK: - 设置引导

  /// 未配置在线模型：可行动的空态（直达设置，不静默降级）。
  private var setupGuidance: some View {
    VStack(spacing: 14) {
      ContentUnavailableView {
        Label("AI 问答需要在线模型", systemImage: "sparkles")
      } description: {
        Text("问答与「AI 总结」共用同一个在线模型；配置后只发送当前会议的纪要与转录文本，绝不上传音频。")
      } actions: {
        Button("去设置") {
          if horizontalSizeClass == .compact {
            // iPhone：关掉问答 sheet 并切到底部设置 tab，不再 sheet 叠 sheet。
            dismiss()
            appState.selectedPhoneTab = .settings
          } else {
            appState.presentedSheet = .settings
          }
        }
        .buttonStyle(.borderedProminent)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  // MARK: - 消息列表

  /// 消息列表：气泡布局 + 等待输入点 + 空态引导。
  private var messageList: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(spacing: 12) {
          if turns.isEmpty {
            VStack(spacing: 12) {
              Label("", systemImage: "bubble.left.and.bubble.right")
                .labelStyle(.iconOnly)
                .font(.system(size: 28, weight: .medium))
                .foregroundStyle(MeetingTheme.primary)
              Text("问问这场会议的任何内容——重点、决定、待办，或者某段讨论的细节。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
              // 猜你想问：从当前纪要内容推导，点按即发送（与桌面端一致）。
              VStack(spacing: 8) {
                ForEach(suggestedQuestions, id: \.self) { question in
                  Button {
                    send(question)
                  } label: {
                    Text(question)
                      .font(.subheadline)
                      .frame(maxWidth: .infinity, alignment: .leading)
                      .padding(.horizontal, 12)
                      .padding(.vertical, 9)
                      .background(
                        MeetingTheme.surfaceRaised,
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                      )
                  }
                  .buttonStyle(.plain)
                  .accessibilityLabel("猜你想问：\(question)")
                }
              }
              .accessibilityElement(children: .contain)
              .accessibilityLabel("猜你想问")
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 36)
            .padding(.horizontal, 6)
          }

          ForEach(turns) { turn in
            ChatBubbleView(turn: turn)
              .id(turn.id)
              .transition(ContentMotion.insertion(reduceMotion: reduceMotion))
          }

          if let sendError {
            Label(sendError, systemImage: "exclamationmark.triangle")
              .font(.caption)
              .foregroundStyle(MeetingTheme.warning)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, 14)
          }
        }
        .padding(14)
        .padding(.bottom, 8)
      }
      .scrollDismissesKeyboard(.interactively)
      .defaultScrollAnchor(.bottom)
      // 新轮次或铺字推进时保持最底部可见（歌词式跟随）。
      .onChange(of: turns.map(\.id)) { _, _ in
        guard let last = turns.last else { return }
        if reduceMotion {
          proxy.scrollTo(last.id, anchor: .bottom)
        } else {
          withAnimation(ContentMotion.content) {
            proxy.scrollTo(last.id, anchor: .bottom)
          }
        }
      }
    }
  }

  // MARK: - 输入栏

  /// 输入栏：多行输入 + 发送按钮；流式中禁用并显示忙碌态。
  private var inputBar: some View {
    HStack(alignment: .bottom, spacing: 10) {
      TextField("问一些关于这场会议的问题…", text: $draft, axis: .vertical)
        .textFieldStyle(.plain)
        .lineLimit(1...4)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(
          MeetingTheme.surfaceRaised,
          in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .onSubmit { send() }
        .accessibilityIdentifier("chat-input-field")

      Button {
        send()
      } label: {
        Group {
          if turns.contains(where: \.isStreaming) {
            ProgressView().controlSize(.small)
          } else {
            Image(systemName: "arrow.up.circle.fill")
              .font(.system(size: 30))
          }
        }
        .foregroundStyle(
          canSend || turns.contains(where: \.isStreaming)
            ? MeetingTheme.primary : Color.secondary.opacity(0.4)
        )
      }
      .buttonStyle(.plain)
      .disabled(!canSend)
      .accessibilityLabel("发送问题")
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .background(MeetingTheme.surface)
    .overlay(alignment: .top) { Divider() }
  }

  // MARK: - 动作

  /// 从当前纪要内容推导「猜你想问」：优先指向本场会议实际存在的内容
  /// （与桌面端 ChatPanel 同一套规则）。
  private var suggestedQuestions: [String] {
    var questions = ["用三句话总结这场会议"]
    if !meeting.decisionsText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      questions.append("这次会议确认了哪些决定？")
    }
    if !meeting.orderedActionItems.isEmpty {
      questions.append("行动项分别由谁负责？")
    }
    if !meeting.openQuestionsText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      questions.append("还有哪些未决问题？")
    }
    if questions.count < 3 { questions.append("会议的重点内容是什么？") }
    return Array(questions.prefix(4))
  }

  /// 发送当前草稿；失败以 inline 错误展示（不弹窗打断）。
  private func send() {
    let question = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !question.isEmpty else { return }
    send(question)
  }

  /// 发送一条问题（草稿或「猜你想问」chip）；失败以 inline 错误展示。
  private func send(_ question: String) {
    let question = question.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !question.isEmpty, !turns.contains(where: { $0.isStreaming }) else {
      return
    }
    draft = ""
    sendError = nil
    let live = recorder.activeMeetingID == meeting.id ? recorder.liveTranscript : ""
    Task {
      do {
        try await chatStore.send(
          question: question,
          meeting: meeting,
          liveTranscript: live,
          preferences: preferences
        )
      } catch {
        sendError = error.localizedDescription
      }
    }
  }
}

// MARK: - 气泡

/// 单条消息气泡：用户右侧主色底、助手左侧浅底；助手流式未开始铺字时显示输入点。
struct ChatBubbleView: View {
  /// 展示的轮次（目标文本与打字机可见文本分开读）。
  let turn: ChatTurn

  private var isUser: Bool { turn.role == "user" }

  var body: some View {
    HStack(alignment: .bottom, spacing: 8) {
      if isUser { Spacer(minLength: 28) }
      VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
        Text(turn.displayedText)
          .font(.subheadline)
          .foregroundStyle(isUser ? .white : .primary)
          .fixedSize(horizontal: false, vertical: true)
        if !isUser, turn.isStreaming, turn.displayedText.isEmpty {
          TypingDots()
            .padding(.vertical, 4)
        }
      }
      .padding(.horizontal, 13)
      .padding(.vertical, 9)
      .background(
        isUser
          ? AnyShapeStyle(MeetingTheme.primary)
          : AnyShapeStyle(MeetingTheme.primarySoft),
        in: RoundedRectangle(cornerRadius: 16, style: .continuous)
      )
      if !isUser { Spacer(minLength: 28) }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(isUser ? "我的提问" : "AI 回答")
  }
}

/// 等待输入点：三点呼吸动画（Reduced Motion 时退化为静态省略号）。
private struct TypingDots: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var phase = false

  var body: some View {
    HStack(spacing: 4) {
      ForEach(0..<3, id: \.self) { index in
        Circle()
          .fill(MeetingTheme.primary.opacity(0.75))
          .frame(width: 6, height: 6)
          .opacity(reduceMotion ? 0.7 : (phase ? 0.35 : 1))
          .animation(
            reduceMotion
              ? nil
              : .easeInOut(duration: 0.5)
                .repeatForever()
                .delay(Double(index) * 0.16),
            value: phase
          )
      }
    }
    .onAppear { phase = true }
    .accessibilityLabel("正在思考")
  }
}
