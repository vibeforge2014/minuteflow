#!/usr/bin/env node
/**
 * Sites 交付准备脚本（npm run build 的收尾步骤）：
 * 校验并把 worker/index.js 与 .openai/hosting.json 复制进 dist，
 * 使产物满足 Sites 托管要求——dist/client/index.html、dist/server/index.js、dist/.openai/hosting.json。
 * 额外把 index.html 复制为 404.html，弥补 GitHub Pages 无 SPA 回退的问题。
 * 注意：本脚本与 worker/index.js、tests/sites-worker.test.mjs 须保持功能不变。
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const index = path.join(dist, "client", "index.html");
const worker = path.join(root, "worker", "index.js");
const hosting = path.join(root, ".openai", "hosting.json");

for (const file of [index, worker, hosting]) {
  if (!existsSync(file)) throw new Error("Missing Sites build input: " + file);
}

mkdirSync(path.join(dist, "server"), { recursive: true });
mkdirSync(path.join(dist, ".openai"), { recursive: true });
copyFileSync(worker, path.join(dist, "server", "index.js"));
copyFileSync(hosting, path.join(dist, ".openai", "hosting.json"));

// GitHub Pages has no SPA fallback (unlike the Sites worker). Copy the built
// index.html to 404.html so client-side routes such as /pricing/ and /terms/
// resolve: Pages serves 404.html for unknown paths, the SPA boots, and
// route detection renders the right page from window.location.
copyFileSync(index, path.join(dist, "client", "404.html"));

console.log("Prepared Sites build: dist/server/index.js and dist/.openai/hosting.json");
