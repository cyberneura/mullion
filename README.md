# Ostinato

A frameless browser window for leaving a page playing.

Ostinato opens a URL or a local file in a window with no visible browser UI —
just the page. The navigation bar appears when you ask for it and gets out of
the way again. It can run a script after the page loads, and it can live in the
menu bar instead of the dock.

The name is the musical term for a figure that repeats over and over.

## Install

```shell
pnpm install
pnpm start -- https://example.com
```

To get an `ostinato` command:

```shell
pnpm link --global
ostinato https://example.com
```

## Usage

```
ostinato [options] [target ...]
```

A target is a URL (`https://example.com`, or just `example.com`), a local file
path, or `-` to read HTML from standard input. Several targets open as several
tabs.

| Option | Meaning |
|---|---|
| `--width <px>` / `--height <px>` | window size (default 1280×720) |
| `--x <px>` / `--y <px>` | window position (default: centred) |
| `--html <string>` / `--html-file <path>` | show HTML instead of a target |
| `--title <string>` | pin the window title so the page cannot change it |
| `--always-on-top` | keep the window above others |
| `--zoom <factor>` | zoom factor (default 1.0) |
| `--navigation` | start with the navigation bar shown |
| `--frame` | keep the normal OS window frame |
| `--new-window` | open a new window even if an instance is already running |
| `--menubar` | run as a menu bar / tray application |
| `--restore` | reopen the pages from the previous session |
| `--js <code>` / `--js-file <path>` | run JavaScript after the page loads |
| `--playwright <code>` / `--playwright-file <path>` | run Playwright-compatible code after the page loads |
| `--js-every-load` | re-run the scripts after every navigation |
| `--open-devtools` | open developer tools on start |

### Showing the navigation bar

Nothing is visible by default except a small handle in the top-right corner: a
drag strip and a `▼` button.

| Action | Result |
|---|---|
| Click `▼` | show the bar and keep it |
| Rest the pointer on the top 4px for 300ms | show the bar until the pointer leaves |
| `Cmd/Ctrl+L` | show the bar and focus the address field |
| `Cmd/Ctrl+T` | new tab, with the address field focused |
| `Esc` | hide the bar |
| A second tab exists | the tab strip stays visible on its own |

`Cmd/Ctrl+R` reloads, `Cmd/Ctrl+W` closes a tab, `Cmd/Ctrl+[` and `Cmd/Ctrl+]`
go back and forward. Everything except `Esc` is also in the application menu.

Text in the address field that does not look like a URL is sent to Google;
the search engine is not configurable yet.

### Running a script after load

```shell
# raw JavaScript
ostinato https://example.com --js 'document.querySelector("video").play()'

# Playwright-compatible
ostinato https://example.com --playwright-file ./start-playing.js
```

Both options can be given together and any number of times; the scripts run in
the order they appear on the command line.

By default the scripts run for the pages named on the command line and again
when you pick **Restart**, but *not* for pages you reach by clicking links —
otherwise your automation would follow you onto every site you visit. Pass
`--js-every-load` if you do want that.

#### What "Playwright-compatible" means here

Real Playwright drives a browser from the outside. Ostinato is already inside
the page, so the API is re-implemented against the DOM. The scripted-interaction
subset works unchanged, including auto-waiting:

```js
await page.waitForSelector('#player');
await page.click('#player button.play');
await page.fill('#search', 'ambient');
await expect(page.locator('#now-playing')).toBeVisible();
```

`page`, `expect`, `test()`, and `require('playwright')` / `require('@playwright/test')`
are all provided, so a pasted `test(...)` block or a `chromium.launch()` codegen
script runs as-is.

Not supported, and they throw a clear error rather than pretending: anything
that needs the browser process itself — `page.screenshot()`, `page.pdf()`,
`page.setViewportSize()`, multiple real browser contexts. Keyboard events are
synthesised, so a page that requires trusted key events will not see them.

Scripts come from your own command line and run with the page's privileges.
Treat `--js-file` and `--playwright-file` the way you would treat any script you
are about to execute.

### Menu bar mode

```shell
ostinato --menubar --width 420 --height 640 https://example.com
```

The window becomes a popover anchored to the tray icon. Left-clicking the icon
shows and hides it; right-clicking opens the menu:

| Item | Result |
|---|---|
| **Close** | quit Ostinato |
| **Reload** | reload the current URL |
| **Restart** | go back to the pages given on the command line and re-run the scripts |

Closing the window (`Cmd/Ctrl+W` on the last tab) only puts it away — **Close**
is what ends the session.

## Local files

PDFs, images, audio, video, and HTML are handed to Chromium's built-in viewers.
JSON, YAML, and CSV are recognised (see `src/targets.js`) but still open as
plain text; dedicated viewers for them are not implemented yet.

## Development

```shell
pnpm test     # unit tests for the CLI parser, target classifier, and script wrapping
pnpm check    # syntax check every source file
pnpm start    # run the app
pnpm dist     # package with electron-builder
```

`src/cli.js`, `src/targets.js`, and `src/scripts.js` are kept free of Electron
imports so they can be tested with `node --test` without launching a browser.

macOS packaging (signing and notarisation) has to be verified on a Mac; it has
not been run.

## Structure

```
bin/ostinato.js          launcher for a global install
src/main.js              window, tabs, tray, IPC
src/cli.js               argument parser            (unit tested)
src/targets.js           URL / file / stdin classification (unit tested)
src/scripts.js           --js / --playwright wrapping      (unit tested)
src/injected/            the Playwright-compatible surface, evaluated in the page
src/navigation.*         the navigation bar renderer
src/handle.*             the always-visible corner handle
src/content-preload.js   top-edge hover detection inside the page
src/settings.js          window bounds and preferences in userData
```

## License

MIT
