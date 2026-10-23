/**
 * VibeNotes for Windows — preload bridge.
 * Exposes a minimal, safe API to the renderer via contextBridge.
 */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('notch', {
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setTriggerMode: (mode) => ipcRenderer.send('settings:set-trigger-mode', mode),
  setKeepAwake: (v) => ipcRenderer.send('settings:set-keepawake', v),
  setScreenAlwaysOn: (v) => ipcRenderer.send('settings:set-screen-always-on', v),
  setAutoCollapse: (v) => ipcRenderer.send('settings:set-auto-collapse', v),
  setPinned: (v) => ipcRenderer.send('settings:set-pinned', v),
  setLaunchAtLogin: (v) => ipcRenderer.send('settings:set-launch-at-login', v),
  onSettingsUpdated: (cb) => ipcRenderer.on('settings-updated', (_e, s) => cb(s)),

  // shell
  openDataDir: () => ipcRenderer.send('app:open-data-dir'),
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),

  // panel control from tray
  onExpandRequested: (cb) => ipcRenderer.on('expand-requested', (_e, src) => cb(src)),
  onCollapseRequested: (cb) => ipcRenderer.on('collapse-requested', (_e, src) => cb(src)),

  // click-through
  setClickThrough: (ignore) => ipcRenderer.send('clickthrough:set', ignore),
  setPanelExpanded: (v) => ipcRenderer.send('panel:expanded', v),
  focusWindow: () => ipcRenderer.send('window:focus'),
  dragStart: (mode) => ipcRenderer.send('window:drag-start', mode),
  dragEnd: (mode) => ipcRenderer.send('window:drag-end', mode),

  // persistence
  loadData: (fileName, fallback) => ipcRenderer.invoke('data:load', fileName, fallback),
  saveData: (fileName, value) => ipcRenderer.invoke('data:save', fileName, value),

  // files
  fileExists: (p) => ipcRenderer.invoke('file:exists', p),
  revealFile: (p) => ipcRenderer.invoke('file:reveal', p),
  openFile: (p) => ipcRenderer.invoke('file:open', p),
  fileSize: (p) => ipcRenderer.invoke('file:stat-size', p),
  pathForFile: (fileObj) => {
    try { return webUtils.getPathForFile(fileObj); } catch { return null; }
  },

  // images
  saveImage: (dataUrl) => ipcRenderer.invoke('image:save', dataUrl),
  readImage: (relPath) => ipcRenderer.invoke('image:read', relPath),

  // drag out
  dragOutFile: (p) => ipcRenderer.send('shelf:drag-start', p),
});
