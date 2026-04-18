const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const fetch = require('node-fetch');
const { app } = require('electron');

const JAVA_RUNTIMES = {
  8: {
    label: 'Java 8',
    targetDirName: 'jre8',
    zipEnv: 'JAVA8_ZIP_PATH',
    zipFileName: 'jre8-win-x64.zip',
    downloadUrl:
      'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u472-b08/OpenJDK8U-jre_x64_windows_hotspot_8u472b08.zip'
  },
  21: {
    label: 'Java 21',
    targetDirName: 'jre21',
    zipEnv: 'JAVA21_ZIP_PATH',
    zipFileName: 'jre21-win-x64.zip',
    downloadUrl: 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse'
  }
};

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

function resolveJavaRuntimeConfig(major) {
  const runtime = JAVA_RUNTIMES[Number(major)];
  if (!runtime) {
    throw new Error(`Java ${major} reinstall is not configured.`);
  }

  return runtime;
}

function resolveJavaZipPath(major) {
  const runtime = resolveJavaRuntimeConfig(major);
  const envOverride = (process.env[runtime.zipEnv] || '').trim();
  if (envOverride) {
    return envOverride;
  }

  const candidateRoots = [app.getAppPath(), path.dirname(app.getAppPath()), process.resourcesPath];
  for (const root of candidateRoots) {
    const candidate = path.join(root, 'build-deps', runtime.zipFileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function downloadJavaZip(major, { onProgress = () => {} } = {}, abortSignal) {
  const runtime = resolveJavaRuntimeConfig(major);
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), `hellas-java${major}-download-`));
  const zipPath = path.join(tempRoot, runtime.zipFileName);

  const response = await fetch(runtime.downloadUrl, { signal: abortSignal });
  if (!response.ok) {
    throw new Error(`Failed to download ${runtime.label} runtime (HTTP ${response.status}).`);
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

async function reinstallBundledJava({ major = 8, onStatus = () => {}, onProgress = () => {} } = {}, abortSignal) {
  const runtime = resolveJavaRuntimeConfig(major);
  const bundledZipPath = resolveJavaZipPath(major);

  const targetDir = path.join(process.resourcesPath, runtime.targetDirName);
  let tempDir = null;
  let zipPath = bundledZipPath;
  let downloadTempRoot = null;

  try {
    ensureNotCancelled(abortSignal);
    onStatus({ message: `Reinstalling bundled ${runtime.label} runtime…` });

    if (!zipPath) {
      onStatus({ message: `Downloading ${runtime.label} runtime…` });
      onProgress({ state: 'downloading', progress: 10 });
      const download = await downloadJavaZip(major, { onProgress }, abortSignal);
      downloadTempRoot = download.tempRoot;
      zipPath = download.zipPath;
    }

    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `hellas-java${major}-`));
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

  return { targetDir, major: Number(major) };
}

async function reinstallBundledJava8(options = {}, abortSignal) {
  return reinstallBundledJava({ ...options, major: 8 }, abortSignal);
}

module.exports = {
  reinstallBundledJava,
  reinstallBundledJava8
};
