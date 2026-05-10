require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { EventEmitter } = require('events');
const { execSync } = require('child_process');

const { Builder, By, until, Capabilities } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const chromedriver = require('chromedriver');

const wa = require('./whatsapp');
const recipients = require('./recipients');
const { createServer } = require('./server');

// ----------------------------------------------------------------------------
// Brightree scraper login state
//
// Brightree only allows one active session per account, so we must NEVER
// auto-relogin from inside the watch loop — that would kick the human user
// off whichever device they just logged in from, which then kicks the bot
// off, ad infinitum.
//
// The bot logs in exactly when the user asks for it (first boot OR an
// explicit "Login" click). If a tick later discovers the session has been
// taken over (we get redirected to the login form), we stop and wait — no
// silent re-login.
// ----------------------------------------------------------------------------

const SCRAPER_STATE = {
    UNKNOWN: 'unknown',          // never tried — next tick may log in
    ACTIVE: 'active',            // we have a working Brightree session
    SESSION_LOST: 'session-lost', // got bounced to login by another device
    LOGGED_OUT: 'logged-out'     // user clicked Logout
};

const scraperEvents = new EventEmitter();
let scraperState = SCRAPER_STATE.UNKNOWN;
let scraperLoginInFlight = false;

function setScraperState(next) {
    if (next === scraperState) return;
    scraperState = next;
    console.log(`[scraper] state -> ${next}`);
    scraperEvents.emit('state', next);
}

function getScraperState() {
    return scraperState;
}

class SessionLostError extends Error {
    constructor() {
        super('Brightree session was taken over by another login');
        this.code = 'SESSION_LOST';
    }
}

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------

const TARGET_URL =
    'https://brightree.net/F1/01822/PulmRX/ARManagement/frmPrivateERNs.aspx';

const PROFILE_DIR = path.resolve(__dirname, '.chrome-profile');
const STATE_FILE = path.resolve(__dirname, '.scraper-state.json');
const DOWNLOAD_DIR = path.resolve(__dirname, '.downloads');

const SCRAPE_INTERVAL_MS = parseInt(
    process.env.SCRAPE_INTERVAL_MS || '60000',
    10
);

const MAX_NEW_RECORDS = 25;

// ----------------------------------------------------------------------------
// Selenium driver
// ----------------------------------------------------------------------------

let driverPromise = null;

async function getDriver() {

    if (driverPromise) return driverPromise;

    driverPromise = (async () => {

        if (!fs.existsSync(PROFILE_DIR)) {
            fs.mkdirSync(PROFILE_DIR, { recursive: true });
        }
        if (!fs.existsSync(DOWNLOAD_DIR)) {
            fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
        }

        // Kill any orphaned browser still running against our profile dir
        // BEFORE wiping the Singleton* locks. Otherwise the lock cleanup
        // would let a second instance launch alongside the orphan, the
        // two would fight over the profile, and one would crash (which
        // is what triggers the macOS "closed unexpectedly" popup).
        //
        // The pattern is scoped to our --user-data-dir, so the user's
        // personal Brave (with its default profile) is left alone.
        try {
            execSync(
                `pkill -f -- "--user-data-dir=${PROFILE_DIR}"`,
                { stdio: 'ignore' }
            );
            // pkill returns immediately; give the OS a beat to actually
            // tear down the process so its lock files are gone.
            await new Promise((r) => setTimeout(r, 300));
        } catch (_) {
            // pkill exits non-zero when it found no matches — fine.
        }

        // Stale Singleton* lock files from a prior unclean shutdown make
        // Brave/Chrome refuse to launch ("Chrome instance exited"). Clean
        // them up before every start so a Ctrl+C/crash doesn't brick the
        // next run.
        for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
            try {
                fs.rmSync(path.join(PROFILE_DIR, name), { force: true });
            } catch (_) { /* ignore */ }
        }

        const options = new chrome.Options();

        options.addArguments(`--user-data-dir=${PROFILE_DIR}`);
        options.addArguments('--no-sandbox');
        options.addArguments('--disable-dev-shm-usage');
        options.addArguments('--disable-blink-features=AutomationControlled');
        options.addArguments('--window-size=1400,900');

        // Force PDFs to download to DOWNLOAD_DIR instead of opening inline,
        // so we can capture them and forward as WhatsApp attachments.
        options.setUserPreferences({
            'download.default_directory': DOWNLOAD_DIR,
            'download.prompt_for_download': false,
            'download.directory_upgrade': true,
            'plugins.always_open_pdf_externally': true,
            'profile.default_content_settings.popups': 0
        });

        if (String(process.env.HEADLESS).toLowerCase() === 'true') {
            options.addArguments('--headless=new');
        }

        if (process.env.BROWSER_BINARY_PATH) {
            options.setChromeBinaryPath(process.env.BROWSER_BINARY_PATH);
        }

        const service = new chrome.ServiceBuilder(chromedriver.path);

        return await new Builder()
            .forBrowser('chrome')
            .withCapabilities(Capabilities.chrome())
            .setChromeOptions(options)
            .setChromeService(service)
            .build();
    })();

    return driverPromise;
}

async function closeDriver() {

    if (!driverPromise) return;

    try {
        const driver = await driverPromise;
        await driver.quit();
    } catch (_) {
        // ignore
    }

    driverPromise = null;
}

// ----------------------------------------------------------------------------
// Login
// ----------------------------------------------------------------------------

async function isOnLoginPage(driver) {
    const matches = await driver.findElements(By.id('Username'));
    return matches.length > 0;
}

async function performLogin(driver) {

    const username = process.env.BRIGHTREE_USERNAME;
    const password = process.env.BRIGHTREE_PASSWORD;

    if (!username || !password) {
        throw new Error(
            'BRIGHTREE_USERNAME and BRIGHTREE_PASSWORD must be set in .env'
        );
    }

    console.log('[scraper] logging in...');

    await driver.wait(until.elementLocated(By.id('Username')), 20000);

    const userField = await driver.findElement(By.id('Username'));
    await userField.clear();
    await userField.sendKeys(username);

    const passField = await driver.findElement(By.id('Password'));
    await passField.clear();
    await passField.sendKeys(password);

    await driver.findElement(By.id('LogInBtn')).click();

    await driver.wait(async () => {

        const stillLogin = await driver.findElements(By.id('Username'));
        if (stillLogin.length === 0) return true;

        const url = await driver.getCurrentUrl();
        return /frmPrivateERNs/i.test(url);

    }, 30000, 'Timed out waiting for login to complete');
}

// Track whether the ERN page is currently loaded so we don't re-navigate on
// every tick — full page reloads can trip ASP.NET session expiry and bounce
// us back to the login screen. After the first load we only re-navigate if
// we discover we've been kicked off the page.
let pageLoaded = false;

async function isOnErnPage(driver) {
    const url = await driver.getCurrentUrl();
    if (!/frmPrivateERNs/i.test(url)) return false;
    return !(await isOnLoginPage(driver));
}

/**
 * Make sure the driver is on the ERN page with a valid session.
 *
 * The watch loop now follows a login → scrape → release pattern: at the
 * start of every tick we may need to log in fresh, and at the end of the
 * tick we deliberately drop the session so the user can use Brightree on
 * another device while the bot is idle.
 *
 * If submitting credentials still doesn't land us on the ERN page (the
 * most common reason: another session is currently active and Brightree
 * blocks the login), we throw SessionLostError so the caller backs off
 * without forcing the issue. The next tick will try again — no manual
 * recovery needed.
 */
async function ensureSession(driver) {

    if (pageLoaded && (await isOnErnPage(driver))) {
        setScraperState(SCRAPER_STATE.ACTIVE);
        return;
    }

    await driver.get(TARGET_URL);
    await driver.sleep(1500);

    if (await isOnLoginPage(driver)) {
        await performLogin(driver);
        await driver.get(TARGET_URL);
        await driver.sleep(1500);
    }

    if (!(await isOnErnPage(driver))) {
        // Could be: (a) login form still visible (creds rejected), or
        // (b) Brightree's "another session is active" warning page. Either
        // way, don't fight — back off and let the next tick try.
        pageLoaded = false;
        setScraperState(SCRAPER_STATE.SESSION_LOST);
        throw new SessionLostError();
    }

    pageLoaded = true;
    setScraperState(SCRAPER_STATE.ACTIVE);
}

/**
 * Drop the Brightree session so other devices can log in. Tries to click
 * a logout link first (proper server-side invalidation) and clears
 * cookies as a safety net regardless.
 */
async function releaseBrightreeSession(driver) {

    try {

        // Look for a logout-shaped element on the current page.
        const logoutEls = await driver.findElements(
            By.css(
                'a[href*="ogout" i], ' +
                'a[id*="ogout" i], ' +
                'input[id*="ogout" i], ' +
                'button[id*="ogout" i]'
            )
        );

        if (logoutEls.length) {
            console.log('[scraper] clicking logout link to release session');
            try {
                await logoutEls[0].click();
            } catch (_) {
                // Fallback to JS-click in case Telerik intercepts it.
                await driver.executeScript(
                    'arguments[0].click();',
                    logoutEls[0]
                );
            }
            await driver.sleep(1500);
        }

    } catch (err) {
        console.warn(
            `[scraper] logout-link click failed: ${err.message}`
        );
    }

    // Belt-and-suspenders: even if the click worked, wipe cookies for the
    // current domain so the local profile is genuinely "logged out".
    try {
        await driver.manage().deleteAllCookies();
    } catch (_) { /* ignore */ }

    pageLoaded = false;
    // Back to UNKNOWN so the next tick is allowed to attempt login.
    setScraperState(SCRAPER_STATE.UNKNOWN);
}

// ----------------------------------------------------------------------------
// Grid scraping
// ----------------------------------------------------------------------------

const GRID_ROW_SELECTOR =
    '#m_ctl00_c_c_dgResults tr.rgRow, #m_ctl00_c_c_dgResults tr.rgAltRow';
const GRID_HEADER_SELECTOR = '#m_ctl00_c_c_dgResults th.rgHeader';
const SEARCH_BUTTON_SELECTOR = '#m_ctl00_c_c_btnSearch_input';

async function clickSearch(driver) {

    const searchEls = await driver.findElements(By.css(SEARCH_BUTTON_SELECTOR));
    if (!searchEls.length) return false;

    console.log('[scraper] clicking Search...');

    try {
        await searchEls[0].click();
    } catch (_) {
        await driver.executeScript(
            'arguments[0].click();',
            searchEls[0]
        );
    }

    return true;
}

async function hasRows(driver) {
    const rows = await driver.findElements(By.css(GRID_ROW_SELECTOR));
    return rows.length > 0;
}

// Wait for the Telerik RadAjax panel to finish its postback. Falls back to a
// short fixed delay if Sys/PRM isn't accessible.
async function waitForAjaxIdle(driver) {

    try {
        await driver.wait(async () => {
            return await driver.executeScript(`
                try {
                    var prm = window.Sys && Sys.WebForms &&
                        Sys.WebForms.PageRequestManager.getInstance();
                    if (!prm) return true;
                    return !prm.get_isInAsyncPostBack();
                } catch (e) { return true; }
            `);
        }, 30000);
    } catch (_) {
        // ignore — we'll just rely on the row presence check below
    }

    await driver.sleep(400);
}

async function waitForGrid(driver) {

    // Always click Search — this re-fires the grid postback so we get fresh
    // rows AND keeps the ASP.NET session warm (no idle-timeout bounce).
    const clicked = await clickSearch(driver);

    if (clicked) {
        await waitForAjaxIdle(driver);
    }

    await driver.wait(async () => hasRows(driver), 60000,
        clicked
            ? 'Timed out waiting for ERN grid rows after clicking Search'
            : 'Timed out waiting for ERN grid rows (no Search button found)'
    );

    await driver.sleep(500);
}

async function readHeaderMap(driver) {

    const headerCells = await driver.findElements(By.css(GRID_HEADER_SELECTOR));

    const map = {};
    for (let i = 0; i < headerCells.length; i++) {
        const text = (await headerCells[i].getText()).trim();
        if (text && !(text in map)) {
            map[text] = i;
        }
    }
    return map;
}

function pick(headerMap, cellTexts, ...candidates) {
    for (const name of candidates) {
        if (name in headerMap) {
            const idx = headerMap[name];
            if (idx < cellTexts.length) {
                return (cellTexts[idx] || '').trim();
            }
        }
    }
    return '';
}

async function scrapeRows(driver) {

    await waitForGrid(driver);

    const headerMap = await readHeaderMap(driver);
    const rowEls = await driver.findElements(By.css(GRID_ROW_SELECTOR));

    const rows = [];

    for (const row of rowEls) {
        const cells = await row.findElements(By.css('td'));
        const texts = await Promise.all(cells.map((c) => c.getText()));

        const reportKey = pick(headerMap, texts, 'Report Key', 'ReportKey');
        const ernDate = pick(headerMap, texts, 'ERN Date', 'ERNDate');
        const insurance = pick(headerMap, texts, 'Insurance');
        const traceNumber = pick(
            headerMap, texts, 'Trace Number', 'TraceNumber'
        );
        const deposit = pick(headerMap, texts, 'Deposit');
        const postDate = pick(headerMap, texts, 'Post Date', 'PostDate');
        const depositAmount = pick(
            headerMap, texts, 'Deposit Amount', 'DepositAmount'
        );
        const balance = pick(headerMap, texts, 'Balance');
        const medicare = pick(headerMap, texts, 'Medicare');
        const source = pick(headerMap, texts, 'Source');

        if (!reportKey && !traceNumber && !ernDate) continue;

        // Pull the EOB report key out of the row's "EOB" link so we can
        // trigger ViewERN(0,'EOB',<id>) later to download the PDF.
        let eobId = null;
        try {
            const eobLink = await row.findElement(
                By.css("a[href*=\"'EOB'\"]")
            );
            const href = await eobLink.getAttribute('href');
            const m = href.match(
                /ViewERN\(\s*\d+\s*,\s*'EOB'\s*,\s*(\d+)\s*\)/
            );
            if (m) eobId = m[1];
        } catch (_) {
            // no EOB link on this row
        }

        rows.push({
            reportKey,
            ernDate,
            insurance,
            traceNumber,
            deposit,
            postDate,
            depositAmount,
            balance,
            medicare,
            source,
            eobId
        });
    }

    return rows;
}

// The Brightree grid is already sorted newest-first by the app itself —
// trust DOM order verbatim. Trying to re-sort by (ERN Date desc, Report Key
// desc) was wrong: within a date, the page's secondary sort isn't Report
// Key, so reordering pulled the wrong row to the top.
function rowId(r) {
    return `${r.reportKey}|${r.traceNumber}`;
}

// ----------------------------------------------------------------------------
// EOB PDF download
// ----------------------------------------------------------------------------

async function waitForNewPdf(beforeSet, timeoutMs) {

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {

        const now = fs.readdirSync(DOWNLOAD_DIR);

        const newCompleted = now.find(
            (name) =>
                !beforeSet.has(name) &&
                !name.endsWith('.crdownload') &&
                name.toLowerCase().endsWith('.pdf')
        );

        if (newCompleted) {
            return path.join(DOWNLOAD_DIR, newCompleted);
        }

        await new Promise((r) => setTimeout(r, 300));
    }

    throw new Error(
        `Timed out waiting for EOB PDF to appear in ${DOWNLOAD_DIR}`
    );
}

async function closeExtraWindows(driver, mainHandle, beforeHandles) {

    const after = await driver.getAllWindowHandles();
    const beforeSet = new Set(beforeHandles);

    for (const h of after) {
        if (h !== mainHandle && !beforeSet.has(h)) {
            try {
                await driver.switchTo().window(h);
                await driver.close();
            } catch (_) { /* ignore */ }
        }
    }

    try {
        await driver.switchTo().window(mainHandle);
    } catch (_) { /* main already focused */ }
}

async function downloadEobPdf(driver, eobId) {

    if (!eobId) return null;

    const before = new Set(fs.readdirSync(DOWNLOAD_DIR));
    const beforeWindows = await driver.getAllWindowHandles();
    const mainHandle = await driver.getWindowHandle();

    console.log(`[scraper] requesting EOB PDF (eobId=${eobId})`);

    try {
        await driver.executeScript(
            `ViewERN(0, 'EOB', ${parseInt(eobId, 10)});`
        );
    } catch (err) {
        await closeExtraWindows(driver, mainHandle, beforeWindows);
        throw new Error(`ViewERN call failed: ${err.message}`);
    }

    let pdfPath;
    try {
        pdfPath = await waitForNewPdf(before, 60000);
    } finally {
        await closeExtraWindows(driver, mainHandle, beforeWindows);
    }

    return pdfPath;
}

// ----------------------------------------------------------------------------
// State (last seen tracking)
// ----------------------------------------------------------------------------

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (_) {
        return {};
    }
}

function writeState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ----------------------------------------------------------------------------
// Scrape orchestration
// ----------------------------------------------------------------------------

async function getLatest() {

    const driver = await getDriver();

    let rows;
    try {
        await ensureSession(driver);
        rows = await scrapeRows(driver);
    } catch (err) {
        // Force a clean re-navigate next tick if anything went sideways.
        pageLoaded = false;
        throw err;
    }

    if (!rows.length) {
        return {
            newRecords: [],
            latest: null,
            allOnPage: rows,
            firstRun: false
        };
    }

    const latest = rows[0];
    const state = readState();
    const trackedId = state.lastId;

    let newRecords;
    let firstRun = false;

    if (!trackedId) {
        firstRun = true;
        newRecords = [latest];
    } else {
        const idx = rows.findIndex((r) => rowId(r) === trackedId);
        if (idx === -1) {
            newRecords = rows.slice(0, MAX_NEW_RECORDS);
        } else {
            newRecords = rows.slice(0, Math.min(idx, MAX_NEW_RECORDS));
        }
    }

    writeState({
        lastId: rowId(latest),
        lastReportKey: latest.reportKey,
        lastTraceNumber: latest.traceNumber,
        lastErnDate: latest.ernDate,
        lastInsurance: latest.insurance,
        lastDepositAmount: latest.depositAmount,
        lastSource: latest.source,
        lastSeenAt: new Date().toISOString()
    });

    // Reverse so iterating sends oldest-of-new first.
    newRecords = newRecords.slice().reverse();

    return { newRecords, latest, allOnPage: rows, firstRun };
}

// ----------------------------------------------------------------------------
// WhatsApp message formatting + sending
// ----------------------------------------------------------------------------

function formatErnMessage(row /* , meta */) {

    const fmt = (s) => (s && String(s).trim()) || '—';
    const amount = (row.depositAmount && row.depositAmount.trim()) || '$0.00';

    return [
        `💰 *${amount}*`,
        '',
        fmt(row.ernDate),
        fmt(row.insurance)
    ].join('\n');
}

async function ensureFreshSession(sock, jid) {

    if (typeof sock.assertSessions !== 'function') return;

    if (typeof jid === 'string' && jid.endsWith('@g.us')) {

        // Group sends use Sender Keys, but Baileys still needs a fresh
        // Signal session with EACH OTHER participant to deliver the
        // sender-key distribution message. Without this step the
        // recipient's app shows "Waiting for this message…" until both
        // sides re-sync — exactly the symptom we hit on first send.
        try {
            const others = await wa.getOtherParticipantJids(jid);
            if (others && others.length) {
                await sock.assertSessions(others, true);
            }
        } catch (e) {
            console.warn(
                `[whatsapp] group session warmup warning for ${jid}: ${e.message}`
            );
        }
        return;
    }

    try {
        await sock.assertSessions([jid], true);
    } catch (e) {
        console.warn(
            `[whatsapp] assertSessions warning for ${jid}: ${e.message}`
        );
    }
}

function isGroupJid(jid) {
    return typeof jid === 'string' && jid.endsWith('@g.us');
}

async function debugLogGroupContext(jid) {

    if (!isGroupJid(jid)) return;

    try {
        const meta = await wa.getCachedGroupMetadata(jid);
        if (!meta) {
            console.warn(
                `[whatsapp] no group metadata available for ${jid} — ` +
                `the bot's account may not be a member of this group`
            );
            return;
        }

        const participants = meta.participants || [];
        // Strip device suffix AND keep the @domain — comparing base ids
        // across formats (`@s.whatsapp.net` vs `@lid`) was previously the
        // source of botIsMember false-negatives.
        const isMember = participants.some((p) => wa.isSelfId(p.id));

        console.log(
            `[whatsapp] group "${meta.subject}" ` +
            `participants=${participants.length} ` +
            `botIsMember=${isMember}`
        );

        if (!isMember) {
            console.warn(
                '[whatsapp] >>> bot account is NOT in this group; the ' +
                'message will not be delivered. Add the bot number to ' +
                'the group from your phone first.'
            );
        }
    } catch (err) {
        console.warn(
            `[whatsapp] group context lookup failed for ${jid}: ${err.message}`
        );
    }
}

async function sendWhatsAppMessage(sock, jid, messageBody) {
    try {
        await debugLogGroupContext(jid);
        await ensureFreshSession(sock, jid);
        const result = await sock.sendMessage(jid, { text: messageBody });
        const id = result && result.key && result.key.id;
        if (id && result.message) {
            wa.rememberSentMessage(id, result.message);
        }
        console.log(`[whatsapp] sent text to ${jid} (id=${id || 'unknown'})`);
    } catch (error) {
        console.error(
            `[whatsapp] send to ${jid} failed: ${error && error.stack || error}`
        );
    }
}

async function sendWhatsAppDocument(sock, jid, filePath, caption, fileName) {
    try {
        await debugLogGroupContext(jid);
        await ensureFreshSession(sock, jid);

        const buffer = fs.readFileSync(filePath);

        const result = await sock.sendMessage(jid, {
            document: buffer,
            mimetype: 'application/pdf',
            fileName,
            caption
        });

        const id = result && result.key && result.key.id;
        if (id && result.message) {
            wa.rememberSentMessage(id, result.message);
        }
        console.log(
            `[whatsapp] sent PDF (${path.basename(filePath)}) to ${jid} ` +
            `(id=${id || 'unknown'})`
        );
    } catch (error) {
        console.error(
            `[whatsapp] document send to ${jid} failed: ` +
            (error && error.stack || error)
        );
    }
}

// ----------------------------------------------------------------------------
// Watch loop
// ----------------------------------------------------------------------------

let scrapeTimer = null;
let scrapeInFlight = false;

function getActiveJids() {

    const list = recipients.getAll();
    const jids = [];

    for (const r of list) {
        const jid = recipients.toJid(r);
        if (jid) jids.push(jid);
    }

    return jids;
}

async function tickOnce() {

    if (scrapeInFlight) {
        console.log('[watch] previous tick still running, skipping');
        return;
    }

    const sock = wa.getSocket();
    if (!sock) {
        console.log('[watch] WhatsApp not connected, skipping tick');
        return;
    }

    const jids = getActiveJids();
    if (!jids.length) {
        console.log('[watch] no recipients configured, skipping tick');
        return;
    }

    // Manual pause from the UI ("Logout" button) — don't auto-relogin.
    if (scraperState === SCRAPER_STATE.LOGGED_OUT) {
        console.log('[watch] Brightree paused by user — skipping tick.');
        return;
    }

    scrapeInFlight = true;

    try {

        console.log(`\n[watch] tick @ ${new Date().toLocaleString()}`);

        const result = await getLatest();

        if (!result.latest) {
            console.log('[watch] no rows on grid');
            return;
        }

        if (!result.newRecords.length) {
            console.log(
                `[watch] no change (latest=${result.latest.reportKey} ${result.latest.ernDate})`
            );
            return;
        }

        const total = result.newRecords.length;
        console.log(
            `[watch] sending ${total} record(s) to ${jids.length} recipient(s) ` +
            `(firstRun=${result.firstRun})`
        );

        const driver = await getDriver();

        for (let i = 0; i < total; i++) {

            const row = result.newRecords[i];
            const messageBody = formatErnMessage(row);

            // Best-effort EOB PDF; fall back to text on failure.
            let pdfPath = null;
            if (row.eobId) {
                try {
                    pdfPath = await downloadEobPdf(driver, row.eobId);
                } catch (err) {
                    console.warn(
                        `[scraper] EOB PDF download failed ` +
                        `(reportKey=${row.reportKey}): ${err.message}`
                    );
                }
            }

            for (const jid of jids) {
                if (pdfPath) {
                    await sendWhatsAppDocument(
                        sock,
                        jid,
                        pdfPath,
                        messageBody,
                        'ERN.pdf'
                    );
                } else {
                    await sendWhatsAppMessage(sock, jid, messageBody);
                }
            }

            if (pdfPath) {
                try { fs.unlinkSync(pdfPath); } catch (_) { /* ignore */ }
            }
        }

    } catch (err) {
        if (err && err.code === 'SESSION_LOST') {
            // Login was blocked (most likely because someone else is logged
            // into Brightree right now). Don't fight; the next tick will
            // try again automatically.
            console.warn(
                '[watch] tick skipped: Brightree login blocked, probably ' +
                'because another device is currently using the session. ' +
                'Will retry on the next tick.'
            );
        } else {
            console.error('[watch] tick error:', err.message);
        }
    } finally {

        // By default we KEEP the session open between ticks — appropriate
        // when other users have their own separate Brightree accounts.
        // Set SCRAPER_RELEASE_BETWEEN_TICKS=true if multiple devices need
        // to share the SAME account and the bot should release the
        // session every tick.
        const releaseEnabled =
            String(process.env.SCRAPER_RELEASE_BETWEEN_TICKS || 'false')
                .toLowerCase() === 'true';

        if (releaseEnabled && scraperState === SCRAPER_STATE.ACTIVE) {
            try {
                const driver = await getDriver();
                await releaseBrightreeSession(driver);
            } catch (err) {
                console.warn(
                    `[scraper] session release failed: ${err.message}`
                );
            }
        }

        scrapeInFlight = false;
    }
}

function startWatchLoop() {

    if (scrapeTimer) return;

    // SCRAPE_INTERVAL_MS=0 (or any falsy / non-positive value) disables
    // the internal scheduler entirely — useful when scraping is driven
    // exclusively from outside, e.g. a hosting-panel cron hitting
    // /api/scrape-now hourly. The daemon stays up for the UI + WhatsApp
    // socket but doesn't tick on its own.
    if (!SCRAPE_INTERVAL_MS || SCRAPE_INTERVAL_MS <= 0) {
        console.log(
            '\n[watch] internal scheduler disabled ' +
            '(SCRAPE_INTERVAL_MS=0). Drive scraping via ' +
            'POST /api/scrape-now.\n'
        );
        return;
    }

    console.log(
        `\n[watch] starting loop, every ${SCRAPE_INTERVAL_MS}ms\n`
    );

    tickOnce();
    scrapeTimer = setInterval(tickOnce, SCRAPE_INTERVAL_MS);
}

function stopWatchLoop() {
    if (scrapeTimer) {
        clearInterval(scrapeTimer);
        scrapeTimer = null;
    }
}

// ----------------------------------------------------------------------------
// Manual scraper login / logout (driven by the settings UI)
// ----------------------------------------------------------------------------

async function loginToBrightree() {

    if (scraperLoginInFlight) {
        throw new Error('Login already in progress — try again in a moment');
    }

    scraperLoginInFlight = true;

    try {
        const driver = await getDriver();
        // Reset state so ensureSession's first check ("are we already on
        // the ERN page?") doesn't short-circuit before we navigate.
        if (scraperState === SCRAPER_STATE.LOGGED_OUT) {
            setScraperState(SCRAPER_STATE.UNKNOWN);
        }
        await ensureSession(driver);
        return getScraperState();
    } finally {
        scraperLoginInFlight = false;
    }
}

async function logoutFromBrightree() {

    // We don't actively hit a Brightree logout URL — the user may want the
    // session to persist on the original device. We just stop using it
    // from the bot's side: mark logged-out so the watch loop pauses, and
    // close the Selenium driver so its cookies are released.
    setScraperState(SCRAPER_STATE.LOGGED_OUT);
    pageLoaded = false;

    try {
        await closeDriver();
    } catch (_) { /* ignore */ }
}

// Surface for server.js so the API can drive the scraper.
const scraperApi = {
    getState: getScraperState,
    on: scraperEvents.on.bind(scraperEvents),
    off: scraperEvents.off.bind(scraperEvents),
    login: loginToBrightree,
    logout: logoutFromBrightree,
    // Trigger an on-demand tick — used by POST /api/scrape-now so cron or
    // any other external scheduler can drive the scrape from outside the
    // process without spawning a fresh node.
    tickNow: () => tickOnce()
};

/**
 * Wipe app-local state that's tied to the paired WhatsApp account:
 * recipient list and the last-synced ERN baseline. Called on logout so the
 * next paired device starts from a clean slate.
 *
 * Intentionally NOT called on transient disconnects (network blips,
 * Baileys restart-required) — those will reconnect using the same auth
 * and the data is still relevant.
 */
function clearLocalAppData() {

    const targets = [
        path.resolve(__dirname, 'recipients.json'),
        path.resolve(__dirname, '.scraper-state.json')
    ];

    for (const file of targets) {
        try {
            fs.rmSync(file, { force: true });
            console.log(`[boot] cleared ${path.basename(file)} on logout`);
        } catch (err) {
            console.warn(
                `[boot] could not clear ${path.basename(file)}: ${err.message}`
            );
        }
    }
}

// ----------------------------------------------------------------------------
// Boot — Express server + WhatsApp manager + watch loop
// ----------------------------------------------------------------------------

const HTTP_PORT = parseInt(process.env.PORT || '3000', 10);

async function boot() {

    // Start the HTTP server first so the user can manage WhatsApp from the UI
    // even if there's nothing paired yet.
    const app = createServer({ scraper: scraperApi });
    app.listen(HTTP_PORT, () => {
        console.log(
            `\n🌐  Settings UI: http://localhost:${HTTP_PORT}\n`
        );
    });

    // Tie the watch loop to WhatsApp connection state.
    wa.on('connected', () => {
        // Settle delay before sending — avoids "Waiting for this message...".
        setTimeout(startWatchLoop, 3000);
    });

    wa.on('disconnected', (info) => {
        stopWatchLoop();
        // Only wipe app-local state on a real logout (manual disconnect
        // or server-initiated unpair). Transient drops will reconnect
        // and the data is still relevant.
        if (info && info.loggedOut) {
            clearLocalAppData();
        }
    });

    // If we have saved auth, auto-connect on boot. Otherwise wait for the
    // user to click "Connect" in the UI to trigger pairing.
    const hasAuth = fs.existsSync(path.resolve(__dirname, 'auth')) &&
        fs.readdirSync(path.resolve(__dirname, 'auth')).length > 0;

    if (hasAuth) {
        console.log('[boot] saved auth detected — auto-connecting WhatsApp');
        wa.start().catch((err) => console.error('[boot] wa.start failed:', err));
    } else {
        console.log(
            '[boot] no saved auth — open the settings UI and click ' +
            '"Connect" to pair a device'
        );
    }
}

let shuttingDown = false;

async function shutdown(signal) {

    // Re-entry guard so a second Ctrl+C doesn't race with the first.
    if (shuttingDown) {
        console.log('Force exit.');
        process.exit(1);
    }
    shuttingDown = true;

    console.log(`\nReceived ${signal}, shutting down...`);
    stopWatchLoop();

    // Wait for the browser to actually close; otherwise the chromedriver
    // child process gets orphaned and leaves Singleton lock files behind
    // that block the next start.
    try {
        await Promise.race([
            closeDriver(),
            new Promise((resolve) => setTimeout(resolve, 8000))
        ]);
    } catch (err) {
        console.warn('Shutdown error:', err.message);
    }

    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

boot().catch((err) => {
    console.error('Fatal boot error:', err);
    process.exit(1);
});
