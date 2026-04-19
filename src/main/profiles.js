const path = require('path');
const { HELLAS_ROOT } = require('./paths');

const LEGACY_PROFILE_ID = 'mc-1.16.5';

const PROFILE_DEFINITIONS = [
  {
    id: LEGACY_PROFILE_ID,
    label: 'MC 1.16.5',
    minecraftVersion: '1.16.5',
    forgeVersion: '1.16.5-36.2.42',
    manifestKey: '1.16.5',
    legacy: true,
    update: {
      url: 'https://hellasregion.com/download/launcher/latest/compact'
    },
    java: {
      major: 8,
      allowedMajors: [8, 11],
      envVars: ['JAVA8_PATH', 'JAVA_8_PATH'],
      bundledDirs: ['jre8', 'jre11']
    }
  },
  {
    id: 'mc-1.21.1',
    label: 'MC 1.21.1',
    minecraftVersion: '1.21.1',
    forgeVersion: '1.21.1-52.1.0',
    manifestKey: '1.21.1',
    installDirName: path.join('profiles', 'mc-1.21.1'),
    update: {
      manifestUrl: 'https://hellasregion.com/wp-json/hellas-launcher-1211/v1/manifest'
    },
    java: {
      major: 21,
      allowedMajors: [21],
      envVars: ['JAVA21_PATH', 'JAVA_21_PATH'],
      bundledDirs: ['jre21']
    }
  }
];

function withResolvedPaths(definition) {
  const rootDir = definition.legacy
    ? HELLAS_ROOT
    : path.join(HELLAS_ROOT, definition.installDirName || definition.id);

  return {
    ...definition,
    rootDir,
    installDir: rootDir,
    instanceDir: path.join(rootDir, 'modpack'),
    forgeDir: path.join(rootDir, 'forge'),
    versionsDir: path.join(rootDir, 'versions')
  };
}

const PROFILES = PROFILE_DEFINITIONS.map(withResolvedPaths);

function getProfiles() {
  return PROFILES.map((profile) => ({ ...profile, java: { ...profile.java } }));
}

function normalizeProfileId(profileId) {
  const raw = typeof profileId === 'string' ? profileId.trim() : '';
  if (!raw) {
    return LEGACY_PROFILE_ID;
  }

  const found = PROFILES.find(
    (profile) =>
      profile.id === raw ||
      profile.minecraftVersion === raw ||
      profile.manifestKey === raw ||
      profile.id.toLowerCase() === raw.toLowerCase()
  );

  return found ? found.id : LEGACY_PROFILE_ID;
}

function getProfile(profileId) {
  const normalized = normalizeProfileId(profileId);
  const profile = PROFILES.find((entry) => entry.id === normalized) || PROFILES[0];
  return { ...profile, java: { ...profile.java } };
}

function getProfileSummary(profile) {
  return {
    id: profile.id,
    label: profile.label,
    minecraftVersion: profile.minecraftVersion,
    forgeVersion: profile.forgeVersion,
    javaMajor: profile.java.major,
    installDir: profile.installDir,
    instanceDir: profile.instanceDir,
    legacy: Boolean(profile.legacy)
  };
}

function envSuffixForProfile(profile) {
  return profile.minecraftVersion.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toUpperCase();
}

function getProfileEnv(profile, baseName) {
  const suffix = envSuffixForProfile(profile);
  const profileIdSuffix = profile.id.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toUpperCase();
  const candidates = [`${baseName}_${suffix}`, `${baseName}_${profileIdSuffix}`, baseName];

  for (const key of candidates) {
    const value = (process.env[key] || '').trim();
    if (value) {
      return value;
    }
  }

  return '';
}

module.exports = {
  LEGACY_PROFILE_ID,
  getProfile,
  getProfiles,
  getProfileSummary,
  getProfileEnv,
  normalizeProfileId
};
