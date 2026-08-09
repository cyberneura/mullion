'use strict';

const { app, BaseWindow, BrowserWindow, WebContentsView, Menu, Tray, dialog, ipcMain, session, shell, nativeImage, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const pkg = require('../package.json');
const { parseCli, helpText } = require('./cli');
const { classifyTarget, labelFor, HOSTLIKE_PATTERN, SCHEME_PATTERN } = require('./targets');
const { resolveScripts, buildInjection } = require('./scripts');
const { loadState, saveState } = require('./settings');
const { imageTooLarge } = require('./images');
const qrcode = require('./qrcode');

// Heights of the two rows the navigation view can show. The view is sized to
// their sum and the page hides the rows it was told not to draw, so the main
// process stays the single source of truth for the layout.
const TAB_BAR_HEIGHT = 32;
const TOOLBAR_HEIGHT = 40;

// The always-visible band at the top: the window's drag area and its title,
// which is also the button that reveals the navigation bar.
const TITLE_BAR_HEIGHT = 30;
// Room kept clear at its left for the macOS window buttons, which the system
// draws over our content rather than in a frame of its own.
const TRAFFIC_LIGHT_INSET = 78;
const TRAFFIC_LIGHT_HEIGHT = 16;

// The top edge of the page reveals the navigation bar once the pointer has
// stayed there; the dwell keeps a pointer merely crossing the edge from
// tripping it.
const EDGE_HEIGHT = 4;
const EDGE_DWELL_MS = 300;

const MIN_CONTENT_HEIGHT = 80;
const BLANK_URL = 'about:blank';
const APP_NAME = 'Mullion';

// Favicons are refused above this size and re-encoded as PNG before the title
// bar sees them, so a page cannot hand the chrome renderer arbitrary bytes.
// The edge limit is separate: 256KB of PNG can still declare a 30000x30000
// canvas, which is several gigabytes once decoded.
const MAX_FAVICON_BYTES = 256 * 1024;
const MAX_FAVICON_EDGE = 4096;
const FAVICON_SIZE = 32;
// A server that sends headers and then stalls would otherwise leave the read
// pending for as long as the app runs.
const FAVICON_TIMEOUT_MS = 10000;

// Remote pages get their own session so nothing they store is shared with the
// navigation bar or the title bar, which run with a preload.
const CONTENT_PARTITION = 'persist:mullion-content';

let mainWindow = null;
let navigationView = null;
let titleBarView = null;
let qrWindow = null;
let tray = null;
let quitting = false;

const tabs = new Map();
// Keyed by the QR window's webContents id: it asks for its own payload once,
// on load, rather than being sent one it might miss.
const qrPayloads = new Map();
let nextTabId = 1;
let activeTabId = null;

let navigationVisible = false;
// The window can be full screen because the user asked the window to be, or
// because the page called requestFullscreen(). The first belongs to the window
// and the second to a tab, they end independently, and neither may clobber the
// other.
let windowFullScreen = false;
// Whether the title bar shows the address instead of the page's own title.
let showUrl = false;
// Set by the window title / Cmd+L: a pinned bar stays until it is explicitly
// dismissed, while a hover-revealed bar hides itself again.
let navigationPinned = false;
let hoverHideTimer = null;
let edgeDwellTimer = null;

let persisted = null;
let injections = [];
// The pages named on the command line. "Restart" goes back to exactly these.
let cliTargets = [];
// Scratch directories holding HTML passed via --html / --html-file / stdin.
const tempDirs = [];

// Unpackaged, the app is running inside Electron's own bundle, so the macOS
// application menu and the userData directory would both be named after it.
// This has to happen before anything asks for a path or builds the menu.
app.setName(APP_NAME);

const cli = parseCli(process.argv.slice(app.isPackaged ? 1 : 2));

if (cli.help) {
  console.log(helpText(pkg.version));
  app.exit(0);
} else if (cli.version) {
  console.log(pkg.version);
  app.exit(0);
} else if (cli.errors.length > 0) {
  for (const error of cli.errors) console.error(`mullion: ${error}`);
  console.error('Run `mullion --help` for usage.');
  app.exit(2);
} else {
  start();
}

function start() {
  // Without --new-window a second launch hands its targets to the running
  // instance instead of starting a second copy of the app.
  // The second instance's own cwd travels with its targets: relative paths must
  // resolve against the shell that typed them, not against the running window.
  if (!cli.newWindow && !app.requestSingleInstanceLock({ targets: cli.targets, cwd: process.cwd() })) {
    app.exit(0);
    return;
  }

  app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
    if (!mainWindow) return;
    const targets = (additionalData && additionalData.targets) || [];
    const cwd = (additionalData && additionalData.cwd) || process.cwd();
    for (const target of targets) createTab(resolveTargetUrl(classifyTarget(target, { cwd })), { runScripts: false });
    revealWindow();
  });

  app.whenReady().then(() => {
    persisted = loadState();
    // Resolved before the menu is built: its checkbox has to start out right.
    showUrl = cli.showUrl || persisted.showUrl;
    const resolved = resolveScripts(cli.scripts);
    for (const error of resolved.errors) console.error(`mullion: ${error}`);
    injections = resolved.scripts.map((script) => ({ origin: script.origin, code: buildInjection(script) }));

    cliTargets = collectStartupUrls();

    if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
      const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'resources', 'icon.png'));
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    }

    app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: pkg.version });

    // The menu is installed even in menu bar mode: it is where the keyboard
    // accelerators live, and they have to keep working when the popover is up.
    Menu.setApplicationMenu(buildAppMenu());
    createWindow();
    if (cli.menubar) {
      // A tray app has no business in the dock or the app switcher.
      if (process.platform === 'darwin' && app.dock) app.dock.hide();
      createTray();
    }
  });

  app.on('window-all-closed', () => {
    // A menu bar app has no windows most of the time; quitting on the last one
    // closing would make the tray icon disappear on the first Cmd+W.
    if (cli.menubar) return;
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });

  app.on('before-quit', () => {
    quitting = true;
    persistState();
    cleanTempDirs();
  });
}

// Turns the CLI targets (plus --html / --html-file / stdin) into the list of
// URLs to open at startup. Anything that is not a page we can host -- a
// `mailto:` target, say -- is handed to the OS instead of opening a blank tab.
function collectStartupUrls() {
  const urls = [];

  if (cli.html !== undefined) urls.push(htmlToUrl(cli.html));
  if (cli.htmlFile !== undefined) urls.push(pathToFileURL(path.resolve(process.cwd(), cli.htmlFile)).href);

  for (const raw of cli.targets) {
    const target = classifyTarget(raw);
    const url = resolveTargetUrl(target);
    if (url) urls.push(url);
  }

  if (cli.restore && urls.length === 0 && persisted.lastUrls.length > 0) {
    urls.push(...persisted.lastUrls);
  }

  return urls.length > 0 ? urls : [BLANK_URL];
}

function resolveTargetUrl(target) {
  if (target.kind === 'stdin') {
    const html = readStdin();
    // An unreadable or empty stdin has already been reported; opening a blank
    // scratch file on top of that would just be noise.
    return html ? htmlToUrl(html) : null;
  }
  if (target.kind === 'external') {
    shell.openExternal(target.url);
    return null;
  }
  if (target.kind === 'invalid') {
    console.error(`mullion: ${target.reason}`);
    return null;
  }
  return target.url;
}

// Reads the whole of stdin. A data: URL would be simpler but breaks relative
// references inside the HTML and has a length ceiling, so the markup goes
// through a real file instead.
function readStdin() {
  if (process.stdin.isTTY) {
    console.error('mullion: `-` was given but stdin is a terminal');
    return '';
  }
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (error) {
    console.error(`mullion: cannot read stdin: ${error.message}`);
    return '';
  }
}

function htmlToUrl(html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mullion-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'index.html');
  fs.writeFileSync(filePath, html);
  return pathToFileURL(filePath).href;
}

// Removed on quit so a long-lived menu bar instance does not leave one
// directory per --html invocation behind in /tmp.
function cleanTempDirs() {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`mullion: could not remove ${dir}: ${error.message}`);
    }
  }
}

function createWindow() {
  const bounds = startupBounds();

  mainWindow = new BaseWindow({
    ...bounds,
    minWidth: 320,
    minHeight: 200,
    title: cli.title || 'Mullion',
    backgroundColor: '#1b1c1f',
    show: !cli.menubar,
    skipTaskbar: cli.menubar,
    alwaysOnTop: cli.alwaysOnTop || cli.menubar,
    // A menu bar window must not stay behind when the user switches Spaces or
    // clicks another app, so it is not resizable into a regular window either.
    resizable: !cli.menubar,
    ...framingOptions()
  });

  navigationPinned = cli.navigation || (!cli.menubar && persisted.navigationPinned);
  navigationVisible = navigationPinned;
  // A window closed while full screen would otherwise hand the state to its
  // replacement, which starts with no title bar and no way to get one back.
  windowFullScreen = false;

  navigationView = createChromeView('navigation.html');
  mainWindow.contentView.addChildView(navigationView);
  // With --frame the platform already draws a title bar; a second one would
  // just repeat it.
  if (!cli.frame) {
    titleBarView = createChromeView('titlebar.html');
    mainWindow.contentView.addChildView(titleBarView);
  }

  openStartupTabs();

  mainWindow.on('resize', relayout);
  // Full screen is the one time the title bar has nothing to offer: the window
  // buttons are gone, there is nothing to drag, and the point of the mode is
  // that the page gets the whole screen.
  mainWindow.on('enter-full-screen', () => {
    windowFullScreen = true;
    relayout();
  });
  mainWindow.on('leave-full-screen', () => {
    windowFullScreen = false;
    relayout();
  });
  mainWindow.on('close', (event) => {
    // In menu bar mode the window is a popover: closing it should put it away,
    // not end the session. "Close" in the tray menu is what actually quits.
    if (cli.menubar && !quitting) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }
    persistState();
  });
  mainWindow.on('closed', () => {
    if (hoverHideTimer !== null) {
      clearTimeout(hoverHideTimer);
      hoverHideTimer = null;
    }
    clearEdgeDwell();
    mainWindow = null;
    navigationView = null;
    titleBarView = null;
    for (const tab of tabs.values()) {
      if (tab.faviconRequest) tab.faviconRequest.abort();
    }
    tabs.clear();
    activeTabId = null;
  });

  if (cli.menubar) mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  relayout();
}

// `mullion a.example b.example` should land on the first page named, not the
// last one to finish being created, so the selection is redone at the end.
function openStartupTabs() {
  const created = cliTargets.map((url) => createTab(url, { runScripts: true })).filter(Boolean);
  if (created.length > 1) selectTab(created[0].id);
}

// How much window chrome to keep.
//
// On macOS `frame: false` removes the traffic lights along with the title bar,
// which leaves no way to close the window; `titleBarStyle: 'hidden'` keeps them
// and lets us place them ourselves, centred in the title bar we draw. A menu bar
// popover is the exception -- it is dismissed by clicking the tray icon, so it
// takes the fully frameless treatment on every platform.
function framingOptions() {
  if (cli.frame) return {};
  if (cli.menubar) return { frame: false };
  if (process.platform !== 'darwin') return { frame: false };
  return {
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: Math.round((TITLE_BAR_HEIGHT - TRAFFIC_LIGHT_HEIGHT) / 2) }
  };
}

// Zero unless the platform is drawing its window buttons inside our title bar,
// which is only the case for a framed-off macOS window.
function trafficLightInset() {
  return process.platform === 'darwin' && !cli.frame && !cli.menubar ? TRAFFIC_LIGHT_INSET : 0;
}

function startupBounds() {
  const explicit = {
    width: cli.width,
    height: cli.height,
    ...(cli.x !== undefined ? { x: cli.x } : {}),
    ...(cli.y !== undefined ? { y: cli.y } : {})
  };
  // A remembered size is only used when the user did not ask for one, and never
  // in menu bar mode where the popover size is chosen by the flags alone.
  const sawSizeFlag = ['width', 'height', 'x', 'y'].some((name) => cli.provided[name]);
  if (cli.menubar || sawSizeFlag || !persisted.bounds) return explicit;
  return persisted.bounds;
}

function createChromeView(page) {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'navigation-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  // Transparent so the title bar paints only its own band; the navigation bar
  // draws its own opaque background in CSS.
  view.setBackgroundColor('#00000000');
  view.webContents.on('before-input-event', handleShortcut);
  view.webContents.loadFile(path.join(__dirname, page));
  return view;
}

function createTab(url, { runScripts = false } = {}) {
  if (!url || !mainWindow) return null;

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: CONTENT_PARTITION
    }
  });

  const tab = {
    id: `tab-${nextTabId}`,
    view,
    url,
    title: labelFor(classifyTarget(url)),
    favicon: null,
    faviconUrl: null,
    faviconRequest: null,
    loading: false,
    htmlFullScreen: false,
    canGoBack: false,
    canGoForward: false,
    // Scripts are tied to the pages the user named, not to whatever they browse
    // to afterwards, so this is armed per load rather than left permanently on.
    runScriptsOnLoad: runScripts && injections.length > 0
  };
  nextTabId += 1;
  tabs.set(tab.id, tab);

  const contents = view.webContents;
  contents.setZoomFactor(cli.zoom !== 1 ? cli.zoom : persisted.zoom);
  contents.on('before-input-event', handleShortcut);
  contents.on('page-title-updated', (_event, title) => {
    tab.title = title;
    syncWindowTitle();
    pushState();
  });
  contents.on('page-favicon-updated', (_event, favicons) => loadFavicon(tab, favicons[0]));
  // Both page gestures come from the browser process's own view of the input,
  // which a page can influence but not forge: a script may dispatch a DOM event
  // and it will not appear here.
  //
  // The limit is frames. Electron attaches its input observer to the primary
  // main frame's widget only, and Chromium delivers a mouse event straight to
  // the widget the hit test chose, so nothing here fires while the pointer is
  // over an out-of-process iframe. A preload does not run in those frames
  // either. Reaching them needs `nodeIntegrationInSubFrames`, which Electron
  // marks experimental and which widens what a sub-frame can talk to.
  contents.on('input-event', (_event, input) => {
    if (tab.id !== activeTabId) return;

    if (input.type === 'mouseDown') {
      // Cleared whatever the button and whatever the bar is doing: a dwell
      // begun on the way to a click must not open the bar a moment after the
      // click asked to be left alone with the page.
      clearEdgeDwell();
      // The primary button only. Hiding the bar moves the page up by the height
      // of the row, which would drag the page out from under the context menu
      // the right button just opened.
      if (input.button !== 'left' || !navigationVisible) return;
      setNavigationVisible(false);
      return;
    }

    if (input.type === 'mouseMove') {
      if (input.y > EDGE_HEIGHT) {
        clearEdgeDwell();
        return;
      }
      if (edgeDwellTimer !== null || navigationVisible) return;
      edgeDwellTimer = setTimeout(() => {
        edgeDwellTimer = null;
        // A page in full screen has the screen; a bar over it would fight what
        // the user asked for.
        if (tab.id !== activeTabId || tab.htmlFullScreen) return;
        if (!navigationVisible) setNavigationVisible(true);
      }, EDGE_DWELL_MS);
      return;
    }

    // The pointer leaving mid-dwell must not trip the reveal behind it.
    if (input.type === 'mouseLeave') clearEdgeDwell();
  });
  // A video going full screen inside the page never reaches the window's own
  // full-screen events, but it wants the same treatment. A background tab that
  // does it must not take the chrome away from the tab in front.
  contents.on('enter-html-full-screen', () => {
    tab.htmlFullScreen = true;
    if (tab.id === activeTabId) relayout();
  });
  contents.on('leave-html-full-screen', () => {
    tab.htmlFullScreen = false;
    if (tab.id === activeTabId) relayout();
  });
  contents.on('did-start-loading', () => {
    tab.loading = true;
    pushState();
  });
  contents.on('did-stop-loading', () => {
    tab.loading = false;
    pushState();
  });
  contents.on('did-navigate', () => {
    // The icon belongs to the page that was left behind; keeping it would put
    // the wrong site's mark next to the new title until the new one arrives.
    // Its fetch goes with it -- the answer is for a page nobody is on now.
    if (tab.faviconRequest) tab.faviconRequest.abort();
    tab.favicon = null;
    tab.faviconUrl = null;
    syncNavigationState(tab);
  });
  contents.on('did-navigate-in-page', () => syncNavigationState(tab));
  contents.on('did-finish-load', () => {
    syncNavigationState(tab);
    if (tab.runScriptsOnLoad || cli.jsEveryLoad) {
      tab.runScriptsOnLoad = false;
      runInjections(tab);
    }
  });
  contents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
    if (isMainFrame) console.error(`mullion: failed to load ${failedUrl}: ${description} (${code})`);
  });

  // Links that ask for a new window become a tab here; letting them through
  // would spawn a bare Electron window with no navigation bar at all.
  contents.setWindowOpenHandler(({ url: requestedUrl }) => {
    createTab(requestedUrl, { runScripts: false });
    return { action: 'deny' };
  });

  // Schemes we cannot host (mailto:, tel:, custom app schemes) go to the OS.
  contents.on('will-navigate', (event, requestedUrl) => {
    if (/^(https?|file|about|data):/i.test(requestedUrl)) return;
    event.preventDefault();
    shell.openExternal(requestedUrl);
  });

  contents.on('context-menu', () => showContentMenu(tab));

  mainWindow.contentView.addChildView(view);
  // Child views stack in insertion order, so the chrome has to be lifted back
  // above the page every time a tab is added or it ends up behind it.
  for (const chrome of [navigationView, titleBarView]) {
    if (!chrome) continue;
    mainWindow.contentView.removeChildView(chrome);
    mainWindow.contentView.addChildView(chrome);
  }

  contents.loadURL(url);
  if (cli.openDevtools) contents.openDevTools({ mode: 'detach' });

  selectTab(tab.id);
  return tab;
}

function syncNavigationState(tab) {
  tab.url = tab.view.webContents.getURL();
  tab.canGoBack = tab.view.webContents.navigationHistory.canGoBack();
  tab.canGoForward = tab.view.webContents.navigationHistory.canGoForward();
  syncWindowTitle();
  pushState();
}

// `session.fetch` follows `file:` and any registered custom protocol, so an
// unchecked favicon URL would let a remote page make the main process read a
// local file and draw it in the chrome. Nothing but http(s) is worth the risk;
// `data:` is not supported by fetch at all, so those are dropped here rather
// than failing later.
function faviconFetchable(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

// The body is read incrementally and abandoned the moment it goes over the
// limit. Reading it whole first and checking the length afterwards is what the
// limit was supposed to prevent.
async function readCapped(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body.cancel();
    return null;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// Fetched in the page's own session, then decoded and re-encoded as a PNG data
// URL. The title bar therefore never makes a request of its own -- which would
// leak out of the content partition -- and never receives bytes it has not
// already been told are an image. An icon that does not decode is left out.
async function loadFavicon(tab, url) {
  if (!faviconFetchable(url) || tab.faviconUrl === url) return;
  tab.faviconUrl = url;

  // One request per tab: a page can name a new icon as often as it likes, and
  // each one would otherwise start a fetch that nothing ever stops.
  if (tab.faviconRequest) tab.faviconRequest.abort();
  const request = new AbortController();
  tab.faviconRequest = request;
  const timeout = setTimeout(() => request.abort(), FAVICON_TIMEOUT_MS);

  try {
    const response = await session.fromPartition(CONTENT_PARTITION).fetch(url, { signal: request.signal });
    if (!response.ok) {
      await response.body.cancel();
      return;
    }
    const bytes = await readCapped(response, MAX_FAVICON_BYTES);
    if (!bytes || bytes.length === 0 || imageTooLarge(bytes, MAX_FAVICON_EDGE)) return;
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return;
    // The page may have moved on while the icon was in flight.
    if (tab.faviconUrl !== url || !tabs.has(tab.id)) return;
    tab.favicon = image.resize({ width: FAVICON_SIZE, height: FAVICON_SIZE }).toDataURL();
    pushState();
  } catch {
    // A favicon that cannot be fetched is not worth a message.
  } finally {
    clearTimeout(timeout);
    if (tab.faviconRequest === request) tab.faviconRequest = null;
  }
}

async function runInjections(tab) {
  for (const injection of injections) {
    try {
      // userGesture: media playback and fullscreen requests are gated on one,
      // and a script that opens a video is the point of the feature.
      await tab.view.webContents.executeJavaScript(injection.code, true);
    } catch (error) {
      console.error(`mullion: script from ${injection.origin} failed: ${error.message}`);
    }
  }
}

function selectTab(tabId) {
  if (!tabs.has(tabId)) return;
  activeTabId = tabId;
  for (const [id, tab] of tabs) tab.view.setVisible(id === tabId);
  const active = tabs.get(tabId);
  clearEdgeDwell();
  syncWindowTitle();
  active.view.webContents.focus();
  relayout();
}

// Detaches and destroys one tab's view. Shared with restartTargets() so the
// teardown order (drop from the map, unparent, then close) has a single
// definition -- closing a view that is still a child leaves a hole behind.
function disposeTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  tabs.delete(tabId);
  if (tab.faviconRequest) tab.faviconRequest.abort();
  mainWindow.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
}

function closeTab(tabId) {
  if (!tabs.has(tabId)) return;
  // Recorded while the URL is still known: once the last tab is gone there is
  // nothing left for --restore to remember.
  if (tabs.size === 1) persistState();
  disposeTab(tabId);

  if (tabs.size === 0) {
    if (cli.menubar) {
      mainWindow.hide();
      createTab(BLANK_URL);
      return;
    }
    mainWindow.close();
    return;
  }
  if (activeTabId === tabId) selectTab([...tabs.keys()][tabs.size - 1]);
  else relayout();
}

function activeTab() {
  return activeTabId ? tabs.get(activeTabId) : null;
}

// Cmd/Ctrl+W is an application accelerator, so it fires wherever focus is. The
// QR window is a BrowserWindow and the main window is not, so anything the
// focus query returns is a secondary window that should take the keystroke.
function closeFocused() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) {
    focused.close();
    return;
  }
  if (activeTabId) closeTab(activeTabId);
}

// The tab strip earns its space once there is a choice to make, so a single-tab
// window stays completely bare. Both the layout and the renderer state read it.
//
// In full screen it waits to be asked for, the way a browser's toolbar does,
// rather than standing between the page and the top of the screen.
function isTabBarVisible() {
  if (windowFullScreen && !navigationVisible) return false;
  return navigationVisible || tabs.size > 1;
}

function clearEdgeDwell() {
  if (edgeDwellTimer === null) return;
  clearTimeout(edgeDwellTimer);
  edgeDwellTimer = null;
}

function relayout() {
  if (!mainWindow || !navigationView) return;
  const { width, height } = mainWindow.getContentBounds();

  // The two kinds of full screen do not mean the same thing. A page that went
  // full screen has asked for the screen outright, so nothing may cover it. A
  // window in full screen is closer to a maximised window: the bands stop
  // taking space, but Cmd+L and the top edge can still call them back.
  //
  // Outside both, the title bar keeps its row whatever else is shown, so that
  // neither the window buttons nor the drag area sit over the page.
  const active = activeTab();
  const pageFullScreen = Boolean(active && active.htmlFullScreen);
  const showTitleBar = Boolean(titleBarView) && !windowFullScreen && !pageFullScreen;
  const titleBarHeight = showTitleBar ? TITLE_BAR_HEIGHT : 0;
  const bandHeight = pageFullScreen ? 0 : (navigationVisible ? TOOLBAR_HEIGHT : 0) + (isTabBarVisible() ? TAB_BAR_HEIGHT : 0);
  const topHeight = titleBarHeight + bandHeight;
  const contentHeight = Math.max(height - topHeight, MIN_CONTENT_HEIGHT);

  if (titleBarView) {
    titleBarView.setBounds({ x: 0, y: 0, width, height: titleBarHeight });
    titleBarView.setVisible(showTitleBar);
  }

  navigationView.setBounds({ x: 0, y: titleBarHeight, width, height: bandHeight });
  navigationView.setVisible(bandHeight > 0);

  for (const [id, tab] of tabs) {
    tab.view.setBounds({ x: 0, y: topHeight, width, height: contentHeight });
    tab.view.setVisible(id === activeTabId);
  }

  pushState();
}

// --title pins the title against the page; otherwise it is the page's own
// title, or its address when the title bar was switched over to showing that.
function windowTitle() {
  if (cli.title) return cli.title;
  const active = activeTab();
  if (!active) return APP_NAME;
  return (showUrl ? active.url : active.title) || APP_NAME;
}

function syncWindowTitle() {
  if (mainWindow && !cli.title) mainWindow.setTitle(windowTitle());
}

function setShowUrl(value) {
  showUrl = value;
  syncWindowTitle();
  pushState();
}

function buildState() {
  return {
    navigationVisible,
    tabBarVisible: isTabBarVisible(),
    title: windowTitle(),
    titleBarInset: trafficLightInset(),
    favicon: (activeTab() && activeTab().favicon) || null,
    loading: Boolean(activeTab() && activeTab().loading),
    activeTabId,
    tabs: [...tabs.values()].map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward
    }))
  };
}

function pushState() {
  const state = buildState();
  for (const view of [navigationView, titleBarView]) {
    if (!view || view.webContents.isDestroyed()) continue;
    view.webContents.send('state', state);
  }
}

function setNavigationVisible(visible, { pinned = false } = {}) {
  // Whatever decided this, it outranks a dwell that has not fired yet.
  clearEdgeDwell();
  if (hoverHideTimer !== null) {
    clearTimeout(hoverHideTimer);
    hoverHideTimer = null;
  }
  navigationVisible = visible;
  navigationPinned = visible && pinned;
  relayout();

  // A bar that was revealed by hovering the top edge puts itself away again;
  // one the user asked for stays.
  if (visible && !pinned) {
    hoverHideTimer = setTimeout(() => {
      hoverHideTimer = null;
      if (!navigationPinned) {
        navigationVisible = false;
        relayout();
      }
    }, 2000);
  }
}

function focusUrlBar() {
  if (!navigationView || navigationView.webContents.isDestroyed()) return;
  // A page in full screen has the screen. Putting a bar over it would fight
  // what the user just asked for, and the pin would outlive the moment by
  // being written to the settings.
  const active = activeTab();
  if (active && active.htmlFullScreen) return;
  setNavigationVisible(true, { pinned: true });
  navigationView.webContents.focus();
  navigationView.webContents.send('focus-url');
}

// Treats anything without a scheme as a URL when it looks like a host and as a
// search otherwise, which is what an address bar is expected to do. The host
// test comes first because `localhost:3000` also satisfies the scheme pattern.
function normalizeInput(input) {
  if (!input) return null;
  if (HOSTLIKE_PATTERN.test(input)) return `https://${input}`;
  if (SCHEME_PATTERN.test(input)) return input;
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

// Only Escape lives here. Every other shortcut is an application menu
// accelerator: handling a key in both places would run the command twice.
function handleShortcut(event, input) {
  if (input.type !== 'keyDown' || input.key !== 'Escape' || !navigationVisible) return;
  setNavigationVisible(false);
  event.preventDefault();
}

function withActiveTab(action) {
  return () => {
    const tab = activeTab();
    if (tab) action(tab.view.webContents);
  };
}

// The zoom and devtools roles act on `BrowserWindow.webContents`, which a
// BaseWindow does not have, so those items drive the active tab explicitly.
function adjustZoom(delta) {
  return withActiveTab((contents) => {
    const factor = delta === 0 ? 1 : Math.min(Math.max(contents.getZoomFactor() + delta, 0.25), 5);
    contents.setZoomFactor(factor);
  });
}

// Only the schemes a browser or the file manager would sensibly take. Handing
// `data:` or a custom scheme to the OS from a menu the page can influence is
// not worth the risk.
function openActiveExternal() {
  const tab = activeTab();
  if (tab && /^(https?|file):/i.test(tab.url)) shell.openExternal(tab.url);
}

function screenshotName(tab) {
  let host = 'page';
  try {
    host = new URL(tab.url).hostname || host;
  } catch {
    // A blank or malformed URL just keeps the fallback name.
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `mullion-${host.replace(/[^a-zA-Z0-9.-]/g, '_')}-${stamp}.png`;
}

// Captures the page only, not the surrounding chrome: the view is what the tab
// owns, and it is the part anyone asking for a screenshot means.
async function takeScreenshot() {
  const tab = activeTab();
  if (!tab) return;
  const file = path.join(app.getPath('downloads'), screenshotName(tab));
  try {
    const image = await tab.view.webContents.capturePage();
    fs.writeFileSync(file, image.toPNG());
    console.log(`mullion: screenshot saved to ${file}`);
    shell.showItemInFolder(file);
  } catch (error) {
    console.error(`mullion: could not save the screenshot: ${error.message}`);
  }
}

// The matrix is computed here and handed over as data, so the QR window never
// has to be told the URL in a form it could act on.
function showQrCode() {
  const tab = activeTab();
  if (!tab) return;
  if (!canShowQrCode(tab)) {
    // Reachable from the View menu, whose items are built once and cannot grey
    // themselves out per tab. Silence here reads as a broken menu item.
    const tooLong = /^https?:/i.test(tab.url);
    dialog.showMessageBox({
      type: 'info',
      message: tooLong ? 'This URL is too long for a QR code.' : 'There is no web address to encode.',
      detail: tooLong
        ? `The limit is ${qrcode.capacityBytes(qrcode.MAX_VERSION)} bytes and this one is ${Buffer.byteLength(tab.url)}.`
        : 'A QR code is only offered for http and https pages.'
    });
    return;
  }

  let code;
  try {
    code = qrcode.encode(tab.url);
  } catch (error) {
    console.error(`mullion: could not build a QR code: ${error.message}`);
    return;
  }

  // One at a time: a second "Show QR Code" replaces the window rather than
  // stacking another one on top of it.
  if (qrWindow && !qrWindow.isDestroyed()) qrWindow.destroy();

  qrWindow = new BrowserWindow({
    width: 300,
    height: 340,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'QR Code',
    backgroundColor: '#1b1c1f',
    alwaysOnTop: cli.alwaysOnTop || cli.menubar,
    webPreferences: {
      preload: path.join(__dirname, 'qr-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const opened = qrWindow;
  const contentsId = opened.webContents.id;
  qrPayloads.set(contentsId, { url: tab.url, code });
  opened.on('closed', () => {
    qrPayloads.delete(contentsId);
    // A replacement may already have been opened by the time this arrives.
    if (qrWindow === opened) qrWindow = null;
  });
  opened.loadFile(path.join(__dirname, 'qr.html'));
}

// The encoder tops out at version 10. A URL past that is not rare -- tracking
// parameters get there easily -- so the menu says so by going grey instead of
// letting the click do nothing.
function canShowQrCode(tab) {
  return Boolean(tab) && /^https?:/i.test(tab.url) && Buffer.byteLength(tab.url) <= qrcode.capacityBytes(qrcode.MAX_VERSION);
}

function showContentMenu(tab) {
  if (!mainWindow) return;
  const contents = tab.view.webContents;
  const history = contents.navigationHistory;

  Menu.buildFromTemplate([
    { label: 'Back', enabled: history.canGoBack(), click: () => history.goBack() },
    { label: 'Forward', enabled: history.canGoForward(), click: () => history.goForward() },
    { label: 'Reload', click: () => contents.reload() },
    { type: 'separator' },
    { label: 'Show Navigation Bar', click: focusUrlBar },
    { label: 'Take Screenshot', click: takeScreenshot },
    { label: 'Open in Default Browser', enabled: /^(https?|file):/i.test(tab.url), click: openActiveExternal },
    { label: 'Show QR Code', enabled: canShowQrCode(tab), click: showQrCode },
    { type: 'separator' },
    { label: 'Restart', click: restartTargets }
  ]).popup({ window: mainWindow });
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => { createTab(BLANK_URL); focusUrlBar(); } },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: closeFocused },
        { type: 'separator' },
        // Cmd+W belongs to the tab, so closing the window moves to Cmd+Shift+W.
        ...(isMac ? [{ role: 'close', accelerator: 'CmdOrCtrl+Shift+W' }] : [{ role: 'quit' }])
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Show Navigation Bar', accelerator: 'CmdOrCtrl+L', click: focusUrlBar },
        {
          label: 'Show URL in Title Bar',
          type: 'checkbox',
          checked: showUrl,
          click: (item) => setShowUrl(item.checked)
        },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: withActiveTab((contents) => contents.reload()) },
        { label: 'Restart', click: restartTargets },
        { type: 'separator' },
        { label: 'Take Screenshot', accelerator: 'CmdOrCtrl+Shift+S', click: takeScreenshot },
        { label: 'Open in Default Browser', click: openActiveExternal },
        { label: 'Show QR Code', click: showQrCode },
        { type: 'separator' },
        // A frameless window has no zoom button, so without this there is no
        // way into full screen at all off macOS.
        ...(cli.menubar
          ? []
          : [
              {
                label: 'Toggle Full Screen',
                accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11',
                click: () => mainWindow && mainWindow.setFullScreen(!mainWindow.isFullScreen())
              },
              { type: 'separator' }
            ]),
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: withActiveTab((contents) => contents.navigationHistory.canGoBack() && contents.navigationHistory.goBack()) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: withActiveTab((contents) => contents.navigationHistory.canGoForward() && contents.navigationHistory.goForward()) },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: adjustZoom(0) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: adjustZoom(0.1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: adjustZoom(-0.1) },
        { type: 'separator' },
        {
          label: 'Toggle Developer Tools',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: withActiveTab((contents) => (contents.isDevToolsOpened() ? contents.closeDevTools() : contents.openDevTools({ mode: 'detach' })))
        }
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, ...(isMac ? [{ role: 'zoom' }, { role: 'front' }] : [])] }
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'resources', 'tray.png'));
  // A template image follows the macOS menu bar's light/dark appearance; on the
  // other platforms the flag is ignored.
  icon.setTemplateImage(true);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip(cli.title || 'Mullion');

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Close', click: () => { quitting = true; app.quit(); } },
      { label: 'Reload', click: () => activeTab() && activeTab().view.webContents.reload() },
      { label: 'Restart', click: restartTargets }
    ])
  );

  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else revealWindow();
  });
}

// Anchors the popover under the tray icon where the platform reports one, and
// falls back to the cursor's display so the window never lands off-screen.
function revealWindow() {
  if (!mainWindow) return;
  if (cli.menubar && tray) {
    const trayBounds = tray.getBounds();
    const { width, height } = mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint(
      trayBounds.width > 0 ? { x: trayBounds.x, y: trayBounds.y } : screen.getCursorScreenPoint()
    );
    const area = display.workArea;
    const anchorX = trayBounds.width > 0 ? Math.round(trayBounds.x + trayBounds.width / 2 - width / 2) : area.x + area.width - width;
    const anchorY = trayBounds.height > 0 ? Math.round(trayBounds.y + trayBounds.height) : area.y;
    mainWindow.setBounds({
      x: Math.min(Math.max(anchorX, area.x), area.x + area.width - width),
      y: Math.min(Math.max(anchorY, area.y), area.y + area.height - height),
      width,
      height
    });
  }
  mainWindow.show();
  mainWindow.focus();
}

// "Restart" means: forget where browsing went and put the command line targets
// back, scripts and all. That is the reason the tray menu has it next to Reload.
function restartTargets() {
  if (!mainWindow) return;
  for (const id of [...tabs.keys()]) disposeTab(id);
  activeTabId = null;
  openStartupTabs();
}

function persistState() {
  if (!mainWindow) return;
  const urls = [...tabs.values()].map((tab) => tab.url).filter((url) => url && url !== BLANK_URL);
  // Called again from the window's close handler, by which time the tabs are
  // already gone; keeping the last non-empty list is what makes --restore work.
  if (urls.length > 0) persisted.lastUrls = urls;
  if (activeTab()) persisted.zoom = activeTab().view.webContents.getZoomFactor();

  saveState({
    // A menu bar popover is sized by its flags, so its geometry is not recorded.
    bounds: cli.menubar ? persisted.bounds : mainWindow.getBounds(),
    navigationPinned,
    showUrl,
    zoom: persisted.zoom,
    lastUrls: persisted.lastUrls
  });
}

ipcMain.handle('get-state', () => buildState());
ipcMain.handle('new-tab', () => {
  createTab(BLANK_URL);
  focusUrlBar();
});
ipcMain.handle('select-tab', (_event, tabId) => selectTab(tabId));
ipcMain.handle('close-tab', (_event, tabId) => closeTab(tabId));
ipcMain.handle('hide-navigation', () => setNavigationVisible(false));
ipcMain.handle('show-navigation', () => setNavigationVisible(true, { pinned: true }));
ipcMain.handle('open-external', openActiveExternal);
ipcMain.handle('get-qr', (event) => qrPayloads.get(event.sender.id) || null);
ipcMain.handle('navigate', (_event, input) => {
  const tab = activeTab();
  const url = normalizeInput(String(input || '').trim());
  if (!tab || !url) return;
  // Same split as will-navigate: only pages we can host are loaded, and a
  // `mailto:` typed into the address bar goes to the OS. Without the check a
  // `javascript:` URL typed (or injected) here would run in the tab's context.
  if (/^(https?|file|about):/i.test(url)) tab.view.webContents.loadURL(url);
  else shell.openExternal(url);
});
ipcMain.handle('go', (_event, action) => {
  const tab = activeTab();
  if (!tab) return;
  const history = tab.view.webContents.navigationHistory;
  if (action === 'back' && history.canGoBack()) history.goBack();
  else if (action === 'forward' && history.canGoForward()) history.goForward();
  else if (action === 'reload') tab.view.webContents.reload();
});
