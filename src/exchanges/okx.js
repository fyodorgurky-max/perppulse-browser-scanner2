import { INTERVAL_MS, normalizeCandles, openSocketGroups, requestJSON, requireAPI } from './common.js';

const BASE = 'https://www.okx.com';
const intervals = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H' };
export const okx = {
  id: 'okx',
  async listMarkets(fetchFn = fetch) {
    const [info, ticker] = await Promise.all([
      requestJSON(`${BASE}/api/v5/public/instruments?instType=SWAP`, fetchFn),
      requestJSON(`${BASE}/api/v5/market/tickers?instType=SWAP`, fetchFn)
    ]);
    requireAPI(info, 'code', 0);
    requireAPI(ticker, 'code', 0);
    const volumes = new Map((ticker.data ?? []).map(t => [t.instId, (Number(t.volCcy24h) || 0) * (Number(t.last) || 0)]));
    return (info.data ?? []).filter(s => s.instId?.endsWith('-USDT-SWAP') && s.state === 'live')
      .map(s => ({ exchange: 'okx', symbol: s.instId, turnover: volumes.get(s.instId) ?? 0 }));
  },
  async loadCandles(fetchFn = fetch, symbol, timeframe, limit = 500, now = Date.now()) {
    if (!INTERVAL_MS[timeframe]) throw new Error('Unsupported timeframe');
    const records = [];
    let cursor = '';
    while (records.length < limit) {
      const batchLimit = Math.min(300, limit - records.length);
      const url = `${BASE}/api/v5/market/candles?instId=${encodeURIComponent(symbol)}&bar=${intervals[timeframe]}&limit=${batchLimit}${cursor ? `&after=${cursor}` : ''}`;
      const data = requireAPI(await requestJSON(url, fetchFn), 'code', 0);
      const batch = data.data ?? [];
      if (!batch.length) break;
      records.push(...batch);
      const oldest = Math.min(...batch.map(r => Number(r[0])));
      if (String(oldest) === cursor || batch.length < batchLimit) break;
      cursor = String(oldest);
    }
    return normalizeCandles(records.map(r => ({
      time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[6],
      closed: r[8] === '1' && Number(r[0]) + INTERVAL_MS[timeframe] <= now
    })));
  },
  connectMinutes(symbols, onClosedCandle, onStatus, wsFactory) {
    return openSocketGroups(symbols, 30, () => 'wss://ws.okx.com:8443/ws/v5/business',
      group => ({ op: 'subscribe', args: group.map(s => ({ channel: 'candle1m', instId: s })) }),
      message => {
        if (message.arg?.channel !== 'candle1m') return;
        for (const k of message.data ?? []) {
          if (k[8] !== '1') continue;
          const bar = normalizeCandles([{ time: k[0], open: k[1], high: k[2], low: k[3], close: k[4], volume: k[6], closed: true }])[0];
          if (bar) onClosedCandle(message.arg.instId, bar);
        }
      }, onStatus, wsFactory);
  }
};
