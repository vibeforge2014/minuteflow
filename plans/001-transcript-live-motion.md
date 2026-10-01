# 001 — 转录直播动效打磨

Commit: f309895 · 状态: DONE · 范围: `src/components/TranscriptPanel.tsx` + `src/styles.css`

## 发现（已逐条核实 file:line）

1. **MEDIUM — 定稿颜色跳变**：`.transcript-item--provisional .transcript-copy { color: #8f949c }`（styles.css:1540）→ 定稿换回 `#343840`（styles.css:1527 基础规则），`.transcript-copy` 无 color 过渡 → 瞬变。直播中每个段落定稿都触发。
2. **MEDIUM — 状态标签 pop 退场**：TranscriptPanel.tsx:355 「临时转写中…」条件渲染，定稿即卸载；入场有 `content-status-enter`、退场无动画。违背仓库「对称退场」原则。
3. **LOW — 尾文重影**：styles.css:1535 `.transcript-copy__tail` 仅 opacity 淡入，流式追加读感偏"鬼影"。
4. **LOW — 多段齐刷刷**：导入块完成时常一次落 2-3 段，`content-motion-enter` 同时播放，缺 30-80ms 级联（AUDIT.md 类别 7）。
5. **LOW — 状态行文字瞬变**：TranscriptPanel.tsx:303 `transcript-hint` 每 ~10s 更新「第 N/M 段」无反馈。

## 方案（精确值）

- **1**：`.transcript-copy` 增加 `transition: color var(--motion-content) var(--ease-out-ui);`（220ms / cubic-bezier(0.23,1,0.32,1)，均为既有 token）。
- **2**：抽 `ProvisionalBadge({ visible })` 组件：`useExitPresence(visible, 140)`；`closing` 时追加 `is-closing` 类。CSS 新增
  `.provisional.is-closing { animation: content-status-exit 140ms var(--ease-out-ui) both; }` +
  `@keyframes content-status-exit { from { opacity: 1 } to { opacity: 0 } }`（纯 opacity，与入场 translateY 对称收回语义； specificity 0,2,0 > 入口规则 0,1,0，同元素并存时退场生效）。
- **3**：`content-tail-enter` 改为 `from { opacity: 0; filter: blur(2px) } to { opacity: 1; filter: blur(0) }`。Reduced Motion 块已将 `.transcript-copy__tail` 整个 animation 覆写为纯淡入 → blur 不会在 RM 下播放。
- **4**：渲染时算出 `enteringSequence`（visibleSegments 中命中 entering 集的有序 id）；入场的 article 上加 inline `animationDelay: min(index,2)*40ms`（0/40/80 三档）。`both` fill 保证延迟期不可见；RM 块的 `!important` animation 简写会把 delay 重置为 0。
- **5**：状态文本提为 `transcriptStatus` 变量，`<p className="transcript-hint content-status-enter" key={transcriptStatus}>` — 文本变化即重挂，复用 160ms 微淡入。无导入任务的直播态文本恒定，不会反复触发。

## 边界

- 不动 `is-playing` 高亮（bare `ease` 用于颜色变化是正确选择）、不动自动滚动、不加打字机效果（AGENTS.md：连续输入保持静止）。
- 不改 tokens、不改 content-motion 分类逻辑。
- `content-status-enter` 的 RM 覆写优先级高于 `is-closing`（!important）→ RM 下标签近似立即消失，符合"更少动画"。

## 验证

- `npx tsc --noEmit` + `npm run build` + `npm test`。
- CDP（MF_CDP_PORT=9222）：给既有 `.transcript-item` 临时挂/摘 `transcript-item--provisional` 验证 color 过渡生效；注入 `.transcript-copy__tail` / `.provisional.is-closing` 探针元素读 `getComputedStyle().animationName / filter`，确认新关键帧真实接线。
