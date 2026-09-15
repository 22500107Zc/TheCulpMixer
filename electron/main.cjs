/*
 * The Culp Mixer desktop shell.
 *
 * A thin Electron host around the same static bundle the web build ships.
 * It adds the three things a browser tab cannot: a real application window,
 * a native menu bar driven by The Culp Mixer's own command registry, and native file
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
  scheme: 'The Culp Mixer',
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
  protocol.handle('The Culp Mixer', async (request) => {
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
    title: 'The Culp Mixer',
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
  // Closing with unsaved work asks first.
  //
  // The window used to go the moment the button was pressed, taking whatever
  // was on screen with it. The renderer is the only side that knows whether
  // there is anything to lose, so it is asked — and the close is held until it
  // answers, or until a second of silence, because a renderer that has stopped
  // responding must not be able to make the window unclosable.
  let closeApproved = false;
  mainWindow.on('close', (event) => {
    saveWindowState(mainWindow);
    if (closeApproved || !mainWindow || mainWindow.isDestroyed()) return;
    event.preventDefault();
    let answered = false;
    const proceed = (ok) => {
      if (answered) return;
      answered = true;
      ipcMain.removeListener('kline:close-answer', onAnswer);
      if (!ok) return;
      closeApproved = true;
      mainWindow.close();
    };
    const onAnswer = (_e, ok) => proceed(!!ok);
    ipcMain.once('kline:close-answer', onAnswer);
    mainWindow.webContents.send('kline:confirm-close');
    setTimeout(() => proceed(true), 10000);
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // Anything that is not the app itself belongs in the user's browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL('The Culp Mixer://app/');

  // Smoke-test hook: `KLINE_SMOKE=<png path> electron .` boots the shell, puts
  // it through a short piece of real work, saves a screenshot and exits — so
  // CI can prove the packaged app on each platform *works*, not merely that it
  // opened a window. A build that renders a grey box and then throws on the
  // first modelling operation used to pass this.
  //
  // KILN_SMOKE is the pre-rename name, still honoured so an older workflow or
  // a script someone has locally keeps working.
  const smokeTarget = process.env.KLINE_SMOKE || process.env.KILN_SMOKE;
  if (smokeTarget) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        let checks = { ok: false, error: 'the page never reported back' };
        try {
          checks = await mainWindow.webContents.executeJavaScript(SMOKE_SCRIPT, true);
        } catch (err) {
          checks = { ok: false, error: String(err && err.message ? err.message : err) };
        }
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(smokeTarget, image.toPNG());
        const menu = Menu.getApplicationMenu();
        console.log(JSON.stringify({
          menus: menu ? menu.items.map((i) => i.label) : [],
          title: mainWindow.getTitle(),
          checks,
        }));
        // A non-zero exit is what makes this a test rather than a screenshot.
        app.exit(checks.ok ? 0 : 1);
      }, 2500);
    });
  }

  return mainWindow;
}

/**
 * What the packaged application is asked to prove it can do.
 *
 * Deliberately a spread rather than one feature: geometry, the modifier stack,
 * rigging with a constraint solve, animation, the undo history and the
 * document format. Each is a subsystem that has, at some point, worked in the
 * browser build and not in the packaged one — a missing asset, a worker that
 * will not start, a path that resolves differently under a custom protocol.
 *
 * Returned rather than thrown so the failure arrives as a readable line in the
 * build log instead of an Electron stack trace.
 */
const SMOKE_SCRIPT = `(() => {
  try {
    const k = window.kline;
    if (!k) return { ok: false, error: 'The Culp Mixer did not start: window.kline is missing' };
    const ed = k.editor;
    const notes = {};

    // Geometry and the operators.
    k.run('add.uvsphere');
    const id = ed.scene.active;
    const before = ed.scene.get(id).mesh.faces.length;
    k.run('edit.toggleMode');
    k.run('select.all');
    k.run('mesh.subdivide');
    notes.subdivided = ed.scene.get(id).mesh.faces.length > before;
    k.run('uv.smart');
    notes.unwrapped = (ed.scene.get(id).mesh.faceUV || []).filter(Boolean).length > 0;
    k.run('edit.toggleMode');

    // Undo has to put it back.
    k.run('edit.undo');
    k.run('edit.undo');
    notes.undone = ed.scene.get(id).mesh.faces.length === before;

    // Undo restores the mode it was recorded in, so this lands back in Edit
    // Mode — where the commands below are refused, correctly and silently
    // enough that the first version of this script blamed the rig.
    if (ed.mode !== 'object') k.run('edit.toggleMode');
    notes.backInObjectMode = ed.mode === 'object';

    // A rig with a constraint, which is the newest evaluation path.
    k.run('add.armature');
    const rigId = ed.scene.active;
    k.run('rig.extrudeBone');
    k.run('rig.addControlBone');
    const rig = ed.scene.get(rigId);
    const control = rig.armature.bones[rig.armature.bones.length - 1];
    control.head = [1, 0.6, 0];
    control.tail = [1, 0.8, 0];
    const tip = rig.armature.bones[1];
    tip.constraints = [{ type: 'ik', target: control.name, chain: 2, iterations: 24 }];
    const posed = ed.scene.get(rigId).armature.bones.length;
    notes.rigged = posed >= 3;

    // Animation through the one evaluation path. Keying works on what is
    // selected, and what is selected right now is the armature.
    ed.selectObject(id);
    ed.scene.timeline.start = 1;
    ed.scene.timeline.end = 10;
    ed.setFrame(1);
    ed.scene.get(id).position.x = 0;
    k.run('anim.insertKey');
    ed.setFrame(10);
    ed.scene.get(id).position.x = 5;
    k.run('anim.insertKey');
    ed.setFrame(5);
    const mid = ed.scene.get(id).position.x;
    notes.animated = mid > 0.5 && mid < 4.5;

    // The document format, out and back.
    const json = JSON.stringify(ed.scene.toJSON());
    ed.newScene();
    ed.loadSceneJSON(JSON.parse(json));
    notes.reopened = ed.scene.objects.size >= 2;

    const failed = Object.keys(notes).filter((key) => !notes[key]);
    return failed.length
      ? { ok: false, error: 'these did not work in the packaged app: ' + failed.join(', '), notes }
      : { ok: true, notes };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
})()`;

/** Turn The Culp Mixer's own shortcut strings into Electron accelerators. */
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
      label: 'The Culp Mixer',
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
        label: 'The Culp Mixer on GitHub',
        click: () => shell.openExternal('https://github.com/22500107Zc/Kline'),
      },
    ],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function queueOpen(filePath) {
  if (!filePath || !/\.(The Culp Mixer|kiln)$/.test(filePath)) return;
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
    queueOpen(argv.find((a) => /\.(The Culp Mixer|kiln)$/.test(a)));
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    queueOpen(filePath);
  });

  app.whenReady().then(() => {
    serveBundle();
    buildMenu([]);
    createWindow();
    queueOpen(process.argv.find((a) => /\.(The Culp Mixer|kiln)$/.test(a)));

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
  The Culp Mixer: { name: 'The Culp Mixer Scene', extensions: ['The Culp Mixer'] },
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

/**
 * Pick a folder once, for a render that will write hundreds of files.
 *
 * A save dialog per frame is not a workflow; it is a way of making somebody
 * press Enter four hundred times.
 */
ipcMain.handle('kline:choose-folder', async (_event, { title }) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: title || 'Choose a folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths?.length) return { status: 'cancelled' };
  return { status: 'saved', path: filePaths[0] };
});

ipcMain.handle('kline:write-in-folder', async (_event, { folder, name, data }) => {
  // The name is built by the application, never typed, but it still gets
  // flattened: a path separator arriving here would write outside the folder
  // the person chose.
  const safe = String(name ?? '').replace(/[\\/]/g, '_').replace(/^\.+/, '');
  if (!safe) return { status: 'failed', reason: 'empty filename' };
  try {
    writeAtomic(path.join(folder, safe), data, true);
    return { status: 'saved', path: path.join(folder, safe) };
  } catch (err) {
    return { status: 'failed', reason: err.message };
  }
});

ipcMain.handle('kline:open-scene', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Scene',
    properties: ['openFile'],
    filters: [{ name: 'The Culp Mixer Scene', extensions: ['The Culp Mixer', 'kiln'] }],
  });
  if (canceled || filePaths.length === 0) return null;
  return readScene(filePaths[0]);
});
