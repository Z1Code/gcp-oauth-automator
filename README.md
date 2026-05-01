# gcp-oauth-automator

Automate Google OAuth 2.0 Web Client ID creation in GCP's **Google Auth Platform** using Playwright on macOS — one command, zero manual clicks.

## What it does

1. Opens Chrome with a dedicated automation profile (one-time sign-in, then fully headless)
2. Navigates GCP's Google Auth Platform UI (`/auth/` paths)
3. Runs the 4-step consent screen wizard (App info → Audience → Contact → Finalize)
4. Creates a **Web Application** OAuth client with your redirect URI
5. Outputs `{"clientId":"...","clientSecret":"GOCSPX-..."}` as JSON to stdout

## Platform

| OS | Status |
|----|--------|
| macOS | ✅ Supported |
| Linux | 🚧 Planned |
| Windows | 🚧 Planned |

## Requirements

- macOS with Google Chrome installed
- Node.js 18+
- A Google account with access to Google Cloud Console

## Setup

```bash
git clone https://github.com/Z1Code/gcp-oauth-automator
cd gcp-oauth-automator
npm install
npx playwright install chromium
```

## Usage

```bash
node scripts/create-oauth-client.mjs \
  'my-gcp-project-id' \
  'My App Name' \
  'https://myapp.com/auth/callback' \
  'support@myapp.com'
```

**Output:**
```json
{"clientId":"123456789-abc.apps.googleusercontent.com","clientSecret":"GOCSPX-xxxxx"}
```

## First run

On first run, Chrome opens visibly and shows Google Cloud Console. Sign in once — your session is saved to `chrome-profile/` and all subsequent runs complete without any user interaction.

## Technical notes

- GCP's new UI uses `cfc-select` (custom Angular component), not `mat-select` — this script handles it correctly
- 12-second propagation delay after consent screen creation (GCP backend requirement)
- JS `evaluate()` clicks for `mat-option` to avoid overlay interception
- Credentials extracted via `Información y resumen` info panel (new GCP UI pattern)

## License

MIT
