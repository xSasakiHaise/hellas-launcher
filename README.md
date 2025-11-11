# Hellas Launcher (MVP)

Hellas Launcher is a Windows portable Electron application for the Hellas Region Minecraft community. The MVP focuses on a rich UI-first experience with the animated **Aetherveil** background, launcher gating behind the Terms & Conditions acknowledgement, and a self-service updater that can pull a curated modpack ZIP directly from `hellasregion.com`.

## Features

- 🎥 **Aetherveil background** — VP9 + alpha with MP4/PNG fallbacks and persistent animation toggle.
- 🔗 **Quick links** — open the main website or Dynmap directly from the launcher shell.
- ✅ **T&C gate** — Start button is disabled until the user acknowledges the Terms & Conditions checkbox.
- 🧭 **Smart INSTALL/PLAY** — Detects the `%AppData%\\Hellas` game data directory and creates it on first run.
- ⬆️ **One-click updater** — Downloads a ZIP payload from a hidden link on `hellasregion.com` and extracts it over the install directory while leaving unrelated files untouched.
- 🧪 **Windows portable build** — Bundle the launcher as `dist/Hellas Launcher.exe` via `electron-builder`.

## Prerequisites

- Windows 10/11
- [Node.js LTS (>=18)](https://nodejs.org/en/download)
- PowerShell with script execution enabled in the repository directory

## Quick start

```powershell
# Clone the repository
cd path\to\workspace

# Copy the environment template and edit the values
Copy-Item .env.example .env
notepad .env

# Install dependencies and build the portable EXE
./build.ps1
```

The resulting executable is placed in `dist/Hellas Launcher.exe`.

## Environment variables

The launcher reads configuration from `.env`. See `.env.example` for the full list of options. At minimum you should set `WEBSITE_URL`, `DYNMAP_URL`, and either `PACK_FEED_URL` or `PACK_ZIP_URL`.

## Development

```bash
npm install
npm run dev
```

While developing, background assets are loaded from `assets/bg/` and must include:

- `aetherveil-bg.webm`
- `aetherveil-bg.mp4`
- `aetherveil-fallback.png`

The repository ships with lightweight placeholder files for these assets so the UI renders out of the box. Replace them with the production-grade **Aetherveil** renders before distributing the launcher. The launcher icon at `assets/icons/icon.png` is also a plain-text placeholder; drop in your final PNG before building release artifacts.

## License

Released under the [MIT License](./LICENSE).
