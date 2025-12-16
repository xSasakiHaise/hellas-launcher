# Platform Normalization for Hellas Launcher

## 1) Executive summary
Hellas Launcher must behave predictably across current and future execution environments, avoiding reliance on host quirks so updates, diagnostics, and play sessions remain reproducible. Normalizing paths, runtime provisioning, and packaging ensures long-term maintainability, controlled runtime behavior, and consistent player outcomes regardless of where the launcher is executed.

## 2) Current launcher architecture (discover & describe)
- **Tech stack:** Electron application driven by Node.js with renderer/preload scripts; uses `electron-builder` for packaging.
- **Entry points & build system:** `src/main/main.js` is the Electron main process entry; `npm run start`/`dev` boot Electron, and `npm run build` uses `electron-builder` to produce artifacts.
- **Runtime lifecycle:** Startup initializes settings and directories, runs update resolution/download, handles authentication, and launches the modpack via Minecraft Launcher Core; renderer communicates through IPC.
- **Storage model:** Install root forced to `%APPDATA%/Hellas` with subdirectories `modpack`, `forge`, and `versions`; behavior and launcher logs are written alongside the executable and in the install root.
- **Update flow:** Update source resolved from environment variables or default feed URL, zip downloaded and extracted into modpack structure with migration of legacy content; supports cancellation.
- **Game launch mechanism:** Modpack launch builds JVM args (memory, log4j config), ensures assets/versions/forge installers, resolves bundled Java runtime, and spawns Minecraft process via `minecraft-launcher-core` with user session and memory plan.
- **Platform-coupled assumptions discovered:**
  - Install path is derived from `APPDATA` and assumes a roaming profile layout.
  - Bundled Java paths point to `javaw.exe` under `jre8`/`jre11` within packaged resources, falling back to `javaw` on the system PATH.
  - `electron-builder` configuration targets Windows portable builds and bundles Windows JREs.
  - JVM process uses Windows-specific executable naming and layout expectations.
  - Directories are created with Windows-oriented path joins and no alternates for other filesystems.
- **Unknowns / needs verification:**
  - UNKNOWN – requires verification: whether renderer UI or preload scripts rely on Windows-specific shell commands; verify by searching for `cmd.exe`, `.bat`, or platform checks in `src/renderer` and `src/preload`.
  - UNKNOWN – requires verification: whether update ZIP contents include platform-specific binaries; verify by inspecting the downloaded archive manifest and any scripts it contains.

## 3) Platform-neutral design rules
1. Never hardcode absolute paths; compute storage roots from a platform-agnostic directory provider and allow override via config when safe.
2. Do not assume platform-specific executables; resolve launchable binaries from bundled metadata keyed by architecture/runtime family.
3. Avoid shell-dependent command construction; use direct process spawning APIs with explicit argument arrays.
4. Never assume file permission defaults; set required permissions explicitly and handle read-only filesystems.
5. Do not rely on system-installed runtimes; provision or fetch controlled runtimes per environment with explicit validation.

**Normalization table**

| Concern | Platform-dependent today | Normalized behavior | Notes |
| --- | --- | --- | --- |
| Install root | Hardcoded `%APPDATA%/Hellas` | Resolve from a platform-agnostic app-data provider with configurable override for tests | Preserve stable subfolders (`modpack`, `forge`, `versions`) regardless of OS |
| Bundled runtime | Windows-only `javaw.exe` paths in `jre8`/`jre11` | Runtime descriptors map platform/arch → executable path; select via metadata, not string literals | Support future runtime families without code changes |
| Packaging target | Windows portable only | Data-driven target list producing native bundles and portable archives per platform | Avoid OS-coded build branches in source |
| Process spawn | Assumes `javaw` naming and Windows layout | Spawn via resolved executable and normalized args; no shell wrappers | Capture stderr/stdout consistently |
| Path joins | Implicit Windows separators | Use platform path utilities and avoid embedding separators in constants | Validate against case sensitivity and reserved names |
| Permissions | Implicit write access under roaming profile | Probe and request writable locations; handle read-only scenarios gracefully | Log explicit failure reasons |
| External dependencies | Assumes system PATH provides Java fallback | Prefer bundled runtime; if fallback is allowed, validate version/architecture explicitly | Record runtime provenance in logs |

## 4) Runtime provisioning strategy
- Ship runtimes as versioned, platform-scoped payloads declared in metadata (e.g., JSON manifest) that maps platform/architecture to a runtime package and executable path.
- Launcher selects runtime based on resolved environment descriptors (OS family, architecture, libc/ABI when relevant) without hardcoded conditionals; selection is purely data-driven.
- If selection fails or runtime validation fails, fallback behavior (e.g., prompt to download runtime or use explicitly allowed system runtime) must be deterministic, user-visible, and logged.
- Runtime metadata resides alongside packaged resources (e.g., `resources/runtime-manifest.json`) and may be refreshed from update feeds; resolution favors packaged data with optional remote overrides after validation.

## 5) Packaging & distribution model
- **Package forms:** Support both native bundles (installer or platform-wrapped executable with resources) and portable archives (zip/tarball) with identical internal layout.
- **Entry executable expectations:** Each package declares a single entry launcher per platform/architecture in metadata; the executable is responsible for bootstrapping updates and selecting runtimes.
- **Resource layout:** Runtimes, assets, and configuration are co-located under a predictable `resources/` subtree with manifest-driven lookups instead of OS-specific directories.
- **Security/trust layers:**
  - Execution trust: signatures or publisher metadata validated before launch where the platform supports it, but trust checks must be abstracted behind a policy interface.
  - User confirmation friction: first-run prompts and update confirmations are driven by launcher policy, not OS-specific dialogs, with consistent messaging across platforms.
  - Distribution integrity: all downloadable artifacts (updates, runtimes, assets) carry checksums and optional signatures validated before use; failures block execution with logged details.

## 6) Normalization work plan
- **Phase 0: Audit & constraint discovery**
  - Touchpoints: search all source files for platform checks, path literals, and executable names; review build configuration and bundled assets.
  - Risks: missing hidden assumptions in update payloads; incomplete manifest coverage.
  - Completion criteria: catalog of all platform-coupled behaviors with owner and remediation notes.
- **Phase 1: Path & filesystem abstraction**
  - Touchpoints: path resolution utilities, storage initialization, logging destinations, update extraction code.
  - Risks: regressions in existing user data locations; migration complexity.
  - Completion criteria: single platform-neutral path provider with tests; no hardcoded absolute paths remain.
- **Phase 2: Runtime isolation**
  - Touchpoints: Java resolver, process spawn code, memory plan and JVM arg builder.
  - Risks: incorrect runtime selection, architecture mismatches, increased package size.
  - Completion criteria: runtime manifest implemented; launcher selects runtimes via metadata with validated version/arch; system runtime usage explicitly gated.
- **Phase 3: Bundle layout definition**
  - Touchpoints: packaging configuration, resource placement, update packaging scripts.
  - Risks: installer/portable divergence; missing resources at runtime.
  - Completion criteria: documented bundle layout with manifests for executables and resources; build artifacts follow the same structure across platforms.
- **Phase 4: Environment validation**
  - Touchpoints: startup checks, update flow, process spawn and logging.
  - Risks: noisy failures on unsupported environments; insufficient diagnostics.
  - Completion criteria: pre-flight validation covering writable paths, runtime presence, architecture compatibility, and network availability with user-facing guidance.
- **Phase 5: Distribution hardening**
  - Touchpoints: update downloader, checksum verification, signature validation, release publishing pipeline.
  - Risks: blocking legitimate updates; increased release complexity.
  - Completion criteria: all artifacts validated before execution; integrity failures surfaced with actionable errors; provenance recorded in logs.

## 7) Failure modes & validation
- **Common cross-platform failure points:** path normalization errors, process spawning failures, insufficient permissions, native library load issues, architecture/runtime mismatches, malformed update archives, inconsistent newline/encoding handling.
- **Validation checklist (apply to any platform):**
  - Resolve app-data root from abstraction and confirm writability.
  - Validate runtime selection against platform/architecture metadata and verify executable exists.
  - Spawn processes without shell interpolation; capture exit codes and output consistently.
  - Ensure downloaded artifacts pass checksum/signature validation before use.
  - Verify file permissions after extraction and adjust when required.
  - Confirm paths avoid reserved names/case collisions and are normalized before use.
  - Validate that memory plans and JVM args are derived from data, not host defaults.
  - Log all selection decisions (paths, runtime, update source) for diagnostics.

## 8) Repo integration & maintenance
- This document lives at `docs/launcher/PLATFORM_NORMALIZATION.md` and must be updated alongside any launcher change that introduces, removes, or modifies platform-sensitive behavior.
- New features must comply with normalization rules: use the path/runtime abstractions, avoid platform branches, and extend manifests instead of hardcoding OS specifics.
- **Non-goals:**
  - No platform-specific feature branching baked into business logic.
  - No OS-named flags, environment variables, or code paths; platform awareness belongs in data and manifest resolution.
