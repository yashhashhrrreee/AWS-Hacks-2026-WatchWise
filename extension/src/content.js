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
    try {
      chrome.storage.local.set({
        fg_live_session: {
          seconds: sessionSeconds,
          playing: !!timerInterval,
          eduSeconds: eduSessionSeconds,
          eduPlaying: !!eduTimerInterval,
          ts: Date.now()
        }
      });
    } catch { teardown(); }
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
        });
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
        });
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

  // ── SPA navigation detection ──────────────────────────────────────────────

  document.addEventListener('yt-navigate-finish', () => {
    if (!contextAlive()) { teardown(); return; }
    flushSession();
    classifyCurrentVideo();
  });

  classifyCurrentVideo();

  window.addEventListener('beforeunload', () => {
    stopTimer();
    flushSession();
  });
})();
