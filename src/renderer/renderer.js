const videoEl = document.getElementById('bg-video');
const fallbackEl = document.getElementById('bg-fallback');
const logoButton = document.getElementById('logo-button');
const menuButton = document.getElementById('menu-button');
const accountButton = document.getElementById('account-button');
const dropdown = document.getElementById('dropdown');
const termsCheckbox = document.getElementById('terms-checkbox');
const startButton = document.getElementById('start-button');
const updateButton = document.getElementById('update-button');
const installStateLabel = document.getElementById('install-state');
const versionLabel = document.getElementById('version-label');
const updateProgress = document.getElementById('update-progress');
const updateProgressBar = document.getElementById('update-progress-bar');
const updateProgressText = document.getElementById('update-progress-text');

let launcherState = {
  termsAccepted: false,
  animationEnabled: true,
  installation: {
    isInstalled: false,
    installDir: '',
    installedVersion: '',
    lastKnownVersion: ''
  },
  update: {
    hasUpdateSource: false,
    preferredVersion: null
  }
};

function setDropdown(open) {
  dropdown.classList.toggle('open', open);
  const expanded = open ? 'true' : 'false';
  menuButton.setAttribute('aria-expanded', expanded);
  accountButton.setAttribute('aria-expanded', expanded);
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

async function refreshState() {
  const state = await window.hellas.getState();
  launcherState = state;
  termsCheckbox.checked = state.termsAccepted;
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
  }
}

document.addEventListener('click', closeDropdownOnClickOutside);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    setDropdown(false);
  }
});

menuButton.addEventListener('click', () => {
  setDropdown(!dropdown.classList.contains('open'));
});

accountButton.addEventListener('click', () => {
  setDropdown(!dropdown.classList.contains('open'));
});

logoButton.addEventListener('click', () => {
  window.hellas.openExternal(launcherState.websiteUrl || 'https://hellasregion.com');
});

termsCheckbox.addEventListener('change', async (event) => {
  const checked = event.target.checked;
  launcherState.termsAccepted = await window.hellas.setTermsAccepted(checked);
  updateStartButtonState();
});

startButton.addEventListener('click', async () => {
  if (!launcherState.termsAccepted) {
    return;
  }

  if (!launcherState.installation.isInstalled) {
    startButton.disabled = true;
    startButton.querySelector('.label').textContent = 'INSTALLING…';
    const installation = await window.hellas.performInstall();
    launcherState.installation = installation;
    startButton.querySelector('.label').textContent = 'PLAY';
    startButton.disabled = false;
    updateInstallLabels();
  } else {
    startButton.querySelector('.label').textContent = 'PLAY';
    // Placeholder for future Minecraft launch integration.
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
        await window.hellas.openExternal(launcherState.dynmapUrl || 'https://map.hellasregion.com');
        break;
      case 'toggle-animation':
        launcherState.animationEnabled = !launcherState.animationEnabled;
        await window.hellas.setAnimationEnabled(launcherState.animationEnabled);
        applyAnimationState();
        break;
      case 'logout':
        await window.hellas.logout();
        break;
      default:
        break;
    }
  });
});

window.hellas.onUpdateProgress(handleProgress);

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
