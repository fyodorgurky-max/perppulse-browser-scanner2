import { INTERVAL_MS, normalizeCandles, openSocketGroups, requestJSON } from './common.js';

const BASE = 'https://fapi.binance.com';
export const binance = {
  id: 'binance',
  async listMarkets(fetchFn = fetch) {
    const [info, tickers] = await Promise.all([
      requestJSON(`${BASE}/fapi/v1/exchangeInfo`, fetchFn),
      requestJSON(`${BASE}/fapi/v1/ticker/24hr`, fetchFn)
    ]);
    const volumes = new Map(tickers.map(t => [t.symbol, Number(t.quoteVolume) || 0]));
    return (info.symbols ?? []).filter(s => s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL' && s.status === 'TRADING')
      .map(s => ({ exchange: 'binance', symbol: s.symbol, turnover: volumes.get(s.symbol) ?? 0 }));
  },
  async loadCandles(fetchFn = fetch, symbol, timeframe, limit = 500, now = Date.now()) {
    const interval = timeframe;
    if (!INTERVAL_MS[interval]) throw new Error('Unsupported timeframe');
    const data = await requestJSON(`${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${Math.min(limit, 1500)}`, fetchFn);
    return normalizeCandles(data.map(r => ({
      time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5],
      closed: Number(r[6]) < now
    })));
  },
  connectMinutes(symbols, onClosedCandle, onStatus, wsFactory) {
    return openSocketGroups(symbols, 60,
      group => `wss://fstream.binance.com/stream?streams=${group.map(s => `${s.toLowerCase()}@kline_1m`).join('/')}`,
      null,
      message => {
        const k = (message.data ?? message).k;
        if (!k?.x) return;
        const bar = normalizeCandles([{ time: k.t, open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v, closed: true }])[0];
        if (bar) onClosedCandle(k.s, bar);
      }, onStatus, wsFactory);
  }
};
