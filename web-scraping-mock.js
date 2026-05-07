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

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------

// Separate state file so mock testing doesn't pollute real .scraper-state.json
const STATE_FILE = path.resolve(__dirname, '.scraper-state.mock.json');

// Tick faster than prod so you can see the pipeline work — override via env.
const SCRAPE_INTERVAL_MS = parseInt(
    process.env.MOCK_SCRAPE_INTERVAL_MS || '15000',
    10
);

const MAX_NEW_RECORDS = 25;

// ----------------------------------------------------------------------------
// Mock data source
//
// Each call returns a "page 1" of rows newest-first. Between calls, the top
// reportKey advances by 1, so the watch loop sees a new record every tick and
// the WhatsApp send path gets exercised end-to-end.
// ----------------------------------------------------------------------------

let mockTickCount = 0;

const INSURANCES = [
    'UNITED HEALTHCARE INSURANCE COMPANY',
    'CGS - DME MAC JURISDICTION C',
    'Cigna Health and Life Insurance Company',
    'WELLMED MEDICAL MANAGEMENT, INC.',
    'UHC SUREST'
];

const SOURCES = ['Inovalon', 'ChangeHC', 'Inovalon', 'Inovalon'];

function pad(n, w) {
    return String(n).padStart(w, '0');
}

function fakeAmount(seed) {
    // Deterministic-ish "amount" so re-runs aren't pure noise.
    const cents = ((seed * 9301 + 49297) % 233280) / 100;
    return `$${cents.toFixed(2)}`;
}

function todayMmDdYyyy() {
    const d = new Date();
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function mockScrapeRows() {

    mockTickCount++;
    const newestKey = 71300 + mockTickCount;
    const today = todayMmDdYyyy();

    const rows = [];
    for (let i = 0; i < 20; i++) {
        const k = newestKey - i;
        rows.push({
            reportKey: String(k),
            ernDate: today,
            insurance: INSURANCES[k % INSURANCES.length],
            traceNumber: `TRC${pad(k, 8)}`,
            deposit: String(63000 + k),
            postDate: '',
            depositAmount: fakeAmount(k),
            balance: '$0.00',
            medicare: '',
            source: SOURCES[k % SOURCES.length]
        });
    }
    return rows;
}

// ----------------------------------------------------------------------------
// Sort + diff (identical to production logic)
// ----------------------------------------------------------------------------

// Mirrors prod: trust the page's own row order — row 0 is newest.
function rowId(r) {
    return `${r.reportKey}|${r.traceNumber}`;
}

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

async function getLatest() {

    const rows = mockScrapeRows();

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

async function sendWhatsAppMessage(sock, to, messageBody) {

    const jid = formatNumber(to);

    try {

        if (typeof sock.assertSessions === 'function') {
            try {
                await sock.assertSessions([jid], true);
            } catch (e) {
                console.warn(
                    `[whatsapp] assertSessions warning for ${to}: ${e.message}`
                );
            }
        }

        await sock.sendMessage(jid, { text: messageBody });
        console.log(`[whatsapp] sent to ${to}`);

    } catch (error) {
        console.error(`[whatsapp] send to ${to} failed: ${error.message}`);
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

        for (let i = 0; i < total; i++) {

            const row = result.newRecords[i];

            const messageBody = formatErnMessage(row, {
                firstRun: result.firstRun,
                index: i + 1,
                total
            });

            for (const number of targetNumbers) {
                await sendWhatsAppMessage(sock, number, messageBody);
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
        `\n[watch] MOCK mode, polling every ${SCRAPE_INTERVAL_MS}ms\n`
    );

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

        sock.ev.on('connection.update', async (update) => {

            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('\nScan this QR using WhatsApp:\n');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'open') {
                console.log('\n✅ WhatsApp connected (MOCK mode)\n');
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
                }
            }
        });

    } catch (error) {
        isConnecting = false;
        console.error('\nFatal error:', error);
        setTimeout(startBot, 5000);
    }
}

async function shutdown(signal) {
    console.log(`\nReceived ${signal}, shutting down...`);
    stopWatchLoop();
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startBot();
