import SwiftUI
import UIKit

enum MeetingTheme {
  // TuneSync-inspired palette: warm coral actions on quiet, system-native surfaces.
  static let primary = Color(red: 0.906, green: 0.435, blue: 0.318)
  static let primarySoft = primary.opacity(0.12)
  static let canvas = Color(uiColor: .systemGroupedBackground)
  static let surface = Color(uiColor: .secondarySystemGroupedBackground)
  static let surfaceRaised = Color(uiColor: .tertiarySystemGroupedBackground)
  static let sidebar = Color(uiColor: .secondarySystemGroupedBackground)
  static let divider = Color(uiColor: .separator).opacity(0.32)
  static let success = Color(red: 0.20, green: 0.58, blue: 0.36)
  static let warning = Color(red: 0.86, green: 0.49, blue: 0.14)
  static let info = Color(red: 0.25, green: 0.52, blue: 0.82)
  static let speakerViolet = Color(red: 0.52, green: 0.36, blue: 0.78)
}

struct DocumentCard<Content: View>: View {
  let title: String
  let systemImage: String
  @ViewBuilder let content: Content

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
      Label(title, systemImage: systemImage)
        .font(.headline)
        .foregroundStyle(.primary)
      content
    }
    .padding(18)
    .background(MeetingTheme.surface)
    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(MeetingTheme.divider)
    }
  }
}

struct StatusPill: View {
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

  private var color: Color {
    switch status {
    case .draft: .secondary
    case .recording: MeetingTheme.success
    case .processing: MeetingTheme.warning
    case .completed: MeetingTheme.primary
    }
  }
}
