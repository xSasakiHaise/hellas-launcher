const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { execFile } = require('child_process');
const { Client } = require('minecraft-launcher-core');
const os = require('os');

const DEFAULT_MC_VERSION = '1.16.5';
const FORGE_METADATA_URL = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const VERSION_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const LOG4J_CONFIG_FILENAME = 'log4j2_112-116.xml';
const LOG4J_CONFIG_URL =
  'https://launcher.mojang.com/v1/objects/02937d122c86ce73319ef9975b58896fc1b491d1/log4j2_112-116.xml';
const launcher = new Client();

function getBundledJavaPath(preferredMajors = [11]) {
  const javaExecutable = process.platform === 'win32' ? 'javaw.exe' : 'java';
  const envPath = process.env.BUNDLED_JAVA_PATH
    ? path.resolve(process.env.BUNDLED_JAVA_PATH)
    : null;

  const runtimeRoots = preferredMajors.flatMap((major) => {
    const folderName = major === 8 ? 'jre8' : `jre${major}`;
    const devFolderName = process.platform === 'win32' ? `${folderName}-win64` : folderName;

    return [
      process.resourcesPath ? path.join(process.resourcesPath, folderName) : null,
      path.join(__dirname, '..', '..', devFolderName)
    ];
  });

  const candidatePaths = [];

  if (envPath) {
    candidatePaths.push(envPath);
    candidatePaths.push(path.join(envPath, 'bin', javaExecutable));
    candidatePaths.push(
      path.join(envPath, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    );
  }

  for (const runtimeRoot of runtimeRoots) {
    if (!runtimeRoot) continue;
    candidatePaths.push(path.join(runtimeRoot, 'bin', javaExecutable));
    if (process.platform === 'win32') {
      candidatePaths.push(path.join(runtimeRoot, 'bin', 'java.exe'));
    }
  }

  for (const candidate of candidatePaths) {
    if (!candidate || !fs.existsSync(candidate)) {
      continue;
    }

    try {
      const stats = fs.statSync(candidate);
      if (stats.isFile()) {
        return candidate;
      }
    } catch (error) {
      // Ignore filesystem errors and continue to the next candidate.
    }
  }

  return null;
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
  await fsp.mkdir(installDir, { recursive: true });
}

function getForgeInstallerPath(installDir, forgeVersion) {
  if (!forgeVersion) return null;

  return path.join(installDir, 'forge', forgeVersion, `forge-${forgeVersion}-installer.jar`);
}

async function findGameDirectory(installDir) {
  const modpackDir = path.join(installDir, 'modpack');
  try {
    await fsp.mkdir(modpackDir, { recursive: true });
    return modpackDir;
  } catch (error) {
    // Fall back to the legacy detection logic below if we cannot create the modpack directory.
    // This preserves compatibility for custom setups while still preferring the modpack path.
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

async function ensureLog4jConfig(installDir, onStatus) {
  const log4jPath = path.join(installDir, LOG4J_CONFIG_FILENAME);
  const exists = await fsp
    .stat(log4jPath)
    .then((stats) => stats.isFile())
    .catch(() => false);

  if (exists) {
    return log4jPath;
  }

  onStatus?.({ message: 'Downloading Log4j configuration…' });
  await downloadToFile(LOG4J_CONFIG_URL, log4jPath, onStatus);

  return log4jPath;
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
  const log4jConfigPath = await ensureLog4jConfig(installDir, onStatus).catch((error) => {
    throw new Error(`Failed to prepare Log4j configuration: ${error.message}`);
  });
  const jvmArgs = buildJvmArgs(memorySettings, log4jConfigPath);
  // Forge 1.16.5 is most stable on Java 8, so prefer a bundled Java 8 runtime when available
  // while still accepting Java 11 for environments that do not ship Java 8.
  let javaPath = getBundledJavaPath([8, 11]);
  if (!javaPath) {
    onStatus({
      message: 'Bundled Java runtime not found; falling back to system Java. Compatibility not guaranteed.',
      level: 'warning'
    });
  }

  let javaExecutable = javaPath || 'java';
  let { major: javaMajor, version: javaVersion } = await detectJavaVersion(javaExecutable);

  let javaCompatibilityWarning = null;
  if (javaMajor === 11) {
    const java8Fallback = getBundledJavaPath([8]);
    if (java8Fallback) {
      onStatus({
        message: 'Detected Java 11; switching to bundled Java 8 for better Forge 1.16.5 compatibility.'
      });
      javaExecutable = java8Fallback;
      javaPath = java8Fallback;
      ({ major: javaMajor, version: javaVersion } = await detectJavaVersion(javaExecutable));
    } else {
      javaCompatibilityWarning =
        'Java 11 detected without a bundled Java 8 runtime; continuing but Forge 1.16.5 may be unstable.';
    }
  }

  if (javaExecutable && javaExecutable !== 'java') {
    onStatus({ message: `Using bundled Java runtime at ${javaExecutable}` });
  }
  if (javaMajor && ![8, 11].includes(javaMajor)) {
    throw new Error(
      `Incompatible Java runtime detected (version ${javaVersion}). Forge 1.16.5 requires Java 8. ` +
        'Please reinstall to include the bundled Java 8 runtime or configure a compatible Java path.'
    );
  }

  if (javaCompatibilityWarning) {
    onStatus({ message: javaCompatibilityWarning, level: 'warning' });
  }

  if (!javaMajor) {
    onStatus({
      message: 'Unable to determine Java version; launching may fail. Please ensure Java 8 is configured.',
      level: 'warning'
    });
  }

  const launchOptions = {
    root: installDir,
    authorization: auth,
    gameDirectory,
    version: {
      number: DEFAULT_MC_VERSION,
      type: 'release'
    },
    forge: resolvedForgeInstaller,
    memory: calculateMemoryAllocation(memorySettings),
    customArgs: jvmArgs,
    javaPath: javaExecutable === 'java' ? undefined : javaExecutable
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
  calculateMemoryAllocation,
  getBundledJavaPath
};
