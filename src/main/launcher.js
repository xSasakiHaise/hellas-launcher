const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { Client } = require('minecraft-launcher-core');

const DEFAULT_MC_VERSION = '1.16.5';
const FORGE_METADATA_URL = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const launcher = new Client();

let cachedForgeVersion = null;
let activeLaunch = null;

async function ensureInstallDirExists(installDir) {
  await fsp.mkdir(installDir, { recursive: true });
}

async function hasModsDirectory(targetDir) {
  const modsPath = path.join(targetDir, 'mods');
  const hasMods = await fsp
    .readdir(modsPath)
    .then((entries) => entries.length > 0)
    .catch(() => false);

  return hasMods;
}

async function findGameDirectory(installDir) {
  const modpackDir = path.join(installDir, 'modpack');
  if (await hasModsDirectory(modpackDir)) {
    return modpackDir;
  }

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

async function checkLaunchRequirements(installDir) {
  const minecraftVersion = DEFAULT_MC_VERSION;
  const forgeVersion = await fetchLatestForgeVersion();

  const minecraftPath = path.join(
    installDir,
    'versions',
    minecraftVersion,
    `${minecraftVersion}.json`
  );
  const forgePath = forgeVersion
    ? path.join(installDir, 'versions', forgeVersion, `${forgeVersion}.json`)
    : null;
  const modpackDir = path.join(installDir, 'modpack');
  const modsPath = path.join(modpackDir, 'mods');
  const fallbackModsPath = path.join(installDir, 'mods');

  const minecraftPresent = await fs
    .access(minecraftPath)
    .then(() => true)
    .catch(() => false);

  const forgePresent = forgePath
    ? await fs
        .access(forgePath)
        .then(() => true)
        .catch(() => false)
    : false;

  const modpackPresent = await fs
    .readdir(modsPath)
    .then((entries) => entries.length > 0)
    .catch(() => false);

  const legacyModpackPresent = await fs
    .readdir(fallbackModsPath)
    .then((entries) => entries.length > 0)
    .catch(() => false);

  return {
    minecraftVersion,
    forgeVersion,
    requirements: {
      minecraft: minecraftPresent,
      forge: forgePresent,
      modpack: modpackPresent || legacyModpackPresent
    }
  };
}

async function launchModpack({ installDir, account, onStatus = () => {} }) {
  if (!installDir) {
    throw new Error('Install directory is missing. Please install the modpack first.');
  }

  if (activeLaunch) {
    throw new Error('A launch is already in progress. Please wait or cancel it.');
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
    forge: forgeVersion,
    memory: {
      max: process.env.MC_MEMORY_MAX || '4096',
      min: process.env.MC_MEMORY_MIN || '2048'
    }
  });

  activeLaunch = launchPromise.finally(() => {
    activeLaunch = null;
  });

  await activeLaunch;
  return { launchedWith: forgeVersion };
}

function cancelLaunch() {
  if (!activeLaunch) {
    return false;
  }

  launcher.kill();
  return true;
}

function isLaunching() {
  return Boolean(activeLaunch);
}

module.exports = { launchModpack, cancelLaunch, isLaunching, checkLaunchRequirements };
