const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;

const { getBundledJavaPath } = require('../src/main/launcher');

function javaExecutableName() {
  return process.platform === 'win32' ? 'javaw.exe' : 'java';
}

test('getBundledJavaPath respects a direct executable path via BUNDLED_JAVA_PATH', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hellas-java-path-exec-'));
  const javaPath = path.join(tempDir, javaExecutableName());
  await fsp.writeFile(javaPath, '');
  const originalEnv = process.env.BUNDLED_JAVA_PATH;
  process.env.BUNDLED_JAVA_PATH = javaPath;

  try {
    assert.equal(getBundledJavaPath(), javaPath);
  } finally {
    process.env.BUNDLED_JAVA_PATH = originalEnv;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('getBundledJavaPath resolves a directory provided via BUNDLED_JAVA_PATH', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hellas-java-path-dir-'));
  const javaDir = path.join(tempDir, 'jre');
  const binDir = path.join(javaDir, 'bin');
  await fsp.mkdir(binDir, { recursive: true });
  const javaPath = path.join(binDir, javaExecutableName());
  await fsp.writeFile(javaPath, '');

  const originalEnv = process.env.BUNDLED_JAVA_PATH;
  process.env.BUNDLED_JAVA_PATH = javaDir;

  try {
    assert.equal(getBundledJavaPath(), javaPath);
  } finally {
    process.env.BUNDLED_JAVA_PATH = originalEnv;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});
