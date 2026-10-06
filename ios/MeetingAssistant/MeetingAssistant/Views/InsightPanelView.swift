//
//  InsightPanelView.swift
//  MeetingAssistant
//
//  会议内容面板组件：实时转录列表、关键结论卡与视觉纪要海报。
//  转录面板由 iPhone/iPad 会议详情的「转录」分段直接使用；iPad 第三栏现在
//  常驻 AI 问答面板（MeetingChatPanelView），不再有独立洞察容器。
//  所属层：视图层。
//

import SwiftData
import SwiftUI

/// 全端统一的内容动效节奏：无弹跳、短反馈；减少动态效果时只保留淡化。
enum ContentMotion {
  static let quick = Animation.timingCurve(0.23, 1, 0.32, 1, duration: 0.16)
  static let content = Animation.timingCurve(0.23, 1, 0.32, 1, duration: 0.22)
  static let view = Animation.timingCurve(0.23, 1, 0.32, 1, duration: 0.18)

  static func insertion(reduceMotion: Bool) -> AnyTransition {
    if reduceMotion { return .opacity }
    return .modifier(
      active: ContentInsertionModifier(opacity: 0, offset: 6),
      identity: ContentInsertionModifier(opacity: 1, offset: 0)
    )
  }
}

private struct ContentInsertionModifier: ViewModifier {
  let opacity: Double
  let offset: CGFloat

  func body(content: Content) -> some View {
    content.opacity(opacity).offset(y: offset)
  }
}

/// 系统生成内容改写时用语义色轻提示，不重挂载 TextEditor 或改变焦点。
private struct ContentUpdateFeedbackModifier: ViewModifier {
  let revision: Date?
  let cornerRadius: CGFloat
  @State private var highlighted = false
  @State private var pulseID = UUID()

  func body(content: Content) -> some View {
    content
      .overlay {
        RoundedRectangle(cornerRadius: cornerRadius)
          .fill(MeetingTheme.primary.opacity(0.1))
          .opacity(highlighted ? 1 : 0)
          .allowsHitTesting(false)
      }
      .onChange(of: revision) { _, newValue in
        guard newValue != nil else { return }
        let token = UUID()
        pulseID = token
        withAnimation(ContentMotion.quick) { highlighted = true }
        Task { @MainActor in
          try? await Task.sleep(for: .milliseconds(360))
          guard pulseID == token else { return }
          withAnimation(ContentMotion.content) { highlighted = false }
        }
      }
  }
}

extension View {
  func contentUpdateFeedback(revision: Date?, cornerRadius: CGFloat = 12) -> some View {
    modifier(ContentUpdateFeedbackModifier(revision: revision, cornerRadius: cornerRadius))
  }
}

/// 实时转录面板：定稿片段列表 + 录音中的临时转写行，自动滚动跟随最新内容。
/// 回放进行中时：时间戳可点按跳转播放器，当前播放片段歌词式高亮并自动跟随。
/// 导航位置：iPhone/iPad 会议详情的「转录」分段。
struct TranscriptPanelView: View {
  /// 录音协调器（临时转写与录音状态）。
  @Environment(RecordingCoordinator.self) private var recorder
  /// 回放播放器（播放同步：时间戳跳转 + 当前行高亮）。
  @Environment(MeetingPlayer.self) private var player
  /// 目标会议。
  let meeting: MeetingRecord
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// 本会议是否处于回放同步态。
  private var isPlaybackSynced: Bool {
    player.attachedMeetingID == meeting.id && player.hasAudio
  }

  private enum DisplayRow: Identifiable {
    case stored(TranscriptSegmentRecord)
    case live(NaturalTranscriptParagraph)

    var id: UUID {
      switch self {
      case .stored(let segment): segment.id
      case .live(let paragraph): paragraph.id
      }
    }
  }

  /// 临时段与定稿段共用稳定 UUID；停止录音时同一行只切换状态，不整组重建。
  private var displayRows: [DisplayRow] {
    let stored = meeting.orderedSegments.map(DisplayRow.stored)
    let storedIDs = Set(meeting.orderedSegments.map(\.id))
    let live = recorder.activeMeetingID == meeting.id
      ? recorder.liveParagraphs.filter { !storedIDs.contains($0.id) }.map(DisplayRow.live)
      : []
    return stored + live
  }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          HStack {
            Label("实时转录", systemImage: "waveform")
              .font(.caption.weight(.semibold))
              .foregroundStyle(MeetingTheme.primary)
            Spacer()
            if isPlaybackSynced {
              Label(
                String(format: "%.2g×", player.rate),
                systemImage: player.isPlaying ? "speaker.wave.2.fill" : "speaker.wave.1"
              )
              .font(.caption)
              .foregroundStyle(.secondary)
              .contentTransition(.numericText())
            }
            Text("\(displayRows.count) 段")
              .font(.caption)
              .foregroundStyle(.secondary)
              .contentTransition(.numericText())
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 12)

          ForEach(Array(displayRows.enumerated()), id: \.element.id) { index, row in
            Group {
              switch row {
              case .stored(let segment):
                TranscriptSegmentRow(
                  segment: segment,
                  playbackActive: isPlaybackSynced && player.isPlaying,
                  isCurrentSegment: isPlaybackSynced && player.currentSegmentID == segment.id
                ) {
                  player.seek(to: segment.startTime)
                }
              case .live(let paragraph):
                LiveTranscriptRow(paragraph: paragraph)
              }
            }
            .id(row.id)
            .transition(ContentMotion.insertion(reduceMotion: reduceMotion))
            if index < displayRows.count - 1 {
              Divider().padding(.leading, 54)
            }
          }

          // 空状态：既无定稿片段也无实时文本。
          if displayRows.isEmpty {
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
      .animation(ContentMotion.content, value: displayRows.map(\.id))
      // 实时文本更新时平滑滚动到最新的临时转写行。
      .onChange(of: recorder.liveParagraphs) { _, _ in
        guard let lastID = recorder.liveParagraphs.last?.id else { return }
        if reduceMotion {
          proxy.scrollTo(lastID, anchor: .bottom)
        } else {
          withAnimation(ContentMotion.content) {
            proxy.scrollTo(lastID, anchor: .bottom)
          }
        }
      }
      // 回放同步：当前片段变化时滚动跟随（歌词式）。
      .onChange(of: player.currentSegmentID) { _, currentID in
        guard isPlaybackSynced, player.isPlaying, let currentID else { return }
        if reduceMotion {
          proxy.scrollTo(currentID, anchor: .center)
        } else {
          withAnimation(ContentMotion.content) {
            proxy.scrollTo(currentID, anchor: .center)
          }
        }
      }
      // 播放位置推进时更新“当前片段”定位（含暂停后跳转）。
      .onChange(of: player.currentTime) { _, _ in
        guard isPlaybackSynced else { return }
        player.updateSync(with: meeting.orderedSegments)
      }
      .onChange(of: isPlaybackSynced) { _, active in
        if active {
          player.updateSync(with: meeting.orderedSegments)
        }
      }
    }
  }
}

/// 单条转录行：时间戳（回放时可点按跳转）、可改名的说话人菜单、可编辑文本
/// 与定稿状态图标；回放同步时当前片段整行歌词式高亮。
private struct TranscriptSegmentRow: View {
  /// 双向绑定的转录片段（就地编辑文本与说话人）。
  @Bindable var segment: TranscriptSegmentRecord
  /// 回放是否进行中（决定时间戳是否呈现可点按的主色态）。
  var playbackActive = false
  /// 是否为当前播放时间命中的片段（歌词式高亮）。
  var isCurrentSegment = false
  /// 点按时间戳跳转播放器。
  var onSeekTimestamp: () -> Void = {}

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      timestampView
        .font(.caption.monospacedDigit())
        .foregroundStyle(
          playbackActive ? AnyShapeStyle(MeetingTheme.primary) : AnyShapeStyle(HierarchicalShapeStyle.tertiary)
        )
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
          .foregroundStyle(isCurrentSegment ? .primary : .secondary)
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
    // 歌词式同步高亮：当前片段整行软主色衬底（Reduced Motion 保留该语义色）。
    .background {
      if isCurrentSegment {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(MeetingTheme.primary.opacity(0.10))
          .padding(.horizontal, 6)
      }
    }
    .animation(ContentMotion.quick, value: isCurrentSegment)
  }

  /// 时间戳：回放同步时可点按跳转，否则纯展示。
  @ViewBuilder
  private var timestampView: some View {
    if playbackActive {
      Button(action: onSeekTimestamp) {
        Text(MeetingFormatters.timestamp(segment.startTime))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("跳转到 \(MeetingFormatters.timestamp(segment.startTime))")
    } else {
      Text(MeetingFormatters.timestamp(segment.startTime))
    }
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
  let paragraph: NaturalTranscriptParagraph
  @State private var highlighted = false
  @State private var pulseID = UUID()

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Text(MeetingFormatters.timestamp(paragraph.startTime))
        .font(.caption.monospacedDigit())
        .foregroundStyle(.tertiary)
        .frame(width: 40, alignment: .leading)
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
          Text(paragraph.speaker)
            .font(.caption.weight(.semibold))
            .foregroundStyle(MeetingTheme.primary)
          Text("临时转写中")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        Text(paragraph.text)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .contentTransition(.opacity)
          .animation(ContentMotion.quick, value: paragraph.text)
      }
      Spacer()
      ProgressView()
        .controlSize(.small)
    }
    .padding(14)
    .background(MeetingTheme.primarySoft)
    .overlay {
      Rectangle()
        .fill(MeetingTheme.primary.opacity(0.08))
        .opacity(highlighted ? 1 : 0)
        .allowsHitTesting(false)
    }
    .onChange(of: paragraph.text) { oldValue, newValue in
      guard NaturalContentChangeClassifier.text(previous: oldValue, next: newValue) != .unchanged else { return }
      let token = UUID()
      pulseID = token
      withAnimation(ContentMotion.quick) { highlighted = true }
      Task { @MainActor in
        try? await Task.sleep(for: .milliseconds(260))
        guard pulseID == token else { return }
        withAnimation(ContentMotion.content) { highlighted = false }
      }
    }
  }
}

/// 关键结论卡：暖色衬底 + 珊瑚圆点行（与桌面端「关键结论」区块同一视觉语言）。
/// 行就地编辑并写回 summaryText 的「## 关键结论」小节；结论无顺序语义，
/// 用圆点而不是编号。会议文档与 AI 纪要面板共用。
struct KeyConclusionsCard: View {
  /// 卡片标题：录音中沿用「会议进展」，其余阶段为「关键结论」。
  let title: String
  /// 绑定的纪要 Markdown（读写「## 关键结论」小节）。
  @Binding var markdown: String
  /// 最近一次纪要应用时间（语义色轻提示）。
  let revision: Date?
  /// 录音中的滚动更新节奏说明；nil 时不显示。
  var cadence: String? = nil
  /// 最近更新时间说明；nil 时不显示。
  var lastUpdated: String? = nil
  /// 是否在卡片底部渲染其余小节（主题要点等）的只读文本。
  var showsRemainingSections = false

  /// 当前「## 关键结论」小节的条目（空串代表待输入的新行）。
  private var lines: [String] {
    MeetingRecord.keyConclusionLines(in: markdown)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .firstTextBaseline) {
        Label(title, systemImage: "doc.text")
          .font(.headline)
        Spacer()
        if let cadence {
          Label(cadence, systemImage: "circle.fill")
            .font(.caption.weight(.medium))
            .foregroundStyle(MeetingTheme.success)
        }
        if let lastUpdated {
          Text(lastUpdated)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      if lines.isEmpty {
        Text("转录产生后，这里会归纳关键结论与进展，不会重复抄录原文。")
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .padding(12)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(MeetingTheme.primarySoft, in: RoundedRectangle(cornerRadius: 12))
      } else {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(lines.indices, id: \.self) { index in
            HStack(alignment: .firstTextBaseline, spacing: 9) {
              Circle()
                .fill(MeetingTheme.primary)
                .frame(width: 7, height: 7)
                .padding(.top, 8)
              TextField("新的结论", text: lineBinding(at: index))
                .font(.subheadline)
                .textFieldStyle(.plain)
              Button {
                removeLine(at: index)
              } label: {
                Image(systemName: "minus.circle")
                  .font(.caption)
                  .foregroundStyle(.tertiary)
              }
              .buttonStyle(.plain)
              .accessibilityLabel("删除这条结论")
            }
            .padding(.vertical, 5)
          }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(MeetingTheme.primarySoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      }

      Button {
        writeBack(lines + [""])
      } label: {
        Label("添加结论", systemImage: "plus")
      }
      .buttonStyle(.borderless)
      .font(.subheadline)

      if showsRemainingSections {
        RemainingSummarySections(markdown: markdown)
      }
    }
    .padding(16)
    .background(MeetingTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(MeetingTheme.divider)
    }
    .contentUpdateFeedback(revision: revision, cornerRadius: 16)
  }

  // MARK: - 行读写

  /// 单行双向绑定：写回时仅替换该行，其余小节原样保留。
  private func lineBinding(at index: Int) -> Binding<String> {
    Binding(
      get: { index < lines.count ? lines[index] : "" },
      set: { newValue in
        guard index < lines.count else { return }
        var updated = lines
        updated[index] = newValue
        writeBack(updated)
      }
    )
  }

  private func removeLine(at index: Int) {
    guard index < lines.count else { return }
    var updated = lines
    updated.remove(at: index)
    writeBack(updated)
  }

  /// 把行列表写回 markdown 并即时保存（由调用方 modelContext 落盘）。
  private func writeBack(_ newLines: [String]) {
    markdown = MeetingRecord.replacingKeyConclusions(in: markdown, with: newLines)
  }
}

/// 关键结论以外的纪要小节（主题要点等）只读渲染；决策/风险等另有可编辑卡片。
private struct RemainingSummarySections: View {
  let markdown: String

  /// 去掉「## 关键结论」小节后的其余小节。
  private var sections: [(title: String, items: [String])] {
    let remaining = MeetingRecord.replacingKeyConclusions(in: markdown, with: [])
    var result: [(String, [String])] = []
    var current: (String, [String])?
    for rawLine in remaining.split(separator: "\n") {
      let line = rawLine.trimmingCharacters(in: .whitespaces)
      if line.hasPrefix("## ") {
        if let section = current { result.append(section) }
        current = (String(line.dropFirst(3)), [])
      } else if !line.isEmpty, current != nil {
        current?.1.append(
          line.replacingOccurrences(of: #"^[\-\*•]\s*"#, with: "", options: .regularExpression)
        )
      }
    }
    if let section = current { result.append(section) }
    return result
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(sections, id: \.title) { section in
        VStack(alignment: .leading, spacing: 5) {
          Text(section.title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
          ForEach(section.items, id: \.self) { item in
            Text(item)
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
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
