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
