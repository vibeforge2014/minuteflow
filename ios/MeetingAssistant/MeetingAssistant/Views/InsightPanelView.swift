//
//  InsightPanelView.swift
//  MeetingAssistant
//
//  会议洞察面板：顶部“转录 / AI 纪要”分段切换，下方分别承载实时转录列表
//  与结构化纪要卡片；iPad 作为三栏布局的第三栏，iPhone 由详情页分段复用
//  TranscriptPanelView / SummaryPanelView。
//  所属层：视图层。
//

import SwiftData
import SwiftUI

/// 洞察面板容器：分段选择器 + 转录/纪要面板。
/// 导航位置：iPad NavigationSplitView 第三栏（detail）；iPhone 不整体使用。
struct InsightPanelView: View {
  /// 全局 UI 状态（读写检查面板标签）。
  @Environment(AppState.self) private var appState
  /// 目标会议。
  let meeting: MeetingRecord

  var body: some View {
    @Bindable var appState = appState

    VStack(spacing: 0) {
      HStack {
        Picker("侧边栏内容", selection: $appState.inspectorTab) {
          ForEach(AppState.InspectorTab.allCases) { tab in
            Text(tab.rawValue).tag(tab)
          }
        }
        .pickerStyle(.segmented)
        Spacer(minLength: 8)
      }
      .padding(14)
      .background(MeetingTheme.surface)
      Divider()

      // 按标签切换：转录面板 / AI 纪要面板。
      switch appState.inspectorTab {
      case .transcript:
        TranscriptPanelView(meeting: meeting)
      case .summary:
        SummaryPanelView(meeting: meeting)
      }
    }
    .background(MeetingTheme.surface)
    .navigationSplitViewColumnWidth(min: 300, ideal: 350, max: 430)
  }
}

/// 实时转录面板：定稿片段列表 + 录音中的临时转写行，自动滚动跟随最新内容。
/// 导航位置：iPad 为 InsightPanelView 的“转录”标签；iPhone 为详情页“转录”分段。
struct TranscriptPanelView: View {
  /// 录音协调器（临时转写与录音状态）。
  @Environment(RecordingCoordinator.self) private var recorder
  /// 目标会议。
  let meeting: MeetingRecord

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          HStack {
            Label("实时转录", systemImage: "waveform")
              .font(.caption.weight(.semibold))
              .foregroundStyle(MeetingTheme.primary)
            Spacer()
            Text("\(meeting.orderedSegments.count) 段")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 12)

          ForEach(meeting.orderedSegments) { segment in
            TranscriptSegmentRow(segment: segment)
              .id(segment.id)
            Divider()
              .padding(.leading, 54)
          }

          // 录音中的临时转写行（未定稿，软底色区分）。
          if recorder.activeMeetingID == meeting.id,
            !recorder.liveTranscript.isEmpty
          {
            LiveTranscriptRow(
              timestamp: TimeInterval(recorder.elapsedSeconds),
              text: recorder.liveTranscript
            )
            .id("live-transcript")
          }

          // 空状态：既无定稿片段也无实时文本。
          if meeting.orderedSegments.isEmpty && recorder.liveTranscript.isEmpty {
            ContentUnavailableView(
              "等待转录",
              systemImage: "waveform",
              description: Text("开始录音后，临时文本会显示在这里")
            )
            .frame(minHeight: 260)
          }
        }
      }
      .scrollDismissesKeyboard(.interactively)
      // 实时文本更新时平滑滚动到最新的临时转写行。
      .onChange(of: recorder.liveTranscript) { _, _ in
        withAnimation(.easeOut(duration: 0.2)) {
          proxy.scrollTo("live-transcript", anchor: .bottom)
        }
      }
    }
  }
}

/// 单条转录行：时间戳、可改名的说话人菜单、可编辑文本与定稿状态图标。
private struct TranscriptSegmentRow: View {
  /// 双向绑定的转录片段（就地编辑文本与说话人）。
  @Bindable var segment: TranscriptSegmentRecord

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Text(MeetingFormatters.timestamp(segment.startTime))
        .font(.caption.monospacedDigit())
        .foregroundStyle(.tertiary)
        .frame(width: 40, alignment: .leading)

      VStack(alignment: .leading, spacing: 6) {
        // 说话人菜单：点按改名（预设名单 + 快速选项）。
        Menu {
          ForEach(["我", "Speaker 1", "Speaker 2", "刘婷", "周哲"], id: \.self) { name in
            Button(name) { segment.speaker = name }
          }
        } label: {
          HStack(spacing: 4) {
            Text(segment.speaker)
              .font(.caption.weight(.semibold))
              .foregroundStyle(speakerColor)
            Image(systemName: "chevron.down")
              .font(.caption2)
              .foregroundStyle(.tertiary)
          }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("说话人 \(segment.speaker)，点按修改")

        TextField("转录内容", text: $segment.text, axis: .vertical)
          .font(.subheadline)
          .textFieldStyle(.plain)
      }

      // 定稿状态图标：定稿为对勾，未定稿为主题色省略号。
      Image(systemName: segment.isFinal ? "checkmark.circle" : "ellipsis.circle")
        .font(.caption)
        .foregroundStyle(
          segment.isFinal
            ? Color.secondary.opacity(0.45)
            : MeetingTheme.primary
        )
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
  }

  /// 按说话人分配固定颜色（“我”为主色，示例说话人有专属色）。
  private var speakerColor: Color {
    switch segment.speaker {
    case "我": MeetingTheme.primary
    case "刘婷": MeetingTheme.speakerViolet
    case "周哲": MeetingTheme.warning
    default: .secondary
    }
  }
}

/// 录音中的临时转写行（软底色 + 进度指示，区别于定稿片段）。
private struct LiveTranscriptRow: View {
  /// 当前录音秒数（展示用时间戳）。
  let timestamp: TimeInterval
  /// 实时识别文本。
  let text: String

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Text(MeetingFormatters.timestamp(timestamp))
        .font(.caption.monospacedDigit())
        .foregroundStyle(.tertiary)
        .frame(width: 40, alignment: .leading)
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
          Text("我")
            .font(.caption.weight(.semibold))
            .foregroundStyle(MeetingTheme.primary)
          Text("临时转写中")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        Text(text)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
      Spacer()
      ProgressView()
        .controlSize(.small)
    }
    .padding(14)
    .background(MeetingTheme.primarySoft)
  }
}

/// AI 纪要面板：手动“更新”按钮 + 决策/未决/风险/下一步四张可编辑卡片。
/// 导航位置：iPad 为 InsightPanelView 的“AI 纪要”标签；iPhone 为详情页同名分段。
struct SummaryPanelView: View {
  private enum DisplayMode: String, CaseIterable, Identifiable {
    case normal = "普通纪要"
    case visual = "视觉纪要"
    var id: String { rawValue }
  }
  /// SwiftData 上下文（保存纪要结果）。
  @Environment(\.modelContext) private var modelContext
  /// 录音协调器（拼接实时转录）。
  @Environment(RecordingCoordinator.self) private var recorder
  /// 用户偏好（纪要 Provider 参数）。
  @Environment(AppPreferences.self) private var preferences
  /// 双向绑定的会议（纪要字段可编辑）。
  @Bindable var meeting: MeetingRecord
  /// 是否正在请求纪要。
  @State private var isSummarizing = false
  /// 纪要失败文案（alert 展示）。
  @State private var errorMessage: String?
  @State private var displayMode: DisplayMode = .normal

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 14) {
        HStack {
          VStack(alignment: .leading, spacing: 3) {
            Text("结构化会议纪要")
              .font(.headline)
            Text("结合定稿转录与我的记录")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          Spacer()
          Button {
            Task { await summarize() }
          } label: {
            if isSummarizing {
              ProgressView()
                .controlSize(.small)
            } else {
              Label("更新", systemImage: "sparkles")
            }
          }
          .buttonStyle(.borderedProminent)
          .disabled(isSummarizing)
        }

        Picker("纪要显示方式", selection: $displayMode) {
          ForEach(DisplayMode.allCases) { mode in Text(mode.rawValue).tag(mode) }
        }
        .pickerStyle(.segmented)

        if displayMode == .normal {
          SummarySectionCard(
            title: "关键决策",
            systemImage: "checkmark.seal",
            text: $meeting.decisionsText
          )
          SummarySectionCard(
            title: "未决问题",
            systemImage: "questionmark.bubble",
            text: $meeting.openQuestionsText
          )
          SummarySectionCard(
            title: "风险",
            systemImage: "exclamationmark.triangle",
            text: $meeting.risksText
          )
          SummarySectionCard(
            title: "下一步",
            systemImage: "arrow.right.circle",
            text: $meeting.nextStepsText
          )

          if meeting.summaryText.isEmpty {
            ContentUnavailableView(
              "尚未生成纪要",
              systemImage: "sparkles",
              description: Text("停止录音只会安全保存内容；需要时请主动生成最终纪要")
            )
            .frame(minHeight: 180)
          }
        } else if let visual = meeting.visualSummary {
          if visual.stale {
            Label("普通纪要已有更新，当前视觉版基于上一版本", systemImage: "exclamationmark.triangle.fill")
              .font(.caption)
              .foregroundStyle(MeetingTheme.warning)
          }
          VisualSummaryPoster(meeting: meeting, visual: visual)
          Button {
            Task { await retryVisualSummary() }
          } label: {
            Label("重试视觉版", systemImage: "arrow.clockwise")
          }
          .buttonStyle(.bordered)
          .disabled(isSummarizing || !preferences.visualSummaryIsVerified)
        } else {
          ContentUnavailableView(
            preferences.visualSummaryIsVerified ? "尚未生成视觉纪要" : "当前使用普通纪要",
            systemImage: "rectangle.3.group",
            description: Text(preferences.visualSummaryIsVerified
              ? "生成最终纪要后会自动排成可分享的信息图"
              : "请在设置中开启视觉纪要并通过结构验证")
          )
          .frame(minHeight: 220)
          if preferences.visualSummaryIsVerified && !meeting.summaryText.isEmpty {
            Button {
              Task { await retryVisualSummary() }
            } label: {
              Label("生成视觉纪要", systemImage: "sparkles")
            }
            .buttonStyle(.borderedProminent)
            .disabled(isSummarizing)
          }
        }
      }
      .padding(16)
      .padding(.bottom, 90)
    }
    // 纪要更新失败提示。
    .alert(
      "纪要更新失败",
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

  // MARK: - 私有方法

  /// 拼接定稿转录（含录音中的实时文本）与笔记生成纪要并保存。
  /// - 副作用：写回 meeting 字段、保存 SwiftData；远程模式下发起网络调用。
  private func summarize() async {
    isSummarizing = true
    defer { isSummarizing = false }
    do {
      let transcript =
        meeting.transcriptText
        + (recorder.activeMeetingID == meeting.id ? "\n\(recorder.liveTranscript)" : "")
      let draft = try await SummaryService().summarize(
        transcript: transcript,
        notes: meeting.personalNotes,
        preferences: preferences
      )
      meeting.apply(summary: draft)
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
          displayMode = .visual
        } catch {
          displayMode = .normal
          errorMessage = "普通纪要已保存，但视觉版生成失败：\(error.localizedDescription)"
        }
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func retryVisualSummary() async {
    guard let sourceDate = meeting.lastSummaryAt else {
      errorMessage = "请先生成普通纪要"
      return
    }
    isSummarizing = true
    defer { isSummarizing = false }
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
      displayMode = .visual
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}

/// 纪要分区卡片：图标标题 + 可编辑多行文本（TextEditor 绑定模型字段）。
private struct SummarySectionCard: View {
  /// 卡片标题。
  let title: String
  /// 标题图标（SF Symbol 名）。
  let systemImage: String
  /// 绑定的纪要字段文本。
  @Binding var text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      Label(title, systemImage: systemImage)
        .font(.subheadline.weight(.semibold))
      TextEditor(text: $text)
        .scrollContentBackground(.hidden)
        .font(.subheadline)
        .frame(minHeight: 72)
    }
    .padding(13)
    .background(
      MeetingTheme.surfaceRaised,
      in: RoundedRectangle(cornerRadius: 12)
    )
  }
}

/// iPhone/iPad 共用的原生视觉纪要画布；导出 PNG 时复用同一视图。
struct VisualSummaryPoster: View {
  let meeting: MeetingRecord
  let visual: VisualSummary

  var body: some View {
    VStack(alignment: .leading, spacing: 22) {
      VStack(alignment: .leading, spacing: 9) {
        Label("MINUTEFLOW 视觉纪要", systemImage: "sparkles")
          .font(.caption2.weight(.bold))
          .tracking(1.2)
          .foregroundStyle(MeetingTheme.primary)
        Text(visual.title)
          .font(.title2.weight(.bold))
          .tracking(-0.6)
        Text(visual.subtitle)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        HStack(spacing: 12) {
          Text(MeetingFormatters.dateTime(meeting.startedAt))
          if !meeting.participants.isEmpty { Text(meeting.participants.joined(separator: "、")) }
        }
        .font(.caption2)
        .foregroundStyle(.tertiary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.bottom, 16)
      .overlay(alignment: .bottom) { Divider() }

      ForEach(visual.sections) { section in
        VisualSummarySectionView(section: section)
      }

      Text("内容由模型整理，版式由 MinuteFlow 在本机生成")
        .font(.caption2)
        .foregroundStyle(.tertiary)
        .frame(maxWidth: .infinity)
    }
    .padding(22)
    .background(MeetingTheme.surface, in: RoundedRectangle(cornerRadius: 18))
    .overlay { RoundedRectangle(cornerRadius: 18).stroke(MeetingTheme.divider) }
  }
}

private struct VisualSummarySectionView: View {
  let section: VisualSummarySection

  var body: some View {
    VStack(alignment: .leading, spacing: 11) {
      HStack(spacing: 9) {
        Text(String(format: "%02d", section.number))
          .font(.caption.weight(.bold).monospacedDigit())
          .foregroundStyle(.white)
          .padding(.horizontal, 8)
          .padding(.vertical, 5)
          .background(tone, in: RoundedRectangle(cornerRadius: 6))
        Text(section.title)
          .font(.headline)
        Rectangle()
          .fill(tone.opacity(0.25))
          .frame(height: 1)
      }

      switch section.layout {
      case .table:
        if let table = section.table { VisualSummaryTableView(table: table, tone: tone) }
      case .cards:
        if let cards = section.cards {
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 190), spacing: 10)], spacing: 10) {
            ForEach(Array(cards.enumerated()), id: \.offset) { _, card in
              VisualSummaryCardView(card: card, tone: tone)
            }
          }
          .padding(10)
          .background(tone.opacity(0.07), in: RoundedRectangle(cornerRadius: 13))
        }
      case .callout:
        if let callout = section.callout {
          Label(callout, systemImage: "checkmark.seal.fill")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.primary)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tone.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
            .overlay { RoundedRectangle(cornerRadius: 12).stroke(tone.opacity(0.25)) }
        }
      }
    }
  }

  private var tone: Color {
    switch section.tone {
    case .coral: MeetingTheme.primary
    case .amber: MeetingTheme.warning
    case .violet: MeetingTheme.speakerViolet
    case .green: MeetingTheme.success
    }
  }
}

private struct VisualSummaryTableView: View {
  let table: VisualSummaryTable
  let tone: Color

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
        GridRow {
          ForEach(Array(table.columns.enumerated()), id: \.offset) { _, column in
            Text(column)
              .font(.caption.weight(.semibold))
              .frame(minWidth: 118, maxWidth: 190, alignment: .leading)
              .padding(10)
              .background(tone.opacity(0.1))
          }
        }
        ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
          Divider()
          GridRow {
            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
              Text(cell)
                .font(.caption)
                .fixedSize(horizontal: false, vertical: true)
                .frame(minWidth: 118, maxWidth: 190, alignment: .topLeading)
                .padding(10)
            }
          }
        }
      }
      .background(MeetingTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
    }
    .padding(10)
    .background(tone.opacity(0.07), in: RoundedRectangle(cornerRadius: 13))
  }
}

private struct VisualSummaryCardView: View {
  let card: VisualSummaryCard
  let tone: Color

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack(alignment: .top) {
        Text(card.title).font(.subheadline.weight(.semibold))
        Spacer(minLength: 6)
        if let status = card.status {
          Text(status)
            .font(.caption2.weight(.medium))
            .foregroundStyle(tone)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .overlay { Capsule().stroke(tone.opacity(0.7)) }
        }
      }
      ForEach(Array(card.bullets.enumerated()), id: \.offset) { _, bullet in
        Label(bullet, systemImage: "circle.fill")
          .font(.caption)
          .symbolRenderingMode(.monochrome)
          .foregroundStyle(.secondary)
      }
      if let takeaway = card.takeaway {
        Text(takeaway)
          .font(.caption)
          .padding(8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(tone.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
      }
    }
    .padding(12)
    .background(MeetingTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: 11))
    .overlay { RoundedRectangle(cornerRadius: 11).stroke(tone.opacity(0.18)) }
  }
}
