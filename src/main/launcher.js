const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LAUNCH_SCRIPT_CANDIDATES = ['launch.bat', 'start.bat', 'run.bat'];
const MAX_DEPTH = 4;

function findForgeJar(rootDir) {
  const stack = [{ dir: rootDir, depth: 0 }];

  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > MAX_DEPTH) continue;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: fullPath, depth: depth + 1 });
      } else if (/forge.*\.jar$/i.test(entry.name)) {
        return fullPath;
      }
    }
  }

  return null;
}

function findLaunchTarget(installDir) {
  for (const candidate of LAUNCH_SCRIPT_CANDIDATES) {
    const candidatePath = path.join(installDir, candidate);
    if (fs.existsSync(candidatePath)) {
      return { type: 'script', path: candidatePath };
    }
  }

  const forgeJar = findForgeJar(installDir);
  if (forgeJar) {
    return { type: 'jar', path: forgeJar };
  }

  return null;
}

async function launchModpack({ installDir, account }) {
  if (!installDir || !fs.existsSync(installDir)) {
    throw new Error('Install directory is missing. Please install the modpack first.');
  }

  const target = findLaunchTarget(installDir);
  if (!target) {
    throw new Error('Forge modpack entry point not found in the installation directory.');
  }

  const env = {
    ...process.env,
    MC_USERNAME: account.username,
    MC_ACCESS_TOKEN: account.accessToken
  };

  let child;
  if (target.type === 'script') {
    child = spawn(target.path, [], {
      cwd: installDir,
      env,
      shell: true,
      detached: true,
      stdio: 'ignore'
    });
  } else {
    const javaBinary = process.env.JAVA_PATH || 'javaw';
    child = spawn(javaBinary, ['-jar', target.path], {
      cwd: path.dirname(target.path),
      env,
      detached: true,
      stdio: 'ignore'
    });
  }

  child.unref();
  return { launchedWith: target.path };
}

module.exports = { launchModpack };
