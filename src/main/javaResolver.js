const path = require('path');
const fs = require('fs');

function resolveBundledJava() {
  const resourcesPath = process.resourcesPath;

  const jre8 = path.join(resourcesPath, 'jre8', 'bin', 'javaw.exe');
  if (fs.existsSync(jre8)) {
    console.log('[Hellas] Using bundled Java 8:', jre8);
    return jre8;
  }

  const jre11 = path.join(resourcesPath, 'jre11', 'bin', 'javaw.exe');
  if (fs.existsSync(jre11)) {
    console.log('[Hellas] Bundled Java 8 missing, fallback to Java 11:', jre11);
    return jre11;
  }

  console.log('[Hellas] No bundled JRE found → using system Java');
  return 'javaw';
}

module.exports = { resolveBundledJava };
