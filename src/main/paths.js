const os = require('os');
const path = require('path');
const fs = require('fs');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const HELLAS_ROOT = path.join(APPDATA, 'Hellas');
const INSTANCE_DIR = path.join(HELLAS_ROOT, 'modpack');

function ensureDirectories(root = HELLAS_ROOT) {
  const modpackDir = path.join(root, 'modpack');
  const forgeDir = path.join(root, 'forge');
  const versionsDir = path.join(root, 'versions');

  for (const dir of [root, modpackDir, forgeDir, versionsDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

ensureDirectories();

module.exports = { APPDATA, HELLAS_ROOT, INSTANCE_DIR, ensureDirectories };
