// popup.js

const API_BASE = 'https://d85j77xztl.execute-api.us-east-2.amazonaws.com';

// ── Elements ──────────────────────────────────────────────────────────────────
const authScreen = document.getElementById('auth-screen');
const dashScreen = document.getElementById('dashboard-screen');
const authForm   = document.getElementById('auth-form');
const authBtn    = document.getElementById('auth-btn');
const authError  = document.getElementById('auth-error');
const tabs       = document.querySelectorAll('.tab');

const timeUsed   = document.getElementById('time-used');
const timeBar    = document.getElementById('time-bar');
const timeLimit  = document.getElementById('time-limit');
const statusDot  = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const alertBanner = document.getElementById('alert-banner');
const alertIcon  = document.getElementById('alert-icon');
const alertTextEl = document.getElementById('alert-text');

let currentTab = 'login';

// ── Tab switching ─────────────────────────────────────────────────────────────
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    authBtn.textContent = currentTab === 'login' ? 'Login' : 'Create Account';
    authError.classList.add('hidden');
  });
});

// ── Auth form submit ──────────────────────────────────────────────────────────
authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.classList.add('hidden');
  authBtn.textContent = 'Loading…';
  authBtn.disabled = true;

  const email    = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const endpoint = currentTab === 'login' ? '/auth/login' : '/auth/signup';

  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Auth failed');

    // Save to extension storage
    await chrome.storage.local.set({ fg_token: data.token, fg_userId: data.userId });

    // Notify background to connect WebSocket
    chrome.runtime.sendMessage({ type: 'AUTH_SUCCESS' });

    showDashboard(data.userId);
  } catch (err) {
    authError.textContent = err.message;
    authError.classList.remove('hidden');
    authBtn.textContent = currentTab === 'login' ? 'Login' : 'Create Account';
    authBtn.disabled = false;
  }
});

// ── Logout ────────────────────────────────────────────────────────────────────
document.getElementById('logout-btn').addEventListener('click', async () => {
  clearInterval(statsRefreshInterval);
  await chrome.storage.local.remove(['fg_token', 'fg_userId', 'fg_pending_alert']);
  chrome.runtime.sendMessage({ type: 'LOGOUT' });
  dashScreen.classList.add('hidden');
  authScreen.classList.remove('hidden');
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
let statsRefreshInterval = null;

async function showDashboard(userId) {
  authScreen.classList.add('hidden');
  dashScreen.classList.remove('hidden');

  // Check for pending alert from WebSocket
  const storage = await chrome.storage.local.get(['fg_pending_alert', 'fg_token']);
  if (storage.fg_pending_alert) {
    showAlert(storage.fg_pending_alert);
    chrome.storage.local.remove('fg_pending_alert');
  }

  // Fetch server total once, then sync every 15s to catch flushed sessions
  // (Smooth 1s tick comes from content.js → chrome.storage live updates)
  if (storage.fg_token) {
    loadStats(storage.fg_token, userId);
    clearInterval(statsRefreshInterval);
    statsRefreshInterval = setInterval(() => loadStats(storage.fg_token, userId), 15000);
  }
}

function formatHMS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

let serverTotalSec = 0;
let limitSec       = 7200;
let liveSessionSec = 0;

function renderTotal() {
  const used = serverTotalSec + liveSessionSec;
  const pct  = Math.min(100, Math.round((used / limitSec) * 100));

  timeUsed.textContent  = formatHMS(used);
  timeLimit.textContent = `of ${formatHMS(limitSec)} limit`;
  timeBar.style.width   = `${pct}%`;

  if (pct >= 100) timeBar.className = 'stat-bar-fill danger';
  else if (pct >= 50) timeBar.className = 'stat-bar-fill warn';
  else timeBar.className = 'stat-bar-fill';
}

async function loadStats(token, userId) {
  try {
    const res = await fetch(`${API_BASE}/stats?userId=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();

    serverTotalSec = data.totalSeconds || 0;
    limitSec       = data.limitSeconds || 7200;
    renderTotal();

    statusDot.classList.add('active');
    statusText.textContent = 'Monitoring active';
  } catch {
    statusText.textContent = 'Could not load stats';
  }
}

// Listen for live session updates from content.js (writes every second when playing)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.fg_live_session) {
    liveSessionSec = changes.fg_live_session.newValue?.seconds || 0;
    renderTotal();
  }
});

// On popup open, also read the current live value once
chrome.storage.local.get(['fg_live_session'], (r) => {
  liveSessionSec = r.fg_live_session?.seconds || 0;
});

function showAlert(alert) {
  alertBanner.classList.remove('hidden', 'warning', 'danger');
  if (alert.level === 'hard') {
    alertBanner.classList.add('danger');
    alertIcon.textContent = '🚨';
  } else {
    alertBanner.classList.add('warning');
    alertIcon.textContent = '⏰';
  }
  alertTextEl.textContent = alert.message;
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const { fg_token, fg_userId } = await chrome.storage.local.get(['fg_token', 'fg_userId']);
  if (fg_token && fg_userId) {
    showDashboard(fg_userId);
  }
})();
