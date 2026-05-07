(function () {

    const $ = (sel) => document.querySelector(sel);

    const els = {
        statusDot: $('#status-dot'),
        statusText: $('#status-text'),
        statusMeta: $('#status-meta'),
        statusActions: $('#status-actions'),
        statusAvatar: $('#status-avatar'),
        logoutBtn: $('#logout-btn'),
        qrCard: $('#qr-card'),
        qrImg: $('#qr-img'),
        recipientsList: $('#recipients-list'),
        recipientForm: $('#recipient-form'),
        recipientError: $('#recipient-error'),
        refreshGroups: $('#refresh-groups'),
        groupsList: $('#groups-list'),
        groupsStatus: $('#groups-status'),
        stateEmpty: $('#state-empty'),
        stateDetail: $('#state-detail'),
        recAmount: $('#rec-amount'),
        recInsurance: $('#rec-insurance'),
        recDate: $('#rec-date'),
        recKey: $('#rec-key'),
        recTrace: $('#rec-trace'),
        recWhen: $('#rec-when')
    };

    const DEFAULT_AVATAR = 'default-avatar.svg';

    let recipientsCache = [];
    let groupsCache = [];
    let lastSyncedAt = null;
    let relativeTimeTimer = null;
    let lastConnected = false;

    // ----------------------------------------------------------------
    // Status rendering
    // ----------------------------------------------------------------

    function renderStatus(status) {

        renderAvatar(status);

        if (status.connected) {
            els.statusDot.className = 'dot connected';
            els.statusText.textContent = 'Connected';
            els.statusMeta.innerHTML = renderUserMeta(status);
            els.statusActions.innerHTML = `
                <button id="disconnect-btn" class="danger">Disconnect</button>
            `;
            $('#disconnect-btn').onclick = disconnect;
            els.qrCard.classList.add('hidden');
            return;
        }

        if (status.starting) {
            els.statusDot.className = 'dot connecting';
            els.statusText.textContent = 'Connecting…';
        } else {
            els.statusDot.className = 'dot disconnected';
            els.statusText.textContent = 'Not connected';
        }

        els.statusMeta.innerHTML = '';
        els.statusActions.innerHTML = `
            <button id="connect-btn">Connect / Pair device</button>
        `;
        $('#connect-btn').onclick = connect;

        if (status.hasQR || status.starting) {
            els.qrCard.classList.remove('hidden');
        }
    }

    function renderAvatar(status) {

        if (status.connected && status.profilePictureUrl) {
            els.statusAvatar.src = status.profilePictureUrl;
            els.statusAvatar.onerror = () => {
                els.statusAvatar.onerror = null;
                els.statusAvatar.src = DEFAULT_AVATAR;
            };
        } else {
            els.statusAvatar.onerror = null;
            els.statusAvatar.src = DEFAULT_AVATAR;
        }
    }

    function renderUserMeta(status) {

        const u = status.user || {};
        const id = (u.id || '').split(':')[0] || '(unknown)';
        const name = u.name ? ` — ${u.name}` : '';
        const paired = status.pairedAt
            ? new Date(status.pairedAt).toLocaleString()
            : '';

        return `
            <div><strong>${id}</strong>${name}</div>
            ${paired ? `<div class="small">Paired ${paired}</div>` : ''}
        `;
    }

    function renderQR(payload) {
        if (!payload || !payload.dataUrl) return;
        els.qrImg.src = payload.dataUrl;
        els.qrCard.classList.remove('hidden');
    }

    // ----------------------------------------------------------------
    // Connect / disconnect
    // ----------------------------------------------------------------

    async function connect() {
        try {
            await postJson('/api/connect');
        } catch (err) {
            alert('Connect failed: ' + err.message);
        }
    }

    async function disconnect() {
        if (!confirm(
            'Disconnect WhatsApp? This logs out and clears local credentials.'
        )) return;
        try {
            await postJson('/api/disconnect');
        } catch (err) {
            alert('Disconnect failed: ' + err.message);
        }
    }

    // ----------------------------------------------------------------
    // Recipients
    // ----------------------------------------------------------------

    async function loadRecipients() {
        const r = await fetchJson('/api/recipients');
        recipientsCache = r.recipients || [];
        renderRecipients();
    }

    function renderRecipients() {

        els.recipientsList.innerHTML = '';

        if (!recipientsCache.length) {
            const li = document.createElement('li');
            li.innerHTML = `
                <span class="muted">
                    No recipients yet — add one below.
                </span>
            `;
            els.recipientsList.appendChild(li);
            return;
        }

        recipientsCache.forEach((item, idx) => {
            const li = document.createElement('li');

            const info = document.createElement('div');
            info.className = 'info';
            info.innerHTML = `
                <div class="name">
                    <span class="badge">${item.type}</span>
                    ${escapeHtml(item.label || item.value)}
                </div>
                <div class="sub">${escapeHtml(item.value)}</div>
            `;

            const btn = document.createElement('button');
            btn.className = 'tiny danger';
            btn.textContent = 'Remove';
            btn.onclick = async () => {
                btn.disabled = true;
                try {
                    await removeRecipient(item.type, item.value);
                } catch (err) {
                    alert('Could not remove: ' + err.message);
                    btn.disabled = false;
                }
            };

            li.appendChild(info);
            li.appendChild(btn);
            els.recipientsList.appendChild(li);
        });
    }

    /**
     * Atomic add — server reads current state, appends, writes. Safe even
     * if the client's recipientsCache hasn't loaded yet (no race window).
     * Returns the server's authoritative list.
     */
    async function addRecipient(item) {
        const r = await postJson('/api/recipients/add', item);
        recipientsCache = r.recipients || [];
        renderRecipients();
        renderGroups();
        return r;
    }

    /** Atomic remove. */
    async function removeRecipient(type, value) {
        const r = await postJson('/api/recipients/remove', { type, value });
        recipientsCache = r.recipients || [];
        renderRecipients();
        renderGroups();
        return r;
    }

    function showFormError(msg) {
        if (!msg) {
            els.recipientError.classList.add('hidden');
            els.recipientError.textContent = '';
            return;
        }
        els.recipientError.textContent = msg;
        els.recipientError.classList.remove('hidden');
    }

    function normalizeForCompare(type, value) {
        const v = String(value || '').trim();
        if (type === 'group') {
            return v.includes('@') ? v : `${v}@g.us`;
        }
        // strip everything but digits to compare phone numbers
        return v.replace(/\D/g, '');
    }

    function isDuplicate(type, value) {
        const target = normalizeForCompare(type, value);
        return recipientsCache.some(
            (r) => r.type === type && normalizeForCompare(r.type, r.value) === target
        );
    }

    els.recipientForm.onsubmit = async (e) => {

        e.preventDefault();
        showFormError(null);

        const fd = new FormData(els.recipientForm);

        const item = {
            type: fd.get('type'),
            value: (fd.get('value') || '').trim(),
            label: (fd.get('label') || '').trim()
        };

        if (!item.value) return;

        // Client-side duplicate hint for fast feedback. The server is the
        // authority — if it returns 409 (DUPLICATE) we surface that too,
        // since the cache may not be in sync yet.
        if (isDuplicate(item.type, item.value)) {
            showFormError(
                `That ${item.type} is already in the recipients list.`
            );
            return;
        }

        try {
            await addRecipient(item);
            els.recipientForm.reset();
        } catch (err) {
            if (/already exists/i.test(err.message)) {
                showFormError(
                    `That ${item.type} is already in the recipients list.`
                );
            } else {
                showFormError('Could not add: ' + err.message);
            }
        }
    };

    // clear the error when the user starts editing
    els.recipientForm.addEventListener('input', () => showFormError(null));

    // ----------------------------------------------------------------
    // Groups
    // ----------------------------------------------------------------

    function isGroupActive(jid) {
        return recipientsCache.some(
            (r) => r.type === 'group' && r.value === jid
        );
    }

    function setGroupsStatus(text) {
        els.groupsStatus.textContent = text;
    }

    function renderRoleBadge(g) {

        if (!g.botIsMember) {
            return `<span class="badge badge-warn"
                          title="The bot account is not in this group; sends will silently fail.">
                Not a member
            </span>`;
        }

        if (g.botRole === 'superadmin') {
            return `<span class="badge badge-ok">Super-admin</span>`;
        }
        if (g.botRole === 'admin') {
            return `<span class="badge badge-ok">Admin</span>`;
        }
        return `<span class="badge">Member</span>`;
    }

    function renderSendPermBadge(g) {

        if (g.announce && !g.botIsAdmin) {
            return `<span class="badge badge-warn"
                          title="This group only allows admins to send messages. The bot is not an admin, so messages will not be delivered.">
                Admins only
            </span>`;
        }
        if (g.announce) {
            return `<span class="badge">Admins only · bot OK</span>`;
        }
        return `<span class="badge badge-mute">All members can send</span>`;
    }

    function buildGroupRow(g) {

        const li = document.createElement('li');
        li.className = 'group-row';

        // ---- Top row: subject + toggle ----------------------------
        const top = document.createElement('div');
        top.className = 'group-top';

        const info = document.createElement('div');
        info.className = 'info';
        info.innerHTML = `
            <div class="name">${escapeHtml(g.subject)}</div>
            <div class="sub">
                ${g.participantCount} members · ${escapeHtml(g.jid)}
            </div>
        `;

        const switchWrap = document.createElement('label');
        switchWrap.className = 'switch';
        switchWrap.title = isGroupActive(g.jid)
            ? 'Sending to this group'
            : 'Click to send to this group';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = isGroupActive(g.jid);

        const slider = document.createElement('span');
        slider.className = 'slider';

        switchWrap.appendChild(checkbox);
        switchWrap.appendChild(slider);

        checkbox.onchange = async () => {

            checkbox.disabled = true;

            try {
                if (checkbox.checked) {
                    await addRecipient({
                        type: 'group',
                        value: g.jid,
                        label: g.subject
                    });
                } else {
                    await removeRecipient('group', g.jid);
                }
            } catch (err) {
                if (!/already exists/i.test(err.message)) {
                    alert('Could not update group: ' + err.message);
                }
                checkbox.checked = !checkbox.checked;
            } finally {
                checkbox.disabled = false;
            }
        };

        top.appendChild(info);
        top.appendChild(switchWrap);

        // ---- Badges row -------------------------------------------
        const badges = document.createElement('div');
        badges.className = 'group-badges';
        badges.innerHTML = `
            ${renderRoleBadge(g)}
            ${renderSendPermBadge(g)}
        `;

        // ---- Action row: test send -------------------------------
        const actions = document.createElement('div');
        actions.className = 'group-actions';

        const testBtn = document.createElement('button');
        testBtn.className = 'tiny secondary';
        testBtn.textContent = 'Send test message';
        testBtn.title = 'Sends a one-line debug ping to this group';

        const testResult = document.createElement('span');
        testResult.className = 'test-result muted small';

        testBtn.onclick = async () => {

            testBtn.disabled = true;
            testResult.className = 'test-result muted small';
            testResult.textContent = 'Sending…';

            try {
                const r = await postJson('/api/test-send', {
                    jid: g.jid,
                    text: `Test ping from settings UI · ${new Date().toLocaleTimeString()}`
                });
                testResult.className = 'test-result ok small';
                testResult.textContent =
                    `Sent · id=${r.messageId || '?'} ` +
                    '(check phone for delivery)';
            } catch (err) {
                testResult.className = 'test-result error small';
                testResult.textContent = 'Failed: ' + err.message;
            } finally {
                testBtn.disabled = false;
            }
        };

        actions.appendChild(testBtn);
        actions.appendChild(testResult);

        // Owner / description (collapsed by default if present)
        if (g.owner || g.desc) {
            const meta = document.createElement('div');
            meta.className = 'group-meta small muted';
            const parts = [];
            if (g.owner) parts.push(`Owner: ${escapeHtml(g.owner)}`);
            if (g.desc) parts.push(`“${escapeHtml(g.desc)}”`);
            meta.innerHTML = parts.join(' · ');
            actions.appendChild(meta);
        }

        li.appendChild(top);
        li.appendChild(badges);
        li.appendChild(actions);

        return li;
    }

    function renderGroups() {

        els.groupsList.innerHTML = '';

        if (!groupsCache.length) {
            return;
        }

        for (const g of groupsCache) {
            els.groupsList.appendChild(buildGroupRow(g));
        }
    }

    async function loadGroups({ silent } = {}) {

        if (!lastConnected) {
            setGroupsStatus('Connect WhatsApp to load groups.');
            groupsCache = [];
            renderGroups();
            return;
        }

        if (!silent) {
            els.refreshGroups.disabled = true;
            els.refreshGroups.textContent = 'Loading…';
            setGroupsStatus('Loading groups…');
        }

        try {

            const r = await fetchJson('/api/groups');
            groupsCache = r.groups || [];

            if (!groupsCache.length) {
                setGroupsStatus(
                    'No groups found. The bot account needs to be a ' +
                    'member of a group before it can show up here.'
                );
            } else {
                setGroupsStatus(`${groupsCache.length} joined group(s)`);
            }

            renderGroups();

        } catch (err) {
            setGroupsStatus('Could not load groups: ' + err.message);
        } finally {
            els.refreshGroups.disabled = false;
            els.refreshGroups.textContent = 'Refresh';
        }
    }

    els.refreshGroups.onclick = () => loadGroups({});

    // ----------------------------------------------------------------
    // Scraper state
    // ----------------------------------------------------------------

    async function loadScraperState() {

        let s;
        try {
            s = await fetchJson('/api/scraper-state');
        } catch (_) {
            s = {};
        }

        if (!s || !s.lastReportKey) {
            els.stateEmpty.classList.remove('hidden');
            els.stateDetail.classList.add('hidden');
            lastSyncedAt = null;
            return;
        }

        els.stateEmpty.classList.add('hidden');
        els.stateDetail.classList.remove('hidden');

        els.recAmount.textContent =
            (s.lastDepositAmount && s.lastDepositAmount.trim()) || '$0.00';
        els.recInsurance.textContent = s.lastInsurance || '—';
        els.recDate.textContent = s.lastErnDate || '—';
        els.recKey.textContent = s.lastReportKey || '–';
        els.recTrace.textContent = s.lastTraceNumber || '–';

        lastSyncedAt = s.lastSeenAt || null;
        updateRelativeTime();
    }

    function timeAgo(iso) {

        if (!iso) return '–';

        const ms = Date.now() - new Date(iso).getTime();
        if (ms < 0) return 'just now';
        if (ms < 60_000) return 'just now';

        const min = Math.floor(ms / 60_000);
        if (min < 60) return `${min} min${min === 1 ? '' : 's'} ago`;

        const hr = Math.floor(min / 60);
        if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;

        const day = Math.floor(hr / 24);
        return `${day} day${day === 1 ? '' : 's'} ago`;
    }

    function updateRelativeTime() {
        els.recWhen.textContent = timeAgo(lastSyncedAt);
    }

    // refresh the "X minutes ago" string every 30s without a re-fetch
    if (relativeTimeTimer) clearInterval(relativeTimeTimer);
    relativeTimeTimer = setInterval(updateRelativeTime, 30_000);

    // ----------------------------------------------------------------
    // SSE
    // ----------------------------------------------------------------

    function startEvents() {

        const sse = new EventSource('/api/events');

        sse.addEventListener('status', (e) => {
            try {
                const status = JSON.parse(e.data);
                const wasConnected = lastConnected;
                lastConnected = !!status.connected;

                renderStatus(status);
                loadScraperState();

                // Auto-fetch groups on the transition from
                // disconnected -> connected so the user doesn't have to
                // click Refresh.
                if (lastConnected && !wasConnected) {
                    loadGroups({ silent: false });
                }
                if (!lastConnected && wasConnected) {
                    setGroupsStatus('Connect WhatsApp to load groups.');
                    groupsCache = [];
                    renderGroups();
                    // Server clears recipients + scraper state on logout;
                    // re-pull so the UI matches what's on disk now.
                    loadRecipients();
                }
            } catch (_) { /* ignore */ }
        });

        sse.addEventListener('qr', (e) => {
            try { renderQR(JSON.parse(e.data)); }
            catch (_) { /* ignore */ }
        });

        sse.onerror = () => {
            // browser will auto-reconnect; nothing to do
        };
    }

    // ----------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------

    function handleAuthError(r) {
        if (r.status === 401) {
            // Session expired or never logged in — bounce to the login page.
            location.href = '/login.html';
            // Throw to abort the calling code path.
            throw new Error('unauthorized');
        }
    }

    async function fetchJson(url) {
        const r = await fetch(url, { credentials: 'same-origin' });
        handleAuthError(r);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
    }

    async function postJson(url, body) {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body || {})
        });
        handleAuthError(r);
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
        return data;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Show the logout button if the server has auth enabled.
    async function setupAuthUI() {
        try {
            const r = await fetchJson('/api/auth-config');
            if (r && r.enabled) {
                els.logoutBtn.classList.remove('hidden');
                els.logoutBtn.onclick = async () => {
                    try {
                        await postJson('/api/logout');
                    } catch (_) { /* ignore */ }
                    location.href = '/login.html';
                };
            }
        } catch (_) { /* ignore */ }
    }

    // Boot — ordered so the recipients cache is fully populated before
    // anything that depends on it (groups card toggles, duplicate checks)
    // can possibly fire.
    (async () => {

        await setupAuthUI();

        try {
            await loadRecipients();
        } catch (_) { /* ignore — page will still work */ }

        try {
            const status = await fetchJson('/api/status');
            renderStatus(status);
            lastConnected = !!status.connected;
            if (status.connected) {
                // recipientsCache is already loaded, so toggles render correctly.
                loadGroups({ silent: false });
            }
        } catch (_) { /* ignore */ }

        loadScraperState();
        startEvents();
    })();

})();
