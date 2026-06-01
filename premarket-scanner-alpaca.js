'use strict';

/**
 * premarket-scanner-alpaca.js  —  WickED Pre-Market Volume Feed (Alpaca variant)
 * ============================================================================
 * Alpaca port of premarket-scanner.js. "Know what's in play before the open."
 *
 * ── WHERE DO THE KEY AND SECRET GO? ──────────────────────────────────────────
 *   RAILWAY ENVIRONMENT VARIABLES, read here as:
 *     process.env.ALPACA_API_KEY  /  process.env.ALPACA_API_SECRET
 *   Never in code, repo, browser/Worker, or chat. (Same rule as every module.)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ IMPORTANT ARCHITECTURE NOTE — READ BEFORE CHOOSING THIS FILE:
 *   Alpaca has NO pre-market full-market snapshot. Its screener (most-actives /
 *   movers) RESETS AT THE OPEN and shows the prior day until 09:30 — useless for
 *   a 6–9am ET scalp scan. Polygon's snapshot DOES update pre-market (from ~4am).
 *
 *   => RECOMMENDED: keep premarket-scanner.js on POLYGON (it already works and
 *      needs no changes). Use Alpaca for live + history; Polygon for the PM scan.
 *      Use each provider for what it does best.
 *
 *   This Alpaca variant exists because you asked for it. It works by scanning a
 *   PROVIDED candidate universe (you can't screen the whole market pre-market on
 *   Alpaca), pulling each symbol's pre-market bars to compute relative volume.
 *   That means: (a) you must supply a universe list, (b) it makes one batched
 *   bars call. It cannot "discover" a surprise gapper that isn't on your list.
 *
 * INTERFACE (same as the Polygon version, so the scalper consumes it identically):
 *   const pm = require('./premarket-scanner-alpaca');
 *   pm.CONFIG.universe = ['SOUN','BBAI',...];     // REQUIRED for Alpaca variant
 *   await pm.runPremarketScan();                  // one scan now
 *   pm.getPremarketWatchlist(); pm.isInPlay(sym); pm.getInPlayMeta(sym);
 *   pm.schedulePremarketScan();                   // 06:00-ish ET weekday job (see note)
 *
 * Node 18+. No npm deps (native fetch). Telegram via env (optional).
 */

const ALPACA_API_KEY    = process.env.ALPACA_API_KEY;
const ALPACA_API_SECRET = process.env.ALPACA_API_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const DATA_BASE = 'https://data.alpaca.markets';

const CONFIG = {
  // REQUIRED for this variant: the candidate universe to scan (NASDAQ $1–20).
  // Alpaca can't screen the whole market pre-market, so you feed it candidates.
  universe: [],                // e.g. ['SOUN','BBAI','MARA',...]
  feed: 'sip',                 // Algo Trader Plus
  minPrice: 1.0,
  maxPrice: 20.0,
  minPremarketVolume: 50000,
  minRelVol: 0.05,             // preVol / prevDayVol
  topN: 12,
  // schedule (ET weekday) — default 06:00 ET to match the 6–9am scalp block
  scanHourET: 6,
  scanMinuteET: 0,
  requestTimeoutMs: 25000,
};

let _watchlist = [];
let _watchMap = new Map();
let _lastScan = null;

function getPremarketWatchlist() { return _watchlist.slice(); }
function isInPlay(sym) { return _watchMap.has(String(sym).toUpperCase()); }
function getInPlayMeta(sym) { return _watchMap.get(String(sym).toUpperCase()) || null; }
function getLastScanInfo() { return _lastScan; }

// ── Alpaca data helpers (Bearer-style header auth — key/secret NEVER in URL) ──
function authHeaders() {
  if (!ALPACA_API_KEY || !ALPACA_API_SECRET) {
    throw new Error('ALPACA_API_KEY / ALPACA_API_SECRET not set (configure in Railway env)');
  }
  return {
    'APCA-API-KEY-ID': ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': ALPACA_API_SECRET,
    'Accept': 'application/json',
  };
}

async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.requestTimeoutMs);
  try {
    const res = await fetch(url, { headers: authHeaders(), signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Alpaca ${res.status}: ${body.slice(0, 200)}`);
    }
    return await res.json();
  } finally { clearTimeout(timer); }
}

/**
 * Today's pre-market accumulated volume + latest price per symbol.
 * Strategy: pull today's 1Min bars from 04:00 ET and sum volume; last close = price.
 * Batched via the multi-symbol bars endpoint.
 */
async function fetchPremarketBars(symbols, feed) {
  const todayET = etDateKey(new Date());
  // start at 04:00 ET premarket open; Alpaca expects RFC-3339. 04:00 ET ≈ 08:00/09:00 UTC
  // We pass an ET-local start; Alpaca accepts date-time with offset.
  const start = `${todayET}T04:00:00-04:00`; // note: -04:00 EDT; adjust if EST (-05:00)
  const symStr = symbols.join(',');
  const out = {}; // symbol -> { preVol, lastPrice, lastT }
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      symbols: symStr, timeframe: '1Min', start, limit: '10000', feed, sort: 'asc',
    });
    if (pageToken) params.set('page_token', pageToken);
    const json = await getJSON(`${DATA_BASE}/v2/stocks/bars?${params}`);
    const bars = json.bars || {};
    for (const [sym, arr] of Object.entries(bars)) {
      if (!out[sym]) out[sym] = { preVol: 0, lastPrice: null, lastT: null };
      for (const b of arr) {
        out[sym].preVol += b.v || 0;
        out[sym].lastPrice = b.c;
        out[sym].lastT = b.t;
      }
    }
    pageToken = json.next_page_token || null;
  } while (pageToken);

  return out;
}

/** Previous trading day's total volume + close, per symbol (1Day bars, last 2). */
async function fetchPrevDay(symbols, feed) {
  const symStr = symbols.join(',');
  const params = new URLSearchParams({
    symbols: symStr, timeframe: '1Day', limit: '2', feed, sort: 'desc',
  });
  const json = await getJSON(`${DATA_BASE}/v2/stocks/bars?${params}`);
  const bars = json.bars || {};
  const out = {};
  for (const [sym, arr] of Object.entries(bars)) {
    // sort desc => arr[0] is most recent CLOSED day (yesterday during pre-market)
    const prev = arr[0];
    if (prev) out[sym] = { prevVol: prev.v || 0, prevClose: prev.c };
  }
  return out;
}

// ── scoring (mirrors the Polygon version) ────────────────────────────────────
function scoreCandidate(sym, pm, pd) {
  if (!pm || pm.lastPrice == null) return null;
  const price = pm.lastPrice;
  if (price < CONFIG.minPrice || price > CONFIG.maxPrice) return null;
  if (pm.preVol < CONFIG.minPremarketVolume) return null;

  const prevVol = pd ? pd.prevVol : 0;
  const prevClose = pd ? pd.prevClose : null;
  const relVol = prevVol > 0 ? pm.preVol / prevVol : 0;
  if (relVol < CONFIG.minRelVol) return null;

  const gapPct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
  const score = relVol * 100 + Math.abs(gapPct) * 0.5;

  return {
    symbol: sym, price: round(price, 2),
    prevClose: prevClose != null ? round(prevClose, 2) : null,
    gapPct: round(gapPct, 1), direction: gapPct >= 0 ? 'up' : 'down',
    bias: gapPct >= 0 ? 'long' : 'short',
    premarketVolume: pm.preVol, prevDayVolume: prevVol,
    relVol: round(relVol, 3), relVolPctOfDay: round(relVol * 100, 1),
    score: round(score, 2),
  };
}

async function runPremarketScan({ notify = true } = {}) {
  if (!CONFIG.universe.length) {
    throw new Error('Alpaca variant requires CONFIG.universe (a candidate symbol list). ' +
      'Alpaca cannot screen the whole market pre-market — see file header. ' +
      'Consider keeping the Polygon scanner for this instead.');
  }
  const started = new Date();
  const feed = CONFIG.feed;
  const [pmMap, pdMap] = await Promise.all([
    fetchPremarketBars(CONFIG.universe, feed),
    fetchPrevDay(CONFIG.universe, feed),
  ]);

  const scored = [];
  for (const sym of CONFIG.universe) {
    const c = scoreCandidate(sym, pmMap[sym], pdMap[sym]);
    if (c) scored.push(c);
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, CONFIG.topN);

  _watchlist = top;
  _watchMap = new Map(top.map((c) => [c.symbol, c]));
  _lastScan = { at: started.toISOString(), scanned: CONFIG.universe.length, qualified: scored.length };

  console.log(`[premarket-alpaca] ${etStamp(started)} — universe ${CONFIG.universe.length}, ` +
    `${scored.length} qualified, top ${top.length} cached`);

  if (notify) {
    try { await sendTelegram(formatBrief(top)); }
    catch (e) { console.error('[premarket-alpaca] telegram:', e.message); }
  }
  return top;
}

// ── Telegram (optional) ──────────────────────────────────────────────────────
function formatBrief(list) {
  const header = `📊 PRE-MARKET (Alpaca) — what's in play (${etStamp(new Date(), true)} ET)`;
  if (!list.length) return `${header}\n\nNothing clearing filters in the universe yet.`;
  const lines = list.map((c, i) => {
    const arrow = c.direction === 'up' ? '▲' : '▼';
    const gap = `${c.gapPct >= 0 ? '+' : ''}${c.gapPct}%`;
    return `${String(i + 1).padStart(2, ' ')}. $${c.symbol}  ${arrow} ${gap}  @ $${c.price}\n` +
           `     ${c.relVolPctOfDay}% of yest vol · ${humanVol(c.premarketVolume)} PM`;
  });
  return `${header}\n\n${lines.join('\n')}\n\n⚡ Scalp window 06:00–09:00 ET.`;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.warn('[premarket-alpaca] telegram env missing'); return; }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}`);
}

// ── scheduler (ET weekday) ────────────────────────────────────────────────────
let _timer = null, _lastDay = null;
function schedulePremarketScan() {
  if (_timer) return;
  console.log(`[premarket-alpaca] scheduled ${pad(CONFIG.scanHourET)}:${pad(CONFIG.scanMinuteET)} ET weekdays`);
  _timer = setInterval(() => {
    const et = nowET();
    if (et.getDay() === 0 || et.getDay() === 6) return;
    if (et.getHours() !== CONFIG.scanHourET || et.getMinutes() !== CONFIG.scanMinuteET) return;
    const key = et.toDateString();
    if (_lastDay === key) return;
    _lastDay = key;
    runPremarketScan().catch((e) => console.error('[premarket-alpaca] scan:', e.message));
  }, 30000);
  return _timer;
}
function stopPremarketScan() { if (_timer) { clearInterval(_timer); _timer = null; } }

// ── helpers ───────────────────────────────────────────────────────────────────
function nowET() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })); }
function etDateKey(d) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(d); // YYYY-MM-DD
}
function etStamp(d, clockOnly = false) {
  const opts = clockOnly
    ? { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }
    : { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };
  return new Intl.DateTimeFormat('en-US', opts).format(d);
}
function round(v, dp) { const f = 10 ** dp; return Math.round(v * f) / f; }
function pad(n) { return String(n).padStart(2, '0'); }
function humanVol(v) {
  if (v >= 1e9) return `${round(v / 1e9, 1)}B`;
  if (v >= 1e6) return `${round(v / 1e6, 1)}M`;
  if (v >= 1e3) return `${round(v / 1e3, 0)}K`;
  return String(v);
}

module.exports = {
  CONFIG, runPremarketScan, schedulePremarketScan, stopPremarketScan,
  getPremarketWatchlist, isInPlay, getInPlayMeta, getLastScanInfo,
};

if (require.main === module) {
  if (!CONFIG.universe.length) {
    console.log('Set CONFIG.universe to a symbol list to run. (Alpaca needs a candidate universe pre-market.)');
    console.log('exports:', Object.keys(module.exports).join(', '));
    process.exit(0);
  }
  runPremarketScan({ notify: process.argv.includes('--notify') })
    .then((top) => { console.table(top.map((c) => ({ sym: c.symbol, price: c.price, gap: `${c.gapPct}%`, relVol: `${c.relVolPctOfDay}%`, score: c.score }))); process.exit(0); })
    .catch((e) => { console.error('Scan failed:', e.message); process.exit(1); });
}
