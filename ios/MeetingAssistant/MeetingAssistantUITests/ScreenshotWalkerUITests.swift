import UIKit
import XCTest

/// 截图漫步：仅当 SCREENSHOT_WALK=1 时执行（`npm`/shell 端到端对比用），
/// 正常测试运行不会触发。逐屏导航并把 PNG 写到宿主 /tmp/shots。
final class ScreenshotWalkerUITests: XCTestCase {
  private let outDir = "/tmp/shots"

  private func snap(_ app: XCUIApplication, _ name: String) {
    // 等待界面稳定后再截图（系统转场动画）。
    Thread.sleep(forTimeInterval: 1.2)
    let shot = XCUIScreen.main.screenshot()
    try? shot.pngRepresentation.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
  }

  func testWalkScreens() throws {
    guard ProcessInfo.processInfo.environment["SCREENSHOT_WALK"] == "1" else {
      throw XCTSkip("仅截图漫步模式运行")
    }
    continueAfterFailure = true
    let app = XCUIApplication()
    app.launchArguments = ["UI_TESTING"]
    app.launch()

    // 1. 会议库（两标签 + 行动项工具栏入口）
    XCTAssertTrue(app.navigationBars["MinuteFlow"].waitForExistence(timeout: 8))
    snap(app, "ios-library")

    // 2. 进行中会议 → 录音中默认落在「转录」
    let live = app.staticTexts["产品团队周会"].firstMatch
    if live.waitForExistence(timeout: 5) { live.tap() }
    snap(app, "ios-transcript")

    // 3. AI 纪要（合并后的纪要文档：操作行/关键结论/视觉入口卡/行动项）
    let minutes = app.segmentedControls.buttons["AI 纪要"].firstMatch
    if minutes.waitForExistence(timeout: 3) { minutes.tap() }
    snap(app, "ios-minutes")

    // 4. AI 问答（导航栏气泡按钮 → 弹层）
    let chat = app.buttons["chat-button"].firstMatch
    if chat.waitForExistence(timeout: 3) {
      chat.tap()
      snap(app, "ios-chat")
      // 从顶部下拉关闭弹层（有分档 detent，普通下拉可能只收半屏）。
      let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.02))
      let bottom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.92))
      top.press(forDuration: 0.05, thenDragTo: bottom)
      Thread.sleep(forTimeInterval: 0.8)
    }

    // 5. 回会议库 → 打开已完成会议（项目复盘），默认即「AI 纪要」
    app.navigationBars.buttons.firstMatch.tap()
    Thread.sleep(forTimeInterval: 0.8)
    let done = app.staticTexts["项目复盘：移动端体验优化"].firstMatch
    if done.waitForExistence(timeout: 5) { done.tap() }
    snap(app, "ios-minutes-completed")
    let visual = app.buttons["show-visual-summary-button"].firstMatch
    if visual.waitForExistence(timeout: 3) {
      visual.tap()
      snap(app, "ios-visual")
      app.buttons["完成"].firstMatch.tap()
      Thread.sleep(forTimeInterval: 0.8)
    }

    // 6. 行动项总览（会议页右上角入口）
    app.navigationBars.buttons.firstMatch.tap()
    Thread.sleep(forTimeInterval: 0.8)
    let allActions = app.buttons["all-actions-button"].firstMatch
    if allActions.waitForExistence(timeout: 3) {
      allActions.tap()
      snap(app, "ios-actions")
      app.navigationBars.buttons.firstMatch.tap()
      Thread.sleep(forTimeInterval: 0.6)
    }

    // 8. 设置 + AI 总结 + 语音转录子页
    if app.tabBars.buttons["设置"].exists {
      app.tabBars.buttons["设置"].tap()
      Thread.sleep(forTimeInterval: 0.8)
      snap(app, "ios-settings")
      for (label, name) in [("AI 总结", "ios-settings-summary"), ("语音转录", "ios-settings-transcription")] {
        let link = app.staticTexts[label].firstMatch
        if link.waitForExistence(timeout: 3) {
          link.tap()
          snap(app, name)
          app.navigationBars.buttons.firstMatch.tap()
          Thread.sleep(forTimeInterval: 0.6)
        }
      }
    }

    // 9. 首次引导（独立启动；段选择会写入 UserDefaults，进入前先归位、
    //    结束后恢复，保证 walker 重复运行是幂等的）
    let onboard = XCUIApplication()
    onboard.launchArguments = ["UI_TESTING", "UI_TESTING_ONBOARDING"]
    onboard.launch()
    if onboard.buttons["onboarding-start"].waitForExistence(timeout: 8) {
      snap(onboard, "ios-onboarding1")
      onboard.buttons["onboarding-start"].tap()
      let skip = onboard.buttons["稍后允许，继续配置"]
      if skip.waitForExistence(timeout: 5) {
        skip.tap()
        // 语音转录页（第 3 步）：归位 Apple Speech，保证「继续」可用并截默认态。
        let apple = onboard.buttons["Apple Speech"].firstMatch
        if apple.waitForExistence(timeout: 3) { apple.tap() }
        snap(onboard, "ios-onboarding2")
      }
      let next = onboard.buttons["onboarding-transcription-next"]
      if next.waitForExistence(timeout: 5) {
        next.tap()
        // AI 总结页（第 4 步）：先归位本机基础截默认态，再截在线分支。
        let local = onboard.buttons["本地基础纪要"].firstMatch
        if local.waitForExistence(timeout: 3) { local.tap() }
        snap(onboard, "ios-onboarding3")
        let online = onboard.buttons["OpenAI 兼容接口"].firstMatch
        if online.waitForExistence(timeout: 3) {
          online.tap()
          snap(onboard, "ios-onboarding4-online")
          // 打开预设菜单并选择 DeepSeek，验证一键预填官方端点与推荐模型。
          let presetMenu = onboard.buttons["model-preset-menu"].firstMatch
          if presetMenu.waitForExistence(timeout: 3) {
            presetMenu.tap()
            Thread.sleep(forTimeInterval: 1.2)
            let deepseek = onboard.buttons["DeepSeek"].firstMatch
            if deepseek.waitForExistence(timeout: 3) {
              deepseek.tap()
              snap(onboard, "ios-onboarding4-online-preset")
            }
          }
          onboard.buttons["返回"].firstMatch.tap()
          // 语音转录页（第 3 步）：远程 Whisper 分支展示转写厂商预设。
          let remote = onboard.buttons["远程 Whisper"].firstMatch
          if remote.waitForExistence(timeout: 3) {
            remote.tap()
            snap(onboard, "ios-onboarding2-remote")
            // 恢复默认段，避免选中态残留影响下次运行。
            onboard.buttons["Apple Speech"].firstMatch.tap()
          }
        }
      }
    }
  }
}
