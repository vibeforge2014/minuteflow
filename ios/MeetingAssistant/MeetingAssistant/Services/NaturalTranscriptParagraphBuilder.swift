//
//  NaturalTranscriptParagraphBuilder.swift
//  MeetingAssistant
//
//  把语音识别原子片段整理成自然发言段落。音频上传/处理窗口不参与段落判断；
//  桌面端与 iOS 端保持相同的说话人、停顿、标点、话题起始与长度规则。
//

import Foundation

/// 语音识别器返回的最小原子片段；尚未写入 SwiftData。
struct TranscriptFragment: Identifiable, Equatable {
  let id: UUID
  let startTime: TimeInterval
  let endTime: TimeInterval
  let speaker: String
  let text: String
  let isFinal: Bool

  init(
    id: UUID = UUID(),
    startTime: TimeInterval,
    endTime: TimeInterval,
    speaker: String,
    text: String,
    isFinal: Bool = true
  ) {
    self.id = id
    self.startTime = startTime
    self.endTime = endTime
    self.speaker = speaker
    self.text = text
    self.isFinal = isFinal
  }
}

/// 可直接展示或固化到 TranscriptSegmentRecord 的自然段落。
struct NaturalTranscriptParagraph: Identifiable, Equatable {
  let id: UUID
  var startTime: TimeInterval
  var endTime: TimeInterval
  var speaker: String
  var text: String
  var isFinal: Bool
}

/// 一次转录调用的全文与原子片段；支持时间片的服务填写 fragments，否则走全文降级。
struct TranscriptRecognitionResult: Equatable {
  let text: String
  let fragments: [TranscriptFragment]
}

/// 与桌面端一致的视图层内容变更语义；不写入 SwiftData。
enum ContentChangeKind: Equatable {
  case unchanged
  case added
  case updated
  case appended
}

enum NaturalContentChangeClassifier {
  static func text(previous: String, next: String) -> ContentChangeKind {
    if previous == next { return .unchanged }
    if previous.isEmpty && !next.isEmpty { return .added }
    if !previous.isEmpty && next.hasPrefix(previous) { return .appended }
    return .updated
  }

  static func enteringIDs<ID: Hashable>(
    previousScope: String,
    nextScope: String,
    previous: Set<ID>,
    next: [ID]
  ) -> Set<ID> {
    guard previousScope == nextScope else { return [] }
    return Set(next.filter { !previous.contains($0) })
  }

  /// 保留完全相同（含重复次数）的条目，同位置未匹配内容视为改写，其余视为新增。
  static func strings(previous: [String], next: [String]) -> [ContentChangeKind] {
    func occurrenceKeys(_ values: [String]) -> [String] {
      var counts: [String: Int] = [:]
      return values.map { value in
        counts[value, default: 0] += 1
        return "\(value)\u{0}\(counts[value] ?? 0)"
      }
    }
    let previousKeys = occurrenceKeys(previous)
    let nextKeys = occurrenceKeys(next)
    var matchedPrevious = Set<Int>()
    var matchedNext = Set<Int>()
    for (nextIndex, key) in nextKeys.enumerated() {
      guard let previousIndex = previousKeys.indices.first(where: {
        previousKeys[$0] == key && !matchedPrevious.contains($0)
      }) else { continue }
      matchedPrevious.insert(previousIndex)
      matchedNext.insert(nextIndex)
    }
    return next.indices.map { index in
      if matchedNext.contains(index) { return .unchanged }
      if previous.indices.contains(index), !matchedPrevious.contains(index) {
        matchedPrevious.insert(index)
        return .updated
      }
      return .added
    }
  }
}

enum NaturalTranscriptParagraphBuilder {
  private static let maximumSilence: TimeInterval = 1.5
  private static let maximumDuration: TimeInterval = 45
  private static let maximumCharacters = 120
  private static let topicOpeners = try! NSRegularExpression(
    pattern: #"^(?:接下来|另外(?:一个|一点|一方面)?|关于|至于|最后|总结一下|下一(?:项|点|个)|第[二三四五六七八九十]+[点项个]|next\b|regarding\b|finally\b)"#,
    options: [.caseInsensitive]
  )
  private static let sentencePattern = try! NSRegularExpression(
    pattern: #"[^。！？!?…]+(?:[。！？!?…]+|$)"#
  )

  /// 按自然发言边界整理片段；第一片的 UUID 作为段落稳定 ID。
  static func paragraphs(from fragments: [TranscriptFragment]) -> [NaturalTranscriptParagraph] {
    fragments
      .filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
      .sorted { $0.startTime < $1.startTime }
      .reduce(into: [NaturalTranscriptParagraph]()) { paragraphs, fragment in
        let current = NaturalTranscriptParagraph(
          id: fragment.id,
          startTime: fragment.startTime,
          endTime: max(fragment.startTime, fragment.endTime),
          speaker: fragment.speaker,
          text: fragment.text.trimmingCharacters(in: .whitespacesAndNewlines),
          isFinal: fragment.isFinal
        )
        guard var previous = paragraphs.last,
          canMerge(previous, current)
        else {
          paragraphs.append(current)
          return
        }

        let spacer = needsLatinSpacer(previous.text, current.text) ? " " : ""
        previous.endTime = max(previous.endTime, current.endTime)
        previous.isFinal = previous.isFinal && current.isFinal
        if !normalized(previous.text).contains(normalized(current.text)) {
          previous.text += spacer + current.text
        }
        paragraphs[paragraphs.count - 1] = previous
      }
  }

  /// 只有全文时按句末标点拆分，并按非标点文字长度分配近似时间。
  static func timedFragments(
    text: String,
    startTime: TimeInterval,
    endTime: TimeInterval,
    speaker: String,
    isFinal: Bool = true
  ) -> [TranscriptFragment] {
    let parts = splitText(text)
    guard !parts.isEmpty else { return [] }
    guard parts.count > 1 else {
      return [TranscriptFragment(
        startTime: startTime,
        endTime: max(startTime, endTime),
        speaker: speaker,
        text: parts[0],
        isFinal: isFinal
      )]
    }

    let weights = parts.map { max(1, normalized($0).count) }
    let totalWeight = max(1, weights.reduce(0, +))
    let duration = max(TimeInterval(parts.count) / 1_000, endTime - startTime)
    var consumedWeight = 0
    var cursor = startTime
    return parts.enumerated().map { index, part in
      consumedWeight += weights[index]
      let next = index == parts.count - 1
        ? endTime
        : min(endTime, max(cursor + 0.001, startTime + duration * Double(consumedWeight) / Double(totalWeight)))
      defer { cursor = max(cursor + 0.001, next) }
      return TranscriptFragment(
        startTime: cursor,
        endTime: max(cursor + 0.001, next),
        speaker: speaker,
        text: part,
        isFinal: isFinal
      )
    }
  }

  private static func canMerge(
    _ previous: NaturalTranscriptParagraph,
    _ current: NaturalTranscriptParagraph
  ) -> Bool {
    let gap = current.startTime - previous.endTime
    let combined = previous.text + (needsLatinSpacer(previous.text, current.text) ? " " : "") + current.text
    let startsNewTopic = endsCompleteSentence(previous.text) && isTopicOpener(current.text)
    return previous.speaker == current.speaker
      && gap >= -0.5 && gap < maximumSilence
      && current.endTime - previous.startTime <= maximumDuration
      && combined.count <= maximumCharacters
      && terminalCount(previous.text) < 2
      && !endsHardSentence(previous.text)
      && !startsNewTopic
  }

  private static func splitText(_ value: String) -> [String] {
    let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    let matches = sentencePattern.matches(in: text, range: range).compactMap { match -> String? in
      guard let swiftRange = Range(match.range, in: text) else { return nil }
      let part = String(text[swiftRange]).trimmingCharacters(in: .whitespacesAndNewlines)
      return part.isEmpty ? nil : part
    }
    return matches.isEmpty ? [text] : matches
  }

  private static func terminalCount(_ text: String) -> Int {
    text.filter { "。！？!?…".contains($0) }.count
  }

  private static func endsCompleteSentence(_ text: String) -> Bool {
    text.trimmingCharacters(in: .whitespacesAndNewlines).last.map { "。！？!?…".contains($0) } ?? false
  }

  private static func endsHardSentence(_ text: String) -> Bool {
    text.trimmingCharacters(in: .whitespacesAndNewlines).last.map { "！？!?".contains($0) } ?? false
  }

  private static func isTopicOpener(_ text: String) -> Bool {
    let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return topicOpeners.firstMatch(
      in: value,
      range: NSRange(value.startIndex..<value.endIndex, in: value)
    ) != nil
  }

  private static func needsLatinSpacer(_ left: String, _ right: String) -> Bool {
    guard let leftCharacter = left.last, let rightCharacter = right.first else { return false }
    return isASCIIAlphaNumeric(leftCharacter) && isASCIIAlphaNumeric(rightCharacter)
  }

  private static func isASCIIAlphaNumeric(_ character: Character) -> Bool {
    character.unicodeScalars.allSatisfy { scalar in
      scalar.value < 128 && CharacterSet.alphanumerics.contains(scalar)
    }
  }

  private static func normalized(_ text: String) -> String {
    text.lowercased().filter { character in
      !character.isWhitespace && !"，。！？、,.!?;；:：'\"“”‘’".contains(character)
    }
  }
}
