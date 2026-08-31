//
//  WorkspaceViews.swift
//  MeetingAssistant
//
//  自适应工作区视图：iPad 用 NavigationSplitView 组装三栏布局（会议库/文档/洞察面板），
//  iPhone 用 TabView 组装三标签布局（会议/行动项/设置），并把会议详情组织为
//  「文档/转录/AI 纪要」分段页。由 AppRootView 按 horizontalSizeClass 选择装配。
//

import SwiftUI

/// iPad 三栏工作区：侧栏会议库 + 中栏会议文档 + 详情栏洞察面板，底部安全区内放置录音条。
struct TabletWorkspaceView: View {
  @Environment(AppState.self) private var appState
  let meetings: [MeetingRecord]
  let onImport: () -> Void
  /// 三栏可见性（用户可手动收起侧栏/中栏）。
  @State private var columnVisibility: NavigationSplitViewVisibility = .all

  var body: some View {
    NavigationSplitView(columnVisibility: $columnVisibility) {
      MeetingLibraryView(meetings: meetings, onImport: onImport)
    } content: {
      if let meeting = selectedMeeting {
        MeetingDocumentView(meeting: meeting, showsVisualSwitcher: true)
          .navigationSplitViewColumnWidth(min: 420, ideal: 610, max: 760)
      } else {
        EmptyMeetingSelectionView()
      }
    } detail: {
      if let meeting = selectedMeeting {
        InsightPanelView(meeting: meeting)
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
  }

  /// 从 AppState 的选中 id 解析当前会议对象。
  private var selectedMeeting: MeetingRecord? {
    guard let id = appState.selectedMeetingID else { return nil }
    return meetings.first { $0.id == id }
  }
}

/// iPhone 工作区：底部三标签（会议库 / 行动项总览 / 设置）。
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

      ActionItemsOverviewView(meetings: meetings)
        .tabItem {
          Label("行动项", systemImage: "checkmark.square")
        }
        .tag(AppState.PhoneTab.actions)

      NavigationStack {
        SettingsView(showsDoneButton: false)
      }
      .tabItem {
        Label("设置", systemImage: "gearshape")
      }
      .tag(AppState.PhoneTab.settings)
    }
  }
}

/// iPhone「会议」标签：可搜索的会议列表（收藏/最近两组），支持左滑收藏、右滑软删除。
private struct PhoneMeetingsView: View {
  @Environment(AppState.self) private var appState
  let meetings: [MeetingRecord]
  let onImport: () -> Void
  @State private var searchText = ""

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
          Button {
            appState.presentedSheet = .newMeeting
          } label: {
            Label("新建会议", systemImage: "plus")
          }
          .accessibilityIdentifier("new-meeting-button")
        }
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

/// iPhone 会议详情页：顶部分段切换 文档 / 转录 / AI 纪要，底部常驻录音条。
private struct PhoneMeetingDetailView: View {
  enum Section: String, CaseIterable, Identifiable {
    case document = "文档"
    case transcript = "转录"
    case summary = "AI 纪要"

    var id: String { rawValue }
  }

  let meeting: MeetingRecord
  @State private var selectedSection: Section = .document
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(spacing: 0) {
      Picker("会议内容", selection: $selectedSection) {
        ForEach(Section.allCases) { section in
          Text(section.rawValue).tag(section)
        }
      }
      .pickerStyle(.segmented)
      .padding(.horizontal)
      .padding(.vertical, 10)
      .background(MeetingTheme.surface)

      Group {
        switch selectedSection {
        case .document:
          MeetingDocumentView(meeting: meeting)
        case .transcript:
          TranscriptPanelView(meeting: meeting)
        case .summary:
          SummaryPanelView(meeting: meeting)
        }
      }
      .id(selectedSection)
      .transition(.opacity)
    }
    .navigationBarTitleDisplayMode(.inline)
    .animation(reduceMotion ? ContentMotion.quick : ContentMotion.view, value: selectedSection)
    .navigationTitle(selectedSection == .document ? "会议文档" : selectedSection.rawValue)
    .safeAreaInset(edge: .bottom, spacing: 6) {
      RecorderBar(meeting: meeting, compact: true)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(MeetingTheme.canvas)
    }
  }
}

/// 行动项总览（iPhone 第二标签）：聚合所有会议里未完成的行动项，按会议分组展示。
struct ActionItemsOverviewView: View {
  let meetings: [MeetingRecord]
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    NavigationStack {
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
