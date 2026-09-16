import { carryStoredDataAcrossTheRename } from './storage-rename';
import { App } from './ui/App';
import { COMMANDS, runCommand } from './editor/commands';
import { buildPrimitive } from './mesh/primitives';
import { Mesh } from './mesh/Mesh';
import './style.css';
import * as licence from './licence/licence';
import * as deliver from './render/pathtrace/deliver';

// Before anything reads storage: move what the previous name wrote.
//
// Renaming the keys without moving what is under them would throw away, on
// the next visit, the autosaved scene somebody was working on, their account,
// how far through the trial they are, their preferences and the payment link.
// It is all still in the browser — just filed under a name nothing looks for.
carryStoredDataAcrossTheRename();

// Registering the worker is what lets browsers install The Culp Mixer as a desktop app,
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
if (!mount) throw new Error('The Culp Mixer could not find its mount point (#app).');

try {
  const app = new App(mount);
  // Scripting handle: `culpmixer.editor` in the browser console reaches the live
  // scene, and `culpmixer.run('mesh.bevel')` fires any command in the registry.
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
  (window as unknown as { __culpmixerLicence: unknown }).__culpmixerLicence = licence;
  // The delivery layer, so the end-to-end suite can drive the real video
  // recorder rather than a stand-in for it.
  (window as unknown as { __culpmixerDeliver: unknown }).__culpmixerDeliver = deliver;
  const global = window as unknown as { culpmixer: unknown; kiln: unknown };
  global.culpmixer = handle;
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
    <h1>The Culp Mixer could not start</h1>
    <p>${message}</p>
    <p class="dim">The Culp Mixer needs WebGL2. Try a recent Chrome, Firefox, Edge or Safari, and make
    sure hardware acceleration is enabled.</p>`;
  mount.appendChild(panel);
  throw err;
}
