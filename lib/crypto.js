'use client';

const ALG = { name: 'AES-GCM', length: 256 };
const SESSION_KEY = '_wtfx_ek';

export async function getSessionKey() {
  if (typeof window === 'undefined') return null;
  const stored = sessionStorage.getItem(SESSION_KEY);
  if (stored) {
    try {
      const jwk = JSON.parse(atob(stored));
      return await crypto.subtle.importKey('jwk', jwk, ALG, true, ['encrypt', 'decrypt']);
    } catch { /* fall through to generate new key */ }
  }
  const key = await crypto.subtle.generateKey(ALG, true, ['encrypt', 'decrypt']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  sessionStorage.setItem(SESSION_KEY, btoa(JSON.stringify(jwk)));
  return key;
}

export async function encryptValue(plaintext) {
  const key = await getSessionKey();
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(String(plaintext))
  );
  return { iv: Array.from(iv), ct: Array.from(new Uint8Array(enc)) };
}

export async function decryptValue(payload) {
  if (!payload || typeof payload !== 'object' || !payload.iv || !payload.ct) return '';
  const key = await getSessionKey();
  const dec = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(payload.iv) },
    key,
    new Uint8Array(payload.ct)
  );
  return new TextDecoder().decode(dec);
}

// Encrypt all fields of a credentials object
export async function encryptCredentials(creds) {
  const out = {};
  for (const [k, v] of Object.entries(creds)) {
    if (v && typeof v === 'string') {
      out[k] = await encryptValue(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Decrypt all fields back to plaintext
export async function decryptCredentials(encrypted) {
  const out = {};
  for (const [k, v] of Object.entries(encrypted)) {
    if (v && typeof v === 'object' && v.iv && v.ct) {
      try { out[k] = await decryptValue(v); }
      catch { out[k] = ''; }
    } else {
      out[k] = v ?? '';
    }
  }
  return out;
}

// Returns true if a field value is an encrypted payload object
export function isEncrypted(v) {
  return v && typeof v === 'object' && Array.isArray(v.iv) && Array.isArray(v.ct);
}

const CREDS_KEY = 'wtfx_pub_configs_enc';

export async function saveEncryptedConfig(platformId, creds) {
  const all = loadRawConfigs();
  all[platformId] = await encryptCredentials(creds);
  localStorage.setItem(CREDS_KEY, JSON.stringify(all));
}

export function loadRawConfigs() {
  try { return JSON.parse(localStorage.getItem(CREDS_KEY) || '{}'); }
  catch { return {}; }
}

export async function loadDecryptedConfig(platformId) {
  const all = loadRawConfigs();
  const raw = all[platformId];
  if (!raw) return {};
  return decryptCredentials(raw);
}

export async function loadAllDecryptedConfigs() {
  const all = loadRawConfigs();
  const out = {};
  for (const id of Object.keys(all)) {
    out[id] = await decryptCredentials(all[id]);
  }
  return out;
}

export function deleteConfig(platformId) {
  const all = loadRawConfigs();
  delete all[platformId];
  localStorage.setItem(CREDS_KEY, JSON.stringify(all));
}

export function hasConfig(platformId) {
  const all = loadRawConfigs();
  return !!all[platformId];
}
