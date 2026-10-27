import { calculateRiskPlan, DEFAULT_RISK_INPUTS } from './risk.js';

const DEFAULT_FILTERS = Object.freeze({ exchange: 'all', timeframe: 'all', side: 'all', type: 'all', pair: 'all', setup: 'all', search: '', sort: 'newest' });
const EXCHANGE_LABELS = { binance: 'Binance Futures', bybit: 'Bybit Linear', okx: 'OKX SWAP' };

export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

export function chartURL(exchange, symbol) {
  const normalized = exchange === 'okx' ? symbol.replace(/-USDT-SWAP$/, 'USDT') : symbol;
  const prefix = { binance: 'BINANCE', bybit: 'BYBIT', okx: 'OKX' }[exchange];
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`${prefix ?? exchange.toUpperCase()}:${normalized}.P`)}`;
}

/** EMA discoveries persist, but an entry assessment must never claim to stay live forever. */
export function effectiveSetupStatus(signal, now = Date.now()) {
  const setup = signal?.tradeSetup;
  const status = setup?.status ?? 'unassessed';
  if (['confirmed', 'watch', 'conflict'].includes(status) && Number.isFinite(setup?.asOf)) {
    const maxAge = status === 'confirmed' ? 5 * 60_000 : 15 * 60_000;
    let expiresAt = setup.asOf + maxAge;
    if (status === 'confirmed' && Number.isFinite(setup.trigger5m?.time)) {
      // Candle.time is its OPEN; the trigger and following 5M candle have closed after 10 minutes.
      expiresAt = Math.min(expiresAt, setup.trigger5m.time + 10 * 60_000);
    }
    if (now >= setup.asOf && now >= expiresAt) return 'expired';
  }
  return status;
}

export function filterAndSortSignals(signals = [], filters = {}) {
  const selected = { ...DEFAULT_FILTERS, ...filters };
  const query = selected.search.trim().toLowerCase();
  return signals.filter(s => (selected.exchange === 'all' || s.exchange === selected.exchange) &&
    (selected.timeframe === 'all' || s.timeframe === selected.timeframe) &&
    (selected.side === 'all' || s.side === selected.side) &&
    (selected.type === 'all' || s.type === selected.type) &&
    (selected.pair === 'all' || s.pair === selected.pair) &&
    (selected.setup === 'all' || effectiveSetupStatus(s) === selected.setup) &&
    (!query || `${s.symbol} ${s.exchange} ${s.pair ?? ''}`.toLowerCase().includes(query)))
    .sort((a, b) => selected.sort === 'volume' ? (b.rvol - a.rvol) || ((b.detectedAt ?? b.time) - (a.detectedAt ?? a.time))
      : ((b.detectedAt ?? b.time) - (a.detectedAt ?? a.time)) || b.time - a.time);
}

export function serializeSignalsCSV(signals = []) {
  const columns = [
    ['Exchange', s => s.exchange], ['Symbol', s => s.symbol], ['Timeframe', s => s.timeframe],
    ['Direction', s => s.side], ['Signal', s => s.type], ['EMA Pair', s => s.pair || ''],
    ['Candles Ago at Detection', s => s.type === 'confirmed' ? s.candlesAgo : ''],
    ['Detected Candle Time (UTC)', s => new Date(s.detectedAt ?? s.time).toISOString()],
    ['Origin Time (UTC)', s => new Date(s.originTime).toISOString()], ['Price', s => s.price],
    ['RSI', s => s.rsi], ['MACD Z', s => s.macdZ], ['RVOL', s => s.rvol], ['Source', s => s.source],
    ['Trade Setup Status', s => effectiveSetupStatus(s)],
    ['15M Setup', s => s.tradeSetup?.setup15m?.type ?? ''],
    ['Assessment Time (UTC)', s => Number.isFinite(s.tradeSetup?.asOf) ? new Date(s.tradeSetup.asOf).toISOString() : '']
  ];
  const cell = value => { const text = String(value ?? ''); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; };
  return [columns.map(([name]) => name).join(','), ...signals.map(s => columns.map(([, get]) => cell(get(s))).join(','))].join('\r\n');
}

export function dashboardCopy(state, resultsCount) {
  const providers = Object.values(state.providers ?? {});
  if (providers.some(p => p.status === 'unavailable') && state.eligible === 0) return 'One or more exchanges are unavailable. Check provider status or network restrictions.';
  if (!state.running) return 'Scanner is paused. Press Start scanning to begin collecting perpetual-futures data.';
  if (state.ready === 0 && state.queued > 0) return 'Initializing market history. High-turnover contracts are checked first; coverage expands as pairs load.';
  if (state.eligible === 0) return 'No eligible USDT perpetuals were returned. Check the 24h turnover cutoff and provider connectivity.';
  if (resultsCount === 0) return 'No matching signals yet. Try other exchanges, timeframes, or a lower volume/turnover threshold.';
  return '';
}

const number = (n, digits = 1) => Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
const price = n => Number.isFinite(n) ? `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 0.01 ? 8 : n < 1 ? 5 : n < 100 ? 3 : 2 })}` : '—';
const timeLabel = n => Number.isFinite(n) ? new Date(n).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const pill = (klass, label) => `<span class="pill ${klass}">${label}</span>`;
const formatTimeUTC = n => Number.isFinite(n) ? new Date(n).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : '—';
const setupStatuses = new Set(['unassessed', 'loading', 'watch', 'confirmed', 'conflict', 'unavailable', 'expired']);
const setupStatus = value => setupStatuses.has(value) ? value : 'unavailable';
const statusChip = status => `<span class="setup-status setup-${setupStatus(status)}">${escapeHTML(status === 'confirmed' ? '✓ SETUP READY' : String(setupStatus(status)).toUpperCase())}</span>`;

function timeframeCard(title, data, description) {
  if (!data) return '';
  return `<article class="context-card"><div class="context-heading">${title} <span class="trend-chip">${escapeHTML(String(data.direction ?? 'range').toUpperCase())}</span></div>
    <div class="context-line">${escapeHTML(description)}</div>
    <dl><div><dt>Close</dt><dd>${price(data.close)}</dd></div><div><dt>UTC VWAP</dt><dd>${price(data.vwap)}</dd></div>
      <div><dt>ATR 14</dt><dd>${number(data.atr, 6)}</dd></div><div><dt>SuperTrend</dt><dd>${price(data.supertrend)}</dd></div>
      <div><dt>Support</dt><dd>${price(data.support)}</dd></div><div><dt>Resistance</dt><dd>${price(data.resistance)}</dd></div>
      <div><dt>RVOL 20</dt><dd>${number(data.rvol, 2)}×</dd></div><div><dt>Last structure</dt><dd>${escapeHTML(data.lastEvent?.kind ?? '—')} ${escapeHTML(data.lastEvent?.direction ?? '')}</dd></div>
      <div><dt>Swing structure</dt><dd>${escapeHTML(data.swingHigh ?? '—')} / ${escapeHTML(data.swingLow ?? '—')}</dd></div>
    </dl></article>`;
}

/** Pure markup for the separate, explicitly timestamped setup and risk assessment panel. */
export function tradeSetupMarkup(signal, riskInputs = DEFAULT_RISK_INPUTS) {
  if (!signal) return '<div class="analysis-empty">Select <strong>Analyze</strong> or <strong>View</strong> beside an EMA alert to inspect its 4H → 5M context.</div>';
  const setup = signal.tradeSetup ?? { status: 'unassessed', reason: 'No analysis requested yet.' };
  const displayStatus = effectiveSetupStatus(signal);
  const form = `<div class="risk-control-grid">
    <label>Account equity · USDT<input data-risk="equity" type="number" min="1" step="10" value="${escapeHTML(riskInputs.equity)}" /></label>
    <label>Risk per trade · %<input data-risk="riskPercent" type="number" min="0.01" max="100" step="0.25" value="${escapeHTML(riskInputs.riskPercent)}" /></label>
    <label>Leverage · x<input data-risk="leverage" type="number" min="1" max="125" step="1" value="${escapeHTML(riskInputs.leverage)}" /></label>
    <label>Round-trip costs · %<input data-risk="costsPercent" type="number" min="0" max="100" step="0.05" value="${escapeHTML(riskInputs.costsPercent)}" /></label>
  </div>`;
  const start = `<div class="trade-panel-header"><div><div class="section-title"><span class="section-accent"></span> ${escapeHTML(signal.symbol)} · ${escapeHTML(signal.side.toUpperCase())} TRADE SETUP</div>
    <p>Independent assessment of EMA ${escapeHTML(signal.pair || signal.type)} · Checked ${formatTimeUTC(setup.asOf)} · Current context, not EMA-cross history</p></div>
    <div class="trade-panel-actions">${statusChip(displayStatus)}<button class="outline-button" data-analyze-id="${escapeHTML(signal.id)}" data-refresh-assessment="true" type="button">↻ Refresh analysis</button></div></div>`;
  if (!setup.context4h || !setup.bias1h) {
    return `${start}<div class="analysis-empty">${escapeHTML(setup.reason || 'Waiting for market data.')}<p>Existing EMA alerts remain visible regardless of this optional assessment.</p></div>
      <div class="risk-card"><h3>RISK / POSITION CALCULATOR</h3>${form}<p class="risk-warning">Waiting for a confirmed structural level and usable entry/stop. No position size is suggested.</p></div>`;
  }
  const checklistNames = {
    higherTimeframeAgreement: '4H and 1H trends agree', oneHourBias: '1H bias supports direction',
    significant15mLevel: '15M setup at a meaningful level', fiveMinuteClose: '5M CLOSED CANDLE trigger',
    volumeConfirmed: '5M relative volume confirms', stopDefined: 'Defined structural stop'
  };
  const checklist = Object.entries(checklistNames).map(([key, label]) =>
    `<div class="check-row ${setup.checklist?.[key] ? 'check-yes' : 'check-no'}"><span>${setup.checklist?.[key] ? '✓' : '○'}</span> ${label}</div>`).join('');
  const plan = displayStatus !== 'expired' ? calculateRiskPlan(setup, riskInputs) : { valid: false, reason: 'Assessment expired. Refresh analysis before using entry, stop or position size.' };
  const planMarkup = plan.valid ? `<div class="plan-grid">
    <div><span>ENTRY · ${escapeHTML(plan.state.toUpperCase())}</span><strong>${price(plan.entry)}</strong></div>
    <div><span>STOP / INVALIDATION</span><strong>${price(plan.stop)}</strong></div>
    <div><span>TP1 · 1.5R GROSS</span><strong>${price(plan.tp1)}</strong></div>
    <div><span>TP2 · 2.5R GROSS</span><strong>${price(plan.tp2)}</strong></div>
    <div><span>USDT NOTIONAL</span><strong>${number(plan.notional, 2)}</strong></div>
    <div><span>EST. INITIAL MARGIN</span><strong>${number(plan.margin, 2)} USDT</strong></div>
    <div><span>PLANNED MAX LOSS*</span><strong>${number(plan.estimatedLoss, 2)} USDT</strong></div>
    <div><span>COIN QUANTITY</span><strong>${number(plan.quantity, 7)}</strong></div>
    <div><span>NET R · TP1</span><strong>${number(plan.netR1, 2)}R</strong></div>
    <div><span>NET R · TP2</span><strong>${number(plan.netR2, 2)}R</strong></div>
  </div><p class="risk-warning">${escapeHTML(setup.trade.invalidation)} · ${plan.cappedByMargin ? 'Size capped by margin availability. ' : ''}${plan.state === 'conditional' ? 'Entry reference is conditional; wait for the 5M trigger. ' : ''}*Estimated costs included; slippage, funding, liquidation and exchange minimums may change results.</p>`
    : `<p class="risk-warning">${escapeHTML(plan.reason)} This is a planning tool; it never places an order.</p>`;
  return `${start}<div class="assessment-callout"><div>${statusChip(displayStatus)} ${escapeHTML(displayStatus === 'expired' ? 'This snapshot is no longer current. Refresh analysis before considering a trade.' : setup.reason)}</div>
    <div>15M setup: <strong>${escapeHTML(setup.setup15m?.type ?? 'none')}</strong> · Structure: ${escapeHTML(setup.setup15m?.event ?? 'none')} · Key level: ${price(setup.setup15m?.level)}</div>
    <div>5M trigger: <strong>${setup.trigger5m?.confirmed ? 'CLOSED CANDLE CONFIRMED' : 'NOT YET CONFIRMED'}</strong> · ${escapeHTML(setup.trigger5m?.reason ?? '')}</div></div>
    <div class="context-grid">
      ${timeframeCard('4H CONTEXT', setup.context4h, `Trend: ${setup.context4h.direction} · Swings ${setup.context4h.swingHigh ?? '?'} / ${setup.context4h.swingLow ?? '?'}`)}
      ${timeframeCard('1H BIAS', setup.bias1h, `Direction: ${setup.bias1h.direction} · ${setup.bias1h.lastEvent?.kind ?? 'no recent break'}`)}
      ${timeframeCard('15M SETUP', setup.setup15m, `Pattern: ${setup.setup15m.type} · ${setup.setup15m.event} · Level ${price(setup.setup15m.level)}`)}
      ${timeframeCard('5M TRIGGER', setup.trigger5m, setup.trigger5m.reason ?? 'Awaiting close')}
    </div><div class="analysis-bottom"><div class="checklist-card"><h3>ENTRY CONFIRMATION CHECKLIST</h3>${checklist}</div>
      <div class="risk-card"><h3>RISK / POSITION CALCULATOR</h3>${form}${planMarkup}</div></div>
    <p class="analysis-disclaimer">Indicators are browser-computed approximations, not identical to the referenced TradingView scripts. Swing pivots require two later closed candles. Setup confirmation is neither a forecast nor investment advice.</p>`;
}

function skeleton() {
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark"><span class="brand-icon">⌁</span></div><div><div class="brand-name">PERP<span>PULSE</span></div><div class="brand-sub">MARKET INTELLIGENCE / 01</div></div></div>
        <div class="sidebar-section-label">MONITOR</div>
        <div class="nav-selected"><span class="nav-dot"></span> Market scanner <span class="nav-arrow">↗</span></div>
        <div class="sidebar-section-label sidebar-spaced">EXCHANGES <span id="provider-count" class="small-counter">0/3</span></div>
        <div id="providers" class="providers"></div>
        <div class="sidebar-bottom">
          <div class="sidebar-section-label">SIGNAL LEGEND</div>
          <div class="legend-row"><span class="legend-circle teal"></span><span>Early bullish exhaustion</span></div>
          <div class="legend-row"><span class="legend-circle coral"></span><span>Early bearish exhaustion</span></div>
          <div class="legend-row"><span class="legend-circle green"></span><span>Confirmed bullish cross</span></div>
          <div class="legend-row"><span class="legend-circle red"></span><span>Confirmed bearish cross</span></div>
          <div class="sidebar-note">Signal discovery only, never trading advice. Derivatives involve substantial risk.</div>
        </div>
      </aside>
      <main class="main">
        <header class="topbar"><div class="breadcrumbs">DASHBOARD <span>/</span> PERPETUAL FUTURES</div><div class="topbar-right"><span class="mode-chip">◈ FREE / NO API KEY</span><span id="local-clock" class="clock"></span></div></header>
        <section class="hero">
          <div class="hero-copy"><div class="eyebrow"><span class="eyebrow-pulse"></span> REAL-TIME SIGNAL DISCOVERY</div><h1>Spot the shift<span class="period">.</span><br/><span class="hero-muted">Before the crowd.</span></h1>
            <p>Multi-exchange perpetual futures scanner for early exhaustion warnings and confirmed EMA 20/200, 10/200 and 10/100 crossovers.</p>
            <div class="hero-actions"><button id="scan-toggle" class="primary-button" type="button">▶ &nbsp; Start scanning</button><button id="notify-toggle" class="ghost-button" type="button">♧ &nbsp; Enable alerts</button><button id="sound-toggle" class="icon-button" type="button" title="Toggle alert sound" aria-label="Toggle alert sound">♫</button></div>
          </div><div class="hero-art" aria-hidden="true"><div class="grid-plane"></div><div class="halo halo-one"></div><div class="halo halo-two"></div><svg class="hero-graph" viewBox="0 0 430 240" fill="none"><path d="M0 164 L39 151 L66 169 L94 120 L125 139 L160 123 L181 153 L205 95 L246 121 L271 72 L305 94 L330 58 L357 82 L388 35 L430 12" stroke="#41f5c8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M0 164 L39 151 L66 169 L94 120 L125 139 L160 123 L181 153 L205 95 L246 121 L271 72 L305 94 L330 58 L357 82 L388 35 L430 12 V240 H0Z" fill="url(#line-gradient)"/><defs><linearGradient id="line-gradient" x1="0" y1="30" x2="0" y2="240"><stop stop-color="#41f5c8" stop-opacity=".25"/><stop offset="1" stop-color="#41f5c8" stop-opacity="0"/></linearGradient></defs><circle cx="388" cy="35" r="6" fill="#41f5c8"/><circle cx="388" cy="35" r="14" stroke="#41f5c8" stroke-opacity=".5"/></svg><div class="art-label">EMA 20 <span>↗</span> EMA 200</div></div>
        </section>
        <section class="section-stat"><div class="section-title"><span class="section-accent"></span> LIVE MARKET COVERAGE</div><div id="scan-status" class="scan-status">● STANDBY</div></section>
        <section class="metrics"><div class="metric-card"><div class="metric-label">ELIGIBLE CONTRACTS <span class="metric-glyph">◉</span></div><div id="metric-eligible" class="metric-value">0</div><div class="metric-sub">Filtered by 24h turnover</div></div><div class="metric-card"><div class="metric-label">INITIALIZED <span class="metric-glyph">↗</span></div><div id="metric-ready" class="metric-value">0</div><div class="metric-progress"><span id="coverage-progress"></span></div></div><div class="metric-card"><div class="metric-label">IN QUEUE <span class="metric-glyph">◷</span></div><div id="metric-queued" class="metric-value">0</div><div class="metric-sub">Progressive, rate-limited</div></div><div class="metric-card"><div class="metric-label">FAILED / STALE <span class="metric-glyph">⚠</span></div><div id="metric-issues" class="metric-value">0 <small>/ 0</small></div><div class="metric-sub">No stale-feed alerts</div></div></section>
        <section class="signal-overview"><div class="overview-title">SIGNAL ACTIVITY <span class="overview-sub">Session discoveries · newest first</span></div><div id="signal-counters" class="signal-counters"></div></section>
        <section class="results-card"><div class="results-header"><div><div class="section-title"><span class="section-accent"></span> SIGNAL FEED <span id="match-count" class="result-count">0</span></div><div class="results-desc">Closed-candle signals only · Cross age is recorded at discovery · Session history retained</div></div><div class="results-actions"><button id="export-button" class="outline-button" type="button">⇩ &nbsp; Export CSV</button></div></div>
          <div class="filter-bar"><div class="search-wrap"><span>⌕</span><input id="signal-search" data-filter="search" type="search" placeholder="Search contracts..." aria-label="Search contracts" /></div>
            <select data-filter="exchange" aria-label="Exchange"><option value="all">All exchanges</option><option value="binance">Binance</option><option value="bybit">Bybit</option><option value="okx">OKX</option></select>
            <select data-filter="timeframe" aria-label="Timeframe"><option value="all">All intervals</option><option value="1m">1 minute</option><option value="5m">5 minutes</option><option value="15m">15 minutes</option></select>
            <select data-filter="side" aria-label="Direction"><option value="all">Long + short</option><option value="long">Long only</option><option value="short">Short only</option></select>
            <select data-filter="type" aria-label="Signal type"><option value="all">Both signal types</option><option value="early">Early warning</option><option value="confirmed">EMA confirmed</option></select>
            <select data-filter="pair" aria-label="EMA pair"><option value="all">All EMA pairs</option><option value="20/200">EMA 20/200</option><option value="10/200">EMA 10/200</option><option value="10/100">EMA 10/100</option></select>
            <select data-filter="setup" aria-label="Trade setup"><option value="all">All setup statuses</option><option value="confirmed">Setup ready</option><option value="watch">Watch</option><option value="conflict">Conflict</option><option value="expired">Expired / refresh</option><option value="unavailable">Unavailable</option><option value="unassessed">Not assessed</option><option value="loading">Loading</option></select>
            <select data-filter="sort" aria-label="Sort by"><option value="newest">Newest first</option><option value="volume">Highest RVOL</option></select>
          </div>
          <div class="table-scroll"><table class="signals-table"><thead><tr><th>CONTRACT</th><th>EXCHANGE</th><th>INTERVAL</th><th>DIRECTION</th><th>SIGNAL</th><th>EMA PAIR</th><th title="Completed candles between the crossover and its discovery">BARS AGO AT FIND</th><th>PRICE</th><th>RSI 14</th><th>MACD Z</th><th>RVOL</th><th title="Time of the actual crossover or early-warning candle">CROSS TIME</th><th>TRADE SETUP</th><th>REVIEW</th><th>CHART</th></tr></thead><tbody id="signals-body"></tbody></table></div>
          <div id="empty-message" class="empty-message"></div><div class="results-footer"><span id="results-summary">Waiting for scan</span><span>DATA: EXCHANGE PUBLIC MARKET FEEDS</span></div>
        </section>
        <section id="trade-setup" class="trade-setup-panel" aria-live="polite"><div id="trade-setup-content" class="trade-setup-content"></div></section>
        <details class="settings-panel"><summary><div><span class="section-accent"></span> SCANNER PARAMETERS <span class="settings-hint">Tune volume and oscillator thresholds</span></div><span class="settings-chevron">⌄</span></summary>
          <div class="settings-grid"><label>Min 24h turnover (USDT)<input type="number" data-setting="minTurnover" min="0" step="1000000" /></label><label>Early RSI oversold<input type="number" data-setting="rsiOversold" min="1" max="50" /></label><label>Early RSI overbought<input type="number" data-setting="rsiOverbought" min="50" max="99" /></label><label>MACD histogram |Z|<input type="number" data-setting="macdExtreme" min="0" max="10" step="0.1" /></label><label>Early minimum RVOL<input type="number" data-setting="earlyRvol" min="0" max="50" step="0.1" /></label><label>Confirm minimum RVOL<input type="number" data-setting="confirmRvol" min="0" max="50" step="0.1" /></label><label>Extreme lookback (bars)<input type="number" data-setting="extremeWindow" min="1" max="25" step="1" /></label><label>Max EMA-cross age (0 to N bars ago)<input type="number" data-setting="crossLookback" min="0" max="15" step="1" /></label></div>
          <p class="setting-note">Changing the turnover cutoff restarts market discovery. EMA 20/200, 10/200 and 10/100 crosses must meet RSI / MACD / crossing-candle RVOL confirmation. A crossover up to 4 closed candles old is detected by default. Early warnings still use EMA 20/200.</p>
        </details>
        <footer class="footer"><span>PERPPULSE / VERSION 3.0</span><span>BUILT FOR THE OPEN WEB · FREE FOREVER TO HOST</span></footer>
      </main>
    </div>`;
}

function providerMarkup(providers) {
  return ['binance', 'bybit', 'okx'].map(exchange => {
    const data = providers[exchange] ?? { status: 'idle', error: '' };
    const status = data.status ?? 'idle';
    return `<div class="provider-item"><div class="provider-head"><span class="provider-emblem emblem-${exchange}">${{ binance: '◆', bybit: '◩', okx: '▦' }[exchange]}</span><span class="provider-name">${EXCHANGE_LABELS[exchange]}</span><span class="health-dot health-${escapeHTML(status)}" title="${escapeHTML(status)}"></span></div><div class="provider-detail"><span>${escapeHTML(status.toUpperCase())}</span><span>${Number(data.total ?? 0)} markets</span></div>${data.error ? `<div class="provider-error" title="${escapeHTML(data.error)}">${escapeHTML(data.error)}</div>` : ''}</div>`;
  }).join('');
}

function rowsMarkup(signals) {
  return signals.slice(0, 500).map(s => `<tr>
    <td><div class="ticker"><span class="ticker-symbol">${escapeHTML(s.symbol)}</span><span class="ticker-sub">${s.source === 'live' ? 'LIVE EVENT' : 'HISTORICAL / INITIAL'}</span></div></td>
    <td><span class="exchange-text">${escapeHTML(EXCHANGE_LABELS[s.exchange] ?? s.exchange)}</span></td>
    <td><span class="timeframe-chip">${escapeHTML(s.timeframe)}</span></td>
    <td>${pill(s.side === 'long' ? 'long' : 'short', s.side === 'long' ? '↗ LONG' : '↘ SHORT')}</td>
    <td>${pill(s.type === 'confirmed' ? 'confirmed' : 'early', s.type === 'confirmed' ? '◉ EMA CROSS' : '◌ EARLY WARN')}</td>
    <td><span class="pair-chip">${escapeHTML(s.pair || '—')}</span></td>
    <td class="numeric">${s.type === 'confirmed' ? number(s.candlesAgo, 0) : '—'}</td>
    <td class="numeric price-cell">${price(s.price)}</td><td class="numeric">${number(s.rsi, 1)}</td>
    <td class="numeric ${s.macdZ < 0 ? 'negative' : 'positive'}">${number(s.macdZ, 2)}</td>
    <td class="numeric rvol-cell">${number(s.rvol, 2)}×</td><td class="date-cell">${timeLabel(s.time)}</td>
    <td>${statusChip(effectiveSetupStatus(s))}</td>
    <td><button class="review-button" data-analyze-id="${escapeHTML(s.id ?? '')}" type="button">${['unassessed', 'expired'].includes(effectiveSetupStatus(s)) ? 'Analyze' : 'View'}</button></td>
    <td><a class="chart-link" target="_blank" rel="noopener noreferrer" href="${escapeHTML(chartURL(s.exchange, s.symbol))}" aria-label="Open ${escapeHTML(s.symbol)} chart on TradingView">↗</a></td>
  </tr>`).join('');
}

function countersMarkup(signals) {
  const groups = [
    ['early', 'long', 'EARLY LONG', 'teal'], ['early', 'short', 'EARLY SHORT', 'coral'],
    ['confirmed', 'long', 'CROSS LONG', 'green'], ['confirmed', 'short', 'CROSS SHORT', 'red']
  ];
  return groups.map(([type, side, label, tone]) => `<div class="counter"><span class="counter-mark ${tone}"></span><div><div class="counter-number">${signals.filter(s => s.type === type && s.side === side).length}</div><div class="counter-label">${label}</div></div></div>`).join('');
}

function tryLoadFilters() {
  try { return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem('perp-pulse-filters-v1') ?? '{}') }; }
  catch { return { ...DEFAULT_FILTERS }; }
}

function tryLoadRiskInputs() {
  try { return { ...DEFAULT_RISK_INPUTS, ...JSON.parse(localStorage.getItem('perp-pulse-risk-v3') ?? '{}') }; }
  catch { return { ...DEFAULT_RISK_INPUTS }; }
}

function refresh(root) {
  const local = root._perpPulse;
  const state = local.state;
  const result = filterAndSortSignals(state.signals ?? [], local.filters);
  local.filteredSignals = result.slice(0, 500);
  const byId = id => root.querySelector(`#${id}`);
  byId('metric-eligible').textContent = number(state.eligible, 0);
  byId('metric-ready').textContent = number(state.ready, 0);
  byId('metric-queued').textContent = number(state.queued, 0);
  byId('metric-issues').innerHTML = `${number(state.failed, 0)} <small>/ ${number(state.stale, 0)}</small>`;
  byId('coverage-progress').style.width = `${state.eligible ? Math.min(100, (state.ready + state.failed) / state.eligible * 100) : 0}%`;
  byId('scan-status').textContent = state.running ? `● ${state.queued ? 'INITIALIZING' : state.stale ? 'DEGRADED' : 'MONITORING'}` : '● STANDBY';
  byId('scan-status').className = `scan-status ${state.running ? 'active' : ''}`;
  byId('scan-toggle').innerHTML = state.running ? '■ &nbsp; Stop scanning' : '▶ &nbsp; Start scanning';
  byId('notify-toggle').textContent = local.notifications ? '✓ Alerts enabled' : '♧  Enable alerts';
  byId('sound-toggle').classList.toggle('sound-on', local.sound);
  byId('sound-toggle').title = local.sound ? 'Sound is on' : 'Sound is off';
  byId('providers').innerHTML = providerMarkup(state.providers ?? {});
  byId('provider-count').textContent = `${Object.values(state.providers ?? {}).filter(p => p.status === 'live').length}/3`;
  byId('signal-counters').innerHTML = countersMarkup(state.signals ?? []);
  byId('match-count').textContent = result.length;
  byId('signals-body').innerHTML = rowsMarkup(result);
  const copy = dashboardCopy(state, result.length);
  byId('empty-message').textContent = copy;
  byId('empty-message').hidden = result.length > 0;
  byId('results-summary').textContent = `Showing ${Math.min(500, result.length)} of ${result.length} matching signals · ${state.ready}/${state.eligible} markets initialized`;
  byId('export-button').disabled = !result.length;
  byId('local-clock').textContent = new Date().toLocaleString([], { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  const details = byId('trade-setup-content');
  const selectedSignal = state.signals?.find(signal => signal.id === local.selectedSignalId);
  if (!details.contains(document.activeElement) || !document.activeElement?.matches?.('[data-risk]')) {
    details.innerHTML = tradeSetupMarkup(selectedSignal, local.riskInputs);
  }
}

export function renderDashboard(root, state, dispatch = () => {}) {
  if (!root._perpPulse) {
    root.innerHTML = skeleton();
    const filters = tryLoadFilters();
    root._perpPulse = { state, dispatch, filters, riskInputs: tryLoadRiskInputs(),
      selectedSignalId: null, filteredSignals: [], notifications: false, sound: false };
    root.querySelectorAll('[data-filter]').forEach(input => { input.value = filters[input.dataset.filter] ?? 'all'; });
    root.addEventListener('click', event => {
      const analyzeId = event.target.closest('button[data-analyze-id]')?.dataset.analyzeId;
      if (analyzeId) {
        root._perpPulse.selectedSignalId = analyzeId;
        const signal = root._perpPulse.state.signals?.find(s => s.id === analyzeId);
        const refreshRequested = event.target.closest('button[data-refresh-assessment="true"]') !== null;
        if (signal && (refreshRequested || ['unassessed', 'unavailable', 'expired'].includes(effectiveSetupStatus(signal)))) {
          root._perpPulse.dispatch('assess', analyzeId);
        }
        refresh(root);
        if (event.target.closest('tr')) root.querySelector('#trade-setup')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      const id = event.target.closest('button')?.id;
      if (!id) return;
      if (id === 'scan-toggle') root._perpPulse.dispatch(root._perpPulse.state.running ? 'stop' : 'start');
      if (id === 'notify-toggle') root._perpPulse.dispatch('notification');
      if (id === 'sound-toggle') root._perpPulse.dispatch('sound');
      if (id === 'export-button') root._perpPulse.dispatch('export', root._perpPulse.filteredSignals);
    });
    root.addEventListener('input', event => {
      const key = event.target.dataset.filter;
      if (key === 'search') {
        root._perpPulse.filters.search = event.target.value;
        refresh(root);
      }
    });
    root.addEventListener('change', event => {
      const risk = event.target.dataset.risk;
      if (risk) {
        const value = Number(event.target.value);
        if (Number.isFinite(value) && value >= 0) {
          root._perpPulse.riskInputs[risk] = value;
          try { localStorage.setItem('perp-pulse-risk-v3', JSON.stringify(root._perpPulse.riskInputs)); } catch {}
        }
        // The change event may fire while the input still owns focus; repaint the plan now.
        event.target.blur();
        refresh(root);
        return;
      }
      const key = event.target.dataset.filter;
      if (key && key !== 'search') {
        root._perpPulse.filters[key] = event.target.value;
        refresh(root);
      }
      if (key) { try { localStorage.setItem('perp-pulse-filters-v1', JSON.stringify(root._perpPulse.filters)); } catch {} }
      const setting = event.target.dataset.setting;
      if (setting) {
        const value = Number(event.target.value);
        if (Number.isFinite(value) && value >= 0) root._perpPulse.dispatch('settings', { [setting]: value });
      }
    });
  }
  root._perpPulse.state = state;
  root._perpPulse.dispatch = dispatch;
  root.querySelectorAll('[data-setting]').forEach(input => {
    if (document.activeElement !== input && String(input.value) !== String(state.settings?.[input.dataset.setting])) {
      input.value = state.settings?.[input.dataset.setting] ?? '';
    }
  });
  refresh(root);
}

export function updateAlertUI(root, { notifications, sound }) {
  if (!root._perpPulse) return;
  root._perpPulse.notifications = !!notifications;
  root._perpPulse.sound = !!sound;
  root.querySelector('#notify-toggle').textContent = notifications ? '✓ Alerts enabled' : '♧  Enable alerts';
  root.querySelector('#sound-toggle').classList.toggle('sound-on', !!sound);
  root.querySelector('#sound-toggle').title = sound ? 'Sound is on' : 'Sound is off';
}
