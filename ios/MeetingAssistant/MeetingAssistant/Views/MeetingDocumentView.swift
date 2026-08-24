//
//  MeetingDocumentView.swift
//  MeetingAssistant
//
//  会议文档主视图：从上到下渲染标题栏（标题/状态/收藏/导出分享）、会议目标与
//  议程、我的记录、实时纪要、行动项与决策跟进等文档卡片，全部字段就地可编辑。
//  所属层：视图层。
//

import SwiftData
import SwiftUI

/// 会议文档视图：轻量文档式中央编辑区。
/// 导航位置：iPad 为 NavigationSplitView 中栏（content）；iPhone 为详情页“文档”分段。
struct MeetingDocumentView: View {
  private enum DocumentMode: String, CaseIterable, Identifiable {
    case normal = "普通纪要"
    case visual = "视觉纪要"
    var id: String { rawValue }
  }
  // MARK: - 环境与状态

  /// SwiftData 上下文（编辑后保存）。
  @Environment(\.modelContext) private var modelContext
  /// 读取自动纪要间隔用于展示。
  @Environment(AppPreferences.self) private var preferences
  /// 双向绑定的会议模型。
  @Bindable var meeting: MeetingRecord
  /// iPad 三栏中栏显式开启切换；不能依赖中栏自身的 size class（窄列会被系统标记为 compact）。
  var showsVisualSwitcher = false
  /// 导出成功的文件（非 nil 时弹出系统分享面板）。
  @State private var shareItem: ShareItem?
  /// 导出失败文案（alert 展示）。
  @State private var exportError: String?
  @State private var documentMode: DocumentMode = .normal

  // MARK: - 视图内容

  var body: some View {
    // 文档纵向结构：页眉 + 各内容卡片。
    VStack(spacing: 0) {
      documentHeader
      if showsVisualSwitcher {
        Picker("纪要显示方式", selection: $documentMode) {
          ForEach(DocumentMode.allCases) { mode in Text(mode.rawValue).tag(mode) }
        }
        .pickerStyle(.segmented)
        .frame(maxWidth: 280)
        .padding(.top, 10)
      }
      if showsVisualSwitcher, documentMode == .visual {
        ScrollView {
          if let visual = meeting.visualSummary {
            VisualSummaryPoster(meeting: meeting, visual: visual)
              .frame(maxWidth: 920)
              .padding(20)
              .padding(.bottom, 86)
          } else {
            ContentUnavailableView(
              preferences.visualSummaryIsVerified ? "尚未生成视觉纪要" : "当前使用普通纪要",
              systemImage: "rectangle.3.group",
              description: Text(preferences.visualSummaryIsVerified
                ? "生成最终纪要后会自动排成可分享的信息图"
                : "请在设置中开启视觉纪要并通过结构验证")
            )
            .frame(maxWidth: .infinity, minHeight: 420)
            .padding(20)
          }
        }
      } else {
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
    }
    .background(MeetingTheme.canvas)
    .navigationSplitViewColumnWidth(min: 420, ideal: 620)
    // 导出成功后弹出系统分享面板。
    .sheet(item: $shareItem) { item in
      ShareSheet(items: [item.url])
    }
    // 导出失败提示。
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
    // 标题或笔记变化时刷新更新时间并保存。
    .onChange(of: meeting.title) { _, _ in markUpdated() }
    .onChange(of: meeting.personalNotes) { _, _ in markUpdated() }
    .onChange(of: meeting.visualSummary?.generatedAt) { _, generatedAt in
      if generatedAt != nil, showsVisualSwitcher { documentMode = .visual }
    }
  }

  // MARK: - 分区视图

  /// 页眉：标题输入、状态胶囊、收藏切换、导出分享菜单与会议元信息。
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
          ForEach(MeetingExportFormat.allCases.filter { $0 != .visualPNG || (meeting.visualSummary?.stale == false) }) { format in
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

  /// “会议目标与议程”卡片：两个多行编辑器。
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

  /// “我的记录”卡片：人工笔记编辑器（AI 不覆盖，录音标记会追加到此）。
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

  /// “实时纪要”卡片：AI 纪要文本（可编辑）+ 更新频率与最近更新时间。
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

  /// “行动项”卡片：行动项列表（或空态）+ 手动添加按钮。
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

  /// “决策、问题与风险”卡片：决策/未决/风险/下一步四个可编辑小节。
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

  // MARK: - 私有方法

  /// 刷新 updatedAt 并立即保存到 SwiftData。
  private func markUpdated() {
    meeting.updatedAt = .now
    try? modelContext.save()
  }

  /// 生成导出文件并触发分享面板；失败时以 alert 提示。
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

/// 带标签与占位文本的多行编辑器（ZStack 叠加占位符模拟 placeholder）。
private struct LabeledEditor: View {
  /// 字段标签。
  let label: String
  /// 空内容时的占位提示。
  let placeholder: String
  /// 绑定的文本。
  @Binding var text: String
  /// 最小高度。
  var minHeight: CGFloat = 74

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text(label)
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
      ZStack(alignment: .topLeading) {
        // 仅在文本为空时显示占位符。
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

/// 行动项行：完成勾选、标题、负责人与截止日期（全部就地编辑）。
/// 同时被会议文档与“行动项”总览复用。
struct ActionItemRow: View {
  /// 双向绑定的行动项。
  @Bindable var item: ActionItemRecord

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      // 勾选按钮：在已完成/未开始之间切换。
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

/// 分享面板条目包装（Identifiable，驱动 sheet(item:)）。
struct ShareItem: Identifiable {
  let id = UUID()
  let url: URL
}
