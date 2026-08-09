# Design QA — 设置菜单优化

## Evidence

- Source visual truth: `/var/folders/br/w5xj47hx5rn3sg6zmvz51k900000gn/T/codex-clipboard-ba97512b-1b7e-4bf5-8e26-90d065a39e23.png`
- Supporting references: the seven additional settings screenshots supplied in the same request.
- Existing product visual truth: `/Users/zqian15/.codex/generated_images/019fb0bc-fbcb-7e43-9466-3ebdf9e5dba6/call_1Z4kzuiPHEUQd1XCaaJAnBNL.png`
- Final implementation screenshot: `/Users/zqian15/Documents/会议助手/design-qa-settings-models-final.png`
- Combined source/implementation comparison: `/Users/zqian15/Documents/会议助手/design-qa-settings-comparison.png`
- Source pixels: 1788 × 1190.
- Implementation screenshot pixels: 1280 × 720.
- Browser viewport override: 1280 × 800 CSS px; browser content capture: 1280 × 720 px.
- Density normalization: both images were decoded at native density; the source was proportionally scaled into a 1280 × 800 panel and the implementation was fit to the adjacent 1280 × 800 panel for the combined comparison.
- State: desktop settings dialog open on “模型与转录”, OpenAI selected, light theme.

## Findings

- No actionable P0, P1, or P2 findings remain.
- Fonts and typography: the implementation retains MinuteFlow's system Chinese type stack and lightweight-document hierarchy. It intentionally uses smaller, calmer UI text than the dark reference while preserving readable labels and clear heading weights.
- Spacing and layout rhythm: the reference's category navigation, secondary provider list, and focused editor anatomy are preserved. The implementation uses a 210 px category rail, 248 px service catalog, and flexible editor; controls remain fully visible without clipping at the tested viewport.
- Colors and visual tokens: competitor purple/dark tokens were intentionally replaced with MinuteFlow's warm off-white surfaces, `#E76F51` accent family, pale peach selection, and semantic green enabled state.
- Image quality and asset fidelity: the screen contains no required raster imagery. All interface icons use the existing Phosphor icon library; no emoji, CSS art, handcrafted SVG, or placeholder asset was introduced.
- Copy and content: labels were adapted to MinuteFlow's actual capabilities—local Whisper, `.pt` runtime, New API, DeepSeek, Ollama, local retention, and operating-system permissions—without adding unsupported settings.
- Accessibility: the settings category navigation is labelled, active states are visually distinct, primary controls retain visible focus treatment, and form inputs keep associated labels.

## Full-view comparison evidence

- The source and implementation were opened together in `/Users/zqian15/Documents/会议助手/design-qa-settings-comparison.png`.
- Both show the same high-level task flow: category selection → provider/model selection → focused credentials and model configuration.
- The implementation deliberately preserves the existing app behind a modal layer instead of changing the entire workspace route, which keeps the settings task contextual and reversible.

## Focused-region comparison evidence

- A separate crop was not required: at original resolution, the combined comparison keeps the complete provider catalog, field labels, input geometry, selected state, and action area legible.
- The model action area was inspected separately in the browser after the first pass.

## Comparison history

1. First pass — P2 action hierarchy: when no saved secret existed, CSS grid placement allowed “测试连接” to consume the remaining row width while “保存配置” stayed narrow, reversing the intended emphasis.
2. Fix — changed the action group to flex layout, reserved flexible space before the actions, and set stable minimum widths of 100 px for secondary actions and 120 px for the primary save action.
3. Post-fix evidence — `/Users/zqian15/Documents/会议助手/design-qa-settings-models-final.png` shows balanced right-aligned actions with “保存配置” as the strongest action. No P0/P1/P2 issues remain.

## Primary interactions tested

- Opened settings from the meeting library.
- Switched between “模型与转录” and “通用设置”.
- Selected DeepSeek from the service catalog and verified the name and Base URL changed to the preset values.
- Verified the clean browser session rendered the final settings state with zero console errors.

## Implementation checklist

- [x] Persistent category navigation.
- [x] Secondary service/model catalog.
- [x] Focused configuration pane with working presets.
- [x] Grouped general and privacy settings cards.
- [x] Local-first privacy explanation.
- [x] Build, Sites packaging, core tests, and browser verification.

## Follow-up polish

- P3: provider-specific brand marks could be added later if the product adopts an approved asset set; the current consistent icon treatment is acceptable and avoids unlicensed logo use.

## Follow-up QA — 本地运行路径降级为高级设置

- Feedback source: `/var/folders/br/w5xj47hx5rn3sg6zmvz51k900000gn/T/codex-clipboard-5cf7b466-6695-40d5-9e25-e35ae45e7544.png` (686 × 440 px).
- Browser implementation: `/Users/zqian15/Documents/会议助手/design-qa-settings-whisper-advanced-collapsed.png` (855 × 858 px).
- Focused side-by-side comparison: `/Users/zqian15/Documents/会议助手/design-qa-settings-whisper-comparison.png` (1392 × 440 px).
- State: “Whisper .pt” selected; automatic discovery, file selection, and verified downloads visible; manual runtime paths collapsed.
- Viewport: current Codex in-app browser desktop viewport; browser screenshot returned at 855 × 858 px.
- Density normalization: the feedback crop remained at native 686 × 440; the matching implementation region was cropped from the browser screenshot and normalized to 686 × 440 for focused comparison.
- Full-view evidence: the full browser capture shows the revised local-model setup inside the complete three-column settings layout with no clipping or modal overflow.
- Focused evidence: the comparison shows the three path fields removed from the normal flow and replaced by one low-emphasis disclosure after the guided setup controls.
- Fonts/typography: the disclosure uses the existing compact UI weight and remains subordinate to model discovery and download actions.
- Spacing/layout: hiding the path fields removes unnecessary vertical form length and keeps save/test actions in the visible region.
- Colors/tokens: the disclosure uses the established warm neutral card surface and border, without introducing another accent.
- Image/assets: no new raster asset or custom icon was required.
- Copy/content: “仅在自动发现失败或需要使用自定义运行环境时填写” explains when the advanced controls are relevant.
- Interaction: verified the disclosure expands to expose Python executable, model-file, and FFmpeg paths, then returns to the collapsed default state.
- Console errors: none.
- Comparison history: initial user evidence identified a P2 progressive-disclosure issue; the fields were moved into a collapsed troubleshooting section; post-fix comparison shows no remaining P0/P1/P2 issue.

## Follow-up QA — 统一本地 Whisper 入口

- Source state: `/Users/zqian15/Documents/会议助手/design-qa-settings-whisper-advanced-collapsed.png` (855 × 858 px), showing separate Whisper and Whisper `.pt` service cards.
- Final implementation: `/Users/zqian15/Documents/会议助手/design-qa-settings-whisper-unified.png` (855 × 858 px).
- Same-size comparison: `/Users/zqian15/Documents/会议助手/design-qa-settings-whisper-unified-comparison.png` (1730 × 858 px).
- Viewport/density: both captures come from the same Codex in-app browser desktop viewport and require no density normalization.
- State: local transcription selected, guided model discovery visible, advanced runtime paths collapsed.
- Full-view evidence: the local-transcription catalog now contains exactly one selected “本地 Whisper” card; the editor heading and name use the same product concept.
- Focused evidence: the previous protocol control exposed “本地 Whisper（Python / .pt）”; the final editor instead presents the read-only “自动适配模型文件” behavior.
- Fonts/typography: removing the second product name reduces label competition and keeps the catalog hierarchy consistent with online services.
- Spacing/layout: the single local card eliminates redundant vertical space without changing the established grid tracks or panel rhythm.
- Colors/tokens: selected, enabled, and read-only states continue to use the existing peach, green, and warm-neutral tokens.
- Image/assets: the existing Phosphor waveform icon is reused; no additional asset or custom icon was introduced.
- Copy/content: GGML, GGUF, and `.pt` remain documented as supported file formats, not separate products. Runtime implementation names are hidden from the default editor.
- Interaction: selecting the unified card initializes the guided local model flow; choosing or downloading a model still switches the underlying engine from its file type.
- Console errors: none.
- Comparison history: initial pass after merging the cards still exposed `whisper.cpp` in the protocol field (P2 conceptual leak); replaced it with a read-only automatic-runtime explanation; final comparison has no remaining P0/P1/P2 issue.

## Follow-up QA — 拆分 AI 总结与转录设置

- Source state: `/Users/zqian15/Documents/会议助手/design-qa-settings-whisper-unified.png` (855 × 858 px), where local transcription and AI providers shared one “模型与转录” page.
- AI-summary implementation: `/Users/zqian15/Documents/会议助手/design-qa-settings-ai-summary.png` (855 × 858 px).
- Transcription implementation: `/Users/zqian15/Documents/会议助手/design-qa-settings-transcription.png` (855 × 858 px).
- Three-state comparison: `/Users/zqian15/Documents/会议助手/design-qa-settings-split-comparison.png` (2605 × 858 px).
- Viewport/density: all captures use the same Codex in-app browser desktop viewport and pixel density; no normalization was required.
- State: settings dialog open in light mode; online OpenAI selected for AI summary and local Whisper selected for transcription.
- Full-view evidence: the previous mixed navigation and provider catalog are replaced by two independent top-level items. Each page keeps the established category rail → scoped service list → focused configuration structure.
- Focused evidence: no separate crop was required because the original-size comparison keeps navigation labels, local/online section labels, provider names, read-only outcome fields, and primary form controls legible.
- Fonts/typography: “AI 总结” and “转录设置” use the same weight and icon rhythm as other top-level settings; local/online labels remain subordinate section headings.
- Spacing/layout: adding one navigation row does not overflow the category rail. Provider lists are shorter and leave more stable whitespace than the mixed catalog.
- Colors/tokens: both pages reuse the same warm selected state, neutral read-only controls, and semantic enabled indicator.
- Image/assets: only existing Phosphor Sparkle and Waveform icons are used; no custom or placeholder asset was introduced.
- Copy/content: AI summary describes meeting organization and action items; transcription describes speech-to-text. Each page explicitly separates “在本机运行” from “在线服务” and filters presets and saved profiles by task.
- Interaction: verified switching between both top-level pages; AI local Ollama hides API credentials and retains its local Base URL; online OpenAI summary exposes credentials; online OpenAI Whisper exposes credentials and return format; LLM-only providers do not appear on the transcription page.
- Console errors: none.
- Comparison history: first implementation split the pages but still exposed a mixed protocol chooser and displayed every preset as “自定义配置” (P2 conceptual duplication); replaced protocol choice with task-aware read-only connection wording and bound the preset selector to the active provider; no P0/P1/P2 issue remains.

final result: passed
