import Foundation

struct SummaryDraft: Equatable, Codable {
  var topics: [String]
  var keyPoints: [String]
  var decisions: [String]
  var actionItems: [String]
  var openQuestions: [String]
  var risks: [String]
  var nextSteps: [String]

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

  private func section(_ title: String, values: [String]) -> String {
    guard !values.isEmpty else { return "" }
    return "## \(title)\n" + values.map { "- \($0)" }.joined(separator: "\n")
  }
}

enum SummaryEngine {
  static func summarize(transcript: String, notes: String) -> SummaryDraft {
    let sentences = normalizedSentences(from: [transcript, notes].joined(separator: "\n"))
    let decisions = matching(sentences, keywords: ["决定", "确定", "结论", "通过", "采用"])
    let actions = matching(sentences, keywords: ["负责", "完成", "跟进", "处理", "提交", "TODO", "待办"])
    let questions = sentences.filter {
      $0.contains("？") || $0.contains("?")
        || ["待确认", "未决", "还需要", "是否"].contains(where: $0.contains)
    }
    let risks = matching(sentences, keywords: ["风险", "阻塞", "延期", "问题", "失败", "依赖"])

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

  private static func matching(_ values: [String], keywords: [String]) -> [String] {
    values.filter { sentence in
      keywords.contains { sentence.localizedCaseInsensitiveContains($0) }
    }
  }
}
