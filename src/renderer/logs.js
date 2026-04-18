const logContent = document.getElementById('log-content');
const logPath = document.getElementById('log-path');
const refreshButton = document.getElementById('refresh-log');
const closeButton = document.getElementById('close-log');

async function refreshLog() {
  try {
    const content = await window.hellas.getLauncherLog();
    logContent.textContent = content || 'No log entries yet.';
    logContent.scrollTop = logContent.scrollHeight;
  } catch (error) {
    logContent.textContent = 'Unable to load log content.';
    console.error('Failed to refresh launcher log', error);
  }
}

async function showLogInfo() {
  try {
    const info = await window.hellas.getLogInfo();
    if (info?.launcherLogPath) {
      logPath.textContent = info.launcherLogPath;
    }
  } catch (error) {
    console.error('Failed to read log info', error);
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  await showLogInfo();
  await refreshLog();
  refreshButton?.addEventListener('click', refreshLog);
  closeButton?.addEventListener('click', () => window.close());
  setInterval(refreshLog, 2000);
});
