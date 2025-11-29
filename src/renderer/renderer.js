const videoEl = document.getElementById('bg-video');
const fallbackEl = document.getElementById('bg-fallback');
const logoButton = document.getElementById('logo-button');
const menuButton = document.getElementById('menu-button');
const accountButton = document.getElementById('account-button');
const accountUsername = document.getElementById('account-username');
const closeButton = document.getElementById('close-button');
const maximizeButton = document.getElementById('maximize-button');
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
const loginButton = document.getElementById('login-button');
const accountStatus = document.getElementById('account-status');
const accountPanel = document.getElementById('account-panel');
const deviceLoginPanel = document.getElementById('device-login');
const userCodeEl = document.getElementById('user-code');
const deviceMessage = document.getElementById('device-message');
const openLoginButton = document.getElementById('open-login');
const copyCodeButton = document.getElementById('copy-code');

let launcherState = {
  termsAccepted: false,
  animationEnabled: true,
  installation: {
    isInstalled: false,
    installDir: '',
    installedVersion: '',
    lastKnownVersion: ''
  },
  account: {
    username: '',
    loggedIn: false
  },
  update: {
    hasUpdateSource: false,
    preferredVersion: null
  }
};

let activeDeviceLogin = null;
let pollTimer = null;
let accountPanelOpen = false;

function setAccountStatus(message, isError = false) {
  accountStatus.textContent = message || '';
  accountStatus.classList.toggle('error', Boolean(isError));
}

function setDropdown(open) {
  dropdown.classList.toggle('open', open);
  const expanded = open ? 'true' : 'false';
  menuButton.setAttribute('aria-expanded', expanded);
}

function updateStartButtonState() {
  const { termsAccepted, installation } = launcherState;
  const buttonLabel = installation.isInstalled ? 'PLAY' : 'INSTALL';
  startButton.querySelector('.label').textContent = buttonLabel;
  startButton.disabled = !termsAccepted;
  startButton.classList.toggle('needs-install', !installation.isInstalled);
}

function updateInstallLabels() {
  const { installation } = launcherState;
  installStateLabel.textContent = installation.isInstalled
    ? `Ready in ${installation.installDir}`
    : 'Install required';

  const versionText = launcherState.update.preferredVersion || installation.installedVersion;
  if (versionText) {
    const suffix = launcherState.update.available ? ' • Update available' : '';
    versionLabel.textContent = `Version ${versionText}${suffix}`;
  } else {
    versionLabel.textContent = '';
  }
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

function setUpdating(isUpdating) {
  startButton.disabled = isUpdating || !launcherState.termsAccepted;
  updateButton.disabled = isUpdating;
  updateProgress.hidden = !isUpdating;
  const updateLabel = updateButton.querySelector('.label');
  if (isUpdating) {
    if (updateLabel) updateLabel.textContent = 'Updating…';
  } else if (updateLabel) {
    updateLabel.textContent = launcherState.update.hasUpdateSource ? 'Update' : 'No Update Source';
  }
  if (!isUpdating) {
    updateProgressBar.style.width = '0%';
    updateProgressText.textContent = '';
  }
}

function handleProgress(payload) {
  if (!payload) {
    return;
  }
  if (payload.state === 'complete') {
    updateProgressBar.style.width = '100%';
    updateProgressText.textContent = payload.version ? `Updated to ${payload.version}` : 'Update complete';
    setTimeout(() => setUpdating(false), 1500);
    return;
  }

  if (typeof payload.progress === 'number') {
    updateProgressBar.style.width = `${Math.max(0, Math.min(100, payload.progress))}%`;
    updateProgressText.textContent = `${payload.progress}%`;
  }
}

function hideDeviceLogin() {
  activeDeviceLogin = null;
  deviceLoginPanel.hidden = true;
  deviceMessage.textContent = '';
  userCodeEl.textContent = '';
}

function setAccountPanel(open) {
  if (!accountPanel) return;
  accountPanel.hidden = !open;
  accountPanelOpen = open;
  if (accountButton) {
    accountButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    accountButton.classList.toggle('active', open);
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
  const updateLabel = updateButton.querySelector('.label');
  if (!state.update.hasUpdateSource) {
    updateButton.disabled = true;
    if (updateLabel) {
      updateLabel.textContent = 'No Update Source';
    }
  } else {
    updateButton.disabled = false;
    if (updateLabel) {
      updateLabel.textContent = 'Update';
    }
  }
}

function closeDropdownOnClickOutside(event) {
  if (!dropdown.contains(event.target) && !menuButton.contains(event.target) && !accountButton.contains(event.target)) {
    setDropdown(false);
    if (accountPanelOpen && accountPanel && !accountPanel.contains(event.target)) {
      setAccountPanel(false);
    }
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

logoButton.addEventListener('click', () => {
  window.hellas.openExternal(launcherState.websiteUrl || 'https://hellasregion.com');
});

closeButton.addEventListener('click', () => {
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

  if (!launcherState.installation.isInstalled) {
    startButton.disabled = true;
    startButton.querySelector('.label').textContent = 'INSTALLING…';
    setUpdating(true);
    updateProgressText.textContent = 'Preparing…';
    try {
      const result = await window.hellas.performInstall();
      if (result && result.installation) {
        launcherState.installation = result.installation;
      }
      if (result && result.version) {
        launcherState.update.preferredVersion = result.version;
        await window.hellas.updateKnownVersion(result.version);
        launcherState.update.available = false;
      }
      updateInstallLabels();
      updateStartButtonState();
    } catch (error) {
      console.error(error);
      setAccountStatus(error.message || 'Install failed.', true);
      setUpdating(false);
    } finally {
      startButton.querySelector('.label').textContent = 'PLAY';
      startButton.disabled = false;
    }
  } else {
    if (!launcherState.account.loggedIn) {
      setAccountStatus('Please log in before launching.', true);
      setAccountPanel(true);
      return;
    }

    startButton.querySelector('.label').textContent = 'LAUNCHING…';
    try {
      await window.hellas.launchGame();
      setAccountStatus('Modpack launch triggered.');
    } catch (error) {
      console.error(error);
      setAccountStatus(error.message || 'Failed to launch the modpack.', true);
    } finally {
      startButton.querySelector('.label').textContent = 'PLAY';
      updateStartButtonState();
    }
  }
});

updateButton.addEventListener('click', async () => {
  if (updateButton.disabled) {
    return;
  }

  setUpdating(true);
  updateProgressText.textContent = 'Preparing…';
  try {
    const result = await window.hellas.triggerUpdate();
    if (result && result.installation) {
      launcherState.installation = result.installation;
      if (result.version) {
        launcherState.update.preferredVersion = result.version;
        await window.hellas.updateKnownVersion(result.version);
      }
      launcherState.update.available = false;
      updateInstallLabels();
      updateStartButtonState();
    }
  } catch (error) {
    console.error(error);
    updateProgressText.textContent = 'Update failed';
    setTimeout(() => setUpdating(false), 2500);
  }
});

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
      case 'reinstall':
        setUpdating(true);
        updateProgressText.textContent = 'Reinstalling…';
        try {
          const result = await window.hellas.freshReinstall();
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
        } catch (error) {
          console.error(error);
          updateProgressText.textContent = 'Reinstall failed';
          setTimeout(() => setUpdating(false), 2500);
        }
        break;
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
