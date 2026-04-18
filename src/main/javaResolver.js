const path = require('path');
const fs = require('fs');

function firstExistingPath(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function normalizeJavaExecutable(candidate) {
  if (!candidate) {
    return null;
  }

  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    const javaw = path.join(candidate, 'bin', 'javaw.exe');
    if (fs.existsSync(javaw)) {
      return javaw;
    }
  }

  return candidate;
}

function resolveBundledJava(profile = null) {
  const resourcesPath = process.resourcesPath;
  const javaConfig = profile?.java || {};
  const envOverride = firstExistingPath(
    (javaConfig.envVars || [])
      .map((key) => process.env[key])
      .map(normalizeJavaExecutable)
      .filter(Boolean)
  );

  if (envOverride) {
    console.log('[Hellas] Using configured Java runtime:', envOverride);
    return envOverride;
  }

  const bundledDirs = javaConfig.bundledDirs?.length ? javaConfig.bundledDirs : ['jre8', 'jre11'];
  for (const bundledDir of bundledDirs) {
    const javaPath = path.join(resourcesPath, bundledDir, 'bin', 'javaw.exe');
    if (fs.existsSync(javaPath)) {
      console.log(`[Hellas] Using bundled Java runtime (${bundledDir}):`, javaPath);
      return javaPath;
    }
  }

  const fallbackPaths = ['jre8', 'jre11', 'jre21']
    .filter((bundledDir) => !bundledDirs.includes(bundledDir))
    .map((bundledDir) => path.join(resourcesPath, bundledDir, 'bin', 'javaw.exe'));
  const fallback = firstExistingPath(fallbackPaths);
  if (fallback && profile?.java?.major !== 21) {
    console.log('[Hellas] Using fallback bundled Java runtime:', fallback);
    return fallback;
  }

  console.log('[Hellas] No matching bundled JRE found, using system Java');
  return 'javaw';
}

module.exports = { resolveBundledJava };
