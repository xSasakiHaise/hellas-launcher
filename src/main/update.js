const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');
const { LEGACY_PROFILE_ID, getProfile, getProfileEnv, getProfileLoader } = require('./profiles');

const DEFAULT_PACK_URL = 'https://hellasregion.com/download/launcher/latest/compact';
const PROGRESS_PHASE_DOWNLOAD = 80; // percent allocated to download progress
const MODPACK_DIR_NAME = 'modpack';
const MODS_DIR_NAME = 'mods';
const RESOURCEPACKS_DIR_NAME = 'resourcepacks';
const MANAGED_MODS_FILENAME = '.hellas-managed-mods.json';
const USER_MODS_FILENAME = '.hellas-user-mods.json';
const SERVER_FILES = ['servers.dat', 'servers.dat_old'];
const LOG4J_CONFIG_FILENAME = 'log4j2_112-116.xml';
const LEGACY_ROOT_DIRS = [
  'config',
  'mods',
  'assets',
  'defaultconfigs',
  'libraries',
  'natives',
  'logs',
  '.mixin.out'
];
const LEGACY_ROOT_FILES = [LOG4J_CONFIG_FILENAME];

function hasSource(source) {
  return Boolean(source?.url || source?.feedUrl || source?.manifestUrl);
}

function resolveUpdateSource(profileInput = LEGACY_PROFILE_ID) {
  const profile = getProfile(profileInput?.id || profileInput);
  const manifestUrl = getProfileEnv(profile, 'PACK_MANIFEST_URL') || profile.update?.manifestUrl || '';
  const feedUrl = getProfileEnv(profile, 'PACK_FEED_URL') || profile.update?.feedUrl || '';
  const directUrl = getProfileEnv(profile, 'PACK_ZIP_URL') || profile.update?.url || '';

  if (manifestUrl) {
    return {
      type: 'manifest',
      manifestUrl,
      sourceUrl: manifestUrl,
      profileId: profile.id,
      version: null,
      sha256: null
    };
  }

  if (feedUrl) {
    return {
      type: 'feed',
      feedUrl,
      sourceUrl: feedUrl,
      profileId: profile.id,
      version: null,
      sha256: null
    };
  }

  const resolvedDirectUrl = directUrl || (profile.id === LEGACY_PROFILE_ID ? DEFAULT_PACK_URL : '');

  if (resolvedDirectUrl) {
    return {
      type: 'direct',
      url: resolvedDirectUrl,
      sourceUrl: resolvedDirectUrl,
      profileId: profile.id,
      version: getProfileEnv(profile, 'PACK_VERSION') || null,
      sha256: getProfileEnv(profile, 'PACK_EXPECTED_SHA256') || null
    };
  }

  return null;
}

function getProfileManifest(manifest, profile) {
  if (!manifest || typeof manifest !== 'object') {
    return null;
  }

  const profiles = manifest.profiles || manifest.minecraftProfiles || null;
  if (!profiles || typeof profiles !== 'object') {
    return null;
  }

  return (
    profiles[profile.id] ||
    profiles[profile.minecraftVersion] ||
    profiles[profile.manifestKey] ||
    Object.values(profiles).find((entry) => entry?.id === profile.id || entry?.minecraftVersion === profile.minecraftVersion) ||
    null
  );
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function downloadIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if (/^\d+$/.test(segments[index])) {
        return segments[index];
      }
    }
  } catch {
    // Ignore invalid URL parsing here; validation happens before download.
  }

  return '';
}

function curseForgeDetailsFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)curseforge\.com$/i.test(parsed.hostname)) {
      return null;
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    const fileMarkerIndex = segments.findIndex((segment) => ['download', 'files'].includes(segment.toLowerCase()));
    const fileId = fileMarkerIndex >= 0 ? segments.slice(fileMarkerIndex + 1).find((segment) => /^\d+$/.test(segment)) : '';
    const slug = fileMarkerIndex >= 1 ? segments[fileMarkerIndex - 1] : '';

    if (!fileId) {
      return null;
    }

    return { slug, fileId };
  } catch {
    return null;
  }
}

async function resolveCurseForgeDownloadUrl(item, options, abortSignal, progressCallback, progressBase) {
  const details = curseForgeDetailsFromUrl(item.url);
  if (!details) {
    return null;
  }

  const resolver = options?.resolveCurseForgeDownloadUrl;
  if (typeof resolver !== 'function') {
    throw new Error(`CurseForge blocked ${item.fileName} (403) and browser download resolving is unavailable.`);
  }

  progressCallback({
    state: 'downloading',
    progress: Math.min(99, progressBase),
    message: `Resolving CurseForge download for ${item.fileName}`
  });
  const downloadUrl = normalizeString(await resolver(item, details, abortSignal));
  if (!downloadUrl) {
    throw new Error(`CurseForge did not expose a browser download URL for ${item.fileName}.`);
  }

  return downloadUrl;
}

function fileNameFromUrl(url, fallbackName) {
  try {
    const parsed = new URL(url);
    const baseName = path.basename(decodeURIComponent(parsed.pathname));
    if (baseName && baseName !== '/' && baseName !== '.' && !/^\d+$/.test(baseName)) {
      return baseName;
    }
  } catch {
    // Ignore invalid URL parsing here; validation happens before download.
  }

  return fallbackName;
}

function fallbackFileName(id, url, index, fallbackDirectory) {
  const downloadId = downloadIdFromUrl(url);
  const baseName = normalizeString(id) || (fallbackDirectory === MODS_DIR_NAME ? `mod-${index + 1}` : `file-${index + 1}`);
  const suffix = downloadId ? `-${downloadId}` : '';
  const extension = fallbackDirectory === RESOURCEPACKS_DIR_NAME ? '.zip' : fallbackDirectory === MODS_DIR_NAME ? '.jar' : '';

  return `${baseName}${suffix}${extension}`;
}

function normalizeDownloadItem(item, index, fallbackDirectory) {
  if (typeof item === 'string') {
    const url = normalizeString(item);
    const id = `item-${index + 1}`;
    return {
      id,
      url,
      fileName: fileNameFromUrl(url, fallbackFileName(id, url, index, fallbackDirectory)),
      sha256: null,
      directory: fallbackDirectory
    };
  }

  const url = normalizeString(item?.url || item?.downloadUrl || item?.link);
  if (!url) {
    return null;
  }

  const rawName = normalizeString(item.fileName || item.filename || item.name);
  const name = /^\d+$/.test(rawName) ? '' : rawName;
  const id = normalizeString(item.id || item.slug || name) || `item-${index + 1}`;
  const fallbackName = fallbackFileName(id, url, index, fallbackDirectory);

  return {
    id,
    url,
    fileName: name || fileNameFromUrl(url, fallbackName),
    sha256: normalizeString(item.sha256 || item.hash) || null,
    directory: normalizeString(item.directory || item.targetDirectory) || fallbackDirectory,
    target: normalizeString(item.target || item.path) || null,
    slug: normalizeString(item.slug) || null,
    projectId: normalizeString(item.projectId || item.modId) || null,
    fileId: normalizeString(item.fileId) || null,
    required: item.required !== false
  };
}

function normalizeDownloadList(list, fallbackDirectory) {
  if (!Array.isArray(list)) {
    return [];
  }

  return list
    .map((item, index) => normalizeDownloadItem(item, index, fallbackDirectory))
    .filter(Boolean);
}

function normalizeAdditionalModLinks(links = []) {
  const rawLinks = Array.isArray(links) ? links : [];
  return rawLinks
    .map((entry, index) => {
      const url = normalizeString(typeof entry === 'string' ? entry : entry?.url);
      if (!url) return null;
      return normalizeDownloadItem(
        {
          id: `player-mod-${index + 1}`,
          url,
          fileName: fileNameFromUrl(url, `player-mod-${index + 1}.jar`)
        },
        index,
        MODS_DIR_NAME
      );
    })
    .filter(Boolean);
}

function normalizeLoaderDescriptor(selected, profile) {
  const profileLoader = getProfileLoader(profile);
  const explicitType = normalizeString(
    selected.loaderType ||
      selected.modLoader ||
      selected.loader?.type ||
      (typeof selected.loader === 'string' ? selected.loader : '')
  );
  const explicitVersion = normalizeString(
    selected.loaderVersion ||
      selected.loader?.version ||
      selected.neoforgeVersion ||
      selected.neoForgeVersion ||
      ''
  );
  const forgeAlias = normalizeString(selected.forgeVersion || selected.forge);
  const staleForgeAlias =
    profileLoader.type === 'neoforge' &&
    !explicitType &&
    !explicitVersion &&
    forgeAlias &&
    !/^neoforge[-_]/i.test(forgeAlias);
  const candidateVersion = staleForgeAlias ? profileLoader.version : explicitVersion || forgeAlias || profileLoader.id;
  const candidateType =
    explicitType ||
    (/^neoforge[-_]/i.test(candidateVersion) || selected.neoforgeVersion || selected.neoForgeVersion
      ? 'neoforge'
      : profileLoader.type);
  const loader = getProfileLoader({
    ...profile,
    loaderType: candidateType,
    loaderVersion: candidateVersion,
    neoforgeVersion: candidateType === 'neoforge' ? candidateVersion : '',
    forgeVersion: candidateVersion
  });

  return {
    loader,
    loaderType: loader.type,
    loaderVersion: loader.version,
    neoforgeVersion: loader.type === 'neoforge' ? loader.version : null,
    forgeVersion: loader.type === 'neoforge' ? loader.id : loader.version
  };
}

function normalizeManifestDescriptor(manifest, profile) {
  const selected = getProfileManifest(manifest, profile) || manifest.modpack || manifest;
  const archive = selected.archive || selected.configArchive || selected.modpack || null;
  const archiveUrl = normalizeString(selected.url || archive?.url);
  const archiveHash = normalizeString(selected.sha256 || selected.hash || archive?.sha256 || archive?.hash) || null;
  const loaderDescriptor = normalizeLoaderDescriptor(selected, profile);

  return {
    schemaVersion: manifest.schemaVersion || manifest.schema || null,
    profileId: profile.id,
    minecraftVersion: selected.minecraftVersion || profile.minecraftVersion,
    forgeVersion: loaderDescriptor.forgeVersion,
    loaderType: loaderDescriptor.loaderType,
    loaderVersion: loaderDescriptor.loaderVersion,
    neoforgeVersion: loaderDescriptor.neoforgeVersion,
    loader: {
      type: loaderDescriptor.loaderType,
      version: loaderDescriptor.loaderVersion
    },
    javaMajor: selected.javaMajor || selected.java?.major || profile.java.major,
    version: selected.version || manifest.version || null,
    url: archiveUrl || null,
    sha256: archiveHash,
    mods: normalizeDownloadList(selected.mods || selected.managedMods, MODS_DIR_NAME),
    resourcepacks: normalizeDownloadList(selected.resourcepacks || selected.resourcePacks, RESOURCEPACKS_DIR_NAME),
    files: normalizeDownloadList(selected.files || selected.extraFiles, '')
  };
}

async function fetchFeedManifest(feedUrl, profileInput = LEGACY_PROFILE_ID) {
  const profile = getProfile(profileInput?.id || profileInput);
  const response = await fetch(feedUrl, {
    headers: {
      'Cache-Control': 'no-cache'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch update feed (${response.status})`);
  }

  const manifest = await response.json();
  const descriptor = normalizeManifestDescriptor(manifest, profile);
  if (!descriptor.url && !descriptor.mods.length && !descriptor.files.length && !descriptor.resourcepacks.length) {
    throw new Error('Feed JSON is missing the "url" field.');
  }

  return descriptor;
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
  if (path.resolve(sourceDir) === path.resolve(destinationDir)) {
    return false;
  }

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

async function migrateRootContent(targetDir, modpackDir) {
  for (const dirName of LEGACY_ROOT_DIRS) {
    const sourceDir = path.join(targetDir, dirName);
    const destinationDir = path.join(modpackDir, dirName);
    await moveDirectoryContents(sourceDir, destinationDir);
  }

  for (const fileName of LEGACY_ROOT_FILES) {
    const sourceFile = path.join(targetDir, fileName);
    const destinationFile = path.join(modpackDir, fileName);
    await moveFileIfExists(sourceFile, destinationFile);
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function sha256File(filePath) {
  const hasher = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hasher.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hasher.digest('hex');
}

function validateHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid download URL: ${url}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported download URL protocol for ${url}`);
  }
}

function safeRelativePath(relativePath) {
  const normalized = path.normalize(relativePath || '').replace(/^([/\\])+/, '');
  if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error(`Unsafe target path in manifest: ${relativePath}`);
  }

  return normalized;
}

async function downloadFile(item, destinationPath, progressCallback, abortSignal, progressBase, progressSpan, options = {}) {
  ensureNotCancelled(abortSignal);
  validateHttpUrl(item.url);

  const existingMatches = item.sha256
    ? await fs.promises
        .access(destinationPath)
        .then(async () => (await sha256File(destinationPath)).toLowerCase() === item.sha256.toLowerCase())
        .catch(() => false)
    : false;

  if (existingMatches) {
    progressCallback({ state: 'downloading', progress: Math.min(99, progressBase + progressSpan) });
    return;
  }

  let response = await fetch(item.url, {
    headers: { 'Cache-Control': 'no-cache' },
    signal: abortSignal
  });

  if (!response.ok) {
    const curseForgeDownloadUrl =
      response.status === 403
        ? await resolveCurseForgeDownloadUrl(item, options, abortSignal, progressCallback, progressBase)
        : null;
    if (curseForgeDownloadUrl) {
      response = await fetch(curseForgeDownloadUrl, {
        headers: { 'Cache-Control': 'no-cache' },
        signal: abortSignal
      });
    }
  }

  if (!response.ok) {
    throw new Error(`Failed to download ${item.fileName} (${response.status})`);
  }

  const contentType = response.headers.get('content-type') || '';
  const expectedArchive = ['.jar', '.zip'].includes(path.extname(destinationPath).toLowerCase());
  if (expectedArchive && contentType.toLowerCase().includes('text/html')) {
    throw new Error(`Download URL for ${item.fileName} returned HTML instead of a mod file.`);
  }

  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  const tempPath = `${destinationPath}.download-${Date.now()}`;
  const totalBytes = Number(response.headers.get('content-length') || 0);
  const hasher = item.sha256 ? crypto.createHash('sha256') : null;
  let downloaded = 0;

  await new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(tempPath);

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
        const itemProgress = Math.round((downloaded / totalBytes) * progressSpan);
        progressCallback({ state: 'downloading', progress: Math.min(99, progressBase + itemProgress) });
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
        if (digest.toLowerCase() !== item.sha256.toLowerCase()) {
          reject(new Error(`Checksum mismatch for ${item.fileName}.`));
          return;
        }
      }
      resolve();
    });

    response.body.pipe(fileStream);
  });

  await fs.promises.rename(tempPath, destinationPath);
  progressCallback({ state: 'downloading', progress: Math.min(99, progressBase + progressSpan) });
}

function formatDownloadFailures(failures) {
  const requiredFailures = failures.filter((failure) => failure.item.required !== false);
  const displayed = failures
    .slice(0, 8)
    .map((failure) => `${failure.item.fileName}: ${failure.error.message.replace(/[.]+$/g, '')}`)
    .join('; ');
  const suffix = failures.length > 8 ? `; plus ${failures.length - 8} more` : '';
  const curseForgeCount = failures.filter((failure) => curseForgeDetailsFromUrl(failure.item.url)).length;
  const requiredPrefix = requiredFailures.length ? `${requiredFailures.length} required download(s) failed` : 'Downloads failed';
  const curseForgeHint = curseForgeCount
    ? ' CurseForge web download pages returned 403 or did not expose a browser download URL; use WordPress-hosted direct file URLs for any remaining failures.'
    : '';

  return `${requiredPrefix}: ${displayed}${suffix}.${curseForgeHint}`;
}

async function removeOwnedFiles(modpackDir, trackerFileName, desiredItems) {
  const trackerPath = path.join(modpackDir, trackerFileName);
  const previous = await readJsonFile(trackerPath, { files: [] });
  const desiredTargets = new Set(desiredItems.map((item) => item.targetPath));

  for (const file of previous.files || []) {
    const previousTarget = normalizeString(file.targetPath);
    if (!previousTarget || desiredTargets.has(previousTarget)) {
      continue;
    }

    const relativePath = safeRelativePath(previousTarget);
    await fs.promises.rm(path.join(modpackDir, relativePath), { force: true }).catch(() => {});
  }
}

function buildPreviousFileMap(previousTracker) {
  const map = new Map();
  for (const file of previousTracker.files || []) {
    const targetPath = normalizeString(file.targetPath);
    if (!targetPath) {
      continue;
    }
    map.set(targetPath, {
      id: normalizeString(file.id),
      url: normalizeString(file.url),
      fileName: normalizeString(file.fileName),
      targetPath,
      sha256: normalizeString(file.sha256)
    });
  }

  return map;
}

async function canReuseExistingDownload(modpackDir, item, previousFileMap) {
  if (item.sha256) {
    return false;
  }

  const previous = previousFileMap.get(item.targetPath);
  if (!previous) {
    return false;
  }

  const sameDownload =
    previous.url === item.url &&
    previous.fileName === item.fileName &&
    previous.id === item.id &&
    previous.targetPath === item.targetPath;
  if (!sameDownload) {
    return false;
  }

  const destinationPath = path.join(modpackDir, item.targetPath);
  return fs.promises
    .stat(destinationPath)
    .then((stats) => stats.isFile() && stats.size > 0)
    .catch(() => false);
}

async function installTrackedFiles(modpackDir, trackerFileName, items, progressCallback, abortSignal, start, end, options = {}) {
  const prepared = items.map((item) => {
    const targetPath = item.target
      ? safeRelativePath(item.target)
      : safeRelativePath(path.join(item.directory || MODS_DIR_NAME, item.fileName));

    return {
      ...item,
      targetPath
    };
  });

  const previousTracker = await readJsonFile(path.join(modpackDir, trackerFileName), { files: [] });
  const previousFileMap = buildPreviousFileMap(previousTracker);
  await removeOwnedFiles(modpackDir, trackerFileName, prepared);

  const span = Math.max(1, end - start);
  const itemSpan = prepared.length ? Math.max(1, Math.floor(span / prepared.length)) : span;
  const installed = [];
  const failures = [];

  for (const [index, item] of prepared.entries()) {
    const progressBase = Math.min(end - 1, start + index * itemSpan);
    const destinationPath = path.join(modpackDir, item.targetPath);
    progressCallback({
      state: 'downloading',
      progress: progressBase,
      message: `Downloading ${item.fileName}`
    });
    try {
      const reusedExisting = await canReuseExistingDownload(modpackDir, item, previousFileMap);
      if (reusedExisting) {
        progressCallback({
          state: 'downloading',
          progress: Math.min(99, progressBase + itemSpan),
          message: `Using existing ${item.fileName}`
        });
      } else {
        await downloadFile(item, destinationPath, progressCallback, abortSignal, progressBase, itemSpan, options);
      }
      installed.push({
        id: item.id,
        url: item.url,
        fileName: item.fileName,
        targetPath: item.targetPath,
        sha256: item.sha256 || null
      });
    } catch (error) {
      const existingFilePresent = await fs.promises
        .access(destinationPath)
        .then(() => true)
        .catch(() => false);
      if (existingFilePresent) {
        installed.push({
          id: item.id,
          url: item.url,
          fileName: item.fileName,
          targetPath: item.targetPath,
          sha256: item.sha256 || null
        });
      }
      failures.push({ item, error });
      progressCallback({
        state: 'warning',
        progress: Math.min(99, progressBase + itemSpan),
        message: `Skipped ${item.fileName}: ${error.message}`
      });
    }
  }

  await writeJsonFile(path.join(modpackDir, trackerFileName), {
    updatedAt: new Date().toISOString(),
    files: installed
  });

  if (failures.some((failure) => failure.item.required !== false)) {
    throw new Error(formatDownloadFailures(failures));
  }
}

async function installManifestUpdate(resolved, targetDir, progressCallback, abortSignal, options = {}) {
  ensureNotCancelled(abortSignal);
  await fs.promises.mkdir(targetDir, { recursive: true });
  const { modpackDir, modsDir, resourcepacksDir } = await ensureModpackStructure(targetDir);
  await migrateRootContent(targetDir, modpackDir);
  await fs.promises.mkdir(modsDir, { recursive: true });
  await fs.promises.mkdir(resourcepacksDir, { recursive: true });

  const managedItems = [
    ...normalizeDownloadList(resolved.mods, MODS_DIR_NAME),
    ...normalizeDownloadList(resolved.resourcepacks, RESOURCEPACKS_DIR_NAME),
    ...normalizeDownloadList(resolved.files, '')
  ];
  const userItems = normalizeAdditionalModLinks(options.additionalMods);

  progressCallback({ state: 'downloading', progress: 1, message: 'Downloading managed mods' });

  if (managedItems.length) {
    await installTrackedFiles(modpackDir, MANAGED_MODS_FILENAME, managedItems, progressCallback, abortSignal, 5, 80, options);
  } else {
    await writeJsonFile(path.join(modpackDir, MANAGED_MODS_FILENAME), {
      updatedAt: new Date().toISOString(),
      files: []
    });
  }

  if (userItems.length) {
    await installTrackedFiles(modpackDir, USER_MODS_FILENAME, userItems, progressCallback, abortSignal, 80, 95, options);
  } else {
    await removeOwnedFiles(modpackDir, USER_MODS_FILENAME, []);
    await writeJsonFile(path.join(modpackDir, USER_MODS_FILENAME), {
      updatedAt: new Date().toISOString(),
      files: []
    });
  }

  progressCallback({ state: 'finalizing', progress: 95 });
  return {
    version: resolved.version || null,
    forgeVersion: resolved.forgeVersion || null,
    loaderType: resolved.loaderType || null,
    loaderVersion: resolved.loaderVersion || null,
    neoforgeVersion: resolved.neoforgeVersion || null
  };
}

async function downloadAndExtractUpdate(source, targetDir, progressCallback = () => {}, abortSignal, options = {}) {
  let resolved = { ...source };
  let tempZipPath = null;
  const profile = getProfile(options.profile?.id || options.profile || source?.profileId || LEGACY_PROFILE_ID);

  try {
    ensureNotCancelled(abortSignal);
    if (source.type === 'feed') {
      progressCallback({ state: 'fetching-feed' });
      resolved = await fetchFeedManifest(source.feedUrl, profile);
    } else if (source.type === 'manifest') {
      progressCallback({ state: 'fetching-feed' });
      resolved = await fetchFeedManifest(source.manifestUrl, profile);
    }

    if ((resolved.forgeVersion || resolved.loaderVersion) && options.onProfileResolved) {
      options.onProfileResolved(resolved);
    }

    if (resolved.mods?.length || resolved.resourcepacks?.length || resolved.files?.length) {
      return await installManifestUpdate(resolved, targetDir, progressCallback, abortSignal, options);
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
        const pack = normalizeManifestDescriptor(manifest, profile);
        if (pack.mods.length || pack.resourcepacks.length || pack.files.length) {
          if (response.body?.cancel) {
            response.body.cancel();
          }
          resolved = pack;
          return await installManifestUpdate(resolved, targetDir, progressCallback, abortSignal, options);
        }

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
    await migrateRootContent(targetDir, modpackDir);
    await fs.promises.rm(modsDir, { recursive: true, force: true });
    await fs.promises.rm(resourcepacksDir, { recursive: true, force: true });
    await fs.promises.rm(legacyModsDir, { recursive: true, force: true });
    await fs.promises.rm(legacyResourcepacksDir, { recursive: true, force: true });

    ensureNotCancelled(abortSignal);
    progressCallback({ state: 'extracting', progress: PROGRESS_PHASE_DOWNLOAD });

    const zip = new AdmZip(tempZipPath);
    zip.getEntries().forEach((entry) => {
      const entryPath = path.join(modpackDir, entry.entryName);
      if (entry.isDirectory) {
        fs.mkdirSync(entryPath, { recursive: true });
      }
    });
    ensureNotCancelled(abortSignal);
    zip.extractAllTo(modpackDir, true);

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

async function freshReinstall(targetDir, progressCallback = () => {}, abortSignal, options = {}) {
  const updateSource = resolveUpdateSource(options.profile);
  if (!hasSource(updateSource)) {
    throw new Error('Update source is not configured.');
  }

  await fs.promises.rm(targetDir, { recursive: true, force: true });

  return downloadAndExtractUpdate(updateSource, targetDir, progressCallback, abortSignal, options);
}

module.exports = {
  resolveUpdateSource,
  downloadAndExtractUpdate,
  fetchFeedManifest,
  freshReinstall,
  hasSource
};
