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

    XCTAssertTrue(
      app.buttons["start-recording-button"].waitForExistence(timeout: 5)
    )
    XCTAssertTrue(app.segmentedControls.buttons["转录"].exists)
    XCTAssertTrue(app.segmentedControls.buttons["AI 纪要"].exists)
  }

  func testPrimaryTabsAreAvailable() {
    let app = XCUIApplication()
    app.launchArguments = ["UI_TESTING"]
    app.launch()

    XCTAssertTrue(app.tabBars.buttons["会议"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.tabBars.buttons["行动项"].exists)
    XCTAssertTrue(app.tabBars.buttons["设置"].exists)

    app.tabBars.buttons["行动项"].tap()
    XCTAssertTrue(app.navigationBars["行动项"].waitForExistence(timeout: 3))

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

  func testCompletedMeetingSwitchesBetweenOrdinaryAndVisualMinutes() {
    let app = XCUIApplication()
    app.launchArguments = ["UI_TESTING"]
    app.launch()

    let meeting = app.staticTexts["项目复盘：移动端体验优化"].firstMatch
    XCTAssertTrue(meeting.waitForExistence(timeout: 5))
    let meetingCell = app.cells.containing(.staticText, identifier: "项目复盘：移动端体验优化").firstMatch
    if meetingCell.exists { meetingCell.tap() } else { meeting.tap() }

    if UIDevice.current.userInterfaceIdiom == .phone {
      XCTAssertTrue(app.segmentedControls.buttons["AI 纪要"].waitForExistence(timeout: 5))
      app.segmentedControls.buttons["AI 纪要"].tap()
    } else {
      XCTAssertEqual(app.textFields["meeting-title-field"].value as? String, "项目复盘：移动端体验优化")
    }
    XCTAssertTrue(app.segmentedControls.buttons["视觉纪要"].waitForExistence(timeout: 5))
    app.segmentedControls.buttons["视觉纪要"].tap()
    XCTAssertTrue(app.staticTexts["移动端体验优化复盘"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["会议定调"].waitForExistence(timeout: 5))

    app.segmentedControls.buttons["普通纪要"].tap()
    XCTAssertTrue(app.staticTexts["关键决策"].waitForExistence(timeout: 5))
  }

  func testTabletWorkspaceShowsDocumentAndTranscriptTogether() throws {
    guard UIDevice.current.userInterfaceIdiom == .pad else {
      throw XCTSkip("仅在 iPad 模拟器验证多栏工作区")
    }

    let app = XCUIApplication()
    app.launchArguments = ["UI_TESTING"]
    app.launch()

    XCTAssertTrue(
      app.textFields["meeting-title-field"].waitForExistence(timeout: 5)
    )
    XCTAssertTrue(app.staticTexts["实时转录"].waitForExistence(timeout: 5))
    XCTAssertTrue(
      app.buttons["start-recording-button"].waitForExistence(timeout: 5)
    )
  }
}
