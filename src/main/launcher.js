const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { execFile } = require('child_process');
const { Client } = require('minecraft-launcher-core');
const os = require('os');
const { resolveBundledJava } = require('./javaResolver');
const { HELLAS_ROOT, INSTANCE_DIR } = require('./paths');

const DEFAULT_MC_VERSION = '1.16.5';
const FORGE_METADATA_URL = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const VERSION_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const LOG4J_CONFIG_FILENAME = 'log4j2_112-116.xml';
const LOG4J_CONFIG_URL =
  'https://launcher.mojang.com/v1/objects/02937d122c86ce73319ef9975b58896fc1b491d1/log4j2_112-116.xml';
const launcher = new Client();

const MODPACK_DIR_NAME = 'modpack';
const FORGE_DIR_NAME = 'forge';
const VERSIONS_DIR_NAME = 'versions';

// Pin the Forge version used by the modpack.
// When you move the modpack to a new Forge, just change this constant.
const MODPACK_FORGE_VERSION = '1.16.5-36.2.42';

function getInstallSubpaths(installDir) {
  const modpackDir = path.join(installDir, MODPACK_DIR_NAME);
  const forgeDir = path.join(installDir, FORGE_DIR_NAME);
  const versionsDir = path.join(installDir, VERSIONS_DIR_NAME);

  return { modpackDir, forgeDir, versionsDir };
}

let cachedForgeVersion = null;
let activeLaunch = null;

function normalizeMemoryValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.round(parsed);
}

function buildMemoryPlan(memorySettings = {}) {
  const totalMemoryMb = Math.floor(os.totalmem() / (1024 * 1024));
  const recommendedMb = Math.max(1024, Math.floor(totalMemoryMb * 0.75));

  const envMax = normalizeMemoryValue(process.env.MC_MEMORY_MAX);
  const envMin = normalizeMemoryValue(process.env.MC_MEMORY_MIN);

  const mode = memorySettings.mode === 'custom' ? 'custom' : 'auto';
  const customMax = normalizeMemoryValue(memorySettings.maxMb);
  const customMin = normalizeMemoryValue(memorySettings.minMb);

  let maxMb = envMax ?? (mode === 'custom' ? customMax : null) ?? recommendedMb;
  maxMb = Math.min(totalMemoryMb, Math.max(1024, maxMb));

  let minMb = envMin ?? (mode === 'custom' ? customMin : null) ?? Math.floor(maxMb / 2);
  minMb = Math.min(maxMb, Math.max(1024, minMb));

  return { totalMemoryMb, recommendedMb, minMb, maxMb };
}

function calculateMemoryAllocation(memorySettings = {}) {
  const plan = buildMemoryPlan(memorySettings);

  return {
    max: `${plan.maxMb}M`,
    min: `${plan.minMb}M`
  };
}

function buildJvmArgs(memorySettings = {}, logConfigPath = LOG4J_CONFIG_FILENAME) {
  const plan = buildMemoryPlan(memorySettings);
  const memoryArgs = [`-Xmx${plan.maxMb}M`, `-Xms${plan.minMb}M`];

  const defaultJvmArgs = [
    ...memoryArgs,
    '-Dfml.ignoreInvalidMinecraftCertificates=true',
    '-Dfml.ignorePatchDiscrepancies=true',
    `-Dlog4j.configurationFile=${logConfigPath}`
  ];

  const userJvmArgs = Array.isArray(memorySettings.jvmArgs)
    ? memorySettings.jvmArgs.filter((arg) => typeof arg === 'string')
    : [];

  return [...defaultJvmArgs, ...userJvmArgs];
}

function parseJavaVersion(output = '') {
  const match = output.match(/"(?<version>[\d+_.]+)"/);
  const version = match?.groups?.version?.replace(/_/g, '.');
  const versionParts = version ? version.split('.') : [];
  // Java 8 reports versions like "1.8.0_402" where the leading "1" is not the
  // actual major version. For Java 9+ the first segment already represents the
  // major version (e.g., "11.0.24").
  const major = versionParts[0] === '1' ? Number(versionParts[1]) : Number(versionParts[0]);

  return { version: version ?? null, major: Number.isFinite(major) ? major : null };
}

async function detectJavaVersion(javaExecutable) {
  return new Promise((resolve) => {
    execFile(javaExecutable, ['-version'], (error, stdout, stderr) => {
      if (error) {
        resolve({ version: null, major: null });
        return;
      }

      const combinedOutput = [stderr, stdout].filter(Boolean).join('\n');
      resolve(parseJavaVersion(combinedOutput));
    });
  });
}

async function ensureInstallDirExists(installDir) {
  const { modpackDir, forgeDir, versionsDir } = getInstallSubpaths(installDir);
  await fsp.mkdir(installDir, { recursive: true });
  await Promise.all([
    fsp.mkdir(modpackDir, { recursive: true }),
    fsp.mkdir(forgeDir, { recursive: true }),
    fsp.mkdir(versionsDir, { recursive: true })
  ]);

  return { modpackDir, forgeDir, versionsDir };
}

function getForgeInstallerPath(installDir, forgeVersion) {
  if (!forgeVersion) return null;

  const { forgeDir } = getInstallSubpaths(installDir);
  return path.join(forgeDir, forgeVersion, `forge-${forgeVersion}-installer.jar`);
}

async function findGameDirectory(installDir) {
  const { modpackDir } = getInstallSubpaths(installDir);
  await fsp.mkdir(modpackDir, { recursive: true });
  return modpackDir;
}

// Previously this pulled from Forge's Maven metadata and picked "latest".
// That was giving you 36.0.0. We hard-pin it to the modpack's Forge version.
async function fetchLatestForgeVersion() {
  if (cachedForgeVersion) return cachedForgeVersion;
  cachedForgeVersion = MODPACK_FORGE_VERSION;
  return cachedForgeVersion;
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

async function ensureLog4jConfig(installDir, onStatus) {
  const { modpackDir } = getInstallSubpaths(installDir);
  const log4jPath = path.join(modpackDir, LOG4J_CONFIG_FILENAME);
  const exists = await fsp
    .stat(log4jPath)
    .then((stats) => stats.isFile())
    .catch(() => false);

  if (exists) {
    return log4jPath;
  }

  onStatus?.({ message: 'Downloading Log4j configuration…' });
  await fsp.mkdir(path.dirname(log4jPath), { recursive: true });
  await downloadToFile(LOG4J_CONFIG_URL, log4jPath, onStatus);

  return log4jPath;
}

async function ensureMinecraftVersion(installDir, minecraftVersion = DEFAULT_MC_VERSION, onStatus) {
  const { versionsDir } = getInstallSubpaths(installDir);
  const versionDir = path.join(versionsDir, minecraftVersion);
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

async function checkLaunchRequirements(installDir, expectedModpackVersion = null) {
  const minecraftVersion = DEFAULT_MC_VERSION;
  const forgeVersion = await fetchLatestForgeVersion();
  const { versionsDir, modpackDir } = getInstallSubpaths(installDir);

  const minecraftPath = path.join(versionsDir, minecraftVersion, `${minecraftVersion}.json`);
  const modpackErrors = [];
  const forgePath = forgeVersion ? path.join(versionsDir, forgeVersion, `${forgeVersion}.json`) : null;
  const forgeInstallerPath = getForgeInstallerPath(installDir, forgeVersion);

  const modsPath = path.join(modpackDir, 'mods');
  await fsp.mkdir(modpackDir, { recursive: true });
  await fsp.mkdir(modsPath, { recursive: true });
  const modDirectories = uniquePaths([modsPath]);

  const minecraftPresent = await fsp
    .access(minecraftPath)
    .then(() => true)
    .catch(() => false);

  const forgePresent = forgePath
    ? await fsp
        .access(forgePath)
        .then(() => true)
        .catch(
          async () =>
            await fsp
              .access(forgeInstallerPath)
              .then(() => true)
              .catch(() => false)
        )
    : await fsp
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
    modpackDiagnostics: {
      modDirectories,
      expectedModpackJar
    },
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

  await ensureLog4jConfig(installDir, onStatus);

  return { minecraftVersion, forgeVersion };
}

async function launchModpack({
  installDir,
  account,
  onStatus = () => {},
  expectedModpackVersion = null,
  memorySettings = {}
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

  const gameDirectory = INSTANCE_DIR;
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
  const log4jConfigPath = await ensureLog4jConfig(installDir, onStatus).catch((error) => {
    throw new Error(`Failed to prepare Log4j configuration: ${error.message}`);
  });

  const jvmArgs = buildJvmArgs(memorySettings, log4jConfigPath);
  const javaExecutable = resolveBundledJava();
  const { major: javaMajor, version: javaVersion } = await detectJavaVersion(javaExecutable);

  if (!javaMajor) {
    onStatus({
      message: 'Unable to determine Java version; launching may fail. Please ensure Java 8 is configured.',
      level: 'warning'
    });
  } else if (![8, 11].includes(javaMajor)) {
    throw new Error(
      `Incompatible Java runtime detected (version ${javaVersion}). Forge 1.16.5 requires Java 8. ` +
        'Please reinstall to include the bundled Java 8 runtime or configure a compatible Java path.'
    );
  } else if (javaMajor === 11) {
    onStatus({
      message: 'Bundled Java 8 not found; using Java 11 fallback. Forge 1.16.5 compatibility may vary.',
      level: 'warning'
    });
  }

  if (!['java', 'javaw'].includes(javaExecutable)) {
    onStatus({ message: `Using bundled Java runtime at ${javaExecutable}` });
  }

  // Build the Forge profile id that matches the modpack:
  // forgeVersion is "1.16.5-36.2.42" → profile folder is "1.16.5-forge-36.2.42"
  const forgeProfileId = `${DEFAULT_MC_VERSION}-forge-${forgeVersion.split('-')[1]}`;

  // Respect custom RAM settings instead of hardcoded values
  const memoryAllocation = calculateMemoryAllocation(memorySettings);

  const launchOptions = {
    // Root ".minecraft" where versions/libraries live
    root: HELLAS_ROOT,

    authorization: auth,

    // Use /Hellas/modpack as the in-game directory
    overrides: {
      gameDirectory
    },

    version: {
      // Vanilla version id from Mojang's manifest
      number: DEFAULT_MC_VERSION,
      type: 'release',

      // Pre-built Forge profile folder under versions/
      // e.g. <HELLAS_ROOT>/versions/1.16.5-forge-36.2.42/...
      custom: forgeProfileId
    },

    // Forge installer / profile to use (resolved earlier)
    forge: resolvedForgeInstaller,

    memory: memoryAllocation,
    customArgs: jvmArgs,

    // if javaExecutable is literally "java" or "javaw", let MCLC resolve it,
    // otherwise pass the full path (your bundled JRE8/11)
    javaPath: ['java', 'javaw'].includes(javaExecutable) ? undefined : javaExecutable
  };

  // Ensure JVM arguments are always a non-null array to satisfy ForgeWrapper expectations.
  if (!Array.isArray(launchOptions.customArgs)) {
    launchOptions.customArgs = [];
  }

  launcher.launch(launchOptions);

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
  ensureMinecraftVersion,
  buildMemoryPlan,
  calculateMemoryAllocation
};
