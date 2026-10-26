export function computeIndicators(candles, settings = {}) {
  const fastPeriod = settings.emaFast ?? 20;
  const slowPeriod = settings.emaSlow ?? 200;
  const rsiPeriod = settings.rsiPeriod ?? 14;
  const volumeWindow = settings.volumeWindow ?? 20;
  const zWindow = settings.zWindow ?? 100;
  const rows = [];
  let emaFast, emaSlow, macdFast, macdSlow, macdSignal;
  let avgGain = 0, avgLoss = 0;
  const histValues = [];
  const volumes = [];

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const close = Number(bar.close);
    const volume = Number(bar.volume);
    const ema = (value, previous, period) => previous === undefined ? value : previous + (2 / (period + 1)) * (value - previous);
    emaFast = ema(close, emaFast, fastPeriod);
    emaSlow = ema(close, emaSlow, slowPeriod);
    macdFast = ema(close, macdFast, 12);
    macdSlow = ema(close, macdSlow, 26);
    const macd = macdFast - macdSlow;
    macdSignal = ema(macd, macdSignal, 9);
    const hist = macd - macdSignal;

    let rsi = NaN;
    if (i > 0) {
      const change = close - Number(candles[i - 1].close);
      const gain = Math.max(0, change);
      const loss = Math.max(0, -change);
      if (i <= rsiPeriod) {
        avgGain += gain;
        avgLoss += loss;
        if (i === rsiPeriod) {
          avgGain /= rsiPeriod;
          avgLoss /= rsiPeriod;
        }
      } else {
        avgGain = (avgGain * (rsiPeriod - 1) + gain) / rsiPeriod;
        avgLoss = (avgLoss * (rsiPeriod - 1) + loss) / rsiPeriod;
      }
      if (i >= rsiPeriod) {
        rsi = avgGain === 0 && avgLoss === 0 ? 50 : avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    }

    let rvol = NaN;
    if (volumes.length >= volumeWindow) {
      const previous = volumes.slice(-volumeWindow);
      const mean = previous.reduce((sum, v) => sum + v, 0) / volumeWindow;
      if (mean > 0) rvol = volume / mean;
    }
    volumes.push(volume);

    let macdZ = NaN;
    if (histValues.length >= zWindow && i >= 35) {
      const previous = histValues.slice(-zWindow);
      const mean = previous.reduce((sum, h) => sum + h, 0) / zWindow;
      const sd = Math.sqrt(previous.reduce((sum, h) => sum + (h - mean) ** 2, 0) / zWindow);
      if (sd > 0) macdZ = (hist - mean) / sd;
    }
    histValues.push(hist);

    rows.push({
      time: bar.time, close,
      ema20: i >= fastPeriod - 1 ? emaFast : NaN,
      ema200: i >= slowPeriod - 1 ? emaSlow : NaN,
      rsi, macd, macdSignal,
      hist: i >= 34 ? hist : NaN,
      macdZ,
      rvol
    });
  }
  return { rows };
}
