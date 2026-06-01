'use strict';

/**
 * sector-scanner.js  —  WickED Sector Rotation Scanner
 * ============================================================================
 * Ranks the 11 SPDR Select Sector ETFs by relative strength vs SPY, identifies
 * leading/lagging sectors, maps them to top liquid names, sends an 8am ET
 * Telegram brief, and refreshes every 30 min during market hours.
 *
 * ── WHERE DO THE KEY AND SECRET GO? ──────────────────────────────────────────
 *   RAILWAY ENVIRONMENT VARIABLES, read here as
 *     process.env.ALPACA_API_KEY / process.env.ALPACA_API_SECRET
 *   Never in code, repo, browser/Worker, or chat.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * HONESTY NOTES (no look-ahead):
 *   - Relative strength = ETF return − SPY return over the SAME window.
 *   - At 8am ET the market is CLOSED. Pre-market sector-ETF volume is thin and
 *     noisy (XLU/XLRE barely trade). So the brief LABELS its data basis:
 *       'premarket' (some PM prints today) or 'prior_session' (none yet).
 *     Treat an 8am read as a directional lean, not gospel. The 30-min intraday
 *     refreshes are the reliable ones.
 *   - We never use a bar that hasn't closed. "Today's return" uses the latest
 *     available close vs the prior official daily close.
 *
 * EXPORTS for scanner use:
 *   getLeadingSectors()   -> [{etf, name, relStrength, names:[...]}, ...] (top 2)
 *   getLaggingSectors()   -> bottom 2
 *   getSectorRanking()    -> full ranked array
 *   isLeaderStock(symbol) -> bool (symbol is a top name in a leading sector)
 *   getStockSector(symbol)-> etf or null
 *   getLastUpdate()       -> { at, basis }
 *
 * Node 18+. No npm deps (native fetch). Telegram optional via env.
 */

const ALPACA_API_KEY    = process.env.ALPACA_API_KEY;
const ALPACA_API_SECRET = process.env.ALPACA_API_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const DATA_BASE = 'https://data.alpaca.markets';

// ── The 11 SPDR Select Sector ETFs + top liquid names (S&P 500 sector leaders) ─
// Names are large, liquid sector bellwethers — used for isLeaderStock() and to
// seed the ORB/reversal universe with leading-sector stocks.
const SECTORS = {
  XLK:  { name: 'Technology',             names: ['NVDA', 'MSFT', 'AAPL', 'AVGO', 'AMD'] },
  XLF:  { name: 'Financials',             names: ['JPM', 'BAC', 'WFC', 'GS', 'MS'] },
  XLE:  { name: 'Energy',                 names: ['XOM', 'CVX', 'COP', 'SLB', 'OXY'] },
  XLV:  { name: 'Health Care',            names: ['LLY', 'UNH', 'JNJ', 'ABBV', 'MRK'] },
  XLI:  { name: 'Industrials',            names: ['GE', 'CAT', 'RTX', 'UBER', 'BA'] },
  XLY:  { name: 'Consumer Discretionary', names: ['AMZN', 'TSLA', 'HD', 'MCD', 'BKNG'] },
  XLP:  { name: 'Consumer Staples',       names: ['WMT', 'COST', 'PG', 'KO', 'PEP'] },
  XLU:  { name: 'Utilities',              names: ['NEE', 'SO', 'DUK', 'CEG', 'AEP'] },
  XLB:  { name: 'Materials',              names: ['LIN', 'SHW', 'FCX', 'ECL', 'NEM'] },
  XLRE: { name: 'Real Estate',            names: ['PLD', 'AMT', 'EQIX', 'WELL', 'SPG'] },
  XLC:  { name: 'Communication Services', names: ['META', 'GOOGL', 'NFLX', 'DIS', 'T'] },
};
const BENCHMARK = 'SPY';

const CONFIG = {
  feed: 'sip',
  topLeaders: 2,
  bottomLaggards: 2,
  refreshMinutes: 30,
  briefHourET: 8,
  briefMinuteET: 0,
  requestTimeoutMs: 25000,
  // build the leader-stock universe from this many top sectors:
  leaderUniverseFromTopN: 2,
};

// ── live state ───────────────────────────────────────────────────────────────
let _ranking = [];            // full ranked array (desc by relStrength)
let _leaderStockSet = new Set();
let _stockToSector = new Map();
let _lastUpdate = null;       // { at, basis }

(function buildStockSectorMap() {
  for (const [etf, info] of Object.entries(SECTORS)) {
    for (const sym of info.names) _stockToSector.set(sym, etf);
  }
})();

function getSectorRanking() { return _ranking.slice(); }
function getLeadingSectors() { return _ranking.slice(0, CONFIG.topLeaders); }
function getLaggingSectors() { return _ranking.slice(-CONFIG.bottomLaggards).reverse(); }
function isLeaderStock(symbol) { return _leaderStockSet.has(String(symbol).toUpperCase()); }
function getStockSector(symbol) { return _stockToSector.get(String(symbol).toUpperCase()) || null; }
function getLastUpdate() { return _lastUpdate; }

// ── Alpaca data ───────────────────────────────────────────────────────────────
function authHeaders() {
  if (!ALPACA_API_KEY || !ALPACA_API_SECRET) {
    throw new Error('ALPACA_API_KEY / ALPACA_API_SECRET not set (configure in Railway env)');
  }
  return { 'APCA-API-KEY-ID': ALPACA_API_KEY, 'APCA-API-SECRET-KEY': ALPACA_API_SECRET, 'Accept': 'application/json' };
}
async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.requestTimeoutMs);
  try {
    const res = await fetch(url, { headers: authHeaders(), signal: ctrl.signal });
    if (!res.ok) { const b = await res.text().catch(() => ''); throw new Error(`Alpaca ${res.status}: ${b.slice(0, 200)}`); }
    return await res.json();
  } finally { clearTimeout(timer); }
}

/**
 * Compute each symbol's return basis:
 *   prior official daily close  (the denominator)
 *   latest available price      (most recent 1Min close incl. pre-market, else
 *                                today's/most-recent daily close)
 * Returns { [sym]: { prevClose, last, basis } }.
 * basis: 'premarket' if we used a pre-market/intraday minute bar from today,
 *        'prior_session' if only daily closes were available.
 */
async function fetchReturns(symbols) {
  const symStr = symbols.join(',');

  // (1) last 3 daily bars (desc) -> prior official close.
  const daily = await getJSON(`${DATA_BASE}/v2/stocks/bars?` + new URLSearchParams({
    symbols: symStr, timeframe: '1Day', limit: '3', feed: CONFIG.feed, sort: 'desc',
  }));
  const dayBars = daily.bars || {};

  // (2) latest minute bar today (incl. pre-market) -> latest price, if any.
  const todayET = etDateKey(new Date());
  const offset = etUtcOffset(new Date());          // '-04:00' or '-05:00'
  const min = await getJSON(`${DATA_BASE}/v2/stocks/bars?` + new URLSearchParams({
    symbols: symStr, timeframe: '1Min', start: `${todayET}T04:00:00${offset}`,
    limit: '10000', feed: CONFIG.feed, sort: 'desc',
  })).catch(() => ({ bars: {} }));
  const minBars = min.bars || {};

  const out = {};
  for (const sym of symbols) {
    const dArr = dayBars[sym] || [];               // desc: [today-or-latest, prior, ...]
    if (!dArr.length) continue;

    // Determine the prior official close. If the most recent daily bar is TODAY,
    // the prior close is dArr[1]; otherwise the most recent daily IS the prior close.
    const mostRecentDailyDate = etDateKey(new Date(dArr[0].t));
    let prevClose, todayDailyClose = null;
    if (mostRecentDailyDate === todayET) {
      todayDailyClose = dArr[0].c;
      prevClose = dArr[1] ? dArr[1].c : null;
    } else {
      prevClose = dArr[0].c;
    }
    if (prevClose == null) continue;

    // Latest price: newest minute bar today if present, else today's daily close,
    // else most-recent daily close (pure prior-session fallback).
    const mArr = minBars[sym] || [];
    let last, basis;
    if (mArr.length) { last = mArr[0].c; basis = 'premarket'; }
    else if (todayDailyClose != null) { last = todayDailyClose; basis = 'intraday_daily'; }
    else { last = prevClose; basis = 'prior_session'; }

    out[sym] = { prevClose, last, basis, retPct: ((last - prevClose) / prevClose) * 100 };
  }
  return out;
}

// ── core scan ─────────────────────────────────────────────────────────────────
async function runSectorScan({ notify = false } = {}) {
  const symbols = [BENCHMARK, ...Object.keys(SECTORS)];
  const rets = await fetchReturns(symbols);

  const spy = rets[BENCHMARK];
  if (!spy) throw new Error('No SPY data returned — cannot compute relative strength');
  const spyRet = spy.retPct;

  const ranking = [];
  let anyPremarket = false;
  for (const [etf, info] of Object.entries(SECTORS)) {
    const r = rets[etf];
    if (!r) continue;
    if (r.basis === 'premarket') anyPremarket = true;
    ranking.push({
      etf, name: info.name, names: info.names,
      etfReturn: round(r.retPct, 2),
      relStrength: round(r.retPct - spyRet, 2),   // outperformance vs SPY
      basis: r.basis,
    });
  }
  ranking.sort((a, b) => b.relStrength - a.relStrength);

  // update state
  _ranking = ranking;
  const basis = anyPremarket ? 'premarket' : (spy.basis === 'intraday_daily' ? 'intraday' : 'prior_session');
  _lastUpdate = { at: new Date().toISOString(), basis, spyReturn: round(spyRet, 2) };

  // rebuild leader-stock universe from top N sectors
  _leaderStockSet = new Set();
  for (const s of ranking.slice(0, CONFIG.leaderUniverseFromTopN)) {
    for (const sym of s.names) _leaderStockSet.add(sym);
  }

  console.log(`[sector] ${etStamp(new Date())} basis=${basis} SPY ${spyRet >= 0 ? '+' : ''}${round(spyRet, 2)}% — ` +
    `lead: ${ranking.slice(0, 2).map(s => s.etf).join(',')} | lag: ${ranking.slice(-2).map(s => s.etf).join(',')}`);

  if (notify) { try { await sendTelegram(formatBrief(ranking, basis, spyRet)); } catch (e) { console.error('[sector] telegram:', e.message); } }
  return ranking;
}

// ── Telegram brief ────────────────────────────────────────────────────────────
function formatBrief(ranking, basis, spyRet) {
  const basisLabel = {
    premarket: '⚠ pre-market (thin volume — directional only)',
    intraday: 'intraday',
    prior_session: '⚠ prior session (no data yet today)',
  }[basis] || basis;

  const leaders = ranking.slice(0, CONFIG.topLeaders);
  const laggards = ranking.slice(-CONFIG.bottomLaggards).reverse();

  const fmtRel = (v) => `${v >= 0 ? '+' : ''}${v}%`;
  const lead = leaders.map((s, i) =>
    `${i + 1}. ${s.etf} ${s.name}  RS ${fmtRel(s.relStrength)}\n     ${s.names.join(' · ')}`).join('\n');
  const lag = laggards.map((s, i) =>
    `${i + 1}. ${s.etf} ${s.name}  RS ${fmtRel(s.relStrength)}`).join('\n');

  return `🧭 SECTOR BRIEF — ${etStamp(new Date(), true)} ET\n` +
    `basis: ${basisLabel}\nSPY ${spyRet >= 0 ? '+' : ''}${round(spyRet, 2)}%\n\n` +
    `🟢 LEADING (focus longs here):\n${lead}\n\n` +
    `🔴 LAGGING:\n${lag}\n\n` +
    `Leader-stock universe seeded from top ${CONFIG.leaderUniverseFromTopN} sectors.`;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.warn('[sector] telegram env missing'); return; }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}`);
}

// ── scheduler: 8am ET brief + 30-min refresh during market hours ──────────────
let _timer = null, _lastBriefDay = null;
function start() {
  if (_timer) return;
  console.log(`[sector] started — 8am ET brief + ${CONFIG.refreshMinutes}min refresh during RTH`);
  // immediate first scan (no notify) so getters are populated on boot
  runSectorScan({ notify: false }).catch((e) => console.error('[sector] boot scan:', e.message));

  _timer = setInterval(() => {
    const et = nowET();
    const dow = et.getDay();
    if (dow === 0 || dow === 6) return;
    const h = et.getHours(), m = et.getMinutes();

    // 8am brief (once per day, with Telegram notify)
    if (h === CONFIG.briefHourET && m === CONFIG.briefMinuteET) {
      const key = et.toDateString();
      if (_lastBriefDay !== key) {
        _lastBriefDay = key;
        runSectorScan({ notify: true }).catch((e) => console.error('[sector] brief:', e.message));
        return;
      }
    }
    // 30-min refresh during market hours (09:30–16:00), silent
    const minutesSinceOpen = (h * 60 + m) - (9 * 60 + 30);
    if (minutesSinceOpen >= 0 && minutesSinceOpen <= 390 && m % CONFIG.refreshMinutes === 0) {
      runSectorScan({ notify: false }).catch((e) => console.error('[sector] refresh:', e.message));
    }
  }, 60000); // check each minute
  return _timer;
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

// ── time helpers (ET) ─────────────────────────────────────────────────────────
function nowET() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })); }
function etDateKey(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
// Determine ET UTC offset ('-04:00' EDT / '-05:00' EST) for a given date.
function etUtcOffset(d) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(d).find(p => p.type === 'timeZoneName')?.value || 'GMT-5';
  const m = s.match(/GMT([+-]\d{1,2})/);
  const hh = m ? String(Math.abs(parseInt(m[1], 10))).padStart(2, '0') : '05';
  const sign = m && m[1].startsWith('-') ? '-' : '-';
  return `${sign}${hh}:00`;
}
function etStamp(d, clockOnly = false) {
  const opts = clockOnly
    ? { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }
    : { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };
  return new Intl.DateTimeFormat('en-US', opts).format(d);
}
function round(v, dp) { if (v == null || !isFinite(v)) return null; const f = 10 ** dp; return Math.round(v * f) / f; }

module.exports = {
  SECTORS, CONFIG,
  runSectorScan, start, stop,
  getSectorRanking, getLeadingSectors, getLaggingSectors,
  isLeaderStock, getStockSector, getLastUpdate,
};

// ── CLI: one scan now (add --notify to send Telegram) ─────────────────────────
if (require.main === module) {
  if (!ALPACA_API_KEY || !ALPACA_API_SECRET) {
    console.log('Set ALPACA_API_KEY / ALPACA_API_SECRET in env to run a live scan.');
    console.log('exports:', Object.keys(module.exports).join(', '));
    console.log('sectors:', Object.keys(SECTORS).join(', '));
    process.exit(0);
  }
  runSectorScan({ notify: process.argv.includes('--notify') })
    .then((r) => {
      console.log(`\nbasis: ${_lastUpdate.basis} | SPY ${_lastUpdate.spyReturn}%\n`);
      console.table(r.map((s) => ({ etf: s.etf, sector: s.name, etfRet: `${s.etfReturn}%`, RS_vs_SPY: `${s.relStrength}%` })));
      console.log('\nLeading:', getLeadingSectors().map(s => s.etf).join(', '));
      console.log('Lagging:', getLaggingSectors().map(s => s.etf).join(', '));
      console.log('Leader universe:', [..._leaderStockSet].join(', '));
      process.exit(0);
    })
    .catch((e) => { console.error('Scan failed:', e.message); process.exit(1); });
}
