# Zen PDF

Zen PDF is a lightweight, offline PDF editor built with Tauri and React. It lets you merge, split, reorder, rotate, compress, and export PDFs — locally on your machine with no network calls.

## Quick Start

- Install dependencies: `npm install`
- Run in development: `npm run dev` (starts Tauri dev with Vite)
- Build a desktop app: `npm run build`

Note for macOS signing: the Tauri config sets a placeholder signing identity. To produce signed binaries, replace the placeholder in `src-tauri/tauri.conf.json:46` with your own Apple Developer ID Application identity or remove the field to sign locally via your keychain settings.

## License

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this project except in compliance with the License.

- License: Apache License 2.0
- Permissions: Commercial use, modification, distribution, and private use.
- Conditions: Preserve license and notices; include NOTICE if provided.
- Limitations: Provided "AS IS" without warranties or conditions.

See `LICENSE` for the full text or visit https://www.apache.org/licenses/LICENSE-2.0
