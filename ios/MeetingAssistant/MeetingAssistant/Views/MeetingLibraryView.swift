import SwiftUI

struct MeetingLibraryView: View {
  @Environment(AppState.self) private var appState
  let meetings: [MeetingRecord]
  let onImport: () -> Void

  var body: some View {
    @Bindable var appState = appState

    VStack(spacing: 0) {
      libraryHeader
      searchField(text: $appState.searchText)
        .padding(.horizontal, 14)
        .padding(.bottom, 10)

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

  private var libraryHeader: some View {
    VStack(spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "waveform.badge.mic")
          .font(.title3.weight(.semibold))
          .foregroundStyle(MeetingTheme.primary)
        Text("会议助手")
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

  private var favoriteMeetings: [MeetingRecord] {
    filteredMeetings.filter(\.isFavorite)
  }

  private var nonFavoriteMeetings: [MeetingRecord] {
    filteredMeetings.filter { !$0.isFavorite }
  }

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

struct MeetingLibraryRow: View {
  let meeting: MeetingRecord

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(spacing: 7) {
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
