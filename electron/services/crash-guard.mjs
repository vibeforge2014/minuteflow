/**
 * 崩溃可观测与恢复（主进程启动时安装）。
 *
 * 此前 uncaughtException / unhandledRejection 只写 console，用户完全看不到；
 * 异常后进程继续带着可能已损坏的状态写数据库，风险比直接退出更高。这里统一：
 *   - 落盘到 userData/logs/crash-guard.log（同步写，保证崩溃前已持久化）；
 *   - crashReporter 只在本地生成 dump，不上传（应用不收集用户数据）；
 *   - 渲染进程崩溃时给出「重新加载 / 退出」对话框，而不是白屏；
 *   - 反复未捕获异常（3 次）走 app.quit()，让 before-quit 的落盘握手有机会执行。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/** 只保留可诊断信息，避免把会议内容写进日志。 */
export function formatCrashRecord(kind, error, at = new Date()) {
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
    : String(error ?? "未知原因");
  const timestamp = at instanceof Date && !Number.isNaN(at.getTime())
    ? at.toISOString()
    : new Date(0).toISOString();
  return `[${timestamp}] ${kind}\n${detail.trimEnd()}\n\n`;
}

/** clean-exit 是正常关闭，不应打扰用户；其余原因都需要提示或重载。 */
export function shouldPromptForRendererReload(details) {
  return String(details?.reason ?? "unknown") !== "clean-exit";
}

export function installCrashGuard({
  app,
  crashReporter,
  dialog,
  Notification,
  getMainWindow,
  logDirectory
}) {
  mkdirSync(logDirectory, { recursive: true });
  const logPath = path.join(logDirectory, "crash-guard.log");

  try {
    // uploadToServer:false —— 只在本机留 dump，不向任何服务器上传崩溃信息。
    crashReporter.start({
      productName: "MinuteFlow",
      companyName: "MinuteFlow",
      uploadToServer: false,
      compress: true
    });
  } catch (error) {
    console.warn("[crash-guard] crashReporter 启动失败：", error);
  }

  let uncaughtCount = 0;
  let rendererPromptOpen = false;

  const record = (kind, error) => {
    const line = formatCrashRecord(kind, error);
    try {
      appendFileSync(logPath, line, "utf8");
    } catch {
      // 日志目录不可写时至少保留控制台输出，不能让日志失败成为新的异常源。
    }
    console.error(line.trimEnd());
    return line;
  };

  process.on("unhandledRejection", (reason) => {
    record("未处理的 Promise 拒绝", reason);
  });

  process.on("uncaughtException", (error) => {
    record("未捕获的异常", error);
    uncaughtCount += 1;
    if (uncaughtCount === 1 && Notification?.isSupported?.()) {
      new Notification({
        title: "MinuteFlow 遇到问题",
        body: "已记录错误。若反复出现，建议重启应用；未保存的内容会自动尝试落盘。"
      }).show();
    }
    if (uncaughtCount >= 3) {
      // 反复异常说明状态已不可信。走 quit（而非 exit）以触发退出前的数据冲刷。
      console.error("[crash-guard] 连续 3 次未捕获异常，准备安全退出。");
      app.quit();
    }
  });

  app.on("render-process-gone", async (_event, contents, details) => {
    record(`渲染进程退出（${details?.reason ?? "unknown"}）`, details?.exitCode ?? "");
    if (!shouldPromptForRendererReload(details) || rendererPromptOpen) return;
    rendererPromptOpen = true;
    try {
      const window = getMainWindow?.();
      if (!window || window.isDestroyed()) return;
      const { response } = await dialog.showMessageBox(window, {
        type: "error",
        title: "界面进程意外退出",
        message: "会议界面意外关闭，录音与已保存的内容不会丢失。",
        detail: `原因：${details?.reason ?? "未知"}。可以重新载入界面继续使用。`,
        buttons: ["重新载入", "退出应用"],
        defaultId: 0,
        cancelId: 1
      });
      if (response === 0 && !contents.isDestroyed()) contents.reload();
      else app.quit();
    } catch (error) {
      record("渲染进程恢复对话框失败", error);
    } finally {
      rendererPromptOpen = false;
    }
  });

  app.on("browser-window-created", (_event, window) => {
    window.webContents.on("unresponsive", () => {
      record("界面无响应", `window id ${window.id}`);
    });
  });

  return { logPath };
}
