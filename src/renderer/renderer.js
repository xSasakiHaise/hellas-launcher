const videoEl = document.getElementById('bg-video');
const fallbackEl = document.getElementById('bg-fallback');
const logoButton = document.getElementById('logo-button');
const menuButton = document.getElementById('menu-button');
const accountButton = document.getElementById('account-button');
const accountUsername = document.getElementById('account-username');
const closeButton = document.getElementById('close-button');
const maximizeButton = document.getElementById('maximize-button');
const accountModal = document.getElementById('account-modal');
const topBar = document.querySelector('.top-bar');
const dropdown = document.getElementById('dropdown');
const termsCheckbox = document.getElementById('terms-checkbox');
const startButton = document.getElementById('start-button');
const updateButton = document.getElementById('update-button');
const installStateLabel = document.getElementById('install-state');
const versionLabel = document.getElementById('version-label');
const updateProgress = document.getElementById('update-progress');
const updateProgressBar = document.getElementById('update-progress-bar');
const updateProgressText = document.getElementById('update-progress-text');
const cancelUpdateButton = document.getElementById('cancel-update-button');
const loginButton = document.getElementById('login-button');
const accountStatus = document.getElementById('account-status');
const accountPanel = document.getElementById('account-panel');
const deviceLoginPanel = document.getElementById('device-login');
const userCodeEl = document.getElementById('user-code');
const deviceMessage = document.getElementById('device-message');
const openLoginButton = document.getElementById('open-login');
const copyCodeButton = document.getElementById('copy-code');
const closeAccountModal = document.getElementById('close-account-modal');
const launchLog = document.getElementById('launch-log');
const cancelLaunchButton = document.getElementById('cancel-launch-button');

let launcherState = {
  termsAccepted: false,
  animationEnabled: true,
  installation: {
    isInstalled: false,
    installDir: '',
    installDirExists: false,
    installedVersion: '',
    lastKnownVersion: '',
    requirements: {
      minecraft: false,
      forge: false,
      modpack: false
    }
  },
  account: {
    username: '',
    loggedIn: false
  },
  update: {
    hasUpdateSource: false,
    preferredVersion: null
  },
  isUpdating: false
};

let activeDeviceLogin = null;
let pollTimer = null;
let accountPanelOpen = false;
let updateInProgress = false;
let launchInProgress = false;

function setAccountStatus(message, isError = false) {
  accountStatus.textContent = message || '';
  accountStatus.classList.toggle('error', Boolean(isError));
}

function clearLaunchLog() {
  if (!launchLog) return;
  launchLog.innerHTML = '';
  launchLog.classList.remove('error', 'success');
}

function appendLaunchLog(message, level = 'info') {
  if (!launchLog || !message) return;
  const entry = document.createElement('div');
  entry.classList.add('launch-log-entry');
  if (level) {
    entry.classList.add(level);
    launchLog.classList.toggle('error', level === 'error');
    launchLog.classList.toggle('success', level === 'success');
  }
  entry.textContent = message;
  launchLog.appendChild(entry);
  launchLog.scrollTop = launchLog.scrollHeight;
}

function setDropdown(open) {
  dropdown.classList.toggle('open', open);
  const expanded = open ? 'true' : 'false';
  menuButton.setAttribute('aria-expanded', expanded);
}

function updateStartButtonState() {
  const { termsAccepted, installation, isUpdating } = launcherState;
  startButton.querySelector('.label').textContent = 'PLAY';
  startButton.disabled = !termsAccepted || updateInProgress || launchInProgress || isUpdating;
  startButton.classList.toggle('needs-install', !installation.isInstalled);
}

function updateInstallLabels() {
  const { installation } = launcherState;
  const requirements = installation.requirements || {};
  const missing = ['minecraft', 'forge', 'modpack']
    .filter((key) => requirements[key] === false)
    .map((key) => key.charAt(0).toUpperCase() + key.slice(1));

  if (installation.isInstalled) {
    installStateLabel.textContent = `Ready in ${installation.installDir}`;
  } else if (installation.installDirExists) {
    installStateLabel.textContent = missing.length ? `Missing: ${missing.join(', ')}` : 'Install required';
  } else {
    installStateLabel.textContent = 'Install required';
  }

  const versionText = launcherState.update.preferredVersion || installation.installedVersion;
  if (versionText) {
    const suffix = launcherState.update.available ? ' • Update available' : '';
    versionLabel.textContent = `Version ${versionText}${suffix}`;
  } else {
    versionLabel.textContent = '';
  }
}

function updateUpdateButtonLabel() {
  const { installation, update } = launcherState;
  const installRequired = !installation.isInstalled;
  const updateLabel = updateButton.querySelector('.label');

  if (!update.hasUpdateSource && !installRequired) {
    updateButton.disabled = true;
    if (updateLabel) {
      updateLabel.textContent = 'No Update Source';
    }
    return;
  }

  if (updateLabel) {
    updateLabel.textContent = installRequired ? 'Install' : 'Update';
  }
  updateButton.disabled = false;
}

function applyAnimationState() {
  if (launcherState.animationEnabled) {
    videoEl.classList.remove('paused');
    if (videoEl.paused) {
      videoEl.play().catch(() => {});
    }
  } else {
    videoEl.classList.add('paused');
    videoEl.pause();
  }
}

function setUpdating(isUpdating, options = {}) {
  const { resetText = true, mode = 'update' } = options;
  updateInProgress = isUpdating;
  launcherState.isUpdating = isUpdating;
  startButton.disabled = isUpdating || !launcherState.termsAccepted || launchInProgress;
  updateButton.disabled = isUpdating;
  updateProgress.hidden = !isUpdating;
  updateProgress.classList.remove('error');
  const updateLabel = updateButton.querySelector('.label');
  if (isUpdating) {
    if (updateLabel) updateLabel.textContent = mode === 'install' ? 'Installing…' : 'Updating…';
  } else {
    updateUpdateButtonLabel();
  }
  if (!isUpdating && resetText) {
    updateProgressBar.style.width = '0%';
    updateProgressText.textContent = '';
  }
  if (cancelUpdateButton) {
    cancelUpdateButton.hidden = !isUpdating;
    cancelUpdateButton.disabled = !isUpdating;
  }
}

function handleProgress(payload) {
  if (!payload) {
    return;
  }
    if (payload.state === 'error') {
      updateProgress.classList.add('error');
      updateProgressBar.style.width = '0%';
      updateProgressText.textContent = payload.message || 'Download failed. Please try again.';
      appendLaunchLog(payload.message || 'Download failed. Please try again.', 'error');
      setUpdating(false, { resetText: false });
      updateProgress.hidden = false;
      return;
    }

  if (payload.state === 'cancelled') {
    updateProgress.classList.remove('error');
    updateProgressBar.style.width = '0%';
    updateProgressText.textContent = payload.message || 'Update cancelled.';
    setUpdating(false, { resetText: false });
    updateProgress.hidden = false;
    return;
  }

  if (payload.state === 'complete') {
    updateProgressBar.style.width = '100%';
    updateProgressText.textContent = payload.version ? `Updated to ${payload.version}` : 'Update complete';
    appendLaunchLog(
      payload.version ? `Updated to ${payload.version}` : 'Update complete',
      'success'
    );
    setTimeout(() => setUpdating(false), 1500);
    return;
  }

  if (payload.state === 'fetching-feed') {
    updateProgressText.textContent = 'Fetching pack info…';
    updateProgress.hidden = false;
  }

  if (typeof payload.progress === 'number') {
    const clamped = Math.max(0, Math.min(100, payload.progress));
    updateProgressBar.style.width = `${clamped}%`;
    const stateLabel =
      {
        'fetching-feed': 'Fetching pack info…',
        downloading: 'Downloading…',
        extracting: 'Extracting…',
        finalizing: 'Finalizing…'
      }[payload.state] || 'Updating…';
    updateProgressText.textContent = `${stateLabel} ${clamped}%`;
  }
}

function handleLaunchStatus(payload) {
  if (!payload) return;
  appendLaunchLog(payload.message, payload.level || 'info');
}

function handleInstallStatus(payload) {
  if (!payload) return;
  appendLaunchLog(payload.message, payload.level || 'info');
}

function hideDeviceLogin() {
  activeDeviceLogin = null;
  deviceLoginPanel.hidden = true;
  deviceMessage.textContent = '';
  userCodeEl.textContent = '';
}

function setAccountPanel(open) {
  accountPanelOpen = open;
  if (accountButton) {
    accountButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    accountButton.classList.toggle('active', open);
  }

  if (accountModal) {
    accountModal.hidden = !open;
  }
  if (accountPanel) {
    accountPanel.hidden = !open;
  }

  if (!open) {
    hideDeviceLogin();
  }
}

function updateAccountUi() {
  const { account } = launcherState;
  const loggedIn = Boolean(account?.loggedIn);
  if (accountUsername) {
    accountUsername.textContent = loggedIn ? account.username : '';
  }
  accountButton.classList.toggle('show-name', loggedIn);
  if (accountModal) {
    accountModal.hidden = !accountPanelOpen;
  }
  if (accountPanel) {
    accountPanel.hidden = !accountPanelOpen;
  }
  if (loginButton) {
    loginButton.hidden = loggedIn;
    loginButton.disabled = loggedIn;
  }
  if (loggedIn) {
    hideDeviceLogin();
  }
}

async function startLoginFlow() {
  hideDeviceLogin();
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  setAccountPanel(true);
  setAccountStatus('Starting Microsoft sign-in…');
  try {
    const deviceInfo = await window.hellas.beginDeviceLogin();
    activeDeviceLogin = deviceInfo;
    userCodeEl.textContent = deviceInfo.userCode;
    deviceMessage.textContent = deviceInfo.message || 'Use this code to sign in.';
    deviceLoginPanel.hidden = false;
    window.hellas.openExternal(deviceInfo.verificationUri);
    startPollingForLogin();
  } catch (error) {
    console.error(error);
    setAccountStatus(error.message || 'Failed to start sign-in.', true);
    hideDeviceLogin();
  }
}

function startPollingForLogin(intervalOverride) {
  if (!activeDeviceLogin) return;
  const currentInterval = intervalOverride || Math.max(5000, (activeDeviceLogin.interval || 5) * 1000);

  if (pollTimer) clearInterval(pollTimer);

  pollTimer = setInterval(async () => {
    try {
      const result = await window.hellas.pollDeviceLogin({ deviceCode: activeDeviceLogin.deviceCode });
      if (result.status === 'pending') {
        deviceMessage.textContent = 'Waiting for approval…';
        return;
      }
      if (result.status === 'slow_down') {
        clearInterval(pollTimer);
        pollTimer = null;
        setTimeout(() => startPollingForLogin(currentInterval + 2000), currentInterval);
        deviceMessage.textContent = 'Please finish signing in…';
        return;
      }
      if (result.status === 'expired' || result.status === 'declined') {
        setAccountStatus(result.message || 'Authorization was declined or expired.', true);
        hideDeviceLogin();
        clearInterval(pollTimer);
        pollTimer = null;
        return;
      }
      if (result.status === 'error') {
        setAccountStatus(result.message || 'Login failed.', true);
        hideDeviceLogin();
        clearInterval(pollTimer);
        pollTimer = null;
        return;
      }
      if (result.status === 'success') {
        hideDeviceLogin();
        launcherState.account = result.account;
        setAccountStatus(`Logged in as ${result.account.username}`);
        updateAccountUi();
        updateStartButtonState();
        setAccountPanel(false);
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } catch (error) {
      console.error(error);
      setAccountStatus(error.message || 'Login failed.', true);
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, currentInterval);
}

async function refreshState() {
  const state = await window.hellas.getState();
  launcherState = state;
  termsCheckbox.checked = state.termsAccepted;
  if (state.account?.loggedIn) {
    setAccountStatus(`Logged in as ${state.account.username}`);
  } else {
    setAccountStatus('Not logged in', true);
  }
  updateAccountUi();
  updateStartButtonState();
  updateInstallLabels();
  applyAnimationState();
  updateUpdateButtonLabel();
}

function closeDropdownOnClickOutside(event) {
  if (!dropdown.contains(event.target) && !menuButton.contains(event.target) && !accountButton.contains(event.target)) {
    setDropdown(false);
  }
}

document.addEventListener('click', closeDropdownOnClickOutside);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    setDropdown(false);
    setAccountPanel(false);
  }
});

menuButton.addEventListener('click', () => {
  setDropdown(!dropdown.classList.contains('open'));
  setAccountPanel(false);
});

accountButton.addEventListener('click', async () => {
  setDropdown(false);
  setAccountPanel(!accountPanelOpen);
  if (launcherState.account.loggedIn) {
    setAccountStatus(`Logged in as ${launcherState.account.username}`);
  }
});

if (closeAccountModal) {
  closeAccountModal.addEventListener('click', () => setAccountPanel(false));
}

if (accountModal) {
  accountModal.addEventListener('click', (event) => {
    if (event.target === accountModal) {
      setAccountPanel(false);
    }
  });
}

logoButton.addEventListener('click', () => {
  window.hellas.openExternal(launcherState.websiteUrl || 'https://hellasregion.com');
});

closeButton.addEventListener('click', async () => {
  if (updateInProgress) {
    const shouldClose = window.confirm(
      'A download is in progress. Closing will cancel it. Are you sure you want to exit?'
    );

    if (!shouldClose) {
      return;
    }

    await window.hellas.cancelUpdate();
  }

  window.hellas.close();
});

if (maximizeButton) {
  maximizeButton.addEventListener('click', () => {
    window.hellas.toggleMaximize();
  });
}

if (topBar) {
  topBar.addEventListener('dblclick', (event) => {
    if (
      event.target.closest('.icon-button') ||
      event.target.closest('.logo') ||
      event.target.closest('.dropdown')
    ) {
      return;
    }
    window.hellas.toggleMaximize();
  });
}

termsCheckbox.addEventListener('change', async (event) => {
  const checked = event.target.checked;
  launcherState.termsAccepted = await window.hellas.setTermsAccepted(checked);
  updateStartButtonState();
});

loginButton.addEventListener('click', startLoginFlow);

if (openLoginButton) {
  openLoginButton.addEventListener('click', () => {
    if (activeDeviceLogin?.verificationUri) {
      window.hellas.openExternal(activeDeviceLogin.verificationUri);
    }
  });
}

if (copyCodeButton) {
  copyCodeButton.addEventListener('click', async () => {
    if (!activeDeviceLogin?.userCode) return;
    try {
      await navigator.clipboard.writeText(activeDeviceLogin.userCode);
      deviceMessage.textContent = 'Code copied. Complete sign-in in your browser.';
    } catch (error) {
      deviceMessage.textContent = 'Copy failed. Enter the code manually.';
    }
  });
}

startButton.addEventListener('click', async () => {
  if (!launcherState.termsAccepted) {
    return;
  }

  clearLaunchLog();

  if (!launcherState.installation.isInstalled) {
    appendLaunchLog('Warning: Modpack not installed. Launch may fail.');
  }

  if (!launcherState.account.loggedIn) {
    setAccountStatus('Please log in before launching.', true);
    appendLaunchLog('Launch blocked: please log in first.', 'error');
    setAccountPanel(true);
    return;
  }

  launchInProgress = true;
  if (cancelLaunchButton) {
    cancelLaunchButton.hidden = false;
    cancelLaunchButton.disabled = false;
  }
  startButton.querySelector('.label').textContent = 'LAUNCHING…';
  appendLaunchLog('Requesting game launch…');
  try {
    await window.hellas.launchGame();
    setAccountStatus('Modpack launch triggered.');
    appendLaunchLog('Launch request sent. Waiting for game to start…');
  } catch (error) {
    console.error(error);
    setAccountStatus(error.message || 'Failed to launch the modpack.', true);
    appendLaunchLog(error.message || 'Failed to launch the modpack.', 'error');
  } finally {
    launchInProgress = false;
    if (cancelLaunchButton) {
      cancelLaunchButton.hidden = true;
    }
    startButton.querySelector('.label').textContent = 'PLAY';
    updateStartButtonState();
  }
});

updateButton.addEventListener('click', async () => {
  if (updateButton.disabled) {
    return;
  }

  const isInstall = !launcherState.installation.isInstalled;
  const cancelledMessage = isInstall ? 'Install cancelled.' : 'Update cancelled.';
  const failureMessage = isInstall ? 'Install failed' : 'Update failed';

  setUpdating(true, { mode: isInstall ? 'install' : 'update' });
  updateProgressText.textContent = 'Preparing…';
  let preserveProgress = false;
  try {
    const result = isInstall ? await window.hellas.performInstall() : await window.hellas.triggerUpdate();
    if (result?.cancelled) {
      updateProgressText.textContent = cancelledMessage;
      setUpdating(false, { resetText: false });
      updateProgress.hidden = false;
      preserveProgress = true;
      return;
    }
    if (result && result.installation) {
      launcherState.installation = result.installation;
      if (result.version) {
        launcherState.update.preferredVersion = result.version;
        await window.hellas.updateKnownVersion(result.version);
      }
      launcherState.update.available = false;
      updateInstallLabels();
      updateStartButtonState();
      if (isInstall) {
        appendLaunchLog('Installation completed. Ready to launch.');
      }
    }
    setUpdating(false);
  } catch (error) {
    console.error(error);
    if (error?.cancelled || error?.message === 'Update cancelled') {
      updateProgress.classList.remove('error');
      updateProgressText.textContent = cancelledMessage;
      setUpdating(false, { resetText: false });
      updateProgress.hidden = false;
      preserveProgress = true;
    } else {
      updateProgress.classList.add('error');
      updateProgressText.textContent = error.message || failureMessage;
      if (isInstall) {
        setAccountStatus(error.message || 'Install failed.', true);
      }
      setTimeout(() => {
        setUpdating(false, { resetText: false });
        updateProgress.hidden = false;
      }, 2500);
    }
  } finally {
    if (preserveProgress) {
      updateProgress.hidden = false;
    }
  }
});

if (cancelUpdateButton) {
  cancelUpdateButton.addEventListener('click', async () => {
    cancelUpdateButton.disabled = true;
    updateProgress.hidden = false;
    updateProgressText.textContent = 'Cancelling…';
    await window.hellas.cancelUpdate();
  });
}

if (cancelLaunchButton) {
  cancelLaunchButton.addEventListener('click', async () => {
    cancelLaunchButton.disabled = true;
    await window.hellas.cancelLaunch();
    launchInProgress = false;
    startButton.querySelector('.label').textContent = 'PLAY';
    setAccountStatus('Launch cancelled.', true);
    updateStartButtonState();
    cancelLaunchButton.hidden = true;
  });
}

const dropdownActions = dropdown.querySelectorAll('button[data-action]');
dropdownActions.forEach((button) => {
  button.addEventListener('click', async () => {
    const action = button.dataset.action;
    setDropdown(false);
      switch (action) {
        case 'dynmap':
          await window.hellas.openExternal(launcherState.dynmapUrl || 'https://map.pixelmon-server.com');
          break;
        case 'toggle-animation':
          launcherState.animationEnabled = !launcherState.animationEnabled;
          await window.hellas.setAnimationEnabled(launcherState.animationEnabled);
          applyAnimationState();
          break;
        case 'open-logs': {
          try {
            await window.hellas.openLogWindow();
          } catch (error) {
            console.error('Failed to open log window', error);
            appendLaunchLog('Unable to open log window. Check debug.txt for details.', 'error');
          }
          break;
        }
        case 'reinstall': {
          setUpdating(true);
          updateProgressText.textContent = 'Reinstalling…';
          let preserveProgress = false;
          try {
            const result = await window.hellas.freshReinstall();
            if (result?.cancelled) {
              updateProgressText.textContent = 'Reinstall cancelled.';
              updateProgress.hidden = false;
              setUpdating(false, { resetText: false });
              preserveProgress = true;
              return;
            }
            if (result && result.installation) {
              launcherState.installation = result.installation;
            }
            if (result && result.version) {
              launcherState.update.preferredVersion = result.version;
              await window.hellas.updateKnownVersion(result.version);
            }
            launcherState.update.available = false;
            updateInstallLabels();
            updateStartButtonState();
            setUpdating(false);
          } catch (error) {
            console.error(error);
            if (error?.cancelled || error?.message === 'Update cancelled') {
              updateProgress.classList.remove('error');
              updateProgressText.textContent = 'Reinstall cancelled.';
              setUpdating(false, { resetText: false });
              updateProgress.hidden = false;
              preserveProgress = true;
            } else {
              updateProgress.classList.add('error');
              updateProgressText.textContent = error.message || 'Reinstall failed';
              setTimeout(() => {
                setUpdating(false, { resetText: false });
                updateProgress.hidden = false;
              }, 2500);
            }
          } finally {
            if (preserveProgress) {
              updateProgress.hidden = false;
            }
          }
          break;
        }
      case 'logout':
        await window.hellas.logout();
        launcherState.account = { username: '', loggedIn: false };
        hideDeviceLogin();
        setAccountStatus('Logged out', true);
        updateAccountUi();
        updateStartButtonState();
        break;
      default:
        break;
    }
  });
});

window.hellas.onUpdateProgress(handleProgress);
window.hellas.onLaunchStatus(handleLaunchStatus);
window.hellas.onInstallStatus(handleInstallStatus);

window.hellas.onAccountUpdated((account) => {
  launcherState.account = account || { username: '', loggedIn: false };
  if (account?.loggedIn) {
    setAccountStatus(`Logged in as ${account.username}`);
  } else {
    setAccountStatus('Not logged in', true);
  }
  updateAccountUi();
  updateStartButtonState();
});

window.addEventListener('DOMContentLoaded', async () => {
  await refreshState();

  videoEl.addEventListener('error', () => {
    videoEl.classList.add('paused');
    fallbackEl.hidden = false;
  });

  videoEl.addEventListener('loadeddata', () => {
    fallbackEl.hidden = true;
    if (!launcherState.animationEnabled) {
      videoEl.pause();
    }
  });
});
