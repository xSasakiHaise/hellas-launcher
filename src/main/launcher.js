const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { Client } = require('minecraft-launcher-core');

const DEFAULT_MC_VERSION = '1.16.5';
const FORGE_METADATA_URL = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const VERSION_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const launcher = new Client();

let cachedForgeVersion = null;
let activeLaunch = null;

async function ensureInstallDirExists(installDir) {
  await fsp.mkdir(installDir, { recursive: true });
}

function getForgeInstallerPath(installDir, forgeVersion) {
  if (!forgeVersion) return null;

  return path.join(installDir, 'forge', forgeVersion, `forge-${forgeVersion}-installer.jar`);
}

async function findGameDirectory(installDir) {
  const modpackDir = path.join(installDir, 'modpack');
  const modpackExists = await fsp
    .stat(modpackDir)
    .then((stats) => stats.isDirectory())
    .catch(() => false);

  if (modpackExists) {
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

async function fetchJson(url, errorMessage) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(errorMessage || `Failed to fetch ${url} (${response.status})`);
  }

  return response.json();
}

async function downloadToFile(url, destinationPath, onStatus) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url} (${response.status})`);
  }

  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  const fileStream = fs.createWriteStream(destinationPath);

  await new Promise((resolve, reject) => {
    response.body.pipe(fileStream);
    response.body.on('error', reject);
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });

  onStatus?.({ message: `Downloaded ${path.basename(destinationPath)}` });
}

async function ensureMinecraftVersion(installDir, minecraftVersion = DEFAULT_MC_VERSION, onStatus) {
  const versionDir = path.join(installDir, 'versions', minecraftVersion);
  const versionJsonPath = path.join(versionDir, `${minecraftVersion}.json`);
  const versionJarPath = path.join(versionDir, `${minecraftVersion}.jar`);

  const versionJsonExists = await fsp
    .stat(versionJsonPath)
    .then((stats) => stats.isFile())
    .catch(() => false);
  const versionJarExists = await fsp
    .stat(versionJarPath)
    .then((stats) => stats.isFile())
    .catch(() => false);

  if (versionJsonExists && versionJarExists) {
    return { minecraftVersion, versionJsonPath, versionJarPath };
  }

  onStatus?.({ message: `Fetching Minecraft ${minecraftVersion} metadata…` });
  const manifest = await fetchJson(
    VERSION_MANIFEST_URL,
    `Failed to resolve Minecraft versions (${VERSION_MANIFEST_URL})`
  );
  const versionEntry = manifest.versions.find((entry) => entry.id === minecraftVersion);
  if (!versionEntry || !versionEntry.url) {
    throw new Error(`Minecraft version ${minecraftVersion} was not found in the manifest.`);
  }

  const versionProfile = await fetchJson(
    versionEntry.url,
    `Failed to download Minecraft ${minecraftVersion} profile.`
  );

  await fsp.mkdir(versionDir, { recursive: true });
  await fsp.writeFile(versionJsonPath, JSON.stringify(versionProfile, null, 2), 'utf8');

  const clientUrl = versionProfile.downloads?.client?.url;
  if (!clientUrl) {
    throw new Error(`Minecraft ${minecraftVersion} profile is missing client download info.`);
  }

  onStatus?.({ message: `Downloading Minecraft ${minecraftVersion} client…` });
  await downloadToFile(clientUrl, versionJarPath, onStatus);

  return { minecraftVersion, versionJsonPath, versionJarPath };
}

async function ensureForgeInstaller(installDir, forgeVersion, onStatus) {
  const installerPath = getForgeInstallerPath(installDir, forgeVersion);
  if (!installerPath) return null;

  const alreadyPresent = await fsp
    .stat(installerPath)
    .then((stats) => stats.isFile())
    .catch(() => false);

  if (alreadyPresent) return installerPath;

  await fsp.mkdir(path.dirname(installerPath), { recursive: true });
  const downloadUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${forgeVersion}/forge-${forgeVersion}-installer.jar`;
  onStatus?.({ message: `Downloading Forge ${forgeVersion}...` });

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download Forge ${forgeVersion} (${response.status})`);
  }

  const fileStream = fs.createWriteStream(installerPath);
  await new Promise((resolve, reject) => {
    response.body.pipe(fileStream);
    response.body.on('error', reject);
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });

  return installerPath;
}

async function detectModpackVersion(modsPaths, expectedModpackJar = null, modpackErrors = []) {
  let detectedVersion = null;

  for (const modsPath of modsPaths) {
    const entries = await fsp
      .readdir(modsPath, { withFileTypes: true })
      .catch((error) => {
        modpackErrors.push({ path: modsPath, message: error.message, code: error.code });
        return [];
      });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = entry.name.match(/^hellasforms-([\w.-]+)\.jar$/i);
      if (match) {
        detectedVersion = match[1];
        if (expectedModpackJar && entry.name === expectedModpackJar) {
          return { modpackJarPresent: true, detectedVersion };
        }
      }
    }
  }

  return { modpackJarPresent: Boolean(detectedVersion), detectedVersion };
}

function uniquePaths(paths) {
  return Array.from(new Set(paths.filter(Boolean)));
}

async function readDirSafe(targetPath, modpackErrors) {
  const entries = await fsp
    .readdir(targetPath)
    .catch((error) => {
      modpackErrors.push({ path: targetPath, message: error.message, code: error.code });
      return [];
    });

  return entries;
}

async function findNestedModDirectories(installDir, modpackErrors) {
  const modDirectories = [];
  const installEntries = await fsp
    .readdir(installDir, { withFileTypes: true })
    .catch((error) => {
      modpackErrors.push({ path: installDir, message: error.message, code: error.code });
      return [];
    });

  for (const entry of installEntries) {
    if (!entry.isDirectory()) continue;

    const candidate = path.join(installDir, entry.name, 'mods');
    const hasModsDirectory = await fsp
      .stat(candidate)
      .then((stats) => stats.isDirectory())
      .catch(() => false);

    if (hasModsDirectory) {
      modDirectories.push(candidate);
    }
  }

  return modDirectories;
}

async function checkLaunchRequirements(installDir, expectedModpackVersion = null) {
  const minecraftVersion = DEFAULT_MC_VERSION;
  const forgeVersion = await fetchLatestForgeVersion();

  const minecraftPath = path.join(
    installDir,
    'versions',
    minecraftVersion,
    `${minecraftVersion}.json`
  );
  const modpackErrors = [];
  const forgePath = forgeVersion
    ? path.join(installDir, 'versions', forgeVersion, `${forgeVersion}.json`)
    : null;
  const forgeInstallerPath = getForgeInstallerPath(installDir, forgeVersion);
  const modpackDir = path.join(installDir, 'modpack');
  const modsPath = path.join(modpackDir, 'mods');
  const fallbackModsPath = path.join(installDir, 'mods');
  const modDirectories = uniquePaths([
    modsPath,
    fallbackModsPath,
    ...(await findNestedModDirectories(installDir, modpackErrors))
  ]);

  const minecraftPresent = await fs
    .access(minecraftPath)
    .then(() => true)
    .catch(() => false);

  const forgePresent = forgePath
    ? await fs
        .access(forgePath)
        .then(() => true)
        .catch(
          async () =>
            await fs
              .access(forgeInstallerPath)
              .then(() => true)
              .catch(() => false)
        )
    : await fs
        .access(forgeInstallerPath)
        .then(() => true)
        .catch(() => false);

  const expectedModpackJar = expectedModpackVersion ? `hellasforms-${expectedModpackVersion}.jar` : null;
  const modsEntries = await Promise.all(modDirectories.map((dir) => readDirSafe(dir, modpackErrors)));

  const { modpackJarPresent, detectedVersion } = await detectModpackVersion(
    modDirectories,
    expectedModpackJar,
    modpackErrors
  );

  const modpackPresent = modpackJarPresent || modsEntries.some((entries) => entries.length > 0);

  return {
    minecraftVersion,
    forgeVersion,
    forgeInstallerPath,
    modpackVersion: detectedVersion,
    searchedModDirectories: modDirectories,
    modpackErrors,
    requirements: {
      minecraft: minecraftPresent,
      forge: forgePresent,
      modpack: modpackPresent
    }
  };
}

async function ensureBaseRuntime({ installDir, onStatus = () => {} }) {
  if (!installDir) {
    throw new Error('Install directory is not set.');
  }

  await ensureInstallDirExists(installDir);
  const minecraftVersion = DEFAULT_MC_VERSION;
  const forgeVersion = await fetchLatestForgeVersion();

  onStatus({ message: 'Checking Minecraft files…' });
  await ensureMinecraftVersion(installDir, minecraftVersion, onStatus);

  onStatus({ message: 'Checking Forge installer…' });
  await ensureForgeInstaller(installDir, forgeVersion, onStatus);

  return { minecraftVersion, forgeVersion };
}

async function launchModpack({
  installDir,
  account,
  onStatus = () => {},
  expectedModpackVersion = null
}) {
  if (!installDir) {
    throw new Error('Install directory is missing. Please install the modpack first.');
  }

  if (activeLaunch) {
    throw new Error('A launch is already in progress. Please wait or cancel it.');
  }

  await ensureInstallDirExists(installDir);
  onStatus({ message: `Checking installation in ${installDir}` });
  const { requirements, forgeVersion, forgeInstallerPath, modpackErrors, searchedModDirectories } =
    await checkLaunchRequirements(installDir, expectedModpackVersion);
  const missing = Object.entries(requirements)
    .filter(([, present]) => !present)
    .map(([key]) => key);

  const missingCritical = missing.filter((item) => item === 'modpack');
  if (missingCritical.length) {
    const modpackErrorDetails = modpackErrors
      .map((error) => `${error.path}: ${error.message}${error.code ? ` (${error.code})` : ''}`)
      .join('; ');
    const searchedDirs = searchedModDirectories?.length
      ? ` Searched mod directories: ${searchedModDirectories.join(', ')}`
      : '';
    const details = modpackErrorDetails ? ` Details: ${modpackErrorDetails}.${searchedDirs}` : searchedDirs;
    throw new Error(
      `Cannot launch yet. Missing components: ${missingCritical
        .map((item) => item.toUpperCase())
        .join(', ')}.${details}`
    );
  }

  let resolvedForgeInstaller = forgeInstallerPath;
  if (missing.length) {
    onStatus({
      message: `Preparing runtime. Missing components: ${missing.map((item) => item.toUpperCase()).join(', ')}`
    });
  }

  if (!requirements.minecraft) {
    try {
      await ensureMinecraftVersion(installDir, DEFAULT_MC_VERSION, onStatus);
    } catch (error) {
      throw new Error(`Failed while downloading Minecraft ${DEFAULT_MC_VERSION}: ${error.message}`);
    }
  }

  if (!requirements.forge) {
    try {
      resolvedForgeInstaller = await ensureForgeInstaller(installDir, forgeVersion, onStatus);
    } catch (error) {
      throw new Error(`Failed while downloading Forge ${forgeVersion}: ${error.message}`);
    }
  }

  const gameDirectory = await findGameDirectory(installDir).catch((error) => {
    throw new Error(`Could not resolve modpack folder under ${installDir}: ${error.message}`);
  });
  onStatus({ message: `Launching from ${gameDirectory}` });

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
    forge: resolvedForgeInstaller,
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

module.exports = {
  launchModpack,
  cancelLaunch,
  isLaunching,
  checkLaunchRequirements,
  ensureBaseRuntime,
  ensureMinecraftVersion
};
