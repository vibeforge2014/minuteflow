/**
 * Sites 托管 Worker（Cloudflare Workers 风格）：为静态资源层补上 SPA 能力。
 * 职责：1) 对 HTML 响应做 __SITE_ORIGIN__ 占位符注入（把构建时的占位符替换为实际请求源）；
 * 2) 未命中资源且浏览器期望 HTML 时回退到 /index.html（SPA 路由兜底，支持 /pricing/ 等深链）。
 * 注意：本文件须保持功能不变，同一份本地原型直接交给 Sites 托管（见 AGENTS.md）。
 */

/** 把 HTML 响应里的 __SITE_ORIGIN__ 占位符替换为当前请求源；非 GET 或非 HTML 原样返回。 */
async function injectRequestOrigin(response, request) {
  if (
    request.method !== "GET" ||
    !response.headers.get("content-type")?.includes("text/html")
  ) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");

  return new Response(
    (await response.text()).replaceAll(
      "__SITE_ORIGIN__",
      new URL(request.url).origin,
    ),
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
}

export default {
  /** Worker 入口：先取静态资源；404 且接受 HTML 时改写为 /index.html 再取一次（SPA fallback）。 */
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");

    if (response.status !== 404 || !acceptsHtml || !["GET", "HEAD"].includes(request.method)) {
      return injectRequestOrigin(response, request);
    }

    const indexUrl = new URL(request.url);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    return injectRequestOrigin(
      await env.ASSETS.fetch(new Request(indexUrl, request)),
      request,
    );
  },
};
