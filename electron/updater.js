const { app, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');

/** @type {import('electron').BrowserWindow | null} */
let mainWindowRef = null;

/** @type {{ state: string, version: string | null, progress: number | null, error: string | null, releaseNotes: string | null }} */
let updateStatus = {
  state: 'idle',
  version: null,
  progress: null,
  error: null,
  releaseNotes: null,
};

function sendUpdateEvent(payload = {}) {
  updateStatus = { ...updateStatus, ...payload };
  const win = mainWindowRef;
  if (win && !win.isDestroyed()) {
    win.webContents.send('relay:update-status', { ...updateStatus });
  }
}

function attachAutoUpdaterEvents() {
  autoUpdater.on('checking-for-update', () => {
    sendUpdateEvent({ state: 'checking', error: null, progress: null });
  });

  autoUpdater.on('update-available', (info) => {
    sendUpdateEvent({
      state: 'available',
      version: info?.version || null,
      releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : null,
      error: null,
      progress: null,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    sendUpdateEvent({
      state: 'idle',
      version: info?.version || app.getVersion(),
      error: null,
      progress: null,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateEvent({
      state: 'downloading',
      progress: Math.round(Number(progress?.percent) || 0),
      error: null,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateEvent({
      state: 'ready',
      version: info?.version || null,
      progress: 100,
      error: null,
    });
  });

  autoUpdater.on('error', (error) => {
    sendUpdateEvent({
      state: 'error',
      error: error?.message || String(error),
    });
  });
}

function initAutoUpdater(mainWindow) {
  if (!app.isPackaged) return { enabled: false, reason: 'development' };
  mainWindowRef = mainWindow;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  attachAutoUpdaterEvents();

  // Delay first check so login/sync isn't competing with download on startup.
  setTimeout(() => {
    void checkForUpdates().catch(() => {});
  }, 12_000);

  return { enabled: true };
}

async function checkForUpdates() {
  if (!app.isPackaged) {
    return { ...updateStatus, state: 'dev', error: null };
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    sendUpdateEvent({ state: 'error', error: error?.message || String(error) });
  }
  return { ...updateStatus };
}

function installUpdate() {
  if (!app.isPackaged) return { ok: false, reason: 'development' };
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
}

function getUpdateStatus() {
  return { ...updateStatus, currentVersion: app.getVersion() };
}

module.exports = {
  initAutoUpdater,
  checkForUpdates,
  installUpdate,
  getUpdateStatus,
};
