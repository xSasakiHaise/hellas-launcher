const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hellas', {
  getState: () => ipcRenderer.invoke('hellas:get-state'),
  setTermsAccepted: (value) => ipcRenderer.invoke('hellas:set-terms', value),
  setAnimationEnabled: (value) => ipcRenderer.invoke('hellas:set-animation', value),
  performInstall: () => ipcRenderer.invoke('hellas:perform-install'),
  openExternal: (url) => ipcRenderer.invoke('hellas:open-external', url),
  logout: () => ipcRenderer.invoke('hellas:logout'),
  triggerUpdate: () => ipcRenderer.invoke('hellas:trigger-update'),
  getInstallation: () => ipcRenderer.invoke('hellas:get-installation'),
  updateKnownVersion: (version) => ipcRenderer.invoke('hellas:update-known-version', version),
  onUpdateProgress: (callback) => {
    const channel = 'hellas:update-progress';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, (_event, payload) => {
      callback(payload);
    });
  }
});
