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
