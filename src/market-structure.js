/** Confirmed 2-left/2-right swings and causal close-through structure breaks. */
export function analyzeMarketStructure(candles = [], pivotDepth = 2) {
  const bars = candles.filter(c => c.closed && [c.time, c.high, c.low, c.close].every(Number.isFinite));
  const highs = [], lows = [], events = [];
  let lastHigh = null, lastLow = null, brokenHigh = null, brokenLow = null;
  let structureDirection = null;
  const depth = Math.max(1, Math.floor(pivotDepth));

  for (let j = 0; j < bars.length; j++) {
    const i = j - depth;
    if (i >= depth) {
      const neighbors = bars.slice(i - depth, i + depth + 1);
      const bar = bars[i];
      if (neighbors.every((candidate, offset) => offset === depth || bar.high > candidate.high)) {
        lastHigh = { time: bar.time, price: bar.high, index: i };
        highs.push(lastHigh);
        brokenHigh = null;
      }
      if (neighbors.every((candidate, offset) => offset === depth || bar.low < candidate.low)) {
        lastLow = { time: bar.time, price: bar.low, index: i };
        lows.push(lastLow);
        brokenLow = null;
      }
    }
    if (j === 0) continue;
    const current = bars[j], previous = bars[j - 1];
    let direction, level, pivotTime;
    if (lastHigh && brokenHigh !== lastHigh.time && previous.close <= lastHigh.price && current.close > lastHigh.price) {
      direction = 'bullish'; level = lastHigh.price; pivotTime = lastHigh.time; brokenHigh = pivotTime;
    } else if (lastLow && brokenLow !== lastLow.time && previous.close >= lastLow.price && current.close < lastLow.price) {
      direction = 'bearish'; level = lastLow.price; pivotTime = lastLow.time; brokenLow = pivotTime;
    }
    if (direction) {
      const kind = structureDirection && structureDirection !== direction ? 'CHoCH' : 'BOS';
      events.push({ time: current.time, index: j, direction, kind, level, pivotTime });
      structureDirection = direction;
    }
  }
  const latestHigh = highs.at(-1) ?? null, latestLow = lows.at(-1) ?? null;
  const earlierHigh = highs.at(-2) ?? null, earlierLow = lows.at(-2) ?? null;
  return {
    highs, lows, events, lastHigh: latestHigh, lastLow: latestLow,
    support: latestLow?.price ?? NaN, resistance: latestHigh?.price ?? NaN,
    swingHighType: earlierHigh && latestHigh ? (latestHigh.price > earlierHigh.price ? 'HH' : latestHigh.price < earlierHigh.price ? 'LH' : 'EH') : 'unknown',
    swingLowType: earlierLow && latestLow ? (latestLow.price > earlierLow.price ? 'HL' : latestLow.price < earlierLow.price ? 'LL' : 'EL') : 'unknown',
    direction: structureDirection ?? 'range', lastEvent: events.at(-1) ?? null
  };
}
