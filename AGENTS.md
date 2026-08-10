# Mullion — notes for agents

Electron app. Read `README.md` first for what the thing does.

## Ground rules

- CommonJS, no build step. There is no bundler and no TypeScript; keep it that way.
- The renderer pages (`navigation.*`, `titlebar.*`, `qr.*`) run **sandboxed**
  with `contextIsolation: true`. Everything they can do goes through the named
  commands in `src/navigation-preload.js` (`src/qr-preload.js` for the QR
  window). Do not add a generic "send any channel" bridge.
- Never build renderer HTML with `innerHTML`. Page titles and URLs are
  attacker-controlled; `textContent` + `createElement` only.
- Remote pages live in their own session partition (`persist:mullion-content`)
  so nothing they store reaches the UI views. Anything fetched on a page's
  behalf — the favicon, for one — is fetched by the main process *in that
  partition* and passed to the UI as data. A UI view must never be pointed at a
  page-supplied URL, and a page-supplied URL must be scheme-checked before the
  main process fetches it: `session.fetch` follows `file:`.
- **`src/images.js` measures PNG and refuses everything else, on purpose.**
  Not an oversight and not a TODO: a JPEG can restate its size in a hierarchical
  frame header, leave it at zero and supply it after the first scan, or push a
  segment walk onto an offset of its choosing with bytes that are not markers.
  All legal. The format is refused because it cannot be measured cheaply and
  safely, and `test/images.test.js` keeps those shapes as cases so that anyone
  reinstating JPEG has to answer them first. Anything else parsed out of bytes a
  page chose belongs in a file like this one: no Electron import, a test per
  malformed case.
- **Content views run with no preload at all.** Both page gestures — the click
  that dismisses the navigation bar and the top-edge dwell that reveals it —
  come from `webContents` `input-event` in the main process, which a page can
  influence but not forge. Do not reintroduce a preload to read something the
  browser process already reports.
- **Neither route sees an out-of-process iframe.** Electron adds its input
  observer to the primary main frame's widget only, and Chromium routes a mouse
  event to the widget the hit test picked, so an embedded player swallows both
  gestures. A preload does not run there either. The only thing that would reach
  it is `nodeIntegrationInSubFrames`, which is experimental and widens the
  sub-frame's reach — it was tried and backed out. Do not write a comment
  claiming iframe coverage; check it against Electron's source first.
- Icons are Bootstrap Icons paths inlined as SVG in the markup. No webfont, no
  icon dependency, and no path data in the renderer scripts: a glyph the
  renderer has to build goes in a `<template>` and is cloned.
- **`resources/tray.png` is measured in points, not pixels**, so its height is
  the height the glyph gets in a 24pt menu bar. Sixteen is the number: at 32 it
  overflows and macOS crops it back to the bar, which is why enlarging the
  margin inside a 32px file changes nothing on screen — both versions render at
  the bar's full height and tower over every neighbouring icon. `tray@2x.png` is
  exactly double. Neither carries a margin of its own; the menu bar spaces its
  own items, and any margin in the file only makes the glyph smaller than the
  ones beside it. Check a change by measuring a screenshot of the bar against
  its neighbours (they sit at 15–18px), not by looking at the file.

## Testing

`src/cli.js`, `src/targets.js`, `src/scripts.js`, `src/qrcode.js`, and
`src/images.js` have no Electron imports so they can run under `node --test`. Keep new pure logic in
those files rather than in `main.js`, and add cases to `test/`.

```shell
pnpm test     # node --test
pnpm check    # node --check on every source file
```

There is no CI. `pnpm test` and `pnpm check` are the gate.

The app itself cannot be launched headlessly in the agent environment, and
macOS packaging cannot be verified on Linux — say so instead of claiming a
run happened.

## Things that are easy to get wrong

- **Script injection scope.** `--js` / `--playwright` run for the command line
  targets and on Restart, not on every navigation. Widening that silently would
  leak the user's automation onto every site they browse to.
- **`buildInjection` needs the newline before `})()`** or a script ending in a
  `//` comment loses its terminator. There is a test for it.
- **The Playwright shim is spliced into an async function body**, not required
  as a module. Only declarations are legal at its top level.
- **Layout is owned by the main process.** `relayout()` sizes every view; the
  renderer only hides the rows it was told to hide. The title bar, the tab
  strip, the toolbar and the page are stacked bands that never overlap, so
  nothing floats over the page.
- **The macOS window buttons are positioned by us** (`trafficLightPosition`).
  Their vertical placement is derived from `TITLE_BAR_HEIGHT`, so changing the
  height keeps the buttons centred without further work. The horizontal
  `TRAFFIC_LIGHT_INSET` does not follow: it and `TRAFFIC_LIGHT_HEIGHT` are
  measured values, and the main process sends the inset to `titlebar.js` in the
  state push. Re-measure both if the buttons change size.
- **The bar is not optional on `about:blank`.** `navigationVisible` is the
  current state and `navigationPinned` the standing choice that outlives the
  session; neither is touched by the rule. `isNavigationBarVisible()` is what
  the layout and the state push read, and it answers whether the bar is on the
  screen: `isBarForcedUp()` puts it up on a blank tab, which has nothing to show
  and no way out of it, and either kind of full screen overrides that — window
  full screen inside `isBarForcedUp()`, a page in full screen at the top of
  `isNavigationBarVisible()`, both because asking for the screen is asking for
  the screen. Nothing is refused, though: a dismissal on a blank tab records itself,
  the bar simply does not move until the tab has a page. That matters because
  `Cmd+T` pins the bar on the way to focusing the address field, so a refusal
  would leave a new tab's pin with no way to undo it, all the way into
  `settings.json`. The one exception is the click in the page, which is the only
  dismissal the user did not ask for by name: it is aimed at the page, and the
  guard on it (`isBarForcedUp()` and `htmlFullScreen` at the `mouseDown`) covers
  both cases where the click cannot take the bar down — held up by a blank tab it
  is on the screen and staying there, under a page in full screen it is gone
  already.
- **`isBarForcedUp()` is the one place the rule lives**, and `isBlankUrl()` in
  `targets.js` (with tests) is the one place the blank test lives. Both the
  visibility the layout reads and the guard that asks "is this dismissal about a
  bar the user can see" go through them, so the two cannot drift apart.
- **The title bar toggles against what is on the screen**, not against
  `navigationVisible`, and it is `toggle-navigation` in the main process that
  decides — one copy of the rule, and no mirrored state in the renderer. The two
  values disagree in two places: on a blank tab, where a bar can be up that
  nothing asked for, and under a page in full screen, where a bar that was asked
  for is off the screen. Only the first is reachable by clicking, since the title
  bar has no row in full screen, and there a click on a bar the user is looking
  at has to put it away — otherwise it answers the opposite of what was asked and
  writes a pin into `settings.json` that was never wanted. `Cmd+L` is what pins
  from there.
- **A URL change can resize the chrome**, which is why `syncNavigationState()`
  calls `relayout()` when a tab crosses into or out of `about:blank`. The
  renderer can only hide a row; the band it sits in is sized by the main
  process, so a state push on its own leaves the page with a gap above it.
- **The unpackaged app is named by renaming Electron's own bundle directory**
  (`scripts/brand-dev-bundle.js`, run from `postinstall`), so in a dev checkout
  it is `node_modules/electron/dist/Mullion.app`. The menu bar reads
  `CFBundleName` / `CFBundleDisplayName` out of the plist, but the Dock tile
  ignores those and follows the directory name — measured both ways round.
  `node_modules/electron/path.txt` is rewritten with it, since that is how
  `require('electron')` finds the binary. `app.setName()` reaches none of this.
- **Do not rename the executable inside that bundle.** `app.isPackaged` is
  derived from its name, and `main.js` reads that flag to decide how much of
  `argv` belongs to Electron and whether to set the Dock icon itself. Renaming
  the binary makes a development run think it is packaged, and the app path
  arrives at the CLI parser as a target — every launch opens a dead `file://`
  tab. It does nothing for the Dock name either; the directory is what counts.
- **`src/qrcode.js` is checked two ways, and only one of them proves spec
  compliance.** The round-trip decoder in `test/` shows the encoder is
  self-consistent, which a mistake mirrored on both sides passes unnoticed.
  Conformance rests on `test/fixtures/qrcode-vectors.json`: whole matrices from
  an unrelated implementation, compared module for module. Touching the encoder
  means adding a fixture, not another round trip.
