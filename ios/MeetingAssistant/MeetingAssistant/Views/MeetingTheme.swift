//
//  MeetingTheme.swift
//  MeetingAssistant
//
//  视觉主题与通用组件：定义 TuneSync 风格的暖橙主色、系统原生表面色、语义状态色
//  与说话人配色，并提供 DocumentCard / StatusPill 两个复用组件。
//  所属层：视图层（主题/设计系统）。
//

import SwiftUI
import UIKit

// MARK: - 主题色板

/// 全局主题色集合（静态常量）。
enum MeetingTheme {
  /// 主色：TuneSync 风格暖珊瑚橙（#E76F51 一线），用于主按钮、tint 与强调。
  // TuneSync-inspired palette: warm coral actions on quiet, system-native surfaces.
  static let primary = Color(red: 0.906, green: 0.435, blue: 0.318)
  /// 填充动作色：更深的可访问珊瑚（与桌面端 --accent-strong #C65138 对齐），
  /// 白字对比达标，用于「开始录音」这类核心填充按钮。
  static let primaryStrong = Color(red: 0.776, green: 0.318, blue: 0.220)
  /// 主色 12% 透明度的柔和底色（选中态/软卡片）。
  static let primarySoft = primary.opacity(0.12)
  /// 页面画布底色（systemGroupedBackground）。
  static let canvas = Color(uiColor: .systemGroupedBackground)
  /// 卡片表面色（secondarySystemGroupedBackground）。
  static let surface = Color(uiColor: .secondarySystemGroupedBackground)
  /// 更高一层的表面色（tertiarySystemGroupedBackground）。
  static let surfaceRaised = Color(uiColor: .tertiarySystemGroupedBackground)
  /// 侧栏背景色。
  static let sidebar = Color(uiColor: .secondarySystemGroupedBackground)
  /// 分隔线颜色（separator 18% 透明度；极简风只保留发丝级提示）。
  static let divider = Color(uiColor: .separator).opacity(0.18)
  /// 语义色：成功/录音中（绿色系）。
  static let success = Color(red: 0.20, green: 0.58, blue: 0.36)
  /// 语义色：警告/整理中（琥珀色系）。
  static let warning = Color(red: 0.86, green: 0.49, blue: 0.14)
  /// 语义色：信息（蓝色系）。
  static let info = Color(red: 0.25, green: 0.52, blue: 0.82)
  /// 说话人专属紫色（示例说话人“刘婷”）；蓝色仅用于说话人身份等语义。
  static let speakerViolet = Color(red: 0.52, green: 0.36, blue: 0.78)
}

// MARK: - 通用组件

extension View {
  /// 极简卡片表面：连续大圆角 + 极淡阴影分层，不用描边——
  /// 层级靠表面色差与留白表达（现代化极简风）。
  func cardSurface(cornerRadius: CGFloat = 18) -> some View {
    self
      .background(MeetingTheme.surface)
      .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
      .shadow(color: .black.opacity(0.04), radius: 10, x: 0, y: 2)
  }
}

/// 文档卡片容器：珊瑚图标 + 小节标题 + 自定义内容（文档视图的统一外壳）。
struct DocumentCard<Content: View>: View {
  /// 卡片标题。
  let title: String
  /// 标题图标（SF Symbol 名）。
  let systemImage: String
  /// 卡片内容。
  @ViewBuilder let content: Content

  /// 创建卡片。
  /// - Parameters:
  ///   - title: 卡片标题。
  ///   - systemImage: 标题图标名。
  ///   - content: 卡片内容构造闭包。
  init(
    _ title: String,
    systemImage: String,
    @ViewBuilder content: () -> Content
  ) {
    self.title = title
    self.systemImage = systemImage
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 7) {
        Image(systemName: systemImage)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(MeetingTheme.primary)
        Text(title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(.primary)
      }
      content
    }
    .padding(20)
    .cardSurface()
  }
}

/// 会议状态胶囊：彩点 + 状态文案，按 MeetingStatus 映射语义色。
struct StatusPill: View {
  /// 展示的会议状态。
  let status: MeetingStatus

  var body: some View {
    HStack(spacing: 5) {
      Circle()
        .fill(color)
        .frame(width: 6, height: 6)
      Text(status.title)
    }
    .font(.caption.weight(.medium))
    .foregroundStyle(color)
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(color.opacity(0.1), in: Capsule())
  }

  /// 状态 → 语义色映射（草稿灰、录音绿、整理琥珀、完成主色）。
  private var color: Color {
    switch status {
    case .draft: .secondary
    case .recording: MeetingTheme.success
    case .processing: MeetingTheme.warning
    case .completed: MeetingTheme.primary
    }
  }
}
