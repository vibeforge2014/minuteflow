import SwiftUI

enum MeetingTheme {
  static let blue = Color(red: 0.08, green: 0.31, blue: 0.92)
  static let paleBlue = Color(red: 0.93, green: 0.95, blue: 1)
  static let canvas = Color(red: 0.97, green: 0.97, blue: 0.96)
  static let sidebar = Color(red: 0.965, green: 0.968, blue: 0.975)
  static let divider = Color.black.opacity(0.08)
  static let success = Color(red: 0.17, green: 0.57, blue: 0.31)
  static let warning = Color(red: 0.92, green: 0.47, blue: 0.12)
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
    .background(.background)
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 14, style: .continuous)
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
    case .completed: MeetingTheme.blue
    }
  }
}
