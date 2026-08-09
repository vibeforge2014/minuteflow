# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Product Decisions

- The product is a local-first Electron desktop meeting assistant for Windows 10 22H2+ and macOS 14.2+.
- Use the selected “lightweight document” visual direction from `/Users/zqian15/.codex/generated_images/019fb0bc-fbcb-7e43-9466-3ebdf9e5dba6/call_1Z4kzuiPHEUQd1XCaaJAnBNL.png` as the source of truth.
- The live meeting view keeps a meeting library on the left, an editable document in the center, live transcript/AI tabs on the right, and a floating recording toolbar at the bottom.
- Data is stored locally by default. Remote model calls only occur after the user configures a provider.
- Chinese and mixed Chinese/English meetings are the first-release language priority.
- The iOS edition is a native SwiftUI universal app targeting iOS/iPadOS 18+, with an adaptive iPhone navigation stack and a three-column iPad workspace.
- The iOS edition remains local-first, uses SwiftData for meeting content, Apple Speech for the built-in transcription path, and Keychain for third-party API credentials.
- iOS records microphone audio only; it must not imply that it can capture another app's protected system audio.
- The iOS edition's overall color system should follow the local TuneSync iOS app: restrained neutral surfaces, TuneSync's warm orange primary tint, soft tinted cards, and semantic status colors, while preserving the meeting assistant's existing layout and information hierarchy.
- The public product site uses an Apple-inspired, restrained visual language: system typography, lightweight document surfaces, translucent floating navigation, immediate press feedback, critically damped-feeling transitions, and full reduced-motion/transparency support.
- On macOS, the Electron title bar must reserve clear space for the native close/minimize/zoom controls; product branding and interactive elements must never overlap the traffic lights.
- Desktop transcription setup should prioritize guided presets: discover local Whisper models, support GGML/GGUF through whisper.cpp and OpenAI Whisper `.pt` checkpoints through the Python runtime, offer verified in-app model downloads, and retain an advanced manual-path fallback.
- Remote transcription and meeting-summary providers must include first-class New API presets and tolerate common OpenAI-compatible endpoint and response-shape variations.
- Personal meeting notes must preserve Markdown source, support `.md` import, render Markdown safely, and remain editable and locally persisted.
- Recording finalization must wait for all pending audio chunks to reach disk before closing or renaming files, so stopping a meeting cannot lose the final chunk or leave an unsavable recording.
- The meeting assistant logo follows TuneSync's friendly coral-orange rounded tile, soft dimensional material, and generous icon spacing, while using an original raised meeting-document-and-waveform symbol across desktop, web, loading, and favicon surfaces.
- The public product site and browser-based meeting workspace use TuneSync's `#E76F51` warm-orange accent, deeper accessible coral for filled actions, warm off-white surfaces, and pale peach selected states; blue remains only where it conveys speaker identity or another distinct semantic category.
- The public product site uses native document scrolling with reliable wheel, trackpad, touch, keyboard, deep-link, and scroll-restoration behavior; its scroll mode stays isolated from the fixed-viewport Electron workspace, and the public site does not offer a browser-based online meeting demo.
- The macOS app checks a validated JSON update manifest hosted on the official product site at startup and on demand. Until releases are Developer ID signed and notarized, updates are never silently installed: the app opens a stable official-site download URL that resolves to the current DMG, and only allow-listed HTTPS release hosts are accepted.
- The desktop app has two distinct access walls: a first-run operating-system permission guide for microphone and macOS system-audio/screen-capture access, plus a ¥99 RMB one-time purchase wall for recording, transcription, AI summaries, processed audio imports, and exports.
- Paid entitlement must be enforced in the Electron main process as well as the renderer. Paddle secrets never ship in the client; activation uses an HTTPS verification service, encrypted local license storage, periodic revalidation, and a bounded offline grace period.
- Desktop settings use a clear settings-workbench structure: a persistent category sidebar, a secondary service/model catalog where selection is needed, and a focused configuration pane. Keep this information architecture in the product's warm, light, local-first visual system rather than copying dark competitor branding.
- Local transcription setup keeps executable, model-file, and FFmpeg paths out of the default flow. Prioritize automatic discovery, verified downloads, and file selection; expose manual paths only inside a collapsed troubleshooting section.
- Present local Whisper as one user-facing transcription option. Detect or switch between whisper.cpp GGML/GGUF and Python `.pt` runtimes from the selected model automatically; do not expose them as separate products in the service catalog.
- AI summarization and transcription are separate top-level desktop settings. Each page must offer clearly labelled “run on this device” and “online service” choices, filter presets and saved profiles to that task, and describe the user outcome before exposing provider or protocol details.
