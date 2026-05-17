// popup.js - FocusGuard

const API_BASE = 'https://d85j77xztl.execute-api.us-east-2.amazonaws.com';

const authScreen = document.getElementById('auth-screen');
const dashScreen = document.getElementById('dashboard-screen');
const authForm   = document.getElementById('auth-form');
const authBtn    = document.getElementById('auth-btn');
const authError  = document.getElementById('auth-error');
const tabs       = document.querySelectorAll('.tab');

const scoreNum        = document.getElementById('score-num');
const studyCaption    = document.getElementById('study-caption');
const resetHint       = document.getElementById('reset-hint');

const limitToggle     = document.getElementById('limit-toggle');
const limitBody       = document.getElementById('limit-body');
const limitChevron    = document.getElementById('limit-chevron');
const limitCooldown   = document.getElementById('limit-cooldown');
const limitCooldownTime = document.getElementById('limit-cooldown-time');
const entLimitSlider  = document.getElementById('ent-limit-slider');
const entLimitVal     = document.getElementById('ent-limit-val');
const studyLimitSlider = document.getElementById('study-limit-slider');
const studyLimitVal   = document.getElementById('study-limit-val');
const btnSaveLimit    = document.getElementById('btn-save-limit');
const limitSaveMsg    = document.getElementById('limit-save-msg');

const eduValueEl      = document.getElementById('edu-value');
const eduBarEl        = document.getElementById('edu-bar');
const entValueEl      = document.getElementById('ent-value');
const entLimitEl      = document.getElementById('ent-limit');
const entBarEl        = document.getElementById('ent-bar');
const entRemainingEl  = document.getElementById('ent-remaining');

const warningModal    = document.getElementById('warning-modal');
const warningClose    = document.getElementById('warning-close');
const warningAck      = document.getElementById('warning-ack');
const blockModeBtn    = document.getElementById('block-mode-btn');
const blockModeLabel  = document.getElementById('block-mode-label');
const warnPctEl       = document.getElementById('warn-pct');
const warnRemainingEl = document.getElementById('warn-remaining-value');
const warnBarEl       = document.getElementById('warn-bar');

const blockModal      = document.getElementById('block-modal');
const blockClose      = document.getElementById('block-close');
const blockLimitLabel = document.getElementById('block-limit-label');
const achievementEl   = document.getElementById('achievement-value');
const resetCountdown  = document.getElementById('reset-countdown');

let currentTab        = 'login';
let serverTotalSec    = 0;
let serverEduSec      = 0;
let limitSec          = 7200;
let studyGoalSec      = 7200;
let limitChangedAt    = null;
let currentStreak     = 0;
let streakAtRisk      = false;
let graceExpiresAt    = null;
let liveSessionSec    = 0;
let livePlaying       = false;
let liveEduSec        = 0;
let liveEduPlaying    = false;
let liveLastTs        = 0;
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

// ── Saved credentials ─────────────────────────────────────────────────────────

const savedCredHint  = document.getElementById('saved-cred-hint');
const savedCredEmail = document.getElementById('saved-cred-email');
const forgetBtn      = document.getElementById('forget-btn');
const rememberMe     = document.getElementById('remember-me');
const emailInput     = document.getElementById('email');
const passwordInput  = document.getElementById('password');

async function loadSavedCreds() {
  const { fg_saved_creds } = await chrome.storage.local.get('fg_saved_creds');
  if (!fg_saved_creds) return;

  emailInput.value    = fg_saved_creds.email    || '';
  passwordInput.value = fg_saved_creds.password || '';
  if (rememberMe) rememberMe.checked = true;

  if (savedCredHint && savedCredEmail) {
    savedCredEmail.textContent = fg_saved_creds.email;
    savedCredHint.classList.remove('hidden');
  }
}

if (forgetBtn) {
  forgetBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove('fg_saved_creds');
    if (emailInput)    emailInput.value    = '';
    if (passwordInput) passwordInput.value = '';
    if (rememberMe)    rememberMe.checked  = false;
    if (savedCredHint) savedCredHint.classList.add('hidden');
  });
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.classList.add('hidden');
  authBtn.textContent = 'Loading...';
  authBtn.disabled = true;

  const email    = emailInput.value.trim();
  const password = passwordInput.value;
  const endpoint = currentTab === 'login' ? '/auth/login' : '/auth/signup';

  const ALLOWED_DOMAINS = new Set([
    'gmail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk',
    'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
    'icloud.com', 'me.com', 'mac.com',
    'protonmail.com', 'proton.me',
    'aol.com', 'mail.com', 'zoho.com',
  ]);
  const emailDomain = email.toLowerCase().split('@')[1] || '';
  if (currentTab === 'signup' && !ALLOWED_DOMAINS.has(emailDomain)) {
    authError.textContent = 'Please use a valid email provider (Gmail, Yahoo, Outlook, iCloud, etc.)';
    authError.classList.remove('hidden');
    authBtn.textContent = 'Create Account';
    authBtn.disabled = false;
    return;
  }

  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Auth failed');

    await chrome.storage.local.set({ fg_token: data.token, fg_userId: data.userId });

    if (rememberMe?.checked) {
      await chrome.storage.local.set({ fg_saved_creds: { email, password } });
    } else {
      await chrome.storage.local.remove('fg_saved_creds');
    }

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
    loadSavedCreds();
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

let blockModeEnabled = false;

async function loadBlockMode() {
  const s = await chrome.storage.local.get('fg_block_mode');
  blockModeEnabled = !!s.fg_block_mode;
  updateBlockModeBtn();
}

function updateBlockModeBtn() {
  if (!blockModeBtn || !blockModeLabel) return;
  if (blockModeEnabled) {
    blockModeBtn.classList.add('active');
    blockModeLabel.textContent = 'Block mode: ON';
  } else {
    blockModeBtn.classList.remove('active');
    blockModeLabel.textContent = 'Block me at 100%';
  }
}

if (blockModeBtn) {
  blockModeBtn.addEventListener('click', async () => {
    blockModeEnabled = !blockModeEnabled;
    await chrome.storage.local.set({ fg_block_mode: blockModeEnabled });
    updateBlockModeBtn();
    if (blockModeEnabled) dismissWarning();
  });
}
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

function timeUntilMidnightHM() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const diffSec = Math.floor((midnight - now) / 1000);
  const h = Math.floor(diffSec / 3600);
  const m = Math.floor((diffSec % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function render() {
  const usedSec      = serverTotalSec + liveSessionSec;
  const remainingSec = Math.max(0, limitSec - usedSec);
  const entPct       = limitSec > 0 ? Math.min(100, Math.round((usedSec / limitSec) * 100)) : 0;
  const eduPct       = limitSec > 0 ? Math.min(100, Math.round((serverEduSec / limitSec) * 100)) : 0;

  if (eduValueEl)     eduValueEl.textContent = formatHMS(serverEduSec + liveEduSec);
  if (eduBarEl)       eduBarEl.style.width = `${eduPct}%`;

  if (entValueEl)     entValueEl.textContent = formatHMS(usedSec);
  if (entLimitEl)     entLimitEl.textContent = formatHMS(limitSec);
  if (entBarEl)       entBarEl.style.width = `${entPct}%`;
  if (entRemainingEl) entRemainingEl.textContent = `${formatHMS(remainingSec)} remaining`;

  const totalEduSec = serverEduSec + liveEduSec;
  const studyPct = Math.min(100, Math.round((totalEduSec / studyGoalSec) * 100));
  if (scoreNum) scoreNum.textContent = String(studyPct);
  const studyGoalHrs = (studyGoalSec / 3600).toFixed(1).replace('.0', '');
  if (studyCaption) {
    if (totalEduSec >= studyGoalSec) {
      studyCaption.textContent = `Congrats! You studied more than ${studyGoalHrs}hrs today 🎉`;
    } else {
      studyCaption.textContent = `${studyPct}% of ${studyGoalHrs}hr goal`;
    }
  }
  if (resetHint) resetHint.textContent = `resets in ${timeUntilMidnightHM()}`;

  // Streak display
  const streakLabel = document.getElementById('streak-label');
  const streakRisk  = document.getElementById('streak-risk');
  const streakGraceTime = document.getElementById('streak-grace-time');
  const streakIcon  = document.getElementById('streak-icon');
  if (streakLabel) {
    streakLabel.textContent = `${currentStreak}-day streak`;
  }
  if (streakRisk && streakGraceTime) {
    if (streakAtRisk && graceExpiresAt) {
      const remainSec = Math.max(0, Math.floor((new Date(graceExpiresAt) - Date.now()) / 1000));
      const h = Math.floor(remainSec / 3600);
      const m = Math.floor((remainSec % 3600) / 60);
      streakGraceTime.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      streakRisk.classList.remove('hidden');
    } else {
      streakRisk.classList.add('hidden');
    }
  }
  if (streakIcon) {
    streakIcon.style.color = streakAtRisk ? 'var(--red)' : '';
  }

  // Limit settings cooldown display
  renderLimitCooldown();

  if (warnPctEl)       warnPctEl.textContent = String(entPct);
  if (warnRemainingEl) warnRemainingEl.textContent = formatHMS(remainingSec);
  if (warnBarEl)       warnBarEl.style.width = `${entPct}%`;

  if (blockLimitLabel) blockLimitLabel.textContent = formatHoursShort(limitSec);
  if (achievementEl)   achievementEl.textContent = formatHMS(serverEduSec + liveEduSec);
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

// ── Weekly chart ──────────────────────────────────────────────────────────────

const DAY_ABBR = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function renderWeekChart(days) {
  const svg = document.getElementById('week-svg');
  const dayRow = document.getElementById('week-chart-days');
  if (!svg || !dayRow) return;

  const W = 268, H = 110;
  const padL = 0, padR = 0, padT = 8, padB = 2;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const n = days.length; // 7

  const slotW = chartW / n;
  const barW  = Math.floor(slotW * 0.45);

  const maxVal = Math.max(...days.map(d => Math.max(d.entSec, d.eduSec)), 1);

  const scaleY = v => padT + chartH - (v / maxVal) * chartH;
  const barX   = i => padL + i * slotW + (slotW - barW) / 2;
  const dotX   = i => padL + i * slotW + slotW / 2;

  const todayStr = new Date().toISOString().slice(0, 10);

  let svgHtml = '';

  // Subtle grid lines (2)
  [0.5, 1].forEach(frac => {
    const y = padT + chartH * (1 - frac) + (frac === 1 ? 0 : 0);
    svgHtml += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"
      stroke="rgba(255,255,255,0.05)" stroke-width="1"/>`;
  });

  // Bars — entertainment (orange)
  days.forEach((d, i) => {
    const bh = Math.max(2, (d.entSec / maxVal) * chartH);
    const by = padT + chartH - bh;
    const isToday = d.date === todayStr;
    const fill = isToday ? '#fb923c' : '#f97316';
    const opacity = d.entSec === 0 ? '0.2' : '0.85';
    svgHtml += `<rect x="${barX(i).toFixed(1)}" y="${by.toFixed(1)}"
      width="${barW}" height="${bh.toFixed(1)}"
      rx="3" fill="${fill}" opacity="${opacity}"/>`;
  });

  // Line — education (green): build polyline points
  const linePoints = days.map((d, i) => {
    const x = dotX(i).toFixed(1);
    const y = scaleY(d.eduSec).toFixed(1);
    return `${x},${y}`;
  }).join(' ');

  svgHtml += `<polyline points="${linePoints}"
    fill="none" stroke="#a3e635" stroke-width="1.8"
    stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>`;

  // Dots on line
  days.forEach((d, i) => {
    const cx = dotX(i).toFixed(1);
    const cy = scaleY(d.eduSec).toFixed(1);
    const isToday = d.date === todayStr;
    svgHtml += `<circle cx="${cx}" cy="${cy}" r="${isToday ? 4 : 3}"
      fill="${isToday ? '#a3e635' : '#1a1a2e'}"
      stroke="#a3e635" stroke-width="1.8"/>`;
  });

  svg.innerHTML = svgHtml;

  // Day labels
  dayRow.innerHTML = days.map(d => {
    const isToday = d.date === todayStr;
    const label = DAY_ABBR[new Date(d.date + 'T12:00:00').getDay()];
    return `<span class="week-day-label${isToday ? ' today' : ''}">${isToday ? 'Today' : label}</span>`;
  }).join('');
}

async function loadWeeklyStats(token, userId) {
  try {
    const res = await fetch(`${API_BASE}/weekly-stats?userId=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.days) renderWeekChart(data.days);
  } catch (err) {
    console.warn('[FocusGuard] weekly stats fetch failed', err);
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
    studyGoalSec   = data.studyGoalSeconds || 7200;
    limitChangedAt = data.limitChangedAt || null;
    currentStreak  = data.currentStreak || 0;
    streakAtRisk   = data.streakAtRisk  || false;
    graceExpiresAt = data.graceExpiresAt || null;
    if (typeof data.educationalSeconds === 'number') serverEduSec = data.educationalSeconds;

    syncLimitSliders();
    render();
  } catch (err) {
    console.warn('[FocusGuard] stats fetch failed', err);
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.fg_live_session) {
    const v = changes.fg_live_session.newValue || {};
    liveSessionSec = v.seconds    || 0;
    livePlaying    = !!v.playing;
    liveEduSec     = v.eduSeconds || 0;
    liveEduPlaying = !!v.eduPlaying;
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
    const sinceLast = Date.now() - liveLastTs;
    if (sinceLast > 1200) {
      if (livePlaying)    liveSessionSec += 1;
      if (liveEduPlaying) liveEduSec     += 1;
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

// ── Limit settings UI ─────────────────────────────────────────────────────────

function secToSliderVal(sec) {
  return (sec / 3600).toFixed(1);
}

function sliderValToSec(val) {
  return Math.round(parseFloat(val) * 3600);
}

function formatSliderLabel(val) {
  const h = parseFloat(val);
  return h === Math.floor(h) ? `${Math.floor(h)}h` : `${h}h`;
}

function getLimitCooldownRemaining() {
  if (!limitChangedAt) return 0;
  const elapsed = Date.now() - new Date(limitChangedAt).getTime();
  return Math.max(0, 24 * 3600 * 1000 - elapsed);
}

function renderLimitCooldown() {
  if (!limitCooldown || !btnSaveLimit || !entLimitSlider || !studyLimitSlider) return;
  const remaining = getLimitCooldownRemaining();
  const onCooldown = remaining > 0;

  if (onCooldown) {
    const totalSec = Math.ceil(remaining / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    limitCooldownTime.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    limitCooldown.classList.remove('hidden');
  } else {
    limitCooldown.classList.add('hidden');
  }

  entLimitSlider.disabled  = onCooldown;
  studyLimitSlider.disabled = onCooldown;
  btnSaveLimit.disabled    = onCooldown;
}

function syncLimitSliders() {
  if (!entLimitSlider || !studyLimitSlider) return;
  const eVal = secToSliderVal(limitSec);
  const sVal = secToSliderVal(studyGoalSec);
  entLimitSlider.value  = eVal;
  studyLimitSlider.value = sVal;
  if (entLimitVal)   entLimitVal.textContent   = formatSliderLabel(eVal);
  if (studyLimitVal) studyLimitVal.textContent = formatSliderLabel(sVal);
}

function initLimitCard(token, userId) {
  if (!limitToggle) return;

  // Toggle expand/collapse
  limitToggle.addEventListener('click', () => {
    const open = !limitBody.classList.contains('hidden');
    limitBody.classList.toggle('hidden', open);
    limitChevron.classList.toggle('open', !open);
  });

  // Live slider labels
  entLimitSlider.addEventListener('input', () => {
    entLimitVal.textContent = formatSliderLabel(entLimitSlider.value);
  });
  studyLimitSlider.addEventListener('input', () => {
    studyLimitVal.textContent = formatSliderLabel(studyLimitSlider.value);
  });

  // Save
  btnSaveLimit.addEventListener('click', async () => {
    const newLimitSec = sliderValToSec(entLimitSlider.value);
    const newStudySec = sliderValToSec(studyLimitSlider.value);

    btnSaveLimit.disabled = true;
    btnSaveLimit.textContent = 'Saving…';
    limitSaveMsg.className = 'limit-save-msg hidden';

    try {
      const res = await fetch(`${API_BASE}/limit`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userId, limitSeconds: newLimitSec, studyGoalSeconds: newStudySec }),
      });
      const data = await res.json();

      if (!res.ok) {
        limitSaveMsg.textContent = data.message || 'Save failed';
        limitSaveMsg.className = 'limit-save-msg error';
        limitSaveMsg.classList.remove('hidden');
        btnSaveLimit.disabled = false;
        btnSaveLimit.textContent = 'Save limits';
        return;
      }

      limitSec       = data.limitSeconds;
      studyGoalSec   = data.studyGoalSeconds;
      limitChangedAt = data.limitChangedAt;

      limitSaveMsg.textContent = 'Saved!';
      limitSaveMsg.className = 'limit-save-msg success';
      limitSaveMsg.classList.remove('hidden');
      setTimeout(() => limitSaveMsg.classList.add('hidden'), 2500);

      renderLimitCooldown();
      render();
    } catch (err) {
      limitSaveMsg.textContent = 'Network error';
      limitSaveMsg.className = 'limit-save-msg error';
      limitSaveMsg.classList.remove('hidden');
      btnSaveLimit.disabled = false;
      btnSaveLimit.textContent = 'Save limits';
    }
  });
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
  liveSessionSec = liveInit.seconds    || 0;
  livePlaying    = !!liveInit.playing;
  liveEduSec     = liveInit.eduSeconds || 0;
  liveEduPlaying = !!liveInit.eduPlaying;
  liveLastTs     = liveInit.ts || 0;
  render();
  startSmoothTick();

  if (storage.fg_pending_alert) {
    chrome.storage.local.remove('fg_pending_alert');
  }

  if (storage.fg_token) {
    loadBlockMode();
    initLimitCard(storage.fg_token, userId);
    loadStats(storage.fg_token, userId);
    loadWeeklyStats(storage.fg_token, userId);
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
  } else {
    loadSavedCreds();
  }
})();
