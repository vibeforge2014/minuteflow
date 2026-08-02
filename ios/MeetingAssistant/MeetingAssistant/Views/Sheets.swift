import SwiftData
import SwiftUI
import UIKit

struct NewMeetingView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.modelContext) private var modelContext
  @Environment(AppState.self) private var appState

  @State private var title = ""
  @State private var startedAt = Date()
  @State private var mode = "线上会议"
  @State private var participants = ""
  @State private var agenda = ""
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

struct SettingsView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(AppPreferences.self) private var preferences

  let showsDoneButton: Bool
  @State private var summaryAPIKey = ""
  @State private var transcriptionAPIKey = ""
  @State private var statusMessage: String?
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

private struct RecentlyDeletedView: View {
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

  private var deletedMeetings: [MeetingRecord] {
    meetings.filter(\.isDeleted)
  }
}

struct OnboardingView: View {
  @Environment(RecordingCoordinator.self) private var recorder
  @Environment(AppPreferences.self) private var preferences
  @State private var page = 0
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

struct ImportHelpView: View {
  @Environment(\.dismiss) private var dismiss
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

struct ShareSheet: UIViewControllerRepresentable {
  let items: [Any]

  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: items, applicationActivities: nil)
  }

  func updateUIViewController(
    _ uiViewController: UIActivityViewController,
    context: Context
  ) {}
}
