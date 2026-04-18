# Hellas Launcher Manifest

WordPress plugin for hosting Hellas Launcher update metadata.

## Endpoints

- `/wp-json/hellas-launcher/v1/manifest` returns the full multi-profile manifest.
- `/wp-json/hellas-launcher/v1/manifest/mc-1.16.5` returns one profile.
- `/wp-json/hellas-launcher/v1/latest` returns the old launcher `{ version, url, sha256 }` response.
- `/download/launcher/latest/compact` returns the same old launcher response through a rewrite rule.

## Manifest Shape

Each profile can provide a legacy archive URL and/or individual managed mod links:

```json
{
  "schemaVersion": 2,
  "profiles": {
    "mc-1.16.5": {
      "minecraftVersion": "1.16.5",
      "forgeVersion": "1.16.5-36.2.42",
      "javaMajor": 8,
      "version": "1.0.0",
      "url": "https://example.com/legacy-modpack.zip",
      "sha256": "",
      "mods": [
        {
          "id": "example-mod",
          "fileName": "example-mod.jar",
          "url": "https://example.com/example-mod.jar",
          "sha256": ""
        }
      ]
    }
  }
}
```

The old compatibility endpoints use the MC 1.16.5 `url`, `version`, and `sha256` fields.
