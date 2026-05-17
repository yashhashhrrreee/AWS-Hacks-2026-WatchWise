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
    initLimitCard(storage.fg_token, userId);
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
