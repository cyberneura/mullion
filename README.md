# Mullion

A frameless browser window for leaving a page playing.

Mullion opens a URL or a local file in a window with no visible browser UI —
just the page. The navigation bar appears when you ask for it and gets out of
the way again. It can run a script after the page loads, and it can live in the
menu bar instead of the dock.

The name is the architectural term for the slender bar that divides a window
into panes — the only part of a window you are meant not to notice.

## Install

```shell
brew install --cask cyberneura/tap/mullion
```

Or from a checkout:

```shell
pnpm install
pnpm start https://example.com
```

Arguments after `pnpm start` reach the app as they are. Do not put `--` in
front of them: pnpm passes it through, and Mullion reads `--` as "everything
after this is a file name", so `pnpm start -- --menubar` tries to open a file
called `--menubar`.

To get a `mullion` command:

```shell
pnpm link --global
mullion https://example.com
```

## Usage

```
mullion [options] [target ...]
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
| `--show-url` | show the URL in the title bar instead of the page title |
| `--js <code>` / `--js-file <path>` | run JavaScript after the page loads |
| `--playwright <code>` / `--playwright-file <path>` | run Playwright-compatible code after the page loads |
| `--js-every-load` | re-run the scripts after every navigation |
| `--open-devtools` | open developer tools on start |

### The title bar

The only chrome shown by default is a 30px title bar holding the window buttons,
the page's favicon, and its title:

```
◯◯◯  ▣ Page title
```

It is a reserved row, not an overlay, so nothing sits on top of the page. Drag
it to move the window, and click the title to open and close the navigation bar.

While a page is loading the favicon is replaced by a spinner, in the same 14px
box so the title does not move. The icon is fetched by the main process in the
page's own session and handed to the title bar as a decoded PNG, so the title
bar never makes a request of its own — pointing it at a page-supplied URL would
take the request out of the content partition.

Only `http(s)` icons are fetched. `session.fetch` follows `file:` and custom
protocols, and a remote page must not be able to name a local file for the main
process to read. `data:` icons are dropped too, since `fetch` does not support
that scheme at all.

Of what is fetched, only PNG is shown. The icon has to be measured before it is
decoded — 256KB of image data can declare a canvas of several gigabytes — and
PNG states its size once, in one place. JPEG offers several ways to say it and
several ways to disguise it, so it is refused rather than measured. A site
serving a JPEG or `.ico` favicon simply shows none.

**View → Show URL in Title Bar** swaps the title for the address, and
`--show-url` starts that way. The choice is remembered between runs. `--title`
overrides both: a pinned title stays pinned.

The two kinds of full screen are treated differently. **View → Toggle Full
Screen** (`Ctrl+Cmd+F`, `F11` elsewhere), which is how you get there on a
frameless window, hides the title bar along with the rest of the chrome — but
`Cmd/Ctrl+L` and the top edge still call the navigation bar back, the way a
browser's toolbar behaves. When a *page* goes full screen, a video for
instance, every band is hidden and stays hidden: the page asked for the screen.

With `--frame` the platform draws its own title bar and Mullion does not add a
second one.

### Showing the navigation bar

| Action | Result |
|---|---|
| Click the window title | show the bar and keep it, or put it away again |
| Rest the pointer on the top 4px of the page for 300ms | show the bar for two seconds |
| Click anywhere in the page | hide the bar |
| `Cmd/Ctrl+L` | show the bar and focus the address field |
| `Cmd/Ctrl+T` | new tab, with the address field focused |
| `Esc` | hide the bar |
| The page is `about:blank` | the bar stays up, so a click in the page does nothing; `Esc` and the collapse button still count and take effect on the next page |

That last row is the one thing window full screen does not honour: there a blank
page gets the screen like any other, and the bar comes back by the same two
routes as on any page.

The tab strip comes and goes with the bar. However many tabs are open, a window
left alone shows nothing but the page.

`Cmd/Ctrl+R` reloads, `Cmd/Ctrl+W` closes a tab, `Cmd/Ctrl+[` and `Cmd/Ctrl+]`
go back and forward. Everything except `Esc` is also in the application menu.

Both pointer gestures stop at a frame boundary: an embedded player served from
another origin swallows the click and the hover, because neither Electron nor a
preload sees input inside an out-of-process iframe. `Cmd/Ctrl+L` is not stopped
by either, which matters most in window full screen where the title bar is not
there to click. The one place it does nothing is under a page that has gone full
screen itself, which has the screen until it gives it back.

### The page menu

Right-clicking the page opens:

| Item | Result |
|---|---|
| **Back** / **Forward** / **Reload** | as the keyboard shortcuts |
| **Show Navigation Bar** | show the bar and focus the address field |
| **Take Screenshot** | save a PNG of the page to your Downloads folder and reveal it |
| **Open in Default Browser** | hand the current `http(s):` or `file:` URL to the OS |
| **Show QR Code** | show the current URL as a QR code, for opening it on a phone |
| **Restart** | go back to the command line targets and re-run the scripts |

**Take Screenshot**, **Open in Default Browser** and **Show QR Code** are also in
the View menu. The QR code is generated in-process (`src/qrcode.js`); no URL is
sent anywhere. The encoder tops out at 213 bytes, which a URL carrying tracking
parameters passes easily — past that the page menu greys the item out, and the
View menu (built once, so it cannot grey itself out per tab) says so instead.

Text in the address field that does not look like a URL is sent to Google;
the search engine is not configurable yet.

### Running a script after load

```shell
# raw JavaScript
mullion https://example.com --js 'document.querySelector("video").play()'

# Playwright-compatible
mullion https://example.com --playwright-file ./start-playing.js
```

Both options can be given together and any number of times; the scripts run in
the order they appear on the command line.

By default the scripts run for the pages named on the command line and again
when you pick **Restart**, but *not* for pages you reach by clicking links —
otherwise your automation would follow you onto every site you visit. Pass
`--js-every-load` if you do want that.

#### What "Playwright-compatible" means here

Real Playwright drives a browser from the outside. Mullion is already inside
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
mullion --menubar --width 420 --height 640 https://example.com
```

The window becomes a popover anchored to the tray icon. Left-clicking the icon
shows and hides it; right-clicking opens the menu:

| Item | Result |
|---|---|
| **Close** | quit Mullion |
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
pnpm test     # CLI parser, target classifier, script wrapping, QR encoder, image headers
pnpm check    # syntax check every source file
pnpm start    # run the app
pnpm dist     # package with electron-builder
```

`src/cli.js`, `src/targets.js`, `src/scripts.js`, `src/qrcode.js`, and
`src/images.js` are kept free of Electron imports so they can be tested with
`node --test` without launching a browser.

macOS packaging (signing and notarisation) has to be verified on a Mac; it has
not been run.

## Structure

```
bin/mullion.js           launcher for a global install
src/main.js              window, tabs, tray, IPC
src/cli.js               argument parser                   (unit tested)
src/targets.js           URL / file / stdin classification (unit tested)
src/scripts.js           --js / --playwright wrapping      (unit tested)
src/qrcode.js            byte-mode QR encoder, level M     (unit tested)
src/images.js            PNG header measurement            (unit tested)
src/injected/            the Playwright-compatible surface, evaluated in the page
src/navigation.*         the navigation bar renderer
src/titlebar.*           the title bar renderer
src/qr.*                 the QR code window renderer
src/settings.js          window bounds and preferences in userData
scripts/                 macOS bundle naming for development, and the release
```

## Releasing

```shell
pnpm release           # patch. `minor` and `major` also work
```

It bumps the version, pushes it to `main`, starts the release workflow and
watches it. The workflow builds a signed and notarized universal dmg and
attaches it to a GitHub release. The Homebrew cask in
[cyberneura/homebrew-tap](https://github.com/cyberneura/homebrew-tap) carries the
version and checksum by hand; the workflow prints both in its run summary.

## License

MIT.

The toolbar glyphs are [Bootstrap Icons](https://icons.getbootstrap.com/) 1.13.1
(MIT), inlined as SVG in `src/navigation.html` rather than pulled in as a
webfont or a dependency.
