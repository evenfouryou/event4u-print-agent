const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printAgent', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getAvailableServers: () => ipcRenderer.invoke('get-available-servers'),
  switchServer: (serverType) => ipcRenderer.invoke('switch-server', serverType),
  getStatus: () => ipcRenderer.invoke('get-status'),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  connect: () => ipcRenderer.invoke('connect'),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  testPrint: () => ipcRenderer.invoke('test-print'),
  
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status:update', (event, status) => callback(status));
  },
  onLogEntry: (callback) => {
    ipcRenderer.on('log:entry', (event, entry) => callback(entry));
  }
});
