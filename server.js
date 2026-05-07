const path = require('path');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');

const wa = require('./whatsapp');
const recipients = require('./recipients');

// ----------------------------------------------------------------------------
// Auth (login/logout, signed-cookie sessions)
// ----------------------------------------------------------------------------

const AUTH_USERNAME = process.env.SETTINGS_USERNAME || '';
const AUTH_PASSWORD = process.env.SETTINGS_PASSWORD || '';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const COOKIE_NAME = 'wa_session';

// Optional token for service-to-service trigger calls (e.g. cron hitting
// POST /api/scrape-now without going through the login flow).
const SCRAPE_TRIGGER_TOKEN = process.env.SCRAPE_TRIGGER_TOKEN || '';

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    if (AUTH_USERNAME && AUTH_PASSWORD) {
        console.warn(
            '[server] SESSION_SECRET not set — using a random per-process ' +
            'secret. Sessions invalidate on every restart. Set SESSION_SECRET ' +
            'in .env to keep them across restarts.'
        );
    }
}

function authConfigured() {
    return !!AUTH_USERNAME && !!AUTH_PASSWORD;
}

function signSession() {
    const payload = { exp: Date.now() + SESSION_TTL_MS };
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto
        .createHmac('sha256', SESSION_SECRET)
        .update(data)
        .digest('base64url');
    return `${data}.${sig}`;
}

function verifySession(token) {

    if (!token || typeof token !== 'string') return false;

    const dot = token.indexOf('.');
    if (dot < 1) return false;

    const data = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    const expected = crypto
        .createHmac('sha256', SESSION_SECRET)
        .update(data)
        .digest('base64url');

    if (sig.length !== expected.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return false;
    }

    try {
        const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
        return payload.exp > Date.now();
    } catch (_) {
        return false;
    }
}

function parseCookies(req) {
    const header = req.headers.cookie || '';
    const out = {};
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) out[k] = decodeURIComponent(v);
    }
    return out;
}

function setSessionCookie(res, token) {
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; ` +
        `HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
    );
}

function clearSessionCookie(res) {
    res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    );
}

function isAuthed(req) {
    if (!authConfigured()) return true;
    const cookies = parseCookies(req);
    return verifySession(cookies[COOKIE_NAME]);
}

const PUBLIC_PATHS = new Set([
    '/login',
    '/login.html',
    '/api/login',
    '/api/auth-config'
]);

function authMiddleware(req, res, next) {

    if (!authConfigured()) return next();

    if (PUBLIC_PATHS.has(req.path)) return next();

    // Cron / service trigger: a single endpoint can be called with a
    // shared-secret header instead of a session cookie.
    if (
        SCRAPE_TRIGGER_TOKEN &&
        req.method === 'POST' &&
        req.path === '/api/scrape-now' &&
        req.headers['x-scrape-token'] === SCRAPE_TRIGGER_TOKEN
    ) {
        return next();
    }

    if (isAuthed(req)) return next();

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    return res.redirect('/login.html');
}

function createServer(options = {}) {

    const scraper = options.scraper || null;

    const app = express();

    app.use(express.json({ limit: '64kb' }));

    // ---------------- public routes ----------------

    app.get('/api/auth-config', (_req, res) => {
        res.json({ enabled: authConfigured() });
    });

    app.post('/api/login', (req, res) => {

        if (!authConfigured()) {
            return res.json({ ok: true, configured: false });
        }

        const { username, password } = req.body || {};

        const ok =
            typeof username === 'string' &&
            typeof password === 'string' &&
            username === AUTH_USERNAME &&
            password === AUTH_PASSWORD;

        if (!ok) {
            // small constant delay reduces timing-attack signal
            return setTimeout(() => {
                res.status(401).json({ error: 'Invalid username or password' });
            }, 250);
        }

        setSessionCookie(res, signSession());
        res.json({ ok: true });
    });

    app.post('/api/logout', (_req, res) => {
        clearSessionCookie(res);
        res.json({ ok: true });
    });

    // If logged-in user hits /login.html, bounce to /
    app.get(['/login', '/login.html'], (req, res, next) => {
        if (authConfigured() && isAuthed(req)) {
            return res.redirect('/');
        }
        next();
    });

    // ---------------- gate ----------------

    app.use(authMiddleware);

    app.use(express.static(path.resolve(__dirname, 'public')));

    // ------------------------------------------------------------------
    // SSE — pushes status + qr updates to the UI in real time.
    // ------------------------------------------------------------------
    app.get('/api/events', (req, res) => {

        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();

        const send = (event, data) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        // initial snapshot
        send('status', wa.getStatus());

        const onStatus = () => send('status', wa.getStatus());
        const onQR = async (qr) => {
            try {
                const dataUrl = await QRCode.toDataURL(qr, {
                    margin: 1,
                    width: 320
                });
                send('qr', { dataUrl });
            } catch (err) {
                console.warn('[server] QR encode failed:', err.message);
            }
        };

        wa.on('connected', onStatus);
        wa.on('disconnected', onStatus);
        wa.on('profile', onStatus);
        wa.on('qr', onQR);

        // Scraper login state changes
        const onScraperState = (state) =>
            send('scraper-state', { state });
        if (scraper) {
            // initial snapshot
            send('scraper-state', { state: scraper.getState() });
            scraper.on('state', onScraperState);
        }

        // keepalive ping every 25s
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);

        req.on('close', () => {
            clearInterval(ping);
            wa.off('connected', onStatus);
            wa.off('disconnected', onStatus);
            wa.off('profile', onStatus);
            wa.off('qr', onQR);
            if (scraper) scraper.off('state', onScraperState);
        });
    });

    // ------------------------------------------------------------------
    // Status / connect / disconnect
    // ------------------------------------------------------------------
    app.get('/api/status', (_req, res) => {
        res.json(wa.getStatus());
    });

    app.get('/api/qr', async (_req, res) => {

        const status = wa.getStatus();
        if (status.connected) return res.json({ connected: true });
        if (!wa.lastQR) return res.json({ pending: true });

        try {
            const dataUrl = await QRCode.toDataURL(wa.lastQR, {
                margin: 1,
                width: 320
            });
            res.json({ dataUrl });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/connect', async (_req, res) => {
        try {
            await wa.start();
            res.json({ ok: true, status: wa.getStatus() });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/disconnect', async (_req, res) => {
        try {
            await wa.logout();
            res.json({ ok: true, status: wa.getStatus() });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // Groups + recipients
    // ------------------------------------------------------------------
    app.get('/api/groups', async (_req, res) => {

        if (!wa.getStatus().connected) {
            return res.status(409).json({
                error: 'WhatsApp is not connected'
            });
        }

        const groups = await wa.fetchGroups();
        res.json({ groups });
    });

    // Debug helper: fire a direct test message at any JID. Useful for
    // isolating "does Baileys + this account actually deliver to this
    // group?" from the watch-loop / scraper plumbing.
    app.post('/api/test-send', async (req, res) => {

        const sock = wa.getSocket();
        if (!sock) {
            return res.status(409).json({ error: 'WhatsApp is not connected' });
        }

        const { jid, text } = req.body || {};
        if (!jid || typeof jid !== 'string') {
            return res.status(400).json({ error: 'jid is required' });
        }

        const body = (typeof text === 'string' && text.trim())
            || `Test ping at ${new Date().toISOString()}`;

        try {

            if (jid.endsWith('@g.us')) {

                // Make sure we have metadata for the group. cachedGroupMetadata
                // (configured on the socket) will hand it back to Baileys
                // during the actual send.
                const meta = await wa.getCachedGroupMetadata(jid);

                if (!meta) {
                    return res.status(404).json({
                        error: 'No metadata for that group JID — the bot ' +
                               'account is probably not a member.'
                    });
                }

                // Self-only groups can't be sent to: WhatsApp's group
                // encryption needs a session with at least one *other*
                // participant. Surface this up front instead of letting
                // libsignal throw "No sessions" deep in the send pipeline.
                const myBase = (wa.getSocket()?.user?.id || '').split(':')[0];
                const myLid  = (wa.getSocket()?.user?.lid || '').split(':')[0];
                const others = (meta.participants || []).filter((p) => {
                    const pBase = (p.id || '').split('@')[0].split(':')[0];
                    return pBase && pBase !== myBase && pBase !== myLid;
                });

                if (others.length === 0) {
                    return res.status(409).json({
                        error: 'This group has no other participants. ' +
                               'WhatsApp can\'t deliver to a group whose ' +
                               'only member is the bot. Add at least one ' +
                               'other person to the group first.'
                    });
                }

            } else {
                if (typeof sock.assertSessions === 'function') {
                    try { await sock.assertSessions([jid], true); }
                    catch (_) { /* ignore */ }
                }
            }

            const result = await sock.sendMessage(jid, { text: body });

            res.json({
                ok: true,
                messageId: result?.key?.id || null,
                jid: result?.key?.remoteJid || jid
            });

        } catch (err) {
            console.error('[server] /api/test-send failed:', err);

            // Translate libsignal "No sessions" into a humane explanation.
            const msg = String(err && err.message || err);
            if (/no sessions/i.test(msg)) {
                return res.status(409).json({
                    error: 'No Signal sessions available for this recipient. ' +
                           'For groups this almost always means the only ' +
                           'participant is the bot itself — add another ' +
                           'real member to the group and try again.'
                });
            }

            res.status(500).json({
                error: err.message,
                stack: err.stack
            });
        }
    });

    app.get('/api/recipients', (_req, res) => {
        res.json({ recipients: recipients.getAll() });
    });

    // Bulk replace — kept for parity, but the UI shouldn't call this
    // because it forces the client to ship a full snapshot of state and
    // races with concurrent edits.
    app.post('/api/recipients', (req, res) => {
        try {
            const list = req.body && req.body.recipients;
            const saved = recipients.saveAll(list);
            res.json({ ok: true, recipients: saved });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // Atomic add — re-reads file, appends, writes back. Safe under
    // concurrent edits and stale client caches.
    app.post('/api/recipients/add', (req, res) => {
        try {
            const item = req.body || {};
            const list = recipients.addOne(item);
            res.json({ ok: true, recipients: list });
        } catch (err) {
            const status =
                err.code === 'DUPLICATE' ? 409 :
                err.code === 'INVALID'   ? 400 : 500;
            res.status(status).json({
                error: err.message,
                code: err.code || null
            });
        }
    });

    // Atomic remove. No-op if not found.
    app.post('/api/recipients/remove', (req, res) => {
        try {
            const { type, value } = req.body || {};
            const list = recipients.removeOne(type, value);
            res.json({ ok: true, recipients: list });
        } catch (err) {
            const status = err.code === 'INVALID' ? 400 : 500;
            res.status(status).json({
                error: err.message,
                code: err.code || null
            });
        }
    });

    // ------------------------------------------------------------------
    // Brightree scraper login lifecycle (manual control)
    // ------------------------------------------------------------------
    app.get('/api/scraper/status', (_req, res) => {
        if (!scraper) return res.json({ state: 'unknown' });
        res.json({ state: scraper.getState() });
    });

    app.post('/api/scraper/login', async (_req, res) => {
        if (!scraper) {
            return res.status(503).json({ error: 'scraper not initialised' });
        }
        try {
            const state = await scraper.login();
            res.json({ ok: true, state });
        } catch (err) {
            console.error('[server] scraper login failed:', err);
            res.status(500).json({
                error: err.message,
                state: scraper.getState()
            });
        }
    });

    app.post('/api/scraper/logout', async (_req, res) => {
        if (!scraper) {
            return res.status(503).json({ error: 'scraper not initialised' });
        }
        try {
            await scraper.logout();
            res.json({ ok: true, state: scraper.getState() });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // External trigger — fire a single scrape tick on demand. Designed
    // for cron / external schedulers; can be called by either an authed
    // session or an X-Scrape-Token header (configured via env).
    //
    //     curl -X POST -H "X-Scrape-Token: $TOKEN" \
    //          http://localhost:3000/api/scrape-now
    //
    app.post('/api/scrape-now', async (_req, res) => {

        if (!scraper) {
            return res.status(503).json({ error: 'scraper not initialised' });
        }

        try {
            // Fire and wait for completion so the caller sees the result
            // synchronously. tickNow internally guards against overlapping
            // ticks (returns immediately if one is already running).
            await scraper.tickNow();
            res.json({ ok: true, state: scraper.getState() });
        } catch (err) {
            console.error('[server] /api/scrape-now failed:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // Last-synced record (so the UI can show last-seen ERN)
    // ------------------------------------------------------------------
    app.get('/api/scraper-state', (_req, res) => {
        const fs = require('fs');
        const STATE_FILE = path.resolve(__dirname, '.scraper-state.json');
        try {
            const obj = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            res.json(obj);
        } catch (_) {
            res.json({});
        }
    });

    return app;
}

module.exports = { createServer };
