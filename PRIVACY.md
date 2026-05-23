# Privacy Policy — Band Tools

**Last updated: May 2026**

Band Tools is a browser extension that helps you manage your band.us group. This policy explains what data the extension accesses and what it does with it.

## What we access

| Data | Why |
|------|-----|
| band.us cookies (`SESSION`, `secretKey`) | To authenticate API requests on your behalf |
| Current tab URL | To auto-detect your band number when you're on band.us |
| band.us API responses (events, members, groups) | To display event lists, RSVP status, and group sync previews |

## What we do NOT do

- We do not collect, transmit, or store any data on external servers
- We do not track usage or analytics
- We do not share any information with third parties
- We do not access cookies or data from any site other than band.us

## Where data goes

All data stays between your browser and the Band API (`api-usw.band.us`). Settings (your default band number, calendar, and group preferences) are stored locally in Chrome's sync storage and synced only to your own Chrome profile.

## Permissions justification

- **cookies** — required to read the `secretKey` cookie used to sign API requests (Band's authentication mechanism)
- **tabs** — required to read the current tab URL to auto-detect your band number
- **storage** — required to save your settings and cache event lists locally
- **activeTab** — required to auto-fill the RSVP input when you're viewing an event page
- **https://*.band.us/*** — required to call the Band API and read authentication cookies

## Contact

This is an open-source project. If you have privacy questions, open an issue on GitHub.
