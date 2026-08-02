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
