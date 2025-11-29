const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { Client } = require('minecraft-launcher-core');

const DEFAULT_MC_VERSION = '1.16.5';
const MOJANG_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';
const FORGE_METADATA_URL = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const FORGE_BASE_URL = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const launcher = new Client();

let cachedForgeVersion = null;

async function ensureInstallDirExists(installDir) {
  await fsp.mkdir(installDir, { recursive: true });
}

async function findGameDirectory(installDir) {
  const entries = await fsp.readdir(installDir, { withFileTypes: true });
  const hasModsAtRoot = entries.some(
    (entry) => entry.isDirectory() && entry.name.toLowerCase() === 'mods'
  );

  if (hasModsAtRoot) {
    return installDir;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const potentialDir = path.join(installDir, entry.name);
    const subEntries = await fsp.readdir(potentialDir, { withFileTypes: true }).catch(() => []);
    const hasMods = subEntries.some(
      (subEntry) => subEntry.isDirectory() && subEntry.name.toLowerCase() === 'mods'
    );

    if (hasMods) {
      return potentialDir;
    }
  }

  throw new Error('Modpack files not found in the installation directory. Please reinstall.');
}

async function fetchLatestForgeVersion() {
  if (cachedForgeVersion) return cachedForgeVersion;

  const response = await fetch(FORGE_METADATA_URL);
  if (!response.ok) {
    throw new Error(`Failed to resolve Forge metadata (${response.status})`);
  }

  const metadata = await response.text();
  const matches = Array.from(metadata.matchAll(/<version>([^<]+)<\/version>/g)).map((match) => match[1]);
  const forgeVersions = matches.filter((version) => version.startsWith(`${DEFAULT_MC_VERSION}-`));
  if (!forgeVersions.length) {
    throw new Error('No Forge versions found for Minecraft 1.16.5');
  }

  const latest = forgeVersions[forgeVersions.length - 1];
  cachedForgeVersion = latest;
  return latest;
}

async function downloadToFile(url, destination, onProgress = () => {}) {
  const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) {
    throw new Error(`Failed to download ${url} (${response.status})`);
  }

  await fsp.mkdir(path.dirname(destination), { recursive: true });

  const total = Number(response.headers.get('content-length') || 0);
  let downloaded = 0;

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(destination);

    response.body.on('data', (chunk) => {
      downloaded += chunk.length;
      if (total) {
        const progress = Math.min(100, Math.round((downloaded / total) * 100));
        onProgress(progress);
      }
    });

    response.body.on('error', (err) => {
      stream.destroy();
      reject(err);
    });

    stream.on('error', (err) => {
      response.body.destroy(err);
      reject(err);
    });

    stream.on('finish', resolve);

    response.body.pipe(stream);
  });
}

async function downloadMinecraftVersion(installDir, onStatus = () => {}) {
  const manifestResponse = await fetch(MOJANG_MANIFEST_URL, { headers: { 'Cache-Control': 'no-cache' } });
  if (!manifestResponse.ok) {
    throw new Error(`Failed to fetch Minecraft manifest (${manifestResponse.status})`);
  }

  const manifest = await manifestResponse.json();
  const versionEntry = manifest.versions.find((entry) => entry.id === DEFAULT_MC_VERSION);
  if (!versionEntry?.url) {
    throw new Error(`Minecraft version ${DEFAULT_MC_VERSION} was not found in the manifest.`);
  }

  const versionJsonResponse = await fetch(versionEntry.url, { headers: { 'Cache-Control': 'no-cache' } });
  if (!versionJsonResponse.ok) {
    throw new Error(`Failed to fetch Minecraft version JSON (${versionJsonResponse.status})`);
  }

  const versionJson = await versionJsonResponse.json();
  const versionsDir = path.join(installDir, 'versions', DEFAULT_MC_VERSION);
  const jsonPath = path.join(versionsDir, `${DEFAULT_MC_VERSION}.json`);
  await fsp.mkdir(versionsDir, { recursive: true });
  await fsp.writeFile(jsonPath, JSON.stringify(versionJson, null, 2), 'utf8');
  onStatus({ message: `Minecraft ${DEFAULT_MC_VERSION} manifest saved.` });

  const clientJar = versionJson.downloads?.client;
  if (clientJar?.url) {
    const jarPath = path.join(versionsDir, `${DEFAULT_MC_VERSION}.jar`);
    onStatus({ message: 'Downloading Minecraft client…' });
    await downloadToFile(clientJar.url, jarPath, () => {});
    onStatus({ message: `Minecraft ${DEFAULT_MC_VERSION} client ready.`, level: 'success' });
  } else {
    onStatus({
      message: 'Minecraft client URL missing from manifest; vanilla assets will download on first launch.',
      level: 'error'
    });
  }

  if (versionJson.assetIndex?.url) {
    const assetIndexPath = path.join(installDir, 'assets', 'indexes', `${versionJson.assetIndex.id}.json`);
    await downloadToFile(versionJson.assetIndex.url, assetIndexPath, () => {});
  }

  return { version: DEFAULT_MC_VERSION };
}

async function downloadForgeArtifacts(installDir, onStatus = () => {}) {
  const forgeVersion = await fetchLatestForgeVersion();
  const forgeDir = path.join(installDir, 'versions', forgeVersion);
  const forgeJsonPath = path.join(forgeDir, `${forgeVersion}.json`);
  const forgeInstallerPath = path.join(forgeDir, `forge-${forgeVersion}-installer.jar`);

  await fsp.mkdir(forgeDir, { recursive: true });

  const forgeJsonUrl = `${FORGE_BASE_URL}/${forgeVersion}/forge-${forgeVersion}.json`;
  const forgeInstallerUrl = `${FORGE_BASE_URL}/${forgeVersion}/forge-${forgeVersion}-installer.jar`;

  onStatus({ message: `Downloading Forge ${forgeVersion} manifest…` });
  await downloadToFile(forgeJsonUrl, forgeJsonPath, () => {});

  onStatus({ message: `Downloading Forge ${forgeVersion} installer…` });
  await downloadToFile(forgeInstallerUrl, forgeInstallerPath, () => {});
  onStatus({ message: `Forge ${forgeVersion} ready.`, level: 'success' });

  return { forgeVersion, forgeInstallerPath, forgeJsonPath };
}

async function ensureBaseDependencies(installDir, onStatus = () => {}) {
  await ensureInstallDirExists(installDir);

  const currentState = await checkLaunchRequirements(installDir).catch(() => ({
    requirements: { minecraft: false, forge: false }
  }));

  if (currentState.requirements?.minecraft && currentState.requirements?.forge) {
    return {
      minecraftVersion: currentState.minecraftVersion,
      forgeVersion: currentState.forgeVersion,
      forgeInstallerPath: currentState.forgeInstallerPath
    };
  }

  onStatus({ message: 'Installing required Minecraft and Forge files…' });
  await downloadMinecraftVersion(installDir, onStatus);
  const forge = await downloadForgeArtifacts(installDir, onStatus);

  return { minecraftVersion: DEFAULT_MC_VERSION, ...forge };
}

async function checkLaunchRequirements(installDir) {
  const minecraftVersion = DEFAULT_MC_VERSION;
  let forgeVersion = null;

  try {
    forgeVersion = await fetchLatestForgeVersion();
  } catch (error) {
    forgeVersion = null;
  }

  const minecraftPath = path.join(
    installDir,
    'versions',
    minecraftVersion,
    `${minecraftVersion}.json`
  );
  const forgeJsonPath = forgeVersion
    ? path.join(installDir, 'versions', forgeVersion, `${forgeVersion}.json`)
    : null;
  const forgeInstallerPath = forgeVersion
    ? path.join(installDir, 'versions', forgeVersion, `forge-${forgeVersion}-installer.jar`)
    : null;
  const modsPath = path.join(installDir, 'mods');

  const minecraftPresent = await fsp
    .access(minecraftPath)
    .then(() => true)
    .catch(() => false);

  const forgeJsonPresent = forgeJsonPath
    ? await fsp
        .access(forgeJsonPath)
        .then(() => true)
        .catch(() => false)
    : false;

  const forgeInstallerPresent = forgeInstallerPath
    ? await fsp
        .access(forgeInstallerPath)
        .then(() => true)
        .catch(() => false)
    : false;

  const modpackPresent = await fsp
    .readdir(modsPath)
    .then((entries) => entries.length > 0)
    .catch(() => false);

  return {
    minecraftVersion,
    forgeVersion,
    forgeInstallerPath,
    requirements: {
      minecraft: minecraftPresent,
      forge: forgeJsonPresent && forgeInstallerPresent,
      modpack: modpackPresent
    }
  };
}

async function launchModpack({ installDir, account, onStatus = () => {} }) {
  if (!installDir) {
    throw new Error('Install directory is missing. Please install the modpack first.');
  }

  await ensureInstallDirExists(installDir);
  onStatus({ message: `Checking installation in ${installDir}` });
  const { requirements, forgeVersion } = await checkLaunchRequirements(installDir);
  const missing = Object.entries(requirements)
    .filter(([, present]) => !present)
    .map(([key]) => key);

  if (missing.length) {
    throw new Error(
      `Cannot launch yet. Missing components: ${missing.map((item) => item.toUpperCase()).join(', ')}`
    );
  }

  const gameDirectory = await findGameDirectory(installDir);

  const forgeInstallerPath = forgeVersion
    ? path.join(installDir, 'versions', forgeVersion, `forge-${forgeVersion}-installer.jar`)
    : null;

  if (!forgeInstallerPath || !fs.existsSync(forgeInstallerPath)) {
    throw new Error('Forge installer is missing. Please reinstall to regenerate Forge files.');
  }

  const auth = {
    access_token: account.accessToken,
    client_token: '',
    uuid: account.uuid || account.username,
    name: account.username,
    user_properties: '{}',
    user_type: 'msa'
  };

  const launchPromise = new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onClose = (code) => {
      cleanup();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Minecraft exited with code ${code}`));
      }
    };

    const onDebug = (line) => {
      if (line) {
        onStatus({ message: String(line) });
      }
    };

    const cleanup = () => {
      launcher.removeListener('error', onError);
      launcher.removeListener('close', onClose);
      launcher.removeListener('debug', onDebug);
      launcher.removeListener('data', onDebug);
    };

    launcher.on('error', onError);
    launcher.on('close', onClose);
    launcher.on('debug', onDebug);
    launcher.on('data', onDebug);
  });

  onStatus({ message: `Launching with Forge ${forgeVersion}` });
  launcher.launch({
    root: installDir,
    authorization: auth,
    gameDirectory,
    version: {
      number: DEFAULT_MC_VERSION,
      type: 'release'
    },
    forge: forgeInstallerPath,
    memory: {
      max: process.env.MC_MEMORY_MAX || '4096',
      min: process.env.MC_MEMORY_MIN || '2048'
    }
  });

  await launchPromise;
  return { launchedWith: forgeVersion };
}

module.exports = { launchModpack, checkLaunchRequirements, ensureBaseDependencies };
