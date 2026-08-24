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
  func testOnboardingModelChoicesPersistTogether() {
    let suiteName = "MeetingAssistantOnboardingTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let preferences = AppPreferences(defaults: defaults)
    preferences.transcriptionProvider = .remoteWhisper
    preferences.transcriptionBaseURL = "https://whisper.example.com/v1"
    preferences.transcriptionModel = "whisper-1"
    preferences.summaryProvider = .openAICompatible
    preferences.summaryBaseURL = "https://llm.example.com/v1"
    preferences.summaryModel = "qwen-plus"
    preferences.hasCompletedOnboarding = true

    let restored = AppPreferences(defaults: defaults)
    XCTAssertEqual(restored.transcriptionProvider, .remoteWhisper)
    XCTAssertEqual(restored.transcriptionModel, "whisper-1")
    XCTAssertEqual(restored.summaryProvider, .openAICompatible)
    XCTAssertEqual(restored.summaryModel, "qwen-plus")
    XCTAssertTrue(restored.hasCompletedOnboarding)
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

  func testVisualSummaryValidationRenumbersSectionsAndRejectsMarkup() throws {
    let date = Date(timeIntervalSince1970: 1_777_000_000)
    let valid = VisualSummary(
      schemaVersion: 1,
      title: "产品周会视觉纪要",
      subtitle: "聚焦登录改版与灰度发布",
      sections: [
        VisualSummarySection(
          id: "decision",
          number: 5,
          title: "会议定调",
          tone: .green,
          layout: .callout,
          table: nil,
          cards: nil,
          callout: "先以 5% 流量灰度，再按数据决定扩量。"
        )
      ],
      generatedAt: date,
      sourceSummaryUpdatedAt: date,
      stale: false
    )
    XCTAssertEqual(try valid.validated().sections.first?.number, 1)

    var invalid = valid
    invalid.subtitle = "https://example.com/meeting"
    XCTAssertThrowsError(try invalid.validated())
  }

  @MainActor
  func testVisualCapabilityVerificationIsClearedWhenConfigurationChanges() {
    let suiteName = "MeetingAssistantVisualTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let preferences = AppPreferences(defaults: defaults)
    preferences.summaryProvider = .openAICompatible
    preferences.visualSummaryEnabled = true
    preferences.markVisualSummaryVerified()
    XCTAssertTrue(preferences.visualSummaryIsVerified)

    preferences.summaryModel = "another-model"
    XCTAssertFalse(preferences.visualSummaryIsVerified)
    XCTAssertTrue(preferences.visualSummaryVerifiedFingerprint.isEmpty)
  }

  @MainActor
  func testVisualSummaryPersistsAndBecomesStaleAfterOrdinarySummaryChanges() throws {
    let meeting = MeetingRecord(title: "视觉纪要持久化")
    let date = Date(timeIntervalSince1970: 1_777_000_000)
    let visual = VisualSummary(
      schemaVersion: 1,
      title: "视觉纪要持久化",
      subtitle: "关键决策一页呈现",
      sections: [
        VisualSummarySection(
          id: "final",
          number: 1,
          title: "最终结论",
          tone: .coral,
          layout: .callout,
          table: nil,
          cards: nil,
          callout: "保持普通纪要为事实源。"
        )
      ],
      generatedAt: date,
      sourceSummaryUpdatedAt: date,
      stale: false
    )
    try meeting.apply(visualSummary: visual)
    XCTAssertEqual(meeting.visualSummary?.title, "视觉纪要持久化")
    XCTAssertFalse(meeting.visualSummary?.stale ?? true)

    meeting.apply(summary: SummaryDraft(
      topics: ["方案"], keyPoints: ["普通纪要已更新"], decisions: [],
      actionItems: [], openQuestions: [], risks: [], nextSteps: []
    ))
    XCTAssertTrue(meeting.visualSummary?.stale ?? false)
  }

  @MainActor
  func testVisualPNGAndBackupExportKeepTheStructuredSummary() throws {
    let meeting = MeetingRecord(title: "视觉导出测试", participantsText: "刘婷、周哲")
    let date = Date(timeIntervalSince1970: 1_777_000_000)
    try meeting.apply(visualSummary: VisualSummary(
      schemaVersion: 1,
      title: "视觉导出测试",
      subtitle: "长文本应按内容自适应高度且中文无乱码",
      sections: [
        VisualSummarySection(
          id: "cards",
          number: 1,
          title: "重点任务",
          tone: .violet,
          layout: .cards,
          table: nil,
          cards: [
            VisualSummaryCard(
              title: "客户端联调",
              status: "进行中",
              bullets: ["完成接口约定", "补充异常路径", "周五前完成回归"],
              takeaway: "优先打通关键链路"
            )
          ],
          callout: nil
        )
      ],
      generatedAt: date,
      sourceSummaryUpdatedAt: date,
      stale: false
    ))

    let pngURL = try ExportService().makeFile(meeting: meeting, format: .visualPNG)
    let png = try Data(contentsOf: pngURL)
    XCTAssertGreaterThan(png.count, 1_000)
    XCTAssertEqual(Array(png.prefix(8)), [137, 80, 78, 71, 13, 10, 26, 10])

    let backupURL = try ExportService().makeFile(meeting: meeting, format: .backup)
    let backup = try String(contentsOf: backupURL, encoding: .utf8)
    XCTAssertTrue(backup.contains("\"visualSummary\""))
    XCTAssertTrue(backup.contains("视觉导出测试"))
  }
}
