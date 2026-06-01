'use strict';

/**
 * trade-log-schema.js  —  WickED Trade Log Schema
 * ============================================================================
 * The foundational data model for every trade WickED takes or simulates.
 *
 * DESIGN PRINCIPLE: capture three things SEPARATELY, so analysis stays honest:
 *   1. SIGNAL CONTEXT  — exactly what the scanner saw at decision time
 *                        (point-in-time, closed-bar only; never outcome-aware)
 *   2. EXCURSION PATH  — how far the trade went for/against you (MAE/MFE)
 *   3. OUTCOME         — the realized result
 *
 * WHY THIS MATTERS: the fields you can NEVER reconstruct later are (a) the
 * scanner's decision-time view (float, indicator values, the partial-bar it
 * acted on) and (b) the trade's price path (MAE/MFE). Outcome math (P&L, R)
 * can always be recomputed. So we over-capture (a) and (b) now — retrofitting
 * them onto a trade history you didn't record is impossible.
 *
 * ONE RECORD SHAPE serves BOTH:
 *   - live/paper trades (mode: 'live' | 'paper')  -> auto-logged via Alpaca
 *   - backtest trades    (mode: 'backtest')        -> emitted by the replay engine
 * Same detection logic feeds both, so a field that exists for one exists for both.
 *
 * GOVERNANCE: every record stamps `rule_version`. When you change a scanner
 * rule, you bump the version. That lets you segment performance BEFORE vs AFTER
 * a change and validate it FORWARD — the human-in-the-loop guard against
 * curve-fitting. The schema enables refinement; it never auto-applies it.
 *
 * No npm dependencies. Node 18+.
 */

const SCHEMA_VERSION = '1.0.0';

// ──────────────────────────────────────────────────────────────────────────
// Enums (kept as plain frozen objects so they serialize cleanly)
// ──────────────────────────────────────────────────────────────────────────
const SCANNER       = Object.freeze({ SCALP: 'scalp', ORB: 'orb', REVERSAL: 'reversal' });
const MODE          = Object.freeze({ LIVE: 'live', PAPER: 'paper', BACKTEST: 'backtest' });
const DIRECTION     = Object.freeze({ LONG: 'long', SHORT: 'short' });
const EXIT_REASON    = Object.freeze({
  TARGET: 'target', STOP: 'stop', TIME_STOP: 'time_stop', TRAIL: 'trail',
  MANUAL: 'manual', EOD: 'eod', INVALIDATED: 'signal_invalidated',
});
const GAP_CLASS     = Object.freeze({
  INTO_RESISTANCE: 'into_resistance', OPEN_AIR: 'open_air',
  INTO_SUPPORT: 'into_support', NONE: 'none',
});
const REVERSAL_TYPE = Object.freeze({
  FADE_INTO_LEVEL: 'fade_into_level',       // mean-reversion: fade the move AT the level
  CONFIRMATION_RECLAIM: 'confirmation_reclaim', // wait for divergence + reclaim, THEN enter
});
const TOD_BUCKET    = Object.freeze({
  PREMARKET: 'premarket', OPEN: 'open', MIDDAY: 'midday',
  AFTERNOON: 'afternoon', CLOSE: 'close',
});

// ──────────────────────────────────────────────────────────────────────────
// The record skeleton. `null` = "not captured / not applicable".
// Scanner-specific blocks (orb / reversal) stay null unless that scanner fired.
// ──────────────────────────────────────────────────────────────────────────
function blankRecord() {
  return {
    // ---- meta ----
    trade_id: null,            // stable unique id (uuid or broker order id)
    schema_version: SCHEMA_VERSION,
    mode: null,                // MODE.*  — live | paper | backtest
    rule_version: null,        // e.g. 'orb-v3' — bump on any rule change (governance)
    created_at: null,          // ISO timestamp this record was written

    // ---- signal (decision-time; closed-bar only, NEVER outcome-aware) ----
    signal: {
      scanner: null,           // SCANNER.*
      signal_time: null,       // ISO, America/New_York — when the trigger fired
      signal_price: null,      // price on the CLOSED bar that triggered
      timeframe: null,         // '1Min' | '5Min' | '15Min' ...
      session_minute: null,    // minutes since 09:30 ET (negative = pre-market)
      tod_bucket: null,        // TOD_BUCKET.* — store the bucket, analyze by it
    },

    // ---- symbol context (POINT-IN-TIME; changes over time, must snapshot) ----
    symbol_context: {
      symbol: null,
      float_at_signal: null,   // shares outstanding/float AT the trade — NOT today's
      float_source: null,      // where the float came from (audit trail)
      prev_close: null,
      gap_pct: null,           // (signal_price - prev_close)/prev_close * 100
      premarket_volume: null,
      premarket_relvol: null,  // preVol / prevDayVol  (from the pre-market feed)
      was_in_play: null,       // boolean — on the 4:45am watchlist?
      avg_daily_volume: null,  // e.g. 20-day, for relative-volume context
      atr: null,               // volatility scale — normalize stops/targets across names
    },

    // ---- ORB-specific (null unless scanner === 'orb') ----
    orb_context: null,         // see orbContext() factory below

    // ---- reversal-specific (null unless scanner === 'reversal') ----
    reversal_context: null,    // see reversalContext() factory below

    // ---- entry ----
    entry: {
      intended_price: null,    // the price the rule wanted
      fill_price: null,        // what you actually got
      slippage: null,          // fill - intended (the fill-fiction tracker)
      time: null,              // ISO
      direction: null,         // DIRECTION.*
      shares: null,
      position_value: null,    // fill_price * shares
      fees: null,              // commissions + SEC/FINRA/TAF
      stop_price: null,        // the protective stop set at entry (defines risk)
      target_price: null,      // the profit objective set at entry
      initial_risk_per_share: null, // |intended_price - stop_price|  (R denominator)
    },

    // ---- exit ----
    exit: {
      intended_price: null,
      fill_price: null,
      slippage: null,
      time: null,
      reason: null,            // EXIT_REASON.*
      fees: null,
    },

    // ---- excursion path (CANNOT be reconstructed later — capture live!) ----
    excursion: {
      mae_price: null,         // worst price reached during the hold
      mfe_price: null,         // best price reached during the hold
      mae_r: null,             // MAE in R units (how deep underwater before working)
      mfe_r: null,             // MFE in R units (how much was on the table at peak)
    },

    // ---- outcome (always recomputable from the above) ----
    outcome: {
      pnl_gross: null,
      pnl_net: null,           // after fees + realized slippage
      r_multiple: null,        // net P&L / (initial_risk_per_share * shares) — the universal currency
      hold_minutes: null,
    },

    // ---- market regime (context for regime-aware analysis) ----
    regime: {
      spy_trend: null,         // 'up' | 'down' | 'flat' (e.g. vs daily 20-EMA)
      vix: null,               // or a volatility proxy
    },

    // ---- free-form ----
    tags: [],                  // e.g. ['news_catalyst','earnings','halt_resume']
    note: null,                // discretionary context, manual annotations
  };
}

// Scanner-specific sub-blocks (kept as separate factories for clarity)
function orbContext() {
  return {
    opening_range_minutes: null, // 5 | 15 | 30
    or_high: null,
    or_low: null,
    or_size: null,               // or_high - or_low
    or_size_pct: null,           // or_size / signal_price * 100 (normalizes across prices)
    break_direction: null,       // DIRECTION.*
    gap_classification: null,    // GAP_CLASS.* — the gap-into-resistance vs open-air split
    nearest_resistance: null,    // level above (for classifying the break's runway)
    nearest_support: null,       // level below
    volume_on_break: null,       // breakout-bar volume
    volume_vs_avg: null,         // volume_on_break / avg per-bar volume
  };
}

function reversalContext() {
  return {
    reversal_type: null,         // REVERSAL_TYPE.* — fade vs confirmation (they backtest differently)
    rsi_value: null,
    divergence_type: null,       // 'bullish' | 'bearish' | 'none'
    divergence_lookback_bars: null,
    sr_level: null,              // the level being tested
    sr_level_source: null,       // 'daily' | 'weekly' | 'prior_day_hl' | 'premarket'
    distance_to_level_pct: null, // how close price was to the level at signal
    reclaim_confirmed: null,     // boolean — did price reclaim before entry?
    mtf_aligned: null,           // boolean — multi-timeframe confirmation (e.g. 5m signal + daily S/R)
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Factory: create a record, merging caller-supplied fields over the skeleton.
// Auto-attaches the right scanner sub-block.
// ──────────────────────────────────────────────────────────────────────────
function createTradeRecord(partial = {}) {
  const rec = blankRecord();
  rec.created_at = new Date().toISOString();
  if (!rec.trade_id) rec.trade_id = genId();

  deepMerge(rec, partial);

  // Attach the scanner-specific block if the scanner is known and block absent.
  const scanner = rec.signal && rec.signal.scanner;
  if (scanner === SCANNER.ORB && !rec.orb_context) rec.orb_context = orbContext();
  if (scanner === SCANNER.REVERSAL && !rec.reversal_context) rec.reversal_context = reversalContext();

  // Allow callers to pass orb/reversal fields directly in `partial`.
  if (partial.orb_context && rec.orb_context) deepMerge(rec.orb_context, partial.orb_context);
  if (partial.reversal_context && rec.reversal_context) deepMerge(rec.reversal_context, partial.reversal_context);

  return rec;
}

// ──────────────────────────────────────────────────────────────────────────
// computeDerived: fill in slippage, risk, R, MAE/MFE-in-R, P&L, hold time —
// ONE canonical implementation so every analysis agrees. Mutates + returns rec.
// Call after both entry and exit are populated.
// ──────────────────────────────────────────────────────────────────────────
function computeDerived(rec) {
  const e = rec.entry, x = rec.exit, ex = rec.excursion, o = rec.outcome;
  const isLong = e.direction === DIRECTION.LONG;
  const sign = isLong ? 1 : -1;

  // Slippage
  if (n(e.fill_price) && n(e.intended_price)) e.slippage = round(e.fill_price - e.intended_price, 4);
  if (n(x.fill_price) && n(x.intended_price)) x.slippage = round(x.fill_price - x.intended_price, 4);

  // Risk per share (R denominator)
  if (e.initial_risk_per_share == null && n(e.intended_price) && n(e.stop_price)) {
    e.initial_risk_per_share = round(Math.abs(e.intended_price - e.stop_price), 4);
  }
  const riskPS = e.initial_risk_per_share;
  const shares = e.shares;

  // P&L (per-share move * shares, then fees)
  if (n(e.fill_price) && n(x.fill_price) && n(shares)) {
    const perShare = (x.fill_price - e.fill_price) * sign;
    o.pnl_gross = round(perShare * shares, 2);
    const fees = (e.fees || 0) + (x.fees || 0);
    o.pnl_net = round(o.pnl_gross - fees, 2);
  }

  // R-multiple (net P&L in units of initial dollar risk)
  if (n(o.pnl_net) && n(riskPS) && riskPS > 0 && n(shares) && shares > 0) {
    o.r_multiple = round(o.pnl_net / (riskPS * shares), 3);
  }

  // MAE/MFE in R (requires the captured price path)
  if (n(riskPS) && riskPS > 0 && n(e.fill_price)) {
    if (n(ex.mae_price)) {
      const adverse = isLong ? (e.fill_price - ex.mae_price) : (ex.mae_price - e.fill_price);
      ex.mae_r = round(Math.max(0, adverse) / riskPS, 3); // 0+ = how far underwater it went
    }
    if (n(ex.mfe_price)) {
      const favor = isLong ? (ex.mfe_price - e.fill_price) : (e.fill_price - ex.mfe_price);
      ex.mfe_r = round(Math.max(0, favor) / riskPS, 3);    // how much was on the table
    }
  }

  // Hold time
  if (e.time && x.time) {
    const mins = (new Date(x.time) - new Date(e.time)) / 60000;
    if (isFinite(mins)) o.hold_minutes = round(mins, 1);
  }

  return rec;
}

// ──────────────────────────────────────────────────────────────────────────
// validateTradeRecord: lightweight sanity checks. Returns { ok, errors:[] }.
// Not a substitute for a real schema validator, but catches the common holes.
// ──────────────────────────────────────────────────────────────────────────
function validateTradeRecord(rec, { stage = 'closed' } = {}) {
  const errs = [];
  const req = (cond, msg) => { if (!cond) errs.push(msg); };

  req(rec, 'record is null');
  if (!rec) return { ok: false, errors: errs };

  req(Object.values(MODE).includes(rec.mode), `mode must be one of ${Object.values(MODE)}`);
  req(rec.rule_version, 'rule_version missing (needed for refinement governance)');
  req(rec.signal && Object.values(SCANNER).includes(rec.signal.scanner), 'signal.scanner invalid');
  req(rec.signal && rec.signal.signal_time, 'signal.signal_time missing');
  req(rec.symbol_context && rec.symbol_context.symbol, 'symbol_context.symbol missing');

  // Point-in-time integrity nudge: float is the classic retrofit trap.
  if (rec.symbol_context && rec.symbol_context.float_at_signal == null) {
    errs.push('WARN: float_at_signal not captured — cannot honestly test float rules later');
  }

  if (rec.signal && rec.signal.scanner === SCANNER.ORB) {
    req(rec.orb_context, 'orb_context missing for ORB trade');
    if (rec.orb_context) req(rec.orb_context.gap_classification, 'orb_context.gap_classification missing');
  }
  if (rec.signal && rec.signal.scanner === SCANNER.REVERSAL) {
    req(rec.reversal_context, 'reversal_context missing for reversal trade');
    if (rec.reversal_context) req(rec.reversal_context.reversal_type, 'reversal_context.reversal_type missing');
  }

  if (stage === 'closed') {
    req(rec.entry && n(rec.entry.fill_price), 'entry.fill_price missing');
    req(rec.entry && n(rec.entry.stop_price), 'entry.stop_price missing (no stop = no R)');
    req(rec.exit && n(rec.exit.fill_price), 'exit.fill_price missing');
    req(rec.exit && rec.exit.reason, 'exit.reason missing');
    if (rec.excursion && rec.excursion.mae_price == null) {
      errs.push('WARN: excursion.mae_price not captured — cannot refine stops later');
    }
    if (rec.excursion && rec.excursion.mfe_price == null) {
      errs.push('WARN: excursion.mfe_price not captured — cannot refine targets later');
    }
  }

  const hard = errs.filter((e) => !e.startsWith('WARN:'));
  return { ok: hard.length === 0, errors: errs };
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────
function n(v) { return typeof v === 'number' && isFinite(v); }
function round(v, dp) { const f = 10 ** dp; return Math.round(v * f) / f; }
function genId() {
  // Prefer crypto.randomUUID when available (Node 18+ has it globally).
  try { return require('crypto').randomUUID(); }
  catch { return 'tr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
}
function deepMerge(target, src) {
  for (const k of Object.keys(src || {})) {
    const sv = src[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) &&
        target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], sv);
    } else {
      target[k] = sv;
    }
  }
  return target;
}

module.exports = {
  SCHEMA_VERSION,
  SCANNER, MODE, DIRECTION, EXIT_REASON, GAP_CLASS, REVERSAL_TYPE, TOD_BUCKET,
  blankRecord, orbContext, reversalContext,
  createTradeRecord, computeDerived, validateTradeRecord,
};

// Demo when run directly: build a sample ORB trade, compute, validate, print.
if (require.main === module) {
  const t = createTradeRecord({
    mode: MODE.PAPER,
    rule_version: 'orb-v1',
    signal: { scanner: SCANNER.ORB, signal_time: '2026-05-29T09:45:00-04:00',
              signal_price: 4.20, timeframe: '5Min', session_minute: 15, tod_bucket: TOD_BUCKET.OPEN },
    symbol_context: { symbol: 'SOUN', float_at_signal: 18_000_000, float_source: 'polygon_ref',
                      prev_close: 3.80, gap_pct: 10.5, premarket_relvol: 0.42, was_in_play: true,
                      avg_daily_volume: 9_500_000, atr: 0.35 },
    orb_context: { opening_range_minutes: 15, or_high: 4.20, or_low: 3.95, or_size: 0.25,
                   or_size_pct: 5.95, break_direction: DIRECTION.LONG,
                   gap_classification: GAP_CLASS.OPEN_AIR, nearest_resistance: 5.00,
                   nearest_support: 3.80, volume_on_break: 1_200_000, volume_vs_avg: 3.1 },
    entry: { intended_price: 4.21, fill_price: 4.23, time: '2026-05-29T09:46:10-04:00',
             direction: DIRECTION.LONG, shares: 500, fees: 1.10, stop_price: 3.95, target_price: 4.85 },
    exit:  { intended_price: 4.85, fill_price: 4.82, time: '2026-05-29T11:20:00-04:00',
             reason: EXIT_REASON.TARGET, fees: 1.10 },
    excursion: { mae_price: 4.08, mfe_price: 4.90 },
    regime: { spy_trend: 'up', vix: 14.2 },
    tags: ['news_catalyst'],
  });
  computeDerived(t);
  const v = validateTradeRecord(t);
  console.log(JSON.stringify(t, null, 2));
  console.log('\nvalidation:', v);
  console.log(`\nR-multiple: ${t.outcome.r_multiple}  |  MAE: ${t.excursion.mae_r}R  |  MFE: ${t.excursion.mfe_r}R  |  held ${t.outcome.hold_minutes}m`);
}
