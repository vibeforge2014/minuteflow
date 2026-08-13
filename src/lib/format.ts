// Shared time/duration formatters for the desktop renderer.
// Kept deliberately small to replace the previous per-component duplicates.

/**
 * Format a duration in seconds as `MM:SS`, or `HH:MM:SS` once it reaches an
 * hour. Used for recording elapsed time, transcript offsets, meeting durations,
 * and note timestamps.
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
 */
export function formatInterval(seconds: number) {
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
}
