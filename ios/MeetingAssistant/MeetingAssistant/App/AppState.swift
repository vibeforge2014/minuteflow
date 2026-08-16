//
//  AppState.swift
//  MeetingAssistant
//
//  应用全局 UI 状态容器：集中管理当前选中会议、iPhone 底部标签、检查面板标签、
//  全局弹层（sheet）、搜索关键字与 Toast 提示等跨视图共享的导航/交互状态。
//  所属层：App 装配层（@Observable 对象，经 environment 注入整个视图树）。
//

import Foundation
import Observation

/// 全局应用状态：以 @MainActor + @Observable 驱动，供 iPhone TabView/NavigationStack
/// 与 iPad 三栏工作区共享同一份选中与导航状态。
@MainActor
@Observable
final class AppState {
  // MARK: - iPhone 底部标签

  /// iPhone compact 布局下 TabView 的三个主标签。
  enum PhoneTab: Hashable {
    case meetings
    case actions
    case settings
  }

  // MARK: - 检查面板标签

  /// 会议详情中“转录 / AI 纪要”两个检查面板的切换标签。
  enum InspectorTab: String, CaseIterable, Identifiable {
    case transcript = "转录"
    case summary = "AI 纪要"

    var id: String { rawValue }
  }

  // MARK: - 全局弹层

  /// 全局 sheet 种类；实现 Identifiable 以配合 SwiftUI 的 sheet(item:)。
  enum AppSheet: Identifiable {
    case newMeeting
    case settings
    case importAudio

    var id: String {
      switch self {
      case .newMeeting: "newMeeting"
      case .settings: "settings"
      case .importAudio: "importAudio"
      }
    }
  }

  // MARK: - 状态属性

  /// 当前选中的会议 ID；iPad 三栏据此决定中栏/右栏内容。
  var selectedMeetingID: UUID?
  /// iPhone 底部 TabView 当前选中的标签。
  var selectedPhoneTab: PhoneTab = .meetings
  /// 检查面板（转录 / AI 纪要）当前标签。
  var inspectorTab: InspectorTab = .transcript
  /// 当前展示的全局 sheet；为 nil 时无弹层。
  var presentedSheet: AppSheet?
  /// 会议库搜索关键字（iPad 侧栏使用）。
  var searchText = ""
  /// 临时 Toast 文案；非 nil 时由界面提示。
  var toastMessage: String?
}
