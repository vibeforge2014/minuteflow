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

/// 设置页：AI 纪要、语音转录、自动纪要、说话人说明与隐私存储分区。
/// 导航位置：iPhone 为 TabView“设置”标签（无完成按钮）；iPad 经全局 sheet
/// 弹出（带“完成”按钮）。
struct SettingsView: View {
  /// 关闭弹层（仅 iPad sheet 场景使用）。
  @Environment(\.dismiss) private var dismiss
  /// 用户偏好（表单直接绑定）。
  @Environment(AppPreferences.self) private var preferences

  /// 是否显示工具栏“完成”按钮（sheet 场景）。
  let showsDoneButton: Bool
  /// 纪要 API Key 输入（仅点击保存时写入 Keychain）。
  @State private var summaryAPIKey = ""
  /// 转录（Whisper）API Key 输入。
  @State private var transcriptionAPIKey = ""
  /// 保存/测试结果文案（alert 展示）。
  @State private var statusMessage: String?
  /// 是否正在测试连接。
  @State private var isTestingConnection = false

  var body: some View {
    @Bindable var preferences = preferences

    Form {
      Section {
        Picker("纪要模型", selection: $preferences.summaryProvider) {
          ForEach(SummaryProviderKind.allCases) { provider in
            Text(provider.rawValue).tag(provider)
          }
        }

        // 仅远程模式显示 Base URL / 模型名 / API Key 与测试连接。
        if preferences.summaryProvider == .openAICompatible {
          TextField("Base URL", text: $preferences.summaryBaseURL)
            .textInputAutocapitalization(.never)
            .keyboardType(.URL)
          TextField("模型名称", text: $preferences.summaryModel)
            .textInputAutocapitalization(.never)
          SecureField("API Key", text: $summaryAPIKey)
            .textContentType(.password)

          HStack {
            Button("保存密钥") {
              saveKey(
                summaryAPIKey,
                account: KeychainService.summaryAPIKeyAccount
              )
            }
            Spacer()
            Button {
              Task { await testSummaryConnection() }
            } label: {
              if isTestingConnection {
                ProgressView()
              } else {
                Text("测试连接")
              }
            }
            .disabled(summaryAPIKey.isEmpty || isTestingConnection)
          }
        }
      } header: {
        Text("AI 纪要")
      } footer: {
        Text("本地基础纪要不会上传数据。配置远程模型后，只发送新增转录和人工笔记。")
      }

      Section {
        Picker("转录模型", selection: $preferences.transcriptionProvider) {
          ForEach(TranscriptionProviderKind.allCases) { provider in
            Text(provider.rawValue).tag(provider)
          }
        }
        Picker("主要语言", selection: $preferences.language) {
          Text("中文（简体）").tag("zh-CN")
          Text("English").tag("en-US")
          Text("日本語").tag("ja-JP")
        }

        // 仅远程 Whisper 模式显示接口配置。
        if preferences.transcriptionProvider == .remoteWhisper {
          TextField("Base URL", text: $preferences.transcriptionBaseURL)
            .textInputAutocapitalization(.never)
            .keyboardType(.URL)
          TextField("模型名称", text: $preferences.transcriptionModel)
            .textInputAutocapitalization(.never)
          SecureField("API Key", text: $transcriptionAPIKey)
            .textContentType(.password)
          Button("保存 Whisper 密钥") {
            saveKey(
              transcriptionAPIKey,
              account: KeychainService.transcriptionAPIKeyAccount
            )
          }
        }
      } header: {
        Text("语音转录")
      } footer: {
        Text("Apple Speech 是内置路径；远程 Whisper 配置用于导入音频和后续后台处理。")
      }

      Section("自动纪要") {
        Picker("更新间隔", selection: $preferences.summaryIntervalSeconds) {
          Text("2 分钟").tag(120)
          Text("5 分钟").tag(300)
          Text("10 分钟").tag(600)
        }
        Toggle("完成录音后自动整理", isOn: .constant(true))
          .disabled(true)
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
    .navigationTitle("设置")
    .toolbar {
      if showsDoneButton {
        ToolbarItem(placement: .confirmationAction) {
          Button("完成") { dismiss() }
        }
      }
    }
    // 保存/测试结果提示。
    .alert(
      "模型设置",
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
      summaryAPIKey =
        (try? KeychainService().load(
          account: KeychainService.summaryAPIKeyAccount
        )) ?? ""
      transcriptionAPIKey =
        (try? KeychainService().load(
          account: KeychainService.transcriptionAPIKeyAccount
        )) ?? ""
    }
  }

  // MARK: - 私有方法

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

  /// 先保存 Key，再用一次最小纪要请求验证连通性。
  /// - 副作用：Keychain 写入 + 网络调用（远程模式）；结果写入 statusMessage。
  private func testSummaryConnection() async {
    saveKey(
      summaryAPIKey,
      account: KeychainService.summaryAPIKeyAccount
    )
    isTestingConnection = true
    defer { isTestingConnection = false }
    do {
      try await SummaryService().testConnection(preferences: preferences)
      statusMessage = "连接成功"
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

/// 三页式首次引导：产品介绍 → 本地优先说明 → 权限申请。
/// 导航位置：首启 fullScreenCover（完成前不可下拉关闭）。
struct OnboardingView: View {
  /// 录音协调器（最后一页请求权限）。
  @Environment(RecordingCoordinator.self) private var recorder
  /// 用户偏好（写入引导完成标记）。
  @Environment(AppPreferences.self) private var preferences
  /// 当前引导页索引（0~2）。
  @State private var page = 0
  /// 权限被拒提示文案。
  @State private var permissionMessage: String?

  var body: some View {
    VStack(spacing: 0) {
      TabView(selection: $page) {
        onboardingPage(
          systemImage: "waveform.badge.mic",
          title: "记录每一次重要讨论",
          message: "录音、实时转录、我的记录与结构化纪要，在同一个工作区完成。"
        )
        .tag(0)

        onboardingPage(
          systemImage: "lock.shield.fill",
          title: "本地优先，数据由你掌控",
          message: "会议内容默认保存在设备上。只有配置远程模型后，才会发送必要片段。"
        )
        .tag(1)

        onboardingPage(
          systemImage: "mic.and.signal.meter.fill",
          title: "允许录音与语音识别",
          message: "麦克风用于保存会议音频，语音识别用于生成实时文字稿。"
        )
        .tag(2)
      }
      .tabViewStyle(.page(indexDisplayMode: .always))

      VStack(spacing: 12) {
        // 前两页显示“继续”；最后一页请求权限完成引导，或稍后在设置中开启。
        if page < 2 {
          Button("继续") {
            withAnimation { page += 1 }
          }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .frame(maxWidth: 420)
        } else {
          Button("允许并开始使用") {
            Task {
              let granted = await recorder.requestPermissions()
              if granted {
                preferences.hasCompletedOnboarding = true
              } else {
                permissionMessage = recorder.errorMessage
              }
            }
          }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .frame(maxWidth: 420)

          Button("稍后在设置中允许") {
            preferences.hasCompletedOnboarding = true
          }
          .foregroundStyle(.secondary)
        }
      }
      .padding(.horizontal, 28)
      .padding(.bottom, 34)
    }
    .background(MeetingTheme.canvas)
    .interactiveDismissDisabled()
    // 权限未开启提示：可继续体验或取消。
    .alert(
      "权限未开启",
      isPresented: Binding(
        get: { permissionMessage != nil },
        set: { if !$0 { permissionMessage = nil } }
      )
    ) {
      Button("继续体验") {
        preferences.hasCompletedOnboarding = true
        permissionMessage = nil
      }
      Button("取消", role: .cancel) { permissionMessage = nil }
    } message: {
      Text(permissionMessage ?? "")
    }
  }

  /// 单页引导内容：大图标 + 标题 + 说明。
  private func onboardingPage(
    systemImage: String,
    title: String,
    message: String
  ) -> some View {
    VStack(spacing: 24) {
      Spacer()
      Image(systemName: systemImage)
        .font(.system(size: 64, weight: .medium))
        .foregroundStyle(MeetingTheme.primary)
        .symbolRenderingMode(.hierarchical)
      Text(title)
        .font(.largeTitle.bold())
        .multilineTextAlignment(.center)
      Text(message)
        .font(.title3)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 520)
      Spacer()
    }
    .padding(36)
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
