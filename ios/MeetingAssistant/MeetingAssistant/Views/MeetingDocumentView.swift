import SwiftData
import SwiftUI

struct MeetingDocumentView: View {
  @Environment(\.modelContext) private var modelContext
  @Environment(AppPreferences.self) private var preferences
  @Bindable var meeting: MeetingRecord
  @State private var shareItem: ShareItem?
  @State private var exportError: String?

  var body: some View {
    VStack(spacing: 0) {
      documentHeader
      ScrollView {
        LazyVStack(spacing: 14) {
          goalAndAgenda
          personalNotes
          liveMinutes
          actionItems
          decisionsAndFollowUp
        }
        .padding(20)
        .padding(.bottom, 86)
      }
      .scrollDismissesKeyboard(.interactively)
    }
    .background(MeetingTheme.canvas)
    .navigationSplitViewColumnWidth(min: 420, ideal: 620)
    .sheet(item: $shareItem) { item in
      ShareSheet(items: [item.url])
    }
    .alert(
      "导出失败",
      isPresented: Binding(
        get: { exportError != nil },
        set: { if !$0 { exportError = nil } }
      )
    ) {
      Button("好") { exportError = nil }
    } message: {
      Text(exportError ?? "")
    }
    .onChange(of: meeting.title) { _, _ in markUpdated() }
    .onChange(of: meeting.personalNotes) { _, _ in markUpdated() }
  }

  private var documentHeader: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        TextField("会议标题", text: $meeting.title)
          .font(.title3.weight(.semibold))
          .textFieldStyle(.plain)
          .accessibilityIdentifier("meeting-title-field")
        StatusPill(status: meeting.status)
        Button {
          meeting.isFavorite.toggle()
        } label: {
          Image(systemName: meeting.isFavorite ? "star.fill" : "star")
            .foregroundStyle(meeting.isFavorite ? .yellow : .secondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(meeting.isFavorite ? "取消收藏" : "收藏")

        Menu {
          ForEach(MeetingExportFormat.allCases) { format in
            Button(format.rawValue) {
              export(format)
            }
          }
        } label: {
          Label("分享", systemImage: "square.and.arrow.up")
        }
        .buttonStyle(.borderedProminent)
      }
      .padding(.horizontal, 20)
      .frame(minHeight: 58)

      HStack(spacing: 18) {
        Label(
          MeetingFormatters.dateTime(meeting.startedAt),
          systemImage: "calendar"
        )
        Label(meeting.meetingMode, systemImage: "person.2")
        if !meeting.participants.isEmpty {
          Label(
            "\(meeting.participants.count) 位参与者",
            systemImage: "person.3"
          )
        }
        Spacer()
        Label("已保存到本机", systemImage: "checkmark.circle.fill")
          .foregroundStyle(MeetingTheme.success)
      }
      .font(.caption)
      .foregroundStyle(.secondary)
      .padding(.horizontal, 20)
      .padding(.bottom, 12)
      Divider()
    }
    .background(MeetingTheme.surface)
  }

  private var goalAndAgenda: some View {
    DocumentCard("会议目标与议程", systemImage: "scope") {
      LabeledEditor(
        label: "会议目标",
        placeholder: "这次会议要解决什么问题？",
        text: $meeting.goal,
        minHeight: 88
      )
      Divider()
      LabeledEditor(
        label: "议程",
        placeholder: "列出需要讨论的主题",
        text: $meeting.agenda,
        minHeight: 88
      )
    }
  }

  private var personalNotes: some View {
    DocumentCard("我的记录", systemImage: "pencil.line") {
      Text("人工笔记不会被 AI 覆盖，录音标记会自动附带时间。")
        .font(.caption)
        .foregroundStyle(.secondary)
      TextEditor(text: $meeting.personalNotes)
        .font(.body)
        .scrollContentBackground(.hidden)
        .frame(minHeight: 130)
        .padding(10)
        .background(
          Color(uiColor: .secondarySystemBackground),
          in: RoundedRectangle(cornerRadius: 10)
        )
        .accessibilityLabel("我的会议记录")
    }
  }

  private var liveMinutes: some View {
    DocumentCard("实时纪要", systemImage: "doc.text") {
      HStack {
        Label(
          "每 \(max(1, preferences.summaryIntervalSeconds / 60)) 分钟更新",
          systemImage: "circle.fill"
        )
        .font(.caption.weight(.medium))
        .foregroundStyle(MeetingTheme.success)
        Spacer()
        if let lastSummaryAt = meeting.lastSummaryAt {
          Text("更新于 \(lastSummaryAt.formatted(date: .omitted, time: .shortened))")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      TextEditor(text: $meeting.summaryText)
        .font(.body)
        .scrollContentBackground(.hidden)
        .frame(minHeight: 180)
        .padding(10)
        .background(MeetingTheme.primarySoft, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityLabel("可编辑会议纪要")
    }
  }

  private var actionItems: some View {
    DocumentCard("行动项", systemImage: "checkmark.square") {
      if meeting.orderedActionItems.isEmpty {
        ContentUnavailableView(
          "暂无行动项",
          systemImage: "checklist",
          description: Text("AI 纪要或手动添加的任务会显示在这里")
        )
        .frame(minHeight: 100)
      } else {
        ForEach(meeting.orderedActionItems) { item in
          ActionItemRow(item: item)
          if item.id != meeting.orderedActionItems.last?.id {
            Divider()
          }
        }
      }
      Button {
        let item = ActionItemRecord(
          title: "新的行动项",
          meeting: meeting
        )
        meeting.actionItems.append(item)
        markUpdated()
      } label: {
        Label("添加行动项", systemImage: "plus")
      }
      .buttonStyle(.borderless)
    }
  }

  private var decisionsAndFollowUp: some View {
    DocumentCard("决策、问题与风险", systemImage: "signpost.right.and.left") {
      LabeledEditor(
        label: "关键决策",
        placeholder: "记录已经确认的结论",
        text: $meeting.decisionsText
      )
      Divider()
      LabeledEditor(
        label: "未决问题",
        placeholder: "仍需确认的事项",
        text: $meeting.openQuestionsText
      )
      Divider()
      LabeledEditor(
        label: "风险",
        placeholder: "依赖、阻塞与潜在风险",
        text: $meeting.risksText
      )
      Divider()
      LabeledEditor(
        label: "下一步",
        placeholder: "会议后的后续安排",
        text: $meeting.nextStepsText
      )
    }
  }

  private func markUpdated() {
    meeting.updatedAt = .now
    try? modelContext.save()
  }

  private func export(_ format: MeetingExportFormat) {
    do {
      shareItem = ShareItem(
        url: try ExportService().makeFile(meeting: meeting, format: format)
      )
    } catch {
      exportError = error.localizedDescription
    }
  }
}

private struct LabeledEditor: View {
  let label: String
  let placeholder: String
  @Binding var text: String
  var minHeight: CGFloat = 74

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text(label)
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
      ZStack(alignment: .topLeading) {
        if text.isEmpty {
          Text(placeholder)
            .foregroundStyle(.tertiary)
            .padding(.horizontal, 5)
            .padding(.vertical, 8)
        }
        TextEditor(text: $text)
          .scrollContentBackground(.hidden)
          .frame(minHeight: minHeight)
      }
    }
  }
}

struct ActionItemRow: View {
  @Bindable var item: ActionItemRecord

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Button {
        item.status = item.status == .done ? .todo : .done
      } label: {
        Image(systemName: item.status == .done ? "checkmark.square.fill" : "square")
          .font(.title3)
          .foregroundStyle(item.status == .done ? MeetingTheme.success : .secondary)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(item.status == .done ? "标记为未完成" : "标记为完成")

      VStack(alignment: .leading, spacing: 8) {
        TextField("行动项", text: $item.title, axis: .vertical)
          .strikethrough(item.status == .done)
        HStack(spacing: 12) {
          Label {
            TextField("负责人", text: $item.owner)
              .frame(maxWidth: 90)
          } icon: {
            Image(systemName: "person")
          }
          if let dueDate = item.dueDate {
            Label {
              Text(MeetingFormatters.shortDate(dueDate))
            } icon: {
              Image(systemName: "calendar")
            }
            .font(.caption)
          } else {
            Text("未设置截止日期")
              .font(.caption)
              .foregroundStyle(.tertiary)
          }
          Spacer()
          Text(item.status.title)
            .font(.caption.weight(.medium))
            .foregroundStyle(item.status == .done ? MeetingTheme.success : .secondary)
        }
        .foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 4)
  }
}

struct ShareItem: Identifiable {
  let id = UUID()
  let url: URL
}
