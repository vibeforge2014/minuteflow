/**
 * Markdown → 安全 HTML 的共享渲染管线（与个人笔记一致）：
 * marked（GFM）解析后经 DOMPurify 白名单净化，禁止 style/iframe/object/embed。
 * AI 问答气泡与笔记编辑器共用，保证两处渲染行为一致。
 */
import DOMPurify from "dompurify";
import { marked } from "marked";

export function markdownToHtml(markdown: string) {
  const rendered = marked.parse(markdown || "", { async: false, gfm: true });
  return DOMPurify.sanitize(String(rendered), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "iframe", "object", "embed"]
  }) || "<p></p>";
}
