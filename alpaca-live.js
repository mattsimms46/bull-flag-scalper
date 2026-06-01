'use strict';

/**
 * alpaca-live.js  —  WickED Real-Time Market Data (Alpaca WebSocket)
 * ============================================================================
 * Drop-in replacement for the Polygon WebSocket in scanner-server.js.
 * Streams real-time minute bars (and optionally trades) from Alpaca and hands
 * each bar to your scanners via a simple callback.
 *
 * ── WHERE DO THE KEY AND SECRET GO? ──────────────────────────────────────────
 *   RAILWAY ENVIRONMENT VARIABLES. NOWHERE ELSE.
 *     ALPACA_API_KEY     = <your key id>
 *     ALPACA_API_SECRET  = <your secret>
 *   This file reads them as process.env.ALPACA_API_KEY / ALPACA_API_SECRET.
 *   They must NEVER appear in code, in the repo, in the browser/Worker, or in chat.
 *   Because the secret lives here server-side, the live stream runs on Railway,
 *   not in the dashboard.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * VERIFIED CONTRACT (Alpaca Market Data v2 stream):
 *   URL:    wss://stream.data.alpaca.markets/v2/{feed}   feed = 'sip' (your plan) | 'iex' (free)
 *   FLOW:   server sends [{"T":"success","msg":"connected"}]
 *           -> client sends {"action":"auth","key":..,"secret":..}   (within 10s!)
 *           -> server sends [{"T":"success","msg":"authenticated"}]
 *           -> client sends {"action":"subscribe","bars":["*"],"trades":[...]}
 *   BARS:   {"T":"b","S":"AAPL","o":..,"h":..,"l":..,"c":..,"v":..,"t":ISO,"n":..,"vw":..}
 *   LIMITS: ONE concurrent connection per account. bars:["*"] is unlimited channels.
 *           => this module is a SINGLETON and reconnects rather than duplicating.
 *
 * INTERFACE (what scanner-server.js consumes):
 *   const live = require('./alpaca-live');
 *   const conn = live.connect(tickers, onBar, opts?);
 *     - tickers: array of symbols, or ['*'] for every symbol's minute bars
 *     - onBar(bar): called per minute bar; bar = normalized shape (see below)
 *     - opts: { feed, onTrade, onStatus, onError }
 *   conn.subscribe(extraTickers) / conn.unsubscribe(tickers) / conn.close()
 *
 * NORMALIZED BAR (so scanners don't learn Alpaca's terse keys):
 *   { symbol, o, h, l, c, v, vw, n, t, source:'alpaca' }
 *
 * Requires the 'ws' package (already in your package.json). Node 18+.
 */

const WebSocket = require('ws');

const ALPACA_API_KEY    = process.env.ALPACA_API_KEY;
const ALPACA_API_SECRET = process.env.ALPACA_API_SECRET;

const DEFAULTS = {
  feed: 'sip',                 // 'sip' (Algo Trader Plus) | 'iex' (free) | 'delayed_sip'
  authTimeoutMs: 9000,         // must auth within 10s; we use 9s to be safe
  reconnectBaseMs: 1000,       // backoff: 1s,2s,4s,8s… capped
  reconnectMaxMs: 30000,
  pingIntervalMs: 20000,       // keepalive
};

/**
 * Singleton connection. Calling connect() again reuses/replaces the live socket
 * (Alpaca allows only ONE concurrent connection per account).
 */
let _client = null;

function connect(tickers, onBar, opts = {}) {
  if (_client) {
    // Reuse the existing connection; just add the requested subscriptions.
    if (onBar) _client.onBar = onBar;
    if (tickers && tickers.length) _client.subscribe(tickers);
    return _client;
  }
  _client = new AlpacaLiveClient(tickers || ['*'], onBar, opts);
  _client.open();
  return _client;
}

function getClient() { return _client; }

class AlpacaLiveClient {
  constructor(tickers, onBar, opts) {
    if (!ALPACA_API_KEY || !ALPACA_API_SECRET) {
      throw new Error('ALPACA_API_KEY / ALPACA_API_SECRET not set (configure in Railway env)');
    }
    this.cfg = { ...DEFAULTS, ...opts };
    this.url = `wss://stream.data.alpaca.markets/v2/${this.cfg.feed}`;
    this.onBar = onBar || (() => {});
    this.onTrade = opts.onTrade || null;
    this.onStatus = opts.onStatus || (() => {});
    this.onError = opts.onError || ((e) => console.error('[alpaca-live]', e.message || e));

    // desired subscription state (so we can re-subscribe after a reconnect)
    this.barSubs = new Set();
    this.tradeSubs = new Set();
    for (const t of tickers || []) this.barSubs.add(t);

    this.ws = null;
    this.authed = false;
    this.reconnectAttempt = 0;
    this.authTimer = null;
    this.pingTimer = null;
    this.intentionalClose = false;
  }

  open() {
    this.intentionalClose = false;
    this.authed = false;
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      // Alpaca sends {"T":"success","msg":"connected"} first; we auth on receipt.
      this.authTimer = setTimeout(() => {
        if (!this.authed) { this.onError(new Error('auth timeout — closing')); this._hardReset(); }
      }, this.cfg.authTimeoutMs);
    });

    this.ws.on('message', (raw) => this._onMessage(raw));
    this.ws.on('error', (e) => this.onError(e));
    this.ws.on('close', () => this._onClose());
    this.ws.on('pong', () => {});
  }

  _onMessage(raw) {
    let msgs;
    try { msgs = JSON.parse(raw.toString()); } catch { return; }
    if (!Array.isArray(msgs)) msgs = [msgs];

    for (const m of msgs) {
      switch (m.T) {
        case 'success':
          if (m.msg === 'connected') this._authenticate();
          else if (m.msg === 'authenticated') this._onAuthenticated();
          break;
        case 'error':
          this.onError(new Error(`Alpaca stream error ${m.code}: ${m.msg}`));
          // 406 = connection limit, 402 = auth failed, etc. Don't hammer on auth failures.
          if (m.code === 402 || m.code === 403 || m.code === 404) this.intentionalClose = true;
          break;
        case 'subscription':
          this.onStatus({ type: 'subscription', bars: m.bars, trades: m.trades, quotes: m.quotes });
          break;
        case 'b':              // minute bar
          this.onBar(normalizeBar(m));
          break;
        case 't':              // trade (only if subscribed)
          if (this.onTrade) this.onTrade(normalizeTrade(m));
          break;
        default:
          // ignore quotes/status/other channels we didn't ask for
          break;
      }
    }
  }

  _authenticate() {
    this._send({ action: 'auth', key: ALPACA_API_KEY, secret: ALPACA_API_SECRET });
  }

  _onAuthenticated() {
    this.authed = true;
    this.reconnectAttempt = 0;
    if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
    // (re)subscribe to whatever we wanted
    this._sendSubscriptions();
    this._startPing();
    this.onStatus({ type: 'authenticated' });
    console.log(`[alpaca-live] authenticated on ${this.cfg.feed}; bars=[${[...this.barSubs].join(',')}]`);
  }

  _sendSubscriptions() {
    const payload = { action: 'subscribe' };
    if (this.barSubs.size) payload.bars = [...this.barSubs];
    if (this.tradeSubs.size) payload.trades = [...this.tradeSubs];
    if (payload.bars || payload.trades) this._send(payload);
  }

  subscribe(tickers = [], { trades = false } = {}) {
    const set = trades ? this.tradeSubs : this.barSubs;
    const added = [];
    for (const t of tickers) if (!set.has(t)) { set.add(t); added.push(t); }
    if (added.length && this.authed) {
      const payload = { action: 'subscribe' };
      payload[trades ? 'trades' : 'bars'] = added;
      this._send(payload);
    }
    return this;
  }

  unsubscribe(tickers = [], { trades = false } = {}) {
    const set = trades ? this.tradeSubs : this.barSubs;
    const removed = [];
    for (const t of tickers) if (set.delete(t)) removed.push(t);
    if (removed.length && this.authed) {
      const payload = { action: 'unsubscribe' };
      payload[trades ? 'trades' : 'bars'] = removed;
      this._send(payload);
    }
    return this;
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping();
    }, this.cfg.pingIntervalMs);
  }
  _stopPing() { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; } }

  _onClose() {
    this._stopPing();
    this.authed = false;
    if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
    if (this.intentionalClose) { this.onStatus({ type: 'closed' }); return; }
    // exponential backoff reconnect
    const delay = Math.min(this.cfg.reconnectMaxMs, this.cfg.reconnectBaseMs * 2 ** this.reconnectAttempt);
    this.reconnectAttempt++;
    this.onStatus({ type: 'reconnecting', attempt: this.reconnectAttempt, delayMs: delay });
    console.warn(`[alpaca-live] disconnected — reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    setTimeout(() => { if (!this.intentionalClose) this.open(); }, delay);
  }

  _hardReset() {
    try { this.ws && this.ws.terminate(); } catch {}
  }

  close() {
    this.intentionalClose = true;
    this._stopPing();
    if (this.authTimer) clearTimeout(this.authTimer);
    try { this.ws && this.ws.close(); } catch {}
    if (_client === this) _client = null;
  }
}

// ── normalizers: hide Alpaca's terse keys from the scanners ──────────────────
function normalizeBar(m) {
  return {
    symbol: m.S,
    o: m.o, h: m.h, l: m.l, c: m.c,
    v: m.v, vw: m.vw, n: m.n,
    t: m.t,                 // RFC-3339 UTC
    source: 'alpaca',
  };
}
function normalizeTrade(m) {
  return { symbol: m.S, price: m.p, size: m.s, t: m.t, source: 'alpaca' };
}

module.exports = { connect, getClient, AlpacaLiveClient, normalizeBar, normalizeTrade };

// ── manual smoke test: `node alpaca-live.js AAPL,MSFT` (needs env creds) ─────
if (require.main === module) {
  if (!ALPACA_API_KEY || !ALPACA_API_SECRET) {
    console.log('Set ALPACA_API_KEY and ALPACA_API_SECRET in env to test.');
    console.log('Interface check only:');
    console.log('  exports:', Object.keys(module.exports).join(', '));
    process.exit(0);
  }
  const tickers = (process.argv[2] || '*').split(',');
  console.log(`[alpaca-live] connecting, subscribing bars=[${tickers.join(',')}] …`);
  const conn = connect(tickers, (bar) => {
    console.log(`BAR ${bar.symbol} o=${bar.o} h=${bar.h} l=${bar.l} c=${bar.c} v=${bar.v} @ ${bar.t}`);
  }, {
    onStatus: (s) => console.log('[status]', JSON.stringify(s)),
    onError: (e) => console.error('[error]', e.message || e),
  });
  process.on('SIGINT', () => { console.log('\nclosing…'); conn.close(); process.exit(0); });
}
