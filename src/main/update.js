const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');

const DEFAULT_PACK_URL = 'https://hellasregion.com/download/latest';
const PROGRESS_PHASE_DOWNLOAD = 80; // percent allocated to download progress

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

async function downloadAndExtractUpdate(source, targetDir, progressCallback = () => {}) {
  let resolved = { ...source };

  if (source.type === 'feed') {
    progressCallback({ state: 'fetching-feed' });
    resolved = await fetchFeedManifest(source.feedUrl);
  }

  if (!resolved.url) {
    throw new Error('No update URL could be resolved.');
  }

  const tempZipPath = path.join(os.tmpdir(), `hellas-update-${Date.now()}.zip`);
  const response = await fetch(resolved.url);
  if (!response.ok) {
    throw new Error(`Failed to download update archive (${response.status})`);
  }

  const totalBytes = Number(response.headers.get('content-length') || 0);
  const hasher = resolved.sha256 ? crypto.createHash('sha256') : null;
  let downloaded = 0;

  try {
    await new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(tempZipPath);

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

    await fs.promises.mkdir(targetDir, { recursive: true });
    progressCallback({ state: 'extracting', progress: PROGRESS_PHASE_DOWNLOAD });

    const zip = new AdmZip(tempZipPath);
    zip.getEntries().forEach((entry) => {
      const entryPath = path.join(targetDir, entry.entryName);
      if (entry.isDirectory) {
        fs.mkdirSync(entryPath, { recursive: true });
      }
    });
    zip.extractAllTo(targetDir, true);

    progressCallback({ state: 'finalizing', progress: 95 });
  } finally {
    await fs.promises.unlink(tempZipPath).catch(() => {});
  }

  return { version: resolved.version || null };
}

module.exports = {
  resolveUpdateSource,
  downloadAndExtractUpdate,
  fetchFeedManifest
};
