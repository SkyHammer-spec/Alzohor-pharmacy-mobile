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

// ── Small helpers ────────────────────────────────────────────────────────
function fmt(n) {
  return Number(n || 0).toLocaleString() + ' IQD';
}
function formatTimestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
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
async function attemptLogin(username, token) {
  const users = await fetchDriveJson('mobile-users.json'); // always live — never trust a cached login list
  const tokenHash = await sha256Hex(token);
  const match = users.find(u =>
    u.display_name.trim().toLowerCase() === username.trim().toLowerCase() && u.token_hash === tokenHash
  );
  if (!match) return { success: false, error: 'Incorrect name or access code.' };
  const session = { id: match.id, display_name: match.display_name, role: match.role, linked_driver_id: match.linked_driver_id };
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
          <label>Name</label>
          <input id="login-name" type="text" autocomplete="username" />
        </div>
        <div class="form-group">
          <label>Access Code</label>
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
    el.innerHTML = `
      <div class="alert-stats">
        <div class="alert-stat danger"><div class="as-num">${a.expired.length}</div><div>Expired</div></div>
        <div class="alert-stat danger"><div class="as-num">${a.outOfStock.length}</div><div>Out of Stock</div></div>
        <div class="alert-stat warn"><div class="as-num">${a.expiring30.length}</div><div>Expiring Soon</div></div>
        <div class="alert-stat warn"><div class="as-num">${a.lowStock.length}</div><div>Low Stock</div></div>
      </div>
      ${[...a.expired, ...a.outOfStock, ...a.expiring30, ...a.lowStock].map(i => `
        <div class="row-item"><div>${i.name}</div><div class="row-sub">Qty: ${i.quantity} · Exp: ${i.expire_date || '—'}</div></div>
      `).join('')}`;
  } else if (tab === 'debts') {
    el.innerHTML = data.debts.balances.map(b => {
      const c = data.debts.customers.find(c => c.id === b.customer_id);
      return `<div class="row-item"><div>${c?.name || '—'}</div><div class="row-amt warn">${fmt(b.owes)}</div></div>`;
    }).join('') || '<div class="empty-state">No outstanding debts.</div>';
  } else if (tab === 'storage') {
    el.innerHTML = data.storage.items.map(i => `
      <div class="row-item"><div>${i.name}</div><div class="row-sub">${i.category || '—'}</div><div class="row-amt">${i.quantity}</div></div>
    `).join('');
  } else if (tab === 'delivery') {
    el.innerHTML = data.delivery.balances.map(b => {
      const g = data.delivery.guys.find(g => g.id === b.delivery_guy_id);
      return `<div class="row-item"><div>${g?.name || '—'}</div><div class="row-amt warn">${fmt(b.owes)}</div></div>`;
    }).join('') || '<div class="empty-state">No delivery guys yet.</div>';
  } else if (tab === 'patients') {
    el.innerHTML = data.patients.families.map(f => {
      const members = data.patients.members.filter(m => m.family_id === f.id);
      return `<div class="row-item"><div>${f.name}</div><div class="row-sub">${members.length} member(s)</div></div>`;
    }).join('') || '<div class="empty-state">No patient families yet.</div>';
  } else if (tab === 'reports' || tab === 'cash') {
    const history = tab === 'reports' ? data.reportsHistory : data.cashHistory;
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
