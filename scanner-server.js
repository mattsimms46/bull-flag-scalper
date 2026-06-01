'use strict';
// ─── WickED Scanner Server — All-in-one ──────────────────────────────────────
// Scalp + ORB + Reversal + API + Gap + Wind-down + Recap
// Data: Alpaca (live bars) + Polygon (pre-market snapshot)

const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');

// Alpaca live stream (replaces Polygon WebSocket)
const alpacaLive = require('./alpaca-live');

// Pre-market scanner (Alpaca variant — universe-based)
const premarketScanner = require('./premarket-scanner-alpaca');

// Sector rotation + pattern rating (Session 4 additions)
const sectorScanner = require('./sector-scanner');
const patternRater  = require('./pattern-rater');

// ── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT  || process.env.TELEGRAM_CHAT_ID;
const API_SECRET     = process.env.API_SECRET     || 'wicked-secret-change-me';
const PORT           = parseInt(process.env.PORT  || '8080');
const MIN_PRICE      = parseFloat(process.env.MIN_PRICE   || '1');
const MAX_PRICE      = parseFloat(process.env.MAX_PRICE   || '20');
const MIN_RVOL       = parseFloat(process.env.MIN_RVOL    || '5');

// Pattern-score gate. Kept LOW by default because the rater pulls scores
// toward neutral while it has little history (LEARNING mode). Raise this as
// your trade log grows and the rater earns confidence. The gate is also
// bypassed entirely while a rating's confidence === 'LEARNING' (see rateAndGate).
const MIN_PATTERN_SCORE = parseFloat(process.env.MIN_PATTERN_SCORE || '3');

// Load PROPOSED scanner params (optional — absent until you run the optimizer).
// Informational/governance only here; the rater reads the file itself too.
let scannerParams = null;
(function loadScannerParams() {
  try {
    const p = path.join(__dirname, 'scanner-params.json');
    if (fs.existsSync(p)) {
      scannerParams = JSON.parse(fs.readFileSync(p, 'utf8'));
      log(`Loaded scanner-params.json (status=${scannerParams.status}, generated=${scannerParams.generated_at}). PROPOSED only — not auto-armed.`);
    } else {
      log('No scanner-params.json yet — rater will derive ranges from the trade log.');
    }
  } catch (e) { log(`scanner-params load: ${e.message}`); }
})();

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// ── Process guards ────────────────────────────────────────────────────────────
process.on('uncaughtException', e => log(`Uncaught: ${e.message}`));
process.on('unhandledRejection', r => log(`Unhandled: ${r}`));

// ── Telegram ──────────────────────────────────────────────────────────────────
function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: 'HTML' });
  const opts = {
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  const req = https.request(opts, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => { if (res.statusCode !== 200) log(`Telegram ${res.statusCode}: ${d.slice(0,200)}`); });
  });
  req.on('error', e => log(`Telegram: ${e.message}`));
  req.write(body); req.end();
}

// ── Data file ─────────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'wicked-data.json');
function readData() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e) { log(`Data read: ${e.message}`); }
  return { alerts:[], journal:[], wheel:[], bnh:[], portfolio:{size:0}, updatedAt:null };
}
function writeData(data) {
  try { data.updatedAt = new Date().toISOString(); fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2)); return true; }
  catch(e) { log(`Data write: ${e.message}`); return false; }
}
function pushAlert(alert) {
  try {
    const data = readData();
    alert.id   = Date.now() + Math.random().toString(36).slice(2,6);
    alert.time = new Date().toISOString();
    alert.outcome = null; alert.notes = '';
    data.alerts.unshift(alert);
    // Keep only today's alerts on server (dashboard localStorage is the persistent store)
    const today = new Date().toDateString();
    data.alerts = data.alerts.filter(a => new Date(a.time).toDateString() === today).slice(0,200);
    writeData(data);
  } catch(e) { log(`Alert store: ${e.message}`); }
}

// ── Market Bias ───────────────────────────────────────────────────────────────
let marketBias = 'NEUTRAL';

async function updateMarketBias() {
  try {
    // Use Alpaca for market bias via recent daily bars
    const headers = {
      'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET,
      'Accept': 'application/json',
    };
    if (!headers['APCA-API-KEY-ID']) return;
    const to   = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - 5*864e5).toISOString().split('T')[0];
    const url  = `https://data.alpaca.markets/v2/stocks/bars?symbols=SPY,QQQ&timeframe=1Day&start=${from}&end=${to}&feed=sip&sort=desc&limit=4`;
    const res  = await fetch(url, { headers });
    if (!res.ok) return;
    const json = await res.json();
    const bars  = json.bars || {};
    let score = 0;
    for (const sym of ['SPY','QQQ']) {
      const arr = bars[sym];
      if (arr && arr.length >= 2) {
        if (arr[0].c > arr[1].c) score++; else score--;
        if (arr[0].c > (arr[0].o + arr[0].c)/2) score++;
      }
    }
    marketBias = score >= 2 ? 'BULLISH' : score <= -2 ? 'BEARISH' : 'NEUTRAL/CHOPPY';
    log(`Market bias: ${marketBias} (score ${score})`);
  } catch(e) { log(`Bias: ${e.message}`); }
}

function biasEmoji() {
  return marketBias === 'BULLISH' ? '🟢' : marketBias === 'BEARISH' ? '🔴' : '🟡';
}

// ── API Server ────────────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-API-Secret',
    'Content-Type': 'application/json',
  };
}
function parseBody(req) {
  return new Promise((resolve,reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body||'{}')); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

http.createServer(async (req,res) => {
  const h = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204,h); res.end(); return; }
  const url = req.url.split('?')[0];
  const authed = req.headers['x-api-secret'] === API_SECRET;

  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200,h);
    res.end(JSON.stringify({ status:'ok', bias:marketBias, time:new Date().toISOString() }));
    return;
  }
  if (req.method === 'GET' && url === '/data') {
    if (!authed) { res.writeHead(401,h); res.end(JSON.stringify({error:'Unauthorized'})); return; }
    const data = readData(); data.marketBias = marketBias;
    res.writeHead(200,h); res.end(JSON.stringify(data)); return;
  }
  if (req.method === 'POST' && url === '/data') {
    if (!authed) { res.writeHead(401,h); res.end(JSON.stringify({error:'Unauthorized'})); return; }
    try {
      const body = await parseBody(req);
      writeData({ ...readData(), ...body });
      res.writeHead(200,h); res.end(JSON.stringify({success:true}));
    } catch(e) { res.writeHead(400,h); res.end(JSON.stringify({error:e.message})); }
    return;
  }
  if (req.method === 'POST' && url === '/alert') {
    if (!authed) { res.writeHead(401,h); res.end(JSON.stringify({error:'Unauthorized'})); return; }
    try { const alert = await parseBody(req); pushAlert(alert); res.writeHead(200,h); res.end(JSON.stringify({success:true})); }
    catch(e) { res.writeHead(400,h); res.end(JSON.stringify({error:e.message})); }
    return;
  }
  if (req.method === 'POST' && url === '/outcome') {
    if (!authed) { res.writeHead(401,h); res.end(JSON.stringify({error:'Unauthorized'})); return; }
    try {
      const {id,outcome,notes} = await parseBody(req);
      const data = readData();
      const alert = data.alerts.find(a => a.id === id);
      if (!alert) throw new Error('Alert not found');
      alert.outcome = outcome; alert.notes = notes||'';
      const ei = data.journal.findIndex(j => j.alertId === id);
      const entry = {alertId:id,type:alert.type,ticker:alert.ticker,time:alert.time,outcome,notes:notes||'',conviction:alert.conviction,rsi:alert.rsi,rvol:alert.rvol};
      if (ei >= 0) data.journal[ei] = entry; else data.journal.unshift(entry);
      writeData(data);
      res.writeHead(200,h); res.end(JSON.stringify({success:true}));
    } catch(e) { res.writeHead(400,h); res.end(JSON.stringify({error:e.message})); }
    return;
  }
  res.writeHead(404,h); res.end(JSON.stringify({error:'Not found'}));
}).listen(PORT, '0.0.0.0', () => log(`API server on port ${PORT}`));

// ── Helpers ───────────────────────────────────────────────────────────────────
function calcRSI(bars, period=7) {
  if (bars.length < period+1) return null;
  const closes = bars.map(b => b.c||b.close);
  let gains=0, losses=0;
  for (let i=closes.length-period; i<closes.length; i++) {
    const d = closes[i]-closes[i-1];
    if (d>0) gains+=d; else losses-=d;
  }
  const ag=gains/period, al=losses/period;
  if (al===0) return 100;
  return Math.round((100-100/(1+ag/al))*10)/10;
}

function calcVWAP(bars) {
  let tpv=0, vol=0;
  for (const b of bars) {
    const o=b.o||b.open, h=b.h||b.high, l=b.l||b.low, c=b.c||b.close, v=b.v||b.vol||0;
    const tp=(o+h+l+c)/4; tpv+=tp*v; vol+=v;
  }
  return vol>0 ? tpv/vol : null;
}

function vwapLabel(price, vwap) {
  if (!vwap) return {label:'N/A', emoji:'⬜', pct:null};
  const pct = ((price-vwap)/vwap*100);
  if (pct>3)  return {label:`${pct.toFixed(1)}% above VWAP`, emoji:'🔴', pct};
  if (pct>0)  return {label:`${pct.toFixed(1)}% above VWAP`, emoji:'🟢', pct};
  if (pct>-3) return {label:`${pct.toFixed(1)}% below VWAP`, emoji:'🟡', pct};
  return           {label:`${pct.toFixed(1)}% below VWAP`, emoji:'🔴', pct};
}

function calcATR(bars, period=14) {
  if (bars.length < period+1) return null;
  const trs = [];
  for (let i=1; i<bars.length; i++) {
    const p=bars[i-1], c=bars[i];
    const ph=p.h||p.high||p.c||p.close, pl=p.l||p.low||p.c||p.close, pc=p.c||p.close;
    const ch=c.h||c.high, cl=c.l||c.low;
    trs.push(Math.max(ch-cl, Math.abs(ch-pc), Math.abs(cl-pc)));
  }
  return trs.slice(-period).reduce((a,b)=>a+b,0)/period;
}

function getET() { return new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'})); }
function getETMins() { const et=getET(); return et.getHours()*60+et.getMinutes(); }
function isWeekday() { const d=getET().getDay(); return d>=1&&d<=5; }

// ── Pattern rating helper ───────────────────────────────────────────────────
// Rates an ORB/reversal setup, decides whether to alert, and returns a
// Telegram-ready block. Returns { allow, scoreLine, rating }.
//
// GATE LOGIC (honest): while the rater is in LEARNING mode it deliberately
// can't be confident, so we ALWAYS allow the alert (annotated) and let you
// see every setup. Once confidence is DEVELOPING/ESTABLISHED, the numeric
// gate (MIN_PATTERN_SCORE) applies.
async function rateAndGate(setup) {
  try {
    const rating = await patternRater.ratePattern(setup, {
      isLeaderStock: sectorScanner.isLeaderStock,
    });
    const learning = rating.confidence === 'LEARNING';
    const allow = learning ? true : (rating.score >= MIN_PATTERN_SCORE);
    const stars = '★'.repeat(Math.round(rating.score / 2)) +
                  '☆'.repeat(5 - Math.round(rating.score / 2));
    const conf = rating.confidence === 'ESTABLISHED' ? '' : ` [${rating.confidence}]`;
    const sectorCtx = sectorScanner.getStockSector(setup.symbol);
    const leaders = sectorScanner.getLeadingSectors().map(s => s.etf);
    const sectorLine = sectorCtx
      ? `🧭 Sector: ${sectorCtx}${leaders.includes(sectorCtx) ? ' (LEADING)' : ''}`
      : '';
    const scoreLine =
      `\n📊 Pattern: <b>${rating.score}/10</b> ${stars}${conf}\n` +
      `~ ${rating.similar_to}\n` +
      (sectorLine ? sectorLine + '\n' : '') +
      rating.reasons.map(r => `  • ${r}`).join('\n');
    return { allow, scoreLine, rating };
  } catch (e) {
    // Never let rating failure block a real setup — fail open, unannotated.
    log(`Pattern rate: ${e.message}`);
    return { allow: true, scoreLine: '', rating: null };
  }
}

// Merge today's leading-sector names into a base ticker list (deduped,
// symbol-clean). Used to expand ORB + reversal universes at startup.
function withLeadingSectorNames(baseList) {
  try {
    const leaders = sectorScanner.getLeadingSectors(); // [{etf,name,names:[...]}]
    const add = [];
    for (const s of leaders) for (const sym of (s.names || [])) add.push(sym);
    return [...new Set([...baseList, ...add])].filter(t => t.length <= 5 && /^[A-Z]+$/.test(t));
  } catch (e) { log(`sector merge: ${e.message}`); return baseList; }
}

// Time-of-day bucket from current ET minutes (minutes since 09:30).
function todBucketNow() {
  const m = getETMins() - 570;
  if (m < 0) return 'premarket';
  if (m < 60) return 'open';
  if (m < 210) return 'midday';
  if (m < 360) return 'afternoon';
  return 'close';
}

// ══════════════════════════════════════════════════════════════════════════════
// ── ALPACA LIVE CONNECTION ────────────────────────────────────────────────────
// One WebSocket, all scanners share it via onBar routing
// ══════════════════════════════════════════════════════════════════════════════
let liveConn = null;

// Per-scanner bar handlers - registered by each scanner on activation
const barHandlers = {
  scalp:    null,
  reversal: null,
  orb:      null,
};

function onBarRouter(bar) {
  // Route each bar to all active scanner handlers
  if (barHandlers.scalp)    barHandlers.scalp(bar);
  if (barHandlers.reversal) barHandlers.reversal(bar);
  if (barHandlers.orb)      barHandlers.orb(bar);
}

// ── Dynamic NASDAQ Universe ($20-$150) ───────────────────────────────────────
let _nasdaqUniverse = [];
let _universeFetchedAt = null;

async function fetchNasdaqUniverse(minPrice=20, maxPrice=150) {
  // Check cache — rebuild once per day
  const now = Date.now();
  if (_nasdaqUniverse.length && _universeFetchedAt && now - _universeFetchedAt < 23*3600*1000) {
    log(`Universe cache: ${_nasdaqUniverse.length} tickers`);
    return _nasdaqUniverse;
  }
  log(`Fetching NASDAQ universe $${minPrice}-$${maxPrice}...`);
  try {
    const headers = {
      'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET,
      'Accept': 'application/json',
    };
    // Get all active NASDAQ assets
    const res = await fetch(
      'https://paper-api.alpaca.markets/v2/assets?status=active&exchange=NASDAQ&asset_class=us_equity',
      { headers }
    );
    if (!res.ok) { log(`Assets fetch ${res.status}`); return _nasdaqUniverse; }
    const assets = await res.json();

    // Filter to tradeable, no OTC, clean symbols
    const candidates = assets
      .filter(a => a.tradable && a.shortable !== false && /^[A-Z]{1,5}$/.test(a.symbol))
      .map(a => a.symbol);

    log(`NASDAQ assets: ${candidates.length} tradeable symbols`);

    // Fetch current prices in batches to filter by price range
    const inRange = [];
    for (let i = 0; i < candidates.length; i += 100) {
      const batch = candidates.slice(i, i+100);
      try {
        const to   = new Date().toISOString().split('T')[0];
        const from = new Date(Date.now()-3*864e5).toISOString().split('T')[0];
        const r = await fetch(
          `https://data.alpaca.markets/v2/stocks/bars?symbols=${batch.join(',')}&timeframe=1Day&start=${from}&end=${to}&feed=sip&sort=desc&limit=1`,
          { headers }
        );
        if (!r.ok) continue;
        const json = await r.json();
        for (const [sym, bars] of Object.entries(json.bars || {})) {
          if (!bars.length) continue;
          const price = bars[0].c;
          if (price >= minPrice && price <= maxPrice) inRange.push(sym);
        }
      } catch(e) { log(`Batch price fetch: ${e.message}`); }
      // Small delay to avoid rate limits
      if (i + 100 < candidates.length) await new Promise(r => setTimeout(r, 300));
    }

    _nasdaqUniverse = inRange;
    _universeFetchedAt = now;
    log(`NASDAQ universe built: ${inRange.length} stocks between $${minPrice}-$${maxPrice}`);
    return inRange;
  } catch(e) {
    log(`Universe fetch failed: ${e.message}`);
    return _nasdaqUniverse;
  }
}

function ensureLiveConnection(tickers) {
  if (!liveConn) {
    log(`Connecting Alpaca live stream for ${tickers.length} tickers...`);
    liveConn = alpacaLive.connect(tickers, onBarRouter, {
      feed: process.env.ALPACA_FEED || 'sip',
      onStatus: s => log(`Alpaca stream: ${JSON.stringify(s)}`),
      onError:  e => log(`Alpaca error: ${e.message||e}`),
    });
  } else {
    liveConn.subscribe(tickers);
  }
}

function cleanupLiveConnection() {
  // Only close if ALL scanners are inactive
  if (!barHandlers.scalp && !barHandlers.reversal && !barHandlers.orb) {
    if (liveConn) { liveConn.close(); liveConn = null; }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── SCALP SCANNER (5am–10am, 1-min bars via Alpaca) ──────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
const SEED_TICKERS = [
  'SOFI','HOOD','MARA','RIOT','CIFR','CLSK','IREN','BITF','HUT','BTBT',
  'ACHR','JOBY','SPCE','RKLB','ASTS','LUNR','HIMS','DOCS','RDDT','SNAP',
  'PINS','NKLA','NIO','AMC','GME','BB','CLOV','EVGO','QUBT','KULR',
  'MVIS','OCGN','APLD','BTCS','ATOS','RAIL','SDIG','UAVS','CLSK',
];

let scalpBars   = {}; // symbol -> [normalized bars]
let scalpAvgVol = {};
let scalpFloat  = {};
let scalpAlerted = new Set();
let scalpActive  = false;

async function fetchScalpMeta(ticker) {
  try {
    const headers = { 'APCA-API-KEY-ID':process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY':process.env.ALPACA_API_SECRET, 'Accept':'application/json' };
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now()-20*864e5).toISOString().split('T')[0];
    const res = await fetch(`https://data.alpaca.markets/v2/stocks/bars?symbols=${ticker}&timeframe=1Day&start=${from}&end=${to}&feed=sip&sort=desc&limit=15`, {headers});
    if (!res.ok) return;
    const json = await res.json();
    const arr = (json.bars||{})[ticker]||[];
    if (arr.length>=3) scalpAvgVol[ticker] = arr.slice(0,10).reduce((s,r)=>s+r.v,0)/Math.min(10,arr.length);
  } catch(e){}
}

async function buildScalpUniverse() {
  log('Building scalp universe...');
  const tickers = new Set(SEED_TICKERS);
  // Add pre-market watchlist if available
  const pmList = premarketScanner.getPremarketWatchlist();
  for (const item of pmList) tickers.add(item.symbol);
  const list = [...tickers].slice(0,150).filter(t=>t.length<=5&&/^[A-Z]+$/.test(t));
  for (let i=0; i<list.length; i+=10)
    await Promise.allSettled(list.slice(i,i+10).map(t=>fetchScalpMeta(t)));
  return list;
}

function detectScalpFlag(ticker) {
  const b = scalpBars[ticker];
  if (!b||b.length<8) return null;
  const n = b.length;
  for (let poleLen=3; poleLen<=8; poleLen++) {
    for (let i=n-1; i>=poleLen+2; i--) {
      const ps=i-poleLen; if(ps<0) break;
      const pole=b.slice(ps,i);
      const poleGain=(b[i-1].c-b[ps].o)/b[ps].o;
      if (poleGain<0.02) continue;
      const greenCount=pole.filter(c=>c.c>c.o).length;
      if (greenCount<Math.ceil(poleLen*0.65)) continue;
      const avgPoleVol=pole.reduce((s,c)=>s+c.v,0)/poleLen;
      const dailyAvg=scalpAvgVol[ticker]||0;
      const avgBarVol=dailyAvg/390;
      if (avgBarVol>0&&avgPoleVol<avgBarVol*MIN_RVOL) continue;
      const flagCandles=b.slice(i,Math.min(i+6,n));
      if (flagCandles.length<2) continue;
      const flagHigh=Math.max(...flagCandles.map(c=>c.h));
      const flagLow=Math.min(...flagCandles.map(c=>c.l));
      const poleTop=b[i-1].c, poleBtm=b[ps].o, poleH=poleTop-poleBtm;
      if ((flagHigh-flagLow)/poleTop>0.04) continue;
      const avgFlagVol=flagCandles.reduce((s,c)=>s+c.v,0)/flagCandles.length;
      if (avgFlagVol>=avgPoleVol*0.80) continue;
      const flagAvg=flagCandles.reduce((s,c)=>s+c.c,0)/flagCandles.length;
      if (flagAvg<poleBtm+poleH*0.5) continue;
      const currentPrice=b[n-1].c;
      const vwap=calcVWAP(b);
      const vwapInfo=vwapLabel(currentPrice,vwap);
      if (vwapInfo.pct&&vwapInfo.pct>5) continue;
      // Boost conviction if pre-market in-play
      const inPlay = premarketScanner.isInPlay(ticker);
      const pmMeta = premarketScanner.getInPlayMeta(ticker);
      return {
        ticker, currentPrice:currentPrice.toFixed(2),
        poleGain:(poleGain*100).toFixed(1), poleBars:poleLen,
        flagBars:flagCandles.length, flagRange:((flagHigh-flagLow)/poleTop*100).toFixed(2),
        spreadPct:((b[n-1].h-b[n-1].l)/currentPrice*100).toFixed(2),
        rVol:avgBarVol>0?(avgPoleVol/avgBarVol).toFixed(1):'N/A',
        breakoutTarget:(poleTop*(1+poleGain)).toFixed(2),
        stopLoss:(flagLow*0.99).toFixed(2),
        vwap:vwap?vwap.toFixed(2):null, vwapInfo,
        inPlay, pmMeta,
      };
    }
  }
  return null;
}

function formatScalpAlert(f) {
  const time=new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'});
  const vwapLine=f.vwap?`${f.vwapInfo.emoji} VWAP: $${f.vwap} (${f.vwapInfo.label})`:'';
  const pmLine=f.inPlay&&f.pmMeta?`🔥 IN PLAY: +${f.pmMeta.relVolPctOfDay}% of yest vol pre-market`:'' ;
  const lines=[
    `🚨 <b>BULL FLAG - ${f.ticker}</b>`,
    `⏰ ${time} ET | ${biasEmoji()} ${marketBias}`,
    ``,
    pmLine,
    `💰 Price: $${f.currentPrice}`,
    `📈 Pole: +${f.poleGain}% (${f.poleBars} bars)`,
    `🏁 Flag: ${f.flagBars} bars, ${f.flagRange}% range`,
    `⚡ Rel Vol: ${f.rVol}x`,
    vwapLine,
    ``,
    `🎯 Target: $${f.breakoutTarget}`,
    `🛑 Stop: $${f.stopLoss}`,
    ``,
    `<i>1-min scalp via Alpaca SIP</i>`,
  ].filter(l=>l!==undefined);
  return lines.join('\n');
}

async function startScalp() {
  log('Scalp scanner starting');
  scalpActive=true; scalpAlerted.clear(); scalpBars={};
  const tickers = await buildScalpUniverse();

  barHandlers.scalp = (bar) => {
    const ticker = bar.symbol; if(!ticker) return;
    if (bar.c<MIN_PRICE||bar.c>MAX_PRICE) return;
    if (!scalpBars[ticker]) scalpBars[ticker]=[];
    scalpBars[ticker].push(bar);
    if (scalpBars[ticker].length>60) scalpBars[ticker].shift();
    if (!scalpAlerted.has(ticker)) {
      const flag=detectScalpFlag(ticker);
      if (flag) {
        scalpAlerted.add(ticker);
        log(`🚨 SCALP: ${ticker} @ $${flag.currentPrice} +${flag.poleGain}% ${flag.rVol}x`);
        sendTelegram(formatScalpAlert(flag));
        pushAlert({type:'scalp',ticker,direction:'bull',price:flag.currentPrice,pole:flag.poleGain,rvol:flag.rVol,rsi:null,target:flag.breakoutTarget,stop:flag.stopLoss,vwap:flag.vwapInfo?.label||null,conviction:Math.min(5,Math.round(parseFloat(flag.rVol||0)/2)+2+(flag.inPlay?1:0))});
        setTimeout(()=>scalpAlerted.delete(ticker),30*60*1000);
      }
    }
  };

  ensureLiveConnection(tickers);

}

function stopScalp() {
  scalpActive=false; barHandlers.scalp=null;
  scalpBars={}; scalpAlerted.clear();
  log('Scalp stopped');

  cleanupLiveConnection();
}

async function checkScalpSchedule() {
  const h=getET().getHours();
  if (isWeekday()&&h>=5&&h<10) { if(!scalpActive) await startScalp(); }
  else { if(scalpActive) stopScalp(); }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── REVERSAL SCANNER (9:30-10:30am, 5-min bars) ──────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
const REVERSAL_TICKERS = [
  'SOFI','HOOD','MARA','RIOT','HIMS','RDDT','SNAP','AMC','GME','NIO',
  'NVDA','AMD','TSLA','META','AAPL','MSFT','AMZN','GOOGL','AVGO','PLTR',
  'CRWD','DDOG','NET','PANW','COIN','SQ','UBER','RBLX','SHOP','NFLX',
  'SPY','QQQ','IWM','SOXL','TQQQ','GLD','SLV','ARKK','LABU','UVXY',
];

let revBars5m  = {};
let revLevels  = {};
let revAvgBarVol={};
let revAlerted = new Set();
let revActive  = false;

function classifyCandle(bar) {
  const totalRange=bar.h-bar.l; if(totalRange===0) return 'doji';
  const body=Math.abs(bar.c-bar.o), bodyPct=body/totalRange;
  const upper=bar.h-Math.max(bar.o,bar.c);
  const lower=Math.min(bar.o,bar.c)-bar.l;
  const isGreen=bar.c>=bar.o;
  if(bodyPct>0.75) return isGreen?'marubozu_green':'marubozu_red';
  if(bodyPct<0.10) return 'doji';
  if(bodyPct<0.30&&upper>body*0.5&&lower>body*0.5) return 'spinning_top';
  if(upper>body*2&&lower<body*0.5&&!isGreen) return 'shooting_star';
  if(lower>body*2&&upper<body*0.5&&isGreen) return 'hammer';
  if(upper>totalRange*0.4||lower>totalRange*0.4) return 'wick_reversal';
  return 'normal';
}

function isExhaustionCandle(bar) {
  return ['doji','spinning_top','shooting_star','hammer','wick_reversal'].includes(classifyCandle(bar));
}

async function fetchRevLevels(ticker) {
  try {
    const headers={'APCA-API-KEY-ID':process.env.ALPACA_API_KEY,'APCA-API-SECRET-KEY':process.env.ALPACA_API_SECRET,'Accept':'application/json'};
    const to=new Date().toISOString().split('T')[0];
    const from=new Date(Date.now()-7*864e5).toISOString().split('T')[0];
    const res=await fetch(`https://data.alpaca.markets/v2/stocks/bars?symbols=${ticker}&timeframe=1Day&start=${from}&end=${to}&feed=sip&sort=desc&limit=5`,{headers});
    if (!res.ok) return;
    const json=await res.json();
    const arr=(json.bars||{})[ticker]||[];
    const levels={prevHigh:null,prevLow:null,prevClose:null,srLevels:[]};
    if (arr.length>=2) {
      const p=arr[1]; levels.prevHigh=p.h; levels.prevLow=p.l; levels.prevClose=p.c;
      revAvgBarVol[ticker]=(arr[0].v||0)/78;
    }
    revLevels[ticker]=levels;
  } catch(e){}
}

function detectReversal(ticker) {
  const b=revBars5m[ticker]; if(!b||b.length<7) return null;
  const n=b.length;
  for (let ei=n-1; ei>=n-3; ei--) {
    const exhaustBar=b[ei];
    if (!isExhaustionCandle(exhaustBar)) continue;
    const avgVol=revAvgBarVol[ticker]||0;
    if (avgVol>0&&exhaustBar.v<avgVol*3) continue;
    for (let poleLen=4; poleLen<=5; poleLen++) {
      const ps=ei-poleLen; if(ps<0) continue;
      const pole=b.slice(ps,ei);
      const allGreen=pole.every(c=>c.c>c.o);
      const allRed=pole.every(c=>c.c<c.o);
      if (!allGreen&&!allRed) continue;
      const marubozuCount=pole.filter(c=>{const r=c.h-c.l,body=Math.abs(c.c-c.o);return r>0&&body/r>0.60}).length;
      if (marubozuCount<3) continue;
      const avgPoleVol=pole.reduce((s,c)=>s+c.v,0)/poleLen;
      if (avgVol>0&&avgPoleVol<avgVol*1.5) continue;
      const direction=allGreen?'BEARISH REVERSAL':'BULLISH REVERSAL';
      const emoji=allGreen?'🔴':'🟢';
      const exhaustPrice=(exhaustBar.h+exhaustBar.l)/2;
      const levels=revLevels[ticker]||{prevHigh:null,prevLow:null,prevClose:null,srLevels:[]};
      const candidates=[];
      const check=(p,type)=>{if(p){const pct=Math.abs(exhaustPrice-p)/exhaustPrice;if(pct<=0.01)candidates.push({price:p,type,pct});}};
      check(levels.prevHigh,'Prev Day High'); check(levels.prevLow,'Prev Day Low'); check(levels.prevClose,'Prev Day Close');
      const srLevel=candidates.length?candidates.sort((a,b)=>a.pct-b.pct)[0]:null;
      const rsi=calcRSI(b.slice(0,ei+1));
      const rsiStars=rsi===null?'':rsi<=5||rsi>=95?'⭐⭐⭐':rsi<=10||rsi>=90?'⭐⭐':rsi<=20||rsi>=80?'⭐':'';
      const candleType=classifyCandle(exhaustBar).replace(/_/g,' ').toUpperCase();
      const poleMove=Math.abs((b[ei-1].c-b[ps].o)/b[ps].o*100).toFixed(1);
      return {ticker,direction,emoji,currentPrice:exhaustBar.c.toFixed(2),poleLen,poleMove,marubozuCount,candleType,exhaustVol:Math.round(exhaustBar.v),volSpike:avgVol>0?(exhaustBar.v/avgVol).toFixed(1):'N/A',rsi,rsiStars,srLevel,prevHigh:levels.prevHigh?.toFixed(2),prevLow:levels.prevLow?.toFixed(2),prevClose:levels.prevClose?.toFixed(2)};
    }
  }
  return null;
}

function formatRevAlert(r) {
  const time=new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'});
  const srHit=r.srLevel?`✅ AT ${r.srLevel.type.toUpperCase()} $${r.srLevel.price.toFixed(2)}`:'⚠️ Not at key level';
  const biasNote=marketBias==='BULLISH'&&r.direction.includes('BEARISH')?'⚠️ Counter-trend on bullish day':marketBias==='BEARISH'&&r.direction.includes('BULLISH')?'⚠️ Counter-trend on bearish day':'';
  return `${r.emoji} <b>${r.direction} - ${r.ticker}</b>
⏰ ${time} ET | ${biasEmoji()} ${marketBias}

💰 Price: $${r.currentPrice}
📊 RSI(7): ${r.rsi??'N/A'} ${r.rsiStars}
📈 Pole: ${r.poleLen} candles +${r.poleMove}% (${r.marubozuCount}/${r.poleLen} Marubozu)
🕯 Exhaustion: ${r.candleType}
⚡ Vol Spike: ${r.volSpike}x

📍 ${srHit}
🗓 PDH: $${r.prevHigh??'N/A'} PDL: $${r.prevLow??'N/A'} PDC: $${r.prevClose??'N/A'}
${biasNote}

<i>5-min reversal via Alpaca SIP</i>`;
}

async function startReversal() {
  log('Reversal scanner starting');
  revActive=true; revAlerted.clear(); revBars5m={};
  // Build dynamic universe: all NASDAQ $20-$150 + leader stocks
  const dynamicUniverse = await fetchNasdaqUniverse(20, 150);
  const revUniverse = [...new Set([...withLeadingSectorNames(REVERSAL_TICKERS), ...dynamicUniverse])].slice(0, 800);
  log(`Reversal universe: ${revUniverse.length} tickers`);
  for (let i=0; i<revUniverse.length; i+=20)
    await Promise.allSettled(revUniverse.slice(i,i+20).map(t=>fetchRevLevels(t)));

  const fiveMBuckets = {}; // ticker -> current 5-min bucket

  barHandlers.reversal = async (bar) => {
    const ticker=bar.symbol; if(!revUniverse.includes(ticker)) return;
    if (!fiveMBuckets[ticker]) fiveMBuckets[ticker]=null;
    const tsMs=new Date(bar.t).getTime();
    const bucket=Math.floor(tsMs/(5*60*1000));
    const last=fiveMBuckets[ticker];
    if (!last||last.bucket!==bucket) {
      if (last) {
        if (!revBars5m[ticker]) revBars5m[ticker]=[];
        revBars5m[ticker].push(last.bar);
        if (revBars5m[ticker].length>50) revBars5m[ticker].shift();
        if (revBars5m[ticker].length>=7&&!revAlerted.has(ticker)) {
          const rev=detectReversal(ticker);
          if (rev) {
            // Build the setup view the rater needs (values already computed above).
            const setup = {
              scanner: 'reversal', symbol: ticker,
              rsi: rev.rsi, marubozuCount: rev.marubozuCount, tod_bucket: todBucketNow(),
            };
            const { allow, scoreLine, rating } = await rateAndGate(setup);
            if (allow) {
              revAlerted.add(ticker);
              log(`${rev.emoji} REVERSAL: ${ticker} ${rev.direction} | pattern ${rating?rating.score:'n/a'}/10`);
              sendTelegram(formatRevAlert(rev) + scoreLine);
              pushAlert({type:'reversal',ticker,direction:rev.direction.includes('BULL')?'bull':'bear',price:rev.currentPrice,candleType:rev.candleType,rvol:rev.volSpike,rsi:rev.rsi,srLevel:rev.srLevel?.type||null,target:null,stop:null,conviction:rev.rsiStars.length+2,patternScore:rating?rating.score:null,patternConfidence:rating?rating.confidence:null});
              setTimeout(()=>revAlerted.delete(ticker),45*60*1000);
            } else {
              log(`REVERSAL ${ticker} suppressed: pattern ${rating.score}/10 < ${MIN_PATTERN_SCORE} (${rating.confidence})`);
            }
          }
        }
      }
      fiveMBuckets[ticker]={bucket,bar:{o:bar.o,h:bar.h,l:bar.l,c:bar.c,v:bar.v,t:bar.t}};
    } else {
      // Update current bucket
      last.bar.h=Math.max(last.bar.h,bar.h);
      last.bar.l=Math.min(last.bar.l,bar.l);
      last.bar.c=bar.c; last.bar.v+=bar.v;
    }
  };

  ensureLiveConnection(revUniverse);

}

function stopReversal() {
  revActive=false; barHandlers.reversal=null;
  revBars5m={}; revAlerted.clear();
  log('Rev stopped');

  cleanupLiveConnection();
}

async function checkRevSchedule() {
  const etMins=getETMins();
  if (isWeekday()&&etMins>=585&&etMins<780) { if(!revActive) await startReversal(); }
  else { if(revActive) stopReversal(); }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── ORB SCANNER (9:30-10:15am) ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
const ORB_TICKERS = [...new Set([
  'SOFI','HOOD','MARA','RIOT','HIMS','RDDT','SNAP','AMC','GME','NIO','ACHR','RKLB','ASTS',
  'NVDA','AMD','TSLA','META','AAPL','MSFT','AMZN','GOOGL','AVGO','ARM','QCOM','MU',
  'AMAT','LRCX','MRVL','NFLX','PLTR','CRWD','DDOG','NET','PANW','ZS','SNOW','APP',
  'SHOP','COIN','SQ','PYPL','UBER','RBLX','DUOL','FTNT','ADBE','CRM','NOW','INTU',
  'AMGN','GILD','MRNA','REGN','BKNG','ABNB','DASH','DKNG','LYFT',
  'SPY','QQQ','IWM','SOXL','TQQQ','LABU','ARKK','GLD','SLV','SQQQ',
  'V','MA','JPM','BAC','GS','WMT','COST','HD','NKE','SBUX',
])];

let orbData     = {};
let orbBars5m   = {};
let orbAtr      = {};
let orbPrevDay  = {};
let orbAvgBarVol= {};
let orbAlerted  = new Set();
let orbActive   = false;
let orbBriefSent= false;

function orbQuality(pct) {
  if(pct<=0.25) return{label:'ELITE',emoji:'🟢',stars:'⭐⭐⭐'};
  if(pct<=0.40) return{label:'GOOD', emoji:'🟡',stars:'⭐⭐'};
  if(pct<=0.50) return{label:'OK',   emoji:'🟠',stars:'⭐'};
  return             {label:'SKIP',  emoji:'❌',stars:''};
}

async function fetchOrbData(ticker) {
  try {
    const headers={'APCA-API-KEY-ID':process.env.ALPACA_API_KEY,'APCA-API-SECRET-KEY':process.env.ALPACA_API_SECRET,'Accept':'application/json'};
    const to=new Date().toISOString().split('T')[0];
    const from=new Date(Date.now()-30*864e5).toISOString().split('T')[0];
    const res=await fetch(`https://data.alpaca.markets/v2/stocks/bars?symbols=${ticker}&timeframe=1Day&start=${from}&end=${to}&feed=sip&sort=desc&limit=20`,{headers});
    if (!res.ok) return;
    const json=await res.json();
    const arr=(json.bars||{})[ticker]||[];
    if (arr.length>=2) {
      const atr=calcATR([...arr].reverse());
      if (atr) orbAtr[ticker]=atr;
      const prev=arr[1];
      orbPrevDay[ticker]={high:prev.h,low:prev.l,close:prev.c};
      orbAvgBarVol[ticker]=prev.v/78;
    }
  } catch(e){}
}

async function sendOrbBrief() {
  if (orbBriefSent) return;
  orbBriefSent=true;
  log('Sending ORB pre-market brief...');
  await updateMarketBias();
  try {
    const candidates=[];
    for (const t of ORB_TICKERS) {
      const atr=orbAtr[t], prev=orbPrevDay[t];
      if (!atr||!prev) continue;
      let score=0;
      const atrPct=atr/prev.close;
      if (atrPct>0.015&&atrPct<0.06) score+=2;
      if (prev.high) score+=1;
      if (score>0) candidates.push({ticker:t,score,prevHigh:prev.high?.toFixed(2),prevLow:prev.low?.toFixed(2),prevClose:prev.close?.toFixed(2),atr:atr.toFixed(2)});
    }
    const top5=candidates.sort((a,b)=>b.score-a.score).slice(0,5);
    if (!top5.length) { sendTelegram('📐 <b>ORB Brief</b>\nNo strong candidates today.'); return; }
    const lines=top5.map((c,i)=>`${i+1}. <b>${c.ticker}</b>\n   PDH: $${c.prevHigh} PDL: $${c.prevLow} PDC: $${c.prevClose}\n   ATR: $${c.atr}`).join('\n\n');
    sendTelegram(`📐 <b>ORB Pre-Market Brief - Top 5</b>\n⏰ 9:15am ET\n${biasEmoji()} Market: <b>${marketBias}</b>\n\n${lines}\n\n<i>Range locks 9:40 - Elite and Good only</i>`);
  } catch(e) { log(`Brief: ${e.message}`); }
}

async function startOrb() {
  log('ORB scanner starting');
  orbActive=true; orbData={}; orbBars5m={}; orbAlerted.clear();
  // Build dynamic universe: all NASDAQ $20-$150 + leader stocks
  const dynamicUniverse = await fetchNasdaqUniverse(20, 150);
  const orbUniverse = [...new Set([...withLeadingSectorNames(ORB_TICKERS), ...dynamicUniverse])].slice(0, 800);
  log(`ORB universe: ${orbUniverse.length} tickers`);
  for (let i=0; i<orbUniverse.length; i+=20)
    await Promise.allSettled(orbUniverse.slice(i,i+20).map(t=>fetchOrbData(t)));

  const fiveMBuckets={};

  barHandlers.orb = async (bar) => {
    const ticker=bar.symbol; if(!orbUniverse.includes(ticker)) return;
    const etMins=getETMins();

    // Update 5-min buckets
    if (!fiveMBuckets[ticker]) fiveMBuckets[ticker]=null;
    const tsMs=new Date(bar.t).getTime();
    const bucket=Math.floor(tsMs/(5*60*1000));
    const last=fiveMBuckets[ticker];
    let completedBar=null;
    if (!last||last.bucket!==bucket) {
      if (last) completedBar=last.bar;
      fiveMBuckets[ticker]={bucket,bar:{o:bar.o,h:bar.h,l:bar.l,c:bar.c,v:bar.v,t:bar.t}};
    } else {
      last.bar.h=Math.max(last.bar.h,bar.h); last.bar.l=Math.min(last.bar.l,bar.l);
      last.bar.c=bar.c; last.bar.v+=bar.v;
    }

    // Build ORB 9:00-9:10 (first 10 minutes)
    if (etMins>=540&&etMins<550) {
      if (!orbData[ticker]) orbData[ticker]={high:bar.h,low:bar.l,locked:false};
      else if (!orbData[ticker].locked) {
        orbData[ticker].high=Math.max(orbData[ticker].high,bar.h);
        orbData[ticker].low=Math.min(orbData[ticker].low,bar.l);
      }
    }

    // Lock ORB at 9:10
    if (etMins>=550&&orbData[ticker]&&!orbData[ticker].locked) {
      orbData[ticker].locked=true;
      const orb=orbData[ticker];
      const orbRange=orb.high-orb.low;
      const atr=orbAtr[ticker];
      const orbPct=atr?orbRange/atr:null;
      if (orbPct&&orbPct>0.50) { delete orbData[ticker]; return; }
      if (orbPct) { orb.orbPct=orbPct; orb.quality=orbQuality(orbPct); orb.orbRange=orbRange; }
    }

    // Process completed 5-min bar for breakout detection 9:10-10:00
    if (completedBar&&etMins>=550&&etMins<600) {
      if (!orbBars5m[ticker]) orbBars5m[ticker]=[];
      orbBars5m[ticker].push(completedBar);
      if (orbBars5m[ticker].length>30) orbBars5m[ticker].shift();

      const orb=orbData[ticker]; if(!orb?.locked) return;
      if (orbAlerted.has(ticker)) return;
      const avgVol=orbAvgBarVol[ticker]||0;
      if (avgVol>0&&completedBar.v<avgVol*2) {
        log(`ORB ${ticker}: low vol ${completedBar.v} vs ${(avgVol*2).toFixed(0)} needed`);
        return;
      }
      const quality=orb.quality||orbQuality(orb.orbPct||0.5);
      if (quality.label==='SKIP'||quality.label==='OK') {
        log(`ORB ${ticker}: quality ${quality.label} (${orb.orbPct?(orb.orbPct*100).toFixed(0)+'%':'N/A'} of ATR) - filtered`);
        return;
      }
      const rsi=calcRSI((orbBars5m[ticker]||[]).slice(-15));
      const prev=orbPrevDay[ticker]||{};
      const atrPct=orb.orbPct?(orb.orbPct*100).toFixed(0):'N/A';

      // Rater setup view (OR/ATR ratio is orb.orbPct; RSI already computed).
      const orbSetup = {
        scanner: 'orb', symbol: ticker,
        rsi, orAtrRatio: orb.orbPct, tod_bucket: todBucketNow(),
      };

      // Alert only on confirmed 5-min close strictly outside OR
      const closeAbove = completedBar.c > orb.high;
      const closeBelow = completedBar.c < orb.low;
      if (closeAbove || closeBelow) log(`ORB ${ticker}: 5-min close $${completedBar.c.toFixed(2)} vs H:$${orb.high.toFixed(2)} L:$${orb.low.toFixed(2)} - breakout confirmed`);
      if (closeAbove) {
        const breakPct=((completedBar.c-orb.high)/orb.high*100).toFixed(2);
        const { allow, scoreLine, rating } = await rateAndGate(orbSetup);
        if (!allow) {
          log(`ORB ${ticker} BULL suppressed: pattern ${rating.score}/10 < ${MIN_PATTERN_SCORE} (${rating.confidence})`);
          return;
        }
        orbAlerted.add(ticker);
        const tgt1=(orb.high+orb.orbRange).toFixed(2), tgt2=(orb.high+orb.orbRange*2).toFixed(2), stop=(orb.high*0.995).toFixed(2);
        const biasNote=marketBias==='BULLISH'?'✅ Bullish bias - high conviction':marketBias==='BEARISH'?'⚠️ Bearish day - reduce size':'🟡 Choppy - wait for confirmation';
        sendTelegram(`🚀 <b>ORB BULLISH BREAKOUT - ${ticker}</b>\n⏰ ${new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'})} ET\n\n💰 $${completedBar.c.toFixed(2)}\n📊 RSI(7): ${rsi??'N/A'}\n⚡ Vol: ${avgVol>0?(completedBar.v/avgVol).toFixed(1):'N/A'}x\n\n📐 ORB H:$${orb.high.toFixed(2)} L:$${orb.low.toFixed(2)}\n   ATR%: ${atrPct}% ${quality.emoji} ${quality.label} ${quality.stars}\n   Break: +${breakPct}%\n\n${biasEmoji()} ${biasNote}\n\n🎯 T1:$${tgt1} T2:$${tgt2}\n🛑 Stop:$${stop}\n\n🗓 PDH:$${prev.high?.toFixed(2)||'N/A'} PDL:$${prev.low?.toFixed(2)||'N/A'}\n\n<i>ORB 10-min via Alpaca SIP</i>` + scoreLine);
        pushAlert({type:'orb',ticker,direction:'bull',price:completedBar.c.toFixed(2),orbQuality:quality.label,orbAtrPct:atrPct,rvol:avgVol>0?(completedBar.v/avgVol).toFixed(1):'N/A',rsi,target:tgt1,stop,conviction:quality.label==='ELITE'?5:4,patternScore:rating?rating.score:null,patternConfidence:rating?rating.confidence:null});
        log(`🚀 ORB BULL: ${ticker} +${breakPct}%`);
        setTimeout(()=>orbAlerted.delete(ticker),45*60*1000);
      } else if (closeBelow) {
        const breakPct=((orb.low-completedBar.c)/orb.low*100).toFixed(2);
        const { allow, scoreLine, rating } = await rateAndGate(orbSetup);
        if (!allow) {
          log(`ORB ${ticker} BEAR suppressed: pattern ${rating.score}/10 < ${MIN_PATTERN_SCORE} (${rating.confidence})`);
          return;
        }
        orbAlerted.add(ticker);
        const tgt1=(orb.low-orb.orbRange).toFixed(2), tgt2=(orb.low-orb.orbRange*2).toFixed(2), stop=(orb.low*1.005).toFixed(2);
        const biasNote=marketBias==='BEARISH'?'✅ Bearish bias - high conviction':marketBias==='BULLISH'?'⚠️ Bullish day - reduce size':'🟡 Choppy - wait for confirmation';
        sendTelegram(`🔻 <b>ORB BEARISH BREAKDOWN - ${ticker}</b>\n⏰ ${new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'})} ET\n\n💰 $${completedBar.c.toFixed(2)}\n📊 RSI(7): ${rsi??'N/A'}\n⚡ Vol: ${avgVol>0?(completedBar.v/avgVol).toFixed(1):'N/A'}x\n\n📐 ORB H:$${orb.high.toFixed(2)} L:$${orb.low.toFixed(2)}\n   ATR%: ${atrPct}% ${quality.emoji} ${quality.label} ${quality.stars}\n   Break: -${breakPct}%\n\n${biasEmoji()} ${biasNote}\n\n🎯 T1:$${tgt1} T2:$${tgt2}\n🛑 Stop:$${stop}\n\n<i>ORB 10-min via Alpaca SIP</i>` + scoreLine);
        pushAlert({type:'orb',ticker,direction:'bear',price:completedBar.c.toFixed(2),orbQuality:quality.label,orbAtrPct:atrPct,rvol:avgVol>0?(completedBar.v/avgVol).toFixed(1):'N/A',rsi,target:tgt1,stop,conviction:quality.label==='ELITE'?5:4,patternScore:rating?rating.score:null,patternConfidence:rating?rating.confidence:null});
        log(`🔻 ORB BEAR: ${ticker} -${breakPct}%`);
        setTimeout(()=>orbAlerted.delete(ticker),45*60*1000);
      }
    }
  };

  ensureLiveConnection(orbUniverse);

}

function stopOrb() {
  orbActive=false; orbBriefSent=false; barHandlers.orb=null;
  orbData={}; orbBars5m={}; orbAlerted.clear();
  log('ORB stopped');

  cleanupLiveConnection();
}

async function checkOrbSchedule() {
  const etMins=getETMins();
  if (isWeekday()&&etMins>=535&&etMins<537&&!orbBriefSent) {
    for (let i=0; i<ORB_TICKERS.length; i+=10)
      await Promise.allSettled(ORB_TICKERS.slice(i,i+10).map(t=>fetchOrbData(t)));
    sendOrbBrief();
  }
  if (isWeekday()&&etMins>=540&&etMins<600) { if(!orbActive) await startOrb(); }
  else { if(orbActive) stopOrb(); }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── SCHEDULED MESSAGES ────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
let recapSentToday=false, windDownSentToday=false, gapScanDone=false;

async function sendGapScanner() {
  if (gapScanDone) return;
  gapScanDone=true;
  log('Running gap scanner...');
  try {
    const GAP_TICKERS=['SOFI','HOOD','MARA','RIOT','HIMS','RDDT','SNAP','AMC','GME','NIO','ACHR','RKLB','ASTS','NVDA','AMD','TSLA','META','AAPL','MSFT','AMZN','GOOGL','AVGO','PLTR','CRWD','DDOG','NET','COIN','SQ','UBER','SHOP','NFLX','MRVL','ARM','SMCI','CLSK','CIFR','IREN'];
    const headers={'APCA-API-KEY-ID':process.env.ALPACA_API_KEY,'APCA-API-SECRET-KEY':process.env.ALPACA_API_SECRET,'Accept':'application/json'};
    const to=new Date().toISOString().split('T')[0];
    const from=new Date(Date.now()-5*864e5).toISOString().split('T')[0];
    const symStr=GAP_TICKERS.join(',');
    const res=await fetch(`https://data.alpaca.markets/v2/stocks/bars?symbols=${symStr}&timeframe=1Day&start=${from}&end=${to}&feed=sip&sort=desc&limit=4`,{headers});
    if (!res.ok) { log(`Gap scanner fetch error ${res.status}`); return; }
    const json=await res.json();
    const bars=json.bars||{};
    const gaps=[];
    for (const [ticker,arr] of Object.entries(bars)) {
      if (arr.length<2) continue;
      const today=arr[0], prev=arr[1];
      if (!today||!prev||!prev.c) continue;
      const gapPct=((today.o-prev.c)/prev.c*100);
      if (Math.abs(gapPct)>=3) gaps.push({ticker,gapPct:gapPct.toFixed(1),openPrice:today.o.toFixed(2),prevClose:prev.c.toFixed(2)});
    }
    if (!gaps.length) { sendTelegram(`📊 <b>Gap Scanner - 8:30am ET</b>\nNo gaps 3%+ today\n\n${biasEmoji()} Market: <b>${marketBias}</b>`); return; }
    gaps.sort((a,b)=>Math.abs(parseFloat(b.gapPct))-Math.abs(parseFloat(a.gapPct)));
    const lines=gaps.slice(0,8).map(g=>`${parseFloat(g.gapPct)>0?'🟢':'🔴'} <b>${g.ticker}</b> ${parseFloat(g.gapPct)>0?'+':''}${g.gapPct}%  Open:$${g.openPrice}  Prev:$${g.prevClose}`).join('\n');
    sendTelegram(`📊 <b>Gap Scanner - 8:30am ET</b>\n${biasEmoji()} Market: <b>${marketBias}</b>\n\n${lines}\n\n<i>Watch for ORB setups at 9:30</i>`);
    log(`Gap scanner: ${gaps.length} gaps`);
  } catch(e) { log(`Gap scanner: ${e.message}`); }
}

async function checkScheduledMessages() {
  if (!isWeekday()) return;
  const etMins=getETMins();

  if (etMins>=510&&etMins<512&&!gapScanDone) { await updateMarketBias(); sendGapScanner(); }

  if (etMins>=525&&etMins<527&&!windDownSentToday) {
    windDownSentToday=true;
    sendTelegram(`⏰ <b>8:45am - Scalp Wind-Down</b>\n45 min to market open\n\n🔔 Wrap up scalp positions\n📐 ORB brief at 9:15am\n\n${biasEmoji()} Bias heading into open: <b>${marketBias}</b>\n${marketBias==='BULLISH'?'Long ORB setups preferred':marketBias==='BEARISH'?'Short/breakdown setups preferred':'Wait for direction at open'}`);
    log('Wind-down reminder sent');
  }

  if (etMins>=990&&etMins<992&&!recapSentToday) {
    recapSentToday=true;
    const data=readData();
    const isToday=a=>new Date(a.time).toDateString()===new Date().toDateString();
    const todayAlerts=data.alerts.filter(isToday);
    const wins=todayAlerts.filter(a=>a.outcome==='win').length;
    const losses=todayAlerts.filter(a=>a.outcome==='loss').length;
    const traded=wins+losses;
    const wr=traded?Math.round(wins/traded*100)+'%':'--';
    const highConv=todayAlerts.filter(a=>(a.conviction||0)>=4).length;
    sendTelegram(`📋 <b>Daily Recap - ${new Date().toLocaleDateString('en-US',{timeZone:'America/New_York',weekday:'long',month:'short',day:'numeric'})}</b>\n\n${biasEmoji()} Market: <b>${marketBias}</b>\n\n⚡ Scalp: ${todayAlerts.filter(a=>a.type==='scalp').length}\n📐 ORB: ${todayAlerts.filter(a=>a.type==='orb').length}\n🔄 Reversal: ${todayAlerts.filter(a=>a.type==='reversal').length}\n📊 Total: ${todayAlerts.length}\n\n🎯 Traded: ${traded} Wins: ${wins} Losses: ${losses}\n📈 Win Rate: ${wr}\n⭐ High conviction (4-5): ${highConv}\n\n<i>ORB brief tomorrow at 9:15am ET</i>`);
    log('Daily recap sent');
  }

  if (etMins===0) { recapSentToday=false; windDownSentToday=false; gapScanDone=false; orbBriefSent=false; }
}

// ── Configure pre-market scanner universe ────────────────────────────────────
premarketScanner.CONFIG.universe = [...new Set([...SEED_TICKERS,...ORB_TICKERS])].slice(0,100);
premarketScanner.CONFIG.scanHourET=6; premarketScanner.CONFIG.scanMinuteET=0;

// ── Main Scheduler ────────────────────────────────────────────────────────────
async function tick() {
  await checkScalpSchedule();
  await checkRevSchedule();
  await checkOrbSchedule();
  await checkScheduledMessages();
}

// Update market bias every 30min during trading hours
setInterval(async()=>{
  const etMins=getETMins();
  if (isWeekday()&&etMins>=480&&etMins<960) await updateMarketBias();
},30*60*1000);

log('WickED starting - Scalp + Reversal + ORB + API + Alpaca Live + Sector');
updateMarketBias();
premarketScanner.schedulePremarketScan();
sectorScanner.start();   // 8am ET brief + 30-min refresh; populates leaders
tick();
setInterval(tick, 60*1000);
