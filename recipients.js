const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, 'recipients.json');

// ----------------------------------------------------------------------------
// File I/O
// ----------------------------------------------------------------------------

function read() {
    try {
        const obj = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return Array.isArray(obj.recipients) ? obj.recipients : [];
    } catch (_) {
        return [];
    }
}

function write(list) {
    fs.writeFileSync(
        FILE,
        JSON.stringify({ recipients: list }, null, 2)
    );
}

// ----------------------------------------------------------------------------
// Shape helpers
// ----------------------------------------------------------------------------

function sanitize(item) {

    const type = item && item.type === 'group' ? 'group' : 'number';
    const value = String(item && item.value || '').trim();
    const label = item && item.label ? String(item.label).trim() : '';

    if (!value) return null;
    return { type, value, label };
}

/** Comparable form for duplicate detection. */
function normalizeForCompare(item) {
    if (!item) return '';
    if (item.type === 'group') {
        return item.value.includes('@')
            ? item.value
            : `${item.value}@g.us`;
    }
    return item.value.replace(/\D/g, '');
}

function sameRecipient(a, b) {
    return a.type === b.type
        && normalizeForCompare(a) === normalizeForCompare(b);
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

function getAll() {
    return read();
}

function saveAll(list) {

    if (!Array.isArray(list)) {
        throw new Error('recipients must be an array');
    }

    const cleaned = list.map(sanitize).filter(Boolean);

    const seen = new Set();
    const dedup = [];
    for (const r of cleaned) {
        const key = `${r.type}|${normalizeForCompare(r)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(r);
    }

    write(dedup);
    return dedup;
}

/**
 * Atomic add — re-reads file, appends, writes back. No race window with the
 * client's stale cache.
 *
 * Throws an Error with code 'DUPLICATE' if a matching entry already exists.
 * Throws an Error with code 'INVALID' if the input doesn't have a value.
 */
function addOne(item) {

    const sanitized = sanitize(item);
    if (!sanitized) {
        const err = new Error('Invalid recipient');
        err.code = 'INVALID';
        throw err;
    }

    const all = read();

    if (all.some((r) => sameRecipient(r, sanitized))) {
        const err = new Error('Recipient already exists');
        err.code = 'DUPLICATE';
        throw err;
    }

    all.push(sanitized);
    write(all);
    return all;
}

/** Atomic remove. Returns the new list. No-op if nothing matched. */
function removeOne(type, value) {

    const target = sanitize({ type, value });
    if (!target) {
        const err = new Error('Invalid recipient');
        err.code = 'INVALID';
        throw err;
    }

    const all = read();
    const next = all.filter((r) => !sameRecipient(r, target));

    write(next);
    return next;
}

/** Convert a recipient entry into a Baileys JID. */
function toJid(recipient) {

    if (!recipient || !recipient.value) return null;

    if (recipient.type === 'group') {
        return recipient.value.includes('@')
            ? recipient.value
            : `${recipient.value}@g.us`;
    }

    const digits = recipient.value.replace(/\D/g, '');
    if (!digits) return null;
    return `${digits}@s.whatsapp.net`;
}

module.exports = {
    getAll,
    saveAll,
    addOne,
    removeOne,
    toJid
};
