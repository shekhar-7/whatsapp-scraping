require('dotenv').config();

const fs = require('fs');
const path = require('path');

const qrcode = require('qrcode-terminal');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const P = require('pino');

const { Builder, By, until, Capabilities } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const chromedriver = require('chromedriver');

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

async function ensureSession(driver) {

    if (pageLoaded && (await isOnErnPage(driver))) {
        // Already authenticated and on the right page — stay put.
        return;
    }

    await driver.get(TARGET_URL);
    await driver.sleep(1500);

    if (await isOnLoginPage(driver)) {
        await performLogin(driver);
        await driver.get(TARGET_URL);
        await driver.sleep(1500);
    }

    if (await isOnLoginPage(driver)) {
        pageLoaded = false;
        throw new Error('Still on login page after submitting credentials');
    }

    pageLoaded = true;
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

function formatNumber(number) {
    return number.replace(/\D/g, '') + '@s.whatsapp.net';
}

async function ensureFreshSession(sock, jid, to) {
    if (typeof sock.assertSessions !== 'function') return;
    try {
        await sock.assertSessions([jid], true);
    } catch (e) {
        console.warn(
            `[whatsapp] assertSessions warning for ${to}: ${e.message}`
        );
    }
}

async function sendWhatsAppMessage(sock, to, messageBody) {

    const jid = formatNumber(to);

    try {
        await ensureFreshSession(sock, jid, to);
        await sock.sendMessage(jid, { text: messageBody });
        console.log(`[whatsapp] sent text to ${to}`);
    } catch (error) {
        console.error(`[whatsapp] send to ${to} failed: ${error.message}`);
    }
}

async function sendWhatsAppDocument(sock, to, filePath, caption, fileName) {

    const jid = formatNumber(to);

    try {
        await ensureFreshSession(sock, jid, to);

        const buffer = fs.readFileSync(filePath);

        await sock.sendMessage(jid, {
            document: buffer,
            mimetype: 'application/pdf',
            fileName,
            caption
        });

        console.log(
            `[whatsapp] sent PDF (${path.basename(filePath)}) to ${to}`
        );
    } catch (error) {
        console.error(
            `[whatsapp] document send to ${to} failed: ${error.message}`
        );
    }
}

// ----------------------------------------------------------------------------
// Watch loop
// ----------------------------------------------------------------------------

let scrapeTimer = null;
let scrapeInFlight = false;

async function tickOnce(sock, targetNumbers) {

    if (scrapeInFlight) {
        console.log('[watch] previous tick still running, skipping');
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
            `[watch] sending ${total} record(s) ` +
            `(firstRun=${result.firstRun})`
        );

        const driver = await getDriver();

        for (let i = 0; i < total; i++) {

            const row = result.newRecords[i];

            const messageBody = formatErnMessage(row, {
                firstRun: result.firstRun,
                index: i + 1,
                total
            });

            // Best-effort: try to download the EOB PDF for this row.
            // If it fails for any reason, fall back to text-only send.
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

            const fileName = 'ERN.pdf';

            for (const number of targetNumbers) {
                if (pdfPath) {
                    await sendWhatsAppDocument(
                        sock,
                        number,
                        pdfPath,
                        messageBody,
                        fileName
                    );
                } else {
                    await sendWhatsAppMessage(sock, number, messageBody);
                }
            }

            // Clean up the PDF after sending so .downloads doesn't grow.
            if (pdfPath) {
                try { fs.unlinkSync(pdfPath); } catch (_) { /* ignore */ }
            }
        }

    } catch (err) {
        console.error('[watch] tick error:', err.message);
    } finally {
        scrapeInFlight = false;
    }
}

function startWatchLoop(sock, targetNumbers) {

    if (scrapeTimer) return;

    console.log(
        `\n[watch] starting loop, every ${SCRAPE_INTERVAL_MS}ms\n`
    );

    // Run immediately, then on interval.
    tickOnce(sock, targetNumbers);
    scrapeTimer = setInterval(
        () => tickOnce(sock, targetNumbers),
        SCRAPE_INTERVAL_MS
    );
}

function stopWatchLoop() {
    if (scrapeTimer) {
        clearInterval(scrapeTimer);
        scrapeTimer = null;
    }
}

// ----------------------------------------------------------------------------
// WhatsApp bot lifecycle
// ----------------------------------------------------------------------------

let isConnecting = false;

async function startBot() {

    if (isConnecting) return;
    isConnecting = true;

    try {

        const targetNumbers = [
            process.env.TEST_TARGET_NUMBER || '+919876543210'
        ];

        const { state, saveCreds } = await useMultiFileAuthState('./auth');
        const { version } = await fetchLatestBaileysVersion();

        console.log('Using WA Version:', version);

        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'silent' }),
            browser: ['Ubuntu', 'Chrome', '20.0.04']
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on( 'connection.update', async (update) => {

            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('\nScan this QR using WhatsApp:\n');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'open') {
                console.log('\n✅ WhatsApp connected\n');
                // Give Baileys a moment to finish prekey upload + presence
                // sync before we start firing messages — sending too early
                // can leave the recipient stuck on "Waiting for this message".
                setTimeout(() => startWatchLoop(sock, targetNumbers), 3000);
            }

            if (connection === 'close') {

                stopWatchLoop();
                isConnecting = false;

                const error = lastDisconnect?.error;
                const statusCode = error?.output?.statusCode;

                console.log('\n❌ WhatsApp connection closed');
                console.log(JSON.stringify(
                    { statusCode, error: error?.message },
                    null,
                    2
                ));

                if (statusCode !== DisconnectReason.loggedOut) {
                    console.log('\n🔄 Reconnecting in 5 seconds...\n');
                    setTimeout(startBot, 5000);
                } else {
                    console.log('\n🚪 Logged out from WhatsApp\n');
                    await closeDriver();
                }
            }
        });

    } catch (error) {
        isConnecting = false;
        console.error('\nFatal error:', error);
        setTimeout(startBot, 5000);
    }
}

// Graceful shutdown — close the browser on Ctrl+C so the next run starts clean.
async function shutdown(signal) {
    console.log(`\nReceived ${signal}, shutting down...`);
    stopWatchLoop();
    await closeDriver();
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startBot();
