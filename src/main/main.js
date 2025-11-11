const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const Store = require('electron-store');
const semver = require('semver');
require('dotenv').config();

const { resolveUpdateSource, downloadAndExtractUpdate, fetchFeedManifest } = require('./update');
const { logout } = require('./auth');

const isDevelopment = process.env.NODE_ENV === 'development';
let mainWindow;
let store;

function createStore() {
  const defaults = {
    termsAccepted: false,
    animationEnabled: process.env.AETHERVEIL_ANIM_ENABLED !== 'false',
    installDir: path.join(app.getPath('appData'), 'Hellas'),
    installedVersion: '',
    lastKnownVersion: ''
  };

  store = new Store({ defaults });
}

function getInstallDir() {
  return store.get('installDir');
}

function getInstallationState() {
  const dir = getInstallDir();
  const exists = fs.existsSync(dir);
  return {
    installDir: dir,
    isInstalled: exists,
    installedVersion: store.get('installedVersion') || '',
    lastKnownVersion: store.get('lastKnownVersion') || ''
  };
}

function sendUpdateProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hellas:update-progress', payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 1100,
    minHeight: 650,
    frame: false,
    backgroundColor: '#00000000',
    transparent: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (isDevelopment) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(() => {
  createStore();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('hellas:get-state', async () => {
  const installation = getInstallationState();
  const updateSource = resolveUpdateSource();
  let preferredVersion = installation.lastKnownVersion;

  if (updateSource) {
    if (updateSource.type === 'feed') {
      try {
        const manifest = await fetchFeedManifest(updateSource.feedUrl);
        if (manifest.version) {
          preferredVersion = manifest.version;
          store.set('lastKnownVersion', manifest.version);
        }
      } catch (error) {
        console.warn('Failed to fetch update feed', error);
      }
    } else if (updateSource.version) {
      preferredVersion = updateSource.version;
      store.set('lastKnownVersion', updateSource.version);
    }
  }

  const installedVersion = installation.installedVersion;
  let updateAvailable = false;
  if (preferredVersion) {
    if (installedVersion) {
      if (semver.valid(preferredVersion) && semver.valid(installedVersion)) {
        updateAvailable = semver.gt(preferredVersion, installedVersion);
      } else {
        updateAvailable = preferredVersion !== installedVersion;
      }
    } else {
      updateAvailable = true;
    }
  }

  return {
    websiteUrl: process.env.WEBSITE_URL || 'https://hellasregion.com',
    dynmapUrl: process.env.DYNMAP_URL || 'https://map.hellasregion.com',
    installation,
    termsAccepted: store.get('termsAccepted'),
    animationEnabled: store.get('animationEnabled'),
    update: {
      hasUpdateSource: Boolean(updateSource),
      preferredVersion,
      available: updateAvailable
    }
  };
});

ipcMain.handle('hellas:set-terms', async (_event, value) => {
  store.set('termsAccepted', Boolean(value));
  return store.get('termsAccepted');
});

ipcMain.handle('hellas:set-animation', async (_event, value) => {
  store.set('animationEnabled', Boolean(value));
  return store.get('animationEnabled');
});

ipcMain.handle('hellas:perform-install', async () => {
  const dir = getInstallDir();
  await fs.promises.mkdir(dir, { recursive: true });
  store.set('installedVersion', store.get('lastKnownVersion'));
  const installation = getInstallationState();
  return installation;
});

ipcMain.handle('hellas:open-external', async (_event, targetUrl) => {
  if (targetUrl) {
    await shell.openExternal(targetUrl);
  }
});

ipcMain.handle('hellas:logout', async () => {
  await logout();
  return true;
});

ipcMain.handle('hellas:trigger-update', async () => {
  const updateSource = resolveUpdateSource();
  if (!updateSource || !updateSource.url) {
    throw new Error('Update source is not configured.');
  }

  sendUpdateProgress({ state: 'downloading', progress: 0 });
  const installDir = getInstallDir();
  const result = await downloadAndExtractUpdate(updateSource, installDir, sendUpdateProgress);
  if (result.version) {
    store.set('installedVersion', result.version);
    store.set('lastKnownVersion', result.version);
  }
  sendUpdateProgress({ state: 'complete', progress: 100, version: result.version || null });
  return { installation: getInstallationState(), version: result.version || null };
});

ipcMain.handle('hellas:get-installation', async () => getInstallationState());

ipcMain.handle('hellas:update-known-version', async (_event, version) => {
  if (version) {
    store.set('lastKnownVersion', version);
  }
  return store.get('lastKnownVersion');
});
