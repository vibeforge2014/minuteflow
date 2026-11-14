/** 导出范围：all=纪要+转写，summary=只导出纪要，transcript=只导出逐字稿。 */
export type ExportScope = "all" | "summary" | "transcript";

export interface FormatOptions {
  scope?: ExportScope;
  includeTimestamps?: boolean;
  includeSpeakers?: boolean;
}

export function formatTime(ms: number): string;
export function scopeLabel(scope?: string): string;
export function exportNameSuffix(scope?: string): string;
export function markdown(meeting: object, options?: FormatOptions): string;
export function subtitle(meeting: object, type: "srt" | "vtt", options?: { includeSpeakers?: boolean }): string;
