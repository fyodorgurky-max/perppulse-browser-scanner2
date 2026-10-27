import { binance } from './exchanges/binance.js';
import { bybit } from './exchanges/bybit.js';
import { okx } from './exchanges/okx.js';
import { createScanner } from './scanner.js';
import { loadSettings, saveSettings } from './storage.js';
import { renderDashboard, serializeSignalsCSV, updateAlertUI } from './ui.js';

const root = document.querySelector('#app');
const adapters = [binance, bybit, okx];
let settings = loadSettings();
let scanner;
let generation = 0;
let notificationsEnabled = false;
let soundEnabled = false;
let renderQueued = false;
let currentState = {
  running: false, eligible: 0, ready: 0, failed: 0, stale: 0, queued: 0,
  providers: {}, signals: [], settings
};

function draw(state = currentState) {
  currentState = state;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderDashboard(root, currentState, dispatch);
    updateAlertUI(root, { notifications: notificationsEnabled, sound: soundEnabled });
  });
}

function playTone() {
  if (!soundEnabled) return;
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    const context = new Audio();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(720, context.currentTime);
    oscillator.frequency.setValueAtTime(960, context.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.06, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.24);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.26);
    oscillator.onended = () => void context.close();
  } catch { /* Browsers can suppress background audio. */ }
}

function notify(signal) {
  if (signal.source !== 'live') return;
  if (notificationsEnabled && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const label = signal.type === 'early' ? 'Early reversal warning' : `EMA ${signal.pair} crossover`;
      const notification = new Notification(`${signal.side.toUpperCase()} · ${signal.symbol}`, {
        body: `${label} on ${signal.exchange.toUpperCase()} · ${signal.timeframe} · RVOL ${signal.rvol.toFixed(1)}x`,
        tag: signal.id
      });
      notification.onclick = () => { window.focus(); notification.close(); };
    } catch { /* Permissions or device policy may prevent notifications. */ }
  }
  playTone();
}

function newScanner() {
  const thisGeneration = ++generation;
  scanner = createScanner({
    adapters, settings, delayMs: 700,
    onState: state => { if (generation === thisGeneration) draw(state); },
    onSignal: signal => { if (generation === thisGeneration) notify(signal); }
  });
  draw(scanner.snapshot());
}

function exportCSV(signals) {
  if (!signals?.length) return;
  const blob = new Blob(['\uFEFF', serializeSignalsCSV(signals)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `perppulse-signals-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function dispatch(action, payload) {
  if (action === 'start') {
    try {
      scanner.stop();
      newScanner();
      await scanner.start();
    }
    catch (error) { console.error('Scanner initialization failed', error); }
  } else if (action === 'stop') {
    scanner.stop();
  } else if (action === 'notification') {
    if (notificationsEnabled) notificationsEnabled = false;
    else if ('Notification' in window && window.isSecureContext) {
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      notificationsEnabled = permission === 'granted';
    } else window.alert('Browser notifications require HTTPS and a compatible browser. The scanner still works without them.');
    updateAlertUI(root, { notifications: notificationsEnabled, sound: soundEnabled });
  } else if (action === 'sound') {
    soundEnabled = !soundEnabled;
    updateAlertUI(root, { notifications: notificationsEnabled, sound: soundEnabled });
  } else if (action === 'export') {
    exportCSV(payload);
  } else if (action === 'settings') {
    const minTurnoverChanged = payload.minTurnover !== undefined && payload.minTurnover !== settings.minTurnover;
    settings = { ...settings, ...payload };
    saveSettings(settings);
    if (minTurnoverChanged) {
      const wasRunning = scanner.snapshot().running;
      scanner.stop();
      newScanner();
      if (wasRunning) void scanner.start();
    } else scanner.updateSettings(payload);
  }
}

newScanner();
