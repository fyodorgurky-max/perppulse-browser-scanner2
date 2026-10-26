import { DEFAULT_SETTINGS } from './signals.js';

const KEY = 'perp-pulse-settings-v1';
export function loadSettings(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage.getItem(KEY) || '{}');
    return { ...DEFAULT_SETTINGS, ...value };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(settings, storage = globalThis.localStorage) {
  try { storage.setItem(KEY, JSON.stringify(settings)); return true; }
  catch { return false; }
}
