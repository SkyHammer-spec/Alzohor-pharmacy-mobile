// ── app.js — Al Zouhor Pharmacy Mobile ──────────────────────────────────────
//
// ARCHITECTURE (per the agreed design):
//  - This is the ONLY place that ever knows the real Drive folder ID / API
//    key. End users never see or need a Google account — they log in with
//    their own app-level username + access token (set up once on desktop).
//  - Files are looked up BY NAME each time (not by a hardcoded file ID),
//    using a public, READ-ONLY API key — this survives a file being
//    deleted/recreated on the desktop side without needing reconfiguration.
//  - Live fetch is always tried first; if it fails (phone has no signal),
//    falls back to the last cached copy, clearly labeled with when it was
//    actually fetched — never silently shows stale data as if it were fresh.

// ── ONE-TIME CONFIG — fill these in after running the desktop sync once ────
// FOLDER_ID: printed in mobile-sync-log.txt after the first successful sync
// (see main.js's logMobileSyncAttempt).
// API_KEY: create in Google Cloud Console → APIs & Services → Credentials →
// Create Credentials → API Key. Restrict it to the Google Drive API only
// (Credentials → click the key → API restrictions → Google Drive API) —
// this key only allows read-only file lookups by name, nothing else.
const FOLDER_ID = '1eCym-wJJ5XiGr3bB2EVfw6ll0kgHZ_qz';
const API_KEY = 'AIzaSyBo-xnBxOXB8J6alxDwrjaQkQupoebqM1s';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

// PUSH_SERVER_URL: the small standalone push server (see push-server/
// folder) — fill this in once it's deployed, e.g.
// 'https://al-zouhor-push.onrender.com'. VAPID_PUBLIC_KEY must exactly
// match the public key that server was started with.
const PUSH_SERVER_URL = 'https://alzohornotifications.bonto.run';
const VAPID_PUBLIC_KEY = 'BLbsHFhPn7jv3mySl_yM6b_OPyQoHQD7BEFRo56mEGq4jxsP1rbBpScanwpXlmc62ehYC0Tn14otqFzxWcyBOtA';

// ── Small helpers ────────────────────────────────────────────────────────
function fmt(n) {
  return Number(n || 0).toLocaleString() + ' IQD';
}
function formatTimestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
async function sha256Hex(text) {
  // Web Crypto API — built into every modern mobile browser, no library needed.
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Drive file lookup + fetch ────────────────────────────────────────────
async function findFileIdByName(filename) {
  const q = encodeURIComponent(`'${FOLDER_ID}' in parents and name='${filename}' and trashed=false`);
  const url = `${DRIVE_API_BASE}/files?q=${q}&key=${API_KEY}&fields=files(id,modifiedTime)`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Drive lookup failed (${res.status})`);
  const data = await res.json();
  if (!data.files || data.files.length === 0) throw new Error(`File not found: ${filename}`);
  return data.files[0].id;
}

async function fetchDriveJson(filename) {
  const fileId = await findFileIdByName(filename);
  const url = `${DRIVE_API_BASE}/files/${fileId}?alt=media&key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return res.json();
}

// ── Local cache — "last known good" copy, survives being offline ─────────
function cacheKey(filename) { return `alzouhor_cache_${filename}`; }

function saveToCache(filename, data) {
  try {
    localStorage.setItem(cacheKey(filename), JSON.stringify({ data, cachedAt: new Date().toISOString() }));
  } catch (e) { /* localStorage full/unavailable — app still works, just without offline fallback this time */ }
}
function loadFromCache(filename) {
  try {
    const raw = localStorage.getItem(cacheKey(filename));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// Always tries live fetch first; falls back to cache with a clear "last
// synced at" timestamp if the live fetch fails for any reason (most common:
// phone currently has no signal) — matches the whole project's "unreliable
// internet is the normal case" design principle, now extended to the phone.
async function fetchWithFallback(filename) {
  try {
    const data = await fetchDriveJson(filename);
    saveToCache(filename, data);
    return { data, fromCache: false, timestamp: new Date().toISOString() };
  } catch (e) {
    const cached = loadFromCache(filename);
    if (cached) return { data: cached.data, fromCache: true, timestamp: cached.cachedAt, error: e.message };
    throw new Error(`No internet connection and no cached data available yet. (${e.message})`);
  }
}

// ── Session (who's logged in, stored locally so they stay logged in) ─────
function getSession() {
  try { return JSON.parse(localStorage.getItem('alzouhor_session') || 'null'); } catch (e) { return null; }
}
function saveSession(session) { localStorage.setItem('alzouhor_session', JSON.stringify(session)); }
function clearSession() { localStorage.removeItem('alzouhor_session'); }

// ── Login ──────────────────────────────────────────────────────────────
// mobile-users.json now contains two kinds of entries, built fresh from
// the desktop app every sync:
//   { type:'admin',  username, password_hash, display_name }
//   { type:'driver', username, password_hash, display_name, driver_id }
// No separate mobile-only accounts — 'admin' entries are real desktop
// users (any role), 'driver' entries are delivery guys who've had mobile
// credentials set up for them.
async function attemptLogin(username, password) {
  const users = await fetchDriveJson('mobile-users.json'); // always live — never trust a cached login list
  const passwordHash = await sha256Hex(password);
  const match = users.find(u =>
    u.username.trim().toLowerCase() === username.trim().toLowerCase() && u.password_hash === passwordHash
  );
  if (!match) return { success: false, error: 'Incorrect username or password.' };
  const session = {
    username: match.username,
    display_name: match.display_name,
    role: match.type, // 'admin' or 'driver'
    linked_driver_id: match.driver_id || null,
  };
  saveSession(session);
  return { success: true, session };
}

// ── Rendering ──────────────────────────────────────────────────────────
const appEl = document.getElementById('app');

function renderLogin(errorMsg) {
  appEl.innerHTML = `
    <div class="login-screen">
      <div class="login-box">
        <div class="login-logo">💊</div>
        <h1>Al Zouhor Pharmacy</h1>
        <p class="login-sub">Mobile</p>
        ${errorMsg ? `<div class="login-error">${errorMsg}</div>` : ''}
        <div class="form-group">
          <label>Username</label>
          <input id="login-name" type="text" autocomplete="username" />
        </div>
        <div class="form-group">
          <label>Password</label>
          <input id="login-token" type="password" autocomplete="current-password" />
        </div>
        <button class="btn-primary full-width" id="login-btn">Sign In</button>
      </div>
    </div>`;
  document.getElementById('login-btn').addEventListener('click', async () => {
    const name = document.getElementById('login-name').value.trim();
    const token = document.getElementById('login-token').value.trim();
    if (!name || !token) return;
    document.getElementById('login-btn').textContent = 'Signing in…';
    try {
      const result = await attemptLogin(name, token);
      if (result.success) renderApp();
      else renderLogin(result.error);
    } catch (e) {
      renderLogin('Could not reach the server. Check your internet connection and try again.');
    }
  });
}

function syncBadge(fromCache, timestamp) {
  return fromCache
    ? `<div class="sync-badge offline">⚠️ Offline — showing data from ${formatTimestamp(timestamp)}</div>`
    : `<div class="sync-badge online">✓ Live — updated ${formatTimestamp(timestamp)}</div>`;
}

async function renderApp() {
  const session = getSession();
  if (!session) { renderLogin(); return; }

  appEl.innerHTML = `<div class="topbar"><h2>Al Zouhor Pharmacy</h2><button id="logout-btn">Logout</button></div>
    <div id="content" class="loading">Loading…</div>`;
  document.getElementById('logout-btn').addEventListener('click', () => { clearSession(); renderLogin(); });

  try {
    if (session.role === 'driver') {
      const { data, fromCache, timestamp } = await fetchWithFallback(`driver-${session.linked_driver_id}.json`);
      renderDriverView(data, fromCache, timestamp);
    } else {
      const { data, fromCache, timestamp } = await fetchWithFallback('admin-snapshot.json');
      renderAdminView(data, fromCache, timestamp);
    }
  } catch (e) {
    document.getElementById('content').innerHTML = `<div class="error-box">${e.message}</div>`;
  }

  setupPushNotifications(); // fire-and-forget — never blocks the actual data render above
}

// ── Push notifications ──────────────────────────────────────────────────
// Only needs to run ONCE per device (the browser remembers the subscription
// after that), but it's safe to call every app open — it's a no-op if
// already subscribed. Silently does nothing if PUSH_SERVER_URL hasn't been
// configured yet, or if the browser/OS doesn't support push at all (older
// iOS Safari versions, for example).
async function setupPushNotifications() {
  if (PUSH_SERVER_URL.startsWith('PASTE_YOUR')) return; // not configured yet
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true, // required by spec — every push must result in a visible notification
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    // Always re-send on app open, not just at first subscribe — cheap
    // no-op on the server if it already has this endpoint, but guarantees
    // the server re-learns about this device if its subscriptions.json
    // was ever wiped (e.g. a redeploy).
    await fetch(`${PUSH_SERVER_URL}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription),
    });
  } catch (e) {
    // Non-fatal — the app itself still works fine without notifications.
    console.warn('Push notification setup failed:', e.message);
  }
}

// Web Push subscription keys must be Uint8Array, but VAPID public keys are
// handed out as URL-safe base64 strings — this is the standard conversion.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function renderDriverView(data, fromCache, timestamp) {
  const content = document.getElementById('content');
  content.className = '';
  const b = data.balance;
  content.innerHTML = `
    ${syncBadge(fromCache, timestamp)}
    <h3>${data.driverName}</h3>
    <div class="metric-row">
      <div class="metric-card"><div class="mc-label">Owed to Pharmacy</div><div class="mc-val warn">${fmt(b.owes)}</div></div>
      <div class="metric-card"><div class="mc-label">Collected</div><div class="mc-val">${fmt(b.collectedAmount)}</div></div>
    </div>
    <div class="section-header">Recent Sales (${data.recentSales.length})</div>
    ${data.recentSales.slice(0, 30).map(s => `
      <div class="row-item">
        <div>${s.destination_name || '—'}</div>
        <div class="row-sub">${s.created_at} · ${s.status}</div>
        <div class="row-amt">${fmt(s.net_amount)}</div>
      </div>`).join('')}
    <div class="section-header">Recent Settlements (${data.recentSettlements.length})</div>
    ${data.recentSettlements.slice(0, 20).map(s => `
      <div class="row-item">
        <div class="row-sub">${s.created_at}</div>
        <div class="row-amt success">${fmt(s.amount)}</div>
      </div>`).join('')}`;
}

const TABS = ['alerts', 'debts', 'storage', 'delivery', 'patients', 'reports', 'cash'];
let _currentTab = 'alerts';
let _expandedDebtCustomers = new Set(); // which customers' purchase history is expanded on the Debts tab
let _expandedDrivers = new Set(); // which drivers' delivery trips are expanded on the Delivery tab
let _expandedFamilies = new Set(); // which patient families are expanded on the Patients tab

function renderAdminView(data, fromCache, timestamp) {
  const content = document.getElementById('content');
  content.className = '';
  content.innerHTML = `
    ${syncBadge(fromCache, timestamp)}
    <div class="tab-bar">
      ${TABS.map(t => `<button class="tab-btn ${t === _currentTab ? 'active' : ''}" data-tab="${t}">${t}</button>`).join('')}
    </div>
    <div id="tab-content"></div>`;
  content.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => { _currentTab = btn.dataset.tab; renderAdminView(data, fromCache, timestamp); });
  });
  renderTabContent(data, _currentTab);
}

function renderTabContent(data, tab) {
  const el = document.getElementById('tab-content');
  if (tab === 'alerts') {
    const a = data.alerts;
    const totalAlerts = a.expired.length + a.outOfStock.length + a.expiring30.length + a.expiring60.length + a.lowStock.length;

    const daysUntil = (dateStr) => Math.ceil((new Date(dateStr) - new Date()) / 86400000);

    // Each section: icon/label/severity class + a function that produces the
    // specific reason text for that item (why THIS item is in THIS section).
    const sections = [
      { key: 'expired', icon: '⛔', label: 'Expired', cls: 'danger', items: a.expired,
        reason: (i) => {
          const days = Math.abs(daysUntil(i.expire_date));
          return `Expired ${days === 0 ? 'today' : days === 1 ? '1 day ago' : days + ' days ago'} (${i.expire_date})`;
        } },
      { key: 'outOfStock', icon: '🚫', label: 'Out of Stock', cls: 'danger', items: a.outOfStock,
        reason: () => `0 units left in stock` },
      { key: 'expiring30', icon: '⏰', label: 'Expiring Soon', cls: 'warn', items: a.expiring30,
        reason: (i) => {
          const days = daysUntil(i.expire_date);
          return `Expires in ${days} day${days === 1 ? '' : 's'} (${i.expire_date})`;
        } },
      { key: 'expiring60', icon: '📅', label: 'Expiring Later', cls: 'info', items: a.expiring60,
        reason: (i) => {
          const days = daysUntil(i.expire_date);
          return `Expires in ${days} days (${i.expire_date})`;
        } },
      { key: 'lowStock', icon: '📉', label: 'Low Stock', cls: 'warn', items: a.lowStock,
        reason: (i) => `Only ${i.quantity} left — reorder point is ${i.min_quantity}` },
    ];

    if (totalAlerts === 0) {
      el.innerHTML = `<div class="empty-state">✅ No alerts right now — everything looks good.</div>`;
      return;
    }

    el.innerHTML = `
      <div class="alert-stats">
        <div class="alert-stat danger"><div class="as-num">${a.expired.length}</div><div>Expired</div></div>
        <div class="alert-stat danger"><div class="as-num">${a.outOfStock.length}</div><div>Out of Stock</div></div>
        <div class="alert-stat warn"><div class="as-num">${a.expiring30.length}</div><div>Expiring Soon</div></div>
        <div class="alert-stat warn"><div class="as-num">${a.lowStock.length}</div><div>Low Stock</div></div>
      </div>
      ${sections.filter(s => s.items.length > 0).map(s => `
        <div class="alert-section">
          <div class="alert-section-header ${s.cls}">${s.icon} ${s.label} <span class="alert-count">${s.items.length}</span></div>
          ${s.items.map(i => `
            <div class="row-item">
              <div>
                <div>${i.name}</div>
                <div class="row-sub alert-reason ${s.cls}">${s.reason(i)}</div>
              </div>
            </div>
          `).join('')}
        </div>
      `).join('')}`;
  } else if (tab === 'debts') {
    const sales = data.debts.sales || [];
    const payments = data.debts.payments || [];
    if (data.debts.balances.length === 0) {
      el.innerHTML = '<div class="empty-state">No outstanding debts.</div>';
      return;
    }
    el.innerHTML = data.debts.balances.map(b => {
      const c = data.debts.customers.find(c => c.id === b.customer_id);
      const isOpen = _expandedDebtCustomers.has(b.customer_id);
      const custSales = sales.filter(s => s.customer_id === b.customer_id);
      const custPayments = payments.filter(p => p.customer_id === b.customer_id);
      // Merge purchases and payments into one chronological timeline so it
      // reads like a real account history, not two separate disconnected lists.
      const timeline = [
        ...custSales.map(s => ({ type: 'sale', date: s.created_at, data: s })),
        ...custPayments.map(p => ({ type: 'payment', date: p.created_at, data: p })),
      ].sort((x, y) => new Date(y.date) - new Date(x.date));

      return `
        <div class="debt-customer">
          <div class="row-item debt-customer-row" data-cid="${b.customer_id}">
            <div>
              <div>${c?.name || '—'}</div>
              <div class="row-sub">${custSales.length} purchase${custSales.length === 1 ? '' : 's'}${b.creditNet > 0 ? ' · has credit' : ''}</div>
            </div>
            <div class="row-amt ${b.owes > 0 ? 'warn' : ''}">${b.owes > 0 ? fmt(b.owes) : (b.creditNet > 0 ? '+' + fmt(b.creditNet) + ' credit' : fmt(0))}</div>
            <div class="debt-expand-arrow">${isOpen ? '▲' : '▼'}</div>
          </div>
          ${isOpen ? `
            <div class="debt-history">
              ${timeline.length === 0 ? '<div class="empty-state small">No history yet.</div>' : timeline.map(t => {
                if (t.type === 'sale') {
                  const s = t.data;
                  return `
                    <div class="debt-history-entry sale">
                      <div class="debt-history-head">
                        <span class="debt-history-icon">🛒</span>
                        <span class="debt-history-date">${fmtDate(s.created_at)}</span>
                        <span class="debt-history-amt warn">${fmt(s.total)}</span>
                      </div>
                      ${s.items && s.items.length > 0 ? `
                        <div class="debt-history-items">
                          ${s.items.map(it => `<div class="debt-history-item-line">${it.quantity}× ${it.item_name} <span class="debt-item-price">${fmt(it.subtotal)}</span></div>`).join('')}
                        </div>` : ''}
                      ${s.note ? `<div class="debt-history-note">"${s.note}"</div>` : ''}
                      ${s.discount > 0 ? `<div class="debt-history-note">Discount: ${fmt(s.discount)}</div>` : ''}
                    </div>`;
                } else {
                  const p = t.data;
                  return `
                    <div class="debt-history-entry payment">
                      <div class="debt-history-head">
                        <span class="debt-history-icon">✅</span>
                        <span class="debt-history-date">${fmtDate(p.created_at)}</span>
                        <span class="debt-history-amt success">− ${fmt(p.amount)}</span>
                      </div>
                      <div class="debt-history-note">Payment received${p.payment_method ? ' · ' + p.payment_method : ''}</div>
                    </div>`;
                }
              }).join('')}
            </div>
          ` : ''}
        </div>`;
    }).join('');

    el.querySelectorAll('.debt-customer-row').forEach(row => {
      row.addEventListener('click', () => {
        const cid = parseInt(row.dataset.cid);
        if (_expandedDebtCustomers.has(cid)) _expandedDebtCustomers.delete(cid);
        else _expandedDebtCustomers.add(cid);
        renderTabContent(data, tab);
      });
    });
  } else if (tab === 'storage') {
    if (data.storage.items.length === 0) {
      el.innerHTML = '<div class="empty-state">No items in storage.</div>';
      return;
    }
    const daysUntil = (dateStr) => Math.ceil((new Date(dateStr) - new Date()) / 86400000);
    el.innerHTML = `
      <table class="data-table storage-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Category</th>
            <th class="num">Qty</th>
            <th>Expires</th>
          </tr>
        </thead>
        <tbody>
          ${data.storage.items.map(i => {
            let expClass = '';
            let expText = '—';
            if (i.expire_date) {
              const days = daysUntil(i.expire_date);
              expText = fmtDate(i.expire_date);
              if (days < 0) expClass = 'exp-danger';
              else if (days <= 30) expClass = 'exp-danger';
              else if (days <= 60) expClass = 'exp-warn';
            }
            const qtyClass = i.min_quantity != null && i.quantity <= i.min_quantity ? 'exp-warn' : '';
            return `
              <tr>
                <td>${i.name}</td>
                <td class="dim">${i.category || '—'}</td>
                <td class="num ${qtyClass}">${i.quantity}</td>
                <td class="${expClass}">${expText}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } else if (tab === 'delivery') {
    if (data.delivery.guys.length === 0) {
      el.innerHTML = '<div class="empty-state">No delivery guys yet.</div>';
      return;
    }
    const allSales = data.delivery.sales || [];
    el.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Driver</th>
            <th class="num">Holding</th>
            <th class="num">Deliveries</th>
            <th class="num">Unsettled Fees</th>
          </tr>
        </thead>
        <tbody>
          ${data.delivery.guys.map(g => {
            // These numbers come straight from the desktop sync, already
            // computed there — no re-deriving logic here, so this can never
            // drift from what the desktop app itself shows for this guy.
            const b = data.delivery.balances.find(b => b.delivery_guy_id === g.id) || { owes: 0, unsettledCount: 0, unsettledFees: 0 };
            const guySales = allSales.filter(s => s.delivery_guy_id === g.id);
            const isOpen = _expandedDrivers.has(g.id);
            return `
              <tr class="driver-row" data-gid="${g.id}">
                <td>${g.name} <span class="debt-expand-arrow">${isOpen ? '▲' : '▼'}</span></td>
                <td class="num ${b.owes > 0 ? 'exp-warn' : ''}">${fmt(b.owes)}</td>
                <td class="num">${b.unsettledCount}</td>
                <td class="num ${b.unsettledFees > 0 ? 'exp-warn' : ''}">${fmt(b.unsettledFees)}</td>
              </tr>
              ${isOpen ? `
                <tr><td colspan="4" class="driver-detail-cell">
                  ${guySales.length === 0 ? '<div class="empty-state small">No deliveries yet.</div>' : guySales.map(s => `
                    <div class="debt-history-entry">
                      <div class="debt-history-head">
                        <span class="debt-history-icon">📦</span>
                        <span class="debt-history-date">#${s.id} · ${fmtDate(s.created_at)}</span>
                        <span class="debt-history-amt warn">${fmt(s.total)}</span>
                      </div>
                      <div class="debt-history-note">${s.destination_name}${s.destination_phone ? ' · ' + s.destination_phone : ''}</div>
                      ${s.items && s.items.length > 0 ? `
                        <div class="debt-history-items">
                          ${s.items.map(it => `<div class="debt-history-item-line">${it.quantity}× ${it.item_name} <span class="debt-item-price">${fmt(it.subtotal)}</span></div>`).join('')}
                        </div>` : ''}
                      <div class="debt-history-note">Fee: ${fmt(s.delivery_fee)} · ${s.status}</div>
                    </div>
                  `).join('')}
                </td></tr>
              ` : ''}`;
          }).join('')}
        </tbody>
      </table>`;

    el.querySelectorAll('.driver-row').forEach(row => {
      row.addEventListener('click', () => {
        const gid = parseInt(row.dataset.gid);
        if (_expandedDrivers.has(gid)) _expandedDrivers.delete(gid);
        else _expandedDrivers.add(gid);
        renderTabContent(data, tab);
      });
    });
  } else if (tab === 'patients') {
    if (data.patients.families.length === 0) {
      el.innerHTML = '<div class="empty-state">No patient families yet.</div>';
      return;
    }
    // Mirrors desktop patients.js EXACTLY (pillsRemaining/buildAlerts/renderMed) —
    // same thresholds, same bar-fill direction (fills with REMAINING pills,
    // not consumed), same color breakpoints.
    const EXPIRY_WARN_DAYS = 14;
    const LOW_PILL_THRESHOLD = 6;

    const daysUntilExpiry = (expireDate) => {
      if (!expireDate) return Infinity;
      return Math.floor((new Date(expireDate) - new Date()) / 86400000);
    };
    const pillsRemaining = (med) => {
      if (!med.start_date || !med.daily_dose || med.daily_dose <= 0) return med.total_pills;
      const daysPassed = Math.max(0, Math.floor((Date.now() - new Date(med.start_date)) / 86400000));
      return Math.max(0, med.total_pills - daysPassed * med.daily_dose);
    };
    const buildAlerts = (med) => {
      const remaining = pillsRemaining(med);
      const days = daysUntilExpiry(med.expire_date);
      const alerts = [];
      if (remaining <= LOW_PILL_THRESHOLD && remaining > 0) alerts.push({ type: 'low', msg: `Only ${remaining} pills left` });
      if (remaining === 0) alerts.push({ type: 'empty', msg: 'Course finished — no pills left' });
      if (days !== Infinity && days <= EXPIRY_WARN_DAYS && days >= 0) alerts.push({ type: 'expiry', msg: `Expires in ${days} day${days === 1 ? '' : 's'}` });
      if (days < 0) alerts.push({ type: 'expired', msg: `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago` });
      return alerts;
    };

    el.innerHTML = data.patients.families.map(f => {
      const members = data.patients.members.filter(m => m.family_id === f.id);
      const isOpen = _expandedFamilies.has(f.id);
      return `
        <div class="debt-customer">
          <div class="row-item debt-customer-row" data-fid="${f.id}">
            <div>
              <div>${f.name}</div>
              <div class="row-sub">${members.length} member${members.length === 1 ? '' : 's'}</div>
            </div>
            <div class="debt-expand-arrow">${isOpen ? '▲' : '▼'}</div>
          </div>
          ${isOpen ? `
            <div class="debt-history">
              ${members.length === 0 ? '<div class="empty-state small">No members yet.</div>' : members.map(m => {
                const meds = data.patients.meds.filter(med => med.member_id === m.id);
                return `
                  <div class="patient-member">
                    <div class="patient-member-name">👤 ${m.name}${m.phone ? ` · ${m.phone}` : ''}</div>
                    ${meds.length === 0 ? '<div class="empty-state small">No medicines on record.</div>' : meds.map(med => {
                      const remaining = pillsRemaining(med);
                      const days = daysUntilExpiry(med.expire_date);
                      const alerts = buildAlerts(med);
                      const pillPct = med.total_pills > 0 ? Math.max(0, remaining / med.total_pills * 100) : 0;
                      const barClass = remaining <= LOW_PILL_THRESHOLD ? 'finished' : remaining <= med.total_pills * 0.3 ? 'low' : 'ok';
                      const expStr = med.expire_date
                        ? (days < 0 ? `<span class="med-exp-tag danger">Expired</span>`
                          : days <= EXPIRY_WARN_DAYS ? `<span class="med-exp-tag danger">Exp ${fmtDate(med.expire_date)} (${days}d)</span>`
                          : `<span class="med-exp-tag">Exp ${fmtDate(med.expire_date)}</span>`)
                        : '';
                      return `
                        <div class="med-card ${barClass}">
                          <div class="med-card-head">
                            <span class="med-name">💊 ${med.medicine_name}</span>
                            ${expStr}
                          </div>
                          <div class="med-progress-track"><div class="med-progress-fill ${barClass}" style="width:${pillPct.toFixed(1)}%"></div></div>
                          <div class="med-sub">${med.daily_dose}/day · ${med.total_pills} total (${med.sheets}×${med.pills_per_sheet}) · <strong class="${remaining <= LOW_PILL_THRESHOLD ? 'med-remaining-low' : ''}">${remaining} left</strong></div>
                          ${alerts.map(a => `<div class="med-alert-line ${a.type}">${a.msg}</div>`).join('')}
                        </div>`;
                    }).join('')}
                  </div>`;
              }).join('')}
            </div>
          ` : ''}
        </div>`;
    }).join('');

    el.querySelectorAll('.debt-customer-row').forEach(row => {
      row.addEventListener('click', () => {
        const fid = parseInt(row.dataset.fid);
        if (_expandedFamilies.has(fid)) _expandedFamilies.delete(fid);
        else _expandedFamilies.add(fid);
        renderTabContent(data, tab);
      });
    });
  } else if (tab === 'reports') {
    const s = data.reportsSummary;
    if (!s) {
      el.innerHTML = '<div class="empty-state">No report data yet.</div>';
      return;
    }
    el.innerHTML = `
      <div class="report-window-note">Last ${s.windowDays} days</div>
      <div class="report-metrics-grid">
        <div class="metric-card"><div class="mc-label">Gross Revenue</div><div class="mc-val success">${fmt(s.revenue)}</div></div>
        <div class="metric-card"><div class="mc-label danger">Refunds</div><div class="mc-val danger">− ${fmt(s.refundsTotal)} <span class="mc-sub">(${s.refundsCount})</span></div></div>
        <div class="metric-card"><div class="mc-label">Net Revenue</div><div class="mc-val info">${fmt(s.netRevenue)}</div></div>
        <div class="metric-card"><div class="mc-label">Discounts Given</div><div class="mc-val warn">${fmt(s.totalDiscount)}</div></div>
        <div class="metric-card"><div class="mc-label">Transactions</div><div class="mc-val">${s.transactionCount}</div></div>
        <div class="metric-card"><div class="mc-label">Units Sold</div><div class="mc-val">${s.unitsSold}</div></div>
      </div>

      <div class="section-header">Top Selling Items</div>
      ${s.topItems.length === 0 ? '<div class="empty-state small">No sales in this window.</div>' : `
        <div class="report-items-list">
          ${(() => {
            const maxQty = Math.max(...s.topItems.map(r => r.total_qty), 1);
            return s.topItems.map(r => `
              <div class="report-item-row">
                <span class="ri-name">${r.item_name}</span>
                <div class="ri-bar-wrap"><div class="ri-bar" style="width:${Math.round(r.total_qty / maxQty * 100)}%"></div></div>
                <span class="ri-units">${r.total_qty} units</span>
              </div>`).join('');
          })()}
        </div>
      `}

      <div class="section-header">Cashier Performance</div>
      ${s.cashierSummary.length === 0 ? '<div class="empty-state small">No shift data in this window.</div>' : `
        <table class="data-table cashier-table">
          <thead><tr><th>Cashier</th><th class="num">Revenue</th><th class="num">Tx</th><th class="num">Hours</th></tr></thead>
          <tbody>
            ${s.cashierSummary.map(c => `
              <tr>
                <td>${c.full_name}</td>
                <td class="num success">${fmt(c.revenue)}</td>
                <td class="num">${c.transaction_count}</td>
                <td class="num">${Math.floor(c.total_minutes / 60)}h ${Math.round(c.total_minutes % 60)}m</td>
              </tr>`).join('')}
          </tbody>
        </table>
      `}`;
  } else if (tab === 'cash') {
    const history = data.cashHistory;
    el.innerHTML = history.slice().reverse().map(h => `
      <div class="row-item"><div>${h.date}</div><div class="row-sub">${h.tx_count} sale(s)</div><div class="row-amt">${fmt(h.revenue)}</div></div>
    `).join('') || '<div class="empty-state">No sales history yet.</div>';
  }
}

// ── Boot ──────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js').catch(() => { /* non-fatal — app still works without offline shell caching */ });
}
renderApp();
