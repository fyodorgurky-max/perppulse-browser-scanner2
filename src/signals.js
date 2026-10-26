export const DEFAULT_SETTINGS = Object.freeze({
  emaFast: 20, emaSlow: 200, rsiPeriod: 14, volumeWindow: 20, zWindow: 100,
  rsiOversold: 30, rsiOverbought: 70,
  rsiBullConfirm: 50, rsiBearConfirm: 50,
  macdExtreme: 1.5, earlyRvol: 2, confirmRvol: 1.5,
  extremeWindow: 5, crossLookback: 3, minTurnover: 5_000_000
});

export function evaluateSignals(candles, indicators, overrides = {}, marketMeta = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  const rows = indicators.rows ?? [];
  const i = rows.length - 1;
  if (i < 1 || candles.length !== rows.length || !candles[i]?.closed) return [];
  const now = rows[i];
  if (![now.ema20, now.ema200, now.rsi, now.hist, now.rvol].every(Number.isFinite)) return [];
  const result = [];
  const push = (type, side, originTime, originRvol = now.rvol) => {
    const { exchange = 'unknown', symbol = 'unknown', timeframe = '1m' } = marketMeta;
    result.push({
      id: [exchange, symbol, timeframe, type, side, originTime].join(':'),
      exchange, symbol, timeframe, type, side, originTime,
      time: now.time, rvol: originRvol, rsi: now.rsi,
      macdZ: now.macdZ, price: now.close
    });
  };

  const recent = rows.slice(-settings.extremeWindow);
  const previous = rows[i - 1];
  if (now.ema20 < now.ema200 && now.rvol >= settings.earlyRvol && now.hist > previous.hist &&
      recent.some(row => row.rsi <= settings.rsiOversold) &&
      recent.some(row => row.macdZ <= -settings.macdExtreme)) {
    push('early', 'long', now.time);
  }
  if (now.ema20 > now.ema200 && now.rvol >= settings.earlyRvol && now.hist < previous.hist &&
      recent.some(row => row.rsi >= settings.rsiOverbought) &&
      recent.some(row => row.macdZ >= settings.macdExtreme)) {
    push('early', 'short', now.time);
  }

  const start = Math.max(1, i - settings.crossLookback + 1);
  for (let k = i; k >= start; k--) {
    const before = rows[k - 1];
    const after = rows[k];
    if (![before.ema20, before.ema200, after.ema20, after.ema200, after.rvol].every(Number.isFinite)) continue;
    if (after.rvol < settings.confirmRvol) continue;
    if (before.ema20 <= before.ema200 && after.ema20 > after.ema200 && now.rsi >= settings.rsiBullConfirm && now.hist > 0) {
      push('confirmed', 'long', after.time, after.rvol);
      break;
    }
    if (before.ema20 >= before.ema200 && after.ema20 < after.ema200 && now.rsi <= settings.rsiBearConfirm && now.hist < 0) {
      push('confirmed', 'short', after.time, after.rvol);
      break;
    }
  }
  return result;
}
