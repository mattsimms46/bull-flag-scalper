// ─── Bull Flag Scalper — Real-Time Server ────────────────────────────────────
// Runs 5am–10am ET daily, streams Polygon WebSocket 1-min bars,
// detects low-float bull flags with 5x+ relative volume, fires Telegram alerts.

const https  = require("https");
const http   = require("http");
const WebSocket = require("ws");

// ── Config ────────────────────────────────────────────────────────────────────
const POLYGON_KEY   = process.env.POLYGON_KEY   || "GMoNIAEFKGYBlnWGTMxlQxaiOD5q3f5H";
const TELEGRAM_TOKEN= process.env.TELEGRAM_TOKEN|| "8600785204:AAFRzkIW4nMMz6Ao5OxrkWrwCP3JvcqTfCU";
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT || "8446284130";
const MIN_PRICE     = parseFloat(process.env.MIN_PRICE  || "1");
const MAX_PRICE     = parseFloat(process.env.MAX_PRICE  || "20");
const MIN_RVOL      = parseFloat(process.env.MIN_RVOL   || "5");   // 5x relative vol
const MAX_FLOAT_M   = parseFloat(process.env.MAX_FLOAT_M|| "20");  // max 20M share float
const SCAN_START_ET = parseInt(process.env.SCAN_START_ET|| "5");   // 5am ET
const SCAN_END_ET   = parseInt(process.env.SCAN_END_ET  || "10");  // 10am ET

// ── Low-float NASDAQ scalping universe ($1–$20 focus) ─────────────────────────
// Refreshed daily from Polygon; this is the seed list for bootstrapping
const SEED_TICKERS = [
  "SOFI","HOOD","MARA","RIOT","CIFR","CLSK","IREN","BITF","HUT","BTBT",
  "ACHR","JOBY","LILM","SPCE","ASTR","RKLB","ASTS","LUNR","RDW","MNTS",
  "HIMS","DOCS","RDDT","DUOL","BMBL","SNAP","PINS","MTTR","WKHS","RIDE",
  "NKLA","GOEV","SOLO","IDEX","AYRO","KNDI","XPEV","NIO","LI","CBAT",
  "SNDL","TLRY","CRON","ACB","CGC","HEXO","APHA","OGI","GRWG","IIPR",
  "AMC","GME","BB","BBBY","KOSS","EXPR","NAKD","CLOV","WKHS","SPRT",
  "ANVS","SAVA","ATOS","BGFV","CIDM","CODA","DARE","EVGO","FAZE","GFAI",
  "HOLO","IMPP","JBDI","KAVL","LIZI","MINM","NXPL","OPAL","PTRA","QUBT",
  "RAIL","SDIG","TIRX","UAVS","VERB","WISA","XELA","YCBD","ZKIN","ZVIA",
  "BKKT","AULT","CLNN","DRUG","EDTK","FRST","GREE","HPNN","INPX","JNCE",
  "KULR","LEDS","MVIS","NAUT","OCGN","PPBT","QMCO","RNAZ","SANG","TPVG",
  "UONE","VNET","WGMI","XBIO","YELL","ZFOX","APLD","BTCS","CIFS","DPRO",
];

// ── State ─────────────────────────────────────────────────────────────────────
let ws              = null;
let activeTickers   = new Set();
let bars            = {};      // ticker -> [{open,high,low,close,vol,ts}]
let avgVol          = {};      // ticker -> avg 10-day volume
let floatData       = {};      // ticker -> shares float
let alertedToday    = new Set();
let scanActive      = false;
let reconnectTimer  = null;

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

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
  req.on("error", e => log(`Telegram send error: ${e.message}`));
  req.write(body);
  req.end();
}

// ── Polygon REST helper ───────────────────────────────────────────────────────
function polygonGet(path) {
  return new Promise((resolve, reject) => {
    const url = `https://api.polygon.io${path}${path.includes("?")?"&":"?"}apiKey=${POLYGON_KEY}`;
    https.get(url, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on("error", reject);
  });
}

// ── Fetch ticker details (float, price) ───────────────────────────────────────
async function fetchTickerDetails(ticker) {
  try {
    const data = await polygonGet(`/v3/reference/tickers/${ticker}`);
    const shares = data?.results?.share_class_shares_outstanding;
    if (shares) floatData[ticker] = shares;
  } catch(e) {
    // silently skip — float data is best-effort
  }
}

// ── Fetch avg daily volume (10-day) ───────────────────────────────────────────
async function fetchAvgVolume(ticker) {
  try {
    const to   = new Date().toISOString().split("T")[0];
    const from = new Date(Date.now() - 20*24*60*60*1000).toISOString().split("T")[0];
    const data = await polygonGet(
      `/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=desc&limit=15`
    );
    if (data?.results?.length >= 3) {
      const vols = data.results.slice(0, 10).map(r => r.v);
      avgVol[ticker] = vols.reduce((a,b)=>a+b,0) / vols.length;
    }
  } catch(e) {}
}

// ── Build universe from Polygon (low-float NASDAQ $1–$20) ─────────────────────
async function buildUniverse() {
  log("Building scan universe from Polygon...");
  const tickers = new Set(SEED_TICKERS);

  try {
    // Fetch most active NASDAQ tickers by volume
    const snap = await polygonGet(`/v2/snapshot/locale/us/markets/stocks/gainers?include_otc=false`);
    if (snap?.tickers) {
      snap.tickers.forEach(t => {
        const p = t.day?.c || t.lastTrade?.p;
        if (p >= MIN_PRICE && p <= MAX_PRICE) tickers.add(t.ticker);
      });
    }
  } catch(e) {
    log(`Universe fetch error: ${e.message}`);
  }

  // Filter and enrich
  const list = [...tickers].slice(0, 150);
  log(`Fetching vol/float data for ${list.length} tickers...`);

  // Batch enrichment
  const BATCH = 10;
  for (let i=0; i<list.length; i+=BATCH) {
    const slice = list.slice(i, i+BATCH);
    await Promise.allSettled([
      ...slice.map(t => fetchAvgVolume(t)),
      ...slice.map(t => fetchTickerDetails(t)),
    ]);
  }

  // Apply float filter
  const filtered = list.filter(t => {
    const float = floatData[t];
    if (float && float > MAX_FLOAT_M * 1_000_000) return false;
    return true;
  });

  log(`Universe ready: ${filtered.length} tickers`);
  return filtered;
}

// ── Bull Flag Detection (1-min bars) ─────────────────────────────────────────
function detectScalpFlag(ticker) {
  const b = bars[ticker];
  if (!b || b.length < 8) return null;

  const n = b.length;

  for (let poleLen = 3; poleLen <= 8; poleLen++) {
    for (let i = n - 1; i >= poleLen + 2; i--) {
      const ps = i - poleLen;
      if (ps < 0) break;

      const pole        = b.slice(ps, i);
      const poleGainRaw = (b[i-1].close - b[ps].open) / b[ps].open;
      if (poleGainRaw < 0.02) continue; // 2% min on 1-min chart

      // Pole: mostly green, no single big red bar
      const greenCount = pole.filter(c=>c.close>c.open).length;
      if (greenCount < Math.ceil(poleLen * 0.65)) continue;

      const avgPoleVol  = pole.reduce((s,c)=>s+c.vol,0)/poleLen;

      // Check relative volume vs daily average
      const dailyAvg = avgVol[ticker] || 0;
      const barsPerDay = 390; // 6.5hr trading day in minutes
      const avgBarVol  = dailyAvg / barsPerDay;
      if (avgBarVol > 0 && avgPoleVol < avgBarVol * MIN_RVOL) continue;

      // Flag: 2–6 bars of tight consolidation / micro pullback
      const flagCandles = b.slice(i, Math.min(i+6, n));
      if (flagCandles.length < 2) continue;

      const flagHigh = Math.max(...flagCandles.map(c=>c.high));
      const flagLow  = Math.min(...flagCandles.map(c=>c.low));
      const poleTop  = b[i-1].close;
      const poleBtm  = b[ps].open;
      const poleH    = poleTop - poleBtm;

      // Micro pullback: flag range < 40% of pole height
      const flagRange = (flagHigh - flagLow) / poleTop;
      if (flagRange > 0.04) continue; // very tight on 1-min

      // Vol must contract during flag
      const avgFlagVol = flagCandles.reduce((s,c)=>s+c.vol,0)/flagCandles.length;
      if (avgFlagVol >= avgPoleVol * 0.80) continue;

      // Flag not retracing more than 50% of pole
      const flagAvg = flagCandles.reduce((s,c)=>s+c.close,0)/flagCandles.length;
      if (flagAvg < poleBtm + poleH * 0.5) continue;

      const currentPrice = b[n-1].close;
      const spread = b[n-1].high - b[n-1].low; // approx spread from last bar range
      const spreadPct = (spread / currentPrice * 100).toFixed(2);

      return {
        ticker,
        currentPrice:    currentPrice.toFixed(2),
        poleGain:        (poleGainRaw * 100).toFixed(1),
        poleBars:        poleLen,
        flagBars:        flagCandles.length,
        avgPoleVol:      Math.round(avgPoleVol),
        rVol:            avgBarVol > 0 ? (avgPoleVol / avgBarVol).toFixed(1) : "N/A",
        flagRange:       (flagRange * 100).toFixed(2),
        spreadPct,
        breakoutTarget:  (poleTop * (1 + poleGainRaw)).toFixed(2),
        stopLoss:        (flagLow * 0.99).toFixed(2),
        float:           floatData[ticker] ? `${(floatData[ticker]/1_000_000).toFixed(1)}M` : "Unknown",
      };
    }
  }
  return null;
}

// ── Format Telegram alert ──────────────────────────────────────────────────────
function formatAlert(flag) {
  const time = new Date().toLocaleTimeString("en-US", { timeZone:"America/New_York", hour:"2-digit", minute:"2-digit" });
  return `🚨 <b>BULL FLAG — ${flag.ticker}</b>
⏰ ${time} ET

💰 Price:    $${flag.currentPrice}
📈 Pole:     +${flag.poleGain}% (${flag.poleBars} bars)
🏁 Flag:     ${flag.flagBars} bars · ${flag.flagRange}% range
⚡ Rel Vol:  ${flag.rVol}x average
📊 Float:   ${flag.float}
📐 Spread:  ~${flag.spreadPct}%

🎯 Target:  $${flag.breakoutTarget}
🛑 Stop:    $${flag.stopLoss}

<i>5am–10am scalp setup · NASDAQ</i>`;
}

// ── WebSocket connection ───────────────────────────────────────────────────────
function connectWebSocket(tickers) {
  log(`Connecting to Polygon WebSocket for ${tickers.length} tickers...`);

  ws = new WebSocket("wss://socket.polygon.io/stocks");

  ws.on("open", () => {
    log("WebSocket connected — authenticating...");
    ws.send(JSON.stringify({ action:"auth", params: POLYGON_KEY }));
  });

  ws.on("message", raw => {
    let msgs;
    try { msgs = JSON.parse(raw); } catch(e) { return; }

    msgs.forEach(msg => {
      // Auth response
      if (msg.ev === "status") {
        if (msg.status === "auth_success") {
          log("Authenticated — subscribing to 1-min bars...");
          // Subscribe in batches of 50
          for (let i=0; i<tickers.length; i+=50) {
            const slice = tickers.slice(i, i+50);
            const params = slice.map(t=>`AM.${t}`).join(",");
            ws.send(JSON.stringify({ action:"subscribe", params }));
          }
          log(`Subscribed to ${tickers.length} tickers`);
          sendTelegram(`✅ <b>Bull Flag Scalper ACTIVE</b>\nScanning ${tickers.length} NASDAQ low-float stocks\n$${MIN_PRICE}–$${MAX_PRICE} · Float ≤${MAX_FLOAT_M}M · ${MIN_RVOL}x min rvol\nWill alert on 1-min bull flags until 10am ET`);
        }
        if (msg.status === "auth_failed") {
          log("Auth failed — check API key");
        }
        return;
      }

      // 1-minute aggregate bar
      if (msg.ev === "AM") {
        const ticker = msg.sym;
        if (!ticker) return;

        const bar = {
          open:  msg.o,
          high:  msg.h,
          low:   msg.l,
          close: msg.c,
          vol:   msg.av || msg.v, // accumulated volume or bar volume
          ts:    msg.s,
        };

        // Price filter
        if (bar.close < MIN_PRICE || bar.close > MAX_PRICE) return;

        if (!bars[ticker]) bars[ticker] = [];
        bars[ticker].push(bar);
        // Keep last 60 bars (1 hour)
        if (bars[ticker].length > 60) bars[ticker].shift();

        // Check for flag
        if (!alertedToday.has(ticker)) {
          const flag = detectScalpFlag(ticker);
          if (flag) {
            alertedToday.add(ticker);
            log(`🚨 FLAG: ${ticker} @ $${flag.currentPrice} | +${flag.poleGain}% pole | ${flag.rVol}x rvol`);
            sendTelegram(formatAlert(flag));
            // Allow re-alert after 30 min
            setTimeout(() => alertedToday.delete(ticker), 30 * 60 * 1000);
          }
        }
      }
    });
  });

  ws.on("close", () => {
    log("WebSocket closed");
    if (scanActive) {
      log("Reconnecting in 5s...");
      reconnectTimer = setTimeout(() => connectWebSocket(tickers), 5000);
    }
  });

  ws.on("error", err => {
    log(`WebSocket error: ${err.message}`);
  });
}

// ── Disconnect ────────────────────────────────────────────────────────────────
function disconnect() {
  scanActive = false;
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.close();
    ws = null;
  }
  bars = {};
  alertedToday.clear();
  log("Scanner disconnected");
  sendTelegram("🔴 <b>Bull Flag Scalper OFFLINE</b>\nMarket window closed (10am ET)\nWill restart tomorrow at 5am ET");
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
async function checkSchedule() {
  const now = new Date();
  const et  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const hour = et.getHours();
  const day  = et.getDay(); // 0=Sun, 6=Sat
  const isWeekday = day >= 1 && day <= 5;

  if (isWeekday && hour >= SCAN_START_ET && hour < SCAN_END_ET) {
    if (!scanActive) {
      log(`Market window open (${hour}:${String(et.getMinutes()).padStart(2,"0")} ET) — starting scan`);
      scanActive = true;
      alertedToday.clear();
      bars = {};
      const tickers = await buildUniverse();
      activeTickers = new Set(tickers);
      connectWebSocket(tickers);
    }
  } else {
    if (scanActive) {
      log(`Market window closed (${hour}:${String(et.getMinutes()).padStart(2,"0")} ET) — stopping scan`);
      disconnect();
    }
  }
}

// ── Health check server (required by Railway) ─────────────────────────────────
http.createServer((req, res) => {
  const now = new Date().toLocaleString("en-US", { timeZone:"America/New_York" });
  res.writeHead(200, { "Content-Type":"application/json" });
  res.end(JSON.stringify({
    status:    "ok",
    scanning:  scanActive,
    tickers:   activeTickers.size,
    time_et:   now,
    alerts_today: alertedToday.size,
  }));
}).listen(process.env.PORT || 3000, () => {
  log("Health server listening on port " + (process.env.PORT || 3000));
});

// ── Start ──────────────────────────────────────────────────────────────────────
log("Bull Flag Scalper starting...");
checkSchedule();
setInterval(checkSchedule, 60 * 1000); // check every minute
