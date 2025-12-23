const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { app } = require('electron');

function asCancellationError(message = 'Update cancelled by user.') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.cancelled = true;
  return error;
}

function ensureNotCancelled(signal) {
  if (signal?.aborted) {
    throw asCancellationError();
  }
}

function resolveJava8ZipPath() {
  const envOverride = (process.env.JAVA8_ZIP_PATH || '').trim();
  if (envOverride) {
    return envOverride;
  }

  const candidateRoots = [app.getAppPath(), path.dirname(app.getAppPath()), process.resourcesPath];
  for (const root of candidateRoots) {
    const candidate = path.join(root, 'build-deps', 'jre8-win-x64.zip');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function resolveExtractedRuntimeDir(extractRoot) {
  const entries = await fs.promises.readdir(extractRoot);
  if (entries.length !== 1) {
    return extractRoot;
  }

  const candidate = path.join(extractRoot, entries[0]);
  const stats = await fs.promises.stat(candidate).catch(() => null);
  if (stats?.isDirectory()) {
    return candidate;
  }

  return extractRoot;
}

async function copyDirectoryContents(sourceDir, targetDir) {
  await fs.promises.mkdir(targetDir, { recursive: true });
  const entries = await fs.promises.readdir(sourceDir);
  for (const entry of entries) {
    const from = path.join(sourceDir, entry);
    const to = path.join(targetDir, entry);
    await fs.promises.cp(from, to, { recursive: true });
  }
}

async function reinstallBundledJava8({ onStatus = () => {}, onProgress = () => {} } = {}, abortSignal) {
  const zipPath = resolveJava8ZipPath();
  if (!zipPath) {
    throw new Error('Java 8 runtime package not found. Please reinstall the launcher.');
  }

  const targetDir = path.join(process.resourcesPath, 'jre8');
  let tempDir = null;

  try {
    ensureNotCancelled(abortSignal);
    onStatus({ message: 'Reinstalling bundled Java 8 runtime…' });
    onProgress({ state: 'downloading', progress: 10 });

    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hellas-java8-'));
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(tempDir, true);

    ensureNotCancelled(abortSignal);
    onProgress({ state: 'extracting', progress: 60 });

    const extractedRoot = await resolveExtractedRuntimeDir(tempDir);
    await fs.promises.rm(targetDir, { recursive: true, force: true });
    await copyDirectoryContents(extractedRoot, targetDir);

    ensureNotCancelled(abortSignal);
    onProgress({ state: 'finalizing', progress: 95 });
  } finally {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { targetDir };
}

module.exports = {
  reinstallBundledJava8
};
