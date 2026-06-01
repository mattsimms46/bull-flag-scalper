'use strict';

/**
 * trade-log-store.js  —  WickED Trade Log: storage + analytics
 * ============================================================================
 * Broker-agnostic local store for trade records (see trade-log-schema.js).
 * Does NOT know or care whether a trade came from Alpaca, Polygon, or a
 * backtest replay — it just persists records and computes honest stats.
 *
 * STORAGE: JSONL (one JSON record per line).
 *   - append-only: a crash mid-write costs at most one trailing line, not the file
 *   - human-readable, greppable, zero dependencies
 *   - migrates to SQLite/Postgres later WITHOUT changing the record shape
 *
 * THREE THINGS IT DOES:
 *   1. appendTrade(rec)            — log a trade (live on fill / backtest from replay)
 *   2. loadTrades(filter)          — read back, filtered (scanner, mode, rule_version, dates)
 *   3. summarize(trades, groupBy)  — per-setup performance: win rate, expectancy, R, MAE/MFE
 *
 * The summary is DESCRIPTIVE, never prescriptive — it surfaces evidence for you
 * to act on. It does not change any rule. (Human-in-the-loop, by design.)
 *
 * No npm dependencies. Node 18+.
 *
 * INTEGRATION:
 *   const store = require('./trade-log-store');
 *   const { createTradeRecord, computeDerived, validateTradeRecord, MODE, SCANNER }
 *           = require('./trade-log-schema');
 *
 *   // on a closed trade:
 *   computeDerived(rec);
 *   const v = validateTradeRecord(rec);
 *   if (v.ok) await store.appendTrade(rec);
 *   else console.warn('not logging invalid record:', v.errors);
 *
 *   // analysis:
 *   const trades = await store.loadTrades({ scanner: SCANNER.ORB, mode: MODE.PAPER });
 *   console.log(store.summarize(trades, 'gap_classification'));
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DEFAULT_PATH = process.env.WICKED_TRADELOG_PATH
  || path.join(process.cwd(), 'data', 'trades.jsonl');

// ──────────────────────────────────────────────────────────────────────────
// Write
// ──────────────────────────────────────────────────────────────────────────
/**
 * Append one trade record as a single JSONL line. Creates the directory and
 * file if needed. Append-only and atomic per-line (single write syscall).
 */
async function appendTrade(rec, filePath = DEFAULT_PATH) {
  if (!rec || typeof rec !== 'object') throw new Error('appendTrade: record must be an object');
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify(rec) + '\n';
  await fsp.appendFile(filePath, line, 'utf8');
  return rec.trade_id || null;
}

/** Synchronous variant for shutdown hooks / non-async call sites. */
function appendTradeSync(rec, filePath = DEFAULT_PATH) {
  if (!rec || typeof rec !== 'object') throw new Error('appendTradeSync: record must be an object');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(rec) + '\n', 'utf8');
  return rec.trade_id || null;
}

// ──────────────────────────────────────────────────────────────────────────
// Read
// ──────────────────────────────────────────────────────────────────────────
/**
 * Load trades, optionally filtered. Filter fields (all optional):
 *   scanner        — 'orb' | 'reversal' | 'scalp'
 *   mode           — 'live' | 'paper' | 'backtest'
 *   rule_version   — exact match (segment before/after a rule change)
 *   symbol         — exact ticker
 *   from, to       — ISO date strings; filters on signal.signal_time
 *   predicate      — custom fn(rec) => boolean for anything else
 * Skips malformed lines rather than throwing (one bad line ≠ lost history).
 */
async function loadTrades(filter = {}, filePath = DEFAULT_PATH) {
  let raw;
  try { raw = await fsp.readFile(filePath, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }

  const out = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let rec;
    try { rec = JSON.parse(s); } catch { skipped++; continue; }
    if (matchesFilter(rec, filter)) out.push(rec);
  }
  if (skipped) console.warn(`[tradelog] skipped ${skipped} malformed line(s) in ${filePath}`);
  return out;
}

function matchesFilter(rec, f) {
  if (!f || Object.keys(f).length === 0) return true;
  if (f.scanner && (rec.signal && rec.signal.scanner) !== f.scanner) return false;
  if (f.mode && rec.mode !== f.mode) return false;
  if (f.rule_version && rec.rule_version !== f.rule_version) return false;
  if (f.symbol && (rec.symbol_context && rec.symbol_context.symbol) !== f.symbol) return false;
  if (f.from || f.to) {
    const t = rec.signal && rec.signal.signal_time ? new Date(rec.signal.signal_time).getTime() : NaN;
    if (!isFinite(t)) return false;
    if (f.from && t < new Date(f.from).getTime()) return false;
    if (f.to && t > new Date(f.to).getTime()) return false;
  }
  if (typeof f.predicate === 'function' && !f.predicate(rec)) return false;
  return true;
}

// ──────────────────────────────────────────────────────────────────────────
// Analyze
// ──────────────────────────────────────────────────────────────────────────
/**
 * Summarize a set of trades into honest performance stats. Optionally group by
 * a dimension so you can see WHERE an edge lives, e.g.:
 *   summarize(trades, 'gap_classification')  // ORB: into_resistance vs open_air
 *   summarize(trades, 'reversal_type')        // fade vs confirmation
 *   summarize(trades, 'tod_bucket')           // open vs midday vs afternoon
 *   summarize(trades, 'rule_version')         // before vs after a rule change
 *   summarize(trades)                         // single overall block
 *
 * Returns { overall, groups: { <key>: stats, ... } } when groupBy is given,
 * else { overall }.
 */
function summarize(trades, groupBy = null) {
  const overall = statsFor(trades);
  if (!groupBy) return { overall };

  const buckets = new Map();
  for (const rec of trades) {
    const key = resolveDimension(rec, groupBy);
    const k = key == null ? '(unset)' : String(key);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(rec);
  }
  const groups = {};
  for (const [k, recs] of buckets) groups[k] = statsFor(recs);
  return { overall, groupBy, groups };
}

/** Pull a grouping value from wherever it lives in the record. */
function resolveDimension(rec, dim) {
  switch (dim) {
    case 'scanner':            return rec.signal && rec.signal.scanner;
    case 'mode':               return rec.mode;
    case 'rule_version':       return rec.rule_version;
    case 'symbol':             return rec.symbol_context && rec.symbol_context.symbol;
    case 'tod_bucket':         return rec.signal && rec.signal.tod_bucket;
    case 'was_in_play':        return rec.symbol_context && rec.symbol_context.was_in_play;
    case 'gap_classification': return rec.orb_context && rec.orb_context.gap_classification;
    case 'break_direction':    return rec.orb_context && rec.orb_context.break_direction;
    case 'reversal_type':      return rec.reversal_context && rec.reversal_context.reversal_type;
    case 'divergence_type':    return rec.reversal_context && rec.reversal_context.divergence_type;
    case 'exit_reason':        return rec.exit && rec.exit.reason;
    default:
      // Allow dotted paths, e.g. 'regime.spy_trend'
      return dim.split('.').reduce((o, k) => (o == null ? o : o[k]), rec);
  }
}

/**
 * Core stats for a list of trades. R-multiple is the spine: expectancy in R is
 * the single most useful number — average R per trade tells you whether the
 * setup makes money net of wins AND losses.
 */
function statsFor(trades) {
  const rs = [];
  const holds = [];
  const maes = [];
  const mfes = [];
  const entrySlip = [];
  let wins = 0, losses = 0, scratches = 0;
  let grossPnl = 0, netPnl = 0;
  let counted = 0;

  for (const t of trades) {
    const o = t.outcome || {};
    const r = num(o.r_multiple);
    if (r != null) { rs.push(r); if (r > 0.01) wins++; else if (r < -0.01) losses++; else scratches++; }
    if (num(o.hold_minutes) != null) holds.push(o.hold_minutes);
    if (num(o.pnl_gross) != null) grossPnl += o.pnl_gross;
    if (num(o.pnl_net) != null) netPnl += o.pnl_net;
    const ex = t.excursion || {};
    if (num(ex.mae_r) != null) maes.push(ex.mae_r);
    if (num(ex.mfe_r) != null) mfes.push(ex.mfe_r);
    const en = t.entry || {};
    if (num(en.slippage) != null) entrySlip.push(en.slippage);
    counted++;
  }

  const decided = wins + losses; // exclude scratches from win rate denominator
  const winRate = decided ? wins / decided : null;

  const avgR = mean(rs);
  const winRs = rs.filter((r) => r > 0.01);
  const lossRs = rs.filter((r) => r < -0.01);
  const avgWinR = mean(winRs);
  const avgLossR = mean(lossRs);

  // Profit factor = gross R won / gross R lost (absolute). >1 = profitable.
  const grossWonR = sum(winRs);
  const grossLostR = Math.abs(sum(lossRs));
  const profitFactor = grossLostR > 0 ? grossWonR / grossLostR : (grossWonR > 0 ? Infinity : null);

  return {
    trades: counted,
    wins, losses, scratches,
    win_rate: pct(winRate),
    expectancy_r: round(avgR, 3),       // avg R per trade — the headline number
    avg_win_r: round(avgWinR, 3),
    avg_loss_r: round(avgLossR, 3),
    profit_factor: profitFactor === Infinity ? 'inf' : round(profitFactor, 2),
    total_pnl_net: round(netPnl, 2),
    total_pnl_gross: round(grossPnl, 2),
    avg_hold_min: round(mean(holds), 1),
    // Excursion aggregates — fuel for stop/target refinement:
    avg_mae_r: round(mean(maes), 3),    // typical heat taken before working
    avg_mfe_r: round(mean(mfes), 3),    // typical peak reached
    avg_entry_slippage: round(mean(entrySlip), 4), // empirical fill-fiction gap
    expectancy_note: expectancyNote(avgR, counted),
  };
}

/** A plain-language flag so a glance tells you if the sample is even meaningful. */
function expectancyNote(avgR, n) {
  if (n < 30) return `only ${n} trades — NOT enough to trust; treat as anecdote`;
  if (n < 100) return `${n} trades — directional read only; keep gathering`;
  if (avgR == null) return 'no R data';
  if (avgR > 0) return `positive expectancy on ${n} trades`;
  return `negative expectancy on ${n} trades`;
}

// ──────────────────────────────────────────────────────────────────────────
// Small stat helpers
// ──────────────────────────────────────────────────────────────────────────
function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
function sum(a) { return a.reduce((s, x) => s + x, 0); }
function mean(a) { return a.length ? sum(a) / a.length : null; }
function round(v, dp) { if (v == null) return null; const f = 10 ** dp; return Math.round(v * f) / f; }
function pct(v) { return v == null ? null : round(v * 100, 1); }

module.exports = {
  DEFAULT_PATH,
  appendTrade, appendTradeSync,
  loadTrades,
  summarize, statsFor,
};

// Demo: synthesize a small mixed ORB book and show grouped stats.
if (require.main === module) {
  (async () => {
    const { createTradeRecord, computeDerived, MODE, SCANNER, DIRECTION, EXIT_REASON, GAP_CLASS, TOD_BUCKET } =
      require('./trade-log-schema');

    const tmp = path.join(require('os').tmpdir(), `wicked-demo-${Date.now()}.jsonl`);

    // 12 synthetic ORB trades: open_air wins more than into_resistance.
    const rng = mulberry32(42);
    for (let i = 0; i < 12; i++) {
      const openAir = i % 2 === 0;
      const cls = openAir ? GAP_CLASS.OPEN_AIR : GAP_CLASS.INTO_RESISTANCE;
      const win = openAir ? rng() < 0.66 : rng() < 0.36;
      const entry = 4.00, stop = 3.80, risk = entry - stop;
      const exit = win ? entry + risk * (1.5 + rng()) : stop - 0.01;
      const rec = createTradeRecord({
        mode: MODE.PAPER, rule_version: 'orb-v1',
        signal: { scanner: SCANNER.ORB, signal_time: `2026-05-${10 + i}T09:45:00-04:00`,
                  signal_price: entry, timeframe: '5Min', session_minute: 15, tod_bucket: TOD_BUCKET.OPEN },
        symbol_context: { symbol: 'TEST', float_at_signal: 15e6, prev_close: 3.6, gap_pct: 11 },
        orb_context: { opening_range_minutes: 15, gap_classification: cls, break_direction: DIRECTION.LONG },
        entry: { intended_price: entry, fill_price: entry, time: `2026-05-${10 + i}T09:46:00-04:00`,
                 direction: DIRECTION.LONG, shares: 500, fees: 1, stop_price: stop, target_price: entry + risk * 3 },
        exit: { intended_price: exit, fill_price: exit, time: `2026-05-${10 + i}T10:30:00-04:00`,
                reason: win ? EXIT_REASON.TARGET : EXIT_REASON.STOP, fees: 1 },
        excursion: { mae_price: win ? entry - risk * 0.4 : stop, mfe_price: win ? exit + 0.05 : entry + risk * 0.3 },
      });
      computeDerived(rec);
      await appendTrade(rec, tmp);
    }

    const trades = await loadTrades({ scanner: SCANNER.ORB }, tmp);
    const result = summarize(trades, 'gap_classification');
    console.log(`Loaded ${trades.length} ORB trades from ${tmp}\n`);
    console.log('OVERALL:', result.overall);
    console.log('\nBY GAP CLASSIFICATION:');
    for (const [k, s] of Object.entries(result.groups)) {
      console.log(`\n  ${k}:`);
      console.log(`    trades=${s.trades} winRate=${s.win_rate}% expectancy=${s.expectancy_r}R ` +
                  `PF=${s.profit_factor} avgMAE=${s.avg_mae_r}R`);
      console.log(`    ${s.expectancy_note}`);
    }
    await fsp.unlink(tmp).catch(() => {});
  })().catch((e) => { console.error(e); process.exit(1); });
}

// tiny seeded RNG so the demo is deterministic
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
