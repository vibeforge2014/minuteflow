//
//  SummaryEngine.swift
//  MeetingAssistant
//
//  本地纪要引擎：不联网，基于句子切分与中文关键词匹配，从转录与笔记中提炼
//  主题、要点、决策、行动项、未决问题、风险与下一步，产出 SummaryDraft。
//  所属层：服务层（纯函数，无副作用）。
//

import Foundation

// MARK: - 纪要草稿

/// 结构化纪要草稿；与远程模型返回的 JSON 字段对齐（可 Codable），也能渲染 Markdown。
struct SummaryDraft: Equatable, Codable {
  /// 主题要点句列表。
  var topics: [String]
  /// 关键结论句列表。
  var keyPoints: [String]
  /// 决策句列表。
  var decisions: [String]
  /// 行动项句列表。
  var actionItems: [String]
  /// 未决问题句列表。
  var openQuestions: [String]
  /// 风险句列表。
  var risks: [String]
  /// 下一步句列表。
  var nextSteps: [String]

  /// 渲染为 Markdown 文本（空小节自动省略）。
  var markdown: String {
    [
      section("主题要点", values: topics),
      section("关键结论", values: keyPoints),
      section("决策", values: decisions),
      section("行动项", values: actionItems),
      section("未决问题", values: openQuestions),
      section("风险", values: risks),
      section("下一步", values: nextSteps),
    ]
    .filter { !$0.isEmpty }
    .joined(separator: "\n\n")
  }

  /// 渲染一个“## 标题 + 列表”小节；空列表返回空串。
  private func section(_ title: String, values: [String]) -> String {
    guard !values.isEmpty else { return "" }
    return "## \(title)\n" + values.map { "- \($0)" }.joined(separator: "\n")
  }
}

// MARK: - 视觉纪要 schema

enum VisualSummaryLayout: String, Codable {
  case table
  case cards
  case callout
}

enum VisualSummaryTone: String, Codable {
  case coral
  case amber
  case violet
  case green
}

struct VisualSummaryTable: Equatable, Codable {
  var columns: [String]
  var rows: [[String]]
}

struct VisualSummaryCard: Equatable, Codable {
  var title: String
  var status: String?
  var bullets: [String]
  var takeaway: String?
}

struct VisualSummarySection: Equatable, Codable, Identifiable {
  var id: String
  var number: Int
  var title: String
  var tone: VisualSummaryTone
  var layout: VisualSummaryLayout
  var table: VisualSummaryTable?
  var cards: [VisualSummaryCard]?
  var callout: String?
}

struct VisualSummary: Equatable, Codable {
  var schemaVersion: Int
  var title: String
  var subtitle: String
  var sections: [VisualSummarySection]
  var generatedAt: Date
  var sourceSummaryUpdatedAt: Date
  var stale: Bool

  /// 对模型返回的受限 schema 做跨平台一致校验；所有字段必须为纯文本。
  func validated() throws -> VisualSummary {
    guard schemaVersion == 1, !title.isEmpty, !subtitle.isEmpty,
      (1...5).contains(sections.count), Self.isPlain(title), Self.isPlain(subtitle)
    else { throw SummaryServiceError.invalidVisualSummary }

    var normalized = self
    for index in normalized.sections.indices {
      var section = normalized.sections[index]
      guard !section.id.isEmpty, Self.isPlain(section.title) else {
        throw SummaryServiceError.invalidVisualSummary
      }
      section.number = index + 1
      switch section.layout {
      case .table:
        guard let table = section.table,
          (2...4).contains(table.columns.count), table.rows.count <= 5,
          table.columns.allSatisfy(Self.isPlain),
          table.rows.allSatisfy({ $0.count == table.columns.count && $0.allSatisfy(Self.isPlain) })
        else { throw SummaryServiceError.invalidVisualSummary }
      case .cards:
        guard let cards = section.cards, (1...4).contains(cards.count),
          cards.allSatisfy({ card in
            Self.isPlain(card.title) && card.bullets.count <= 4
              && card.bullets.allSatisfy(Self.isPlain)
              && card.status.map(Self.isPlain) ?? true
              && card.takeaway.map(Self.isPlain) ?? true
          })
        else { throw SummaryServiceError.invalidVisualSummary }
      case .callout:
        guard let callout = section.callout, Self.isPlain(callout) else {
          throw SummaryServiceError.invalidVisualSummary
        }
      }
      normalized.sections[index] = section
    }
    return normalized
  }

  private static func isPlain(_ value: String) -> Bool {
    guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      value.count <= 240
    else { return false }
    return value.range(
      of: #"(<[^>]+>|```|https?://|^\s{0,3}#{1,6}\s)"#,
      options: [.regularExpression, .caseInsensitive]
    ) == nil
  }
}

// MARK: - 本地引擎

/// 本地关键词纪要引擎（离线可用，无副作用）。
enum SummaryEngine {
  /// 从转录与笔记生成结构化草稿。
  ///
  /// - Parameters:
  ///   - transcript: 会议转录文本。
  ///   - notes: 人工笔记。
  /// - Returns: 分类后的 SummaryDraft。
  static func summarize(transcript: String, notes: String) -> SummaryDraft {
    let sentences = normalizedSentences(from: [transcript, notes].joined(separator: "\n"))
    // 决策/行动/风险按中文关键词归类；未决问题按问句与“待确认”类措辞识别。
    let decisions = matching(sentences, keywords: ["决定", "确定", "结论", "通过", "采用"])
    let actions = matching(sentences, keywords: ["负责", "完成", "跟进", "处理", "提交", "TODO", "待办"])
    let questions = sentences.filter {
      $0.contains("？") || $0.contains("?")
        || ["待确认", "未决", "还需要", "是否"].contains(where: $0.contains)
    }
    let risks = matching(sentences, keywords: ["风险", "阻塞", "延期", "问题", "失败", "依赖"])

    // 要点取前几句；主题取未被归类的前几句，避免与决策/行动重复。
    let keyPoints = Array(sentences.prefix(6))
    let topics = Array(
      sentences
        .filter { sentence in
          !decisions.contains(sentence) && !actions.contains(sentence)
            && !questions.contains(sentence)
        }
        .prefix(4)
    )

    return SummaryDraft(
      topics: topics,
      keyPoints: keyPoints,
      decisions: decisions,
      actionItems: actions,
      openQuestions: questions,
      risks: risks,
      nextSteps: actions.isEmpty ? Array(sentences.suffix(2)) : actions
    )
  }

  /// 文本归一化：按中英文句读切句、去列表前缀、去空行并保序去重。
  static func normalizedSentences(from text: String) -> [String] {
    text
      .replacingOccurrences(of: "。", with: "\n")
      .replacingOccurrences(of: "！", with: "\n")
      .replacingOccurrences(of: "；", with: "\n")
      .replacingOccurrences(of: ";", with: "\n")
      .split(whereSeparator: \.isNewline)
      .map {
        $0.trimmingCharacters(in: .whitespacesAndNewlines)
          .replacingOccurrences(
            of: #"^[\-\*•\d\.\s]+"#,
            with: "",
            options: .regularExpression
          )
      }
      .filter { !$0.isEmpty }
      .reduce(into: [String]()) { result, sentence in
        if !result.contains(sentence) {
          result.append(sentence)
        }
      }
  }

  /// 返回命中任一关键词的句子（大小写不敏感）。
  private static func matching(_ values: [String], keywords: [String]) -> [String] {
    values.filter { sentence in
      keywords.contains { sentence.localizedCaseInsensitiveContains($0) }
    }
  }
}
