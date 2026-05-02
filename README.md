# gcp-oauth-automator

Automate Google OAuth 2.0 client setup in GCP's **Google Auth Platform** using Playwright. One command, zero manual clicks. Works on **Windows, macOS, and Linux**.

## Two modes

| Mode | When to use |
|------|-------------|
| `create` | New project — no OAuth client yet |
| `renew` | Client exists but secret is lost/placeholder, or needs rotating |

## How it works

1. Launches Google Chrome with a dedicated automation profile (your real Chrome is untouched)
2. On first run: Chrome opens visibly → you sign in once → session saved permanently
3. On subsequent runs: fully automatic, no user interaction needed
4. Outputs `{"clientId":"...","clientSecret":"GOCSPX-..."}` as JSON to stdout

> **Note on Google's UI:** Google's new Auth Platform UI masks OAuth secrets immediately after creation. This script handles that by clicking the "Add secret" button on the client detail page, which generates a new visible secret. Old secrets remain valid until explicitly revoked.

## Platform support

| OS | Status |
|----|--------|
| macOS | ✅ Supported |
| Windows | ✅ Supported |
| Linux | ✅ Supported |

## Requirements

- **Node.js 18+** — https://nodejs.org
- **Google Chrome** — https://www.google.com/chrome/
- **npm** (comes with Node.js)
- **gcloud CLI** — only needed for `create` mode — https://cloud.google.com/sdk/docs/install

## Setup

```bash
git clone https://github.com/Z1Code/gcp-oauth-automator
cd gcp-oauth-automator
npm install
```

## Usage

### `renew` mode — rotate credentials on an existing project

Only needs the GCP project ID.

```bash
node scripts/oauth-client.mjs renew 'my-project-id'
```

Output:
```json
{"clientId":"292997751497-xxxx.apps.googleusercontent.com","clientSecret":"GOCSPX-xxxx"}
```

### `create` mode — create a new OAuth client from scratch

Requires: GCP project ID, app name, redirect URI, support email.
Also requires `gcloud` CLI to be installed and authenticated.

```bash
# 1. Create GCP project
gcloud projects create my-project-id --name="My App"
gcloud config set project my-project-id

# 2. Enable required APIs
#    Do NOT enable oauth2.googleapis.com — it's an internal GCP service and will fail
gcloud services enable people.googleapis.com cloudresourcemanager.googleapis.com --project=my-project-id

# 3. Run the script
node scripts/oauth-client.mjs create 'my-project-id' 'My App' 'https://myapp.com/api/auth/callback/google' 'owner@example.com'
```

### Windows (PowerShell)

```powershell
# Renew
node scripts/oauth-client.mjs renew 'my-project-id'

# Create
node scripts/oauth-client.mjs create 'my-project-id' 'My App' 'https://myapp.com/api/auth/callback/google' 'owner@example.com'
```

## Inject credentials into your project

### Auth.js v5 (next-auth@beta)

```env
AUTH_GOOGLE_ID=292997751497-xxxx.apps.googleusercontent.com
AUTH_GOOGLE_SECRET=GOCSPX-xxxx
```

### Custom / legacy

```env
GOOGLE_OAUTH_CLIENT_ID=292997751497-xxxx.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-xxxx
```

### VPS (PM2 / ecosystem.config.js)

> ⚠️ Don't use `sed` to edit `ecosystem.config.js` — it creates double commas `,,` when a line already ends with `,`. Edit the file directly.

```bash
# Edit ecosystem.config.js manually, then:
pm2 restart myapp --update-env
```

## Parse JSON output in scripts

```bash
# Bash
CLIENT_ID=$(node scripts/oauth-client.mjs renew 'project' | python3 -c "import sys,json; print(json.load(sys.stdin)['clientId'])")
CLIENT_SECRET=$(node scripts/oauth-client.mjs renew 'project' | python3 -c "import sys,json; print(json.load(sys.stdin)['clientSecret'])")
```

```js
// Node.js
import { execSync } from 'child_process';
const { clientId, clientSecret } = JSON.parse(
  execSync("node scripts/oauth-client.mjs renew my-project").toString()
);
```

## Redirect URI

For Auth.js v5, the callback path must be:
```
https://yourdomain.com/api/auth/callback/google
```

## Chrome automation profile

The script uses a dedicated profile at `~/.claude-skills/oauth/chrome-profile` (separate from your real Chrome profile). This avoids conflicts with Google's DBSC (Device Bound Session Credentials).

## Debugging

Screenshots are saved automatically at each step:
- `/tmp/gcp-oauth-*.png` on macOS/Linux
- `%TEMP%\gcp-oauth-*.png` on Windows

Logs go to `/tmp/oauth.log` (or `%TEMP%\oauth.log` on Windows) when you redirect stderr:
```bash
node scripts/oauth-client.mjs renew 'project' 2>/tmp/oauth.log
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Chrome not found` | Install from https://www.google.com/chrome/ |
| Chrome not found on Linux | `sudo apt install google-chrome-stable` |
| `clientSecret` is empty | Chrome session expired — sign in when Chrome opens, then rerun |
| `oauth2.googleapis.com` enable fails | Skip it — it's internal. Only enable `people.googleapis.com` |
| `Could not find OAuth client` | No clients exist in this project — use `create` mode |
| Script crashes | Check log file for full stack trace |

## Using with AI assistants (ChatGPT, Claude, Gemini, etc.)

Run the script manually, then paste the JSON output into your conversation:

```
Here are my OAuth credentials: {"clientId":"...","clientSecret":"GOCSPX-..."}
Please inject them into my ecosystem.config.js.
```

For Claude Code users, a `/oauth` skill wrapper is available that automates this entire workflow including credential injection.

## Security notes

- The automation Chrome profile stores your Google session — keep `~/.claude-skills/oauth/chrome-profile` private
- `renew` mode generates a **new** secret — old secrets remain valid until you revoke them in GCP Console
- OAuth credentials have no expiry — rotate only if compromised
- Never commit credentials to git — use environment variables or secrets managers

## License

MIT
