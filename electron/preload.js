const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relayDesktop', {
  platform: process.platform,
  isDesktop: true,
  getAppInfo: () => ipcRenderer.invoke('relay:app-info'),
  openSource: () => ipcRenderer.invoke('relay:open-source'),
  getProtocolStatus: () => ipcRenderer.invoke('relay:protocol-status'),
  repairProtocol: () => ipcRenderer.invoke('relay:protocol-repair'),
  focusWindow: () => ipcRenderer.invoke('relay:focus-window'),
  windowAction: (action) => ipcRenderer.invoke('relay:window-action', action),
  isMaximized: () => ipcRenderer.invoke('relay:window-is-maximized'),
  onMaximizedChange: (callback) => {
    const handler = (_event, maximized) => {
      if (typeof callback === 'function') callback(Boolean(maximized));
    };
    ipcRenderer.on('relay:window-maximized', handler);
    return () => ipcRenderer.removeListener('relay:window-maximized', handler);
  },
  isWindowFocused: () => ipcRenderer.invoke('relay:window-focused'),
  setSpellcheck: (enabled) => ipcRenderer.invoke('relay:set-spellcheck', Boolean(enabled)),
  getSpellcheck: () => ipcRenderer.invoke('relay:get-spellcheck'),
  showNotification: (payload) => ipcRenderer.invoke('relay:show-notification', payload),
  clearNotifications: (payload) => ipcRenderer.invoke('relay:clear-notifications', payload || {}),
  onNotificationClick: (callback) => {
    const handler = (_event, data) => {
      if (typeof callback === 'function') callback(data);
    };
    ipcRenderer.on('relay:notification-click', handler);
    return () => ipcRenderer.removeListener('relay:notification-click', handler);
  },
  onProtocolOpen: (callback) => {
    const handler = (_event, data) => {
      if (typeof callback === 'function') callback(data);
    };
    ipcRenderer.on('relay:protocol-open', handler);
    return () => ipcRenderer.removeListener('relay:protocol-open', handler);
  },
  checkForUpdates: () => ipcRenderer.invoke('relay:check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('relay:install-update'),
  getUpdateStatus: () => ipcRenderer.invoke('relay:get-update-status'),
  onUpdateStatus: (callback) => {
    const handler = (_event, data) => {
      if (typeof callback === 'function') callback(data);
    };
    ipcRenderer.on('relay:update-status', handler);
    return () => ipcRenderer.removeListener('relay:update-status', handler);
  },
});
