//
//  MeetingFormatters.swift
//  MeetingAssistant
//
//  会议展示格式化工具：秒数时间戳、紧凑时长与中文（zh_CN）日期/日期时间文案，
//  供列表、文档、转录与导出统一调用。
//  所属层：工具层（纯静态方法，无副作用）。
//

import Foundation

// MARK: - 格式化工具

/// 时间与时长格式化集合。
enum MeetingFormatters {
  /// 秒 → "mm:ss"（满 1 小时为 "HH:mm:ss"）；向下取整，负数归零。
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

  /// 秒 → "mm:ss" 紧凑时长（会议库列表行使用）。
  static func compactDuration(_ interval: TimeInterval) -> String {
    let value = max(0, Int(interval.rounded(.down)))
    let minutes = value / 60
    let seconds = value % 60
    return String(format: "%02d:%02d", minutes, seconds)
  }

  /// 日期 → "MM-dd"（zh_CN）。
  static func shortDate(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.dateFormat = "MM-dd"
    return formatter.string(from: date)
  }

  /// 日期 → "yyyy-MM-dd HH:mm"（zh_CN）。
  static func dateTime(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.dateFormat = "yyyy-MM-dd HH:mm"
    return formatter.string(from: date)
  }
}
