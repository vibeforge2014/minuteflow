# Design QA — 桌面核心会议工作流三态重设计

## Evidence

- Source visual truth: `/Users/zqian15/.codex/generated_images/019fb0bc-fbcb-7e43-9466-3ebdf9e5dba6/call_1Z4kzuiPHEUQd1XCaaJAnBNL.png`
- Final implementation screenshot: `/Users/zqian15/.codex/visualizations/2026/08/23/01a02eb7-37ad-7a93-8cdc-2ef4a7285bc3/minuteflow-qa/live-populated-1440x1024.png`
- Combined full-view comparison: `/Users/zqian15/.codex/visualizations/2026/08/23/01a02eb7-37ad-7a93-8cdc-2ef4a7285bc3/minuteflow-qa/comparison-full.png`
- Focused header/document comparison: `/Users/zqian15/.codex/visualizations/2026/08/23/01a02eb7-37ad-7a93-8cdc-2ef4a7285bc3/minuteflow-qa/comparison-header.png`
- Focused recorder/action comparison: `/Users/zqian15/.codex/visualizations/2026/08/23/01a02eb7-37ad-7a93-8cdc-2ef4a7285bc3/minuteflow-qa/comparison-recorder.png`
- Supplementary states: `prepare-1280x720.png`, `new-meeting-1280x720.png`, `review-1280x720.png`, `review-1440x1024.png`, `review-1024x720.png`, and `live-1024x720.png` in the same `minuteflow-qa` directory.
- Source pixels: 1487 × 1058.
- Implementation pixels: 1440 × 1024 at a 1440 × 1024 CSS viewport and device pixel ratio 1.
- Density normalization: the source was Lanczos-scaled to 1440 × 1024; the implementation remained at native 1× density. The normalized frames were placed side by side at 2880 × 1024.
- Primary comparison state: populated live meeting, light theme, left meeting library, notes-first center document, live transcript on the right, recording controls docked at the bottom.

## Findings

- No actionable P0, P1, or P2 findings remain.
- Fonts and typography: the implementation keeps the source's system-style Chinese sans-serif hierarchy, restrained weights, compact metadata, and document-first text density. The single 68 px title bar intentionally replaces the source's repeated in-document meeting title.
- Spacing and layout rhythm: the three-column proportions, lightweight dividers, document margins, transcript density, and compact action table remain aligned with the source. Stage-specific reordering is intentional: live meetings put personal notes before rolling minutes; review meetings put conclusions and actions first.
- Colors and visual tokens: the source's blue product accent is intentionally mapped to MinuteFlow's locked warm-orange palette, pale peach selection, warm off-white surfaces, and semantic green/red status colors. Contrast remains clear in primary actions and status badges.
- Image quality and asset fidelity: this workspace contains no required raster illustration or product imagery. The existing real MinuteFlow brand mark and Phosphor icon set are retained; no emoji, handcrafted SVG, placeholder asset, or CSS illustration was introduced.
- Copy and content: preparation guidance explains capture scope, permission status, and non-blocking missing transcription. Live and review copy distinguish rolling progress from user-triggered final minutes and never implies an automatic final AI call after stopping.
- Accessibility and behavior: tabs expose tab semantics, dynamic recording states use polite live regions, core recording controls are at least 40 px, visible focus styles remain, temporary transcript text cannot be edited, and reduced-motion rules suppress recording pulses and disclosure transitions.

## Full-view comparison evidence

- The combined image compares the reference and implementation in the same normalized live-meeting state and density.
- The implementation preserves the meeting-library/document/transcript skeleton, section rhythm, action-table geometry, live transcript anatomy, and bottom transport controls.
- Intentional product-plan changes are visible rather than drift: one editable title instead of two, no always-visible document toolbar, notes first while live, warm-orange primary actions, and a fixed non-overlapping recording region instead of a floating overlay.

## Focused-region comparison evidence

- `comparison-header.png` verifies the compressed single-title header, document metadata, notes anatomy, and right-panel tabs at readable scale.
- `comparison-recorder.png` verifies action-table density and that the bottom recorder keeps timer, capture tracks, transcription state, marker, pause, stop, and mini-window controls without covering document content.
- Responsive evidence at 1024 × 720 confirms the 350 px transcript drawer does not introduce horizontal overflow and does not cover the recording stop controls.

## Comparison history

1. First pass — P1 layout: closing the right panel left its full grid track reserved, producing a large blank area beside the preparation document.
   - Fix: made the app shell use two columns by default and add the third grid track only while the right panel is open.
   - Post-fix evidence: `prepare-1280x720.png` shows the preparation document expanding across the available workspace with no dead panel column.
2. Responsive pass — P1 control obstruction: at 1024 × 720 the fixed transcript drawer covered the recorder's pause/stop controls.
   - Fix: while the drawer is open below 1040 px, constrain the live recorder region to end exactly at the drawer's left edge.
   - Post-fix evidence: `live-1024x720.png` shows all persistent recorder controls visible and clickable; measured recorder right edge and drawer left edge both equal 674 CSS px.
3. Interaction pass — P2 implicit submit inconsistency: the browser WebView did not reliably submit the new-meeting form when Enter was pressed in the title field.
   - Fix: explicitly map Enter outside textareas to `requestSubmit()` with `startRecording=false`; the primary button still opts into immediate recording.
   - Post-fix evidence: browser verification created “三态工作流验收” in preparation state with no recorder bar and no right panel, while the primary button created a separate meeting and entered live recording.

## Primary interactions tested

- Enter creates only; the primary button creates and starts recording.
- Preparation permission/readiness display and non-blocking missing transcription.
- Start, pause, continue, two-step stop, safe-save review transition, and no automatic final summary.
- Transcript explicit edit/Escape exit, speaker management entry, follow control, and no-audio timestamp feedback.
- Continue-recording confirmation from the review overflow menu.
- Playback drawer, play/pause, and advancing local timeline in the Electron build.
- 1440 × 1024, 1280 × 720, and 1024 × 720 responsive layouts.
- Fresh in-app browser page console errors/warnings: none.

## Implementation checklist

- [x] Three-state workspace derivation and one-time stage layouts.
- [x] Preparation readiness and single primary action.
- [x] Simplified new-meeting flow with explicit Enter behavior.
- [x] Notes-first live workspace, readable transcripts, follow control, and docked recorder.
- [x] Conclusions-first review workspace, manual final summary, on-demand playback, and protected continuation.
- [x] Responsive transcript drawer and accessible persistent controls.
- [x] Typecheck, 61 core tests, production build, Sites packaging tests, browser QA, and Electron recording/player smoke.

## Follow-up polish

- P3: very long live goals are intentionally truncated into compact chips; a tooltip could expose their full text without increasing live-document density.

final result: passed
