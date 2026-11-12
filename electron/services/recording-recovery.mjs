/**
 * 异常退出后的录音恢复。
 *
 * 录音以 `<sessionId>-<track>.partial` 落盘，正常 stop 才改名为最终文件并登记
 * 音频资产。崩溃时 recordings:stop 永远不会被调用：会议被标记 interrupted，
 * .partial 只留作诊断，用户拿不回刚录的内容。启动时这里：
 *   1. 从 audio_chunks 找出仍指向 .partial 的会话（不扫描无账目的垃圾文件）；
 *   2. 用 FFmpeg remux 补上缺失的 WebM/Matroska 索引，失败则原样改名保住字节；
 *   3. 改写块账目路径并登记 audio_assets，让会议里直接可以回放。
 *
 * 任何一步失败都保留 .partial 原文件，绝不删除用户录音。
 */
import { execFile } from "node:child_process";
import { open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 文件名格式：<uuid>-<microphone|system>.partial。 */
export function parsePartialFileName(name) {
  const match = /^([0-9a-f-]{36})-(microphone|system)\.partial$/i.exec(String(name ?? ""));
  return match ? { sessionId: match[1], track: match[2].toLowerCase() } : null;
}

/** 按文件头判断容器；无法识别时按 WebM 处理（MediaRecorder 默认输出）。 */
export function detectAudioExtension(header) {
  const bytes = Buffer.from(header ?? []);
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return ".webm";
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return ".m4a";
  return ".webm";
}

/** 把待恢复条目按现状分类，纯函数便于单测。 */
export function classifyPendingEntries(entries, stats) {
  return entries.map((entry) => {
    const parsed = parsePartialFileName(path.basename(entry.path ?? ""));
    const size = Number(stats.get(entry.path)?.size ?? 0);
    if (!parsed || !entry.path?.endsWith(".partial")) return { ...entry, action: "skip", reason: "文件名不符合录音块格式" };
    if (!size) return { ...entry, ...parsed, action: "skip", reason: "空文件或文件已不存在" };
    return { ...entry, ...parsed, action: "recover", size };
  });
}

async function inspectHeader(filePath) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, 12, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const defaultDependencies = {
  listPending: async () => [],
  statFile: (filePath) => stat(filePath).catch(() => null),
  readHeader: inspectHeader,
  renameFile: rename,
  removeFile: (filePath) => unlink(filePath).catch(() => {}),
  runFfmpeg: async (args) => {
    await execFileAsync(args[0], args.slice(1), { timeout: 30_000, maxBuffer: 1024 * 1024 });
  },
  finalizeAudioPath: () => {},
  saveAudioAsset: () => {},
  loadMeeting: () => null,
  notify: () => {},
  log: console
};

/**
 * @returns {Promise<{recovered:number, skipped:number, failed:number, details:string[]}>}
 */
export async function recoverInterruptedRecordings(overrides = {}) {
  const deps = { ...defaultDependencies, ...overrides };
  const result = { recovered: 0, skipped: 0, failed: 0, details: [] };
  let pending;
  try {
    pending = await deps.listPending();
  } catch (error) {
    result.failed += 1;
    result.details.push(`读取待恢复录音失败：${error instanceof Error ? error.message : error}`);
    return result;
  }
  if (!pending?.length) return result;

  const stats = new Map();
  for (const entry of pending) stats.set(entry.path, await deps.statFile(entry.path));
  const classified = classifyPendingEntries(pending, stats);

  for (const entry of classified) {
    if (entry.action === "skip") {
      result.skipped += 1;
      result.details.push(`跳过 ${path.basename(entry.path)}：${entry.reason}`);
      continue;
    }
    const meeting = await deps.loadMeeting(entry.meetingId);
    if (!meeting) {
      result.skipped += 1;
      result.details.push(`跳过 ${path.basename(entry.path)}：所属会议不存在或已删除`);
      continue;
    }
    const source = entry.path;
    const extension = detectAudioExtension(await deps.readHeader(source).catch(() => Buffer.alloc(0)));
    const target = source.replace(/\.partial$/, extension);
    const temporary = `${target}.recover.tmp`;
    let size = entry.size;
    try {
      const existingTarget = await deps.statFile(target);
      if (existingTarget?.size) {
        // 上次崩溃发生在改名之后、落库之前：直接沿用已有最终文件。
        await deps.removeFile(source);
      } else {
        let remuxed = false;
        try {
          // ffmpegPath 允许传异步函数，只有真正需要 remux 时才解析（可能触发首次安装）。
          const executable = typeof deps.ffmpegPath === "function"
            ? await deps.ffmpegPath()
            : (deps.ffmpegPath || "ffmpeg");
          await deps.runFfmpeg([
            executable, "-y", "-fflags", "+genpts",
            "-i", source, "-c", "copy", temporary
          ]);
          const remuxedStat = await deps.statFile(temporary);
          remuxed = Boolean(remuxedStat?.size);
        } catch {
          // 未 finalize 的 WebM 有时 ffmpeg 也修不了：保留原始字节仍比丢弃好。
          await deps.removeFile(temporary);
        }
        if (remuxed) {
          await deps.renameFile(temporary, target);
          await deps.removeFile(source);
          size = (await deps.statFile(target))?.size ?? size;
        } else {
          await deps.renameFile(source, target);
        }
      }
      await deps.finalizeAudioPath(entry.sessionId, entry.track, target);
      await deps.saveAudioAsset({
        id: `${entry.sessionId}:${entry.track}`,
        meetingId: entry.meetingId,
        path: target,
        playbackPath: target,
        track: entry.track,
        sourceType: "recording",
        originalName: entry.track === "microphone" ? "现场麦克风录音（崩溃恢复）" : "系统声音录音（崩溃恢复）",
        mimeType: extension === ".m4a" ? "audio/mp4" : "audio/webm",
        byteLength: size
      });
      result.recovered += 1;
      result.details.push(`已恢复 ${path.basename(target)}（${size} 字节）`);
    } catch (error) {
      result.failed += 1;
      result.details.push(`恢复 ${path.basename(source)} 失败，原文件已保留：${error instanceof Error ? error.message : error}`);
    }
  }

  if (result.recovered) {
    try {
      await deps.notify(result.recovered);
    } catch {
      // 通知失败不影响已落库的恢复结果。
    }
  }
  for (const line of result.details) deps.log?.log?.(`[recording-recovery] ${line}`);
  return result;
}
