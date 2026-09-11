/*
 * Kline desktop shell.
 *
 * A thin Electron host around the same static bundle the web build ships.
 * It adds the three things a browser tab cannot: a real application window,
 * a native menu bar driven by Kline's own command registry, and native file
 * dialogs for opening and saving scenes.
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const IS_MAC = process.platform === 'darwin';
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

// A privileged custom scheme, because ES modules and service workers are both
// blocked on file:// — this gives the bundle a proper secure origin.
protocol.registerSchemesAsPrivileged([{
  scheme: 'kline',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
}]);

let mainWindow = null;
/** A scene path from the command line or a Finder double-click, held until the window is ready. */
let pendingOpen = null;

function readWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch {
    /* First run, or the file is unreadable — fall back to defaults. */
  }
  return { width: 1440, height: 900 };
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...bounds, maximized: win.isMaximized() }));
  } catch {
    /* Losing the window position is not worth interrupting a quit. */
  }
}

/*
 * Content types the bundle needs stated explicitly.
 *
 * Fetching a file:// URL does not reliably label what comes back, and one of
 * these matters a great deal: WebAssembly has to arrive as application/wasm or
 * the browser refuses to compile it as a stream. It still runs — it falls back
 * to buffering the whole 13MB and compiling that — but slower, and with a
 * console error that looks like a fault. The depth model is 26MB of
 * octet-stream for the same reason.
 */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};

function serveBundle() {
  protocol.handle('kline', async (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '' || pathname === '/') pathname = '/index.html';
    const target = path.join(DIST, path.normalize(pathname));
    if (!target.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    if (!fs.existsSync(target)) return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(target).toString());
    const type = CONTENT_TYPES[path.extname(target).toLowerCase()];
    if (!type) return response;
    const headers = new Headers(response.headers);
    headers.set('Content-Type', type);
    return new Response(response.body, { status: response.status, headers });
  });
}

function createWindow() {
  const state = readWindowState();
  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#131214',
    title: 'Kline',
    show: false,
    autoHideMenuBar: false,
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? { x: 14, y: 10 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (state.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // The page title is written for a browser tab; the window keeps the app name.
  mainWindow.on('page-title-updated', (event) => event.preventDefault());
  mainWindow.on('close', () => saveWindowState(mainWindow));
  mainWindow.on('closed', () => { mainWindow = null; });

  // Anything that is not the app itself belongs in the user's browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL('kline://app/');

  // Smoke-test hook: `KLINE_SMOKE=<png path> electron .` boots the shell, saves
  // a screenshot and exits, so CI can prove the desktop build actually renders
  // — including the packaged app, on a real machine of that platform.
  // KILN_SMOKE is the pre-rename name, still honoured so an older workflow or
  // a script someone has locally keeps working.
  const smokeTarget = process.env.KLINE_SMOKE || process.env.KILN_SMOKE;
  if (smokeTarget) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(smokeTarget, image.toPNG());
        const menu = Menu.getApplicationMenu();
        console.log(JSON.stringify({
          menus: menu ? menu.items.map((i) => i.label) : [],
          title: mainWindow.getTitle(),
        }));
        app.exit(0);
      }, 2500);
    });
  }

  return mainWindow;
}

/** Turn Kline's own shortcut strings into Electron accelerators. */
function toAccelerator(shortcut) {
  if (!shortcut || !/ctrl\+/i.test(shortcut)) return undefined; // single keys stay with the canvas
  if (/numpad/i.test(shortcut)) return undefined;
  return shortcut.replace(/ctrl/gi, 'CmdOrCtrl');
}

const MENU_ORDER = ['File', 'Edit', 'Add', 'Object', 'Mesh', 'Select', 'View'];

function buildMenu(commands) {
  const send = (id) => () => mainWindow?.webContents.send('kline:command', id);
  const byCategory = new Map();
  for (const cmd of commands ?? []) {
    const list = byCategory.get(cmd.category) ?? [];
    list.push(cmd);
    byCategory.set(cmd.category, list);
  }

  const template = [];

  if (IS_MAC) {
    template.push({
      label: 'Kline',
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    });
  }

  for (const category of MENU_ORDER) {
    const items = (byCategory.get(category) ?? []).map((cmd) => ({
      label: cmd.label,
      accelerator: toAccelerator(cmd.shortcut),
      click: send(cmd.id),
    }));
    if (category === 'File') {
      if (items.length) items.push({ type: 'separator' });
      items.push(IS_MAC ? { role: 'close' } : { role: 'quit' });
    }
    if (category === 'View') {
      items.push(
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      );
    }
    if (items.length) template.push({ label: category, submenu: items });
  }

  template.push({
    label: 'Help',
    submenu: [
      { label: 'Keyboard Shortcuts', click: () => mainWindow?.webContents.send('kline:shortcuts') },
      { type: 'separator' },
      {
        label: 'Kline on GitHub',
        click: () => shell.openExternal('https://github.com/22500107Zc/Kline'),
      },
    ],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function queueOpen(filePath) {
  if (!filePath || !/\.(kline|kiln)$/.test(filePath)) return;
  if (mainWindow) mainWindow.webContents.send('kline:open-file', readScene(filePath));
  else pendingOpen = filePath;
}

function readScene(filePath) {
  try {
    return { name: path.basename(filePath), text: fs.readFileSync(filePath, 'utf8') };
  } catch (err) {
    dialog.showErrorBox('Could not open scene', `${filePath}\n\n${err.message}`);
    return null;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    queueOpen(argv.find((a) => /\.(kline|kiln)$/.test(a)));
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    queueOpen(filePath);
  });

  app.whenReady().then(() => {
    serveBundle();
    buildMenu([]);
    createWindow();
    queueOpen(process.argv.find((a) => /\.(kline|kiln)$/.test(a)));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit();
  });
}

// The renderer owns the command registry, so it tells the shell what to show.
ipcMain.on('kline:register-commands', (_event, commands) => {
  buildMenu(commands);
  if (pendingOpen && mainWindow) {
    mainWindow.webContents.send('kline:open-file', readScene(pendingOpen));
    pendingOpen = null;
  }
});

const FILTERS = {
  kline: { name: 'Kline Scene', extensions: ['kline'] },
  obj: { name: 'Wavefront OBJ', extensions: ['obj'] },
  mtl: { name: 'Material Library', extensions: ['mtl'] },
  stl: { name: 'STL', extensions: ['stl'] },
  gltf: { name: 'glTF 2.0', extensions: ['gltf'] },
};

// Every export goes through a real Save dialog rather than a silent download.
/**
 * Write a file so that a failure half way through cannot destroy the version
 * that was already there.
 *
 * The previous write went straight at the destination, so an interruption —
 * a full disk, a pulled drive, power — left the person's project truncated
 * with no copy of what it had been. Writing beside it and renaming into place
 * means the destination only ever holds a whole file: the rename is atomic on
 * POSIX, and on Windows it replaces in one step.
 *
 * The data is flushed before the rename. Without that the rename can land
 * while the contents are still in the page cache, which is the one ordering
 * that turns a crash into an empty file with a valid name.
 */
function writeAtomic(filePath, data, binary) {
  const tmp = `${filePath}.kline-tmp-${process.pid}-${Date.now()}`;
  let handle = null;
  try {
    handle = fs.openSync(tmp, 'wx');
    fs.writeFileSync(handle, binary ? Buffer.from(data) : data, binary ? undefined : 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (handle !== null) { try { fs.closeSync(handle); } catch (e) { /* already gone */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* best effort */ }
    throw err;
  }
}

ipcMain.handle('kline:save-file', async (_event, { defaultName, data, binary }) => {
  const ext = String(defaultName ?? '').split('.').pop()?.toLowerCase() ?? '';
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export',
    defaultPath: defaultName ?? 'untitled',
    filters: FILTERS[ext] ? [FILTERS[ext]] : [],
  });
  // Cancelled and failed are different answers and the caller acts on them
  // differently: one is a decision, the other is a problem. Returning null for
  // both is what let "Saved" appear over a disk that was full.
  if (canceled || !filePath) return { status: 'cancelled' };
  try {
    writeAtomic(filePath, data, binary);
    return { status: 'saved', path: filePath };
  } catch (err) {
    dialog.showErrorBox('Could not save file', `${filePath}\n\n${err.message}`);
    return { status: 'failed', reason: err.message };
  }
});

ipcMain.handle('kline:open-scene', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Scene',
    properties: ['openFile'],
    filters: [{ name: 'Kline Scene', extensions: ['kline', 'kiln'] }],
  });
  if (canceled || filePaths.length === 0) return null;
  return readScene(filePaths[0]);
});
