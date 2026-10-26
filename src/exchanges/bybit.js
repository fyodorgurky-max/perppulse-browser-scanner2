import { INTERVAL_MS, normalizeCandles, openSocketGroups, requestJSON, requireAPI } from './common.js';

const BASE = 'https://api.bybit.com';
const intervals = { '1m': '1', '5m': '5', '15m': '15' };

export const bybit = {
  id: 'bybit',
  async listMarkets(fetchFn = fetch) {
    const instruments = [];
    let cursor = '';
    do {
      const url = `${BASE}/v5/market/instruments-info?category=linear&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const data = requireAPI(await requestJSON(url, fetchFn), 'retCode', 0);
      instruments.push(...(data.result?.list ?? []));
      cursor = data.result?.nextPageCursor ?? '';
    } while (cursor);
    const ticker = requireAPI(await requestJSON(`${BASE}/v5/market/tickers?category=linear`, fetchFn), 'retCode', 0);
    const volumes = new Map((ticker.result?.list ?? []).map(t => [t.symbol, Number(t.turnover24h) || 0]));
    return instruments.filter(s => s.contractType === 'LinearPerpetual' && s.status === 'Trading' && s.quoteCoin === 'USDT')
      .map(s => ({ exchange: 'bybit', symbol: s.symbol, turnover: volumes.get(s.symbol) ?? 0 }));
  },
  async loadCandles(fetchFn = fetch, symbol, timeframe, limit = 500, now = Date.now()) {
    if (!INTERVAL_MS[timeframe]) throw new Error('Unsupported timeframe');
    const data = requireAPI(await requestJSON(`${BASE}/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=${intervals[timeframe]}&limit=${Math.min(limit, 1000)}`, fetchFn), 'retCode', 0);
    return normalizeCandles((data.result?.list ?? []).map(r => ({
      time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5],
      closed: Number(r[0]) + INTERVAL_MS[timeframe] <= now
    })));
  },
  connectMinutes(symbols, onClosedCandle, onStatus, wsFactory) {
    return openSocketGroups(symbols, 30, () => 'wss://stream.bybit.com/v5/public/linear',
      group => ({ op: 'subscribe', args: group.map(s => `kline.1.${s}`) }),
      message => {
        if (!message.topic?.startsWith('kline.1.')) return;
        const symbol = message.topic.slice('kline.1.'.length);
        for (const k of message.data ?? []) {
          if (!k.confirm) continue;
          const bar = normalizeCandles([{ time: k.start, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume, closed: true }])[0];
          if (bar) onClosedCandle(symbol, bar);
        }
      }, onStatus, wsFactory);
  }
};
