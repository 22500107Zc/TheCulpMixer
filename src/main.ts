import { App } from './ui/App';
import { COMMANDS, runCommand } from './editor/commands';
import { buildPrimitive } from './mesh/primitives';
import { Mesh } from './mesh/Mesh';
import './style.css';
import * as licence from './licence/licence';

// Registering the worker is what lets browsers install Kline as a desktop app,
// and what makes it start without a network connection afterwards.
if ('serviceWorker' in navigator && import.meta.env.PROD && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    // Resolve against the page, not this module: the bundle lives in assets/.
    const url = `${import.meta.env.BASE_URL}sw.js`;
    navigator.serviceWorker.register(url, { scope: import.meta.env.BASE_URL }).catch(() => {
      /* Installing offline support is a bonus; never block startup on it. */
    });
  });
}

const mount = document.getElementById('app');
if (!mount) throw new Error('Kline could not find its mount point (#app).');

try {
  const app = new App(mount);
  // Scripting handle: `kline.editor` in the browser console reaches the live
  // scene, and `kline.run('mesh.bevel')` fires any command in the registry.
  // The same handle is what the end-to-end tests drive the app through.
  const handle = {
    app,
    editor: app.editor,
    commands: COMMANDS,
    run: (id: string) => runCommand(app.editor, id),
    buildPrimitive,
    meshFromJSON: (data: Parameters<typeof Mesh.fromJSON>[0]) => Mesh.fromJSON(data),
  };
  // The licence module, so the end-to-end suite can mint a key with a throwaway
  // pair and drive the real verification rather than a copy of it.
  (window as unknown as { __klineLicence: unknown }).__klineLicence = licence;
  const global = window as unknown as { kline: unknown; kiln: unknown };
  global.kline = handle;
  // The handle was called `kiln` before the application was renamed, and it is
  // documented, scriptable and probably sitting in somebody's saved snippets.
  // Keeping the old name pointing at the same object costs one line.
  global.kiln = handle;
} catch (err) {
  mount.innerHTML = '';
  const message = err instanceof Error ? err.message : String(err);
  const panel = document.createElement('div');
  panel.className = 'fatal';
  panel.innerHTML = `
    <h1>Kline could not start</h1>
    <p>${message}</p>
    <p class="dim">Kline needs WebGL2. Try a recent Chrome, Firefox, Edge or Safari, and make
    sure hardware acceleration is enabled.</p>`;
  mount.appendChild(panel);
  throw err;
}
