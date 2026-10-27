import { analyzeTradeIndicators } from './trade-indicators.js';
import { analyzeMarketStructure } from './market-structure.js';

const FRAMES = ['4h', '1h', '15m', '5m'];
const REQUIRED_BARS = { '4h': 60, '1h': 60, '15m': 55, '5m': 55 };
const intervals = { '4h': 14_400_000, '1h': 3_600_000, '15m': 900_000, '5m': 300_000 };
const ownSide = side => side === 'long' ? 'bullish' : 'bearish';

function trendDirection(row) {
  if (!row || !Number.isFinite(row.ema50) || !Number.isFinite(row.supertrend)) return 'range';
  if (row.close > row.ema50 && row.supertrendDirection === 'bullish') return 'bullish';
  if (row.close < row.ema50 && row.supertrendDirection === 'bearish') return 'bearish';
  return 'range';
}

function context(candles) {
  const indicator = analyzeTradeIndicators(candles);
  const structure = analyzeMarketStructure(candles);
  return {
    direction: trendDirection(indicator.latest),
    close: indicator.latest.close,
    candleTime: indicator.latest.time,
    ema50: indicator.latest.ema50,
    vwap: indicator.latest.vwap,
    atr: indicator.latest.atr,
    rvol: indicator.latest.rvol,
    supertrend: indicator.latest.supertrend,
    supertrendDirection: indicator.latest.supertrendDirection,
    support: structure.support,
    resistance: structure.resistance,
    swingHigh: structure.swingHighType,
    swingLow: structure.swingLowType,
    structureDirection: structure.direction,
    lastEvent: structure.lastEvent,
    _rows: indicator.rows,
    _structure: structure
  };
}

function findSetup(side, market, last15) {
  const direction = ownSide(side);
  const { _rows: rows, _structure: structure } = market;
  const latest = rows.at(-1), previous = rows.at(-2);
  const recent = structure.events.filter(event => event.direction === direction &&
    latest.time - event.time <= 4 * intervals['15m']);
  for (const event of recent.reverse()) {
    const eventRow = rows[event.index];
    if (eventRow?.rvol >= 1.2) {
      return { type: 'breakout_retest', direction, level: event.level, event: event.kind, time: event.time,
        volume: eventRow.rvol, reason: `15M ${event.kind} with elevated relative volume; awaiting directional 5M retest.` };
    }
  }

  const support = side === 'long' ? [market.support, latest.vwap] : [market.resistance, latest.vwap];
  const nearby = support.filter(Number.isFinite).sort((a, b) => Math.abs(a - latest.close) - Math.abs(b - latest.close));
  for (const level of nearby) {
    if (!Number.isFinite(latest.atr)) continue;
    const tolerance = latest.atr * 0.6;
    const touched = side === 'long' ? latest.low <= level + tolerance && latest.close >= level : latest.high >= level - tolerance && latest.close <= level;
    const turning = side === 'long' ? latest.close > latest.open && latest.close > previous.close : latest.close < latest.open && latest.close < previous.close;
    if (touched && turning && latest.rvol >= 1) {
      return { type: 'trend_pullback', direction, level, event: market.lastEvent?.kind ?? 'none', time: latest.time,
        volume: latest.rvol, reason: '15M price reacted near confirmed support/resistance or UTC VWAP.' };
    }
  }
  return { type: 'none', direction, level: NaN, event: market.lastEvent?.kind ?? 'none', time: last15.time,
    volume: latest.rvol, reason: 'No recent directional 15M breakout/retest or pullback setup.' };
}

function findTrigger(side, setup, market5m) {
  const rows = market5m._rows;
  const now = rows.at(-1), prior = rows.at(-2);
  const atr = now.atr;
  if (setup.type === 'none' || !Number.isFinite(atr)) return { confirmed: false, reason: 'Waiting for a 15M setup.' };
  if (now.time < setup.time + intervals['15m']) {
    return { confirmed: false, reason: 'Waiting for a 5M candle that closes after the 15M setup is confirmed.' };
  }
  const bullish = side === 'long';
  const directionalClose = bullish ? now.close > now.open : now.close < now.open;
  const volumeGood = now.rvol >= 1.2;
  let priceConfirmed;
  if (setup.type === 'breakout_retest') {
    const tolerance = Math.max(atr * 0.3, setup.level * 0.0005);
    const tested = bullish
      ? Math.abs(now.low - setup.level) <= tolerance && now.close > setup.level
      : Math.abs(now.high - setup.level) <= tolerance && now.close < setup.level;
    priceConfirmed = tested;
  } else {
    priceConfirmed = bullish
      ? now.low > prior.low && now.close > Math.max(prior.high, rows.at(-3).high)
      : now.high < prior.high && now.close < Math.min(prior.low, rows.at(-3).low);
  }
  const confirmed = directionalClose && volumeGood && priceConfirmed;
  return {
    confirmed, time: now.time, price: now.close, rvol: now.rvol,
    reason: confirmed ? 'Closed 5M candle confirmed direction, structure and RVOL ≥ 1.2.'
      : [!directionalClose && 'Directional candle close missing', !volumeGood && '5M RVOL < 1.2', !priceConfirmed && '5M retest / break of local level missing'].filter(Boolean).join('; ')
  };
}

function buildTrade(side, setup, trigger, context5m) {
  if (setup.type === 'none') return null;
  const rows = context5m._rows, latest = rows.at(-1);
  const lastSwings = context5m._structure;
  const bullish = side === 'long';
  const entry = trigger.confirmed ? trigger.price : latest.close;
  const recent = rows.slice(-5);
  const recentExtreme = bullish ? Math.min(...recent.map(r => r.low)) : Math.max(...recent.map(r => r.high));
  const pivot = bullish ? lastSwings.lastLow?.price : lastSwings.lastHigh?.price;
  // A recent candle low/high by itself is not a causally confirmed swing.
  // Without a real swing invalidation, never offer notional or target sizes.
  if (!Number.isFinite(pivot) || (bullish && pivot >= entry) || (!bullish && pivot <= entry)) return null;
  const stopAnchor = bullish
    ? Math.min(recentExtreme, pivot)
    : Math.max(recentExtreme, pivot);
  const stop = bullish ? stopAnchor - latest.atr * 0.25 : stopAnchor + latest.atr * 0.25;
  if (entry <= 0 || stop <= 0 || (bullish && stop >= entry) || (!bullish && stop <= entry)) return null;
  const tolerance = latest.atr * 0.3;
  return { entry, stop, level: setup.level,
    entryZone: [Math.max(0, setup.level - tolerance), setup.level + tolerance],
    state: trigger.confirmed ? 'triggered' : 'conditional',
    invalidation: bullish ? `5M closes decisively below ${stop}` : `5M closes decisively above ${stop}` };
}

/** Read-only, timestamped assessment. Does not suppress or mutate EMA signals. */
export function assessTradeSetup({ side, frames = {}, asOf = Date.now() } = {}) {
  if (!['long', 'short'].includes(side)) return { status: 'unavailable', side, asOf, reason: 'Unsupported direction.' };
  if (!Number.isFinite(asOf)) return { status: 'unavailable', side, asOf, reason: 'Invalid assessment time.' };
  const closed = {};
  for (const frame of FRAMES) {
    closed[frame] = (frames[frame] ?? []).filter(bar => bar.closed && Number.isFinite(bar.close));
    if (closed[frame].length < REQUIRED_BARS[frame]) {
      return { status: 'unavailable', side, asOf, reason: `Insufficient ${frame.toUpperCase()} closed-candle history.` };
    }
    const interval = intervals[frame];
    const age = asOf - (closed[frame].at(-1).time + interval);
    if (!Number.isFinite(age) || age < -60_000 || age > interval * 2) {
      return { status: 'unavailable', side, asOf, reason: `${frame.toUpperCase()} data are stale or not yet closed.` };
    }
  }
  const four = context(closed['4h']), one = context(closed['1h']), fifteen = context(closed['15m']), five = context(closed['5m']);
  const setup15m = findSetup(side, fifteen, closed['15m'].at(-1));
  const trigger5m = findTrigger(side, setup15m, five);
  const trade = buildTrade(side, setup15m, trigger5m, five);
  const desired = ownSide(side);
  const higherTimeframeAgreement = four.direction === desired && one.direction === desired;
  const checklist = {
    higherTimeframeAgreement,
    oneHourBias: one.direction === desired,
    significant15mLevel: setup15m.type !== 'none',
    fiveMinuteClose: trigger5m.confirmed,
    volumeConfirmed: trigger5m.confirmed && trigger5m.rvol >= 1.2,
    stopDefined: !!trade
  };
  const conflict = (four.direction !== 'range' && four.direction !== desired) || (one.direction !== 'range' && one.direction !== desired);
  const status = conflict ? 'conflict' : higherTimeframeAgreement && setup15m.type !== 'none' && trigger5m.confirmed && !!trade ? 'confirmed' : 'watch';
  const reason = conflict ? 'Higher-timeframe direction contradicts the proposed trade.'
    : status === 'confirmed' ? 'Market direction, 15M setup and closed 5M entry trigger align.'
      : setup15m.type === 'none' ? 'No valid 15M setup yet.'
        : !higherTimeframeAgreement ? 'Waiting for full 4H/1H trend agreement.' : trigger5m.reason;
  const clean = ({ _rows, _structure, ...item }) => item;
  return {
    status, reason, side, asOf, context4h: clean(four), bias1h: clean(one),
    setup15m: { ...setup15m, ...clean(fifteen) }, trigger5m: { ...trigger5m, ...clean(five) },
    trade, checklist
  };
}
