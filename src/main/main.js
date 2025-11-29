const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const Store = require('electron-store');
const semver = require('semver');
require('dotenv').config();

const { resolveUpdateSource, downloadAndExtractUpdate, fetchFeedManifest, freshReinstall } = require('./update');
const { requestDeviceCode, pollDeviceCode, loginWithRefreshToken } = require('./auth');
const { launchModpack, cancelLaunch, isLaunching, checkLaunchRequirements } = require('./launcher');

const isDevelopment = process.env.NODE_ENV === 'development';
let mainWindow;
let store;
let sessionAccount = { username: '', accessToken: '', refreshToken: '', uuid: '' };
let updateAbortController = null;
let updateInProgress = false;
let launchInProgress = false;

function setUpdateInProgress(value) {
  updateInProgress = value;
}

function createStore() {
  const defaults = {
    termsAccepted: false,
    animationEnabled: process.env.AETHERVEIL_ANIM_ENABLED !== 'false',
    installDir: path.join(app.getPath('appData'), 'Hellas'),
    installedVersion: '',
    lastKnownVersion: '',
    account: {
      username: '',
      refreshToken: ''
    }
  };

  store = new Store({ defaults });

  const storedAccount = store.get('account');
  if (storedAccount && storedAccount.accessToken) {
    store.set('account', { username: storedAccount.username || '', refreshToken: '' });
  }
}

function getInstallDir() {
  return store.get('installDir');
}

function getAccount() {
  const storedAccount = store.get('account') || { username: '' };
  const resolved = {
    username: sessionAccount.username || storedAccount.username || '',
    loggedIn: Boolean(sessionAccount.username && sessionAccount.accessToken)
  };

  return resolved;
}

function getSessionAccount() {
  return { ...sessionAccount };
}

function broadcastAccount() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hellas:account-updated', getAccount());
  }
}

function clearSessionAccount() {
  sessionAccount = { username: '', accessToken: '', refreshToken: '', uuid: '' };
}

async function setSession(session) {
  if (!session || !session.username || !session.accessToken) {
    clearSessionAccount();
    store.set('account', { username: '', refreshToken: '' });
    broadcastAccount();
    return;
  }

  sessionAccount = {
    username: session.username,
    uuid: session.uuid || '',
    accessToken: session.accessToken,
    refreshToken: session.refreshToken || ''
  };
  store.set('account', {
    username: session.username,
    refreshToken: session.refreshToken || ''
  });
  broadcastAccount();
}

async function attemptRestoreAccount() {
  const storedAccount = store.get('account');
  if (!storedAccount || !storedAccount.refreshToken) {
    clearSessionAccount();
    return;
  }

  try {
    const session = await loginWithRefreshToken(storedAccount.refreshToken);
    await setSession(session);
  } catch (error) {
    console.warn('Stored login could not be refreshed', error);
    clearSessionAccount();
    store.set('account', { username: '', refreshToken: '' });
  }
}

async function getInstallationState() {
  const dir = getInstallDir();
  const installDirExists = fs.existsSync(dir);
  let requirements = { minecraft: false, forge: false, modpack: false };
  let forgeVersion = null;
  let minecraftVersion = null;

  try {
    const check = await checkLaunchRequirements(dir);
    requirements = check.requirements;
    forgeVersion = check.forgeVersion;
    minecraftVersion = check.minecraftVersion;
  } catch (error) {
    console.warn('Unable to verify installation readiness', error);
  }

  const installedVersion = store.get('installedVersion') || '';
  const lastKnownVersion = store.get('lastKnownVersion') || '';
  // Consider the installation launch-ready once the modpack content is present; the
  // launcher can download missing Minecraft/Forge files on demand during launch.
  const readyToLaunch = installDirExists && Boolean(installedVersion) && Boolean(requirements.modpack);

  return {
    installDir: dir,
    installDirExists,
    isInstalled: readyToLaunch,
    installedVersion,
    lastKnownVersion,
    requirements,
    forgeVersion,
    minecraftVersion
  };
}

function sendUpdateProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hellas:update-progress', payload);
  }
}

function sendLaunchStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hellas:launch-status', payload);
  }
}

  function sendInstallStatus(payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hellas:install-status', payload);
    }
  }

  function cancelActiveUpdate() {
  if (updateAbortController) {
    updateAbortController.abort();
    return true;
  }

  return false;
}

async function runUpdateTask(task) {
  if (updateInProgress) {
    throw new Error('Another download is already in progress.');
  }

  updateAbortController = new AbortController();
  setUpdateInProgress(true);

  try {
    const result = await task(updateAbortController.signal);
    return result;
  } catch (error) {
    if (error.cancelled || error.name === 'AbortError') {
      return { cancelled: true };
    }
    throw error;
  } finally {
    if (updateAbortController) {
      updateAbortController = null;
    }
    setUpdateInProgress(false);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 1100,
    minHeight: 650,
    frame: false,
    resizable: false,
    maximizable: true,
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

  mainWindow.on('close', (event) => {
    if (updateInProgress) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'question',
        buttons: ['Yes', 'No'],
        defaultId: 1,
        cancelId: 1,
        title: 'Download in progress',
        message: 'A download is currently in progress. Closing will cancel it. Are you sure you want to exit?'
      });

      if (choice === 1) {
        event.preventDefault();
        return;
      }

      cancelActiveUpdate();
    }
  });

  if (isDevelopment) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(async () => {
  createStore();
  await attemptRestoreAccount();
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
  const installation = await getInstallationState();
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
    dynmapUrl: process.env.DYNMAP_URL || 'https://map.pixelmon-server.com',
    installation,
    account: getAccount(),
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

ipcMain.handle('hellas:start-device-login', async () => requestDeviceCode());

ipcMain.handle('hellas:poll-device-login', async (_event, payload) => {
  const deviceCode = payload?.deviceCode;
  if (!deviceCode) {
    throw new Error('Device code missing.');
  }

  const result = await pollDeviceCode(deviceCode);
  if (result.status === 'success') {
    await setSession(result.session);
    return { status: 'success', account: getAccount() };
  }

  return result;
});

  ipcMain.handle('hellas:perform-install', async () => {
    const dir = getInstallDir();
    const updateSource = resolveUpdateSource();
    if (!updateSource || !updateSource.url) {
      sendInstallStatus({ message: 'Update source is not configured.', level: 'error' });
      throw new Error('Update source is not configured.');
    }

    await fs.promises.mkdir(dir, { recursive: true });

    sendInstallStatus({ message: `Preparing installation into ${dir}` });
    sendUpdateProgress({ state: 'downloading', progress: 0 });
    try {
      const result = await runUpdateTask((signal) =>
        downloadAndExtractUpdate(updateSource, dir, sendUpdateProgress, signal)
      );

      if (result.cancelled) {
        sendUpdateProgress({ state: 'cancelled', message: 'Installation cancelled.' });
        return { cancelled: true };
      }

      if (result.version) {
        store.set('installedVersion', result.version);
        store.set('lastKnownVersion', result.version);
      }

      sendUpdateProgress({ state: 'complete', progress: 100, version: result.version || null });
      sendInstallStatus({ message: 'Installation completed successfully.', level: 'success' });
      return { installation: await getInstallationState(), version: result.version || null };
    } catch (error) {
      sendInstallStatus({ message: error.message || 'Installation failed.', level: 'error' });
      sendUpdateProgress({ state: 'error', message: error.message || 'Installation failed.' });
      throw error;
    }
  });

ipcMain.handle('hellas:open-external', async (_event, targetUrl) => {
  if (targetUrl) {
    await shell.openExternal(targetUrl);
  }
});

ipcMain.handle('hellas:toggle-maximize', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return false;
  }

  mainWindow.maximize();
  return true;
});

ipcMain.handle('hellas:close', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  } else {
    app.quit();
  }
});

ipcMain.handle('hellas:cancel-update', async () => cancelActiveUpdate());

ipcMain.handle('hellas:logout', async () => {
  clearSessionAccount();
  store.set('account', { username: '', refreshToken: '' });
  broadcastAccount();
  return true;
});

  ipcMain.handle('hellas:launch-game', async () => {
    const account = getSessionAccount();
    if (!account.username || !account.accessToken) {
      throw new Error('Please log in with your Minecraft account before launching.');
    }

  const installDir = getInstallDir();
  const installation = await getInstallationState();

  if (!installation.isInstalled) {
    sendLaunchStatus({
      message: 'Launch blocked: install the modpack before starting.',
      level: 'error'
    });
    throw new Error('Cannot launch until the modpack and dependencies are installed.');
  }

    if (launchInProgress || isLaunching()) {
      throw new Error('A launch is already running.');
    }

    launchInProgress = true;
    try {
      sendLaunchStatus({ message: 'Starting Minecraft launch…' });
      const { launchedWith } = await launchModpack({
        installDir,
        account,
        onStatus: sendLaunchStatus
      });
      sendLaunchStatus({ message: `Launch completed with Forge ${launchedWith}`, level: 'success' });
      return { account: { username: account.username }, installDir, launchedWith };
    } catch (error) {
      sendLaunchStatus({ message: error.message || 'Failed to launch.', level: 'error' });
      throw error;
    } finally {
      launchInProgress = false;
    }
  });

ipcMain.handle('hellas:cancel-launch', async () => {
  launchInProgress = false;
  return cancelLaunch();
});

  ipcMain.handle('hellas:trigger-update', async () => {
    const updateSource = resolveUpdateSource();
    if (!updateSource || !updateSource.url) {
      sendInstallStatus({ message: 'Update source is not configured.', level: 'error' });
      throw new Error('Update source is not configured.');
    }

    sendInstallStatus({ message: 'Starting update…' });
    sendUpdateProgress({ state: 'downloading', progress: 0 });
    const installDir = getInstallDir();
    try {
      const result = await runUpdateTask((signal) =>
        downloadAndExtractUpdate(updateSource, installDir, sendUpdateProgress, signal)
      );

      if (result.cancelled) {
        sendUpdateProgress({ state: 'cancelled', message: 'Update cancelled.' });
        return { cancelled: true };
      }

      if (result.version) {
        store.set('installedVersion', result.version);
        store.set('lastKnownVersion', result.version);
      }

      sendUpdateProgress({ state: 'complete', progress: 100, version: result.version || null });
      sendInstallStatus({ message: 'Update completed.', level: 'success' });
      return { installation: await getInstallationState(), version: result.version || null };
    } catch (error) {
      sendInstallStatus({ message: error.message || 'Update failed.', level: 'error' });
      sendUpdateProgress({ state: 'error', message: error.message || 'Update failed.' });
      throw error;
    }
  });

  ipcMain.handle('hellas:fresh-reinstall', async () => {
    const updateSource = resolveUpdateSource();
    if (!updateSource || !updateSource.url) {
      sendInstallStatus({ message: 'Update source is not configured.', level: 'error' });
      throw new Error('Update source is not configured.');
  }

    sendInstallStatus({ message: 'Starting fresh reinstall…' });
    sendUpdateProgress({ state: 'downloading', progress: 0 });
    const installDir = getInstallDir();
    try {
      const result = await runUpdateTask((signal) => freshReinstall(installDir, sendUpdateProgress, signal));

      if (result.cancelled) {
        sendUpdateProgress({ state: 'cancelled', message: 'Reinstall cancelled.' });
        return { cancelled: true };
      }

      if (result.version) {
        store.set('installedVersion', result.version);
        store.set('lastKnownVersion', result.version);
      }

      sendUpdateProgress({ state: 'complete', progress: 100, version: result.version || null });
      sendInstallStatus({ message: 'Reinstall finished.', level: 'success' });
      return { installation: await getInstallationState(), version: result.version || null };
    } catch (error) {
      sendInstallStatus({ message: error.message || 'Reinstall failed.', level: 'error' });
      sendUpdateProgress({ state: 'error', message: error.message || 'Reinstall failed.' });
      throw error;
    }
  });

ipcMain.handle('hellas:get-installation', async () => getInstallationState());

ipcMain.handle('hellas:update-known-version', async (_event, version) => {
  if (version) {
    store.set('lastKnownVersion', version);
  }
  return store.get('lastKnownVersion');
});
