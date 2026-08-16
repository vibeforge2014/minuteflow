//
//  MeetingLibraryView.swift
//  MeetingAssistant
//
//  会议库侧栏：品牌标题、新建按钮、搜索框、“收藏/最近会议”两组列表
//  与底部设置/导入操作；行支持左滑收藏与右滑软删除。
//  所属层：视图层。
//

import SwiftUI

/// 会议库侧栏视图。
/// 导航位置：iPad NavigationSplitView 第一栏（sidebar）；iPhone 由 PhoneMeetingsView 替代。
struct MeetingLibraryView: View {
  /// 全局 UI 状态（选中会议、搜索词、弹层）。
  @Environment(AppState.self) private var appState
  /// 传入的会议列表（已按开始时间倒序）。
  let meetings: [MeetingRecord]
  /// 导入按钮回调（由根视图唤起文件选择器）。
  let onImport: () -> Void

  var body: some View {
    @Bindable var appState = appState

    VStack(spacing: 0) {
      libraryHeader
      searchField(text: $appState.searchText)
        .padding(.horizontal, 14)
        .padding(.bottom, 10)

      // List(selection:) 双向绑定选中会议，驱动中栏/右栏内容。
      List(selection: $appState.selectedMeetingID) {
        if !favoriteMeetings.isEmpty {
          Section("收藏") {
            meetingRows(favoriteMeetings)
          }
        }
        Section("最近会议") {
          meetingRows(nonFavoriteMeetings)
        }
      }
      .listStyle(.sidebar)
      .scrollContentBackground(.hidden)

      libraryFooter
    }
    .background(MeetingTheme.sidebar)
    .navigationTitle("会议")
    .navigationSplitViewColumnWidth(min: 230, ideal: 270, max: 330)
  }

  // MARK: - 分区视图

  /// 侧栏页眉：品牌标识 + “新建会议”主按钮。
  private var libraryHeader: some View {
    VStack(spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "waveform.badge.mic")
          .font(.title3.weight(.semibold))
          .foregroundStyle(MeetingTheme.primary)
        Text("MinuteFlow")
          .font(.headline)
        Spacer()
      }
      Button {
        appState.presentedSheet = .newMeeting
      } label: {
        Label("新建会议", systemImage: "plus")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .accessibilityIdentifier("new-meeting-button")
    }
    .padding(14)
  }

  /// 自定义搜索框（放大镜 + 输入框 + 清除按钮）。
  private func searchField(text: Binding<String>) -> some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass")
        .foregroundStyle(.secondary)
      TextField("搜索会议或内容", text: text)
        .textFieldStyle(.plain)
      if !text.wrappedValue.isEmpty {
        Button {
          text.wrappedValue = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
            .foregroundStyle(.tertiary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("清除搜索")
      }
    }
    .padding(.horizontal, 10)
    .frame(height: 38)
    .background(MeetingTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: 9))
    .overlay {
      RoundedRectangle(cornerRadius: 9)
        .stroke(MeetingTheme.divider)
    }
  }

  /// 渲染会议行：左滑收藏/取消收藏，右滑软删除（移到最近删除）。
  @ViewBuilder
  private func meetingRows(_ values: [MeetingRecord]) -> some View {
    ForEach(values) { meeting in
      MeetingLibraryRow(meeting: meeting)
        .tag(meeting.id)
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
            if appState.selectedMeetingID == meeting.id {
              appState.selectedMeetingID =
                filteredMeetings.first {
                  $0.id != meeting.id
                }?.id
            }
          } label: {
            Label("移到最近删除", systemImage: "trash")
          }
        }
    }
  }

  /// 侧栏底栏：设置入口与导入入口。
  private var libraryFooter: some View {
    HStack {
      Button {
        appState.presentedSheet = .settings
      } label: {
        Label("设置", systemImage: "gearshape")
      }
      Spacer()
      Button(action: onImport) {
        Label("导入", systemImage: "square.and.arrow.down")
      }
    }
    .buttonStyle(.plain)
    .font(.subheadline)
    .foregroundStyle(.secondary)
    .padding(16)
    .overlay(alignment: .top) {
      Divider()
    }
  }

  // MARK: - 过滤辅助

  /// 过滤后的收藏会议。
  private var favoriteMeetings: [MeetingRecord] {
    filteredMeetings.filter(\.isFavorite)
  }

  /// 过滤后的非收藏（最近）会议。
  private var nonFavoriteMeetings: [MeetingRecord] {
    filteredMeetings.filter { !$0.isFavorite }
  }

  /// 按搜索词过滤（匹配标题/标签/笔记/纪要/转录，大小写不敏感）。
  private var filteredMeetings: [MeetingRecord] {
    let query = appState.searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return meetings }
    return meetings.filter { meeting in
      [
        meeting.title,
        meeting.tagsText,
        meeting.personalNotes,
        meeting.summaryText,
        meeting.transcriptText,
      ]
      .contains { $0.localizedCaseInsensitiveContains(query) }
    }
  }
}

/// 会议库行：标题（录音中带红点/星标）+ 日期、时长与状态摘要。
/// iPad 侧栏与 iPhone 会议列表共用。
struct MeetingLibraryRow: View {
  /// 展示的会议。
  let meeting: MeetingRecord

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(spacing: 7) {
        // 录音中的会议显示红色呼吸圆点。
        if meeting.status == .recording {
          Circle()
            .fill(.red)
            .frame(width: 7, height: 7)
        }
        Text(meeting.title)
          .font(.subheadline.weight(.medium))
          .lineLimit(1)
        Spacer(minLength: 4)
        if meeting.isFavorite {
          Image(systemName: "star.fill")
            .font(.caption2)
            .foregroundStyle(.yellow)
        }
      }
      HStack(spacing: 8) {
        Text(MeetingFormatters.shortDate(meeting.startedAt))
        Text(MeetingFormatters.compactDuration(meeting.duration))
        if meeting.status == .recording {
          Text("进行中")
            .foregroundStyle(MeetingTheme.success)
        }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    }
    .padding(.vertical, 3)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "\(meeting.title)，\(meeting.status.title)，时长 \(MeetingFormatters.compactDuration(meeting.duration))"
    )
  }
}
