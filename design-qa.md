# Design QA — MinuteFlow 跨端体验轻量优化（2026-08-31）

## Evidence

- Source visual truth: `/Users/zqian15/.codex/generated_images/019fb0bc-fbcb-7e43-9466-3ebdf9e5dba6/call_1Z4kzuiPHEUQd1XCaaJAnBNL.png` (1487 × 1058 px), the selected lightweight-document workspace direction recorded in `AGENTS.md`.
- Browser-rendered desktop implementation: `/tmp/minuteflow-ux-polish/desktop-1487x1058.png` (1487 × 1058 px) at a 1487 × 1058 CSS viewport and density 1. No density or aspect-ratio normalization was needed.
- Combined full-view comparison input: `/tmp/minuteflow-ux-polish/design-qa-combined.png` (1487 × 600 px), with source and implementation scaled equally to 50% and placed side by side.
- Focused header/workspace comparison input: `/tmp/minuteflow-ux-polish/design-qa-focused-header.png` (1487 × 560 px), with the upper 250 px of each 1487 × 1058 artifact stacked at 1:1 scale.
- Responsive/browser evidence: `/tmp/minuteflow-ux-polish/desktop-settings-1100x800.png`, `/tmp/minuteflow-ux-polish/marketing-390x844.png`, and `/tmp/minuteflow-ux-polish/marketing-menu-final-390x844.png`.
- Native iPhone evidence: `/tmp/minuteflow-ux-polish/ios-iphone-library.png` and `/tmp/minuteflow-ux-polish/ios-iphone-library-light.png` (1206 × 2622 px dark/light simulator captures). iPad layout was verified by its dedicated landscape UI test rather than retained as screenshot evidence.
- State: source is a live meeting; implementation is the same three-column information architecture in the recoverable pre-meeting state with a populated transcript. The state mismatch is intentional, so comparison judgments cover anatomy, hierarchy, density, typography, tokens, and persistent controls rather than live-only content.

## Findings

- No actionable P0, P1, or P2 findings remain.
- Fonts and typography: the system/PingFang stack preserves the source's compact document hierarchy, restrained metadata, and readable transcript density. Desktop titles, state labels, settings copy, mobile menu labels, and native iOS list metadata do not clip at the tested sizes.
- Spacing and layout rhythm: the desktop retains a stable library/document/transcript grid and a lightweight central document. Header actions now form a readable title/favorite group and a separate local-save/export/utility group. The 1100 × 800 settings workbench keeps its editor scroll area and sticky bottom actions fully inside the dialog.
- Colors and visual tokens: the source's structural hierarchy is retained while blue product chrome is intentionally mapped to MinuteFlow's durable warm-coral system. Coral is limited to primary actions and selected product states; semantic green, amber, red, and speaker colors remain distinct.
- Image quality and asset fidelity: no new or substitute artwork was introduced. The website continues to use the real product screenshot and existing MinuteFlow brand asset; desktop uses Phosphor and iOS uses SF Symbols. The 390 px screenshot crop enlarges the real workspace asset without stretching it.
- Copy and content: settings/setup consistently use “AI 总结”; content results and workspace switches use “AI 纪要”. Meeting phases, local-save wording, recoverable import states, and the user-initiated final-minutes behavior are coherent across React and SwiftUI.
- Icons and controls: icon buttons now expose selected/expanded states and explanatory labels; settings navigation exposes the current page; mobile segmented controls keep native behavior and practical touch targets.
- Responsiveness and accessibility: no horizontal overflow was measured at 1487 × 1058 or 1100 × 800. iPhone and iPad recorder bars occupy safe-area layout space instead of covering content. Reduced-motion/transparency fallbacks, visible keyboard focus, Escape handling, menu focus restoration, and 44 px mobile menu controls remain present.

## Full-view comparison evidence

- The combined input confirms the same dominant three-column composition, narrow searchable meeting library, wide document canvas, transcript utility rail, compact top chrome, and high information density.
- The implementation intentionally replaces the source's live-only toolbar and blue accent with the approved staged workflow, warm coral brand tint, local-save status, and preparation card. These are product constraints recorded in `AGENTS.md`, not unresolved fidelity drift.
- Persistent controls remain visible without overlapping the document. The populated transcript keeps the right panel useful even while the central workspace is in preparation state.

## Focused region comparison evidence

- The 1:1 upper-region comparison verifies title/favorite adjacency, local-save/export grouping, panel tabs, three column boundaries, lightweight dividers, and restrained border radii at readable scale.
- The focused input was necessary because the equal-scale full-view board makes small header labels and panel controls too small to judge reliably.

## Comparison history

1. First desktop pass — P2 header grouping: the editable title used a fixed viewport-relative width, which left the favorite control visually floating near the center of the header.
   - Fix: changed the title input to content-sized layout with the existing minimum/maximum constraints and preserved narrow-window caps.
   - Post-fix evidence: `/tmp/minuteflow-ux-polish/desktop-1487x1058.png` and `/tmp/minuteflow-ux-polish/design-qa-focused-header.png` show the star directly following the title group.
2. First 390 px website pass — P2 mobile navigation alignment: when the main links became absolutely positioned, the menu button no longer occupied the trailing edge of the floating navigation bar.
   - Fix: gave the navigation-actions group automatic leading margin, keeping the 44 × 44 control at x=324 inside the 366 px bar.
   - Post-fix evidence: `/tmp/minuteflow-ux-polish/marketing-menu-final-390x844.png`; the opaque menu, dimming scrim, and trailing close control are aligned with no page scroll.
3. Post-fix comparison found no remaining P0/P1/P2 visual, responsive, interaction, or accessibility mismatch.

## Primary interactions tested

- Desktop three-column panel open/close, settings navigation, stable editor scrolling, sticky save/test actions, Cmd+N, Esc, Cmd+K, initial dialog focus, and search focus.
- Website mobile menu open, document scroll lock, Escape close, focus return to the menu button, and 390 px screenshot crop; browser console warnings/errors checked on desktop, settings, and website states: none.
- iPhone light/dark library rendering, action/settings tabs, meeting detail, AI-minutes switch, onboarding, and safe bottom layout through UI tests; iPad three-column document/transcript/recorder coexistence through the landscape UI test.
- TypeScript, 85 Vitest cases, Swift build, 12 Swift unit tests, 5 iPhone UI tests (1 iPad-only skip), the dedicated iPad UI test, production build, and 4 Sites worker tests pass.

## Implementation checklist

- [x] Cross-platform AI-summary/minutes and lifecycle wording.
- [x] Desktop header grouping, contextual empty state, settings bottom actions, import hierarchy, and narrow-window stability.
- [x] iPhone/iPad safe-area recorder placement, compact phone idle state, grouped action items, settings explanation, and adaptive split widths.
- [x] Opaque mobile website menu, scroll lock, Escape/outside close, focus restoration, tighter hero rhythm, and readable real-product screenshot crop.
- [x] Keyboard, reduced-motion/transparency, responsive, native SwiftUI, build, test, and Sites packaging validation.

## Follow-up polish

- P3 release smoke test: VoiceOver reading order, the largest accessibility text sizes, iPad portrait split-view contraction, and macOS/Windows native title-bar hit regions should still receive the planned human pass on release hardware; the automated and simulator checks found no blocker.

final result: passed

---

# Design QA — macOS 权限引导完成率优化（渐进式流程）

## Evidence

- Source visual truth: `/Users/zqian15/Desktop/minuteflow/artifacts/permission-audit-2026-08-30/06-usability-pass-main.png` (1280 × 720 px) and `/Users/zqian15/Desktop/minuteflow/artifacts/permission-audit-2026-08-30/08-usability-pass-helper.png` (780 × 176 px). These preserve the selected warm permission wall and dark real-app drag-helper direction from the prior accepted pass.
- Electron implementation states: `/Users/zqian15/Desktop/minuteflow/artifacts/permission-completion-2026-08-30/01-microphone.jpeg`, `02-screen-settings.jpeg`, `03-restart.jpeg`, `05-verify.jpeg`, and `06-success.jpeg` (each 1152 × 768 physical px). The BrowserWindow was 1440 × 960 CSS px on a 0.8 macOS capture scale.
- Native System Settings handoff evidence: `/Users/zqian15/Desktop/minuteflow/artifacts/permission-completion-2026-08-30/04-system-settings.jpeg` (723 × 515 px); it opens the localized “录屏与系统录音” pane without changing any TCC switch.
- Full-view comparison input: `/Users/zqian15/Desktop/minuteflow/artifacts/permission-completion-2026-08-30/09-main-comparison.png` (2560 × 768 px). The 1280 × 720 source is vertically padded to 1280 × 768; the 1152 × 768 implementation is horizontally padded to the same frame without resampling.
- Five-state implementation board: `/Users/zqian15/Desktop/minuteflow/artifacts/permission-completion-2026-08-30/11-state-board.png` (1728 × 768 px), covering microphone, screen settings, restart, verify, and success.
- Focused helper comparison input: `/Users/zqian15/Desktop/minuteflow/artifacts/permission-completion-2026-08-30/10-helper-comparison.png` (1560 × 176 px). The Electron helper capture was 622 × 140 physical px and was normalized back to its 780 × 176 CSS size before comparison.
- Minimum helper evidence after the responsive fix: `/Users/zqian15/Desktop/minuteflow/artifacts/permission-completion-2026-08-30/12-helper-560.jpeg` (454 × 140 physical px, representing the 560 × 176 CSS helper at the same 0.8 capture scale plus its outer margin).
- State: macOS first-run authorization, with microphone initially undecided, screen/system-audio denied, System Settings return, restart-required recovery, post-relaunch verification, and automatic completion.

## Findings

- No actionable P0, P1, or P2 findings remain.
- Fonts and typography: the system/PingFang stack and existing compact optical hierarchy are retained. Phase titles, two permission rows, helper instructions, and footer actions remain readable without truncation; the 560 px helper uses a deliberately tighter but still coherent scale.
- Spacing and layout rhythm: the first screen now contains only the two permission rows and one current action. The drag tutorial appears only during the system-audio task. Restart, verify, and success use a single compact status surface, keeping the dialog below the 672 CSS px maximum available at a 1280 × 720 viewport.
- Colors and visual tokens: warm white, pale peach, coral actions, amber restart, and semantic green success map to MinuteFlow's established tokens. The dark helper preserves the macOS floating-material contrast without copying System Settings chrome.
- Image quality and asset fidelity: the real MinuteFlow brand asset and packaged app icon remain in use; Phosphor supplies standard interface icons. No emoji, handcrafted SVG, CSS-drawn logo, or placeholder image was introduced.
- Copy and content: duplicate privacy explanations are reduced to one consent/local-storage note. Each phase explains the current outcome, restart necessity, local-only verification, and the Finder/list “+” recovery path. The guide explicitly says that screen imagery is not saved and that Accessibility permission is not required.
- States and interaction: all five main phases render and transition; the success feedback remains visible for about one second and then closes automatically. The helper exposes idle, dragging, dropped, restarting, and success copy, with “开关已打开，重启” and “在访达中显示” available in the dropped state.
- Accessibility: native buttons remain keyboard reachable, focus starts on the phase primary action, progress/status changes use live regions, verification failures use alert semantics, reduced-motion/transparency rules include the new stages, and the Finder fallback supports keyboard-only completion.
- Viewport resilience: no main-stage persistent control is clipped in the captured smaller physical viewport. The focused 780 × 176 helper fits, and the revised 560 × 176 compact layout keeps both fallback buttons and the “不需要辅助功能权限” reassurance inside the dark surface.

## Full-view comparison evidence

- The combined main input shows the intentional progressive reduction from the previous all-at-once wall: the implementation preserves the accepted typography, rows, warm palette, radii, and action hierarchy while removing the early drag tutorial and duplicate authorization note.
- The five-state board confirms that only one task-specific panel is added at a time and that restart/verify/success do not increase the modal beyond the screen-settings stage.
- The implementation uses one coral primary action in every active stage. “暂不授权，先体验” remains a quiet exit, while restart and verify expose only their phase-specific recovery control.

## Focused region comparison evidence

- The helper comparison confirms the same draggable application tile, upward direction cue, dark rounded material, target instruction, close control, Finder fallback, and no-Accessibility reassurance as the accepted source.
- The focused 560 px evidence is necessary because the dropped state adds a second button. After the compact-grid fix, all visible copy and controls remain inside the 176 px helper with no crop or scroll burden.

## Comparison history

1. First responsive pass — P2 helper overflow at the 560 × 176 minimum: in the dropped/restart state, the no-Accessibility reassurance wrapped below the fixed dark helper surface.
   - Fix: introduced the same compact grid used by the real `max-width: 600px` breakpoint for deterministic development preview; narrowed the draggable tile, tightened type and gaps, and kept the restart/Finder actions on one compact row.
   - Post-fix evidence: `12-helper-560.jpeg`; the dark surface contains the application tile, direction cue, title, description, both actions, reassurance, and close control.
2. Post-fix comparison found no remaining P0/P1/P2 visual or interaction mismatch, so no further iteration was required.

## Primary interactions tested

- “允许麦克风” advances to the system-audio task without showing the drag tutorial early.
- “打开系统设置” opens the correct localized macOS pane and moves the main guide to the recoverable restart state after return.
- “重启并继续” advances to verification in the safe development preview; production uses the new atomic resume-marker IPC before relaunch.
- “验证系统音频” reaches success; success automatically closes after roughly one second.
- Helper idle and dropped/restart states render at 780 × 176 and 560 × 176; Finder and restart controls are present in the accessibility tree.
- The actual System Settings pane was observed but no OS permission switch, TCC database, or unrelated system setting was modified.
- TypeScript, Electron main/preload syntax, 85 core tests, production build, and 4 Sites worker tests pass.

## Implementation checklist

- [x] `microphone → screen-settings → restart → verify → success` pure phase state.
- [x] Atomic `permissionSetupResume` persistence and relaunch API.
- [x] Resume overrides prior completed/skipped flow state; completion and skip clear the marker.
- [x] Friendly permission-error recovery instead of Chromium error text.
- [x] One-second success feedback with automatic continuation.
- [x] Five drag-helper states plus Finder and list “+” recovery.
- [x] Cursor-display positioning, reopen recomputation, and work-area clamping.
- [x] 780 × 176 and 560 × 176 helper layouts without clipping.
- [x] Existing no-Accessibility, no-screen-save, and no-normal-recording-picker constraints preserved.

## Follow-up polish

- P3 release gate: the final native drag acceptance, actual TCC toggle/relaunch, VoiceOver announcement order, and post-signing bundle identity still require the planned macOS 14.2+ smoke test with a signed test package and isolated account. This implementation pass intentionally does not reset the current user's TCC data, bump the version, sign, notarize, or publish.

final result: passed

---

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

---

# Design QA — 完整设置页重构与辅助文字可读性（2026-11-05）

## Evidence and normalization

- Source visual truth: `/Users/zqian15/.codex/generated_images/01a1aa09-d19e-7620-b18e-41998efaca72/exec-d72d65e4-1f00-4898-9caf-e74f96c3bd7b.png` (1487 × 1058 px), the settings direction recorded in `AGENTS.md`.
- Implementation: `http://127.0.0.1:5173/?preview=desktop`, captured through the Codex in-app browser. CSS viewport and screenshot are 1113 × 938; the browser reports devicePixelRatio 2 but its screenshot export is already normalized to CSS pixels, so the capture was not downsampled again.
- Dialog: 1040 × 760 CSS px, x=36.5, y=89. Source dialog crop `(164,101)–(1324,961)` is 1160 × 860 px; normalized to the implementation's 1040 × 760 frame. Fractional capture coordinates were rounded to whole pixels. Browser/background chrome is excluded from comparison.
- Same-route source/implementation: `/tmp/minuteflow-settings-qa-transcription-before.png`, `/tmp/minuteflow-settings-qa-transcription-after.png`.
- Combined full-view comparison inputs: `/tmp/minuteflow-settings-qa-comparison-before.png` and `/tmp/minuteflow-settings-qa-comparison-after.png` (2080 × 790 px). Both source and implementation are present in each input and were inspected together.
- Combined focused comparison: `/tmp/minuteflow-settings-qa-focused-after.png` (1640 × 450 px), covering page headings, text hierarchy, section rules, list anatomy and actions at readable scale.
- Readability correction evidence: `/tmp/minuteflow-settings-qa-general-before.png`, `/tmp/minuteflow-settings-qa-general-after.png`, and `/tmp/minuteflow-settings-qa-contrast-comparison.png` (1556 × 465 px, same glossary/license regions before and after).
- Existing responsive evidence from the implementation pass: `/tmp/minuteflow-settings-v2-800.png`, `/tmp/minuteflow-settings-v2-mobile.png` (390 × 844), and the in-app-browser mobile form/validation capture. The full implementation pass verified five categories, the addition/editor/back paths, keyboard model selection, multiline terminology and Escape persistence.

## State and intentional constraints

- The source contains illustrative saved transcription profiles; this browser's real local state has no STT profiles and one local-summary profile. Empty groups are intentionally omitted; no fake saved providers were inserted to imitate the source. The missing three rows are a data-state difference, not broken rendering.
- Source design and implementation share two columns, persistent five-category navigation, a single content pane, warm white/coral surfaces and restrained inset rows. The source image is a direction reference, not a literal data fixture.
- The implementation retains the recorded compact desktop type contract: 23 px page title, 13 px controls and 12 px secondary copy (saved service titles 14 px). Generated image lettering and the normalized source navigation are larger. This is an explicit density constraint recorded with the implementation, not a claim of pixel-exact ImageGen text matching.
- The five settings pages retain their actual product functions; general/privacy/update content is an extension of the same shell rather than invented content copied from the STT overview.

## Findings and comparison history

1. **[P2 — fixed] Small secondary copy was too faint.**
   - Location: glossary hints, licensing/device constraints, page descriptions, provider/model metadata and empty-state copy in `src/components/settings/settings.css`.
   - Evidence: in-app DOM/computed styles showed 12 px text at `#93887e` and `#9a8e83`, with white-background contrast ratios of approximately 3.46:1 and 3.20:1; the page subtitle used `#817b76` (4.18:1). The combined pre-fix comparison also showed substantially paler secondary copy than the reference direction.
   - Impact: required constraints and next-step guidance were harder to read, especially at the retained compact desktop text size.
   - Fix: applied a shared `--settings-muted: #746d66` to these text roles and active text actions, including download metadata, empty-model hints, local-test guidance and empty service states. This yields approximately 5.09:1 on white; small text remains readable on the existing near-white tinted surfaces. The default badge text was deepened separately without changing its peach background.
   - Post-fix evidence: final computed styles report `rgb(116,109,102)` for page descriptions, glossary hints, licensing constraints and the STT empty state. Same-state screenshots and the combined before/after contrast board show stronger secondary copy while preserving geometry and interaction hierarchy.
2. **Final comparison:** the normalized full-view and focused source/implementation inputs were re-opened after the fix. No additional actionable P0/P1/P2 findings remain within the recorded typography, real-data and platform constraints.

## Required fidelity surfaces

- **Fonts and typography:** system/PingFang fallback, existing optical weight hierarchy and the 23/13/12 scale are retained. The correction changes colors, not font metrics or wrapping. Sidebar titles, header descriptions, form labels, hints and active text actions remain readable; no browser-default control font was introduced.
- **Spacing and layout rhythm:** the 192 px category rail, aligned 34 px content gutters, inset rows, fine separators, 17 px dialog radius and scrollable content region remain unchanged. Lists, adding and editing are distinct steps with one return path. The intentional empty state contains no fabricated cards.
- **Colors and visual tokens:** warm neutral surfaces and coral primary/selected states remain intact. The shared muted token replaces a scattered set of pale grays; errors, verified state and disabled controls keep their semantic treatments.
- **Image quality and asset fidelity:** this settings surface has no bitmap content assets. Existing Phosphor interface icons and the MinuteFlow wordmark remain sharp and aligned; no CSS drawing, emoji, new logo or rasterized UI was introduced. Source generic icons map to the product's existing icon family rather than becoming custom artwork.
- **Copy and content:** all five category labels and the distinction between 转录设置, AI 总结 and AI 纪要 are preserved. Local/online consequences and errors remain actionable. The source's sample saved-service text is intentionally replaced by actual stored profile data and the corresponding empty state.

## Verification and residual gaps

- In-app browser captures and computed-style inspection confirmed the corrected values; the preview remains open on 通用设置.
- The complete implementation pass checked navigation, keyboard focus, adding/back paths, missing-key and endpoint validation, no duplicate validation banner, local model setup, glossary line breaks and Escape persistence. 800 px and 390 px captures confirmed no dialog overflow and usable scrolling/actions.
- Console review during the implementation pass found one historical Vite hot-reload error from creating a stylesheet before its import existed; it was resolved. The final rendered page had no framework overlay, and the final production build succeeds.
- Current change is CSS-only plus this report and the durable design note; production build and whitespace checks passed after the final token correction. The prior 189 unit tests and 4 Sites packaging tests passed for the full implementation pass; they were not rerun for a text-color-only change.
- Real provider requests, macOS/Windows permission transitions, paid activation/refund actions, update installation, native VoiceOver and maximum OS text scaling were not exercised.

## Implementation checklist

- [x] Preserve the two-column shell and separate service-list/add/editor steps.
- [x] Normalize and inspect combined source/implementation views and a focused region.
- [x] Correct the P2 secondary-text readability finding.
- [x] Re-capture at the same state/viewport and verify the final computed text colors.
- [x] Preserve user configuration; no dummy providers or credentials were saved.

final result: passed

---

# Design QA — 设置草稿续填与键盘边界（2026-11-05）

## Evidence and state

- Visual source for this incremental pass: the previously verified settings shell, captured before editing at `/tmp/minuteflow-settings-draft-before.png` (956 × 664 px). Original art direction remains the settings reference recorded in `AGENTS.md`.
- Implementation: `/tmp/minuteflow-settings-draft-after.png` (956 × 664 px), same AI 总结 overview, one existing local-summary profile, plus an intentionally edited but unsaved online form. All test drafts were discarded; no test provider or credential was saved to the backend.
- In-app browser CSS viewport and exported pixel dimensions both equal 956 × 664. The responsive dialog is 924 × 632, x=16, y=16. No density resampling was needed.
- Combined comparison: `/tmp/minuteflow-settings-draft-comparison.png` (1848 × 662), with matching dialog crops `(16,16)–(940,648)` side by side, inspected together.
- Focused comparison: `/tmp/minuteflow-settings-draft-focused.png` (1400 × 370), same content region before/after at native size.
- Final mobile evidence: `/tmp/minuteflow-settings-draft-mobile-final.png` at 390 × 640. A prior 390 × 844 override exceeded the visible host capture height and produced a black compositor region; that capture was rejected as full-frame evidence. The final 640 px capture fits the host surface, shows the entire dialog, and preserves working continue/discard controls.

## Findings and comparison history

1. **[P2 — fixed] Returning from an edited new service had no continuation entry.** Editing a model name and returning showed only saved services; choosing 添加服务 again reset the form. Added a distinct 本次设置草稿 section. Multiple new configurations retain independent session identities; edits to saved profiles retain their own existing row with 未保存更改. These records are renderer-memory state only, cleared when settings closes. Local services that already save immediately do not create redundant pending drafts.
2. **[P2 — fixed] Escape closed settings from the profile menu.** Escape now dismisses the active menu first and returns focus to 更多操作. The native in-app-browser test confirmed the menu disappears while the settings dialog remains open.
3. **[P2 — fixed] Hidden disclosure controls broke focus wrapping.** An initial visibility filter based on layout rectangles still admitted Chromium controls inside closed details, leaving Shift+Tab stuck on the first navigation button. Final filtering explicitly checks every closed disclosure ancestor, admits its direct summary, and excludes hidden/inert/disabled controls. Post-fix native Shift+Tab from the first settings button lands on 浏览全部模型与下载选项; Tab returns to 通用设置.
4. **[P3 — fixed] Discarding a draft removed the focused control.** Focus now moves to the next draft or 添加服务. Restoration of saved edits similarly moves focus back into the form. The mobile discard test confirmed focus lands on 添加服务 rather than the document body.

## Fidelity surfaces and intentional extension

- Typography: existing system/PingFang hierarchy and 14 px service titles / 12 px secondary copy are preserved. The added draft row uses the existing row anatomy; empty custom names fall back to 未命名配置.
- Layout and spacing: category rail, page heading, gutters, border radii and inset lists match the before image. The only intentional extra content is the draft group above saved services. Continue is one keyboard action per row; the visible trailing label shares that same action, and discard stays independent.
- Colors: the corrected shared muted-text token remains in use. A restrained warm border identifies transient drafts; saved/default states and semantic error colors remain unchanged.
- Assets: the only added icon is the existing Phosphor pencil, with the same size/style family as neighboring interface icons. No raster artwork or fabricated product assets were introduced.
- Copy: 本次设置草稿 communicates the session lifetime; 继续配置, 放弃未保存配置, 未保存更改 and 还原更改 describe actual behavior. Credentials are never displayed in the list or serialized with these drafts.

## Checks and residual gaps

- Browser-verified: model text survives back/resume; separate STT and LLM drafts keep their corresponding model fields; two new forms coexist; discard removes only the selected draft; menu Escape preserves settings; closed-details focus wrapping works both directions; 390 px continue/discard works without horizontal overflow; closing/reopening clears the transient group.
- Test credentials were dummy values and remained masked. The browser redacts password values even in read-only DOM evaluation, so exact secret-string equality was not claimed as browser evidence. Draft identity and credential-related dirty state have targeted unit coverage.
- No real online saved profile was present, so saved-profile restoration UI was not exercised against a real credential; baseline restoration logic and verification/default-metadata exclusions were covered by the targeted tests.
- Type checking, production build, 10 targeted draft/configuration unit tests and 4 Sites packaging tests passed. Core provider calls, operating-system permission changes, activation and update installation were not executed.
- Full-view and focused before/after inputs were inspected after the final changes. No actionable P0/P1/P2 findings remain in the tested states.

final result: passed


---

# Design QA — 添加说话人分离无法操作修复（2026-11-05）

## Evidence and correction

- Before: `/tmp/minuteflow-diarization-before.png`. The browser catalog contained no diarization entries, leaving the recommended-model region empty. File selection returned null and scanning returned empty results without explaining the missing native capability.
- After: `/tmp/minuteflow-diarization-after.png`, 956 × 664. Both ONNX model slots now render immediately, with model descriptions, size/license metadata, separate file selectors and download buttons, plus 检测本机 and 下载并配置两个模型. The existing settings rail, warm surfaces, typography and inset rows are retained; this is a functional repair rather than a new visual direction.
- Browser-verified: entering the page shows both slots; detection, file choice and download each produce an explicit desktop-capability message rather than silently doing nothing. A failed download exposes 重试下载. Returning to the list and reopening clears stale operation feedback.
- Narrow-layout check: at a 390 × 640 viewport, both cards measure 330 px wide with matching 330 px scroll width. File and download actions wrap without horizontal overflow. The host compositor scaled the exported narrow screenshot (`/tmp/minuteflow-diarization-mobile.png`), so it is not claimed as native-density visual evidence. The viewport override was reset and the final desktop page was left open.

## Persistence and validation

- Desktop downloader and renderer now share the same two-model catalog, retaining official download URLs and SHA-256 metadata. Catalog failures have visible retry feedback.
- Automatic detection merges both paths into one save. Sequential downloads retain the saved id and prior path; explicit model-slot selection removes ambiguous filename inference.
- Seven targeted tests pass: atomic detection, sequential persistence, installed-model preference, explicit slot mapping, shared browser catalog metadata, immediate rendering, and browser capability errors. Type checking passes. The combined focused/core run previously passed 190 tests before the final immediate-render assertion was added; production build and all four Sites packaging tests passed.
- Real native file dialogs, model downloads and ONNX inference were not exercised in this browser verification. The browser preview does not fabricate installed models or native file paths.

final result: passed for the tested configuration states
