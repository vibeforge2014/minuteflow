//
//  UITestingSupport.swift
//  MeetingAssistant
//
//  DEBUG 专用的截图/端到端驱动支持：通过 `UI_TESTING_INITIAL=<route>` 启动参数
//  直接把应用落到指定导航状态（会议库/会议详情/转写段/AI 问答/设置子页），
//  供 simctl 截图与跨端 UI 对齐检查使用——本机宿主的 XCUITest 服务栈不可用时
//  仍能稳定逐屏出图。Release 构建 initialRoute 恒为 nil，全部路由代码为空操作。
//  所属层：App 装配层。
//

import Foundation

/// 解析 UI 测试启动参数并给出初始导航状态。
/// 类型常驻（消费方无需条件编译）；仅 DEBUG 下真正读取启动参数。
@MainActor
enum UITestingLauncher {
  /// 支持的初始路由（与截图脚本一一对应）。
  enum Route: String {
    case minutes
    case transcript
    case chat
    case settings
    case settingsSummary = "settings-summary"
    case settingsTranscription = "settings-transcription"
  }

  /// 首个匹配的初始路由；未传、值不认识或 Release 构建时为 nil（走正常启动路径）。
  static var initialRoute: Route? {
    #if DEBUG
    guard ProcessInfo.processInfo.arguments.contains("UI_TESTING") else { return nil }
    return launchValue(forKey: "UI_TESTING_INITIAL").flatMap(Route.init(rawValue:))
    #else
    nil
    #endif
  }

  /// 从启动参数里取值，兼容 `KEY=VALUE` 与 `KEY VALUE` 两种传参形式。
  private static func launchValue(forKey key: String) -> String? {
    let arguments = ProcessInfo.processInfo.arguments
    if let index = arguments.firstIndex(where: { $0 == key }), index + 1 < arguments.count {
      return arguments[index + 1]
    }
    for argument in arguments where argument.hasPrefix("\(key)=") {
      return String(argument.dropFirst(key.count + 1))
    }
    return nil
  }
}
