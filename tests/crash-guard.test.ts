import { describe, expect, it } from "vitest";
import {
  formatCrashRecord,
  shouldPromptForRendererReload
} from "../electron/services/crash-guard.mjs";

describe("崩溃记录", () => {
  it("带时间戳、类型与堆栈，且不重复拼接", () => {
    const at = new Date("2026-11-12T06:00:00.000Z");
    const record = formatCrashRecord("未捕获的异常", new TypeError("boom"), at);
    expect(record).toContain("[2026-11-12T06:00:00.000Z] 未捕获的异常");
    expect(record).toContain("TypeError: boom");
  });

  it("非 Error 值与非法日期也能安全记录", () => {
    expect(formatCrashRecord("拒绝", "reason", new Date("invalid"))).toContain("reason");
    expect(formatCrashRecord("拒绝", undefined)).toContain("未知原因");
  });

  it("正常退出不打扰用户，异常退出需要提示", () => {
    expect(shouldPromptForRendererReload({ reason: "clean-exit" })).toBe(false);
    for (const reason of ["crashed", "oom", "killed", "abnormal-exit", undefined]) {
      expect(shouldPromptForRendererReload({ reason })).toBe(true);
    }
  });
});
