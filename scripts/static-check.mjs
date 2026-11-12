#!/usr/bin/env node
/**
 * 主进程静态一致性检查（npm run check:main）：
 *
 * 1. tsc -p tsconfig.electron.json：解析 electron/ 与 scripts/ 下所有 .mjs/.cjs
 *    的模块依赖，抓出「新增模块忘记提交 / 相对路径写错」这类只在干净 checkout
 *    才暴露的构建失败。checkJs 关闭：主进程是动态 JS，全量类型推断会产生大量噪声。
 * 2. IPC 通道对账：preload.cjs 暴露给渲染层的 invoke/send 通道必须在主进程注册；
 *    主进程主动推送的事件通道应在 preload 有订阅（仅警告，允许有意不订阅）。
 * 3. package.json scripts 与 CI workflow 里 npm run 的脚本名必须存在。
 *
 * 任何硬性不一致都以非 0 退出，便于 CI 门禁。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const failures = [];
const warnings = [];

// ---- 1. 主进程模块解析 ----
try {
  execFileSync(process.execPath, [
    path.join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p", path.join(root, "tsconfig.electron.json")
  ], { cwd: root, stdio: "pipe" });
  console.log("[check:main] 模块解析检查通过");
} catch (error) {
  const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
  failures.push(`主进程模块解析失败：\n${output}`);
}

// ---- 2. IPC 通道对账 ----
const preload = read("electron/preload.cjs");
const mainFiles = ["electron/main.mjs", ...readdirSync(path.join(root, "electron", "services"))
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => `electron/services/${name}`)];
const mainSource = mainFiles.map(read).join("\n");

const collect = (source, pattern) => {
  const found = new Set();
  for (const match of source.matchAll(pattern)) found.add(match[1]);
  return found;
};

const invoked = collect(preload, /\binvoke\(\s*["']([\w:.-]+)["']/g);
const sentFromRenderer = collect(preload, /ipcRenderer\.send\(\s*["']([\w:.-]+)["']/g);
const listenedInRenderer = collect(preload, /ipcRenderer\.on\(\s*["']([\w:.-]+)["']/g);
const handled = new Set([
  ...collect(mainSource, /\btrustedHandle\(\s*["']([\w:.-]+)["']/g),
  ...collect(mainSource, /ipcMain\.handle\(\s*["']([\w:.-]+)["']/g)
]);
const listenedInMain = collect(mainSource, /ipcMain\.on(?:ce)?\(\s*["']([\w:.-]+)["']/g);
// 也支持 `const channel = "app:flush"; ipcMain.on(channel, ...)` 这类间接注册。
for (const match of mainSource.matchAll(/ipcMain\.on(?:ce)?\(\s*([A-Za-z_$][\w$]*)\s*,/g)) {
  const variable = match[1];
  const declaration = mainSource.match(
    new RegExp(`\\b(?:const|let|var)\\s+${variable}\\s*=\\s*["']([\\w:.-]+)["']`)
  );
  if (declaration) listenedInMain.add(declaration[1]);
}
const pushedToRenderer = collect(mainSource, /\.send\(\s*["']([\w:.-]+:[\w:.-]+)["']/g);

for (const channel of invoked) {
  if (!handled.has(channel)) failures.push(`preload invoke("${channel}") 在主进程没有对应 handler`);
}
for (const channel of sentFromRenderer) {
  if (!listenedInMain.has(channel) && !handled.has(channel)) {
    failures.push(`preload send("${channel}") 在主进程没有对应 ipcMain.on / handler`);
  }
}
for (const channel of pushedToRenderer) {
  if (!listenedInRenderer.has(channel)) warnings.push(`主进程推送 "${channel}"，preload 未订阅（确认是否有意）`);
}
console.log(`[check:main] IPC 对账：${invoked.size} invoke / ${sentFromRenderer.size} send / ${handled.size} handler / ${listenedInMain.size} on`);

// ---- 3. 脚本引用一致性 ----
const pkg = JSON.parse(read("package.json"));
const scripts = Object.keys(pkg.scripts ?? {});
const workflowDir = path.join(root, ".github", "workflows");
const workflowSources = readdirSync(workflowDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => readFileSync(path.join(workflowDir, name), "utf8"))
  .join("\n");
const referenced = new Set();
for (const match of workflowSources.matchAll(/npm\s+run\s+([\w:.-]+)/g)) referenced.add(match[1]);
for (const match of Object.values(pkg.scripts).join("\n").matchAll(/npm\s+run\s+([\w:.-]+)/g)) referenced.add(match[1]);
for (const name of referenced) {
  if (!scripts.includes(name)) failures.push(`脚本 "${name}" 被引用但 package.json 未定义`);
}
console.log(`[check:main] 脚本引用检查：${referenced.size} 处引用 / ${scripts.length} 个脚本`);

for (const warning of warnings) console.warn(`[check:main] 提示：${warning}`);
if (failures.length) {
  for (const failure of failures) console.error(`[check:main] 错误：${failure}`);
  console.error(`[check:main] 失败：${failures.length} 项不一致`);
  process.exit(1);
}
console.log("[check:main] 全部通过");
