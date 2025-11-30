const fs = require('fs');
const path = require('path');

let logDirectory = null;
let initialized = false;

function ensureLogDirectory() {
  if (!logDirectory) {
    logDirectory = process.cwd();
  }

  try {
    fs.mkdirSync(logDirectory, { recursive: true });
  } catch (error) {
    console.warn('Unable to create log directory', error);
  }
}

function initLogger(app) {
  if (initialized) return;
  const defaultDir = path.dirname(app.getPath('exe'));
  logDirectory = defaultDir || app.getPath('userData');
  ensureLogDirectory();
  initialized = true;
}

function getDebugLogPath() {
  ensureLogDirectory();
  return path.join(logDirectory, 'debug.txt');
}

function getLauncherLogPath() {
  ensureLogDirectory();
  return path.join(logDirectory, 'launcher.log');
}

function writeLine(filePath, line) {
  try {
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  } catch (error) {
    console.warn(`Failed to write to log ${filePath}`, error);
  }
}

function logMessage(level, message, metadata = {}) {
  if (!initialized) return;
  const timestamp = new Date().toISOString();
  const meta = Object.keys(metadata || {}).length ? ` ${JSON.stringify(metadata)}` : '';
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${meta}`;
  writeLine(getDebugLogPath(), line);
  writeLine(getLauncherLogPath(), line);
}

function readLauncherLog() {
  if (!initialized) return '';
  try {
    return fs.readFileSync(getLauncherLogPath(), 'utf8');
  } catch (error) {
    return '';
  }
}

module.exports = {
  initLogger,
  logMessage,
  getDebugLogPath,
  getLauncherLogPath,
  readLauncherLog
};
