# Frame of Reference

A Chrome extension that lets you point at any UI element and copy a compact, LLM-ready reference to your clipboard. Then paste it into your LLM and ask for the change you want.

**3 steps, no setup, low token cost.**

1. Click the extension icon
2. Click the element you mean
3. Paste into your LLM

## What gets copied

```text
# Frame of Reference (UI element reference)
Path: /#search (page route)
Target: combobox "Query mode" (selected element)
Exact: example.com##button[aria-label="Query mode"] (CSS selector)
Region: search "Query input" (parent container)
```

Each line serves a purpose: `Path` gives page context, `Target` describes what you selected, `Exact` is a precise CSS pinpoint, and `Region` shows the surrounding container. A `Locator` fallback only appears when the CSS selector is too complex.

When supported by Chrome and the paste target, the clipboard also includes a cropped screenshot of the selected element alongside the text reference. If rich clipboard image copy is unavailable, the extension preserves the text-only copy path.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder (contains `manifest.json` at root)
5. Pin Frame of Reference in the toolbar

## Usage

1. Click the Frame of Reference icon
2. Hover until the right element is highlighted (red border + grey overlay)
3. Use `ArrowUp`/`ArrowDown` to widen or narrow the selection
4. Click or press `Enter` to copy
5. Press `Esc` to cancel

**Keyboard shortcut:** `Alt+Shift+F` toggles the picker. If another extension uses that combo, remap it at `chrome://extensions/shortcuts`.

## How it works

- Scores the full element stack under your cursor to pick the most useful target
- Promotes interactive elements (buttons, inputs, links) over raw text nodes
- Prefers surrounding UI blocks (cards, panels) when you hover plain text
- Traverses open shadow roots and accessible iframes
- Strips tracking params (`utm_*`, `fbclid`, etc.) from the copied path
- No build step, no dependencies at runtime

## Project layout

```
manifest.json      Chrome extension manifest (MV3)
background.js      Service worker (~260 lines)
content/picker.js  Core picker logic (~3300 lines, single IIFE)
icons/             Extension icons (SVG + PNGs)
```

## Limitations

- Does not run on `chrome://` pages
- Closed shadow roots are inaccessible
- Cross-origin iframe access depends on browser permissions
- Requires a pointer device (mouse, trackpad, or touchscreen) to select elements

## License

MIT
