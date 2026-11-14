/**
 * 自动更新下载会话状态机（electron/services/update-download-state.mjs）单元测试。
 *
 * 背景（用户反馈「进度卡住 / 无法取消」）：慢速线路上 electron-updater 可能长时间
 * 没有 download-progress 事件，旧实现会让 UI 永远停在同一个百分比。这里锁定：
 * 1) 下载阶段首次停滞 → 自动重连一次，第二次仍停滞 → 明确失败（可手动下载兜底）；
 * 2) 已进入 Squirrel.Mac 安装准备阶段（无进度事件属正常）→ 只允许超时失败，绝不重试；
 * 3) 用户取消后判定恒 ok（取消是意图，不是故障），不会触发重连/失败。
 */
import { describe, expect, it } from "vitest";
import {
  FINALIZE_FRACTION,
  createDownloadSession,
  evaluateDownloadHealth,
  mergeProgress,
  progressSnapshot
} from "../electron/services/update-download-state.mjs";

describe("createDownloadSession", () => {
  it("新会话从零进度开始，attempt 可显式指定（重连时递增）", () => {
    const session = createDownloadSession({ version: "0.1.45", now: 1_000 });
    expect(session.version).toBe("0.1.45");
    expect(session.attempt).toBe(1);
    expect(session.receivedBytes).toBe(0);
    expect(session.totalBytes).toBe(0);
    expect(session.fraction).toBe(0);
    expect(session.finalizing).toBe(false);
    expect(session.cancelRequested).toBe(false);
    expect(session.lastProgressAt).toBe(1_000);

    const retry = createDownloadSession({ version: "0.1.45", now: 2_000, attempt: 2 });
    expect(retry.attempt).toBe(2);
    expect(retry.startedAt).toBe(2_000);
  });
});

describe("mergeProgress", () => {
  it("合并字节与百分比，并刷新 lastProgressAt", () => {
    const session = createDownloadSession({ version: "0.1.45", now: 0 });
    mergeProgress(session, { transferred: 50, total: 200 }, 500);
    expect(session.receivedBytes).toBe(50);
    expect(session.totalBytes).toBe(200);
    expect(session.fraction).toBeCloseTo(0.25);
    expect(session.lastProgressAt).toBe(500);
    // 无 total 时由 electron-updater 直接给 fraction 也接受。
    mergeProgress(session, { transferred: 100, total: 0, fraction: 0.5 }, 900);
    expect(session.fraction).toBeCloseTo(0.5);
    // fraction 上限钳到 1。
    mergeProgress(session, { transferred: 300, total: 200, fraction: 1.5 }, 1_000);
    expect(session.fraction).toBe(1);
  });

  it("fraction 达到阈值即标记 finalizing（进入本地安装准备阶段）", () => {
    const session = createDownloadSession({ now: 0 });
    mergeProgress(session, { transferred: 97, total: 100 }, 100);
    expect(session.finalizing).toBe(false);
    mergeProgress(session, { transferred: 99, total: 100 }, 200);
    expect(session.fraction).toBeGreaterThanOrEqual(FINALIZE_FRACTION);
    expect(session.finalizing).toBe(true);
  });
});

describe("evaluateDownloadHealth", () => {
  it("下载阶段停滞超过 90s：第 1 次 → retry，第 2 次 → fail", () => {
    const session = createDownloadSession({ now: 0 });
    mergeProgress(session, { transferred: 10, total: 100 }, 1_000);
    expect(evaluateDownloadHealth(session, 1_000 + 60_000)).toBe("ok");
    expect(evaluateDownloadHealth(session, 1_000 + 91_000)).toBe("retry");
    // 重连后 attempt 递增：再次停滞直接失败，不再无限重试。
    session.attempt = 2;
    session.lastProgressAt = 200_000;
    expect(evaluateDownloadHealth(session, 200_000 + 91_000)).toBe("fail");
  });

  it("finalizing 阶段无进度属正常，超时只允许失败、不可重试", () => {
    const session = createDownloadSession({ now: 0 });
    mergeProgress(session, { transferred: 100, total: 100 }, 1_000);
    expect(session.finalizing).toBe(true);
    // 安装准备阶段 3 分钟内无事件：ok（Squirrel.Mac 本地处理不报进度）。
    expect(evaluateDownloadHealth(session, 1_000 + 120_000)).toBe("ok");
    // 超过 finalize 上限：fail，即使 attempt=1 也不给 retry。
    session.attempt = 1;
    expect(evaluateDownloadHealth(session, 1_000 + 181_000)).toBe("fail");
  });

  it("用户取消后判定恒 ok，不会触发重连或失败", () => {
    const session = createDownloadSession({ now: 0 });
    session.cancelRequested = true;
    session.lastProgressAt = 0;
    expect(evaluateDownloadHealth(session, 10 * 60_000)).toBe("ok");
    session.finalizing = true;
    expect(evaluateDownloadHealth(session, 10 * 60_000)).toBe("ok");
  });
});

describe("progressSnapshot", () => {
  it("产出与渲染层 AppUpdateDownloadProgress 同构的快照", () => {
    const session = createDownloadSession({ version: "0.1.45", now: 0 });
    mergeProgress(session, { transferred: 64, total: 256 }, 100);
    expect(progressSnapshot(session, "downloading")).toEqual({
      status: "downloading",
      version: "0.1.45",
      receivedBytes: 64,
      totalBytes: 256,
      fraction: 0.25
    });
    expect(progressSnapshot(session, "downloading", "网络较慢，正在重新连接…").message)
      .toBe("网络较慢，正在重新连接…");
    expect(progressSnapshot(session, "error", "更新下载长时间无进展，已停止。").status).toBe("error");
  });
});
