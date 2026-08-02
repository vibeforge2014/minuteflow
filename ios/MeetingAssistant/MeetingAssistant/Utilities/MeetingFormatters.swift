import Foundation

enum MeetingFormatters {
  static func timestamp(_ interval: TimeInterval) -> String {
    let value = max(0, Int(interval.rounded(.down)))
    let hours = value / 3_600
    let minutes = (value % 3_600) / 60
    let seconds = value % 60

    if hours > 0 {
      return String(format: "%02d:%02d:%02d", hours, minutes, seconds)
    }
    return String(format: "%02d:%02d", minutes, seconds)
  }

  static func compactDuration(_ interval: TimeInterval) -> String {
    let value = max(0, Int(interval.rounded(.down)))
    let minutes = value / 60
    let seconds = value % 60
    return String(format: "%02d:%02d", minutes, seconds)
  }

  static func shortDate(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.dateFormat = "MM-dd"
    return formatter.string(from: date)
  }

  static func dateTime(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.dateFormat = "yyyy-MM-dd HH:mm"
    return formatter.string(from: date)
  }
}
