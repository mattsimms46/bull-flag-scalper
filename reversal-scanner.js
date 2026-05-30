// ─── Exhaustion Reversal Scanner ─────────────────────────────────────────────
// Runs 9:30–10:30am ET daily on 5-min candles
// Detects: Marubozu pole → exhaustion candle at S/R with volume spike + RSI extreme

// ── Config ────────────────────────────────────────────────────────────────────
const POLYGON_KEY    = process.env.POLYGON_KEY    || "GMoNIAEFKGYBlnWGTMxlQxaiOD5q3f5H";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8600785204:AAFRzkIW4nMMz6Ao5OxrkWrwCP3JvcqTfCU";
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT  || "8446284130";
const SR_PROXIMITY   = parseFloat(process.env.SR_PROXIMITY  || "0.01");  // 1%
const MIN_VOL_SPIKE  = parseFloat(process.env.MIN_VOL_SPIKE || "3");     // 3x
const RSI_PERIOD     = parseInt(process.env.RSI_PERIOD      || "7");
const SCAN_START_ET  = { h: 9,  m: 30 };
const SCAN_END_ET    = { h: 10, m: 30 };

const https     = require("https");
const WebSocket = require("ws");

// ── Universe — combined low-float + liquid higher priced ──────────────────────
const REVERSAL_TICKERS = [
  // Low-float high-beta
  "SOFI","HOOD","MARA","RIOT","CIFR","CLSK","IREN","BITF","HUT","BTBT",
  "ACHR","JOBY","SPCE","RKLB","ASTS","LUNR","HIMS","DOCS","RDDT","SNAP",
  "PINS","NKLA","GOEV","NIO","SNDL","TLRY","AMC","GME","BB","CLOV",
  "EVGO","QUBT","KULR","MVIS","OCGN","APLD","BTCS","GFAI","VERB","ZFOX",
  "ATOS","DARE","RAIL","SDIG","UAVS","WISA","XELA","SANG","NXPL","HOLO",
  // Liquid higher priced NASDAQ
  "NVDA","AMD","TSLA","META","AAPL","MSFT","AMZN","GOOGL","AVGO","ARM",
  "QCOM","MU","AMAT","LRCX","MRVL","NFLX","PLTR","CRWD","DDOG","NET",
  "PANW","ZS","SNOW","APP","SHOP","COIN","SQ","PYPL","UBER","RBLX",
  "DUOL","FTNT","OKTA","TEAM","ADBE","CRM","NOW","INTU","WDAY",
  "AMGN","GILD","MRNA","REGN","VRTX","BKNG","ABNB","DASH","DKNG",
  // ETFs for broad market reversals
  "SPY","QQQ","IWM","SOXL","TQQQ","LABU","ARKK","SQQQ","UVXY",
];

// ── State ─────────────────────────────────────────────────────────────────────
let ws5m          = null;
let bars5m        = {};   // ticker -> [5min bars]
let dailyLevels   = {};   // ticker -> { prevHigh, prevLow, srLevels[] }
let avgBarVol     = {};   // ticker -> avg 5min bar volume
let alertedToday  = new Set();
let scanActive    = false;
let reconnectTimer= null;

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[REV ${new Date().toISOString()}] ${msg}`); }

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
  req.on("error", e => log(`Telegram: ${e.message}`));
  req.write(body); req.end();
}

// ── Polygon REST ──────────────────────────────────────────────────────────────
function polygonGet(path) {
  return new Promise((resolve, reject) => {
    const sep = path.includes("?") ? "&" : "?";
    https.get(`https://api.polygon.io${path}${sep}apiKey=${POLYGON_KEY}`, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on("error", reject);
  });
}

// ── RSI Calculation ───────────────────────────────────────────────────────────
function calcRSI(bars, period=RSI_PERIOD) {
  if (bars.length < period + 1) return null;
  const closes = bars.map(b => b.close);
  let gains = 0, losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains  += diff;
    else          losses -= diff;
  }
  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

// ── RSI extremity rank ────────────────────────────────────────────────────────
function rsiRank(rsi) {
  if (rsi === null) return { label: "N/A", stars: "" };
  if (rsi <= 5  || rsi >= 95) return { label: "EXTREME",  stars: "⭐⭐⭐" };
  if (rsi <= 10 || rsi >= 90) return { label: "VERY HIGH", stars: "⭐⭐" };
  if (rsi <= 20 || rsi >= 80) return { label: "HIGH",      stars: "⭐" };
  return { label: "MODERATE", stars: "" };
}

// ── Candle classification ─────────────────────────────────────────────────────
function classifyCandle(bar) {
  const totalRange = bar.high - bar.low;
  if (totalRange === 0) return "doji";
  const body       = Math.abs(bar.close - bar.open);
  const bodyPct    = body / totalRange;
  const upperWick  = bar.high - Math.max(bar.open, bar.close);
  const lowerWick  = Math.min(bar.open, bar.close) - bar.low;
  const isGreen    = bar.close >= bar.open;

  // Marubozu: body >75% of range, tiny wicks
  if (bodyPct > 0.75) return isGreen ? "marubozu_green" : "marubozu_red";

  // Doji: body <10% of range
  if (bodyPct < 0.10) return "doji";

  // Spinning top: small body, wicks both sides
  if (bodyPct < 0.30 && upperWick > body * 0.5 && lowerWick > body * 0.5)
    return "spinning_top";

  // Shooting star: upper wick >2x body, small lower wick (bearish signal after up move)
  if (upperWick > body * 2 && lowerWick < body * 0.5 && !isGreen)
    return "shooting_star";

  // Hammer: lower wick >2x body, small upper wick (bullish signal after down move)
  if (lowerWick > body * 2 && upperWick < body * 0.5 && isGreen)
    return "hammer";

  // Strong wick candle
  if (upperWick > totalRange * 0.4 || lowerWick > totalRange * 0.4)
    return "wick_reversal";

  return "normal";
}

function isMarubozu(bar) {
  const t = classifyCandle(bar);
  return t === "marubozu_green" || t === "marubozu_red";
}

function isExhaustionCandle(bar) {
  const t = classifyCandle(bar);
  return ["doji","spinning_top","shooting_star","hammer","wick_reversal"].includes(t);
}

// ── Fetch previous day levels + 5-day 1hr S/R ────────────────────────────────
async function fetchLevels(ticker) {
  try {
    // Previous day OHLC
    const today = new Date();
    const from  = new Date(today - 7*24*60*60*1000).toISOString().split("T")[0];
    const to    = today.toISOString().split("T")[0];

    const daily = await polygonGet(
      `/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=desc&limit=5`
    );

    let prevHigh = null, prevLow = null, prevClose = null;
    if (daily?.results?.length >= 2) {
      const prev   = daily.results[1]; // yesterday
      prevHigh  = prev.h;
      prevLow   = prev.l;
      prevClose = prev.c;
    }

    // 5-day 1hr candles for S/R levels
    const hourly = await polygonGet(
      `/v2/aggs/ticker/${ticker}/range/1/hour/${from}/${to}?adjusted=true&sort=asc&limit=120`
    );

    const srLevels = [];
    if (hourly?.results?.length) {
      // Find significant highs and lows from 1hr chart
      const hrs = hourly.results;
      for (let i=1; i<hrs.length-1; i++) {
        // Swing high
        if (hrs[i].h > hrs[i-1].h && hrs[i].h > hrs[i+1].h) {
          srLevels.push({ price: hrs[i].h, type: "resistance" });
        }
        // Swing low
        if (hrs[i].l < hrs[i-1].l && hrs[i].l < hrs[i+1].l) {
          srLevels.push({ price: hrs[i].l, type: "support" });
        }
      }
      // Dedupe levels within 0.5% of each other
      const deduped = [];
      srLevels.sort((a,b)=>a.price-b.price).forEach(level => {
        const near = deduped.find(d => Math.abs(d.price-level.price)/level.price < 0.005);
        if (!near) deduped.push(level);
      });
      srLevels.length = 0;
      deduped.forEach(l => srLevels.push(l));
    }

    // Avg 5-min bar volume (from yesterday's data approximated)
    const avgDailyVol = daily?.results?.[1]?.v || 0;
    avgBarVol[ticker] = avgDailyVol / 78; // ~78 5-min bars per day

    dailyLevels[ticker] = { prevHigh, prevLow, prevClose, srLevels };
  } catch(e) {
    log(`Levels fetch error ${ticker}: ${e.message}`);
  }
}

// ── Find nearest S/R level ────────────────────────────────────────────────────
function nearestLevel(ticker, price) {
  const levels = dailyLevels[ticker];
  if (!levels) return null;

  const candidates = [];

  // Check prev high/low
  if (levels.prevHigh) {
    const pct = Math.abs(price - levels.prevHigh) / price;
    if (pct <= SR_PROXIMITY)
      candidates.push({ price: levels.prevHigh, type: "Prev Day High", pct });
  }
  if (levels.prevLow) {
    const pct = Math.abs(price - levels.prevLow) / price;
    if (pct <= SR_PROXIMITY)
      candidates.push({ price: levels.prevLow, type: "Prev Day Low", pct });
  }
  if (levels.prevClose) {
    const pct = Math.abs(price - levels.prevClose) / price;
    if (pct <= SR_PROXIMITY)
      candidates.push({ price: levels.prevClose, type: "Prev Day Close", pct });
  }

  // Check 1hr S/R levels
  levels.srLevels.forEach(l => {
    const pct = Math.abs(price - l.price) / price;
    if (pct <= SR_PROXIMITY)
      candidates.push({ price: l.price, type: l.type === "resistance" ? "1hr Resistance" : "1hr Support", pct });
  });

  if (!candidates.length) return null;
  // Return closest
  return candidates.sort((a,b) => a.pct - b.pct)[0];
}

// ── Main Detection ────────────────────────────────────────────────────────────
function detectReversal(ticker) {
  const b = bars5m[ticker];
  if (!b || b.length < 7) return null;
  const n = b.length;

  // Look at last 8 bars
  for (let exhaustIdx = n-1; exhaustIdx >= n-3; exhaustIdx--) {
    const exhaustBar = b[exhaustIdx];

    // Must be exhaustion candle type
    if (!isExhaustionCandle(exhaustBar)) continue;

    // Must have volume spike
    const avgVol = avgBarVol[ticker] || 0;
    if (avgVol > 0 && exhaustBar.vol < avgVol * MIN_VOL_SPIKE) continue;

    // Check for 4-5 Marubozu pole before exhaustion candle
    for (let poleLen = 4; poleLen <= 5; poleLen++) {
      const poleStart = exhaustIdx - poleLen;
      if (poleStart < 0) continue;

      const pole = b.slice(poleStart, exhaustIdx);

      // All must be same color
      const allGreen = pole.every(c => c.close > c.open);
      const allRed   = pole.every(c => c.close < c.open);
      if (!allGreen && !allRed) continue;

      // Must be Marubozu-style (body > 60% of range for at least 3 of the candles)
      const marubozuCount = pole.filter(c => {
        const range = c.high - c.low;
        const body  = Math.abs(c.close - c.open);
        return range > 0 && body/range > 0.60;
      }).length;
      if (marubozuCount < 3) continue;

      // Pole must show conviction — consistent or rising volume
      const avgPoleVol = pole.reduce((s,c)=>s+c.vol,0) / poleLen;
      if (avgPoleVol < (avgVol || avgPoleVol) * 1.5) continue; // pole above avg vol

      // Direction
      const direction = allGreen ? "BEARISH REVERSAL" : "BULLISH REVERSAL";
      const emoji     = allGreen ? "🔴" : "🟢";

      // Check S/R proximity
      const exhaustPrice = (exhaustBar.high + exhaustBar.low) / 2;
      const srLevel = nearestLevel(ticker, exhaustPrice);

      // RSI
      const rsi     = calcRSI(b.slice(0, exhaustIdx+1));
      const rsiInfo = rsiRank(rsi);

      // Candle type label
      const candleType = classifyCandle(exhaustBar).replace(/_/g," ").toUpperCase();

      // Pole stats
      const poleMove = Math.abs(
        (b[exhaustIdx-1].close - b[poleStart].open) / b[poleStart].open * 100
      ).toFixed(1);

      return {
        ticker,
        direction,
        emoji,
        isGreenPole:    allGreen,
        currentPrice:   exhaustBar.close.toFixed(2),
        poleLen,
        poleMove,
        marubozuCount,
        candleType,
        exhaustVol:     Math.round(exhaustBar.vol),
        volSpike:       avgVol > 0 ? (exhaustBar.vol/avgVol).toFixed(1) : "N/A",
        rsi,
        rsiRank:        rsiInfo,
        srLevel,
        prevHigh:       dailyLevels[ticker]?.prevHigh?.toFixed(2),
        prevLow:        dailyLevels[ticker]?.prevLow?.toFixed(2),
        prevClose:      dailyLevels[ticker]?.prevClose?.toFixed(2),
        srLevels:       dailyLevels[ticker]?.srLevels || [],
      };
    }
  }
  return null;
}

// ── Format Telegram Alert ─────────────────────────────────────────────────────
function formatReversalAlert(r) {
  const time = new Date().toLocaleTimeString("en-US", {
    timeZone:"America/New_York", hour:"2-digit", minute:"2-digit"
  });

  // Top nearby S/R levels
  const srText = r.srLevels
    .filter(l => Math.abs(l.price - parseFloat(r.currentPrice)) / parseFloat(r.currentPrice) < 0.03)
    .sort((a,b) => Math.abs(a.price-parseFloat(r.currentPrice)) - Math.abs(b.price-parseFloat(r.currentPrice)))
    .slice(0,3)
    .map(l => `  ${l.type==="resistance"?"🔴 R":"🟢 S"} $${l.price.toFixed(2)}`)
    .join("\n") || "  None within 3%";

  const srHit = r.srLevel
    ? `✅ AT ${r.srLevel.type.toUpperCase()} $${r.srLevel.price.toFixed(2)} (${(r.srLevel.pct*100).toFixed(2)}% away)`
    : "⚠️ Not at key level — weaker setup";

  return `${r.emoji} <b>${r.direction} — ${r.ticker}</b>
⏰ ${time} ET

💰 Price:     $${r.currentPrice}
📊 RSI(${RSI_PERIOD}):   ${r.rsi ?? "N/A"} ${r.rsiRank.stars} ${r.rsiRank.label}

📈 Pole:      ${r.poleLen} candles · +${r.poleMove}% · ${r.marubozuCount}/${r.poleLen} Marubozu
🕯 Exhaustion: ${r.candleType}
⚡ Vol Spike:  ${r.volSpike}x average

📍 S/R: ${srHit}

🗓 Prior Day:
  High:  $${r.prevHigh ?? "N/A"}
  Low:   $${r.prevLow  ?? "N/A"}
  Close: $${r.prevClose?? "N/A"}

📐 Nearby 1hr Levels:
${srText}

<i>Confirm reversal before entry · 5-min chart · First hour</i>`;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectReversalWS(tickers) {
  log(`Connecting reversal WS for ${tickers.length} tickers...`);
  ws5m = new WebSocket("wss://socket.polygon.io/stocks");

  ws5m.on("open", () => {
    ws5m.send(JSON.stringify({ action:"auth", params: POLYGON_KEY }));
  });

  ws5m.on("message", raw => {
    let msgs;
    try { msgs = JSON.parse(raw); } catch(e) { return; }

    msgs.forEach(msg => {
      if (msg.ev === "status") {
        if (msg.status === "auth_success") {
          log("Reversal WS authenticated — subscribing to 5-min bars...");
          for (let i=0; i<tickers.length; i+=50) {
            const params = tickers.slice(i,i+50).map(t=>`A.${t}`).join(",");
            ws5m.send(JSON.stringify({ action:"subscribe", params }));
          }
          sendTelegram(`🔄 <b>Reversal Scanner ACTIVE</b>\nScanning ${tickers.length} tickers on 5-min bars\nLooking for Marubozu poles → exhaustion at S/R\nRSI(${RSI_PERIOD}) extremes ranked ⭐⭐⭐\nRuns until 10:30am ET`);
        }
        return;
      }

      // 5-min aggregate (A = per-second agg, AM = per-minute)
      // We use AM for 1-min and aggregate manually to 5-min
      if (msg.ev === "AM" || msg.ev === "A") {
        const ticker = msg.sym;
        if (!ticker || !REVERSAL_TICKERS.includes(ticker)) return;

        const bar = {
          open:  msg.o,
          high:  msg.h,
          low:   msg.l,
          close: msg.c,
          vol:   msg.av || msg.v,
          ts:    msg.s,
        };

        if (!bars5m[ticker]) bars5m[ticker] = [];

        // Aggregate 1-min bars into 5-min bars
        const last = bars5m[ticker][bars5m[ticker].length - 1];
        const barTime = Math.floor(bar.ts / (5*60*1000)); // 5-min bucket

        if (last && Math.floor(last.ts / (5*60*1000)) === barTime) {
          // Update current 5-min bar
          last.high  = Math.max(last.high, bar.high);
          last.low   = Math.min(last.low,  bar.low);
          last.close = bar.close;
          last.vol   = bar.vol;
        } else {
          // New 5-min bar
          bars5m[ticker].push({ ...bar });
          if (bars5m[ticker].length > 50) bars5m[ticker].shift();
        }

        // Only check on new bar completion (when we just pushed a new bar)
        if (bars5m[ticker].length >= 7 && !alertedToday.has(ticker)) {
          const reversal = detectReversal(ticker);
          if (reversal) {
            alertedToday.add(ticker);
            log(`${reversal.emoji} REVERSAL: ${ticker} ${reversal.direction} RSI:${reversal.rsi} Vol:${reversal.volSpike}x`);
            sendTelegram(formatReversalAlert(reversal));
            // Allow re-alert after 20 min
            setTimeout(() => alertedToday.delete(ticker), 20*60*1000);
          }
        }
      }
    });
  });

  ws5m.on("close", () => {
    log("Reversal WS closed");
    if (scanActive) {
      reconnectTimer = setTimeout(() => connectReversalWS(tickers), 5000);
    }
  });

  ws5m.on("error", err => log(`Reversal WS error: ${err.message}`));
}

// ── Disconnect ────────────────────────────────────────────────────────────────
function disconnectReversal() {
  scanActive = false;
  clearTimeout(reconnectTimer);
  if (ws5m) { ws5m.close(); ws5m = null; }
  bars5m = {};
  alertedToday.clear();
  log("Reversal scanner stopped");
  sendTelegram("🔄 <b>Reversal Scanner OFFLINE</b>\nFirst hour complete · See you tomorrow 9:30am ET");
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
async function checkReversalSchedule() {
  const et      = new Date(new Date().toLocaleString("en-US", { timeZone:"America/New_York" }));
  const h       = et.getHours(), m = et.getMinutes();
  const mins    = h * 60 + m;
  const startM  = SCAN_START_ET.h * 60 + SCAN_START_ET.m; // 9:30
  const endM    = SCAN_END_ET.h   * 60 + SCAN_END_ET.m;   // 10:30
  const isWeekday = et.getDay() >= 1 && et.getDay() <= 5;

  if (isWeekday && mins >= startM && mins < endM) {
    if (!scanActive) {
      log(`Reversal scanner starting (${h}:${String(m).padStart(2,"0")} ET)`);
      scanActive = true;
      alertedToday.clear();
      bars5m = {};

      // Fetch S/R levels for all tickers before connecting
      log("Fetching S/R levels...");
      const BATCH = 10;
      for (let i=0; i<REVERSAL_TICKERS.length; i+=BATCH) {
        await Promise.allSettled(
          REVERSAL_TICKERS.slice(i,i+BATCH).map(t => fetchLevels(t))
        );
      }
      log("S/R levels ready — connecting WebSocket");
      connectReversalWS(REVERSAL_TICKERS);
    }
  } else {
    if (scanActive) {
      log(`Reversal scanner stopping (${h}:${String(m).padStart(2,"0")} ET)`);
      disconnectReversal();
    }
  }
}

// ── Export for use in main server ────────────────────────────────────────────
module.exports = { checkReversalSchedule };
