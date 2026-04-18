# Hellas Launcher

This repository now contains the reconstructed `1.0.0` launcher source from the current Desktop build.

The Desktop executable at `C:\Users\raehr\Desktop\Hellas Launcher.exe` was copied into `deconstructed/desktop-1.0.0` and only the copy was unpacked. The Desktop file itself was not modified.

## What 1.0.0 Contains

- A full Electron launcher UI with the real Aetherveil background assets.
- Microsoft device-code login and Minecraft ownership verification.
- Install readiness checks for Minecraft, Forge, and the modpack.
- Minecraft launch flow via `minecraft-launcher-core`.
- Bundled Java runtime resolution with Java 8 and Java 11 fallbacks.
- RAM allocation settings.
- Update cancelation, fresh reinstall, Java 8 reinstall, install-folder opening, and launcher logs.

## Runtime Resources

The Desktop build bundled runtime files outside `app.asar`. They are restored under:

```text
runtime-resources/jre8
runtime-resources/jre11
runtime-resources/build-deps
```

The build config copies those folders to `process.resourcesPath` so the existing `javaResolver.js` and `runtime.js` behavior stays compatible with the Desktop version.

## Environment

Copy `.env.example` to `.env` and set values as needed:

```powershell
Copy-Item .env.example .env
notepad .env
```

Important variables:

- `MICROSOFT_CLIENT_ID`
- `PACK_FEED_URL` or `PACK_ZIP_URL`
- `JAVA8_ZIP_PATH`
- `MC_MEMORY_MIN`
- `MC_MEMORY_MAX`

If no update URL is set, the launcher falls back to the built-in compact pack URL used by `1.0.0`.

## Development

```powershell
npm install --package-lock=false
npm run dev
```

## Build

```powershell
.\build.ps1
```

The portable executable is written to:

```text
dist/Hellas Launcher.exe
```

## Deconstruction Notes

The copied Desktop executable and unpacked working files live under `deconstructed/`, which is ignored by git. The source, assets, and runtime resources needed to rebuild the launcher live in the normal repository paths.
