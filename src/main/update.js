const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');

const DEFAULT_PACK_URL = 'https://hellasregion.com/download/launcher/latest/compact';
const PROGRESS_PHASE_DOWNLOAD = 80; // percent allocated to download progress
const MODPACK_DIR_NAME = 'modpack';
const MODS_DIR_NAME = 'mods';
const RESOURCEPACKS_DIR_NAME = 'resourcepacks';
const SERVER_FILES = ['servers.dat', 'servers.dat_old'];

function resolveUpdateSource() {
  const feedUrl = (process.env.PACK_FEED_URL || '').trim();
  const directUrl = (process.env.PACK_ZIP_URL || '').trim();

  if (feedUrl) {
    return {
      type: 'feed',
      feedUrl,
      version: null,
      sha256: null
    };
  }

  const resolvedDirectUrl = directUrl || DEFAULT_PACK_URL;

  if (resolvedDirectUrl) {
    return {
      type: 'direct',
      url: resolvedDirectUrl,
      version: process.env.PACK_VERSION || null,
      sha256: process.env.PACK_EXPECTED_SHA256 || null
    };
  }

  return null;
}

async function fetchFeedManifest(feedUrl) {
  const response = await fetch(feedUrl, {
    headers: {
      'Cache-Control': 'no-cache'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch update feed (${response.status})`);
  }

  const manifest = await response.json();
  if (!manifest.url) {
    throw new Error('Feed JSON is missing the "url" field.');
  }

  return {
    url: manifest.url,
    version: manifest.version || null,
    sha256: manifest.sha256 || manifest.hash || null
  };
}

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

async function ensureModpackStructure(targetDir) {
  const modpackDir = path.join(targetDir, MODPACK_DIR_NAME);
  const modsDir = path.join(modpackDir, MODS_DIR_NAME);
  const resourcepacksDir = path.join(modpackDir, RESOURCEPACKS_DIR_NAME);

  await fs.promises.mkdir(modpackDir, { recursive: true });
  await fs.promises.mkdir(modsDir, { recursive: true });
  await fs.promises.mkdir(resourcepacksDir, { recursive: true });

  return { modpackDir, modsDir, resourcepacksDir };
}

async function moveDirectoryContents(sourceDir, destinationDir) {
  const exists = await fs.promises
    .stat(sourceDir)
    .then((stats) => stats.isDirectory())
    .catch(() => false);

  if (!exists) return false;

  await fs.promises.rm(destinationDir, { recursive: true, force: true });
  await fs.promises.mkdir(destinationDir, { recursive: true });

  const entries = await fs.promises.readdir(sourceDir);
  for (const entry of entries) {
    const from = path.join(sourceDir, entry);
    const to = path.join(destinationDir, entry);
    await fs.promises.rename(from, to).catch(async (error) => {
      if (error.code === 'EXDEV') {
        await fs.promises.cp(from, to, { recursive: true });
        await fs.promises.rm(from, { recursive: true, force: true });
      } else {
        throw error;
      }
    });
  }

  await fs.promises.rm(sourceDir, { recursive: true, force: true });
  return true;
}

async function moveFileIfExists(sourcePath, destinationPath) {
  const exists = await fs.promises
    .access(sourcePath)
    .then(() => true)
    .catch(() => false);

  if (!exists) return false;

  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });

  try {
    await fs.promises.rename(sourcePath, destinationPath);
  } catch (error) {
    if (error.code === 'EXDEV') {
      await fs.promises.copyFile(sourcePath, destinationPath);
      await fs.promises.unlink(sourcePath);
    } else {
      throw error;
    }
  }

  return true;
}

async function downloadAndExtractUpdate(source, targetDir, progressCallback = () => {}, abortSignal) {
  let resolved = { ...source };
  let tempZipPath = null;

  try {
    ensureNotCancelled(abortSignal);
    if (source.type === 'feed') {
      progressCallback({ state: 'fetching-feed' });
      resolved = await fetchFeedManifest(source.feedUrl);
    }

    if (!resolved.url) {
      throw new Error('No update URL could be resolved.');
    }

    tempZipPath = path.join(os.tmpdir(), `hellas-update-${Date.now()}.zip`);
    let response = await fetch(resolved.url, {
      headers: { 'Cache-Control': 'no-cache' },
      signal: abortSignal
    });

    if (!response.ok) {
      throw new Error(`Failed to download update archive (${response.status})`);
    }

    const contentType = response.headers.get('content-type') || '';
    const contentLength = Number(response.headers.get('content-length') || 0);
    const shouldAttemptDescriptor =
      contentType.includes('application/json') ||
      resolved.url.toLowerCase().endsWith('.json') ||
      (contentLength > 0 && contentLength <= 512 * 1024);

    if (shouldAttemptDescriptor) {
      try {
        const manifest = await response.clone().json();
        const pack = manifest.modpack || manifest;
        if (!pack?.url) {
          throw new Error('Update descriptor missing the modpack URL.');
        }
        resolved.url = pack.url;
        resolved.version = pack.version || resolved.version || null;
        resolved.sha256 = pack.sha256 || pack.hash || resolved.sha256 || null;

        if (response.body?.cancel) {
          response.body.cancel();
        }

        response = await fetch(resolved.url, { signal: abortSignal });
        if (!response.ok) {
          throw new Error(`Failed to download update archive (${response.status})`);
        }
      } catch (descriptorError) {
        if (shouldAttemptDescriptor && contentType.includes('application/json')) {
          throw descriptorError;
        }
      }
    }

    const totalBytes = Number(response.headers.get('content-length') || 0);
    const hasher = resolved.sha256 ? crypto.createHash('sha256') : null;
    let downloaded = 0;

    await new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(tempZipPath);

      const handleAbort = () => {
        const abortError = asCancellationError();
        response.body.destroy(abortError);
        fileStream.destroy(abortError);
        reject(abortError);
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          handleAbort();
          return;
        }
        abortSignal.addEventListener('abort', handleAbort, { once: true });
      }

      response.body.on('data', (chunk) => {
        downloaded += chunk.length;
        if (hasher) {
          hasher.update(chunk);
        }
        if (totalBytes) {
          const progress = Math.min(99, Math.round((downloaded / totalBytes) * PROGRESS_PHASE_DOWNLOAD));
          progressCallback({ state: 'downloading', progress });
        }
      });

      response.body.on('error', (err) => {
        fileStream.destroy();
        reject(err);
      });

      fileStream.on('error', (err) => {
        response.body.destroy(err);
        reject(err);
      });

      fileStream.on('finish', () => {
        if (hasher) {
          const digest = hasher.digest('hex');
          if (digest.toLowerCase() !== resolved.sha256.toLowerCase()) {
            reject(new Error('Downloaded archive checksum does not match expected SHA-256.'));
            return;
          }
        }
        progressCallback({ state: 'downloading', progress: PROGRESS_PHASE_DOWNLOAD });
        resolve();
      });

      response.body.pipe(fileStream);
    });

    ensureNotCancelled(abortSignal);
    await fs.promises.mkdir(targetDir, { recursive: true });
    const { modpackDir, modsDir, resourcepacksDir } = await ensureModpackStructure(targetDir);
    // Preserve other directories by extracting over the install dir, but ensure mods
    // are fully replaced to avoid stale content lingering between updates.
    const legacyModsDir = path.join(targetDir, MODS_DIR_NAME);
    const legacyResourcepacksDir = path.join(targetDir, RESOURCEPACKS_DIR_NAME);
    await fs.promises.rm(modsDir, { recursive: true, force: true });
    await fs.promises.rm(resourcepacksDir, { recursive: true, force: true });
    await fs.promises.rm(legacyModsDir, { recursive: true, force: true });
    await fs.promises.rm(legacyResourcepacksDir, { recursive: true, force: true });

    ensureNotCancelled(abortSignal);
    progressCallback({ state: 'extracting', progress: PROGRESS_PHASE_DOWNLOAD });

    const zip = new AdmZip(tempZipPath);
    zip.getEntries().forEach((entry) => {
      const entryPath = path.join(targetDir, entry.entryName);
      if (entry.isDirectory) {
        fs.mkdirSync(entryPath, { recursive: true });
      }
    });
    ensureNotCancelled(abortSignal);
    zip.extractAllTo(targetDir, true);

    await ensureModpackStructure(targetDir);
    await moveDirectoryContents(legacyModsDir, modsDir);
    await moveDirectoryContents(legacyResourcepacksDir, resourcepacksDir);
    for (const serverFile of SERVER_FILES) {
      await moveFileIfExists(path.join(targetDir, serverFile), path.join(modpackDir, serverFile));
    }

    progressCallback({ state: 'finalizing', progress: 95 });
  } catch (error) {
    if (error.cancelled || error.name === 'AbortError') {
      progressCallback({ state: 'cancelled', message: 'Update cancelled.' });
      throw error;
    }
    progressCallback({ state: 'error', message: error.message || 'Update failed' });
    throw error;
  } finally {
    if (tempZipPath) {
      await fs.promises.unlink(tempZipPath).catch(() => {});
    }
  }

  return { version: resolved.version || null };
}

async function freshReinstall(targetDir, progressCallback = () => {}, abortSignal) {
  const updateSource = resolveUpdateSource();
  if (!updateSource || !updateSource.url) {
    throw new Error('Update source is not configured.');
  }

  await fs.promises.rm(targetDir, { recursive: true, force: true });

  return downloadAndExtractUpdate(updateSource, targetDir, progressCallback, abortSignal);
}

module.exports = {
  resolveUpdateSource,
  downloadAndExtractUpdate,
  fetchFeedManifest,
  freshReinstall
};
