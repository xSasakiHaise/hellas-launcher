const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const fetch = require('node-fetch');
const { app } = require('electron');

const JAVA8_DOWNLOAD_URL =
  'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u472-b08/OpenJDK8U-jre_x64_windows_hotspot_8u472b08.zip';

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

async function downloadJava8Zip({ onProgress = () => {} } = {}, abortSignal) {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hellas-java8-download-'));
  const zipPath = path.join(tempRoot, 'jre8-win-x64.zip');

  const response = await fetch(JAVA8_DOWNLOAD_URL, { signal: abortSignal });
  if (!response.ok) {
    throw new Error(`Failed to download Java 8 runtime (HTTP ${response.status}).`);
  }

  const total = Number(response.headers.get('content-length')) || 0;
  let downloaded = 0;

  await new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(zipPath);
    response.body.on('error', reject);
    fileStream.on('error', reject);
    fileStream.on('finish', resolve);
    response.body.on('data', (chunk) => {
      downloaded += chunk.length;
      if (total) {
        const progress = 10 + Math.round((downloaded / total) * 40);
        onProgress({ state: 'downloading', progress: Math.min(progress, 50) });
      }
      if (abortSignal?.aborted) {
        response.body.destroy(asCancellationError());
      }
    });
    response.body.pipe(fileStream);
  });

  return { tempRoot, zipPath };
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
  const bundledZipPath = resolveJava8ZipPath();

  const targetDir = path.join(process.resourcesPath, 'jre8');
  let tempDir = null;
  let zipPath = bundledZipPath;
  let downloadTempRoot = null;

  try {
    ensureNotCancelled(abortSignal);
    onStatus({ message: 'Reinstalling bundled Java 8 runtime…' });

    if (!zipPath) {
      onStatus({ message: 'Downloading Java 8 runtime…' });
      onProgress({ state: 'downloading', progress: 10 });
      const download = await downloadJava8Zip({ onProgress }, abortSignal);
      downloadTempRoot = download.tempRoot;
      zipPath = download.zipPath;
    }

    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hellas-java8-'));
    const extractDir = path.join(tempDir, 'extracted');
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);

    ensureNotCancelled(abortSignal);
    onProgress({ state: 'extracting', progress: 60 });

    const extractedRoot = await resolveExtractedRuntimeDir(extractDir);
    await fs.promises.rm(targetDir, { recursive: true, force: true });
    await copyDirectoryContents(extractedRoot, targetDir);

    ensureNotCancelled(abortSignal);
    onProgress({ state: 'finalizing', progress: 95 });
  } finally {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    if (downloadTempRoot) {
      await fs.promises.rm(downloadTempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { targetDir };
}

module.exports = {
  reinstallBundledJava8
};
