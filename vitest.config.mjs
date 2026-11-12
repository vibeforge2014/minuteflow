/**
 * 单元测试配置：tests/ 下所有 *.test.ts 都纳入默认 `npm test`。
 *
 * 背景：package.json 曾把 test 写死成 3 个文件名，导致 tests/ 里其余测试
 *（含断点续跑、Apple Speech、设置草稿、更新源等）长期零执行。同时 vitest 的
 * 默认 glob 会把 .build/ 里几十份历史 release 副本也扫进来，报「找不到模块」，
 * 因此这里显式收窄 include/exclude。node:test 写的 *.test.mjs 仍由
 * test:sites / test:license 单独运行，不由 vitest 加载。
 */
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.mjs";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ["tests/**/*.test.ts"],
      exclude: [
        "**/node_modules/**",
        "**/.build/**",
        "**/dist/**",
        "**/out/**",
        "**/release/**"
      ],
      environment: "node"
    }
  })
);
