/** Closed-bar, locally calculated context indicators (not copies of community Pine scripts). */
export function analyzeTradeIndicators(candles = []) {
  const closed = candles.filter(bar => bar.closed && [bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite));
  const rows = [];
  let ema50;
  let atr = NaN;
  let atrSeed = 0;
  let trendAtr = NaN;
  let trendAtrSeed = 0;
  let finalUpper = NaN;
  let finalLower = NaN;
  let trend = 0;
  let vwapDay = NaN, volumeSum = 0, weightedSum = 0;
  const volumes = [];

  for (let i = 0; i < closed.length; i++) {
    const bar = closed[i];
    const previous = closed[i - 1];
    ema50 = ema50 === undefined ? bar.close : ema50 + (2 / 51) * (bar.close - ema50);
    const tr = previous ? Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close)) : bar.high - bar.low;
    if (i < 14) {
      atrSeed += tr;
      if (i === 13) atr = atrSeed / 14;
    } else atr = ((atr * 13) + tr) / 14;
    if (i < 10) {
      trendAtrSeed += tr;
      if (i === 9) trendAtr = trendAtrSeed / 10;
    } else trendAtr = ((trendAtr * 9) + tr) / 10;

    const day = Math.floor(bar.time / 86_400_000);
    if (day !== vwapDay) { vwapDay = day; volumeSum = 0; weightedSum = 0; }
    volumeSum += bar.volume;
    weightedSum += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
    const vwap = volumeSum > 0 ? weightedSum / volumeSum : NaN;

    let rvol = NaN;
    if (volumes.length >= 20) {
      const mean = volumes.slice(-20).reduce((s, v) => s + v, 0) / 20;
      if (mean > 0) rvol = bar.volume / mean;
    }
    volumes.push(bar.volume);

    let supertrend = NaN;
    if (Number.isFinite(trendAtr)) {
      const middle = (bar.high + bar.low) / 2;
      const basicUpper = middle + 3 * trendAtr;
      const basicLower = middle - 3 * trendAtr;
      if (!Number.isFinite(finalUpper)) {
        finalUpper = basicUpper;
        finalLower = basicLower;
        trend = bar.close >= middle ? 1 : -1;
      } else {
        const prevFinalUpper = finalUpper;
        const prevFinalLower = finalLower;
        const previousClose = previous?.close ?? bar.close;
        finalUpper = basicUpper < prevFinalUpper || previousClose > prevFinalUpper ? basicUpper : prevFinalUpper;
        finalLower = basicLower > prevFinalLower || previousClose < prevFinalLower ? basicLower : prevFinalLower;
        if (trend === -1 && bar.close > prevFinalUpper) trend = 1;
        else if (trend === 1 && bar.close < prevFinalLower) trend = -1;
      }
      supertrend = trend === 1 ? finalLower : finalUpper;
    }

    rows.push({ ...bar, atr, ema50: i >= 49 ? ema50 : NaN, vwap, rvol,
      supertrend, supertrendDirection: trend === 1 ? 'bullish' : trend === -1 ? 'bearish' : 'unavailable' });
  }
  return { rows, latest: rows.at(-1) ?? null };
}
