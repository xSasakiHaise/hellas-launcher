const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;

const { resolveBundledJava } = require('../src/main/javaResolver');

const JAVA_EXECUTABLE = 'javaw.exe';

test('resolveBundledJava prefers bundled Java 8', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hellas-java-path-jre8-'));
  const jre8Bin = path.join(tempDir, 'jre8', 'bin');
  await fsp.mkdir(jre8Bin, { recursive: true });
  const javaPath = path.join(jre8Bin, JAVA_EXECUTABLE);
  await fsp.writeFile(javaPath, '');

  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = tempDir;

  try {
    assert.equal(resolveBundledJava(), javaPath);
  } finally {
    process.resourcesPath = originalResourcesPath;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('resolveBundledJava falls back to bundled Java 11 when Java 8 is missing', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hellas-java-path-jre11-'));
  const jre11Bin = path.join(tempDir, 'jre11', 'bin');
  await fsp.mkdir(jre11Bin, { recursive: true });
  const javaPath = path.join(jre11Bin, JAVA_EXECUTABLE);
  await fsp.writeFile(javaPath, '');

  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = tempDir;

  try {
    assert.equal(resolveBundledJava(), javaPath);
  } finally {
    process.resourcesPath = originalResourcesPath;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('resolveBundledJava uses system Java when no bundles exist', () => {
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = path.join(os.tmpdir(), 'hellas-java-path-none');

  try {
    assert.equal(resolveBundledJava(), 'javaw');
  } finally {
    process.resourcesPath = originalResourcesPath;
  }
});
