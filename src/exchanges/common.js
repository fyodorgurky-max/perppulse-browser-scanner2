export const INTERVAL_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000 };

export async function requestJSON(url, fetchFn = fetch) {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status ?? 'network error'} at ${new URL(url).host}`);
  try { return await response.json(); }
  catch { throw new Error(`Invalid JSON market-data response from ${new URL(url).host}; provider may be blocked`); }
}

export function normalizeCandles(records) {
  const byTime = new Map();
  for (const record of records ?? []) {
    if (!record.closed) continue;
    const candle = {
      time: Number(record.time), open: Number(record.open), high: Number(record.high),
      low: Number(record.low), close: Number(record.close), volume: Number(record.volume), closed: true
    };
    if (![candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) continue;
    if (candle.volume < 0 || candle.low > candle.high || candle.open <= 0 || candle.close <= 0) continue;
    byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function requireAPI(data, codeField, okValue) {
  if (String(data?.[codeField]) !== String(okValue)) {
    throw new Error(data?.retMsg || data?.msg || 'Exchange API error');
  }
  return data;
}

export function openSocketGroups(symbols, groupSize, makeURL, subscribe, onMessage, onStatus, wsFactory = url => new WebSocket(url)) {
  const sockets = [];
  for (let i = 0; i < symbols.length; i += groupSize) {
    const group = symbols.slice(i, i + groupSize);
    const socket = wsFactory(makeURL(group));
    socket.onopen = () => {
      onStatus?.({ status: 'connected', symbols: group });
      if (subscribe) socket.send(JSON.stringify(subscribe(group)));
    };
    socket.onmessage = event => {
      try { onMessage(JSON.parse(event.data)); }
      catch (error) { onStatus?.({ status: 'error', error: error.message, symbols: group }); }
    };
    socket.onerror = () => onStatus?.({ status: 'error', error: 'WebSocket network failure', symbols: group });
    socket.onclose = () => onStatus?.({ status: 'disconnected', symbols: group });
    sockets.push(socket);
  }
  return { close() { for (const socket of sockets) { socket.onclose = null; socket.close(); } } };
}
