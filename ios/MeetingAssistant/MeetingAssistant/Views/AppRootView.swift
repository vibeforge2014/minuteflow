//
//  AppRootView.swift
//  MeetingAssistant
//
//  应用根视图：按 horizontalSizeClass 在 iPad 三栏工作区与 iPhone Tab 工作区
//  之间切换，并集中挂载全局 sheet、文件导入、导入进度遮罩、错误 alert、
//  首次引导 fullScreenCover、演示数据播种与自动纪要刷新。
//  所属层：视图层（导航根）。
//

import SwiftData
import SwiftUI
import UniformTypeIdentifiers

/// 根视图：负责自适应布局分流与全局弹层/导入/引导装配。
/// 导航位置：WindowGroup 的最外层视图；iPad 与 iPhone 布局在此分流。
struct AppRootView: View {
  // MARK: - 环境与数据

  /// 水平尺寸类别：regular 走 iPad 三栏，compact 走 iPhone Tab。
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  /// SwiftData 上下文（播种、导入、纪要保存）。
  @Environment(\.modelContext) private var modelContext
  /// 全局 UI 状态。
  @Environment(AppState.self) private var appState
  /// 录音协调器（监听自动纪要节拍）。
  @Environment(RecordingCoordinator.self) private var recorder
  /// 用户偏好（引导标记、导入转录参数）。
  @Environment(AppPreferences.self) private var preferences
  /// 导入协调器（进度与错误）。
  @Environment(AudioImportCoordinator.self) private var importCoordinator
  /// 全部会议（按开始时间倒序）。
  @Query(sort: \MeetingRecord.startedAt, order: .reverse)
  private var meetings: [MeetingRecord]

  /// 是否弹出系统文件选择器（音频导入）。
  @State private var isFileImporterPresented = false
  /// 播种失败文案（alert 展示）。
  @State private var seedError: String?

  // MARK: - 视图内容

  var body: some View {
    // 供 sheet/alert 等使用 $appState 绑定（@Observable 手动绑定模式）。
    @Bindable var appState = appState

    Group {
      // 尺寸类别分流：iPad 三栏工作区 / iPhone Tab 工作区。
      if horizontalSizeClass == .regular {
        TabletWorkspaceView(
          meetings: activeMeetings,
          onImport: { isFileImporterPresented = true }
        )
      } else {
        PhoneWorkspaceView(
          meetings: activeMeetings,
          onImport: { isFileImporterPresented = true }
        )
      }
    }
    .tint(MeetingTheme.primary)
    .background(MeetingTheme.canvas)
    // 全局 sheet 分发：新建会议 / 设置 / 导入帮助。
    .sheet(item: $appState.presentedSheet) { sheet in
      switch sheet {
      case .newMeeting:
        NewMeetingView()
      case .settings:
        NavigationStack {
          SettingsView(showsDoneButton: true)
        }
      case .importAudio:
        ImportHelpView {
          appState.presentedSheet = nil
          isFileImporterPresented = true
        }
      }
    }
    // 系统文件选择器：选中音频后交给导入协调器处理。
    .fileImporter(
      isPresented: $isFileImporterPresented,
      allowedContentTypes: [.audio, .movie],
      allowsMultipleSelection: false
    ) { result in
      guard case .success(let urls) = result, let url = urls.first else {
        if case .failure(let error) = result {
          importCoordinator.errorMessage = error.localizedDescription
        }
        return
      }
      Task {
        do {
          let meeting = try await importCoordinator.importAudio(
            from: url,
            preferences: preferences,
            modelContext: modelContext
          )
          appState.selectedMeetingID = meeting.id
        } catch {
          importCoordinator.errorMessage = error.localizedDescription
        }
      }
    }
    // 导入中显示全屏进度遮罩。
    .overlay {
      if importCoordinator.isImporting {
        ImportProgressOverlay(text: importCoordinator.progressText)
      }
    }
    // 导入失败提示。
    .alert(
      "无法导入",
      isPresented: Binding(
        get: { importCoordinator.errorMessage != nil },
        set: { if !$0 { importCoordinator.errorMessage = nil } }
      )
    ) {
      Button("好") { importCoordinator.errorMessage = nil }
    } message: {
      Text(importCoordinator.errorMessage ?? "")
    }
    // 本地数据（播种）错误提示。
    .alert(
      "本地数据错误",
      isPresented: Binding(
        get: { seedError != nil },
        set: { if !$0 { seedError = nil } }
      )
    ) {
      Button("好") { seedError = nil }
    } message: {
      Text(seedError ?? "")
    }
    // 首次启动引导（完成后写入偏好，不再弹出）。
    .fullScreenCover(
      isPresented: Binding(
        get: { !preferences.hasCompletedOnboarding },
        set: { if !$0 { preferences.hasCompletedOnboarding = true } }
      )
    ) {
      OnboardingView()
    }
    // 首启播种演示数据并默认选中最近一场会议。
    .task {
      do {
        try DemoDataSeeder.seedIfNeeded(modelContext: modelContext)
        if appState.selectedMeetingID == nil {
          appState.selectedMeetingID = activeMeetings.first?.id
        }
      } catch {
        seedError = error.localizedDescription
      }
    }
    // 会议列表变化时保持默认选中不为空。
    .onChange(of: meetings.map(\.id)) { _, _ in
      if appState.selectedMeetingID == nil {
        appState.selectedMeetingID = activeMeetings.first?.id
      }
    }
    // 录音到达自动纪要间隔时刷新当前会议纪要。
    .onChange(of: recorder.summaryTick) { _, _ in
      guard let meeting = activeRecordingMeeting else { return }
      Task { await refreshSummary(for: meeting) }
    }
  }

  // MARK: - 私有辅助

  /// 过滤掉软删除会议后的列表。
  private var activeMeetings: [MeetingRecord] {
    meetings.filter { !$0.isDeleted }
  }

  /// 当前正在录音的会议对象（若存在）。
  private var activeRecordingMeeting: MeetingRecord? {
    guard let id = recorder.activeMeetingID else { return nil }
    return meetings.first { $0.id == id }
  }

  /// 汇总当前转录（含实时文本）与笔记生成纪要并应用；失败时以 Toast 提示。
  /// - 副作用：修改 meeting 字段并保存 SwiftData；远程模式下发起网络调用。
  private func refreshSummary(for meeting: MeetingRecord) async {
    do {
      let draft = try await SummaryService().summarize(
        transcript: meeting.transcriptText + "\n" + recorder.liveTranscript,
        notes: meeting.personalNotes,
        preferences: preferences
      )
      meeting.apply(summary: draft)
      try modelContext.save()
    } catch {
      appState.toastMessage = "自动纪要稍后重试：\(error.localizedDescription)"
    }
  }
}

/// 全屏导入进度遮罩（毛玻璃卡片 + 转圈 + 进度文案）。
private struct ImportProgressOverlay: View {
  /// 进度文案。
  let text: String

  var body: some View {
    ZStack {
      Color.black.opacity(0.18)
        .ignoresSafeArea()
      VStack(spacing: 14) {
        ProgressView()
          .controlSize(.large)
        Text(text)
          .font(.headline)
      }
      .padding(28)
      .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(text)
  }
}

// iPad 布局预览（内存数据库 + 全套环境对象）。
#Preview("iPad") {
  AppRootView()
    .environment(AppState())
    .environment(RecordingCoordinator())
    .environment(AppPreferences())
    .environment(AudioImportCoordinator())
    .modelContainer(
      for: [
        MeetingRecord.self,
        TranscriptSegmentRecord.self,
        ActionItemRecord.self,
      ], inMemory: true)
}
