const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const repoRoot = path.resolve(__dirname, '..');

const RUNTIMES = [
  {
    label: 'Java 8',
    zipPath: path.join(repoRoot, 'build-deps', 'jre8-win-x64.zip'),
    targetDir: path.join(repoRoot, 'jre8-win64')
  },
  {
    label: 'Java 11',
    zipPath: path.join(repoRoot, 'build-deps', 'jre11-win-x64.zip'),
    targetDir: path.join(repoRoot, 'jre11-win64')
  }
];

const EXECUTABLE_NAMES = new Set(['javaw.exe', 'java.exe', 'java']);

async function pathExists(target) {
  try {
    await fs.promises.access(target);
    return true;
  } catch (error) {
    return false;
  }
}

async function findExecutable(startDir) {
  const queue = [startDir];
  while (queue.length) {
    const current = queue.shift();
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
      } else if (EXECUTABLE_NAMES.has(entry.name.toLowerCase())) {
        return entryPath;
      }
    }
  }
  return null;
}

async function hasBundledRuntime(targetDir) {
  for (const name of EXECUTABLE_NAMES) {
    if (await pathExists(path.join(targetDir, 'bin', name))) {
      return true;
    }
  }
  return false;
}

async function extractRuntime(zipPath, targetDir, label) {
  if (!(await pathExists(zipPath))) {
    throw new Error(
      `${label} runtime archive not found at ${zipPath}. Place the ZIP in build-deps/ or run build.ps1 to download it.`
    );
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hellas-jre-'));
  try {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(tempDir, true);

    const executablePath = await findExecutable(tempDir);
    if (!executablePath) {
      throw new Error(`${label} runtime archive did not contain a Java executable.`);
    }

    const javaHome = path.dirname(path.dirname(executablePath));
    await fs.promises.rm(targetDir, { recursive: true, force: true });
    await fs.promises.mkdir(targetDir, { recursive: true });
    await fs.promises.cp(javaHome, targetDir, { recursive: true });
    console.log(`[bundle-jre] Bundled ${label} runtime into ${targetDir}.`);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  for (const runtime of RUNTIMES) {
    const alreadyBundled = await hasBundledRuntime(runtime.targetDir);
    if (alreadyBundled) {
      console.log(`[bundle-jre] ${runtime.label} already present in ${runtime.targetDir}.`);
      continue;
    }

    console.log(`[bundle-jre] Preparing ${runtime.label} runtime for packaging...`);
    await extractRuntime(runtime.zipPath, runtime.targetDir, runtime.label);
  }
}

main().catch((error) => {
  console.error('[bundle-jre] Failed to bundle Java runtime:', error.message);
  process.exit(1);
});
