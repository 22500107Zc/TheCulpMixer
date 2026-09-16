const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between The Culp Mixer and the desktop shell. Everything is a named
 * channel — the renderer never sees ipcRenderer or Node.
 */
contextBridge.exposeInMainWorld('culpMixerDesktop', {
  platform: process.platform,
  /** Hand the shell the command registry so it can build the native menu. */
  registerCommands: (commands) => ipcRenderer.send('culpmixer:register-commands', commands),
  onCommand: (fn) => ipcRenderer.on('culpmixer:command', (_e, id) => fn(id)),
  onShowShortcuts: (fn) => ipcRenderer.on('culpmixer:shortcuts', () => fn()),
  onOpenFile: (fn) => ipcRenderer.on('culpmixer:open-file', (_e, file) => fn(file)),
  // The shell asks before closing; the answer comes back the other way.
  onConfirmClose: (fn) => ipcRenderer.on('culpmixer:confirm-close', () => fn()),
  answerClose: (ok) => ipcRenderer.send('culpmixer:close-answer', !!ok),
  saveFile: (defaultName, data, binary) =>
    ipcRenderer.invoke('culpmixer:save-file', { defaultName, data, binary: !!binary }),
  // A sequence is asked for a folder once rather than a dialog per frame.
  chooseFolder: (title) => ipcRenderer.invoke('culpmixer:choose-folder', { title }),
  writeInFolder: (folder, name, data) =>
    ipcRenderer.invoke('culpmixer:write-in-folder', { folder, name, data }),
  openScene: () => ipcRenderer.invoke('culpmixer:open-scene'),
});
