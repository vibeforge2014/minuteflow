import UIKit
import XCTest

final class MeetingAssistantUITests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  func testMeetingLibraryOpensDocumentWorkspace() {
    let app = XCUIApplication()
    app.launchArguments = ["UI_TESTING"]
    app.launch()

    XCTAssertTrue(
      app.navigationBars["MinuteFlow"].waitForExistence(timeout: 5)
    )
    let meeting = app.staticTexts["产品团队周会"].firstMatch
    XCTAssertTrue(meeting.waitForExistence(timeout: 5))
    meeting.tap()

    // 两段式详情：录音中的会议默认落在「转录」，录音条仍在底部常驻。
    XCTAssertTrue(
      app.buttons["start-recording-button"].waitForExistence(timeout: 5)
    )
    XCTAssertTrue(app.segmentedControls.buttons["转录"].exists)
    XCTAssertTrue(app.segmentedControls.buttons["AI 纪要"].exists)
    XCTAssertFalse(app.segmentedControls.buttons["文档"].exists)
    XCTAssertFalse(app.segmentedControls.buttons["AI 问答"].exists)
    // AI 问答改为导航栏气泡按钮。
    XCTAssertTrue(app.buttons["chat-button"].exists)
  }

  func testPrimaryTabsAreAvailable() {
    let app = XCUIApplication()
    app.launchArguments = ["UI_TESTING"]
    app.launch()

    XCTAssertTrue(app.tabBars.buttons["会议"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.tabBars.buttons["设置"].exists)
    XCTAssertFalse(app.tabBars.buttons["行动项"].exists)

    // 跨会议行动项汇总从会议页右上角进入。
    app.buttons["all-actions-button"].tap()
    XCTAssertTrue(app.navigationBars["行动项"].waitForExistence(timeout: 3))
    app.navigationBars.buttons.firstMatch.tap()

    app.tabBars.buttons["设置"].tap()
    XCTAssertTrue(app.navigationBars["设置"].waitForExistence(timeout: 3))
  }

  func testFirstLaunchGuidesTranscriptionAndSummaryConfiguration() {
    let app = XCUIApplication()
    app.launchArguments = ["UI_TESTING", "UI_TESTING_ONBOARDING"]
    app.launch()

    XCTAssertTrue(app.buttons["onboarding-start"].waitForExistence(timeout: 5))
    app.buttons["onboarding-start"].tap()

    let skipPermission = app.buttons["稍后允许，继续配置"]
    XCTAssertTrue(skipPermission.waitForExistence(timeout: 5))
    skipPermission.tap()

    XCTAssertTrue(app.segmentedControls["onboarding-transcription-provider"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["onboarding-transcription-next"].exists)
    app.buttons["onboarding-transcription-next"].tap()

    XCTAssertTrue(app.segmentedControls["onboarding-summary-provider"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["onboarding-summary-finish"].exists)
    app.buttons["onboarding-summary-finish"].tap()

    if UIDevice.current.userInterfaceIdiom == .pad {
      XCTAssertTrue(app.textFields["meeting-title-field"].waitForExistence(timeout: 5))
    } else {
      XCTAssertTrue(app.navigationBars["MinuteFlow"].waitForExistence(timeout: 5))
    }
  }

  func testCompletedMeetingShowsVisualSummaryFromMinutesEntry() {
    let app = XCUIApplication()
    app.launchArguments = ["UI_TESTING"]
    app.launch()

    let meeting = app.staticTexts["项目复盘：移动端体验优化"].firstMatch
    XCTAssertTrue(meeting.waitForExistence(timeout: 5))
    let meetingCell = app.cells.containing(.staticText, identifier: "项目复盘：移动端体验优化").firstMatch
    if meetingCell.exists { meetingCell.tap() } else { meeting.tap() }

    if UIDevice.current.userInterfaceIdiom == .phone {
      // 会后整理的会议默认落在「AI 纪要」。
      XCTAssertTrue(app.segmentedControls.buttons["AI 纪要"].waitForExistence(timeout: 5))
    } else {
      XCTAssertEqual(app.textFields["meeting-title-field"].value as? String, "项目复盘：移动端体验优化")
    }
    XCTAssertTrue(app.staticTexts["关键结论"].waitForExistence(timeout: 5))

    // 视觉纪要入口卡：点开全屏海报，再关闭回到纪要文档。
    let visualEntry = app.buttons["show-visual-summary-button"]
    XCTAssertTrue(visualEntry.waitForExistence(timeout: 5))
    visualEntry.tap()
    XCTAssertTrue(app.staticTexts["移动端体验优化复盘"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["会议定调"].waitForExistence(timeout: 5))
    app.buttons["完成"].tap()

    XCTAssertTrue(app.staticTexts["关键结论"].waitForExistence(timeout: 5))
  }

  func testChatOpensAsSheetFromDetailToolbar() {
    let app = XCUIApplication()
    app.launchArguments = ["UI_TESTING"]
    app.launch()

    let meeting = app.staticTexts["产品团队周会"].firstMatch
    XCTAssertTrue(meeting.waitForExistence(timeout: 5))
    meeting.tap()
    XCTAssertTrue(app.buttons["chat-button"].waitForExistence(timeout: 5))

    app.buttons["chat-button"].tap()
    // 弹层中出现 AI 问答面板（演示环境未配置在线模型时显示设置引导）。
    XCTAssertTrue(
      (app.staticTexts["AI 问答"].waitForExistence(timeout: 5))
        || (app.buttons["去设置"].waitForExistence(timeout: 2))
    )
  }

  func testTabletWorkspaceShowsDocumentAndTranscriptTogether() throws {
    guard UIDevice.current.userInterfaceIdiom == .pad else {
      throw XCTSkip("仅在 iPad 模拟器验证多栏工作区")
    }

    let app = XCUIApplication()
    app.launchArguments = ["UI_TESTING"]
    app.launch()

    // iPad：中栏「AI 纪要 | 转录」+ 右栏常驻 AI 问答（未配置在线模型时为设置引导）。
    XCTAssertTrue(
      app.textFields["meeting-title-field"].waitForExistence(timeout: 5)
    )
    XCTAssertTrue(app.segmentedControls.buttons["转录"].exists)
    XCTAssertTrue(app.segmentedControls.buttons["AI 纪要"].exists)
    XCTAssertTrue(
      app.buttons["start-recording-button"].waitForExistence(timeout: 5)
    )
  }
}
