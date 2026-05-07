const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const P = require('pino');

const AUTH_DIR = path.resolve(__dirname, 'auth');

/**
 * Locate the bot's own entry inside a group's participant list. Group
 * participants in WhatsApp may be listed by either the user's
 * `s.whatsapp.net` JID or `lid`, and the device-suffix (`:N`) varies
 * between sessions, so we strip that and match on the base id.
 */
function baseId(jid) {
    if (!jid || typeof jid !== 'string') return '';
    const at = jid.indexOf('@');
    const left = at < 0 ? jid : jid.slice(0, at);
    const colon = left.indexOf(':');
    const base = colon < 0 ? left : left.slice(0, colon);
    const domain = at < 0 ? '' : jid.slice(at);
    return base + domain;
}

function findBotParticipant(participants, userJid, userLid) {
    if (!participants || !participants.length) return null;
    const wanted = new Set(
        [userJid, userLid].filter(Boolean).map(baseId)
    );
    if (!wanted.size) return null;
    return participants.find((p) => wanted.has(baseId(p.id))) || null;
}

class WhatsAppManager extends EventEmitter {

    constructor() {
        super();
        this.sock = null;
        this.starting = false;
        this.intentionalLogout = false;

        this.connected = false;
        this.user = null;
        this.lastQR = null;
        this.lastQRDataUrl = null;
        this.pairedAt = null;
        this.profilePictureUrl = null;

        // Group metadata cache feeding sendMessage(..., { cachedGroupMetadata }).
        // Baileys' internal group cache isn't always populated by
        // groupFetchAllParticipating(), so we keep our own and hand it back
        // via the option below.
        this.groupMetadataCache = new Map();

        // Recently-sent message bodies — used by the getMessage callback so
        // Baileys can re-encrypt and re-send when a recipient sends a
        // "retry receipt" because their device couldn't decrypt the
        // original (the "Waiting for this message…" symptom). LRU-bounded
        // to keep memory in check.
        this.sentMessageStore = new Map();
        this.sentMessageStoreMax = 300;
    }

    rememberSentMessage(id, content) {
        if (!id || !content) return;
        this.sentMessageStore.set(id, content);
        if (this.sentMessageStore.size > this.sentMessageStoreMax) {
            const firstKey = this.sentMessageStore.keys().next().value;
            this.sentMessageStore.delete(firstKey);
        }
    }

    async getCachedGroupMetadata(jid) {

        if (this.groupMetadataCache.has(jid)) {
            return this.groupMetadataCache.get(jid);
        }

        if (!this.sock) return undefined;

        try {
            const meta = await this.sock.groupMetadata(jid);
            this.groupMetadataCache.set(jid, meta);
            return meta;
        } catch (err) {
            console.warn(
                `[wa] groupMetadata fetch failed for ${jid}: ${err.message}`
            );
            return undefined;
        }
    }

    /**
     * Remove the bot's own identity from a group's participant list.
     *
     * Why: when sending to a group, Baileys iterates participants, fans out
     * to each device, and asserts a Signal session for each. If the
     * participant list still contains the bot's own LID/PN, Baileys tries
     * to set up a session with self and libsignal throws "No sessions"
     * (since you don't keep a pairwise session with yourself). WhatsApp's
     * server handles multi-device fan-out for the sender's own account
     * separately, so dropping self from the encryption list is safe.
     *
     * Comparison strips the device suffix (`:16`) and matches on the base
     * identity, so the device that's currently the bot AND any other
     * device on the same account both get filtered.
     */
    _stripSelfFromMetadata(meta) {

        if (!meta || !meta.participants) return meta;

        const myJidBase = baseId(this.user?.id || '');
        const myLidBase = baseId(this.user?.lid || '');
        const wanted = new Set([myJidBase, myLidBase].filter(Boolean));

        if (!wanted.size) return meta;

        const before = meta.participants.length;
        const filtered = meta.participants.filter(
            (p) => !wanted.has(baseId(p.id || ''))
        );

        if (filtered.length === before) return meta;

        return { ...meta, participants: filtered };
    }

    /** Start (or resume) a Baileys socket. Safe to call repeatedly. */
    async start() {

        if (this.sock || this.starting) return;
        this.starting = true;

        try {

            if (!fs.existsSync(AUTH_DIR)) {
                fs.mkdirSync(AUTH_DIR, { recursive: true });
            }

            const { state, saveCreds } =
                await useMultiFileAuthState(AUTH_DIR);
            const { version } = await fetchLatestBaileysVersion();

            console.log('[wa] starting socket, baileys version:', version);

            const baileysLogLevel =
                (process.env.BAILEYS_LOG_LEVEL || 'silent').toLowerCase();

            // cachedGroupMetadata used to be a per-message option, but is
            // now part of the socket config. Baileys calls this whenever
            // it needs group metadata to encrypt a group message; we hand
            // back what we already pre-warmed (filtered to exclude self —
            // see notes below) and let Baileys fall back to its own fetch
            // on a miss.
            const cachedGroupMetadata = async (jid) => {
                if (!this.groupMetadataCache.has(jid)) return undefined;
                const meta = this.groupMetadataCache.get(jid);
                return this._stripSelfFromMetadata(meta);
            };

            // Baileys calls this when a recipient asks for a retry on a
            // message we previously sent. Returning the original content
            // lets it re-encrypt with a freshly negotiated Signal session.
            // Returning undefined makes Baileys send a "deleted message"
            // placeholder, which is the fix you want to AVOID.
            const getMessage = async (key) => {
                const cached =
                    this.sentMessageStore.get(key && key.id) || undefined;
                if (!cached) {
                    console.warn(
                        `[wa] getMessage miss for id=${key && key.id} — ` +
                        'recipient retry will produce a placeholder'
                    );
                }
                return cached;
            };

            const sock = makeWASocket({
                version,
                auth: state,
                logger: P({ level: baileysLogLevel }),
                browser: ['Ubuntu', 'Chrome', '20.0.04'],
                printQRInTerminal: false,
                cachedGroupMetadata,
                getMessage
            });

            // Cache every message we send so getMessage above can find
            // them when a retry receipt comes back.
            sock.ev.on('messages.upsert', ({ messages }) => {
                for (const m of messages || []) {
                    if (m.key && m.key.fromMe && m.message && m.key.id) {
                        this.rememberSentMessage(m.key.id, m.message);
                    }
                }
            });

            // Surface retry receipts in the log — a real retry from the
            // recipient end is a strong signal that getMessage was needed.
            sock.ev.on('message-receipt.update', (updates) => {
                for (const u of updates || []) {
                    const t = u && u.receipt && u.receipt.type;
                    if (t === 'retry' || t === 'pending-retry') {
                        console.log(
                            `[wa] retry receipt: type=${t} ` +
                            `from=${u.key && u.key.remoteJid} ` +
                            `id=${u.key && u.key.id}`
                        );
                    }
                }
            });

            sock.ev.on('creds.update', saveCreds);
            sock.ev.on('connection.update', (u) => this._handleUpdate(u));

            // Track delivery status for messages we sent so the operator
            // can see if a group send actually reached the server vs
            // silently stayed local. We only emit a log when the status
            // changes, not on every duplicate update.
            sock.ev.on('messages.update', (updates) => {
                for (const u of updates || []) {
                    if (!u.key || !u.key.fromMe) continue;
                    const status = u.update && u.update.status;
                    if (typeof status !== 'number') continue;
                    const label =
                        status === 0 ? 'ERROR' :
                        status === 1 ? 'PENDING' :
                        status === 2 ? 'SERVER_ACK' :
                        status === 3 ? 'DELIVERY_ACK' :
                        status === 4 ? 'READ' :
                        status === 5 ? 'PLAYED' : `?(${status})`;
                    console.log(
                        `[wa] msg status: ${label} ` +
                        `to=${u.key.remoteJid} id=${u.key.id}`
                    );
                }
            });

            this.sock = sock;
            this.intentionalLogout = false;

        } finally {
            this.starting = false;
        }
    }

    async _handleUpdate(update) {

        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            this.lastQR = qr;
            console.log('[wa] QR code received — open the settings UI to scan');
            this.emit('qr', qr);
        }

        if (connection === 'open') {
            this.connected = true;
            this.lastQR = null;
            this.lastQRDataUrl = null;
            this.user = this.sock?.user
                ? {
                    id: this.sock.user.id,
                    name: this.sock.user.name,
                    lid: this.sock.user.lid
                }
                : null;
            this.pairedAt = new Date().toISOString();
            this.profilePictureUrl = null;
            console.log('[wa] connected as', this.user?.id);
            this.emit('connected', this.user);

            // Fetch the profile picture in the background — don't block
            // the connection on it (the URL may be unavailable for accounts
            // with privacy settings restricting profile pics).
            this._refreshProfilePicture().catch(() => { /* swallowed */ });

            // Pre-warm the group metadata cache. Group sends need each
            // participant's Signal session info to encrypt the message; if
            // metadata isn't cached when sendMessage runs, the send can
            // silently no-op. Doing this proactively after every connect
            // means the watch loop's first tick can hit groups reliably
            // without depending on the settings UI being open.
            this._warmGroupCache().catch(() => { /* swallowed */ });

            // Make sure our pre-key bundle on the WhatsApp server is fresh
            // so recipients can establish Signal sessions with us. Without
            // this, a fresh recipient that has never messaged the bot can
            // get stuck on "Waiting for this message…" because their first
            // session attempt fails and they have no recent pre-keys to
            // retry with.
            this._refreshPreKeys().catch(() => { /* swallowed */ });
        }

        if (connection === 'close') {

            const code = lastDisconnect?.error?.output?.statusCode;
            const wasLoggedOut =
                code === DisconnectReason.loggedOut || this.intentionalLogout;

            this.connected = false;
            this.user = null;
            this.sock = null;

            console.log(
                `[wa] connection closed (code=${code}, loggedOut=${wasLoggedOut})`
            );

            this.emit('disconnected', { code, loggedOut: wasLoggedOut });

            if (!wasLoggedOut) {
                console.log('[wa] reconnecting in 5s...');
                setTimeout(() => this.start().catch(console.error), 5000);
            } else {
                this.intentionalLogout = false;
            }
        }
    }

    /** Logout from WhatsApp and clear local auth. */
    async logout() {

        this.intentionalLogout = true;

        if (this.sock) {
            try {
                await this.sock.logout();
            } catch (err) {
                console.warn('[wa] sock.logout failed:', err.message);
            }
        }

        // Best-effort wipe of credentials so the next start triggers a QR.
        try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (err) {
            console.warn('[wa] failed to remove auth dir:', err.message);
        }

        this.sock = null;
        this.connected = false;
        this.user = null;
        this.lastQR = null;
        this.lastQRDataUrl = null;
        this.pairedAt = null;

        this.emit('disconnected', { code: null, loggedOut: true });
    }

    async _refreshProfilePicture() {

        if (!this.sock || !this.user) return;

        const jid = this.user.id;

        try {
            const url = await this.sock.profilePictureUrl(jid, 'image');
            if (url && this.connected) {
                this.profilePictureUrl = url;
                this.emit('profile', { profilePictureUrl: url });
            }
        } catch (err) {
            // Privacy settings or no picture set — leave null and let the
            // UI fall back to the default avatar.
            this.profilePictureUrl = null;
        }
    }

    async _refreshPreKeys() {

        if (!this.sock) return;

        // Baileys exposes a couple of variants depending on version; we
        // prefer the "if required" variant so we don't churn the bundle
        // on every reconnect.
        const fn =
            this.sock.uploadPreKeysToServerIfRequired ||
            this.sock.uploadPreKeys;

        if (typeof fn !== 'function') return;

        try {
            await fn.call(this.sock);
            console.log('[wa] pre-keys refreshed');
        } catch (err) {
            console.warn('[wa] pre-key refresh failed:', err.message);
        }
    }

    async _warmGroupCache() {

        if (!this.sock) return;

        try {
            const groups = await this.sock.groupFetchAllParticipating();
            const entries = Object.entries(groups || {});

            this.groupMetadataCache.clear();
            for (const [jid, meta] of entries) {
                this.groupMetadataCache.set(jid, meta);
            }

            console.log(
                `[wa] group metadata cache warmed (${entries.length} groups)`
            );
        } catch (err) {
            console.warn('[wa] group cache warm failed:', err.message);
        }
    }

    getStatus() {
        return {
            connected: this.connected,
            user: this.user,
            pairedAt: this.pairedAt,
            profilePictureUrl: this.profilePictureUrl,
            hasQR: !!this.lastQR,
            starting: this.starting
        };
    }

    /** Returns the underlying sock when connected, otherwise null. */
    getSocket() {
        return this.connected ? this.sock : null;
    }

    /** Returns true if `id` matches one of the bot's own identities (JID or LID). */
    isSelfId(id) {
        if (!id) return false;
        const target = baseId(id);
        const myJidBase = baseId(this.user?.id || '');
        const myLidBase = baseId(this.user?.lid || '');
        return target === myJidBase || target === myLidBase;
    }

    /** Strip device suffix and return base id (helper for other modules). */
    baseId(jid) {
        return baseId(jid);
    }

    /**
     * Get the participant JIDs of a group, excluding the bot's own
     * identities. Returns an empty array if metadata is unavailable.
     */
    async getOtherParticipantJids(groupJid) {
        const meta = await this.getCachedGroupMetadata(groupJid);
        if (!meta || !meta.participants) return [];
        return meta.participants
            .map((p) => p.id)
            .filter((id) => id && !this.isSelfId(id));
    }

    /** List groups the bot is a member of. Also refreshes the metadata cache. */
    async fetchGroups() {

        if (!this.sock) return [];

        try {
            const groups = await this.sock.groupFetchAllParticipating();
            const entries = Object.entries(groups || {});

            this.groupMetadataCache.clear();
            for (const [jid, meta] of entries) {
                this.groupMetadataCache.set(jid, meta);
            }

            const userJid = this.user?.id;
            const userLid = this.user?.lid;

            return entries.map(([, g]) => {

                const participants = g.participants || [];
                const me = findBotParticipant(
                    participants,
                    userJid,
                    userLid
                );

                return {
                    jid: g.id,
                    subject: g.subject || '(no name)',
                    desc: g.desc || '',
                    owner: g.owner || null,
                    participantCount: participants.length,
                    // WhatsApp group settings
                    //   announce = only admins can send messages
                    //   restrict = only admins can edit group info
                    announce: !!g.announce,
                    restrict: !!g.restrict,
                    // Bot's role: 'superadmin' | 'admin' | 'member' | 'not-member'
                    botRole: me
                        ? (me.admin || 'member')
                        : 'not-member',
                    botIsMember: !!me,
                    botIsAdmin: !!(me && me.admin)
                };
            });
        } catch (err) {
            console.error('[wa] fetchGroups failed:', err.message);
            return [];
        }
    }
}

module.exports = new WhatsAppManager();
