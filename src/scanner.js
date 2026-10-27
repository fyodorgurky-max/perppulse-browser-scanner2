import { computeIndicators } from './indicators.js';
import { DEFAULT_SETTINGS, evaluateSignals } from './signals.js';
import { INTERVAL_MS, normalizeCandles } from './exchanges/common.js';
import { assessTradeSetup } from './trade-setup.js';

const FRAMES = ['1m', '5m', '15m'];
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const keyFor = (exchange, symbol) => `${exchange}:${symbol}`;

export function buildHigherTimeframes(minutes, timeframe) {
  const interval = INTERVAL_MS[timeframe];
  const count = interval / 60_000;
  if (!interval || !Number.isInteger(count)) throw new Error('Unsupported timeframe');
  const buckets = new Map();
  for (const candle of minutes) {
    if (!candle.closed) continue;
    const bucket = Math.floor(candle.time / interval) * interval;
    const array = buckets.get(bucket) ?? [];
    array.push(candle);
    buckets.set(bucket, array);
  }
  const result = [];
  for (const [bucket, chunk] of buckets) {
    chunk.sort((a, b) => a.time - b.time);
    if (chunk.length !== count || chunk.some((c, i) => c.time !== bucket + i * 60_000)) continue;
    result.push({
      time: bucket, open: chunk[0].open, high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)), close: chunk.at(-1).close,
      volume: chunk.reduce((sum, c) => sum + c.volume, 0), closed: true
    });
  }
  return result.sort((a, b) => a.time - b.time);
}

export function createScanner({ adapters = [], settings = {}, onState = () => {}, onSignal = () => {},
  fetchFn = fetch, wsFactory, delayMs = 120, nowFn = Date.now, feedIdleMs = 240_000,
  assessmentDelayMs = 450, assessmentAutoLimit = 20 } = {}) {
  let currentSettings = { ...DEFAULT_SETTINGS, ...settings };
  const adapterById = new Map(adapters.map(adapter => [adapter.id, adapter]));
  const records = new Map();
  const providers = {};
  const signals = [];
  const seenSignals = new Set();
  const streamGroups = [];
  const pending = new Map();
  const timers = new Set();
  const repairs = new Set();
  const assessmentQueue = [];
  const assessmentTasks = new Set();
  const contextCache = new Map();
  let autoAssessed = 0, activeAssessments = 0;
  let healthTimer = null;
  let running = false, eligible = 0, ready = 0, failed = 0, stale = 0, queue = [], bootstrapPromise = Promise.resolve();

  function snapshot() {
    return {
      running, eligible, ready, failed, queued: queue.length, stale,
      providers: Object.fromEntries(Object.entries(providers).map(([id, p]) => [id, { ...p }])),
      signals: [...signals], settings: { ...currentSettings }
    };
  }
  function emit() { onState(snapshot()); }
  function reconcileStale() { stale = [...records.values()].filter(record => record.stale).length; }
  function getCandles(exchange, symbol, timeframe) {
    return records.get(keyFor(exchange, symbol))?.frames?.[timeframe] ?? [];
  }
  function recordSignal(signal, source) {
    if (seenSignals.has(signal.id)) return;
    seenSignals.add(signal.id);
    const enriched = { ...signal, source, tradeSetup: { status: 'unassessed', reason: 'Awaiting optional multi-timeframe analysis.' } };
    signals.unshift(enriched);
    if (signals.length > 1500) signals.pop();
    onSignal(enriched);
    if (source === 'live' || autoAssessed < assessmentAutoLimit) {
      autoAssessed++;
      requestAssessment(enriched.id);
    }
  }
  function getSignal(id) { return signals.find(signal => signal.id === id); }
  async function loadAssessmentContext(record) {
    const key = keyFor(record.market.exchange, record.market.symbol);
    const cached = contextCache.get(key);
    if (cached && nowFn() - cached.time < (cached.ttl ?? 15 * 60_000) &&
        (!Number.isFinite(cached.validUntil) || nowFn() < cached.validUntil)) return cached.promise;
    const adapter = adapterById.get(record.market.exchange);
    const promise = (async () => {
      const oneHour = await adapter.loadCandles(fetchFn, record.market.symbol, '1h', 150, nowFn());
      const fourHours = await adapter.loadCandles(fetchFn, record.market.symbol, '4h', 150, nowFn());
      for (const [frame, bars] of [['1h', oneHour], ['4h', fourHours]]) {
        const interval = INTERVAL_MS[frame];
        const mostRecentClose = bars.at(-1)?.time + interval;
        const age = nowFn() - mostRecentClose;
        if (!Number.isFinite(age) || bars.length < 60 || age > 2 * interval || age < -60_000) {
          throw new Error(`${frame.toUpperCase()} context is missing, stale, or not yet closed.`);
        }
      }
      return { '1h': oneHour, '4h': fourHours };
    })();
    contextCache.set(key, { time: nowFn(), promise, ttl: 15 * 60_000 });
    try {
      const data = await promise;
      const entry = contextCache.get(key);
      if (entry?.promise === promise) {
        const nextHourClose = data['1h'].at(-1).time + 2 * INTERVAL_MS['1h'];
        const nextFourHourClose = data['4h'].at(-1).time + 2 * INTERVAL_MS['4h'];
        entry.validUntil = Math.min(entry.time + 15 * 60_000,
          Math.max(entry.time + 30_000, Math.min(nextHourClose, nextFourHourClose)));
      }
      return data;
    }
    catch (error) {
      // Briefly cache failures as well, so ten EMA pairs don't hammer an
      // unavailable provider with identical higher-timeframe requests.
      const entry = contextCache.get(key);
      if (entry?.promise === promise) { entry.time = nowFn(); entry.ttl = 60_000; }
      throw error;
    }
  }
  function pumpAssessments() {
    while (running && activeAssessments < 1 && assessmentQueue.length) {
      const id = assessmentQueue.shift();
      activeAssessments++;
      const operation = (async () => {
        const signal = getSignal(id);
        if (!signal) return;
        try {
          const record = records.get(keyFor(signal.exchange, signal.symbol));
          if (!record?.ready || record.stale) throw new Error('Market history is not ready or is stale.');
          if (assessmentDelayMs > 0) await wait(assessmentDelayMs);
          const context = await loadAssessmentContext(record);
          if (!running) return;
          const current = records.get(keyFor(signal.exchange, signal.symbol));
          if (!current?.ready || current.stale) throw new Error('Market history became stale.');
          signal.tradeSetup = assessTradeSetup({
            side: signal.side, asOf: nowFn(),
            frames: { ...context, '15m': current.frames['15m'], '5m': current.frames['5m'] }
          });
        } catch (error) {
          if (!running) return;
          signal.tradeSetup = { status: 'unavailable', asOf: nowFn(), reason: `Context unavailable: ${error.message}` };
        }
        emit();
      })();
      assessmentTasks.add(operation);
      operation.finally(() => {
        assessmentTasks.delete(operation);
        activeAssessments--;
        if (running) pumpAssessments();
      });
    }
  }
  function requestAssessment(id) {
    const signal = getSignal(id);
    if (!signal || !running || signal.tradeSetup?.status === 'loading') return false;
    signal.tradeSetup = { status: 'loading', reason: 'Retrieving 4H/1H context from the exchange…' };
    assessmentQueue.push(id);
    pumpAssessments();
    emit();
    return true;
  }
  function evaluate(record, timeframe, source) {
    const candles = record.frames[timeframe];
    if (candles.length < 220 || !candles.at(-1)?.closed) return;
    const indicators = computeIndicators(candles, currentSettings);
    const results = evaluateSignals(candles, indicators, currentSettings,
      { exchange: record.market.exchange, symbol: record.market.symbol, timeframe });
    for (const signal of results) recordSignal(signal, source);
  }
  async function loadFrames(record) {
    const adapter = adapterById.get(record.market.exchange);
    const frames = {};
    for (const timeframe of FRAMES) {
      frames[timeframe] = await adapter.loadCandles(fetchFn, record.market.symbol, timeframe, 500, nowFn());
      if (frames[timeframe].length < 220) throw new Error(`Insufficient ${timeframe} history (${frames[timeframe].length})`);
    }
    return frames;
  }
  async function repair(record, desiredTime = 0) {
    if (record.repairPromise) return record.repairPromise;
    record.stale = true; reconcileStale(); emit();
    const operation = (async () => {
      try {
        const frames = await loadFrames(record);
        if (frames['1m'].at(-1).time < desiredTime) throw new Error('Backfill is behind the latest candle');
        if (!running) return;
        record.frames = frames;
        record.stale = false;
        record.error = '';
      } catch (error) {
        record.error = `Backfill: ${error.message}`;
      } finally {
        record.repairPromise = null;
        reconcileStale(); emit();
      }
    })();
    record.repairPromise = operation;
    repairs.add(operation);
    operation.finally(() => repairs.delete(operation));
    return operation;
  }
  function onClosed(exchange, symbol, rawCandle) {
    if (!running) return;
    const record = records.get(keyFor(exchange, symbol));
    if (!record?.ready || record.stale) return;
    const candle = normalizeCandles([rawCandle])[0];
    if (!candle) return;
    const minutes = record.frames['1m'];
    const lastTime = minutes.at(-1)?.time;
    if (lastTime !== undefined && candle.time <= lastTime) return;
    if (lastTime !== undefined && candle.time !== lastTime + 60_000) {
      void repair(record, candle.time);
      return;
    }
    minutes.push(candle);
    if (minutes.length > 500) minutes.shift();
    evaluate(record, '1m', 'live');
    for (const frame of ['5m', '15m']) {
      const interval = INTERVAL_MS[frame];
      if ((candle.time + 60_000) % interval !== 0) continue;
      const aggregated = buildHigherTimeframes(minutes.slice(-interval / 60_000), frame).at(-1);
      if (!aggregated) continue;
      const series = record.frames[frame];
      if (aggregated.time <= series.at(-1).time) continue;
      if (aggregated.time !== series.at(-1).time + interval) {
        void repair(record, candle.time);
        return;
      }
      series.push(aggregated);
      if (series.length > 500) series.shift();
      evaluate(record, frame, 'live');
    }
    emit();
  }
  function connectGroup(exchange, symbols) {
    if (!running || !symbols.length) return;
    const adapter = adapterById.get(exchange);
    let deliberateClose = false;
    const group = {
      exchange, symbols, connection: null, connected: false, reconnecting: false, lastActivity: nowFn(),
      close() { deliberateClose = true; this.connection?.close(); }
    };
    function disconnected() {
      if (!running || deliberateClose || group.reconnecting) return;
      group.connected = false;
      group.reconnecting = true;
      providers[exchange].status = 'stale';
      for (const symbol of symbols) {
        const record = records.get(keyFor(exchange, symbol));
        if (record?.ready) record.stale = true;
      }
      reconcileStale(); emit();
      const timer = setTimeout(async () => {
        timers.delete(timer);
        if (!running) return;
        await Promise.all(symbols.map(symbol => {
          const record = records.get(keyFor(exchange, symbol));
          return record ? repair(record) : Promise.resolve();
        }));
        if (running) {
          group.close();
          streamGroups.splice(streamGroups.indexOf(group), 1);
          connectGroup(exchange, symbols);
        }
      }, 4000);
      timers.add(timer);
    }
    group.recover = disconnected;
    try { group.connection = adapter.connectMinutes(symbols,
      (symbol, candle) => { group.lastActivity = nowFn(); onClosed(exchange, symbol, candle); },
      status => {
        if (!running || deliberateClose) return;
        if (status.status === 'connected') {
          group.connected = true;
          group.lastActivity = nowFn();
          providers[exchange].status = 'live'; providers[exchange].error = '';
        } else if (status.status === 'disconnected') {
          disconnected();
        } else if (status.status === 'error') {
          providers[exchange].error = status.error || 'WebSocket failure';
        }
        emit();
      }, wsFactory); }
    catch (error) {
      providers[exchange].error = `WebSocket: ${error.message}`;
      disconnected();
    }
    streamGroups.push(group);
  }
  function checkFeedHealth() {
    if (!running) return;
    for (const group of [...streamGroups]) {
      if (!group.reconnecting && nowFn() - group.lastActivity > feedIdleMs) {
        group.recover();
        group.close();
      }
    }
  }
  function stageSocket(record) {
    const exchange = record.market.exchange;
    const list = pending.get(exchange) ?? [];
    list.push(record.market.symbol);
    pending.set(exchange, list);
    if (list.length >= 25) {
      connectGroup(exchange, list.splice(0));
    }
  }
  async function bootstrapMarket(market) {
    const record = { market, ready: false, stale: false, frames: {}, error: '' };
    records.set(keyFor(market.exchange, market.symbol), record);
    try {
      record.frames = await loadFrames(record);
      if (!running) return;
      record.ready = true;
      ready++;
      for (const frame of FRAMES) evaluate(record, frame, 'snapshot');
      stageSocket(record);
    } catch (error) {
      record.error = error.message;
      failed++;
      providers[market.exchange].error = `Some pairs unavailable: ${error.message}`;
    }
    emit();
  }
  async function bootstrapAll() {
    const concurrency = Math.max(1, Math.min(4, Number(currentSettings.bootstrapConcurrency) || 2));
    async function worker() {
      while (running && queue.length) {
        const market = queue.shift();
        emit();
        await bootstrapMarket(market);
        if (delayMs > 0) await wait(delayMs);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (running) for (const [exchange, symbols] of pending) {
      if (symbols.length) connectGroup(exchange, symbols.splice(0));
    }
    emit();
  }
  async function start() {
    if (running) return;
    running = true;
    healthTimer = setInterval(checkFeedHealth, 30_000);
    for (const adapter of adapters) providers[adapter.id] = { status: 'loading', error: '', total: 0 };
    emit();
    const listings = await Promise.all(adapters.map(async adapter => {
      try {
        const markets = await adapter.listMarkets(fetchFn);
        providers[adapter.id].total = markets.length;
        providers[adapter.id].status = 'initializing';
        return markets.filter(market => market.turnover >= currentSettings.minTurnover);
      } catch (error) {
        providers[adapter.id].status = 'unavailable';
        providers[adapter.id].error = error.message;
        return [];
      }
    }));
    queue = listings.flat().sort((a, b) => b.turnover - a.turnover);
    eligible = queue.length;
    emit();
    bootstrapPromise = bootstrapAll();
  }
  async function whenIdle() {
    await bootstrapPromise;
    while (repairs.size) await Promise.all([...repairs]);
  }
  async function whenAssessmentsIdle() {
    while (assessmentTasks.size) await Promise.all([...assessmentTasks]);
  }
  function updateSettings(partial) {
    currentSettings = { ...currentSettings, ...partial };
    // Re-evaluate existing closed history when criteria change. Otherwise a
    // crossover from the last four candles may remain unseen until the next bar.
    for (const record of records.values()) {
      if (!record.ready || record.stale) continue;
      for (const frame of FRAMES) evaluate(record, frame, 'snapshot');
    }
    emit();
  }
  function stop() {
    running = false;
    assessmentQueue.length = 0;
    contextCache.clear();
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = null;
    for (const group of streamGroups) group.close();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const provider of Object.values(providers)) if (provider.status === 'live') provider.status = 'paused';
    emit();
  }
  return { start, stop, whenIdle, whenAssessmentsIdle, assessSignal: requestAssessment,
    snapshot, getCandles, updateSettings, checkFeedHealth };
}
