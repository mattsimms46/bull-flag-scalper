'use strict';

/**
 * alpaca-history.js  —  WickED Historical Bars Fetcher + Cache
 * ============================================================================
 * Pulls historical OHLCV bars from Alpaca's Market Data API and caches them
 * locally, so the backtest replay engine fetches once and tests many times.
 *
 * This module is DATA-ONLY. It uses your Alpaca *market data* key/secret and
 * never touches trading endpoints. It cannot place an order. Safe to run
 * against your live data keys; it reads, never writes to your account.
 *
 * ENDPOINT (verified against Alpaca docs):
 *   GET https://data.alpaca.markets/v2/stocks/bars
 *   headers: APCA-API-KEY-ID, APCA-API-SECRET-KEY
 *   required params: symbols, timeframe
 *   limit: up to 10000 data points/page (TOTAL across symbols, not per symbol)
 *   pagination: response.next_page_token -> pass back as page_token until null
 *   feed: 'sip' (all US exchanges — your Algo Trader Plus plan) | 'iex' (free)
 *   adjustment: default here = 'split' so reverse-split penny names don't show
 *               fake price cliffs (critical for low-float backtesting integrity)
 *
 * ENV REQUIRED (Railway — never hardcode, never in the repo, never in chat):
 *   ALPACA_API_KEY      market data key id
 *   ALPACA_API_SECRET   market data secret key
 *
 * CACHE: one JSONL file per (symbol, timeframe, feed, adjustment). Bars are
 * append-only lines; a manifest tracks coverage so re-runs only fetch gaps.
 *
 * No npm dependencies. Node 18+.
 *
 * CLI:
 *   node alpaca-history.js SOUN 1Min 2024-01-01 2024-03-01
 *   node alpaca-history.js SOUN,BBAI 5Min 2024-01-01 2024-06-01 --feed sip
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DATA_BASE = 'https://data.alpaca.markets/v2/stocks/bars';

const ALPACA_API_KEY    = process.env.ALPACA_API_KEY;
const ALPACA_API_SECRET = process.env.ALPACA_API_SECRET;

const CONFIG = {
  feed: 'sip',            // 'sip' (full, paid) | 'iex' (free, ~3% volume)
  adjustment: 'split',    // 'raw' | 'split' | 'dividend' | 'all'
  pageLimit: 10000,       // max data points per page (API ceiling)
  cacheDir: process.env.WICKED_HISTORY_DIR || path.join(process.cwd(), 'data', 'history'),
  maxRetries: 4,          // on 429 / 5xx
  baseBackoffMs: 1000,    // exponential: 1s, 2s, 4s, 8s
  requestTimeoutMs: 30000,
};

// ──────────────────────────────────────────────────────────────────────────
// Low-level: one page request with retry/backoff on 429 + 5xx
// ──────────────────────────────────────────────────────────────────────────
async function fetchBarsPage(params) {
  if (!ALPACA_API_KEY || !ALPACA_API_SECRET) {
    throw new Error('ALPACA_API_KEY / ALPACA_API_SECRET not set (configure in Railway env)');
  }
  const qs = new URLSearchParams(params).toString();
  const url = `${DATA_BASE}?${qs}`;

  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG.requestTimeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'APCA-API-KEY-ID': ALPACA_API_KEY,
          'APCA-API-SECRET-KEY': ALPACA_API_SECRET,
          'Accept': 'application/json',
        },
        signal: ctrl.signal,
      });

      if (res.status === 429 || res.status >= 500) {
        if (attempt < CONFIG.maxRetries) {
          const wait = CONFIG.baseBackoffMs * 2 ** attempt;
          console.warn(`[alpaca-history] ${res.status} — retry ${attempt + 1}/${CONFIG.maxRetries} in ${wait}ms`);
          await sleep(wait);
          continue;
        }
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Alpaca bars ${res.status}: ${body.slice(0, 300)}`);
      }
      return await res.json();
    } catch (e) {
      if (attempt < CONFIG.maxRetries && (e.name === 'AbortError' || e.name === 'TypeError')) {
        const wait = CONFIG.baseBackoffMs * 2 ** attempt;
        console.warn(`[alpaca-history] ${e.name} — retry ${attempt + 1}/${CONFIG.maxRetries} in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('[alpaca-history] exhausted retries');
}

// ──────────────────────────────────────────────────────────────────────────
// Fetch ALL bars for a symbol set + timeframe across a date range (paginated).
// Returns { [symbol]: [bar, ...] } with bars normalized to a tidy shape.
// ──────────────────────────────────────────────────────────────────────────
async function fetchHistory(symbols, timeframe, start, end, opts = {}) {
  const feed = opts.feed || CONFIG.feed;
  const adjustment = opts.adjustment || CONFIG.adjustment;
  const symStr = Array.isArray(symbols) ? symbols.join(',') : String(symbols);

  const bySymbol = {};
  let pageToken = null;
  let pages = 0;
  let total = 0;

  do {
    const params = {
      symbols: symStr,
      timeframe,
      start,
      end,
      limit: String(CONFIG.pageLimit),
      adjustment,
      feed,
      sort: 'asc',
    };
    if (pageToken) params.page_token = pageToken;

    const json = await fetchBarsPage(params);
    const bars = json.bars || {};
    for (const [sym, arr] of Object.entries(bars)) {
      if (!bySymbol[sym]) bySymbol[sym] = [];
      for (const b of arr) {
        bySymbol[sym].push(normalizeBar(b));
        total++;
      }
    }
    pageToken = json.next_page_token || null;
    pages++;
    if (pages % 10 === 0) console.log(`[alpaca-history] ${symStr} ${timeframe}: ${pages} pages, ${total} bars so far…`);
  } while (pageToken);

  console.log(`[alpaca-history] ${symStr} ${timeframe} ${start}→${end}: ${total} bars across ${pages} page(s)`);
  return bySymbol;
}

/** Normalize Alpaca's terse bar keys into readable fields. */
function normalizeBar(b) {
  return {
    t: b.t,            // RFC-3339 timestamp (UTC)
    o: b.o, h: b.h, l: b.l, c: b.c,
    v: b.v,            // volume
    n: b.n,            // trade count
    vw: b.vw,          // volume-weighted avg price
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Cache: one JSONL file per (symbol, timeframe, feed, adjustment).
// + a sidecar .meta.json recording covered [start,end] so re-runs skip work.
// ──────────────────────────────────────────────────────────────────────────
function cacheKey(symbol, timeframe, feed, adjustment) {
  return `${symbol}__${timeframe}__${feed}__${adjustment}`.replace(/[^A-Za-z0-9_.-]/g, '_');
}
function cachePaths(symbol, timeframe, feed, adjustment) {
  const base = path.join(CONFIG.cacheDir, cacheKey(symbol, timeframe, feed, adjustment));
  return { jsonl: `${base}.jsonl`, meta: `${base}.meta.json` };
}

/**
 * Fetch + persist history for one symbol. Idempotent: if the requested range is
 * already covered by the cache manifest, it does nothing. Otherwise fetches and
 * appends, then de-dupes by timestamp on read.
 */
async function cacheHistory(symbol, timeframe, start, end, opts = {}) {
  const feed = opts.feed || CONFIG.feed;
  const adjustment = opts.adjustment || CONFIG.adjustment;
  await fsp.mkdir(CONFIG.cacheDir, { recursive: true });
  const { jsonl, meta } = cachePaths(symbol, timeframe, feed, adjustment);

  const manifest = await readMeta(meta);
  if (manifest && coversRange(manifest, start, end)) {
    console.log(`[alpaca-history] cache hit ${symbol} ${timeframe} (${start}→${end} already covered)`);
    return jsonl;
  }

  const data = await fetchHistory(symbol, timeframe, start, end, { feed, adjustment });
  const bars = data[symbol] || [];
  if (bars.length) {
    const lines = bars.map((b) => JSON.stringify(b)).join('\n') + '\n';
    await fsp.appendFile(jsonl, lines, 'utf8');
  }

  // Update manifest coverage (union of old + new range).
  const newStart = manifest ? minDate(manifest.start, start) : start;
  const newEnd = manifest ? maxDate(manifest.end, end) : end;
  await fsp.writeFile(meta, JSON.stringify({
    symbol, timeframe, feed, adjustment,
    start: newStart, end: newEnd,
    updated_at: new Date().toISOString(),
  }, null, 2), 'utf8');

  return jsonl;
}

/** Load cached bars for a symbol, de-duped + sorted ascending by timestamp. */
async function loadCachedBars(symbol, timeframe, opts = {}) {
  const feed = opts.feed || CONFIG.feed;
  const adjustment = opts.adjustment || CONFIG.adjustment;
  const { jsonl } = cachePaths(symbol, timeframe, feed, adjustment);
  let raw;
  try { raw = await fsp.readFile(jsonl, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }

  const seen = new Set();
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let b; try { b = JSON.parse(s); } catch { continue; }
    if (seen.has(b.t)) continue;     // de-dupe overlapping fetches
    seen.add(b.t);
    out.push(b);
  }
  out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Meta helpers
// ──────────────────────────────────────────────────────────────────────────
async function readMeta(metaPath) {
  try { return JSON.parse(await fsp.readFile(metaPath, 'utf8')); }
  catch { return null; }
}
function dnum(d) { return new Date(d).getTime(); }
function coversRange(m, start, end) { return dnum(m.start) <= dnum(start) && dnum(m.end) >= dnum(end); }
function minDate(a, b) { return dnum(a) <= dnum(b) ? a : b; }
function maxDate(a, b) { return dnum(a) >= dnum(b) ? a : b; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  CONFIG,
  fetchHistory,
  cacheHistory,
  loadCachedBars,
  cachePaths,
};

// ──────────────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [, , symArg, tf, start, end, ...rest] = process.argv;
  if (!symArg || !tf || !start || !end) {
    console.log('Usage: node alpaca-history.js <SYMBOLS> <TIMEFRAME> <START> <END> [--feed sip|iex] [--adj raw|split|all]');
    console.log('  e.g. node alpaca-history.js SOUN 1Min 2024-01-01 2024-03-01');
    process.exit(1);
  }
  const feed = argVal(rest, '--feed') || CONFIG.feed;
  const adjustment = argVal(rest, '--adj') || CONFIG.adjustment;
  const symbols = symArg.split(',').map((s) => s.trim().toUpperCase());

  (async () => {
    for (const sym of symbols) {
      await cacheHistory(sym, tf, start, end, { feed, adjustment });
      const bars = await loadCachedBars(sym, tf, { feed, adjustment });
      console.log(`  ${sym}: ${bars.length} bars cached` +
        (bars.length ? ` (${bars[0].t} → ${bars[bars.length - 1].t})` : ''));
    }
  })().catch((e) => { console.error('Fetch failed:', e.message); process.exit(1); });
}

function argVal(arr, flag) {
  const i = arr.indexOf(flag);
  return i >= 0 && i + 1 < arr.length ? arr[i + 1] : null;
}
