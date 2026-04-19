const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const Store = require('electron-store');
const semver = require('semver');
require('dotenv').config();
const { HELLAS_ROOT, ensureDirectories } = require('./paths');

const { resolveUpdateSource, downloadAndExtractUpdate, fetchFeedManifest, freshReinstall, hasSource } = require('./update');
const { reinstallBundledJava, reinstallBundledJava8 } = require('./runtime');
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
const {
  LEGACY_PROFILE_ID,
  getProfile,
  getProfileLoader,
  getProfiles,
  getProfileSummary,
  normalizeProfileId
} = require('./profiles');

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
const CURSEFORGE_BROWSER_RESOLVE_TIMEOUT_MS = 30000;

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

function isForgeCdnArchiveUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)forgecdn\.net$/i.test(parsed.hostname) && /\.(jar|zip)$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function resolveCurseForgeDownloadInBrowser(item, details, abortSignal) {
  return new Promise((resolve, reject) => {
    const fileLabel = item?.fileName || details?.fileId || 'CurseForge file';
    const partition = `hellas-cf-download-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const browser = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    const session = browser.webContents.session;
    let settled = false;

    const finish = (error, downloadUrl) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
      session.webRequest.onBeforeRequest({ urls: ['*://*.forgecdn.net/*'] }, null);
      if (!browser.isDestroyed()) {
        browser.destroy();
      }
      if (error) {
        reject(error);
      } else {
        resolve(downloadUrl);
      }
    };

    const onAbort = () => finish(new Error('CurseForge browser download resolving cancelled.'));
    const timeout = setTimeout(
      () => finish(new Error(`Timed out waiting for CurseForge browser download for ${fileLabel}.`)),
      CURSEFORGE_BROWSER_RESOLVE_TIMEOUT_MS
    );

    if (abortSignal) {
      if (abortSignal.aborted) {
        finish(new Error('CurseForge browser download resolving cancelled.'));
        return;
      }
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    session.webRequest.onBeforeRequest({ urls: ['*://*.forgecdn.net/*'] }, (request, callback) => {
      if (isForgeCdnArchiveUrl(request.url)) {
        callback({ cancel: true });
        finish(null, request.url);
        return;
      }
      callback({});
    });

    session.on('will-download', (event, downloadItem) => {
      const urlChain = downloadItem.getURLChain();
      const downloadUrl = urlChain.length ? urlChain[urlChain.length - 1] : downloadItem.getURL();
      event.preventDefault();
      if (downloadUrl) {
        finish(null, downloadUrl);
      }
    });

    browser.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        logMessage('warn', 'CurseForge browser page load failed', {
          fileName: fileLabel,
          errorCode,
          errorDescription,
          url: validatedUrl
        });
      }
    });

    browser.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
    );
    browser
      .loadURL(item.url)
      .catch((error) => finish(new Error(`Failed to open CurseForge download page for ${fileLabel}: ${error.message}`)));
  });
}

function setUpdateInProgress(value) {
  updateInProgress = value;
}

function createStore() {
  const defaults = {
    termsAccepted: false,
    animationEnabled: process.env.AETHERVEIL_ANIM_ENABLED !== 'false',
    installDir: HELLAS_ROOT,
    activeProfileId: LEGACY_PROFILE_ID,
    profileStates: {},
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

function applyProfileOverrides(profile) {
  const state = store.get(`profileStates.${profile.id}`) || {};
  const javaMajor = Number(state.javaMajor);
  const overriddenJava = Number.isFinite(javaMajor) && javaMajor > 0
    ? { ...profile.java, major: javaMajor, allowedMajors: [javaMajor] }
    : { ...profile.java };

  const merged = {
    ...profile,
    forgeVersion: state.forgeVersion || profile.forgeVersion,
    loaderType: state.loaderType || profile.loaderType,
    loaderVersion: state.loaderVersion || profile.loaderVersion,
    neoforgeVersion: state.neoforgeVersion || profile.neoforgeVersion,
    java: overriddenJava
  };
  const loader = getProfileLoader(merged);

  return {
    ...merged,
    loader,
    loaderType: loader.type,
    loaderVersion: loader.version
  };
}

function getActiveProfile() {
  const activeProfileId = normalizeProfileId(store.get('activeProfileId'));
  if (activeProfileId !== store.get('activeProfileId')) {
    store.set('activeProfileId', activeProfileId);
  }
  return applyProfileOverrides(getProfile(activeProfileId));
}

function isLegacyProfile(profile) {
  return profile.id === LEGACY_PROFILE_ID;
}

function getProfileState(profile) {
  return store.get(`profileStates.${profile.id}`) || {};
}

function setProfileStateValue(profile, key, value) {
  store.set(`profileStates.${profile.id}.${key}`, value);
}

function getProfileVersion(profile, key) {
  if (isLegacyProfile(profile)) {
    return store.get(key) || '';
  }

  return getProfileState(profile)[key] || '';
}

function setProfileVersion(profile, key, value) {
  if (isLegacyProfile(profile)) {
    store.set(key, value || '');
  }
  setProfileStateValue(profile, key, value || '');
}

function rememberManifestProfileDetails(profile, manifest = {}) {
  if (manifest.loaderType) {
    setProfileStateValue(profile, 'loaderType', manifest.loaderType);
  }
  if (manifest.loaderVersion) {
    setProfileStateValue(profile, 'loaderVersion', manifest.loaderVersion);
  }
  if (manifest.neoforgeVersion) {
    setProfileStateValue(profile, 'neoforgeVersion', manifest.neoforgeVersion);
  }
  if (manifest.forgeVersion) {
    setProfileStateValue(profile, 'forgeVersion', manifest.forgeVersion);
  }
  if (manifest.javaMajor) {
    setProfileStateValue(profile, 'javaMajor', manifest.javaMajor);
  }
}

function getAdditionalMods(profile = getActiveProfile()) {
  const links = getProfileState(profile).additionalMods || [];
  return Array.isArray(links) ? links.filter((link) => typeof link === 'string' && link.trim()) : [];
}

function setAdditionalMods(profile, links) {
  const normalized = Array.isArray(links)
    ? links.map((link) => String(link || '').trim()).filter(Boolean)
    : [];
  setProfileStateValue(profile, 'additionalMods', Array.from(new Set(normalized)));
  return getAdditionalMods(profile);
}

function getInstallDir(profile = getActiveProfile()) {
  if (isLegacyProfile(profile)) {
    // Enforce the Hellas layout at %APPDATA%/Hellas with the modpack stored in
    // the /modpack folder. Persist the value in the store so subsequent runs stay
    // consistent, but do not allow overrides.
    store.set('installDir', HELLAS_ROOT);
    ensureDirectories(HELLAS_ROOT);
    return HELLAS_ROOT;
  }

  ensureDirectories(HELLAS_ROOT);
  fs.mkdirSync(profile.installDir, { recursive: true });
  fs.mkdirSync(profile.instanceDir, { recursive: true });
  fs.mkdirSync(profile.forgeDir, { recursive: true });
  fs.mkdirSync(profile.versionsDir, { recursive: true });
  return profile.installDir;
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

function getMemorySettings(profile = getActiveProfile()) {
  if (isLegacyProfile(profile)) {
    return normalizeMemorySettings(store.get('memory') || {});
  }

  return normalizeMemorySettings(getProfileState(profile).memory || {});
}

function setMemorySettings(settings, profile = getActiveProfile()) {
  const normalized = normalizeMemorySettings(settings);
  if (isLegacyProfile(profile)) {
    store.set('memory', normalized);
  }
  setProfileStateValue(profile, 'memory', normalized);
  return normalized;
}

function getMemoryState(profile = getActiveProfile()) {
  const settings = getMemorySettings(profile);
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

async function getInstallationState(profile = getActiveProfile()) {
  const dir = getInstallDir(profile);
  const installDirExists = fs.existsSync(dir);
  let requirements = { minecraft: false, forge: false, modpack: false };
  let forgeVersion = null;
  let minecraftVersion = null;
  let detectedModpackVersion = null;
  let modpackErrors = [];
  let searchedModDirectories = [];
  const expectedModpackVersion =
    getProfileVersion(profile, 'lastKnownVersion') || getProfileVersion(profile, 'installedVersion') || null;

  try {
    const check = await checkLaunchRequirements(dir, expectedModpackVersion, profile);
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

  const installedVersion = getProfileVersion(profile, 'installedVersion') || '';
  const lastKnownVersion = getProfileVersion(profile, 'lastKnownVersion') || '';
  const resolvedInstalledVersion =
    installedVersion ||
    detectedModpackVersion ||
    (requirements.modpack ? expectedModpackVersion : '') ||
    lastKnownVersion ||
    (requirements.modpack ? 'unversioned' : '');

  if (detectedModpackVersion && detectedModpackVersion !== installedVersion) {
    setProfileVersion(profile, 'installedVersion', detectedModpackVersion);
  }
  // Consider the installation launch-ready once the modpack content is present; the
  // launcher can download missing Minecraft/loader files on demand during launch.
  const readyToLaunch = installDirExists && Boolean(resolvedInstalledVersion) && Boolean(requirements.modpack);

  return {
    installDir: dir,
    profileId: profile.id,
    profile: getProfileSummary(profile),
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
  const activeProfile = getActiveProfile();
  const installation = await getInstallationState(activeProfile);
  const updateSource = resolveUpdateSource(activeProfile);
  let preferredVersion = installation.lastKnownVersion;

  if (hasSource(updateSource)) {
    if (updateSource.type === 'feed') {
      try {
        const manifest = await fetchFeedManifest(updateSource.feedUrl, activeProfile);
        rememberManifestProfileDetails(activeProfile, manifest);
        if (manifest.version) {
          preferredVersion = manifest.version;
          setProfileVersion(activeProfile, 'lastKnownVersion', manifest.version);
        }
      } catch (error) {
        console.warn('Failed to fetch update feed', error);
      }
    } else if (updateSource.type === 'manifest') {
      try {
        const manifest = await fetchFeedManifest(updateSource.manifestUrl, activeProfile);
        rememberManifestProfileDetails(activeProfile, manifest);
        if (manifest.version) {
          preferredVersion = manifest.version;
          setProfileVersion(activeProfile, 'lastKnownVersion', manifest.version);
        }
      } catch (error) {
        console.warn('Failed to fetch update manifest', error);
      }
    } else if (updateSource.version) {
      preferredVersion = updateSource.version;
      setProfileVersion(activeProfile, 'lastKnownVersion', updateSource.version);
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
    profiles: getProfiles().map(getProfileSummary),
    activeProfile: getProfileSummary(activeProfile),
    additionalMods: getAdditionalMods(activeProfile),
    installation,
    account: getAccount(),
    termsAccepted: store.get('termsAccepted'),
    animationEnabled: store.get('animationEnabled'),
    memory: getMemoryState(activeProfile),
    update: {
      hasUpdateSource: hasSource(updateSource),
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

ipcMain.handle('hellas:get-memory-settings', async () => getMemoryState(getActiveProfile()));

ipcMain.handle('hellas:set-memory-settings', async (_event, settings) => {
  const activeProfile = getActiveProfile();
  setMemorySettings(settings, activeProfile);
  return getMemoryState(activeProfile);
});

ipcMain.handle('hellas:set-active-profile', async (_event, profileId) => {
  const nextProfileId = normalizeProfileId(profileId);
  store.set('activeProfileId', nextProfileId);
  const profile = getActiveProfile();
  return {
    activeProfile: getProfileSummary(profile),
    installation: await getInstallationState(profile),
    memory: getMemoryState(profile),
    additionalMods: getAdditionalMods(profile)
  };
});

ipcMain.handle('hellas:get-additional-mods', async () => getAdditionalMods(getActiveProfile()));

ipcMain.handle('hellas:set-additional-mods', async (_event, links) => {
  const profile = getActiveProfile();
  return setAdditionalMods(profile, links);
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
    const profile = getActiveProfile();
    const dir = getInstallDir(profile);
    const updateSource = resolveUpdateSource(profile);
    if (!hasSource(updateSource)) {
      sendInstallStatus({ message: 'Update source is not configured.', level: 'error' });
      throw new Error('Update source is not configured.');
    }

    await fs.promises.mkdir(dir, { recursive: true });

    recordBehavior('install-start', { dir, profileId: profile.id, updateSource: updateSource.sourceUrl || updateSource.url });

    sendInstallStatus({ message: `Preparing installation into ${dir}` });
    sendUpdateProgress({ state: 'downloading', progress: 0 });
    try {
      const result = await runUpdateTask((signal) =>
        downloadAndExtractUpdate(updateSource, dir, sendUpdateProgress, signal, {
          profile,
          additionalMods: getAdditionalMods(profile),
          resolveCurseForgeDownloadUrl: resolveCurseForgeDownloadInBrowser
        })
      );

      if (result.cancelled) {
        sendUpdateProgress({ state: 'cancelled', message: 'Installation cancelled.' });
        return { cancelled: true };
      }

      if (result.version) {
        setProfileVersion(profile, 'installedVersion', result.version);
        setProfileVersion(profile, 'lastKnownVersion', result.version);
      }
      rememberManifestProfileDetails(profile, result);

      const runtimeProfile = applyProfileOverrides(profile);
      sendInstallStatus({ message: 'Verifying Minecraft and loader files…' });
      await ensureBaseRuntime({ installDir: dir, profile: runtimeProfile, onStatus: sendInstallStatus });

      sendUpdateProgress({ state: 'complete', progress: 100, version: result.version || null });
      sendInstallStatus({ message: 'Installation completed successfully.', level: 'success' });
      recordBehavior('install-complete', { dir, version: result.version || null });
      return { installation: await getInstallationState(runtimeProfile), version: result.version || null };
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

ipcMain.handle('hellas:open-install-folder', async () => {
  const dir = getInstallDir();
  await fs.promises.mkdir(dir, { recursive: true });
  await shell.openPath(dir);
  return dir;
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

  const profile = getActiveProfile();
  const installDir = getInstallDir(profile);
  const installation = await getInstallationState(profile);
  const expectedModpackVersion =
    installation.lastKnownVersion || installation.installedVersion || null;

  recordBehavior('launch-attempt', {
    installDir,
    profileId: profile.id,
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
    const memorySettings = getMemorySettings(profile);
    const { launchedWith, loader } = await launchModpack({
      installDir,
      profile,
      account,
      onStatus: sendLaunchStatus,
      expectedModpackVersion,
      memorySettings
    });
    const launchedLoader = loader ? `${loader.label} ${loader.version}` : launchedWith;
    sendLaunchStatus({ message: `Launch completed with ${launchedLoader}`, level: 'success' });
    logMessage('info', 'Launch completed', { launchedWith, loader });
    return { account: { username: account.username }, installDir, launchedWith, loader };
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
    const profile = getActiveProfile();
    const updateSource = resolveUpdateSource(profile);
    if (!hasSource(updateSource)) {
      sendInstallStatus({ message: 'Update source is not configured.', level: 'error' });
      throw new Error('Update source is not configured.');
    }

    recordBehavior('update-start', { profileId: profile.id, updateSource: updateSource.sourceUrl || updateSource.url });
    sendInstallStatus({ message: 'Starting update…' });
    sendUpdateProgress({ state: 'downloading', progress: 0 });
    const installDir = getInstallDir(profile);
    try {
      const result = await runUpdateTask((signal) =>
        downloadAndExtractUpdate(updateSource, installDir, sendUpdateProgress, signal, {
          profile,
          additionalMods: getAdditionalMods(profile),
          resolveCurseForgeDownloadUrl: resolveCurseForgeDownloadInBrowser
        })
      );

      if (result.cancelled) {
        sendUpdateProgress({ state: 'cancelled', message: 'Update cancelled.' });
        return { cancelled: true };
      }

      if (result.version) {
        setProfileVersion(profile, 'installedVersion', result.version);
        setProfileVersion(profile, 'lastKnownVersion', result.version);
      }
      rememberManifestProfileDetails(profile, result);

      const runtimeProfile = applyProfileOverrides(profile);
      sendInstallStatus({ message: 'Verifying Minecraft and loader files…' });
      await ensureBaseRuntime({ installDir: installDir, profile: runtimeProfile, onStatus: sendInstallStatus });

      sendUpdateProgress({ state: 'complete', progress: 100, version: result.version || null });
      sendInstallStatus({ message: 'Update completed.', level: 'success' });
      recordBehavior('update-complete', { installDir, version: result.version || null });
      return { installation: await getInstallationState(runtimeProfile), version: result.version || null };
    } catch (error) {
      sendInstallStatus({ message: error.message || 'Update failed.', level: 'error' });
      sendUpdateProgress({ state: 'error', message: error.message || 'Update failed.' });
      recordBehavior('update-error', { message: error.message });
      logMessage('error', 'Update failed', { message: error.message });
      throw error;
    }
  });

  ipcMain.handle('hellas:fresh-reinstall', async () => {
    const profile = getActiveProfile();
    const updateSource = resolveUpdateSource(profile);
    if (!hasSource(updateSource)) {
      sendInstallStatus({ message: 'Update source is not configured.', level: 'error' });
      throw new Error('Update source is not configured.');
  }

    recordBehavior('reinstall-start', { profileId: profile.id, updateSource: updateSource.sourceUrl || updateSource.url });
    sendInstallStatus({ message: 'Starting fresh reinstall…' });
    sendUpdateProgress({ state: 'downloading', progress: 0 });
    const installDir = getInstallDir(profile);
    try {
      const result = await runUpdateTask((signal) =>
        freshReinstall(installDir, sendUpdateProgress, signal, {
          profile,
          additionalMods: getAdditionalMods(profile),
          resolveCurseForgeDownloadUrl: resolveCurseForgeDownloadInBrowser
        })
      );

      if (result.cancelled) {
        sendUpdateProgress({ state: 'cancelled', message: 'Reinstall cancelled.' });
        return { cancelled: true };
      }

      if (result.version) {
        setProfileVersion(profile, 'installedVersion', result.version);
        setProfileVersion(profile, 'lastKnownVersion', result.version);
      }
      rememberManifestProfileDetails(profile, result);

      const runtimeProfile = applyProfileOverrides(profile);
      sendInstallStatus({ message: 'Verifying Minecraft and loader files…' });
      await ensureBaseRuntime({ installDir: installDir, profile: runtimeProfile, onStatus: sendInstallStatus });

      sendUpdateProgress({ state: 'complete', progress: 100, version: result.version || null });
      sendInstallStatus({ message: 'Reinstall finished.', level: 'success' });
      recordBehavior('reinstall-complete', { installDir, version: result.version || null });
      return { installation: await getInstallationState(runtimeProfile), version: result.version || null };
    } catch (error) {
      sendInstallStatus({ message: error.message || 'Reinstall failed.', level: 'error' });
      sendUpdateProgress({ state: 'error', message: error.message || 'Reinstall failed.' });
      recordBehavior('reinstall-error', { message: error.message });
      logMessage('error', 'Reinstall failed', { message: error.message });
      throw error;
    }
  });

  ipcMain.handle('hellas:reinstall-java8', async () => {
    recordBehavior('java8-reinstall-start', {});
    sendInstallStatus({ message: 'Reinstalling bundled Java 8 runtime…' });
    sendUpdateProgress({ state: 'downloading', progress: 0 });

    try {
      const result = await runUpdateTask((signal) =>
        reinstallBundledJava8({ onStatus: sendInstallStatus, onProgress: sendUpdateProgress }, signal)
      );

      if (result.cancelled) {
        sendUpdateProgress({ state: 'cancelled', message: 'Java 8 reinstall cancelled.' });
        return { cancelled: true };
      }

      sendUpdateProgress({ state: 'complete', progress: 100 });
      sendInstallStatus({ message: 'Java 8 reinstall finished.', level: 'success' });
      recordBehavior('java8-reinstall-complete', { targetDir: result.targetDir });
      return { targetDir: result.targetDir };
    } catch (error) {
      sendInstallStatus({ message: error.message || 'Java 8 reinstall failed.', level: 'error' });
      sendUpdateProgress({ state: 'error', message: error.message || 'Java 8 reinstall failed.' });
      recordBehavior('java8-reinstall-error', { message: error.message });
      logMessage('error', 'Java 8 reinstall failed', { message: error.message });
      throw error;
    }
  });

  ipcMain.handle('hellas:reinstall-profile-java', async () => {
    const profile = getActiveProfile();
    const javaMajor = profile.java?.major || 8;
    const label = `Java ${javaMajor}`;
    recordBehavior('profile-java-reinstall-start', { profileId: profile.id, javaMajor });
    sendInstallStatus({ message: `Reinstalling bundled ${label} runtime…` });
    sendUpdateProgress({ state: 'downloading', progress: 0 });

    try {
      const result = await runUpdateTask((signal) =>
        reinstallBundledJava({ major: javaMajor, onStatus: sendInstallStatus, onProgress: sendUpdateProgress }, signal)
      );

      if (result.cancelled) {
        sendUpdateProgress({ state: 'cancelled', message: `${label} reinstall cancelled.` });
        return { cancelled: true, javaMajor };
      }

      sendUpdateProgress({ state: 'complete', progress: 100 });
      sendInstallStatus({ message: `${label} reinstall finished.`, level: 'success' });
      recordBehavior('profile-java-reinstall-complete', {
        profileId: profile.id,
        javaMajor,
        targetDir: result.targetDir
      });
      return { targetDir: result.targetDir, javaMajor };
    } catch (error) {
      sendInstallStatus({ message: error.message || `${label} reinstall failed.`, level: 'error' });
      sendUpdateProgress({ state: 'error', message: error.message || `${label} reinstall failed.` });
      recordBehavior('profile-java-reinstall-error', { profileId: profile.id, javaMajor, message: error.message });
      logMessage('error', `${label} reinstall failed`, { profileId: profile.id, error: error.message });
      throw error;
    }
  });

ipcMain.handle('hellas:get-installation', async () => getInstallationState(getActiveProfile()));

ipcMain.handle('hellas:update-known-version', async (_event, version) => {
  const profile = getActiveProfile();
  if (version) {
    setProfileVersion(profile, 'lastKnownVersion', version);
  }
  return getProfileVersion(profile, 'lastKnownVersion');
});

ipcMain.handle('hellas:open-log-window', async () => {
  const window = createLogWindow();
  return { opened: Boolean(window), path: getLauncherLogPath() };
});

ipcMain.handle('hellas:get-launcher-log', async () => readLauncherLog());

ipcMain.handle('hellas:get-log-info', async () => ({
  launcherLogPath: getLauncherLogPath()
}));
