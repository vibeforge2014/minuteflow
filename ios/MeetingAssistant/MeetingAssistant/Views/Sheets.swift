//
//  Sheets.swift
//  MeetingAssistant
//
//  弹层与辅助界面集合：新建会议表单、设置页、最近删除、首次引导、
//  导入帮助说明与系统分享面板（UIKit 桥接）。
//  所属层：视图层。
//

import SwiftData
import SwiftUI
import UIKit

// MARK: - 新建会议

/// 新建会议表单：标题、开始时间、类型、参与者、会议目标与议程。
/// 导航位置：全局 sheet（AppState.presentedSheet = .newMeeting）。
struct NewMeetingView: View {
  /// 关闭弹层。
  @Environment(\.dismiss) private var dismiss
  /// SwiftData 上下文（插入新会议）。
  @Environment(\.modelContext) private var modelContext
  /// 全局 UI 状态（创建后选中并关闭）。
  @Environment(AppState.self) private var appState

  /// 会议标题输入。
  @State private var title = ""
  /// 开始时间选择。
  @State private var startedAt = Date()
  /// 会议类型（线上/线下/访谈）。
  @State private var mode = "线上会议"
  /// 参与者输入（逗号分隔）。
  @State private var participants = ""
  /// 议程输入。
  @State private var agenda = ""
  /// 会议目标输入。
  @State private var goal = ""

  var body: some View {
    NavigationStack {
      Form {
        Section("基本信息") {
          TextField("会议标题", text: $title)
            .accessibilityIdentifier("new-meeting-title")
          DatePicker(
            "开始时间",
            selection: $startedAt,
            displayedComponents: [.date, .hourAndMinute]
          )
          Picker("会议类型", selection: $mode) {
            Text("线上会议").tag("线上会议")
            Text("线下会议").tag("线下会议")
            Text("访谈").tag("访谈")
          }
        }

        Section("参与者") {
          TextField("姓名之间用逗号分隔", text: $participants)
        }

        Section("会议目标") {
          TextField(
            "这次会议希望解决什么？",
            text: $goal,
            axis: .vertical
          )
          .lineLimit(3...6)
        }

        Section("议程") {
          TextField(
            "列出需要讨论的主题",
            text: $agenda,
            axis: .vertical
          )
          .lineLimit(3...8)
        }

        // 本地优先提示：内容默认仅保存在本机。
        Section {
          Label(
            "录音和会议内容默认只保存在本机",
            systemImage: "lock.shield"
          )
          .font(.footnote)
          .foregroundStyle(.secondary)
        }
      }
      .navigationTitle("新建会议")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("取消") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("创建") { createMeeting() }
            .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("create-meeting-confirm")
        }
      }
    }
    .presentationDetents([.large])
  }

  // MARK: - 私有方法

  /// 创建并保存会议，选中后关闭表单。
  /// - 副作用：插入 SwiftData 并保存；更新 appState.selectedMeetingID。
  private func createMeeting() {
    let meeting = MeetingRecord(
      title: title.trimmingCharacters(in: .whitespacesAndNewlines),
      startedAt: startedAt,
      meetingMode: mode,
      participantsText: participants,
      agenda: agenda,
      goal: goal
    )
    modelContext.insert(meeting)
    try? modelContext.save()
    appState.selectedMeetingID = meeting.id
    dismiss()
  }
}

// MARK: - 设置

/// 常用 OpenAI 兼容供应商预设：一键预填官方端点与推荐模型。
struct ModelServicePreset: Identifiable {
  /// 展示名。
  let name: String
  /// 官方 Base URL（New API 网关留空，由用户填自己的地址）。
  let baseURL: String
  /// 推荐模型名。
  let model: String

  var id: String { name }

  /// AI 总结常用预设（国内服务直连官方端点）。
  static let summaryPresets: [ModelServicePreset] = [
    .init(name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat"),
    .init(name: "Kimi（月之暗面）", baseURL: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k"),
    .init(name: "通义千问", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus"),
    .init(name: "智谱 GLM", baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash"),
    .init(name: "OpenAI", baseURL: "https://api.openai.com/v1", model: "gpt-4.1-mini"),
    .init(name: "New API 网关", baseURL: "", model: "gpt-4.1-mini"),
  ]

  /// 转写常用预设。
  static let transcriptionPresets: [ModelServicePreset] = [
    .init(name: "OpenAI Whisper", baseURL: "https://api.openai.com/v1", model: "whisper-1"),
    .init(name: "New API 网关", baseURL: "", model: "whisper-1"),
  ]
}

/// 厂商预设选择行：一键预填官方端点与推荐模型，设置子页与首次引导共用。
struct ModelPresetMenu: View {
  /// 该任务可选的预设列表。
  let presets: [ModelServicePreset]
  /// 预填目标：Base URL。
  @Binding var baseURL: String
  /// 预填目标：模型名。
  @Binding var model: String

  /// 与当前端点匹配的预设名（无匹配为空；New API 等空端点预设不参与匹配）。
  private var matchedName: String {
    presets.first {
      !$0.baseURL.isEmpty
        && $0.baseURL == baseURL.trimmingCharacters(in: .whitespaces)
    }?.name ?? ""
  }

  var body: some View {
    Menu {
      ForEach(presets) { preset in
        Button(preset.name) {
          if !preset.baseURL.isEmpty {
            baseURL = preset.baseURL
          }
          model = preset.model
        }
      }
    } label: {
      Label(
        matchedName.isEmpty ? "选择常用服务预设" : "预设：\(matchedName)",
        systemImage: "wand.and.stars"
      )
    }
    .accessibilityIdentifier("model-preset-menu")
  }
}

/// 设置页：模型服务工作台（AI 总结 / 语音转录两个任务子页）、纪要节奏、
/// 说话人说明与隐私存储分区。
/// 导航位置：iPhone 为 TabView“设置”标签（无完成按钮）；iPad 经全局 sheet
/// 弹出（带“完成”按钮）。
struct SettingsView: View {
  /// 关闭弹层（仅 iPad sheet 场景使用）。
  @Environment(\.dismiss) private var dismiss
  /// 用户偏好（读取当前任务选择用于主页副标题）。
  @Environment(AppPreferences.self) private var preferences

  /// 是否显示工具栏“完成”按钮（sheet 场景）。
  let showsDoneButton: Bool

  var body: some View {
    @Bindable var preferences = preferences

    Form {
      // 模型服务：先说清楚任务结果，再进入 Provider/协议细节（子页）。
      Section {
        NavigationLink {
          TaskModelSettingsView(task: .summary)
        } label: {
          Label {
            VStack(alignment: .leading, spacing: 3) {
              Text("AI 总结")
              Text(taskSummary(.summary))
                .font(.caption)
                .foregroundStyle(.secondary)
            }
          } icon: {
            Image(systemName: "sparkles")
              .foregroundStyle(MeetingTheme.primary)
          }
        }
        NavigationLink {
          TaskModelSettingsView(task: .transcription)
        } label: {
          Label {
            VStack(alignment: .leading, spacing: 3) {
              Text("语音转录")
              Text(taskSummary(.transcription))
                .font(.caption)
                .foregroundStyle(.secondary)
            }
          } icon: {
            Image(systemName: "waveform")
              .foregroundStyle(MeetingTheme.primary)
          }
        }
      } header: {
        Text("模型服务")
      } footer: {
        Text("两个任务各自独立设置；都在“本机运行”与“在线服务”之间选择。AI 问答复用「AI 总结」的在线模型。")
      }

      Section {
        Picker("滚动纪要间隔", selection: $preferences.summaryIntervalSeconds) {
          Text("2 分钟").tag(120)
          Text("5 分钟").tag(300)
          Text("10 分钟").tag(600)
        }
        LabeledContent("最终 AI 纪要", value: "会后手动生成")
      } header: {
        Text("纪要更新")
      } footer: {
        Text("录音中按间隔更新滚动纪要；最终 AI 纪要需在会后由你主动生成。")
      }

      // 说话人策略说明：仅手动改名，不做声纹/身份识别。
      Section("说话人") {
        LabeledContent("实时录音", value: "标记为“我”")
        LabeledContent("导入录音", value: "临时 Speaker 1")
        Text("当前版本支持手动改名和重新分配片段，不创建跨会议声纹，也不会声称识别真实身份。")
          .font(.footnote)
          .foregroundStyle(.secondary)
      }

      Section("隐私与存储") {
        Label("会议、录音与索引默认保存在本机", systemImage: "internaldrive")
        Label("API Key 仅保存在系统钥匙串", systemImage: "key.fill")
        Label("iOS 仅录制麦克风，不捕获其他 App 的系统音频", systemImage: "iphone")
        NavigationLink {
          RecentlyDeletedView()
        } label: {
          Label("最近删除", systemImage: "trash")
        }
      }
    }
    .contentMargins(.bottom, showsDoneButton ? 20 : 84, for: .scrollContent)
    .navigationTitle("设置")
    .toolbar {
      if showsDoneButton {
        ToolbarItem(placement: .confirmationAction) {
          Button("完成") { dismiss() }
        }
      }
    }
  }

  /// 任务在主页副标题里的当前选择摘要。
  private func taskSummary(_ task: ModelServiceTask) -> String {
    switch task {
    case .summary:
      preferences.summaryProvider == .local ? "本机运行 · 无需联网" : "在线服务 · \(preferences.summaryModel)"
    case .transcription:
      preferences.transcriptionProvider == .appleSpeech ? "本机运行 · Apple Speech" : "在线服务 · \(preferences.transcriptionModel)"
    }
  }
}

// MARK: - 任务子页

/// 模型任务种类：决定子页的文案、偏好字段与预设列表。
enum ModelServiceTask {
  case summary
  case transcription

  /// 页面标题。
  var title: String {
    switch self {
    case .summary: "AI 总结"
    case .transcription: "语音转录"
    }
  }

  /// 结果导向的用户收益描述（先讲结果，再讲 Provider 细节）。
  var outcomeDescription: String {
    switch self {
    case .summary:
      "录音中和会后把语音整理成结构化纪要：关键点、决策、风险与行动项。选择本机运行可完全离线；选择在线服务可获得更高质量，需配置模型与密钥。"
    case .transcription:
      "把语音变成带时间戳的文字。本机运行使用系统语音识别，免费且即时；在线服务支持远程 Whisper，适合导入音频的整段转写。"
    }
  }
}

/// 任务模型设置子页：本机/在线二选一 → 预设与字段 → 保存密钥与测试连接。
/// 导航位置：设置主页 NavigationLink push 进入。
private struct TaskModelSettingsView: View {
  /// 目标任务。
  let task: ModelServiceTask
  /// 用户偏好（表单直接绑定）。
  @Environment(AppPreferences.self) private var preferences

  /// API Key 输入（仅点击保存时写入 Keychain）。
  @State private var apiKey = ""
  /// 保存/测试结果文案（alert 展示）。
  @State private var statusMessage: String?
  /// 是否正在测试连接。
  @State private var isTestingConnection = false

  /// 该任务当前是否走在线服务。
  private var isOnline: Bool {
    switch task {
    case .summary: preferences.summaryProvider == .openAICompatible
    case .transcription: preferences.transcriptionProvider == .remoteWhisper
    }
  }

  /// 该任务对应的预设列表。
  private var presets: [ModelServicePreset] {
    switch task {
    case .summary: ModelServicePreset.summaryPresets
    case .transcription: ModelServicePreset.transcriptionPresets
    }
  }

  /// 当前 Base URL 与模型（读写的便捷绑定目标由 switch 决定）。
  private var keychainAccount: String {
    switch task {
    case .summary: KeychainService.summaryAPIKeyAccount
    case .transcription: KeychainService.transcriptionAPIKeyAccount
    }
  }

  var body: some View {
    @Bindable var preferences = preferences

    Form {
      // 运行位置：结果导向二选一，不先暴露协议细节。
      Section {
        Picker("运行位置", selection: runLocationBinding) {
          Text("在本机运行").tag(false)
          Text("使用在线服务").tag(true)
        }
        .pickerStyle(.segmented)
        if task == .transcription {
          Picker("主要语言", selection: $preferences.language) {
            Text("中文（简体）").tag("zh-CN")
            Text("English").tag("en-US")
            Text("日本語").tag("ja-JP")
          }
        }
        Text(task.outcomeDescription)
          .font(.footnote)
          .foregroundStyle(.secondary)
      }

      if isOnline {
        // 常用预设：一键预填官方端点与推荐模型。
        Section {
          ModelPresetMenu(presets: presets, baseURL: baseURLBinding, model: modelBinding)
          TextField("Base URL", text: baseURLBinding)
            .textInputAutocapitalization(.never)
            .keyboardType(.URL)
          TextField("模型名称", text: modelBinding)
            .textInputAutocapitalization(.never)
          SecureField("API Key", text: $apiKey)
            .textContentType(.password)

          HStack {
            Button("保存密钥") {
              saveKey(apiKey, account: keychainAccount)
            }
            .disabled(apiKey.isEmpty)
            Spacer()
            Button {
              Task { await testConnection() }
            } label: {
              if isTestingConnection {
                ProgressView()
              } else {
                Text("测试连接")
              }
            }
            .disabled(isTestingConnection)
          }
        } header: {
          Text("在线服务")
        } footer: {
          Text(footerText)
        }

        // 视觉纪要开关只属于 AI 总结任务。
        if task == .summary {
          Section {
            Toggle("启用视觉纪要", isOn: $preferences.visualSummaryEnabled)
            if preferences.visualSummaryEnabled {
              LabeledContent(
                "视觉结构验证",
                value: preferences.visualSummaryIsVerified ? "已通过" : "请测试连接"
              )
              .foregroundStyle(preferences.visualSummaryIsVerified ? MeetingTheme.success : .secondary)
            }
          } header: {
            Text("视觉纪要")
          } footer: {
            Text("需显式开启并通过真实结构验证；生成视觉版时只发送已保存的普通纪要和必要会议元信息。")
          }
        }
      } else {
        Section {
          Text(localOnlyDescription)
            .font(.footnote)
            .foregroundStyle(.secondary)
        } header: {
          Text("本机运行")
        }
      }
    }
    .navigationTitle(task.title)
    .navigationBarTitleDisplayMode(.inline)
    // 保存/测试结果提示。
    .alert(
      task.title,
      isPresented: Binding(
        get: { statusMessage != nil },
        set: { if !$0 { statusMessage = nil } }
      )
    ) {
      Button("好") { statusMessage = nil }
    } message: {
      Text(statusMessage ?? "")
    }
    // 进入页面时预填已保存的密钥（仅展示，不回写）。
    .task {
      apiKey = (try? KeychainService().load(account: keychainAccount)) ?? ""
    }
  }

  // MARK: - 绑定

  /// 本机/在线二选一写到对应 Provider。
  private var runLocationBinding: Binding<Bool> {
    Binding(
      get: { isOnline },
      set: { online in
        switch task {
        case .summary:
          preferences.summaryProvider = online ? .openAICompatible : .local
        case .transcription:
          preferences.transcriptionProvider = online ? .remoteWhisper : .appleSpeech
        }
      }
    )
  }

  private var baseURLBinding: Binding<String> {
    switch task {
    case .summary: Binding(
      get: { preferences.summaryBaseURL },
      set: { preferences.summaryBaseURL = $0 }
    )
    case .transcription: Binding(
      get: { preferences.transcriptionBaseURL },
      set: { preferences.transcriptionBaseURL = $0 }
    )
    }
  }

  private var modelBinding: Binding<String> {
    switch task {
    case .summary: Binding(
      get: { preferences.summaryModel },
      set: { preferences.summaryModel = $0 }
    )
    case .transcription: Binding(
      get: { preferences.transcriptionModel },
      set: { preferences.transcriptionModel = $0 }
    )
    }
  }

  /// 在线区块的脚注文案。
  private var footerText: String {
    switch task {
    case .summary:
      "密钥仅保存在系统钥匙串。AI 问答复用这里的在线模型，只发送当前会议的纪要与转录文本。New API 网关预设不预填地址，填入你的网关 Base URL（一般以 /v1 结尾）即可。"
    case .transcription:
      "远程 Whisper 用于导入音频的整段转写，使用 OpenAI 兼容 /v1/audio/transcriptions 接口。"
    }
  }

  /// 本机区块说明。
  private var localOnlyDescription: String {
    switch task {
    case .summary:
      "本机基础纪要由关键词引擎生成，完全离线，不上传任何数据。"
    case .transcription:
      "Apple Speech 由系统提供，免费即时；识别是否完全在设备端取决于语言与系统资源。"
    }
  }

  // MARK: - 动作

  /// 保存或清空 API Key（空值删除对应条目）。
  /// - 副作用：Keychain 写/删操作；结果写入 statusMessage。
  private func saveKey(_ key: String, account: String) {
    do {
      if key.isEmpty {
        try KeychainService().remove(account: account)
      } else {
        try KeychainService().save(key, account: account)
      }
      statusMessage = "已安全保存到系统钥匙串"
    } catch {
      statusMessage = error.localizedDescription
    }
  }

  /// 先保存 Key，再用一次最小请求验证连通性（总结任务走纪要通道并顺带
  /// 验证视觉结构）。
  /// - 副作用：Keychain 写入 + 网络调用；结果写入 statusMessage。
  private func testConnection() async {
    saveKey(apiKey, account: keychainAccount)
    isTestingConnection = true
    defer { isTestingConnection = false }
    do {
      switch task {
      case .summary:
        try await SummaryService().testConnection(preferences: preferences)
        if preferences.visualSummaryEnabled {
          preferences.markVisualSummaryVerified()
          statusMessage = "连接与视觉纪要结构验证成功"
        } else {
          statusMessage = "连接成功"
        }
      case .transcription:
        try await RemoteWhisperService().testConnection(preferences: preferences)
        statusMessage = "连接成功"
      }
    } catch {
      statusMessage = error.localizedDescription
    }
  }
}

/// 最近删除页：列出软删除的会议并支持恢复。
/// 导航位置：设置页内 NavigationLink push 进入。
private struct RecentlyDeletedView: View {
  /// 全部会议（按更新时间倒序）。
  @Query(sort: \MeetingRecord.updatedAt, order: .reverse)
  private var meetings: [MeetingRecord]

  var body: some View {
    List {
      if deletedMeetings.isEmpty {
        ContentUnavailableView(
          "最近删除为空",
          systemImage: "trash",
          description: Text("从会议库删除的内容可以在这里恢复")
        )
      } else {
        ForEach(deletedMeetings) { meeting in
          HStack {
            VStack(alignment: .leading, spacing: 4) {
              Text(meeting.title)
              Text(meeting.updatedAt, format: .dateTime.month().day().hour().minute())
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            Button("恢复") {
              meeting.isDeleted = false
              meeting.updatedAt = .now
            }
            .buttonStyle(.bordered)
          }
        }
      }
    }
    .navigationTitle("最近删除")
  }

  /// 仅保留软删除标记的会议。
  private var deletedMeetings: [MeetingRecord] {
    meetings.filter(\.isDeleted)
  }
}

// MARK: - 首次引导

/// 四步首次引导：产品说明 → 权限 → 语音转录 → 大模型总结。
/// iOS 内置 Apple Speech，因此把它作为无需账号的本机转录路径，同时明确提供远程
/// Whisper 配置；大模型可跳过，随后稳定降级为本机基础纪要。
struct OnboardingView: View {
  @Environment(RecordingCoordinator.self) private var recorder
  @Environment(AppPreferences.self) private var preferences

  @State private var page = 0
  @State private var transcriptionAPIKey = ""
  @State private var summaryAPIKey = ""
  @State private var errorMessage: String?
  @State private var isRequestingPermission = false

  private let pageTitles = ["欢迎", "录音权限", "语音转录", "AI 总结"]

  var body: some View {
    VStack(spacing: 0) {
      onboardingHeader

      ScrollView {
        Group {
          switch page {
          case 0: welcomePage
          case 1: permissionPage
          case 2: transcriptionPage
          default: summaryPage
          }
        }
        .frame(maxWidth: 620)
        .padding(.horizontal, 28)
        .padding(.vertical, 30)
        .frame(maxWidth: .infinity, minHeight: 420)
      }

      onboardingFooter
    }
    .background(MeetingTheme.canvas)
    .tint(MeetingTheme.primary)
    .interactiveDismissDisabled()
    .task {
      transcriptionAPIKey = (try? KeychainService().load(
        account: KeychainService.transcriptionAPIKeyAccount
      )) ?? ""
      summaryAPIKey = (try? KeychainService().load(
        account: KeychainService.summaryAPIKeyAccount
      )) ?? ""
    }
    .alert(
      "无法完成设置",
      isPresented: Binding(
        get: { errorMessage != nil },
        set: { if !$0 { errorMessage = nil } }
      )
    ) {
      Button("好") { errorMessage = nil }
    } message: {
      Text(errorMessage ?? "")
    }
  }

  private var onboardingHeader: some View {
    VStack(spacing: 14) {
      HStack {
        VStack(alignment: .leading, spacing: 3) {
          Text("首次设置 · \(page + 1)/\(pageTitles.count)")
            .font(.caption2.weight(.bold))
            .foregroundStyle(MeetingTheme.primary)
          Text(pageTitles[page])
            .font(.title2.bold())
        }
        Spacer()
        Text("MinuteFlow")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(.secondary)
      }

      HStack(spacing: 7) {
        ForEach(pageTitles.indices, id: \.self) { index in
          Capsule()
            .fill(index <= page ? MeetingTheme.primary : Color.secondary.opacity(0.15))
            .frame(height: 5)
        }
      }
      .accessibilityLabel("设置进度，第 \(page + 1) 步，共 \(pageTitles.count) 步")
    }
    .padding(.horizontal, 28)
    .padding(.top, 22)
    .padding(.bottom, 18)
    .background(.background)
    .overlay(alignment: .bottom) { Divider() }
  }

  private var welcomePage: some View {
    VStack(spacing: 22) {
      onboardingSymbol("waveform.badge.mic")
      VStack(spacing: 10) {
        Text("先配置两项能力")
          .font(.largeTitle.bold())
          .multilineTextAlignment(.center)
        Text("完成语音转录与 AI 总结设置后，会议结束即可生成清晰纪要。会议、录音和索引仍默认保存在设备上。")
          .font(.title3)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
      }
      HStack(spacing: 12) {
        onboardingFeature("waveform", title: "语音转录", detail: "Apple Speech 或 Whisper")
        Image(systemName: "arrow.right")
          .foregroundStyle(.tertiary)
        onboardingFeature("sparkles", title: "AI 纪要", detail: "本机基础或在线大模型")
      }
    }
  }

  private var permissionPage: some View {
    VStack(spacing: 22) {
      onboardingSymbol("mic.and.signal.meter.fill")
      VStack(spacing: 10) {
        Text("允许录音")
          .font(.largeTitle.bold())
        Text("麦克风用于保存会议音频和生成实时文字。iPhone 与 iPad 只录制麦克风，不会捕获其他 App 的受保护音频。")
          .font(.title3)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
      }
      Label("权限只在你主动开始会议时使用，可随时在系统设置中撤销。", systemImage: "lock.shield.fill")
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MeetingTheme.primarySoft, in: RoundedRectangle(cornerRadius: 14))
    }
  }

  private var transcriptionPage: some View {
    VStack(alignment: .leading, spacing: 18) {
      onboardingSectionIntro(
        "waveform",
        eyebrow: "第一项 · 语音转录",
        title: "先让声音变成可靠文字",
        detail: "Apple Speech 是内置路径；需要跨平台 Whisper 服务时，可在这里直接配置。"
      )

      VStack(alignment: .leading, spacing: 14) {
        Picker("转录方式", selection: Binding(
          get: { preferences.transcriptionProvider },
          set: { preferences.transcriptionProvider = $0 }
        )) {
          ForEach(TranscriptionProviderKind.allCases) { provider in
            Text(provider.rawValue).tag(provider)
          }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("onboarding-transcription-provider")

        Picker("主要语言", selection: Binding(
          get: { preferences.language },
          set: { preferences.language = $0 }
        )) {
          Text("中文（简体）").tag("zh-CN")
          Text("English").tag("en-US")
          Text("日本語").tag("ja-JP")
        }

        if preferences.transcriptionProvider == .remoteWhisper {
          Divider()
          // 常用厂商预设：一键预填官方端点与推荐模型。
          ModelPresetMenu(
            presets: ModelServicePreset.transcriptionPresets,
            baseURL: Binding(
              get: { preferences.transcriptionBaseURL },
              set: { preferences.transcriptionBaseURL = $0 }
            ),
            model: Binding(
              get: { preferences.transcriptionModel },
              set: { preferences.transcriptionModel = $0 }
            )
          )
          Text("预设会填好官方地址与模型名；New API 网关需自行填网关地址（一般以 /v1 结尾）。")
            .font(.footnote)
            .foregroundStyle(.secondary)
          TextField("Base URL", text: Binding(
            get: { preferences.transcriptionBaseURL },
            set: { preferences.transcriptionBaseURL = $0 }
          ))
          .textInputAutocapitalization(.never)
          .keyboardType(.URL)
          TextField("模型名称", text: Binding(
            get: { preferences.transcriptionModel },
            set: { preferences.transcriptionModel = $0 }
          ))
          .textInputAutocapitalization(.never)
          SecureField("Whisper API Key", text: $transcriptionAPIKey)
            .textContentType(.password)
        } else {
          Label("无需账号，使用系统语音识别；录音仍保存在本机。", systemImage: "checkmark.circle.fill")
            .font(.footnote)
            .foregroundStyle(MeetingTheme.success)
        }
      }
      .padding(18)
      .background(.background, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
      .shadow(color: .black.opacity(0.04), radius: 10, x: 0, y: 2)
    }
  }

  private var summaryPage: some View {
    VStack(alignment: .leading, spacing: 18) {
      onboardingSectionIntro(
        "sparkles",
        eyebrow: "第二项 · AI 总结",
        title: "把文字整理成可执行纪要",
        detail: "在线模型生成更完整的终稿；不配置时会自动使用本机基础纪要。"
      )

      VStack(alignment: .leading, spacing: 14) {
        Picker("纪要方式", selection: Binding(
          get: { preferences.summaryProvider },
          set: { preferences.summaryProvider = $0 }
        )) {
          ForEach(SummaryProviderKind.allCases) { provider in
            Text(provider.rawValue).tag(provider)
          }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("onboarding-summary-provider")

        if preferences.summaryProvider == .openAICompatible {
          // 常用厂商预设：一键预填官方端点与推荐模型，通常只需再填密钥。
          ModelPresetMenu(
            presets: ModelServicePreset.summaryPresets,
            baseURL: Binding(
              get: { preferences.summaryBaseURL },
              set: { preferences.summaryBaseURL = $0 }
            ),
            model: Binding(
              get: { preferences.summaryModel },
              set: { preferences.summaryModel = $0 }
            )
          )
          Text("预设会填好官方地址与推荐模型，通常只需再填密钥；New API 网关需自行填网关地址（一般以 /v1 结尾）。")
            .font(.footnote)
            .foregroundStyle(.secondary)
          TextField("Base URL", text: Binding(
            get: { preferences.summaryBaseURL },
            set: { preferences.summaryBaseURL = $0 }
          ))
          .textInputAutocapitalization(.never)
          .keyboardType(.URL)
          TextField("模型名称", text: Binding(
            get: { preferences.summaryModel },
            set: { preferences.summaryModel = $0 }
          ))
          .textInputAutocapitalization(.never)
          SecureField("大模型 API Key", text: $summaryAPIKey)
            .textContentType(.password)
          Toggle("启用视觉纪要", isOn: Binding(
            get: { preferences.visualSummaryEnabled },
            set: { preferences.visualSummaryEnabled = $0 }
          ))
          Text("视觉纪要需要稍后在设置中测试连接并通过结构验证，模型配置不会按名称猜测能力。")
            .font(.footnote)
            .foregroundStyle(.secondary)
        } else {
          Label("无需密钥，会议内容不上传；信息密度会低于在线终稿。", systemImage: "lock.shield.fill")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
      }
      .padding(18)
      .background(.background, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
      .shadow(color: .black.opacity(0.04), radius: 10, x: 0, y: 2)
    }
  }

  private var onboardingFooter: some View {
    HStack(spacing: 12) {
      if page > 0 {
        Button("返回") {
          withAnimation(.easeInOut(duration: 0.2)) { page -= 1 }
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
      }
      Spacer()

      if page == 0 {
        Button("开始设置") { advance() }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .accessibilityIdentifier("onboarding-start")
      } else if page == 1 {
        Button("稍后允许，继续配置") { advance() }
          .foregroundStyle(.secondary)
        Button {
          Task {
            isRequestingPermission = true
            let granted = await recorder.requestPermissions()
            isRequestingPermission = false
            if granted { advance() } else { errorMessage = recorder.errorMessage }
          }
        } label: {
          if isRequestingPermission { ProgressView() } else { Text("允许并继续") }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(isRequestingPermission)
      } else if page == 2 {
        Button("继续") {
          do {
            try saveTranscriptionConfiguration()
            advance()
          } catch { errorMessage = error.localizedDescription }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(!transcriptionConfigurationIsComplete)
        .accessibilityIdentifier("onboarding-transcription-next")
      } else {
        Button(preferences.summaryProvider == .local ? "使用本机纪要并完成" : "保存并完成") {
          do {
            try saveSummaryConfiguration()
            preferences.hasCompletedOnboarding = true
          } catch { errorMessage = error.localizedDescription }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(!summaryConfigurationIsComplete)
        .accessibilityIdentifier("onboarding-summary-finish")
      }
    }
    .padding(.horizontal, 28)
    .padding(.vertical, 18)
    .background(.background)
    .overlay(alignment: .top) { Divider() }
  }

  private var transcriptionConfigurationIsComplete: Bool {
    preferences.transcriptionProvider == .appleSpeech || (
      !preferences.transcriptionBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && !preferences.transcriptionModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && !transcriptionAPIKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    )
  }

  private var summaryConfigurationIsComplete: Bool {
    preferences.summaryProvider == .local || (
      !preferences.summaryBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && !preferences.summaryModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && !summaryAPIKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    )
  }

  private func advance() {
    withAnimation(.easeInOut(duration: 0.2)) { page = min(page + 1, pageTitles.count - 1) }
  }

  private func saveTranscriptionConfiguration() throws {
    guard preferences.transcriptionProvider == .remoteWhisper else { return }
    try KeychainService().save(
      transcriptionAPIKey.trimmingCharacters(in: .whitespacesAndNewlines),
      account: KeychainService.transcriptionAPIKeyAccount
    )
  }

  private func saveSummaryConfiguration() throws {
    guard preferences.summaryProvider == .openAICompatible else { return }
    try KeychainService().save(
      summaryAPIKey.trimmingCharacters(in: .whitespacesAndNewlines),
      account: KeychainService.summaryAPIKeyAccount
    )
  }

  private func onboardingSymbol(_ name: String) -> some View {
    Image(systemName: name)
      .font(.system(size: 54, weight: .medium))
      .foregroundStyle(MeetingTheme.primary)
      .symbolRenderingMode(.hierarchical)
      .frame(width: 92, height: 92)
      .background(MeetingTheme.primarySoft, in: RoundedRectangle(cornerRadius: 26))
  }

  private func onboardingFeature(_ icon: String, title: String, detail: String) -> some View {
    HStack(spacing: 10) {
      Image(systemName: icon)
        .font(.title3)
        .foregroundStyle(MeetingTheme.primary)
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(.subheadline.bold())
        Text(detail).font(.caption).foregroundStyle(.secondary)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.background, in: RoundedRectangle(cornerRadius: 16))
    .shadow(color: .black.opacity(0.04), radius: 10, x: 0, y: 2)
  }

  private func onboardingSectionIntro(
    _ icon: String,
    eyebrow: String,
    title: String,
    detail: String
  ) -> some View {
    HStack(alignment: .top, spacing: 14) {
      Image(systemName: icon)
        .font(.title2)
        .foregroundStyle(MeetingTheme.primary)
        .frame(width: 50, height: 50)
        .background(MeetingTheme.primarySoft, in: RoundedRectangle(cornerRadius: 15))
      VStack(alignment: .leading, spacing: 6) {
        Text(eyebrow.uppercased())
          .font(.caption2.bold())
          .foregroundStyle(MeetingTheme.primary)
        Text(title).font(.title.bold())
        Text(detail).font(.body).foregroundStyle(.secondary)
      }
    }
  }
}

// MARK: - 导入帮助

/// 导入说明弹层：解释导入行为并提供“选择文件”入口。
/// 导航位置：全局 sheet（.importAudio）；确认后关闭并唤起系统文件选择器。
struct ImportHelpView: View {
  /// 关闭弹层。
  @Environment(\.dismiss) private var dismiss
  /// “选择文件”回调（由根视图打开 fileImporter）。
  let onChooseFile: () -> Void

  var body: some View {
    NavigationStack {
      VStack(spacing: 22) {
        Image(systemName: "waveform.badge.plus")
          .font(.system(size: 58))
          .foregroundStyle(MeetingTheme.primary)
        Text("导入录音或视频")
          .font(.title2.bold())
        Text("支持系统文件选择器中的常见音频与视频格式。导入后会复制到本地并进入同一套转录和纪要流程。")
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
        Button("选择文件", action: onChooseFile)
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
        Spacer()
      }
      .padding(28)
      .navigationTitle("导入")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("取消") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium])
  }
}

// MARK: - 系统分享桥接

/// UIActivityViewController 的 SwiftUI 桥接（会议导出分享用）。
struct ShareSheet: UIViewControllerRepresentable {
  /// 待分享的内容（导出文件 URL 等）。
  let items: [Any]

  /// 创建系统分享视图控制器。
  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: items, applicationActivities: nil)
  }

  /// SwiftUI 占位更新（无需处理）。
  func updateUIViewController(
    _ uiViewController: UIActivityViewController,
    context: Context
  ) {}
}
