// Shared time/duration formatters for the desktop renderer.
// Kept deliberately small to replace the previous per-component duplicates.
// 中文补充：桌面渲染层共享的时间/时长格式化工具（保持精简，替代此前各组件里的重复实现）。
//
// 所属层：渲染层纯工具函数。
// 主要导出：formatDuration、formatInterval。

/**
 * Format a duration in seconds as `MM:SS`, or `HH:MM:SS` once it reaches an
 * hour. Used for recording elapsed time, transcript offsets, meeting durations,
 * and note timestamps.
 * 中文补充：把秒格式化为 MM:SS，满一小时后自动切换为 HH:MM:SS；
 * 用于录音计时、转录时间偏移、会议时长与笔记时间戳。
 */
export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(remaining)}`
    : `${pad(minutes)}:${pad(remaining)}`;
}

/**
 * Human-friendly interval label for summary cadence preferences, e.g.
 * "每 5 分钟" / "每 45 秒".
 * 中文补充：纪要生成间隔的人性化文案（整分钟显示“N 分钟”，否则显示“N 秒”）。
 */
export function formatInterval(seconds: number) {
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
}
