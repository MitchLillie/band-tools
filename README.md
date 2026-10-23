# Band Tools

A Chrome extension for [band.us](https://band.us) groups. Adds three features the web app doesn't surface directly:

| Feature | What it does |
|---------|-------------|
| **My Events** | Lists upcoming events across a configurable date window, with a one-click copy for sharing as plain text |
| **RSVP** | Shows exactly who has and hasn't responded to a private event |
| **Sync Group** | Adds newly-joined group members as sharers on upcoming private events (dry-run first, then apply) |

## Installation

### From the Chrome Web Store

<https://chromewebstore.google.com/detail/band-tools/iagofipjlicpojpompdahgbnmfglgioo>

### From Firefox Add-ons

<https://addons.mozilla.org/firefox/addon/band-tools/>

Releases are published to both stores automatically when a release-please release PR is merged — see [Auto-deploy](#auto-deploy).

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

Releases are driven by [release-please](https://github.com/googleapis/release-please)
(`.github/workflows/release-please.yml`):

1. Merge PRs to `main` with [Conventional Commit](https://www.conventionalcommits.org/)
   titles (`fix: …`, `feat: …`). release-please keeps a release PR open that bumps
   `package.json` + `manifest.json` and updates `CHANGELOG.md`.
2. Merge the release PR. That tags `vX.Y.Z`, creates a GitHub Release, and the
   `deploy-chrome` / `deploy-firefox` jobs in the same workflow publish to both
   stores. (They live in that workflow because tags created with `GITHUB_TOKEN`
   don't trigger other workflows.)

Ordinary merges to `main` only run `ci.yml` tests; they don't deploy.

Firefox versions are submitted to the listed channel with a source archive
(`git archive` of the tagged commit), since `background.js` is bundled; AMO signs
and distributes them after review.

### One-time setup

**Chrome Web Store** (see [Google's docs](https://developer.chrome.com/docs/webstore/one_time_payment)):
1. Upload `band-tools-chrome-<version>.zip` manually from the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) to create the listing. Note the **Extension ID** and your **Publisher ID** from the dashboard.
2. Create a Google Cloud project, enable the Chrome Web Store API, and create OAuth 2.0 credentials. Do a one-time token exchange for a `refresh_token` (the `chrome-webstore-upload-cli` README has a script).

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
the live AMO listing. Changing it after publishing
to AMO creates a new listing, so don't.

### Manual run

**Actions → Release → Run workflow** publishes the version currently on `main` to
both stores without cutting a new release (back-fills, or a retry after a failed
deploy). Bump the version first — both stores reject re-uploads of a published
version.

## License
MIT
