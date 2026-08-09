'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The QR window renderer is sandboxed and only ever reads one payload: the
// matrix the main process already computed, plus the URL it stands for.
contextBridge.exposeInMainWorld('mullionQr', {
  get: () => ipcRenderer.invoke('get-qr')
});
