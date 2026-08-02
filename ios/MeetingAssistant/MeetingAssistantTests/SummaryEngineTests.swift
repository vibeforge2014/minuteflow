import SwiftData
import XCTest

@testable import MeetingAssistant

final class SummaryEngineTests: XCTestCase {
  func testSummaryExtractsMeetingElements() {
    let draft = SummaryEngine.summarize(
      transcript: """
        团队决定采用 B 方案。
        刘婷负责周五前完成可用性测试。
        当前风险是登录失败会阻塞灰度发布。
        是否需要增加法务评审？
        """,
      notes: "重点关注登录链路"
    )

    XCTAssertEqual(draft.decisions, ["团队决定采用 B 方案"])
    XCTAssertEqual(draft.actionItems, ["刘婷负责周五前完成可用性测试"])
    XCTAssertEqual(draft.risks, ["当前风险是登录失败会阻塞灰度发布"])
    XCTAssertEqual(draft.openQuestions, ["是否需要增加法务评审？"])
    XCTAssertTrue(draft.markdown.contains("## 行动项"))
  }

  func testSummaryRemovesDuplicateSentences() {
    let draft = SummaryEngine.summarize(
      transcript: "决定使用新方案。决定使用新方案。",
      notes: ""
    )

    XCTAssertEqual(draft.decisions, ["决定使用新方案"])
  }

  func testTimestampFormatting() {
    XCTAssertEqual(MeetingFormatters.timestamp(0), "00:00")
    XCTAssertEqual(MeetingFormatters.timestamp(125), "02:05")
    XCTAssertEqual(MeetingFormatters.timestamp(3_725), "01:02:05")
  }

  @MainActor
  func testMeetingPersistsRelatedTranscriptAndActionItem() throws {
    let schema = Schema([
      MeetingRecord.self,
      TranscriptSegmentRecord.self,
      ActionItemRecord.self,
    ])
    let configuration = ModelConfiguration(
      schema: schema,
      isStoredInMemoryOnly: true
    )
    let container = try ModelContainer(
      for: schema,
      configurations: [configuration]
    )
    let context = container.mainContext
    let meeting = MeetingRecord(title: "测试会议")
    let segment = TranscriptSegmentRecord(
      startTime: 0,
      endTime: 8,
      speaker: "我",
      text: "开始会议",
      meeting: meeting
    )
    let action = ActionItemRecord(
      title: "输出方案",
      owner: "刘婷",
      meeting: meeting
    )
    meeting.transcriptSegments.append(segment)
    meeting.actionItems.append(action)
    context.insert(meeting)
    try context.save()

    let fetched = try context.fetch(FetchDescriptor<MeetingRecord>())
    XCTAssertEqual(fetched.count, 1)
    XCTAssertEqual(fetched.first?.transcriptText, "开始会议")
    XCTAssertEqual(fetched.first?.actionItems.first?.owner, "刘婷")
  }

  @MainActor
  func testApplyingSummaryDoesNotDuplicateActionItems() {
    let meeting = MeetingRecord(title: "增量纪要")
    let draft = SummaryDraft(
      topics: ["登录改版"],
      keyPoints: ["完成可用性测试"],
      decisions: ["采用 A 方案"],
      actionItems: ["刘婷负责完成测试"],
      openQuestions: [],
      risks: [],
      nextSteps: ["进入灰度"]
    )

    meeting.apply(summary: draft)
    meeting.apply(summary: draft)

    XCTAssertEqual(meeting.actionItems.count, 1)
    XCTAssertTrue(meeting.summaryText.contains("登录改版"))
    XCTAssertTrue(meeting.decisionsText.contains("采用 A 方案"))
  }

  @MainActor
  func testPreferencesPersistInProvidedDefaults() {
    let suiteName = "MeetingAssistantTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let preferences = AppPreferences(defaults: defaults)
    preferences.summaryIntervalSeconds = 300
    preferences.language = "en-US"

    let restored = AppPreferences(defaults: defaults)
    XCTAssertEqual(restored.summaryIntervalSeconds, 300)
    XCTAssertEqual(restored.language, "en-US")
  }

  @MainActor
  func testSRTExportContainsSpeakerAndTimestamps() throws {
    let meeting = MeetingRecord(title: "导出测试")
    meeting.transcriptSegments.append(
      TranscriptSegmentRecord(
        startTime: 2.5,
        endTime: 7.25,
        speaker: "刘婷",
        text: "开始评审",
        meeting: meeting
      )
    )

    let url = try ExportService().makeFile(
      meeting: meeting,
      format: .subtitles
    )
    let text = try String(contentsOf: url, encoding: .utf8)

    XCTAssertTrue(text.contains("00:00:02,500 --> 00:00:07,250"))
    XCTAssertTrue(text.contains("刘婷：开始评审"))
  }
}
