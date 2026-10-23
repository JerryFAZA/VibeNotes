/**
 * VibeNotes for Windows (win64)
 * A Windows port inspired by the open-source macOS app oil-oil/NotchNotes (v0.2.1).
 * Fresh implementation on Electron — no decompilation of the original binary.
 *
 * Main process: frameless transparent top-anchored window, tray icon,
 * trigger modes (hover / click / tray-only), keep-awake (powerSaveBlocker),
 * JSON persistence for notes / shelf / settings, drag-out of shelf files.
 */
'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, powerSaveBlocker, screen, nativeImage, shell, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const APP_NAME = 'VibeNotes';

// ---------------------------------------------------------------------------
// Legacy data migration: the app was first shipped as "NotchNotes", so
// existing users keep their notes under %APPDATA%\NotchNotes. Copy everything
// into the new %APPDATA%\VibeNotes directory on first run of the renamed app.
// ---------------------------------------------------------------------------
function migrateLegacyUserData() {
  try {
    const legacy = path.join(app.getPath('appData'), 'NotchNotes');
    const target = userDataDir();
    if (!fs.existsSync(legacy)) return;
    if (fs.existsSync(path.join(target, 'notes.json'))) return; // already migrated
    fs.mkdirSync(target, { recursive: true });
    for (const f of ['notes.json', 'shelf.json', 'settings.json']) {
      const src = path.join(legacy, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(target, f));
    }
    const legacyImages = path.join(legacy, 'images');
    if (fs.existsSync(legacyImages)) {
      fs.cpSync(legacyImages, path.join(target, 'images'), { recursive: true });
    }
  } catch { /* best effort - never block startup */ }
}
app.setName(APP_NAME);

// Login item must carry the app dir as an argument, otherwise booting
// electron.exe bare would show Electron's default "no app" error window.
const LAUNCH_APP_DIR = path.dirname(__dirname);
function setLoginItem(open) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!open, path: process.execPath, args: [LAUNCH_APP_DIR] });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ---------------------------------------------------------------------------
// Paths & persistence
// ---------------------------------------------------------------------------
const userDataDir = () => app.getPath('userData');
const dataFile = (name) => path.join(userDataDir(), name);
const imagesDir = () => path.join(userDataDir(), 'images');

async function readJson(fileName, fallback) {
  try {
    const raw = await fsp.readFile(dataFile(fileName), 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(fileName, value) {
  await fsp.mkdir(userDataDir(), { recursive: true });
  const file = dataFile(fileName);
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fsp.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Settings (main-process owned part)
// ---------------------------------------------------------------------------
const TRIGGER_MODES = ['hover', 'click', 'tray'];
const AUTO_COLLAPSE_MODES = ['mouseLeave', 'none'];

let settings = {
  triggerMode: 'hover',          // 'hover' | 'click' | 'tray'
  autoCollapse: 'mouseLeave',    // 'mouseLeave' | 'none'
  keepAwake: false,              // prevent system sleep
  screenAlwaysOn: false,         // prevent display sleep
  launchAtLogin: false,
  windowX: null,                 // legacy: remembered window x (relative to primary workArea.x)
  windowPos: null,               // {cx, cy}: absolute window-center coords (multi-display aware)
  pinned: false,                 // panel stays expanded & on top until unpinned
};

async function loadSettings() {
  const stored = await readJson('settings.json', {});
  if (TRIGGER_MODES.includes(stored.triggerMode)) settings.triggerMode = stored.triggerMode;
  if (AUTO_COLLAPSE_MODES.includes(stored.autoCollapse)) settings.autoCollapse = stored.autoCollapse;
  settings.keepAwake = !!stored.keepAwake;
  settings.screenAlwaysOn = !!stored.screenAlwaysOn;
  settings.launchAtLogin = !!stored.launchAtLogin;
  settings.windowX = (typeof stored.windowX === 'number' && Number.isFinite(stored.windowX)) ? stored.windowX : null;
  settings.windowPos = (stored.windowPos && typeof stored.windowPos.cx === 'number' && typeof stored.windowPos.cy === 'number')
    ? stored.windowPos : null;
  settings.pinned = !!stored.pinned;
  // One-time migration: legacy windowX (top-anchored on primary) -> absolute center
  if (!settings.windowPos && settings.windowX !== null) {
    try {
      const wa = screen.getPrimaryDisplay().workArea;
      settings.windowPos = { cx: Math.round(wa.x + settings.windowX + WIN_WIDTH / 2), cy: Math.round(wa.y + WIN_HEIGHT / 2) };
    } catch { /* ignore */ }
  }
  // Recover login item truth from OS (user may disable it in Task Manager)
  try {
    settings.launchAtLogin = app.getLoginItemSettings({ path: process.execPath, args: [LAUNCH_APP_DIR] }).openAtLogin;
  } catch { /* ignore */ }

  // Self-heal: an early build registered bare electron.exe (no app args) as a
  // login item - on boot it opens Electron's default window instead of the
  // app. Remove that leftover unless the corrected entry is present.
  try {
    const legacy = app.getLoginItemSettings({ path: process.execPath });
    const corrected = app.getLoginItemSettings({ path: process.execPath, args: [LAUNCH_APP_DIR] });
    if (legacy.openAtLogin && !corrected.openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: false, path: process.execPath, args: [] });
    }
  } catch { /* ignore */ }
}

function persistSettings() {
  writeJson('settings.json', settings).catch(() => {});
}

// ---------------------------------------------------------------------------
// Keep-awake (powerSaveBlocker)
// ---------------------------------------------------------------------------
let systemSleepBlockerId = null;
let displaySleepBlockerId = null;

function applyKeepAwake() {
  // Valid blocker types in Electron: 'prevent-app-suspension' | 'prevent-display-sleep'
  if (settings.keepAwake) {
    if (systemSleepBlockerId === null || !powerSaveBlocker.isStarted(systemSleepBlockerId)) {
      systemSleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
  } else if (systemSleepBlockerId !== null && powerSaveBlocker.isStarted(systemSleepBlockerId)) {
    powerSaveBlocker.stop(systemSleepBlockerId);
    systemSleepBlockerId = null;
  }

  if (settings.screenAlwaysOn) {
    if (displaySleepBlockerId === null || !powerSaveBlocker.isStarted(displaySleepBlockerId)) {
      displaySleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    }
  } else if (displaySleepBlockerId !== null && powerSaveBlocker.isStarted(displaySleepBlockerId)) {
    powerSaveBlocker.stop(displaySleepBlockerId);
    displaySleepBlockerId = null;
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let win = null;
let tray = null;
let expanded = false;            // current visual state of the drawer
let iconCache = null;            // nativeImage for tray / drag

const WIN_WIDTH = 720;
const WIN_HEIGHT = 540;

function appIcon() {
  if (iconCache) return iconCache;
  const pngPath = path.join(__dirname, 'assets', 'icon.png');
  try {
    iconCache = nativeImage.createFromPath(pngPath);
  } catch {
    iconCache = nativeImage.createEmpty();
  }
  if (iconCache.isEmpty()) {
    // 1x1 transparent fallback so Tray() never throws
    iconCache = nativeImage.createFromBuffer(
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
    );
  }
  return iconCache;
}

function anchorWindow() {
  // Remembered absolute center (multi-display aware): place on the display
  // that contains it, clamped fully inside that display's work area.
  if (settings.windowPos) {
    try {
      const disp = screen.getDisplayNearestPoint({ x: Math.round(settings.windowPos.cx), y: Math.round(settings.windowPos.cy) });
      const wa = disp.workArea;
      let x = settings.windowPos.cx - WIN_WIDTH / 2;
      let y = settings.windowPos.cy - WIN_HEIGHT / 2;
      x = Math.max(wa.x, Math.min(x, wa.x + wa.width - WIN_WIDTH));
      y = Math.max(wa.y, Math.min(y, wa.y + wa.height - WIN_HEIGHT));
      return { x: Math.round(x), y: Math.round(y), width: WIN_WIDTH, height: WIN_HEIGHT };
    } catch { /* fall through to default */ }
  }
  // Legacy windowX or first run: top-centered on the primary display
  const wa = screen.getPrimaryDisplay().workArea;
  let relX = (typeof settings.windowX === 'number') ? settings.windowX : Math.round((wa.width - WIN_WIDTH) / 2);
  relX = Math.max(0, Math.min(relX, wa.width - WIN_WIDTH));
  const x = Math.round(wa.x + relX);
  const y = wa.y;
  return { x, y, width: WIN_WIDTH, height: WIN_HEIGHT };
}

function rememberWindowPos(cx, cy) {
  settings.windowPos = { cx: Math.round(cx), cy: Math.round(cy) };
  persistSettings();
}

function createWindow() {
  win = new BrowserWindow({
    ...anchorWindow(),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'index.html'));

  win.once('ready-to-show', () => {
    win.showInactive();
    // Start collapsed and click-through; renderer drives expansion.
    win.webContents.send('settings-updated', publicSettings());
    setClickThrough(true);
  });

  win.on('closed', () => { win = null; });

  // Re-anchor when display topology changes (dock/undock, resolution change)
  screen.on('display-metrics-changed', () => {
    if (win && !win.isDestroyed()) win.setBounds(anchorWindow());
  });
}

function setClickThrough(ignore) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setIgnoreMouseEvents(ignore, { forward: true });
  } catch { /* platform guard */ }
}

// ---------------------------------------------------------------------------
// Auto-collapse watcher (main process, system cursor based).
// - mouseLeave: cursor outside the window -> collapse
// ---------------------------------------------------------------------------
let leaveWatchTimer = null;
let outsideCount = 0;

function stopLeaveWatch() {
  if (leaveWatchTimer) { clearInterval(leaveWatchTimer); leaveWatchTimer = null; }
  outsideCount = 0;
}

function startLeaveWatch() {
  stopLeaveWatch();
  leaveWatchTimer = setInterval(() => {
    if (!expanded || settings.pinned) { stopLeaveWatch(); return; }
    if (dragTimer) return;   // a window drag is in progress: never auto-collapse
    if (settings.autoCollapse !== 'mouseLeave') { stopLeaveWatch(); return; }
    if (!win || win.isDestroyed()) { stopLeaveWatch(); return; }
    try {
      const p = screen.getCursorScreenPoint();
      const b = win.getBounds();
      const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
      if (!inside) {
        outsideCount++;
        if (outsideCount >= 2) {          // ~440ms outside -> collapse
          stopLeaveWatch();
          win.webContents.send('collapse-requested', 'auto');
        }
      } else {
        outsideCount = 0;
      }
    } catch {
      stopLeaveWatch();
    }
  }, 220);
}

// ---------------------------------------------------------------------------
// Pill drag (free positioning incl. second display) + top-edge snapping.
// Main-process driven: the real cursor is polled, so fast pointer moves never
// drop frames. Release near a display's top edge snaps to that top edge and
// aligns X to left/center/right (legacy notch behavior); anywhere else the
// window simply stays where dropped, clamped fully on-screen.
// ---------------------------------------------------------------------------
let dragTimer = null;
let dragGrabOffsetX = 0;
let dragGrabOffsetY = 0;
let dragBounds = null;           // virtual-screen union bounds
let dragMode = 'pill';           // 'pill' (collapse auto-collapse on top) | 'panel' (free)
let snapAnimTimer = null;

function stopDrag() {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
}

function stopSnapAnim() {
  if (snapAnimTimer) { clearInterval(snapAnimTimer); snapAnimTimer = null; }
}

function virtualScreenBounds() {
  let ux1 = Infinity, uy1 = Infinity, ux2 = -Infinity, uy2 = -Infinity;
  for (const d of screen.getAllDisplays()) {
    ux1 = Math.min(ux1, d.bounds.x);
    uy1 = Math.min(uy1, d.bounds.y);
    ux2 = Math.max(ux2, d.bounds.x + d.bounds.width);
    uy2 = Math.max(uy2, d.bounds.y + d.bounds.height);
  }
  return { ux1, uy1, ux2, uy2 };
}

function startDrag(mode) {
  if (!win || win.isDestroyed() || dragTimer) return;
  stopSnapAnim();
  dragMode = (mode === 'panel') ? 'panel' : 'pill';
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  dragGrabOffsetX = p.x - b.x;
  dragGrabOffsetY = p.y - b.y;
  dragBounds = virtualScreenBounds();
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed()) { stopDrag(); return; }
    try {
      const p2 = screen.getCursorScreenPoint();
      let x = p2.x - dragGrabOffsetX;
      let y = p2.y - dragGrabOffsetY;
      // keep the window fully inside the virtual screen (spans all displays)
      x = Math.max(dragBounds.ux1, Math.min(x, dragBounds.ux2 - WIN_WIDTH));
      y = Math.max(dragBounds.uy1, Math.min(y, dragBounds.uy2 - WIN_HEIGHT));
      win.setBounds({ x, y, width: WIN_WIDTH, height: WIN_HEIGHT });
    } catch {
      stopDrag();
    }
  }, 16);
}

function endDrag(mode) {
  stopDrag();
  if (!win || win.isDestroyed()) return;
  const m = (mode === 'panel') ? 'panel' : dragMode;
  try {
    const b = win.getBounds();
    const disp = screen.getDisplayMatching(b);
    const wa = disp.workArea;
    // 'pill' release near a display's top edge -> snap to that top edge.
    // X is FREE now: it stays wherever the user dropped it (clamped on-screen).
    const wantSnap = m === 'pill' && Math.abs(b.y - wa.y) <= 48;
    const x = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - WIN_WIDTH));
    if (wantSnap) {
      const y = wa.y;
      animateWindowTo(x, y);
      rememberWindowPos(x + WIN_WIDTH / 2, y + WIN_HEIGHT / 2);
    } else {
      // Free placement (any X on the screen, any display, or expanded panel)
      const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - WIN_HEIGHT));
      win.setBounds({ x, y, width: WIN_WIDTH, height: WIN_HEIGHT });
      rememberWindowPos(x + WIN_WIDTH / 2, y + WIN_HEIGHT / 2);
    }
  } catch { /* ignore */ }
}

function animateWindowTo(targetX, targetY) {
  stopSnapAnim();
  if (!win || win.isDestroyed()) return;
  const start = Date.now();
  const dur = 260;
  const from = win.getBounds();
  const fx = from.x, fy = from.y;
  snapAnimTimer = setInterval(() => {
    if (!win || win.isDestroyed()) { stopSnapAnim(); return; }
    const t = Math.min(1, (Date.now() - start) / dur);
    const ease = 1 - Math.pow(1 - t, 3);            // easeOutCubic
    win.setBounds({
      x: Math.round(fx + (targetX - fx) * ease),
      y: Math.round(fy + (targetY - fy) * ease),
      width: WIN_WIDTH,
      height: WIN_HEIGHT,
    });
    if (t >= 1) stopSnapAnim();
  }, 16);
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function buildTrayMenu() {
  const modeItem = (mode, label) => ({
    label,
    type: 'radio',
    checked: settings.triggerMode === mode,
    click: () => setTriggerMode(mode),
  });

  return Menu.buildFromTemplate([
    { label: expanded ? '收起笔记面板' : '打开笔记面板', click: () => togglePanelFromTray() },
    { type: 'separator' },
    modeItem('hover', '触发模式：悬停 (Hover)'),
    modeItem('click', '触发模式：点击 (Click)'),
    modeItem('tray', '触发模式：仅托盘 (Tray Only)'),
    { type: 'separator' },
    {
      label: '保持唤醒（防止系统休眠）',
      type: 'checkbox',
      checked: settings.keepAwake,
      click: (item) => { settings.keepAwake = item.checked; applyKeepAwake(); persistSettings(); pushSettings(); },
    },
    {
      label: '屏幕常亮（防止屏幕关闭）',
      type: 'checkbox',
      checked: settings.screenAlwaysOn,
      click: (item) => { settings.screenAlwaysOn = item.checked; applyKeepAwake(); persistSettings(); pushSettings(); },
    },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: settings.launchAtLogin,
      click: (item) => {
        settings.launchAtLogin = item.checked;
        setLoginItem(item.checked);
        persistSettings(); pushSettings();
      },
    },
    { type: 'separator' },
    { label: '打开数据文件夹', click: () => shell.openPath(userDataDir()) },
    { type: 'separator' },
    { label: '退出 VibeNotes', click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(appIcon());
  tray.setToolTip('VibeNotes');
  tray.on('click', () => togglePanelFromTray());
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function togglePanelFromTray() {
  if (!win || win.isDestroyed()) return;
  if (expanded) {
    win.webContents.send('collapse-requested', 'tray');
  } else {
    win.webContents.send('expand-requested', 'tray');
  }
}

// ---------------------------------------------------------------------------
// Trigger mode & IPC
// ---------------------------------------------------------------------------
function publicSettings() {
  return {
    triggerMode: settings.triggerMode,
    autoCollapse: settings.autoCollapse,
    keepAwake: settings.keepAwake,
    screenAlwaysOn: settings.screenAlwaysOn,
    launchAtLogin: settings.launchAtLogin,
    pinned: settings.pinned,
    keepAwakeActive: systemSleepBlockerId !== null && powerSaveBlocker.isStarted(systemSleepBlockerId),
    displayAlwaysOnActive: displaySleepBlockerId !== null && powerSaveBlocker.isStarted(displaySleepBlockerId),
  };
}

function setTriggerMode(mode) {
  if (!TRIGGER_MODES.includes(mode)) return;
  settings.triggerMode = mode;
  persistSettings();
  pushSettings();
}

function pushSettings() {
  if (win && !win.isDestroyed()) win.webContents.send('settings-updated', publicSettings());
  refreshTrayMenu();
}

function registerIpc() {
  ipcMain.handle('settings:get', () => publicSettings());

  ipcMain.on('window:focus', () => {
    if (!win || win.isDestroyed()) return;
    win.focus();
    // Second nudge defeats Windows foreground-lock on some launches.
    setTimeout(() => { if (win && !win.isDestroyed()) win.focus(); }, 60);
  });

  ipcMain.on('settings:set-trigger-mode', (_e, mode) => setTriggerMode(mode));

  ipcMain.on('settings:set-keepawake', (_e, value) => {
    settings.keepAwake = !!value;
    applyKeepAwake(); persistSettings(); pushSettings();
  });

  ipcMain.on('settings:set-auto-collapse', (_e, value) => {
    if (AUTO_COLLAPSE_MODES.includes(value)) {
      settings.autoCollapse = value;
      persistSettings();
      pushSettings();
      if (expanded && settings.autoCollapse === 'mouseLeave') {
        startLeaveWatch();
      } else {
        stopLeaveWatch();
      }
    }
  });

  ipcMain.on('settings:set-pinned', (_e, value) => {
    settings.pinned = !!value;
    persistSettings();
    pushSettings();
    // Pinned suppresses every auto-collapse path.
    if (settings.pinned || !expanded) stopLeaveWatch();
    else if (settings.autoCollapse === 'mouseLeave') startLeaveWatch();
    else stopLeaveWatch();
  });

  ipcMain.on('settings:set-screen-always-on', (_e, value) => {
    settings.screenAlwaysOn = !!value;
    applyKeepAwake(); persistSettings(); pushSettings();
  });

  ipcMain.on('settings:set-launch-at-login', (_e, value) => {
    settings.launchAtLogin = !!value;
    setLoginItem(settings.launchAtLogin);
    persistSettings(); pushSettings();
  });

  ipcMain.on('app:open-data-dir', () => {
    shell.openPath(userDataDir());
  });

  ipcMain.on('shell:open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });

  // Click-through control from renderer
  ipcMain.on('clickthrough:set', (_e, ignore) => setClickThrough(!!ignore));

  // Pill drag (X axis) + edge snapping
  ipcMain.on('window:drag-start', (_e, mode) => startDrag(mode));
  ipcMain.on('window:drag-end', (_e, mode) => endDrag(mode));

  ipcMain.on('panel:expanded', (_e, value) => {
    expanded = !!value;
    refreshTrayMenu();
    if (expanded && settings.autoCollapse === 'mouseLeave') {
      startLeaveWatch();
    } else {
      stopLeaveWatch();
    }
  });

  // --- persistence ---------------------------------------------------------
  ipcMain.handle('data:load', async (_e, fileName, fallback) => readJson(fileName, fallback));
  ipcMain.handle('data:save', (_e, fileName, value) => writeJson(fileName, value));

  // --- files ----------------------------------------------------------------
  ipcMain.handle('file:exists', (_e, p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });

  ipcMain.handle('file:reveal', (_e, p) => {
    try { shell.showItemInFolder(p); return true; } catch { return false; }
  });

  ipcMain.handle('file:open', (_e, p) => {
    try { shell.openPath(p); return true; } catch { return false; }
  });

  ipcMain.handle('file:stat-size', (_e, p) => {
    try { return fs.statSync(p).size; } catch { return -1; }
  });

  // --- pasted images ---------------------------------------------------------
  ipcMain.handle('image:save', async (_e, dataUrl) => {
    try {
      const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/.exec(dataUrl || '');
      if (!m) return null;
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      await fsp.mkdir(imagesDir(), { recursive: true });
      const name = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      await fsp.writeFile(path.join(imagesDir(), name), Buffer.from(m[2], 'base64'));
      return `images/${name}`;
    } catch {
      return null;
    }
  });

  ipcMain.handle('image:read', async (_e, relPath) => {
    try {
      const safe = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
      const full = path.join(imagesDir(), path.basename(safe));
      const buf = await fsp.readFile(full);
      const ext = path.extname(full).slice(1).toLowerCase();
      const mime = ext === 'jpg' ? 'jpeg' : (ext || 'png');
      return `data:image/${mime};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  });

  // --- drag out of the shelf --------------------------------------------------
  ipcMain.on('shelf:drag-start', (_e, filePath) => {
    if (!win || win.isDestroyed()) return;
    try {
      const icon = appIcon().resize({ width: 32, height: 32 });
      win.webContents.startDrag({ file: filePath, icon });
    } catch { /* ignore */ }
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    win.showInactive();
    win.webContents.send('expand-requested', 'second-instance');
  }
});

app.whenReady().then(async () => {
  migrateLegacyUserData();
  try {
    await loadSettings();
    applyKeepAwake();
  } catch (err) {
    // Never let a settings/power issue block window & tray creation.
    console.error('startup recovery:', err);
  }
  registerIpc();
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  // Tray app: keep running unless quitting was requested explicitly.
  if (!win) app.quit();
});

app.on('before-quit', () => {
  applyKeepAwake === null; // noop guard
  // Stop blockers so the machine can sleep after exit even if setting was on.
  if (systemSleepBlockerId !== null) { try { powerSaveBlocker.stop(systemSleepBlockerId); } catch {} }
  if (displaySleepBlockerId !== null) { try { powerSaveBlocker.stop(displaySleepBlockerId); } catch {} }
});
