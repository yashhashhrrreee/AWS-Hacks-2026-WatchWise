// auth.js — auth utilities used by popup.js

const API_BASE = 'https://d85j77xztl.execute-api.us-east-2.amazonaws.com';

export async function signup(email, password) {
  const res = await fetch(`${API_BASE}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Signup failed');
  return data; // { token, userId }
}

export async function login(email, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Login failed');
  return data; // { token, userId }
}

export async function saveSession(token, userId) {
  return new Promise(resolve => {
    chrome.storage.local.set({ fg_token: token, fg_userId: userId }, resolve);
  });
}

export async function clearSession() {
  return new Promise(resolve => {
    chrome.storage.local.remove(['fg_token', 'fg_userId', 'fg_pending_alert'], resolve);
  });
}

export async function getSession() {
  return new Promise(resolve => {
    chrome.storage.local.get(['fg_token', 'fg_userId'], r => resolve(r));
  });
}
