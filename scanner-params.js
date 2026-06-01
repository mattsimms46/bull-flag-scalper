'use strict';

/**
 * scanner-params.js  —  WickED Parameter Optimizer (HONEST by construction)
 * ============================================================================
 * Sweeps ORB / reversal parameters over the last 90 days of cached bars, finds
 * combinations that hold up out-of-sample, and writes them to
 * scanner-params.json as PROPOSED (you approve before any live/paper use).
 *
 * ── WHERE DO THE KEY AND SECRET GO? ──────────────────────────────────────────
 *   RAILWAY ENV: process.env.ALPACA_API_KEY / process.env.ALPACA_API_SECRET
 *   (Only needed if bars aren't already cached; this module reads the cache via
 *   alpaca-history.js, which uses those env vars. Never in code/repo/chat.)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ANTI-CURVE-FIT GUARDRAILS (the whole point — do not remove):
 *   1. MINIMUM-SAMPLE GATE. A parameter combo is ignored unless it produced at
 *      least MIN_TRADES trades. Thin slices = luck, not edge. Rejected loudly.
 *   2. TRAIN / VALIDATION SPLIT. Params are tuned on the FIRST ~70% of the date
 *      range (train) and must STILL clear the bar on the held-out last ~30%
 *      (validation) they never saw. Win-on-train/lose-on-validation = overfit,
 *      discarded.
 *   3. PROPOSED, NOT ACTIVE. Output is flagged status:'proposed' with full
 *      evidence (sample sizes, train vs validation R). Nothing auto-arms.
 *   4. SECTOR LEADERSHIP IS ADDITIVE, NOT A PARAMETER SOURCE. We optimize on the
 *      BROAD sample (all symbols, full window) so results aren't luck. Per-sector
 *      "what worked in tech last week" is computed too — but tagged low_sample
 *      and informational ONLY. Leadership is meant to be used as a +score signal
 *      (see pattern-rater.js), NOT as a reason to trust thin per-sector params.
 *
 * WHY THIS DESIGN: "params that worked on tech last week will work this week"
 * blends two claims. Leadership persisting = safe & real. The SPECIFIC params
 * tuned on one sector-week = usually fitting noise. So we lean on leadership the
 * safe way and treat per-sector param slices as a caveated secondary view.
 *
 * USAGE:
 *   node scanner-params.js --symbols AMD,NVDA,MSFT --days 90
 *   // or programmatic:
 *   const opt = require('./scanner-params');
 *   const result = await opt.optimize({ symbols:[...], days:90, scanner:'orb' });
 *
 * Depends on: ./alpaca-history, ./orb-replay, ./reversal-replay, ./trade-log-store
 * Node 18+. No npm deps.
 */

const fs = require('fs/promises');
const path = require('path');
const { backtestORB } = require('./orb-replay');
const { backtestReversal } = require('./reversal-replay');
const store = require('./trade-log-store');

// ── Acceptance thresholds & sweep grids ───────────────────────────────────────
const GATES = {
  MIN_TRADES: 30,          // sample gate (per the schema's own "anecdote" line)
  MIN_WIN_RATE: 0.50,      // >50% win rate
  MIN_EXPECTANCY_R: 0.30,  // >0.3R expectancy
  // validation must ALSO clear these, on data the optimizer never tuned on:
  VAL_MIN_TRADES: 12,      // smaller window, so a lower floor — still not tiny
  VAL_MIN_EXPECTANCY_R: 0.15, // must stay positive & meaningful out-of-sample
  TRAIN_FRACTION: 0.70,    // first 70% train, last 30% validation (time-ordered)
};

// Parameter grids to sweep. Deliberately COARSE — a fine grid over many params
// is itself a form of overfitting (more combos = more chances for one to look
// good by luck). Few knobs, few values.
const GRIDS = {
  orb: {
    orAtrRatioMax:   [0.4, 0.5, 0.6],
    targetOrMultiple:[1.0, 1.5, 2.0],
    minRelVol:       [1.0, 1.3],
  },
  reversal: {
    minRunLength:    [3, 4, 5],
    targetRMultiple: [1.5, 2.0, 2.5],
    volMinMultiple:  [1.0, 1.2],
  },
};

const OUTFILE = process.env.WICKED_PARAMS_PATH || path.join(process.cwd(), 'scanner-params.json');

// ── date helpers ──────────────────────────────────────────────────────────────
function isoDaysAgo(days) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function splitDate(startISO, endISO, frac) {
  const s = new Date(startISO).getTime(), e = new Date(endISO).getTime();
  return new Date(s + (e - s) * frac).toISOString().slice(0, 10);
}

// cartesian product of a grid object -> array of param objects
function gridCombos(grid) {
  const keys = Object.keys(grid);
  let combos = [{}];
  for (const k of keys) {
    const next = [];
    for (const c of combos) for (const v of grid[k]) next.push({ ...c, [k]: v });
    combos = next;
  }
  return combos;
}

// ── run one backtest slice with given params, return stats (NO persistence) ───
async function runSlice(scanner, symbols, start, end, params) {
  const common = { symbols, start, end, persist: false, ruleVersion: 'opt-sweep' };
  const result = scanner === 'orb'
    ? await backtestORB({ ...common, ...params })
    : await backtestReversal({ ...common, ...params });
  return { trades: result.trades, stats: store.statsFor(result.trades) };
}

// ── core: optimize one scanner over the window ────────────────────────────────
async function optimizeScanner(scanner, symbols, startISO, endISO) {
  const grid = GRIDS[scanner];
  if (!grid) throw new Error(`unknown scanner '${scanner}'`);
  const trainEnd = splitDate(startISO, endISO, GATES.TRAIN_FRACTION);
  const combos = gridCombos(grid);

  console.log(`[params] ${scanner}: sweeping ${combos.length} combos | train ${startISO}→${trainEnd} | val ${trainEnd}→${endISO}`);

  const evaluated = [];
  for (const params of combos) {
    // TRAIN slice
    const train = await runSlice(scanner, symbols, startISO, trainEnd, params);
    const ts = train.stats;
    const trainPass =
      ts.trades >= GATES.MIN_TRADES &&
      (ts.win_rate != null && ts.win_rate / 100 >= GATES.MIN_WIN_RATE) &&
      (ts.expectancy_r != null && ts.expectancy_r >= GATES.MIN_EXPECTANCY_R);

    let val = null, valPass = false;
    if (trainPass) {
      // Only validate combos that passed training (saves compute, and validation
      // is meaningless for combos that already failed on the larger sample).
      val = await runSlice(scanner, symbols, trainEnd, endISO, params);
      const vs = val.stats;
      valPass =
        vs.trades >= GATES.VAL_MIN_TRADES &&
        vs.expectancy_r != null && vs.expectancy_r >= GATES.VAL_MIN_EXPECTANCY_R;
    }

    evaluated.push({
      params,
      train: sliceSummary(train.stats),
      validation: val ? sliceSummary(val.stats) : null,
      trainPass, valPass,
      verdict: !trainPass ? 'rejected_train'
             : !valPass   ? 'rejected_validation_overfit'
             : 'accepted',
    });
  }

  // Rank accepted combos by validation expectancy (out-of-sample is what matters),
  // tie-break by train sample size (more data = more trust).
  const accepted = evaluated.filter((e) => e.verdict === 'accepted')
    .sort((a, b) => (b.validation.expectancy_r - a.validation.expectancy_r)
                 || (b.train.trades - a.train.trades));

  return { scanner, trainEnd, combosTested: combos.length, accepted, allEvaluated: evaluated };
}

function sliceSummary(s) {
  return {
    trades: s.trades, win_rate: s.win_rate, expectancy_r: s.expectancy_r,
    profit_factor: s.profit_factor, avg_win_r: s.avg_win_r, avg_loss_r: s.avg_loss_r,
    sample_note: s.expectancy_note,
  };
}

// ── sector-weighted view: INFORMATIONAL ONLY, loudly caveated ─────────────────
// "What worked in <sector> recently?" Computed by filtering the already-run
// trade log by symbol membership. Always low-sample → tagged, never promoted.
function sectorView(allTrades, sectorMap) {
  // sectorMap: { ETF: [symbols...] } — pass sector-scanner.SECTORS names.
  const out = {};
  for (const [etf, info] of Object.entries(sectorMap)) {
    const syms = new Set((info.names || info).map((s) => s.toUpperCase()));
    const slice = allTrades.filter((t) => syms.has((t.symbol_context?.symbol || '').toUpperCase()));
    const stats = store.statsFor(slice);
    out[etf] = {
      trades: stats.trades,
      win_rate: stats.win_rate,
      expectancy_r: stats.expectancy_r,
      low_sample: stats.trades < GATES.MIN_TRADES,
      caveat: stats.trades < GATES.MIN_TRADES
        ? 'LOW SAMPLE — informational only; do NOT tune params on this. Use leadership as an additive score signal instead.'
        : 'meets sample gate, but still treat sector slices as secondary to the broad optimization',
    };
  }
  return out;
}

// ── top-level orchestration + write PROPOSED params ───────────────────────────
async function optimize(opts = {}) {
  const symbols = opts.symbols || [];
  if (!symbols.length) throw new Error('optimize: provide opts.symbols (the universe to sweep)');
  const days = opts.days || 90;
  const endISO = opts.end || new Date().toISOString().slice(0, 10);
  const startISO = opts.start || isoDaysAgo(days);
  const scanners = opts.scanner ? [opts.scanner] : ['orb', 'reversal'];

  const results = {};
  const allTradesForSector = [];
  for (const scanner of scanners) {
    const r = await optimizeScanner(scanner, symbols, startISO, endISO);
    results[scanner] = r;
    // gather full-window trades of the BEST accepted combo for the sector view
    if (r.accepted.length) {
      const best = r.accepted[0];
      const full = await runSlice(scanner, symbols, startISO, endISO, best.params);
      allTradesForSector.push(...full.trades);
    }
  }

  // sector view (informational), if a sector map was provided
  let sector = null;
  if (opts.sectorMap) sector = sectorView(allTradesForSector, opts.sectorMap);

  const doc = {
    schema: 'wicked-scanner-params/v1',
    status: 'proposed',                 // GUARDRAIL #3 — never auto-active
    generated_at: new Date().toISOString(),
    window: { start: startISO, end: endISO, days, train_fraction: GATES.TRAIN_FRACTION },
    gates: GATES,
    universe: symbols,
    proposals: {},
    sector_view: sector,
    sector_view_disclaimer:
      'Sector slices are LOW-SAMPLE and INFORMATIONAL. Leadership persistence is real; ' +
      'specific params tuned on one sector-week are usually noise. Optimize on the broad ' +
      'sample; use sector leadership as an additive score (pattern-rater.js), not a param source.',
  };

  for (const [scanner, r] of Object.entries(results)) {
    doc.proposals[scanner] = {
      best: r.accepted[0] || null,
      runners_up: r.accepted.slice(1, 3),
      combos_tested: r.combosTested,
      accepted_count: r.accepted.length,
      rejected_overfit: r.allEvaluated.filter((e) => e.verdict === 'rejected_validation_overfit').length,
      rejected_train: r.allEvaluated.filter((e) => e.verdict === 'rejected_train').length,
      note: r.accepted.length
        ? 'PROPOSED only. Review train vs validation R before promoting. Paper-test first.'
        : 'NO combo passed both the sample gate and out-of-sample validation. This is a HONEST null result — do not force it. Gather more data or accept this scanner has no edge on this universe/window.',
    };
  }

  if (opts.write !== false) {
    await fs.writeFile(OUTFILE, JSON.stringify(doc, null, 2), 'utf8');
    console.log(`[params] wrote PROPOSED params to ${OUTFILE}`);
  }
  return doc;
}

module.exports = { optimize, optimizeScanner, sectorView, gridCombos, GATES, GRIDS, OUTFILE };

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const symbols = (get('--symbols', '') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const days = parseInt(get('--days', '90'), 10);
  const scanner = get('--scanner', null);

  if (!symbols.length) {
    console.log('Usage: node scanner-params.js --symbols AMD,NVDA,MSFT [--days 90] [--scanner orb|reversal]');
    console.log('(Requires cached 1Min + 1Day bars for each symbol — run alpaca-history.js first.)');
    console.log('\nGuardrails:', JSON.stringify(GATES, null, 2));
    process.exit(0);
  }

  optimize({ symbols, days, scanner })
    .then((doc) => {
      console.log(`\nstatus: ${doc.status} | window ${doc.window.start}→${doc.window.end}`);
      for (const [s, p] of Object.entries(doc.proposals)) {
        console.log(`\n=== ${s.toUpperCase()} ===`);
        console.log(`  tested ${p.combos_tested} combos | accepted ${p.accepted_count} | ` +
                    `rejected(train) ${p.rejected_train} | rejected(overfit) ${p.rejected_overfit}`);
        if (p.best) {
          console.log('  BEST (proposed):', JSON.stringify(p.best.params));
          console.log(`    train:      ${p.best.train.trades} trades, ${p.best.train.win_rate}% WR, ${p.best.train.expectancy_r}R`);
          console.log(`    validation: ${p.best.validation.trades} trades, ${p.best.validation.win_rate}% WR, ${p.best.validation.expectancy_r}R`);
        } else {
          console.log('  ' + p.note);
        }
      }
      process.exit(0);
    })
    .catch((e) => { console.error('Optimize failed:', e.message); process.exit(1); });
}
