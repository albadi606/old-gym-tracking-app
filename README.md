# Gym Tracker

Gym Tracker is a mobile-friendly workout journal with an equipment catalog, cardio and strength logging, workout history, progress reports, and backup and restore. New installations include an editable sample routine and generic equipment images.

## Run locally

Install Node.js 24.15 or newer in the Node.js 24 LTS line and pnpm 9, then run:

\`\`\`sh
pnpm install --frozen-lockfile
pnpm dev
\`\`\`

Open the local URL printed by Vite. To build and verify the app:

\`\`\`sh
pnpm run build
pnpm run lint
pnpm test
pnpm run assets:check
pnpm run icons:check
pnpm exec playwright install chromium
pnpm run test:e2e
\`\`\`

## Data and backups

The app stores workouts, preferences, and photos in the current browser's IndexedDB. It runs without an account or backend and works offline after installation. Use Settings to export or restore a backup. Backup files contain your records and photos in readable JSON. Keep them somewhere private.

The sample image sources are in \`source-assets/machines/\`. Run \`pnpm run assets:build\` to regenerate their WebP variants and manifest.

## Hosting

Serve the \`dist/\` folder over HTTPS, return \`index.html\` for client-side routes, and give \`/sw.js\` a short cache lifetime so the browser can find updates.
