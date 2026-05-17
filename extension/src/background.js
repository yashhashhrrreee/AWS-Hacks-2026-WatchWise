// background.js — MV3 service worker
// Handles: classification API calls, session writes, WebSocket connection,
//          incoming alert notifications from stream-processor Lambda

// ── Config (replace with your actual endpoints after deploy) ─────────────────
const API_BASE = 'https://d85j77xztl.execute-api.us-east-2.amazonaws.com';
const WS_URL   = 'wss://japbfh6ltj.execute-api.us-east-2.amazonaws.com/prod';

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function getToken() {
  return new Promise(resolve => {
    chrome.storage.local.get(['fg_token'], r => resolve(r.fg_token || null));
  });
}

async function getUserId() {
  return new Promise(resolve => {
    chrome.storage.local.get(['fg_userId'], r => resolve(r.fg_userId || null));
  });
}

// ── WebSocket management ──────────────────────────────────────────────────────

let ws = null;
let wsReconnectTimeout = null;

async function connectWebSocket() {
  const token = await getToken();
  if (!token) return; // not logged in

  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket(`${WS_URL}?token=${token}`);

  ws.onopen = () => {
    console.log('[FocusGuard] WebSocket connected');
    clearTimeout(wsReconnectTimeout);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.alert) handleAlert(data.alert, data.totalSeconds, data.limitSeconds);
    } catch (e) {
      console.warn('[FocusGuard] WS message parse error', e);
    }
  };

  ws.onclose = () => {
    console.log('[FocusGuard] WebSocket closed, reconnecting in 5s...');
    wsReconnectTimeout = setTimeout(connectWebSocket, 5000);
  };

  ws.onerror = (err) => {
    console.error('[FocusGuard] WebSocket error', err);
    ws.close();
  };
}

function handleAlert(alertType, totalSeconds, limitSeconds) {
  const totalMin = Math.round(totalSeconds / 60);
  const limitMin = Math.round(limitSeconds / 60);

  if (alertType === '50%') {
    showAlertPopup({
      level: 'warning',
      title: '⏰ Halfway Through Your Limit',
      message: `You've used ${totalMin} of ${limitMin} minutes of non-academic video time today.`,
    });
  } else if (alertType === '100%') {
    showAlertPopup({
      level: 'hard',
      title: '🚨 Daily Limit Reached',
      message: `You've hit your ${limitMin}-minute daily limit for non-academic videos.`,
    });
  }
}

function showAlertPopup(data) {
  // Store alert so popup.js can display it
  chrome.storage.local.set({ fg_pending_alert: data });

  // Chrome notification as fallback
  chrome.notifications?.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: data.title,
    message: data.message,
    priority: 2,
  });

  // Open the extension popup programmatically if possible
  // (MV3 limitation: can only open popup via user gesture, so we rely on notification)
}

// ── Classification ────────────────────────────────────────────────────────────

async function classifyVideo(payload) {
  const token = await getToken();
  if (!token) {
    console.warn('[FocusGuard] classifyVideo: no token, defaulting to educational');
    return { educational: true };
  }

  console.log('[FocusGuard] classifyVideo POST /classify', payload);

  try {
    const res = await fetch(`${API_BASE}/classify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    console.log('[FocusGuard] /classify response:', res.status, data);
    return data;
  } catch (e) {
    console.error('[FocusGuard] Classify error', e);
    return { educational: true };
  }
}

// ── Session flush ─────────────────────────────────────────────────────────────

async function flushSession(payload) {
  const token = await getToken();
  const userId = await getUserId();
  console.log('[FocusGuard] flushSession called', { hasToken: !!token, userId, payload });
  if (!token || !userId) {
    console.warn('[FocusGuard] flushSession aborting — missing token or userId');
    return;
  }

  const body = { ...payload, userId };
  console.log('[FocusGuard] POST /session body:', body);

  try {
    const res = await fetch(`${API_BASE}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log('[FocusGuard] /session response:', res.status, text);
  } catch (e) {
    console.error('[FocusGuard] Session flush error', e);
  }
}

// ── Message listener (from content.js) ───────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CLASSIFY_VIDEO') {
    classifyVideo(message.payload).then(result => sendResponse(result));
    return true; // async response
  }

  if (message.type === 'FLUSH_SESSION') {
    flushSession(message.payload);
    return false;
  }

  if (message.type === 'AUTH_SUCCESS') {
    // Called by popup after login/signup
    connectWebSocket();
    return false;
  }

  if (message.type === 'LOGOUT') {
    ws?.close();
    ws = null;
    return false;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(connectWebSocket);
chrome.runtime.onInstalled.addListener(connectWebSocket);

// Reconnect WebSocket when service worker wakes
connectWebSocket();
