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
let checkProcess;
let fileWatcher;
let restartTimer;
let restartQueue = Promise.resolve();
let sourceRevision = 0;
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

function checkElectronSources() {
  return new Promise((resolve, reject) => {
    const check = run(process.execPath, [path.join(projectDirectory, "scripts", "static-check.mjs")]);
    checkProcess = check;
    // 静态检查内部会跑 tsc：给它一个有界超时，卡住时也要能退出，
    // 否则 Ctrl+C 退出时会留下孤儿进程。
    const timeout = setTimeout(() => check.kill("SIGKILL"), 30_000);
    const settle = (value, error) => {
      clearTimeout(timeout);
      if (checkProcess === check) checkProcess = undefined;
      if (error) reject(error); else resolve(value);
    };
    check.once("error", (error) => settle(undefined, error));
    check.once("exit", (code) => settle(code === 0));
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
  // 调试端口（MF_CDP_PORT=9222 npm run dev:electron）：供 CDP 连接渲染进程做自动化诊断。
  const debugArgs = process.env.MF_CDP_PORT
    ? [`--remote-debugging-port=${process.env.MF_CDP_PORT}`]
    : [];
  const child = run(electronExecutable, [...debugArgs, projectDirectory], {
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
  const revision = ++sourceRevision;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartQueue = restartQueue.then(async () => {
      if (shuttingDown || revision !== sourceRevision) return;
      const valid = await checkElectronSources();
      if (shuttingDown || revision !== sourceRevision) return;
      if (!valid) {
        // 监听范围只有 electron/；若错误来自 scripts/ 或配置，需说明如何重试，
        // 不能承诺「自动重新检查」却永远不触发。
        log("主进程检查未通过，保留当前窗口。修复后保存任一 electron/ 文件即可重试；若问题在 scripts/ 或配置，请重启开发服务。");
        return;
      }
      restartingElectron = true;
      log(`${fileName} 已变更，正在重启 Electron…`);
      const previousProcess = electronProcess;
      electronProcess = undefined;
      await waitForExit(previousProcess);
      restartingElectron = false;
      if (revision === sourceRevision) startElectron();
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
  const currentCheck = checkProcess;
  electronProcess = undefined;
  checkProcess = undefined;
  await Promise.all([waitForExit(currentElectron), waitForExit(currentCheck), waitForExit(viteProcess)]);
  process.exit(exitCode);
}

async function main() {
  if (!(await checkElectronSources())) throw new Error("请先修复主进程检查中的问题。");
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
