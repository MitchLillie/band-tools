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
No build step — plain HTML/CSS/JS. Edit files and reload the extension in `chrome://extensions`.

The BAND API layer (auth, HMAC request signing, schedule endpoints) comes from the
[`bandstand`](https://github.com/MitchLillie/bandstand) library, vendored as a single
browser build at `vendor/bandstand.js`. To update it, run `npm run build` in the
bandstand repo and copy its `dist/browser.js` over `vendor/bandstand.js`.

```
band-tools/
  manifest.json        MV3 manifest (module service worker)
  background.js        Service worker — features, backed by bandstand
  vendor/bandstand.js  Vendored browser build of the bandstand API client
  popup.html/js/css    Toolbar popup UI
  options.html/js      Settings page
  content.js           Auto-detects band_no and user identity from the page
  icons/               PNG icons (16, 48, 128px)
```

## License
MIT
