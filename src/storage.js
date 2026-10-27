import { DEFAULT_SETTINGS } from './signals.js';

const KEY = 'perp-pulse-settings-v2';
const PREVIOUS_KEY = 'perp-pulse-settings-v1';
export function loadSettings(storage = globalThis.localStorage) {
  try {
    const current = storage.getItem(KEY);
    if (current !== null) return { ...DEFAULT_SETTINGS, ...JSON.parse(current) };
    const previous = JSON.parse(storage.getItem(PREVIOUS_KEY) || '{}');
    // v1 stored a window *length*; v2 stores inclusive maximum crossover age.
    return { ...DEFAULT_SETTINGS, ...previous, crossLookback: DEFAULT_SETTINGS.crossLookback };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(settings, storage = globalThis.localStorage) {
  try { storage.setItem(KEY, JSON.stringify(settings)); return true; }
  catch { return false; }
}
