//
//  MeetingPlayer.swift
//  MeetingAssistant
//
//  会议回放播放器：基于 AVPlayer 回放已录音/已导入的本机音频，提供播放控制、
//  会话内倍速循环、进度跳转与“当前转录片段”定位，供文档页回放条与转录面板
//  的歌词式同步高亮共用。
//  所属层：服务层（@Observable 环境对象，全局单会话）。
//

import AVFoundation
import Foundation
import Observation

// MARK: - 回放错误

/// 回放启动失败的具体原因。
enum MeetingPlayerError: LocalizedError {
  case missingAudio
  case cannotStartPlayback(String)

  var errorDescription: String? {
    switch self {
    case .missingAudio:
      "找不到本机音频文件，无法回放。"
    case .cannotStartPlayback(let reason):
      "回放失败：\(reason)"
    }
  }
}

// MARK: - 回放播放器

/// 会议音频回放协调器：同一时刻只挂载一场会议的音频。
///
/// 设计约束（与桌面端回放决策对齐）：
/// - 只有存在已验证的本机音频资产才可用；文件缺失/不可读时不留空播放器。
/// - 倍速在 1.0 → 1.5 → 2.0 → 0.75 间循环，本次启动会话内记忆。
/// - 转录时间戳可跳转播放器；当前播放时间对应的片段高亮如同步歌词。
@MainActor
@Observable
final class MeetingPlayer {
  // MARK: - 会话级倍速记忆

  /// 倍速循环档位（与桌面端一致）。
  private static let rateLadder: [Float] = [1.0, 1.5, 2.0, 0.75]
  /// 本次启动会话记住的倍速下标（跨会议共享，不持久化）。
  private static var sessionRateIndex = 0

  // MARK: - 私有属性

  /// 底层播放器。
  private let player = AVPlayer()
  /// 周期性时间观察者句柄（deinit/换曲时移除）。
  private var timeObserver: Any?
  /// 播放结束通知观察者。
  private var endObserver: NSObjectProtocol?

  // MARK: - 状态属性（供视图观察）

  /// 已挂载音频的会议 ID；nil 表示当前无音频可回放。
  private(set) var attachedMeetingID: UUID?
  /// 音频总时长（秒）；未知时为 0。
  private(set) var duration: TimeInterval = 0
  /// 当前播放位置（秒）。
  private(set) var currentTime: TimeInterval = 0
  /// 是否正在播放。
  private(set) var isPlaying = false
  /// 当前播放时间命中的转录片段 ID（同步高亮用）。
  private(set) var currentSegmentID: UUID?
  /// 面向用户的回放错误文案。
  var errorMessage: String?

  /// 当前倍速（会话内记忆）。
  var rate: Float {
    Self.rateLadder[Self.sessionRateIndex]
  }

  // MARK: - 初始化

  /// 配置播放器并挂接时间/结束观察者。
  init() {
    timeObserver = player.addPeriodicTimeObserver(
      forInterval: CMTime(seconds: 0.25, preferredTimescale: 600),
      queue: .main
    ) { [weak self] time in
      Task { @MainActor in
        guard let self else { return }
        self.currentTime = max(0, time.seconds)
        // 播到末尾自动复位（AVPlayer 默认停在末帧，isPlaying 需手动收口）。
        if self.duration > 0, self.currentTime >= self.duration - 0.05 {
          self.pause()
          self.currentTime = self.duration
        }
      }
    }
    endObserver = NotificationCenter.default.addObserver(
      forName: AVPlayerItem.didPlayToEndTimeNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor in
        self?.pause()
      }
    }
  }

  // 不实现 deinit 清理：本对象随 App 生命周期常驻（@State 注入环境），
  // @MainActor 属性无法从非隔离 deinit 访问，且进程退出时无需摘除观察者。

  // MARK: - 挂载与卸载

  /// 为一场会议挂载音频：定位本机音频文件、替换播放条目并读取时长。
  ///
  /// - Parameter meeting: 目标会议。
  /// - 副作用：替换 AVPlayer 条目；无有效音频时清空挂载状态并停止播放。
  func attach(meeting: MeetingRecord) {
    guard attachedMeetingID != meeting.id else { return }
    pause()
    errorMessage = nil
    guard
      let filename = meeting.audioFilename,
      let url = Self.resolvableAudioURL(forFilename: filename)
    else {
      detach()
      return
    }
    let item = AVPlayerItem(url: url)
    player.replaceCurrentItem(with: item)
    attachedMeetingID = meeting.id
    currentTime = 0
    currentSegmentID = nil
    duration = 0
    Task { [weak self] in
      // 异步加载时长；失败时保持 0，滑杆退化为不可拖动。
      guard let seconds = try? await item.asset.load(.duration).seconds,
        !seconds.isNaN, seconds > 0
      else { return }
      self?.duration = seconds
    }
  }

  /// 卸载当前音频（切换会议或音频缺失时）。
  func detach() {
    pause()
    player.replaceCurrentItem(with: nil)
    attachedMeetingID = nil
    duration = 0
    currentTime = 0
    currentSegmentID = nil
  }

  /// 当前挂载的会议是否有可回放音频。
  var hasAudio: Bool {
    attachedMeetingID != nil && player.currentItem != nil
  }

  // MARK: - 播放控制

  /// 播放/暂停切换；播放前激活回放音频会话。
  func togglePlayPause() {
    if isPlaying {
      pause()
    } else {
      play()
    }
  }

  /// 开始播放。
  /// - 副作用：配置并激活 AVAudioSession（.playback）。
  func play() {
    guard hasAudio else {
      errorMessage = MeetingPlayerError.missingAudio.localizedDescription
      return
    }
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .default)
      try session.setActive(true, options: [.notifyOthersOnDeactivation])
    } catch {
      errorMessage = MeetingPlayerError.cannotStartPlayback(
        error.localizedDescription
      ).localizedDescription
      return
    }
    // 已播到末尾时从头再来。
    if duration > 0, currentTime >= duration - 0.05 {
      seek(to: 0)
    }
    player.rate = rate
    isPlaying = true
  }

  /// 暂停播放（保留进度；不强行停用会话，避免打断其他音频衔接）。
  func pause() {
    player.rate = 0
    player.pause()
    isPlaying = false
  }

  /// 跳转到指定时间（夹在 0…duration）。
  func seek(to time: TimeInterval) {
    let clamped = duration > 0 ? min(max(0, time), duration) : max(0, time)
    currentTime = clamped
    let target = CMTime(seconds: clamped, preferredTimescale: 600)
    player.seek(
      to: target,
      toleranceBefore: .zero,
      toleranceAfter: .zero
    ) { [weak self] _ in
      Task { @MainActor in
        // 跳转后若仍在播放，按当前倍速继续。
        if self?.isPlaying == true {
          self?.player.rate = self?.rate ?? 1
        }
      }
    }
  }

  /// 循环切换倍速（1.0 → 1.5 → 2.0 → 0.75），会话内记忆。
  func cycleRate() {
    Self.sessionRateIndex =
      (Self.sessionRateIndex + 1) % Self.rateLadder.count
    if isPlaying {
      player.rate = rate
    }
  }

  // MARK: - 转录同步

  /// 用当前播放时间更新同步高亮：命中片段优先取时间包含关系，回退为
  /// “最后一个起点不晚于当前时间的片段”（空隙/轻微越界仍能跟随）。
  ///
  /// - Parameter segments: 按起点升序的转录片段。
  /// - Returns: 命中的片段 ID。
  @discardableResult
  func updateSync(with segments: [TranscriptSegmentRecord]) -> UUID? {
    guard hasAudio, !segments.isEmpty else {
      currentSegmentID = nil
      return nil
    }
    let matched: TranscriptSegmentRecord?
    if let inside = segments.first(where: { segment in
      currentTime >= segment.startTime && currentTime < max(segment.endTime, segment.startTime + 0.001)
    }) {
      matched = inside
    } else {
      matched = segments.last { $0.startTime <= currentTime }
    }
    currentSegmentID = matched?.id
    return currentSegmentID
  }

  // MARK: - 音频定位

  /// 在 Recordings / Imports 两个沙盒目录中解析音频文件名。
  /// - Parameter filename: 会议记录保存的文件名。
  /// - Returns: 存在且可读的文件 URL。
  static func resolvableAudioURL(forFilename filename: String) -> URL? {
    let sanitized = filename.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !sanitized.isEmpty, !sanitized.contains("/") else { return nil }
    let root = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    )[0]
    for directory in ["Recordings", "Imports"] {
      let url = root
        .appendingPathComponent(directory, isDirectory: true)
        .appendingPathComponent(sanitized)
      if FileManager.default.isReadableFile(atPath: url.path) {
        return url
      }
    }
    return nil
  }
}
