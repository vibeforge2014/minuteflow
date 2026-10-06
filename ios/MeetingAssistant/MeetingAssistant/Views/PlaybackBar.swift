//
//  PlaybackBar.swift
//  MeetingAssistant
//
//  回放条视图：置于会议文档上方——收起时是一枚紧凑「回放」操作，点按展开
//  完整时间轴（播放/暂停、进度滑杆、倍速循环与收起）。只有存在已验证的
//  本机音频资产才渲染；文件缺失不留空播放器，播放失败给出明确错误。
//  所属层：视图层（MeetingDocumentView 头部下方挂载）。
//

import SwiftUI

/// 回放条：紧凑态 + 展开时间轴两段式。
struct PlaybackBar: View {
  /// 回放播放器（进度/时长/倍速/错误）。
  @Environment(MeetingPlayer.self) private var player
  /// 录音协调器（录音中的会议禁用回放，避免会话冲突）。
  @Environment(RecordingCoordinator.self) private var recorder
  /// 所属会议。
  let meeting: MeetingRecord
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// 是否展开完整时间轴。
  @State private var isExpanded = false

  var body: some View {
    // 前置条件：挂载了本会议音频，且该会议不在录音中。
    let recordingThisMeeting =
      recorder.isRecording && recorder.activeMeetingID == meeting.id
    if player.attachedMeetingID == meeting.id, player.hasAudio,
      !recordingThisMeeting
    {
      VStack(spacing: 0) {
        if isExpanded {
          expandedTimeline
            .transition(
              reduceMotion ? .opacity : .modifier(
                active: PlaybackExpandModifier(progress: 0),
                identity: PlaybackExpandModifier(progress: 1)
              )
            )
        } else {
          compactAction
        }
      }
      .frame(maxWidth: .infinity)
      .animation(
        reduceMotion ? ContentMotion.quick : ContentMotion.view,
        value: isExpanded
      )
      .alert(
        "无法回放",
        isPresented: Binding(
          get: { player.errorMessage != nil },
          set: { if !$0 { player.errorMessage = nil } }
        )
      ) {
        Button("好") { player.errorMessage = nil }
      } message: {
        Text(player.errorMessage ?? "")
      }
    }
  }

  // MARK: - 紧凑态

  /// 紧凑「回放」操作行：一枚按钮 + 音频时长，点按展开时间轴。
  private var compactAction: some View {
    Button {
      withAnimation(
        reduceMotion ? ContentMotion.quick : ContentMotion.view
      ) {
        isExpanded = true
      }
    } label: {
      HStack(spacing: 8) {
        Image(systemName: "play.circle.fill")
          .font(.title3)
          .foregroundStyle(MeetingTheme.primary)
        Text("回放")
          .font(.subheadline.weight(.medium))
          .foregroundStyle(.primary)
        if player.duration > 0 {
          Text(MeetingFormatters.timestamp(player.duration))
            .font(.caption.monospacedDigit())
            .foregroundStyle(.tertiary)
        }
        Spacer()
        Image(systemName: "chevron.down")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.tertiary)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .background(MeetingTheme.surface)
      .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      .shadow(color: .black.opacity(0.04), radius: 10, x: 0, y: 2)
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 20)
    .padding(.top, 10)
    .accessibilityLabel("展开回放时间轴")
  }

  // MARK: - 展开态

  /// 完整时间轴：播放/暂停、当前/总时长、进度滑杆、倍速与收起。
  private var expandedTimeline: some View {
    VStack(spacing: 8) {
      HStack(spacing: 14) {
        Button {
          player.togglePlayPause()
        } label: {
          Image(
            systemName: player.isPlaying ? "pause.circle.fill" : "play.circle.fill"
          )
          .font(.system(size: 34))
          .foregroundStyle(MeetingTheme.primary)
          .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(player.isPlaying ? "暂停" : "播放")

        VStack(spacing: 2) {
          Slider(
            value: Binding(
              get: { player.duration > 0 ? player.currentTime : 0 },
              set: { player.seek(to: $0) }
            ),
            in: 0...max(player.duration, 0.1)
          )
          .disabled(player.duration <= 0)
          HStack {
            Text(MeetingFormatters.timestamp(player.currentTime))
            Spacer()
            Text(MeetingFormatters.timestamp(max(player.duration, 0)))
          }
          .font(.caption2.monospacedDigit())
          .foregroundStyle(.tertiary)
        }

        Button {
          player.cycleRate()
        } label: {
          Text(String(format: "%.2g×", player.rate))
            .font(.caption.weight(.semibold).monospacedDigit())
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(MeetingTheme.primarySoft, in: Capsule())
            .foregroundStyle(MeetingTheme.primary)
            .contentTransition(.numericText())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("播放倍速，当前 \(String(format: "%.2g", player.rate)) 倍")

        Button {
          player.pause()
          withAnimation(
            reduceMotion ? ContentMotion.quick : ContentMotion.view
          ) {
            isExpanded = false
          }
        } label: {
          Image(systemName: "chevron.up")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.tertiary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("收起回放")
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .background(MeetingTheme.surface)
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    .shadow(color: .black.opacity(0.04), radius: 10, x: 0, y: 2)
    .padding(.horizontal, 20)
    .padding(.top, 10)
  }
}

/// 展开动效：从轻微下压+透明渐进（同一对象的空间连续，而非弹现）。
private struct PlaybackExpandModifier: ViewModifier {
  let progress: Double

  func body(content: Content) -> some View {
    content.opacity(progress).offset(y: (1 - progress) * -4)
  }
}
