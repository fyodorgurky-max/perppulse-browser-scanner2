export const DEFAULT_RISK_INPUTS = Object.freeze({ equity: 100, riskPercent: 1, leverage: 10, costsPercent: 0.15 });

/** Illustration for a linear USDT-margined contract; not a liquidation or fill forecast. */
export function calculateRiskPlan(assessment, inputs = {}) {
  const { equity, riskPercent, leverage, costsPercent } = { ...DEFAULT_RISK_INPUTS, ...inputs };
  const entry = Number(assessment?.trade?.entry);
  const stop = Number(assessment?.trade?.stop);
  const side = assessment?.side;
  const invalid = reason => ({ valid: false, reason });
  if (![equity, riskPercent, leverage, costsPercent].every(Number.isFinite) || equity <= 0 || riskPercent <= 0 || riskPercent > 100 || leverage < 1 || leverage > 125 || costsPercent < 0 || costsPercent > 100) {
    return invalid('Enter valid equity, risk %, leverage and cost assumptions.');
  }
  if (!assessment?.trade || !Number.isFinite(entry) || !Number.isFinite(stop) || entry <= 0 || stop <= 0 ||
      !['long', 'short'].includes(side) || (side === 'long' && stop >= entry) || (side === 'short' && stop <= entry)) {
    return invalid('No valid structural entry and invalidation stop are available yet.');
  }
  const distance = Math.abs(entry - stop);
  const stopFraction = distance / entry;
  const costsFraction = costsPercent / 100;
  const riskBudget = equity * riskPercent / 100;
  const desiredNotional = riskBudget / (stopFraction + costsFraction);
  const maxNotional = equity * leverage * 0.95; // Leave a small margin reserve.
  const notional = Math.min(desiredNotional, maxNotional);
  const quantity = notional / entry;
  const margin = notional / leverage;
  const tp1 = side === 'long' ? entry + 1.5 * distance : entry - 1.5 * distance;
  const tp2 = side === 'long' ? entry + 2.5 * distance : entry - 2.5 * distance;
  if (tp1 <= 0 || tp2 <= 0) return invalid('Price targets are outside the valid positive price range.');
  const actualRisk = notional * (stopFraction + costsFraction);
  const netRatio = multiple => (multiple * stopFraction - costsFraction) / (stopFraction + costsFraction);
  return {
    valid: true, side, state: assessment.trade.state, entry, stop, tp1, tp2,
    quantity, notional, margin, riskBudget, estimatedLoss: actualRisk,
    estimatedCosts: notional * costsFraction, stopPercent: stopFraction * 100,
    netR1: netRatio(1.5), netR2: netRatio(2.5),
    cappedByMargin: notional < desiredNotional,
    inputs: { equity, riskPercent, leverage, costsPercent }
  };
}
