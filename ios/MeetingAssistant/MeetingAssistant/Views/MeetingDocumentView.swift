//
//  MeetingDocumentView.swift
//  MeetingAssistant
//
//  会议文档主视图（即「AI 纪要」分段）：从上到下渲染标题栏（标题/状态/收藏/导出
//  分享）、会议目标与议程、我的记录、纪要操作行、关键结论、视觉纪要入口、行动项
//  与决策跟进等文档卡片，全部字段就地可编辑。
//  所属层：视图层。
//

import SwiftData
import SwiftUI

/// 会议文档视图：轻量文档式中央编辑区，AI 纪要的唯一编辑入口。
/// 导航位置：iPad 为三栏中栏；iPhone 为详情页「AI 纪要」分段。
struct MeetingDocumentView: View {
  // MARK: - 环境与状态

  /// SwiftData 上下文（编辑后保存）。
  @Environment(\.modelContext) private var modelContext
  /// 读取自动纪要间隔用于展示。
  @Environment(AppPreferences.self) private var preferences
  /// 回放播放器（文档页负责把本会议音频挂载上去）。
  @Environment(MeetingPlayer.self) private var player
  /// 录音协调器（更新纪要时拼接实时转录）。
  @Environment(RecordingCoordinator.self) private var recorder
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// 双向绑定的会议模型。
  @Bindable var meeting: MeetingRecord
  /// 导出成功的文件（非 nil 时弹出系统分享面板）。
  @State private var shareItem: ShareItem?
  /// 导出失败文案（alert 展示）。
  @State private var exportError: String?
  /// 是否正在生成/更新纪要（普通或视觉）。
  @State private var isSummarizing = false
  /// 纪要生成失败文案（alert 展示）。
  @State private var summaryError: String?
  /// 全屏查看视觉纪要海报。
  @State private var showsVisualPoster = false

  // MARK: - 视图内容

  var body: some View {
    // 文档纵向结构：页眉 + 纪要操作条 + 回放条 + 各内容卡片。
    VStack(spacing: 0) {
      documentHeader
      summaryStrip
      // 回放条：仅有可回放本机音频时出现；紧凑「回放」操作，展开时间轴。
      PlaybackBar(meeting: meeting)
      ScrollView {
        LazyVStack(spacing: 16) {
          goalAndAgenda
          personalNotes
          liveMinutes
          visualSummaryEntry
          actionItems
          decisionsAndFollowUp
        }
        .padding(24)
        .padding(.bottom, 86)
      }
      .scrollDismissesKeyboard(.interactively)
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
    // 纪要更新失败提示。
    .alert(
      "纪要更新失败",
      isPresented: Binding(
        get: { summaryError != nil },
        set: { if !$0 { summaryError = nil } }
      )
    ) {
      Button("好") { summaryError = nil }
    } message: {
      Text(summaryError ?? "")
    }
    // 视觉纪要全屏查看（含重新生成）。
    .fullScreenCover(isPresented: $showsVisualPoster) {
      VisualSummaryCover(
        meeting: meeting,
        isSummarizing: isSummarizing,
        canRegenerate: preferences.visualSummaryIsVerified,
        onRegenerate: { Task { await retryVisualSummary() } },
        onDismiss: { showsVisualPoster = false }
      )
    }
    // 标题、参与者或笔记变化时刷新更新时间并保存。
    .onChange(of: meeting.title) { _, _ in markUpdated() }
    .onChange(of: meeting.participantsText) { _, _ in markUpdated() }
    .onChange(of: meeting.personalNotes) { _, _ in markUpdated() }
    // 关键结论卡片的就地编辑写回 summaryText 后同样落盘。
    .onChange(of: meeting.summaryText) { _, _ in markUpdated() }
    // 挂载本会议音频到全局回放播放器（缺文件时自动卸载，不留空播放器）。
    .onAppear { player.attach(meeting: meeting) }
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
          Image(systemName: "square.and.arrow.up")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(width: 34, height: 34)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("分享或导出")
      }
      .padding(.horizontal, 24)
      .frame(minHeight: 58)

      HStack(spacing: 14) {
        // 窄屏（iPhone）放不下时换行成两行，避免参与者输入框被压到「添加…」。
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 16) {
            metaFields
            Spacer()
            Text("已保存到本机")
              .foregroundStyle(.tertiary)
          }
          VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 16) { metaFields }
            Text("已保存到本机")
              .foregroundStyle(.tertiary)
          }
        }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
      .padding(.horizontal, 24)
      .padding(.bottom, 16)
    }
    .background(MeetingTheme.surface)
  }

  /// 元信息字段：日期、会议形式与可编辑参与者。
  private var metaFields: some View {
    HStack(spacing: 16) {
      Label(
        MeetingFormatters.dateTime(meeting.startedAt),
        systemImage: "calendar"
      )
      Label(meeting.meetingMode, systemImage: "person.2")
      // 参与者就地可编辑（顿号/逗号分隔），与桌面端 meta 行一致。
      Label {
        TextField("添加参与者", text: $meeting.participantsText)
          .frame(maxWidth: 170)
          .accessibilityLabel("参与者")
      } icon: {
        Image(systemName: "person.3")
      }
    }
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
          in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .accessibilityLabel("我的会议记录")
    }
  }

  /// 「关键结论 / 会议进展」卡片：暖色圆点行（与桌面端同一视觉语言），
  /// 其余纪要小节只读展示；决策/风险等另有可编辑卡片。
  private var liveMinutes: some View {
    KeyConclusionsCard(
      title: meeting.status == .recording ? "会议进展" : "关键结论",
      markdown: $meeting.summaryText,
      revision: meeting.lastSummaryAt,
      cadence: meeting.status == .recording
        ? "每 \(max(1, preferences.summaryIntervalSeconds / 60)) 分钟更新" : nil,
      lastUpdated: meeting.lastSummaryAt
        .map { "更新于 \($0.formatted(date: .omitted, time: .shortened))" },
      showsRemainingSections: true
    )
  }

  /// 纪要操作条（吸附在文档页眉下方，滚动时始终可见）：一行状态说明 +
  /// 「生成/更新纪要」主操作。与桌面端会后状态带同一信息结构——
  /// 生成纪要是会后整理的首要动作，不能埋在目标/议程两块编辑器之后。
  private var summaryStrip: some View {
    HStack(spacing: 10) {
      Text(summaryStripText)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .minimumScaleFactor(0.85)
      Spacer()
      if isSummarizing {
        HStack(spacing: 6) {
          ProgressView()
            .controlSize(.small)
          Text("正在整理…")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      } else {
        Button(action: { Task { await summarize() } }) {
          Label(hasSummary ? "更新纪要" : "生成纪要", systemImage: "sparkles")
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .accessibilityIdentifier("update-summary-button")
      }
    }
    .padding(.horizontal, 24)
    .padding(.vertical, 9)
    .background(MeetingTheme.surface)
    .overlay(alignment: .bottom) { Divider() }
  }

  /// 操作条左侧的状态说明：随录音状态与纪要是否已生成变化。
  private var summaryStripText: String {
    if meeting.status == .recording {
      return "录音中每 \(max(1, preferences.summaryIntervalSeconds / 60)) 分钟自动更新"
    }
    if !hasSummary {
      return "还没有生成纪要，转录与笔记就绪后一键归纳"
    }
    if let last = meeting.lastSummaryAt {
      return "纪要更新于 \(last.formatted(date: .omitted, time: .shortened))"
    }
    return "最终纪要由你手动更新"
  }

  /// 是否已有可更新的纪要内容（关键结论或任一跟进字段非空）。
  private var hasSummary: Bool {
    !meeting.summaryText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || !meeting.decisionsText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || !meeting.risksText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || !meeting.nextStepsText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// 「视觉纪要」入口卡：已生成时一键全屏查看；未生成且已通过结构验证时提供生成入口。
  /// 功能未开启且从未生成时不渲染，避免文档内堆积设置引导。
  @ViewBuilder
  private var visualSummaryEntry: some View {
    if meeting.visualSummary != nil || (preferences.visualSummaryIsVerified && !meeting.summaryText.isEmpty) {
      DocumentCard("视觉纪要", systemImage: "rectangle.3.group") {
        if let visual = meeting.visualSummary {
          if visual.stale {
            Label("普通纪要已有更新，当前视觉版基于上一版本", systemImage: "exclamationmark.triangle.fill")
              .font(.caption)
              .foregroundStyle(MeetingTheme.warning)
          }
          Text("把已生成的普通纪要排成一页可分享的信息图。")
            .font(.caption)
            .foregroundStyle(.secondary)
          Button {
            showsVisualPoster = true
          } label: {
            Label("查看视觉纪要", systemImage: "rectangle.expand.vertical")
          }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("show-visual-summary-button")
        } else {
          Text("把已生成的普通纪要排成一页可分享的信息图。")
            .font(.caption)
            .foregroundStyle(.secondary)
          Button {
            Task { await retryVisualSummary() }
          } label: {
            if isSummarizing {
              ProgressView()
                .controlSize(.small)
            } else {
              Label("生成视觉纪要", systemImage: "sparkles")
            }
          }
          .buttonStyle(.bordered)
          .controlSize(.small)
          .disabled(isSummarizing)
          .accessibilityIdentifier("generate-visual-summary-button")
        }
      }
    }
  }

  /// “行动项”卡片：行动项列表（或紧凑空态行）+ 手动添加按钮。
  private var actionItems: some View {
    DocumentCard("行动项", systemImage: "checkmark.square") {
      if meeting.orderedActionItems.isEmpty {
        // 空态是一条紧凑提示行，不再用整块图标空态把卡片撑到两屏高。
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Text("生成纪要后会自动归纳行动项，也可以先手动添加。")
            .font(.caption)
            .foregroundStyle(.secondary)
          Spacer(minLength: 8)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      } else {
        ForEach(meeting.orderedActionItems) { item in
          ActionItemRow(item: item)
            .transition(ContentMotion.insertion(reduceMotion: reduceMotion))
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
        withAnimation(ContentMotion.content) { meeting.actionItems.append(item) }
        markUpdated()
      } label: {
        Label("添加行动项", systemImage: "plus")
      }
      .buttonStyle(.borderless)
    }
    .animation(ContentMotion.content, value: meeting.orderedActionItems.map(\.id))
  }

  /// “决策、问题与下一步”卡片：决策/未决/风险/下一步四个可编辑小节。
  private var decisionsAndFollowUp: some View {
    DocumentCard("决策、问题与下一步", systemImage: "signpost.right.and.left") {
      LabeledEditor(
        label: "决策",
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

  /// 拼接定稿转录（含录音中的实时文本）与笔记生成纪要并保存；
  /// 会后已通过视觉结构验证时顺带生成视觉版并打开海报。
  /// - 副作用：写回 meeting 字段、保存 SwiftData；远程模式下发起网络调用。
  private func summarize() async {
    withAnimation(ContentMotion.quick) { isSummarizing = true }
    defer { withAnimation(ContentMotion.quick) { isSummarizing = false } }
    do {
      let transcript =
        meeting.transcriptText
        + (recorder.activeMeetingID == meeting.id ? "\n\(recorder.liveTranscript)" : "")
      let draft = try await SummaryService().summarize(
        transcript: transcript,
        notes: meeting.personalNotes,
        preferences: preferences
      )
      withAnimation(ContentMotion.content) { meeting.apply(summary: draft) }
      try modelContext.save()
      if meeting.status == .completed && preferences.visualSummaryIsVerified,
        let sourceDate = meeting.lastSummaryAt
      {
        do {
          let visual = try await SummaryService().generateVisualSummary(
            title: meeting.title,
            participants: meeting.participants,
            summary: draft,
            sourceSummaryUpdatedAt: sourceDate,
            preferences: preferences
          )
          try meeting.apply(visualSummary: visual)
          try modelContext.save()
          showsVisualPoster = true
        } catch {
          summaryError = "普通纪要已保存，但视觉版生成失败：\(error.localizedDescription)"
        }
      }
    } catch {
      summaryError = error.localizedDescription
    }
  }

  /// 依据已保存的普通纪要单独重试视觉版；成功后打开海报。
  private func retryVisualSummary() async {
    guard let sourceDate = meeting.lastSummaryAt else {
      summaryError = "请先生成普通纪要"
      return
    }
    withAnimation(ContentMotion.quick) { isSummarizing = true }
    defer { withAnimation(ContentMotion.quick) { isSummarizing = false } }
    do {
      let visual = try await SummaryService().generateVisualSummary(
        title: meeting.title,
        participants: meeting.participants,
        summary: meeting.summaryDraft,
        sourceSummaryUpdatedAt: sourceDate,
        preferences: preferences
      )
      try meeting.apply(visualSummary: visual)
      try modelContext.save()
      showsVisualPoster = true
    } catch {
      summaryError = error.localizedDescription
    }
  }
}

/// 视觉纪要全屏查看：海报 + 完成关闭 + 重新生成（需通过结构验证）。
private struct VisualSummaryCover: View {
  @Bindable var meeting: MeetingRecord
  let isSummarizing: Bool
  let canRegenerate: Bool
  let onRegenerate: () -> Void
  let onDismiss: () -> Void

  var body: some View {
    NavigationStack {
      ScrollView {
        if let visual = meeting.visualSummary {
          VisualSummaryPoster(meeting: meeting, visual: visual)
            .frame(maxWidth: 920)
            .padding(20)
            .padding(.bottom, 40)
        }
      }
      .navigationTitle("视觉纪要")
      .navigationBarTitleDisplayMode(.inline)
      .background(MeetingTheme.canvas)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("完成", action: onDismiss)
        }
        ToolbarItem(placement: .primaryAction) {
          Button(action: onRegenerate) {
            if isSummarizing {
              ProgressView()
            } else {
              Label("重新生成", systemImage: "arrow.clockwise")
            }
          }
          .disabled(isSummarizing || !canRegenerate)
        }
      }
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
        withAnimation(ContentMotion.quick) {
          item.status = item.status == .done ? .todo : .done
        }
      } label: {
        Image(systemName: item.status == .done ? "checkmark.square.fill" : "square")
          .font(.title3)
          .foregroundStyle(item.status == .done ? MeetingTheme.success : .secondary)
          .contentTransition(.opacity)
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
          // 状态胶囊菜单：未开始/进行中/已完成三档，与桌面端行动项状态选择一致。
          Menu {
            ForEach(ActionItemStatus.allCases, id: \.self) { status in
              Button(status.title) {
                withAnimation(ContentMotion.quick) { item.status = status }
              }
            }
          } label: {
            HStack(spacing: 5) {
              Circle()
                .fill(statusColor)
                .frame(width: 6, height: 6)
              Text(item.status.title)
              Image(systemName: "chevron.down")
                .font(.caption2)
                .foregroundStyle(.tertiary)
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(statusColor)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(statusColor.opacity(0.1), in: Capsule())
          }
          .menuOrder(.fixed)
        }
        .foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 4)
  }

  /// 状态语义色：未开始灰、进行中琥珀、已完成绿。
  private var statusColor: Color {
    switch item.status {
    case .todo: .secondary
    case .inProgress: MeetingTheme.warning
    case .done: MeetingTheme.success
    }
  }
}

/// 分享面板条目包装（Identifiable，驱动 sheet(item:)）。
struct ShareItem: Identifiable {
  let id = UUID()
  let url: URL
}
