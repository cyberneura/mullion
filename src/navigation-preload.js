'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The navigation bar renderer is sandboxed, so this is the whole surface it can
// reach. Every entry is a named command -- nothing here forwards arbitrary
// channel names, which would let a compromised renderer talk to any handler.
contextBridge.exposeInMainWorld('ostinato', {
  getState: () => ipcRenderer.invoke('get-state'),
  navigate: (url) => ipcRenderer.invoke('navigate', url),
  go: (action) => ipcRenderer.invoke('go', action),
  newTab: () => ipcRenderer.invoke('new-tab'),
  selectTab: (tabId) => ipcRenderer.invoke('select-tab', tabId),
  closeTab: (tabId) => ipcRenderer.invoke('close-tab', tabId),
  openExternal: () => ipcRenderer.invoke('open-external'),
  hideNavigation: () => ipcRenderer.invoke('hide-navigation'),
  showNavigation: () => ipcRenderer.invoke('show-navigation'),
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  onFocusUrl: (callback) => ipcRenderer.on('focus-url', () => callback())
});
