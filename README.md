# Zen PDF

Zen PDF is a lightweight, offline PDF editor built with Tauri and React. It lets you merge, split, reorder, rotate, compress, and export PDFs — locally on your machine with no network calls.

## Quick Start

- Install dependencies: `npm install`
- Run in development: `npm run dev` (starts Tauri dev with Vite)
- Build a desktop app: `npm run build`

Note for macOS signing: the Tauri config sets a placeholder signing identity. To produce signed binaries, replace the placeholder in `src-tauri/tauri.conf.json:46` with your own Apple Developer ID Application identity or remove the field to sign locally via your keychain settings.

## Platform Builds

### macOS (Intel, x86_64)

- Requirements
  - Xcode Command Line Tools: `xcode-select --install`
  - Rust (via rustup) and Node.js 18+ with npm
  - Tauri CLI: `npm install -g @tauri-apps/cli` (optional; `npm run build` will also invoke it)
- Develop
  - `npm run dev` (runs Vite + Tauri dev)
- Build (unsigned by default)
  - `npm run build` (produces a `.app`/`.dmg` under `src-tauri/target/release`)
  - To sign/notarize, set a valid `signingIdentity` in `src-tauri/tauri.conf.json` or sign via your keychain. Unsigned builds may require removing quarantine: `xattr -dr com.apple.quarantine "Zen PDF.app"`

### Linux (x86_64 and aarch64)

- Requirements
  - Rust (stable) and Node.js 18+ with npm
  - System packages
    - Debian/Ubuntu: `sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf`
    - Arch: `sudo pacman -S --needed webkit2gtk gtk3 libappindicator-gtk3 librsvg patchelf`
- Develop
  - `npm run dev`
- Build bundles
  - `tauri build --bundles appimage,deb` (Debian/Ubuntu) or `tauri build --bundles appimage,rpm` (Fedora/openSUSE)
  - Outputs land under `src-tauri/target/release/bundle/`
- Notes
  - The `dmg` bundle target in `tauri.conf.json` is macOS-only and ignored on Linux. Pass Linux bundles explicitly as above.

### Cross‑arch macOS

- Building Intel binaries from Apple Silicon is not recommended due to Apple toolchain and WebKit constraints. Build natively on an Intel Mac for the best results.

## License

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this project except in compliance with the License.

- License: Apache License 2.0
- Permissions: Commercial use, modification, distribution, and private use.
- Conditions: Preserve license and notices; include NOTICE if provided.
- Limitations: Provided "AS IS" without warranties or conditions.

See `LICENSE` for the full text or visit https://www.apache.org/licenses/LICENSE-2.0
