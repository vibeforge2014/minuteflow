# Website scroll UX audit · 2026-08-02

## Scope and user goal

- Surface: public product homepage, product specifications, mobile navigation, and the former browser demo boundary.
- Goal: make long-form website content reliably scrollable by wheel, trackpad, touch, keyboard, section links, and deep links without changing the fixed three-column Electron workspace.
- Browser: Codex in-app browser.

## Evidence

1. Homepage before refactor: `audit-scroll-before.png` (1280 × 720).
2. Specifications before refactor: `audit-scroll-specs-before.png` (1280 × 720).
3. Homepage after refactor, top state: `audit-scroll-after-top.png` (1280 × 720).
4. Homepage after refactor, scrolled state: `audit-scroll-after-gesture.png` (1280 × 720).
5. Homepage after refactor, mobile state: `audit-scroll-mobile-after.png` (390 × 844).

## Findings and changes

### Step 1 · Enter the homepage · repaired

- The page contained 6132 px of content in a 720 px viewport, but the root `html` element still computed to `overflow-y: hidden` from the desktop application shell.
- The marketing container also computed as an unintended scroll container because `overflow-x: hidden` forced its vertical overflow to `auto`.
- The website now activates a route-specific native document scroll mode on both `html` and `body`; the marketing container uses `overflow-x: clip` and visible vertical overflow.

### Step 2 · Browse long-form sections · improved

- Wheel, trackpad, touch, and page-level scrolling now target the document scrolling element.
- The floating navigation becomes slightly more compact after the first 24 px of scrolling, preserving context without consuming as much vertical space.
- A visible return-to-top control appears after scrolling and is removed from the tab order while hidden.

### Step 3 · Navigate the specification page · improved

- The sticky section directory now updates the URL and active state together.
- Direct links such as `#/specs/data` restore the requested section after reload, with the section positioned below the floating header.

### Step 4 · Use the site on mobile · verified

- The 390 × 844 layout keeps a 7012 px native document scroll range.
- The compact menu opens and closes correctly; selecting “功能” closes the menu, updates the hash, and positions the section below the header.
- Touch-size navigation and the return-to-top control remain reachable without covering the primary content.

### Step 5 · Follow an old online-demo link · retired

- The public `#/app` route and every visible online-demo entry point were removed after the online experience was discontinued.
- An old `#/app` URL now returns to the public homepage; the Electron application continues to use its fixed viewport and independently scrolling panes.

## Accessibility notes and limits

- Added a keyboard-visible “跳到主要内容” link and focusable main landmarks.
- Added `aria-current="location"` to the active specification entry and a named return-to-top button.
- Reduced-motion preferences disable smooth scrolling and transition-heavy motion.
- Screen-reader announcements and physical iOS/Windows gesture behavior still require device-level validation; the browser audit confirms DOM semantics, responsive reflow, and simulated scrolling only.

final result: passed
