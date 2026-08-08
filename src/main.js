'use strict';

const { app, BaseWindow, WebContentsView, Menu, Tray, ipcMain, shell, nativeImage, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const pkg = require('../package.json');
const { parseCli, helpText } = require('./cli');
const { classifyTarget, labelFor, HOSTLIKE_PATTERN, SCHEME_PATTERN } = require('./targets');
const { resolveScripts, buildInjection } = require('./scripts');
const { loadState, saveState } = require('./settings');

// Heights of the two rows the navigation view can show. The view is sized to
// their sum and the page hides the rows it was told not to draw, so the main
// process stays the single source of truth for the layout.
const TAB_BAR_HEIGHT = 32;
const TOOLBAR_HEIGHT = 40;

// The always-visible handle in the top-right corner: a drag strip plus the
// button that reveals the navigation bar.
const HANDLE_WIDTH = 96;
const HANDLE_HEIGHT = 22;

const MIN_CONTENT_HEIGHT = 80;
const BLANK_URL = 'about:blank';

// Remote pages get their own session so nothing they store is shared with the
// navigation bar or the handle, which run with a preload.
const CONTENT_PARTITION = 'persist:ostinato-content';

let mainWindow = null;
let navigationView = null;
let handleView = null;
let tray = null;
let quitting = false;

const tabs = new Map();
let nextTabId = 1;
let activeTabId = null;

let navigationVisible = false;
// Set by the `▼` button / Cmd+L: a pinned bar stays until it is explicitly
// dismissed, while a hover-revealed bar hides itself again.
let navigationPinned = false;
let hoverHideTimer = null;

let persisted = null;
let injections = [];
// The pages named on the command line. "Restart" goes back to exactly these.
let cliTargets = [];
// Scratch directories holding HTML passed via --html / --html-file / stdin.
const tempDirs = [];

const cli = parseCli(process.argv.slice(app.isPackaged ? 1 : 2));

if (cli.help) {
  console.log(helpText(pkg.version));
  app.exit(0);
} else if (cli.version) {
  console.log(pkg.version);
  app.exit(0);
} else if (cli.errors.length > 0) {
  for (const error of cli.errors) console.error(`ostinato: ${error}`);
  console.error('Run `ostinato --help` for usage.');
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
    const resolved = resolveScripts(cli.scripts);
    for (const error of resolved.errors) console.error(`ostinato: ${error}`);
    injections = resolved.scripts.map((script) => ({ origin: script.origin, code: buildInjection(script) }));

    cliTargets = collectStartupUrls();

    if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
      const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'resources', 'icon.png'));
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    }

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
    console.error(`ostinato: ${target.reason}`);
    return null;
  }
  return target.url;
}

// Reads the whole of stdin. A data: URL would be simpler but breaks relative
// references inside the HTML and has a length ceiling, so the markup goes
// through a real file instead.
function readStdin() {
  if (process.stdin.isTTY) {
    console.error('ostinato: `-` was given but stdin is a terminal');
    return '';
  }
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (error) {
    console.error(`ostinato: cannot read stdin: ${error.message}`);
    return '';
  }
}

function htmlToUrl(html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ostinato-'));
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
      console.warn(`ostinato: could not remove ${dir}: ${error.message}`);
    }
  }
}

function createWindow() {
  const bounds = startupBounds();

  mainWindow = new BaseWindow({
    ...bounds,
    minWidth: 320,
    minHeight: 200,
    title: cli.title || 'Ostinato',
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

  navigationView = createChromeView('navigation.html');
  handleView = createChromeView('handle.html');
  mainWindow.contentView.addChildView(navigationView);
  mainWindow.contentView.addChildView(handleView);

  openStartupTabs();

  mainWindow.on('resize', relayout);
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
    mainWindow = null;
    navigationView = null;
    handleView = null;
    tabs.clear();
    activeTabId = null;
  });

  if (cli.menubar) mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  relayout();
}

// `ostinato a.example b.example` should land on the first page named, not the
// last one to finish being created, so the selection is redone at the end.
function openStartupTabs() {
  const created = cliTargets.map((url) => createTab(url, { runScripts: true })).filter(Boolean);
  if (created.length > 1) selectTab(created[0].id);
}

// How much window chrome to keep.
//
// On macOS `frame: false` removes the traffic lights along with the title bar,
// which leaves no way to close the window; `titleBarStyle: 'hiddenInset'` gives
// the same edge-to-edge content while keeping them. A menu bar popover is the
// exception -- it is dismissed by clicking the tray icon, so it takes the fully
// frameless treatment on every platform.
function framingOptions() {
  if (cli.frame) return {};
  if (cli.menubar) return { frame: false };
  return process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : { frame: false };
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
  // Transparent so the handle only paints its own grip and button; the
  // navigation bar draws its own opaque background in CSS.
  view.setBackgroundColor('#00000000');
  view.webContents.on('before-input-event', handleShortcut);
  view.webContents.loadFile(path.join(__dirname, page));
  return view;
}

function createTab(url, { runScripts = false } = {}) {
  if (!url || !mainWindow) return null;

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'content-preload.js'),
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
    if (mainWindow && tab.id === activeTabId && !cli.title) mainWindow.setTitle(title);
    pushState();
  });
  contents.on('did-navigate', () => syncNavigationState(tab));
  contents.on('did-navigate-in-page', () => syncNavigationState(tab));
  contents.on('did-finish-load', () => {
    syncNavigationState(tab);
    if (tab.runScriptsOnLoad || cli.jsEveryLoad) {
      tab.runScriptsOnLoad = false;
      runInjections(tab);
    }
  });
  contents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
    if (isMainFrame) console.error(`ostinato: failed to load ${failedUrl}: ${description} (${code})`);
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

  mainWindow.contentView.addChildView(view);
  // Child views stack in insertion order, so the handle has to be lifted back
  // above the page every time a tab is added or it ends up behind it.
  mainWindow.contentView.removeChildView(handleView);
  mainWindow.contentView.addChildView(handleView);

  contents.loadURL(url);
  if (cli.openDevtools) contents.openDevTools({ mode: 'detach' });

  selectTab(tab.id);
  return tab;
}

function syncNavigationState(tab) {
  tab.url = tab.view.webContents.getURL();
  tab.canGoBack = tab.view.webContents.navigationHistory.canGoBack();
  tab.canGoForward = tab.view.webContents.navigationHistory.canGoForward();
  pushState();
}

async function runInjections(tab) {
  for (const injection of injections) {
    try {
      // userGesture: media playback and fullscreen requests are gated on one,
      // and a script that opens a video is the point of the feature.
      await tab.view.webContents.executeJavaScript(injection.code, true);
    } catch (error) {
      console.error(`ostinato: script from ${injection.origin} failed: ${error.message}`);
    }
  }
}

function selectTab(tabId) {
  if (!tabs.has(tabId)) return;
  activeTabId = tabId;
  for (const [id, tab] of tabs) tab.view.setVisible(id === tabId);
  const active = tabs.get(tabId);
  if (!cli.title) mainWindow.setTitle(active.title || 'Ostinato');
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

// The tab strip earns its space once there is a choice to make, so a single-tab
// window stays completely bare. Both the layout and the renderer state read it.
function isTabBarVisible() {
  return navigationVisible || tabs.size > 1;
}

function relayout() {
  if (!mainWindow || !navigationView) return;
  const { width, height } = mainWindow.getContentBounds();

  const bandHeight = (navigationVisible ? TOOLBAR_HEIGHT : 0) + (isTabBarVisible() ? TAB_BAR_HEIGHT : 0);
  const contentHeight = Math.max(height - bandHeight, MIN_CONTENT_HEIGHT);

  navigationView.setBounds({ x: 0, y: 0, width, height: bandHeight });
  navigationView.setVisible(bandHeight > 0);

  for (const [id, tab] of tabs) {
    tab.view.setBounds({ x: 0, y: bandHeight, width, height: contentHeight });
    tab.view.setVisible(id === activeTabId);
  }

  handleView.setBounds({ x: Math.max(width - HANDLE_WIDTH, 0), y: 0, width: Math.min(HANDLE_WIDTH, width), height: HANDLE_HEIGHT });
  handleView.setVisible(!navigationVisible);

  pushState();
}

function buildState() {
  return {
    navigationVisible,
    tabBarVisible: isTabBarVisible(),
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
  if (!navigationView || navigationView.webContents.isDestroyed()) return;
  navigationView.webContents.send('state', buildState());
}

function setNavigationVisible(visible, { pinned = false } = {}) {
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

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => { createTab(BLANK_URL); focusUrlBar(); } },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => activeTabId && closeTab(activeTabId) },
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
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: withActiveTab((contents) => contents.reload()) },
        { label: 'Restart', click: restartTargets },
        { type: 'separator' },
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
  tray.setToolTip(cli.title || 'Ostinato');

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
ipcMain.handle('open-external', () => {
  const tab = activeTab();
  // Only the schemes a browser or the file manager would sensibly take. Handing
  // `data:` or a custom scheme to the OS from a button the page can influence
  // is not worth the risk.
  if (tab && /^(https?|file):/i.test(tab.url)) shell.openExternal(tab.url);
});
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

// Sent by content-preload when the pointer dwells on the very top edge.
ipcMain.on('edge-hover', () => {
  if (!navigationVisible) setNavigationVisible(true);
});
