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

## Uploading Mods

The settings page includes an **Upload MC 1.21.1 Mods** area.

Uploaded `.jar` and `.zip` files are saved under:

```text
wp-content/uploads/hellas-launcher/1.21.1/mods
```

Each uploaded file is automatically added to:

```text
profiles.mc-1.21.1.mods
```

The plugin stores:

- `id`
- `fileName`
- `url`
- `sha256`

The primary uploader sends every selected file in 5 MB chunks through:

```text
/wp-json/hellas-launcher-1211/v1/upload-chunk
```

This avoids one large all-or-nothing POST and makes batches of many mods more reliable. Keep the admin page open until each selected file shows as completed.

The plugin does not impose an overall file size limit. Each request is still limited by PHP, WordPress, and web server settings such as `upload_max_filesize`, `post_max_size`, Nginx `client_max_body_size`, Apache limits, or host-level limits. Because the chunk size is 5 MB, those server limits must allow requests slightly larger than 5 MB.

Configure the launcher with `PACK_MANIFEST_URL_1_21_1=https://example.com/wp-json/hellas-launcher-1211/v1/manifest`.
