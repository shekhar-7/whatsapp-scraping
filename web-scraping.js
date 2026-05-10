require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const axios = require('axios');
const cheerio = require('cheerio');

const wa = require('./whatsapp');
const recipients = require('./recipients');
const auth = require('./auth');
const { createServer } = require('./server');

// ----------------------------------------------------------------------------
// Brightree scraper state
// ----------------------------------------------------------------------------

const SCRAPER_STATE = {
    UNKNOWN: 'unknown',          
    ACTIVE: 'active',            
    SESSION_LOST: 'session-lost',
    LOGGED_OUT: 'logged-out'     
};

const scraperEvents = new EventEmitter();
let scraperState = SCRAPER_STATE.UNKNOWN;

function setScraperState(next) {
    if (next === scraperState) return;
    scraperState = next;
    console.log(`[scraper] state -> ${next}`);
    scraperEvents.emit('state', next);
}

function getScraperState() {
    return scraperState;
}

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------

const STATE_FILE = path.resolve(__dirname, '.scraper-state.json');

const SCRAPE_INTERVAL_MS = parseInt(
    process.env.SCRAPE_INTERVAL_MS || '60000',
    10
);

const MAX_NEW_RECORDS = 25;

// ----------------------------------------------------------------------------
// API Scraping logic
// ----------------------------------------------------------------------------

async function fetchErnData() {
    // Check if we have a valid session, if not, auto-login!
    if (!(await auth.checkSession())) {
        console.log('[scraper] Session missing. Attempting auto-login...');
        await auth.login(process.env.BRIGHTREE_USERNAME, process.env.BRIGHTREE_PASSWORD);
    }
    
    const url = 'https://brightree.net/F1/01825/PulmRX/ARManagement/frmPrivateERNs.aspx';
    
    // Step 1: GET the page to retrieve a fresh __VIEWSTATE and __EVENTVALIDATION
    const client = auth.getClient();
    console.log('[scraper] Fetching fresh viewstate for search...');
    const getResponse = await client.get(url, {
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Upgrade-Insecure-Requests': '1',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
        }
    });

    // If the GET request redirects to login, refresh session and retry GET
    if (getResponse.request && getResponse.request.res && getResponse.request.res.responseUrl && getResponse.request.res.responseUrl.includes('login.brightree.net')) {
        console.log('[scraper] Session expired on GET. Refreshing session...');
        await auth.login(process.env.BRIGHTREE_USERNAME, process.env.BRIGHTREE_PASSWORD);
        return fetchErnData(); // Recursively retry after login
    }

    const $ = cheerio.load(getResponse.data);
    const viewState = $('#__VIEWSTATE').val() || '';
    const viewStateGenerator = $('#__VIEWSTATEGENERATOR').val() || '';
    const eventValidation = $('#__EVENTVALIDATION').val() || '';

    // Step 2: Prepare the POST payload
    const basePayload = process.env.BRIGHTREE_API_BODY || '';
    const params = new URLSearchParams(basePayload);
    
    // Inject the fresh tokens into the payload
    params.set('__VIEWSTATE', viewState);
    params.set('__VIEWSTATEGENERATOR', viewStateGenerator);
    params.set('__EVENTVALIDATION', eventValidation);
    // Ensure the event target is the search button
    params.set('__EVENTTARGET', 'm$ctl00$c$c$btnSearch');
    params.set('__EVENTARGUMENT', '');
    
    const dataRaw = params.toString();
    
    try {
        const client = auth.getClient();
        let response = await client.post(url, dataRaw, {
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-GB,en;q=0.5',
                'Cache-Control': 'max-age=0',
                'Connection': 'keep-alive',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': 'https://brightree.net',
                'Referer': 'https://brightree.net/F1/01825/PulmRX/ARManagement/frmPrivateERNs.aspx',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-User': '?1',
                'Sec-GPC': '1',
                'Upgrade-Insecure-Requests': '1',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
                'sec-ch-ua': '"Brave";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"macOS"'
            }
        });
        
        // If we landed on the login page, the session is invalid/expired
        if (response.request && response.request.res && response.request.res.responseUrl && response.request.res.responseUrl.includes('login.brightree.net')) {
            console.log('[scraper] Grid request redirected to login. Refreshing session...');
            await auth.login(process.env.BRIGHTREE_USERNAME, process.env.BRIGHTREE_PASSWORD);
            // Retry once
            const freshClient = auth.getClient();
            response = await freshClient.post(url, dataRaw, {
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en-GB,en;q=0.5',
                    'Cache-Control': 'max-age=0',
                    'Connection': 'keep-alive',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': 'https://brightree.net',
                    'Referer': 'https://brightree.net/F1/01825/PulmRX/ARManagement/frmPrivateERNs.aspx',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'same-origin',
                    'Sec-Fetch-User': '?1',
                    'Sec-GPC': '1',
                    'Upgrade-Insecure-Requests': '1',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
                    'sec-ch-ua': '"Brave";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': '"macOS"'
                }
            });
        }
        
        return response.data;
    } catch (error) {
        console.error('[scraper] API request failed:', error.message);
        throw error;
    }
}

function parseRows(html) {
    const $ = cheerio.load(html);
    const rows = [];
    
    const headers = [];
    $('#m_ctl00_c_c_dgResults th.rgHeader').each((i, el) => {
        headers.push($(el).text().trim());
    });
    
    // Fallback if header finding fails, match the indexes found in the user's HTML snippet
    const headerMap = {};
    headers.forEach((h, i) => {
        if (h) headerMap[h] = i;
    });

    $('#m_ctl00_c_c_dgResults tr.rgRow, #m_ctl00_c_c_dgResults tr.rgAltRow').each((i, row) => {
        const cells = $(row).find('td');
        const texts = [];
        cells.each((j, c) => texts.push($(c).text().trim()));
        
        const pick = (...candidates) => {
            for (const name of candidates) {
                if (name in headerMap) {
                    const idx = headerMap[name];
                    if (idx < texts.length) return texts[idx] || '';
                }
            }
            return '';
        };

        const reportKey = pick('Report Key', 'ReportKey');
        const ernDate = pick('ERN Date', 'ERNDate');
        const insurance = pick('Insurance');
        const traceNumber = pick('Trace Number', 'TraceNumber');
        const deposit = pick('Deposit');
        const postDate = pick('Post Date', 'PostDate');
        const depositAmount = pick('Deposit Amount', 'DepositAmount');
        const balance = pick('Balance');
        const medicare = pick('Medicare');
        const source = pick('Source');

        if (!reportKey && !traceNumber && !ernDate) return;

        let eobId = null;
        try {
            // Debug: Log all links in the row to find the EOB pattern
            const links = $(row).find('a');
            links.each((_, link) => {
                const href = $(link).attr('href') || '';
                const text = $(link).text().trim();
                if (text.includes('EOB') || href.includes('EOB')) {
                    console.log(`[scraper-debug] Found potential EOB link: text="${text}", href="${href}"`);
                    // Try to extract ID from ViewERN(123, 'EOB', 456)
                    const m = href.match(/ViewERN\(\s*\d+\s*,\s*'EOB'\s*,\s*(\d+)\s*\)/);
                    if (m) {
                        eobId = m[1];
                        console.log(`[scraper] Extracted EOB ID: ${eobId}`);
                    }
                }
            });
        } catch (err) {
            console.error('[scraper-debug] Error parsing EOB link:', err.message);
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
    });

    return rows;
}

function rowId(r) {
    return `${r.reportKey}|${r.traceNumber}`;
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
    setScraperState(SCRAPER_STATE.ACTIVE);
    
    let html;
    try {
        html = await fetchErnData();
    } catch (err) {
        setScraperState(SCRAPER_STATE.UNKNOWN);
        throw err;
    }

    const rows = parseRows(html);

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

    newRecords = newRecords.slice().reverse();

    return { newRecords, latest, allOnPage: rows, firstRun };
}

// ----------------------------------------------------------------------------
// WhatsApp message formatting + sending
// ----------------------------------------------------------------------------

function formatErnMessage(row) {
    const fmt = (s) => (s && String(s).trim()) || '—';
    const amount = (row.depositAmount && row.depositAmount.trim()) || '$0.00';

    return [
        `💰 *${amount}*`,
        '',
        fmt(row.ernDate),
        fmt(row.insurance)
    ].join('\n');
}

async function downloadPdf(eobId) {
    if (!eobId) return null;
    
    console.log(`[scraper] downloading PDF for EOB ${eobId}...`);
    // Updated URL parameters based on user's working curl
    const viewerUrl = `https://brightree.net/F1/01825/PulmRX/ARManagement/frmViewERN.aspx?ReportKey=0&ReportType=EOB&MedavantERAKey=${eobId}`;
    const client = auth.getClient();
    
    try {
        // Step 1: Hit the viewer page
        const res = await client.get(viewerUrl, {
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Referer': 'https://brightree.net/F1/01825/PulmRX/ARManagement/frmPrivateERNs.aspx'
            }
        });
        
        let pdfUrl = viewerUrl; // Default to viewer URL
        
        // If it's HTML, try to find the PDF link inside (iframe or embed)
        if (res.headers['content-type'] && res.headers['content-type'].includes('text/html')) {
            const $ = cheerio.load(res.data);
            
            // Debug: Log more content
            console.log(`[scraper-debug] Body starts with: ${res.data.toString().substring(0, 1000)}`);
            
            if (res.data.toString().includes('Session Expired') || res.data.toString().includes('login.brightree.net')) {
                console.error('[scraper] Session expired while trying to download PDF.');
                return null;
            }

            // Brightree often uses an iframe or a specific link for the PDF content
            const iframe = $('iframe#pdfViewer, iframe[src*=".pdf"], iframe[src*="ViewERN"], embed[src*=".pdf"]');
            if (iframe.length) {
                pdfUrl = iframe.attr('src');
                console.log(`[scraper-debug] Found raw iframe/embed src: ${pdfUrl}`);
                if (pdfUrl && !pdfUrl.startsWith('http')) {
                    pdfUrl = new URL(pdfUrl, 'https://brightree.net').href;
                }
                console.log(`[scraper] Found actual PDF URL from iframe: ${pdfUrl}`);
            } else {
                // If no iframe, look for ANY link that might be the PDF
                const allLinks = [];
                $('a').each((_, a) => allLinks.push({ text: $(a).text().trim(), href: $(a).attr('href') }));
                console.log(`[scraper-debug] All links on viewer page:`, JSON.stringify(allLinks.slice(0, 10)));

                const downloadLink = $('a[href*=".pdf"], a:contains("Download"), a[href*="GetFile"], a[href*="DownloadFile"]');
                if (downloadLink.length) {
                    pdfUrl = downloadLink.attr('href');
                    if (pdfUrl && !pdfUrl.startsWith('http')) {
                        pdfUrl = new URL(pdfUrl, 'https://brightree.net').href;
                    }
                    console.log(`[scraper] Found download link: ${pdfUrl}`);
                }
            }
        }

        // If the pdfUrl is still the viewerUrl and we didn't find a better one,
        // it's likely we are just hitting the viewer page again.
        if (pdfUrl === viewerUrl) {
            console.warn(`[scraper] Could not find a specific PDF link on the viewer page. Retrying with binary headers...`);
        }

        // Step 2: Download the actual PDF binary
        const pdfRes = await client.get(pdfUrl, {
            responseType: 'arraybuffer',
            headers: {
                'Accept': 'application/pdf, */*',
                'Referer': viewerUrl
            }
        });
        
        if (pdfRes.headers['content-type'] && pdfRes.headers['content-type'].includes('application/pdf')) {
            return Buffer.from(pdfRes.data);
        } else {
            console.warn(`[scraper] Failed to get PDF from ${pdfUrl} (type: ${pdfRes.headers['content-type']})`);
            return null;
        }
    } catch (err) {
        console.error(`[scraper] PDF download for ${eobId} failed:`, err.message);
        return null;
    }
}

async function ensureFreshSession(sock, jid) {
    if (typeof sock.assertSessions !== 'function') return;

    if (typeof jid === 'string' && jid.endsWith('@g.us')) {
        try {
            const others = await wa.getOtherParticipantJids(jid);
            if (others && others.length) {
                await sock.assertSessions(others, true);
            }
        } catch (e) {
            console.warn(`[whatsapp] group session warmup warning for ${jid}: ${e.message}`);
        }
        return;
    }

    try {
        await sock.assertSessions([jid], true);
    } catch (e) {
        console.warn(`[whatsapp] assertSessions warning for ${jid}: ${e.message}`);
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
            console.warn(`[whatsapp] no group metadata available for ${jid} — the bot's account may not be a member of this group`);
            return;
        }

        const participants = meta.participants || [];
        const isMember = participants.some((p) => wa.isSelfId(p.id));

        console.log(`[whatsapp] group "${meta.subject}" participants=${participants.length} botIsMember=${isMember}`);

        if (!isMember) {
            console.warn('[whatsapp] >>> bot account is NOT in this group; the message will not be delivered.');
        }
    } catch (err) {
        console.warn(`[whatsapp] group context lookup failed for ${jid}: ${err.message}`);
    }
}

async function sendWhatsAppMessage(sock, jid, messageBody, pdfBuffer, fileName) {
    try {
        await debugLogGroupContext(jid);
        await ensureFreshSession(sock, jid);
        
        if (pdfBuffer) {
            // Send as a single document message with caption
            await sock.sendMessage(jid, {
                document: pdfBuffer,
                fileName: fileName || 'Document.pdf',
                caption: messageBody,
                mimetype: 'application/pdf'
            });
            console.log(`[whatsapp] sent PDF with caption to ${jid} (${fileName})`);
        } else {
            // Fallback to plain text if no PDF
            const result = await sock.sendMessage(jid, { text: messageBody });
            const id = result && result.key && result.key.id;
            if (id && result.message) {
                wa.rememberSentMessage(id, result.message);
            }
            console.log(`[whatsapp] sent text to ${jid} (id=${id || 'unknown'})`);
        }
    } catch (error) {
        console.error(`[whatsapp] send to ${jid} failed: ${error && error.stack || error}`);
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
            console.log(`[watch] no change (latest=${result.latest.reportKey} ${result.latest.ernDate})`);
            return;
        }

        const total = result.newRecords.length;
        console.log(`[watch] sending ${total} record(s) to ${jids.length} recipient(s) (firstRun=${result.firstRun})`);

        for (let i = 0; i < total; i++) {
            const row = result.newRecords[i];
            const messageBody = formatErnMessage(row);

            let pdfBuffer = null;
            if (row.eobId) {
                pdfBuffer = await downloadPdf(row.eobId);
            }
            
            for (const jid of jids) {
                await sendWhatsAppMessage(sock, jid, messageBody, pdfBuffer, `EOB_${row.eobId || 'Doc'}.pdf`);
            }
        }
    } catch (err) {
        console.error('[watch] tick error:', err.message);
    } finally {
        scrapeInFlight = false;
    }
}

function startWatchLoop() {
    if (scrapeTimer) return;

    if (!SCRAPE_INTERVAL_MS || SCRAPE_INTERVAL_MS <= 0) {
        console.log('\n[watch] internal scheduler disabled. Drive scraping via POST /api/scrape-now.\n');
        return;
    }

    console.log(`\n[watch] starting loop, every ${SCRAPE_INTERVAL_MS}ms\n`);

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
    // API is static, so just mark as active
    setScraperState(SCRAPER_STATE.ACTIVE);
    return getScraperState();
}

async function logoutFromBrightree() {
    setScraperState(SCRAPER_STATE.LOGGED_OUT);
}

async function test5Records() {
    console.log('[test] fetching API...');
    let html;
    try {
        html = await fetchErnData();
        console.log(`[test] HTML fetched, length: ${html.length} bytes`);
        if (html.includes('id="m_ctl00_c_c_dgResults"')) {
            console.log('[test] Found data grid in HTML.');
        } else {
            console.log('[test] Warning: Could not find data grid in HTML. Viewstate might be invalid or page might be an error page.');
        }
    } catch (err) {
        console.error('[test] fetch error:', err.message);
        return;
    }

    const rows = parseRows(html);
    if (!rows.length) {
        console.log('[test] no rows found.');
        return;
    }

    const top5 = rows.slice(0, 5).reverse(); // reverse so the newest is at the bottom in WhatsApp
    console.log(`[test] found ${rows.length} rows, sending top ${top5.length} to WhatsApp.`);

    const sock = wa.getSocket();
    if (!sock) {
        console.log('[test] WhatsApp not connected. Start the server and connect first.');
        return;
    }

    const jids = getActiveJids();
    if (!jids.length) {
        console.log('[test] no recipients configured.');
        return;
    }

    for (let i = 0; i < top5.length; i++) {
        const row = top5[i];
        const msg = formatErnMessage(row);
        
        let pdf = null;
        if (row.eobId) {
            pdf = await downloadPdf(row.eobId);
        }

        for (const jid of jids) {
            await sendWhatsAppMessage(sock, jid, msg, pdf, `EOB_${row.eobId || 'Doc'}.pdf`);
        }
    }
    console.log('[test] 5 records test complete.');
}

// Surface for server.js so the API can drive the scraper.
const scraperApi = {
    getState: getScraperState,
    on: scraperEvents.on.bind(scraperEvents),
    off: scraperEvents.off.bind(scraperEvents),
    login: loginToBrightree,
    logout: logoutFromBrightree,
    tickNow: () => tickOnce(),
    test5: test5Records
};

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
            console.warn(`[boot] could not clear ${path.basename(file)}: ${err.message}`);
        }
    }
}

// ----------------------------------------------------------------------------
// Boot — Express server + WhatsApp manager + watch loop
// ----------------------------------------------------------------------------

const HTTP_PORT = parseInt(process.env.PORT || '3000', 10);

async function boot() {
    const app = createServer({ scraper: scraperApi });
    app.listen(HTTP_PORT, () => {
        console.log(`\n🌐  Settings UI: http://localhost:${HTTP_PORT}\n`);
    });

    // Dummy interval to prevent the Node event loop from exiting
    // when there are no other active handles.
    setInterval(() => {}, 60 * 60 * 1000);

    wa.on('connected', () => {
        setTimeout(startWatchLoop, 3000);
    });

    wa.on('disconnected', (info) => {
        stopWatchLoop();
        if (info && info.loggedOut) {
            clearLocalAppData();
        }
    });

    const hasAuth = fs.existsSync(path.resolve(__dirname, 'auth')) &&
        fs.readdirSync(path.resolve(__dirname, 'auth')).length > 0;

    if (hasAuth) {
        console.log('[boot] saved auth detected — auto-connecting WhatsApp');
        wa.start().catch((err) => console.error('[boot] wa.start failed:', err));
    } else {
        console.log('[boot] no saved auth — open the settings UI and click "Connect" to pair a device');
    }
}

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) {
        console.log('Force exit.');
        process.exit(1);
    }
    shuttingDown = true;

    console.log(`\nReceived ${signal}, shutting down...`);
    stopWatchLoop();

    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

boot().catch((err) => {
    console.error('Fatal boot error:', err);
    process.exit(1);
});
