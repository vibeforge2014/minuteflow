// MinuteFlow 官网下载 Worker：zensoft.top/minuteflow/dl/* 与 /minuteflow/releases/*
// 直接从 R2 读取，安装包流量不再落到源站。
//
// 关键约束：已发布桌面客户端的更新白名单是精确 hostname（zensoft.top），
// 因此资产 URL 必须保持 zensoft.top/minuteflow/dl/<tag>/<file> 不变，
// 只能通过 Worker 路由在边缘改写数据源，绝不能换 r2.dev / dl.zensoft.top 域名。
// 清单走 /minuteflow/releases/* 且缩短边缘缓存，发版后立即可见。

const CONTENT_TYPES = {
  dmg: "application/x-apple-diskimage",
  exe: "application/vnd.microsoft.portable-executable",
  json: "application/json; charset=utf-8",
  onnx: "application/octet-stream",
  bin: "application/octet-stream",
  gguf: "application/octet-stream",
  pt: "application/octet-stream",
  txt: "text/plain; charset=utf-8",
  sha256: "text/plain; charset=utf-8",
};

function contentTypeFor(key) {
  const dot = key.lastIndexOf(".");
  const ext = dot >= 0 ? key.slice(dot + 1).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// /minuteflow/dl/<key> → <key>；/minuteflow/releases/<name> → releases/<name>。
function objectKeyFor(pathname) {
  if (pathname.startsWith("/minuteflow/dl/")) {
    return pathname.slice("/minuteflow/dl/".length);
  }
  if (pathname.startsWith("/minuteflow/releases/")) {
    return pathname.slice("/minuteflow/".length);
  }
  return null;
}

function notFound() {
  return new Response("Not Found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = objectKeyFor(url.pathname);
    if (!key || key.endsWith("/") || key.includes("..")) {
      return notFound();
    }
    // 清单是每次发版的入口，缩短边缘缓存让更新检查尽快看到新版本；
    // 安装包/模型内容寻址（带 sha256 校验），可以缓存更久。
    const cacheControl = key.startsWith("releases/")
      ? "public, max-age=60"
      : "public, max-age=3600";

    if (request.method === "HEAD") {
      const head = await env.BUCKET.head(key);
      if (!head) return notFound();
      return new Response(null, {
        status: 200,
        headers: {
          "content-type": contentTypeFor(key),
          "content-length": String(head.size),
          etag: head.etag,
          "accept-ranges": "bytes",
          "cache-control": cacheControl,
        },
      });
    }
    if (request.method !== "GET") {
      return new Response("Method Not Allowed\n", { status: 405 });
    }

    const range = request.headers.get("range");
    let object;
    try {
      object = await env.BUCKET.get(key, range ? { range: request.headers } : undefined);
    } catch {
      return new Response("Range Not Satisfiable\n", {
        status: 416,
        headers: { "content-range": `bytes */` },
      });
    }
    if (!object) return notFound();

    const headers = {
      "content-type": contentTypeFor(key),
      etag: object.etag,
      "accept-ranges": "bytes",
      "cache-control": cacheControl,
    };
    if (range) {
      // R2 的 range 字段是 {offset, length}；content-length 交给运行时按响应体计算。
      if (object.range) {
        const end = object.range.offset + object.range.length - 1;
        headers["content-range"] = `bytes ${object.range.offset}-${end}/${object.size}`;
      }
      return new Response(object.body, { status: 206, headers });
    }
    return new Response(object.body, { status: 200, headers });
  },
};
