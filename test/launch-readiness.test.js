const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;

const FORGE_VERSION = '1.16.5-99.99.99';

const fetchModulePath = require.resolve('node-fetch');
require.cache[fetchModulePath] = {
  id: fetchModulePath,
  filename: fetchModulePath,
  loaded: true,
  exports: async (_url) => ({
    ok: true,
    text: async () =>
      `<metadata><versioning><versions><version>${FORGE_VERSION}</version></versions></versioning></metadata>`,
    json: async () => ({})
  })
};

const { checkLaunchRequirements } = require('../src/main/launcher');

async function createBaseInstall(dir, { modpackVersion = '1.0.0', includeModpack = true } = {}) {
  const minecraftDir = path.join(dir, 'versions', '1.16.5');
  await fsp.mkdir(minecraftDir, { recursive: true });
  await fsp.writeFile(path.join(minecraftDir, '1.16.5.json'), '{}', 'utf8');
  await fsp.writeFile(path.join(minecraftDir, '1.16.5.jar'), '');

  const forgeDir = path.join(dir, 'versions', FORGE_VERSION);
  await fsp.mkdir(forgeDir, { recursive: true });
  await fsp.writeFile(path.join(forgeDir, `${FORGE_VERSION}.json`), '{}', 'utf8');

  if (includeModpack) {
    const modsDir = path.join(dir, 'modpack', 'mods');
    await fsp.mkdir(modsDir, { recursive: true });
    await fsp.writeFile(path.join(modsDir, `hellasforms-${modpackVersion}.jar`), '');
  }
}

test('checkLaunchRequirements returns ready when files are present', async () => {
  const installDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hellas-launcher-ready-'));

  try {
    await createBaseInstall(installDir, { modpackVersion: '1.0.0', includeModpack: true });

    const result = await checkLaunchRequirements(installDir, '1.0.0');

    assert.deepEqual(result.requirements, {
      minecraft: true,
      forge: true,
      modpack: true
    });
    assert.equal(result.modpackVersion, '1.0.0');
  } finally {
    await fsp.rm(installDir, { recursive: true, force: true });
  }
});

test('checkLaunchRequirements reports missing modpack', async () => {
  const installDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hellas-launcher-missing-'));

  try {
    await createBaseInstall(installDir, { includeModpack: false });

    const result = await checkLaunchRequirements(installDir, '1.0.0');

    assert.equal(result.requirements.minecraft, true);
    assert.equal(result.requirements.forge, true);
    assert.equal(result.requirements.modpack, false);
  } finally {
    await fsp.rm(installDir, { recursive: true, force: true });
  }
});

test('checkLaunchRequirements handles filesystem access errors without throwing', async () => {
  const installDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hellas-launcher-access-'));

  let accessMock;
  try {
    await createBaseInstall(installDir, { modpackVersion: '2.0.0', includeModpack: true });
    const originalAccess = fsp.access;
    accessMock = mock.method(fs.promises, 'access', async (targetPath, ...args) => {
      if (targetPath.endsWith(path.join('1.16.5', '1.16.5.json'))) {
        const error = new Error('Permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalAccess.call(fsp, targetPath, ...args);
    });

    const result = await checkLaunchRequirements(installDir, '2.0.0');

    assert.equal(result.requirements.minecraft, false);
    assert.equal(result.requirements.forge, true);
    assert.equal(result.requirements.modpack, true);
  } finally {
    accessMock?.mock.restore();
    await fsp.rm(installDir, { recursive: true, force: true });
  }
});
