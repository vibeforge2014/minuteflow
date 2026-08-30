# Design QA — macOS 权限引导易用性迭代

## Evidence

- Source visual truth: the preserved prior permission-wall and drag-helper baselines at `/Users/zqian15/Desktop/minuteflow/artifacts/permission-audit-2026-08-30/03-optimized-permission-wall.png` (1280 × 720 px) and `/Users/zqian15/Desktop/minuteflow/artifacts/permission-audit-2026-08-30/02-current-drag-helper.png` (1280 × 720 px). They preserve the selected macOS drag-helper direction from the original attached reference.
- Browser-rendered implementation: `/Users/zqian15/Desktop/minuteflow/artifacts/permission-audit-2026-08-30/06-usability-pass-main.png` and `/Users/zqian15/Desktop/minuteflow/artifacts/permission-audit-2026-08-30/07-usability-pass-waiting.png` (both 1280 × 720 px at a 1280 × 720 CSS viewport, density 1).
- Floating helper implementation: `/Users/zqian15/Desktop/minuteflow/artifacts/permission-audit-2026-08-30/08-usability-pass-helper.png` (780 × 176 px at a 780 × 176 CSS viewport, density 1).
- Full-view comparison: `/Users/zqian15/Desktop/minuteflow/artifacts/permission-audit-2026-08-30/10-main-before-after.png` (2560 × 720 px).
- Focused helper comparison: `/Users/zqian15/Desktop/minuteflow/artifacts/permission-audit-2026-08-30/09-helper-before-after.png` (1560 × 176 px; the prior helper was cropped and padded to the same 780 × 176 comparison frame).
- Minimum-width evidence: `/Users/zqian15/Desktop/minuteflow/artifacts/permission-audit-2026-08-30/12-helper-min-width-fixed.png` (560 × 176 px).
- State: macOS first run, microphone initially not determined, screen/system-audio permission denied, then microphone granted and System Settings opened.

## Findings

- No actionable P0, P1, or P2 findings remain.
- Fonts and typography: the system/PingFang stack, restrained weight hierarchy, short labels, and compact helper copy remain legible at 780 px and the 560 px minimum. No text truncation or unintended overflow remains.
- Spacing and layout rhythm: the main dialog retains its two-step hierarchy and single primary action. The helper keeps a large direct-manipulation tile, upward cue, target copy, fallback action, and close control in a 176 px non-blocking window.
- Colors and visual tokens: the light guide continues to use MinuteFlow warm white, peach, coral, and semantic green. The helper keeps the reference's dark floating material, with coral reserved for direction and the Finder fallback.
- Image quality and asset fidelity: both guide surfaces reuse the real MinuteFlow brand asset and the native drag payload uses the packaged app icon. Phosphor provides the standard UI icons; there are no emoji, placeholder images, CSS-drawn logos, or improvised SVG assets.
- Copy and content: the guide clearly separates microphone from system audio, names “屏幕与系统音频录制”, states that MinuteFlow does not save screen video, and explains both drag and “+” recovery paths without asking for Accessibility permission.
- Accessibility and agency: the drag tile exposes an instruction through `aria-describedby`, live drag/status copy announces state changes, errors use alert semantics, and “在访达中显示” gives keyboard-only users a workable path.

## Full-view comparison evidence

- The side-by-side main comparison shows that the added fallback sentence does not disrupt the established dialog proportions, step hierarchy, footer actions, or 1280 × 720 fit.
- The post-click waiting state replaces vague “go back and check” guidance with “系统设置已打开 · 正在自动检查”, a waiting status on the system-audio row, “立即检查”, and a clearly labelled reopen action.
- The implementation intentionally preserves MinuteFlow's visual system rather than copying the reference application's branding.

## Focused region comparison evidence

- The helper comparison verifies the same dark rounded surface, draggable app tile, upward arrow, target instruction, and dismiss affordance. The new implementation adds a visible Finder fallback while keeping the “不需要辅助功能权限” reassurance adjacent to it.
- At the 560 × 176 minimum, the final helper reports a 548 × 164 outer box with 546 × 162 internal scroll bounds; no content is clipped or scrollable.

## Comparison history

1. Baseline usability gap — P1 keyboard recovery: the previous helper described the system-list “+” fallback but did not provide a way to locate the real app bundle without dragging.
   - Fix: added a trusted `system:reveal-application` IPC route and a keyboard-operable “在访达中显示” button.
   - Post-fix evidence: `08-usability-pass-helper.png`; Enter activation completed in the browser preview without errors.
2. Baseline usability gap — P2 return-state ambiguity: after opening System Settings, the main guide gave no persistent feedback that the handoff succeeded.
   - Fix: added an explicit waiting state, automatic 1.5-second background permission checks, “立即检查”, and “重新打开系统设置”.
   - Post-fix evidence: `07-usability-pass-waiting.png`.
3. First responsive pass — P2 helper clipping at the native 560 px minimum: the new fallback wrapped below the fixed helper surface.
   - Fix: added a compact helper grid and type treatment below 680 px.
   - Post-fix evidence: `12-helper-min-width-fixed.png`; internal height reduced from 175 px to 162 px inside the 164 px content surface.

## Primary interactions tested

- “允许麦克风” advances the first row to “已允许” and moves the primary action to “打开系统设置”.
- “打开系统设置” changes the second row to “等待设置” and exposes the automatic-check/reopen state.
- The helper's “在访达中显示” fallback is keyboard-operable with Enter.
- Browser console errors checked on both surfaces: none.
- TypeScript, Electron main/preload syntax, 82 core tests, production build, and 4 Sites worker tests pass.

## Implementation checklist

- [x] Single sequential primary action.
- [x] Real `.app` drag payload through Electron.
- [x] Keyboard/Finder fallback for the system-list “+” route.
- [x] Automatic permission recognition after opening System Settings.
- [x] Explicit waiting, success, warning, and error feedback.
- [x] 560 px native helper minimum without clipping.
- [x] Reduced-motion/transparency compatibility preserved.

## Follow-up polish

- P3 test gap: the browser preview verifies layout and state transitions, but the final signed `.app` should still receive a release smoke test against the localized macOS 14.2+ System Settings pane because native drag acceptance is controlled by macOS.

final result: passed

---

# Design QA — 跨平台视觉纪要与会后布局

## Evidence

- Source visual truth: `/var/folders/br/w5xj47hx5rn3sg6zmvz51k900000gn/T/codex-clipboard-637dd8de-2ab4-41c8-a9ea-c875e3ec608e.png` (竞品会后布局) and `/var/folders/br/w5xj47hx5rn3sg6zmvz51k900000gn/T/codex-clipboard-d769c652-9fbd-4741-ab02-6a8f6e5c8c68.png` (竞品视觉纪要信息图).
- Final browser-rendered implementation screenshot: `/Users/zqian15/Desktop/minuteflow/artifacts/implementation-visual-transcript-1366x1038-final.png`.
- Long-content lower-region screenshot: `/Users/zqian15/Desktop/minuteflow/artifacts/implementation-visual-lower-1366x1038.png`.
- Narrow-window screenshot: `/Users/zqian15/Desktop/minuteflow/artifacts/implementation-visual-narrow-1100x800.png`.
- Combined full-view comparison: `/Users/zqian15/Desktop/minuteflow/artifacts/design-qa-visual-comparison-final.png`.
- Source pixels: 2138 × 1624, normalized to 1366 × 1038 with Lanczos resampling (same 1.316 aspect ratio).
- Implementation pixels and CSS viewport: 1366 × 1038 at density 1. A second browser pass used 1100 × 800.
- Primary state: completed meeting, light theme, visual-summary tab selected, left meeting library retained, structured infographic in the center, real timestamped transcript on the right.

## Findings

- No actionable P0, P1, or P2 findings remain.
- Fonts and typography: the implementation uses the product's system Chinese sans-serif stack, bold document title, restrained metadata, compact table text, and clear section/card hierarchy. Long Chinese copy wraps naturally without truncation; table and card labels remain legible at 1100 px.
- Spacing and layout rhythm: the reference's dense infographic hierarchy is preserved through a hero, numbered sections, constrained tables, two-column cards, and a final callout. MinuteFlow intentionally retains its left meeting library and right transcript, so the center canvas is narrower than the competitor's content-only view; the document remains centered and scrolls independently.
- Colors and visual tokens: the competitor's blue/purple product chrome is intentionally mapped to MinuteFlow coral orange, pale peach, amber, violet, and semantic green. Surfaces use warm off-white, lightweight borders, and restrained elevation without gradients.
- Image quality and asset fidelity: no raster illustration or generated text image is required. The visual summary is native DOM/SwiftUI content with the existing MinuteFlow mark and library icons, so Chinese remains sharp at display and PNG-export resolutions. No emoji, handcrafted SVG, placeholder imagery, or CSS illustration substitutes were introduced.
- Copy and content: visual content is meeting-specific and coherent on its own. The persistent label states that the model organizes content while MinuteFlow renders it locally. The right panel remains transcript/structured-summary content and intentionally does not copy the competitor's AI Q&A.
- Icons and controls: the existing Phosphor/SF Symbols families are retained, active tabs and numbered sections are visually distinct, and export exposes “视觉纪要图” only for a valid non-stale visual summary.
- Responsiveness and accessibility: 1366 × 1038 and 1100 × 800 show no overlap, clipped persistent controls, or horizontal page overflow. Tabs expose semantic tab roles, table markup remains native, visible text contrast is adequate, and the center document supports independent scrolling through the final callout.

## Full-view comparison evidence

- The combined image places the normalized 1366 × 1038 source and implementation in one comparison input. Both establish a dominant information-dense summary canvas with a strong title, a numbered comparison table, colored card groups, and an adjacent utility panel.
- Deliberate product constraints explain the remaining structural differences: MinuteFlow keeps the meeting library, removes AI Q&A, uses a user-triggered “生成最终纪要” stage, and shows the existing transcript panel. Playback is intentionally absent from this demo meeting because no verified local audio asset exists; the product keeps playback on demand rather than rendering an empty player.
- The implementation matches the requested information density without copying competitor branding or directly generating a Chinese-text bitmap.

## Focused-region comparison evidence

- The upper implementation screenshot verifies title hierarchy, metadata, numbered section 01, four-column table, right-panel transcript density, and the ordinary/visual switch at readable scale.
- The lower screenshot verifies sections 02–04, two-column cards, status pills, dynamic document height, final callout, and the local-rendering attribution. No card or table content overflows its container.
- The 1100 × 800 screenshot verifies that the three-column workspace remains usable at a narrow desktop width; the visual table stays contained and transcript text wraps without covering the document.

## Comparison history

1. First visual pass — P2 section hierarchy: numbered section badges rendered white-on-white because `currentColor` resolved after the badge text color was set to white.
   - Fix: introduced a per-tone `--visual-accent` token and used it explicitly for the badge background while retaining white numerals.
   - Post-fix evidence: `implementation-visual-1366x1038-final.png` and the final combined comparison show visible amber, violet, green, and coral section numbers.
2. First full-view pass — P2 right-panel realism: the completed demo meeting had no transcript, leaving a blank right panel and weakening the intended “visual minutes + existing transcript” state.
   - Fix: added realistic, timestamped two-speaker transcript segments to the completed browser fixture.
   - Post-fix evidence: `implementation-visual-transcript-1366x1038-final.png` shows four readable transcript segments alongside the visual canvas.
3. Native iPad pass — P1 missing switch: a `NavigationSplitView` content column can receive a compact horizontal size class even on iPad, so a child-level size-class check hid the ordinary/visual control.
   - Fix: the iPad workspace now explicitly enables the center visual switch; iPhone continues to use the AI-minutes secondary picker.
   - Post-fix evidence: the iPad UI tests switch to “视觉纪要”, verify the poster title and final callout, then return to “普通纪要”.

## Primary interactions tested

- Desktop ordinary/visual tab switching and independent long-document scrolling.
- Desktop valid-visual export menu gating, including the “视觉纪要图” PNG item.
- Desktop completed-meeting selection, timestamped transcript visibility, 1366 × 1038 and 1100 × 800 layouts.
- Desktop recording-start transition and permission-timeout fallback; the browser preview correctly returned to a safe preparation state when real capture was unavailable.
- iPhone completed-meeting navigation, AI-minutes tab, ordinary/visual secondary switching, visual title/final callout, and return to editable ordinary minutes.
- iPad three-column document/transcript coexistence and center ordinary/visual switching.
- Browser console warnings/errors in the final page: none.

## Implementation checklist

- [x] Constrained cross-platform `VisualSummary` schema and Simplified Chinese normalization.
- [x] Verified capability fingerprint, real schema connection test, and invalidation after model configuration changes.
- [x] Two-stage final summary with ordinary-summary persistence, cancellation, stale marking, retry, and explicit fallback semantics.
- [x] Electron native visual canvas, conditional export menu, and hidden-window PNG rendering.
- [x] iPhone/iPad SwiftUI visual canvas, SwiftData optional-field migration path, retry/fallback state, JSON backup preservation, and `ImageRenderer` PNG export.
- [x] Desktop browser interaction QA, iPhone/iPad UI tests, schema/persistence/PNG unit tests, production build, and Sites packaging tests.

## Follow-up polish

- P3: the 1100 px layout intentionally uses very compact table type to preserve four columns; a future user preference could offer a larger-text single-card table presentation without changing the current default density.

final result: passed

---

# Design QA — 首次启动模型配置向导

## Evidence

- Existing visual-system anchors: desktop `SystemPermissionsDialog`, the warm-light settings workbench, coral primary actions, neutral document surfaces, and the iOS `MeetingTheme` tokens.
- Desktop welcome state: `/Users/zqian15/Desktop/minuteflow/artifacts/onboarding-welcome-808x800.png`.
- Desktop AI-summary state: `/Users/zqian15/Desktop/minuteflow/artifacts/onboarding-summary-808x800.png`.
- Desktop completion state: `/Users/zqian15/Desktop/minuteflow/artifacts/onboarding-ready-808x800.png`.
- Browser viewport: 808 × 800 at density 1; the real application workspace remains visible behind the modal.

## Findings

- No actionable P0, P1, or P2 findings remain.
- Hierarchy: the four-step progress indicator, single task title, short explanation, setup choices, current readiness state, and one primary action create a clear sequential path without duplicating the full settings editor.
- Product consistency: typography, borders, restrained shadows, warm coral tint, pale peach surfaces, semantic green success, and Phosphor/SF Symbols match the existing desktop and iOS systems.
- Behavior: desktop opens the real Whisper or AI-summary settings workbench and returns to the same wizard step. Readiness updates from persisted profiles; finishing without Whisper states “only save audio,” while finishing without an online LLM states “local basic summary.”
- iOS adaptation: the same order is retained in an adaptive full-screen flow. Apple Speech is the built-in alternative to remote Whisper; remote API fields and credentials are saved through the existing preferences and Keychain services.
- Privacy and model semantics: no network call occurs merely because the wizard opens or finishes. Visual-summary capability remains gated behind the existing real schema connection test.
- Accessibility: desktop controls retain native button/dialog semantics and visible focus targets. iOS fields use native SwiftUI controls, explicit accessibility identifiers, and a spoken progress label.

## Interaction verification

- [x] First launch opens after the versioned permissions wall.
- [x] Welcome → Whisper → AI summary → completion navigation.
- [x] Whisper setup opens the real transcription settings page.
- [x] Closing settings resumes the current onboarding step.
- [x] Explicit audio-only and local-basic-summary fallback copy.
- [x] Completion persists and enters the meeting workspace.
- [x] iPhone UI automation completes the full local-default onboarding path.
- [x] No clipping or overflow at 808 × 800; long content remains scrollable on iPhone/iPad.

final result: passed
