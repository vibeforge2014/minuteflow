/** 本地音频协议使用的纯工具：解析 HTTP Range，并按扩展名返回浏览器可识别的 MIME。 */
export function parseByteRange(header, size) {
  if (!header) return null;
  const match = String(header).match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || size <= 0) return undefined;
  let start;
  let end;
  if (!match[1] && match[2]) {
    const suffix = Math.min(size, Number(match[2]));
    start = size - suffix;
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) return undefined;
  return { start, end: Math.min(end, size - 1) };
}

export function audioContentType(filePath) {
  const extension = String(filePath).toLowerCase().split(".").pop();
  return ({
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    wav: "audio/wav",
    flac: "audio/flac",
    ogg: "audio/ogg",
    webm: "audio/webm"
  })[extension] || "application/octet-stream";
}
