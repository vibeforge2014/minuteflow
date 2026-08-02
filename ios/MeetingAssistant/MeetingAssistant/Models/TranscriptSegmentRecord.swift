import Foundation
import SwiftData

@Model
final class TranscriptSegmentRecord {
  @Attribute(.unique) var id: UUID
  var startTime: TimeInterval
  var endTime: TimeInterval
  var speaker: String
  var text: String
  var isFinal: Bool
  var createdAt: Date
  var meeting: MeetingRecord?

  init(
    id: UUID = UUID(),
    startTime: TimeInterval,
    endTime: TimeInterval,
    speaker: String,
    text: String,
    isFinal: Bool = true,
    createdAt: Date = .now,
    meeting: MeetingRecord? = nil
  ) {
    self.id = id
    self.startTime = startTime
    self.endTime = endTime
    self.speaker = speaker
    self.text = text
    self.isFinal = isFinal
    self.createdAt = createdAt
    self.meeting = meeting
  }
}
