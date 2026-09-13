const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between Kline and the desktop shell. Everything is a named
 * channel — the renderer never sees ipcRenderer or Node.
 */
contextBridge.exposeInMainWorld('klineDesktop', {
  platform: process.platform,
  /** Hand the shell the command registry so it can build the native menu. */
  registerCommands: (commands) => ipcRenderer.send('kline:register-commands', commands),
  onCommand: (fn) => ipcRenderer.on('kline:command', (_e, id) => fn(id)),
  onShowShortcuts: (fn) => ipcRenderer.on('kline:shortcuts', () => fn()),
  onOpenFile: (fn) => ipcRenderer.on('kline:open-file', (_e, file) => fn(file)),
  saveFile: (defaultName, data, binary) =>
    ipcRenderer.invoke('kline:save-file', { defaultName, data, binary: !!binary }),
  // A sequence is asked for a folder once rather than a dialog per frame.
  chooseFolder: (title) => ipcRenderer.invoke('kline:choose-folder', { title }),
  writeInFolder: (folder, name, data) =>
    ipcRenderer.invoke('kline:write-in-folder', { folder, name, data }),
  openScene: () => ipcRenderer.invoke('kline:open-scene'),
});
