# whatsapp-scraping

Watches a target web page, detects new rows in its data grid, and pushes
each new row as a WhatsApp message with an attached PDF — via
[Baileys](https://github.com/WhiskeySockets/Baileys) for WhatsApp and
Selenium for the browser automation.

The main entry point is [`web-scraping.js`](./web-scraping.js) — it bundles
the scraper, the diff/state logic, and the WhatsApp send loop into a
single long-running process.

---

## What it does

1. Connects to WhatsApp once (QR pairing on first run, persisted in `auth/`).
2. Drives a real Chromium browser (Brave by default, see config) to log
   into the target site and load the data page.
3. Every `SCRAPE_INTERVAL_MS`, fires the page's Search button via AJAX
   postback to refresh the grid, scrapes page 1, diffs against the
   last-seen record in `.scraper-state.json`.
4. For every untracked record, downloads its associated PDF and sends the
   formatted summary + PDF as a WhatsApp document.

## Prerequisites

- macOS / Linux
- Node.js 18+
- A Chromium-based browser. Tested with **Brave**; Chrome works the same.
  The scraper uses `chromedriver` matched to the browser's major version.
- A WhatsApp account on a phone for QR pairing
- Valid credentials for the target site

## Install

```sh
npm install
```

## Configure

Fill in [`.env`](./.env) with the following keys:

```ini
# Site login
BRIGHTREE_USERNAME=
BRIGHTREE_PASSWORD=

# Browser
HEADLESS=false                                # set true to hide the window once stable
BROWSER_BINARY_PATH=/Applications/Brave Browser.app/Contents/MacOS/Brave Browser

# Watch loop
SCRAPE_INTERVAL_MS=60000                      # 60s default

# WhatsApp recipient
TEST_TARGET_NUMBER=+15551234567
```

If your Brave/Chrome version doesn't match the installed `chromedriver`,
re-pin it: `npm install chromedriver@<major-version>` (e.g. `147` or `148`).

## Run

```sh
node web-scraping.js
```

First run prints a QR code — scan it from your phone (WhatsApp →
Settings → Linked Devices → Link a Device). Subsequent runs reuse the
session in `auth/`.

### Mock mode

For testing the WhatsApp send pipeline without hitting the live site
(useful when credentials change or the site is down), there is a mock
runner that auto-generates a new fake record every interval:

```sh
node web-scraping-mock.js
```

Mock mode uses its own state file (`.scraper-state.mock.json`) and a
faster default interval (15s, override with `MOCK_SCRAPE_INTERVAL_MS`).

## How tracking works

- **Bootstrap (first run / no state)**: scrapes the grid, takes the top
  row, sends it as `📌 Tracking started`, writes its identity
  (`reportKey|traceNumber`) as the baseline.
- **Steady state**: each tick, the script walks rows from the top of the
  grid until it hits the tracked baseline. Every row above that becomes a
  new record. Sent oldest→newest so they read chronologically in chat.
  After sending, the new top row becomes the baseline.
- **Trust the page's order**: rows are not re-sorted client-side. The
  grid is already newest-first by the app's own definition.

State file: [`.scraper-state.json`](./.scraper-state.json) — single JSON
object, hand-editable.

## Reset cheatsheet

Stop the script first (Ctrl+C) so it doesn't rewrite state mid-reset.

| Goal | Command |
|---|---|
| Reset record tracking | `rm .scraper-state.json` |
| Re-pair WhatsApp / fix Bad MAC | `rm -rf auth` |
| Force fresh site login | `rm -rf .chrome-profile` |
| Total reset | `rm -rf auth .chrome-profile .scraper-state.json .downloads` |

## Troubleshooting

**"This version of ChromeDriver only supports Chrome version N"**
Brave/Chrome and `chromedriver` major versions are mismatched. Run
`npm install chromedriver@<browser-major>` to align.

**Logs in repeatedly on every tick**
Means full page reloads were happening between ticks; the current code
keeps the page loaded and uses Search-button AJAX postbacks to keep the
server-side session warm. If you still see this, your site's sliding
session timeout is shorter than your scrape interval — drop
`SCRAPE_INTERVAL_MS`.

**"Waiting for this message…" in WhatsApp**
Signal session out of sync between sender and recipient. The code calls
`sock.assertSessions([jid], true)` before every send to force-rebuild
the session, which fixes it for almost every case. If a specific
recipient remains stuck, have them send any message to your bot number
once — that forces both sides to renegotiate.

**`Bad MAC Error` spam in logs**
The `auth/` folder's session ratchet state is out of sync with the
server. Stop the script, `rm -rf auth`, restart, rescan the QR.

**PDF download times out**
The script triggers the page's "view document" JS function and waits
for a `.pdf` file to appear in `.downloads/`. If the site changes the
delivery flow (e.g., to an HTML wrapper instead of a direct PDF), the
wait will time out and the script falls back to text-only. Inspect what
the popup window does and adjust `downloadEobPdf()` accordingly.

## Files

| Path | Purpose |
|---|---|
| `web-scraping.js` | Main entry — scrape + WhatsApp send loop |
| `web-scraping-mock.js` | Same pipeline, fake data source |
| `app.js`, `baileys-app.js` | Earlier prototypes — kept for reference |
| `.env` | Credentials and runtime config |
| `auth/` | Baileys WhatsApp session (gitignored) |
| `.chrome-profile/` | Selenium browser profile (gitignored) |
| `.scraper-state.json` | Last-seen record baseline (gitignored) |
| `.downloads/` | Transient PDFs (gitignored, deleted per record) |
