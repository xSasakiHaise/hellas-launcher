const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hellas', {
  getState: () => ipcRenderer.invoke('hellas:get-state'),
  setTermsAccepted: (value) => ipcRenderer.invoke('hellas:set-terms', value),
  setAnimationEnabled: (value) => ipcRenderer.invoke('hellas:set-animation', value),
  beginDeviceLogin: () => ipcRenderer.invoke('hellas:start-device-login'),
  pollDeviceLogin: (payload) => ipcRenderer.invoke('hellas:poll-device-login', payload),
  performInstall: () => ipcRenderer.invoke('hellas:perform-install'),
  openExternal: (url) => ipcRenderer.invoke('hellas:open-external', url),
  logout: () => ipcRenderer.invoke('hellas:logout'),
  close: () => ipcRenderer.invoke('hellas:close'),
  triggerUpdate: () => ipcRenderer.invoke('hellas:trigger-update'),
  cancelUpdate: () => ipcRenderer.invoke('hellas:cancel-update'),
  freshReinstall: () => ipcRenderer.invoke('hellas:fresh-reinstall'),
  getInstallation: () => ipcRenderer.invoke('hellas:get-installation'),
  launchGame: () => ipcRenderer.invoke('hellas:launch-game'),
  cancelLaunch: () => ipcRenderer.invoke('hellas:cancel-launch'),
  updateKnownVersion: (version) => ipcRenderer.invoke('hellas:update-known-version', version),
  toggleMaximize: () => ipcRenderer.invoke('hellas:toggle-maximize'),
  onUpdateProgress: (callback) => {
    const channel = 'hellas:update-progress';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, (_event, payload) => {
      callback(payload);
    });
  },
  onAccountUpdated: (callback) => {
    const channel = 'hellas:account-updated';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, (_event, payload) => {
      callback(payload);
    });
  },
  onLaunchStatus: (callback) => {
    const channel = 'hellas:launch-status';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, (_event, payload) => {
      callback(payload);
    });
  },
  onInstallStatus: (callback) => {
    const channel = 'hellas:install-status';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, (_event, payload) => {
      callback(payload);
    });
  }
});
