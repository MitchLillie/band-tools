# Band Tools

A Chrome extension for [band.us](https://band.us) groups. Adds three features the web app doesn't surface directly:

| Feature | What it does |
|---------|-------------|
| **My Events** | Lists upcoming events across a configurable date window, with a one-click copy for sharing as plain text |
| **RSVP** | Shows exactly who has and hasn't responded to a private event |
| **Sync Group** | Adds newly-joined group members as sharers on upcoming private events (dry-run first, then apply) |

## Installation

### From the Chrome Web Store *(coming soon)*

### Load unpacked (developer mode)
1. Download or clone this repo
2. Open `chrome://extensions` and enable **Developer mode**
3. Click **Load unpacked** and select the `band-tools/` folder
4. Navigate to your band on [band.us](https://band.us) — the extension auto-detects your band

## First-time setup
1. Make sure you're logged into band.us in Chrome
2. Click the Band Tools icon → open **Settings** (⚙)
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
API client, bundled from `src/background.js` with esbuild.

```bash
npm install
npm run build   # src/background.js -> background.js
npm test        # unit tests (vitest)
npm run e2e      # Chromium E2E (Playwright)
```

Load the folder as an unpacked extension after building. The popup, options, and
content script are plain HTML/JS and need no build.

```
band-tools/
  manifest.json      MV3 manifest (module service worker)
  src/background.js  Service worker source (imports bandstand/browser)
  background.js      esbuild output, loaded by the manifest (gitignored)
  popup.html/js/css  Toolbar popup UI
  options.html/js    Settings page
  content.js         Auto-detects band_no and user identity from the page
  icons/             PNG icons (16, 48, 128px)
```

## License
MIT
