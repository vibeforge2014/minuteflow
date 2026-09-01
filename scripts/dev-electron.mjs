/**
 * MinuteFlow desktop development runner.
 *
 * Vite owns renderer HMR, while this runner watches the Electron main-process
 * boundary and restarts the app when main/preload/service files change. Keeping
 * the two paths separate lets React preserve state during UI edits and ensures
 * privileged code is always reloaded from a fresh Electron process.
 */
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const developmentServerUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
const require = createRequire(import.meta.url);
const viteCli = path.join(projectDirectory, "node_modules", "vite", "bin", "vite.js");
// Requiring Electron from plain Node returns the platform-native executable
// path, avoiding .cmd wrapper differences between Windows and macOS.
const electronExecutable = require("electron");
const electronDirectory = path.join(projectDirectory, "electron");
const watchedExtensions = new Set([".js", ".cjs", ".mjs", ".json"]);

let viteProcess;
let electronProcess;
let fileWatcher;
let restartTimer;
let restartQueue = Promise.resolve();
let shuttingDown = false;
let restartingElectron = false;

function log(message) {
  process.stdout.write(`[MinuteFlow dev] ${message}\n`);
}

function run(executable, arguments_, environment = process.env) {
  return spawn(executable, arguments_, {
    cwd: projectDirectory,
    env: environment,
    stdio: "inherit",
    windowsHide: false
  });
}

function waitForExit(child, timeoutMs = 3_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function waitForDevelopmentServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!shuttingDown && Date.now() < deadline) {
    try {
      const response = await fetch(developmentServerUrl, {
        signal: AbortSignal.timeout(1_000)
      });
      if (response.ok) return;
    } catch {
      // Vite is still starting. Retry until the bounded deadline below.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`开发服务器未能在 ${Math.round(timeoutMs / 1_000)} 秒内启动。`);
}

function startElectron() {
  if (shuttingDown) return;
  log("启动 Electron；修改 src/ 会热替换，修改 electron/ 会自动重启应用。");
  const child = run(electronExecutable, [projectDirectory], {
    ...process.env,
    VITE_DEV_SERVER_URL: developmentServerUrl
  });
  electronProcess = child;
  child.once("exit", (code, signal) => {
    if (electronProcess !== child || restartingElectron || shuttingDown) return;
    log(`Electron 已退出${signal ? `（${signal}）` : `（代码 ${code ?? 0}）`}。`);
    void shutdown(code ?? 0);
  });
}

function requestElectronRestart(fileName) {
  if (shuttingDown || !fileName || !watchedExtensions.has(path.extname(fileName))) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartQueue = restartQueue.then(async () => {
      if (shuttingDown) return;
      restartingElectron = true;
      log(`${fileName} 已变更，正在重启 Electron…`);
      const previousProcess = electronProcess;
      electronProcess = undefined;
      await waitForExit(previousProcess);
      restartingElectron = false;
      startElectron();
    }).catch((error) => {
      restartingElectron = false;
      console.error("[MinuteFlow dev] Electron 热重启失败：", error);
      void shutdown(1);
    });
  }, 180);
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(restartTimer);
  fileWatcher?.close();
  const currentElectron = electronProcess;
  electronProcess = undefined;
  await Promise.all([waitForExit(currentElectron), waitForExit(viteProcess)]);
  process.exit(exitCode);
}

async function main() {
  log(`启动 Vite：${developmentServerUrl}`);
  const serverUrl = new URL(developmentServerUrl);
  viteProcess = run(process.execPath, [viteCli, "--host", serverUrl.hostname, "--port", serverUrl.port || "5173", "--strictPort"]);
  viteProcess.once("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[MinuteFlow dev] Vite 意外退出（代码 ${code ?? 0}）。`);
      void shutdown(code || 1);
    }
  });

  await waitForDevelopmentServer();
  startElectron();
  fileWatcher = watch(electronDirectory, { recursive: true }, (_eventType, fileName) => {
    requestElectronRestart(fileName);
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { void shutdown(0); });
}

main().catch((error) => {
  console.error("[MinuteFlow dev] 启动失败：", error);
  void shutdown(1);
});
