# Hellas Launcher Manifest

WordPress plugin for hosting the Hellas Launcher MC 1.21.1 update metadata.

MC 1.16.5 is intentionally not handled here. Keep the old WordPress plugin in charge of the legacy 1.16.5 update feed and compact ZIP endpoint.

## Endpoints

- `/wp-json/hellas-launcher-1211/v1/manifest` returns the MC 1.21.1 manifest.
- `/wp-json/hellas-launcher-1211/v1/manifest/mc-1.21.1` returns the MC 1.21.1 profile.
- `/wp-json/hellas-launcher-1211/v1/manifest/1.21.1` returns the same MC 1.21.1 profile.

## Manifest Shape

The profile can provide individual managed mod links:

```json
{
  "schemaVersion": 2,
  "profiles": {
    "mc-1.21.1": {
      "minecraftVersion": "1.21.1",
      "forgeVersion": "1.21.1-52.1.0",
      "javaMajor": 21,
      "version": "1.0.0",
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

Configure the launcher with `PACK_MANIFEST_URL_1_21_1=https://example.com/wp-json/hellas-launcher-1211/v1/manifest`.
