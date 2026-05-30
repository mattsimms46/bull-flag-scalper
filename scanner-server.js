// ─── Bull Flag Scalper — Real-Time Server ────────────────────────────────────
const https     = require("https");
const WebSocket = require("ws");

// ── Config ────────────────────────────────────────────────────────────────────
const POLYGON_KEY    = process.env.POLYGON_KEY    || "GMoNIAEFKGYBlnWGTMxlQxaiOD5q3f5H";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8600785204:AAFRzkIW4nMMz6Ao5OxrkWrwCP3JvcqTfCU";
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT  || "8446284130";
const MIN_PRICE      = parseFloat(process.env.MIN_PRICE   || "1");
const MAX_PRICE      = parseFloat(process.env.MAX_PRICE   || "20");
const MIN_RVOL       = parseFloat(process.env.MIN_RVOL    || "5");
const MAX_FLOAT_M    = parseFloat(process.env.MAX_FLOAT_M || "20");
const SCAN_START_ET  = parseInt(process.env.SCAN_START_ET || "5");
const SCAN_END_ET    = parseInt(process.env.SCAN_END_ET   || "10");

// No HTTP server — pure worker process, Railway won't health check it

// ── Process guards ────────────────────────────────────────────────────────────
process.on("SIGTERM",            () => log("SIGTERM — ignoring, staying alive"));
process.on("uncaughtException",  e  => log(`Uncaught: ${e.message}`));
process.on("unhandledRejection", r  => log(`Unhandled: ${r}`));

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── VWAP Calculation ──────────────────────────────────────────────────────────
function calcVWAP(bars) {
  // VWAP = sum(typical_price * volume) / sum(volume)
  let cumTPV = 0, cumVol = 0;
  for (const b of bars) {
    const tp = (b.open + b.high + b.low + b.close) / 4;
    cumTPV += tp * b.vol;
    cumVol += b.vol;
  }
  return cumVol > 0 ? cumTPV / cumVol : null;
}

function vwapLabel(price, vwap) {
  if (!vwap) return { label:"VWAP N/A", emoji:"⬜", pct:null };
  const pct = ((price - vwap) / vwap * 100);
  if (pct > 3)  return { label:`${pct.toFixed(1)}% above VWAP ⚠️`, emoji:"🔴", pct };
  if (pct > 0)  return { label:`${pct.toFixed(1)}% above VWAP ✅`, emoji:"🟢", pct };
  if (pct > -3) return { label:`${pct.toFixed(1)}% below VWAP`,    emoji:"🟡", pct };
  return              { label:`${pct.toFixed(1)}% below VWAP ⚠️`, emoji:"🔴", pct };
}

// ── State ─────────────────────────────────────────────────────────────────────
let ws             = null;
let activeTickers  = new Set();
let bars           = {};
let avgVol         = {};
let floatData      = {};
let alertedToday   = new Set();
let scanActive     = false;
let reconnectTimer = null;

// ── Telegram ──────────────────────────────────────────────────────────────────
function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: "HTML" });
  const opts = {
    hostname: "api.telegram.org",
    path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  };
  const req = https.request(opts, res => {
    if (res.statusCode !== 200) log(`Telegram error: ${res.statusCode}`);
  });
  req.on("error", e => log(`Telegram error: ${e.message}`));
  req.write(body);
  req.end();
}

// ── Polygon REST ──────────────────────────────────────────────────────────────
function polygonGet(path) {
  return new Promise((resolve, reject) => {
    const url = `https://api.polygon.io${path}${path.includes("?")?"&":"?"}apiKey=${POLYGON_KEY}`;
    https.get(url, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on("error", reject);
  });
}

// ── Fetch avg volume ──────────────────────────────────────────────────────────
async function fetchAvgVolume(ticker) {
  try {
    const to   = new Date().toISOString().split("T")[0];
    const from = new Date(Date.now() - 20*24*60*60*1000).toISOString().split("T")[0];
    const data = await polygonGet(`/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=desc&limit=15`);
    if (data?.results?.length >= 3) {
      const vols = data.results.slice(0,10).map(r=>r.v);
      avgVol[ticker] = vols.reduce((a,b)=>a+b,0) / vols.length;
    }
  } catch(e) {}
}

// ── Fetch float ───────────────────────────────────────────────────────────────
async function fetchFloat(ticker) {
  try {
    const data = await polygonGet(`/v3/reference/tickers/${ticker}`);
    const shares = data?.results?.share_class_shares_outstanding;
    if (shares) floatData[ticker] = shares;
  } catch(e) {}
}

// ── Build universe ────────────────────────────────────────────────────────────
const SEED_TICKERS = [
  "SOFI","HOOD","MARA","RIOT","CIFR","CLSK","IREN","BITF","HUT","BTBT",
  "ACHR","JOBY","SPCE","ASTR","RKLB","ASTS","LUNR","HIMS","DOCS","RDDT",
  "SNAP","PINS","WKHS","NKLA","GOEV","SOLO","IDEX","NIO","SNDL","TLRY",
  "AMC","GME","BB","CLOV","EVGO","FAZE","QUBT","KULR","MVIS","OCGN",
  "APLD","BTCS","DPRO","GFAI","HOLO","VERB","WISA","XELA","ZFOX","RAIL",
  "SDIG","UAVS","ATOS","DARE","LIZI","MNTS","NXPL","SANG","TPVG","YELL",
];

async function buildUniverse() {
  log("Building universe...");
  const tickers = new Set(SEED_TICKERS);

  try {
    const snap = await polygonGet(`/v2/snapshot/locale/us/markets/stocks/gainers?include_otc=false`);
    if (snap?.tickers) {
      snap.tickers.forEach(t => {
        const p = t.day?.c || t.lastTrade?.p;
        if (p >= MIN_PRICE && p <= MAX_PRICE) tickers.add(t.ticker);
      });
    }
  } catch(e) { log(`Universe fetch error: ${e.message}`); }

  const list = [...tickers].slice(0, 150);
  log(`Enriching ${list.length} tickers...`);

  const BATCH = 10;
  for (let i=0; i<list.length; i+=BATCH) {
    const slice = list.slice(i, i+BATCH);
    await Promise.allSettled([
      ...slice.map(t => fetchAvgVolume(t)),
      ...slice.map(t => fetchFloat(t)),
    ]);
  }

  const filtered = list.filter(t => {
    const float = floatData[t];
    return !float || float <= MAX_FLOAT_M * 1_000_000;
  });

  log(`Universe ready: ${filtered.length} tickers`);
  return filtered;
}

// ── Flag Detection ────────────────────────────────────────────────────────────
function detectScalpFlag(ticker) {
  const b = bars[ticker];
  if (!b || b.length < 8) return null;
  const n = b.length;

  for (let poleLen=3; poleLen<=8; poleLen++) {
    for (let i=n-1; i>=poleLen+2; i--) {
      const ps = i - poleLen;
      if (ps < 0) break;

      const pole        = b.slice(ps, i);
      const poleGainRaw = (b[i-1].close - b[ps].open) / b[ps].open;
      if (poleGainRaw < 0.02) continue;

      const greenCount = pole.filter(c=>c.close>c.open).length;
      if (greenCount < Math.ceil(poleLen*0.65)) continue;

      const avgPoleVol = pole.reduce((s,c)=>s+c.vol,0) / poleLen;
      const dailyAvg   = avgVol[ticker] || 0;
      const avgBarVol  = dailyAvg / 390;
      if (avgBarVol > 0 && avgPoleVol < avgBarVol * MIN_RVOL) continue;

      const flagCandles = b.slice(i, Math.min(i+6, n));
      if (flagCandles.length < 2) continue;

      const flagHigh = Math.max(...flagCandles.map(c=>c.high));
      const flagLow  = Math.min(...flagCandles.map(c=>c.low));
      const poleTop  = b[i-1].close;
      const poleBtm  = b[ps].open;
      const poleH    = poleTop - poleBtm;

      if ((flagHigh-flagLow)/poleTop > 0.04) continue;

      const avgFlagVol = flagCandles.reduce((s,c)=>s+c.vol,0) / flagCandles.length;
      if (avgFlagVol >= avgPoleVol*0.80) continue;

      const flagAvg = flagCandles.reduce((s,c)=>s+c.close,0) / flagCandles.length;
      if (flagAvg < poleBtm + poleH*0.5) continue;

      const currentPrice = b[n-1].close;
      const spreadPct    = ((b[n-1].high - b[n-1].low) / currentPrice * 100).toFixed(2);

      return {
        ticker,
        currentPrice:    currentPrice.toFixed(2),
        poleGain:        (poleGainRaw*100).toFixed(1),
        poleBars:        poleLen,
        flagBars:        flagCandles.length,
        avgPoleVol:      Math.round(avgPoleVol),
        rVol:            avgBarVol > 0 ? (avgPoleVol/avgBarVol).toFixed(1) : "N/A",
        flagRange:       ((flagHigh-flagLow)/poleTop*100).toFixed(2),
        spreadPct,
        breakoutTarget:  (poleTop*(1+poleGainRaw)).toFixed(2),
        stopLoss:        (flagLow*0.99).toFixed(2),
        float:           floatData[ticker] ? `${(floatData[ticker]/1_000_000).toFixed(1)}M` : "Unknown",
      };
    }
  }
  return null;
}

// ── Format Alert ──────────────────────────────────────────────────────────────
function formatAlert(f) {
  const time = new Date().toLocaleTimeString("en-US", { timeZone:"America/New_York", hour:"2-digit", minute:"2-digit" });
  const vwapLine = f.vwap
    ? `${f.vwapInfo.emoji} VWAP:   $${f.vwap} (${f.vwapInfo.label})`
    : "";
  return `🚨 <b>BULL FLAG — ${f.ticker}</b>
⏰ ${time} ET

💰 Price:   $${f.currentPrice}
📈 Pole:    +${f.poleGain}% (${f.poleBars} bars)
🏁 Flag:    ${f.flagBars} bars · ${f.flagRange}% range
⚡ Rel Vol: ${f.rVol}x average
📊 Float:   ${f.float}
📐 Spread:  ~${f.spreadPct}%
${vwapLine}

🎯 Target: $${f.breakoutTarget}
🛑 Stop:   $${f.stopLoss}

<i>1-min scalp · NASDAQ · 5am–10am ET</i>`;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWebSocket(tickers) {
  log(`Connecting WebSocket for ${tickers.length} tickers...`);
  ws = new WebSocket("wss://socket.polygon.io/stocks");

  ws.on("open", () => {
    log("WS connected — authenticating...");
    ws.send(JSON.stringify({ action:"auth", params: POLYGON_KEY }));
  });

  ws.on("message", raw => {
    let msgs;
    try { msgs = JSON.parse(raw); } catch(e) { return; }
    msgs.forEach(msg => {
      if (msg.ev === "status") {
        if (msg.status === "auth_success") {
          log("Authenticated — subscribing...");
          for (let i=0; i<tickers.length; i+=50) {
            const params = tickers.slice(i,i+50).map(t=>`AM.${t}`).join(",");
            ws.send(JSON.stringify({ action:"subscribe", params }));
          }
          sendTelegram(`✅ <b>Bull Flag Scalper ACTIVE</b>\nScanning ${tickers.length} NASDAQ stocks\n$${MIN_PRICE}–$${MAX_PRICE} · Float ≤${MAX_FLOAT_M}M · ${MIN_RVOL}x min rvol`);
        }
        if (msg.status === "auth_failed") log("Auth failed");
        return;
      }

      if (msg.ev === "AM") {
        const ticker = msg.sym;
        if (!ticker) return;
        const bar = { open:msg.o, high:msg.h, low:msg.l, close:msg.c, vol:msg.av||msg.v, ts:msg.s };
        if (bar.close < MIN_PRICE || bar.close > MAX_PRICE) return;
        if (!bars[ticker]) bars[ticker] = [];
        bars[ticker].push(bar);
        if (bars[ticker].length > 60) bars[ticker].shift();

        if (!alertedToday.has(ticker)) {
          const flag = detectScalpFlag(ticker);
          if (flag) {
            // Add VWAP context
            const vwap = calcVWAP(bars[ticker]);
            const vwapInfo = vwapLabel(parseFloat(flag.currentPrice), vwap);
            flag.vwap = vwap ? vwap.toFixed(2) : null;
            flag.vwapInfo = vwapInfo;
            alertedToday.add(ticker);
            log(`🚨 FLAG: ${ticker} @ $${flag.currentPrice} | +${flag.poleGain}% | ${flag.rVol}x rvol | VWAP:${vwapInfo.label}`);
            sendTelegram(formatAlert(flag));
            setTimeout(() => alertedToday.delete(ticker), 30*60*1000);
          }
        }
      }
    });
  });

  ws.on("close", () => {
    log("WS closed");
    if (scanActive) {
      log("Reconnecting in 5s...");
      reconnectTimer = setTimeout(() => connectWebSocket(tickers), 5000);
    }
  });

  ws.on("error", err => log(`WS error: ${err.message}`));
}

// ── Disconnect ────────────────────────────────────────────────────────────────
function disconnect() {
  scanActive = false;
  clearTimeout(reconnectTimer);
  if (ws) { ws.close(); ws = null; }
  bars = {};
  alertedToday.clear();
  log("Scanner stopped");
  sendTelegram("🔴 <b>Bull Flag Scalper OFFLINE</b>\nMarket window closed · Back tomorrow 5am ET");
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
async function checkSchedule() {
  const et      = new Date(new Date().toLocaleString("en-US", { timeZone:"America/New_York" }));
  const hour    = et.getHours();
  const isWeekday = et.getDay() >= 1 && et.getDay() <= 5;

  if (isWeekday && hour >= SCAN_START_ET && hour < SCAN_END_ET) {
    if (!scanActive) {
      log(`Starting scan (${hour}:${String(et.getMinutes()).padStart(2,"0")} ET)`);
      scanActive = true;
      alertedToday.clear();
      bars = {};
      const tickers = await buildUniverse();
      activeTickers = new Set(tickers);
      connectWebSocket(tickers);
    }
  } else {
    if (scanActive) {
      log(`Stopping scan (${hour}:${String(et.getMinutes()).padStart(2,"0")} ET)`);
      disconnect();
    }
  }
}

// ── Daily Recap ───────────────────────────────────────────────────────────────
let recapSentToday = false;
let dailyAlerts = { scalp:[], orb:[], reversal:[] };

function scheduleRecap() {
  const et      = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const etMins  = et.getHours()*60 + et.getMinutes();
  const recapM  = 16*60+30; // 4:30pm ET
  const isWeekday = et.getDay()>=1 && et.getDay()<=5;

  if (isWeekday && etMins >= recapM && etMins < recapM+2 && !recapSentToday) {
    recapSentToday = true;
    sendDailyRecap();
  }
  // Reset at midnight
  if (etMins === 0) {
    recapSentToday = false;
    dailyAlerts = { scalp:[], orb:[], reversal:[] };
  }
}

function sendDailyRecap() {
  const today = new Date().toLocaleDateString("en-US",{
    timeZone:"America/New_York", weekday:"long", month:"short", day:"numeric"
  });

  const scalpCount    = alertedToday?.size || 0;
  const now = new Date().toLocaleTimeString("en-US",{timeZone:"America/New_York"});

  const body = `📋 <b>Daily Recap — ${today}</b>
⏰ ${now} ET

⚡ <b>Bull Flag Scalper</b>
  Alerts fired: ${scalpCount} setups
  Window: 5:00–10:00am ET

📐 <b>ORB Scanner</b>
  Elite/Good breakouts only
  Window: 9:40–10:15am ET

🔄 <b>Reversal Scanner</b>
  Marubozu exhaustion setups
  Window: 9:30–10:30am ET

—
<i>Review your trades · Adjust criteria in Railway Variables if needed
Tomorrow's pre-market brief at 9:20am ET</i>`;

  // Use https directly since sendTelegram is defined above
  const msgBody = JSON.stringify({ chat_id: TELEGRAM_CHAT, text: body, parse_mode:"HTML" });
  const opts = {
    hostname:"api.telegram.org",
    path:`/bot${TELEGRAM_TOKEN}/sendMessage`,
    method:"POST",
    headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(msgBody)},
  };
  const req = https.request(opts, res => {
    if (res.statusCode!==200) log(`Recap Telegram error: ${res.statusCode}`);
  });
  req.on("error", e => log(`Recap error: ${e.message}`));
  req.write(msgBody); req.end();
  log("Daily recap sent");
}

// ── Start API + all scanners ──────────────────────────────────────────────────
const { checkReversalSchedule } = require("./reversal-scanner");
const { checkORBSchedule }      = require("./orb-scanner");
const { writeData, readData }   = require("./api-server");

// Push alert to local data store so dashboard can read it
function pushAlert(alert) {
  try {
    const data = readData();
    alert.id   = Date.now() + Math.random().toString(36).slice(2,6);
    alert.time = new Date().toISOString();
    alert.outcome = null;
    alert.notes   = "";
    data.alerts.unshift(alert);
    if (data.alerts.length > 200) data.alerts = data.alerts.slice(0,200);
    writeData(data);
    log(`Alert stored: ${alert.ticker} ${alert.type}`);
  } catch(e) {
    log(`Alert store error: ${e.message}`);
  }
}

// Make pushAlert available globally for scanners
global.wickedPushAlert = pushAlert;

log("Bull Flag Pro starting — Scalper + Reversal + ORB + Daily Recap + API");
checkSchedule();
checkReversalSchedule();
checkORBSchedule();
scheduleRecap();
setInterval(() => {
  checkSchedule();
  checkReversalSchedule();
  checkORBSchedule();
  scheduleRecap();
}, 60 * 1000);
