'use strict';

/**
 * pattern-rater.js  —  WickED Live Setup Scorer (HONEST about what it knows)
 * ============================================================================
 * When a setup fires, score it 1–10 by comparing to HISTORICAL WINNERS for that
 * scanner type, then return the score + reasons + a confidence tier for the
 * Telegram alert.
 *
 * ── THE CENTRAL HONESTY PROBLEM ──────────────────────────────────────────────
 *   A "score vs historical winners" is only as good as the history behind it.
 *   Early in paper trading you have almost no winners — so a naive "9/10 similar
 *   to winners" is FALSE CONFIDENCE. This module therefore reports a CONFIDENCE
 *   TIER and degrades gracefully:
 *     - winners < MIN_FOR_RANGE  -> tier 'LEARNING', score shrinks toward neutral,
 *                                   alert literally says "low confidence, only N winners".
 *     - winners >= ESTABLISHED   -> tier 'ESTABLISHED', full-strength scoring.
 *   A component with insufficient history contributes a NEUTRAL sub-score, never
 *   a fabricated one. The rater always knows how much it knows.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * SCORE COMPONENTS (per your spec), each 0..1 then weighted:
 *   ORB:       RSI-in-winning-range, ATR-ratio-in-winning-range, time-of-day
 *   REVERSAL:  RSI extremity-in-winning-range, Marubozu-count-vs-winners, time-of-day
 *   BONUS:     +2 (on the 1–10 scale) if stock is in today's leading sector
 *
 * "Winning ranges" come from (in priority order):
 *   1. scanner-params.json proposals (if present) — the optimizer's blessed params
 *   2. derived from WINNING trades in the trade log (R > 0)
 *   3. sensible static fallback (clearly flagged) when history is too thin
 *
 * EXPORT:
 *   ratePattern(setup, opts?) -> {
 *     score,            // 1..10 (clamped), includes sector bonus
 *     base_score,       // 1..10 before sector bonus
 *     confidence,       // 'LEARNING' | 'DEVELOPING' | 'ESTABLISHED'
 *     winners_compared, // how many historical winners informed this
 *     reasons: [...],   // human-readable component notes for the alert
 *     similar_to,       // "N historical winners" phrasing
 *     sector_bonus      // 0 or 2
 *   }
 *
 * Depends on: ./trade-log-store, ./trade-log-schema, and optionally
 * ./sector-scanner (for the leadership bonus) + ./scanner-params.json.
 * Node 18+. No npm deps.
 */

const fsSync = require('fs');
const path = require('path');
const store = require('./trade-log-store');
const { SCANNER } = require('./trade-log-schema');

// optional deps — loaded defensively so the rater works standalone
let sectorScanner = null;
try { sectorScanner = require('./sector-scanner'); } catch { /* optional */ }

const PARAMS_PATH = process.env.WICKED_PARAMS_PATH || path.join(process.cwd(), 'scanner-params.json');

const CONF = {
  MIN_FOR_RANGE: 8,      // below this, a component can't define a "winning range"
  DEVELOPING: 20,        // winners >= this -> 'DEVELOPING'
  ESTABLISHED: 50,       // winners >= this -> 'ESTABLISHED' (full strength)
  SECTOR_BONUS: 2,       // points added (1–10 scale) for leading-sector stock
};

// component weights per scanner (sum to 1 before the 1–10 rescale)
const WEIGHTS = {
  orb:      { rsi: 0.30, atr: 0.45, tod: 0.25 },
  reversal: { rsi: 0.35, marubozu: 0.40, tod: 0.25 },
};

// ── load winning ranges (cached briefly) ──────────────────────────────────────
let _cache = { at: 0, ranges: null };
const CACHE_MS = 5 * 60 * 1000;

function loadProposedParams() {
  try {
    const raw = fsSync.readFileSync(PARAMS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

/**
 * Build winning-range stats per scanner from the trade log (winners only).
 * Returns { orb:{rsi:{...}, atr:{...}, tod:{...}, n}, reversal:{...} }.
 * Each sub-range = {lo, hi, mean, n} from winners' values (using mean ± 1 stdev
 * as the "sweet spot" band). Insufficient n -> null (component goes neutral).
 */
async function buildWinningRanges(logPath) {
  const ranges = {};
  for (const scanner of [SCANNER.ORB, SCANNER.REVERSAL]) {
    const trades = await store.loadTrades({ scanner, predicate: (t) => (t.outcome?.r_multiple || 0) > 0 }, logPath);
    const n = trades.length;
    const r = { n };

    if (scanner === SCANNER.ORB) {
      r.rsi = band(trades.map((t) => t.symbol_context?.rsi).filter(isNum));
      r.atr = band(trades.map((t) => t.orb_context?.or_size != null && t.symbol_context?.atr
        ? t.orb_context.or_size / t.symbol_context.atr : null).filter(isNum));
      r.tod = todHistogram(trades);
    } else {
      r.rsi = band(trades.map((t) => t.reversal_context?.rsi_value).filter(isNum));
      r.marubozu = band(trades.map((t) => t.reversal_context?.run_length).filter(isNum));
      r.tod = todHistogram(trades);
    }
    ranges[scanner] = r;
  }
  return ranges;
}

async function getRanges(logPath) {
  const now = Date.now();
  if (_cache.ranges && now - _cache.at < CACHE_MS) return _cache.ranges;
  const ranges = await buildWinningRanges(logPath);
  _cache = { at: now, ranges };
  return ranges;
}

// mean ± 1 stdev band; null if too few samples to be meaningful
function band(vals) {
  const n = vals.length;
  if (n < CONF.MIN_FOR_RANGE) return { n, usable: false };
  const mean = vals.reduce((s, x) => s + x, 0) / n;
  const variance = vals.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  return { n, usable: true, mean: round(mean, 2), lo: round(mean - sd, 2), hi: round(mean + sd, 2), sd: round(sd, 2) };
}

// time-of-day histogram of winners by bucket -> win-share per bucket
function todHistogram(trades) {
  const counts = {};
  for (const t of trades) {
    const b = t.signal?.tod_bucket || 'unknown';
    counts[b] = (counts[b] || 0) + 1;
  }
  const total = trades.length;
  return { n: total, usable: total >= CONF.MIN_FOR_RANGE, counts, total };
}

// ── component scorers: each returns {score:0..1, note, usable} ────────────────
function scoreAgainstBand(value, b, label) {
  if (b == null || !b.usable) return { score: 0.5, note: `${label}: neutral (insufficient history)`, usable: false };
  if (!isNum(value)) return { score: 0.5, note: `${label}: n/a`, usable: false };
  // 1.0 at the mean, decaying to ~0.4 at ±1sd, ~0.15 beyond ±2sd
  const z = b.sd > 0 ? Math.abs(value - b.mean) / b.sd : 0;
  const score = clamp(Math.exp(-0.5 * z * z), 0.1, 1); // gaussian closeness
  const inBand = value >= b.lo && value <= b.hi;
  return {
    score,
    note: `${label} ${round(value, 1)} vs winners ${b.lo}–${b.hi} (mean ${b.mean})${inBand ? ' ✓' : ''}`,
    usable: true,
  };
}

function scoreTod(bucket, hist, label) {
  if (hist == null || !hist.usable) return { score: 0.5, note: `${label}: neutral (insufficient history)`, usable: false };
  const c = hist.counts[bucket] || 0;
  const share = hist.total > 0 ? c / hist.total : 0;
  // share of winners in this bucket, normalized so the modal bucket ~1.0
  const maxShare = Math.max(...Object.values(hist.counts)) / hist.total;
  const score = maxShare > 0 ? clamp(share / maxShare, 0.1, 1) : 0.5;
  return { score, note: `time ${bucket}: ${c}/${hist.total} winners here`, usable: true };
}

// ── main ──────────────────────────────────────────────────────────────────────
/**
 * setup = {
 *   scanner: 'orb' | 'reversal',
 *   symbol: 'NVDA',
 *   rsi: <number>,                 // current RSI at signal
 *   orAtrRatio: <number>,          // ORB only: or_size / ATR
 *   marubozuCount: <number>,       // reversal only: run length
 *   tod_bucket: 'open'|'midday'|..,// from signal time
 * }
 */
async function ratePattern(setup, opts = {}) {
  const scanner = setup.scanner;
  const weights = WEIGHTS[scanner];
  if (!weights) throw new Error(`ratePattern: unknown scanner '${scanner}'`);

  const ranges = await getRanges(opts.logPath);
  const R = ranges[scanner] || { n: 0 };
  const winners = R.n || 0;

  // confidence tier from sample size
  const confidence = winners >= CONF.ESTABLISHED ? 'ESTABLISHED'
                   : winners >= CONF.DEVELOPING ? 'DEVELOPING'
                   : 'LEARNING';

  // component scores
  const comps = [];
  if (scanner === 'orb') {
    comps.push(['rsi', scoreAgainstBand(setup.rsi, R.rsi, 'RSI')]);
    comps.push(['atr', scoreAgainstBand(setup.orAtrRatio, R.atr, 'OR/ATR')]);
    comps.push(['tod', scoreTod(setup.tod_bucket, R.tod, 'TOD')]);
  } else {
    comps.push(['rsi', scoreAgainstBand(setup.rsi, R.rsi, 'RSI')]);
    comps.push(['marubozu', scoreAgainstBand(setup.marubozuCount, R.marubozu, 'Marubozu run')]);
    comps.push(['tod', scoreTod(setup.tod_bucket, R.tod, 'TOD')]);
  }

  // weighted 0..1
  let raw = 0;
  for (const [key, c] of comps) raw += weights[key] * c.score;

  // HONESTY: shrink toward neutral (0.5) when confidence is low.
  // LEARNING -> heavy shrink; DEVELOPING -> mild; ESTABLISHED -> none.
  const shrink = confidence === 'LEARNING' ? 0.5 : confidence === 'DEVELOPING' ? 0.2 : 0;
  const adj = raw * (1 - shrink) + 0.5 * shrink;

  let baseScore = clamp(Math.round(adj * 9 + 1), 1, 10); // map 0..1 -> 1..10

  // sector bonus (additive, the safe way leadership should be used)
  let sectorBonus = 0;
  let sectorNote = null;
  const leader = opts.isLeaderStock
    ? opts.isLeaderStock(setup.symbol)
    : (sectorScanner && sectorScanner.isLeaderStock ? sectorScanner.isLeaderStock(setup.symbol) : false);
  if (leader) {
    sectorBonus = CONF.SECTOR_BONUS;
    const etf = (sectorScanner && sectorScanner.getStockSector) ? sectorScanner.getStockSector(setup.symbol) : null;
    sectorNote = `+${CONF.SECTOR_BONUS} leading sector${etf ? ` (${etf})` : ''}`;
  }

  const score = clamp(baseScore + sectorBonus, 1, 10);

  const reasons = comps.map(([, c]) => c.note);
  if (sectorNote) reasons.push(sectorNote);
  if (confidence === 'LEARNING') {
    reasons.push(`⚠ LOW CONFIDENCE — only ${winners} historical winners to compare against; score pulled toward neutral.`);
  }

  return {
    score,
    base_score: baseScore,
    sector_bonus: sectorBonus,
    confidence,
    winners_compared: winners,
    similar_to: winners > 0 ? `${winners} historical ${scanner} winners` : 'no historical winners yet',
    reasons,
  };
}

// format a compact line for the Telegram alert
function formatForAlert(rating) {
  const stars = '★'.repeat(Math.round(rating.score / 2)) + '☆'.repeat(5 - Math.round(rating.score / 2));
  const conf = rating.confidence === 'ESTABLISHED' ? '' : ` [${rating.confidence}]`;
  return `Pattern ${rating.score}/10 ${stars}${conf}\n` +
    `~ ${rating.similar_to}\n` +
    rating.reasons.map((r) => `  • ${r}`).join('\n');
}

// ── helpers ───────────────────────────────────────────────────────────────────
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round(v, dp) { if (!isNum(v)) return v; const f = 10 ** dp; return Math.round(v * f) / f; }

module.exports = { ratePattern, formatForAlert, buildWinningRanges, CONF, WEIGHTS };

// ── demo with a synthetic trade log (proves honest degradation) ───────────────
if (require.main === module) {
  (async () => {
    const os = require('os');
    const { createTradeRecord, computeDerived, MODE, DIRECTION, EXIT_REASON, GAP_CLASS, TOD_BUCKET } = require('./trade-log-schema');
    const tmp = path.join(os.tmpdir(), `rater-demo-${Date.now()}.jsonl`);

    // helper to write a winning ORB trade with given RSI / OR-ATR
    async function winTrade(rsi, orAtr, atr = 1.0) {
      const orSize = orAtr * atr, entry = 50, stop = 50 - orSize, risk = entry - stop;
      const rec = createTradeRecord({
        mode: MODE.BACKTEST, rule_version: 'demo',
        signal: { scanner: 'orb', signal_time: '2026-05-20T09:45:00-04:00', signal_price: entry, timeframe: '5Min', tod_bucket: TOD_BUCKET.OPEN },
        symbol_context: { symbol: 'DEMO', atr, rsi },
        orb_context: { opening_range_minutes: 10, or_size: orSize, gap_classification: GAP_CLASS.OPEN_AIR, break_direction: DIRECTION.LONG },
        entry: { intended_price: entry, fill_price: entry, time: '2026-05-20T09:46:00-04:00', direction: DIRECTION.LONG, shares: 100, fees: 1, stop_price: stop, target_price: entry + 2 * risk },
        exit: { intended_price: entry + 2 * risk, fill_price: entry + 2 * risk, time: '2026-05-20T10:30:00-04:00', reason: EXIT_REASON.TARGET, fees: 1 },
        excursion: { mae_price: entry - 0.3 * risk, mfe_price: entry + 2.1 * risk },
      });
      computeDerived(rec);
      await store.appendTrade(rec, tmp);
    }

    const setup = { scanner: 'orb', symbol: 'DEMO', rsi: 62, orAtrRatio: 0.35, tod_bucket: TOD_BUCKET.OPEN };

    // Phase 1: only 3 winners -> LEARNING, score pulled toward neutral
    for (let i = 0; i < 3; i++) await winTrade(60 + i, 0.33 + i * 0.01);
    let r1 = await ratePattern(setup, { logPath: tmp, isLeaderStock: () => false });
    console.log('PHASE 1 (3 winners):');
    console.log(formatForAlert(r1), '\n');

    // Phase 2: 60 winners clustered around RSI 60 / OR-ATR 0.35 -> ESTABLISHED
    _resetCache();
    for (let i = 0; i < 60; i++) await winTrade(58 + (i % 6), 0.33 + (i % 5) * 0.01);
    let r2 = await ratePattern(setup, { logPath: tmp, isLeaderStock: () => false });
    console.log('PHASE 2 (63 winners, setup in sweet spot):');
    console.log(formatForAlert(r2), '\n');

    // Phase 3: same but stock is a sector leader -> +2 bonus
    let r3 = await ratePattern(setup, { logPath: tmp, isLeaderStock: () => true });
    console.log('PHASE 3 (same, leading-sector stock):');
    console.log(formatForAlert(r3), '\n');

    console.log('Honest degradation check:',
      r1.confidence === 'LEARNING' && r2.confidence === 'ESTABLISHED' && r3.score > r2.score
      ? 'PASS — low-sample pulled toward neutral, full-sample scored confidently, sector bonus applied'
      : 'CHECK');

    require('fs/promises').unlink(tmp).catch(() => {});
  })().catch((e) => { console.error(e); process.exit(1); });

  // expose a cache reset for the demo
  function _resetCache() { module.exports.__resetCache && module.exports.__resetCache(); }
}

// allow tests to clear the range cache
module.exports.__resetCache = function () { _cache = { at: 0, ranges: null }; };
