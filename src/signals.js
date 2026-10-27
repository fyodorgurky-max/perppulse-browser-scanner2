export const DEFAULT_SETTINGS = Object.freeze({
  rsiPeriod: 14, volumeWindow: 20, zWindow: 100,
  rsiOversold: 30, rsiOverbought: 70,
  rsiBullConfirm: 50, rsiBearConfirm: 50,
  macdExtreme: 1.5, earlyRvol: 2, confirmRvol: 1.5,
  extremeWindow: 5, crossLookback: 4, minTurnover: 5_000_000
});

export const EMA_CROSS_PAIRS = Object.freeze([
  { id: '20/200', fast: 'ema20', slow: 'ema200' },
  { id: '10/200', fast: 'ema10', slow: 'ema200' },
  { id: '10/100', fast: 'ema10', slow: 'ema100' }
]);

export function evaluateSignals(candles, indicators, overrides = {}, marketMeta = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  const rows = indicators.rows ?? [];
  const i = rows.length - 1;
  if (i < 1 || candles.length !== rows.length || !candles[i]?.closed) return [];
  const now = rows[i];
  const result = [];
  const push = (type, side, row, pair = '', candlesAgo = 0) => {
    const { exchange = 'unknown', symbol = 'unknown', timeframe = '1m' } = marketMeta;
    result.push({
      id: [exchange, symbol, timeframe, type, pair || 'none', side, row.time].join(':'),
      exchange, symbol, timeframe, type, side, pair, candlesAgo, originTime: row.time,
      time: row.time, detectedAt: now.time, rvol: row.rvol, rsi: row.rsi,
      macdZ: row.macdZ, price: row.close
    });
  };

  const recent = rows.slice(-settings.extremeWindow);
  const previous = rows[i - 1];
  if (now.ema20 < now.ema200 && now.rvol >= settings.earlyRvol && now.hist > previous.hist &&
      recent.some(row => row.rsi <= settings.rsiOversold) &&
      recent.some(row => row.macdZ <= -settings.macdExtreme)) {
    push('early', 'long', now);
  }
  if (now.ema20 > now.ema200 && now.rvol >= settings.earlyRvol && now.hist < previous.hist &&
      recent.some(row => row.rsi >= settings.rsiOverbought) &&
      recent.some(row => row.macdZ >= settings.macdExtreme)) {
    push('early', 'short', now);
  }

  // Maximum age in *completed* bars, including the current bar at age zero.
  const maxAge = Math.max(0, Math.floor(Number(settings.crossLookback) || 0));
  const start = Math.max(1, i - maxAge);
  for (let k = i; k >= start; k--) {
    const before = rows[k - 1];
    const after = rows[k];
    if (!candles[k]?.closed || !candles[k - 1]?.closed || ![after.rsi, after.hist, after.rvol].every(Number.isFinite)) continue;
    if (after.rvol < settings.confirmRvol) continue;
    for (const pair of EMA_CROSS_PAIRS) {
      const earlierFast = before[pair.fast], earlierSlow = before[pair.slow];
      const crossingFast = after[pair.fast], crossingSlow = after[pair.slow];
      if (![earlierFast, earlierSlow, crossingFast, crossingSlow].every(Number.isFinite)) continue;
      if (earlierFast <= earlierSlow && crossingFast > crossingSlow && after.rsi >= settings.rsiBullConfirm && after.hist > 0) {
        push('confirmed', 'long', after, pair.id, i - k);
      }
      if (earlierFast >= earlierSlow && crossingFast < crossingSlow && after.rsi <= settings.rsiBearConfirm && after.hist < 0) {
        push('confirmed', 'short', after, pair.id, i - k);
      }
    }
  }
  return result;
}
