// content.js — injected on youtube.com/watch pages
// Responsible for:
//   1. Extracting video metadata (title, description, creator)
//   2. Sending to background for classification
//   3. Running a local timer if non-educational
//   4. Flushing session to background when video stops

(() => {
  let currentVideoId = null;
  let isNonEducational = false;
  let timerInterval = null;
  let sessionSeconds = 0;
  let videoPlaying = false;

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

  function startTimer() {
    if (timerInterval) return;
    timerInterval = setInterval(() => {
      sessionSeconds++;
    }, 1000);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function flushSession() {
    if (!isNonEducational || sessionSeconds < 1) return;

    const meta = getMetadata();
    chrome.runtime.sendMessage({
      type: 'FLUSH_SESSION',
      payload: {
        videoId: currentVideoId,
        videoTitle: meta.title,
        videoCreator: meta.creator,
        durationSeconds: sessionSeconds,
      }
    });

    sessionSeconds = 0;
  }

  // ── Video event binding ───────────────────────────────────────────────────

  function bindVideoEvents(video) {
    video.addEventListener('play', () => {
      if (isNonEducational) startTimer();
      videoPlaying = true;
    });

    video.addEventListener('pause', () => {
      stopTimer();
      videoPlaying = false;
      flushSession();
    });

    video.addEventListener('ended', () => {
      stopTimer();
      videoPlaying = false;
      flushSession();
    });
  }

  // ── Classification ────────────────────────────────────────────────────────

  async function classifyCurrentVideo() {
    const videoId = getVideoId();
    if (!videoId || videoId === currentVideoId) return;

    currentVideoId = videoId;
    isNonEducational = false;
    stopTimer();
    sessionSeconds = 0;

    // Wait a moment for YouTube's DOM to populate metadata
    await new Promise(r => setTimeout(r, 2000));

    const meta = getMetadata();
    if (!meta.title) return;

    chrome.runtime.sendMessage(
      {
        type: 'CLASSIFY_VIDEO',
        payload: meta
      },
      (response) => {
        if (chrome.runtime.lastError) return;
        if (response && response.educational === false) {
          isNonEducational = true;
          const video = getVideoElement();
          if (video && !video.paused) startTimer();
        }
      }
    );

    // Bind events (safe to call multiple times, events won't double-fire
    // because we replace the video element on navigation)
    const video = getVideoElement();
    if (video) bindVideoEvents(video);
  }

  // ── SPA navigation detection ──────────────────────────────────────────────
  // YouTube is a SPA; we watch for URL changes via yt-navigate-finish

  document.addEventListener('yt-navigate-finish', () => {
    flushSession(); // flush previous if any
    classifyCurrentVideo();
  });

  // Initial load
  classifyCurrentVideo();

  // Flush on tab close / navigation away
  window.addEventListener('beforeunload', () => {
    stopTimer();
    flushSession();
  });
})();
