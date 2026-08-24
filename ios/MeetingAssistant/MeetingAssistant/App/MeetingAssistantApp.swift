//
//  MeetingAssistantApp.swift
//  MeetingAssistant
//
//  应用入口：启动时创建 SwiftData ModelContainer（本地会议数据库），
//  并把 AppState、RecordingCoordinator、AppPreferences、AudioImportCoordinator
//  注入环境后展示根视图 AppRootView。
//  所属层：App 装配层。
//

import SwiftData
import SwiftUI

/// 应用根入口：负责 SwiftData 容器创建与环境对象装配。
@main
struct MeetingAssistantApp: App {
  // MARK: - SwiftData 容器与全局对象

  /// 本地数据库容器；创建失败时应用无法继续运行。
  private let modelContainer: ModelContainer
  /// 全局 UI 状态（选中会议、标签页、弹层、搜索等）。
  @State private var appState = AppState()
  /// 录音协调器：AVAudioEngine 录音 + SFSpeechRecognizer 实时转录。
  @State private var recorder = RecordingCoordinator()
  /// 用户偏好：转录/纪要 Provider、语言与自动纪要间隔（UserDefaults 持久化）。
  @State private var preferences = AppPreferences()
  /// 音频导入协调器：导入外部音频并转录为会议。
  @State private var importCoordinator = AudioImportCoordinator()

  // MARK: - 初始化

  /// 构建 Schema 与磁盘上的 "MeetingAssistant" 数据库。
  ///
  /// - 副作用：创建/打开本地 SwiftData 存储文件；失败时 fatalError 终止启动
  ///   （本地优先应用在无数据库时无法运行）。
  init() {
    do {
      // 注册全部模型类型；新增模型必须同步加入 Schema，否则容器无法建表。
      let schema = Schema([
        MeetingRecord.self,
        TranscriptSegmentRecord.self,
        ActionItemRecord.self,
      ])
      let configuration = ModelConfiguration(
        "MeetingAssistant",
        schema: schema,
        // UI 测试每次从全新演示数据启动，避免旧模拟器数据库掩盖轻量迁移或视觉纪要状态。
        isStoredInMemoryOnly: ProcessInfo.processInfo.arguments.contains("UI_TESTING")
      )
      modelContainer = try ModelContainer(
        for: schema,
        configurations: [configuration]
      )
    } catch {
      fatalError("无法创建本地会议数据库：\(error.localizedDescription)")
    }
  }

  // MARK: - 场景

  /// 主窗口场景：注入环境对象并向下传递 SwiftData 容器。
  var body: some Scene {
    WindowGroup {
      AppRootView()
        .environment(appState)
        .environment(recorder)
        .environment(preferences)
        .environment(importCoordinator)
    }
    .modelContainer(modelContainer)
  }
}
