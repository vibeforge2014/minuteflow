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
