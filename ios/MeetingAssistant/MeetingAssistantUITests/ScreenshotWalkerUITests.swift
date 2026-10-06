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

    // 1. 会议库
    XCTAssertTrue(app.navigationBars["MinuteFlow"].waitForExistence(timeout: 8))
    snap(app, "ios-library")

    // 2. 进行中会议 → 文档（默认段）
    let live = app.staticTexts["产品团队周会"].firstMatch
    if live.waitForExistence(timeout: 5) { live.tap() }
    snap(app, "ios-meeting-doc")

    // 3. 转录
    let transcript = app.segmentedControls.buttons["转录"].firstMatch
    if transcript.waitForExistence(timeout: 3) { transcript.tap() }
    snap(app, "ios-transcript")

    // 4. AI 纪要（普通）→ 视觉纪要
    let minutes = app.segmentedControls.buttons["AI 纪要"].firstMatch
    if minutes.waitForExistence(timeout: 3) { minutes.tap() }
    snap(app, "ios-minutes")

    // 5. AI 问答
    let chat = app.segmentedControls.buttons["AI 问答"].firstMatch
    if chat.waitForExistence(timeout: 3) { chat.tap() }
    snap(app, "ios-chat")

    // 6. 回会议库 → 打开已完成会议（项目复盘）看普通/视觉纪要
    app.navigationBars.buttons.firstMatch.tap()
    Thread.sleep(forTimeInterval: 0.8)
    let done = app.staticTexts["项目复盘：移动端体验优化"].firstMatch
    if done.waitForExistence(timeout: 5) { done.tap() }
    let minutes2 = app.segmentedControls.buttons["AI 纪要"].firstMatch
    if minutes2.waitForExistence(timeout: 3) { minutes2.tap() }
    snap(app, "ios-minutes-completed")
    let visual = app.segmentedControls.buttons["视觉纪要"].firstMatch
    if visual.waitForExistence(timeout: 3) { visual.tap() }
    snap(app, "ios-visual")

    // 7. 行动项 tab
    app.navigationBars.buttons.firstMatch.tap()
    Thread.sleep(forTimeInterval: 0.8)
    if app.tabBars.buttons["行动项"].exists {
      app.tabBars.buttons["行动项"].tap()
      snap(app, "ios-actions")
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

    // 9. 首次引导（独立启动）
    let onboard = XCUIApplication()
    onboard.launchArguments = ["UI_TESTING", "UI_TESTING_ONBOARDING"]
    onboard.launch()
    if onboard.buttons["onboarding-start"].waitForExistence(timeout: 8) {
      snap(onboard, "ios-onboarding1")
      onboard.buttons["onboarding-start"].tap()
      let skip = onboard.buttons["稍后允许，继续配置"]
      if skip.waitForExistence(timeout: 5) {
        skip.tap()
        snap(onboard, "ios-onboarding2")
      }
      let next = onboard.buttons["onboarding-transcription-next"]
      if next.waitForExistence(timeout: 5) {
        next.tap()
        snap(onboard, "ios-onboarding3")
      }
    }
  }
}
