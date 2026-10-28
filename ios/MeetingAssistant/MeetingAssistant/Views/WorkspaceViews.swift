//
//  WorkspaceViews.swift
//  MeetingAssistant
//
//  自适应工作区视图：iPad 用 NavigationSplitView 组装三栏布局（会议库/纪要文档/AI 问答），
//  iPhone 用 TabView 组装两标签布局（会议/设置），并把会议详情组织为
//  「AI 纪要/转录」两段页（AI 问答为导航栏按钮弹层）。由 AppRootView 按
//  horizontalSizeClass 选择装配。
//

import SwiftUI

/// iPad 三栏工作区：侧栏会议库 + 中栏纪要文档（AI 纪要/转录两段）+ 详情栏 AI 问答，
/// 底部安全区内放置录音条。与 Mac 桌面端三栏同构。
struct TabletWorkspaceView: View {
  @Environment(AppState.self) private var appState
  /// 回放播放器（会议切换时重新挂载音频）。
  @Environment(MeetingPlayer.self) private var player
  let meetings: [MeetingRecord]
  let onImport: () -> Void
  /// 三栏可见性（用户可手动收起侧栏/中栏）。
  @State private var columnVisibility: NavigationSplitViewVisibility = .all

  var body: some View {
    NavigationSplitView(columnVisibility: $columnVisibility) {
      MeetingLibraryView(meetings: meetings, onImport: onImport)
    } content: {
      if let meeting = selectedMeeting {
        MeetingDetailTabsView(meeting: meeting)
          .id(meeting.id)
          .navigationSplitViewColumnWidth(min: 420, ideal: 610, max: 760)
      } else {
        EmptyMeetingSelectionView()
      }
    } detail: {
      if let meeting = selectedMeeting {
        MeetingChatPanelView(meeting: meeting)
          .navigationSplitViewColumnWidth(min: 330, ideal: 390, max: 500)
      } else {
        EmptyMeetingSelectionView()
      }
    }
    .navigationSplitViewStyle(.balanced)
    // 为录音条预留真实布局空间，长文档和大字体不会被悬浮控件遮挡。
    .safeAreaInset(edge: .bottom, spacing: 0) {
      if let meeting = selectedMeeting {
        RecorderBar(meeting: meeting)
          .frame(maxWidth: 760)
          .padding(.horizontal, 20)
          .padding(.vertical, 10)
      }
    }
    // 选中会议变化时挂载其本机音频（无音频自动卸载）。
    .onChange(of: appState.selectedMeetingID) { _, _ in
      if let meeting = selectedMeeting {
        player.attach(meeting: meeting)
      } else {
        player.detach()
      }
    }
  }

  /// 从 AppState 的选中 id 解析当前会议对象。
  private var selectedMeeting: MeetingRecord? {
    guard let id = appState.selectedMeetingID else { return nil }
    return meetings.first { $0.id == id }
  }
}

/// iPhone 工作区：底部两标签（会议库 / 设置）；跨会议行动项汇总从会议页工具栏进入。
struct PhoneWorkspaceView: View {
  @Environment(AppState.self) private var appState
  let meetings: [MeetingRecord]
  let onImport: () -> Void

  var body: some View {
    // AppState 是 @Observable，绑定 TabView selection 需先转 @Bindable。
    @Bindable var appState = appState

    TabView(selection: $appState.selectedPhoneTab) {
      PhoneMeetingsView(meetings: meetings, onImport: onImport)
        .tabItem {
          Label("会议", systemImage: "doc.text.magnifyingglass")
        }
        .tag(AppState.PhoneTab.meetings)

      NavigationStack {
        SettingsView(
          showsDoneButton: false,
          uitestingInitialTask: Self.uitestingSettingsTask
        )
      }
      .tabItem {
        Label("设置", systemImage: "gearshape")
      }
      .tag(AppState.PhoneTab.settings)
    }
  }

  /// 截图驱动：UI_TESTING_INITIAL=settings-summary / settings-transcription
  /// 映射到设置标签的初始任务子页（Release 下恒为 nil）。
  private static var uitestingSettingsTask: ModelServiceTask? {
    switch UITestingLauncher.initialRoute {
    case .settingsSummary: .summary
    case .settingsTranscription: .transcription
    default: nil
    }
  }
}

/// iPhone「会议」标签：可搜索的会议列表（收藏/最近两组），支持左滑收藏、右滑软删除。
private struct PhoneMeetingsView: View {
  @Environment(AppState.self) private var appState
  /// SwiftData 上下文（快速开会插入新会议）。
  @Environment(\.modelContext) private var modelContext
  /// 录音协调器（快速开会直接启动录音）。
  @Environment(RecordingCoordinator.self) private var recorder
  /// 识别语言与自动纪要间隔。
  @Environment(AppPreferences.self) private var preferences
  let meetings: [MeetingRecord]
  let onImport: () -> Void
  @State private var searchText = ""
  /// 快速开会启动失败的错误文案（alert 展示）。
  @State private var quickStartError: String?
  /// 快速开会创建的会议：非 nil 时推入其详情页（录音中）。
  @State private var quickStartedMeeting: MeetingRecord?

  var body: some View {
    NavigationStack {
      List {
        if filteredMeetings.isEmpty {
          ContentUnavailableView.search(text: searchText)
        } else {
          if !favorites.isEmpty {
            Section("收藏") {
              rows(favorites)
            }
          }
          if !nonFavoriteMeetings.isEmpty {
            Section("最近会议") {
              rows(nonFavoriteMeetings)
            }
          }
        }
      }
      .searchable(text: $searchText, prompt: "搜索标题、笔记或转录")
      .navigationTitle("MinuteFlow")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          // 导入外部音频（触发 AppRootView 的 fileImporter）。
          Button(action: onImport) {
            Label("导入", systemImage: "square.and.arrow.down")
          }
        }
        ToolbarItem(placement: .primaryAction) {
          // 跨会议行动项汇总入口；行动项本体仍编辑于每场会议的纪要文档。
          NavigationLink {
            ActionItemsOverviewView(meetings: meetings)
          } label: {
            Label("全部行动项", systemImage: "checkmark.square")
          }
          .accessibilityIdentifier("all-actions-button")
        }
        ToolbarItem(placement: .primaryAction) {
          // 零填写快速开会：轻点即建即录并推入详情；长按菜单保留「详细新建…」表单。
          Menu {
            Button {
              appState.presentedSheet = .newMeeting
            } label: {
              Label("详细新建…", systemImage: "square.and.pencil")
            }
          } label: {
            Label("新建会议", systemImage: "plus")
          } primaryAction: {
            startQuickMeeting()
          }
          .accessibilityIdentifier("new-meeting-button")
        }
      }
      .navigationDestination(item: $quickStartedMeeting) { meeting in
        PhoneMeetingDetailView(meeting: meeting)
      }
      // 截图驱动：UI_TESTING_INITIAL=minutes/transcript/chat 时等待演示数据后推入详情页
      //（Release 下 initialRoute 恒为 nil，本 task 为空操作）。
      .task {
        guard let route = UITestingLauncher.initialRoute,
              ["minutes", "transcript", "chat"].contains(route.rawValue) else {
          return
        }
        for _ in 0..<50 where meetings.isEmpty {
          try? await Task.sleep(for: .milliseconds(100))
        }
        if let first = meetings.first {
          quickStartedMeeting = first
        }
      }
      .alert(
        "无法开始录音",
        isPresented: Binding(
          get: { quickStartError != nil },
          set: { if !$0 { quickStartError = nil } }
        )
      ) {
        // 权限被拒时直达系统设置，不留文字死胡同。
        if let quickStartError, quickStartError.contains("未获得"), quickStartError.contains("权限") {
          Button("打开系统设置") {
            if let url = URL(string: UIApplication.openSettingsURLString) {
              UIApplication.shared.open(url)
            }
          }
        }
        Button("好", role: .cancel) { quickStartError = nil }
      } message: {
        Text(quickStartError ?? "")
      }
    }
  }

  // MARK: - 快速开会

  /// 零填写创建会议并立即录音转录；成功后推入详情页（录音中）。
  private func startQuickMeeting() {
    Task {
      do {
        quickStartedMeeting = try await MeetingQuickStart.createAndStartRecording(
          in: modelContext,
          appState: appState,
          recorder: recorder,
          preferences: preferences
        )
      } catch {
        quickStartError = error.localizedDescription
      }
    }
  }

  @ViewBuilder
  private func rows(_ values: [MeetingRecord]) -> some View {
    ForEach(values) { meeting in
      NavigationLink {
        PhoneMeetingDetailView(meeting: meeting)
          .onAppear { appState.selectedMeetingID = meeting.id }
      } label: {
        MeetingLibraryRow(meeting: meeting)
      }
      .swipeActions(edge: .leading) {
        Button {
          meeting.isFavorite.toggle()
        } label: {
          Label(
            meeting.isFavorite ? "取消收藏" : "收藏",
            systemImage: meeting.isFavorite ? "star.slash" : "star"
          )
        }
        .tint(.yellow)
      }
      .swipeActions(edge: .trailing) {
        Button(role: .destructive) {
          meeting.isDeleted = true
        } label: {
          Label("删除", systemImage: "trash")
        }
      }
    }
  }

  private var favorites: [MeetingRecord] {
    filteredMeetings.filter(\.isFavorite)
  }

  private var nonFavoriteMeetings: [MeetingRecord] {
    filteredMeetings.filter { !$0.isFavorite }
  }

  /// 按标题、个人笔记、纪要与转录全文做大小写不敏感搜索。
  private var filteredMeetings: [MeetingRecord] {
    guard !searchText.isEmpty else { return meetings }
    return meetings.filter {
      [$0.title, $0.personalNotes, $0.summaryText, $0.transcriptText]
        .contains { $0.localizedCaseInsensitiveContains(searchText) }
    }
  }
}

/// 会议详情两段：AI 纪要（合并后的可编辑纪要文档）与 转写。
/// 默认段随会议状态：录音中先看转写，会前准备/会后整理先看纪要（与 Mac 一致）。
enum MeetingDetailSection: String, CaseIterable, Identifiable {
  case summary = "AI 纪要"
  case transcript = "转写"

  var id: String { rawValue }

  static func defaultSection(for status: MeetingStatus) -> MeetingDetailSection {
    status == .recording ? .transcript : .summary
  }
}

/// 会议详情内容切换（iPhone 详情页与 iPad 中栏共用）：
/// 顶部分段「AI 纪要 | 转写」，不包含录音条（由外层工作区放置）。
struct MeetingDetailTabsView: View {
  let meeting: MeetingRecord
  @State private var selectedSection: MeetingDetailSection
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(meeting: MeetingRecord) {
    self.meeting = meeting
    // 截图驱动：UI_TESTING_INITIAL=transcript 时直接落在转写段（Release 下为 nil）。
    let override: MeetingDetailSection? =
      UITestingLauncher.initialRoute == .transcript ? .transcript : nil
    _selectedSection = State(
      initialValue: override ?? MeetingDetailSection.defaultSection(for: meeting.status)
    )
  }

  var body: some View {
    VStack(spacing: 0) {
      Picker("会议内容", selection: $selectedSection) {
        ForEach(MeetingDetailSection.allCases) { section in
          Text(section.rawValue).tag(section)
        }
      }
      .pickerStyle(.segmented)
      .accessibilityIdentifier("meeting-detail-sections")
      .padding(.horizontal)
      .padding(.vertical, 10)
      .background(MeetingTheme.surface)

      Group {
        switch selectedSection {
        case .summary:
          MeetingDocumentView(meeting: meeting)
        case .transcript:
          TranscriptPanelView(meeting: meeting)
        }
      }
      .id(selectedSection)
      .transition(.opacity)
    }
    .animation(reduceMotion ? ContentMotion.quick : ContentMotion.view, value: selectedSection)
  }
}

/// iPhone 会议详情页：两段「AI 纪要 | 转录」内容（MeetingDetailTabsView）；
/// AI 问答经导航栏气泡按钮以弹层打开，底部常驻录音条。
private struct PhoneMeetingDetailView: View {
  let meeting: MeetingRecord
  @State private var showsChat = false
  @Environment(MeetingPlayer.self) private var player

  var body: some View {
    MeetingDetailTabsView(meeting: meeting)
      .navigationBarTitleDisplayMode(.inline)
      .navigationTitle("会议详情")
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          Button {
            showsChat = true
          } label: {
            Label("AI 问答", systemImage: "bubble.left.and.bubble.right")
          }
          .accessibilityIdentifier("chat-button")
        }
      }
      .sheet(isPresented: $showsChat) {
        MeetingChatPanelView(meeting: meeting)
          .presentationDetents([.medium, .large])
          .presentationDragIndicator(.visible)
      }
      .safeAreaInset(edge: .bottom, spacing: 6) {
        RecorderBar(meeting: meeting, compact: true)
          .padding(.horizontal, 12)
          .padding(.vertical, 6)
          .background(MeetingTheme.canvas)
      }
      // 详情页出现即挂载本会议音频（纪要分段同样会兜底）。
      .onAppear { player.attach(meeting: meeting) }
      // 截图驱动：UI_TESTING_INITIAL=chat 时打开 AI 问答弹层（Release 下为空操作）。
      .task {
        if UITestingLauncher.initialRoute == .chat {
          showsChat = true
        }
      }
  }
}

/// 行动项总览：聚合所有会议里未完成的行动项，按会议分组展示；
/// 由会议页工具栏「全部行动项」push 进入。
struct ActionItemsOverviewView: View {
  let meetings: [MeetingRecord]
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    List {
      if activeItems.isEmpty {
        ContentUnavailableView(
          "暂无行动项",
          systemImage: "checkmark.square",
          description: Text("会议纪要生成的行动项会集中显示在这里")
        )
      } else {
        ForEach(meetingsWithActiveItems, id: \.meeting.id) { group in
          Section(group.meeting.title) {
            ForEach(group.items) { item in
              ActionItemRow(item: item)
                .transition(ContentMotion.insertion(reduceMotion: reduceMotion))
            }
          }
        }
      }
    }
    .animation(ContentMotion.content, value: activeItems.map(\.item.id))
    .navigationTitle("行动项")
  }

  /** 展平所有会议中未完成的行动项为 (会议, 行动项) 对。 */
  private var activeItems: [(meeting: MeetingRecord, item: ActionItemRecord)] {
    meetings.flatMap { meeting in
      meeting.orderedActionItems
        .filter { $0.status != .done }
        .map { (meeting, $0) }
    }
  }

  /** 每场会议只显示一个分组标题，组内保留行动项原有顺序。 */
  private var meetingsWithActiveItems: [(meeting: MeetingRecord, items: [ActionItemRecord])] {
    meetings.compactMap { meeting in
      let items = meeting.orderedActionItems.filter { $0.status != .done }
      return items.isEmpty ? nil : (meeting, items)
    }
  }
}

/// iPad 三栏未选中会议时的占位视图。
private struct EmptyMeetingSelectionView: View {
  var body: some View {
    ContentUnavailableView(
      "选择一场会议",
      systemImage: "doc.text",
      description: Text("从会议库选择内容，或新建会议开始录音")
    )
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(MeetingTheme.canvas)
  }
}
