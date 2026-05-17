// popup.js - FocusGuard

const API_BASE = 'https://d85j77xztl.execute-api.us-east-2.amazonaws.com';

const authScreen = document.getElementById('auth-screen');
const dashScreen = document.getElementById('dashboard-screen');
const authForm   = document.getElementById('auth-form');
const authBtn    = document.getElementById('auth-btn');
const authError  = document.getElementById('auth-error');
const tabs       = document.querySelectorAll('.tab');

const scoreNum        = document.getElementById('score-num');
const dotRow          = document.getElementById('dot-row');
const goalsCaption    = document.getElementById('goals-caption');

const eduValueEl      = document.getElementById('edu-value');
const eduBarEl        = document.getElementById('edu-bar');
const entValueEl      = document.getElementById('ent-value');
const entLimitEl      = document.getElementById('ent-limit');
const entBarEl        = document.getElementById('ent-bar');
const entRemainingEl  = document.getElementById('ent-remaining');

const warningModal    = document.getElementById('warning-modal');
const warningClose    = document.getElementById('warning-close');
const warningAck      = document.getElementById('warning-ack');
const warnPctEl       = document.getElementById('warn-pct');
const warnRemainingEl = document.getElementById('warn-remaining-value');
const warnBarEl       = document.getElementById('warn-bar');

const blockModal      = document.getElementById('block-modal');
const blockClose      = document.getElementById('block-close');
const blockLimitLabel = document.getElementById('block-limit-label');
const achievementEl   = document.getElementById('achievement-value');
const resetCountdown  = document.getElementById('reset-countdown');

let currentTab     = 'login';
let serverTotalSec = 0;
let serverEduSec   = 0;
let limitSec       = 7200;
let liveSessionSec = 0;
let livePlaying    = false;    // is a non-edu video currently playing
let liveLastTs     = 0;        // ms timestamp of last update from content.js
let statsRefreshInterval = null;
let smoothTickInterval   = null;

let warningDismissedToday  = false;
let blockDismissedThisOpen = false;

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    authBtn.textContent = currentTab === 'login' ? 'Login' : 'Create Account';
    authError.classList.add('hidden');
  });
});

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.classList.add('hidden');
  authBtn.textContent = 'Loading...';
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

    await chrome.storage.local.set({ fg_token: data.token, fg_userId: data.userId });
    chrome.runtime.sendMessage({ type: 'AUTH_SUCCESS' });

    showDashboard(data.userId);
  } catch (err) {
    authError.textContent = err.message;
    authError.classList.remove('hidden');
    authBtn.textContent = currentTab === 'login' ? 'Login' : 'Create Account';
    authBtn.disabled = false;
  }
});

const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    clearInterval(statsRefreshInterval);
    stopSmoothTick();
    await chrome.storage.local.remove(['fg_token', 'fg_userId', 'fg_pending_alert']);
    chrome.runtime.sendMessage({ type: 'LOGOUT' });
    dashScreen.classList.add('hidden');
    authScreen.classList.remove('hidden');
  });
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function dismissWarning() {
  warningDismissedToday = true;
  if (warningModal) warningModal.classList.add('hidden');
  await chrome.storage.local.set({ fg_warning_dismissed_date: todayKey() });
}

function dismissBlock() {
  blockDismissedThisOpen = true;
  if (blockModal) blockModal.classList.add('hidden');
}

if (warningClose) warningClose.addEventListener('click', dismissWarning);
if (warningAck)   warningAck.addEventListener('click', dismissWarning);
if (blockClose)   blockClose.addEventListener('click', dismissBlock);

const warnBackdrop  = warningModal && warningModal.querySelector('.modal-backdrop');
const blockBackdrop = blockModal   && blockModal.querySelector('.modal-backdrop');
if (warnBackdrop)  warnBackdrop.addEventListener('click', dismissWarning);
if (blockBackdrop) blockBackdrop.addEventListener('click', dismissBlock);

function formatHMS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function formatHoursShort(totalSeconds) {
  const h = Math.round((totalSeconds || 0) / 3600);
  return `${h}hr`;
}

function timeUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const diffSec = Math.floor((midnight - now) / 1000);
  return formatHMS(diffSec);
}

function render() {
  const usedSec      = serverTotalSec + liveSessionSec;
  const remainingSec = Math.max(0, limitSec - usedSec);
  const entPct       = limitSec > 0 ? Math.min(100, Math.round((usedSec / limitSec) * 100)) : 0;
  const eduPct       = limitSec > 0 ? Math.min(100, Math.round((serverEduSec / limitSec) * 100)) : 0;

  if (eduValueEl)     eduValueEl.textContent = formatHMS(serverEduSec);
  if (eduBarEl)       eduBarEl.style.width = `${eduPct}%`;

  if (entValueEl)     entValueEl.textContent = formatHMS(usedSec);
  if (entLimitEl)     entLimitEl.textContent = formatHMS(limitSec);
  if (entBarEl)       entBarEl.style.width = `${entPct}%`;
  if (entRemainingEl) entRemainingEl.textContent = `${formatHMS(remainingSec)} remaining`;

  if (scoreNum) scoreNum.textContent = String(Math.max(0, 100 - entPct));

  if (dotRow) {
    const filledGreen = Math.max(0, 5 - Math.ceil(entPct / 20));
    const orangeDot   = entPct >= 80 && entPct < 100 ? 1 : 0;
    const redDot      = entPct >= 100 ? 1 : 0;
    let html = '';
    for (let i = 0; i < filledGreen; i++) html += '<span class="dot dot-green"></span>';
    for (let i = 0; i < orangeDot; i++)   html += '<span class="dot dot-orange"></span>';
    for (let i = 0; i < redDot; i++)      html += '<span class="dot dot-red"></span>';
    while (html.split('<span').length - 1 < 5) html += '<span class="dot dot-dim"></span>';
    dotRow.innerHTML = html;
    if (goalsCaption) goalsCaption.textContent = `${filledGreen} of 5 goals hit`;
  }

  if (warnPctEl)       warnPctEl.textContent = String(entPct);
  if (warnRemainingEl) warnRemainingEl.textContent = formatHMS(remainingSec);
  if (warnBarEl)       warnBarEl.style.width = `${entPct}%`;

  if (blockLimitLabel) blockLimitLabel.textContent = formatHoursShort(limitSec);
  if (achievementEl)   achievementEl.textContent = formatHMS(serverEduSec);
  if (resetCountdown)  resetCountdown.textContent = `Resets in ${timeUntilMidnight()}`;

  if (entPct >= 100 && !blockDismissedThisOpen) {
    if (blockModal)   blockModal.classList.remove('hidden');
    if (warningModal) warningModal.classList.add('hidden');
  } else if (entPct >= 50 && entPct < 100 && !warningDismissedToday) {
    if (warningModal) warningModal.classList.remove('hidden');
    if (blockModal)   blockModal.classList.add('hidden');
  } else {
    if (warningModal) warningModal.classList.add('hidden');
    if (blockModal)   blockModal.classList.add('hidden');
  }
}

async function loadStats(token, userId) {
  try {
    const res = await fetch(`${API_BASE}/stats?userId=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();

    serverTotalSec = data.totalSeconds || 0;
    limitSec       = data.limitSeconds || 7200;
    if (typeof data.educationalSeconds === 'number') serverEduSec = data.educationalSeconds;

    render();
  } catch (err) {
    console.warn('[FocusGuard] stats fetch failed', err);
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.fg_live_session) {
    const v = changes.fg_live_session.newValue || {};
    liveSessionSec = v.seconds || 0;
    livePlaying    = !!v.playing;
    liveLastTs     = v.ts || Date.now();
    render();
  }
  if (changes.fg_pending_alert?.newValue) {
    const alert = changes.fg_pending_alert.newValue;
    if (alert.level === 'hard') blockDismissedThisOpen = false;
    else                        warningDismissedToday = false;
    render();
  }
});

// Local 1-second tick: while a video is playing, bump the live counter
// locally so the UI stays smooth even if storage events arrive late.
// The next real storage update from content.js will snap us back into sync.
function startSmoothTick() {
  if (smoothTickInterval) return;
  smoothTickInterval = setInterval(() => {
    if (livePlaying) {
      // Only tick locally if we haven't heard from content.js in the last 1.5s
      // (otherwise content.js's own tick is doing the job).
      const sinceLast = Date.now() - liveLastTs;
      if (sinceLast > 1500) {
        liveSessionSec += 1;
      }
    }
    render();
  }, 1000);
}

function stopSmoothTick() {
  if (smoothTickInterval) {
    clearInterval(smoothTickInterval);
    smoothTickInterval = null;
  }
}

async function showDashboard(userId) {
  authScreen.classList.add('hidden');
  dashScreen.classList.remove('hidden');

  const storage = await chrome.storage.local.get([
    'fg_pending_alert', 'fg_token', 'fg_live_session', 'fg_warning_dismissed_date'
  ]);

  warningDismissedToday = storage.fg_warning_dismissed_date === todayKey();
  blockDismissedThisOpen = false;

  const liveInit = storage.fg_live_session || {};
  liveSessionSec = liveInit.seconds || 0;
  livePlaying    = !!liveInit.playing;
  liveLastTs     = liveInit.ts || 0;
  startSmoothTick();

  if (storage.fg_pending_alert) {
    chrome.storage.local.remove('fg_pending_alert');
  }

  if (storage.fg_token) {
    loadStats(storage.fg_token, userId);
    clearInterval(statsRefreshInterval);
    statsRefreshInterval = setInterval(
      () => loadStats(storage.fg_token, userId),
      15000
    );
  }
}

(async () => {
  const { fg_token, fg_userId } = await chrome.storage.local.get(['fg_token', 'fg_userId']);
  if (fg_token && fg_userId) {
    showDashboard(fg_userId);
  }
})();
