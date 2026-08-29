// Where the user's own provider API keys live.
//
// Keys stay on the device: nothing is ever sent to Supabase or to this app's
// servers. Two scopes, chosen per provider in the UI:
//   'device'  localStorage — survives reloads and restarts (default; a run can
//             be resumed tomorrow without re-typing the key)
//   'session' sessionStorage — cleared when the tab closes (shared computers)
//
// The generator reads the key once when a run starts and keeps it in memory for
// the duration of that run.

import { DEFAULT_PROVIDER_ID, getProvider, PROVIDER_IDS } from './providers.js';

const STORAGE_KEY = 'duocards.aiCredentials';
const PREFS_KEY = 'duocards.aiBuilderPrefs';

function storageFor(scope) {
  if (typeof window === 'undefined') return null;
  return scope === 'session' ? window.sessionStorage : window.localStorage;
}

function readBlob(scope) {
  try {
    const raw = storageFor(scope)?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeBlob(scope, blob) {
  try {
    const store = storageFor(scope);
    if (!store) return;
    if (Object.keys(blob).length === 0) store.removeItem(STORAGE_KEY);
    else store.setItem(STORAGE_KEY, JSON.stringify(blob));
  } catch {
    /* private mode / quota — the key simply isn't remembered */
  }
}

function normalizeCredential(providerId, stored) {
  const provider = getProvider(providerId);
  return {
    providerId: provider.id,
    apiKey: String(stored?.apiKey ?? ''),
    model: String(stored?.model ?? '') || provider.defaultModel,
    baseUrl: String(stored?.baseUrl ?? '') || provider.baseUrl,
    // Providers that cannot be called from a page are always relayed.
    useProxy: provider.direct ? Boolean(stored?.useProxy) : true,
    scope: stored?.scope === 'session' ? 'session' : 'device',
    updatedAt: stored?.updatedAt ?? null,
  };
}

// -> { [providerId]: credential } for every provider, filled in from whichever
// scope holds a key (session wins — it is the more deliberate choice).
export function loadCredentials() {
  const device = readBlob('device');
  const session = readBlob('session');
  const credentials = {};
  for (const providerId of PROVIDER_IDS) {
    const stored = session[providerId]
      ? { ...session[providerId], scope: 'session' }
      : device[providerId]
        ? { ...device[providerId], scope: 'device' }
        : null;
    credentials[providerId] = normalizeCredential(providerId, stored);
  }
  return credentials;
}

export function loadCredential(providerId) {
  return loadCredentials()[providerId] ?? normalizeCredential(providerId, null);
}

export function saveCredential(credential) {
  const next = normalizeCredential(credential.providerId, credential);
  next.updatedAt = new Date().toISOString();
  // A provider lives in exactly one scope: drop it from the other one first.
  const other = next.scope === 'session' ? 'device' : 'session';
  const otherBlob = readBlob(other);
  if (otherBlob[next.providerId]) {
    delete otherBlob[next.providerId];
    writeBlob(other, otherBlob);
  }
  const blob = readBlob(next.scope);
  if (next.apiKey) {
    blob[next.providerId] = next;
  } else {
    delete blob[next.providerId];
  }
  writeBlob(next.scope, blob);
  return next;
}

export function clearCredential(providerId) {
  for (const scope of ['device', 'session']) {
    const blob = readBlob(scope);
    if (blob[providerId]) {
      delete blob[providerId];
      writeBlob(scope, blob);
    }
  }
}

// Builder preferences that are not secrets (last provider used, last run size).
export function loadBuilderPrefs() {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      providerId: PROVIDER_IDS.includes(parsed?.providerId) ? parsed.providerId : DEFAULT_PROVIDER_ID,
      concurrency: Number(parsed?.concurrency) || 3,
    };
  } catch {
    return { providerId: DEFAULT_PROVIDER_ID, concurrency: 3 };
  }
}

export function saveBuilderPrefs(prefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* non-fatal */
  }
}
