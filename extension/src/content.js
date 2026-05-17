// content.js — injected on youtube.com/watch pages
// Responsible for:
//   1. Extracting video metadata (title, description, creator)
//   2. Sending to background for classification
//   3. Running a local timer if non-educational
//   4. Flushing session to background when video stops

(() => {
  const log = (...args) => console.log('%c[FocusGuard]', 'color:#7c6aff;font-weight:bold', ...args);
  log('content script loaded');

  let currentVideoId = null;
  let isNonEducational = false;
  let isEducational = false;
  let timerInterval = null;
  let sessionSeconds = 0;
  let eduTimerInterval = null;
  let eduSessionSeconds = 0;
  let videoPlaying = false;

  // ── Context guard ─────────────────────────────────────────────────────────
  // After extension reload the old content script stays alive but chrome APIs
  // throw "Extension context invalidated". Guard every chrome.* call and shut
  // down cleanly when the context is gone.

  function contextAlive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  function teardown() {
    clearInterval(timerInterval);
    clearInterval(eduTimerInterval);
    timerInterval = null;
    eduTimerInterval = null;
    log('extension context invalidated — timers stopped');
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function getVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('v');
  }

  function getMetadata() {
    const title = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.innerText
      || document.title.replace(' - YouTube', '').trim();

    const description = document.querySelector('#description-inline-expander .yt-core-attributed-string')?.innerText
      || document.querySelector('ytd-text-inline-expander #content')?.innerText
      || '';

    const creator = document.querySelector('ytd-channel-name yt-formatted-string a')?.innerText
      || document.querySelector('#owner #channel-name')?.innerText
      || '';

    return { title, description: description.slice(0, 500), creator };
  }

  function getVideoElement() {
    return document.querySelector('video');
  }

  // ── Timer ────────────────────────────────────────────────────────────────

  function publishLive() {
    if (!contextAlive()) { teardown(); return; }
    chrome.storage.local.set({
      fg_live_session: {
        seconds: sessionSeconds,
        playing: !!timerInterval,
        eduSeconds: eduSessionSeconds,
        eduPlaying: !!eduTimerInterval,
        ts: Date.now()
      }
    }).catch(() => teardown());
  }

  function startTimer() {
    if (timerInterval) return;
    log('timer STARTED (non-educational video playing)');
    timerInterval = setInterval(() => {
      if (!contextAlive()) { teardown(); return; }
      sessionSeconds++;
      publishLive();
    }, 1000);
    publishLive();
  }

  function stopTimer() {
    if (timerInterval) {
      log(`timer STOPPED at ${sessionSeconds}s`);
      clearInterval(timerInterval);
      timerInterval = null;
      publishLive();
    }
  }

  function startEduTimer() {
    if (eduTimerInterval) return;
    log('edu timer STARTED (educational video playing)');
    eduTimerInterval = setInterval(() => {
      if (!contextAlive()) { teardown(); return; }
      eduSessionSeconds++;
      publishLive();
    }, 1000);
    publishLive();
  }

  function stopEduTimer() {
    if (eduTimerInterval) {
      log(`edu timer STOPPED at ${eduSessionSeconds}s`);
      clearInterval(eduTimerInterval);
      eduTimerInterval = null;
      publishLive();
    }
  }

  function flushSession() {
    if (!contextAlive()) { teardown(); return; }

    if (!isNonEducational || sessionSeconds < 1) {
      log(`flushSession skipped (isNonEducational=${isNonEducational}, seconds=${sessionSeconds})`);
    } else {
      const meta = getMetadata();
      log(`FLUSHING non-edu session: ${sessionSeconds}s of "${meta.title}"`);
      try {
        chrome.runtime.sendMessage({
          type: 'FLUSH_SESSION',
          payload: {
            videoId: currentVideoId,
            videoTitle: meta.title,
            videoCreator: meta.creator,
            durationSeconds: sessionSeconds,
            classification: 'noneducational',
          }
        }, () => void chrome.runtime.lastError);
      } catch { teardown(); return; }
      sessionSeconds = 0;
      publishLive();
    }

    if (isEducational && eduSessionSeconds >= 1) {
      const meta = getMetadata();
      log(`FLUSHING edu session: ${eduSessionSeconds}s of "${meta.title}"`);
      try {
        chrome.runtime.sendMessage({
          type: 'FLUSH_SESSION',
          payload: {
            videoId: currentVideoId,
            videoTitle: meta.title,
            videoCreator: meta.creator,
            durationSeconds: eduSessionSeconds,
            classification: 'educational',
          }
        }, () => void chrome.runtime.lastError);
      } catch { teardown(); return; }
      eduSessionSeconds = 0;
      publishLive();
    }
  }

  // ── Video event binding ───────────────────────────────────────────────────

  function bindVideoEvents(video) {
    video.addEventListener('play', () => {
      if (!contextAlive()) { teardown(); return; }
      if (isNonEducational) startTimer();
      else startEduTimer();
      videoPlaying = true;
    });

    video.addEventListener('pause', () => {
      stopTimer();
      stopEduTimer();
      videoPlaying = false;
      flushSession();
    });

    video.addEventListener('ended', () => {
      stopTimer();
      stopEduTimer();
      videoPlaying = false;
      flushSession();
    });
  }

  // ── Classification ────────────────────────────────────────────────────────

  async function classifyCurrentVideo() {
    if (!contextAlive()) return;

    const videoId = getVideoId();
    if (!videoId) { log('no videoId in URL, skipping'); return; }
    if (videoId === currentVideoId) { log(`already classified videoId=${videoId}, skipping`); return; }

    log(`new videoId detected: ${videoId}`);
    currentVideoId = videoId;
    isNonEducational = false;
    isEducational = false;
    stopTimer();
    stopEduTimer();
    sessionSeconds = 0;
    eduSessionSeconds = 0;

    await new Promise(r => setTimeout(r, 2000));

    if (!contextAlive()) return;

    const meta = getMetadata();
    if (!meta.title) { log('no title found, aborting classification'); return; }

    log('sending CLASSIFY_VIDEO to background', meta);
    try {
      chrome.runtime.sendMessage(
        { type: 'CLASSIFY_VIDEO', payload: meta },
        (response) => {
          if (chrome.runtime.lastError) {
            log('classify error:', chrome.runtime.lastError.message);
            return;
          }
          log('classify RESPONSE:', response);
          if (response && response.educational === false) {
            isNonEducational = true;
            const video = getVideoElement();
            if (video && !video.paused) startTimer();
          } else if (response && response.educational === true) {
            isEducational = true;
            const video = getVideoElement();
            if (video && !video.paused) startEduTimer();
          }
        }
      );
    } catch { teardown(); return; }

    const video = getVideoElement();
    if (video) {
      log('binding play/pause/ended events to <video>');
      bindVideoEvents(video);
    } else {
      log('no <video> element found yet');
    }
  }

  // ── Block overlay ─────────────────────────────────────────────────────────

  let blockPauseListener = null;
  let blockTickInterval  = null;

  function timeUntilMidnight() {
    const now  = new Date();
    const mid  = new Date(now); mid.setHours(24, 0, 0, 0);
    const sec  = Math.max(0, Math.floor((mid - now) / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }

  function showBlockOverlay() {
    if (document.getElementById('fg-block-overlay')) return;

    const video = document.querySelector('video');
    if (video) {
      video.pause();
      blockPauseListener = () => video.pause();
      video.addEventListener('play', blockPauseListener);
    }

    const overlay = document.createElement('div');
    overlay.id = 'fg-block-overlay';
    overlay.innerHTML = `
      <style>
        #fg-block-overlay {
          position: fixed; inset: 0; z-index: 2147483647;
          background: rgba(10,5,25,0.97);
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          color: #f0ecff;
        }
        #fg-block-overlay .fg-icon {
          width: 64px; height: 64px;
          background: rgba(248,113,113,0.15);
          border: 2px solid rgba(248,113,113,0.4);
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          margin-bottom: 20px;
        }
        #fg-block-overlay h1 {
          font-size: 20px; font-weight: 600; margin: 0 0 8px;
        }
        #fg-block-overlay p {
          font-size: 13px; color: rgba(200,185,255,0.7);
          margin: 0 0 28px; text-align: center; max-width: 300px;
          line-height: 1.6;
        }
        #fg-block-reset {
          font-size: 12px; color: rgba(200,185,255,0.5);
          display: flex; align-items: center; gap: 6px;
        }
        #fg-block-reset strong { color: rgba(200,185,255,0.85); font-size: 14px; }
      </style>
      <div class="fg-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
          stroke="#f87171" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <h1>Entertainment limit reached</h1>
      <p>You've hit your daily limit. Time to focus on something meaningful.</p>
      <div id="fg-block-reset">
        Resets in&nbsp;<strong id="fg-block-countdown">${timeUntilMidnight()}</strong>
      </div>`;

    document.body.appendChild(overlay);

    blockTickInterval = setInterval(() => {
      const el = document.getElementById('fg-block-countdown');
      if (el) el.textContent = timeUntilMidnight();
    }, 30000);
  }

  function removeBlockOverlay() {
    document.getElementById('fg-block-overlay')?.remove();
    clearInterval(blockTickInterval);
    blockTickInterval = null;
    const video = document.querySelector('video');
    if (video && blockPauseListener) {
      video.removeEventListener('play', blockPauseListener);
      blockPauseListener = null;
    }
  }

  async function checkBlockOnLoad() {
    if (!contextAlive()) return;
    try {
      const s = await chrome.storage.local.get(['fg_block_mode', 'fg_blocked_date']);
      const today = new Date().toISOString().slice(0, 10);
      if (s.fg_block_mode && s.fg_blocked_date === today) showBlockOverlay();
    } catch { /* context gone */ }
  }

  // ── Warning toast ─────────────────────────────────────────────────────────

  function showWarningToast(totalMin, limitMin) {
    if (document.getElementById('fg-warning-toast')) return;

    const pct = Math.round((totalMin / limitMin) * 100);
    const remaining = limitMin - totalMin;

    const toast = document.createElement('div');
    toast.id = 'fg-warning-toast';
    toast.innerHTML = `
      <style>
        #fg-warning-toast {
          position: fixed;
          top: 72px;
          right: 16px;
          z-index: 2147483646;
          width: 300px;
          background: linear-gradient(145deg, rgba(20,12,50,0.97), rgba(15,20,50,0.97));
          border: 1px solid rgba(249,115,22,0.4);
          border-radius: 14px;
          padding: 14px 16px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          color: #f0ecff;
          box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04);
          animation: fg-slide-in 0.3s ease;
        }
        @keyframes fg-slide-in {
          from { opacity: 0; transform: translateX(20px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        #fg-warning-toast .fg-toast-header {
          display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
        }
        #fg-warning-toast .fg-toast-icon {
          width: 28px; height: 28px; flex-shrink: 0;
          background: rgba(249,115,22,0.15);
          border: 1px solid rgba(249,115,22,0.35);
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
        }
        #fg-warning-toast .fg-toast-title {
          font-size: 13px; font-weight: 600; flex: 1;
        }
        #fg-warning-toast .fg-toast-close {
          background: none; border: none; color: rgba(200,185,255,0.5);
          font-size: 16px; cursor: pointer; padding: 0; line-height: 1;
        }
        #fg-warning-toast .fg-toast-close:hover { color: #f0ecff; }
        #fg-warning-toast .fg-toast-body {
          font-size: 11px; color: rgba(200,185,255,0.75); margin-bottom: 10px; line-height: 1.5;
        }
        #fg-warning-toast .fg-toast-bar-track {
          height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; margin-bottom: 10px;
        }
        #fg-warning-toast .fg-toast-bar-fill {
          height: 100%; border-radius: 2px; background: #f97316;
          width: ${Math.min(100, pct)}%;
        }
        #fg-warning-toast .fg-toast-actions {
          display: flex; gap: 8px;
        }
        #fg-warning-toast .fg-btn {
          flex: 1; padding: 6px 0; border-radius: 8px; font-size: 11px; font-weight: 500;
          font-family: inherit; cursor: pointer; border: 1px solid;
          transition: background 0.15s;
        }
        #fg-warning-toast .fg-btn-dismiss {
          background: rgba(127,119,221,0.15); border-color: rgba(127,119,221,0.3); color: #c4b8f5;
        }
        #fg-warning-toast .fg-btn-dismiss:hover { background: rgba(127,119,221,0.28); }
        #fg-warning-toast .fg-btn-block {
          background: rgba(248,113,113,0.12); border-color: rgba(248,113,113,0.3); color: #fca5a5;
        }
        #fg-warning-toast .fg-btn-block:hover { background: rgba(248,113,113,0.22); }
        #fg-warning-toast .fg-btn-block.active {
          background: rgba(248,113,113,0.25); border-color: rgba(248,113,113,0.6); color: #f87171;
        }
      </style>
      <div class="fg-toast-header">
        <div class="fg-toast-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>
        <span class="fg-toast-title">Halfway through your limit</span>
        <button class="fg-toast-close" id="fg-toast-close-btn">×</button>
      </div>
      <div class="fg-toast-body">
        Used ${totalMin} of ${limitMin} min entertainment today. ${remaining} min remaining.
      </div>
      <div class="fg-toast-bar-track"><div class="fg-toast-bar-fill"></div></div>
      <div class="fg-toast-actions">
        <button class="fg-btn fg-btn-dismiss" id="fg-toast-dismiss">Got it</button>
        <button class="fg-btn fg-btn-block" id="fg-toast-block-btn">Block at 100%</button>
      </div>`;

    document.body.appendChild(toast);

    // Auto-dismiss after 12s
    const autoDismiss = setTimeout(() => toast.remove(), 12000);

    document.getElementById('fg-toast-close-btn').addEventListener('click', () => {
      clearTimeout(autoDismiss); toast.remove();
    });
    document.getElementById('fg-toast-dismiss').addEventListener('click', () => {
      clearTimeout(autoDismiss); toast.remove();
    });

    const blockBtn = document.getElementById('fg-toast-block-btn');

    // Reflect current block mode state
    chrome.storage.local.get('fg_block_mode').then(s => {
      if (s.fg_block_mode) blockBtn.classList.add('active');
      blockBtn.textContent = s.fg_block_mode ? 'Block mode: ON' : 'Block at 100%';
    }).catch(() => {});

    blockBtn.addEventListener('click', async () => {
      try {
        const s = await chrome.storage.local.get('fg_block_mode');
        const newVal = !s.fg_block_mode;
        await chrome.storage.local.set({ fg_block_mode: newVal });
        blockBtn.classList.toggle('active', newVal);
        blockBtn.textContent = newVal ? 'Block mode: ON' : 'Block at 100%';
      } catch { /* context gone */ }
    });
  }

  // Listen for block injection from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SHOW_BLOCK_OVERLAY') showBlockOverlay();
    if (msg.type === 'SHOW_WARNING_TOAST')  showWarningToast(msg.totalMin, msg.limitMin);
  });

  // ── SPA navigation detection ──────────────────────────────────────────────

  document.addEventListener('yt-navigate-finish', () => {
    if (!contextAlive()) { teardown(); return; }
    flushSession();
    classifyCurrentVideo();
    checkBlockOnLoad(); // re-apply overlay on SPA nav
  });

  classifyCurrentVideo();
  checkBlockOnLoad();

  window.addEventListener('beforeunload', () => {
    stopTimer();
    flushSession();
  });
})();
