const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const Store = require('electron-store');
const semver = require('semver');
require('dotenv').config();

const { resolveUpdateSource, downloadAndExtractUpdate, fetchFeedManifest, freshReinstall } = require('./update');
const { requestDeviceCode, pollDeviceCode, loginWithRefreshToken } = require('./auth');
const {
  launchModpack,
  cancelLaunch,
  isLaunching,
  checkLaunchRequirements,
  ensureBaseRuntime,
  buildMemoryPlan
} = require('./launcher');
const { initLogger, logMessage, getLauncherLogPath, readLauncherLog } = require('./logger');

const isDevelopment = process.env.NODE_ENV === 'development';
let mainWindow;
let store;
let sessionAccount = { username: '', accessToken: '', refreshToken: '', uuid: '' };
let updateAbortController = null;
let updateInProgress = false;
let launchInProgress = false;
let logWindow;
const behaviorLog = [];
let behaviorLogWritten = false;

function recordBehavior(event, details = {}) {
  behaviorLog.push({ timestamp: new Date().toISOString(), event, ...details });
  logMessage('info', `behavior:${event}`, details);
}

function getBehaviorLogPath() {
  const executableDir = path.dirname(app.getPath('exe'));
  return path.join(executableDir, 'hellas-behavior.log');
}

function flushBehaviorLog() {
  if (behaviorLogWritten || !behaviorLog.length) {
    return;
  }

  const logPath = getBehaviorLogPath();
  const header = `Hellas Launcher behavior log - ${new Date().toISOString()}`;
  const lines = behaviorLog.map((entry) => {
    const { timestamp, event, ...rest } = entry;
    const data = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    return `[${timestamp}] ${event}${data}`;
  });

  try {
    fs.writeFileSync(logPath, [header, ...lines].join('\n'), 'utf8');
    behaviorLogWritten = true;
  } catch (error) {
    console.warn('Failed to write behavior log', error);
  }
}

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
    memory: { mode: 'auto', minMb: null, maxMb: null },
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

function normalizeMemorySettings(settings = {}) {
  const mode = settings.mode === 'custom' ? 'custom' : 'auto';
  const toNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
  };

  return {
    mode,
    minMb: toNumber(settings.minMb),
    maxMb: toNumber(settings.maxMb)
  };
}

function getMemorySettings() {
  return normalizeMemorySettings(store.get('memory') || {});
}

function setMemorySettings(settings) {
  const normalized = normalizeMemorySettings(settings);
  store.set('memory', normalized);
  return normalized;
}

function getMemoryState() {
  const settings = getMemorySettings();
  const plan = buildMemoryPlan(settings);

  return {
    settings,
    system: {
      totalMb: plan.totalMemoryMb,
      recommendedMb: plan.recommendedMb
    },
    applied: {
      minMb: plan.minMb,
      maxMb: plan.maxMb
    }
  };
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
    logMessage('error', 'Stored login refresh failed', { error: error.message });
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
  let detectedModpackVersion = null;
  let modpackErrors = [];
  let searchedModDirectories = [];
  const expectedModpackVersion = store.get('lastKnownVersion') || store.get('installedVersion') || null;

  try {
    const check = await checkLaunchRequirements(dir, expectedModpackVersion);
    requirements = check.requirements;
    forgeVersion = check.forgeVersion;
    minecraftVersion = check.minecraftVersion;
    detectedModpackVersion = check.modpackVersion || null;
    modpackErrors = check.modpackErrors || [];
    searchedModDirectories = check.searchedModDirectories || [];
  } catch (error) {
    console.warn('Unable to verify installation readiness', error);
    logMessage('error', 'Installation readiness check failed', { error: error.message });
  }

  const installedVersion = store.get('installedVersion') || '';
  const lastKnownVersion = store.get('lastKnownVersion') || '';
  const resolvedInstalledVersion =
    installedVersion ||
    detectedModpackVersion ||
    (requirements.modpack ? expectedModpackVersion : '') ||
    lastKnownVersion ||
    (requirements.modpack ? 'unversioned' : '');

  if (detectedModpackVersion && detectedModpackVersion !== installedVersion) {
    store.set('installedVersion', detectedModpackVersion);
  }
  // Consider the installation launch-ready once the modpack content is present; the
  // launcher can download missing Minecraft/Forge files on demand during launch.
  const readyToLaunch = installDirExists && Boolean(resolvedInstalledVersion) && Boolean(requirements.modpack);

  return {
    installDir: dir,
    installDirExists,
    isInstalled: readyToLaunch,
    installedVersion: resolvedInstalledVersion || installedVersion,
    lastKnownVersion,
    modpackErrors,
    searchedModDirectories,
    requirements,
    forgeVersion,
    minecraftVersion
  };
}

function sendUpdateProgress(payload) {
  recordBehavior('update-progress', { payload });
  logMessage('debug', 'Update progress event', payload);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hellas:update-progress', payload);
  }
}

function sendLaunchStatus(payload) {
  recordBehavior('launch-status', { payload });
  logMessage('debug', 'Launch status event', payload);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hellas:launch-status', payload);
  }
}

  function sendInstallStatus(payload) {
    recordBehavior('install-status', { payload });
    logMessage('debug', 'Install status event', payload);
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
    recordBehavior('window-close-attempt', { updateInProgress });
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

function createLogWindow() {
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.focus();
    return logWindow;
  }

  logWindow = new BrowserWindow({
    width: 900,
    height: 600,
    title: 'Hellas Launcher Logs',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  logWindow.setMenuBarVisibility(false);
  logWindow.on('closed', () => {
    logWindow = null;
  });

  logWindow.loadFile(path.join(__dirname, '../renderer/logs.html'));
  return logWindow;
}

app.whenReady().then(async () => {
  initLogger(app);
  recordBehavior('app-ready', { version: app.getVersion(), platform: process.platform });
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
  flushBehaviorLog();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  recordBehavior('app-before-quit');
  flushBehaviorLog();
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
    memory: getMemoryState(),
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

ipcMain.handle('hellas:get-memory-settings', async () => getMemoryState());

ipcMain.handle('hellas:set-memory-settings', async (_event, settings) => {
  setMemorySettings(settings);
  return getMemoryState();
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

    recordBehavior('install-start', { dir, updateSource: updateSource.url });

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

      sendInstallStatus({ message: 'Verifying Minecraft and Forge files…' });
      await ensureBaseRuntime({ installDir: dir, onStatus: sendInstallStatus });

      sendUpdateProgress({ state: 'complete', progress: 100, version: result.version || null });
      sendInstallStatus({ message: 'Installation completed successfully.', level: 'success' });
      recordBehavior('install-complete', { dir, version: result.version || null });
      return { installation: await getInstallationState(), version: result.version || null };
    } catch (error) {
      sendInstallStatus({ message: error.message || 'Installation failed.', level: 'error' });
      sendUpdateProgress({ state: 'error', message: error.message || 'Installation failed.' });
      recordBehavior('install-error', { message: error.message });
      logMessage('error', 'Installation failed', { message: error.message });
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
  const expectedModpackVersion =
    installation.lastKnownVersion || installation.installedVersion || null;

  recordBehavior('launch-attempt', {
    installDir,
    expectedModpackVersion,
    account: account.username
  });

  if (!installation.isInstalled) {
    const modpackErrorDetails = (installation.modpackErrors || [])
      .map((error) => `${error.path}: ${error.message}${error.code ? ` (${error.code})` : ''}`)
      .join('; ');
    const searchedDirs = installation.searchedModDirectories?.length
      ? ` Searched mod directories: ${installation.searchedModDirectories.join(', ')}`
      : '';
    const details = modpackErrorDetails ? ` Details: ${modpackErrorDetails}.${searchedDirs}` : searchedDirs;
    sendLaunchStatus({
      message: `Launch blocked: install the modpack before starting.${details}`,
      level: 'error'
    });
    throw new Error(`Cannot launch until the modpack and dependencies are installed.${details}`);
  }

  if (launchInProgress || isLaunching()) {
    throw new Error('A launch is already running.');
  }

  launchInProgress = true;
  try {
    const missing = Object.entries(installation.requirements || {})
      .filter(([, present]) => !present)
      .map(([key]) => key.toUpperCase());
    if (missing.length) {
      sendLaunchStatus({ message: `Resolving missing components: ${missing.join(', ')}` });
    }
    sendLaunchStatus({ message: 'Starting Minecraft launch…' });
    const memorySettings = getMemorySettings();
    const { launchedWith } = await launchModpack({
      installDir,
      account,
      onStatus: sendLaunchStatus,
      expectedModpackVersion,
      memorySettings
    });
    sendLaunchStatus({ message: `Launch completed with Forge ${launchedWith}`, level: 'success' });
    logMessage('info', 'Launch completed', { launchedWith });
    return { account: { username: account.username }, installDir, launchedWith };
  } catch (error) {
    sendLaunchStatus({ message: error.message || 'Failed to launch.', level: 'error' });
    logMessage('error', 'Launch failed', { error: error.message });
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

    recordBehavior('update-start', { updateSource: updateSource.url });
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

      sendInstallStatus({ message: 'Verifying Minecraft and Forge files…' });
      await ensureBaseRuntime({ installDir: installDir, onStatus: sendInstallStatus });

      sendUpdateProgress({ state: 'complete', progress: 100, version: result.version || null });
      sendInstallStatus({ message: 'Update completed.', level: 'success' });
      recordBehavior('update-complete', { installDir, version: result.version || null });
      return { installation: await getInstallationState(), version: result.version || null };
    } catch (error) {
      sendInstallStatus({ message: error.message || 'Update failed.', level: 'error' });
      sendUpdateProgress({ state: 'error', message: error.message || 'Update failed.' });
      recordBehavior('update-error', { message: error.message });
      logMessage('error', 'Update failed', { message: error.message });
      throw error;
    }
  });

  ipcMain.handle('hellas:fresh-reinstall', async () => {
    const updateSource = resolveUpdateSource();
    if (!updateSource || !updateSource.url) {
      sendInstallStatus({ message: 'Update source is not configured.', level: 'error' });
      throw new Error('Update source is not configured.');
  }

    recordBehavior('reinstall-start', { updateSource: updateSource.url });
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

      sendInstallStatus({ message: 'Verifying Minecraft and Forge files…' });
      await ensureBaseRuntime({ installDir: installDir, onStatus: sendInstallStatus });

      sendUpdateProgress({ state: 'complete', progress: 100, version: result.version || null });
      sendInstallStatus({ message: 'Reinstall finished.', level: 'success' });
      recordBehavior('reinstall-complete', { installDir, version: result.version || null });
      return { installation: await getInstallationState(), version: result.version || null };
    } catch (error) {
      sendInstallStatus({ message: error.message || 'Reinstall failed.', level: 'error' });
      sendUpdateProgress({ state: 'error', message: error.message || 'Reinstall failed.' });
      recordBehavior('reinstall-error', { message: error.message });
      logMessage('error', 'Reinstall failed', { message: error.message });
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

ipcMain.handle('hellas:open-log-window', async () => {
  const window = createLogWindow();
  return { opened: Boolean(window), path: getLauncherLogPath() };
});

ipcMain.handle('hellas:get-launcher-log', async () => readLauncherLog());

ipcMain.handle('hellas:get-log-info', async () => ({
  launcherLogPath: getLauncherLogPath()
}));
