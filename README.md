# Band Tools

A Chrome extension for [band.us](https://band.us) groups. Adds three features the web app doesn't surface directly:

| Feature | What it does |
|---------|-------------|
| **My Events** | Lists upcoming events across a configurable date window, with a one-click copy for sharing as plain text |
| **RSVP** | Shows exactly who has and hasn't responded to a private event |
| **Sync Group** | Adds newly-joined group members as sharers on upcoming private events (dry-run first, then apply) |

## Installation

### From the Chrome Web Store *(coming soon)*

### From Firefox Add-ons *(coming soon)*

Both stores are published automatically on every merge to `main` via the `deploy-chrome` and `deploy-firefox` jobs in `.github/workflows/ci.yml`, gated on the `test` job passing. The same jobs are triggerable manually with `workflow_dispatch`. See [Auto-deploy](#auto-deploy) for the secrets you need to configure once.

### Load unpacked (developer mode)
1. Clone this repo, then `npm install && npm run build`
2. Open `chrome://extensions` and enable **Developer mode**
3. Click **Load unpacked** and select the generated `dist/` folder
4. Navigate to your band on [band.us](https://band.us) — the extension auto-detects your band

## First-time setup
1. Make sure you're logged into band.us in Chrome
2. Click the Band Tools icon → open the **Settings** tab
3. Enter your band number (found in the URL: `band.us/band/XXXXXXXX/...`)
4. Click **Load Calendars & Groups** to set defaults

## Permissions
- **cookies** — reads `secretKey` to sign API requests (Band's auth mechanism)
- **tabs** — reads the current tab URL to auto-detect your band number
- **storage** — saves your settings and caches event lists
- **activeTab** — auto-fills RSVP input when viewing an event page
- **https://*.band.us/*** — makes API calls to `api-usw.band.us` and reads cookies

## Privacy
See [PRIVACY.md](PRIVACY.md). No data leaves your browser except to the Band API.

## Development

The service worker uses the [`bandstand`](https://github.com/MitchLillie/bandstand)
API client. `npm run build` bundles `src/background.js` with esbuild and copies the
static files into `dist/` (Chrome) and `dist/firefox/` (Firefox, with the
gecko-id and `background.scripts` swaps required by AMO).

```bash
npm install
npm run build          # -> dist/ and dist/firefox/
npm test               # unit tests (vitest)
npm run e2e             # Chromium E2E (Playwright)
npm run package:chrome  # dist/ -> band-tools-chrome-<version>.zip (no firefox/ inside)
npm run firefox:run    # opens a sandboxed Firefox with dist/firefox loaded
npm run firefox:lint   # web-ext lint against dist/firefox
```

```
band-tools/
  src/background.js     Service worker source (imports bandstand/browser)
  build.js              esbuild bundle + static-file copy -> dist/, dist/firefox/
  scripts/
    package-chrome.js   Pure-Node zip writer for the Chrome Web Store upload
  manifest.json         MV3 manifest (module service worker)
  popup.html/js/css     Toolbar popup UI (General / Admin / Settings tabs)
  content.js            Auto-detects band_no and user identity from the page
  icons/                icon.svg source + PNG icons (16, 48, 128px)
  dist/                 Chrome build (gitignored)
  dist/firefox/         Firefox build (gitignored)
  .github/workflows/ci.yml  test + e2e (PRs/pushes) + deploy-chrome + deploy-firefox
```

## Auto-deploy

Pushing to `main` runs `ci.yml` first; if the `test` job passes, the
`deploy-chrome` and `deploy-firefox` jobs then publish to both stores. The
Firefox job also uploads the signed `.xpi` as a workflow artifact so you
always have a local copy.

### One-time setup

**Chrome Web Store** ([Google's docs](https://developer.chrome.com/docs/webstore/one_time_payment)) — full walkthrough:

1. **Upload the listing manually.** From the [CWS Developer Dashboard](https://chrome.google.com/webstore/devconsole), upload `band-tools-chrome-0.2.0.zip` (produced by `npm run package:chrome`) to create the listing. Note:
   - **Extension ID** — visible in the URL when you open the listing, format `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` (32 chars).
   - **Publisher ID** — on your account/profile page in the dashboard, numeric string.

2. **Create a Google Cloud project.** https://console.cloud.google.com/ → top-left project dropdown → **New Project** → name it `band-tools` → **Create**. Make sure it's selected.

3. **Enable the Chrome Web Store API.** Search bar → `Chrome Web Store API` → click the result → **Enable**.

4. **Configure the OAuth consent screen.** Left sidebar → **APIs & Services** → **OAuth consent screen**:
   - User type: **External** → **Create**
   - App name: `Band Tools`, support email and developer contact email: your gmail
   - Click through Scopes and Test users with **Save and Continue** (no additions needed)
   - On the consent screen page, click **Publish App** to avoid 7-day refresh-token expiry. (If you leave it in Testing mode, you must add your own email as a test user AND refresh tokens expire after 7 days, so the deploy will eventually break.)

5. **Create OAuth credentials.** Left sidebar → **Credentials** → **+ Create Credentials** → **OAuth client ID**:
   - Application type: **Web application**
   - Name: `band-tools-deploy`
   - **Authorized redirect URIs** → **+ Add URI** → `https://developers.google.com/oauthplayground` (must be exact, including protocol)
   - **Create** → copy the **Client ID** and **Client Secret** from the modal.

6. **Get a refresh token.** Go to https://developers.google.com/oauthplayground:
   - Click the **gear icon** (top right) → check **Use your own OAuth credentials** → paste the Client ID and Client Secret from step 5
   - In the left panel, find **Chrome Web Store API v1** and check the scope `https://www.googleapis.com/auth/chromewebstore` (or paste that URL into the "Input your own scope" field if it's not listed)
   - Click **Authorize APIs** → sign in with the Google account that owns the CWS listing → grant permission
   - Back in the Playground, click **Exchange authorization code for tokens**
   - Copy the **`refresh_token`** value (long string starting with `1//`)

7. **Set GitHub secrets** (see [the secrets table](#github-secrets-to-set)).

**Firefox Add-ons** (AMO):
1. Submit the extension manually once — AMO requires human review for new listings. Once approved, subsequent updates can go via API.
2. Generate API credentials at <https://addons.mozilla.org/en-US/developers/addon/api/key/>. The **JWT issuer** is the API key, the **JWT secret** is the API secret.

### GitHub secrets to set

| Secret | Source |
|---|---|
| `CHROME_CLIENT_ID` | Google Cloud OAuth client ID |
| `CHROME_CLIENT_SECRET` | Google Cloud OAuth client secret |
| `CHROME_REFRESH_TOKEN` | OAuth refresh token from the one-time exchange |
| `CHROME_PUBLISHER_ID` | CWS Publisher ID from the dashboard |
| `CHROME_EXTENSION_ID` | The extension's ID from the dashboard |
| `AMO_JWT_ISSUER` | AMO API key (JWT issuer) |
| `AMO_JWT_SECRET` | AMO API secret (JWT secret) |

The gecko ID is hardcoded in `build.js` (`band-tools@band-tools`) and matches
what's currently in the pending AMO submission. Changing it after publishing
to AMO creates a new listing, so don't.

### Manual run

Use the **Run workflow** button on the Actions tab to publish without waiting
for a push (useful for back-fills or hot-fixes).

## License
MIT
