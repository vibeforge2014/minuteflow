import Foundation
import Observation

@MainActor
@Observable
final class AppState {
  enum PhoneTab: Hashable {
    case meetings
    case actions
    case settings
  }

  enum InspectorTab: String, CaseIterable, Identifiable {
    case transcript = "转录"
    case summary = "AI 纪要"

    var id: String { rawValue }
  }

  enum AppSheet: Identifiable {
    case newMeeting
    case settings
    case importAudio

    var id: String {
      switch self {
      case .newMeeting: "newMeeting"
      case .settings: "settings"
      case .importAudio: "importAudio"
      }
    }
  }

  var selectedMeetingID: UUID?
  var selectedPhoneTab: PhoneTab = .meetings
  var inspectorTab: InspectorTab = .transcript
  var presentedSheet: AppSheet?
  var searchText = ""
  var toastMessage: String?
}
